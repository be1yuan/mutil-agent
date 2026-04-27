# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-Agent Orchestrator — a multi-model agent orchestration layer that supports heterogeneous LLM providers (DeepSeek, Kimi, GLM, MiniMax) through a unified Coordinator pattern. Currently in **design phase** — the repository contains only specification documents (DESIGN.md series), no implementation code yet.

## Design Documents (read in order)

- `DESIGN.md` — Original design: full Claude Code-inspired Coordinator Mode with 4-phase workflow, all 4 model adapters, file-mailbox + HTTP comms, delegation-chain permissions, aggressive 2-week MVP estimate
- `DESIGN-v2.md` — Correction pass: removes leaked-source references, fixes incorrect model data (context windows, pricing), simplifies MVP scope (2 models only), adds test strategy, adjusts timeline to 4–6 weeks
- `DESIGN-v3.md` — Refinement: replaces deprecated OpenAI Swarm with Agents SDK, adds Kimi Anthropic-compatible endpoints, Moonshot dual-region (cn/ai) handling, fixes AgentInstance type bug, expands i18n coverage in ComplexityEvaluator
- `DESIGN-v4.md` — Safety & production hardening: adds FallbackExecutor (retry + exponential backoff + cross-model failover), Mutex-guarded WorktreeManager, CostTracker, Zod config validation, event-driven PermissionManager, proper cleanup/queue lifecycle handling, timeline adjusted to 5–7 weeks

## Target Architecture

```
Orchestrator
├── Task Parser → Complexity Evaluator → Simple (single model) / Complex (parallel workers)
├── Adapters (ModelAdapter interface)
│   ├── DeepSeekAdapter (OpenAI + Anthropic-compatible API)
│   ├── KimiAdapter (dual-region cn/ai, OpenAI + Anthropic)
│   ├── GLMAdapter (OpenAI format)
│   └── MiniMaxAdapter (OpenAI format)
├── Communication (MemoryQueue primary, FileMailbox secondary, HTTPBridge deferred)
├── Security (PermissionManager allowlist, safeExec with spawn+args, path traversal protection)
├── Lifecycle (AgentRunner with heartbeat + timeout, WorktreeManager with Mutex)
└── Observability (structured logging, Prometheus metrics, OpenTelemetry tracing, CostTracker)
```

## Key Design Decisions (from v4)

- **Language**: TypeScript/Node.js (OpenAI-compatible API format as baseline; Anthropic-compatible for DeepSeek/Kimi where supported)
- **MVP scope** (5–7 weeks): DeepSeek V4-Pro + Kimi K2.6 only, in-memory queue, allowlist permissions, spawn+args security, retry+fallback, budget cap, Zod config validation
- **Dynamic complexity evaluation**: heuristic patterns for simple tasks; model-assisted assessment only for complex ones
- **No delegation-chain permissions**: flat allowlist per agent type; dangerous operations (file.delete, bash.exec, git.push) require human approval via injected callback
- **Git Worktree isolation**: Mutex-serialized to prevent concurrent git conflicts
- **Claude Code bridge**: CLI subcommand (`execute --task ... --format anthropic`) callable via Bash tool; programmatic bridge class available

## What This Repository Contains

- `DESIGN.md` → `DESIGN-v4.md`: Iterative design specifications (no implementation code yet)
- `.workbuddy/memory/MEMORY.md`: Workbuddy memory index (project-internal tooling)

## When Implementing

- Start with: `src/adapters/base-adapter.ts` (ModelAdapter interface), `src/adapters/deepseek-adapter.ts`, `src/adapters/kimi-adapter.ts`
- Config validation first: `src/config/validator.ts` (Zod schema) — catches misconfiguration at startup
- Then core: `src/core/complexity-evaluator.ts`, `src/coordinator/`, `src/communication/memory-queue.ts`
- Security: `src/security/safe-exec.ts`, `src/security/path-utils.ts` — wire into lifecycle
- Use `src/adapters/fallback-executor.ts` to wrap all model calls
- Observability (`src/observability/`) can be scaffolded early but wired last
