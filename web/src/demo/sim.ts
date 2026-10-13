/**
 * In-browser Octave backend for the public demo. No server, no shells, no keys.
 * Agents are scripted, but every number on screen comes from Octave's real
 * engines: risk scoring and triage order (server/risk.ts) and tournament
 * ranking (server/scoring.ts). Conflicts are modelled the way a three-way merge
 * decides them: two agents conflict when their edited line ranges overlap.
 */
import type { Backend, TermHandlers } from "../api";
import { scoreDiff, triageOrder, hasDestructiveSql } from "../../../server/risk";
import { rankEntrants } from "../../../server/scoring";
import type { AppState, Entrant, FileChange, Project, Radar, RadarPair, Status, Tournament, Workspace } from "../types";

interface SimFile extends FileChange {
  ranges: [number, number][];
  patch: string;
}

interface SimWs {
  ws: Workspace;
  files: Map<string, SimFile>;
  status: Status;
  exitCode: number | null;
  startedAt: number;
  lastOutputAt: number;
  scrollback: string;
  listeners: Set<TermHandlers>;
  idleTimer?: number;
  line: string;
  /** How this agent reacts to a Conflict Radar heads-up. */
  onHeadsUp?: () => void;
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

const AGENT_PROMPT: Record<string, string> = {
  claude: C.dim("claude ›"),
  codex: C.dim("codex ›"),
  gemini: C.dim("gemini ›"),
  opencode: C.dim("opencode ›"),
  "cursor-agent": C.dim("cursor ›"),
  aider: C.dim("aider ›"),
  shell: "$",
};

function hunk(start: number, minus: string[], plus: string[], ctx: string[] = []): string {
  const body = [...ctx.map((l) => ` ${l}`), ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`)];
  return `@@ -${start},${minus.length + ctx.length} +${start},${plus.length + ctx.length} @@\n${body.join("\n")}\n`;
}

function file(path: string, status: FileChange["status"], ranges: [number, number][], patch: string): SimFile {
  const lines = patch.split("\n");
  return {
    path,
    status,
    ranges,
    patch,
    added: lines.filter((l) => l.startsWith("+")).length,
    deleted: lines.filter((l) => l.startsWith("-")).length,
    binary: false,
  };
}

const overlaps = (a: [number, number][], b: [number, number][]) =>
  a.some(([s1, e1]) => b.some(([s2, e2]) => s1 <= e2 && s2 <= e1));

const rid = () => Math.random().toString(16).slice(2, 10);

export class DemoSim implements Backend {
  project: Project = { id: "demo", name: "acme-shop", path: "~/code/acme-shop", baseBranch: "main" };
  private sims = new Map<string, SimWs>();
  private order: string[] = [];
  private tournaments: Tournament[] = [];
  private base = new Map<string, [number, number][]>(); // what main changed after workspaces branched
  private subs = new Set<(s: AppState) => void>();
  private timers: number[] = [];
  private pending = false;
  private nextPort = 4100;

  constructor() {
    this.seed();
  }

  // ---------- plumbing ----------

  reset() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.sims.forEach((s) => clearTimeout(s.idleTimer));
    this.sims.clear();
    this.order = [];
    this.tournaments = [];
    this.base.clear();
    this.nextPort = 4100;
    this.seed();
    this.emit();
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private emit() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      const s = this.snapshot();
      this.subs.forEach((f) => f(s));
    });
  }

  private snapshot(): AppState {
    const statuses: AppState["statuses"] = {};
    for (const [id, s] of this.sims) statuses[id] = { status: s.status, exitCode: s.exitCode, lastOutputAt: s.lastOutputAt, startedAt: s.startedAt };
    return {
      projects: [this.project],
      workspaces: this.order.map((id) => this.sims.get(id)!.ws),
      tournaments: this.tournaments.map((t) => ({ ...t, entrants: t.entrants.map((e) => ({ ...e })) })),
      statuses,
    };
  }

  private write(id: string, text: string) {
    const s = this.sims.get(id);
    if (!s) return;
    const d = text.replace(/\n/g, "\r\n");
    s.scrollback += d;
    s.lastOutputAt = Date.now();
    s.listeners.forEach((l) => l.onOut(d));
    if (s.status !== "exited") {
      if (s.status !== "running") { s.status = "running"; this.emit(); }
      clearTimeout(s.idleTimer);
      s.idleTimer = window.setTimeout(() => {
        if (s.status === "running") { s.status = "idle"; this.emit(); }
      }, 2200);
    }
  }

  private exit(id: string, code: number) {
    const s = this.sims.get(id);
    if (!s) return;
    clearTimeout(s.idleTimer);
    s.status = "exited";
    s.exitCode = code;
    s.listeners.forEach((l) => l.onExit(code));
    this.emit();
    this.onEntrantExit(id, code);
  }

  private edit(id: string, f: SimFile | null, path?: string) {
    const s = this.sims.get(id);
    if (!s) return;
    if (f) s.files.set(f.path, f);
    else if (path) s.files.delete(path);
    this.emit();
  }

  /** Run a script of [delay, action] steps for a workspace. */
  private play(id: string, steps: Array<[number, () => void]>) {
    let t = 0;
    for (const [dt, fn] of steps) {
      t += dt;
      this.later(t, () => this.sims.has(id) && fn());
    }
  }

  private add(opts: { name: string; agent: string; prompt?: string; tournamentId?: string }): SimWs {
    const id = rid();
    const base = this.nextPort;
    this.nextPort += 10;
    const ws: Workspace = {
      id,
      projectId: this.project.id,
      name: opts.name,
      branch: `octave/${opts.name}`,
      path: `~/.octave/worktrees/acme-shop/${opts.name}`,
      baseBranch: "main",
      agent: opts.agent,
      prompt: opts.prompt,
      command: opts.agent,
      ports: { base, ports: Array.from({ length: 10 }, (_, i) => base + i) },
      copiedEnv: [".env", "apps/web/.env.local"],
      setup: "pnpm install --frozen-lockfile --prefer-offline",
      tournamentId: opts.tournamentId,
      createdAt: Date.now(),
    };
    const sim: SimWs = { ws, files: new Map(), status: "running", exitCode: null, startedAt: Date.now(), lastOutputAt: Date.now(), scrollback: "", listeners: new Set(), line: "" };
    this.sims.set(id, sim);
    this.order.push(id);
    return sim;
  }

  private intro(id: string, agent: string, prompt?: string) {
    this.write(id, C.dim(`▸ octave setup: pnpm install --frozen-lockfile --prefer-offline\n`));
    this.write(id, C.dim(`  Lockfile is up to date, resolution step is skipped\n  Done in 1.4s\n`));
    this.write(id, C.dim(`▸ PORT=${this.sims.get(id)!.ws.ports.base}  2 env files copied\n\n`));
    if (prompt) this.write(id, `${AGENT_PROMPT[agent] ?? "›"} ${prompt}\n\n`);
  }

  // ---------- the scripted story ----------

  private seed() {
    const cartCtx = ["export function applyDiscount(total: number, code?: string) {"];

    // 1. Two agents rewrite the same lines of cart.ts -> a real conflict.
    const bulk = this.add({ name: "bulk-discounts", agent: "claude", prompt: "Add a BULK20 code: 20% off orders over $200" });
    this.intro(bulk.ws.id, "claude", bulk.ws.prompt);
    const bulkEdit = file("src/cart.ts", "M", [[8, 10]], hunk(8, ['  if (code === "SAVE10") return total * 0.9;'], ['  if (code === "SAVE10") return total * 0.9;', '  if (code === "BULK20" && total > 200) return total * 0.8;'], cartCtx));
    this.play(bulk.ws.id, [
      [900, () => this.write(bulk.ws.id, `${C.cyan("●")} Reading src/cart.ts, test/cart.test.ts\n`)],
      [1300, () => { this.write(bulk.ws.id, `${C.cyan("●")} Edit ${C.bold("src/cart.ts")} ${C.green("+2")} ${C.red("-1")}\n`); this.edit(bulk.ws.id, bulkEdit); }],
      [1500, () => {
        this.write(bulk.ws.id, `${C.cyan("●")} Edit ${C.bold("test/cart.test.ts")} ${C.green("+6")}\n`);
        this.edit(bulk.ws.id, file("test/cart.test.ts", "M", [[20, 26]], hunk(20, [], ['test("BULK20 over $200", () => {', '  expect(applyDiscount(300, "BULK20")).toBe(240);', "});", 'test("BULK20 under $200", () => {', '  expect(applyDiscount(100, "BULK20")).toBe(100);', "});"])));
      }],
      [1200, () => this.write(bulk.ws.id, `${C.cyan("●")} Run ${C.bold("pnpm test")}\n  ${C.green("✓")} 16 passed ${C.dim("(412ms)")}\n\n${C.green("✓")} Done. BULK20 applies 20% off above $200, with tests.\n${AGENT_PROMPT.claude} `)],
    ]);

    const refactor = this.add({ name: "discount-refactor", agent: "codex", prompt: "Refactor discounts into a lookup table" });
    this.intro(refactor.ws.id, "codex", refactor.ws.prompt);
    const refactorConflicting = file("src/cart.ts", "M", [[6, 12]], hunk(6, ['  if (code === "SAVE10") return total * 0.9;', "  return total;"], ["  const RATES: Record<string, number> = { SAVE10: 0.9 };", "  return total * (RATES[code ?? \"\"] ?? 1);"], cartCtx));
    const refactorSafe = file("src/discounts.ts", "A", [[1, 6]], hunk(1, [], ["export const RATES: Record<string, number> = {", "  SAVE10: 0.9,", "};", "", "export const rateFor = (code?: string) => RATES[code ?? \"\"] ?? 1;"]));
    this.play(refactor.ws.id, [
      [1400, () => this.write(refactor.ws.id, `${C.blue("▌")} exploring src/cart.ts\n`)],
      [2100, () => { this.write(refactor.ws.id, `${C.blue("▌")} apply_patch ${C.bold("src/cart.ts")} ${C.green("+2")} ${C.red("-2")}\n`); this.edit(refactor.ws.id, refactorConflicting); }],
      [1600, () => this.write(refactor.ws.id, `${C.blue("▌")} tests: 14 passed\n\nRefactor complete. Discounts now come from a RATES table.\n${AGENT_PROMPT.codex} `)],
    ]);
    refactor.onHeadsUp = () => {
      const id = refactor.ws.id;
      this.later(900, () => this.write(id, `\n${C.yellow("!")} Understood: another agent owns applyDiscount() in src/cart.ts.\n`));
      this.later(2000, () => { this.write(id, `${C.blue("▌")} revert ${C.bold("src/cart.ts")}\n`); this.edit(id, null, "src/cart.ts"); });
      this.later(3200, () => { this.write(id, `${C.blue("▌")} apply_patch ${C.bold("src/discounts.ts")} ${C.green("+5")} (new file)\n`); this.edit(id, refactorSafe); });
      this.later(4300, () => this.write(id, `Moved the lookup table into src/discounts.ts so cart.ts stays untouched.\n${AGENT_PROMPT.codex} `));
    };
    bulk.onHeadsUp = () => {
      const id = bulk.ws.id;
      this.later(900, () => this.write(id, `\n${C.yellow("!")} Noted. Keeping my BULK20 change minimal; it's two lines in applyDiscount().\n${AGENT_PROMPT.claude} `));
    };

    // 2. Same file, different lines -> overlap that merges cleanly.
    const tax = this.add({ name: "tax-by-region", agent: "gemini", prompt: "Make tax depend on the shipping region" });
    this.intro(tax.ws.id, "gemini", tax.ws.prompt);
    this.play(tax.ws.id, [
      [1700, () => this.write(tax.ws.id, `${C.cyan("✦")} Planning: tax() needs a region parameter.\n`)],
      [1500, () => {
        this.write(tax.ws.id, `${C.cyan("✦")} WriteFile ${C.bold("src/cart.ts")}\n`);
        this.edit(tax.ws.id, file("src/cart.ts", "M", [[18, 21]], hunk(18, ["export function tax(total: number) {", "  return total * 0.08;"], ['export function tax(total: number, region: "US" | "EU" = "US") {', '  return total * (region === "EU" ? 0.2 : 0.08);'])));
      }],
      [1400, () => this.write(tax.ws.id, `\nRegion-aware tax is in. Want me to thread region through checkout too?\n${AGENT_PROMPT.gemini} `)],
    ]);

    // 3. Risky: auth + destructive migration, and main moves underneath it.
    const sess = this.add({ name: "session-hardening", agent: "claude", prompt: "Shorten sessions to 15 minutes and drop the legacy token column" });
    this.intro(sess.ws.id, "claude", sess.ws.prompt);
    this.play(sess.ws.id, [
      [1100, () => this.write(sess.ws.id, `${C.cyan("●")} Reading src/auth/session.ts, db/schema.sql\n`)],
      [1400, () => {
        this.write(sess.ws.id, `${C.cyan("●")} Edit ${C.bold("src/auth/session.ts")} ${C.green("+1")} ${C.red("-1")}\n`);
        this.edit(sess.ws.id, file("src/auth/session.ts", "M", [[3, 3]], hunk(3, ["  const ttl = 60 * 60 * 1000; // 1 hour"], ["  const ttl = 15 * 60 * 1000; // 15 minutes"])));
      }],
      [1300, () => {
        this.write(sess.ws.id, `${C.cyan("●")} Write ${C.bold("db/migrations/0042_sessions.sql")} ${C.green("+3")}\n`);
        this.edit(sess.ws.id, file("db/migrations/0042_sessions.sql", "A", [[1, 3]], hunk(1, [], ["ALTER TABLE sessions DROP COLUMN legacy_token;", "ALTER TABLE sessions ADD COLUMN rotated_at timestamptz;", "UPDATE sessions SET rotated_at = now();"])));
      }],
      [1200, () => this.write(sess.ws.id, `\n${C.green("✓")} Sessions now last 15 minutes. Migration drops legacy_token.\n${AGENT_PROMPT.claude} `)],
    ]);
    // A teammate merges to main and touches the same line.
    this.later(9500, () => { this.base.set("src/auth/session.ts", [[3, 3]]); this.emit(); });

    // 4. Boring and safe.
    const readme = this.add({ name: "readme-polish", agent: "opencode", prompt: "Document the discount codes in the README" });
    this.intro(readme.ws.id, "opencode", readme.ws.prompt);
    this.play(readme.ws.id, [
      [1200, () => { this.write(readme.ws.id, `${C.dim("[edit]")} README.md\n`); this.edit(readme.ws.id, file("README.md", "M", [[40, 46]], hunk(40, [], ["## Discount codes", "", "| Code | Effect |", "|---|---|", "| SAVE10 | 10% off |"]))); }],
      [900, () => this.write(readme.ws.id, `Added a discount-code table to the README.\n${AGENT_PROMPT.opencode} `)],
    ]);

    // 5. A tournament already underway.
    this.startTournament(
      "Fix slugify so punctuation is stripped and dashes are trimmed",
      "pnpm test --filter slug",
      ["claude", "codex", "gemini"],
      [
        { pass: true, files: [file("src/slug.ts", "M", [[1, 3]], hunk(1, ['  return s.toLowerCase().replace(/ /g, "-");'], ['  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");']))], ms: 6200 },
        { pass: false, files: [file("src/slug.ts", "M", [[1, 3]], hunk(1, ['  return s.toLowerCase().replace(/ /g, "-");'], ['  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/ +/g, "-");']))], ms: 4100 },
        {
          pass: true,
          files: [
            file("src/slug.ts", "M", [[1, 14]], hunk(1, ['  return s.toLowerCase().replace(/ /g, "-");'], ["const DASH = \"-\";", "const normalize = (s: string) => s.normalize(\"NFKD\").toLowerCase();", "const collapse = (s: string) => s.replace(/[^a-z0-9]+/g, DASH);", "const trim = (s: string) => s.replace(/^-+/, \"\").replace(/-+$/, \"\");", "", "export function slugify(s: string) {", "  return trim(collapse(normalize(s)));", "}"])),
            file("package.json", "M", [[3, 3]], hunk(3, ['  "version": "1.4.0",'], ['  "version": "1.4.1",'])),
          ],
          ms: 8300,
        },
      ],
    );
  }

