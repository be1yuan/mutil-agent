import type {
  ModelAdapter,
  ToolDefinition,
  ChatParams,
  ChatResponse,
  ToolCall,
  ContentBlock,
  SubAgentArgs,
  SubAgentResult,
} from "../adapters/types.js";
import type { AgentDefinition } from "./types.js";
import type { AgentResult } from "../types/core.js";
import type { ModelProvider } from "../types/core.js";
import type { CostTracker } from "../observability/cost-tracker.js";
import type { PermissionResolver } from "../security/permission-resolver.js";
import type { ConcurrencyLimiter } from "./concurrency-limiter.js";
import type { FallbackExecutor } from "../adapters/fallback-executor.js";
import type { Mailbox } from "./mailbox.js";
import type { ToolContext } from "./tool-executor.js";
import { AdapterSelector } from "./adapter-selector.js";
import { getAllowedTools, buildTaskTool } from "./tools.js";
import { executeTool } from "./tool-executor.js";
import { getLogger } from "../observability/logger.js";
import { acquireWorktree, resolveIsolation } from "./worktree-manager.js";

// ── Agent loop ──

export interface AgentLoopDeps {
  adapterSelector: AdapterSelector;
  permissionResolver: PermissionResolver;
  costTracker: CostTracker;
  concurrencyLimiter: ConcurrencyLimiter;
  adapters: Map<string, ModelAdapter>;
  fallbackExecutor: FallbackExecutor;
  loadAgentDefinition: (agentType: string) => AgentDefinition;
  /** List of available agent types (for dynamic task tool enum) */
  agentTypes?: string[];
  onApprovalRequest?: (request: ApprovalRequest) => Promise<boolean>;
  workspaceDir: string;
  /** If provided, agent will use streaming API and emit text deltas here */
  onStreamText?: (text: string) => void;
  /** If provided, returns a colored prefix for stream text (used by committee) */
  getStreamPrefix?: (agentType: string) => string;
  /** File mailbox instance (if enabled) */
  mailbox?: Mailbox;
  /** When true, the provider uses native web search — exclude custom WebSearch tool */
  nativeSearch?: boolean;

  // ── Lifecycle callbacks (optional, for terminal visualization) ──

  /** Called when a new step begins */
  onStepStart?: (step: number, agentType: string) => void;
  /** Called before a tool executes */
  onToolStart?: (agentType: string, toolName: string, args: Record<string, unknown>) => void;
  /** Called after a tool finishes */
  onToolComplete?: (agentType: string, toolName: string, duration: number, success: boolean) => void;
  /** Called when a sub-agent is spawned */
  onSubAgentSpawn?: (parentType: string, childType: string, task: string) => void;
  /** Called when a sub-agent finishes */
  onSubAgentComplete?: (parentType: string, childType: string, result: SubAgentResult) => void;
  /** Called after each model call with updated budget info */
  onBudgetUpdate?: (spent: number, remaining: number) => void;
}

