#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
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
import { createAppLogger, setLogger } from "../observability/logger.js";
import type { ModelAdapter } from "../adapters/types.js";
import type { AgentDefinition } from "../agent/types.js";
import type { ModelProvider } from "../types/core.js";

// ── Orchestrator ──

class Orchestrator {
  private adapters: Map<ModelProvider, ModelAdapter> = new Map();
  private fallbackExecutor!: FallbackExecutor;
  private agentDefinitions: Map<string, AgentDefinition> = new Map();
  private logger!: ReturnType<typeof createAppLogger>;
  private config!: import("../config/types.js").OrchestratorConfig;

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
        this.adapters.set(provider as ModelProvider, new DeepSeekAdapter(providerConfig.apiKey));
      } else if (provider === "zhipu") {
        this.adapters.set(provider as ModelProvider, new GLMAdapter(providerConfig.apiKey));
      } else if (provider === "mimo") {
        this.adapters.set(provider as ModelProvider, new MiMoAdapter(providerConfig.apiKey));
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

    this.logger.info("orchestrator.init.complete", {
      providers: Array.from(this.adapters.keys()),
      agents: Array.from(this.agentDefinitions.keys()),
    });
  }

  async execute(task: string, options: { agent?: string; budget?: number }): Promise<void> {
    const agentType = options.agent ?? "main";
    const definition = this.agentDefinitions.get(agentType);
    if (!definition) {
      console.error(`Agent "${agentType}" not found. Available: ${Array.from(this.agentDefinitions.keys()).join(", ")}`);
      process.exit(1);
    }

    const budget = options.budget ?? this.config.budget.maxDollars;

    const workspaceDir = path.dirname(path.resolve(this.configPath));

    const deps = {
      adapterSelector: new AdapterSelector(),
      permissionResolver: new PermissionResolver(this.config.security.requireApproval),
      costTracker: new CostTracker(budget),
      concurrencyLimiter: new ConcurrencyLimiter(this.config.security.maxConcurrentAgents),
      adapters: this.adapters,
      fallbackExecutor: this.fallbackExecutor,
      agentTypes: Array.from(this.agentDefinitions.keys()),
      loadAgentDefinition: (type: string) => {
        const def = this.agentDefinitions.get(type);
        if (!def) throw new Error(`Agent "${type}" not found`);
        return def;
      },
      onApprovalRequest: async (req: { agentType: string; toolName: string; arguments: Record<string, unknown> }) => {
        // CLI mode: auto-approve for now (interactive mode can be added later)
        this.logger.info("agent.approval.auto", { tool: req.toolName, agentType: req.agentType });
        return true;
      },
      workspaceDir,
      // Stream text to stdout in real-time
      onStreamText: (text: string) => {
        process.stdout.write(text);
      },
    };

    const loop = new AgentLoop(deps);
    const result = await loop.run(task, definition, budget);

    console.log("\n--- Result ---");
    console.log(`Status: ${result.status}`);
    if (result.content) console.log(`Content:\n${result.content}`);
    if (result.error) console.log(`Error: ${result.error}`);
    console.log(`Steps: ${result.steps}`);
    console.log(`Cost: $${result.cost.toFixed(4)}`);
  }

  listAgents(): void {
    console.log("Available agents:");
    for (const [agentType, def] of this.agentDefinitions) {
      console.log(`  ${agentType}: ${def.description ?? "No description"} (${def.model})`);
    }
  }

  async committee(
    task: string,
    options: { agents?: string; strategy?: string; budget?: number }
  ): Promise<void> {
    // Support both comma and space as delimiters (PowerShell expands commas into spaces)
    const agentTypes = (options.agents ?? "explore,coder,reviewer")
      .split(/[,\s]+/)
      .map((a: string) => a.trim())
      .filter(Boolean);
    const strategy = (options.strategy ?? "concat") as AggregationStrategy;
    const budget = options.budget ?? this.config.budget.maxDollars;

    // Validate agent types
    for (const at of agentTypes) {
      if (!this.agentDefinitions.has(at)) {
        console.error(`Agent "${at.trim()}" not found. Available: ${Array.from(this.agentDefinitions.keys()).join(", ")}`);
        process.exit(1);
      }
    }

    const workspaceDir = path.dirname(path.resolve(this.configPath));

    const deps = {
      adapterSelector: new AdapterSelector(),
      permissionResolver: new PermissionResolver(this.config.security.requireApproval),
      costTracker: new CostTracker(budget),
      concurrencyLimiter: new ConcurrencyLimiter(this.config.security.maxConcurrentAgents),
      adapters: this.adapters,
      fallbackExecutor: this.fallbackExecutor,
      agentTypes: Array.from(this.agentDefinitions.keys()),
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
      onStreamText: (text: string) => {
        process.stdout.write(text);
      },
    };

    const committee = new Committee(deps);
    const result = await committee.run(task, {
      agentTypes,
      strategy,
    }, budget);

    console.log("\n--- Committee Result ---");
    console.log(`Status: ${result.status}`);
    console.log(`Strategy: ${result.strategy}`);
    console.log(`Members: ${result.members.length}`);
    console.log(`Total cost: $${result.totalCost.toFixed(4)}`);
    console.log(`Total steps: ${result.totalSteps}`);

    for (const member of result.members) {
      console.log(`\n[${member.agentType}] ${member.result.status} (${member.result.steps} steps, $${member.result.cost.toFixed(4)})`);
    }

    if (result.content) {
      console.log(`\n--- Aggregated Output ---\n${result.content}`);
    }
  }
}

// ── CLI ──

const program = new Command();

program
  .name("multi-agent")
  .description("Lightweight self-orchestrating multi-agent CLI")
  .version("0.1.0");

program
  .command("run")
  .description("Execute a task with an agent")
  .argument("<task>", "Task description")
  .option("-c, --config <path>", "Config file path", "orchestrator.yaml")
  .option("-a, --agent <type>", "Agent type to use", "main")
  .option("-b, --budget <dollars>", "Budget limit in dollars", parseFloat)
  .action(async (task: string, options: { config: string; agent?: string; budget?: number }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();
    await orchestrator.execute(task, { agent: options.agent, budget: options.budget });
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

      // Optional dependency check
      if (!isCheerioAvailable()) {
        console.log("\n  [hint] cheerio not installed — WebFetch will use regex-based extraction.");
        console.log("         Install for better results: npm install cheerio");
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
  .option("-b, --budget <dollars>", "Budget limit in dollars", parseFloat)
  .action(async (task: string, options: { config: string; agents?: string; strategy?: string; budget?: number }) => {
    const agentsDir = path.join(path.dirname(options.config), ".agents");
    const orchestrator = new Orchestrator(options.config, agentsDir);
    await orchestrator.init();
    await orchestrator.committee(task, options);
  });

program.parse();
