import { useEffect, useState, type ReactNode } from "react";
import type { Risk, Status } from "./types";

export function StatusDot({ status, title }: { status?: Status; title?: string }) {
  const s = status ?? "exited";
  const label = statusLabel(s);
  return <span className={`dot dot-${s}`} role="img" title={title ?? label} aria-label={label} />;
}

export function statusLabel(s?: Status) {
  return { running: "Working", idle: "Waiting on you", attention: "Needs your approval", exited: "Stopped" }[s ?? "exited"];
}

/** Statuses where the agent is blocked on the human. */
export const needsYou = (s?: Status) => s === "idle" || s === "attention";

export function RiskBadge({ risk }: { risk: Risk }) {
  return (
    <span className={`risk risk-${risk.level}`} title={risk.reasons.map((r) => `${r.points > 0 ? "+" : ""}${r.points} ${r.label}`).join("\n")}>
      <span className="risk-bar"><span style={{ width: `${Math.max(4, risk.score)}%` }} /></span>
      {risk.score}
    </span>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="ghost icon" onClick={onClose} aria-label="Close">✕</button></header>
        {children}
      </div>
    </div>
  );
}

let pushToast: (msg: string, kind?: "ok" | "err") => void = () => {};
export const toast = (msg: string, kind: "ok" | "err" = "ok") => pushToast(msg, kind);

export function Toasts() {
  const [items, setItems] = useState<{ id: number; msg: string; kind: string }[]>([]);
  useEffect(() => {
    pushToast = (msg, kind = "ok") => {
      const id = Math.random();
      setItems((x) => [...x, { id, msg, kind }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === "err" ? 7000 : 3500);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>)}
    </div>
  );
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function agentLabel(agent: string) {
  return agent.startsWith("custom:") ? "custom" : agent;
}

export function Mark() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M12 22a3 3 0 1 1-3-3h3V8l11-2v13a3 3 0 1 1-3-3h3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  );
}

/** Tournament entrants are named t-<id>-<agent>-<n>; show just <agent>-<n>. */
export function displayName(name: string) {
  return name.replace(/^t-[0-9a-f]+-/, "");
}

export function Splash({ text }: { text: string }) {
  return <div className="boot"><Mark /><p className="muted">{text}</p></div>;
}
