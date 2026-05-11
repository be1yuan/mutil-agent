/**
 * Workflow YAML parser — loads and validates workflow definitions using Zod.
 */

import fs from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { WorkflowDefinition, WorkflowStep, WorkflowCondition, StepType } from "./types.js";

// ── Zod schemas ──

const StepTypeSchema = z.enum(["agent", "committee", "checkpoint"]);

const WorkflowConditionSchema = z.object({
  field: z.enum(["status", "content", "cost"]),
  operator: z.enum(["eq", "contains", "gt", "lt", "matches"]),
  value: z.union([z.string(), z.number()]),
});

const WorkflowStepSchema = z.object({
  id: z.string().min(1, "Step id is required"),
  type: StepTypeSchema,
  agentType: z.string().optional(),
  agentTypes: z.array(z.string()).optional(),
  task: z.string().min(1, "Step task is required"),
  model: z.string().optional(),
  provider: z.enum(["deepseek", "zhipu", "mimo", "kimi", "qwen"]).optional(),
  maxSteps: z.number().int().positive().optional(),
  budget: z.number().positive().optional(),
  timeout: z.number().int().positive().optional(),
  strategy: z.string().optional(),
  on: z.object({
    condition: WorkflowConditionSchema,
    then: z.string().min(1),
    else: z.string().min(1),
  }).optional(),
  checkpoint: z.object({
    message: z.string(),
    autoApprove: z.boolean().optional(),
  }).optional(),
});

const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1, "Workflow name is required"),
  description: z.string().min(1, "Description is required for workflow matching"),
  version: z.string().optional(),
  steps: z.array(WorkflowStepSchema).min(1, "At least one step is required"),
  variables: z.record(z.string()).optional(),
});

// ── Validation errors ──

export class WorkflowValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid workflow definition:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "WorkflowValidationError";
  }
}

// ── Parser ──

/**
 * Parse and validate a workflow YAML string into a WorkflowDefinition.
 */
export function parseWorkflowYaml(yamlContent: string): WorkflowDefinition {
  const raw = YAML.parse(yamlContent);
  const result = WorkflowDefinitionSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new WorkflowValidationError(issues);
  }

  // Cross-field validation
  const def = result.data;
  const stepIds = new Set(def.steps.map((s) => s.id));
  const issues: string[] = [];

  // Check for duplicate step ids
  const seen = new Set<string>();
  for (const step of def.steps) {
    if (seen.has(step.id)) {
      issues.push(`Duplicate step id: "${step.id}"`);
    }
    seen.add(step.id);
  }

  // Validate step-type-specific fields
  for (const step of def.steps) {
    if (step.type === "agent" && !step.agentType) {
      issues.push(`Step "${step.id}": agentType is required for type=agent`);
    }
    if (step.type === "committee" && (!step.agentTypes || step.agentTypes.length === 0)) {
      issues.push(`Step "${step.id}": agentTypes is required for type=committee`);
    }

    // Validate branch targets exist
    if (step.on) {
      if (!stepIds.has(step.on.then)) {
        issues.push(`Step "${step.id}": branch target "${step.on.then}" not found`);
      }
      if (!stepIds.has(step.on.else)) {
        issues.push(`Step "${step.id}": branch target "${step.on.else}" not found`);
      }
    }
  }

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }

  return def as WorkflowDefinition;
}

/**
 * Load and parse a workflow YAML file.
 */
export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const content = await fs.readFile(filePath, "utf-8");
  return parseWorkflowYaml(content);
}
