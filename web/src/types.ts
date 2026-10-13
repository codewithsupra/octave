export type Status = "running" | "idle" | "exited";

export interface Project { id: string; name: string; path: string; baseBranch: string }
export interface Workspace {
  id: string; projectId: string; name: string; branch: string; path: string; baseBranch: string;
  agent: string; prompt?: string; command: string; ports: { base: number; ports: number[] };
  copiedEnv: string[]; setup: string | null; tournamentId?: string; createdAt: number;
}
export interface Entrant {
  workspaceId: string; agent: string; exitCode?: number | null; churn?: number; files?: number; risk?: number; score?: number;
  verify?: { passed: boolean; code: number | null; durationMs: number; tail: string };
}
export interface Tournament {
  id: string; projectId: string; prompt: string; verify: string; status: "running" | "judging" | "done";
  entrants: Entrant[]; winner?: string; createdAt: number;
}
export interface SessionInfo { status: Status; exitCode: number | null; lastOutputAt: number; startedAt: number }
export interface AppState {
  projects: Project[]; workspaces: Workspace[]; tournaments: Tournament[];
  statuses: Record<string, SessionInfo>;
}
export interface FileChange { path: string; status: "A" | "M" | "D" | "R"; added: number; deleted: number; binary: boolean }
export interface Risk {
  score: number; level: "low" | "medium" | "high";
  reasons: { points: number; label: string }[];
  stats: { files: number; added: number; deleted: number };
}
export interface Diff { snapshot: string; base: string; files: FileChange[]; risk: Risk }
export interface RadarPair { a: string; b: string; overlap: string[]; conflicts: string[]; severity: "none" | "overlap" | "conflict" }
export interface Radar { pairs: RadarPair[]; baseConflicts: Record<string, string[]>; computedAt: number }
export interface Agent { id: string; label: string; available: boolean }
