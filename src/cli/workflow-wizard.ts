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
import { t } from "./i18n.js";
import { questionWithEsc, ESC } from "./question-with-esc.js";
import type { WorkflowDefinition, WorkflowStep, StepType } from "../workflow/types.js";
import type { AgentDefinition } from "../agent/types.js";
import type { ModelProvider } from "../types/core.js";

export interface ModelEntry {
  model: string;
  provider: ModelProvider;
  label: string;
}

export interface WizardStepInput {
  type: StepType;
  agentType?: string;
  agentTypes?: string[];
  task: string;
  modelOverride?: string;
  providerOverride?: ModelProvider;
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
  agentDefinitions: Map<string, AgentDefinition>,
  modelCatalog: ModelEntry[]
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
    console.log(style.bold(`  ${t("wizard.create")}`));
    console.log(style.dim("  ────────────────────"));
    console.log();

    // Name
    const name = await prompt(`  ${t("wizard.name")} `);
    if (!name) {
      console.log(style.dim(`  ${t("wizard.cancelled")}`));
      return null;
    }

    // Description
    const description = await prompt(`  ${t("wizard.description")} `);
    if (!description) {
      console.log(style.dim(`  ${t("wizard.cancelled")}`));
      return null;
    }

    // Build steps
    const steps: WizardStepInput[] = [];
    let stepNum = 1;

    while (true) {
      console.log();
      console.log(style.bold(`  ${t("wizard.step")} ${stepNum} — ${t("wizard.chooseType")}`));
      console.log(style.dim(`    1. ${t("wizard.type.agent")}`));
      console.log(style.dim(`    2. ${t("wizard.type.committee")}`));
      console.log(style.dim(`    3. ${t("wizard.type.checkpoint")}`));
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
        const picked = await promptAgentPicker(prompt, agentDefinitions, "single");
        if (!picked) {
          console.log(style.dim(`  ${t("wizard.cancelled")}`));
          return null;
        }
        agentType = picked[0];
        // Offer model override
        const modelOverride = await promptModelOverride(prompt, agentType, agentDefinitions, modelCatalog);
        const task = await prompt(`  ${t("wizard.task")} `);
        if (!task) {
          console.log(style.dim(`  ${t("wizard.cancelled")}`));
          return null;
        }
        const stepInput: WizardStepInput = { type: stepType, agentType, task };
        if (modelOverride) {
          stepInput.modelOverride = modelOverride.model;
          stepInput.providerOverride = modelOverride.provider;
        }
        steps.push(stepInput);
      } else if (stepType === "committee") {
        const picked = await promptAgentPicker(prompt, agentDefinitions, "multi");
        if (!picked || picked.length === 0) {
          console.log(style.dim(`  ${t("wizard.cancelled")}`));
          return null;
        }
        agentTypes = picked;
        const task = await prompt(`  ${t("wizard.task")} `);
        if (!task) {
          console.log(style.dim(`  ${t("wizard.cancelled")}`));
          return null;
        }
        steps.push({ type: stepType, agentTypes, task });
      } else {
        // checkpoint — no agent needed
        const task = await prompt(`  ${t("wizard.task")} `);
        if (!task) {
          console.log(style.dim(`  ${t("wizard.cancelled")}`));
          return null;
        }
        steps.push({ type: stepType, task });
      }

      const addMore = await prompt(`  ${t("wizard.addMore")} `);
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
    console.log(style.bold(`  ${t("wizard.preview")}`));
    console.log(style.dim("  ━━━━━━━━━━━━━━━━━━━"));
    console.log(yaml.split("\n").map((l) => `  ${l}`).join("\n"));
    console.log(style.dim("  ━━━━━━━━━━━━━━━━━━━"));
    console.log();

