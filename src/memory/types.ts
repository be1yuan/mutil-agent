/**
 * Memory system types — Phase 2 of v2.0.
 *
 * Defines the core data structures for short-term session memory,
 * long-term knowledge storage, and shared project context.
 */

// ── Memory entry ──

export interface MemoryEntry {
  id: string;
  type: "fact" | "decision" | "preference" | "summary" | "context";
  content: string;
  source: string;      // agentType that created it
  tags: string[];
  timestamp: number;
  expiresAt?: number;  // short-term entries may have TTL
}

// ── Conversation summary ──

export interface ConversationSummary {
  sessionId: string;
  agentType: string;
  task: string;
  summary: string;          // compressed summary
  keyDecisions: string[];   // key decisions extracted
  tokenCount: number;       // original token count
  timestamp: number;
}

// ── Project context ──

export interface ProjectContext {
  key: string;              // e.g. "architecture", "conventions"
  content: string;
  updatedAt: number;
  updatedBy: string;
}

// ── Config ──

export interface MemoryConfig {
  enabled: boolean;
  dir: string;
  shortTermMaxEntries: number;
  longTermMaxEntries: number;
  summarizationThreshold: number;
  autoSummarize: boolean;
}

// ── Manager interface (for type-safe cross-module usage) ──

export interface MemoryManagerInterface {
  init(): Promise<void>;
  write(entry: Omit<MemoryEntry, "id" | "timestamp"> & { source?: string }): Promise<string>;
  read(id: string): Promise<MemoryEntry | null>;
  search(query: string, tags?: string[], type?: string, limit?: number): Promise<MemoryEntry[]>;
  listKnowledge(): Promise<MemoryEntry[]>;
  clear(): Promise<void>;
}
