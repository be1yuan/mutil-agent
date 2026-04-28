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
import { AdapterSelector } from "./adapter-selector.js";
import { getAllowedTools, buildTaskTool } from "./tools.js";
import { executeTool } from "./tool-executor.js";
import { getLogger } from "../observability/logger.js";

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
      // 1. Select model provider
      const provider = this.deps.adapterSelector.select(task, definition);

      const params: ChatParams = {
        model: definition.model,
        system: definition.systemPrompt,
        messages: history,
        tools: allowedTools,
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
      if (this.deps.costTracker.spent > budget) {
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
        const result = await this.executeToolCall(tc, definition);
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

      steps++;
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
      return await this.spawnSubAgent(tc.arguments as unknown as SubAgentArgs, definition);
    }

    // Other tools: execute directly
    try {
      logger.info("agent.tool.executed", {
        agentType: definition.agentType,
        tool: tc.name,
      });
      return await executeTool(tc.name, tc.arguments, this.deps.workspaceDir);
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

    // Acquire concurrency permit
    const release = await this.deps.concurrencyLimiter.acquire();

    try {
      const subLoop = new AgentLoop(this.deps);
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
      });

      const subResult: SubAgentResult = {
        status: result.status,
        content: result.content,
        error: result.error,
        steps: result.steps,
        cost: result.cost,
      };

      return JSON.stringify(subResult);
    } finally {
      release();
    }
  }
}