    const saveChoice = await prompt(`  ${t("wizard.save")} `);
    if (saveChoice.toLowerCase() === "n" || saveChoice.toLowerCase() === "no") {
      console.log(style.dim(`  ${t("wizard.cancelled")}`));
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

/**
 * Show a numbered agent picker. Returns selected agent type(s), or null if cancelled.
 */
async function promptAgentPicker(
  prompt: (q: string) => Promise<string>,
  agentDefinitions: Map<string, AgentDefinition>,
  mode: "single" | "multi"
): Promise<string[] | null> {
  const agents = Array.from(agentDefinitions.entries());
  console.log();
  console.log(style.bold(`  ${t("wizard.availableAgents")}`));
  for (let i = 0; i < agents.length; i++) {
    const [type, def] = agents[i];
    const desc = def.description ? style.dim(` — ${def.description}`) : "";
    console.log(`    ${style.bold(`[${i + 1}]`)} ${type}${desc}  ${style.dim(`(${def.model})`)}`);
  }
  console.log();

  if (mode === "single") {
    const choice = await prompt(`  ${t("wizard.agent")} [1-${agents.length}]: `);
    if (!choice) return null;
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < agents.length) {
      return [agents[idx][0]];
    }
    // Try matching by name
    const byName = agents.find(([type]) => type === choice.toLowerCase());
    if (byName) return [byName[0]];
    return null;
  }

  // Multi-select
  const choices = await prompt(`  ${t("wizard.agents")} [1-${agents.length}, comma-separated]: `);
  if (!choices) return null;
  const indices = choices.split(",").map((s) => parseInt(s.trim(), 10) - 1);
  const selected: string[] = [];
  for (const idx of indices) {
    if (idx >= 0 && idx < agents.length && !selected.includes(agents[idx][0])) {
      selected.push(agents[idx][0]);
    }
  }
  // Fallback: try matching by name
  if (selected.length === 0) {
    const names = choices.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const name of names) {
      const match = agents.find(([type]) => type === name);
      if (match && !selected.includes(match[0])) {
        selected.push(match[0]);
      }
    }
  }
  return selected.length > 0 ? selected : null;
}

/**
 * Show model override picker for a specific agent.
 * Returns the selected model entry, or null to use the agent's default.
 */
async function promptModelOverride(
  prompt: (q: string) => Promise<string>,
  agentType: string,
  agentDefinitions: Map<string, AgentDefinition>,
  modelCatalog: ModelEntry[]
): Promise<ModelEntry | null> {
  const def = agentDefinitions.get(agentType);
  const defaultModel = def?.model ?? "unknown";

  console.log();
  console.log(style.dim(`  ${agentType} → ${defaultModel}`));
  console.log(style.dim("  Override model? (Enter to keep default)"));
  for (let i = 0; i < modelCatalog.length; i++) {
    const m = modelCatalog[i];
    const marker = m.model === defaultModel ? style.success(" ●") : "  ";
    console.log(`  ${marker} [${i + 1}] ${m.label}  ${style.dim(m.model)}`);
  }

  const readline = await import("node:readline");
  const mrl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const choice = await questionWithEsc(mrl, `  ${t("model.select")} [1-${modelCatalog.length}, ${t("model.cancel")}]: `);
  mrl.close();
  if (choice === ESC || !choice) return null;
  const idx = parseInt(choice, 10) - 1;
  if (idx >= 0 && idx < modelCatalog.length) {
    return modelCatalog[idx];
  }
  return null;
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
  if (input.modelOverride) {
    step.model = input.modelOverride;
  }
  if (input.providerOverride) {
    step.provider = input.providerOverride;
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
    if (step.model) s.model = step.model;
    if (step.provider) s.provider = step.provider;
    if (step.budget !== undefined) s.budget = step.budget;
    if (step.maxSteps !== undefined) s.maxSteps = step.maxSteps;
    if (step.checkpoint) s.checkpoint = step.checkpoint;
    if (step.on) s.on = step.on;
    return s;
  });

  return YAML.stringify(obj, { lineWidth: 120 });
}
