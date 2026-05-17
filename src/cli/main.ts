#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { loadConfig, loadAgents } from "../config/loader.js";
import { validateConfig } from "../config/validator.js";
import { createModelAdapter } from "../adapters/anthropic-client.js";
import { FallbackExecutor } from "../adapters/fallback-executor.js";
import { AgentLoop, estimateTokenCount } from "../agent/agent-loop.js";
import { AdapterSelector } from "../agent/adapter-selector.js";
import { PermissionResolver } from "../security/permission-resolver.js";
import { CostTracker } from "../observability/cost-tracker.js";
import { ConcurrencyLimiter } from "../agent/concurrency-limiter.js";
import { Committee, type AggregationStrategy } from "../agent/committee.js";
import { Debate } from "../agent/collaboration/debate.js";
import { ReviewChain } from "../agent/collaboration/review-chain.js";
import { pruneStaleWorktrees } from "../agent/worktree-manager.js";
import { isCheerioAvailable } from "../agent/web-tools.js";
import { Mailbox } from "../agent/mailbox.js";
import { MemoryManager } from "../memory/index.js";
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
import { summarizeToolArgs, style, symbols } from "./ansi.js";
import { DashboardEventBridge } from "./dashboard/event-bridge.js";
import {
  WorkflowEngine,
  WorkflowStateStore,
  loadWorkflow,
  type WorkflowDefinition,
  type WorkflowRun,
} from "../workflow/index.js";
import { matchWorkflow } from "../agent/workflow-matcher.js";
import { handleCommand, findWorkflowByName, fuzzyMatchCommand } from "./repl-commands.js";
import { runWorkflowWizard } from "./workflow-wizard.js";
import { runMeetingWizard } from "./meeting-wizard.js";
import { runAgentWizard } from "./agent-wizard.js";
import { t, toggleLocale } from "./i18n.js";
import { questionWithEsc, ESC } from "./question-with-esc.js";
import type { ModelAdapter } from "../adapters/types.js";
import type { AgentDefinition } from "../agent/types.js";
import type { ModelProvider } from "../types/core.js";
import type { SubAgentResult } from "../adapters/types.js";

// ── Known model catalog (model → provider) ──

const MODEL_CATALOG: { model: string; provider: ModelProvider; label: string }[] = [
  { model: "deepseek-v4-pro",    provider: "deepseek", label: "DeepSeek V4 Pro" },
  { model: "deepseek-v4-flash",  provider: "deepseek", label: "DeepSeek V4 Flash" },
  { model: "glm-4.7",            provider: "zhipu",    label: "GLM 4.7 (Zhipu)" },
  { model: "MiMo-V2.5-Pro",      provider: "mimo",     label: "MiMo V2.5 Pro" },
  { model: "kimi-k2.6",          provider: "kimi",     label: "Kimi K2.6 (DashScope)" },
  { model: "qwen3.6-max-preview", provider: "qwen",    label: "Qwen 3.6 Max Preview (DashScope)" },
];

class Orchestrator {
  private adapters: Map<ModelProvider, ModelAdapter> = new Map();
  private fallbackExecutor!: FallbackExecutor;
  private agentDefinitions: Map<string, AgentDefinition> = new Map();
  private agentSourcePaths: Map<string, string> = new Map();
  private workflowDefinitions: WorkflowDefinition[] = [];
  private workflowMatchCache: Map<string, string> = new Map();
  private logger!: ReturnType<typeof createAppLogger>;
  private config!: import("../config/types.js").OrchestratorConfig;
  private mailbox?: Mailbox;
  private apiServer?: ApiServer;
  memoryManager?: MemoryManager;

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

