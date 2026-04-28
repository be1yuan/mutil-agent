import { spawn } from "node:child_process";

// ── Safe execution ──

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  constructor(
    message: string,
    public readonly result: ExecResult
  ) {
    super(message);
    this.name = "ExecError";
  }
}

/**
 * Execute a command safely using spawn with argument array.
 * Never use shell: true to prevent command injection.
 */
export function safeExec(
  command: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  // Validate all arguments are strings
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new TypeError(`All arguments must be strings, got: ${typeof arg}`);
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 30_000,
      shell: false, // Never use shell
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

// ── Path safety ──

import path from "node:path";

/**
 * Resolve a path safely within a base directory.
 * Throws if the resolved path escapes the base directory.
 *
 * Handles common Agent path patterns:
 * - "README.md"            → relative to basePath
 * - "/README.md"           → treated as relative to basePath (agent convention)
 * - "src/agent/tools.ts"   → relative to basePath
 * - "D:\web\...\README.md" → absolute path, allowed only if within basePath
 */
export function safeResolve(basePath: string, targetPath: string): string {
  // Normalize: strip leading "/" — agents use "/file" to mean "workspace root / file"
  let normalized = targetPath;
  if (normalized.startsWith("/") && !normalized.match(/^[\/\\][a-zA-Z]:/)) {
    normalized = normalized.slice(1);
  }

  const resolved = path.resolve(basePath, normalized);
  const rel = path.relative(basePath, resolved);

  // On Windows, different drive letters produce absolute relative paths
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${targetPath}`);
  }

  return resolved;
}

/**
 * Validate a slug string (alphanumeric, hyphen, underscore only).
 */
export function validateSlug(slug: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(`Invalid slug format: ${slug}`);
  }
  if (slug.length > 64) {
    throw new Error(`Slug too long (max 64 chars): ${slug}`);
  }
  return slug;
}
