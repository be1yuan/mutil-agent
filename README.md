# Multi-Agent Orchestrator

A self-orchestrating multi-agent CLI that coordinates LLM agents through a unified protocol. Built for DeepSeek V4-Pro and GLM-5.1 via Anthropic-compatible API endpoints.

## Architecture

Each agent runs an **embedded orchestrate loop** — no separate coordinator service. Agents assess complexity internally and delegate subtasks via the `task` primitive:

```
User → Main Agent → (simple task) → answer directly
                   → (complex task) → spawn explore → coder → reviewer
                                    → synthesize results
```

## Quick Start

```bash
# Install dependencies
npm install

# Set API keys
export DEEPSEEK_API_KEY=sk-...
export ZHIPU_API_KEY=...

# Run a task
npm run dev run "Fix the login bug in auth.ts" --agent main

# List available agents
npm run dev list-agents

# Validate configuration
npm run dev validate
```

## Agent Definitions

Agents are defined as Markdown files in `.agents/` with YAML frontmatter:

```markdown
---
agentType: coder
model: deepseek-chat
provider: deepseek
maxSteps: 50
timeout: 300000
tools:
  Read: allow
  Write: allow
  Bash:
    allow: ["git *", "npm *"]
    deny: ["rm -rf /"]
---
(system prompt body)
```

### Built-in Agents

| Agent | Role | Key Restrictions |
|-------|------|-----------------|
| `main` | General tasks + delegation | Full access, can spawn sub-agents |
| `explore` | Read-only codebase analysis | Read/Grep/Glob only, no writes |
| `coder` | Code writing and editing | Can write/edit but not delegate |
| `reviewer` | Code review and quality analysis | Read-only + git inspection |

## Tool Permissions

Three-tier permission model per tool:

- **`allow`** — execute immediately
- **`ask`** — request user confirmation first
- **`deny`** — block execution

Bash tools support **glob patterns** for fine-grained command control:

```yaml
Bash:
  allow: ["git *", "npm test", "ls *"]
  ask: ["git push *", "rm *"]
  deny: ["rm -rf /", "git push --force*"]
```

## Configuration

`orchestrator.yaml`:

```yaml
providers:
  deepseek:
    apiKey: ${DEEPSEEK_API_KEY}
    baseURL: https://api.deepseek.com/anthropic
  zhipu:
    apiKey: ${ZHIPU_API_KEY}
    baseURL: https://open.bigmodel.cn/api/anthropic

fallback:
  maxRetries: 3
  fallbackModel:  # cross-model failover
    provider: zhipu
    model: glm-5.1

budget:
  maxDollars: 5.0

security:
  maxConcurrentAgents: 5
  requireApproval: ["file.delete", "git.push"]
```

## Project Structure

```
src/
├── agent/           Agent execution loop, model selection, tools, concurrency
├── adapters/        Model adapters (DeepSeek, GLM) + fallback executor
├── security/        Permission resolution, safe-exec, path traversal protection
├── config/          YAML/Markdown loader, Zod validation
├── observability/   Structured logging, cost tracking with budget cap
├── types/            Core shared types
└── cli/              CLI entry point (commander)
```

## MVP Status

- [x] Agent main loop with embedded task decomposition
- [x] DeepSeek + GLM adapters (Anthropic-compatible endpoints)
- [x] Markdown agent definitions + YAML configuration
- [x] Three-tier permission engine (allow/ask/deny + Bash glob matching)
- [x] Fallback executor (retry + exponential backoff + cross-model failover)
- [x] Cost tracker with budget cap + 80% warning threshold
- [x] Concurrency limiter (semaphore-based)
- [x] Structured logging (Winston)
- [ ] Tool execution implementation (Read/Write/Edit/Bash/Grep/Glob)
- [ ] Test suite
- [ ] Streaming response support (v0.2)

## License

MIT
