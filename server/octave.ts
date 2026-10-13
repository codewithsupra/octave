import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { agentCommand } from "./agents";
import { GENERATED_FILES, codexNotifyFlag, installAgentHooks, mapHookEvent, newHookToken, tokenMatches, writeHookScript } from "./hooks";
import { copyEnvFiles, setupScript, writePortEnv } from "./bootstrap";
import * as G from "./git";
import { PortAllocator, portEnv } from "./ports";
import { SessionManager } from "./pty";
import { SQL_FILE, hasDestructiveSql, scoreDiff, triageOrder, type RiskReport } from "./risk";
import { HttpError, Store, type Project, type Tournament, type Workspace } from "./store";
import { rankEntrants, runVerify } from "./tournament";

const id = () => randomUUID().slice(0, 8);

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "ws"
  );
}

export interface DiffSummary {
  snapshot: string;
  base: string;
  files: G.FileChange[];
  risk: RiskReport;
}

export interface RadarPair {
  a: string;
  b: string;
  overlap: string[];
  conflicts: string[];
  severity: "none" | "overlap" | "conflict";
}

export interface Radar {
  pairs: RadarPair[];
  baseConflicts: Record<string, string[]>;
  computedAt: number;
}

export class Octave {
  sessions = new SessionManager();
  private ports = new PortAllocator();
  private diffCache = new Map<string, DiffSummary>();
  private mergeCache = new Map<string, G.MergePrediction>();

  /** Where agent hooks report to, e.g. http://127.0.0.1:7420. Unset: hooks stay dormant. */
  hookBase: string | null = null;
  readonly hookScript: string;

  constructor(public store: Store) {
    this.hookScript = writeHookScript(store.home);
    this.sessions.on("exit", (wsId: string, code: number) => this.onExit(wsId, code));
  }

  private command(agent: string, opts: { prompt?: string; headless?: boolean }): string {
    const flags = agent === "codex" ? codexNotifyFlag(this.hookScript) : undefined;
    return agentCommand(agent, { ...opts, flags });
  }

  // ---------- projects ----------

  async addProject(dir: string): Promise<Project> {
    const abs = path.resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    if (!existsSync(abs)) throw new HttpError(400, `Path does not exist: ${abs}`);
    let root: string;
    try {
      root = await G.repoRoot(abs);
    } catch {
      throw new HttpError(400, `Not a git repository: ${abs}`);
    }
    const existing = this.store.state.projects.find((p) => p.path === root);
    if (existing) return existing;
    let baseBranch = await G.currentBranch(root);
    if (baseBranch === "HEAD") baseBranch = (await G.revParse(root, "HEAD")).slice(0, 12);
    const project: Project = { id: id(), name: path.basename(root), path: root, baseBranch, createdAt: Date.now() };
    this.store.update((s) => s.projects.push(project));
    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    for (const w of this.store.state.workspaces.filter((w) => w.projectId === projectId)) {
      await this.removeWorkspace(w.id);
    }
    this.store.update((s) => {
      s.projects = s.projects.filter((p) => p.id !== projectId);
      s.tournaments = s.tournaments.filter((t) => t.projectId !== projectId);
    });
  }

  // ---------- workspaces ----------

  async createWorkspace(opts: {
    projectId: string;
    name?: string;
    agent: string;
    prompt?: string;
    headless?: boolean;
    bootstrap?: boolean;
    tournamentId?: string;
    /** false: create the worktree but don't start the agent yet. */
    start?: boolean;
  }): Promise<Workspace> {
    const project = this.store.project(opts.projectId);
    const base = opts.name?.trim() || opts.prompt?.trim().split(/\s+/).slice(0, 5).join(" ") || opts.agent;
    let slug = slugify(base);
    const taken = (s: string) =>
      this.store.state.workspaces.some((w) => w.projectId === project.id && w.name === s) ||
      existsSync(this.worktreeDir(project, s));
    for (let i = 2; taken(slug); i++) slug = `${slugify(base).slice(0, 36)}-${i}`;

    let branch = `octave/${slug}`;
    while (await G.branchExists(project.path, branch)) branch = `octave/${slug}-${id().slice(0, 4)}`;

    const dir = this.worktreeDir(project, slug);
    await mkdir(path.dirname(dir), { recursive: true });
    await G.addWorktree(project.path, dir, branch, project.baseBranch);

    const ports = await this.ports.allocate(this.store.state.workspaces.map((w) => w.ports));
    const env = portEnv(ports);
    await this.excludeOctaveFiles(project.path);
    await writePortEnv(dir, env);
    const copiedEnv = await copyEnvFiles(project.path, dir);
    const hooks = await installAgentHooks(dir, this.hookScript);

    const setup = opts.bootstrap === false ? null : setupScript(dir);
    const agentCmd = this.command(opts.agent, { prompt: opts.prompt, headless: opts.headless });
    const command = [setup && `echo '\\033[2m▸ octave setup: ${setup.replace(/'/g, "")}\\033[0m' && (${setup})`, agentCmd]
      .filter(Boolean)
      .join(" ; ");

    const ws: Workspace = {
      id: id(),
      projectId: project.id,
      name: slug,
      branch,
      path: dir,
      baseBranch: project.baseBranch,
      agent: opts.agent,
      prompt: opts.prompt,
      command,
      ports,
      copiedEnv,
      setup,
      tournamentId: opts.tournamentId,
      hookToken: newHookToken(),
      hooks,
      createdAt: Date.now(),
    };
    this.store.update((s) => s.workspaces.push(ws));
    if (opts.start !== false) this.startSession(ws, !opts.headless);
    return ws;
  }

