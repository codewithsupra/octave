import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { wsUrl } from "./api";

const theme = {
  background: "#151A27",
  foreground: "#DDE3F0",
  cursor: "#9AA8FF",
  cursorAccent: "#151A27",
  selectionBackground: "#3A4566",
  black: "#1A2030", red: "#FF7A6B", green: "#5FD3A6", yellow: "#F2C14E",
  blue: "#7FA8FF", magenta: "#C79BFF", cyan: "#6CD2E0", white: "#DDE3F0",
  brightBlack: "#5D6A88", brightRed: "#FF9A8E", brightGreen: "#86E4BF", brightYellow: "#F7D57E",
  brightBlue: "#A6C1FF", brightMagenta: "#DABBFF", brightCyan: "#95E2EC", brightWhite: "#FFFFFF",
};

/** xterm.js bound to a workspace PTY. `generation` changes when the session restarts. */
export function Terminal({ workspaceId, generation }: { workspaceId: string; generation: number }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const ws = new WebSocket(wsUrl(`/ws/term/${workspaceId}`));
    const send = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    const doFit = () => {
      try {
        fit.fit();
        send({ t: "resize", c: term.cols, r: term.rows });
      } catch {}
    };
    ws.onopen = () => { doFit(); term.focus(); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "out") term.write(m.d);
      else if (m.t === "exit") term.write(`\r\n\x1b[2m[process exited with code ${m.code}]\x1b[0m\r\n`);
    };
    ws.onclose = (e) => { if (e.code === 1008) term.write(`\r\n\x1b[31m${e.reason}\x1b[0m\r\n`); };
    const sub = term.onData((d) => send({ t: "in", d }));
    const ro = new ResizeObserver(() => requestAnimationFrame(doFit));
    ro.observe(el);
    return () => { ro.disconnect(); sub.dispose(); ws.close(); term.dispose(); };
  }, [workspaceId, generation]);

  return <div className="term" ref={host} />;
}
