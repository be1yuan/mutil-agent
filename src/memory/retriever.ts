/**
 * Retriever — unified cross-type memory search with relevance ranking.
 *
 * Searches across long-term knowledge and project context.
 * Results are ranked by: exact content match > tag match > time decay.
 */

import type { MemoryEntry } from "./types.js";
import type { LongTermMemory } from "./long-term.js";
import type { ProjectContextStore } from "./project-context.js";

export class Retriever {
  constructor(
    private longTerm: LongTermMemory,
    private projectContext: ProjectContextStore
  ) {}

  /** Cross-type unified search. */
  async search(
    query: string,
    tags?: string[],
    type?: string,
    limit = 10
  ): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];

    // Search long-term
    const longResults = await this.longTerm.search(query, tags);
    results.push(...longResults.filter((e) => !type || e.type === type));

    // Search project context
    const contextKeys = await this.projectContext.list();
    for (const key of contextKeys) {
      const ctx = await this.projectContext.get(key);
      if (ctx) {
        const ctxLower = ctx.content.toLowerCase();
        const qLower = query.toLowerCase();
        if (ctxLower.includes(qLower) || key.toLowerCase().includes(qLower)) {
          results.push({
            id: `ctx_${key}`,
            type: "context",
            content: ctx.content.slice(0, 500),
            source: ctx.updatedBy,
            tags: ["context", key],
            timestamp: ctx.updatedAt,
          });
        }
      }
    }

    return this.rankResults(results, query).slice(0, limit);
  }

  private rankResults(results: MemoryEntry[], query: string): MemoryEntry[] {
    const q = query.toLowerCase();
    const now = Date.now();
    const scored = results.map((e) => {
      let score = 0;

      // Exact content match
      if (e.content.toLowerCase().includes(q)) score += 3;

      // Tag match
      if (e.tags.some((t) => t.toLowerCase().includes(q))) score += 2;

      // Time decay: newer entries weighted higher (1 day half-life)
      const ageDays = (now - e.timestamp) / 86400000;
      score += Math.max(0, 1 - ageDays);

      return { entry: e, score };
    });

    return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
  }
}
