/**
 * /agent interactive wizard — guided agent selection, config view, model switching, editing.
 * Uses node:readline, matching meeting-wizard.ts pattern.
 */

import * as readline from "node:readline";
import { t } from "./i18n.js";
import { style } from "./ansi.js";
import { questionWithEsc, ESC } from "./question-with-esc.js";
import { saveAgent } from "../config/loader.js";
import type { AgentDefinition } from "../agent/types.js";
import type { ModelProvider } from "../types/core.js";

// ── Helpers ──

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** Format tool permissions for display */
function formatTools(tools: Record<string, unknown>): string {
  const names = Object.keys(tools);
  return `${names.length} → ${names.join(", ")}`;
}

// ── Main entry ──

export async function runAgentWizard(
  agentDefs: Map<string, AgentDefinition>,
  sourcePaths: Map<string, string>,
  modelCatalog: { model: string; provider: ModelProvider; label: string }[]
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    if (agentDefs.size === 0) {
      console.log(style.warning(`  ${t("agent.noAgents")}.`));
      return;
    }

    while (true) {
      // ── Step 1: Agent selection ──
      const agent = await selectAgent(rl, agentDefs);
      if (!agent) return; // cancelled

      // ── Step 2: Action menu (loop) ──
      await actionLoop(rl, agent.name, agent.definition, agentDefs, sourcePaths, modelCatalog);
    }
  } finally {
    rl.close();
  }
}

// ── Agent selection ──

async function selectAgent(
  rl: readline.Interface,
  agentDefs: Map<string, AgentDefinition>
): Promise<{ name: string; definition: AgentDefinition } | null> {
  const entries = Array.from(agentDefs.entries());

  while (true) {
    console.log();
    console.log(style.bold(`  ${t("agent.selectAgent")}:`));
    console.log();

    for (let i = 0; i < entries.length; i++) {
      const [name, def] = entries[i];
      const desc = def.description ?? t("agent.noDescription");
      console.log(`  ${style.bold(`${i + 1}.`)} ${name} ${style.dim(`— ${desc} · ${def.model}`)}`);
    }

    console.log();
    const raw = await questionWithEsc(rl, `  ${t("agent.selectPrompt")} `);
    if (raw === ESC || !raw) return null;

    // Try number first
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num >= 1 && num <= entries.length) {
      const [name, definition] = entries[num - 1];
      return { name, definition };
    }

    // Try name match
    for (const [name, definition] of entries) {
      if (name.toLowerCase() === raw.toLowerCase()) {
        return { name, definition };
      }
    }

    console.log(style.warning(`  ${t("agent.notFound")}: "${raw}"`));
    // loop back
  }
}

// ── Action menu loop ──

async function actionLoop(
  rl: readline.Interface,
  agentName: string,
  definition: AgentDefinition,
  agentDefs: Map<string, AgentDefinition>,
  sourcePaths: Map<string, string>,
  modelCatalog: { model: string; provider: ModelProvider; label: string }[]
): Promise<void> {
  while (true) {
    console.log();
    console.log(style.dim("──────────────────────────────────────────────"));
    console.log(`  ${style.bold(agentName)} ${style.dim(t("agent.actionsFor"))}`);
    console.log();
    console.log(`  ${style.bold("1.")} ${t("agent.action.show")}`);
    console.log(`  ${style.bold("2.")} ${t("agent.action.model")}`);
    console.log(`  ${style.bold("3.")} ${t("agent.action.edit")}`);
    console.log(`  ${style.bold("4.")} ${t("agent.action.back")}`);
    console.log();
    const raw = await questionWithEsc(rl, `  ${t("agent.actionPrompt")} `);

    if (raw === "1") {
      showAgentDetail(agentName, definition);
    } else if (raw === "2") {
      const changed = await changeModel(rl, agentName, definition, sourcePaths, modelCatalog);
      if (changed) {
        console.log(style.success(`  ${t("agent.model.switched")} ${style.bold(definition.model)}`));
      }
    } else if (raw === "3") {
      await editAgentConfig(rl, agentName, definition, sourcePaths);
    } else if (raw === "4" || raw === "" || raw === ESC) {
      return; // back to list
    }
  }
}

// ── Show detail ──

