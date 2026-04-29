/**
 * ANSI terminal formatting utilities — zero dependencies.
 * Provides colors, symbols, and formatting functions for terminal output.
 */

// ── ANSI escape codes ──

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

/** Foreground colors */
export const fg = {
  green: (s: string) => `${ESC}32m${s}${RESET}`,
  red: (s: string) => `${ESC}31m${s}${RESET}`,
  yellow: (s: string) => `${ESC}33m${s}${RESET}`,
  cyan: (s: string) => `${ESC}36m${s}${RESET}`,
  blue: (s: string) => `${ESC}34m${s}${RESET}`,
  magenta: (s: string) => `${ESC}35m${s}${RESET}`,
  gray: (s: string) => `${ESC}90m${s}${RESET}`,
  white: (s: string) => `${ESC}97m${s}${RESET}`,
};

/** Composite styles */
export const style = {
  bold: (s: string) => `${BOLD}${s}${RESET}`,
  dim: (s: string) => `${DIM}${s}${RESET}`,
  success: (s: string) => fg.green(s),
  error: (s: string) => fg.red(s),
  warning: (s: string) => fg.yellow(s),
  info: (s: string) => fg.cyan(s),
  muted: (s: string) => fg.gray(s),
};

// ── Unicode symbols ──

export const symbols = {
  // Steps
  step: "▸",
  stepSub: "├▸",
  stepLast: "└▸",

  // Tools
  read: "📄",
  write: "📝",
  edit: "✏️",
  bash: "⚙️",
  grep: "🔍",
  glob: "📂",
  webSearch: "🌐",
  webFetch: "🔗",
  spawn: "┬",

  // Status
  ok: "✓",
  fail: "✗",
  warn: "⚠",
  info: "●",
  running: "◌",
  done: "✓",
  pending: "○",

  // Box drawing
  boxH: "─",
  boxV: "│",
  boxTL: "╭",
  boxTR: "╮",
  boxBL: "╰",
  boxBR: "╯",
};

// ── Formatting functions ──

/** Map tool name to its symbol */
export function toolSymbol(toolName: string): string {
  const map: Record<string, string> = {
    Read: symbols.read,
    Write: symbols.write,
    Edit: symbols.edit,
    Bash: symbols.bash,
    Grep: symbols.grep,
    Glob: symbols.glob,
    WebSearch: symbols.webSearch,
    WebFetch: symbols.webFetch,
    task: symbols.spawn,
  };
  return map[toolName] ?? symbols.info;
}

/** Boxed banner with lines */
export function banner(lines: string[], width = 60): string {
  const top = `${symbols.boxTL}${symbols.boxH.repeat(width - 2)}${symbols.boxTR}`;
  const bottom = `${symbols.boxBL}${symbols.boxH.repeat(width - 2)}${symbols.boxBR}`;
  const body = lines.map((line) => {
    // Strip ANSI codes for length calculation
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    const padLen = Math.max(0, width - 3 - stripped.length);
    return `${symbols.boxV} ${line}${" ".repeat(padLen)}${symbols.boxV}`;
  });
  return [top, ...body, bottom].join("\n");
}

/** Progress bar */
export function progressBar(ratio: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pct = (clamped * 100).toFixed(1) + "%";
  return `[${bar}] ${pct}`;
}

/** Truncate string with ellipsis */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

/** Summarize tool arguments for display (non-verbose mode) */
export function summarizeToolArgs(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return String(args.file_path ?? args.path ?? "");
    case "Bash":
      return String(args.command ?? "");
    case "Grep":
      return String(args.pattern ?? "");
    case "Glob":
      return String(args.pattern ?? "");
    case "WebSearch":
      return String(args.query ?? "");
    case "WebFetch":
      return String(args.url ?? "");
    case "task":
      return String(args.task ?? "").slice(0, 80);
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

/** Member colors for committee mode */
export const MEMBER_COLORS = [
  fg.cyan,
  fg.yellow,
  fg.magenta,
  fg.green,
  fg.blue,
];
