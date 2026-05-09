/**
 * WorkflowMatcher — LLM-based intent matching.
 *
 * Matches a user's free-text task description against loaded workflow
 * definitions by sending a lightweight prompt to the model.
 */

import { createHash } from "node:crypto";
import type { FallbackExecutor } from "../adapters/fallback-executor.js";
import type { WorkflowDefinition } from "../workflow/types.js";
import type { ModelProvider } from "../types/core.js";

export interface WorkflowMatchResult {
  matched: boolean;
  workflowName?: string;
  workflowDescription?: string;
  stepCount?: number;
}

export interface MatcherDeps {
  fallbackExecutor: FallbackExecutor;
  /** Model to use for matching (should be cheap/fast, e.g. deepseek-v4-flash) */
  model: string;
  provider: ModelProvider;
}

/**
 * Parse LLM reply to find a matching workflow name.
 * Tries exact match first, then substring containment as fallback.
 */
function findMatchInReply(
  reply: string,
  workflows: WorkflowDefinition[]
): WorkflowDefinition | undefined {
  const lower = reply.toLowerCase().replace(/[."]/g, "").trim();
  // Exact match
  const exact = workflows.find((w) => w.name.toLowerCase() === lower);
  if (exact) return exact;
  // Substring containment — handles models that add extra text
  return workflows.find((w) => lower.includes(w.name.toLowerCase()));
}

/**
 * Analyze user task and match against available workflows.
 * Uses a single LLM call with a minimal prompt — no tools, no multi-step.
 */
export async function matchWorkflow(
  task: string,
  workflows: WorkflowDefinition[],
  deps: MatcherDeps,
  cache?: Map<string, string>
): Promise<WorkflowMatchResult> {
  if (workflows.length === 0) {
    return { matched: false };
  }

  // Check cache
  const cacheKey = taskHash(task);
  if (cache?.has(cacheKey)) {
    const cachedName = cache.get(cacheKey)!;
    if (cachedName === "__none__") {
      return { matched: false };
    }
    const wf = workflows.find((w) => w.name === cachedName);
    if (wf) {
      return {
        matched: true,
        workflowName: wf.name,
        workflowDescription: wf.description,
        stepCount: wf.steps.length,
      };
    }
  }

  // Build candidate list
  const candidates = workflows
    .map((w, i) => `${i + 1}. ${w.name}: ${w.description} (${w.steps.length} steps)`)
    .join("\n");

  const prompt = [
    `User task: "${task}"`,
    `Available workflows:`,
    candidates,
    ``,
    `If there is a matching workflow, return its name only.`,
    `If no match, return "none".`,
    `Return only the name or "nothing" — no explanation.`,
  ].join("\n");

  try {
    const response = await deps.fallbackExecutor.execute(
      {
        model: deps.model,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 100,
        temperature: 0,
      },
      deps.provider
    );

    const reply = (response.content ?? "").trim().toLowerCase();

    // Cache the result
    if (cache) {
      cache.set(cacheKey, reply === "none" ? "__none__" : reply);
    }

    if (reply === "none" || reply === "") {
      return { matched: false };
    }

    const matched = findMatchInReply(reply, workflows);
    if (matched) {
      return {
        matched: true,
        workflowName: matched.name,
        workflowDescription: matched.description,
        stepCount: matched.steps.length,
      };
    }

    return { matched: false };
  } catch {
    // On LLM error, fall through to no match — don't block the user
    return { matched: false };
  }
}

/**
 * Match multiple candidates (returns top N matches).
 */
export async function matchMultipleWorkflows(
  task: string,
  workflows: WorkflowDefinition[],
  deps: MatcherDeps,
  limit = 3
): Promise<WorkflowMatchResult[]> {
  if (workflows.length === 0) return [];

  const candidates = workflows
    .map((w, i) => `${i + 1}. ${w.name}: ${w.description} (${w.steps.length} steps)`)
    .join("\n");

  const prompt = [
    `User task: "${task}"`,
    `Available workflows:`,
    candidates,
    ``,
    `Return all matching workflow names, comma-separated.`,
    `If no match, return "none".`,
    `Return only the names — no explanation.`,
  ].join("\n");

  try {
    const response = await deps.fallbackExecutor.execute(
      {
        model: deps.model,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 150,
        temperature: 0,
      },
      deps.provider
    );

    const reply = (response.content ?? "").trim().toLowerCase();
    if (reply === "none" || reply === "") return [];

    // Parse names: try comma-split, then space-split as fallback
    let nameTokens = reply.split(",").map((s) => s.trim()).filter(Boolean);
    if (nameTokens.length <= 1 && reply.includes(" ")) {
      // Model may have returned space-separated names instead of comma-separated
      nameTokens = reply.split(/\s+/).filter((s) => s.length > 2);
    }

    const results: WorkflowMatchResult[] = [];
    for (const token of nameTokens) {
      const clean = token.replace(/[.\d]/g, "").trim();
      if (!clean) continue;
      const wf = workflows.find((w) => w.name.toLowerCase() === clean)
        ?? workflows.find((w) => clean.includes(w.name.toLowerCase()));
      if (wf && results.length < limit && !results.some((r) => r.workflowName === wf.name)) {
        results.push({
          matched: true,
          workflowName: wf.name,
          workflowDescription: wf.description,
          stepCount: wf.steps.length,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

function taskHash(task: string): string {
  return createHash("md5").update(task.trim().toLowerCase()).digest("hex").slice(0, 12);
}
