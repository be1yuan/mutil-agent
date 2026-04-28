import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { minimatch } from "minimatch";
import { safeExec, safeResolve } from "../security/safe-exec.js";
import { webSearch, webFetch } from "./web-tools.js";

const SKIP_DIRS = ["node_modules", ".git", "dist", ".claude"];

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir: string
): Promise<string> {
  switch (toolName) {
    case "Read":
      return executeRead(args, workspaceDir);
    case "Write":
      return executeWrite(args, workspaceDir);
    case "Edit":
      return executeEdit(args, workspaceDir);
    case "Bash":
      return executeBash(args, workspaceDir);
    case "Grep":
      return executeGrep(args, workspaceDir);
    case "Glob":
      return executeGlob(args, workspaceDir);
    case "WebSearch":
      return webSearch({ query: String(args.query ?? "") });
    case "WebFetch":
      return webFetch({ url: String(args.url ?? "") });
    default:
      return `[unknown tool] ${toolName}`;
  }
}

// ── Read ──

async function executeRead(
  args: Record<string, unknown>,
  workspaceDir: string
): Promise<string> {
  const filePath = safeResolve(workspaceDir, String(args.filePath));
  try {
    const content = await readFile(filePath, "utf-8");
    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[error] Cannot read ${filePath}: ${msg}`;
  }
}

// ── Write ──

async function executeWrite(
  args: Record<string, unknown>,
  workspaceDir: string
): Promise<string> {
  const filePath = safeResolve(workspaceDir, String(args.filePath));
  const content = String(args.content);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
  return `[written] ${filePath}`;
}

// ── Edit ──

async function executeEdit(
  args: Record<string, unknown>,
  workspaceDir: string
): Promise<string> {
  const filePath = safeResolve(workspaceDir, String(args.filePath));
  const oldStr = String(args.oldString);
  const newStr = String(args.newString);
  const content = await readFile(filePath, "utf-8");

  if (!content.includes(oldStr)) {
    return `[edit error] old string not found in ${filePath}`;
  }

  const firstIndex = content.indexOf(oldStr);
  if (content.indexOf(oldStr, firstIndex + 1) !== -1) {
    return `[edit error] old string matches multiple locations in ${filePath} — provide more surrounding context to make it unique`;
  }

  await writeFile(filePath, content.replace(oldStr, newStr), "utf-8");
  return `[edited] ${filePath}`;
}

// ── Bash ──

async function executeBash(
  args: Record<string, unknown>,
  workspaceDir: string
): Promise<string> {
  const command = String(args.command);
  const cmdArgs = (args.args as string[]) ?? [];
  const cwd = args.cwd
    ? safeResolve(workspaceDir, String(args.cwd))
    : workspaceDir;

  try {
    const result = await safeExec(command, cmdArgs, { cwd, timeout: 30_000 });
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout.trimEnd());
    if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (!result.stdout && !result.stderr) parts.push(`(exit ${result.code})`);
    return parts.join("\n") || `(exit ${result.code})`;
  } catch (err) {
    return `[bash error] ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Grep ──

async function executeGrep(
  args: Record<string, unknown>,
  workspaceDir: string
): Promise<string> {
  const pattern = String(args.pattern);
  const searchPath = safeResolve(workspaceDir, String(args.path));

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch {
    return `[grep error] invalid regex pattern: ${pattern}`;
  }

  const files = await collectFiles(searchPath);
  const results: string[] = [];
  const MAX_RESULTS = 200;

  for (const file of files) {
    try {
      const content = await readFile(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          results.push(
            `${relative(workspaceDir, file)}:${i + 1}: ${lines[i].trim()}`
          );
          if (results.length >= MAX_RESULTS) break;
        }
      }
    } catch {
      // skip binary / unreadable
    }
    if (results.length >= MAX_RESULTS) break;
  }

  return results.length > 0
    ? results.join("\n")
    : `[grep] no matches for "${pattern}" in ${relative(workspaceDir, searchPath) || "."}`;
}

// ── Glob ──

async function executeGlob(
  args: Record<string, unknown>,
  workspaceDir: string
): Promise<string> {
  const pattern = String(args.pattern);
  const basePath = safeResolve(workspaceDir, String(args.path ?? "."));
  const files = await collectFiles(basePath);

  const matches = files
    .map((f) => relative(basePath, f))
    .filter((rel) => minimatch(rel, pattern))
    .sort()
    .slice(0, 200);

  return matches.length > 0
    ? matches.join("\n")
    : `[glob] no files match "${pattern}" in ${relative(workspaceDir, basePath) || "."}`;
}

// ── Helpers ──

async function collectFiles(root: string): Promise<string[]> {
  let s;
  try {
    s = await stat(root);
  } catch {
    return [];
  }
  if (!s.isDirectory()) return [root];

  const result: string[] = [];
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (SKIP_DIRS.some((d) => e.parentPath?.includes(d))) continue;
      result.push(resolve(e.parentPath ?? root, e.name));
    }
  } catch {
    // ignore permission errors
  }
  return result;
}
