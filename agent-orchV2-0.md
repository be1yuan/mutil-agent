# DESIGN-v10: v2.0 设计方案

> agent-orch v2.0 — 智能协作 + 持久化 + 可扩展

---

## 1. 背景与目标

### 1.1 现状 (v1.0)

v1.0 已完成全部核心功能：

| 模块 | 状态 | 说明 |
|------|------|------|
| Agent 主循环 | ✅ | tool-use loop，子 Agent 派生 |
| 模型适配器 | ✅ | DeepSeek/GLM/MiMo via Anthropic SDK |
| 11 个内置工具 | ✅ | Read/Write/Edit/Bash/Grep/Glob/WebSearch/WebFetch/Mailbox/task |
| 权限系统 | ✅ | 三层权限 allow/ask/deny，Bash glob 匹配 |
| 委员会模式 | ✅ | 并行执行 + concat/majority/best 聚合 |
| Mailbox | ✅ | 文件级跨进程通信 |
| HTTP API | ✅ | 零依赖 node:http + SSE 流式 |
| TUI Dashboard | ✅ | ink/React 终端界面 |
| 可观测性 | ✅ | CostTracker + Winston 日志 + Prometheus 指标 |
| 构建分发 | ✅ | esbuild + Docker + CI/CD |

测试：9 个文件，116 个测试全部通过。

### 1.2 v2.0 目标

从"能跑"升级到"跑得好、记得住、能扩展"，覆盖 5 个方向：

| 优先级 | 方向 | 核心价值 |
|--------|------|----------|
| P0 | 工作流引擎 | 可复用的多步骤流程定义，条件分支，人工审批 |
| P1 | Agent 记忆 | 跨任务知识积累，会话摘要，项目上下文 |
| P2 | 插件系统 | 用户自定义工具，MCP 协议，外部 API 集成 |
| P3 | 协作增强 | 辩论模式，审查链，加权投票 |
| P3 | Web Dashboard | 浏览器端监控、成本分析、执行树可视化 |

### 1.3 设计约束

- **向后兼容**：v1.0 CLI 和 API 继续工作
- **零依赖优先**：核心功能不引入新外部依赖
- **文件存储优先**：状态持久化使用文件系统（原子写入 temp+rename 模式）
- **独立可交付**：每个 Phase 独立开发、测试、发布

---

## 2. 架构扩展点

v2.0 所有新功能都通过现有扩展点接入，不破坏已有架构：

```
┌─────────────────────────────────────────────────────────┐
│                    CLI (src/cli/main.ts)                 │
│  新增命令: workflow / memory / plugins / debate          │
├─────────────────────────────────────────────────────────┤
│              Orchestrator (src/cli/main.ts)              │
│  初始化时加载: WorkflowEngine / Memory / PluginRegistry  │
├──────────┬──────────┬───────────┬───────────┬───────────┤
│ Workflow │  Memory  │  Plugin   │ Collab.   │ Web Dash  │
│  Engine  │  System  │  System   │  Modes    │  Board    │
├──────────┴──────────┴───────────┴───────────┴───────────┤
│               AgentLoop (src/agent/agent-loop.ts)       │
│  AgentLoopDeps 新增: memory?, pluginRegistry?           │
├─────────────────────────────────────────────────────────┤
│          ToolExecutor (src/agent/tool-executor.ts)      │
│  executeTool() 新增: Memory*/Plugin* 分支               │
│  ToolContext 新增: memory?, pluginRegistry?             │
├─────────────────────────────────────────────────────────┤
│          Config (src/config/types.ts + loader.ts)       │
│  OrchestratorConfig 新增: workflows? / memory? / plugins?│
└─────────────────────────────────────────────────────────┘
```

关键扩展点：

| 扩展点 | 位置 | v2.0 用途 |
|--------|------|----------|
| `AgentLoopDeps` | agent-loop.ts:28 | 注入 memory 和 pluginRegistry |
| `executeTool()` switch | tool-executor.ts:18 | 新增 Memory/Plugin 工具分支 |
| `ToolContext` | tool-executor.ts:11 | 携带 memory 和 pluginRegistry 实例 |
| `OrchestratorConfig` | config/types.ts:57 | 新增 workflows/memory/plugins 配置段 |
| CLI command 注册 | cli/main.ts (Commander) | 新增 workflow/memory/plugins/debate 子命令 |
| `AggregationStrategy` | committee.ts | 新增 weighted-majority/weighted-best |

---

## 3. Phase 1: 工作流引擎

### 3.1 目标

用户通过 YAML 文件定义多步骤工作流，引擎自动执行、支持条件分支和人工审批。

### 3.2 工作流 YAML 格式

