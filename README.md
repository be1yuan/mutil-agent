# Multi-Agent Orchestrator

轻量级自编排多 Agent CLI，基于 DeepSeek V4-Pro、GLM-5.1 和 MiMo-V2.5-Pro，通过 Anthropic 兼容端点统一接入。

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
export MIMO_API_KEY=...

# 执行任务
npm run dev run "修复 auth.ts 中的登录 bug" --agent main

# 查看可用 Agent
npm run dev list-agents

# 校验配置
npm run dev validate
```

## CLI 命令

| 命令 | 说明 |
|------|------|
| `run <task>` | 执行任务（`--agent`, `--budget`, `--verbose`, `--quiet`）|
| `list-agents` | 列出可用 Agent |
| `validate` | 验证配置和 Agent 定义 |
| `committee <task>` | 多 Agent 并行执行（`--agents`, `--strategy`, `--budget`）|
| `serve` | 启动 HTTP API 服务器（`--host`, `--port`）|

### CLI 选项

| 选项 | 说明 |
|------|------|
| `-a, --agent <type>` | 指定 Agent 类型（默认 `main`）|
| `-b, --budget <yuan>` | 预算上限，单位人民币元 |
| `-v, --verbose` | 显示完整工具参数和返回值 |
| `-q, --quiet` | 仅显示最终结果，抑制实时输出 |
| `-c, --config <path>` | 配置文件路径（默认 `orchestrator.yaml`）|

### Committee 模式

多 Agent 并行执行同一任务，支持三种聚合策略：

```bash
# 默认三 Agent 并行，concat 聚合
npm run dev committee "分析代码库安全性"

# 指定 Agent 和策略
npm run dev committee "审查 PR" --agents "reviewer,architect" --strategy majority
```

| 策略 | 说明 |
|------|------|
| `concat` | 拼接所有 Agent 输出 |
| `majority` | 多数投票（需要至少 3 个 Agent）|
| `best` | 选择成本最低的完整结果 |

## Agent 定义

Agent 使用 `.agents/` 目录下的 Markdown 文件定义，带 YAML frontmatter：

```markdown
---
agentType: coder
model: deepseek-v4-pro
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

| Agent | 模型 | 角色 | 关键限制 |
|-------|------|------|---------|
| `main` | DeepSeek V4-Pro | 通用任务 + 委派子任务 | 完整权限，可派生子 Agent |
| `explore` | DeepSeek V4-Pro | 只读代码库分析 | 仅 Read/Grep/Glob，不可写入 |
| `coder` | DeepSeek V4-Pro | 代码编写与修改 | 可写入/编辑，不可委派 |
| `reviewer` | DeepSeek V4-Pro | 代码审查与质量分析 | 只读 + git 检查 |
| `architect` | MiMo-V2.5-Pro | 只读架构顾问 | 只读分析，不写代码，不可委派 |

## 内置工具

| 工具 | 说明 |
|------|------|
| `Read` | 读取文件内容（100KB 截断）|
| `Write` | 写入文件 |
| `Edit` | 替换文件内容（唯一匹配检查）|
| `Bash` | 安全执行命令（spawn 数组，非 shell:true）|
| `Grep` | 正则搜索文件内容 |
| `Glob` | 文件模式匹配 |
| `WebSearch` | DuckDuckGo 搜索（带缓存 + 限速）|
| `WebFetch` | URL 抓取（DNS rebinding 防护 + 缓存）|
| `MailboxSend` | 发送邮箱消息（跨进程通信）|
| `MailboxReceive` | 接收邮箱消息（支持阻塞等待）|

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

## 文件邮箱

跨进程持久化消息系统，Agent 之间可通过文件邮箱异步通信。

```bash
# 启用邮箱（orchestrator.yaml）
mailbox:
  enabled: true
  dir: .mailbox
  pollIntervalMs: 500
  maxAgeMs: 86400000
```

存储布局：
```
.mailbox/
├── {agentType}/inbox/          # 未读消息
├── {agentType}/inbox/.read/    # 已读消息
├── {agentType}/.bc_read/       # 广播已读标记
├── _broadcast/inbox/           # 广播消息（to="*"）
└── _dead_letter/               # 无效投递
```

特性：原子写入（temp → rename）、Windows 兼容广播、per-agent 已读跟踪、waitFor 阻塞等待新消息。

## HTTP API

独立部署模式，通过 `serve` 命令启动 HTTP API 服务器：

```bash
npm run dev serve --port 3100
```

### 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/tasks` | 提交新任务 |
| `GET` | `/api/tasks/:id` | 查询任务状态/结果 |
| `GET` | `/api/tasks/:id/stream` | SSE 实时流 |
| `GET` | `/api/agents` | 列出可用 Agent |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/cost` | 成本追踪 |

### 认证与安全

- 可选 Bearer token 认证（`api.authToken` 配置）
- 请求体大小限制：1MB
- IP 级速率限制：60 次/分钟
- CORS 支持

### SSE 事件

`step` / `tool` / `delta` / `cost` / `result` / `done`

## 故障转移

FallbackExecutor 提供三重保障：

1. 主模型重试（最多 3 次，指数退避）
2. 429/5xx/超时自动重试
3. 跨模型故障转移（DeepSeek → GLM → MiMo）

## 成本控制

双保险机制：

- **预算上限**：超出 `maxYuan` 立即终止（单位人民币元）
- **steps 上限**：每 Agent 最大迭代次数，防止无限循环
- 父子 Agent 共享同一个 `CostTracker`，子 Agent 花费实时扣减父 Agent 预算
- 80% 预算预警阈值
- API 模式下每个任务独立 CostTracker

## 模型定价

| Provider | 模型 | 输入 (¥/1M tokens) | 输出 (¥/1M tokens) | 缓存命中 |
|----------|------|---------------------|---------------------|----------|
| deepseek | DeepSeek V4-Pro | ¥2.87 | ¥5.74 | — |
| zhipu | GLM-5.1 | ¥7.0 | ¥22.4 | — |
| mimo | MiMo-V2.5-Pro | ¥7.0 | ¥21.0 | ¥1.4 |

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
  mimo:
    apiKey: ${MIMO_API_KEY}
    baseURL: https://api.xiaomimimo.com/anthropic

fallback:
  maxRetries: 3
  retryDelayMs: 1000
  fallbackModel:
    provider: zhipu
    model: glm-5.1

budget:
  maxYuan: 35.0

security:
  maxConcurrentAgents: 5
  requireApproval: ["file.delete", "git.push"]

mailbox:
  enabled: true
  dir: .mailbox

api:
  host: 127.0.0.1
  port: 3100
  authToken: ${API_AUTH_TOKEN}
  cors: true
```

## 项目结构

```
src/
├── agent/            Agent 执行循环、工具定义、并发控制、邮箱、worktree
├── adapters/         模型适配器（DeepSeek, GLM, MiMo）+ 故障转移执行器
├── api/              HTTP API 服务器、SSE、任务管理器
├── security/         权限解析、安全执行、路径遍历防护
├── config/           YAML/Markdown 加载器、Zod 校验
├── observability/    结构化日志、预算追踪
├── types/            核心共享类型
└── cli/              CLI 入口、ANSI 颜色、状态渲染器
.agents/              Agent 定义文件（Markdown + frontmatter）
orchestrator.yaml     全局配置
```

## 可选依赖

```bash
# 更好的 WebFetch HTML 提取
npm install cheerio
```

## 环境要求

- Node.js >= 20
- pnpm 或 npm

## 许可证

MIT