  private startTournament(prompt: string, verify: string, agents: string[], plan?: Array<{ pass: boolean; files: SimFile[]; ms: number }>) {
    const t: Tournament = { id: rid(), projectId: this.project.id, prompt, verify, status: "running", entrants: [], createdAt: Date.now() };
    this.tournaments.unshift(t);
    agents.forEach((agent, i) => {
      const p = plan?.[i] ?? randomPlan(prompt);
      const s = this.add({ name: `t-${t.id}-${agent}-${i + 1}`, agent, prompt, tournamentId: t.id });
      t.entrants.push({ workspaceId: s.ws.id, agent });
      (s as SimWs & { plan?: typeof p }).plan = p;
      const id = s.ws.id;
      this.write(id, C.dim(`▸ headless run: ${agent}\n\n`));
      this.play(id, [
        [p.ms * 0.3, () => this.write(id, `${C.cyan("●")} Reading ${p.files.map((f) => f.path).join(", ")}\n`)],
        [p.ms * 0.4, () => { p.files.forEach((f) => { this.write(id, `${C.cyan("●")} Edit ${C.bold(f.path)} ${C.green(`+${f.added}`)} ${C.red(`-${f.deleted}`)}\n`); this.edit(id, f); }); }],
        [p.ms * 0.3, () => { this.write(id, `\n${C.green("✓")} Finished.\n`); this.exit(id, 0); }],
      ]);
    });
    this.emit();
    return t;
  }