```yaml
name: code-review-pipeline
description: 探索 → 编码 → 审查 完整流程
version: "1.0"
variables:
  targetDir: "src/agent"

steps:
  - id: explore
    type: agent                    # agent | committee | checkpoint
    agentType: explore
    task: "分析 ${targetDir} 的代码结构，找出所有公开 API 和调用关系"

  - id: implement
    type: agent
    agentType: coder
    task: "根据分析结果: ${steps.explore.content}，实现重构"
    maxSteps: 30
    budget: 5.0                    # 单步预算上限 (元)
    on:                            # 条件分支
      condition:
        field: status              # status | content | cost
        operator: eq               # eq | contains | gt | lt | matches
        value: success
      then: review
      else: fix_errors

  - id: review
    type: agent
    agentType: reviewer
    task: "审查代码变更: ${steps.implement.content}"
    checkpoint:                    # 人工审批检查点
      message: "审查完成，是否继续执行?"
      autoApprove: false           # 非交互模式下是否自动通过

  - id: fix_errors
    type: agent
    agentType: coder
    task: "修复之前实现中的问题，参考 reviewer 反馈: ${steps.review.content}"
```

### 3.3 核心类型

```typescript
// src/workflow/types.ts

type StepType = "agent" | "committee" | "checkpoint";

interface WorkflowCondition {
  field: "status" | "content" | "cost";
  operator: "eq" | "contains" | "gt" | "lt" | "matches";
  value: string | number;
}

interface WorkflowStep {
  id: string;
  type: StepType;
  agentType?: string;              // type=agent 时使用
  agentTypes?: string[];           // type=committee 时使用
  task: string;                    // 支持 ${var} 和 ${steps.id.content} 插值
  maxSteps?: number;
  budget?: number;                 // 单步预算上限 (元)
  timeout?: number;                // 单步超时 (ms)
  on?: {
    condition: WorkflowCondition;
    then: string;                  // 下一步 id
    else: string;                  // 分支 id
  };
  checkpoint?: {
    message: string;
    autoApprove?: boolean;
  };
}

interface WorkflowDefinition {
  name: string;
  description?: string;
  version?: string;
  steps: WorkflowStep[];
  variables?: Record<string, string>;
}

type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "waiting_approval";

interface StepResult {
  stepId: string;
  status: StepStatus;
  result?: AgentResult;
  startedAt?: number;
  completedAt?: number;
  approved?: boolean;
}

interface WorkflowRun {
  id: string;
  workflowName: string;
  status: "running" | "completed" | "failed" | "paused" | "cancelled";
  steps: StepResult[];
  variables: Record<string, string>;
  startedAt: number;
  completedAt?: number;
  totalCost: number;
}
```

### 3.4 新建文件

| 文件 | 用途 |
|------|------|
| `src/workflow/types.ts` | 上述类型定义 |
| `src/workflow/parser.ts` | YAML 加载 + Zod 校验 WorkflowDefinition |
| `src/workflow/parser.test.ts` | 解析器测试（有效/无效/插值） |
| `src/workflow/engine.ts` | WorkflowEngine 类：步骤遍历、分支路由、检查点暂停/恢复 |
| `src/workflow/engine.test.ts` | 引擎单元测试 |
| `src/workflow/template-resolver.ts` | `${var}` / `${steps.id.content}` 变量插值 |
| `src/workflow/state-store.ts` | 文件持久化 WorkflowRun 状态到 `.workflow-state/` |
| `src/workflow/state-store.test.ts` | 状态持久化测试 |
| `.workflows/example-code-review.yaml` | 内置示例工作流 |
| `.workflows/example-feature-impl.yaml` | 内置示例工作流 |

### 3.5 修改文件

| 文件 | 改动内容 |
|------|----------|
| `src/cli/main.ts` | 1. 新增 `workflow run <file>` 命令 — 加载 YAML，执行工作流<br>2. 新增 `workflow list` 命令 — 列出 `.workflows/` 下的工作流文件<br>3. 新增 `workflow status <id>` 命令 — 查看运行状态<br>4. 新增 `workflow resume <id>` 命令 — 恢复暂停的工作流<br>5. Orchestrator 类新增 `runWorkflow()` 方法 |
| `src/config/types.ts` | OrchestratorConfig 增加可选字段：`workflows?: { dir: string; stateDir: string; defaultTimeout: number }` |
| `src/config/validator.ts` | 增加 `WorkflowsConfigSchema` Zod schema |
| `src/config/loader.ts` | 增加 `loadWorkflow(filePath: string): WorkflowDefinition` |
| `src/api/server.ts` | 新增 3 个端点：<br>- `POST /api/workflows` — 启动工作流<br>- `GET /api/workflows/:id` — 查询状态<br>- `POST /api/workflows/:id/resume` — 恢复暂停 |
| `orchestrator.yaml` | 新增配置段（见下方） |

### 3.6 配置变更

`orchestrator.yaml` 新增：

```yaml
workflows:
  dir: .workflows              # 工作流 YAML 文件目录
  stateDir: .workflow-state    # 运行状态持久化目录
  defaultTimeout: 600000       # 单步默认超时 (10分钟)
```

