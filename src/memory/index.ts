/**
 * Memory system — public API.
 *
 * Central MemoryManager class that coordinates short-term, long-term,
 * and project context stores. The Orchestrator creates and owns this instance.
 */

import crypto from "node:crypto";
import { ensureMemoryDirs } from "./persistence.js";
import { ShortTermMemory } from "./short-term.js";
import { LongTermMemory } from "./long-term.js";
import { ProjectContextStore } from "./project-context.js";
import { Retriever } from "./retriever.js";
import type {
  MemoryEntry,
  ConversationSummary,
  MemoryConfig,
  MemoryManagerInterface,
} from "./types.js";

export class MemoryManager implements MemoryManagerInterface {
  public readonly shortTerm: ShortTermMemory;
  public readonly longTerm: LongTermMemory;
  public readonly projectContext: ProjectContextStore;
  private retriever: Retriever;
  private config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.shortTerm = new ShortTermMemory(
      config.dir,
      config.shortTermMaxEntries,
      config.summarizationThreshold
    );
    this.longTerm = new LongTermMemory(config.dir, config.longTermMaxEntries);
    this.projectContext = new ProjectContextStore(config.dir);
    this.retriever = new Retriever(this.longTerm, this.projectContext);
  }

  async init(): Promise<void> {
    await ensureMemoryDirs(this.config.dir);
  }

  /** Write a new memory entry. Returns the assigned ID. */
  async write(
    entry: Omit<MemoryEntry, "id" | "timestamp"> & { source?: string }
  ): Promise<string> {
    const id = `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const full: MemoryEntry = {
      ...entry,
      id,
      source: entry.source ?? "unknown",
      timestamp: Date.now(),
    };

    if (entry.type === "context") {
      const key = entry.tags[0] ?? "general";
      await this.projectContext.set(key, entry.content, full.source);
    } else {
      await this.longTerm.create(full);
    }
    return id;
  }

  /** Read a single memory entry by ID. Checks long-term first, then project context. */
  async read(id: string): Promise<MemoryEntry | null> {
    const lt = await this.longTerm.get(id);
    if (lt) return lt;
    // Try project context — reconstruct key from ID pattern
    const pcKeys = await this.projectContext.list();
    for (const key of pcKeys) {
      const ctx = await this.projectContext.get(key);
      if (ctx) {
        const ctxId = `ctx_${key}`;
        if (ctxId === id) {
          return {
            id: ctxId,
            type: "context",
            content: ctx.content,
            source: ctx.updatedBy,
            tags: [key],
            timestamp: ctx.updatedAt,
          };
        }
      }
    }
    return null;
  }

  /** Unified search across long-term + project context. */
  async search(
    query: string,
    tags?: string[],
    type?: string,
    limit?: number
  ): Promise<MemoryEntry[]> {
    return this.retriever.search(query, tags, type, limit);
  }

  /** List all long-term knowledge entries. */
  async listKnowledge(): Promise<MemoryEntry[]> {
    return this.longTerm.list();
  }

  /** Delete all knowledge entries. */
  async clear(): Promise<void> {
    await this.longTerm.clear();
  }

  /** Generate and store a conversation summary for a session. */
  async summarize(
    sessionId: string,
    task: string,
    agentType: string,
    history: unknown[],
    summaryText: string,
    keyDecisions: string[],
    tokenCount: number
  ): Promise<ConversationSummary> {
    const summary: ConversationSummary = {
      sessionId,
      agentType,
      task,
      summary: summaryText,
      keyDecisions,
      tokenCount,
      timestamp: Date.now(),
    };
    await this.shortTerm.storeSummary(sessionId, summary);
    return summary;
  }
}

// Re-export sub-modules and types
export { ShortTermMemory } from "./short-term.js";
export { LongTermMemory } from "./long-term.js";
export { ProjectContextStore } from "./project-context.js";
export { Retriever } from "./retriever.js";
export type {
  MemoryEntry,
  ConversationSummary,
  ProjectContext,
  MemoryConfig,
  MemoryManagerInterface,
} from "./types.js";
