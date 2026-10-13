import { EventEmitter } from "node:events";
import * as nodePty from "node-pty";

export type SessionStatus = "running" | "idle" | "exited";

const SCROLLBACK_BYTES = 512 * 1024;
const IDLE_AFTER_MS = 4000;

export interface SpawnOpts {
  cwd: string;
  command: string; // empty -> plain login shell
  env: Record<string, string>;
  keepShell: boolean; // drop into a shell when the command exits
  cols?: number;
  rows?: number;
}

/**
 * The server's own env minus anything injected by the tool that launched it
 * (npm/pnpm scripts set npm_config_prefix etc., which breaks nvm and leaks
 * Octave's package context into every agent shell).
 */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^(npm|pnpm|yarn|bun)_/i.test(k) || k === "INIT_CWD" || k === "NODE_ENV" || k === "OCTAVE_HOME" || k === "OCTAVE_PORT") continue;
    out[k] = v;
  }
  return out;
}

export function shellInvocation(command: string, keepShell: boolean): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const file = "powershell.exe";
    if (!command) return { file, args: ["-NoLogo"] };
    return { file, args: keepShell ? ["-NoLogo", "-NoExit", "-Command", command] : ["-NoLogo", "-Command", command] };
  }
  const file = process.env.SHELL || "/bin/bash";
  if (!command) return { file, args: ["-l"] };
  return { file, args: ["-lc", keepShell ? `${command}; exec ${file} -l` : command] };
}

/**
 * One PTY per workspace. Keeps a bounded scrollback so a browser tab that
 * attaches later (or reloads) sees the full history, and derives a status
 * from output activity: an agent that stops printing is waiting on you.
 */
export class Session extends EventEmitter {
  status: SessionStatus = "running";
  exitCode: number | null = null;
  lastOutputAt = Date.now();
  startedAt = Date.now();
  private chunks: string[] = [];
  private bytes = 0;
  private proc: nodePty.IPty;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(public id: string, opts: SpawnOpts) {
    super();
    const { file, args } = shellInvocation(opts.command, opts.keepShell);
    this.proc = nodePty.spawn(file, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      cwd: opts.cwd,
      env: { ...cleanEnv(), TERM: "xterm-256color", COLORTERM: "truecolor", ...opts.env },
    });
    this.proc.onData((d) => this.onData(d));
    this.proc.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.setStatus("exited");
      this.emit("exit", exitCode);
    });
    this.armIdle();
  }

  private onData(d: string) {
    this.chunks.push(d);
    this.bytes += d.length;
    while (this.bytes > SCROLLBACK_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
    }
    this.lastOutputAt = Date.now();
    if (this.status === "idle") this.setStatus("running");
    this.armIdle();
    this.emit("data", d);
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.status === "running") this.setStatus("idle");
    }, IDLE_AFTER_MS);
  }

  private setStatus(s: SessionStatus) {
    if (s === this.status) return;
    this.status = s;
    this.emit("status", s);
  }

  scrollback(): string {
    return this.chunks.join("");
  }

  write(d: string) {
    if (this.status !== "exited") this.proc.write(d);
  }

  resize(cols: number, rows: number) {
    if (this.status === "exited") return;
    try {
      this.proc.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
    } catch {}
  }

  kill() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.status !== "exited") {
      try {
        this.proc.kill();
      } catch {}
    }
  }
}

export interface SessionInfo {
  status: SessionStatus;
  exitCode: number | null;
  lastOutputAt: number;
  startedAt: number;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();

  start(id: string, opts: SpawnOpts): Session {
    this.sessions.get(id)?.kill();
    const s = new Session(id, opts);
    this.sessions.set(id, s);
    s.on("status", (status) => this.emit("status", id, status));
    s.on("exit", (code) => this.emit("exit", id, code));
    this.emit("status", id, s.status);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  stop(id: string) {
    this.sessions.get(id)?.kill();
    this.sessions.delete(id);
  }

  statuses(): Record<string, SessionInfo> {
    const out: Record<string, SessionInfo> = {};
    for (const [id, s] of this.sessions) out[id] = { status: s.status, exitCode: s.exitCode, lastOutputAt: s.lastOutputAt, startedAt: s.startedAt };
    return out;
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}