### 3.7 WorkflowEngine 核心逻辑

```
输入: WorkflowDefinition + AgentLoopDeps + budget

1. 创建 WorkflowRun，所有步骤初始 pending
2. 从第一个步骤开始执行
3. 对每个步骤:
   a. 解析变量插值 (template-resolver)
   b. 根据 type 执行:
      - "agent": 创建 AgentLoop，运行 task
      - "committee": 创建 Committee，并行运行
      - "checkpoint": 暂停，等待用户/API 审批
   c. 记录 StepResult
   d. 持久化状态到 .workflow-state/
   e. 如果有 on 条件:
      - 评估条件 (status/cost/content)
      - 路由到 then 或 else 指定的步骤
   f. 如果步骤失败且无分支，终止工作流
4. 所有可达步骤完成后，标记 WorkflowRun 为 completed
```

### 3.8 测试计划

| 测试 | 说明 |
|------|------|
| parser: valid YAML | 解析完整工作流定义 |
| parser: missing steps | 拒绝无 steps 的 YAML |
| parser: invalid step type | 拒绝未知 type |
| parser: variable interpolation | `${var}` 替换正确 |
| parser: step reference | `${steps.id.content}` 替换正确 |
| engine: sequential | 3 步顺序执行 |
| engine: branch true | 条件满足走 then |
| engine: branch false | 条件不满足走 else |
| engine: checkpoint pause | 暂停后 resume 继续 |
| engine: checkpoint auto-approve | 非交互模式自动通过 |
| engine: step budget | 单步预算耗尽时停止 |
| engine: step failure | 步骤失败终止工作流 |
| engine: state persistence | 杀掉进程后 resume 恢复 |
| engine: variable propagation | 步骤 A 的输出可被步骤 B 引用 |
| CLI: workflow run | 端到端 CLI 测试 |
| API: POST /api/workflows | API 启动工作流 |
| API: resume | API 恢复暂停的工作流 |

---

## 4. Phase 2: Agent 记忆系统

### 4.1 目标

让 Agent 具备跨任务记忆能力：短期会话摘要、长期结构化知识、共享项目上下文。

### 4.2 记忆类型

| 类型 | 生命周期 | 存储 | 用途 |
|------|----------|------|------|
| 短期记忆 | 单次会话 | `.memory/sessions/{id}/` | 对话摘要，上下文压缩 |
| 长期记忆 | 持久化 | `.memory/knowledge/{id}.json` | 事实、决策、偏好 |
| 项目上下文 | 持久化 | `.memory/context/{key}.md` | 架构约定、项目知识 |

### 4.3 核心类型

```typescript
// src/memory/types.ts

interface MemoryEntry {
  id: string;
  type: "fact" | "decision" | "preference" | "summary" | "context";
  content: string;
  source: string;                  // 创建者 agentType
  tags: string[];                  // 用于检索过滤
  timestamp: number;
  expiresAt?: number;              // 短期条目可设 TTL
}

interface ConversationSummary {
  sessionId: string;
  agentType: string;
  task: string;
  summary: string;                 // 压缩后的摘要
  keyDecisions: string[];          // 关键决策
  tokenCount: number;              // 原始 token 数
  timestamp: number;
}

interface ProjectContext {
  key: string;                     // 如 "architecture", "conventions"
  content: string;
  updatedAt: number;
  updatedBy: string;
}

interface MemoryConfig {
  enabled: boolean;
  dir: string;                     // 默认 ".memory"
  shortTermMaxEntries: number;     // 默认 50
  longTermMaxEntries: number;      // 默认 500
  summarizationThreshold: number;  // token 阈值，默认 8000
  autoSummarize: boolean;          // 默认 true
}
```

### 4.4 新增工具

```typescript
// MemoryRead — 读取记忆
{
  name: "MemoryRead",
  description: "从持久化记忆中检索相关事实、决策和上下文",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      tags: { type: "array", items: { type: "string" }, description: "标签过滤" },
      type: { type: "string", enum: ["fact","decision","preference","summary","context"] },
      limit: { type: "number", description: "最大返回条数，默认 10" },
    },
    required: ["query"],
  },
}

// MemoryWrite — 写入记忆
{
  name: "MemoryWrite",
  description: "将事实、决策或偏好写入持久化记忆",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["fact","decision","preference","context"] },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["type", "content", "tags"],
  },
}

// MemorySearch — 搜索记忆
{
  name: "MemorySearch",
  description: "跨记忆类型统一搜索",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["query"],
  },
}
```

### 4.5 新建文件

