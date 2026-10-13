import { useMemo, useState } from "react";
import { api } from "../api";
import type { Agent, AppState, Project, Tournament } from "../types";
import { StatusDot, ago, toast, useAsync } from "../ui";

export function TournamentView({ project, state, agents, onOpen }: { project: Project; state: AppState; agents: Agent[]; onOpen: (id: string) => void }) {
  const list = state.tournaments.filter((t) => t.projectId === project.id);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Tournament</h1>
          <p className="lede">
            Give one task to several agents at once. Each gets its own worktree. When they finish, Octave runs your check in every
            worktree and ranks the results: passing first, then lowest review risk, then smallest diff. Keep the winner and archive the rest.
          </p>
        </div>
      </header>
      <NewTournament project={project} agents={agents} />
      {list.map((t) => <TournamentCard key={t.id} t={t} state={state} onOpen={onOpen} />)}
    </div>
  );
}

function NewTournament({ project, agents }: { project: Project; agents: Agent[] }) {
  const [prompt, setPrompt] = useState("");
  const [verify, setVerify] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>(() => {
    const avail = agents.filter((a) => a.available && a.id !== "shell");
    return avail.length ? { [avail[0].id]: 2 } : {};
  });
  const [custom, setCustom] = useState("");
  const { busy, run } = useAsync();

  const roster = useMemo(() => {
    const r: string[] = [];
    for (const [id, n] of Object.entries(counts)) for (let i = 0; i < n; i++) r.push(id);
    if (custom.trim()) r.push(`custom:${custom.trim()}`);
    return r;
  }, [counts, custom]);

  const bump = (id: string, d: number) => setCounts((c) => ({ ...c, [id]: Math.max(0, Math.min(4, (c[id] ?? 0) + d)) }));

  const start = () =>
    run(async () => {
      await api("/api/tournaments", { body: { projectId: project.id, prompt, verify, agents: roster } });
      toast(`Tournament started with ${roster.length} entrants`);
      setPrompt("");
    });

  return (
    <section className="panel t-new">
      <label className="field">
        <span>Task</span>
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Add input validation to the signup form and cover it with tests" />
      </label>
      <label className="field">
        <span>Check to run in each worktree</span>
        <input value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="npm test && npm run typecheck" className="mono" />
        <small className="muted">An exit code of 0 counts as passing. Leave it empty to rank on review risk and diff size alone.</small>
      </label>
      <div className="field">
        <span>Entrants</span>
        <div className="roster">
          {agents.filter((a) => a.id !== "shell").map((a) => (
            <div key={a.id} className={`stepper ${a.available ? "" : "unavailable"}`} title={a.available ? "" : `${a.label} isn't installed on this machine`}>
              <span>{a.label}</span>
              <button className="ghost icon" onClick={() => bump(a.id, -1)} disabled={!counts[a.id]} aria-label={`Fewer ${a.label}`}>−</button>
              <b>{counts[a.id] ?? 0}</b>
              <button className="ghost icon" onClick={() => bump(a.id, 1)} disabled={!a.available} aria-label={`More ${a.label}`}>+</button>
            </div>
          ))}
        </div>
        <input value={custom} onChange={(e) => setCustom(e.target.value)} className="mono" placeholder="Optional custom entrant, e.g. my-agent --task {prompt}" />
      </div>
      <div className="row">
        <button disabled={busy || !prompt.trim() || roster.length < 2 || roster.length > 8} onClick={start}>
          Start tournament with {roster.length} entrant{roster.length === 1 ? "" : "s"}
        </button>
        {roster.length < 2 && <span className="muted small">Pick at least two entrants.</span>}
      </div>
    </section>
  );
}

function TournamentCard({ t, state, onOpen }: { t: Tournament; state: AppState; onOpen: (id: string) => void }) {
  const { busy, run } = useAsync();
  const wsById = new Map(state.workspaces.map((w) => [w.id, w]));
  const finished = t.entrants.filter((e) => e.exitCode !== undefined || state.statuses[e.workspaceId]?.status === "exited").length;
  const statusText = { running: `Agents working, ${finished} of ${t.entrants.length} finished`, judging: "Running checks in each worktree", done: "Finished" }[t.status];

  return (
    <section className={`panel t-card t-${t.status}`}>
      <header>
        <div>
          <h3>{t.prompt}</h3>
          <p className="muted small">
            {statusText} · started {ago(t.createdAt)} {t.verify && <>· check <code>{t.verify}</code></>}
          </p>
        </div>
        <div className="row">
          {t.status === "running" && <button className="ghost" disabled={busy} onClick={() => run(() => api(`/api/tournaments/${t.id}/judge`, { body: {} }), "Judged")}>Judge now</button>}
          {t.status === "done" && t.winner && wsById.has(t.winner) && t.entrants.some((e) => e.workspaceId !== t.winner && wsById.has(e.workspaceId)) && (
            <button disabled={busy} onClick={() => run(async () => {
              const r = await api<{ branch: string; sha: string | null }>(`/api/tournaments/${t.id}/adopt`, { body: {} });
              toast(`Kept the winner on ${r.branch}${r.sha ? ` (${r.sha.slice(0, 7)})` : ""}. Other entrants archived.`);
            })}>Keep winner, archive the rest</button>
          )}
          <button className="ghost danger" disabled={busy} onClick={() => confirm("Delete this tournament and archive all of its worktrees?") && run(() => api(`/api/tournaments/${t.id}`, { method: "DELETE" }))}>Delete</button>
        </div>
      </header>
      <table className="board">
        <thead>
          <tr><th>#</th><th>Entrant</th><th>Check</th><th className="num">Files</th><th className="num">Lines</th><th className="num">Risk</th><th className="num">Score</th></tr>
        </thead>
        <tbody>
          {t.entrants.map((e, i) => {
            const w = wsById.get(e.workspaceId);
            const win = t.winner === e.workspaceId;
            return (
              <tr key={e.workspaceId} className={win ? "winner" : ""}>
                <td>{t.status === "done" ? i + 1 : ""}</td>
                <td>
                  <StatusDot status={state.statuses[e.workspaceId]?.status} />{" "}
                  {w ? <button className="link" onClick={() => onOpen(w.id)} title={w.branch}>{w.name.replace(/^t-[0-9a-f]+-/, "")}</button> : <span className="muted">{e.agent} (archived)</span>}
                  {win && <span className="crown">winner</span>}
                </td>
                <td>
                  {e.verify ? (
                    <span className={e.verify.passed ? "pass" : "fail"} title={e.verify.tail}>
                      {e.verify.passed ? "passed" : `failed${e.verify.code != null ? ` (${e.verify.code})` : ""}`}
                      {e.verify.durationMs > 0 && <span className="muted"> {(e.verify.durationMs / 1000).toFixed(1)}s</span>}
                    </span>
                  ) : t.status === "done" ? <span className="muted">{e.files === 0 ? "no changes" : "skipped"}</span> : <span className="muted">pending</span>}
                </td>
                <td className="num">{e.files ?? "–"}</td>
                <td className="num">{e.churn ?? "–"}</td>
                <td className="num">{e.risk ?? "–"}</td>
                <td className="num strong">{e.score ?? "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
