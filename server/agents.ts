import { accessSync, constants } from "node:fs";
import path from "node:path";

/** POSIX single-quote escaping. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface AgentPreset {
  id: string;
  label: string;
  bin: string;
  /** Interactive TUI, optionally seeded with a first prompt. */
  interactive: (prompt?: string) => string;
  /** Non-interactive run that exits when the task is done (used by tournaments). */
  headless: (prompt: string) => string;
}

export const PRESETS: AgentPreset[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    interactive: (p) => (p ? `claude ${q(p)}` : "claude"),
    headless: (p) => `claude -p ${q(p)} --permission-mode acceptEdits --output-format text`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    interactive: (p) => (p ? `codex ${q(p)}` : "codex"),
    headless: (p) => `codex exec --full-auto ${q(p)}`,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    interactive: (p) => (p ? `gemini -i ${q(p)}` : "gemini"),
    headless: (p) => `gemini -p ${q(p)} --yolo`,
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    interactive: (p) => (p ? `opencode --prompt ${q(p)}` : "opencode"),
    headless: (p) => `opencode run ${q(p)}`,
  },
  {
    id: "cursor-agent",
    label: "Cursor Agent",
    bin: "cursor-agent",
    interactive: (p) => (p ? `cursor-agent ${q(p)}` : "cursor-agent"),
    headless: (p) => `cursor-agent -p ${q(p)} --force`,
  },
  {
    id: "aider",
    label: "Aider",
    bin: "aider",
    interactive: (p) => (p ? `aider --message ${q(p)}` : "aider"),
    headless: (p) => `aider --yes-always --message ${q(p)}`,
  },
  {
    id: "shell",
    label: "Shell",
    bin: "",
    interactive: () => "",
    headless: (p) => p,
  },
];

export function findPreset(id: string): AgentPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function onPath(bin: string, envPath = process.env.PATH ?? ""): boolean {
  if (!bin) return true;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of envPath.split(path.delimiter)) {
    for (const ext of exts) {
      try {
        accessSync(path.join(dir, bin + ext), constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

/** A user-defined command template; `{prompt}` is replaced with the quoted prompt. */
export function customCommand(template: string, prompt?: string): string {
  return template.includes("{prompt}") ? template.replaceAll("{prompt}", q(prompt ?? "")) : template;
}

export function agentCommand(agent: string, opts: { prompt?: string; headless?: boolean }): string {
  if (agent.startsWith("custom:")) return customCommand(agent.slice(7), opts.prompt);
  const preset = findPreset(agent);
  if (!preset) throw new Error(`Unknown agent "${agent}"`);
  if (opts.headless) return preset.headless(opts.prompt ?? "");
  return preset.interactive(opts.prompt);
}
