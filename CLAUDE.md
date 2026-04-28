# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # Install dependencies (Node >=20)
npm run build            # Compile TypeScript (tsc)
npm run dev              # Run via tsx (e.g., npm run dev run "task" --agent main)
npm run dev run "task"   # Execute a task (add --agent <type>, --budget <n>)
npm run dev list-agents  # List available agent definitions
npm run dev validate     # Validate orchestrator.yaml + .agents/*.md
npm test                 # Run tests (vitest run)
npm run test:watch       # Run tests in watch mode
npm run typecheck        # Type-check without emitting (tsc --noEmit)
```

## Architecture

### Layered structure (bottom-up)

```
src/types/core.ts          — ModelProvider, Usage, AgentResult (zero deps)
src/adapters/types.ts      — ModelAdapter interface, ChatParams/Response, tools, sub-agent types
src/agent/types.ts         — AgentDefinition, Permission, BashPermission
src/config/types.ts        — OrchestratorConfig, Zod schemas

src/adapters/anthropic-client.ts   — DeepSeekAdapter + GLMAdapter via Anthropic SDK (shared codegen)
src/adapters/fallback-executor.ts  — Retry + exponential backoff + cross-model failover
src/agent/adapter-selector.ts      — Chooses model provider per task (agent config or default deepseek)
src/agent/agent-loop.ts            — Core execution loop: chat → tools → repeat until done/maxSteps
src/agent/tools.ts                 — Built-in tool definitions + task tool for sub-agent spawning
src/agent/concurrency-limiter.ts   — Semaphore limiting concurrent sub-agent spawns
src/security/permission-resolver.ts— allow/ask/deny with Bash glob matching, global baseline overrides
src/security/safe-exec.ts          — spawn-based execution (never shell:true), path traversal guard
src/config/loader.ts               — YAML config (with env var substitution) + Markdown agent loader
src/config/validator.ts            — Zod validation with defaults
src/observability/cost-tracker.ts  — Per-call cost accounting, 80% budget warning
src/observability/logger.ts        — Winston JSON logger (console + file)
src/cli/main.ts                    — Orchestrator class + Commander CLI (run/list-agents/validate)
```

### Key design decisions

- **No separate orchestrator** — each Agent runs an embedded loop; orchestration happens via the `task` tool spawning sub-agents within the same process
- **Model provider = Anthropic-compatible HTTP endpoints** — DeepSeek and GLM use the same `@anthropic-ai/sdk` client, differentiated only by baseURL
- **Permissions are scoped per agent definition** — `.agents/*.md` frontmatter declares per-tool allow/ask/deny; Bash permissions use glob patterns; global `requireApproval` in `orchestrator.yaml` is a security baseline that can only make permissions stricter
- **Sub-agents share parent's CostTracker** — costs from sub-agent model calls decrement the same budget pool; concurrency is limited by semaphore (`maxConcurrentAgents`)
- **Fallback chain**: primary model retries (max 3, exponential backoff) → cross-model switch (e.g. DeepSeek → GLM) → throw `ModelUnavailableError`

### Agent definition format (Markdown + YAML frontmatter)

Files in `.agents/*.md` have frontmatter fields: `agentType`, `model`, `provider` (optional), `maxSteps`, `timeout`, `tools` (map of tool name → `allow|ask|deny` or `{allow, ask, deny}` for Bash globs), and the body text becomes `systemPrompt`.

### What's implemented vs pending

Implemented: agent loop, DeepSeek/GLM adapters, config loading/validation, permission engine, fallback executor, budget tracking, concurrency control, structured logging, CLI.

Pending (v0.2): actual tool execution logic (Read/Write/Edit/Bash/Grep/Glob are stubs that return `[executed]`), streaming responses, git worktree isolation, test suite.
