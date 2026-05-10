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
import type { DebateResult, ReviewChainResult } from "../agent/collaboration/types.js";

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

// ── Debate result ──

export function renderDebateResult(result: DebateResult): string {
  const statusIcon = result.status === "success" ? symbols.ok : result.status === "error" ? symbols.fail : symbols.warn;
  const statusColor = result.status === "success" ? style.success : result.status === "error" ? style.error : style.warning;

  const lines: string[] = [
    style.bold(`Debate │ ${statusIcon} ${statusColor(result.status.toUpperCase())} │ Rounds: ${result.rounds.length} │ Cost: ¥${result.totalCost.toFixed(4)}`),
    "",
  ];

  for (const round of result.rounds) {
    const hasScores = round.scores && round.scores.length > 0;
    const roundLabel = hasScores ? `Round ${round.round} (scored)` : `Round ${round.round}`;
    lines.push(style.bold(`  ${symbols.stepSub} ${roundLabel}:`));

    for (const resp of round.responses) {
      const preview = truncate(resp.content.replace(/\s+/g, " "), 80);
      lines.push(`  ${symbols.stepLast} ${style.info(resp.agentType)}: ${style.dim(preview)}`);
    }

    if (round.scores && round.scores.length > 0) {
      lines.push(`  ${style.dim("  Scores:")}`);
      for (const s of round.scores) {
        const dims = `rel:${s.dimensions.relevance} dep:${s.dimensions.depth} nov:${s.dimensions.novelty} clr:${s.dimensions.clarity}${s.dimensions.critique !== undefined ? ` cri:${s.dimensions.critique}` : ""}`;
        lines.push(`  ${symbols.stepLast} ${style.info(s.agentType)}: ${s.totalScore}/100 ${style.dim(`(${dims})`)} ${style.dim(s.comment)}`);
      }
    }

    lines.push("");
  }

  if (result.moderatorResult) {
    const modPreview = truncate(result.moderatorResult.content.replace(/\s+/g, " "), 80);
    lines.push(style.bold(`  ${symbols.stepSub} Moderator (${result.moderatorResult.agentType}):`));
    lines.push(`  ${symbols.stepLast} ${style.dim(modPreview)}`);
    lines.push("");
  }

  lines.push(`Total cost: ¥${result.totalCost.toFixed(4)} │ Total steps: ${result.totalSteps}`);

  return banner(lines);
}

// ── Review Chain result ──

export function renderReviewChainResult(result: ReviewChainResult): string {
  const statusIcon = result.status === "success" ? symbols.ok : result.status === "error" ? symbols.fail : symbols.warn;
  const statusColor = result.status === "success" ? style.success : result.status === "error" ? style.error : style.warning;

  const headerStatus = result.status === "max_iterations_reached" ? "MAX ITERATIONS" : result.status.toUpperCase();
  const lines: string[] = [
    style.bold(`Review Chain │ ${statusIcon} ${statusColor(headerStatus)} │ Iterations: ${result.iterations.length} │ Cost: ¥${result.totalCost.toFixed(4)}`),
    "",
  ];

  for (const it of result.iterations) {
    const acceptedLabel = it.accepted ? style.success(" ✓ ACCEPTED") : "";
    lines.push(style.bold(`  ${symbols.stepSub} Iteration ${it.iteration}${acceptedLabel}:`));

    // Coder output
    const coderPreview = truncate(it.coderResult.content.replace(/\s+/g, " "), 80);
    lines.push(`  ${symbols.stepSub} ${style.info("coder")}: ${style.dim(coderPreview)}`);

    // Reviewer verdict
    if (it.reviewerResult) {
      const verdictStr = it.reviewerResult.verdict.type === "NEEDS_CHANGES"
        ? `NEEDS_CHANGES: ${truncate(it.reviewerResult.verdict.feedback, 60)}`
        : it.reviewerResult.verdict.type;
      const verdictColor = it.reviewerResult.verdict.type === "LGTM" || it.reviewerResult.verdict.type === "APPROVED"
        ? style.success : style.warning;
      lines.push(`  ${symbols.stepLast} ${style.info("reviewer")}: ${verdictColor(verdictStr)}`);
    }

    lines.push("");
  }

  lines.push(`Total cost: ¥${result.totalCost.toFixed(4)} │ Total steps: ${result.totalSteps}`);

  return banner(lines);
}
