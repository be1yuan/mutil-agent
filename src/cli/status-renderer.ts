/**
 * Status renderer — business-level rendering functions for CLI output.
 * Composes ansi.ts utilities into domain-specific renderers.
 */

import {
  fg,
  style,
  symbols,
  toolSymbol,
  banner,
  progressBar,
  truncate,
} from "./ansi.js";
import type { AgentResult } from "../types/core.js";
import type { SubAgentResult } from "../adapters/types.js";

// ── Startup banner ──

export function renderBanner(
  agentType: string,
  model: string,
  budget: number
): string {
  return banner([
    style.bold(`Agent: ${agentType}`) +
      " │ " +
      style.info(`Model: ${model}`) +
      " │ " +
      style.success(`Budget: ¥${budget.toFixed(2)}`),
  ]);
}

// ── Step header ──

export function renderStepStart(step: number, maxSteps: number): string {
  return style.bold(fg.cyan(`▸ Step ${step}/${maxSteps}`));
}

// ── Tool execution ──

export function renderToolStart(
  toolName: string,
  detail: string,
  verbose = false
): string {
  const sym = toolSymbol(toolName);
  const name = style.bold(toolName.padEnd(10));
  const maxLen = verbose ? 120 : 60;
  const det = style.dim(truncate(detail, maxLen));
  return `  ${sym} ${name} ${det}`;
}

export function renderToolComplete(
  toolName: string,
  detail: string,
  success: boolean,
  duration: number
): string {
  const sym = toolSymbol(toolName);
  const name = style.bold(toolName.padEnd(10));
  const det = style.dim(truncate(detail, 40));
  const status = success
    ? style.success(`✓ ${duration}ms`)
    : style.error(`✗ ${duration}ms`);
  return `  ${sym} ${name} ${det}  ${status}`;
}

// ── Sub-agent spawn / complete ──

export function renderSubAgentSpawn(
  parent: string,
  child: string,
  task: string
): string {
  return `  ${symbols.spawn} ${style.dim(`[${parent}]`)} → ${style.info(`[${child}]`)} ${style.dim(truncate(task, 50))}`;
}

export function renderSubAgentComplete(
  child: string,
  status: string,
  cost: number
): string {
  const icon = status === "success" ? symbols.ok : symbols.fail;
  const color = status === "success" ? style.success : style.error;
  return `  ${symbols.done} ${color(`[${child}]`)} ${icon} ${status} ${style.dim(`(¥${cost.toFixed(4)})`)}`;
}

// ── Cost status bar ──

export function renderCostStatus(
  spent: number,
  budget: number,
  steps: number,
  maxSteps: number
): string {
  const ratio = budget > 0 ? spent / budget : 0;
  const bar = progressBar(ratio, 20);
  const costColor =
    ratio > 0.8 ? style.error : ratio > 0.5 ? style.warning : style.success;

  const w = 60;
  return [
    `${symbols.boxTL}${symbols.boxH.repeat(w - 2)}${symbols.boxTR}`,
    `${symbols.boxV} ${style.bold("Status")} │ Steps: ${steps}/${maxSteps} │ Cost: ${costColor(`¥${spent.toFixed(4)}`)} │ Budget: ${bar} ${symbols.boxV}`,
    `${symbols.boxBL}${symbols.boxH.repeat(w - 2)}${symbols.boxBR}`,
  ].join("\n");
}

// ── Final result block ──

export function renderResult(result: AgentResult): string {
  const isWarning = result.status === "budget_exceeded" || result.status === "max_steps_reached";
  const statusIcon = result.status === "success" ? symbols.ok : isWarning ? symbols.warn : symbols.fail;
  const statusColor = result.status === "success" ? style.success : isWarning ? style.warning : style.error;

  return banner(
    [
      `${statusIcon} ${statusColor(result.status.toUpperCase())}`,
      `Steps: ${result.steps} │ Cost: ¥${result.cost.toFixed(4)}`,
      result.error ? style.error(`Error: ${truncate(result.error, 50)}`) : "",
    ].filter(Boolean)
  );
}

// ── Committee result tree ──

interface CommitteeMemberResult {
  agentType: string;
  result: AgentResult;
}

interface CommitteeRenderResult {
  status: string;
  strategy: string;
  members: CommitteeMemberResult[];
  totalCost: number;
  totalSteps: number;
  content?: string;
}

export function renderCommitteeResult(result: CommitteeRenderResult): string {
  const lines: string[] = [
    style.bold(
      `Committee │ Strategy: ${result.strategy} │ Members: ${result.members.length}`
    ),
    "",
  ];

  for (let i = 0; i < result.members.length; i++) {
    const m = result.members[i];
    const isLast = i === result.members.length - 1;
    const connector = isLast ? symbols.stepLast : symbols.stepSub;
    const icon = m.result.status === "success" ? symbols.ok : symbols.fail;
    const color =
      m.result.status === "success" ? style.success : style.error;

    lines.push(
      `  ${connector} ${color(m.agentType.padEnd(10))} ${icon} ` +
        `${m.result.status} (${m.result.steps} steps, ¥${m.result.cost.toFixed(4)})`
    );
  }

  lines.push("");
  lines.push(
    `Total cost: ¥${result.totalCost.toFixed(4)} │ Total steps: ${result.totalSteps}`
  );

  return banner(lines);
}
