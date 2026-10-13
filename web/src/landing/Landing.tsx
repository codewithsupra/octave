import { useEffect, useState } from "react";
import { Mark } from "../ui";
import { linkProps } from "../router";
import "./landing.css";

const REPO = "https://github.com/codewithsupra/octave";

export function Landing() {
  useEffect(() => {
    document.title = "Octave: run a fleet of coding agents without collisions";
  }, []);
  return (
    <div className="lp">
      <Nav />
      <main>
        <Hero />
        <Problems />
        <Features />
        <Included />
        <HowItWorks />
        <About />
        <FinalCta />
      </main>
      <footer className="lp-foot">
        <div className="lp-wrap foot-row">
          <span className="brand-sm"><Mark /> Octave</span>
          <span className="muted">An independent open-source project. MIT licensed.</span>
          <nav className="foot-links" aria-label="Footer">
            <a {...linkProps("/demo")}>Demo</a>
            <a href={REPO}>Source</a>
            <a {...linkProps("/sign-in")}>Sign in</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Nav() {
  return (
    <header className="lp-nav">
      <div className="lp-wrap nav-row">
        <a className="brand-sm" {...linkProps("/")}><Mark /> Octave</a>
        <nav className="nav-links" aria-label="Sections">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#about">About</a>
        </nav>
        <div className="nav-cta">
          <a className="lp-link" {...linkProps("/sign-in")}>Sign in</a>
          <a className="lp-btn" {...linkProps("/demo")}>Try the demo</a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero lp-wrap">
      <div className="hero-copy">
        <h1>Run a fleet of coding agents. See which ones will collide before they do.</h1>
        <p className="hero-sub">
          Octave gives every agent its own worktree, ports and env files, then merges their unfinished work in memory every few
          seconds. Conflicts show up while there's still time to steer, finished work arrives ranked by risk, and you can race agents
          on the same task to see which one was worth it.
        </p>
        <div className="hero-cta">
          <a className="lp-btn big" {...linkProps("/demo")}>Try the live demo</a>
          <a className="lp-btn ghost big" href="#install">Install locally</a>
        </div>
        <p className="hero-note">Works with Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, Aider or any command. Free, open source, and it runs on your machine.</p>
      </div>
      <HeroRadar />
    </section>
  );
}

const AGENTS = ["bulk-discounts", "discount-refactor", "tax-by-region", "session-hardening"];
type Cell = "none" | "overlap" | "conflict";
const PHASES: Array<{ cells: Record<string, Cell>; caption: string; chip?: string; ms: number }> = [
  { cells: {}, caption: "Four agents start on four tasks, each in its own worktree.", ms: 1800 },
  { cells: { "0-2": "overlap" }, caption: "Two agents touch src/cart.ts on different lines. That merges cleanly.", ms: 2200 },
  { cells: { "0-2": "overlap", "0-1": "conflict", "1-2": "overlap" }, caption: "bulk-discounts and discount-refactor rewrote the same lines. That will conflict.", ms: 2600 },
  { cells: { "0-2": "overlap", "0-1": "conflict", "1-2": "overlap" }, caption: "One click tells discount-refactor which code another agent owns.", chip: "Heads-up sent to discount-refactor", ms: 2200 },
  { cells: { "0-2": "overlap" }, caption: "It moves its change to a new file. Resolved before either agent finished.", ms: 3200 },
];

function HeroRadar() {
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [i, setI] = useState(reduced ? 2 : 0);
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setI((x) => (x + 1) % PHASES.length), PHASES[i].ms);
    return () => clearTimeout(t);
  }, [i, reduced]);
  const phase = PHASES[i];
  const cell = (r: number, c: number): Cell => phase.cells[`${Math.min(r, c)}-${Math.max(r, c)}`] ?? "none";
  return (
    <figure className="hero-radar" aria-label="Animated example of Octave's conflict radar">
      <div className="hr-head">
        <span className="hr-title">Conflict radar</span>
        <span className="hr-live"><span className="live-dot" /> merging every 4s</span>
      </div>
      <div className="hr-grid" style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${AGENTS.length}, 40px)` }}>
        {AGENTS.map((name, r) => (
          <div key={name} className="hr-row">
            <span className="hr-name"><span className={`dot ${i >= 4 && r === 1 ? "dot-running" : "dot-idle"}`} /> {name}</span>
            {AGENTS.map((_, c) => {
              const v = r === c ? "self" : cell(r, c);
              return <span key={c} className={`hr-cell ${v}`}>{v === "conflict" ? "1" : v === "overlap" ? "1" : ""}</span>;
            })}
          </div>
        ))}
      </div>
      <figcaption className="hr-caption" aria-live="polite">{phase.caption}</figcaption>
      <div className={`hr-chip ${phase.chip ? "on" : ""}`}>{phase.chip ?? " "}</div>
    </figure>
  );
}

function Problems() {
  const items = [
    ["Collisions surface at merge time", "Worktrees keep agents from overwriting each other's files. They don't stop two agents from rewriting the same function. You find that out an hour later, in a conflict."],
    ["Review becomes the job", "Five agents produce five diffs. Without an order, the auth change and the README typo get the same attention, and the one that matters waits."],
    ["Nobody knows which agent was worth it", "Running agents in parallel multiplies the bill. Without measuring the output, there's no way to tell whether the extra runs bought better code."],
  ];
  return (
    <section className="lp-wrap problems" aria-labelledby="problems-h">
      <h2 id="problems-h">What breaks at five agents</h2>
      <div className="prob-grid">
        {items.map(([h, p]) => (
          <div key={h} className="prob">
            <h3>{h}</h3>
            <p>{p}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Features() {
  const rows = [
    {
      id: "radar",
      title: "Conflict radar",
      lead: "Every pair of workspaces is merged in memory, uncommitted work included, every few seconds.",
      points: [
        "A real three-way merge with git merge-tree, not a guess from file names.",
        "Flags when main moves underneath a workspace.",
        "Warn an agent from the cell. Octave types the heads-up into its terminal.",
      ],
      img: "/shots/radar.png",
    },
    {
      id: "review",
      title: "Review queue",
      lead: "Finished work arrives riskiest first, and every point of the score comes with a reason.",
      points: [
        "Catches destructive SQL, auth and payments code, CI, infra, secrets and lockfiles.",
        "Penalises source changes without test changes; rewards diffs that include tests.",
        "Work still in progress waits at the bottom until the agent stops.",
      ],
      img: "/shots/review.png",
    },
    {
      id: "tournament",
      title: "Tournament",
      lead: "Give one task to several agents, run your tests in every worktree, and keep the best result.",
      points: [
        "Ranked by passing checks, then lowest review risk, then smallest diff.",
        "Mix agents, or run the same agent several times.",
        "Keep the winner's branch and archive the rest in one click.",
      ],
      img: "/shots/tournament.png",
    },
  ];
  return (
    <section id="features" className="lp-wrap features" aria-labelledby="features-h">
      <h2 id="features-h">Three things your worktree tool doesn't do</h2>
      {rows.map((r, n) => (
        <article key={r.id} className={`feat ${n % 2 ? "flip" : ""}`}>
          <div className="feat-copy">
            <h3>{r.title}</h3>
            <p className="feat-lead">{r.lead}</p>
            <ul>{r.points.map((p) => <li key={p}>{p}</li>)}</ul>
            <a className="lp-link" {...linkProps(`/demo#/${r.id}`)}>See it in the demo</a>
          </div>
          <div className="feat-shot">
            <img src={r.img} alt={`Octave ${r.title.toLowerCase()} screen`} loading="lazy" width={1440} height={900} />
          </div>
        </article>
      ))}
    </section>
  );
}