| 文件 | 用途 |
|------|------|
| `src/memory/types.ts` | MemoryEntry, ConversationSummary, ProjectContext, MemoryConfig |
| `src/memory/short-term.ts` | 会话级记忆管理，超阈值自动调用模型摘要 |
| `src/memory/short-term.test.ts` | 存取/摘要/隔离 测试 |
| `src/memory/long-term.ts` | 长期知识 CRUD，标签索引 |
| `src/memory/long-term.test.ts` | CRUD/搜索/持久化 测试 |
| `src/memory/project-context.ts` | 项目上下文读写 `.memory/context/{key}.md` |
| `src/memory/retriever.ts` | 统一查询接口，跨类型搜索 + 时间/标签权重排序 |
| `src/memory/retriever.test.ts` | 检索相关性排序测试 |
| `src/memory/tools.ts` | MemoryRead/Write/Search 工具定义 |
| `src/memory/index.ts` | 公共 API 导出 |

### 4.6 修改文件

| 文件 | 改动内容 |
|------|----------|
| `src/agent/tool-executor.ts` | 1. `executeTool()` switch 增加 `MemoryRead` / `MemoryWrite` / `MemorySearch` 分支<br>2. `ToolContext` 接口增加 `memory?: MemoryManager` |
| `src/agent/tools.ts` | `allTools` 数组增加 3 个记忆工具 |
| `src/agent/agent-loop.ts` | 1. `AgentLoopDeps` 增加 `memory?: MemoryManager`<br>2. 循环结束后若 autoSummarize=true 且 token 超阈值，调用摘要 |
| `src/config/types.ts` | `OrchestratorConfig` 增加 `memory?: MemoryConfig` |
| `src/config/validator.ts` | 增加 `MemoryConfigSchema` |
| `src/cli/main.ts` | 1. Orchestrator.init() 加载记忆系统<br>2. 新增 `memory list` — 列出长期记忆条目<br>3. 新增 `memory search <query>` — 搜索记忆<br>4. 新增 `memory clear` — 清空记忆 |
| `src/api/server.ts` | 新增：<br>- `GET /api/memory` — 列出记忆<br>- `GET /api/memory/search?q=` — 搜索<br>- `DELETE /api/memory` — 清空 |
| `orchestrator.yaml` | 新增配置段（见下方） |

### 4.7 配置变更

```yaml
memory:
  enabled: true
  dir: .memory
  shortTermMaxEntries: 50
  longTermMaxEntries: 500
  summarizationThreshold: 8000    # token 数超过此值触发自动摘要
  autoSummarize: true
```

### 4.8 自动摘要流程

```
AgentLoop 执行完毕
  ↓
计算 conversationHistory 的 token 数
  ↓
超过 summarizationThreshold?
  ↓ Yes
将完整历史发给模型，prompt:
  "总结以下对话，提取关键决策和事实，输出 JSON"
  ↓
模型返回摘要 JSON
  ↓
存入 .memory/sessions/{sessionId}/summary.json
  ↓
后续步骤使用摘要替代完整历史
```

### 4.9 存储结构

```
.memory/
  knowledge/                     # 长期记忆
    mem_a1b2c3.json              # 单条记忆条目
    mem_d4e5f6.json
  context/                       # 项目上下文
    architecture.md              # 项目架构
    conventions.md               # 编码规范
  sessions/                      # 短期会话
    sess_20260507_001/
      summary.json               # ConversationSummary
      entries.json               # 本次会话的 MemoryEntry[]
  index.json                     # 标签 → 条目 ID 索引
```

### 4.10 测试计划

| 测试 | 说明 |
|------|------|
| short-term: store/retrieve | 写入条目后能读回 |
| short-term: auto-summarize | 超阈值自动生成摘要 |
| short-term: session isolation | 不同会话互不干扰 |
| long-term: CRUD | 创建/读取/更新/删除 |
| long-term: tag search | 标签过滤返回正确结果 |
| long-term: persistence | 进程重启后数据仍在 |
| project-context: read/update | 读写项目上下文 |
| retriever: cross-type search | 跨类型统一搜索 |
| retriever: relevance ranking | 相关性排序正确 |
| tool: MemoryRead | 工具执行返回正确结果 |
| tool: MemoryWrite | 工具执行写入文件 |
| integration: agent uses memory | Agent 循环中使用记忆端到端 |

---

## 5. Phase 3: 插件系统

### 5.1 目标

用户通过 YAML 定义自定义工具，支持脚本执行、HTTP 调用、MCP 协议三种 handler。

### 5.2 插件 YAML 格式

