/**
 * REPL slash command handler — routes /workflow and /agent commands.
 */

import type { WorkflowDefinition } from "../workflow/types.js";
import type { AgentDefinition } from "../agent/types.js";
import { style } from "./ansi.js";
import { t } from "./i18n.js";

/** All known slash commands (for fuzzy matching hints) */
export const KNOWN_COMMANDS = [
  "/model",
  "/workflow",
  "/wf",
  "/agent",
  "/language",
  "/lang",
  "/save",
  "/help",
  "/h",
];

/**
 * Find the best matching known command for a user input.
 * Returns the best match if the input is a prefix or close match, otherwise undefined.
 */
export function fuzzyMatchCommand(input: string): string | undefined {
  const lower = input.toLowerCase().replace(/\s+.*$/, ""); // strip args
  if (!lower.startsWith("/")) return undefined;

  // Exact match — no hint needed
  if (KNOWN_COMMANDS.includes(lower)) return undefined;

  // Prefix match: "/mod" → "/model"
  const prefixMatches = KNOWN_COMMANDS.filter((c) => c.startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) return undefined; // ambiguous — don't hint

  // Edit distance ≤ 2 match
  let best: string | undefined;
  let bestDist = 3; // threshold
  for (const cmd of KNOWN_COMMANDS) {
    const dist = levenshtein(lower, cmd);
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }
  return best;
}

/** Simple Levenshtein distance (for short strings, no optimization needed). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

export interface CommandContext {
  workflows: WorkflowDefinition[];
  agents: Map<string, AgentDefinition>;
  /** Run a workflow by name or file path */
  onRunWorkflow: (nameOrPath: string) => Promise<void>;
  /** List workflows */
  onListWorkflows: () => void;
  /** Show workflow status */
  onWorkflowStatus: (id: string) => Promise<void>;
  /** Create new workflow interactively */
  onNewWorkflow: () => Promise<void>;
  /** List agents */
  onListAgents: () => void;
}

export interface CommandResult {
  handled: boolean;
  /** If true, caller should continue the REPL loop (re-prompt) */
  continue?: boolean;
}

/**
 * Handle a user input line. Returns whether the input was handled as a command.
 * If not handled, the caller should treat the input as a task.
 */
export async function handleCommand(
  input: string,
  ctx: CommandContext
): Promise<CommandResult> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const sub = parts[1]?.toLowerCase();
  const arg = parts.slice(2).join(" ");

  // ── /workflow commands ──
  if (cmd === "/workflow" || cmd === "/wf") {
    if (!sub || sub === "list" || sub === "ls") {
      ctx.onListWorkflows();
      return { handled: true, continue: true };
    }

    if (sub === "new" || sub === "create") {
      await ctx.onNewWorkflow();
      return { handled: true, continue: true };
    }

    if (sub === "status") {
      if (!arg) {
        console.log(style.warning("  Usage: /workflow status <run-id>"));
        return { handled: true, continue: true };
      }
      await ctx.onWorkflowStatus(arg);
      return { handled: true, continue: true };
    }

    if (sub === "run") {
      if (!arg) {
        console.log(style.warning("  Usage: /workflow run <name>"));
        return { handled: true, continue: true };
      }
      await ctx.onRunWorkflow(arg);
      return { handled: true, continue: false };
    }

    // Unknown subcommand — show help
    console.log();
    console.log(style.bold(`  ${t("wf.title")}`));
    console.log(style.dim(`  /workflow list          ${t("wf.list")}`));
    console.log(style.dim(`  /workflow run <name>    ${t("wf.run")}`));
    console.log(style.dim(`  /workflow new           ${t("wf.new")}`));
    console.log(style.dim(`  /workflow status <id>   ${t("wf.status")}`));
    console.log();
    return { handled: true, continue: true };
  }

  // ── /agent commands ──
  if (cmd === "/agent") {
    if (!sub || sub === "list" || sub === "ls") {
      ctx.onListAgents();
      return { handled: true, continue: true };
    }

    // Unknown subcommand
    console.log();
    console.log(style.bold(`  ${t("agent.title")}`));
    console.log(style.dim(`  /agent list    ${t("agent.list")}`));
    console.log();
    return { handled: true, continue: true };
  }

  return { handled: false };
}

/**
 * Match a workflow by name from the loaded list.
 * Exact match first, then prefix match.
 */
export function findWorkflowByName(
  name: string,
  workflows: WorkflowDefinition[]
): WorkflowDefinition | undefined {
  const lower = name.toLowerCase();
  // Exact match
  const exact = workflows.find((w) => w.name.toLowerCase() === lower);
  if (exact) return exact;

  // Prefix match
  return workflows.find((w) => w.name.toLowerCase().startsWith(lower));
}