function Included() {
  const items = [
    ["Its own ports", "Each workspace reserves ten free ports and exports PORT, so ten dev servers never collide."],
    ["Env files carried over", "Gitignored .env files are copied into every new worktree, where git leaves them behind."],
    ["No setup script", "Octave detects pnpm, bun, yarn, npm, uv, poetry, pip, cargo, go or bundler and installs first."],
    ["Any CLI agent", "Presets for six agents, plus any command you type with a {prompt} placeholder."],
    ["Real terminals", "A full PTY per agent in the browser, with history that survives a reload."],
    ["Tells you when it's your turn", "Status for every agent, plus a desktop notification when one starts waiting on you."],
    ["Commit and open PRs", "From the changes panel, through the GitHub CLI you already use."],
    ["Locked to you", "Clerk sign-in, and the first account claims the machine. Nobody else gets a shell."],
  ];
  return (
    <section className="lp-wrap included" aria-labelledby="inc-h">
      <h2 id="inc-h">And the basics, without the setup</h2>
      <dl className="inc-grid">
        {items.map(([t, d]) => (
          <div key={t}>
            <dt>{t}</dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    ["Branch", "Each task gets a git worktree on its own branch, a block of ports and copies of your env files."],
    ["Snapshot", "Octave turns each agent's current state, uncommitted edits included, into a commit through a throwaway index. The agent's own index is never touched."],
    ["Merge in memory", "Pairs of snapshots go through git merge-tree. Snapshots are content-addressed, so only pairs that changed are recomputed."],
    ["Score and rank", "Diffs are scored with explainable rules, and tournament entrants are ranked after your checks run."],
  ];
  return (
    <section id="how" className="lp-wrap how" aria-labelledby="how-h">
      <h2 id="how-h">How it works</h2>
      <div className="how-grid">
        <ol className="steps">
          {steps.map(([t, d], i) => (
            <li key={t}>
              <span className="step-n">{i + 1}</span>
              <div><h3>{t}</h3><p>{d}</p></div>
            </li>
          ))}
        </ol>
        <pre className="code" aria-label="Snapshot implementation">
{`# capture an agent's work without touching its index
export GIT_INDEX_FILE=$(mktemp)
git read-tree HEAD
git add -A
tree=$(git write-tree)
snap=$(git commit-tree $tree -p HEAD -m snapshot)

# will these two agents conflict?
git merge-tree --write-tree --name-only $snapA $snapB`}
        </pre>
      </div>
    </section>
  );
}

function About() {
  return (
    <section id="about" className="lp-wrap about" aria-labelledby="about-h">
      <h2 id="about-h">About</h2>
      <div className="about-grid">
        <div className="about-why">
          <h3>Why Octave exists</h3>
          <p>
            Tools for running coding agents in parallel have solved isolation: one worktree per agent and a dashboard of terminals.
            The questions that come next are still left to you. Which of these agents are about to collide? Which diff do I read
            first? Was the second agent worth paying for?
          </p>
          <p>Octave answers those three with git's own merge machinery, a scoring model you can read, and a test run.</p>
        </div>
        <div className="about-me">
          <div className="me-head">
            <span className="avatar" aria-hidden="true">SS</span>
            <div>
              <h3>Supratim Sarkar</h3>
              <p className="muted">Designed and built Octave</p>
            </div>
          </div>
          <p>
            Full-stack TypeScript engineer who ships complete products, from React interfaces to Node.js services, and tests them
            against real failures. Contributor to Tiptap, with two fixes merged by its core team. Previously a software engineering
            intern at Mendix, a Siemens company. M.Sc. in Software Engineering from VU Amsterdam and the University of Amsterdam, and
            an AWS Certified Solutions Architect.
          </p>
          <ul className="me-links">
            <li><a href="https://github.com/codewithsupra">GitHub</a></li>
            <li><a href="https://linkedin.com/in/supratimsarkar99">LinkedIn</a></li>
            <li><a href="https://supratim-software-portfolio.vercel.app">Portfolio</a></li>
            <li><a href="mailto:supratim347@gmail.com">Email</a></li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  const [copied, setCopied] = useState(false);
  const cmd = `git clone ${REPO}\ncd octave && npm install && npm start`;
  return (
    <section id="install" className="final" aria-labelledby="final-h">
      <div className="lp-wrap final-row">
        <div>
          <h2 id="final-h">Your next five pull requests, written in parallel.</h2>
          <p className="muted">Needs Node 20+ and git 2.38+. Opens at localhost:7420 and keeps everything on your machine.</p>
          <div className="hero-cta">
            <a className="lp-btn big" {...linkProps("/demo")}>Try the live demo</a>
            <a className="lp-btn ghost big" {...linkProps("/app")}>Open my Octave</a>
          </div>
        </div>
        <div className="final-code">
          <pre className="code">{cmd}</pre>
          <button
            className="ghost copy"
            onClick={() => {
              navigator.clipboard?.writeText(cmd).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </section>
  );
}
