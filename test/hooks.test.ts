import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeRepo, write, sh, tmp } from "./helpers";
import { codexNotifyFlag, installAgentHooks, mapHookEvent, tokenMatches, writeHookScript } from "../server/hooks";
import { agentCommand, resolveBin, findPreset } from "../server/agents";
import { Octave } from "../server/octave";
import { Store } from "../server/store";
import { addWorktree } from "../server/git";

describe("hook event mapping", () => {
  it("claude", () => {
    expect(mapHookEvent("claude", { hook_event_name: "UserPromptSubmit", prompt: "x" })).toMatchObject({ state: "working" });
    expect(mapHookEvent("claude", { hook_event_name: "PostToolUse" })).toMatchObject({ state: "working" });
    expect(mapHookEvent("claude", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }))
      .toEqual({ state: "attention", detail: "Claude needs your permission to use Bash", event: "Notification" });
    expect(mapHookEvent("claude", { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" })).toMatchObject({ state: "idle" });
    expect(mapHookEvent("claude", { hook_event_name: "Notification", notification_type: "auth_success" })).toBeNull();
    const long = "x ".repeat(400);
    const stop = mapHookEvent("claude", { hook_event_name: "Stop", last_assistant_message: long })!;
    expect(stop.state).toBe("idle");
    expect(stop.detail!.length).toBeLessThanOrEqual(280);
  });
  it("codex", () => {
    expect(mapHookEvent("codex", { type: "agent-turn-complete", "last-assistant-message": "Done." })).toEqual({ state: "idle", detail: "Done.", event: "agent-turn-complete" });
    expect(mapHookEvent("codex", { type: "approval-requested" })).toMatchObject({ state: "attention" });
    expect(mapHookEvent("codex", { type: "something-new" })).toBeNull();
  });
  it("cursor", () => {
    expect(mapHookEvent("cursor", { hook_event_name: "sessionStart" })).toMatchObject({ state: "working" });
    expect(mapHookEvent("cursor", { hook_event_name: "stop", status: "completed" })).toEqual({ state: "idle", detail: undefined, event: "stop" });
    expect(mapHookEvent("cursor", { hook_event_name: "stop", status: "error" })!.detail).toContain("error");
  });
  it("unknown agents are ignored", () => {
    expect(mapHookEvent("aider", { hook_event_name: "Stop" })).toBeNull();
  });
});

describe("hook auth", () => {
  it("constant-time bearer match", () => {
    expect(tokenMatches("abc", "Bearer abc")).toBe(true);
    expect(tokenMatches("abc", "Bearer abd")).toBe(false);
    expect(tokenMatches("abc", "Bearer ab")).toBe(false);
    expect(tokenMatches("abc", "abc")).toBe(false);
    expect(tokenMatches(undefined, "Bearer ")).toBe(false);
  });
});

describe("hook installation", () => {
  it("writes Claude + Cursor hook files, merging existing Claude settings", async () => {
    const repo = makeRepo();
    const w = path.join(tmp(), "w");
    await addWorktree(repo, w, "oct/h", "main");
    write(w, ".claude/settings.local.json", JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
    const script = writeHookScript(tmp());
    expect(await installAgentHooks(w, script)).toEqual({ claude: true, cursor: true });
    const claude = JSON.parse(readFileSync(path.join(w, ".claude/settings.local.json"), "utf8"));
    expect(claude.permissions.allow).toEqual(["Bash(npm test)"]); // preserved
    expect(Object.keys(claude.hooks).sort()).toEqual(["Notification", "PostToolUse", "Stop", "StopFailure", "UserPromptSubmit"]);
    expect(claude.hooks.Stop[0].hooks[0].command).toContain(`${script}' claude`);
    const cursor = JSON.parse(readFileSync(path.join(w, ".cursor/hooks.json"), "utf8"));
    expect(cursor.version).toBe(1);
    expect(Object.keys(cursor.hooks)).toEqual(["sessionStart", "postToolUse", "stop"]);
  });

  it("leaves files the repo tracks untouched", async () => {
    const repo = makeRepo({ ".cursor/hooks.json": '{"version":1,"hooks":{}}\n' });
    const w = path.join(tmp(), "w");
    await addWorktree(repo, w, "oct/t", "main");
    const r = await installAgentHooks(w, writeHookScript(tmp()));
    expect(r).toEqual({ claude: true, cursor: false });
    expect(readFileSync(path.join(w, ".cursor/hooks.json"), "utf8")).toBe('{"version":1,"hooks":{}}\n');
  });

  it("codex notify flag survives shell quoting as valid TOML", () => {
    const flag = codexNotifyFlag("/Users/me/.octave/hooks/octave-hook.sh");
    const args = execFileSync("sh", ["-c", `printf '%s\\n' ${flag}`], { encoding: "utf8" }).trim().split("\n");
    expect(args).toEqual(["-c", 'notify=["/Users/me/.octave/hooks/octave-hook.sh","codex"]']);
    expect(agentCommand("codex", { prompt: "fix it", flags: flag })).toBe(`codex ${flag} 'fix it'`);
    expect(agentCommand("codex", { prompt: "fix it", headless: true, flags: flag })).toBe(`codex ${flag} exec --full-auto 'fix it'`);
  });

  it("finds Cursor under its new `agent` name only in ~/.cursor/bin", () => {
    const preset = findPreset("cursor-agent")!;
    const fake = tmp();
    const cursorBin = path.join(fake, ".cursor", "bin");
    write(cursorBin, "agent", "#!/bin/sh\n");
    execFileSync("chmod", ["+x", path.join(cursorBin, "agent")]);
    write(fake, "bin/agent", "#!/bin/sh\n");
    execFileSync("chmod", ["+x", path.join(fake, "bin/agent")]);
    expect(resolveBin(preset, path.join(fake, "bin"))).toBeNull(); // some unrelated `agent`
    expect(resolveBin(preset, cursorBin)).toBe("agent");
    expect(agentCommand("cursor-agent", { prompt: "go", envPath: cursorBin })).toBe("agent 'go'");
  });
});

describe("hook script", () => {
  const servers: http.Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  const listen = () =>
    new Promise<{ port: number; got: { headers: http.IncomingHttpHeaders; body: string }[] }>((resolve) => {
      const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
      const srv = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          got.push({ headers: req.headers, body });
          res.statusCode = 204;
          res.end();
        });
      });
      servers.push(srv);
      srv.listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as { port: number }).port, got }));
    });

  it("forwards stdin (claude/cursor) and argv (codex) payloads with the token", async () => {
    const script = writeHookScript(tmp());
    const { port, got } = await listen();
    const env = { ...process.env, OCTAVE_HOOK_URL: `http://127.0.0.1:${port}/api/hooks/w1`, OCTAVE_HOOK_TOKEN: "s3cret" };
    const a = spawnSync(script, ["claude"], { input: '{"hook_event_name":"Stop"}', env, encoding: "utf8" });
    const b = spawnSync(script, ["codex", '{"type":"agent-turn-complete"}'], { env, encoding: "utf8" });
    expect([a.status, a.stdout, b.status, b.stdout]).toEqual([0, "", 0, ""]);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((g) => [g.headers.authorization, g.headers["x-octave-agent"], g.body])).toEqual([
      ["Bearer s3cret", "claude", '{"hook_event_name":"Stop"}'],
      ["Bearer s3cret", "codex", '{"type":"agent-turn-complete"}'],
    ]);
  });

  it("is a silent no-op outside Octave and never fails when Octave is down", () => {
    const script = writeHookScript(tmp());
    const outside = spawnSync(script, ["claude"], { input: "{}", env: { PATH: process.env.PATH }, encoding: "utf8" });
    expect([outside.status, outside.stdout, outside.stderr]).toEqual([0, "", ""]);
    const t = Date.now();
    const down = spawnSync(script, ["claude"], { input: "{}", env: { ...process.env, OCTAVE_HOOK_URL: "http://127.0.0.1:9/api/hooks/x", OCTAVE_HOOK_TOKEN: "t" }, encoding: "utf8" });
    expect([down.status, down.stdout, down.stderr]).toEqual([0, "", ""]);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe("hooks end to end through Octave", () => {
  const octaves: Octave[] = [];
  const servers: http.Server[] = [];
  afterAll(() => { octaves.forEach((o) => o.shutdown()); servers.forEach((s) => s.close()); });

  it("a permission prompt becomes 'attention', Stop becomes idle with the last message, output no longer flips status", async () => {
    const o = new Octave(new Store(tmp()));
    octaves.push(o);
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = req.url!.match(/^\/api\/hooks\/(\w+)/);
        const r = m ? o.applyHook(m[1], req.headers.authorization, String(req.headers["x-octave-agent"]), JSON.parse(body || "{}")) : "forbidden";
        res.statusCode = r === "forbidden" ? 403 : 204;
        res.end();
      });
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    o.hookBase = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    const repo = makeRepo();
    const p = await o.addProject(repo);
    const S = o.hookScript;
    // A fake "claude" that fires real hooks through the real script, like Claude Code does.
    const fake = [
      `printf '{"hook_event_name":"UserPromptSubmit","prompt":"go"}' | '${S}' claude`,
      "sleep 0.4",
      `printf '{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}' | '${S}' claude`,
      "sleep 6", // silent for longer than the activity timeout: must stay 'attention'
      "echo some output",
      `printf '{"hook_event_name":"PostToolUse"}' | '${S}' claude`,
      "sleep 0.4",
      `printf '{"hook_event_name":"Stop","last_assistant_message":"Refactor done, 14 tests pass."}' | '${S}' claude`,
      "sleep 0.3",
      "echo trailing redraw",
      "sleep 30",
    ].join("; ");
    const ws = await o.createWorkspace({ projectId: p.id, name: "hooked", agent: `custom:${fake}`, bootstrap: false });
    const info = () => o.sessions.statuses()[ws.id];
    const waitFor = async (cond: () => boolean, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return; await new Promise((r) => setTimeout(r, 50)); }
      throw new Error(`timed out; status=${JSON.stringify(info())}`);
    };

    await waitFor(() => info()?.status === "attention");
    expect(info()).toMatchObject({ source: "hooks", detail: "Claude needs your permission to use Bash" });
    await new Promise((r) => setTimeout(r, 4500)); // past IDLE_AFTER_MS with no output
    expect(info().status).toBe("attention");
    await waitFor(() => info()?.detail === "Refactor done, 14 tests pass.");
    expect(info().status).toBe("idle");
    await new Promise((r) => setTimeout(r, 600)); // "trailing redraw" output arrives
    expect(info().status).toBe("idle");

    // generated hook files never appear as the agent's changes
    expect(existsSync(path.join(ws.path, ".claude/settings.local.json"))).toBe(true);
    expect((await o.diff(ws.id)).files).toEqual([]);

    // wrong token is refused
    expect(o.applyHook(ws.id, "Bearer nope", "claude", { hook_event_name: "Stop" })).toBe("forbidden");
    sh(repo, "status"); // repo still healthy
  }, 40000);
});
