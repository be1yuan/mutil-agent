/**
 * /meeting interactive wizard — guided setup for Debate, Review Chain, and Committee.
 * Uses raw stdin via simple-input.ts to avoid Windows readline \r\n issues.
 */

import { t } from "./i18n.js";
import { style } from "./ansi.js";
import { readLine, ESC } from "./simple-input.js";
import type { AgentDefinition } from "../agent/types.js";
import type { DebateConfig, ReviewChainConfig } from "../agent/collaboration/types.js";
import type { AggregationStrategy } from "../agent/committee.js";

// ── Wizard results ──

export interface MeetingResult {
  mode: "debate" | "review-chain" | "committee";
  task: string;
  debateConfig?: DebateConfig;
  reviewChainConfig?: ReviewChainConfig;
  committeeConfig?: {
    agentTypes: string[];
    strategy: AggregationStrategy;
    weights?: Record<string, number>;
  };
}

// ── Helpers ──

/**
 * Ask a single question. Uses raw stdin (no readline) to avoid
 * Windows \r\n split issues that cause silent exits on subsequent prompts.
 * Returns ESC sentinel if user presses Escape on empty input.
 */
async function question(prompt: string): Promise<string> {
  const answer = await readLine(prompt);
  if (answer === ESC) return ESC;
  // On Enter with empty input, print a newline for visual consistency
  // (readLine doesn't auto-echo a newline on \r/\n)
  process.stdout.write("\n");
  return answer.trim();
}

/**
 * Prompt that returns null (cancelled) if the user presses Escape
 * or enters empty input.
 */
async function requiredPrompt(prompt: string): Promise<string | null> {
  const answer = await question(prompt);
  if (answer === ESC || answer === "") return null;
  return answer;
}

function availableList(agentDefs: Map<string, AgentDefinition>): string {
  return Array.from(agentDefs.keys()).join(", ");
}

function defaultParticipants(agentDefs: Map<string, AgentDefinition>): string[] {
  const all = Array.from(agentDefs.keys());
  const preferred = ["explore", "architect"];
  return preferred.filter((a) => all.includes(a));
}

// ── Main entry ──

export async function runMeetingWizard(
  agentDefs: Map<string, AgentDefinition>
): Promise<MeetingResult | null> {
  console.log();
  console.log(style.dim("──────────────────────────────────────────────"));
  console.log(style.bold(`  ${t("meeting.title")}`));
  console.log();
  console.log(`  ${style.bold("1.")} ${t("meeting.mode.debate")}`);
  console.log(style.dim(`     ${t("meeting.mode.debate.desc")}`));
  console.log();
  console.log(`  ${style.bold("2.")} ${t("meeting.mode.reviewChain")}`);
  console.log(style.dim(`     ${t("meeting.mode.reviewChain.desc")}`));
  console.log();
  console.log(`  ${style.bold("3.")} ${t("meeting.mode.committee")}`);
  console.log(style.dim(`     ${t("meeting.mode.committee.desc")}`));
  console.log(style.dim("──────────────────────────────────────────────"));
  console.log();

  const modeAnswer = await question(`  ${t("meeting.selectMode")} [1-3]: `);

  if (modeAnswer === ESC || modeAnswer === "") {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }

  if (modeAnswer === "1") {
    return promptDebateConfig(agentDefs);
  } else if (modeAnswer === "2") {
    return promptReviewChainConfig(agentDefs);
  } else if (modeAnswer === "3") {
    return promptCommitteeConfig(agentDefs);
  } else {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }
}

// ── Debate wizard ──

