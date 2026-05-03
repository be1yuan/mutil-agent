#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { loadConfig, loadAgents } from "../config/loader.js";
import { validateConfig } from "../config/validator.js";
import { DeepSeekAdapter, GLMAdapter, MiMoAdapter } from "../adapters/anthropic-client.js";
import { FallbackExecutor } from "../adapters/fallback-executor.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { AdapterSelector } from "../agent/adapter-selector.js";
import { PermissionResolver } from "../security/permission-resolver.js";
import { CostTracker } from "../observability/cost-tracker.js";
import { ConcurrencyLimiter } from "../agent/concurrency-limiter.js";
import { Committee, type AggregationStrategy } from "../agent/committee.js";
import { pruneStaleWorktrees } from "../agent/worktree-manager.js";
import { isCheerioAvailable } from "../agent/web-tools.js";
import { Mailbox } from "../agent/mailbox.js";
import { ApiServer } from "../api/server.js";
import { createAppLogger, setLogger } from "../observability/logger.js";
import {
  renderBanner,
  renderStepStart,
  renderToolStart,
  renderToolComplete,
  renderSubAgentSpawn,
  renderSubAgentComplete,
  renderCostStatus,
  renderResult,
  renderCommitteeResult,
} from "./status-renderer.js";
import { initProject } from "./init.js";
import { summarizeToolArgs, style } from "./ansi.js";
import { DashboardEventBridge } from "./dashboard/event-bridge.js";
import type { ModelAdapter } from "../adapters/types.js";
import type { AgentDefinition } from "../agent/types.js";
import type { ModelProvider } from "../types/core.js";
import type { SubAgentResult } from "../adapters/types.js";

// ── Orchestrator ──

class Orchestrator {
  private adapters: Map<ModelProvider, ModelAdapter> = new Map();
  private fallbackExecutor!: FallbackExecutor;
  private agentDefinitions: Map<string, AgentDefinition> = new Map();
  private logger!: ReturnType<typeof createAppLogger>;
  private config!: import("../config/types.js").OrchestratorConfig;
  private mailbox?: Mailbox;
  private apiServer?: ApiServer;

  constructor(
    private configPath: string,
    private agentsDir: string
  ) {}

  async init(): Promise<void> {
    // Load and validate config
    const rawConfig = await loadConfig(this.configPath);
    this.config = validateConfig(rawConfig);
    const config = this.config;

    // Setup logger
    this.logger = createAppLogger(config.observability);
    setLogger(this.logger);

    // Prune stale worktrees from previous runs
    const workspaceDir = path.dirname(path.resolve(this.configPath));
    await pruneStaleWorktrees(workspaceDir);

    // Create adapters
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      if (provider === "deepseek") {
        this.adapters.set(provider as ModelProvider, new DeepSeekAdapter(providerConfig.apiKey, providerConfig.nativeSearch));
      } else if (provider === "zhipu") {
        this.adapters.set(provider as ModelProvider, new GLMAdapter(providerConfig.apiKey));
      } else if (provider === "mimo") {
        this.adapters.set(provider as ModelProvider, new MiMoAdapter(providerConfig.apiKey, providerConfig.nativeSearch));
      }
    }

    // Setup fallback executor
    this.fallbackExecutor = new FallbackExecutor(
      this.adapters,
      config.fallback
    );

    // Load agent definitions
    const loadedAgents = await loadAgents(this.agentsDir);
    for (const [agentType, loaded] of loadedAgents) {
      this.agentDefinitions.set(agentType, loaded.definition);
    }

    // Initialize mailbox (opt-in: must explicitly set enabled: true)
    if (config.mailbox?.enabled === true) {
      const mailboxDir = path.join(workspaceDir, config.mailbox?.dir ?? ".mailbox");
      this.mailbox = new Mailbox(mailboxDir, {
        pollIntervalMs: config.mailbox?.pollIntervalMs,
        maxAgeMs: config.mailbox?.maxAgeMs,
      });
      await this.mailbox.init();
      this.logger.info("orchestrator.mailbox.initialized", { dir: mailboxDir });
    }