```yaml
# .plugins/my-tools.yaml
name: my-custom-tools
description: 自定义工具集
version: "1.0"

tools:
  - name: DeployCheck
    description: 检查部署状态
    parameters:
      type: object
      properties:
        service: { type: string, description: "服务名" }
        environment: { type: string, enum: ["staging", "production"] }
      required: ["service", "environment"]
    handler:
      type: script                 # 脚本执行
      command: "bash"
      args: ["-c", "curl -s https://status.example.com/api/${service}/${environment}"]
    permissions: allow
    timeout: 10000

  - name: CreateIssue
    description: 创建 GitHub Issue
    parameters:
      type: object
      properties:
        repo: { type: string }
        title: { type: string }
        body: { type: string }
      required: ["repo", "title", "body"]
    handler:
      type: http                   # HTTP 调用
      url: "https://api.github.com/repos/${repo}/issues"
      method: POST
      headers:
        Authorization: "Bearer ${GITHUB_TOKEN}"
        Accept: "application/vnd.github.v3+json"
    permissions: ask

  - name: JiraTicket
    description: 查询 Jira 工单
    parameters:
      type: object
      properties:
        ticketId: { type: string }
      required: ["ticketId"]
    handler:
      type: mcp                    # MCP 工具调用
      server: jira-server
      tool: get_ticket
    permissions: allow
```

### 5.3 三种 Handler

| Handler | 执行方式 | 安全措施 |
|---------|----------|----------|
| `script` | `child_process.spawn` (shell:false) | 复用 safe-exec.ts，参数数组传递 |
| `http` | `fetch()` with timeout | URL 校验复用 web-tools.ts，环境变量替换 header |
| `mcp` | JSON-RPC 2.0 over stdio/SSE | 零依赖 MCP 客户端，连接生命周期管理 |

### 5.4 核心类型

```typescript
// src/plugins/types.ts

type PluginHandler =
  | { type: "script"; command: string; args?: string[] }
  | { type: "http"; url: string; method: "GET"|"POST"; headers?: Record<string, string> }
  | { type: "mcp"; server: string; tool: string };

interface PluginToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter;       // 复用已有的 ToolParameter 类型
  handler: PluginHandler;
  permissions?: ToolPermission;    // 复用已有的权限类型
  timeout?: number;
}

interface PluginDefinition {
  name: string;
  description?: string;
  version?: string;
  tools: PluginToolDefinition[];
}

type McpTransport =
  | { type: "stdio"; command: string; args?: string[] }
  | { type: "sse"; url: string };

interface McpServerConfig {
  name: string;
  transport: McpTransport;
  tools?: string[];                // 过滤暴露的工具，空 = 全部
}

interface PluginConfig {
  enabled: boolean;
  dir: string;                     // 默认 ".plugins"
  mcpServers?: McpServerConfig[];
}
```

### 5.5 新建文件

| 文件 | 用途 |
|------|------|
| `src/plugins/types.ts` | 插件相关类型定义 |
| `src/plugins/loader.ts` | 从 `.plugins/*.yaml` 加载插件定义 |
| `src/plugins/loader.test.ts` | 加载器测试 |
| `src/plugins/executor.ts` | 三种 handler 的执行器 |
| `src/plugins/executor.test.ts` | 执行器测试 |
| `src/plugins/registry.ts` | 合并内置 + 插件工具，权限过滤 |
| `src/plugins/registry.test.ts` | 注册表测试 |
| `src/plugins/mcp-client.ts` | MCP JSON-RPC 2.0 客户端（零依赖） |
| `src/plugins/mcp-client.test.ts` | MCP 客户端测试 |
| `.plugins/example-hello.yaml` | 示例插件 |

### 5.6 修改文件

| 文件 | 改动内容 |
|------|----------|
| `src/agent/tool-executor.ts` | 1. `executeTool()` switch 末尾增加插件工具分支 — 若工具名匹配已注册插件，委托给 `PluginExecutor`<br>2. `ToolContext` 增加 `pluginRegistry?: PluginRegistry` |
| `src/agent/tools.ts` | `getAllowedTools()` 增加 `pluginTools?: ToolDefinition[]` 参数，合并到返回列表 |
| `src/agent/agent-loop.ts` | `AgentLoopDeps` 增加 `pluginRegistry?: PluginRegistry`，传递到 ToolContext |
| `src/config/types.ts` | `OrchestratorConfig` 增加 `plugins?: PluginConfig` |
| `src/config/validator.ts` | 增加 `PluginConfigSchema` |
| `src/cli/main.ts` | 1. Orchestrator.init() 加载插件<br>2. 新增 `plugins list` 命令 |
| `src/cli/init.ts` | `init` 命令增加 `.plugins/` 目录脚手架 |
| `orchestrator.yaml` | 新增配置段（见下方） |

### 5.7 配置变更

```yaml
plugins:
  enabled: true
  dir: .plugins
  mcpServers:
    - name: jira-server
      transport:
        type: stdio
        command: "npx"
        args: ["-y", "@anthropic/mcp-jira"]
      tools: ["get_ticket", "search_tickets"]
    - name: github-mcp
      transport:
        type: sse
        url: "http://localhost:3001/sse"
```

### 5.8 MCP 客户端设计

零依赖实现 JSON-RPC 2.0 over stdio：

```
1. spawn MCP 服务器子进程
2. 发送 initialize 请求 (protocolVersion, capabilities)
3. 接收 initialize 响应
4. 发送 tools/list 请求
5. 接收工具列表，转换为 ToolDefinition[]
6. 工具调用时: 发送 tools/call 请求，接收结果
7. 进程退出时清理连接
```

