import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PortBlock } from "./ports";

export interface Project {
  id: string;
  name: string;
  path: string;
  baseBranch: string;
  createdAt: number;
}

export interface Workspace {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  path: string;
  baseBranch: string;
  agent: string;
  prompt?: string;
  command: string;
  ports: PortBlock;
  copiedEnv: string[];
  setup: string | null;
  tournamentId?: string;
  createdAt: number;
}

export interface Entrant {
  workspaceId: string;
  agent: string;
  exitCode?: number | null;
  verify?: { passed: boolean; code: number | null; durationMs: number; tail: string };
  churn?: number;
  files?: number;
  risk?: number;
  score?: number;
}

export interface Tournament {
  id: string;
  projectId: string;
  prompt: string;
  verify: string;
  status: "running" | "judging" | "done";
  entrants: Entrant[];
  winner?: string;
  createdAt: number;
}

export interface State {
  projects: Project[];
  workspaces: Workspace[];
  tournaments: Tournament[];
}

export class Store extends EventEmitter {
  state: State = { projects: [], workspaces: [], tournaments: [] };
  private file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(public home: string) {
    super();
    mkdirSync(home, { recursive: true });
    this.file = path.join(home, "state.json");
    if (existsSync(this.file)) {
      try {
        this.state = { ...this.state, ...JSON.parse(readFileSync(this.file, "utf8")) };
      } catch {
        // Corrupt state should never brick the app; keep a copy for forensics.
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      }
    }
  }

  /** Mutate, persist (debounced, atomic) and notify listeners. */
  update(fn: (s: State) => void): void {
    fn(this.state);
    this.emit("change", this.state);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  project(id: string): Project {
    const p = this.state.projects.find((x) => x.id === id);
    if (!p) throw new HttpError(404, `No project ${id}`);
    return p;
  }

  workspace(id: string): Workspace {
    const w = this.state.workspaces.find((x) => x.id === id);
    if (!w) throw new HttpError(404, `No workspace ${id}`);
    return w;
  }

  tournament(id: string): Tournament {
    const t = this.state.tournaments.find((x) => x.id === id);
    if (!t) throw new HttpError(404, `No tournament ${id}`);
    return t;
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
