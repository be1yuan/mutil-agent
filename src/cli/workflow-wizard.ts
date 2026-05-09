/**
 * WorkflowWizard — interactive /workflow new creation.
 *
 * Guides the user through creating a workflow YAML definition
 * step by step, then saves it to the .workflows/ directory.
 */

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { style } from "./ansi.js";
import type { WorkflowDefinition, WorkflowStep, StepType } from "../workflow/types.js";

export interface WizardStepInput {
  type: StepType;
  agentType?: string;
  agentTypes?: string[];
  task: string;
}

interface WizardResult {
  definition: WorkflowDefinition;
  filePath: string;
}

/**
 * Run the interactive workflow creation wizard.
 * Returns the created definition and file path, or null if cancelled.
 */
export async function runWorkflowWizard(
  workflowsDir: string,
  availableAgents: string[]
): Promise<WizardResult | null> {
  const readline = await import("node:readline");
  let rl: ReturnType<typeof readline.createInterface> | undefined;

  const prompt = (question: string): Promise<string> => {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise<string>((resolve) => {
      rl!.question(question, (ans: string) => {
        rl!.close();
        rl = undefined;
        resolve(ans.trim());
      });
    });
  };

  try {
    console.log();
    console.log(style.bold("  Create New Workflow"));
    console.log(style.dim("  ────────────────────"));
    console.log();

    // Name
    const name = await prompt("  Name: ");
    if (!name) {
      console.log(style.dim("  Cancelled."));
      return null;
    }

    // Description
    const description = await prompt("  Description: ");
    if (!description) {
      console.log(style.dim("  Cancelled."));
      return null;
    }

    // Build steps
    const steps: WizardStepInput[] = [];
    let stepNum = 1;

    while (true) {
      console.log();
      console.log(style.bold(`  Step ${stepNum} — Choose type:`));
      console.log(style.dim("    1. agent      (single agent)"));
      console.log(style.dim("    2. committee  (multiple agents in parallel)"));
      console.log(style.dim("    3. checkpoint (human approval)"));
      const typeChoice = await prompt("  > ");

      let stepType: StepType;
      if (typeChoice === "2") {
        stepType = "committee";
      } else if (typeChoice === "3") {
        stepType = "checkpoint";
      } else {
        stepType = "agent";
      }

      let agentType: string | undefined;
      let agentTypes: string[] | undefined;

      if (stepType === "agent") {
        console.log();
        console.log(style.dim(`  Available agents: ${availableAgents.join(", ")}`));
        agentType = await prompt("  Agent: ");
        if (!agentType) {
          console.log(style.dim("  Cancelled."));
          return null;
        }
      } else if (stepType === "committee") {
        console.log();
        console.log(style.dim(`  Available agents: ${availableAgents.join(", ")}`));
        const agentsStr = await prompt("  Agents (comma-separated): ");
        if (!agentsStr) {
          console.log(style.dim("  Cancelled."));
          return null;
        }
        agentTypes = agentsStr.split(",").map((s) => s.trim()).filter(Boolean);
      }

      const task = await prompt("  Task description: ");
      if (!task) {
        console.log(style.dim("  Cancelled."));
        return null;
      }

      steps.push({ type: stepType, agentType, agentTypes, task });

      const addMore = await prompt("  Add another step? [Y/n] ");
      if (addMore.toLowerCase() === "n" || addMore.toLowerCase() === "no") {
        break;
      }
      stepNum++;
    }

    // Build definition
    const definition: WorkflowDefinition = {
      name: sanitizeName(name),
      description,
      steps: steps.map((s, i) => buildStep(s, i)),
    };

    // Show preview
    const yaml = serializeWorkflow(definition);
    console.log();
    console.log(style.bold("  Generated workflow:"));
    console.log(style.dim("  ━━━━━━━━━━━━━━━━━━━"));
    console.log(yaml.split("\n").map((l) => `  ${l}`).join("\n"));
    console.log(style.dim("  ━━━━━━━━━━━━━━━━━━━"));
    console.log();

    const saveChoice = await prompt("  Save? [Y/n] ");
    if (saveChoice.toLowerCase() === "n" || saveChoice.toLowerCase() === "no") {
      console.log(style.dim("  Cancelled."));
      return null;
    }

    // Save
    const filePath = path.join(workflowsDir, `${definition.name}.yaml`);
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.writeFile(filePath, yaml, "utf-8");

    console.log(style.success(`  ✓ Workflow "${definition.name}" saved to ${filePath}`));

    return { definition, filePath };
  } finally {
    rl?.close();
  }
}

export function buildStep(input: WizardStepInput, index: number): WorkflowStep {
  const id = `step${index + 1}`;
  const step: WorkflowStep = {
    id,
    type: input.type,
    task: input.task,
  };

  if (input.type === "agent" && input.agentType) {
    step.agentType = input.agentType;
  }
  if (input.type === "committee" && input.agentTypes) {
    step.agentTypes = input.agentTypes;
  }
  if (input.type === "checkpoint") {
    step.checkpoint = {
      message: input.task,
      autoApprove: false,
    };
  }

  return step;
}

export function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Serialize a WorkflowDefinition to YAML using the yaml library for proper escaping.
 */
export function serializeWorkflow(def: WorkflowDefinition): string {
  // Build a plain object matching the YAML structure, then let yaml.stringify handle escaping
  const obj: Record<string, unknown> = {
    name: def.name,
    description: def.description,
  };
  if (def.version) obj.version = def.version;
  if (def.variables && Object.keys(def.variables).length > 0) {
    obj.variables = def.variables;
  }
  obj.steps = def.steps.map((step) => {
    const s: Record<string, unknown> = {
      id: step.id,
      type: step.type,
    };
    if (step.agentType) s.agentType = step.agentType;
    if (step.agentTypes) s.agentTypes = step.agentTypes;
    s.task = step.task;
    if (step.budget !== undefined) s.budget = step.budget;
    if (step.maxSteps !== undefined) s.maxSteps = step.maxSteps;
    if (step.checkpoint) s.checkpoint = step.checkpoint;
    if (step.on) s.on = step.on;
    return s;
  });

  return YAML.stringify(obj, { lineWidth: 120 });
}
