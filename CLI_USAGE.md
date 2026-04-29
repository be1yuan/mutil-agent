# Multi-Agent Orchestrator - CLI 使用说明

> 基于 DESIGN-v6 轻量自编排架构

---

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

创建 `.env` 文件，填入各 Provider 的 API Key：

```bash
DEEPSEEK_API_KEY=your_deepseek_key
ZHIPU_API_KEY=your_zhipu_key
MIMO_API_KEY=your_mimo_key
```

### 3. 验证配置

```bash
pnpm run dev validate
```

---

## CLI 命令

### `run` - 单 Agent 执行任务

```bash
# 使用默认 main agent
pnpm run dev run "分析代码库"

# 指定 agent
pnpm run dev run "分析代码库" --agent explore

# 指定预算
pnpm run dev run "修复 bug" --agent coder --budget 20.0

# 详细模式（显示完整工具参数）
pnpm run dev run "审查代码" --agent reviewer --verbose

# 静默模式（只显示最终结果）
pnpm run dev run "分析代码库" --agent explore --quiet
```

**选项**:

| 选项 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `--config` | `-c` | `orchestrator.yaml` | 配置文件路径 |
| `--agent` | `-a` | `main` | Agent 类型 |
| `--budget` | `-b` | `35.0` | 预算上限（人民币，元） |
| `--verbose` | `-v` | `false` | 显示完整工具参数和返回值 |
| `--quiet` | `-q` | `false` | 只显示最终结果，抑制实时输出 |

---

### `committee` - 多 Agent 并行（Committee 模式）

```bash
# 默认组合：explore + coder + reviewer，concat 策略
pnpm run dev committee "审查 src/agent/agent-loop.ts 的安全性"

# 指定 Agent 组合
pnpm run dev committee "审查代码" --agents explore,coder,reviewer

# 指定聚合策略
pnpm run dev committee "审查代码" --agents architect,coder,reviewer --strategy concat

# 其他策略
pnpm run dev committee "决策" --agents main,architect --strategy majority
pnpm run dev committee "选择最佳方案" --agents coder,reviewer --strategy best
```

**选项**:

| 选项 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `--config` | `-c` | `orchestrator.yaml` | 配置文件路径 |
| `--agents` | `-a` | `explore,coder,reviewer` | Agent 组合（逗号或空格分隔） |
| `--strategy` | `-s` | `concat` | 聚合策略：concat / majority / best |
| `--budget` | `-b` | `35.0` | 预算上限（人民币，元） |
| `--verbose` | `-v` | `false` | 显示完整工具参数 |
| `--quiet` | `-q` | `false` | 只显示最终结果 |

**聚合策略说明**:

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| `concat` | 拼接所有 Agent 输出 | 审查、分析类任务 |
| `majority` | 投票选出多数意见 | 决策类任务 |
| `best` | 选择最优输出 | 方案选择类任务 |

**⚠️ PowerShell 注意**: PowerShell 把逗号视为数组分隔符，`--agents a,b,c` 会被展开成三个参数。CLI 已兼容空格分隔，所以以下写法等价：

```powershell
# 两种写法都有效
pnpm run dev committee "任务" --agents explore,coder,reviewer
pnpm run dev committee "任务" --agents "explore coder reviewer"
```

---

### `serve` - 启动 HTTP API 服务器

```bash
# 默认配置启动（127.0.0.1:3100）
pnpm run dev serve

# 指定主机和端口
pnpm run dev serve --host 0.0.0.0 --port 8080
```

**选项**:

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--config` | `orchestrator.yaml` | 配置文件路径 |
| `--host` | `127.0.0.1` | 绑定地址 |
| `--port` | `3100` | 绑定端口 |

**API 端点**:

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/tasks` | 提交新任务 |
| `GET` | `/api/tasks/:id` | 查询任务状态 |
| `GET` | `/api/tasks/:id/stream` | SSE 实时流 |
| `GET` | `/api/agents` | 列出可用 Agent |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/cost` | 成本追踪 |

**提交任务示例**:

```bash
# 无认证
curl -X POST http://127.0.0.1:3100/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"task": "分析代码库结构", "agentType": "explore"}'

