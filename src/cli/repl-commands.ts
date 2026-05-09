/**
 * REPL slash command handler — routes /workflow and /agent commands.
 */

import type { WorkflowDefinition } from "../workflow/types.js";
import type { AgentDefinition } from "../agent/types.js";
import { style } from "./ansi.js";

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
    console.log(style.bold("  /workflow commands:"));
    console.log(style.dim("  /workflow list          List available workflows"));
    console.log(style.dim("  /workflow run <name>    Run a workflow by name"));
    console.log(style.dim("  /workflow new           Create a new workflow interactively"));
    console.log(style.dim("  /workflow status <id>   Check workflow run status"));
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
    console.log(style.bold("  /agent commands:"));
    console.log(style.dim("  /agent list    List available agents"));
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
