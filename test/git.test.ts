import { describe, it, expect } from "vitest";
import path from "node:path";
import { makeRepo, write, sh, tmp } from "./helpers";
import {
  addWorktree, snapshot, diffFiles, predictMerge, mergeBase, revParse,
  removeWorktree, commitAll, branchExists, diffPatch,
} from "../server/git";

const base = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";

describe("git primitives", () => {
  it("snapshot captures edits + untracked files without touching the index", async () => {
    const repo = makeRepo({ "a.txt": base });
    const head = await revParse(repo, "HEAD");
    expect(await snapshot(repo)).toBe(head); // clean tree -> HEAD

    write(repo, "a.txt", base.replace("line2", "CHANGED"));
    write(repo, "new.txt", "hello\n");
    const snap = await snapshot(repo);
    expect(snap).not.toBe(head);

    // the agent's real index is untouched: nothing staged
    expect(sh(repo, "diff", "--cached", "--name-only").trim()).toBe("");
    expect(sh(repo, "status", "--porcelain")).toContain("?? new.txt");

    const files = await diffFiles(repo, head, snap);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["a.txt"]).toMatchObject({ status: "M", added: 1, deleted: 1 });
    expect(byPath["new.txt"]).toMatchObject({ status: "A", added: 1, deleted: 0 });
    expect(await diffPatch(repo, head, snap, "a.txt")).toContain("+CHANGED");
  });

  it("predictMerge detects real conflicts and clean merges across worktrees", async () => {
    const repo = makeRepo({ "a.txt": base, "b.txt": "b\n" });
    const root = tmp();
    const w1 = path.join(root, "w1"), w2 = path.join(root, "w2"), w3 = path.join(root, "w3");
    await addWorktree(repo, w1, "oct/w1", "main");
    await addWorktree(repo, w2, "oct/w2", "main");
    await addWorktree(repo, w3, "oct/w3", "main");

    write(w1, "a.txt", base.replace("line2", "agent-one"));
    write(w2, "a.txt", base.replace("line2", "agent-two")); // same hunk -> conflict
    write(w3, "a.txt", base.replace("line8", "agent-three")); // same file, far hunk -> clean
    const [s1, s2, s3] = await Promise.all([snapshot(w1), snapshot(w2), snapshot(w3)]);

    expect(await predictMerge(repo, s1, s2)).toEqual({ clean: false, conflicts: ["a.txt"] });
    expect(await predictMerge(repo, s1, s3)).toEqual({ clean: true, conflicts: [] });
    expect(await mergeBase(repo, s1, s2)).toBe(await revParse(repo, "main"));
  });

  it("commitAll + removeWorktree lifecycle", async () => {
    const repo = makeRepo();
    const w = path.join(tmp(), "w");
    await addWorktree(repo, w, "oct/x", "main");
    expect(await commitAll(w, "nothing")).toBeNull();
    write(w, "f.txt", "x\n");
    const sha = await commitAll(w, "add f");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await removeWorktree(repo, w, "oct/x");
    expect(await branchExists(repo, "oct/x")).toBe(false);
  });
});
