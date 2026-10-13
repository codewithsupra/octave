import { useEffect, useRef, useState } from "react";
import type { AppState } from "./types";

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error ?? text; } catch {}
    throw new Error(msg || `Request failed (${res.status})`);
  }
  try { return JSON.parse(text) as T; } catch { return text as T; }
}

export function wsUrl(path: string): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}

/** Live app state pushed from the server; reconnects with backoff. */
export function useAppState(): { state: AppState | null; connected: boolean } {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let dead = false;
    let timer: number | undefined;
    const open = () => {
      ws = new WebSocket(wsUrl("/ws/events"));
      ws.onopen = () => { retry = 0; setConnected(true); };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "state") setState({ ...m.state, statuses: m.statuses });
      };
      ws.onclose = () => {
        setConnected(false);
        if (!dead) timer = window.setTimeout(open, Math.min(5000, 300 * 2 ** retry++));
      };
    };
    open();
    return () => { dead = true; clearTimeout(timer); ws?.close(); };
  }, []);
  return { state, connected };
}

/** Poll an endpoint while mounted (and the tab is visible). */
export function usePoll<T>(path: string | null, ms: number): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);
  const [, force] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const run = async () => {
      try {
        const d = await api<T>(path);
        if (alive) { setData(d); setError(null); }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    // Always load once; after that, skip background ticks and catch up the
    // moment the tab is visible again.
    run();
    const id = window.setInterval(() => !document.hidden && run(), ms);
    const onVis = () => !document.hidden && run();
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [path, ms, tick.current]);
  useEffect(() => { setData(null); }, [path]);
  return { data, error, refresh: () => { tick.current++; force((x) => x + 1); } };
}
