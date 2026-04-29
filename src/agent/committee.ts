/**
 * Committee mode — multiple agents execute the same task in parallel,
 * then a verdict is reached through voting or aggregation.
 *
 * Usage:
 *   const committee = new Committee(deps);
 *   const result = await committee.run(task, agentTypes, budget);
 *
 * Aggregation strategies:
 * - "majority"  — pick the most common status/sentiment
 * - "concat"    — concatenate all results (default, useful for diverse perspectives)
 * - "best"      — pick the result with the most detail (by output length)
 */

import { AgentLoop, type AgentLoopDeps } from "./agent-loop.js";
import type { AgentResult } from "../types/core.js";
import { getLogger } from "../observability/logger.js";

/** ANSI colors for distinguishing committee members */
const MEMBER_COLORS = [
  (s: string) => `\x1b[36m${s}\x1b[0m`, // cyan
  (s: string) => `\x1b[33m${s}\x1b[0m`, // yellow
  (s: string) => `\x1b[35m${s}\x1b[0m`, // magenta
  (s: string) => `\x1b[32m${s}\x1b[0m`, // green
  (s: string) => `\x1b[34m${s}\x1b[0m`, // blue
];

// ── Types ──

export type AggregationStrategy = "majority" | "concat" | "best";

export interface CommitteeConfig {
  /** Agent types to run in parallel */
  agentTypes: string[];
  /** How to combine results */
  strategy?: AggregationStrategy;
  /** Maximum number of agents to run concurrently (default: agentTypes.length) */
  maxConcurrency?: number;
}

export interface CommitteeMemberResult {
  agentType: string;
  result: AgentResult;
}

export interface CommitteeResult {
  status: "success" | "error" | "partial";
  /** Aggregated content from all members */
  content?: string;
  /** Individual member results */
  members: CommitteeMemberResult[];
  /** Which strategy was used */
  strategy: AggregationStrategy;
  /** Total cost across all members */
  totalCost: number;
  /** Total steps across all members */
  totalSteps: number;
}

// ── Committee runner ──

export class Committee {
  constructor(private deps: AgentLoopDeps) {}

  async run(
    task: string,
    config: CommitteeConfig,
    budget: number
  ): Promise<CommitteeResult> {
    const logger = getLogger();
    const strategy = config.strategy ?? "concat";
    const memberResults: CommitteeMemberResult[] = [];

    logger.info("committee.started", {
      agents: config.agentTypes,
      strategy,
    });

    // Run agents in parallel with concurrency control
    const maxConcurrent = config.maxConcurrency ?? config.agentTypes.length;
    const semaphore = new Semaphore(maxConcurrent);

    const promises = config.agentTypes.map(async (agentType, index) => {
      const release = await semaphore.acquire();
      try {
        const definition = this.deps.loadAgentDefinition(agentType);

        // Each member gets a color prefix via getStreamPrefix callback
        const color = MEMBER_COLORS[index % MEMBER_COLORS.length];
        const memberDeps: AgentLoopDeps = {
          ...this.deps,
          getStreamPrefix: (type: string) => color(`[${type}] `),
        };

        // Each agent gets the full remaining budget — they share the same
        // CostTracker instance, so the first to exceed stops the rest.
        // This avoids the "small per-agent budget" problem where one
        // agent needs more than budget/n.
        const loop = new AgentLoop(memberDeps);
        const result = await loop.run(task, definition, this.deps.costTracker.remaining);

        return { agentType, result };
      } catch (err) {
        // Re-throw with agentType attached for logging
        throw Object.assign(new Error(String(err)), { agentType });
      } finally {
        release();
      }
    });

    // Wait for all agents to complete
    const settled = await Promise.allSettled(promises);

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        memberResults.push(outcome.value);
      } else {
        logger.warn("committee.member_failed", {
          agentType: (outcome.reason as { agentType?: string })?.agentType ?? "unknown",
          error: outcome.reason?.message ?? String(outcome.reason),
        });
      }
    }

    // Aggregate results
    const aggregated = this.aggregate(memberResults, strategy);
    const totalCost = memberResults.reduce((s, m) => s + m.result.cost, 0);
    const totalSteps = memberResults.reduce((s, m) => s + m.result.steps, 0);

    logger.info("committee.completed", {
      members: memberResults.length,
      strategy,
      totalCost,
      totalSteps,
    });

    return {
      ...aggregated,
      members: memberResults,
      strategy,
      totalCost,
      totalSteps,
    };
  }

  private aggregate(
    results: CommitteeMemberResult[],
    strategy: AggregationStrategy
  ): { status: CommitteeResult["status"]; content?: string } {
    if (results.length === 0) {
      return { status: "error" };
    }

    // If only one member, return its result directly
    if (results.length === 1) {
      return {
        status: results[0].result.status === "success" ? "success" : "error",
        content: results[0].result.content,
      };
    }

    const successes = results.filter((m) => m.result.status === "success");
    const hasPartial = successes.length > 0 && successes.length < results.length;

    switch (strategy) {
      case "majority": {
        // Pick the most common status
        const statusCounts = new Map<string, number>();
        for (const m of results) {
          statusCounts.set(m.result.status, (statusCounts.get(m.result.status) ?? 0) + 1);
        }
        let majorityStatus = "";
        let majorityCount = 0;
        for (const [status, count] of statusCounts) {
          if (count > majorityCount) {
            majorityCount = count;
            majorityStatus = status;
          }
        }
        // Use content from the first successful member
        const content = successes[0]?.result.content ?? results[0].result.content;
        return {
          status: majorityStatus === "success" ? "success" : hasPartial ? "partial" : "error",
          content,
        };
      }

      case "best": {
        // Pick the result with the longest content
        const sorted = [...successes].sort(
          (a, b) => (b.result.content?.length ?? 0) - (a.result.content?.length ?? 0)
        );
        const best = sorted[0];
        return {
          status: best ? "success" : "error",
          content: best?.result.content,
        };
      }

      case "concat":
      default: {
        // Concatenate all successful results with headers
        const parts = successes.map((m) => {
          const header = `[${m.agentType}]`;
          const content = m.result.content ?? "(no output)";
          return `${header}\n${content}`;
        });
        return {
          status: hasPartial ? "partial" : successes.length === results.length ? "success" : "error",
          content: parts.length > 0 ? parts.join("\n\n---\n\n") : undefined,
        };
      }
    }
  }
}

// ── Simple semaphore for concurrency ──

class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(private maxPermits: number) {
    this.permits = maxPermits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.permits++;
    }
  }
}
