import { useEffect, useState } from "react";
import { api, usePoll } from "../api";
import { Terminal } from "../Terminal";
import type { AppState, Diff, Workspace } from "../types";
import { RiskBadge, StatusDot, displayName, statusLabel, toast, useAsync } from "../ui";

export function WorkspaceView({ ws, state, onRemoved }: { ws: Workspace; state: AppState; onRemoved: () => void }) {
  const info = state.statuses[ws.id];
  const { busy, run } = useAsync();
  const [showChanges, setShowChanges] = useState(true);

  const remove = () => {
    if (!confirm(`Archive "${ws.name}"? This removes the worktree and deletes branch ${ws.branch}.`)) return;
    run(() => api(`/api/workspaces/${ws.id}`, { method: "DELETE" }), "Workspace archived").then(onRemoved);
  };

  return (
    <div className="ws-view">
      <header className="ws-head">
        <div className="ws-title">
          <StatusDot status={info?.status} />
          <div>
            <h1>{displayName(ws.name)}</h1>
            <p className="meta">
              <code>{ws.branch}</code> from <code>{ws.baseBranch}</code>
              <span className="sep" />
              {statusLabel(info?.status)}
              <span className="sep" />
              <span title={`PORT and OCTAVE_PORT_0…9 are reserved for this workspace (${ws.ports.ports[0]}–${ws.ports.ports.at(-1)})`}>
                ports {ws.ports.ports[0]}–{ws.ports.ports.at(-1)}
              </span>
              {ws.copiedEnv.length > 0 && (
                <>
                  <span className="sep" />
                  <span title={ws.copiedEnv.join("\n")}>{ws.copiedEnv.length} env file{ws.copiedEnv.length > 1 ? "s" : ""} copied</span>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="actions">
          <OpenMenu ws={ws} />
          <button className="ghost" disabled={busy} onClick={() => run(() => api(`/api/workspaces/${ws.id}/restart`, { body: { mode: "agent" } }))}>Restart agent</button>
          <button className="ghost" disabled={busy} onClick={() => run(() => api(`/api/workspaces/${ws.id}/restart`, { body: { mode: "shell" } }))}>New shell</button>
          <button className="ghost" aria-pressed={showChanges} onClick={() => setShowChanges((x) => !x)}>Changes</button>
          <button className="danger ghost" disabled={busy} onClick={remove}>Archive</button>
        </div>
      </header>
      {ws.prompt && <p className="task" title={ws.prompt}>{ws.prompt}</p>}
      <div className={`ws-body ${showChanges ? "with-changes" : ""}`}>
        <Terminal workspaceId={ws.id} generation={info?.startedAt ?? 0} />
        {showChanges && <ChangesPanel ws={ws} />}
      </div>
    </div>
  );
}

function OpenMenu({ ws }: { ws: Workspace }) {
  const { run } = useAsync();
  const open = (app: string) => run(() => api(`/api/workspaces/${ws.id}/open`, { body: { app } }));
  return (
    <select className="ghost" value="" aria-label="Open in" onChange={(e) => e.target.value && open(e.target.value)}>
      <option value="">Open in…</option>
      <option value="cursor">Cursor</option>
      <option value="code">VS Code</option>
      <option value="zed">Zed</option>
      <option value="finder">File manager</option>
    </select>
  );
}

export function ChangesPanel({ ws }: { ws: Workspace }) {
  const { data: diff, error, refresh } = usePoll<Diff>(`/api/workspaces/${ws.id}/diff`, 3000);
  const [file, setFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<string>("");
  const [msg, setMsg] = useState("");
  const { busy, run } = useAsync();

  useEffect(() => setFile(null), [ws.id]);
  useEffect(() => {
    if (!file) return setPatch("");
    api<string>(`/api/workspaces/${ws.id}/patch?file=${encodeURIComponent(file)}`).then(setPatch).catch((e) => setPatch(String(e.message)));
  }, [file, ws.id, diff?.snapshot]);

  const commit = () =>
    run(async () => {
      const r = await api<{ sha: string | null }>(`/api/workspaces/${ws.id}/commit`, { body: { message: msg } });
      toast(r.sha ? `Committed ${r.sha.slice(0, 7)} on ${ws.branch}` : "Nothing to commit");
      setMsg("");
      refresh();
    });
  const pr = () =>
    run(async () => {
      const r = await api<{ url: string }>(`/api/workspaces/${ws.id}/pr`, { body: { message: msg } });
      toast("Pull request opened");
      window.open(r.url, "_blank", "noopener");
    });

  return (
    <aside className="changes">
      <div className="changes-head">
        <h3>Changes vs {ws.baseBranch}</h3>
        {diff && <RiskBadge risk={diff.risk} />}
      </div>
      {error && <p className="error">{error}</p>}
      {!diff && !error && <p className="muted pad">Reading worktree…</p>}
      {diff && diff.files.length === 0 && <p className="muted pad">No changes yet. Edits show up here within a few seconds, including uncommitted ones.</p>}
      {diff && diff.files.length > 0 && (
        <>
          <p className="stats">
            {diff.risk.stats.files} file{diff.risk.stats.files === 1 ? "" : "s"} <span className="add">+{diff.risk.stats.added}</span> <span className="del">−{diff.risk.stats.deleted}</span>
          </p>
          {diff.risk.reasons.length > 0 && (
            <ul className="reasons">
              {diff.risk.reasons.slice(0, 4).map((r, i) => (
                <li key={i}><span className={r.points < 0 ? "add" : r.points > 0 ? "del" : "muted"}>{r.points > 0 ? `+${r.points}` : r.points}</span> {r.label}</li>
              ))}
            </ul>
          )}
          <ul className="files">
            {diff.files.map((f) => (
              <li key={f.path}>
                <button className={file === f.path ? "file active" : "file"} onClick={() => setFile(file === f.path ? null : f.path)}>
                  <span className={`fs fs-${f.status}`}>{f.status}</span>
                  <span className="fp" title={f.path}>{f.path}</span>
                  <span className="add">{f.binary ? "bin" : `+${f.added}`}</span>
                  {!f.binary && <span className="del">−{f.deleted}</span>}
                </button>
              </li>
            ))}
          </ul>
          {file && <PatchView patch={patch} />}
          <div className="commit">
            <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Commit message" onKeyDown={(e) => e.key === "Enter" && commit()} />
            <div className="row">
              <button disabled={busy} onClick={commit}>Commit</button>
              <button className="ghost" disabled={busy} onClick={pr} title="Commits, pushes the branch and opens a PR with the GitHub CLI">Open PR</button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

export function PatchView({ patch }: { patch: string }) {
  const lines = patch.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  return (
    <pre className="patch">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "ins" : l.startsWith("-") ? "rem" : ""}>{l || " "}</div>
      ))}
    </pre>
  );
}