async function promptDebateConfig(
  agentDefs: Map<string, AgentDefinition>
): Promise<MeetingResult | null> {
  console.log();
  console.log(style.bold(`  ${t("meeting.debate.title")}`));
  console.log(style.dim("──────────────────────────────────────────────"));
  console.log();

  const topic = await requiredPrompt(`  ${t("meeting.debate.topic")}: `);
  if (!topic) {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }

  const defaultParts = defaultParticipants(agentDefs);
  console.log(`  ${style.dim(`${t("meeting.available")}: ${availableList(agentDefs)}`)}`);
  console.log(`  ${style.dim(`${t("meeting.default")}: ${defaultParts.join(", ")}`)}`);
  const participantsAnswer = await question(`  ${t("meeting.debate.participants")}: `);
  const participants = participantsAnswer
    ? participantsAnswer.split(/[,\s]+/).map((a) => a.trim()).filter(Boolean)
    : defaultParts;

  if (participants.length === 0) {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }

  // Validate participants
  for (const p of participants) {
    if (!agentDefs.has(p)) {
      console.log(`  ${style.error(`${t("meeting.invalidAgent")}: ${p}`)}`);
      return null;
    }
  }

  const roundsAnswer = await question(`  ${t("meeting.debate.rounds")} [2]: `);
  const rounds = parseInt(roundsAnswer) || 2;

  const judgeAnswer = await question(`  ${t("meeting.debate.enableJudge")} [Y/n]: `);
  const judge = judgeAnswer.toLowerCase() !== "n";

  let judgeAgentType = "judge";
  if (judge) {
    console.log(`  ${style.dim(`${t("meeting.available")}: ${availableList(agentDefs)}`)}`);
    const judgeAlt = await question(`  ${t("meeting.debate.judgeAgent")} [judge]: `);
    if (judgeAlt) judgeAgentType = judgeAlt;
    if (!agentDefs.has(judgeAgentType)) {
      console.log(`  ${style.error(`${t("meeting.invalidAgent")}: ${judgeAgentType}`)}`);
      return null;
    }
  }

  const moderatorAnswer = await question(`  ${t("meeting.debate.enableModerator")} [y/N]: `);
  const hasModerator = moderatorAnswer.toLowerCase() === "y";

  let moderator: string | undefined;
  if (hasModerator) {
    console.log(`  ${style.dim(`${t("meeting.available")}: ${availableList(agentDefs)}`)}`);
    const modAnswer = await question(`  ${t("meeting.debate.moderatorAgent")} [architect]: `);
    moderator = modAnswer || "architect";
    if (!agentDefs.has(moderator)) {
      console.log(`  ${style.error(`${t("meeting.invalidAgent")}: ${moderator}`)}`);
      return null;
    }
  }

  // Confirmation
  console.log();
  console.log(style.dim("  ┌─────────────────────────────────────────┐"));
  console.log(style.dim("  │          ") + style.bold(t("meeting.confirm.title")) + style.dim("            │"));
  console.log(style.dim("  │                                          │"));
  console.log(style.dim(`  │  ${t("meeting.confirm.mode")}: `) + style.info(t("meeting.mode.debate")));
  console.log(style.dim(`  │  ${t("meeting.debate.topic")}: ${topic.slice(0, 35)}`));
  console.log(style.dim(`  │  ${t("meeting.debate.participants")}: ${participants.join(", ")}`));
  console.log(style.dim(`  │  ${t("meeting.debate.rounds")}: ${rounds}`));
  console.log(style.dim(`  │  ${t("meeting.debate.judge")}: ${judge ? judgeAgentType : t("meeting.debate.judgeOff")}`));
  console.log(style.dim(`  │  ${t("meeting.debate.moderator")}: ${moderator || t("meeting.debate.noModerator")}`));
  console.log(style.dim("  │                                          │"));
  console.log(style.dim("  └─────────────────────────────────────────┘"));
  console.log();

  const confirm = await question(`  ${t("meeting.debate.start")} [Y/n]: `);
  if (confirm === ESC || confirm.toLowerCase() === "n") {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }

  return {
    mode: "debate",
    task: topic,
    debateConfig: {
      participants,
      rounds,
      judge,
      judgeAgentType: judge ? judgeAgentType : undefined,
      moderator,
      prompt: topic,
    },
  };
}

// ── Review Chain wizard ──

async function promptReviewChainConfig(
  agentDefs: Map<string, AgentDefinition>
): Promise<MeetingResult | null> {
  console.log();
  console.log(style.bold(`  ${t("meeting.reviewChain.title")}`));
  console.log(style.dim("──────────────────────────────────────────────"));
  console.log();

  const task = await requiredPrompt(`  ${t("meeting.reviewChain.task")}: `);
  if (!task) {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }

  const coderAnswer = await question(`  ${t("meeting.reviewChain.coder")} [coder]: `);
  const coder = coderAnswer || "coder";
  if (!agentDefs.has(coder)) {
    console.log(`  ${style.error(`${t("meeting.invalidAgent")}: ${coder}`)}`);
    return null;
  }

  const reviewerAnswer = await question(`  ${t("meeting.reviewChain.reviewer")} [reviewer]: `);
  const reviewer = reviewerAnswer || "reviewer";
  if (!agentDefs.has(reviewer)) {
    console.log(`  ${style.error(`${t("meeting.invalidAgent")}: ${reviewer}`)}`);
    return null;
  }

  const maxIterAnswer = await question(`  ${t("meeting.reviewChain.maxIterations")} [3]: `);
  const maxIterations = parseInt(maxIterAnswer) || 3;

  const manualAnswer = await question(`  ${t("meeting.reviewChain.manualApproval")} [y/N]: `);
  const acceptThreshold = manualAnswer.toLowerCase() === "y" ? "manual" : "auto";

  // Confirmation
  console.log();
  console.log(style.dim("  ┌─────────────────────────────────────────┐"));
  console.log(style.dim("  │          ") + style.bold(t("meeting.confirm.title")) + style.dim("            │"));
  console.log(style.dim("  │                                          │"));
  console.log(style.dim(`  │  ${t("meeting.confirm.mode")}: `) + style.info(t("meeting.mode.reviewChain")));
  console.log(style.dim(`  │  ${t("meeting.reviewChain.task")}: ${task.slice(0, 35)}`));
  console.log(style.dim(`  │  ${t("meeting.reviewChain.coder")}: ${coder}  ${t("meeting.reviewChain.reviewer")}: ${reviewer}`));
  console.log(style.dim(`  │  ${t("meeting.reviewChain.maxIterations")}: ${maxIterations}  ${t("meeting.reviewChain.approval")}: ${acceptThreshold === "auto" ? t("meeting.reviewChain.auto") : t("meeting.reviewChain.manual")}`));
  console.log(style.dim("  │                                          │"));
  console.log(style.dim("  └─────────────────────────────────────────┘"));
  console.log();

  const confirm = await question(`  ${t("meeting.reviewChain.start")} [Y/n]: `);
  if (confirm === ESC || confirm.toLowerCase() === "n") {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }

  return {
    mode: "review-chain",
    task,
    reviewChainConfig: { coder, reviewer, maxIterations, acceptThreshold },
  };
}

