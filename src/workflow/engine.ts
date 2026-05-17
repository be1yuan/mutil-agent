/**
 * WorkflowEngine -- executes a workflow definition step by step.
 *
 * Supports:
 * - Sequential step execution
 * - Agent steps (delegate to AgentLoop)
 * - Committee steps (parallel multi-agent)
 * - Checkpoint steps (pause for approval)
 * - Conditional branching (on.condition -> then/else)
 * - State persistence (crash-safe resume)
 * - Variable interpolation via template-resolver
 */

import { AgentLoop, type AgentLoopDeps } from "../agent/agent-loop.js";
import { Committee, type CommitteeConfig } from "../agent/committee.js";
import { Debate } from "../agent/collaboration/debate.js";
import { ReviewChain } from "../agent/collaboration/review-chain.js";
import type { AgentResult, ModelProvider } from "../types/core.js";
import { getLogger } from "../observability/logger.js";
import { resolveTemplate } from "./template-resolver.js";
import { WorkflowStateStore } from "./state-store.js";
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowCondition,
  WorkflowRun,
  StepResult,
  StepStatus,
} from "./types.js";

// -- Public interface --

export interface WorkflowEngineDeps {
  agentLoopDeps: AgentLoopDeps;
  stateStore: WorkflowStateStore;
  /** Called when a checkpoint is reached and needs approval. Returns true to continue, false to cancel. */
  onCheckpoint?: (stepId: string, message: string) => Promise<boolean>;
  /** Called after each step completes (for progress reporting) */
  onStepComplete?: (stepId: string, status: StepStatus, result?: AgentResult) => void;
  /** Called when the workflow status changes */
  onWorkflowStatusChange?: (status: WorkflowRun["status"], run: WorkflowRun) => void;
}

export class WorkflowEngine {
  constructor(private deps: WorkflowEngineDeps) {}

