import { useMemo, useState } from "react";
import { api, usePoll } from "../api";
import type { AppState, Project, Radar, RadarPair, Workspace } from "../types";
import { StatusDot, ago, displayName, useAsync } from "../ui";

export function RadarView({ project, state, onOpen }: { project: Project; state: AppState; onOpen: (id: string) => void }) {
  const { data: radar, error } = usePoll<Radar>(`/api/projects/${project.id}/radar`, 4000);
  const [sel, setSel] = useState<RadarPair | null>(null);
  const wsById = useMemo(() => new Map(state.workspaces.map((w) => [w.id, w])), [state.workspaces]);

  // Only workspaces that have produced changes take part.
  const ids = useMemo(() => {
    if (!radar) return [];
    const s = new Set<string>();
    // Rows only for workspaces involved in something; independent ones are noise.
    radar.pairs.filter((p) => p.severity !== "none").forEach((p) => (s.add(p.a), s.add(p.b)));
    Object.keys(radar.baseConflicts).forEach((k) => s.add(k));
    return [...s].filter((id) => wsById.has(id));
  }, [radar, wsById]);

  const pairOf = (a: string, b: string) => radar?.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  const conflicts = radar?.pairs.filter((p) => p.severity === "conflict") ?? [];
  const drift = Object.entries(radar?.baseConflicts ?? {});
  const current = sel && pairOf(sel.a, sel.b);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Conflict radar</h1>
          <p className="lede">
            Every pair of workspaces is merged in memory every few seconds, uncommitted work included. A red cell means those two
            agents will conflict if both land. You find out now, not at merge time.
          </p>
        </div>
        {radar && <p className="muted small">Checked {ago(radar.computedAt)}</p>}
      </header>
      {error && <p className="error">{error}</p>}
      {!radar && !error && <p className="muted">Merging worktrees…</p>}

      {radar && ids.length < 2 && drift.length === 0 && (
        <div className="empty">
          <h2>{radar.pairs.length ? "All clear" : "Nothing to compare yet"}</h2>
          <p>
            {radar.pairs.length
              ? `${radar.pairs.length} pair${radar.pairs.length > 1 ? "s" : ""} of workspaces checked. None of them touch the same files.`
              : "The radar lights up once two or more workspaces have changes. Start a few agents on related tasks and watch it here."}
          </p>
        </div>
      )}

      {radar && (ids.length >= 2 || drift.length > 0) && (
        <div className="radar-layout">
          <div className="matrix-wrap">
            <div className="matrix" style={{ gridTemplateColumns: `minmax(120px, 180px) repeat(${ids.length}, minmax(44px, 64px))` }}>
              <div />
              {ids.map((id) => (
                <div key={id} className="mx-col" title={wsById.get(id)!.name}><span>{displayName(wsById.get(id)!.name)}</span></div>
              ))}
              {ids.map((row) => (
                <Row key={row} row={row} ids={ids} wsById={wsById} pairOf={pairOf} drift={radar.baseConflicts[row]} sel={current ?? null} onSel={setSel} state={state} />
              ))}
            </div>
            <ul className="legend">
              <li><span className="cell conflict" /> Will conflict</li>
              <li><span className="cell overlap" /> Same files, merges cleanly</li>
              <li><span className="cell none" /> Independent</li>
              <li><span className="cell drift" /> Conflicts with {project.baseBranch}</li>
            </ul>
          </div>

          <div className="radar-side">
            {current ? (
              <PairDetail pair={current} a={wsById.get(current.a)!} b={wsById.get(current.b)!} state={state} onOpen={onOpen} />
            ) : (
              <div className="callout">
                <h3>{conflicts.length ? `${conflicts.length} predicted conflict${conflicts.length > 1 ? "s" : ""}` : "No predicted conflicts"}</h3>
                <p className="muted">{conflicts.length ? "Select a red cell to see the files and warn one of the agents." : "Every pair of workspaces merges cleanly right now."}</p>
              </div>
            )}
            {drift.length > 0 && (
              <div className="callout warn">
                <h3>{project.baseBranch} moved underneath</h3>
                {drift.map(([id, files]) => (
                  <p key={id}>
                    <button className="link" onClick={() => onOpen(id)}>{wsById.get(id)?.name ?? id}</button> conflicts with {project.baseBranch} in{" "}
                    {files.map((f) => <code key={f}>{f}</code>)}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ row, ids, wsById, pairOf, drift, sel, onSel, state }: {
  row: string; ids: string[]; wsById: Map<string, Workspace>; pairOf: (a: string, b: string) => RadarPair | undefined;
  drift?: string[]; sel: RadarPair | null; onSel: (p: RadarPair) => void; state: AppState;
}) {
  return (
    <>
      <div className="mx-row"><StatusDot status={state.statuses[row]?.status} /> <span title={wsById.get(row)!.name}>{displayName(wsById.get(row)!.name)}</span></div>
      {ids.map((col) => {
        if (col === row) {
          return <div key={col} className={`cell self ${drift ? "drift" : ""}`} title={drift ? `Conflicts with base: ${drift.join(", ")}` : "Same workspace"} />;
        }
        const p = pairOf(row, col);
        if (!p) return <div key={col} className="cell none" />;
        const active = sel && ((sel.a === p.a && sel.b === p.b));
        const n = p.severity === "conflict" ? p.conflicts.length : p.overlap.length;
        return (
          <button
            key={col}
            className={`cell ${p.severity} ${active ? "active" : ""}`}
            onClick={() => onSel(p)}
            aria-label={`${wsById.get(row)!.name} and ${wsById.get(col)!.name}: ${p.severity}`}
          >
            {p.severity !== "none" ? n : ""}
          </button>
        );
      })}
    </>
  );
}

function PairDetail({ pair, a, b, state, onOpen }: { pair: RadarPair; a: Workspace; b: Workspace; state: AppState; onOpen: (id: string) => void }) {
  const { busy, run } = useAsync();
  const files = pair.severity === "conflict" ? pair.conflicts : pair.overlap;
  const warn = (target: Workspace, other: Workspace) =>
    run(
      () =>
        api(`/api/workspaces/${target.id}/input`, {
          body: {
            text: `Heads-up from Octave: another agent working on "${other.prompt ?? other.name}" is also editing ${files.join(", ")}. ` +
              `Your changes will conflict with theirs. Avoid modifying ${files.length > 1 ? "these files" : "this file"} unless your task truly requires it; if it does, keep the edit minimal and isolated.`,
          },
        }),
      `Heads-up sent to ${target.name}`,
    );
  const alive = (w: Workspace) => state.statuses[w.id] && state.statuses[w.id].status !== "exited";
  return (
    <div className={`callout ${pair.severity === "conflict" ? "bad" : ""}`}>
      <h3>
        <button className="link" onClick={() => onOpen(a.id)}>{a.name}</button> and <button className="link" onClick={() => onOpen(b.id)}>{b.name}</button>
      </h3>
      <p className="muted">
        {pair.severity === "conflict"
          ? `A three-way merge of their current work conflicts in ${files.length} file${files.length > 1 ? "s" : ""}.`
          : pair.severity === "overlap"
            ? "They touch the same files, but the edits merge cleanly today."
            : "They don't share any files."}
      </p>
      {files.length > 0 && <ul className="filelist">{files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>}
      {pair.severity !== "none" && (
        <div className="row wrap">
          <button disabled={busy || !alive(a)} onClick={() => warn(a, b)} title={alive(a) ? "" : "Agent isn't running"}>Warn {a.name}</button>
          <button className="ghost" disabled={busy || !alive(b)} onClick={() => warn(b, a)} title={alive(b) ? "" : "Agent isn't running"}>Warn {b.name}</button>
        </div>
      )}
    </div>
  );
}
