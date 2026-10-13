import { useMemo } from "react";
import { usePoll } from "../api";
import type { AppState, Project, Risk, Status } from "../types";
import { RiskBadge, StatusDot, agentLabel, displayName, statusLabel } from "../ui";

interface Item { workspaceId: string; status: Status; risk: Risk; ready: boolean }

export function ReviewView({ project, state, onOpen }: { project: Project; state: AppState; onOpen: (id: string) => void }) {
  const { data, error } = usePoll<{ queue: Item[] }>(`/api/projects/${project.id}/triage`, 4000);
  const wsById = useMemo(() => new Map(state.workspaces.map((w) => [w.id, w])), [state.workspaces]);
  const queue = (data?.queue ?? []).filter((i) => wsById.has(i.workspaceId));
  const withChanges = queue.filter((i) => i.risk.stats.files > 0);
  const ready = withChanges.filter((i) => i.ready);
  const quick = ready.filter((i) => i.risk.level === "low");

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Review queue</h1>
          <p className="lede">
            Finished work, riskiest first. Each score is explained: sensitive paths, missing tests, deletions and size. Spend your
            attention where it matters, and clear the low-risk ones fast.
          </p>
        </div>
        {data && (
          <div className="kpis">
            <div><b>{ready.length}</b><span>ready</span></div>
            <div><b>{quick.length}</b><span>quick wins</span></div>
            <div><b>{withChanges.length - ready.length}</b><span>still working</span></div>
          </div>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Scoring every workspace's diff…</p>}
      {data && withChanges.length === 0 && (
        <div className="empty">
          <h2>Nothing to review</h2>
          <p>When an agent changes files, its workspace lands here, ranked by how carefully you need to read it.</p>
        </div>
      )}
      <ol className="queue">
        {withChanges.map((i, n) => {
          const w = wsById.get(i.workspaceId)!;
          return (
            <li key={i.workspaceId} className={i.ready ? "" : "inflight"}>
              <span className="rank">{i.ready ? n + 1 : ""}</span>
              <div className="q-main">
                <div className="q-title">
                  <StatusDot status={i.status} />
                  <button className="link strong" onClick={() => onOpen(w.id)}>{displayName(w.name)}{w.tournamentId ? " (tournament winner)" : ""}</button>
                  <span className="muted small">{agentLabel(w.agent)}, {statusLabel(i.status).toLowerCase()}</span>
                </div>
                {w.prompt && <p className="q-task">{w.prompt}</p>}
                <ul className="chips">
                  {i.risk.reasons.filter((r) => r.points !== 0).slice(0, 5).map((r, k) => (
                    <li key={k} className={r.points < 0 ? "good" : ""}>{r.label}</li>
                  ))}
                  {i.risk.reasons.every((r) => r.points === 0) && <li className="good">nothing notable</li>}
                </ul>
              </div>
              <div className="q-side">
                <RiskBadge risk={i.risk} />
                <span className="small">
                  {i.risk.stats.files} file{i.risk.stats.files === 1 ? "" : "s"} <span className="add">+{i.risk.stats.added}</span> <span className="del">−{i.risk.stats.deleted}</span>
                </span>
                <button className={i.risk.level === "high" ? "" : "ghost"} onClick={() => onOpen(w.id)}>Review</button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