错误处理：
- 服务器崩溃：自动重连 1 次
- 超时：默认 30s
- 协议错误：返回错误信息给 Agent

### 5.9 PluginRegistry 设计

```
启动时:
  1. 扫描 .plugins/*.yaml，加载所有 PluginDefinition
  2. 连接所有 mcpServers，发现工具
  3. 合并为统一工具列表
  4. 拒绝与内置工具同名的插件工具

运行时:
  getToolsForAgent(agentType) → 根据 agent 定义的权限过滤
  executePluginTool(name, args) → 路由到对应 handler
```

### 5.10 测试计划

| 测试 | 说明 |
|------|------|
| loader: valid YAML | 解析有效插件定义 |
| loader: invalid YAML | 拒绝格式错误的文件 |
| loader: duplicate names | 警告并跳过重名工具 |
| executor: script | 执行脚本，验证输出 |
| executor: http | Mock fetch，验证请求/响应 |
| executor: mcp | Mock MCP 服务器，验证调用 |
| executor: timeout | 超时返回错误 |
| registry: merge | 合并后工具列表正确 |
| registry: permission override | Agent 权限覆盖插件权限 |
| mcp-client: connect | stdio 连接成功 |
| mcp-client: discovery | 发现工具列表 |
| mcp-client: tool call | 调用工具返回结果 |
| mcp-client: reconnect | 重连成功 |
| integration: agent uses plugin | Agent 调用插件工具端到端 |

---

## 6. Phase 4: 协作模式增强

### 6.1 目标

扩展委员会模式，支持辩论（多轮互评）、审查链（迭代改进）、加权投票。

### 6.2 新增模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| 辩论 (debate) | 多 Agent 多轮交替评论，可选主持人综合 | 架构决策、方案评审 |
| 审查链 (review-chain) | coder→reviewer→coder 迭代循环 | 代码实现、质量保证 |
| 加权投票 (weighted-vote) | 委员会 + 可配置权重 | 多专家意见综合 |

### 6.3 核心类型

```typescript
// src/agent/collaboration/types.ts

type CollaborationMode = "committee" | "debate" | "review-chain" | "weighted-vote";

interface DebateConfig {
  rounds: number;                  // 辩论轮数，默认 2
  participants: string[];          // 参与者 agent 类型
  moderator?: string;              // 主持人 agent 类型（可选）
  prompt: string;                  // 初始议题
}

interface ReviewChainConfig {
  coder: string;                   // 编码 agent 类型
  reviewer: string;                // 审查 agent 类型
  maxIterations: number;           // 最大迭代次数，默认 3
  acceptThreshold: "auto" | "manual";  // auto=reviewer 判定, manual=人工审批
}

interface WeightedVoteConfig {
  agentTypes: string[];
  weights: Record<string, number>; // agentType → 权重
  strategy: "weighted-majority" | "weighted-best";
}

interface DebateRoundResult {
  round: number;
  responses: { agentType: string; content: string }[];
}

interface ReviewChainIteration {
  iteration: number;
  coderResult: AgentResult;
  reviewerResult: AgentResult;
  accepted: boolean;
  feedback?: string;
}
```

### 6.4 辩论模式流程

```
Round 1: 所有参与者收到初始 prompt → 各自产出初始回答
    ↓
Round 2..N: 每个参与者收到所有人的上轮回答
  Prompt: "以下是其他参与者的回答，请质疑、改进或补充你的立场"
  → 各自产出评论和修订
    ↓
Round N+1 (如有 moderator):
  主持人收到所有轮次的完整记录
  → 产出最终综合答案
    ↓
输出: 拼接最终轮结果 或 主持人综合答案
```

### 6.5 审查链流程

```
1. Coder 收到任务 → 产出代码/方案
    ↓
2. Reviewer 收到 Coder 的输出
   → 审查并判断:
     - "LGTM" / "APPROVED" → 结束
     - "NEEDS_CHANGES: <反馈>" → 继续
    ↓
3. (如有 manual 检查点) 暂停等待人工审批
    ↓
4. Coder 收到 Reviewer 反馈 → 修订版本
    ↓
5. 回到步骤 2，直到 LGTM 或达到 maxIterations
    ↓
6. 输出最终版本
```

Reviewer 的 system prompt 末尾追加：
```
请在审查末尾用以下格式之一结束:
- "LGTM" 或 "APPROVED" — 代码可以接受
- "NEEDS_CHANGES: <具体反馈>" — 需要修改
```

### 6.6 加权投票

扩展现有 Committee 聚合策略：

- `weighted-majority`: 每个 Agent 的投票乘以权重，加权和最高的状态胜出
- `weighted-best`: 类似 "best"，但评分 = content_length × weight

