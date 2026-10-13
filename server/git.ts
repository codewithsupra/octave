import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
      },
    );
  });
}

/** Like run(), but throws on a non-zero exit. */
export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await run(cwd, args, env);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

export async function repoRoot(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
}

export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function revParse(dir: string, ref: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const r = await run(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.code === 0;
}

export async function addWorktree(repo: string, dir: string, branch: string, base: string): Promise<void> {
  await git(repo, ["worktree", "add", "-b", branch, dir, base]);
}

export async function removeWorktree(repo: string, dir: string, deleteBranch?: string): Promise<void> {
  await run(repo, ["worktree", "remove", "--force", dir]);
  await run(repo, ["worktree", "prune"]);
  if (deleteBranch) await run(repo, ["branch", "-D", deleteBranch]);
}

/**
 * Capture the worktree's full state (tracked edits + untracked files) as a
 * dangling commit, using a throwaway index so the agent's own index and
 * working tree are never touched. If nothing changed, returns HEAD.
 */
export async function snapshot(worktree: string): Promise<string> {
  const head = await revParse(worktree, "HEAD");
  const dir = await mkdtemp(path.join(tmpdir(), "octave-idx-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    await git(worktree, ["read-tree", "HEAD"], env);
    await git(worktree, ["add", "-A", "--", "."], env);
    const tree = (await git(worktree, ["write-tree"], env)).trim();
    const headTree = (await git(worktree, ["rev-parse", "HEAD^{tree}"])).trim();
    if (tree === headTree) return head;
    const commit = await git(
      worktree,
      ["commit-tree", tree, "-p", head, "-m", "octave snapshot"],
      {
        GIT_AUTHOR_NAME: "octave",
        GIT_AUTHOR_EMAIL: "octave@localhost",
        GIT_COMMITTER_NAME: "octave",
        GIT_COMMITTER_EMAIL: "octave@localhost",
        // Fixed dates make snapshots content-addressed: same tree + parent
        // => same SHA, so diff/merge results can be cached across polls.
        GIT_AUTHOR_DATE: "1700000000 +0000",
        GIT_COMMITTER_DATE: "1700000000 +0000",
      },
    );
    return commit.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  return (await git(repo, ["merge-base", a, b])).trim();
}

export interface FileChange {
  path: string;
  status: "A" | "M" | "D" | "R";
  added: number;
  deleted: number;
  binary: boolean;
}

/** Per-file change summary between two commits. */
export async function diffFiles(repo: string, from: string, to: string): Promise<FileChange[]> {
  const [numstat, names] = await Promise.all([
    git(repo, ["diff", "--numstat", "-z", "--no-renames", from, to]),
    git(repo, ["diff", "--name-status", "-z", "--no-renames", from, to]),
  ]);
  const status = new Map<string, FileChange["status"]>();
  const ns = names.split("\0").filter(Boolean);
  for (let i = 0; i + 1 < ns.length; i += 2) status.set(ns[i + 1], ns[i][0] as FileChange["status"]);

  const out: FileChange[] = [];
  for (const rec of numstat.split("\0").filter(Boolean)) {
    const [a, d, ...rest] = rec.split("\t");
    const p = rest.join("\t");
    const binary = a === "-";
    out.push({
      path: p,
      status: status.get(p) ?? "M",
      added: binary ? 0 : Number(a),
      deleted: binary ? 0 : Number(d),
      binary,
    });
  }
  return out;
}

export async function diffPatch(repo: string, from: string, to: string, file?: string): Promise<string> {
  const args = ["diff", "--no-renames", "--no-color", from, to];
  if (file) args.push("--", file);
  return git(repo, args);
}

export interface MergePrediction {
  clean: boolean;
  conflicts: string[];
}

/** Real three-way merge in memory (git >= 2.38); nothing on disk changes. */
export async function predictMerge(repo: string, a: string, b: string): Promise<MergePrediction> {
  const r = await run(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", a, b]);
  if (r.code !== 0 && r.code !== 1) {
    throw new Error(`git merge-tree failed (${r.code}): ${r.stderr.trim()}`);
  }
  const lines = r.stdout.split("\n").map((l) => l.trim());
  const conflicts = [...new Set(lines.slice(1).filter(Boolean))];
  return { clean: r.code === 0, conflicts };
}

export async function commitAll(worktree: string, message: string): Promise<string | null> {
  await git(worktree, ["add", "-A"]);
  const staged = await run(worktree, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return null;
  await git(worktree, ["commit", "-m", message, "--no-verify"]);
  return revParse(worktree, "HEAD");
}

/** Files that are gitignored but present in the checkout. */
export async function ignoredFiles(repo: string): Promise<string[]> {
  const out = await git(repo, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--directory", "--no-empty-directory"]);
  return out.split("\0").filter(Boolean);
}
