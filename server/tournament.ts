import { spawn } from "node:child_process";
import { cleanEnv, shellInvocation } from "./pty";

export { rankEntrants, scoreEntrant } from "./scoring";

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