export interface ApprovalRequest {
  agentType: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export class AgentLoop {
  constructor(private deps: AgentLoopDeps) {}

  async run(
    task: string,
    definition: AgentDefinition,
    budget: number
  ): Promise<AgentResult> {
    const logger = getLogger();
    const history: ChatParams["messages"] = [
      { role: "user", content: task },
    ];
    let steps = 0;

    // Build tool list from agent definition
    const allowedTools = this.buildToolList(definition);

    logger.info("agent.task.started", {
      agentType: definition.agentType,
      model: definition.model,
      task: task.slice(0, 200),
    });

    while (steps < definition.maxSteps) {
      // Notify: step start
      this.deps.onStepStart?.(steps, definition.agentType);

      // 1. Select model provider
      const provider = this.deps.adapterSelector.select(task, definition);

      // Count this iteration as a step (even if the model returns content without tool calls)
      steps++;

      // 1b. Pre-flight budget check: estimate worst-case cost
      const maxTokens = definition.maxTokensPerStep ?? 4096;
      const inputEstimate = this.estimateInputTokens(history);
      const worstCaseCost = this.deps.costTracker.estimateWorstCase(
        provider as ModelProvider,
        inputEstimate,
        maxTokens
      );
      if (!this.deps.costTracker.canAfford(worstCaseCost)) {
        logger.warn("agent.budget.preflight_denied", {
          agentType: definition.agentType,
          worstCaseCost: worstCaseCost.toFixed(6),
          remaining: this.deps.costTracker.remaining.toFixed(6),
        });
        return {
          status: "budget_exceeded",
          content: `Budget insufficient for next model call (estimated worst case: ¥${worstCaseCost.toFixed(4)}, remaining: ¥${this.deps.costTracker.remaining.toFixed(4)})`,
          steps,
          cost: this.deps.costTracker.spent,
        };
      }

      // Apply stream prefix if provided (used by committee for color coding)
      const streamHandler = this.deps.onStreamText
        ? this.deps.getStreamPrefix
          ? (text: string) => {
              const prefix = this.deps.getStreamPrefix!(definition.agentType);
              const prefixed = text
                .split("\n")
                .map((line, i) => (i === 0 ? prefix + line : " ".repeat(10) + line))
                .join("\n");
              this.deps.onStreamText!(prefixed);
            }
          : this.deps.onStreamText
        : undefined;

      const params: ChatParams = {
        model: definition.model,
        system: definition.systemPrompt,
        messages: history,
        tools: allowedTools,
        maxTokens: definition.maxTokensPerStep ?? 4096,
        stream: !!streamHandler,
        onTextDelta: streamHandler,
        onRetry: (attempt: number, error: Error) => {
          // When a retry occurs during streaming, emit a visible marker
          // so the user knows subsequent output is from a new attempt,
          // not a continuation of the previous (possibly corrupted) stream.
          if (streamHandler) {
            streamHandler(`\n[retry attempt ${attempt}: ${error.message.slice(0, 80)}]\n`);
          }
        },
      };

      let response: ChatResponse;
      try {
        response = await this.deps.fallbackExecutor.execute(
          params,
          provider as ModelProvider
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error("agent.model_call_failed", {
          agentType: definition.agentType,
          provider,
          error: errMsg,
        });
        return {
          status: "error",
          error: `Model call failed (after retries + fallback): ${errMsg}`,
          steps,
          cost: this.deps.costTracker.spent,
        };
      }

      // 2. Cost tracking
      this.deps.costTracker.record(response.usage, provider);
      this.deps.onBudgetUpdate?.(this.deps.costTracker.spent, this.deps.costTracker.remaining);
      if (this.deps.costTracker.spent >= budget) {
        logger.warn("agent.budget_exceeded", {
          agentType: definition.agentType,
          spent: this.deps.costTracker.spent,
          budget,
        });
        return {
          status: "budget_exceeded",
          steps,
          cost: this.deps.costTracker.spent,
        };
      }

      // 3. No tool calls → done
      if (response.toolCalls.length === 0) {
        logger.info("agent.task.completed", {
          agentType: definition.agentType,
          steps,
          cost: this.deps.costTracker.spent,
        });
        return {
          status: "success",
          content: response.content ?? undefined,
          steps,
          cost: this.deps.costTracker.spent,
        };
      }

      // 4. Execute tools
      const toolResults: { tool_use_id: string; content: string }[] = [];

      for (const tc of response.toolCalls) {
        // Notify: tool start
        this.deps.onToolStart?.(definition.agentType, tc.name, tc.arguments);
        const toolStart = Date.now();

        const result = await this.executeToolCall(tc, definition);

        // Notify: tool complete
        const toolDuration = Date.now() - toolStart;
        const toolSuccess = !result.startsWith("[denied]") && !result.startsWith("[tool error]");
        this.deps.onToolComplete?.(definition.agentType, tc.name, toolDuration, toolSuccess);

        toolResults.push({
          tool_use_id: tc.id,
          content: result,
        });
      }

      // Add assistant message with tool_use blocks
      const assistantBlocks: ContentBlock[] = [];
      if (response.content) {
        assistantBlocks.push({ type: "text", text: response.content });
      }
      for (const tc of response.toolCalls) {
        assistantBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      history.push({
        role: "assistant",
        content: assistantBlocks,
      });

      // Add tool results
      history.push({
        role: "user",
        content: toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
      });

    }

    logger.warn("agent.max_steps_reached", {
      agentType: definition.agentType,
      steps: definition.maxSteps,
      cost: this.deps.costTracker.spent,
    });

    return {
      status: "max_steps_reached",
      steps,
      cost: this.deps.costTracker.spent,
    };
  }

  // ── Private helpers ──

  private buildToolList(definition: AgentDefinition): ToolDefinition[] {
    const allowed: string[] = [];
    for (const [name, perm] of Object.entries(definition.tools)) {
      if (typeof perm === "string") {
        if (perm === "allow" || perm === "ask") allowed.push(name);
      } else {
        // BashPermission object — Bash tool is allowed, matching happens at runtime
        allowed.push(name);
      }
    }
    // When nativeSearch is enabled, the provider injects its own web_search tool.
    // Remove the custom WebSearch to avoid the model calling the broken DuckDuckGo version.
    if (this.deps.nativeSearch) {
      const idx = allowed.indexOf("WebSearch");
      if (idx !== -1) allowed.splice(idx, 1);
    }
    const agentTypes = this.deps.agentTypes ?? [];
    return getAllowedTools(allowed, undefined, agentTypes);
  }

  private async executeToolCall(
    tc: ToolCall,
    definition: AgentDefinition
  ): Promise<string> {
    const logger = getLogger();
    const bashCommand =
      tc.name === "Bash" ? String(tc.arguments.command ?? "") : undefined;

    const { decision, needsApproval } = this.deps.permissionResolver.canUse(
      definition,
      tc.name,
      bashCommand
    );

    if (decision === "deny") {
      logger.warn("agent.tool.denied", {
        agentType: definition.agentType,
        tool: tc.name,
      });
      return `[denied] ${tc.name}`;
    }

    if (needsApproval) {
      const approved = await this.requestApproval(definition.agentType, tc);
      if (!approved) {
        logger.warn("agent.tool.user_denied", {
          agentType: definition.agentType,
          tool: tc.name,
        });
        return `[user denied] ${tc.name}`;
      }
    }

    // task tool: spawn sub-agent
    if (tc.name === "task") {
      const args = tc.arguments as Record<string, unknown>;
      if (typeof args.agentType !== "string" || typeof args.task !== "string") {
        return `[tool error] task: missing required fields (agentType, task)`;
      }
      return await this.spawnSubAgent(args as unknown as SubAgentArgs, definition);
    }

    // Other tools: execute directly
    try {
      logger.info("agent.tool.executed", {
        agentType: definition.agentType,
        tool: tc.name,
      });
      return await executeTool(tc.name, tc.arguments, this.deps.workspaceDir, {
        mailbox: this.deps.mailbox,
        currentAgentType: definition.agentType,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("agent.tool.error", {
        agentType: definition.agentType,
        tool: tc.name,
        error: msg,
      });
      return `[tool error] ${tc.name}: ${msg}`;
    }
  }

  private async requestApproval(
    agentType: string,
    tc: ToolCall
  ): Promise<boolean> {
    if (!this.deps.onApprovalRequest) {
      return false; // No approval channel → deny by default
    }
    return this.deps.onApprovalRequest({
      agentType,
      toolName: tc.name,
      arguments: tc.arguments,
    });
  }

  private async spawnSubAgent(
    args: SubAgentArgs,
    definition: AgentDefinition
  ): Promise<string> {
    const logger = getLogger();
    const subDef = this.deps.loadAgentDefinition(args.agentType);

    logger.info("agent.subagent.spawn", {
      parentAgent: definition.agentType,
      subAgent: args.agentType,
      task: args.task.slice(0, 200),
    });

    // Notify: sub-agent spawn
    this.deps.onSubAgentSpawn?.(definition.agentType, args.agentType, args.task);

    // Determine isolation mode
    const isolation = await resolveIsolation(
      this.deps.workspaceDir,
      subDef.isolation
    );

    // For worktree isolation, create a separate working directory
    let effectiveWorkspace = this.deps.workspaceDir;
    let worktreeCleanup: (() => Promise<void>) | undefined;

    if (isolation === "worktree") {
      try {
        const handle = await acquireWorktree(
          this.deps.workspaceDir,
          args.agentType
        );
        effectiveWorkspace = handle.worktreeDir;
        worktreeCleanup = handle.cleanup;
      } catch (err) {
        logger.warn("agent.subagent.worktree_failed", {
          subAgent: args.agentType,
          error: err instanceof Error ? err.message : String(err),
        });
        // Fallback to context isolation
      }
    }

    // Acquire concurrency permit
    const release = await this.deps.concurrencyLimiter.acquire();

    try {
      // Create a modified deps with the worktree workspace
      const subDeps = effectiveWorkspace === this.deps.workspaceDir
        ? this.deps
        : { ...this.deps, workspaceDir: effectiveWorkspace };

      const subLoop = new AgentLoop(subDeps);
      const result = await subLoop.run(
        args.task,
        subDef,
        this.deps.costTracker.remaining
      );

      logger.info("agent.subagent.completed", {
        subAgent: args.agentType,
        status: result.status,
        steps: result.steps,
        cost: result.cost,
        isolation,
      });

      const subResult: SubAgentResult = {
        status: result.status,
        content: result.content,
        error: result.error,
        steps: result.steps,
        cost: result.cost,
      };

      // Notify: sub-agent complete
      this.deps.onSubAgentComplete?.(definition.agentType, args.agentType, subResult);

      return JSON.stringify(subResult);
    } finally {
      // Always release the concurrency permit and clean up worktree,
      // even if one of them fails.
      try {
        release();
      } catch (releaseErr) {
        logger.error("agent.subagent.release_failed", {
          subAgent: args.agentType,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }
      if (worktreeCleanup) {
        try {
          await worktreeCleanup();
        } catch (cleanupErr) {
          logger.error("agent.subagent.worktree_cleanup_failed", {
            subAgent: args.agentType,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
    }
  }

  /**
   * Rough token estimate for a message history.
   * Uses the ~4 chars per token heuristic. This is intentionally
   * conservative (over-estimates) for budget pre-flight checks.
   */
  private estimateInputTokens(
    history: (import("../adapters/types.js").Message | import("../adapters/types.js").ToolResult)[]
  ): number {
    let chars = 0;
    for (const msg of history) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ("text" in block && typeof block.text === "string") {
            chars += block.text.length;
          } else if ("content" in block && typeof block.content === "string") {
            chars += block.content.length;
          }
        }
      }
    }
    return Math.ceil(chars / 4);
  }
}
