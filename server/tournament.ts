import { spawn } from "node:child_process";
import { cleanEnv, shellInvocation } from "./pty";
import type { Entrant } from "./store";

/**
 * Entrant scoring, in priority order:
 *   1. did verification pass (tests/typecheck/lint)
 *   2. did the agent actually change anything
 *   3. lower review risk
 *   4. smaller diff (less to review, less to break)
 */
export function scoreEntrant(e: Entrant): number {
  if (!e.files) return -1000; // no work produced
  let s = 0;
  if (e.verify?.passed) s += 1000;
  if (e.exitCode != null && e.exitCode !== 0) s -= 100;
  s -= (e.risk ?? 0) * 3;
  s -= Math.min(300, (e.churn ?? 0) / 2);
  return Math.round(s);
}

export function rankEntrants(entrants: Entrant[]): Entrant[] {
  return entrants
    .map((e) => ({ ...e, score: scoreEntrant(e) }))
    .sort((a, b) => b.score! - a.score!);
}

export interface VerifyResult {
  passed: boolean;
  code: number | null;
  durationMs: number;
  tail: string;
}

/** Run the verification command in a worktree, capturing the output tail. */
export function runVerify(
  cwd: string,
  command: string,
  env: Record<string, string>,
  timeoutMs = 10 * 60_000,
): Promise<VerifyResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const { file, args } = shellInvocation(command, false);
    const child = spawn(file, args, { cwd, env: { ...cleanEnv(), ...env, CI: "1" } });
    let out = "";
    const keep = (b: Buffer) => {
      out = (out + b.toString()).slice(-6000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      out += `\n[octave] verification timed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, code, durationMs: Date.now() - started, tail: out });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ passed: false, code: null, durationMs: Date.now() - started, tail: String(err) });
    });
  });
}