    this.logger.info("orchestrator.init.complete", {
      providers: Array.from(this.adapters.keys()),
      agents: Array.from(this.agentDefinitions.keys()),
      mailbox: !!this.mailbox,
    });
  }

  async execute(
    task: string,
    options: { agent?: string; budget?: number; verbose?: boolean; quiet?: boolean; dashboard?: boolean }
  ): Promise<void> {
    const agentType = options.agent ?? "main";
    const definition = this.agentDefinitions.get(agentType);
    if (!definition) {
      console.error(`Agent "${agentType}" not found. Available: ${Array.from(this.agentDefinitions.keys()).join(", ")}`);
      process.exit(1);
    }

    const budget = options.budget ?? this.config.budget.maxYuan;
    const verbose = options.verbose ?? false;
    const quiet = options.quiet ?? false;
    const dashboard = options.dashboard ?? false;
    const workspaceDir = path.dirname(path.resolve(this.configPath));

    // Determine if the selected provider uses native web search
    const defaultProvider = definition.provider ?? "deepseek";
    const providerConf = this.config.providers[defaultProvider];
    const nativeSearch = providerConf?.nativeSearch === true;

    // Dashboard mode: use ink TUI
    if (dashboard) {
      await this.executeWithDashboard(task, definition, budget, agentType, workspaceDir, nativeSearch, defaultProvider);
      return;
    }

    // Standard mode
    if (!quiet) {
      console.log(renderBanner(agentType, definition.model, budget));
      console.log();
    }

    // Build deps (shared across conversation rounds)
    let currentStepCost = 0;
    const deps = {
      adapterSelector: new AdapterSelector(),
      permissionResolver: new PermissionResolver(this.config.security.requireApproval),
      costTracker: new CostTracker(budget),
      concurrencyLimiter: new ConcurrencyLimiter(this.config.security.maxConcurrentAgents),
      adapters: this.adapters,
      fallbackExecutor: this.fallbackExecutor,
      agentTypes: Array.from(this.agentDefinitions.keys()),
      mailbox: this.mailbox,
      nativeSearch,
      loadAgentDefinition: (type: string) => {
        const def = this.agentDefinitions.get(type);
        if (!def) throw new Error(`Agent "${type}" not found`);
        return def;
      },
      onApprovalRequest: async (req: { agentType: string; toolName: string; arguments: Record<string, unknown> }) => {
        this.logger.info("agent.approval.auto", { tool: req.toolName, agentType: req.agentType });
        return true;
      },
      workspaceDir,
      onStreamText: quiet ? undefined : (text: string) => {
        process.stdout.write(text);
      },
      onStepStart: quiet ? undefined : (step: number) => {
        if (step > 0 && currentStepCost > 0) {
          console.log(renderCostStatus(currentStepCost, budget, step, definition.maxSteps));
        }
        currentStepCost = 0;
        console.log();
        console.log(renderStepStart(step, definition.maxSteps));
      },
      onToolStart: quiet ? undefined : (_agentType: string, toolName: string, args: Record<string, unknown>) => {
        const detail = verbose ? JSON.stringify(args) : summarizeToolArgs(toolName, args);
        process.stdout.write(renderToolStart(toolName, detail, verbose));
      },
      onToolComplete: quiet ? undefined : (_agentType: string, toolName: string, duration: number, success: boolean) => {
        const status = success
          ? style.success(`  ✓ ${duration}ms`)
          : style.error(`  ✗ ${duration}ms`);
        console.log(status);
      },
      onSubAgentSpawn: quiet ? undefined : (parent: string, child: string, subTask: string) => {
        console.log(renderSubAgentSpawn(parent, child, subTask));
      },
      onSubAgentComplete: quiet ? undefined : (_parent: string, child: string, result: SubAgentResult) => {
        console.log(renderSubAgentComplete(child, result.status, result.cost));
      },
      onBudgetUpdate: quiet ? undefined : (spent: number, _remaining: number) => {
        currentStepCost = spent;
      },
    };

    // ── Conversation loop ──
    const loop = new AgentLoop(deps);
    let conversationHistory: (import("../adapters/types.js").Message | import("../adapters/types.js").ToolResult)[] | undefined;

    while (true) {
      // Run the agent loop
      const result = conversationHistory
        ? await loop.run(task, definition, budget, { initialHistory: conversationHistory })
        : await loop.run(task, definition, budget);

      // Preserve history for continuation
      if (result.history) {
        conversationHistory = result.history;
      }

      // Final cost bar + result
      if (!quiet && currentStepCost > 0) {
        console.log(renderCostStatus(currentStepCost, budget, result.steps, definition.maxSteps));
      }
      console.log();
      console.log(renderResult(result));

      if (result.content && verbose) {
        console.log(`\nContent:\n${result.content}`);
      }

      // ── Post-task action menu (inner loop: save re-shows menu) ──
      while (true) {
        const action = await this.promptPostTaskAction(result, workspaceDir, quiet);
        if (action.type === "exit") {
          return; // Exit the entire conversation loop
        }
        if (action.type === "save") {
          // Save is handled inside promptPostTaskAction; re-show menu
          continue;
        }
        if (action.type === "continue") {
          if (!conversationHistory) {
            conversationHistory = [{ role: "user" as const, content: task }];
          }
          conversationHistory.push({ role: "user", content: action.message });
          if (!quiet) {
            console.log();
            console.log(style.dim("─── Continuing conversation ───"));
            console.log();
          }
          break; // Break inner loop to re-run agent
        }
        break;
      }
    }
  }

  /** Prompt user for post-task action (continue / save / exit) */
  private async promptPostTaskAction(
    result: import("../types/core.js").AgentResult,
    workspaceDir: string,
    quiet: boolean
  ): Promise<{ type: "exit" } | { type: "save" } | { type: "continue"; message: string }> {
    const readline = await import("node:readline");

    const statusIcon = result.status === "success" ? "✓" : result.status === "error" ? "✗" : "⚠";
    const statusColor = result.status === "success" ? "\x1b[32m" : result.status === "error" ? "\x1b[31m" : "\x1b[33m";
    const reset = "\x1b[0m";

    console.log();
    console.log(`${statusColor}${statusIcon}${reset} ${statusColor}${result.status.toUpperCase()}${reset}  Steps: ${result.steps}  Cost: ¥${result.cost.toFixed(4)}`);
    console.log(style.dim("──────────────────────────────────────────────"));
    console.log(`  ${style.bold("1.")} Continue chatting`);
    console.log(`  ${style.bold("2.")} Save result to file`);
    console.log(`  ${style.bold("3.")} Exit`);
    console.log(style.dim("──────────────────────────────────────────────"));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(`  Select [1-3] or type a message to continue: `, (answer) => {
        rl.close();
        const trimmed = answer.trim();

        if (trimmed === "2") {
          // Save result
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const filePath = path.join(workspaceDir, `output-${ts}.md`);
            fs.writeFileSync(filePath, result.content ?? "(no content)", "utf-8");
            console.log(style.success(`  ✓ Saved to: ${filePath}`));
          } catch (e) {
            console.error(style.error(`  ✗ Save failed: ${(e as Error).message}`));
          }
          resolve({ type: "save" });
        } else if (trimmed === "3" || trimmed === "") {
          resolve({ type: "exit" });
        } else if (trimmed === "1") {
          // Continue — need to get the follow-up message
          const rl2 = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl2.question(`  Your message: `, (msg) => {
            rl2.close();
            if (msg.trim()) {
              resolve({ type: "continue", message: msg.trim() });
            } else {
              resolve({ type: "exit" });
            }
          });
        } else {
          // Treat as follow-up message directly
          resolve({ type: "continue", message: trimmed });
        }
      });
    });
  }

  /** Execute task with ink TUI dashboard */
  private async executeWithDashboard(
    task: string,
    definition: AgentDefinition,
    budget: number,
    agentType: string,
    workspaceDir: string,
    nativeSearch: boolean,
    provider: string
  ): Promise<void> {
    // Lazy-load ink and React to avoid overhead when not using dashboard
    const { render } = await import("ink");
    const React = await import("react");
    const { App } = await import("./dashboard/app.js");

    // Create event bridge
    const bridge = new DashboardEventBridge();

    // Build base deps (no lifecycle callbacks — bridge provides them)
    const baseDeps = {
      adapterSelector: new AdapterSelector(),
      permissionResolver: new PermissionResolver(this.config.security.requireApproval),
      costTracker: new CostTracker(budget),
      concurrencyLimiter: new ConcurrencyLimiter(this.config.security.maxConcurrentAgents),
      adapters: this.adapters,
      fallbackExecutor: this.fallbackExecutor,
      agentTypes: Array.from(this.agentDefinitions.keys()),
      mailbox: this.mailbox,
      nativeSearch,
      loadAgentDefinition: (type: string) => {
        const def = this.agentDefinitions.get(type);
        if (!def) throw new Error(`Agent "${type}" not found`);
        return def;
      },
      onApprovalRequest: async (_req: { agentType: string; toolName: string; arguments: Record<string, unknown> }) => {
        this.logger.info("agent.approval.auto", { tool: _req.toolName, agentType: _req.agentType });
        return true;
      },
      workspaceDir,
    };

    // Wrap deps with bridge callbacks
    const deps = bridge.createDeps(baseDeps);

    // Save callback: writes content to a timestamped file in the workspace
    const onSave = (content: string): string | undefined => {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filePath = path.join(workspaceDir, `output-${ts}.md`);
        fs.writeFileSync(filePath, content, "utf-8");
        return filePath;
      } catch (e) {
        console.error(`Save failed: ${(e as Error).message}`);
        return undefined;
      }
    };

    // Enter alternate screen buffer to prevent repeated frame output on Windows.
    const useAltScreen = process.stdout.isTTY;
    if (useAltScreen) {
      process.stdout.write("\x1b[?1049h");
      process.stdout.write("\x1b[2J");
      process.stdout.write("\x1b[H");
    }

    // Render Dashboard UI
    const { unmount, waitUntilExit } = render(
      React.createElement(App, {
        bridge,
        agentType,
        model: definition.model,
        provider,
        budget,
        maxSteps: definition.maxSteps,
        onSave,
      }),
      { patchConsole: false }
    );

    // ── Conversation loop (dashboard mode) ──
    const loop = new AgentLoop(deps);
    let conversationHistory: (import("../adapters/types.js").Message | import("../adapters/types.js").ToolResult)[] | undefined;

    try {
      while (true) {
        // Run the agent loop
        const result = conversationHistory
          ? await loop.run(task, definition, budget, { initialHistory: conversationHistory })
          : await loop.run(task, definition, budget);

        // Preserve history for continuation
        if (result.history) {
          conversationHistory = result.history;
        }

        // Signal done to dashboard
        bridge.emitDone(result.status, result.steps, result.cost, result.content);

        // Wait for user action (continue / save / exit)
        const action = await bridge.waitForUserAction();

        if (action.type === "exit") {
          break;
        }

        if (action.type === "continue") {
          if (!conversationHistory) {
            conversationHistory = [{ role: "user" as const, content: task }];
          }
          conversationHistory.push({ role: "user", content: action.message });
          bridge.resetForContinuation();
          continue;
        }

        if (action.type === "save") {
          // Save is handled inside the Dashboard component via onSave callback
          // Just loop back to show the action menu again
          continue;
        }
      }

      unmount();
      if (useAltScreen) {
        process.stdout.write("\x1b[?1049l");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bridge.emitDone("error", 0, 0, msg);
      await waitUntilExit();
      unmount();
      if (useAltScreen) {
        process.stdout.write("\x1b[?1049l");
      }
      console.error(`Error: ${msg}`);
    }
  }

  listAgents(): void {
    console.log("Available agents:");
    for (const [agentType, def] of this.agentDefinitions) {
      console.log(`  ${agentType}: ${def.description ?? "No description"} (${def.model})`);
    }
  }

  /** Interactively prompt user to choose execution mode */
  async promptModeSelection(task: string): Promise<"single" | "committee"> {
    const readline = await import("node:readline");

    console.log();
    console.log(style.dim("──────────────────────────────────────────────"));
    console.log(style.bold("  How would you like to execute this task?"));
    console.log();
    console.log(`  ${style.bold("1.")} Single Agent`);
    console.log(style.dim("     Main agent handles everything — fast, efficient, good for straightforward tasks"));
    console.log();
    console.log(`  ${style.bold("2.")} Multi-Agent Committee`);
    console.log(style.dim("     explore + coder + reviewer work in parallel — thorough, good for complex tasks"));
    console.log(style.dim("──────────────────────────────────────────────"));
    console.log();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(`  Select [1-2, default: 1]: `, (answer) => {
        rl.close();
        const trimmed = answer.trim();
        if (trimmed === "2" || trimmed.toLowerCase() === "c" || trimmed.toLowerCase() === "committee") {
          resolve("committee");
        } else {
          resolve("single");
        }
      });
    });
  }

  async committee(
    task: string,
    options: { agents?: string; strategy?: string; budget?: number; verbose?: boolean; quiet?: boolean; dashboard?: boolean }
  ): Promise<void> {
    // Dashboard is not yet supported for committee mode
    if (options.dashboard) {
      console.warn(style.warning("  Warning: --dashboard is not supported in committee mode. Ignoring."));
    }

    // Support both comma and space as delimiters (PowerShell expands commas into spaces)
    const agentTypes = (options.agents ?? "explore,coder,reviewer")
      .split(/[,\s]+/)
      .map((a: string) => a.trim())
      .filter(Boolean);
    const strategy = (options.strategy ?? "concat") as AggregationStrategy;
    const budget = options.budget ?? this.config.budget.maxYuan;
    const quiet = options.quiet ?? false;

    // Validate agent types
    for (const at of agentTypes) {
      if (!this.agentDefinitions.has(at)) {
        console.error(`Agent "${at.trim()}" not found. Available: ${Array.from(this.agentDefinitions.keys()).join(", ")}`);
        process.exit(1);
      }
    }

    const workspaceDir = path.dirname(path.resolve(this.configPath));

    // In committee mode, check if any provider has nativeSearch enabled
    const nativeSearch = Object.values(this.config.providers).some(p => p.nativeSearch === true);

    const deps = {
      adapterSelector: new AdapterSelector(),
      permissionResolver: new PermissionResolver(this.config.security.requireApproval),
      costTracker: new CostTracker(budget),
      concurrencyLimiter: new ConcurrencyLimiter(this.config.security.maxConcurrentAgents),
      adapters: this.adapters,
      fallbackExecutor: this.fallbackExecutor,
      agentTypes: Array.from(this.agentDefinitions.keys()),
      mailbox: this.mailbox,
      nativeSearch,
      loadAgentDefinition: (type: string) => {
        const def = this.agentDefinitions.get(type);
        if (!def) throw new Error(`Agent "${type}" not found`);
        return def;
      },
      onApprovalRequest: async (req: { agentType: string; toolName: string; arguments: Record<string, unknown> }) => {
        this.logger.info("agent.approval.auto", { tool: req.toolName, agentType: req.agentType });
        return true;
      },
      workspaceDir,
      onStreamText: quiet ? undefined : (text: string) => {
        process.stdout.write(text);
      },
    };

    const committee = new Committee(deps);
    const result = await committee.run(task, {
      agentTypes,
      strategy,
    }, budget);

    // Render committee result
    console.log();
    console.log(renderCommitteeResult({
      status: result.status,
      strategy: result.strategy,
      members: result.members,
      totalCost: result.totalCost,
      totalSteps: result.totalSteps,
      content: result.content,
    }));

    if (result.content) {
      console.log(`\n--- Aggregated Output ---\n${result.content}`);
    }

    // Post-task action menu for committee mode (save / exit only — no continue in committee)
    const action = await this.promptCommitteePostTaskAction(result.content, workspaceDir);
    // Only "save" and "exit" — committee doesn't support continuation
  }

  /** Post-task menu for committee mode (no continue — committee is one-shot) */
  private async promptCommitteePostTaskAction(
    content: string | undefined,
    workspaceDir: string
  ): Promise<{ type: "save" } | { type: "exit" }> {
    const readline = await import("node:readline");

    console.log(style.dim("──────────────────────────────────────────────"));
    console.log(`  ${style.bold("1.")} Save result to file`);
    console.log(`  ${style.bold("2.")} Exit`);
    console.log(style.dim("──────────────────────────────────────────────"));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(`  Select [1-2, default: 2]: `, (answer) => {
        rl.close();
        const trimmed = answer.trim();

        if (trimmed === "1") {
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const filePath = path.join(workspaceDir, `output-${ts}.md`);
            fs.writeFileSync(filePath, content ?? "(no content)", "utf-8");
            console.log(style.success(`  ✓ Saved to: ${filePath}`));
          } catch (e) {
            console.error(style.error(`  ✗ Save failed: ${(e as Error).message}`));
          }
          resolve({ type: "save" });
        } else {
          resolve({ type: "exit" });
        }
      });
    });
  }

  /** Start the HTTP API server */
  async serve(options: { host?: string; port?: number }): Promise<void> {
    const apiConfig = this.config.api;
    const host = options.host ?? apiConfig?.host ?? "127.0.0.1";
    const port = options.port ?? apiConfig?.port ?? 3100;

    const workspaceDir = path.dirname(path.resolve(this.configPath));
    const budget = this.config.budget.maxYuan;
    const nativeSearch = Object.values(this.config.providers).some(p => p.nativeSearch === true);

    const deps: import("../agent/agent-loop.js").AgentLoopDeps = {
      adapterSelector: new AdapterSelector(),
      permissionResolver: new PermissionResolver(this.config.security.requireApproval),
      costTracker: new CostTracker(budget),
      concurrencyLimiter: new ConcurrencyLimiter(this.config.security.maxConcurrentAgents),
      adapters: this.adapters,
      fallbackExecutor: this.fallbackExecutor,
      agentTypes: Array.from(this.agentDefinitions.keys()),
      mailbox: this.mailbox,
      nativeSearch,
      loadAgentDefinition: (type: string) => {
        const def = this.agentDefinitions.get(type);
        if (!def) throw new Error(`Agent "${type}" not found`);
        return def;
      },
      onApprovalRequest: async (_req: { agentType: string; toolName: string; arguments: Record<string, unknown> }) => {
        return true; // Auto-approve in API mode
      },
      workspaceDir,
    };

    this.apiServer = new ApiServer(this.config, {
      host,
      port,
      authToken: apiConfig?.authToken,
      cors: apiConfig?.cors ?? true,
    }, this.agentDefinitions, deps);

    await this.apiServer.start();

    console.log(style.success(`  API server running at http://${host}:${port}`));
    console.log(style.dim(`  Endpoints: POST /api/tasks, GET /api/tasks/:id, GET /api/tasks/:id/stream`));
    console.log(style.dim(`  Agents: ${Array.from(this.agentDefinitions.keys()).join(", ")}`));
    console.log(style.dim(`  Mailbox: ${this.mailbox ? "enabled" : "disabled"}`));
    console.log();
    console.log("  Press Ctrl+C to stop");

    // Graceful shutdown
    const shutdown = async () => {
      console.log("\nShutting down...");
      await this.apiServer?.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

// ── CLI ──

const program = new Command();

program
  .name("agent-orch")
  .description("Lightweight self-orchestrating multi-agent CLI")
  .version("1.0.0");

program
  .command("run")
  .description("Execute a task with an agent")
  .argument("<task>", "Task description")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .option("-a, --agent <type>", "Agent type to use (default: auto-select)")
  .option("-m, --mode <mode>", "Execution mode: single or committee", "single")
  .option("-b, --budget <yuan>", "Budget limit in yuan (RMB)", parseFloat)
  .option("-v, --verbose", "Show full tool arguments and return values")
  .option("-q, --quiet", "Only show final result, suppress real-time output")
  .option("-d, --dashboard", "Enable interactive TUI dashboard mode")
  .option("-i, --interactive", "Interactively choose execution mode before starting")
  .action(async (task: string, options: { config: string; agent?: string; mode?: string; budget?: number; verbose?: boolean; quiet?: boolean; dashboard?: boolean; interactive?: boolean }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();

    // Interactive mode selection
    if (options.interactive && !options.dashboard) {
      const mode = await orchestrator.promptModeSelection(task);
      options.mode = mode;
    }

    if (options.mode === "committee") {
      await orchestrator.committee(task, {
        agents: "explore,coder,reviewer",
        strategy: "concat",
        budget: options.budget,
        verbose: options.verbose,
        quiet: options.quiet,
        dashboard: options.dashboard,
      });
    } else {
      await orchestrator.execute(task, {
        agent: options.agent,
        budget: options.budget,
        verbose: options.verbose,
        quiet: options.quiet,
        dashboard: options.dashboard,
      });
    }
  });

program
  .command("list-agents")
  .description("List available agents")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .action(async (options: { config: string }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();
    orchestrator.listAgents();
  });

program
  .command("validate")
  .description("Validate configuration and agent definitions")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .action(async (options: { config: string }) => {
    try {
      const rawConfig = await loadConfig(options.config);
      validateConfig(rawConfig);
      console.log("Configuration is valid.");

      const agentsDir = path.join(path.dirname(options.config), ".agents");
      const agents = await loadAgents(agentsDir);
      console.log(`Loaded ${agents.size} agent definitions.`);
      for (const [agentType, loaded] of agents) {
        console.log(`  ${agentType}: ${loaded.definition.model}`);
      }

      // Optional dependency checks
      const checks: { label: string; status: "ok" | "warn" | "info" | "error"; message: string }[] = [];

      // ink + react (dashboard)
      try {
        await import("ink");
        await import("react");
        checks.push({ label: "ink + react", status: "ok", message: "Dashboard support available" });
      } catch {
        checks.push({ label: "ink + react", status: "warn", message: "Not installed — dashboard requires `npm install ink react`" });
      }

      // cheerio (WebFetch HTML extraction)
      if (!isCheerioAvailable()) {
        checks.push({ label: "cheerio", status: "info", message: "Not installed — WebFetch will use regex-based extraction. Install: `npm install cheerio`" });
      } else {
        checks.push({ label: "cheerio", status: "ok", message: "WebFetch HTML extraction enhanced" });
      }

      // Node.js version
      const nodeVersion = process.versions.node.split(".").map(Number);
      if (nodeVersion[0] >= 20) {
        checks.push({ label: "Node.js", status: "ok", message: `${process.version} (>= 20)` });
      } else {
        checks.push({ label: "Node.js", status: "error", message: `v${process.version} — requires >= 20` });
      }

      // Git (worktree isolation)
      try {
        const { execSync } = await import("node:child_process");
        execSync("git --version", { stdio: "pipe" });
        checks.push({ label: "git", status: "ok", message: "Worktree isolation available" });
      } catch {
        checks.push({ label: "git", status: "warn", message: "Not found — worktree isolation unavailable" });
      }

      // .env file
      const envPath = path.join(path.dirname(options.config), ".env");
      try {
        const { access } = await import("node:fs/promises");
        await access(envPath);
        checks.push({ label: ".env", status: "ok", message: "Environment file present" });
      } catch {
        checks.push({ label: ".env", status: "warn", message: "Not found — API keys may be missing" });
      }

      if (checks.length > 0) {
        console.log("\nEnvironment checks:");
        for (const check of checks) {
          const icon = check.status === "ok" ? "✅" : check.status === "warn" ? "⚠️ " : check.status === "error" ? "🔴" : "ℹ️ ";
          console.log(`  ${icon} ${check.label} — ${check.message}`);
        }
      }
    } catch (error) {
      console.error(`Validation failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("committee")
  .description("Run multiple agents in parallel (Committee mode)")
  .argument("<task>", "Task description")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .option("-a, --agents <types>", "Comma-separated agent types", "explore,coder,reviewer")
  .option("-s, --strategy <strategy>", "Aggregation strategy: concat, majority, best", "concat")
  .option("-b, --budget <yuan>", "Budget limit in yuan (RMB)", parseFloat)
  .option("-v, --verbose", "Show full tool arguments and return values")
  .option("-q, --quiet", "Only show final result, suppress real-time output")
  .option("-d, --dashboard", "Enable interactive TUI dashboard mode")
  .action(async (task: string, options: { config: string; agents?: string; strategy?: string; budget?: number; verbose?: boolean; quiet?: boolean; dashboard?: boolean }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();
    await orchestrator.committee(task, options);
  });

program
  .command("serve")
  .description("Start the HTTP API server")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .option("--host <host>", "Bind host (default: 127.0.0.1)")
  .option("--port <port>", "Bind port (default: 3100)", parseInt)
  .action(async (options: { config: string; host?: string; port?: number }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();
    await orchestrator.serve(options);
  });

program
  .command("init")
  .description("Scaffold a new agent-orch project in the current directory")
  .option("--dashboard", "Include ink + react dependencies for TUI dashboard mode")
  .action(async (options: { dashboard?: boolean }) => {
    await initProject({ dashboard: options.dashboard });
  });

program.parse();
