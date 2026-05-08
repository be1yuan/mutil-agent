import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkflowStateStore } from "./state-store.js";

describe("WorkflowStateStore", () => {
  let tmpDir: string;
  let store: WorkflowStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-state-test-"));
    store = new WorkflowStateStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a run and loads it back", async () => {
    const run = await store.createRun("test-workflow", { key: "value" }, ["s1", "s2"]);

    expect(run.id).toMatch(/^run_/);
    expect(run.workflowName).toBe("test-workflow");
    expect(run.status).toBe("running");
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0].status).toBe("pending");
    expect(run.steps[1].status).toBe("pending");
    expect(run.variables).toEqual({ key: "value" });
    expect(run.totalCost).toBe(0);

    const loaded = await store.load(run.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(run.id);
    expect(loaded!.workflowName).toBe("test-workflow");
  });

  it("returns null for non-existent run", async () => {
    const loaded = await store.load("non-existent-id");
    expect(loaded).toBeNull();
  });

  it("updates a step result", async () => {
    const run = await store.createRun("test", {}, ["s1", "s2"]);

    const updated = await store.updateStep(run.id, "s1", {
      status: "completed",
      result: { status: "success", content: "done", steps: 3, cost: 0.5 },
      startedAt: Date.now(),
      completedAt: Date.now(),
    });

    expect(updated).not.toBeNull();
    expect(updated!.steps[0].status).toBe("completed");
    expect(updated!.steps[0].result?.content).toBe("done");
    expect(updated!.steps[1].status).toBe("pending"); // unchanged
  });

  it("persists updates to disk", async () => {
    const run = await store.createRun("test", {}, ["s1"]);
    await store.updateStep(run.id, "s1", { status: "completed" });

    // Create a new store instance to verify persistence
    const store2 = new WorkflowStateStore(tmpDir);
    const loaded = await store2.load(run.id);
    expect(loaded!.steps[0].status).toBe("completed");
  });

  it("finalizes a run", async () => {
    const run = await store.createRun("test", {}, ["s1"]);
    const finalized = await store.finalize(run.id, "completed", 1.5);

    expect(finalized).not.toBeNull();
    expect(finalized!.status).toBe("completed");
    expect(finalized!.totalCost).toBe(1.5);
    expect(finalized!.completedAt).toBeDefined();
  });

  it("lists runs in reverse chronological order", async () => {
    const run1 = await store.createRun("wf1", {}, ["s1"]);
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    const run2 = await store.createRun("wf2", {}, ["s1"]);

    const runs = await store.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(run2.id); // most recent first
    expect(runs[1].id).toBe(run1.id);
  });

  it("returns empty array when no runs exist", async () => {
    const runs = await store.listRuns();
    expect(runs).toEqual([]);
  });

  it("generates unique run ids", async () => {
    const id1 = store.generateRunId();
    const id2 = store.generateRunId();
    expect(id1).not.toBe(id2);
  });

  it("updateStep returns null for non-existent run", async () => {
    const result = await store.updateStep("non-existent", "s1", { status: "completed" });
    expect(result).toBeNull();
  });

  it("updateStep returns null for non-existent step", async () => {
    const run = await store.createRun("test", {}, ["s1"]);
    const result = await store.updateStep(run.id, "nonexistent", { status: "completed" });
    expect(result).toBeNull();
  });
});