  private worktreeDir(project: Project, slug: string): string {
    return path.join(this.store.home, "worktrees", `${slugify(project.name)}-${project.id}`, slug);
  }

  /** Octave's own files must never show up as a change in diffs or commits. */
  private async excludeOctaveFiles(repo: string) {
    const common = (await G.git(repo, ["rev-parse", "--git-common-dir"])).trim();
    const file = path.resolve(repo, common, "info", "exclude");
    await mkdir(path.dirname(file), { recursive: true });
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    // .venv/ is created by the pip bootstrap and must not read as agent churn.
    const want = [".env.octave", ".venv/", ...GENERATED_FILES].filter((l) => !cur.split("\n").includes(l));
    if (want.length) {
      await appendFile(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# octave\n${want.join("\n")}\n`);
    }
  }

  private wsEnv(ws: Workspace): Record<string, string> {
    if (!ws.hookToken) {
      const token = newHookToken();
      this.store.update(() => (ws.hookToken = token));
    }
    return {
      ...portEnv(ws.ports),
      OCTAVE: "1",
      OCTAVE_WORKSPACE: ws.name,
      OCTAVE_BRANCH: ws.branch,
      OCTAVE_BASE_BRANCH: ws.baseBranch,
      ...(this.hookBase ? { OCTAVE_HOOK_URL: `${this.hookBase}/api/hooks/${ws.id}`, OCTAVE_HOOK_TOKEN: ws.hookToken! } : {}),
    };
  }

  /**
   * An agent's lifecycle hook reported in. Authenticated by the workspace's
   * own secret (hooks can't sign in), compared in constant time.
   */
  applyHook(wsId: string, authorization: string | undefined, agent: string, payload: Record<string, unknown>): "ok" | "ignored" | "forbidden" {
    const ws = this.store.state.workspaces.find((w) => w.id === wsId);
    if (!ws || !tokenMatches(ws.hookToken, authorization)) return "forbidden";
    const ev = mapHookEvent(agent, payload);
    const session = this.sessions.get(wsId);
    if (!ev || !session) return "ignored";
    session.applyHook(ev.state, ev.event, ev.detail);
    return "ok";
  }

  startSession(ws: Workspace, keepShell: boolean, command = ws.command) {
    return this.sessions.start(ws.id, { cwd: ws.path, command, env: this.wsEnv(ws), keepShell });
  }

  restartWorkspace(wsId: string, mode: "agent" | "shell") {
    const ws = this.store.workspace(wsId);
    const cmd = mode === "shell" ? "" : this.command(ws.agent, {});
    return this.startSession(ws, true, cmd);
  }

  async removeWorkspace(wsId: string, keepBranch = false): Promise<void> {
    const ws = this.store.workspace(wsId);
    const project = this.store.project(ws.projectId);
    this.sessions.stop(ws.id);
    await G.removeWorktree(project.path, ws.path, keepBranch ? undefined : ws.branch);
    this.store.update((s) => (s.workspaces = s.workspaces.filter((w) => w.id !== wsId)));
  }

  async diff(wsId: string): Promise<DiffSummary> {
    const ws = this.store.workspace(wsId);
    const project = this.store.project(ws.projectId);
    if (!existsSync(ws.path)) throw new HttpError(410, `Worktree missing on disk: ${ws.path}`);
    const snap = await G.snapshot(ws.path);
    const baseRef = (await G.revParse(project.path, ws.baseBranch).catch(() => null)) ?? ws.baseBranch;
    const key = `${snap}:${baseRef}`;
    const hit = this.diffCache.get(key);
    if (hit) return hit;
    const base = await G.mergeBase(project.path, snap, baseRef);
    const files = await G.diffFiles(project.path, base, snap);
    const destructiveSql: string[] = [];
    for (const f of files.filter((f) => SQL_FILE.test(f.path) && !f.binary && f.added > 0)) {
      if (hasDestructiveSql(await G.diffPatch(project.path, base, snap, f.path))) destructiveSql.push(f.path);
    }
    const out = { snapshot: snap, base, files, risk: scoreDiff(files, { destructiveSql }) };
    if (this.diffCache.size > 500) this.diffCache.clear();
    this.diffCache.set(key, out);
    return out;
  }

  async patch(wsId: string, file?: string): Promise<string> {
    const d = await this.diff(wsId);
    return G.diffPatch(this.store.project(this.store.workspace(wsId).projectId).path, d.base, d.snapshot, file);
  }

  async commit(wsId: string, message: string): Promise<string | null> {
    const ws = this.store.workspace(wsId);
    return G.commitAll(ws.path, message || `octave: ${ws.name}`);
  }

  // ---------- Feature 1: Conflict Radar ----------

  private async predict(repo: string, a: string, b: string): Promise<G.MergePrediction> {
    const key = `${a}:${b}`;
    const hit = this.mergeCache.get(key);
    if (hit) return hit;
    const r = await G.predictMerge(repo, a, b);
    if (this.mergeCache.size > 2000) this.mergeCache.clear();
    this.mergeCache.set(key, r);
    return r;
  }

  /**
   * For every pair of live workspaces, find files both touched and run a real
   * in-memory three-way merge of their current (uncommitted) state. Also checks
   * each workspace against the base branch, which may have moved on.
   */
  async radar(projectId: string): Promise<Radar> {
    const project = this.store.project(projectId);
    const wss = this.store.state.workspaces.filter((w) => w.projectId === projectId && existsSync(w.path));
    const diffs = new Map<string, DiffSummary>();
    await Promise.all(
      wss.map(async (w) => {
        try {
          diffs.set(w.id, await this.diff(w.id));
        } catch {}
      }),
    );
    const live = wss.filter((w) => diffs.get(w.id)?.files.length);
    const pairs: RadarPair[] = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        // Entrants of one tournament are alternatives by design, not collaborators.
        if (live[i].tournamentId && live[i].tournamentId === live[j].tournamentId) continue;
        const A = diffs.get(live[i].id)!, B = diffs.get(live[j].id)!;
        const bPaths = new Set(B.files.map((f) => f.path));
        const overlap = A.files.map((f) => f.path).filter((p) => bPaths.has(p));
        let conflicts: string[] = [];
        if (overlap.length) conflicts = (await this.predict(project.path, A.snapshot, B.snapshot)).conflicts;
        pairs.push({
          a: live[i].id,
          b: live[j].id,
          overlap,
          conflicts,
          severity: conflicts.length ? "conflict" : overlap.length ? "overlap" : "none",
        });
      }
    }
    const baseConflicts: Record<string, string[]> = {};
    const baseSha = await G.revParse(project.path, project.baseBranch).catch(() => null);
    if (baseSha) {
      for (const w of live) {
        const d = diffs.get(w.id)!;
        if (d.base === baseSha) continue; // base hasn't moved; can't conflict
        const r = await this.predict(project.path, d.snapshot, baseSha);
        if (r.conflicts.length) baseConflicts[w.id] = r.conflicts;
      }
    }
    const rank = { conflict: 0, overlap: 1, none: 2 };
    pairs.sort((x, y) => rank[x.severity] - rank[y.severity] || y.overlap.length - x.overlap.length);
    return { pairs, baseConflicts, computedAt: Date.now() };
  }

  // ---------- Feature 2: Review Triage ----------

  async triage(projectId: string) {
    // Tournament entrants are judged on the leaderboard; only a winner joins the queue.
    const winners = new Set(this.store.state.tournaments.map((t) => t.winner).filter(Boolean));
    const wss = this.store.state.workspaces.filter(
      (w) => w.projectId === projectId && existsSync(w.path) && (!w.tournamentId || winners.has(w.id)),
    );
    const statuses = this.sessions.statuses();
    const items = await Promise.all(
      wss.map(async (w) => {
        const d = await this.diff(w.id).catch(() => null);
        return d ? { item: { workspaceId: w.id, status: statuses[w.id]?.status ?? "exited" }, risk: d.risk } : null;
      }),
    );
    const ordered = triageOrder(items.filter((x): x is NonNullable<typeof x> => !!x));
    // Work that is still actively being written isn't ready to review yet.
    const ready = ordered.filter((x) => x.item.status !== "running");
    const inFlight = ordered.filter((x) => x.item.status === "running");
    return { queue: [...ready, ...inFlight].map((x) => ({ ...x.item, risk: x.risk, ready: x.item.status !== "running" })) };
  }

  // ---------- Feature 3: Agent Tournament ----------

  async createTournament(opts: { projectId: string; prompt: string; verify: string; agents: string[] }): Promise<Tournament> {
    if (!opts.prompt.trim()) throw new HttpError(400, "Prompt is required");
    if (opts.agents.length < 2) throw new HttpError(400, "A tournament needs at least 2 entrants");
    if (opts.agents.length > 8) throw new HttpError(400, "At most 8 entrants");
    const t: Tournament = {
      id: id(),
      projectId: opts.projectId,
      prompt: opts.prompt,
      verify: opts.verify.trim(),
      status: "running",
      entrants: [],
      createdAt: Date.now(),
    };
    this.store.update((s) => s.tournaments.unshift(t));
    const counts: Record<string, number> = {};
    const created: Workspace[] = [];
    for (const agent of opts.agents) {
      const label = agent.startsWith("custom:") ? "custom" : agent;
      counts[label] = (counts[label] ?? 0) + 1;
      const ws = await this.createWorkspace({
        projectId: opts.projectId,
        name: `t-${t.id}-${label}-${counts[label]}`,
        agent,
        prompt: opts.prompt,
        headless: true,
        tournamentId: t.id,
        start: false,
      });
      created.push(ws);
      this.store.update(() => this.store.tournament(t.id).entrants.push({ workspaceId: ws.id, agent }));
    }
    // Start only once the full roster is registered, so a fast entrant can't
    // trigger judging before its siblings exist.
    for (const ws of created) this.startSession(ws, false);
    return this.store.tournament(t.id);
  }

  private onExit(wsId: string, code: number) {
    const ws = this.store.state.workspaces.find((w) => w.id === wsId);
    if (!ws?.tournamentId) return;
    const t = this.store.state.tournaments.find((x) => x.id === ws.tournamentId);
    if (!t || t.status !== "running") return;
    this.store.update(() => {
      const e = t.entrants.find((e) => e.workspaceId === wsId);
      if (e) e.exitCode = code;
    });
    const allDone = t.entrants.every((e) => e.exitCode !== undefined);
    if (allDone && t.entrants.length) void this.judge(t.id);
  }

  async judge(tournamentId: string): Promise<Tournament> {
    const t = this.store.tournament(tournamentId);
    if (t.status === "judging") return t;
    this.store.update(() => (t.status = "judging"));
    for (const e of t.entrants) this.sessions.get(e.workspaceId)?.kill();
    try {
      await Promise.all(
        t.entrants.map(async (e) => {
          const ws = this.store.state.workspaces.find((w) => w.id === e.workspaceId);
          if (!ws || !existsSync(ws.path)) return;
          const d = await this.diff(ws.id).catch(() => null);
          const verify = t.verify && d?.files.length ? await runVerify(ws.path, t.verify, this.wsEnv(ws)) : undefined;
          this.store.update(() => {
            e.files = d?.files.length ?? 0;
            e.churn = d ? d.risk.stats.added + d.risk.stats.deleted : 0;
            e.risk = d?.risk.score ?? 0;
            e.verify = verify ?? (t.verify ? undefined : { passed: true, code: 0, durationMs: 0, tail: "(no verify command)" });
          });
        }),
      );
      const ranked = rankEntrants(t.entrants);
      this.store.update(() => {
        t.entrants = ranked;
        t.winner = ranked[0] && ranked[0].score! > -1000 ? ranked[0].workspaceId : undefined;
        t.status = "done";
      });
    } catch (err) {
      this.store.update(() => (t.status = "done"));
      throw err;
    }
    return t;
  }

  async adoptWinner(tournamentId: string): Promise<{ branch: string; sha: string | null }> {
    const t = this.store.tournament(tournamentId);
    if (!t.winner) throw new HttpError(400, "Tournament has no winner");
    const ws = this.store.workspace(t.winner);
    const sha = await this.commit(ws.id, `octave tournament ${t.id}: ${t.prompt.slice(0, 60)}`);
    for (const e of t.entrants) {
      if (e.workspaceId !== t.winner && this.store.state.workspaces.some((w) => w.id === e.workspaceId)) {
        await this.removeWorkspace(e.workspaceId);
      }
    }
    return { branch: ws.branch, sha };
  }

  shutdown() {
    this.sessions.stopAll();
    this.store.flush();
  }
}