# Bearer 认证（需要配置 api.authToken）
curl -X POST http://127.0.0.1:3100/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token-here" \
  -d '{"task": "分析代码库结构", "agentType": "explore"}'
```

**SSE 流式订阅**:

```bash
# 订阅任务实时事件（step/tool/delta/cost/result/done）
curl http://127.0.0.1:3100/api/tasks/{task-id}/stream

# 带 Bearer 认证
curl -H "Authorization: Bearer your-token-here" \
  http://127.0.0.1:3100/api/tasks/{task-id}/stream
```

---

### `list-agents` - 列出可用 Agent

```bash
pnpm run dev list-agents
```

**输出示例**:

```
Available agents:
  main: General-purpose orchestrator agent (deepseek-v4-pro)
  explore: Read-only codebase analysis (deepseek-v4-flash)
  coder: Code writing and tool execution (glm-4.7)
  reviewer: Code review and quality analysis (deepseek-v4-flash)
  architect: Architecture advisor for design review (MiMo-V2.5-Pro)
```

---

### `validate` - 验证配置

```bash
pnpm run dev validate
```

检查内容：
- orchestrator.yaml 格式和字段
- Agent 定义文件（.agents/*.md）frontmatter 解析
- 可选依赖（cheerio）安装状态

---

## Agent 角色说明

| Agent | 模型 | 定位 | 权限特点 |
|-------|------|------|----------|
| `main` | deepseek-v4-pro | 通用编排 + task 自编排 | 全工具 allow（含 MailboxSend/MailboxReceive） |
| `coder` | glm-4.7 | 代码编写 + 工具执行 | 全工具 allow |
| `explore` | deepseek-v4-flash | 只读代码库分析 | Read/Grep/Glob only，无 Write/Bash |
| `reviewer` | deepseek-v4-flash | 代码审查 | Read/Grep/Glob only |
| `architect` | MiMo-V2.5-Pro | 架构顾问（只读分析） | Read/Grep/Glob/WebSearch/WebFetch allow；Write/Edit/Bash deny |

**Committee 推荐组合**:

| 场景 | 推荐组合 | 策略 |
|------|----------|------|
| 代码审查 | `architect,coder,reviewer` | `concat` |
| 安全分析 | `architect,reviewer` | `concat` |
| 架构决策 | `architect,main` | `majority` |
| 方案选择 | `coder,reviewer` | `best` |
| 代码库分析 | `explore,architect` | `concat` |

---

## 邮箱工具（MailboxSend / MailboxReceive）

文件邮箱支持跨进程、跨 Agent 的异步通信。邮箱默认启用，通过 `orchestrator.yaml` 中的 `mailbox` 配置段控制。

### MailboxSend — 发送消息

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `to` | string | 是 | 收件人 agentType，或 `"*"` 广播 |
| `subject` | string | 是 | 消息主题 |
| `body` | string | 是 | 消息正文（Markdown） |
| `priority` | string | 否 | 优先级：`low` / `normal` / `high`（默认 `normal`） |
| `correlationId` | string | 否 | 关联 ID，用于请求-回复模式 |

**广播说明**: `to="*"` 会将消息投递到 `_broadcast` 目录（Windows 上 `*` 不是合法目录名，内部自动映射），所有 Agent 均可接收。

### MailboxReceive — 接收消息

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentType` | string | 否 | 邮箱所属 Agent（默认为当前 Agent） |
| `wait` | boolean | 否 | 是否等待新消息（默认 `false`） |
| `timeout` | number | 否 | 等待超时毫秒数（默认 30000，仅 `wait=true` 时生效） |

**wait 模式**: 设为 `true` 时阻塞等待直到新消息到达或超时。waitFor 只返回新消息（已有消息被排除），需要已有消息时先调用不带 wait 的 receive()。

### 邮箱配置

```yaml
mailbox:
  enabled: true          # 必须显式启用（opt-in）
  dir: .mailbox          # 邮箱存储目录
  maxAgeMs: 86400000     # 消息最大保留时间（24小时）
  pollIntervalMs: 500    # waitFor 轮询间隔
```

**注意**: 邮箱默认不启用。必须在 `orchestrator.yaml` 中设置 `mailbox.enabled: true` 才会创建 `.mailbox/` 目录和启用邮箱工具。

### 使用场景

