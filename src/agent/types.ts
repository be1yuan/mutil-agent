import type { ModelProvider } from "../types/core.js";

// ── Permissions ──

export type Permission = "allow" | "ask" | "deny";

export interface BashPermission {
  allow?: string[];  // glob patterns
  ask?: string[];
  deny?: string[];
}

export type ToolPermission = Permission | BashPermission;

export function isBashPermission(p: ToolPermission): p is BashPermission {
  return typeof p === "object" && p !== null;
}

// ── Agent definition ──

export interface AgentDefinition {
  agentType: string;
  model: string;
  provider?: ModelProvider;        // optional — AdapterSelector decides default
  description?: string;
  systemPrompt: string;            // parsed from markdown body
  tools: Record<string, ToolPermission>;
  maxSteps: number;
  timeout: number;                 // ms
  isolation?: "context" | "worktree";
}

// ── Parsed tools ──

export interface ResolvedTools {
  allowed: string[];
  ask: string[];
  denied: string[];
  bashPatterns: {
    allow: string[];
    ask: string[];
    deny: string[];
  };
}

/** Extract tool names list for use in permission checks */
export function resolveTools(tools: Record<string, ToolPermission>): ResolvedTools {
  const result: ResolvedTools = {
    allowed: [],
    ask: [],
    denied: [],
    bashPatterns: { allow: [], ask: [], deny: [] },
  };

  for (const [name, perm] of Object.entries(tools)) {
    if (isBashPermission(perm)) {
      if (perm.allow) result.bashPatterns.allow.push(...perm.allow);
      if (perm.ask) result.bashPatterns.ask.push(...perm.ask);
      if (perm.deny) result.bashPatterns.deny.push(...perm.deny);
      // Bash is always in "allowed" if defined, actual cmd matching happens at runtime
      result.allowed.push(name);
    } else {
      switch (perm) {
        case "allow": result.allowed.push(name); break;
        case "ask": result.ask.push(name); break;
        case "deny": result.denied.push(name); break;
      }
    }
  }

  return result;
}
