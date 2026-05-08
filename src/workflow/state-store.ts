/**
 * Workflow state store — file-based persistence for WorkflowRun state.
 *
 * Uses atomic writes (writeFile to temp + rename) for crash safety.
 * State files are stored in .workflow-state/{runId}.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { WorkflowRun, StepResult } from "./types.js";

export class WorkflowStateStore {
  constructor(private stateDir: string) {}

  /** Ensure the state directory exists */
  async init(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
  }

  /** Generate a unique run id */
  generateRunId(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const rand = crypto.randomBytes(4).toString("hex");
    return `run_${ts}_${rand}`;
  }

  /** Create a new WorkflowRun and persist it */
  async createRun(
    workflowName: string,
    variables: Record<string, string>,
    stepIds: string[]
  ): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: this.generateRunId(),
      workflowName,
      status: "running",
      steps: stepIds.map((stepId) => ({
        stepId,
        status: "pending" as const,
      })),
      variables,
      startedAt: Date.now(),
      totalCost: 0,
    };

    await this.save(run);
    return run;
  }

  /** Load a WorkflowRun by id */
  async load(runId: string): Promise<WorkflowRun | null> {
    const filePath = this.filePath(runId);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as WorkflowRun;
    } catch {
      return null;
    }
  }

  /** Save a WorkflowRun (atomic write) */
  async save(run: WorkflowRun): Promise<void> {
    const filePath = this.filePath(run.id);
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(run, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  /** Update a specific step result and persist */
  async updateStep(
    runId: string,
    stepId: string,
    update: Partial<StepResult>
  ): Promise<WorkflowRun | null> {
    const run = await this.load(runId);
    if (!run) return null;

    const stepIndex = run.steps.findIndex((s) => s.stepId === stepId);
    if (stepIndex === -1) return null;

    run.steps[stepIndex] = { ...run.steps[stepIndex], ...update };
    await this.save(run);
    return run;
  }

  /** Mark the workflow run as completed/failed/cancelled */
  async finalize(
    runId: string,
    status: WorkflowRun["status"],
    totalCost?: number
  ): Promise<WorkflowRun | null> {
    const run = await this.load(runId);
    if (!run) return null;

    run.status = status;
    run.completedAt = Date.now();
    if (totalCost !== undefined) {
      run.totalCost = totalCost;
    }
    await this.save(run);
    return run;
  }

  /** List all workflow runs (most recent first) */
  async listRuns(): Promise<WorkflowRun[]> {
    try {
      const entries = await fs.readdir(this.stateDir);
      const runs: WorkflowRun[] = [];

      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
        const runId = entry.replace(/\.json$/, "");
        const run = await this.load(runId);
        if (run) runs.push(run);
      }

      runs.sort((a, b) => b.startedAt - a.startedAt);
      return runs;
    } catch {
      return [];
    }
  }

  private filePath(runId: string): string {
    return path.join(this.stateDir, `${runId}.json`);
  }
}
