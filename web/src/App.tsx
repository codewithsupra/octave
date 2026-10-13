import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, useAppState } from "./api";
import type { Agent, AppState, Project } from "./types";
import { Modal, StatusDot, Toasts, agentLabel, toast, useAsync } from "./ui";
import { RadarView } from "./views/RadarView";
import { ReviewView } from "./views/ReviewView";
import { TournamentView } from "./views/TournamentView";
import { WorkspaceView } from "./views/WorkspaceView";

type Route = { view: "ws"; id: string } | { view: "radar" | "review" | "tournament" } | { view: "home" };

function readRoute(): Route {
  const [view, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (view === "ws" && id) return { view: "ws", id };
  if (view === "radar" || view === "review" || view === "tournament") return { view };
  return { view: "home" };
}

export function App({ mode = "local", banner, account }: { mode?: "local" | "authed" | "demo"; banner?: ReactNode; account?: ReactNode }) {
  const { state, connected } = useAppState();
  const [route, setRoute] = useState<Route>(readRoute);
  const [projectId, setProjectId] = useState<string | null>(() => localStorageGet("octave.project"));
  const [agents, setAgents] = useState<Agent[]>([]);
  const [dialog, setDialog] = useState<null | "project" | "workspace">(null);

  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener("hashchange", on);
    api<Agent[]>("/api/agents").then(setAgents).catch(() => {});
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const go = (r: Route) => {
    location.hash = r.view === "ws" ? `/ws/${r.id}` : r.view === "home" ? "" : `/${r.view}`;
  };

  const project = useMemo(() => {
    if (!state) return null;
    // A workspace route implies its project.
    if (route.view === "ws") {
      const w = state.workspaces.find((x) => x.id === route.id);
      if (w) return state.projects.find((p) => p.id === w.projectId) ?? null;
    }
    return state.projects.find((p) => p.id === projectId) ?? state.projects[0] ?? null;
  }, [state, projectId, route]);

  useEffect(() => {
    if (project) localStorageSet("octave.project", project.id);
  }, [project?.id]);

  useAttentionAlerts(state);

  if (!state) {
    return <div className="boot"><Logo /><p className="muted">{connected ? "Loading…" : "Connecting to the Octave server…"}</p></div>;
  }

  const wss = project ? state.workspaces.filter((w) => w.projectId === project.id) : [];
  const waiting = wss.filter((w) => state.statuses[w.id]?.status === "idle").length;
  const current = route.view === "ws" ? state.workspaces.find((w) => w.id === route.id) : undefined;

  return (
    <div className={`app ${banner ? "has-banner" : ""}`} data-mode={mode}>
      {banner}
      <nav className="sidebar" aria-label="Workspaces">
        <div className="brand"><Logo /><span>Octave</span>{!connected && <span className="offline" title="Reconnecting">offline</span>}</div>

        {state.projects.length > 0 && (
          <div className="project-pick">
            <select value={project?.id ?? ""} onChange={(e) => { setProjectId(e.target.value); go({ view: "home" }); }} aria-label="Project">
              {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="ghost icon" onClick={() => setDialog("project")} aria-label="Add repository" title="Add repository">+</button>
          </div>
        )}

        {project && (
          <>
            <ul className="nav">
              <li><button className={route.view === "review" ? "on" : ""} onClick={() => go({ view: "review" })}>Review queue</button></li>
              <li><button className={route.view === "radar" ? "on" : ""} onClick={() => go({ view: "radar" })}>Conflict radar</button></li>
              <li><button className={route.view === "tournament" ? "on" : ""} onClick={() => go({ view: "tournament" })}>Tournament</button></li>
            </ul>
            <div className="ws-list-head">
              <span>Workspaces{waiting > 0 && <span className="pill" title="Agents waiting on you">{waiting} waiting</span>}</span>
              <button className="ghost icon" onClick={() => setDialog("workspace")} aria-label="New workspace" title="New workspace (N)">+</button>
            </div>
            <ul className="ws-list">
              {wss.length === 0 && <li className="muted small pad">No workspaces yet.</li>}
              {wss.filter((w) => !w.tournamentId).map((w) => (
                <WsRow key={w.id} w={w} state={state} on={current?.id === w.id} onClick={() => go({ view: "ws", id: w.id })} />
              ))}
              {state.tournaments.filter((t) => t.projectId === project.id).map((t) => {
                const entrants = wss.filter((w) => w.tournamentId === t.id);
                if (!entrants.length) return null;
                return <TournamentGroup key={t.id} prompt={t.prompt} open={entrants.some((w) => w.id === current?.id)}>
                  {entrants.map((w, i) => (
                    <WsRow key={w.id} w={w} state={state} on={current?.id === w.id} label={`Entrant ${i + 1}${t.winner === w.id ? " (winner)" : ""}`} onClick={() => go({ view: "ws", id: w.id })} />
                  ))}
                </TournamentGroup>;
              })}
            </ul>
          </>
        )}
        <footer className="side-foot muted small">
          {account}
          {project ? <code title={project.path}>{project.path.replace(/^\/Users\/[^/]+/, "~")}</code> : null}
        </footer>
      </nav>

      <main className="main">
        {state.projects.length === 0 ? (
          <Welcome onAdd={() => setDialog("project")} />
        ) : !project ? null : current ? (
          <WorkspaceView key={current.id} ws={current} state={state} onRemoved={() => go({ view: "home" })} />
        ) : route.view === "radar" ? (
          <RadarView project={project} state={state} onOpen={(id) => go({ view: "ws", id })} />
        ) : route.view === "review" ? (
          <ReviewView project={project} state={state} onOpen={(id) => go({ view: "ws", id })} />
        ) : route.view === "tournament" ? (
          <TournamentView project={project} state={state} agents={agents} onOpen={(id) => go({ view: "ws", id })} />
        ) : (
          <Home project={project} state={state} onNew={() => setDialog("workspace")} onOpen={(id) => go({ view: "ws", id })} />
        )}
      </main>

      {dialog === "project" && <AddProject onClose={() => setDialog(null)} onAdded={(p) => { setProjectId(p.id); setDialog(null); go({ view: "home" }); }} />}
      {dialog === "workspace" && project && (
        <NewWorkspace project={project} agents={agents} onClose={() => setDialog(null)} onCreated={(id) => { setDialog(null); go({ view: "ws", id }); }} />
      )}
      <Shortcuts onNew={() => project && setDialog("workspace")} />
      <Toasts />
    </div>
  );
}

function WsRow({ w, state, on, label, onClick }: { w: AppState["workspaces"][number]; state: AppState; on: boolean; label?: string; onClick: () => void }) {
  return (
    <li>
      <button className={on ? "on" : ""} onClick={onClick} title={w.prompt ?? w.name}>
        <StatusDot status={state.statuses[w.id]?.status} />
        <span className="ws-name">{label ?? w.name}</span>
        <span className="ws-agent">{agentLabel(w.agent)}</span>
      </button>
    </li>
  );
}

function TournamentGroup({ prompt, open: initial, children }: { prompt: string; open: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  useEffect(() => { if (initial) setOpen(true); }, [initial]);
  return (
    <li className="ws-group">
      <button className="group-toggle" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="clampline">Tournament: {prompt}</span>
      </button>
      {open && <ul>{children}</ul>}
    </li>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M12 22a3 3 0 1 1-3-3h3V8l11-2v13a3 3 0 1 1-3-3h3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  );
}

function Welcome({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="welcome">
      <h1>Run a fleet of coding agents without them stepping on each other.</h1>
      <p className="lede">
        Every agent gets its own git worktree, its own ports and a copy of your env files. Octave predicts merge conflicts between
        them while they work, ranks finished work by how carefully you need to review it, and can race agents against each other on the same task.
      </p>
      <button className="big" onClick={onAdd}>Add a git repository</button>
      <p className="muted small">Works with Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, Aider, or any command you type.</p>
    </div>
  );
}

function Home({ project, state, onNew, onOpen }: { project: Project; state: AppState; onNew: () => void; onOpen: (id: string) => void }) {
  const wss = state.workspaces.filter((w) => w.projectId === project.id);
  const by = (s: string) => wss.filter((w) => (state.statuses[w.id]?.status ?? "exited") === s);
  const groups: [string, string, typeof wss][] = [
    ["idle", "Waiting on you", by("idle")],
    ["running", "Working", by("running")],
    ["exited", "Stopped", by("exited")],
  ];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{project.name}</h1>
          <p className="lede">New workspaces branch from <code>{project.baseBranch}</code>.</p>
        </div>
        <button onClick={onNew}>New workspace</button>
      </header>
      {wss.length === 0 ? (
        <div className="empty">
          <h2>Start your first agent</h2>
          <p>Describe a task, pick an agent, and Octave sets up an isolated worktree with its dependencies installed.</p>
          <button onClick={onNew}>New workspace</button>
        </div>
      ) : (
        <div className="board-cols">
          {groups.map(([key, label, items]) => (
            <section key={key} className="col">
              <h3><StatusDot status={key as never} /> {label} <span className="muted">{items.length}</span></h3>
              {items.map((w) => (
                <button key={w.id} className="ws-card" onClick={() => onOpen(w.id)}>
                  <b>{w.name}</b>
                  <span className="muted small">{agentLabel(w.agent)} on <code>{w.branch}</code></span>
                  {w.prompt && <span className="small clamp">{w.prompt}</span>}
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Project) => void }) {
  const [path, setPath] = useState("");
  const [suggest, setSuggest] = useState<string[] | null>(null);
  const { busy, run } = useAsync();
  useEffect(() => { api<string[]>("/api/repos/suggest").then(setSuggest).catch(() => setSuggest([])); }, []);
  const add = (p: string) => run(() => api<Project>("/api/projects", { body: { path: p } })).then((r) => r && onAdded(r));
  return (
    <Modal title="Add a repository" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); add(path); }}>
        <label className="field">
          <span>Path to a git repository</span>
          <input autoFocus className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/my-app" />
        </label>
        <div className="row end"><button disabled={busy || !path.trim()}>Add repository</button></div>
      </form>
      {suggest && suggest.length > 0 && (
        <div className="suggest">
          <p className="muted small">Found on this machine</p>
          <ul>
            {suggest.slice(0, 12).map((s) => (
              <li key={s}><button className="file" onClick={() => add(s)} disabled={busy}><code>{s.replace(/^\/Users\/[^/]+/, "~")}</code></button></li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function NewWorkspace({ project, agents, onClose, onCreated }: { project: Project; agents: Agent[]; onClose: () => void; onCreated: (id: string) => void }) {
  const firstAvail = agents.find((a) => a.available && a.id !== "shell")?.id ?? "shell";
  const [agent, setAgent] = useState(firstAvail);
  const [custom, setCustom] = useState("");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [bootstrap, setBootstrap] = useState(true);
  const { busy, run } = useAsync();
  const submit = () =>
    run(() =>
      api<{ id: string }>("/api/workspaces", {
        body: { projectId: project.id, agent: agent === "custom" ? `custom:${custom}` : agent, prompt, name, bootstrap },
      }),
    ).then((w) => w && onCreated(w.id));
  return (
    <Modal title={`New workspace in ${project.name}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field">
          <span>Task</span>
          <textarea autoFocus rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}
            placeholder="Fix the flaky date test in utils/format.test.ts" />
          <small className="muted">Sent to the agent as its first message. Leave it empty to start the agent idle.</small>
        </label>
        <div className="field">
          <span>Agent</span>
          <div className="agents">
            {agents.map((a) => (
              <label key={a.id} className={`agent ${agent === a.id ? "on" : ""} ${a.available ? "" : "unavailable"}`} title={a.available ? "" : "Not found on PATH"}>
                <input type="radio" name="agent" value={a.id} checked={agent === a.id} onChange={() => setAgent(a.id)} disabled={!a.available} />
                {a.label}
              </label>
            ))}
            <label className={`agent ${agent === "custom" ? "on" : ""}`}>
              <input type="radio" name="agent" value="custom" checked={agent === "custom"} onChange={() => setAgent("custom")} />
              Custom
            </label>
          </div>
          {agent === "custom" && (
            <input className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="my-agent --task {prompt}" />
          )}
        </div>
        <div className="row two">
          <label className="field">
            <span>Name (optional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="from the task" />
          </label>
          <label className="check">
            <input type="checkbox" checked={bootstrap} onChange={(e) => setBootstrap(e.target.checked)} />
            Install dependencies first
          </label>
        </div>
        <div className="row end">
          <button disabled={busy || (agent === "custom" && !custom.trim())}>{busy ? "Creating worktree…" : "Create workspace"}</button>
        </div>
      </form>
    </Modal>
  );
}

function Shortcuts({ onNew }: { onNew: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, .term, [contenteditable]")) return;
      if (e.key === "n" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onNew(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onNew]);
  return null;
}

/** Desktop notification + tab title badge when an agent starts waiting on you. */
function useAttentionAlerts(state: AppState | null) {
  const prev = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!state) return;
    const idle = state.workspaces.filter((w) => state.statuses[w.id]?.status === "idle");
    document.title = idle.length ? `(${idle.length}) Octave` : "Octave";
    for (const w of state.workspaces) {
      const now = state.statuses[w.id]?.status;
      const was = prev.current[w.id];
      if (was === "running" && (now === "idle" || now === "exited") && !w.tournamentId && document.hidden) {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(`${w.name} ${now === "idle" ? "is waiting on you" : "finished"}`, { body: w.prompt ?? w.branch, tag: w.id });
        }
      }
      if (now) prev.current[w.id] = now;
    }
  }, [state]);
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      const ask = () => { Notification.requestPermission(); window.removeEventListener("click", ask); };
      window.addEventListener("click", ask);
      return () => window.removeEventListener("click", ask);
    }
  }, []);
}

function localStorageGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch {}
}

export { toast };
