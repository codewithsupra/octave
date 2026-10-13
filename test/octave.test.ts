import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, sh, tmp } from "./helpers";
import { Octave, slugify } from "../server/octave";
import { Store } from "../server/store";
import { snapshot } from "../server/git";
import { rankEntrants, scoreEntrant } from "../server/tournament";

const base = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n") + "\n";
const octaves: Octave[] = [];
function boot() {
  const o = new Octave(new Store(tmp()));
  octaves.push(o);
  return o;
}
afterAll(() => octaves.forEach((o) => o.shutdown()));

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
};

describe("Octave service (end to end, real PTYs + git)", () => {
  it("slugify", () => {
    expect(slugify("Fix the Login bug!!")).toBe("fix-the-login-bug");
    expect(slugify("***")).toBe("ws");
  });

  it("creates isolated workspaces with ports, env copy, and live diffs", async () => {
    const repo = makeRepo({ "a.txt": base, ".gitignore": ".env\n" });
    write(repo, ".env", "KEY=1\n");
    const o = boot();
    const p = await o.addProject(repo);
    expect(p.baseBranch).toBe("main");
    expect((await o.addProject(path.join(repo))).id).toBe(p.id); // idempotent

    const w1 = await o.createWorkspace({ projectId: p.id, name: "one", agent: "shell", headless: true, prompt: "echo $PORT > port.txt" });
    const w2 = await o.createWorkspace({ projectId: p.id, name: "two", agent: "shell", headless: true, prompt: "echo $PORT > port.txt" });
    expect(w1.ports.base).not.toBe(w2.ports.base);
    expect(w1.copiedEnv).toEqual([".env"]);
    expect(readFileSync(path.join(w1.path, ".env.octave"), "utf8")).toContain(`PORT=${w1.ports.base}`);

    await waitFor(() => o.sessions.get(w1.id)?.status === "exited" && o.sessions.get(w2.id)?.status === "exited");
    expect(readFileSync(path.join(w1.path, "port.txt"), "utf8").trim()).toBe(String(w1.ports.base));

    const d = await o.diff(w1.id);
    // .env.octave is excluded and .env is ignored -> only the agent's file shows
    expect(d.files.map((f) => f.path)).toEqual(["port.txt"]);
    expect(await o.diff(w1.id)).toBe(d); // cached by content-addressed snapshot
    expect(await o.patch(w1.id)).toContain(`+${w1.ports.base}`);

    await o.removeWorkspace(w2.id);
    expect(existsSync(w2.path)).toBe(false);
  });

  it("conflict radar flags real conflicts, overlaps, and base drift", async () => {
    const repo = makeRepo({ "a.txt": base, "b.txt": base });
    const o = boot();
    const p = await o.addProject(repo);
    const mk = (name: string) => o.createWorkspace({ projectId: p.id, name, agent: "shell", headless: true, prompt: "true", bootstrap: false });
    const [x, y, z] = await Promise.all([mk("x"), mk("y"), mk("z")]);
    write(x.path, "a.txt", base.replace("line1", "X"));
    write(y.path, "a.txt", base.replace("line1", "Y")); // same hunk as x
    write(z.path, "a.txt", base.replace("line9", "Z")); // same file, different hunk
    write(z.path, "b.txt", base.replace("line5", "Z"));

    const r = await o.radar(p.id);
    const find = (a: string, b: string) => r.pairs.find((q) => (q.a === a && q.b === b) || (q.a === b && q.b === a))!;
    expect(find(x.id, y.id)).toMatchObject({ severity: "conflict", conflicts: ["a.txt"] });
    expect(find(x.id, z.id)).toMatchObject({ severity: "overlap", conflicts: [] });
    expect(r.pairs[0].severity).toBe("conflict"); // sorted worst-first

    // main moves on and touches b.txt line5 -> z now conflicts with base
    write(repo, "b.txt", base.replace("line5", "MAIN"));
    sh(repo, "commit", "-qam", "main moves");
    const r2 = await o.radar(p.id);
    expect(r2.baseConflicts[z.id]).toEqual(["b.txt"]);
    expect(r2.baseConflicts[x.id]).toBeUndefined();

    const tri = await o.triage(p.id);
    expect(tri.queue).toHaveLength(3);

    // destructive SQL in a migration is caught from the patch content
    write(x.path, "db/migrations/9.sql", "ALTER TABLE users DROP COLUMN email;\n");
    const dx = await o.diff(x.id);
    expect(dx.risk.reasons.some((q) => q.label.includes("destructive SQL"))).toBe(true);
  });

  it("tournament: runs entrants headless, verifies, ranks, adopts winner", async () => {
    const repo = makeRepo({ "a.txt": base });
    const o = boot();
    const p = await o.addProject(repo);
    // entrant 1 does the task, entrant 2 breaks it, entrant 3 does nothing
    const t = await o.createTournament({
      projectId: p.id,
      prompt: "make answer.txt contain 42",
      verify: `grep -qx 42 answer.txt`,
      agents: ["custom:echo 42 > answer.txt", "custom:echo 41 > answer.txt", "custom:true"],
    });
    expect(t.entrants).toHaveLength(3);
    await waitFor(() => o.store.tournament(t.id).status === "done", 30000);
    const done = o.store.tournament(t.id);
    const [first] = done.entrants;
    expect(first.verify?.passed).toBe(true);
    expect(done.winner).toBe(first.workspaceId);
    expect(done.entrants.at(-1)!.files).toBe(0);

    // only the winner shows up in the review queue
    expect((await o.triage(p.id)).queue.map((q) => q.workspaceId)).toEqual([done.winner]);

    const winner = o.store.workspace(done.winner!);
    const res = await o.adoptWinner(t.id);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(o.store.state.workspaces.map((w) => w.id)).toEqual([winner.id]);
    expect(sh(repo, "show", `${winner.branch}:answer.txt`).trim()).toBe("42");
  });

  it("radar ignores pairs within the same tournament", async () => {
    const repo = makeRepo({ "a.txt": base });
    const o = boot();
    const p = await o.addProject(repo);
    const t = await o.createTournament({
      projectId: p.id, prompt: "edit a", verify: "",
      agents: ["custom:echo one > a.txt", "custom:echo two > a.txt"],
    });
    await waitFor(() => o.store.tournament(t.id).status === "done");
    const solo = await o.createWorkspace({ projectId: p.id, name: "solo", agent: "custom:echo solo > a.txt", headless: true, bootstrap: false });
    await waitFor(() => o.sessions.get(solo.id)?.status === "exited");
    const r = await o.radar(p.id);
    // 2 entrants x solo = 2 pairs; the entrant-vs-entrant pair is skipped
    expect(r.pairs).toHaveLength(2);
    expect(r.pairs.every((q) => q.a === solo.id || q.b === solo.id)).toBe(true);
    expect(r.pairs.every((q) => q.severity === "conflict")).toBe(true);
    expect(o.store.state.workspaces.filter((w) => w.tournamentId).map((w) => w.name).sort())
      .toEqual([`t-${t.id}-custom-1`, `t-${t.id}-custom-2`]);
  });

  it("scoring prefers passing, then low risk, then small diffs", () => {
    expect(scoreEntrant({ workspaceId: "a", agent: "x", files: 0 })).toBe(-1000);
    const ranked = rankEntrants([
      { workspaceId: "big", agent: "a", files: 3, churn: 400, risk: 10, verify: { passed: true, code: 0, durationMs: 1, tail: "" } },
      { workspaceId: "fail", agent: "b", files: 1, churn: 5, risk: 0, verify: { passed: false, code: 1, durationMs: 1, tail: "" } },
      { workspaceId: "small", agent: "c", files: 1, churn: 20, risk: 10, verify: { passed: true, code: 0, durationMs: 1, tail: "" } },
    ]);
    expect(ranked.map((e) => e.workspaceId)).toEqual(["small", "big", "fail"]);
  });

  it("snapshots are deterministic for identical content", async () => {
    const repo = makeRepo();
    write(repo, "n.txt", "x\n");
    expect(await snapshot(repo)).toBe(await snapshot(repo));
  });
});
