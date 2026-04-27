# Multi-Agent Orchestrator

轻量级自编排多 Agent CLI，基于 DeepSeek V4-Pro 和 GLM-5.1，通过 Anthropic 兼容端点统一接入。

## 架构

每个 Agent 运行**内嵌编排循环** — 不需要独立的协调器服务。Agent 在循环中自行判断任务复杂度，复杂任务通过 `task` 原语拆分子 Agent：

```
用户 → 主 Agent → (简单任务) → 直接回答
                → (复杂任务) → 派生 explore → coder → reviewer
                              → 汇总结果
```

核心设计决策：废弃独立 Orchestrator 层。编排本质是决策，决策应内嵌在执行主体的循环中，而非外包给上层模块。详见 [DESIGN-v6.md](DESIGN-v6.md)。

## 快速开始

```bash
# 安装依赖
npm install

# 设置 API 密钥
export DEEPSEEK_API_KEY=sk-...
export ZHIPU_API_KEY=...

# 执行任务
npm run dev run "修复 auth.ts 中的登录 bug" --agent main

# 查看可用 Agent
npm run dev list-agents

# 校验配置
npm run dev validate
```

## Agent 定义

Agent 使用 `.agents/` 目录下的 Markdown 文件定义，带 YAML frontmatter：

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
（正文为 system prompt）
```

### 内置 Agent

| Agent | 角色 | 关键限制 |
|-------|------|---------|
| `main` | 通用任务 + 委派子任务 | 完整权限，可派生子 Agent |
| `explore` | 只读代码库分析 | 仅 Read/Grep/Glob，不可写入 |
| `coder` | 代码编写与修改 | 可写入/编辑，不可委派 |
| `reviewer` | 代码审查与质量分析 | 只读 + git 检查 |

## 工具权限

三级权限模型：

- **`allow`** — 直接执行
- **`ask`** — 请求用户确认后执行
- **`deny`** — 阻止执行

Bash 工具支持 **glob 模式** 做命令级细粒度控制：

```yaml
Bash:
  allow: ["git *", "npm test", "ls *"]
  ask: ["git push *", "rm *"]
  deny: ["rm -rf /", "git push --force*"]
```

权限优先级：全局 `requireApproval` 是最低安全基线，Agent 配置只能比它更严格（deny > ask > allow）。

## 故障转移

FallbackExecutor 提供三重保障：

1. 主模型重试（最多 3 次，指数退避）
2. 429/5xx/超时自动重试
3. 跨模型故障转移（DeepSeek → GLM）

## 成本控制

双保险机制：

- **预算上限**：超出 `maxDollars` 立即终止
- **steps 上限**：每 Agent 最大迭代次数，防止无限循环
- 父子 Agent 共享同一个 `CostTracker`，子 Agent 花费实时扣减父 Agent 预算
- 80% 预算预警阈值

## 配置

`orchestrator.yaml`：

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
  retryDelayMs: 1000
  fallbackModel:
    provider: zhipu
    model: glm-5.1

budget:
  maxDollars: 5.0

security:
  maxConcurrentAgents: 5
  requireApproval: ["file.delete", "git.push"]
```

## 项目结构

```
src/
├── agent/            Agent 执行循环、模型选择、工具定义、并发控制
├── adapters/         模型适配器（DeepSeek, GLM）+ 故障转移执行器
├── security/         权限解析、安全执行、路径遍历防护
├── config/           YAML/Markdown 加载器、Zod 校验
├── observability/    结构化日志、预算追踪
├── types/            核心共享类型
└── cli/              CLI 入口（commander）
.agents/              Agent 定义文件（Markdown + frontmatter）
orchestrator.yaml     全局配置
```

## MVP 进度

- [x] Agent 主循环（内嵌 task 拆分子 Agent）
- [x] DeepSeek + GLM 适配器（Anthropic 兼容端点）
- [x] Markdown Agent 定义 + YAML 配置
- [x] 三级权限引擎（allow/ask/deny + Bash glob 匹配）
- [x] 故障转移执行器（重试 + 指数退避 + 跨模型切换）
- [x] 预算追踪（父子共享 + 上限 + 80% 预警）
- [x] 并发控制（信号量）
- [x] 结构化日志（Winston）
- [x] CLI 入口（run / list-agents / validate）
- [ ] 工具实际执行逻辑（Read/Write/Edit/Bash/Grep/Glob）
- [ ] 测试套件
- [ ] 流式响应（v0.2）
- [ ] Git worktree 隔离（v0.2）

## 许可证

MIT
