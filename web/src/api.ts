import { useEffect, useRef, useState } from "react";
import type { AppState } from "./types";

/**
 * Everything the UI needs from a backend. The real one talks to the local
 * Octave server; the demo one is an in-browser simulator (see demo/sim.ts),
 * so the exact same views power both /app and /demo.
 */
export interface TermHandlers {
  onOut: (d: string) => void;
  onExit: (code: number | null) => void;
  onClose: (reason: string, code: number) => void;
}
export interface TermConn {
  send: (m: { t: "in"; d: string } | { t: "resize"; c: number; r: number }) => void;
  close: () => void;
}
export interface Backend {
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  events(onState: (s: AppState) => void, onConn: (up: boolean) => void): () => void;
  terminal(id: string, h: TermHandlers): TermConn;
}

type TokenFn = () => Promise<string | null>;
let getToken: TokenFn = async () => null;
/** Set by the Clerk bridge once a session exists. */
export function setTokenProvider(fn: TokenFn) {
  getToken = fn;
}

export function wsUrl(path: string): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function http<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {};
  if (init?.body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error ?? text; } catch {}
    throw new HttpError(res.status, msg || `Request failed (${res.status})`);
  }
  try { return JSON.parse(text) as T; } catch { return text as T; }
}

/** Opens a socket and performs the auth handshake before handing it over. */
function authedSocket(path: string, onReady: (ws: WebSocket) => void, onClose: (code: number, reason: string) => void): WebSocket {
  const ws = new WebSocket(wsUrl(path));
  ws.onopen = async () => {
    const token = await getToken();
    // With auth off the server ignores this; with auth on it's required.
    ws.send(JSON.stringify({ t: "auth", token }));
    onReady(ws);
  };
  ws.onclose = (e) => onClose(e.code, e.reason);
  return ws;
}

export const realBackend: Backend = {
  request: http,
  events(onState, onConn) {
    let ws: WebSocket | null = null;
    let retry = 0;
    let dead = false;
    let timer: number | undefined;
    const open = () => {
      ws = authedSocket(
        "/ws/events",
        (sock) => {
          sock.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.type === "state") { retry = 0; onConn(true); onState({ ...m.state, statuses: m.statuses }); }
          };
        },
        (code) => {
          onConn(false);
          // 4401/4403: auth problem; reconnecting won't help until the user acts.
          if (!dead && code !== 4403) timer = window.setTimeout(open, Math.min(5000, 300 * 2 ** retry++));
        },
      );
    };
    open();
    return () => { dead = true; clearTimeout(timer); ws?.close(); };
  },
  terminal(id, h) {
    let sock: WebSocket | null = null;
    const queue: string[] = [];
    const ws = authedSocket(
      `/ws/term/${id}`,
      (s) => {
        sock = s;
        s.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.t === "out") h.onOut(m.d);
          else if (m.t === "exit") h.onExit(m.code);
        };
        queue.splice(0).forEach((m) => s.send(m));
      },
      (code, reason) => h.onClose(reason, code),
    );
    return {
      send: (m) => {
        const raw = JSON.stringify(m);
        if (sock?.readyState === WebSocket.OPEN) sock.send(raw);
        else queue.push(raw);
      },
      close: () => ws.close(),
    };
  },
};

let backend: Backend = realBackend;
export function setBackend(b: Backend) {
  backend = b;
}
export function currentBackend(): Backend {
  return backend;
}

export function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return backend.request<T>(path, init);
}

/** Live app state pushed from the backend. */
export function useAppState(): { state: AppState | null; connected: boolean } {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => backend.events(setState, setConnected), []);
  return { state, connected };
}

/** Poll an endpoint while mounted; background ticks are skipped and caught up on focus. */
export function usePoll<T>(path: string | null, ms: number): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);
  const [, force] = useState(0);
  useEffect(() => { setData(null); }, [path]);
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
    run();
    const id = window.setInterval(() => !document.hidden && run(), ms);
    const onVis = () => !document.hidden && run();
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [path, ms, tick.current]);
  return { data, error, refresh: () => { tick.current++; force((x) => x + 1); } };
}
