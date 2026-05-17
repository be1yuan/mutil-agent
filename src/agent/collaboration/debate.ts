import { AgentLoop, type AgentLoopDeps } from "../agent-loop.js";
import type { AgentResult } from "../../types/core.js";
import { getLogger } from "../../observability/logger.js";
import type {
  DebateConfig,
  DebateRoundResult,
  DebateResult,
  DebateParticipantScore,
} from "./types.js";

const MEMBER_COLORS = [
  (s: string) => `\x1b[36m${s}\x1b[0m`,
  (s: string) => `\x1b[33m${s}\x1b[0m`,
  (s: string) => `\x1b[35m${s}\x1b[0m`,
  (s: string) => `\x1b[32m${s}\x1b[0m`,
  (s: string) => `\x1b[34m${s}\x1b[0m`,
];

const JUDGE_PROMPT = `你是一场多智能体辩论的评委。请根据以下维度对每位参与者的回答打分（0-10分）：

1. 相关性(relevance): 回答与辩论主题的相关程度
2. 深度(depth): 分析的深入程度和细节丰富度
3. 新颖度(novelty): 观点的独特性和创新性
4. 清晰度(clarity): 表达是否清晰、逻辑是否严密
{critiqueDimension}

辩论主题: {topic}

{responses}

请以 JSON 格式输出评分结果（不要其他内容）:
{
  "scores": [
    {
      "agentType": "...",
      "totalScore": 85,
      "dimensions": { "relevance": 9, "depth": 8, "novelty": 7, "clarity": 9, "critique": 0 },
      "comment": "简短评语（1-2句话）"
    }
  ]
}`;

const MODERATOR_PROMPT = `你是一场多智能体辩论的主持人。你的职责是综合所有辩论轮次和评委评分，产出一个全面、平衡的最终总结。

辩论主题: {topic}

{roundsTranscript}

请综合各方观点，指出共识、分歧，并给出你的综合判断。`;

export class Debate {
  constructor(private deps: AgentLoopDeps) {}

  async run(
    task: string,
    config: DebateConfig,
    budget: number
  ): Promise<DebateResult> {
    const logger = getLogger();
    const rounds: DebateRoundResult[] = [];
    let budgetExhausted = false;

    logger.info("debate.started", {
      participants: config.participants,
      rounds: config.rounds,
      judge: config.judge,
    });

    // Round 1: initial responses
    const round1 = await this.runRound(1, config.participants, task);
    if (config.judge && config.judgeAgentType) {
      round1.scores = await this.judgeRound(
        1,
        round1.responses,
        config.judgeAgentType,
        task,
        config.customJudgePrompt
      );
    }
    rounds.push(round1);

    // Rounds 2..N: critique and improve
    for (let r = 2; r <= config.rounds; r++) {
      if (this.deps.costTracker.remaining <= 0) {
        logger.warn("debate.budget_exhausted", { round: r });
        budgetExhausted = true;
        break;
      }

      const roundPrompt = this.buildRoundPrompt(r, task, rounds[r - 2]);
      const roundResult = await this.runRound(r, config.participants, roundPrompt);

      if (config.judge && config.judgeAgentType) {
        roundResult.scores = await this.judgeRound(
          r,
          roundResult.responses,
          config.judgeAgentType,
          task,
          config.customJudgePrompt
        );
      }
      rounds.push(roundResult);
    }

    // Moderator synthesis (if configured)
    let moderatorResult: DebateResult["moderatorResult"];
    let content: string | undefined;

    if (config.moderator && this.deps.costTracker.remaining > 0) {
      const moderatorDef = this.deps.loadAgentDefinition(config.moderator);
      const transcript = this.buildModeratorTranscript(task, rounds);
      const moderatorPrompt = MODERATOR_PROMPT
        .replace("{topic}", task)
        .replace("{roundsTranscript}", transcript);

      const moderatorLoop = new AgentLoop(this.deps);
      const moderatorOut = await moderatorLoop.run(
        moderatorPrompt,
        moderatorDef,
        this.deps.costTracker.remaining
      );

      moderatorResult = {
        agentType: config.moderator,
        content: moderatorOut.content ?? "(no synthesis)",
      };
      content = moderatorResult.content;
    } else {
      // Concatenate last round responses
      const lastRound = rounds[rounds.length - 1];
      content = lastRound.responses
        .map((r) => `[${r.agentType}]\n${r.content}`)
        .join("\n\n---\n\n");
    }

    // Compute total steps and cost from all rounds
    let totalSteps = 0;
    for (const round of rounds) {
      for (const resp of round.responses) {
        totalSteps += resp.steps;
      }
      if (round.scores) totalSteps += 1; // judge call
    }
    if (moderatorResult) totalSteps += 1; // moderator call
    const totalCost = this.deps.costTracker.spent;

    // Compute status
    const allRoundsCompleted = rounds.length >= config.rounds;
    const status: DebateResult["status"] = budgetExhausted
      ? "budget_exceeded"
      : rounds.length === 0
        ? "error"
        : allRoundsCompleted
          ? "success"
          : "partial";

    logger.info("debate.completed", {
      rounds: rounds.length,
      totalCost,
      totalSteps,
      status,
    });

    return {
      status,
      content,
      rounds,
      moderatorResult,
      totalCost,
      totalSteps,
    };
  }

