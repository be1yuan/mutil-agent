import { minimatch } from "minimatch";
import type { AgentDefinition, Permission, BashPermission } from "../agent/types.js";

// ── Permission resolver ──

export class PermissionResolver {
  private globalRequireApproval: Set<string>;

  constructor(globalRequireApproval: string[] = []) {
    this.globalRequireApproval = new Set(globalRequireApproval);
  }

  /**
   * Check if an agent can use a tool.
   *
   * Priority rules:
   * 1. Global requireApproval is the minimum security baseline
   * 2. Agent-level tools config can only be stricter, never looser
   * 3. Final decision = stricter of the two
   */
  canUse(
    definition: AgentDefinition,
    toolName: string,
    bashCommand?: string
  ): { decision: Permission; needsApproval: boolean } {
    const agentResult = this.resolveAgentLevel(definition, toolName, bashCommand);
    const globalDecision = this.checkGlobalBaseline(toolName, bashCommand);
    const finalDecision = stricter(agentResult.decision, globalDecision);

    return {
      decision: finalDecision,
      needsApproval: finalDecision === "ask",
    };
  }

  private resolveAgentLevel(
    definition: AgentDefinition,
    toolName: string,
    bashCommand?: string
  ): { decision: Permission } {
    const perm = definition.tools[toolName];

    // Tool not listed → default deny
    if (!perm) return { decision: "deny" };

    // Bash tool: glob matching
    if (toolName === "Bash" && bashCommand && typeof perm === "object") {
      return { decision: resolveBash(perm as BashPermission, bashCommand) };
    }

    // Other tools: simple string value
    const decision = typeof perm === "string" ? perm : "deny";
    return { decision };
  }

  private checkGlobalBaseline(toolName: string, bashCommand?: string): Permission {
    for (const baseline of this.globalRequireApproval) {
      if (baseline === toolName) return "ask";
      if (baseline === "bash.exec" && toolName === "Bash") return "ask";
      if (baseline.startsWith("bash.") && toolName === "Bash" && bashCommand) {
        const cmdPattern = baseline.replace("bash.", "");
        if (bashCommand.startsWith(cmdPattern)) return "ask";
      }
    }
    return "allow";
  }
}

// ── Helpers ──

function stricter(a: Permission, b: Permission): Permission {
  const order = { deny: 3, ask: 2, allow: 1 };
  return order[a] >= order[b] ? a : b;
}

function resolveBash(perm: BashPermission, command: string): Permission {
  // deny first
  for (const pattern of perm.deny ?? []) {
    if (minimatch(command, pattern)) return "deny";
  }
  // ask second
  for (const pattern of perm.ask ?? []) {
    if (minimatch(command, pattern)) return "ask";
  }
  // allow fallback
  for (const pattern of perm.allow ?? []) {
    if (minimatch(command, pattern)) return "allow";
  }
  // No match → default ask (safe default)
  return "ask";
}
