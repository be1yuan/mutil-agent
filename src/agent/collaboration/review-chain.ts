import { AgentLoop, type AgentLoopDeps } from "../agent-loop.js";
import type { AgentResult } from "../../types/core.js";
import { getLogger } from "../../observability/logger.js";
import type {
  ReviewChainConfig,
  ReviewChainIteration,
  ReviewChainResult,
  ReviewVerdict,
} from "./types.js";

const REVIEW_INSTRUCTIONS = `\n\n---\nReview Instructions:\nPlease review the above output and end your review with exactly one of the following:\n- "LGTM" or "APPROVED" — the solution is acceptable\n- "NEEDS_CHANGES: <具体反馈>" — changes are needed, explain what and why`;

const LGTM_RE = /\b(LGTM|APPROVED)\b/im;
const NEEDS_CHANGES_RE = /NEEDS_CHANGES\s*:\s*(.+)/im;

export function parseVerdict(text: string): ReviewVerdict {
  const tail = text.slice(-500);
  const lgtmMatch = tail.match(LGTM_RE);
  if (lgtmMatch) {
    return { type: lgtmMatch[1].toUpperCase() as "LGTM" | "APPROVED" };
  }
  const changesMatch = tail.match(NEEDS_CHANGES_RE);
  if (changesMatch) {
    return { type: "NEEDS_CHANGES", feedback: changesMatch[1].trim() };
  }
  // Default: if unclear, treat as needs changes with generic feedback
  return { type: "NEEDS_CHANGES", feedback: "Reviewer did not provide clear verdict" };
}

export class ReviewChain {
  constructor(private deps: AgentLoopDeps) {}

  async run(
    task: string,
    config: ReviewChainConfig,
    budget: number
  ): Promise<ReviewChainResult> {
    const logger = getLogger();
    const iterations: ReviewChainIteration[] = [];
    let totalCost = 0;
    let totalSteps = 0;
    let manualRejected = false;

    logger.info("review-chain.started", {
      coder: config.coder,
      reviewer: config.reviewer,
      maxIterations: config.maxIterations,
    });

    const coderDef = this.deps.loadAgentDefinition(config.coder);
    const reviewerDef = this.deps.loadAgentDefinition(config.reviewer);

    // Append review instructions to reviewer's system prompt
    const reviewerDefWithInstructions = {
      ...reviewerDef,
      systemPrompt: reviewerDef.systemPrompt + REVIEW_INSTRUCTIONS,
    };

    // Step 1: Coder produces initial solution
    const coderDeps: AgentLoopDeps = {
      ...this.deps,
      getStreamPrefix: (_type: string) => `\x1b[36m[coder]\x1b[0m `,
    };
    let coderLoop = new AgentLoop(coderDeps);
    let coderResult = await coderLoop.run(
      task,
      coderDef,
      this.deps.costTracker.remaining
    );

    const coderOutput = {
      content: coderResult.content ?? "",
      cost: coderResult.cost,
      steps: coderResult.steps,
    };
    totalCost += coderResult.cost;
    totalSteps += coderResult.steps;

    // Iterative review loop
    for (let i = 0; i < config.maxIterations; i++) {
      if (this.deps.costTracker.remaining <= 0) {
        logger.warn("review-chain.budget_exhausted", { iteration: i + 1 });
        break;
      }

      const iteration: ReviewChainIteration = {
        iteration: i + 1,
        coderResult: coderOutput,
        accepted: false,
      };

      // Reviewer evaluates
      const reviewerDeps: AgentLoopDeps = {
        ...this.deps,
        getStreamPrefix: (_type: string) => `\x1b[33m[reviewer]\x1b[0m `,
      };
      const reviewerLoop = new AgentLoop(reviewerDeps);
      const reviewPrompt = `Review the following output:\n\n${coderOutput.content}`;
      const reviewerResult = await reviewerLoop.run(
        reviewPrompt,
        reviewerDefWithInstructions,
        this.deps.costTracker.remaining
      );

      const verdict = parseVerdict(reviewerResult.content ?? "");
      iteration.reviewerResult = {
        content: reviewerResult.content ?? "",
        cost: reviewerResult.cost,
        steps: reviewerResult.steps,
        verdict,
      };
      totalCost += reviewerResult.cost;
      totalSteps += reviewerResult.steps;

      if (verdict.type === "LGTM" || verdict.type === "APPROVED") {
        iteration.accepted = true;
        iterations.push(iteration);
        logger.info("review-chain.accepted", { iteration: i + 1 });
        break;
      }

      // NOT accepted — check manual checkpoint
      iteration.feedback = verdict.type === "NEEDS_CHANGES" ? verdict.feedback : undefined;
      iteration.accepted = false;
      iterations.push(iteration);

      if (config.acceptThreshold === "manual") {
        const approved = await this.requestManualApproval(iteration);
        if (!approved) {
          manualRejected = true;
          logger.info("review-chain.manual_rejected", { iteration: i + 1 });
          break;
        }
      }

      // If max iterations reached, stop
      if (i >= config.maxIterations - 1) {
        logger.info("review-chain.max_iterations", { iteration: i + 1 });
        break;
      }

      // Coder revises based on feedback
      const revisionPrompt = `Revise your previous output based on the following feedback:\n\n${verdict.type === "NEEDS_CHANGES" ? verdict.feedback : "Please improve the solution."}\n\nPrevious output:\n${coderOutput.content}`;

      const revisedDeps: AgentLoopDeps = {
        ...this.deps,
        getStreamPrefix: (_type: string) => `\x1b[36m[coder]\x1b[0m `,
      };
      const revisedLoop = new AgentLoop(revisedDeps);
      const revisedResult = await revisedLoop.run(
        revisionPrompt,
        coderDef,
        this.deps.costTracker.remaining
      );

      coderOutput.content = revisedResult.content ?? coderOutput.content;
      coderOutput.cost = revisedResult.cost;
      coderOutput.steps = revisedResult.steps;
      totalCost += revisedResult.cost;
      totalSteps += revisedResult.steps;
    }

    const acceptedIteration = iterations.find((it) => it.accepted);
    const status = acceptedIteration
      ? "success"
      : manualRejected
        ? "max_iterations_reached"
        : iterations.length >= config.maxIterations
          ? "max_iterations_reached"
          : this.deps.costTracker.remaining <= 0
            ? "budget_exceeded"
            : "error";

    logger.info("review-chain.completed", {
      status,
      iterations: iterations.length,
      totalCost,
      totalSteps,
    });

    return {
      status,
      content: acceptedIteration?.coderResult.content ?? iterations[iterations.length - 1]?.coderResult.content,
      iterations,
      totalCost,
      totalSteps,
    };
  }

  private async requestManualApproval(
    iteration: ReviewChainIteration
  ): Promise<boolean> {
    if (!this.deps.onApprovalRequest) return true;

    const feedback = iteration.feedback ?? "No specific feedback";
    return this.deps.onApprovalRequest({
      agentType: "review-chain",
      toolName: "approval",
      arguments: {
        iteration: iteration.iteration,
        feedback,
        coderOutput: iteration.coderResult.content.slice(0, 500),
      },
    });
  }
}
