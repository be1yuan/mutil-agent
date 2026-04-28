import { describe, it, expect } from "vitest";
import { resolveIsolation } from "./worktree-manager.js";

// ── WorktreeManager Tests ──

describe("WorktreeManager", () => {
  describe("resolveIsolation", () => {
    it("returns 'context' when no isolation requested", async () => {
      const result = await resolveIsolation("/some/dir");
      expect(result).toBe("context");
    });

    it("returns 'context' when isolation is 'context'", async () => {
      const result = await resolveIsolation("/some/dir", "context");
      expect(result).toBe("context");
    });

    it("returns 'context' when worktree requested but not a git repo", async () => {
      // /nonexistent is definitely not a git repo
      const result = await resolveIsolation("/nonexistent/path", "worktree");
      expect(result).toBe("context");
    });

    it("returns 'worktree' when worktree requested and in a git repo", async () => {
      // This test assumes the project itself is a git repo
      const result = await resolveIsolation(process.cwd(), "worktree");
      expect(result).toBe("worktree");
    });
  });
});