### 6.7 新建文件

| 文件 | 用途 |
|------|------|
| `src/agent/collaboration/types.ts` | 协作相关类型 |
| `src/agent/collaboration/debate.ts` | 辩论模式实现 |
| `src/agent/collaboration/debate.test.ts` | 辩论测试 |
| `src/agent/collaboration/review-chain.ts` | 审查链实现 |
| `src/agent/collaboration/review-chain.test.ts` | 审查链测试 |
| `src/agent/collaboration/weighted-vote.ts` | 加权投票实现 |
| `src/agent/collaboration/weighted-vote.test.ts` | 加权投票测试 |

### 6.8 修改文件

| 文件 | 改动内容 |
|------|----------|
| `src/agent/committee.ts` | 1. `AggregationStrategy` 增加 `"weighted-majority"` 和 `"weighted-best"`<br>2. `CommitteeConfig` 增加可选 `weights?: Record<string, number>` |
| `src/cli/main.ts` | 1. 新增 `debate <task>` 命令（`--participants`, `--rounds`, `--moderator`）<br>2. 新增 `review-chain <task>` 命令（`--coder`, `--reviewer`, `--max-iterations`）<br>3. `run` 命令的 `--mode` 增加 `debate` 和 `review-chain` 选项<br>4. Orchestrator 新增 `debate()` 和 `reviewChain()` 方法 |
| `src/api/server.ts` | `POST /api/tasks` body 的 `mode` 字段增加 `"debate"` / `"review-chain"` / `"weighted-vote"` |

### 6.9 测试计划

| 测试 | 说明 |
|------|------|
| debate: single round | 2 Agent 1 轮，验证都有响应 |
| debate: multi-round | 2 Agent 3 轮，验证包含评论 |
| debate: moderator | 主持人综合产出最终答案 |
| debate: budget limit | 预算耗尽时停止辩论 |
| review-chain: approve first | Reviewer 首次通过 |
| review-chain: iterate | 多次迭代改进 |
| review-chain: max iterations | 达到上限返回最佳版本 |
| review-chain: manual checkpoint | 人工审批流程 |
| weighted-vote: majority | 权重影响投票结果 |
| weighted-vote: best | 高权重 Agent 的长内容胜出 |
| CLI: debate 命令 | 端到端测试 |
| CLI: review-chain 命令 | 端到端测试 |

---

## 7. Phase 5: Web Dashboard

### 7.1 目标

浏览器端 Dashboard，实时任务监控、成本分析、执行树可视化。

### 7.2 设计原则

- **单文件 Dashboard**：一个 `dashboard.html` 文件，内联 CSS + JS
- **零外部依赖**：不用 React/Vue/任何前端框架
- **实时更新**：复用现有 SSE 基础设施
- **渐进增强**：先做核心功能，后续迭代

### 7.3 Dashboard 布局

```
+───────────────────────────────────────────────────────+
│ 成本面板: ¥12.35 / ¥35.00 | DeepSeek: ¥8.2 GLM: ¥4.1│
+──────────────────┬────────────────────────────────────+
│                  │                                     │
│  任务列表        │  实时流 / 执行详情                    │
│                  │                                     │
│  ● 运行中 (2)    │  Step 3/5: coder 执行中              │
│    #001 main     │  > Read src/agent/tools.ts           │
│    #002 explore  │  ✓ 45ms                              │
│                  │  > Edit src/agent/tools.ts            │
│  ✓ 已完成 (5)    │  ✗ 12ms (no match)                   │
│    #003 coder    │  > Edit src/agent/tools.ts            │
│    #004 review   │  ✓ 8ms                                │
│    ...           │                                     │
│                  │  ┌─ 执行树 ─────────────────────┐    │
│  ✗ 失败 (1)      │  │ main                        │    │
│    #005 fix      │  │ ├─ explore ✓ ¥1.2           │    │
│                  │  │ ├─ coder   ● ¥3.4           │    │
│                  │  │ │  └─ reviewer ⏳            │    │
│                  │  │ └─ architect ✓ ¥0.8         │    │
│                  │  └─────────────────────────────┘    │
+──────────────────┴─────────────────────────────────────+
│ [工作流进度] Step 3/4: implement → review → fix → done  │
+────────────────────────────────────────────────────────+
```

### 7.4 技术实现

- **HTML**: 语义化标签，CSS Grid 布局
- **CSS**: CSS 变量主题，动画过渡，暗色模式
- **JS**: 原生 `EventSource` 接收 SSE，`fetch` 调用 API
- **实时更新**: `EventSource` 监听 `/api/dashboard/events`，收到事件后 DOM 更新
- **成本图表**: 纯 CSS sparkline（无 chart 库）

### 7.5 新建文件

| 文件 | 用途 |
|------|------|
| `src/api/dashboard-handler.ts` | Dashboard 路由处理：`GET /dashboard` 返回 HTML |
| `src/api/dashboard.html` | 单文件 Dashboard（HTML + 内联 CSS + 内联 JS） |
| `src/api/dashboard-handler.test.ts` | Dashboard 端点测试 |

