/**
 * Workflow module — public API.
 */

export type {
  StepType,
  WorkflowCondition,
  WorkflowStep,
  WorkflowDefinition,
  StepStatus,
  StepResult,
  WorkflowStatus,
  WorkflowRun,
} from "./types.js";

export { parseWorkflowYaml, loadWorkflow, WorkflowValidationError } from "./parser.js";
export { resolveTemplate } from "./template-resolver.js";
export { WorkflowStateStore } from "./state-store.js";
export { WorkflowEngine, type WorkflowEngineDeps } from "./engine.js";