// ── Committee wizard ──

async function promptCommitteeConfig(
  agentDefs: Map<string, AgentDefinition>
): Promise<MeetingResult | null> {
  console.log();
  console.log(style.bold(`  ${t("meeting.committee.title")}`));
  console.log(style.dim("──────────────────────────────────────────────"));
  console.log();

  const task = await requiredPrompt(`  ${t("meeting.committee.task")}: `);
  if (!task) {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }

  const defaultAgents = ["explore", "coder", "reviewer", "architect"].filter((a) =>
    agentDefs.has(a)
  );
  console.log(`  ${style.dim(`${t("meeting.available")}: ${availableList(agentDefs)}`)}`);
  console.log(`  ${style.dim(`${t("meeting.default")}: ${defaultAgents.join(", ")}`)}`);
  const agentsAnswer = await question(`  ${t("meeting.committee.agents")}: `);
  const agentTypes = agentsAnswer
    ? agentsAnswer.split(/[,\s]+/).map((a) => a.trim()).filter(Boolean)
    : defaultAgents;

  if (agentTypes.length === 0) {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }

  for (const a of agentTypes) {
    if (!agentDefs.has(a)) {
      console.log(`  ${style.error(`${t("meeting.invalidAgent")}: ${a}`)}`);
      return null;
    }
  }

  console.log();
  console.log(`  ${t("meeting.committee.strategy")}:`);
  console.log(`  ${style.bold("1.")} concat ${style.dim(`  — ${t("meeting.committee.strategy.concat")}`)}`);
  console.log(`  ${style.bold("2.")} majority ${style.dim(` — ${t("meeting.committee.strategy.majority")}`)}`);
  console.log(`  ${style.bold("3.")} best ${style.dim(`     — ${t("meeting.committee.strategy.best")}`)}`);
  console.log(`  ${style.bold("4.")} weighted-majority ${style.dim(` — ${t("meeting.committee.strategy.weightedMajority")}`)}`);
  console.log(`  ${style.bold("5.")} weighted-best ${style.dim(` — ${t("meeting.committee.strategy.weightedBest")}`)}`);
  console.log();

  const strategyAnswer = await question(`  ${t("meeting.committee.selectStrategy")} [1, default: 1]: `);
  const strategyMap: Record<string, AggregationStrategy> = {
    "1": "concat",
    "2": "majority",
    "3": "best",
    "4": "weighted-majority",
    "5": "weighted-best",
  };
  const strategy = strategyAnswer ? (strategyMap[strategyAnswer] ?? "concat") : "concat";

  let weights: Record<string, number> | undefined;
  if (strategy === "weighted-majority" || strategy === "weighted-best") {
    console.log(`  ${style.dim(`${t("meeting.committee.weightsHint")}`)}`);
    const weightsAnswer = await question(`  ${t("meeting.committee.weights")}: `);
    if (weightsAnswer) {
      weights = {};
      for (const part of weightsAnswer.split(/[,\s]+/)) {
        const [agent, weightStr] = part.split(":");
        if (agent && weightStr) {
          const w = parseFloat(weightStr);
          if (!isNaN(w)) weights[agent.trim()] = w;
        }
      }
    }
  }

  // Confirmation
  const strategyLabel =
    strategy === "weighted-majority"
      ? `${strategy} (${JSON.stringify(weights ?? {})})`
      : strategy;
  console.log();
  console.log(style.dim("  ┌─────────────────────────────────────────┐"));
  console.log(style.dim("  │          ") + style.bold(t("meeting.confirm.title")) + style.dim("            │"));
  console.log(style.dim("  │                                          │"));
  console.log(style.dim(`  │  ${t("meeting.confirm.mode")}: `) + style.info(t("meeting.mode.committee")));
  console.log(style.dim(`  │  ${t("meeting.committee.task")}: ${task.slice(0, 35)}`));
  console.log(style.dim(`  │  ${t("meeting.committee.agents")}: ${agentTypes.join(", ")}`));
  console.log(style.dim(`  │  ${t("meeting.committee.strategyLabel")}: ${strategyLabel}`));
  console.log(style.dim("  │                                          │"));
  console.log(style.dim("  └─────────────────────────────────────────┘"));
  console.log();

  const confirm = await question(`  ${t("meeting.committee.start")} [Y/n]: `);
  if (confirm === ESC || confirm.toLowerCase() === "n") {
    console.log(style.warning(`  ${t("meeting.cancelled")}`));
    return null;
  }

  return {
    mode: "committee",
    task,
    committeeConfig: { agentTypes, strategy, weights },
  };
}