    // Create adapters — uses auto-detection factory
    // that supports both Anthropic-format and OpenAI-format baseURLs
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      const p = provider as ModelProvider;
      this.adapters.set(p, createModelAdapter(p, providerConfig));
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
      this.agentSourcePaths.set(agentType, loaded.sourcePath);
    }

    // Load workflow definitions
    const wfConfig = config.workflows;
    if (wfConfig) {
      const wfDir = path.join(workspaceDir, wfConfig.dir);
      try {
        const entries = await fs.promises.readdir(wfDir).catch(() => []);
        for (const entry of entries) {
          if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
          try {
            const wf = await loadWorkflow(path.join(wfDir, entry));
            this.workflowDefinitions.push(wf);
          } catch (err) {
            this.logger.warn("orchestrator.workflow.load.failed", {
              file: entry,
              error: (err as Error).message,
            });
          }
        }
        if (this.workflowDefinitions.length > 0) {
          this.logger.info("orchestrator.workflows.loaded", {
            count: this.workflowDefinitions.length,
            names: this.workflowDefinitions.map((w) => w.name),
          });
        }
      } catch {
        // workflows dir doesn't exist — not an error
      }
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

    // Initialize memory manager (defaults are applied by Zod validator)
    if (config.memory?.enabled !== false) {
      const memConfig = config.memory!;
      this.memoryManager = new MemoryManager(memConfig);
      await this.memoryManager.init();
      this.logger.info("orchestrator.memory.initialized", { dir: memConfig.dir });
    }

    this.logger.info("orchestrator.init.complete", {
      providers: Array.from(this.adapters.keys()),
      agents: Array.from(this.agentDefinitions.keys()),
      mailbox: !!this.mailbox,
    });
  }

  async execute(
    task: string | undefined,
    options: { agent?: string; budget?: number; verbose?: boolean; quiet?: boolean; dashboard?: boolean; mode?: "single" | "auto" | "committee" }
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
    const mode = options.mode ?? "auto"; // auto = self-orchestration (AI decides)
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

    // Standard mode — task is always defined here (dashboard returns early)
    const resolvedTask = task!;

    if (!quiet) {
      const modeLabel = mode === "single" ? "single agent" : mode === "auto" ? "self-orchestration" : mode;
      console.log(renderBanner(agentType, definition.model, budget));
      console.log(style.dim(`  Mode: ${modeLabel}`));
      console.log();
    }

    // For "single" mode: disable task tool by creating a modified definition
    let effectiveDefinition = definition;
    if (mode === "single") {
      const { task: _, ...toolsWithoutTask } = definition.tools;
      effectiveDefinition = { ...definition, tools: toolsWithoutTask };
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
      memory: this.memoryManager,
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
          console.log(renderCostStatus(currentStepCost, budget, step, effectiveDefinition.maxSteps));
        }
        currentStepCost = 0;
        console.log();
        console.log(renderStepStart(step, effectiveDefinition.maxSteps));
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
        ? await loop.run(resolvedTask, effectiveDefinition, budget, { initialHistory: conversationHistory })
        : await loop.run(resolvedTask, effectiveDefinition, budget);

      // Preserve history for continuation
      if (result.history) {
        conversationHistory = result.history;
      }

      // Auto-summarize if conversation exceeds threshold
      if (conversationHistory && this.memoryManager) {
        await this.maybeAutoSummarize(
          `session_${Date.now()}`,
          resolvedTask,
          agentType,
          conversationHistory,
          result.content
        );
      }

      // Final cost bar + result
      if (!quiet && currentStepCost > 0) {
        console.log(renderCostStatus(currentStepCost, budget, result.steps, effectiveDefinition.maxSteps));
      }
      console.log();
      console.log(renderResult(result));

      if (result.content && verbose) {
        console.log(`\nContent:\n${result.content}`);
      }

      // ── Post-task prompt (inner loop: /save re-prompts, Esc quits) ──
      while (true) {
        const action = await this.promptPostTaskAction(result, definition, workspaceDir, quiet);
        if (action.type === "exit") {
          return;
        }
        if (action.type === "save" || action.type === "model-switched") {
          continue;
        }
        // Continue conversation
        if (!conversationHistory) {
          conversationHistory = [{ role: "user" as const, content: resolvedTask }];
        }
        conversationHistory.push({ role: "user", content: action.message });
        if (!quiet) {
          console.log();
          console.log(style.dim("─── Continuing conversation ───"));
          console.log();
        }
        break;
      }
    }
  }

  /** Claude Code-style prompt: type to continue, /save to save, /model to switch, Esc to quit */
  private async promptPostTaskAction(
    result: import("../types/core.js").AgentResult,
    definition: AgentDefinition,
    workspaceDir: string,
    _quiet: boolean
  ): Promise<{ type: "exit" } | { type: "save" } | { type: "model-switched" } | { type: "continue"; message: string }> {
    const readline = await import("node:readline");
    const icon = result.status === "success" ? style.success("✓") : result.status === "error" ? style.error("✗") : style.warning("⚠");
    const currentModel = style.dim(`[${definition.model}]`);

    while (true) {
      console.log(`  ${icon} ${result.status} · ${result.steps} steps · ¥${result.cost.toFixed(4)} · ${currentModel} · /save /model`);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const raw = await questionWithEsc(rl, style.bold("  > "));
      rl.close();

      if (raw === ESC || raw === "") {
        return { type: "exit" };
      }

      const answer = raw.toLowerCase();

      if (answer === "/save" || answer === "/s") {
        try {
          const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const filePath = path.join(workspaceDir, `output-${ts}.md`);
          fs.writeFileSync(filePath, result.content ?? "(no content)", "utf-8");
          console.log(style.success(`  Saved to: ${filePath}`));
        } catch (e) {
          console.error(style.error(`  Save failed: ${(e as Error).message}`));
        }
        return { type: "save" };
      }

      if (answer === "/model" || answer === "/models") {
        await this.showModelPicker(definition);
        return { type: "model-switched" };
      }

      if (answer === "/help" || answer === "/h" || answer === "/") {
        console.log();
        console.log(style.bold(`  ${t("help.title")}`));
        console.log(style.dim(`  /save   ${t("help.save")}`));
        console.log(style.dim(`  /model  ${t("help.model")}`));
        console.log(style.dim(`  Esc     ${t("help.exit")}`));
        console.log();
        continue;
      }

      if (answer.startsWith("/")) {
        const cmd = answer.split(/\s+/)[0];
        const hint = fuzzyMatchCommand(cmd);
        console.log(style.warning(`  ${t("cmd.unknown")} ${cmd}`));
        if (hint) {
          console.log(style.dim(`  ${t("cmd.didYouMean")} ${style.bold(hint)}?`));
        }
        console.log(style.dim(`  ${t("cmd.typeHelp")}`));
        console.log();
        continue;
      }

      // Any other text = continue conversation (use original casing)
      return { type: "continue", message: raw };
    }
  }

  /** Show interactive model picker and apply selection to the given definition */
  private async showModelPicker(definition: AgentDefinition): Promise<boolean> {
    const readline = await import("node:readline");

    console.log();
    console.log(style.bold(`  ${t("model.title")}`));
    for (let i = 0; i < MODEL_CATALOG.length; i++) {
      const m = MODEL_CATALOG[i];
      const marker = m.model === definition.model ? style.success(" ●") : "  ";
      console.log(`  ${marker} [${i + 1}] ${m.label}  ${style.dim(m.model)}`);
    }
    console.log();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(style.bold(`  ${t("model.select")} [1-${MODEL_CATALOG.length}, ${t("model.cancel")}]: `), (choice) => {
        rl.close();
        const idx = parseInt(choice.trim(), 10) - 1;
        if (idx >= 0 && idx < MODEL_CATALOG.length) {
          const selected = MODEL_CATALOG[idx];
          definition.model = selected.model;
          definition.provider = selected.provider;
          console.log(style.success(`  ${t("model.switched")} ${selected.label} (${selected.model})`));
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  /** Execute task with ink TUI dashboard. If task is undefined, the TUI prompts for it. */
  private async executeWithDashboard(
    task: string | undefined,
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
      memory: this.memoryManager,
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
        initialTask: task,
        onSave,
      }),
      { patchConsole: false }
    );

    // If no task provided, wait for user to enter it in the TUI
    const actualTask = task ?? await bridge.waitForTask();

    // User cancelled task input (Esc) — clean up and exit
    if (!actualTask) {
      unmount();
      if (useAltScreen) {
        process.stdout.write("\x1b[?1049l");
      }
      return;
    }

    // ── Conversation loop (dashboard mode) ──
    const loop = new AgentLoop(deps);
    let conversationHistory: (import("../adapters/types.js").Message | import("../adapters/types.js").ToolResult)[] | undefined;

    try {
      while (true) {
        // Run the agent loop
        const result = conversationHistory
          ? await loop.run(actualTask, definition, budget, { initialHistory: conversationHistory })
          : await loop.run(actualTask, definition, budget);

        // Preserve history for continuation
        if (result.history) {
          conversationHistory = result.history;
        }

        // Auto-summarize if conversation exceeds threshold
        if (conversationHistory && this.memoryManager) {
          await this.maybeAutoSummarize(
            `session_${Date.now()}`,
            actualTask,
            agentType,
            conversationHistory,
            result.content
          );
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
            conversationHistory = [{ role: "user" as const, content: actualTask }];
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

  /** Interactively prompt for a task description (no subcommand mode).
   *  Slash commands (/model, /workflow, /agent) are handled inline and re-prompt. */
  async promptTask(): Promise<string> {
    const readline = await import("node:readline");
    console.log();
    console.log(style.bold(`  ${t("welcome.title")}`));
    console.log(style.dim(`  ${t("welcome.hint")}`));
    console.log(style.dim(`  ${t("welcome.commands")}`));
    console.log();

    while (true) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await questionWithEsc(rl, "  > ");
      rl.close();

      if (answer === ESC) {
        console.log(style.dim("  Goodbye."));
        process.exit(0);
      }

      const lower = answer.toLowerCase();

      if (lower === "/model" || lower === "/models") {
        const def = this.agentDefinitions.get("main");
        if (def) {
          await this.showModelPicker(def);
          console.log();
        }
        continue;
      }

      if (lower === "/help" || lower === "/h" || lower === "/") {
        console.log();
        console.log(style.bold(`  ${t("help.title")}`));
        console.log(style.dim(`  /model       ${t("help.model")}`));
        console.log(style.dim(`  /meeting     ${t("help.meeting")}`));
        console.log(style.dim(`  /workflow    ${t("help.workflow")}`));
        console.log(style.dim(`  /agent       ${t("help.agent")}`));
        console.log(style.dim(`  /language    ${t("help.language")}`));
        console.log(style.dim(`  Esc          ${t("help.exit")}`));
        console.log();
        continue;
      }

      if (lower === "/language" || lower === "/lang") {
        toggleLocale();
        console.log(style.success(`  ${t("lang.switched")}`));
        console.log();
        continue;
      }

      if (lower === "/meeting" || lower === "/mt") {
        await this.runMeetingWizard();
        continue;
      }

      if (lower === "/agent") {
        await this.agentWizard();
        continue;
      }

      // Handle /workflow commands
      if (lower.startsWith("/workflow") || lower.startsWith("/wf")) {
        const cmdResult = await handleCommand(answer, {
          workflows: this.workflowDefinitions,
          agents: this.agentDefinitions,
          onRunWorkflow: async (name: string) => {
            const wf = findWorkflowByName(name, this.workflowDefinitions);
            if (!wf) {
              console.log(style.error(`  Workflow "${name}" not found.`));
              return;
            }
            await this.runWorkflowByName(wf);
          },
          onListWorkflows: () => this.listLoadedWorkflows(),
          onWorkflowStatus: async (id: string) => { await this.workflowStatus(id); },
          onNewWorkflow: async () => {
            const wfConfig = this.config.workflows;
            const workspaceDir = path.dirname(path.resolve(this.configPath));
            const wfDir = path.join(workspaceDir, wfConfig?.dir ?? ".workflows");
            const result = await runWorkflowWizard(wfDir, this.agentDefinitions, MODEL_CATALOG);
            if (result) {
              this.workflowDefinitions.push(result.definition);
              this.workflowMatchCache.clear(); // invalidate cache after new workflow
            }
          },
          onListAgents: () => this.listAgents(),
        });
        if (cmdResult.continue) {
          console.log();
        }
        continue;
      }

      if (lower.startsWith("/")) {
        const cmd = lower.split(/\s+/)[0];
        const hint = fuzzyMatchCommand(cmd);
        console.log(style.warning(`  ${t("cmd.unknown")} ${cmd}`));
        if (hint) {
          console.log(style.dim(`  ${t("cmd.didYouMean")} ${style.bold(hint)}?`));
        }
        console.log(style.dim(`  ${t("cmd.typeHelp")}`));
        console.log();
        continue;
      }

      if (!answer) {
        console.error(style.error(`  ${t("cmd.taskEmpty")}`));
        console.log();
        continue;
      }

      // Smart workflow matching
      const wfConfig = this.config.workflows;
      if (wfConfig?.autoRecommend !== false && this.workflowDefinitions.length > 0) {
        const match = await this.tryWorkflowMatch(answer);
        if (match) {
          return match; // user accepted — will be handled as workflow run
        }
      }

      return answer;
    }
  }

  /** Try to match user task against loaded workflows. Returns workflow run command or null. */
  private async tryWorkflowMatch(task: string): Promise<string | null> {
    try {
      // Use the cheapest available provider for matching
      const provider = this.getMatchingProvider();
      if (!provider) return null;

      const match = await matchWorkflow(
        task,
        this.workflowDefinitions,
        {
          fallbackExecutor: this.fallbackExecutor,
          model: provider.model,
          provider: provider.provider,
        },
        this.workflowMatchCache
      );

      if (!match.matched || !match.workflowName) return null;

      // Show recommendation
      console.log();
      console.log(style.success(`  ${t("wf.found")} ${style.bold(match.workflowName)}`));
      if (match.workflowDescription) {
        console.log(style.dim(`  ${match.workflowDescription}`));
      }
      console.log(style.dim(`  ${match.stepCount} ${t("wf.steps")}`));
      console.log();

      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`  ${t("wf.use")} `, (ans) => {
          rl.close();
          resolve(ans.trim().toLowerCase());
        });
      });

      if (answer === "n" || answer === "no") {
        return null; // Fall through to normal agent execution
      }

      // Return a marker that signals workflow execution (uses sentinel unlikely to collide with user input)
      return `\x00workflow:${match.workflowName}`;
    } catch {
      return null;
    }
  }

  /** Get the cheapest/fastest provider for lightweight LLM calls. */
  private getMatchingProvider(): { model: string; provider: ModelProvider } | null {
    // Prefer deepseek-v4-flash (cheapest)
    if (this.adapters.has("deepseek")) {
      return { model: "deepseek-v4-flash", provider: "deepseek" };
    }
    if (this.adapters.has("zhipu")) {
      return { model: "glm-4.7", provider: "zhipu" };
    }
    if (this.adapters.has("mimo")) {
      return { model: "MiMo-V2.5-Pro", provider: "mimo" };
    }
    return null;
  }

  /** List loaded workflow definitions. */
  private listLoadedWorkflows(): void {
    if (this.workflowDefinitions.length === 0) {
      console.log(style.dim(`  ${t("wf.none")}`));
      return;
    }
    console.log();
    console.log(style.bold(`  ${t("wf.available")}`));
    for (const wf of this.workflowDefinitions) {
      console.log(`    ${style.bold(wf.name)} — ${wf.description} (${wf.steps.length} ${t("wf.steps")})`);
    }
    console.log();
  }

  /** Run a workflow by its loaded definition. */
  private async runWorkflowByName(wf: WorkflowDefinition): Promise<void> {
    const wfConfig = this.config.workflows;
    const workspaceDir = path.dirname(path.resolve(this.configPath));
    const stateDir = path.join(workspaceDir, wfConfig?.stateDir ?? ".workflow-state");
    const budget = this.config.budget.maxYuan;

    console.log();
    console.log(style.bold(`  Workflow: ${wf.name}`));
    console.log(style.dim(`  ${wf.description}`));
    console.log(style.dim(`  Steps: ${wf.steps.length}`));
    console.log(style.dim(`  Budget: ¥${budget.toFixed(2)}`));
    console.log();

    const deps = this.buildAgentLoopDeps(workspaceDir, budget, false);
    const stateStore = new WorkflowStateStore(stateDir);
    await stateStore.init();

    const engine = new WorkflowEngine({
      agentLoopDeps: deps,
      stateStore,
      onCheckpoint: async (_stepId, message) => {
        console.log();
        console.log(style.warning(`  Checkpoint: ${message}`));
        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question("  Approve? [Y/n] ", (ans) => {
            rl.close();
            resolve(ans.trim().toLowerCase());
          });
        });
        return answer !== "n" && answer !== "no";
      },
      onStepComplete: (stepId, status) => {
        const icon = status === "completed" ? style.success("✓") : style.error("✗");
        console.log(`  ${icon} ${stepId} (${status})`);
      },
    });

    const run = await engine.run(wf, budget);

    // Show summary
    console.log();
    const statusIcon = run.status === "completed"
      ? style.success("✓")
      : run.status === "paused"
        ? style.warning("⏸")
        : style.error("✗");
    console.log(`${statusIcon} Workflow ${run.status} · ${run.steps.length} steps · ¥${run.totalCost.toFixed(4)}`);
  }

  /** Try to run a matched workflow by name. Returns true if handled. */
  async tryRunMatchedWorkflow(name: string): Promise<boolean> {
    const wf = this.workflowDefinitions.find((w) => w.name === name);
    if (!wf) return false;
    await this.runWorkflowByName(wf);
    return true;
  }


  /** Interactively prompt user to choose execution mode */
  async promptModeSelection(): Promise<"single" | "auto" | "committee"> {
    const readline = await import("node:readline");

    console.log();
    console.log(style.dim("──────────────────────────────────────────────"));
    console.log(style.bold(`  ${t("mode.title")}`));
    console.log();
    console.log(`  ${style.bold("1.")} ${t("mode.single")}`);
    console.log(style.dim(`     ${t("mode.single.desc")}`));
    console.log();
    console.log(`  ${style.bold("2.")} ${t("mode.auto")}`);
    console.log(style.dim(`     ${t("mode.auto.desc")}`));
    console.log();
    console.log(`  ${style.bold("3.")} ${t("mode.committee")}`);
    console.log(style.dim(`     ${t("mode.committee.desc")}`));
    console.log(style.dim("──────────────────────────────────────────────"));
    console.log();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(`  Select [1-3, default: 2]: `, (answer) => {
        rl.close();
        const trimmed = answer.trim();
        if (trimmed === "1" || trimmed.toLowerCase() === "s" || trimmed.toLowerCase() === "single") {
          resolve("single");
        } else if (trimmed === "3" || trimmed.toLowerCase() === "c" || trimmed.toLowerCase() === "committee") {
          resolve("committee");
        } else {
          resolve("auto");
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
      memory: this.memoryManager,
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

    // Agent contribution summaries
    console.log();
    console.log(style.bold(`  ── ${t("meeting.contributions")} ──`));
    for (const m of result.members) {
      const preview = m.result.content
        ? m.result.content.slice(0, 150).replace(/\n/g, " ")
        : t("meeting.noOutput");
      const c = m.result.status === "success" ? style.success : style.warning;
      console.log(style.dim(`  [${m.agentType}] ${m.result.steps} steps · ¥${m.result.cost.toFixed(4)}`));
      console.log(`     ${c(`"${preview}..."`)}`);
    }

    if (result.content) {
      console.log(`\n--- Aggregated Output ---\n${result.content}`);
    }

    // Post-task action menu for committee mode (save / exit only — no continue in committee)
    const action = await this.promptCommitteePostTaskAction(result.content, workspaceDir);
    // Only "save" and "exit" — committee doesn't support continuation
  }

  /** /meeting wizard — guided setup for debate, review chain, or committee */
  private async runMeetingWizard(): Promise<void> {
    const meetingResult = await runMeetingWizard(this.agentDefinitions);
    if (!meetingResult) return;

    const budget = this.config.budget.maxYuan;

    if (meetingResult.mode === "debate" && meetingResult.debateConfig) {
      await this.debate(meetingResult.task, meetingResult.debateConfig, budget);
    } else if (meetingResult.mode === "review-chain" && meetingResult.reviewChainConfig) {
      await this.reviewChain(meetingResult.task, meetingResult.reviewChainConfig, budget);
    } else if (meetingResult.mode === "committee" && meetingResult.committeeConfig) {
      await this.committee(meetingResult.task, {
        agents: meetingResult.committeeConfig.agentTypes.join(","),
        strategy: meetingResult.committeeConfig.strategy,
        budget,
      });
    }
  }

  /** /agent wizard — interactive agent management */
  private async agentWizard(): Promise<void> {
    await runAgentWizard(this.agentDefinitions, this.agentSourcePaths, MODEL_CATALOG);
  }

  /** Debate mode — multi-agent multi-round debate */
  async debate(
    task: string,
    debateConfig: import("../agent/collaboration/types.js").DebateConfig,
    budget: number
  ): Promise<void> {
    const workspaceDir = path.dirname(path.resolve(this.configPath));
    const nativeSearch = Object.values(this.config.providers).some((p) => p.nativeSearch === true);

    const deps = this.buildAgentLoopDeps(workspaceDir, budget, false);

    const debate = new Debate(deps);
    const result = await debate.run(task, debateConfig, budget);

    console.log();
    for (const round of result.rounds) {
      console.log(style.bold(`  ── Round ${round.round} ──`));
      for (const resp of round.responses) {
        console.log(style.dim(`  [${resp.agentType}] ${resp.content.slice(0, 200)}...`));
      }
      if (round.scores && round.scores.length > 0) {
        console.log(style.dim("  ── Scores ──"));
        for (const s of round.scores) {
          const bar = "█".repeat(Math.round(s.totalScore / 5)) + "░".repeat(20 - Math.round(s.totalScore / 5));
          console.log(`  ${style.bold(s.agentType.padEnd(12))} ${s.totalScore}分 ${bar}`);
          console.log(`  ${style.dim(`    相关性:${s.dimensions.relevance} 深度:${s.dimensions.depth} 新颖度:${s.dimensions.novelty} 清晰度:${s.dimensions.clarity}`)}`);
          console.log(style.dim(`     💬 ${s.comment}`));
        }
      }
    }

    if (result.moderatorResult) {
      console.log();
      console.log(style.bold(`  ── Moderator [${result.moderatorResult.agentType}] ──`));
      console.log(result.moderatorResult.content);
    }

    // Agent contribution summaries
    const contribs = new Map<string, { steps: number; cost: number; preview: string }>();
    for (const round of result.rounds) {
      for (const resp of round.responses) {
        const prev = contribs.get(resp.agentType);
        if (prev) {
          prev.steps += resp.steps;
          prev.cost += resp.cost;
        } else {
          contribs.set(resp.agentType, { steps: resp.steps, cost: resp.cost, preview: resp.content.slice(0, 120) });
        }
      }
    }
    console.log();
    console.log(style.bold(`  ── ${t("meeting.contributions")} ──`));
    for (const [agentType, c] of contribs) {
      console.log(style.dim(`  [${agentType}] ${c.steps} steps · ¥${c.cost.toFixed(4)} · "${c.preview}..."`));
    }

    const icon = result.status === "success" ? style.success(symbols.ok) : style.error(symbols.fail);
    console.log(`\n  ${icon} ${result.status} · ¥${result.totalCost.toFixed(4)}`);

    await this.promptCommitteePostTaskAction(result.content, workspaceDir);
  }

  /** Review Chain — coder + reviewer iterative improvement */
  async reviewChain(
    task: string,
    reviewConfig: import("../agent/collaboration/types.js").ReviewChainConfig,
    budget: number
  ): Promise<void> {
    const workspaceDir = path.dirname(path.resolve(this.configPath));

    const deps = this.buildAgentLoopDeps(workspaceDir, budget, false);

    const chain = new ReviewChain(deps);
    const result = await chain.run(task, reviewConfig, budget);

    console.log();
    for (const iter of result.iterations) {
      const verdictIcon = iter.accepted ? style.success("✓") : style.error("✗");
      console.log(`  ${style.bold(`Iteration ${iter.iteration}`)} ${verdictIcon}`);
      if (iter.reviewerResult) {
        const verdict = iter.reviewerResult.verdict;
        if (verdict.type === "LGTM" || verdict.type === "APPROVED") {
          console.log(style.success(`    Review: ${verdict.type}`));
        } else {
          const fb = verdict.type === "NEEDS_CHANGES" ? verdict.feedback : "";
          console.log(style.warning(`    Review: NEEDS_CHANGES — ${fb.slice(0, 100)}`));
        }
      }
    }

    // Agent contribution summaries
    let coderSteps = 0, coderCost = 0, reviewerSteps = 0, reviewerCost = 0;
    let coderPreview = "", reviewerPreview = "";
    for (const iter of result.iterations) {
      coderSteps += iter.coderResult.steps;
      coderCost += iter.coderResult.cost;
      if (!coderPreview) coderPreview = iter.coderResult.content.slice(0, 120);
      if (iter.reviewerResult) {
        reviewerSteps += iter.reviewerResult.steps;
        reviewerCost += iter.reviewerResult.cost;
        if (!reviewerPreview) reviewerPreview = iter.reviewerResult.content.slice(0, 120);
      }
    }
    console.log();
    console.log(style.bold(`  ── ${t("meeting.contributions")} ──`));
    console.log(style.dim(`  [coder] ${coderSteps} steps · ¥${coderCost.toFixed(4)} · "${coderPreview}..."`));
    if (reviewerSteps > 0) {
      console.log(style.dim(`  [reviewer] ${reviewerSteps} steps · ¥${reviewerCost.toFixed(4)} · "${reviewerPreview}..."`));
    }

    const icon = result.status === "success" ? style.success(symbols.ok) : style.error(symbols.fail);
    console.log(`\n  ${icon} ${result.status} · ¥${result.totalCost.toFixed(4)}`);

    await this.promptCommitteePostTaskAction(result.content, workspaceDir);
  }

  /** Claude Code-style prompt for committee (no continue — committee is one-shot) */
  private async promptCommitteePostTaskAction(
    content: string | undefined,
    workspaceDir: string
  ): Promise<{ type: "save" } | { type: "exit" }> {
    const readline = await import("node:readline");

    while (true) {
      console.log(style.dim("  /save to save · Esc to quit"));

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const raw = await questionWithEsc(rl, style.bold("  > "));
      rl.close();

      if (raw === ESC || raw === "") {
        return { type: "exit" };
      }

      const answer = raw.toLowerCase();

      if (answer === "/save" || answer === "/s") {
        try {
          const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const filePath = path.join(workspaceDir, `output-${ts}.md`);
          fs.writeFileSync(filePath, content ?? "(no content)", "utf-8");
          console.log(style.success(`  Saved to: ${filePath}`));
        } catch (e) {
          console.error(style.error(`  Save failed: ${(e as Error).message}`));
        }
        return { type: "save" };
      }

      if (answer === "/help" || answer === "/h" || answer === "/") {
        console.log();
        console.log(style.bold(`  ${t("help.title")}`));
        console.log(style.dim(`  /save  ${t("help.save")}`));
        console.log(style.dim(`  Esc    ${t("help.exit")}`));
        console.log();
        continue;
      }

      if (answer.startsWith("/")) {
        const cmd = answer.split(/\s+/)[0];
        const hint = fuzzyMatchCommand(cmd);
        console.log(style.warning(`  ${t("cmd.unknown")} ${cmd}`));
        if (hint) {
          console.log(style.dim(`  ${t("cmd.didYouMean")} ${style.bold(hint)}?`));
        }
        console.log(style.dim(`  ${t("cmd.typeHelp")}`));
        console.log();
        continue;
      }

      // Any other input = exit
      return { type: "exit" };
    }
  }

  /** Start the HTTP API server */
  async serve(options: { host?: string; port?: number; dashboardWeb?: boolean }): Promise<void> {
    const apiConfig = this.config.api;
    const host = options.host ?? apiConfig?.host ?? "127.0.0.1";
    const port = options.port ?? apiConfig?.port ?? 3100;
    const dashboardPort = apiConfig?.dashboard?.port ?? 3101;

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
      memory: this.memoryManager,
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

    // Dashboard web server
    let dashboardProcess: import("node:child_process").ChildProcess | null = null;
    if (options.dashboardWeb || apiConfig?.dashboard?.enabled) {
      const repoRoot = path.resolve(path.dirname(this.configPath));
      const dashPath = path.join(repoRoot, "apps", "dashboard", "src", "server.ts");
      const { spawn } = await import("node:child_process");
      dashboardProcess = spawn("npx", ["tsx", dashPath], {
        env: { ...process.env, PORT: String(dashboardPort), AGENT_API_URL: `http://${host}:${port}` },
        stdio: "inherit",
      });
      dashboardProcess.on("error", () => {
        console.log(style.warning("  Failed to start dashboard. Run 'pnpm dev:dashboard' manually."));
      });
      console.log(style.success(`  Dashboard at http://127.0.0.1:${dashboardPort}`));
    } else {
      console.log(style.dim("  Dashboard: use --dashboard-web to enable web dashboard"));
    }

    console.log();
    console.log("  Press Ctrl+C to stop");

    // Graceful shutdown
    const shutdown = async () => {
      console.log("\nShutting down...");
      if (dashboardProcess) {
        dashboardProcess.kill("SIGTERM");
      }
      await this.apiServer?.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  // ── Workflow methods ──

  async runWorkflow(
    filePath: string,
    options: { budget?: number; quiet?: boolean; variables?: Record<string, string> }
  ): Promise<void> {
    const quiet = options.quiet ?? false;
    const budget = options.budget ?? this.config.budget.maxYuan;
    const workspaceDir = path.dirname(path.resolve(this.configPath));
    const wfConfig = this.config.workflows;
    const stateDir = path.join(workspaceDir, wfConfig?.stateDir ?? ".workflow-state");

    // Load workflow definition
    let definition: WorkflowDefinition;
    try {
      definition = await loadWorkflow(filePath);
    } catch (err) {
      console.error(style.error(`  Failed to load workflow: ${(err as Error).message}`));
      process.exit(1);
    }

    if (!quiet) {
      console.log();
      console.log(style.bold(`  Workflow: ${definition.name}`));
      if (definition.description) {
        console.log(style.dim(`  ${definition.description}`));
      }
      console.log(style.dim(`  Steps: ${definition.steps.length}`));
      console.log(style.dim(`  Budget: ¥${budget.toFixed(2)}`));
      console.log();
    }

    // Build deps
    const deps = this.buildAgentLoopDeps(workspaceDir, budget, quiet);

    // Create engine
    const stateStore = new WorkflowStateStore(stateDir);
    await stateStore.init();

    const engine = new WorkflowEngine({
      agentLoopDeps: deps,
      stateStore,
      onCheckpoint: async (stepId, message) => {
        console.log();
        console.log(style.warning(`  Checkpoint [${stepId}]: ${message}`));

        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>((resolve) => {
          rl.question(style.bold("  Approve? [Y/n]: "), (ans) => {
            rl.close();
            resolve(ans.trim().toLowerCase());
          });
        });

        return answer !== "n" && answer !== "no";
      },
      onStepComplete: quiet
        ? undefined
        : (stepId, status, result) => {
            const icon =
              status === "completed"
                ? style.success("✓")
                : status === "failed"
                  ? style.error("✗")
                  : status === "skipped"
                    ? style.dim("⊘")
                    : style.warning("⏸");
            const cost = result?.cost ? ` ¥${result.cost.toFixed(4)}` : "";
            const steps = result?.steps ? ` ${result.steps} steps` : "";
            console.log(`  ${icon} ${stepId}: ${status}${steps}${cost}`);
          },
      onWorkflowStatusChange: quiet
        ? undefined
        : (status, run) => {
            if (status === "paused") {
              console.log(style.warning(`  Workflow paused (run: ${run.id})`));
              console.log(style.dim(`  Resume with: agent-orch workflow resume ${run.id}`));
            }
          },
    });

    const run = await engine.run(definition, budget, options.variables);

    // Final output
    console.log();
    const statusIcon =
      run.status === "completed"
        ? style.success("✓")
        : run.status === "paused"
          ? style.warning("⏸")
          : style.error("✗");
    console.log(`${statusIcon} Workflow ${run.status}`);
    console.log(style.dim(`  Run ID: ${run.id}`));
    console.log(style.dim(`  Total cost: ¥${run.totalCost.toFixed(4)}`));

    if (run.completedAt) {
      const duration = ((run.completedAt - run.startedAt) / 1000).toFixed(1);
      console.log(style.dim(`  Duration: ${duration}s`));
    }

    // Print step summary
    console.log();
    console.log(style.bold("  Steps:"));
    for (const step of run.steps) {
      const icon =
        step.status === "completed"
          ? style.success("✓")
          : step.status === "failed"
            ? style.error("✗")
            : step.status === "skipped"
              ? style.dim("⊘")
              : step.status === "waiting_approval"
                ? style.warning("⏸")
                : style.dim("○");
      const cost = step.result?.cost ? ` ¥${step.result.cost.toFixed(4)}` : "";
      console.log(`    ${icon} ${step.stepId}: ${step.status}${cost}`);
    }

    // If paused, print resume hint
    if (run.status === "paused") {
      console.log();
      console.log(style.dim(`  Resume: agent-orch workflow resume ${run.id} -c ${this.configPath}`));
    }
  }

  async listWorkflows(): Promise<void> {
    const workspaceDir = path.dirname(path.resolve(this.configPath));
    const wfConfig = this.config.workflows;
    const workflowsDir = path.join(workspaceDir, wfConfig?.dir ?? ".workflows");

    let entries: string[];
    try {
      entries = await fs.promises.readdir(workflowsDir);
    } catch {
      console.log(style.dim("  No workflows directory found."));
      return;
    }

    const yamlFiles = entries.filter((e) => e.endsWith(".yaml") || e.endsWith(".yml"));

    if (yamlFiles.length === 0) {
      console.log(style.dim("  No workflow files found."));
      return;
    }

    console.log(style.bold("  Available workflows:"));
    console.log();

    for (const file of yamlFiles) {
      const filePath = path.join(workflowsDir, file);
      try {
        const def = await loadWorkflow(filePath);
        console.log(`  ${style.bold(def.name)} ${style.dim(`(${file})`)}`);
        if (def.description) {
          console.log(`    ${style.dim(def.description)}`);
        }
        console.log(`    ${style.dim(`${def.steps.length} steps`)}`);
      } catch {
        console.log(`  ${style.error(file)} ${style.dim("(invalid)")}`);
      }
    }

    // Also show recent runs
    const stateDir = path.join(workspaceDir, wfConfig?.stateDir ?? ".workflow-state");
    const stateStore = new WorkflowStateStore(stateDir);
    const runs = await stateStore.listRuns();

    if (runs.length > 0) {
      console.log();
      console.log(style.bold("  Recent runs:"));
      for (const run of runs.slice(0, 10)) {
        const icon =
          run.status === "completed"
            ? style.success("✓")
            : run.status === "paused"
              ? style.warning("⏸")
              : run.status === "running"
                ? style.dim("●")
                : style.error("✗");
        const time = new Date(run.startedAt).toLocaleString();
        console.log(`    ${icon} ${run.id} ${style.dim(`${run.workflowName} · ${time} · ¥${run.totalCost.toFixed(4)}`)}`);
      }
    }
  }

  async workflowStatus(runId: string): Promise<void> {
    const workspaceDir = path.dirname(path.resolve(this.configPath));
    const wfConfig = this.config.workflows;
    const stateDir = path.join(workspaceDir, wfConfig?.stateDir ?? ".workflow-state");
    const stateStore = new WorkflowStateStore(stateDir);

    const run = await stateStore.load(runId);
    if (!run) {
      console.error(style.error(`  Workflow run "${runId}" not found`));
      process.exit(1);
    }

    const icon =
      run.status === "completed"
        ? style.success("✓")
        : run.status === "paused"
          ? style.warning("⏸")
          : run.status === "running"
            ? style.dim("●")
            : style.error("✗");

    console.log();
    console.log(`${icon} ${style.bold(run.workflowName)} ${style.dim(`(${run.id})`)}`);
    console.log(style.dim(`  Status: ${run.status}`));
    console.log(style.dim(`  Total cost: ¥${run.totalCost.toFixed(4)}`));
    console.log(style.dim(`  Started: ${new Date(run.startedAt).toLocaleString()}`));
    if (run.completedAt) {
      const duration = ((run.completedAt - run.startedAt) / 1000).toFixed(1);
      console.log(style.dim(`  Duration: ${duration}s`));
    }

    console.log();
    console.log(style.bold("  Steps:"));
    for (const step of run.steps) {
      const stepIcon =
        step.status === "completed"
          ? style.success("✓")
          : step.status === "failed"
            ? style.error("✗")
            : step.status === "skipped"
              ? style.dim("⊘")
              : step.status === "waiting_approval"
                ? style.warning("⏸")
                : style.dim("○");
      const cost = step.result?.cost ? ` ¥${step.result.cost.toFixed(4)}` : "";
      const content = step.result?.content
        ? ` ${style.dim(step.result.content.slice(0, 80) + (step.result.content.length > 80 ? "..." : ""))}`
        : "";
      console.log(`    ${stepIcon} ${step.stepId}: ${step.status}${cost}${content}`);
    }

    if (run.status === "paused") {
      console.log();
      console.log(style.dim(`  Resume: agent-orch workflow resume ${run.id}`));
    }
  }

  async resumeWorkflow(
    runId: string,
    filePath: string,
    options: { budget?: number; quiet?: boolean }
  ): Promise<void> {
    const quiet = options.quiet ?? false;
    const budget = options.budget ?? this.config.budget.maxYuan;
    const workspaceDir = path.dirname(path.resolve(this.configPath));
    const wfConfig = this.config.workflows;
    const stateDir = path.join(workspaceDir, wfConfig?.stateDir ?? ".workflow-state");

    // Load workflow definition
    let definition: WorkflowDefinition;
    try {
      definition = await loadWorkflow(filePath);
    } catch (err) {
      console.error(style.error(`  Failed to load workflow: ${(err as Error).message}`));
      process.exit(1);
    }

    // Build deps
    const deps = this.buildAgentLoopDeps(workspaceDir, budget, quiet);

    // Create engine
    const stateStore = new WorkflowStateStore(stateDir);
    await stateStore.init();

    const engine = new WorkflowEngine({
      agentLoopDeps: deps,
      stateStore,
      onCheckpoint: async (stepId, message) => {
        console.log();
        console.log(style.warning(`  Checkpoint [${stepId}]: ${message}`));

        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>((resolve) => {
          rl.question(style.bold("  Approve? [Y/n]: "), (ans) => {
            rl.close();
            resolve(ans.trim().toLowerCase());
          });
        });

        return answer !== "n" && answer !== "no";
      },
      onStepComplete: quiet
        ? undefined
        : (stepId, status, result) => {
            const stepIcon =
              status === "completed"
                ? style.success("✓")
                : status === "failed"
                  ? style.error("✗")
                  : status === "skipped"
                    ? style.dim("⊘")
                    : style.warning("⏸");
            const cost = result?.cost ? ` ¥${result.cost.toFixed(4)}` : "";
            console.log(`  ${stepIcon} ${stepId}: ${status}${cost}`);
          },
      onWorkflowStatusChange: quiet
        ? undefined
        : (status, run) => {
            if (status === "paused") {
              console.log(style.warning(`  Workflow paused (run: ${run.id})`));
            }
          },
    });

    const run = await engine.resumeWithDefinition(runId, definition, budget);

    // Final output
    console.log();
    const statusIcon =
      run.status === "completed"
        ? style.success("✓")
        : run.status === "paused"
          ? style.warning("⏸")
          : style.error("✗");
    console.log(`${statusIcon} Workflow ${run.status}`);
    console.log(style.dim(`  Total cost: ¥${run.totalCost.toFixed(4)}`));

    if (run.status === "paused") {
      console.log(style.dim(`  Resume: agent-orch workflow resume ${run.id} -c ${this.configPath}`));
    }
  }

  private buildAgentLoopDeps(workspaceDir: string, budget: number, quiet: boolean) {
    const nativeSearch = Object.values(this.config.providers).some(
      (p) => p.nativeSearch === true
    );

    return {
      adapterSelector: new AdapterSelector(),
      permissionResolver: new PermissionResolver(this.config.security.requireApproval),
      costTracker: new CostTracker(budget),
      concurrencyLimiter: new ConcurrencyLimiter(this.config.security.maxConcurrentAgents),
      adapters: this.adapters,
      fallbackExecutor: this.fallbackExecutor,
      agentTypes: Array.from(this.agentDefinitions.keys()),
      mailbox: this.mailbox,
      memory: this.memoryManager,
      nativeSearch,
      loadAgentDefinition: (type: string) => {
        const def = this.agentDefinitions.get(type);
        if (!def) throw new Error(`Agent "${type}" not found`);
        return def;
      },
      onApprovalRequest: async (req: {
        agentType: string;
        toolName: string;
        arguments: Record<string, unknown>;
      }) => {
        this.logger.info("agent.approval.auto", {
          tool: req.toolName,
          agentType: req.agentType,
        });
        return true;
      },
      workspaceDir,
      onStreamText: quiet
        ? undefined
        : (text: string) => {
            process.stdout.write(text);
          },
    };
  }

  /** Auto-summarize conversation history when it exceeds the threshold. */
  private async maybeAutoSummarize(
    sessionId: string,
    task: string,
    agentType: string,
    history: (import("../adapters/types.js").Message | import("../adapters/types.js").ToolResult)[],
    resultContent?: string
  ): Promise<void> {
    if (!this.memoryManager || !this.config.memory?.autoSummarize) return;

    const threshold = this.config.memory?.summarizationThreshold ?? 8000;
    const tokens = estimateTokenCount(history);
    if (tokens < threshold) return;

    const summaryText = resultContent
      ? `Task result: ${resultContent.slice(0, 500)}`
      : `Conversation reached ${tokens} tokens (threshold: ${threshold})`;

    try {
      await this.memoryManager.summarize(
        sessionId,
        task,
        agentType,
        history,
        summaryText,
        [],
        tokens
      );
      this.logger.info("orchestrator.memory.auto_summarized", {
        sessionId,
        tokens,
        threshold,
      });
    } catch (err) {
      this.logger.warn("orchestrator.memory.summarize_failed", {
        error: (err as Error).message,
      });
    }
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
  .option("-a, --agent <type>", "Agent type to use (default: main)")
  .option("-m, --mode <mode>", "Execution mode: single, auto, committee", "auto")
  .option("-b, --budget <yuan>", "Budget limit in yuan (RMB)", parseFloat)
  .option("-v, --verbose", "Show full tool arguments and return values")
  .option("-q, --quiet", "Only show final result, suppress real-time output")
  .option("-d, --dashboard", "Enable interactive TUI dashboard mode")
  .option("-i, --interactive", "Interactively choose execution mode before starting")
  .action(async (task: string, options: { config: string; agent?: string; mode?: string; budget?: number; verbose?: boolean; quiet?: boolean; dashboard?: boolean; interactive?: boolean }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();

    // Interactive mode selection (overrides -m if used)
    let mode = options.mode ?? "auto";
    if (options.interactive && !options.dashboard) {
      mode = await orchestrator.promptModeSelection();
    }

    if (mode === "committee") {
      await orchestrator.committee(task, {
        agents: "explore,coder,reviewer,architect",
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
        mode: mode as "single" | "auto",
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
  .option("-a, --agents <types>", "Comma-separated agent types", "explore,coder,reviewer,architect")
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
  .option("--dashboard-web", "Also start the web dashboard at http://127.0.0.1:3101")
  .action(async (options: { config: string; host?: string; port?: number; dashboardWeb?: boolean }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();
    await orchestrator.serve({ host: options.host, port: options.port, dashboardWeb: options.dashboardWeb });
  });

program
  .command("init")
  .description("Scaffold a new agent-orch project in the current directory")
  .option("--dashboard", "Include ink + react dependencies for TUI dashboard mode")
  .action(async (options: { dashboard?: boolean }) => {
    await initProject({ dashboard: options.dashboard });
  });

// ── Workflow commands ──

const workflowCmd = program
  .command("workflow")
  .description("Manage and execute workflows");

workflowCmd
  .command("run")
  .description("Execute a workflow from a YAML file")
  .argument("<file>", "Workflow YAML file path")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .option("-b, --budget <yuan>", "Budget limit in yuan (RMB)", parseFloat)
  .option("-q, --quiet", "Suppress real-time output")
  .option("--var <pairs...>", "Override workflow variables (key=value)")
  .action(async (file: string, options: { config: string; budget?: number; quiet?: boolean; var?: string[] }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();

    const variables: Record<string, string> = {};
    if (options.var) {
      for (const pair of options.var) {
        const eqIndex = pair.indexOf("=");
        if (eqIndex > 0) {
          variables[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
        }
      }
    }

    await orchestrator.runWorkflow(file, {
      budget: options.budget,
      quiet: options.quiet,
      variables,
    });
  });

workflowCmd
  .command("list")
  .description("List available workflows and recent runs")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .action(async (options: { config: string }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();
    await orchestrator.listWorkflows();
  });

workflowCmd
  .command("status")
  .description("Show status of a workflow run")
  .argument("<id>", "Workflow run ID")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .action(async (id: string, options: { config: string }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();
    await orchestrator.workflowStatus(id);
  });

workflowCmd
  .command("resume")
  .description("Resume a paused workflow run")
  .argument("<id>", "Workflow run ID")
  .argument("<file>", "Workflow YAML file path")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .option("-b, --budget <yuan>", "Budget limit in yuan (RMB)", parseFloat)
  .option("-q, --quiet", "Suppress real-time output")
  .action(async (id: string, file: string, options: { config: string; budget?: number; quiet?: boolean }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();
    await orchestrator.resumeWorkflow(id, file, {
      budget: options.budget,
      quiet: options.quiet,
    });
  });

// ── Memory commands ──

const memoryCmd = program
  .command("memory")
  .description("Manage agent memory");

memoryCmd
  .command("list")
  .description("List all knowledge entries")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .action(async (options: { config: string }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();

    if (!orchestrator.memoryManager) {
      console.log(style.warning(`  ${t("memory.notEnabled")}`));
      return;
    }

    const entries = await orchestrator.memoryManager.listKnowledge();
    if (entries.length === 0) {
      console.log(style.dim(`  ${t("memory.empty")}`));
      return;
    }
    console.log(style.bold(`  ${t("memory.list")}`));
    console.log();
    for (const entry of entries) {
      const time = new Date(entry.timestamp).toLocaleString();
      const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
      console.log(`  ${style.bold(entry.id)} ${style.dim(`(${entry.type})${tagStr} · ${time}`)}`);
      console.log(`    ${style.dim(entry.content.slice(0, 120) + (entry.content.length > 120 ? "..." : ""))}`);
      console.log();
    }
  });

memoryCmd
  .command("search")
  .description("Search knowledge entries")
  .argument("<query>", "Search query")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .option("-t, --tags <tags>", "Filter by tags (comma-separated)")
  .action(async (query: string, options: { config: string; tags?: string }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();

    if (!orchestrator.memoryManager) {
      console.log(style.warning(`  ${t("memory.notEnabled")}`));
      return;
    }

    const tags = options.tags ? options.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const results = await orchestrator.memoryManager.search(query, tags);
    if (results.length === 0) {
      console.log(style.dim(`  ${t("memory.noResults")} "${query}"`));
      return;
    }
    console.log(style.bold(`  ${t("memory.search")} "${query}" (${results.length} results):`));
    console.log();
    for (const entry of results) {
      const time = new Date(entry.timestamp).toLocaleString();
      console.log(`  ${style.bold(entry.id)} ${style.dim(`(${entry.type}) · ${time}`)}`);
      console.log(`    ${entry.content.slice(0, 160)}`);
      console.log();
    }
  });

memoryCmd
  .command("clear")
  .description("Clear all knowledge entries")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .action(async (options: { config: string }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();

    if (!orchestrator.memoryManager) {
      console.log(style.warning(`  ${t("memory.notEnabled")}`));
      return;
    }

    await orchestrator.memoryManager.clear();
    console.log(style.success(`  ${t("memory.cleared")}`));
  });

// Default action: "agent-orch" or "agent-orch <task>" (no subcommand) — Claude-like UX
program
  .argument("[task]", "Task description (prompts interactively if omitted)")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .option("-a, --agent <type>", "Agent type to use")
  .option("-m, --mode <mode>", "Execution mode: single or committee", "single")
  .option("-b, --budget <yuan>", "Budget limit in yuan (RMB)", parseFloat)
  .option("-v, --verbose", "Show full tool arguments")
  .option("-q, --quiet", "Only show final result")
  .option("-d, --dashboard", "Enable TUI dashboard mode")
  .option("-i, --interactive", "Interactively choose execution mode")
  .action(async (task: string | undefined, options: {
    config: string; agent?: string; mode?: string; budget?: number;
    verbose?: boolean; quiet?: boolean; dashboard?: boolean; interactive?: boolean;
  }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();

    // No task given (or slash command like /models) — prompt interactively
    // Exception: --dashboard without a task enters TUI first and prompts inside
    if (!task || task.startsWith("/")) {
      if (options.dashboard) {
        // Defer task input to the dashboard TUI
        await orchestrator.execute(undefined, {
          agent: options.agent,
          budget: options.budget,
          verbose: options.verbose,
          quiet: options.quiet,
          dashboard: true,
        });
        return;
      }
      task = await orchestrator.promptTask();
    }

    // Handle workflow match marker from smart matching
    if (task.startsWith("\x00workflow:")) {
      const wfName = task.slice("\x00workflow:".length);
      const handled = await orchestrator.tryRunMatchedWorkflow(wfName);
      if (handled) return;
    }

    // Interactive mode selection
    if (options.interactive && !options.dashboard) {
      const mode = await orchestrator.promptModeSelection();
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

// ── Global error handlers (prevent silent exits on Windows) ──

process.on("unhandledRejection", (reason) => {
  console.error(style.error(`\n  Unhandled rejection:`), reason instanceof Error ? reason.message : reason);
  console.error(reason instanceof Error ? reason.stack : "");
});

process.on("uncaughtException", (error) => {
  console.error(style.error(`\n  Uncaught exception: ${error.message}`));
  console.error(error.stack ?? "");
  process.exit(1);
});

program.parse();
