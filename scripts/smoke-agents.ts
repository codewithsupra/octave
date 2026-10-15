/**
 * Real-agent smoke test: runs each installed agent CLI headless through Octave
 * on a throwaway repo and checks that its lifecycle hook reaches Octave.
 *
 *   npm run smoke:agents            # every installed agent
 *   npm run smoke:agents -- codex   # just one
 *
 * Uses your own agent logins and spends a few thousand tokens per agent, so
 * it's opt-in and not part of CI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { findPreset, resolveBin } from "../server/agents";
import { Octave } from "../server/octave";
import { Store } from "../server/store";

const AGENTS: Record<string, { hookAgent: string; expect: string }> = {
  claude: { hookAgent: "claude", expect: "Stop" },
  codex: { hookAgent: "codex", expect: "agent-turn-complete" },
  "cursor-agent": { hookAgent: "cursor", expect: "stop" },
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(AGENTS);
const temp = (p: string) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));

const repo = temp("octave-smoke-");
const sh = (...a: string[]) => execFileSync("git", a, { cwd: repo });
sh("init", "-q", "-b", "main");
writeFileSync(path.join(repo, "README.md"), "# smoke\n");
sh("add", "-A");
sh("-c", "user.email=smoke@octave.dev", "-c", "user.name=smoke", "commit", "-qm", "init");

const o = new Octave(new Store(temp("octave-smoke-home-")));
const events = new Map<string, string[]>();
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const id = req.url!.split("/").pop()!;
    const p = JSON.parse(body || "{}");
    o.applyHook(id, req.headers.authorization, String(req.headers["x-octave-agent"]), p);
    events.set(id, [...(events.get(id) ?? []), String(p.hook_event_name ?? p.type)]);
    res.statusCode = 204;
    res.end();
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
o.hookBase = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const project = await o.addProject(repo);

const rows: string[][] = [];
let failed = false;
for (const agent of wanted) {
  const spec = AGENTS[agent];
  const preset = findPreset(agent);
  if (!spec || !preset) {
    rows.push([agent, "unknown agent", "", ""]);
    continue;
  }
  if (resolveBin(preset) === null) {
    rows.push([agent, "not installed (skipped)", "", ""]);
    continue;
  }
  const ws = await o.createWorkspace({ projectId: project.id, name: `smoke-${agent}`, agent, prompt: "Reply with just: ok", headless: true, bootstrap: false });
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (o.sessions.statuses()[ws.id]?.status === "exited" || Date.now() - t0 > 180_000) {
        clearInterval(tick);
        resolve();
      }
    }, 250);
  });
  const s = o.sessions.get(ws.id)!;
  const got = events.get(ws.id) ?? [];
  const ok = s.exitCode === 0 && got.includes(spec.expect);
  if (!ok) failed = true;
  rows.push([agent, ok ? "PASS" : "FAIL", `exit ${s.exitCode} in ${Math.round((Date.now() - t0) / 1000)}s`, got.join(" → ") || "no hook events"]);
  if (!ok) {
    const out = s.scrollback().replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").trim();
    console.log(`\n--- ${agent} output (last 600 chars) ---\n${out.slice(-600)}\n`);
  }
}

console.log("\nagent          result                   run            hook events");
for (const r of rows) console.log(`${r[0].padEnd(15)}${r[1].padEnd(25)}${r[2].padEnd(15)}${r[3]}`);
o.shutdown();
srv.close();
process.exit(failed ? 1 : 0);
