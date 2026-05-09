/**
 * ProjectContextStore — shared project knowledge files.
 *
 * Stores persistent markdown documents under .memory/context/{key}.md
 * for architecture conventions, coding standards, and other project-level knowledge.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { atomicWrite, atomicRead, readTextFile, validatePathSegment } from "./persistence.js";
import type { ProjectContext } from "./types.js";

interface ContextMeta {
  key: string;
  updatedAt: number;
  updatedBy: string;
}

export class ProjectContextStore {
  constructor(private memoryDir: string) {}

  /** Read a context document by key. Returns null if not found. */
  async get(key: string): Promise<ProjectContext | null> {
    validatePathSegment(key);
    const contentPath = this.filePath(key);
    const metaPath = this.metaPath(key);
    const content = await readTextFile(contentPath);
    if (content === null) return null;
    const meta = await atomicRead<ContextMeta>(metaPath);
    return {
      key,
      content,
      updatedAt: meta?.updatedAt ?? 0,
      updatedBy: meta?.updatedBy ?? "unknown",
    };
  }

  /** Write a context document. */
  async set(key: string, content: string, updatedBy: string): Promise<void> {
    validatePathSegment(key);
    const now = Date.now();
    await atomicWrite(this.filePath(key), content);
    await atomicWrite(this.metaPath(key), JSON.stringify({ key, updatedAt: now, updatedBy }));
  }

  /** Delete a context document. */
  async delete(key: string): Promise<void> {
    validatePathSegment(key);
    try { await fs.unlink(this.filePath(key)); } catch { /* ok */ }
    try { await fs.unlink(this.metaPath(key)); } catch { /* ok */ }
  }

  /** List all context keys. */
  async list(): Promise<string[]> {
    const contextDir = path.join(this.memoryDir, "context");
    try {
      const entries = await fs.readdir(contextDir);
      return entries
        .filter((e) => e.endsWith(".md"))
        .map((e) => e.replace(/\.md$/, ""));
    } catch {
      return [];
    }
  }

  private filePath(key: string): string {
    return path.join(this.memoryDir, "context", `${key}.md`);
  }

  private metaPath(key: string): string {
    return path.join(this.memoryDir, "context", `${key}.meta.json`);
  }
}
