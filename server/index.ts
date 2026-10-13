import express, { type NextFunction, type Request, type Response } from "express";
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyToken } from "@clerk/express";
import { WebSocketServer, type WebSocket } from "ws";
import { PRESETS, onPath } from "./agents";
import { Gate, tokenFrom } from "./auth";
import { git } from "./git";
import { Octave } from "./octave";
import { HttpError, Store } from "./store";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Clerk keys from `clerk env pull` (.env.local) or a hand-written .env.
for (const f of [".env.local", ".env"]) {
  const file = path.join(ROOT, f);
  if (existsSync(file)) process.loadEnvFile(file);
}

const PORT = Number(process.env.OCTAVE_PORT ?? 7420);
const HOME = process.env.OCTAVE_HOME ?? path.join(os.homedir(), ".octave");
const SECRET_KEY = process.env.CLERK_SECRET_KEY;
const PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY;
// Remote access (e.g. Octave on a GPU box): set OCTAVE_PUBLIC_URL. Only allowed with auth on.
const PUBLIC_URL = process.env.OCTAVE_PUBLIC_URL ? new URL(process.env.OCTAVE_PUBLIC_URL) : null;
if (PUBLIC_URL && !SECRET_KEY) {
  console.error("OCTAVE_PUBLIC_URL requires Clerk auth (CLERK_SECRET_KEY). Refusing to expose shells without sign-in.");
  process.exit(1);
}
const HOST = PUBLIC_URL ? "0.0.0.0" : "127.0.0.1";

const store = new Store(HOME);
const octave = new Octave(store);

// Tokens are only accepted when minted for one of our own origins.
const authorizedParties = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  "http://localhost:5173",
  ...(PUBLIC_URL ? [PUBLIC_URL.origin] : []),
];
const gate = new Gate(
  store,
  SECRET_KEY
    ? async (token) => {
        const claims = await verifyToken(token, { secretKey: SECRET_KEY, authorizedParties });
        return claims?.sub ? { userId: claims.sub } : null;
      }
    : null,
  (process.env.OCTAVE_ALLOWED_USERS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
);
const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- security: this server can spawn shells, so lock it to localhost ----------

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function isLocalHost(host?: string): boolean {
  if (!host) return false;
  if (PUBLIC_URL && host === PUBLIC_URL.host) return true;
  return LOCAL_HOSTS.has(host.replace(/:\d+$/, ""));
}
function isLocalOrigin(origin?: string): boolean {
  if (!origin) return true; // non-browser clients (curl, CLI)
  try {
    const u = new URL(origin);
    if (PUBLIC_URL && u.origin === PUBLIC_URL.origin) return true;
    return LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
app.use((req, res, next) => {
  // Host check defeats DNS rebinding; Origin check defeats cross-site requests.
  if (!isLocalHost(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
    res.status(403).json({ error: "Forbidden: Octave only accepts local requests" });
    return;
  }
  next();
});

const h =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      next(err);
    }
  };

const p = (req: Request, k: string) => String(req.params[k]);

// ---------- auth ----------

/** Public: tells the UI whether to show Clerk, and with which key. */
app.get("/api/config", (_req, res) => {
  res.json({ authEnabled: gate.enabled, publishableKey: gate.enabled ? PUBLISHABLE_KEY ?? null : null });
});

app.use("/api", async (req, res, next) => {
  const r = await gate.check(tokenFrom(req.headers));
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.locals.userId = r.userId;
  next();
});

app.get("/api/me", (_req, res) => {
  res.json({ userId: res.locals.userId, owner: store.state.owner?.userId === res.locals.userId });
});

// ---------- API ----------

app.get("/api/state", h(() => ({ ...store.state, statuses: octave.sessions.statuses() })));

app.get(
  "/api/agents",
  h(() => PRESETS.map((a) => ({ id: a.id, label: a.label, available: onPath(a.bin) }))),
);

/** Git repos under common dev folders, for the "add project" picker. */
app.get(
  "/api/repos/suggest",
  h(() => {
    const roots = ["Desktop", "code", "Code", "dev", "projects", "Projects", "src", "work", "repos", "Developer", "GitHub"]
      .map((d) => path.join(os.homedir(), d))
      .filter((d) => existsSync(d));
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (found.length > 60) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      if (entries.includes(".git")) return void found.push(dir);
      if (depth === 0) return;
      for (const e of entries) {
        if (e.startsWith(".") || e === "node_modules") continue;
        const full = path.join(dir, e);
        try {
          if (statSync(full).isDirectory()) walk(full, depth - 1);
        } catch {}
      }
    };
    roots.forEach((r) => walk(r, 2));
    const have = new Set(store.state.projects.map((p) => p.path));
    return found.filter((f) => !have.has(f) && !f.startsWith(HOME));
  }),
);

app.post("/api/projects", h((req) => octave.addProject(String(req.body.path ?? ""))));
app.delete("/api/projects/:id", h((req) => octave.removeProject(p(req, "id"))));

app.post(
  "/api/workspaces",
  h((req) => {
    const { projectId, name, agent, prompt, bootstrap } = req.body ?? {};
    return octave.createWorkspace({ projectId, name, agent: agent || "claude", prompt: prompt || undefined, bootstrap });
  }),
);
app.delete("/api/workspaces/:id", h((req) => octave.removeWorkspace(p(req, "id"), req.query.keepBranch === "1")));
app.post(
  "/api/workspaces/:id/restart",
  h((req) => {
    octave.restartWorkspace(p(req, "id"), req.body?.mode === "shell" ? "shell" : "agent");
  }),
);
/** Type a message into the agent's terminal (Conflict Radar heads-ups). */
app.post(
  "/api/workspaces/:id/input",
  h((req) => {
    const ws = store.workspace(p(req, "id"));
    const s = octave.sessions.get(ws.id);
    if (!s || s.status === "exited") throw new HttpError(409, "The agent in this workspace isn't running");
    const text = String(req.body?.text ?? "").replace(/[\r\n]+/g, " ").slice(0, 4000);
    if (!text) throw new HttpError(400, "Text is required");
    // Bracketed paste so TUIs treat it as one message, then submit.
    s.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => s.write("\r"), 120);
  }),
);
app.get("/api/workspaces/:id/diff", h((req) => octave.diff(p(req, "id"))));
app.get(
  "/api/workspaces/:id/patch",
  h(async (req, res) => {
    res.type("text/plain").send(await octave.patch(p(req, "id"), req.query.file ? String(req.query.file) : undefined));
  }),
);
app.post("/api/workspaces/:id/commit", h(async (req) => ({ sha: await octave.commit(p(req, "id"), String(req.body?.message ?? "")) })));

