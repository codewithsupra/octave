import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ignoredFiles } from "./git";
import { renderEnvFile } from "./ports";

export interface StackInfo {
  kind: string;
  install: string | null;
}

const DETECTORS: Array<[string, string, string]> = [
  // [marker file, kind, install command]
  ["pnpm-lock.yaml", "pnpm", "pnpm install --frozen-lockfile --prefer-offline"],
  ["bun.lockb", "bun", "bun install --frozen-lockfile"],
  ["bun.lock", "bun", "bun install --frozen-lockfile"],
  ["yarn.lock", "yarn", "yarn install --frozen-lockfile"],
  ["package-lock.json", "npm", "npm ci --prefer-offline --no-audit --no-fund"],
  ["uv.lock", "uv", "uv sync"],
  ["poetry.lock", "poetry", "poetry install"],
  ["requirements.txt", "pip", "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"],
  ["Cargo.toml", "cargo", "cargo fetch"],
  ["go.mod", "go", "go mod download"],
  ["Gemfile.lock", "bundler", "bundle install"],
  ["package.json", "npm", "npm install --no-package-lock --no-audit --no-fund"],
];

/** Zero-config: figure out how to install deps from the files present. */
export function detectStack(dir: string): StackInfo {
  for (const [marker, kind, install] of DETECTORS) {
    if (existsSync(path.join(dir, marker))) return { kind, install };
  }
  return { kind: "none", install: null };
}

const ENV_RE = /(^|\/)\.env(\.[\w.-]+)?$/;
const SKIP_RE = /(^|\/)(node_modules|\.venv|venv|target|dist|build|\.next)\//;

/**
 * Copies gitignored .env files (which `git worktree add` leaves behind) from
 * the main checkout into the new worktree, preserving relative paths.
 */
export async function copyEnvFiles(repo: string, worktree: string): Promise<string[]> {
  const copied: string[] = [];
  for (const rel of await ignoredFiles(repo)) {
    if (rel.endsWith("/") || SKIP_RE.test(rel) || !ENV_RE.test(rel)) continue;
    const src = path.join(repo, rel);
    if (!existsSync(src) || !statSync(src).isFile()) continue;
    const dst = path.join(worktree, rel);
    if (existsSync(dst)) continue;
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(src, dst);
    copied.push(rel);
  }
  return copied;
}

export async function writePortEnv(worktree: string, env: Record<string, string>): Promise<void> {
  await writeFile(path.join(worktree, ".env.octave"), renderEnvFile(env));
}

/**
 * The shell snippet run in the workspace terminal before the agent starts.
 * A repo-provided .octave/setup.sh always wins over auto-detection.
 */
export function setupScript(worktree: string): string | null {
  const custom = path.join(worktree, ".octave", "setup.sh");
  if (existsSync(custom)) return `sh ${JSON.stringify(custom)}`;
  return detectStack(worktree).install;
}