### 7.6 修改文件

| 文件 | 改动内容 |
|------|----------|
| `src/api/server.ts` | 1. 新增 `GET /dashboard` — 返回 dashboard.html<br>2. 新增 `GET /api/tasks/history` — 已完成任务历史<br>3. 新增 `GET /api/dashboard/events` — 全局 SSE 广播 |
| `src/api/task-manager.ts` | 1. 新增 `listCompleted()` 方法<br>2. 内存中保留最近 N 个已完成任务 |
| `src/api/sse.ts` | 新增全局 `SSEClientSet` 用于系统级广播（非单任务） |
| `src/cli/main.ts` | 新增 `--dashboard-web` 标志，启动 API 并打印 Dashboard URL |

### 7.7 配置变更

```yaml
api:
  enabled: true
  host: 127.0.0.1
  port: 3100
  dashboard:
    enabled: true              # 是否提供 /dashboard 路由
    historyRetention: 100      # 内存中保留的已完成任务数
```

### 7.8 测试计划

| 测试 | 说明 |
|------|------|
| GET /dashboard | 返回 HTML 200 |
| GET /api/tasks/history | 返回已完成任务列表 |
| SSE /api/dashboard/events | 接收系统事件 |
| SSE task lifecycle | 任务提交→运行→完成广播事件 |
| Dashboard HTML integrity | HTML 合法，包含预期元素 |
| Cost API | 成本数据正确 |

---

## 8. Phase 依赖与开发顺序

```
Phase 1 (工作流) ── 无依赖，最先开发
Phase 2 (记忆)   ── 无依赖，可与 Phase 1 并行
Phase 3 (插件)   ── 无依赖，可与 Phase 1 并行
Phase 4 (协作)   ── 依赖 Phase 1（工作流步骤可使用 debate/review-chain）
Phase 5 (Web UI) ── 依赖 Phase 1 + Phase 4（可视化工作流和协作）
```

**推荐开发顺序**：1 → 2 → 3 → 4 → 5

### 工作量估算

| Phase | 天数 | 风险 | 价值 |
|-------|------|------|------|
| 1. 工作流引擎 | 5-7 | 中 | 极高 |
| 2. 记忆系统 | 3-4 | 低 | 高 |
| 3. 插件系统 | 4-5 | 中高 | 高 |
| 4. 协作模式 | 3-4 | 低 | 中 |
| 5. Web Dashboard | 3-4 | 低 | 中 |
| **合计** | **18-24** | | |

---

## 9. 每个 Phase 的改动清单汇总

### 文件改动矩阵

| 文件 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|------|---------|---------|---------|---------|---------|
| `src/cli/main.ts` | +workflow 命令 | +memory 命令 | +plugins 命令 | +debate/review-chain 命令 | +--dashboard-web |
| `src/config/types.ts` | +workflows | +memory | +plugins | — | +api.dashboard |
| `src/config/validator.ts` | +WorkflowsConfigSchema | +MemoryConfigSchema | +PluginConfigSchema | — | — |
| `src/config/loader.ts` | +loadWorkflow | — | — | — | — |
| `src/agent/agent-loop.ts` | — | +memory 到 Deps | +pluginRegistry 到 Deps | — | — |
| `src/agent/tool-executor.ts` | — | +Memory 工具分支 | +Plugin 工具分支 | — | — |
| `src/agent/tools.ts` | — | +Memory 工具定义 | +pluginTools 参数 | — | — |
| `src/agent/committee.ts` | — | — | — | +weighted 策略 | — |
| `src/api/server.ts` | +workflow 端点 | +memory 端点 | — | +mode: debate | +dashboard 路由 |
| `src/api/task-manager.ts` | — | — | — | — | +listCompleted |
| `src/api/sse.ts` | — | — | — | — | +全局广播 |
| `orchestrator.yaml` | +workflows | +memory | +plugins | — | +api.dashboard |

### 新增文件汇总

| Phase | 新增文件数 | 目录 |
|-------|-----------|------|
| Phase 1 | 10 | `src/workflow/` + `.workflows/` |
| Phase 2 | 10 | `src/memory/` |
| Phase 3 | 10 | `src/plugins/` + `.plugins/` |
| Phase 4 | 7 | `src/agent/collaboration/` |
| Phase 5 | 3 | `src/api/` |
| **合计** | **40** | |

---

## 10. 验证标准

每个 Phase 完成后必须满足：

1. `npm run typecheck` — 零 TS 编译错误
2. `npm test` — 所有旧测试 + 新测试通过
3. `npm run build` — esbuild 构建成功
4. 手动验证新增 CLI 命令可执行
5. 手动验证新增 API 端点可访问
6. 新增代码无 TODO/FIXME