  private onEntrantExit(id: string, code: number) {
    const t = this.tournaments.find((x) => x.entrants.some((e) => e.workspaceId === id));
    if (!t || t.status !== "running") return;
    t.entrants.find((e) => e.workspaceId === id)!.exitCode = code;
    if (t.entrants.every((e) => e.exitCode !== undefined)) this.judge(t);
  }

  private judge(t: Tournament) {
    if (t.status !== "running") return;
    t.status = "judging";
    this.emit();
    this.later(1600, () => {
      for (const e of t.entrants) {
        const s = this.sims.get(e.workspaceId);
        const plan = (s as (SimWs & { plan?: { pass: boolean } }) | undefined)?.plan;
        const d = s ? this.diffOf(s) : null;
        e.files = d?.files.length ?? 0;
        e.churn = d ? d.risk.stats.added + d.risk.stats.deleted : 0;
        e.risk = d?.risk.score ?? 0;
        const passed = !!plan?.pass && !!e.files;
        e.verify = { passed, code: passed ? 0 : 1, durationMs: 900 + Math.round(Math.random() * 900), tail: passed ? "✓ 9 passed" : "✗ slugify > trims dashes\n  expected 'hi' but got '-hi-'" };
      }
      const ranked = rankEntrants(t.entrants as Entrant[]);
      t.entrants = ranked;
      t.winner = ranked[0] && (ranked[0].score ?? -1000) > -1000 ? ranked[0].workspaceId : undefined;
      t.status = "done";
      this.emit();
    });
  }

