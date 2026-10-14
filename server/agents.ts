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
  /** Other executable names for the same agent (first found on PATH wins). */
  altBins?: string[];
  /** Interactive TUI, optionally seeded with a first prompt. `flags` go right after the binary. */
  interactive: (prompt?: string, flags?: string) => string;
  /** Non-interactive run that exits when the task is done (used by tournaments). */
  headless: (prompt: string, flags?: string) => string;
}

const withFlags = (bin: string, flags?: string) => (flags ? `${bin} ${flags}` : bin);

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
    interactive: (p, f) => (p ? `${withFlags("codex", f)} ${q(p)}` : withFlags("codex", f)),
    // `--full-auto` was removed in newer Codex; workspace-write keeps writes inside the worktree.
    headless: (p, f) => `${withFlags("codex", f)} exec --sandbox workspace-write ${q(p)}`,
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
    // Cursor renamed the CLI to `agent`; `cursor-agent` remains as an alias.
    altBins: ["agent"],
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

export function which(bin: string, envPath = process.env.PATH ?? ""): string | null {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of envPath.split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {}
    }
  }
  return null;
}

export function onPath(bin: string, envPath = process.env.PATH ?? ""): boolean {
  return !bin || which(bin, envPath) !== null;
}

/** The executable to run for a preset, or null when it isn't installed. */
export function resolveBin(preset: AgentPreset, envPath = process.env.PATH ?? ""): string | null {
  if (!preset.bin) return "";
  if (which(preset.bin, envPath)) return preset.bin;
  for (const alt of preset.altBins ?? []) {
    const full = which(alt, envPath);
    // `agent` is a generic name; only accept the one Cursor's installer puts in ~/.cursor/bin.
    if (full && (alt !== "agent" || full.includes(`${path.sep}.cursor${path.sep}`))) return alt;
  }
  return null;
}

/** A user-defined command template; `{prompt}` is replaced with the quoted prompt. */
export function customCommand(template: string, prompt?: string): string {
  return template.includes("{prompt}") ? template.replaceAll("{prompt}", q(prompt ?? "")) : template;
}

export function agentCommand(agent: string, opts: { prompt?: string; headless?: boolean; flags?: string; envPath?: string }): string {
  if (agent.startsWith("custom:")) return customCommand(agent.slice(7), opts.prompt);
  const preset = findPreset(agent);
  if (!preset) throw new Error(`Unknown agent "${agent}"`);
  let cmd = opts.headless ? preset.headless(opts.prompt ?? "", opts.flags) : preset.interactive(opts.prompt, opts.flags);
  // Swap in an alternate executable name if that's what's installed.
  const bin = preset.bin ? resolveBin(preset, opts.envPath) : null;
  if (bin && bin !== preset.bin && cmd.startsWith(preset.bin)) cmd = bin + cmd.slice(preset.bin.length);
  return cmd;
}