  /**
   * Execute a workflow from scratch.
   * Returns the final WorkflowRun state.
   */
  async run(
    definition: WorkflowDefinition,
    budget: number,
    initialVariables?: Record<string, string>
  ): Promise<WorkflowRun> {
    const logger = getLogger();
    const variables = { ...definition.variables, ...initialVariables };
    const stepIds = definition.steps.map((s) => s.id);

    // Create run state
    const run = await this.deps.stateStore.createRun(
      definition.name,
      variables,
      stepIds
    );

    logger.info("workflow.started", {
      runId: run.id,
      workflow: definition.name,
      steps: stepIds.length,
    });

    this.deps.onWorkflowStatusChange?.("running", run);

    try {
      await this.executeSteps(definition, run, budget);
    } catch (err) {
      logger.error("workflow.failed", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.deps.stateStore.finalize(run.id, "failed", run.totalCost);
      run.status = "failed";
      run.completedAt = Date.now();
      this.deps.onWorkflowStatusChange?.("failed", run);
      return run;
    }

    // If not paused by a checkpoint, finalize as completed
    if (run.status !== "paused") {
      await this.deps.stateStore.finalize(run.id, "completed", run.totalCost);
      run.status = "completed";
      run.completedAt = Date.now();
      this.deps.onWorkflowStatusChange?.("completed", run);
    }

    return run;
  }

  /**
   * Resume a paused workflow (from a checkpoint).
   * Requires the workflow definition to be provided -- use resumeWithDefinition().
   */
  async resume(runId: string, budget: number): Promise<WorkflowRun> {
    throw new Error(
      `Cannot resume workflow "${runId}" without definition. Use resumeWithDefinition() instead.`
    );
  }

  /**
   * Execute a workflow using a pre-created run (for API use).
   * The run must already exist in "running" status with steps initialized.
   */
  async runWithExisting(
    runId: string,
    definition: WorkflowDefinition,
    budget: number
  ): Promise<WorkflowRun> {
    const logger = getLogger();
    const run = await this.deps.stateStore.load(runId);

    if (!run) {
      throw new Error(`Workflow run "${runId}" not found`);
    }

    logger.info("workflow.started", {
      runId: run.id,
      workflow: definition.name,
      steps: definition.steps.length,
    });

    this.deps.onWorkflowStatusChange?.("running", run);

    try {
      await this.executeSteps(definition, run, budget);
    } catch (err) {
      logger.error("workflow.failed", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.deps.stateStore.finalize(run.id, "failed", run.totalCost);
      run.status = "failed";
      run.completedAt = Date.now();
      this.deps.onWorkflowStatusChange?.("failed", run);
      return run;
    }

    if (run.status !== "paused") {
      await this.deps.stateStore.finalize(run.id, "completed", run.totalCost);
      run.status = "completed";
      run.completedAt = Date.now();
      this.deps.onWorkflowStatusChange?.("completed", run);
    }

    return run;
  }

  /**
   * Resume a paused workflow with the original definition provided.
   */
  async resumeWithDefinition(
    runId: string,
    definition: WorkflowDefinition,
    budget: number
  ): Promise<WorkflowRun> {
    const logger = getLogger();
    const run = await this.deps.stateStore.load(runId);

    if (!run) {
      throw new Error(`Workflow run "${runId}" not found`);
    }

    if (run.status !== "paused") {
      throw new Error(`Workflow run "${runId}" is not paused (status: ${run.status})`);
    }

    // Mark the checkpoint step as approved
    const waitingStep = run.steps.find((s) => s.status === "waiting_approval");
    if (waitingStep) {
      waitingStep.status = "completed";
      waitingStep.approved = true;
      await this.deps.stateStore.updateStep(runId, waitingStep.stepId, {
        status: "completed",
        approved: true,
      });
    }

    // Resume running
    await this.deps.stateStore.finalize(runId, "running");
    run.status = "running";
    run.completedAt = undefined;
    this.deps.onWorkflowStatusChange?.("running", run);

    logger.info("workflow.resumed", { runId });

    try {
      await this.executeSteps(definition, run, budget);
    } catch (err) {
      logger.error("workflow.failed", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.deps.stateStore.finalize(run.id, "failed", run.totalCost);
      run.status = "failed";
      run.completedAt = Date.now();
      this.deps.onWorkflowStatusChange?.("failed", run);
      return run;
    }

    const allDone = run.steps.every(
      (s) => s.status === "completed" || s.status === "skipped"
    );

    if (allDone) {
      await this.deps.stateStore.finalize(run.id, "completed", run.totalCost);
      run.status = "completed";
      run.completedAt = Date.now();
      this.deps.onWorkflowStatusChange?.("completed", run);
    }

    return run;
  }

  // -- Core execution loop --

  private async executeSteps(
    definition: WorkflowDefinition,
    run: WorkflowRun,
    budget: number
  ): Promise<void> {
    const logger = getLogger();
    const stepMap = new Map(definition.steps.map((s) => [s.id, s]));
    const stepResultMap = new Map<string, StepResult>();
    const skippedSteps = new Set<string>();

    // Populate stepResultMap from run state
    for (const sr of run.steps) {
      stepResultMap.set(sr.stepId, sr);
    }

    let currentStepId = definition.steps[0]?.id ?? "";
    const visited = new Set<string>();

    while (currentStepId) {
      // Guard against infinite loops
      if (visited.has(currentStepId)) {
        logger.error("workflow.cycle_detected", {
          runId: run.id,
          stepId: currentStepId,
        });
        throw new Error(`Cycle detected: step "${currentStepId}" was already visited`);
      }
      visited.add(currentStepId);

      const step = stepMap.get(currentStepId);
      if (!step) {
        throw new Error(`Step "${currentStepId}" not found in definition`);
      }

      // Check if step is already completed (from a previous resume)
      const existingResult = stepResultMap.get(currentStepId);
      if (existingResult && (existingResult.status === "completed" || existingResult.status === "skipped")) {
        currentStepId = this.resolveNextStep(step, existingResult, definition, skippedSteps);
        continue;
      }

      // Resolve task template
      const resolvedTask = resolveTemplate(step.task, run.variables, stepResultMap);

      // Execute based on step type
      let stepResult: StepResult;

      switch (step.type) {
        case "agent":
          stepResult = await this.executeAgentStep(step, resolvedTask, run, budget);
          break;
        case "committee":
          stepResult = await this.executeCommitteeStep(step, resolvedTask, run, budget);
          break;
        case "checkpoint":
          stepResult = await this.executeCheckpointStep(step, run);
          break;
        case "debate":
          stepResult = await this.executeDebateStep(step, resolvedTask, run, budget);
          break;
        case "review-chain":
          stepResult = await this.executeReviewChainStep(step, resolvedTask, run, budget);
          break;
        default:
          throw new Error(`Unknown step type: ${(step as { type: string }).type}`);
      }

      // Update run state
      const stepIndex = run.steps.findIndex((s) => s.stepId === currentStepId);
      if (stepIndex !== -1) {
        run.steps[stepIndex] = stepResult;
      }
      stepResultMap.set(currentStepId, stepResult);

      // Update total cost
      if (stepResult.result?.cost) {
        run.totalCost += stepResult.result.cost;
      }

      // Persist state
      await this.deps.stateStore.updateStep(run.id, currentStepId, stepResult);
      await this.deps.stateStore.save(run);

      // Notify
      this.deps.onStepComplete?.(currentStepId, stepResult.status, stepResult.result);

      logger.info("workflow.step.completed", {
        runId: run.id,
        stepId: currentStepId,
        status: stepResult.status,
        cost: stepResult.result?.cost ?? 0,
      });

      // If step failed and there's no branch, stop the workflow
      if (stepResult.status === "failed" && !step.on) {
        logger.warn("workflow.step.failed_no_branch", {
          runId: run.id,
          stepId: currentStepId,
        });
        throw new Error(`Step "${currentStepId}" failed with no fallback branch`);
      }

      // If checkpoint paused the workflow
      if (stepResult.status === "waiting_approval") {
        run.status = "paused";
        run.currentStepId = currentStepId;
        await this.deps.stateStore.save(run);
        this.deps.onWorkflowStatusChange?.("paused", run);
        return;
      }

      // If this step has a branch condition, mark skipped steps
      if (step.on) {
        const conditionMet = evaluateCondition(step.on.condition, stepResult);
        const targetStepId = conditionMet ? step.on.then : step.on.else;
        this.markSkippedSteps(step, targetStepId, definition, skippedSteps);

        // Update skipped steps in run state
        for (const skippedId of skippedSteps) {
          const skippedIndex = run.steps.findIndex((s) => s.stepId === skippedId);
          if (skippedIndex !== -1 && run.steps[skippedIndex].status === "pending") {
            const skippedResult: StepResult = {
              stepId: skippedId,
              status: "skipped",
            };
            run.steps[skippedIndex] = skippedResult;
            stepResultMap.set(skippedId, skippedResult);
            await this.deps.stateStore.updateStep(run.id, skippedId, skippedResult);
          }
        }
      }

      // Resolve next step
      currentStepId = this.resolveNextStep(step, stepResult, definition, skippedSteps);
    }
  }

  private resolveNextStep(
    step: WorkflowStep,
    result: StepResult,
    definition: WorkflowDefinition,
    skippedSteps: Set<string>
  ): string {
    // If there's a condition, evaluate it
    if (step.on) {
      const conditionMet = evaluateCondition(step.on.condition, result);
      return conditionMet ? step.on.then : step.on.else;
    }

    // Otherwise, go to the next non-skipped step in sequence
    const stepIndex = definition.steps.findIndex((s) => s.id === step.id);
    for (let i = stepIndex + 1; i < definition.steps.length; i++) {
      const nextId = definition.steps[i].id;
      if (!skippedSteps.has(nextId)) {
        return nextId;
      }
    }
    return ""; // Last step or all remaining are skipped
  }

  /**
   * Mark steps that are unreachable after branching.
   *
   * When branching from sourceStep to targetStepId:
   * - Steps between source and target (exclusive) are skipped (the other branch)
   * - When "then" is taken, the else target and its continuation are skipped
   * - When "else" is taken, the then path steps are skipped
   */
  private markSkippedSteps(
    sourceStep: WorkflowStep,
    targetStepId: string,
    definition: WorkflowDefinition,
    skippedSteps: Set<string>
  ): void {
    if (!sourceStep.on) return;

    const sourceIndex = definition.steps.findIndex((s) => s.id === sourceStep.id);
    const targetIndex = definition.steps.findIndex((s) => s.id === targetStepId);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const { then: thenId, else: elseId } = sourceStep.on;
    const thenIndex = definition.steps.findIndex((s) => s.id === thenId);
    const elseIndex = definition.steps.findIndex((s) => s.id === elseId);

    if (targetStepId === thenId) {
      // "then" branch taken -- skip the else path:
      // 1. Steps between source and then (prefix of else path)
      for (let i = sourceIndex + 1; i < thenIndex; i++) {
        skippedSteps.add(definition.steps[i].id);
      }
      // 2. The else target itself
      skippedSteps.add(elseId);
      // 3. Steps after else that are part of else's sequential continuation,
      //    up to the point where both branches converge
      const maxBranchIndex = Math.max(thenIndex, elseIndex);
      for (let i = elseIndex + 1; i < definition.steps.length; i++) {
        if (i > maxBranchIndex) break;
        skippedSteps.add(definition.steps[i].id);
      }
    } else if (targetStepId === elseId) {
      // "else" branch taken -- skip the then path
      for (let i = sourceIndex + 1; i < elseIndex; i++) {
        skippedSteps.add(definition.steps[i].id);
      }
    }
  }

  // -- Step executors --

  private async executeAgentStep(
    step: WorkflowStep,
    task: string,
    run: WorkflowRun,
    budget: number
  ): Promise<StepResult> {
    if (!step.agentType) {
      return {
        stepId: step.id,
        status: "failed",
        result: { status: "error", error: `Step "${step.id}": agentType is required`, steps: 0, cost: 0 },
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
    }
    const stepBudget = step.budget ?? budget;
    const definition = this.deps.agentLoopDeps.loadAgentDefinition(step.agentType);

    // Apply step-level model/provider overrides
    const effectiveDef = {
      ...definition,
      ...(step.maxSteps ? { maxSteps: step.maxSteps } : {}),
      ...(step.model ? { model: step.model } : {}),
      ...(step.provider ? { provider: step.provider as ModelProvider } : {}),
    };

    const startedAt = Date.now();

    try {
      const loop = new AgentLoop(this.deps.agentLoopDeps);
      const result = await loop.run(task, effectiveDef, stepBudget);

      return {
        stepId: step.id,
        status: result.status === "success" ? "completed" : "failed",
        result,
        startedAt,
        completedAt: Date.now(),
      };
    } catch (err) {
      return this.createFailedResult(step.id, startedAt, err);
    }
  }

  private async executeCommitteeStep(
    step: WorkflowStep,
    task: string,
    run: WorkflowRun,
    budget: number
  ): Promise<StepResult> {
    if (!step.agentTypes || step.agentTypes.length === 0) {
      return {
        stepId: step.id,
        status: "failed",
        result: { status: "error", error: `Step "${step.id}": agentTypes is required`, steps: 0, cost: 0 },
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
    }
    const startedAt = Date.now();
    const committeeConfig: CommitteeConfig = {
      agentTypes: step.agentTypes,
      strategy: (step.strategy as CommitteeConfig["strategy"]) ?? "concat",
    };

    try {
      const committee = new Committee(this.deps.agentLoopDeps);
      const result = await committee.run(task, committeeConfig, step.budget ?? budget);

      return {
        stepId: step.id,
        status: result.status === "success" || result.status === "partial" ? "completed" : "failed",
        result: {
          status: result.status === "partial" ? "success" : result.status,
          content: result.content,
          steps: result.totalSteps,
          cost: result.totalCost,
        },
        startedAt,
        completedAt: Date.now(),
      };
    } catch (err) {
      return this.createFailedResult(step.id, startedAt, err);
    }
  }

  private async executeDebateStep(
    step: WorkflowStep,
    task: string,
    run: WorkflowRun,
    budget: number
  ): Promise<StepResult> {
    if (!step.debateConfig) {
      return {
        stepId: step.id,
        status: "failed",
        result: { status: "error", error: `Step "${step.id}": debateConfig is required`, steps: 0, cost: 0 },
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
    }
    const startedAt = Date.now();

    try {
      const debate = new Debate(this.deps.agentLoopDeps);
      const result = await debate.run(task, step.debateConfig, step.budget ?? budget);

      return {
        stepId: step.id,
        status: result.status === "success" || result.status === "partial" ? "completed" : "failed",
        result: {
          status: result.status === "partial" ? "success" : result.status,
          content: result.content,
          steps: result.totalSteps,
          cost: result.totalCost,
        },
        startedAt,
        completedAt: Date.now(),
      };
    } catch (err) {
      return this.createFailedResult(step.id, startedAt, err);
    }
  }

  private async executeReviewChainStep(
    step: WorkflowStep,
    task: string,
    run: WorkflowRun,
    budget: number
  ): Promise<StepResult> {
    if (!step.reviewChainConfig) {
      return {
        stepId: step.id,
        status: "failed",
        result: { status: "error", error: `Step "${step.id}": reviewChainConfig is required`, steps: 0, cost: 0 },
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
    }
    const startedAt = Date.now();

    try {
      const chain = new ReviewChain(this.deps.agentLoopDeps);
      const result = await chain.run(task, step.reviewChainConfig, step.budget ?? budget);

      return {
        stepId: step.id,
        status: result.status === "success" ? "completed" : "failed",
        result: {
          status: result.status === "max_iterations_reached" ? "max_steps_reached" : result.status,
          content: result.content,
          steps: result.totalSteps,
          cost: result.totalCost,
        },
        startedAt,
        completedAt: Date.now(),
      };
    } catch (err) {
      return this.createFailedResult(step.id, startedAt, err);
    }
  }

  private async executeCheckpointStep(
    step: WorkflowStep,
    run: WorkflowRun
  ): Promise<StepResult> {
    const message = step.checkpoint?.message ?? "Approval required to continue";
    const autoApprove = step.checkpoint?.autoApprove ?? false;

    if (autoApprove) {
      return {
        stepId: step.id,
        status: "completed",
        approved: true,
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
    }

    if (!this.deps.onCheckpoint) {
      return {
        stepId: step.id,
        status: "completed",
        approved: true,
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
    }

    const approved = await this.deps.onCheckpoint(step.id, message);

    if (approved) {
      return {
        stepId: step.id,
        status: "completed",
        approved: true,
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
    }

    return {
      stepId: step.id,
      status: "waiting_approval",
      approved: false,
      startedAt: Date.now(),
    };
  }

  private createFailedResult(stepId: string, startedAt: number, error: unknown): StepResult {
    return {
      stepId,
      status: "failed",
      result: {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        steps: 0,
        cost: 0,
      },
      startedAt,
      completedAt: Date.now(),
    };
  }
}

// -- Condition evaluator --

function evaluateCondition(condition: WorkflowCondition, result: StepResult): boolean {
  let actual: string | number | undefined;

  switch (condition.field) {
    case "status":
      actual = result.status;
      break;
    case "content":
      actual = result.result?.content ?? "";
      break;
    case "cost":
      actual = result.result?.cost ?? 0;
      break;
  }

  if (actual === undefined) return false;

  const expected = condition.value;

  switch (condition.operator) {
    case "eq":
      return String(actual) === String(expected);
    case "contains":
      return String(actual).includes(String(expected));
    case "gt":
      return Number(actual) > Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "matches":
      try {
        return new RegExp(String(expected)).test(String(actual));
      } catch {
        return false;
      }
    default:
      return false;
  }
}