- 跨进程 Agent 协作：一个 Agent 完成任务后通知另一个
- 异步请求-回复：通过 `correlationId` 关联请求与回复
- 广播通知：向所有 Agent 推送状态更新

---

## 配置文件说明

### orchestrator.yaml

```yaml
providers:
  deepseek:
    apiKey: ${DEEPSEEK_API_KEY}
    baseURL: https://api.deepseek.com/anthropic
    defaultModel: deepseek-v4-pro
  zhipu:
    apiKey: ${ZHIPU_API_KEY}
    baseURL: https://open.bigmodel.cn/api/anthropic
    defaultModel: glm-4.7
  mimo:
    apiKey: ${MIMO_API_KEY}
    baseURL: https://api.xiaomimimo.com/anthropic
    defaultModel: MiMo-V2.5-Pro

fallback:
  maxRetries: 3
  retryDelayMs: 1000
  retryableErrors:
    - rate_limit
    - timeout
    - server_error
  fallbackModel:
    provider: zhipu
    model: glm-4.7

security:
  maxConcurrentAgents: 5
  requireApproval:
    - file.delete
    - git.push
    - git.push --force

budget:
  maxYuan: 35.0

observability:
  logLevel: info
  metricsEnabled: true

mailbox:
  enabled: true
  dir: .mailbox
  maxAgeMs: 86400000
  pollIntervalMs: 500

api:
  enabled: true
  host: 127.0.0.1
  port: 3100
  # authToken: ${API_AUTH_TOKEN}  # 可选 Bearer 认证 token
  cors: true
```

### Agent 定义文件（.agents/*.md）

Agent 定义使用 Markdown frontmatter 格式：

```markdown
---
agentType: architect
model: MiMo-V2.5-Pro
provider: mimo
description: Architecture advisor
maxSteps: 20
maxTokensPerStep: 8192
timeout: 180000
tools:
  Read: allow
  Grep: allow
  Glob: allow
  WebSearch: allow
  Write: deny
  Edit: deny
  Bash:
    allow: ["git log*", "ls *"]
    deny: ["*"]
  task: deny
---

You are an architecture advisor agent...
```

**权限语法**:

| 语法 | 说明 |
|------|------|
| `allow` | 完全允许 |
| `deny` | 完全拒绝 |
| `allow: ["pattern*"]` + `deny: ["*"]` | 白名单模式（只允许匹配 glob 的命令） |

---

## 故障排查

### Agent 未找到

```
Agent "xxx" not found. Available: coder, explore, main, reviewer, architect
```

检查 `.agents/` 目录下是否有对应的 `.md` 文件，frontmatter 中的 `agentType` 是否正确。

### 配置验证失败

```bash
pnpm run dev validate
```

根据错误提示检查 orchestrator.yaml 或 Agent 定义文件。

### API Key 无效

确保 `.env` 文件中对应 Provider 的 API Key 正确，且已加载（不需要手动 export，程序自动读取）。

### MiMo 认证失败

MiMo 使用 `api-key` header 认证，不是 Anthropic 标准的 `x-api-key`。`MiMoAdapter` 已通过自定义 `fetch` 处理此差异，无需手动配置。

### API 返回 401 Unauthorized

如果在 `orchestrator.yaml` 中配置了 `api.authToken`，所有 API 请求必须携带 `Authorization: Bearer <token>` header。去掉 `authToken` 配置可关闭认证。

### API 返回 413 Payload Too Large

请求体超过 1MB 限制。减小请求参数后重试。

### API 返回 429 Too Many Requests

同一 IP 请求频率超过 60 次/分钟。稍后重试。

### 邮箱工具报错 "Mailbox not enabled"

邮箱默认不启用（opt-in）。在 `orchestrator.yaml` 中添加 `mailbox.enabled: true` 以启用邮箱功能。邮箱目录会自动创建，无需手动建立。

### 邮箱广播消息未收到

广播消息（`to="*"`）存储在 `_broadcast` 目录。接收时需要用 `MailboxReceive` 指定自己的 `agentType`，广播消息对所有 Agent 可见。

---

## 开发脚本

```bash
# 类型检查
pnpm run typecheck

# 运行测试
pnpm run test

# 开发模式（带热重载）
pnpm run dev
```