app.post(
  "/api/workspaces/:id/open",
  h((req) => {
    const ws = store.workspace(p(req, "id"));
    const target = String(req.body?.app ?? "finder");
    const cmds: Record<string, [string, string[]]> = {
      code: ["code", [ws.path]],
      cursor: ["cursor", [ws.path]],
      zed: ["zed", [ws.path]],
      finder: process.platform === "darwin" ? ["open", [ws.path]] : process.platform === "win32" ? ["explorer", [ws.path]] : ["xdg-open", [ws.path]],
    };
    const cmd = cmds[target];
    if (!cmd) throw new HttpError(400, `Unknown app ${target}`);
    if (!onPath(cmd[0])) throw new HttpError(400, `${cmd[0]} is not on PATH`);
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
  }),
);

app.post(
  "/api/workspaces/:id/pr",
  h(async (req) => {
    const ws = store.workspace(p(req, "id"));
    if (!onPath("gh")) throw new HttpError(400, "GitHub CLI (gh) is not installed");
    await octave.commit(ws.id, String(req.body?.message ?? "") || `octave: ${ws.name}`);
    await git(ws.path, ["push", "-u", "origin", ws.branch]);
    const title = String(req.body?.title ?? "") || (ws.prompt ?? ws.name).slice(0, 72);
    const url = await new Promise<string>((resolve, reject) =>
      execFile(
        "gh",
        ["pr", "create", "--head", ws.branch, "--base", ws.baseBranch, "--title", title, "--body", `Created with Octave.\n\nTask: ${ws.prompt ?? "(interactive)"}`],
        { cwd: ws.path },
        (err, stdout, stderr) => (err ? reject(new HttpError(400, stderr || String(err))) : resolve(stdout.trim())),
      ),
    );
    return { url };
  }),
);

app.get("/api/projects/:id/radar", h((req) => octave.radar(p(req, "id"))));
app.get("/api/projects/:id/triage", h((req) => octave.triage(p(req, "id"))));

