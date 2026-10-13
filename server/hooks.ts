import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "./git";

/**
 * Agent lifecycle hooks. Each agent CLI calls one tiny script on events like
 * "turn finished" or "needs permission"; the script forwards the event to the
 * local Octave server. That gives exact statuses instead of guessing from
 * terminal silence (a long, quiet test run is still "working").
 *
 * The script must never interfere with the agent. Claude Code, for one, treats
 * a Stop hook exiting with code 2 as "don't stop", so the script is silent,
 * times out fast, and always exits 0 even when Octave is down.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# Octave agent hook: forwards one agent lifecycle event to the local Octave server.
# Silent, 2s timeout, always exits 0, so it can never block or alter the agent.
agent="$1"
[ -n "$OCTAVE_HOOK_URL" ] && [ -n "$OCTAVE_HOOK_TOKEN" ] || exit 0
if [ -n "$2" ]; then payload="$2"; else payload=$(cat); fi
printf '%s' "$payload" | curl -s -m 2 -o /dev/null -X POST \\
  -H "Authorization: Bearer $OCTAVE_HOOK_TOKEN" \\
  -H "X-Octave-Agent: $agent" \\
  -H "Content-Type: application/json" \\
  --data-binary @- "$OCTAVE_HOOK_URL" >/dev/null 2>&1
exit 0
`;

export function writeHookScript(home: string): string {
  const dir = path.join(home, "hooks");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "octave-hook.sh");
  if (!existsSync(file) || readFileSync(file, "utf8") !== HOOK_SCRIPT) writeFileSync(file, HOOK_SCRIPT);
  chmodSync(file, 0o755);
  return file;
}

export function newHookToken(): string {
  return randomBytes(24).toString("hex");
}

export function tokenMatches(expected: string | undefined, header: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(header.slice(7));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Files Octave generates inside worktrees; they must never show up in diffs. */
export const GENERATED_FILES = [".claude/settings.local.json", ".cursor/hooks.json"];

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function tracked(worktree: string, rel: string): Promise<boolean> {
  return (await run(worktree, ["ls-files", "--error-unmatch", rel])).code === 0;
}

export interface InstalledHooks {
  claude: boolean;
  cursor: boolean;
}

/**
 * Wire hooks for every agent that supports file-based hooks. A file the repo
 * itself tracks is left alone (editing it would show up as the agent's change);
 * that agent falls back to activity-based status.
 */
export async function installAgentHooks(worktree: string, script: string): Promise<InstalledHooks> {
  const out: InstalledHooks = { claude: false, cursor: false };

  // Claude Code: https://code.claude.com/docs/en/hooks
  const claudeRel = ".claude/settings.local.json";
  if (!(await tracked(worktree, claudeRel))) {
    const file = path.join(worktree, claudeRel);
    let settings: { hooks?: Record<string, unknown[]> } & Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        settings = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
    }
    const handler = { type: "command", command: `${sh(script)} claude`, timeout: 5 };
    const group = (matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [handler] }];
    settings.hooks = {
      ...(settings.hooks ?? {}),
      UserPromptSubmit: group(),
      PostToolUse: group("*"),
      Notification: group(),
      Stop: group(),
      StopFailure: group(),
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(settings, null, 2) + "\n");
    out.claude = true;
  }

  // Cursor: https://cursor.com/docs/agent/hooks
  const cursorRel = ".cursor/hooks.json";
  if (!(await tracked(worktree, cursorRel))) {
    const file = path.join(worktree, cursorRel);
    // Observe-only events: none of these can block or rewrite what the agent does.
    const cmd = [{ command: `${sh(script)} cursor` }];
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 1, hooks: { sessionStart: cmd, postToolUse: cmd, stop: cmd } }, null, 2) + "\n",
    );
    out.cursor = true;
  }
  return out;
}

/** Codex has no project hook file; its `notify` program is passed per invocation. */
export function codexNotifyFlag(script: string): string {
  return `-c ${sh(`notify=["${script.replace(/"/g, '\\"')}","codex"]`)}`;
}

export type HookState = "working" | "attention" | "idle";

export interface HookEvent {
  state: HookState;
  /** Short human text: the permission being asked for, or the agent's last message. */
  detail?: string;
  event: string;
}

const clip = (s: unknown, n = 280) => {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : undefined;
};

/** Translate one agent's hook payload into Octave's status model. */
export function mapHookEvent(agent: string, p: Record<string, unknown>): HookEvent | null {
  if (agent === "claude") {
    const ev = String(p.hook_event_name ?? "");
    switch (ev) {
      case "UserPromptSubmit":
      case "PostToolUse":
        return { state: "working", event: ev };
      case "Notification":
        if (p.notification_type === "permission_prompt") return { state: "attention", detail: clip(p.message), event: ev };
        if (p.notification_type === "idle_prompt") return { state: "idle", detail: clip(p.message), event: ev };
        return null;
      case "Stop":
        return { state: "idle", detail: clip(p.last_assistant_message), event: ev };
      case "StopFailure":
        return { state: "idle", detail: "The turn ended with an API error", event: ev };
      default:
        return null;
    }
  }
  if (agent === "codex") {
    const type = String(p.type ?? "");
    if (type === "agent-turn-complete") return { state: "idle", detail: clip(p["last-assistant-message"]), event: type };
    if (type === "approval-requested") return { state: "attention", detail: "Codex is asking for approval", event: type };
    return null;
  }
  if (agent === "cursor") {
    const ev = String(p.hook_event_name ?? "");
    if (ev === "stop") {
      const status = String(p.status ?? "completed");
      return { state: "idle", detail: status === "completed" ? undefined : `Cursor stopped: ${status}`, event: ev };
    }
    if (ev === "sessionStart" || ev === "postToolUse") return { state: "working", event: ev };
    return null;
  }
  return null;
}
