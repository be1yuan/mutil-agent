/**
 * Shared persistence utilities for the memory system.
 *
 * Atomic write pattern (temp+rename) adapted from Mailbox for crash-safe single-file writes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Atomic write: write to temp file then rename. No partial writes visible to readers. */
export async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.tmp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);
  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    try { await fs.unlink(tempPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** Read and parse a JSON file. Returns null if file does not exist or is malformed. */
export async function atomicRead<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Read a plain text file. Returns null if file does not exist. */
export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Validate that a key/id is safe for use in a filesystem path. */
export function validatePathSegment(segment: string): void {
  if (segment.includes("..") || segment.includes("/") || segment.includes("\\")) {
    throw new Error(`Invalid path segment: "${segment}"`);
  }
}

/** Ensure the .memory/ directory tree exists and clean up stale temp files. */
export async function ensureMemoryDirs(memoryDir: string): Promise<void> {
  await fs.mkdir(path.join(memoryDir, "knowledge"), { recursive: true });
  await fs.mkdir(path.join(memoryDir, "context"), { recursive: true });
  await fs.mkdir(path.join(memoryDir, "sessions"), { recursive: true });

  // Clean up stale temp files from crashed atomicWrite calls
  for (const subdir of ["knowledge", "context", "sessions"]) {
    try {
      const dir = path.join(memoryDir, subdir);
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (entry.startsWith(".tmp_")) {
          try { await fs.unlink(path.join(dir, entry)); } catch { /* best-effort */ }
        }
      }
    } catch { /* dir may not exist yet */ }
  }
}
