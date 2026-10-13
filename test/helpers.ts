import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function write(dir: string, file: string, content: string): void {
  const p = path.join(dir, file);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** A fresh repo on branch main with one commit. */
export function makeRepo(files: Record<string, string> = { "README.md": "# demo\n" }): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "octave-test-")));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@t.dev");
  sh(dir, "config", "user.name", "t");
  sh(dir, "config", "commit.gpgsign", "false");
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

export function tmp(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "octave-tmp-")));
}