  // ---------- derived views (real engines) ----------

  private diffOf(s: SimWs) {
    const files = [...s.files.values()];
    const destructiveSql = files.filter((f) => /\.sql$|migrations?\//.test(f.path) && hasDestructiveSql(f.patch)).map((f) => f.path);
    const plain: FileChange[] = files.map(({ path, status, added, deleted, binary }) => ({ path, status, added, deleted, binary }));
    const snap = files.map((f) => f.path + f.added + f.deleted + f.ranges.join()).join("|");
    return { snapshot: `demo-${hash(snap)}`, base: "main", files: plain, risk: scoreDiff(plain, { destructiveSql }) };
  }

  private radar(): Radar {
    const live = this.order.map((id) => this.sims.get(id)!).filter((s) => s.files.size > 0);
    const pairs: RadarPair[] = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const A = live[i], B = live[j];
        if (A.ws.tournamentId && A.ws.tournamentId === B.ws.tournamentId) continue;
        const overlap = [...A.files.keys()].filter((p) => B.files.has(p));
        const conflicts = overlap.filter((p) => overlaps(A.files.get(p)!.ranges, B.files.get(p)!.ranges));
        pairs.push({ a: A.ws.id, b: B.ws.id, overlap, conflicts, severity: conflicts.length ? "conflict" : overlap.length ? "overlap" : "none" });
      }
    }
    const baseConflicts: Record<string, string[]> = {};
    for (const s of live) {
      const hit = [...s.files.values()].filter((f) => this.base.has(f.path) && overlaps(f.ranges, this.base.get(f.path)!)).map((f) => f.path);
      if (hit.length) baseConflicts[s.ws.id] = hit;
    }
    const rank = { conflict: 0, overlap: 1, none: 2 };
    pairs.sort((x, y) => rank[x.severity] - rank[y.severity] || y.overlap.length - x.overlap.length);
    return { pairs, baseConflicts, computedAt: Date.now() };
  }

  private triage() {
    const winners = new Set(this.tournaments.map((t) => t.winner).filter(Boolean));
    const items = this.order
      .map((id) => this.sims.get(id)!)
      .filter((s) => !s.ws.tournamentId || winners.has(s.ws.id))
      .map((s) => ({ item: { workspaceId: s.ws.id, status: s.status }, risk: this.diffOf(s).risk }));
    const ordered = triageOrder(items);
    const ready = ordered.filter((x) => x.item.status !== "running");
    const inFlight = ordered.filter((x) => x.item.status === "running");
    return { queue: [...ready, ...inFlight].map((x) => ({ ...x.item, risk: x.risk, ready: x.item.status !== "running" })) };
  }

  // ---------- Backend ----------

  events(onState: (s: AppState) => void, onConn: (up: boolean) => void) {
    this.subs.add(onState);
    onConn(true);
    onState(this.snapshot());
    return () => void this.subs.delete(onState);
  }

  terminal(id: string, h: TermHandlers) {
    const s = this.sims.get(id);
    if (!s) {
      queueMicrotask(() => h.onClose("no such workspace", 1008));
      return { send: () => {}, close: () => {} };
    }
    queueMicrotask(() => {
      h.onOut(s.scrollback);
      if (s.status === "exited") h.onExit(s.exitCode);
    });
    s.listeners.add(h);
    return {
      send: (m: { t: string; d?: string }) => {
        if (m.t !== "in" || !m.d || s.status === "exited") return;
        for (const ch of m.d) {
          if (ch === "\r") {
            const line = s.line.trim();
            s.line = "";
            this.write(id, "\n");
            if (line) this.later(500, () => this.write(id, `${C.dim("This agent is simulated for the demo. In your own Octave, this is a real terminal running")} ${C.bold(s.ws.agent)}${C.dim(".")}\n${AGENT_PROMPT[s.ws.agent] ?? "›"} `));
          } else if (ch === "\x7f") {
            if (s.line) { s.line = s.line.slice(0, -1); this.write(id, "\b \b"); }
          } else if (ch >= " ") {
            s.line += ch;
            this.write(id, ch);
          }
        }
      },
      close: () => void s.listeners.delete(h),
    };
  }

  async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 120)); // feel like a network
    const method = init?.method ?? (init?.body ? "POST" : "GET");
    const body = (init?.body ?? {}) as Record<string, unknown>;
    const url = new URL(path, "http://demo");
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    const out = (v: unknown) => v as T;
    const fail = (msg: string): never => { throw new Error(msg); };

    const [, a, id, b] = parts;
    if (a === "state") return out(this.snapshot());
    if (a === "agents") return out(["claude", "codex", "gemini", "opencode", "cursor-agent", "aider", "shell"].map((x) => ({ id: x, label: LABELS[x], available: true })));
    if (a === "repos") return out([]);
    if (a === "projects" && method === "POST") fail("The demo runs on a sample repo. Install Octave to add your own repositories.");
    if (a === "projects" && b === "radar") return out(this.radar());
    if (a === "projects" && b === "triage") return out(this.triage());

    if (a === "workspaces" && !id && method === "POST") {
      const agent = String(body.agent || "claude").startsWith("custom:") ? "shell" : String(body.agent || "claude");
      const prompt = body.prompt ? String(body.prompt) : undefined;
      const name = slug(String(body.name || prompt || agent));
      const s = this.add({ name: this.unique(name), agent, prompt });
      this.intro(s.ws.id, agent, prompt);
      const target = guessFile(prompt);
      this.play(s.ws.id, [
        [1000, () => this.write(s.ws.id, `${C.cyan("●")} Reading ${target.path}\n`)],
        [1500, () => { this.write(s.ws.id, `${C.cyan("●")} Edit ${C.bold(target.path)} ${C.green(`+${target.added}`)} ${C.red(`-${target.deleted}`)}\n`); this.edit(s.ws.id, target); }],
        [1100, () => this.write(s.ws.id, `\n${C.green("✓")} Done. Review the change in the panel on the right.\n${AGENT_PROMPT[agent] ?? "›"} `)],
      ]);
      this.emit();
      return out(s.ws);
    }

    const s = id ? this.sims.get(id) : undefined;
    if (a === "workspaces" && id) {
      if (!s) fail("That workspace was archived");
      if (method === "DELETE") {
        clearTimeout(s!.idleTimer);
        this.sims.delete(id);
        this.order = this.order.filter((x) => x !== id);
        this.emit();
        return out({ ok: true });
      }
      if (b === "diff") return out(this.diffOf(s!));
      if (b === "patch") {
        const f = url.searchParams.get("file");
        const files = [...s!.files.values()].filter((x) => !f || x.path === f);
        return out(files.map((x) => `diff --git a/${x.path} b/${x.path}\n--- a/${x.path}\n+++ b/${x.path}\n${x.patch}`).join(""));
      }
      if (b === "commit") return out({ sha: s!.files.size ? hash(String(Date.now())).padEnd(40, "0") : null });
      if (b === "restart") {
        s!.status = "running";
        s!.exitCode = null;
        s!.startedAt = Date.now();
        s!.scrollback = "";
        this.write(id, `${AGENT_PROMPT[s!.ws.agent] ?? "$"} `);
        this.emit();
        return out({ ok: true });
      }
      if (b === "input") {
        if (s!.status === "exited") fail("The agent in this workspace isn't running");
        this.write(id, `\n${C.yellow(String(body.text ?? ""))}\n`);
        s!.onHeadsUp?.();
        s!.onHeadsUp = undefined;
        return out({ ok: true });
      }
      if (b === "pr") fail("Opening pull requests needs your GitHub account. It works in the installed app.");
      if (b === "open") fail("Opening an editor works in the installed app, where worktrees are real folders.");
    }

    if (a === "tournaments" && !id && method === "POST") {
      const agents = (body.agents as string[]) ?? [];
      if (!String(body.prompt ?? "").trim()) fail("Prompt is required");
      if (agents.length < 2) fail("A tournament needs at least 2 entrants");
      return out(this.startTournament(String(body.prompt), String(body.verify ?? ""), agents.map((x) => (x.startsWith("custom:") ? "shell" : x))));
    }
    if (a === "tournaments" && id) {
      const t = this.tournaments.find((x) => x.id === id) ?? fail("No such tournament");
      if (b === "judge") { this.judge(t!); return out(t); }
      if (b === "adopt") {
        for (const e of t!.entrants) if (e.workspaceId !== t!.winner) await this.request(`/api/workspaces/${e.workspaceId}`, { method: "DELETE" }).catch(() => {});
        return out({ branch: this.sims.get(t!.winner!)?.ws.branch ?? "octave/winner", sha: hash(t!.id).padEnd(40, "0") });
      }
      if (method === "DELETE") {
        for (const e of t!.entrants) await this.request(`/api/workspaces/${e.workspaceId}`, { method: "DELETE" }).catch(() => {});
        this.tournaments = this.tournaments.filter((x) => x.id !== id);
        this.emit();
        return out({ ok: true });
      }
    }
    return fail(`Not available in the demo: ${method} ${url.pathname}`);
  }

  private unique(name: string) {
    let n = name;
    for (let i = 2; this.order.some((id) => this.sims.get(id)!.ws.name === n); i++) n = `${name}-${i}`;
    return n;
  }
}

const LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI", opencode: "OpenCode", "cursor-agent": "Cursor Agent", aider: "Aider", shell: "Shell" };

function slug(s: string) {
  return s.toLowerCase().split(/\s+/).slice(0, 5).join(" ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ws";
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Pick a plausible file for a free-form demo task, so the radar reacts. */
function guessFile(prompt = ""): SimFile {
  const p = prompt.toLowerCase();
  if (/discount|cart|price|coupon/.test(p)) return file("src/cart.ts", "M", [[8, 9]], hunk(8, ['  if (code === "SAVE10") return total * 0.9;'], ['  if (code === "SAVE10" || code === "WELCOME10") return total * 0.9;']));
  if (/auth|login|session|password/.test(p)) return file("src/auth/session.ts", "M", [[3, 4]], hunk(3, ["  const ttl = 60 * 60 * 1000; // 1 hour"], ["  const ttl = 30 * 60 * 1000; // 30 minutes"]));
  if (/doc|readme/.test(p)) return file("README.md", "M", [[60, 63]], hunk(60, [], ["## Running locally", "", "pnpm install && pnpm dev"]));
  if (/test/.test(p)) return file("test/checkout.test.ts", "A", [[1, 5]], hunk(1, [], ['import { checkout } from "../src/checkout";', "", 'test("empty cart", () => {', "  expect(checkout([])).toEqual({ total: 0 });", "});"]));
  return file("src/checkout.ts", "M", [[30, 34]], hunk(30, ["  return { total };"], ["  if (!items.length) return { total: 0 };", "  return { total: Math.round(total * 100) / 100 };"]));
}

function randomPlan(prompt: string) {
  const f = guessFile(prompt);
  return { pass: Math.random() > 0.35, files: [f], ms: 3500 + Math.random() * 4000 };
}