app.post(
  "/api/tournaments",
  h((req) => {
    const { projectId, prompt, verify, agents } = req.body ?? {};
    return octave.createTournament({ projectId, prompt: String(prompt ?? ""), verify: String(verify ?? ""), agents: Array.isArray(agents) ? agents : [] });
  }),
);
app.post("/api/tournaments/:id/judge", h((req) => octave.judge(p(req, "id"))));
app.post("/api/tournaments/:id/adopt", h((req) => octave.adoptWinner(p(req, "id"))));
app.delete(
  "/api/tournaments/:id",
  h(async (req) => {
    const t = store.tournament(p(req, "id"));
    for (const e of t.entrants) if (store.state.workspaces.some((w) => w.id === e.workspaceId)) await octave.removeWorkspace(e.workspaceId);
    store.update((s) => (s.tournaments = s.tournaments.filter((x) => x.id !== t.id)));
  }),
);

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

// ---------- static (production) ----------

const dist = path.join(ROOT, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

// ---------- websockets ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const eventClients = new Set<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  if (!isLocalHost(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const headerToken = tokenFrom(req.headers);
  wss.handleUpgrade(req, socket, head, (ws) => {
    const route = () => {
      if (url.pathname === "/ws/events") return attachEvents(ws);
      const m = url.pathname.match(/^\/ws\/term\/([\w-]+)$/);
      if (m) return attachTerminal(ws, m[1]);
      ws.close(1008, "unknown endpoint");
    };
    authenticate(ws, headerToken).then((ok) => ok && route());
  });
});

/**
 * Browsers can't set headers on a WebSocket and tokens don't belong in URLs,
 * so when the cookie isn't present the client's first message must be
 * {t:"auth", token}. Nothing else is accepted until it verifies.
 */
function authenticate(ws: WebSocket, headerToken: string | null): Promise<boolean> {
  if (!gate.enabled) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = async (token: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("message", onMsg);
      const r = await gate.check(token);
      if (!r.ok) {
        ws.close(r.status === 403 ? 4403 : 4401, r.error.slice(0, 120));
        return resolve(false);
      }
      ws.send(JSON.stringify({ t: "authed" }));
      resolve(true);
    };
    const onMsg = (raw: unknown) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.t === "auth") return void finish(typeof m.token === "string" ? m.token : null);
      } catch {}
      void finish(null);
    };
    const timer = setTimeout(() => void finish(headerToken), 5000);
    ws.on("message", onMsg);
  });
}

function attachEvents(ws: WebSocket) {
  eventClients.add(ws);
  ws.send(JSON.stringify({ type: "state", state: store.state, statuses: octave.sessions.statuses() }));
  ws.on("close", () => eventClients.delete(ws));
}

let pending: NodeJS.Timeout | null = null;
function broadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const msg = JSON.stringify({ type: "state", state: store.state, statuses: octave.sessions.statuses() });
    for (const c of eventClients) if (c.readyState === c.OPEN) c.send(msg);
  }, 60);
}
store.on("change", broadcast);
octave.sessions.on("status", broadcast);

function attachTerminal(ws: WebSocket, id: string) {
  let session = octave.sessions.get(id);
  if (!session) {
    const w = store.state.workspaces.find((x) => x.id === id);
    if (!w) return ws.close(1008, "no such workspace");
    // Server restarted since this workspace was made: give it a fresh shell.
    session = octave.restartWorkspace(id, "shell");
  }
  const s = session;
  ws.send(JSON.stringify({ t: "out", d: s.scrollback() }));
  if (s.status === "exited") ws.send(JSON.stringify({ t: "exit", code: s.exitCode }));
  const onData = (d: string) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: "out", d }));
  const onExit = (code: number) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: "exit", code }));
  s.on("data", onData);
  s.on("exit", onExit);
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.t === "in" && typeof m.d === "string") s.write(m.d);
      else if (m.t === "resize") s.resize(Number(m.c), Number(m.r));
    } catch {}
  });
  ws.on("close", () => {
    s.off("data", onData);
    s.off("exit", onExit);
  });
}

server.listen(PORT, HOST, () => {
  const where = PUBLIC_URL ? PUBLIC_URL.origin : `http://localhost:${PORT}`;
  console.log(`\n  ♪ Octave running at ${where}\n    state: ${HOME}\n    auth:  ${gate.enabled ? "Clerk (owner-locked)" : "off (local only)"}\n`);
});

const shutdown = () => {
  octave.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
