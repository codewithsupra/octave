import { useMemo, useState } from "react";
import { App } from "../App";
import { setBackend } from "../api";
import { DemoSim } from "../demo/sim";
import { linkProps } from "../router";

// ---------- /demo: real UI, simulated backend ----------

let sim: DemoSim | null = null;
export default function DemoRoot() {
  const s = useMemo(() => (sim ??= new DemoSim()), []);
  setBackend(s);
  const [key, setKey] = useState(0);
  return (
    <App
      key={key}
      mode="demo"
      banner={
        <div className="demo-banner" role="note">
          <span>
            <b>Live demo.</b> Real Octave UI and scoring, simulated agents. Open the <a href="#/radar">Conflict radar</a>, click a red cell and warn an agent.
          </span>
          <span className="row">
            <button className="ghost" onClick={() => { s.reset(); setKey((k) => k + 1); location.hash = ""; }}>Restart demo</button>
            <a className="btn" {...linkProps("/")}>About Octave</a>
          </span>
        </div>
      }
    />
  );
}