  private async runRound(
    round: number,
    participants: string[],
    prompt: string
  ): Promise<DebateRoundResult> {
    const logger = getLogger();
    const responses: Array<{ agentType: string; content: string; steps: number; cost: number }> = [];

    logger.info("debate.round_started", { round, participants });

    // Run participants in parallel (same pattern as Committee)
    const promises = participants.map(async (agentType, index) => {
      const definition = this.deps.loadAgentDefinition(agentType);
      const color = MEMBER_COLORS[index % MEMBER_COLORS.length];
      const memberDeps: AgentLoopDeps = {
        ...this.deps,
        getStreamPrefix: (_type: string) => color(`[${agentType}] `),
      };

      const loop = new AgentLoop(memberDeps);
      const result = await loop.run(
        prompt,
        definition,
        this.deps.costTracker.remaining
      );

      return { agentType, result };
    });

    const settled = await Promise.allSettled(promises);

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        responses.push({
          agentType: outcome.value.agentType,
          content: outcome.value.result.content ?? "(no response)",
          steps: outcome.value.result.steps ?? 0,
          cost: outcome.value.result.cost ?? 0,
        });
      } else {
        logger.warn("debate.participant_failed", {
          round,
          error: (outcome.reason as Error)?.message ?? String(outcome.reason),
        });
        responses.push({
          agentType: "unknown",
          content: `[error: ${String(outcome.reason)}]`,
          steps: 0,
          cost: 0,
        });
      }
    }

    logger.info("debate.round_completed", { round, responseCount: responses.length });
    return { round, responses };
  }

  private async judgeRound(
    round: number,
    responses: Array<{ agentType: string; content: string }>,
    judgeAgentType: string,
    topic: string,
    customJudgePrompt?: string
  ): Promise<DebateParticipantScore[]> {
    const logger = getLogger();

    const judgeDef = this.deps.loadAgentDefinition(judgeAgentType);

    const responsesText = responses
      .map((r) => `参与者 ${r.agentType}:\n${r.content}`)
      .join("\n\n");

    const judgePrompt = (customJudgePrompt ?? JUDGE_PROMPT)
      .replace("{critiqueDimension}", round > 1 ? "5. 批判性(critique): 对其他观点的批判性审视质量" : "")
      .replace("{topic}", topic)
      .replace("{responses}", responsesText);

    logger.info("debate.judge_started", { round, judgeAgentType });

    const judgeLoop = new AgentLoop(this.deps);
    const judgeResult = await judgeLoop.run(
      judgePrompt,
      judgeDef,
      this.deps.costTracker.remaining
    );

    // Parse JSON from judge output
    const rawContent = judgeResult.content ?? "";
    try {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.scores && Array.isArray(parsed.scores)) {
          logger.info("debate.judge_completed", { round, scored: parsed.scores.length });
          return parsed.scores as DebateParticipantScore[];
        }
      }
      logger.warn("debate.judge_unparseable", { round, content: rawContent.slice(0, 200) });
    } catch (err) {
      logger.warn("debate.judge_parse_error", { round, error: String(err) });
    }

    return [];
  }

  private buildRoundPrompt(
    round: number,
    topic: string,
    previousRound: DebateRoundResult
  ): string {
    const prevResponses = previousRound.responses
      .map((r) => `[${r.agentType}]: ${r.content}`)
      .join("\n\n");

    let scoresSection = "";
    if (previousRound.scores && previousRound.scores.length > 0) {
      const scoreLines = previousRound.scores
        .map(
          (s) =>
            `  ${s.agentType}: ${s.totalScore}分 — ${s.comment}`
        )
        .join("\n");
      scoresSection = `\n上一轮评委评分:\n${scoreLines}\n`;
    }

    return `你正在参加一场多轮辩论。这是第 ${round} 轮。

辩论主题: ${topic}

以下是上一轮各方的观点:
${prevResponses}
${scoresSection}
请批判性地审视以上观点，指出其不足、矛盾或遗漏之处，并在此基础上改进和完善你的立场。提供更有深度和说服力的论述。`;
  }

  private buildModeratorTranscript(
    topic: string,
    rounds: DebateRoundResult[]
  ): string {
    return rounds
      .map((r) => {
        const responses = r.responses
          .map((resp) => `[${resp.agentType}]: ${resp.content}`)
          .join("\n\n");

        let scores = "";
        if (r.scores && r.scores.length > 0) {
          const scoreLines = r.scores
            .map(
              (s) =>
                `  ${s.agentType}: ${s.totalScore}分 (相关性:${s.dimensions.relevance} 深度:${s.dimensions.depth} 新颖度:${s.dimensions.novelty} 清晰度:${s.dimensions.clarity}) — ${s.comment}`
            )
            .join("\n");
          scores = `\n评委评分:\n${scoreLines}\n`;
        }

        return `=== 第${r.round}轮 ===\n${responses}${scores}`;
      })
      .join("\n\n");
  }
}