function showAgentDetail(name: string, def: AgentDefinition): void {
  console.log();
  console.log(style.dim(`  ┌─ ${name} ${"─".repeat(Math.max(0, 42 - name.length))}`));
  console.log(`  │ ${t("agent.detail.type")}:     ${def.agentType}`);
  console.log(`  │ ${t("agent.detail.model")}:    ${def.model}${def.provider ? ` (${def.provider})` : ""}`);
  console.log(`  │ ${t("agent.detail.desc")}: ${def.description ?? t("agent.noDescription")}`);
  console.log(`  │ ${t("agent.detail.maxSteps")}: ${def.maxSteps}`);
  console.log(`  │ ${t("agent.detail.timeout")}:  ${def.timeout}ms`);
  console.log(`  │ ${t("agent.detail.isolation")}: ${def.isolation ?? t("agent.detail.none")}`);
  console.log(`  │ ${t("agent.detail.tools")}:    ${formatTools(def.tools)}`);

  const promptPreview = def.systemPrompt.slice(0, 300);
  const truncated = def.systemPrompt.length > 300;
  console.log(`  │ ${t("agent.detail.systemPrompt")}: (${def.systemPrompt.length} chars)`);
  console.log(`  │ ${t("agent.detail.promptPreview")}`);
  for (const line of promptPreview.split("\n")) {
    console.log(`  │ ${line}`);
  }
  if (truncated) console.log(`  │ ...`);
  console.log(style.dim(`  └${"─".repeat(50)}`));
  console.log();
}

// ── Change model ──

async function changeModel(
  rl: readline.Interface,
  agentName: string,
  definition: AgentDefinition,
  sourcePaths: Map<string, string>,
  modelCatalog: { model: string; provider: ModelProvider; label: string }[]
): Promise<boolean> {
  console.log();
  console.log(style.bold(`  ${t("agent.model.select")} "${agentName}":`));
  console.log();

  for (let i = 0; i < modelCatalog.length; i++) {
    const m = modelCatalog[i];
    const current = m.model === definition.model ? ` ${style.info("●")}` : "";
    console.log(`  ${style.bold(`${i + 1}.`)}${current} ${m.label} ${style.dim(`(${m.model})`)}`);
  }

  console.log();
  const raw = await questionWithEsc(rl, `  ${t("agent.model.prompt")} `);
  if (raw === ESC || !raw) return false;

  const num = parseInt(raw, 10);
  if (!isNaN(num) && num >= 1 && num <= modelCatalog.length) {
    const selected = modelCatalog[num - 1];
    definition.model = selected.model;
    definition.provider = selected.provider;
    const src = sourcePaths.get(agentName);
    if (src) await saveAgent(src, definition);
    return true;
  }

  return false;
}

// ── Edit config ──

async function editAgentConfig(
  rl: readline.Interface,
  agentName: string,
  definition: AgentDefinition,
  sourcePaths: Map<string, string>
): Promise<void> {
  console.log();
  console.log(style.bold(`  ${t("agent.edit.title")} "${agentName}"`));
  console.log(style.dim(`  ${t("agent.edit.hint")}`));
  console.log();

  let changed = false;

  // systemPrompt
  console.log(`  ${t("agent.edit.prompt")} [${t("agent.edit.currentLen")}: ${definition.systemPrompt.length}]`);
  const newPrompt = await question(rl, `  > `);
  if (newPrompt) {
    definition.systemPrompt = newPrompt;
    changed = true;
  }

  // maxSteps
  console.log(`  ${t("agent.edit.maxSteps")} [${t("agent.edit.current")}: ${definition.maxSteps}]:`);
  const stepsRaw = await question(rl, `  > `);
  if (stepsRaw) {
    const parsed = parseInt(stepsRaw, 10);
    if (!isNaN(parsed) && parsed > 0) { definition.maxSteps = parsed; changed = true; }
  }

  // timeout
  console.log(`  ${t("agent.edit.timeout")} [${t("agent.edit.current")}: ${definition.timeout}ms]:`);
  const timeoutRaw = await question(rl, `  > `);
  if (timeoutRaw) {
    const parsed = parseInt(timeoutRaw, 10);
    if (!isNaN(parsed) && parsed > 0) { definition.timeout = parsed; changed = true; }
  }

  // isolation
  console.log(`  ${t("agent.edit.isolation")} [${t("agent.edit.current")}: ${definition.isolation ?? t("agent.detail.none")}]:`);
  const isoRaw = await question(rl, `  > `);
  if (isoRaw) {
    changed = true;
    const lower = isoRaw.toLowerCase();
    if (lower === "context" || lower === "worktree") {
      definition.isolation = lower as "context" | "worktree";
    } else if (lower === t("agent.edit.none").toLowerCase() || lower === "" || lower === "none") {
      definition.isolation = undefined;
    }
  }

  if (changed) {
    const src = sourcePaths.get(agentName);
    if (src) await saveAgent(src, definition);
  }
  console.log(style.success(`  ${t("agent.edit.updated")}: "${agentName}"`));
}
