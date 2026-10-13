import { describe, it, expect } from "vitest";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { makeRepo, write, tmp } from "./helpers";
import { detectStack, copyEnvFiles, setupScript } from "../server/bootstrap";
import { addWorktree } from "../server/git";

describe("zero-config bootstrap", () => {
  it("detects package managers by lockfile priority", () => {
    const d = tmp();
    expect(detectStack(d).kind).toBe("none");
    write(d, "package.json", "{}");
    expect(detectStack(d).kind).toBe("npm");
    expect(detectStack(d).install).toContain("--no-package-lock"); // never invent a lockfile
    write(d, "pnpm-lock.yaml", "");
    expect(detectStack(d)).toMatchObject({ kind: "pnpm" });
    expect(setupScript(d)).toContain("pnpm install");
    expect(detectStack(tmp()).install).toBeNull();
    write(d, ".octave/setup.sh", "echo custom");
    expect(setupScript(d)).toContain(".octave/setup.sh");
  });

  it("copies gitignored .env files into new worktrees", async () => {
    const repo = makeRepo({ ".gitignore": ".env\n.env.*\nnode_modules/\n", "apps/web/x.ts": "" });
    write(repo, ".env", "SECRET=1\n");
    write(repo, "apps/web/.env.local", "A=2\n");
    write(repo, "node_modules/pkg/.env", "nope\n");
    const w = path.join(tmp(), "w");
    await addWorktree(repo, w, "oct/env", "main");
    const copied = await copyEnvFiles(repo, w);
    expect(copied.sort()).toEqual([".env", "apps/web/.env.local"]);
    expect(readFileSync(path.join(w, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(existsSync(path.join(w, "node_modules/pkg/.env"))).toBe(false);
  });
});
