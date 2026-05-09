/**
 * LongTermMemory — persistent knowledge storage with tag indexing.
 *
 * Stores entries as individual JSON files in .memory/knowledge/.
 * Maintains a tag→entry ID index in .memory/index.json for fast lookup.
 * Each tag is stored in its own file under .memory/tags/ to avoid
 * read-modify-write races between concurrent writers.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { atomicWrite, atomicRead, validatePathSegment } from "./persistence.js";
import type { MemoryEntry } from "./types.js";

type TagIndex = Record<string, string[]>;

export class LongTermMemory {
  private indexPath: string;

  constructor(
    private memoryDir: string,
    private maxEntries: number
  ) {
    this.indexPath = path.join(memoryDir, "index.json");
  }

  /** Create a new memory entry and update the tag index. */
  async create(entry: MemoryEntry): Promise<void> {
    validatePathSegment(entry.id);
    // Write entry file
    const entryPath = path.join(this.memoryDir, "knowledge", `${entry.id}.json`);
    await atomicWrite(entryPath, JSON.stringify(entry, null, 2));

    // Update tag index — rebuild from full index to avoid races
    await this.addToIndex(entry);

    // Evict oldest if over max (batch delete to avoid N× index rewrites)
    await this.enforceMax();
  }

  /** Read an entry by ID. */
  async get(id: string): Promise<MemoryEntry | null> {
    validatePathSegment(id);
    const entryPath = path.join(this.memoryDir, "knowledge", `${id}.json`);
    return atomicRead<MemoryEntry>(entryPath);
  }

  /** Update partial fields on an existing entry. */
  async update(id: string, partial: Partial<MemoryEntry>): Promise<void> {
    validatePathSegment(id);
    const existing = await this.get(id);
    if (!existing) return;
    const merged: MemoryEntry = { ...existing, ...partial, id };
    const entryPath = path.join(this.memoryDir, "knowledge", `${id}.json`);
    await atomicWrite(entryPath, JSON.stringify(merged, null, 2));
    // Rebuild index entries for this entry's tags
    const index = (await atomicRead<TagIndex>(this.indexPath)) ?? {};
    for (const tag of existing.tags) {
      if (index[tag]) {
        index[tag] = index[tag].filter((i) => i !== id);
        if (index[tag].length === 0) delete index[tag];
      }
    }
    for (const tag of merged.tags) {
      if (!index[tag]) index[tag] = [];
      if (!index[tag].includes(id)) index[tag].push(id);
    }
    await atomicWrite(this.indexPath, JSON.stringify(index));
  }

  /** Delete an entry and remove from tag index. */
  async delete(id: string): Promise<void> {
    validatePathSegment(id);
    const entryPath = path.join(this.memoryDir, "knowledge", `${id}.json`);
    try { await fs.unlink(entryPath); } catch { /* ok if not found */ }

    const index = (await atomicRead<TagIndex>(this.indexPath)) ?? {};
    for (const [tag, ids] of Object.entries(index)) {
      index[tag] = ids.filter((i) => i !== id);
      if (index[tag].length === 0) delete index[tag];
    }
    await atomicWrite(this.indexPath, JSON.stringify(index));
  }

  /** Search entries by keyword and tags. */
  async search(query: string, tags?: string[]): Promise<MemoryEntry[]> {
    const lower = query.toLowerCase();
    const index = (await atomicRead<TagIndex>(this.indexPath)) ?? {};

    // Determine candidate IDs
    let candidateIds: string[] | undefined;
    if (tags && tags.length > 0) {
      candidateIds = [];
      for (const tag of tags) {
        const tagLower = tag.toLowerCase();
        for (const [idxTag, ids] of Object.entries(index)) {
          if (idxTag.toLowerCase().includes(tagLower)) {
            for (const id of ids) {
              if (!candidateIds.includes(id)) candidateIds.push(id);
            }
          }
        }
      }
    }

    // Read entries
    const entries: MemoryEntry[] = [];
    if (candidateIds) {
      for (const id of candidateIds) {
        const entry = await this.get(id);
        if (entry) entries.push(entry);
      }
    } else {
      entries.push(...(await this.list()));
    }

    // Keyword filter
    if (lower) {
      return entries.filter(
        (e) =>
          e.content.toLowerCase().includes(lower) ||
          e.tags.some((t) => t.toLowerCase().includes(lower))
      );
    }
    return entries;
  }

  /** List all knowledge entries. */
  async list(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    const knowledgeDir = path.join(this.memoryDir, "knowledge");
    try {
      const dirents = await fs.readdir(knowledgeDir);
      for (const dirent of dirents) {
        if (!dirent.endsWith(".json")) continue;
        const entry = await atomicRead<MemoryEntry>(path.join(knowledgeDir, dirent));
        if (entry) entries.push(entry);
      }
    } catch {
      // dir doesn't exist yet
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries;
  }

  /** Delete all knowledge entries and index. */
  async clear(): Promise<void> {
    const knowledgeDir = path.join(this.memoryDir, "knowledge");
    try {
      const dirents = await fs.readdir(knowledgeDir);
      for (const dirent of dirents) {
        if (dirent.endsWith(".json")) {
          await fs.unlink(path.join(knowledgeDir, dirent));
        }
      }
    } catch { /* ok */ }
    await atomicWrite(this.indexPath, JSON.stringify({}));
  }

  /** Add entry to tag index. */
  private async addToIndex(entry: MemoryEntry): Promise<void> {
    const index = (await atomicRead<TagIndex>(this.indexPath)) ?? {};
    for (const tag of entry.tags) {
      if (!index[tag]) index[tag] = [];
      if (!index[tag].includes(entry.id)) {
        index[tag].push(entry.id);
      }
    }
    await atomicWrite(this.indexPath, JSON.stringify(index));
  }

  /** Evict oldest entries if count exceeds maxEntries. Batch delete to avoid N× index rewrites. */
  private async enforceMax(): Promise<void> {
    const all = await this.list();
    if (all.length <= this.maxEntries) return;
    const toDelete = all.slice(this.maxEntries);
    // Batch delete: remove files first, then rebuild index once
    const deleteIds = new Set(toDelete.map((e) => e.id));
    for (const id of deleteIds) {
      try { await fs.unlink(path.join(this.memoryDir, "knowledge", `${id}.json`)); } catch { /* ok */ }
    }
    // Rebuild index from remaining entries
    const remaining = all.filter((e) => !deleteIds.has(e.id));
    const index: TagIndex = {};
    for (const entry of remaining) {
      for (const tag of entry.tags) {
        if (!index[tag]) index[tag] = [];
        index[tag].push(entry.id);
      }
    }
    await atomicWrite(this.indexPath, JSON.stringify(index));
  }
}
