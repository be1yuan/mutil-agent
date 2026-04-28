/**
 * Git worktree manager for sub-agent isolation.
 *
 * When an AgentDefinition specifies isolation: "worktree", the sub-agent
 * works in a separate git worktree instead of the main working directory.
 * This prevents file conflicts between parallel agents.
 *
 * Lifecycle:
 * 1. acquire() — creates a new worktree from HEAD
 * 2. sub-agent runs with worktreeDir as workspaceDir
 * 3. release() — removes the worktree
 *
 * Safety: process exit hooks are registered to clean up worktrees
 * even if the process is killed (SIGINT/SIGTERM/exit).
 */

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getLogger } from "../observability/logger.js";

// Track active worktrees for cleanup on process exit
const activeWorktrees: Set<string> = new Set();
let exitHandlerRegistered = false;

/**
 * Register a process exit handler that prunes all active worktrees.
 * Called once on first worktree acquisition.
 */
function ensureExitHandler(mainDir: string): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  const cleanup = () => {
    for (const worktreeDir of activeWorktrees) {
      try {
        // Synchronous fallback — best effort
        execFile("git", ["worktree", "remove", "--force", worktreeDir], {
          cwd: mainDir,
          timeout: 5_000,
        }, () => {}); // fire-and-forget
      } catch {
        // Best effort
      }
    }
    activeWorktrees.clear();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

export interface WorktreeHandle {
  /** Absolute path to the worktree directory */
  worktreeDir: string;
  /** Cleanup function — removes the worktree */
  cleanup: () => Promise<void>;
}

/**
 * Check if a directory is inside a git repository.
 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await gitExec(dir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a git command and return stdout.
 */
function gitExec(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Create a temporary directory for worktrees.
 * Uses .git/orchestrator-worktrees/ inside the repo.
 */
async function getWorktreeBaseDir(repoDir: string): Promise<string> {
  const gitDir = await gitExec(repoDir, ["rev-parse", "--git-dir"]);
  const absGitDir = resolve(repoDir, gitDir);
  const worktreeBase = join(absGitDir, "orchestrator-worktrees");
  await mkdir(worktreeBase, { recursive: true });
  return worktreeBase;
}

/**
 * Generate a unique worktree directory name.
 */
function worktreeName(agentType: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${agentType}-${ts}-${rand}`;
}

/**
 * Acquire a git worktree for a sub-agent.
 *
 * @param mainDir - The main working directory (must be inside a git repo)
 * @param agentType - The agent type (used for naming the worktree)
 * @returns A WorktreeHandle with the worktree directory and cleanup function
 */
export async function acquireWorktree(
  mainDir: string,
  agentType: string
): Promise<WorktreeHandle> {
  const logger = getLogger();

  if (!(await isGitRepo(mainDir))) {
    throw new Error(`Not a git repository: ${mainDir}`);
  }

  const baseDir = await getWorktreeBaseDir(mainDir);
  const name = worktreeName(agentType);
  const worktreeDir = join(baseDir, name);

  // Create worktree from HEAD (detached HEAD)
  await gitExec(mainDir, ["worktree", "add", "--detach", worktreeDir, "HEAD"]);

  // Register for process-exit cleanup
  activeWorktrees.add(worktreeDir);
  ensureExitHandler(mainDir);

  logger.info("worktree.acquired", { agentType, worktreeDir });

  const cleanup = async () => {
    activeWorktrees.delete(worktreeDir);
    try {
      await gitExec(mainDir, ["worktree", "remove", "--force", worktreeDir]);
      logger.info("worktree.released", { agentType, worktreeDir });
    } catch (err) {
      // Force-remove the directory if git worktree remove fails
      try {
        await rm(worktreeDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
      logger.warn("worktree.cleanup_force", { agentType, worktreeDir, error: String(err) });
    }
  };

  return { worktreeDir, cleanup };
}

/**
 * Check if worktree isolation is available (git repo check).
 * Returns the effective isolation mode: "worktree" if possible, "context" otherwise.
 */
export async function resolveIsolation(
  mainDir: string,
  requested?: "context" | "worktree"
): Promise<"context" | "worktree"> {
  if (requested !== "worktree") return "context";
  if (await isGitRepo(mainDir)) return "worktree";
  return "context"; // fallback if not a git repo
}

/**
 * Prune stale worktrees left behind by previous runs.
 * Safe to call at startup — only removes worktrees that are
 * no longer referenced by any working directory.
 */
export async function pruneStaleWorktrees(mainDir: string): Promise<void> {
  const logger = getLogger();
  try {
    if (!(await isGitRepo(mainDir))) return;
    await gitExec(mainDir, ["worktree", "prune"]);
    logger.info("worktree.pruned", { dir: mainDir });
  } catch (err) {
    // Non-critical — just log and continue
    logger.warn("worktree.prune_failed", {
      dir: mainDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
