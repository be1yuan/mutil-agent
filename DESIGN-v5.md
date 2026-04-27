# Multi-Agent Orchestrator v5 — 轻量自编排架构

## 一、架构决策

### 1.1 废弃独立 Orchestrator 层

DESIGN-v4 的四阶段 Coordinator（Research → Synthesize → Implement → Verify）源于 Claude Code 泄露源码的设计，但**独立编排层已被实践证伪**：

- Kilo Code 废弃了独立 Orchestrator Mode，转而让 Agent 自身判断是否需要委派
- 独立的 TaskPlanner + AgentRouter + CommunicationHub 增加了代码量、调试难度和延迟，但并未带来对应价值
- 编排本质上是决策，决策应该内嵌在执行主体的循环中，而不是外包给一个上层模块

**v5 方案**：Agent 主循环内嵌复杂度判断，复杂任务通过 `task` 原语拆分子 Agent 会话。

### 1.2 对比

| 维度 | DESIGN-v4 | DESIGN-v5 |
|------|-----------|-----------|
| 编排模型 | 独立 Coordinator 四阶段 | Agent 自编排，内嵌判断 |
| 子任务通信 | 内存队列 + 文件邮箱 | task 原语，独立会话上下文 |
| 复杂度评估 | 独立 ComplexityEvaluator 模块 | Agent 推理时自行判断 |
| Agent 配置 | YAML + Zod | Markdown frontmatter（主）+ YAML（兼容） |
| 权限控制 | Allowlist/Denylist 全局 | 工具级 allow/ask/deny + Bash glob |
| 成本控制 | 预算上限 + 80% 告警 | 预算上限 + steps 上限双保险 |
| 隔离机制 | Git worktree（MVP 就包含） | 独立会话上下文（worktree 推到 v0.2） |
| 模型支持 | DeepSeek + Kimi | DeepSeek V4-Pro + GLM-5.1 |

---

## 二、整体架构

```
┌──────────────────────────────────────────┐
│              CLI / Programmatic API       │
└────────────────────┬─────────────────────┘
                     │
┌────────────────────▼─────────────────────┐
│              Main Agent                  │
│                                          │
│   ┌──────────┐  ┌───────────────────┐   │
│   │ 内嵌复杂度 │  │  Adapter Selector │   │
│   │ 判断      │  │  (DeepSeek / GLM) │   │
│   └─────┬────┘  └────────┬──────────┘   │
│         │                │               │
│   ┌─────▼────┐    ┌──────▼──────┐       │
│   │ 简单任务  │    │  模型调用    │       │
│   │ 直接执行  │    │  (Anthropic │       │
│   └──────────┘    │   兼容格式)  │       │
│                   └─────────────┘       │
│                                          │
│   ┌──────────────────────────────────┐  │
│   │ task 原语 (复杂任务拆分子 Agent)  │  │
│   │  - spawn sub-agent (独立会话)     │  │
│   │  - 结果回传                       │  │
│   │  - steps 计数器                   │  │
│   └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
    ┌────────┐ ┌────────┐ ┌────────┐
    │ Sub    │ │ Sub    │ │ Sub    │
    │ Agent  │ │ Agent  │ │ Agent  │
    │ (coder)│ │(explore│ │(review)│
    └────────┘ └────────┘ └────────┘
```

---

## 三、Agent 定义系统

### 3.1 Markdown Frontmatter 格式（主格式）

Agent 定义文件放在 `.agents/` 目录下，文件名即 Agent 类型。正文是 system prompt。

```markdown
---
agentType: coder
model: deepseek-v4-pro
provider: deepseek
tools:
  - Read: allow
  - Write: allow
  - Edit: allow
  - Bash:
      allow:
        - "npm *"
        - "git status"
        - "git diff"
        - "git log *"
      ask:
        - "git commit *"
        - "git push *"
      deny:
        - "rm *"
        - "git push --force*"
  - Grep: allow
  - Glob: allow
  - WebSearch: ask
  - WebFetch: ask
maxSteps: 50
timeout: 300000
---

你是一个资深软件工程师。你的职责是：
1. 理解任务需求，读取相关代码
2. 规划修改方案
3. 实现代码修改
4. 验证修改正确性

原则：
- 不要做半成品实现
- 修改完代码后运行相关测试
- 遇到不确定的事情使用 ask 权限工具时需要向用户确认
```

### 3.2 TypeScript 类型定义

```typescript
// src/agents/types.ts

/** 权限决策 */
type Permission = "allow" | "ask" | "deny";

/** 工具权限：简单模式 */
type SimpleToolPermission = Permission;

/** 工具权限：Bash 专有的 glob 匹配模式 */
interface BashPermission {
  allow?: string[];  // glob 模式
  ask?: string[];
  deny?: string[];
}

/** 工具权限联合 */
type ToolPermission = SimpleToolPermission | BashPermission;

/** Agent 定义 */
interface AgentDefinition {
  agentType: string;           // 唯一标识，对应文件名
  model: string;               // 模型标识
  provider: ModelProvider;     // 模型提供商
  description?: string;        // 用途简述
  tools: Record<string, ToolPermission>;  // 工具名 → 权限
  maxSteps: number;            // 最大迭代步数
  timeout: number;             // 超时 ms
  isolation?: "context" | "worktree";  // 隔离方式，默认 context
}

type ModelProvider = "deepseek" | "zhipu";

/** 解析后的工具列表（用于构建 tool 调用） */
interface ResolvedTools {
  allowed: string[];
  ask: string[];
  denied: string[];
  bashPatterns: {
    allow: string[];
    ask: string[];
    deny: string[];
  };
}
```

### 3.3 权限解析引擎

```typescript
// src/security/permission-resolver.ts

import { minimatch } from "minimatch";

class PermissionResolver {
  /**
   * 判断 Agent 能否使用某个工具。
   * Bash 工具走 glob 匹配，其余工具走简单匹配。
   */
  canUse(
    definition: AgentDefinition,
    toolName: string,
    bashCommand?: string
  ): { decision: Permission; needsApproval: boolean } {
    const perm = definition.tools[toolName];

    // 工具未列在定义中 → 默认拒绝
    if (!perm) return { decision: "deny", needsApproval: false };

    // Bash 工具：逐 glob 匹配
    if (toolName === "Bash" && bashCommand && typeof perm === "object") {
      return this.resolveBash(perm, bashCommand);
    }

    // 其余工具：简单值
    const decision = typeof perm === "string" ? perm : "deny";
    return {
      decision,
      needsApproval: decision === "ask",
    };
  }

  private resolveBash(
    perm: BashPermission,
    command: string
  ): { decision: Permission; needsApproval: boolean } {
    // deny 优先
    for (const pattern of perm.deny ?? []) {
      if (minimatch(command, pattern)) return { decision: "deny", needsApproval: false };
    }
    // ask 其次
    for (const pattern of perm.ask ?? []) {
      if (minimatch(command, pattern)) return { decision: "ask", needsApproval: true };
    }
    // allow 兜底
    for (const pattern of perm.allow ?? []) {
      if (minimatch(command, pattern)) return { decision: "allow", needsApproval: false };
    }
    // 无匹配 → 默认 ask（安全默认值）
    return { decision: "ask", needsApproval: true };
  }
}
```

---

## 四、模型适配器

### 4.1 统一接口

```typescript
// src/adapters/types.ts

interface ModelAdapter {
  readonly provider: ModelProvider;

  /** 非流式调用 */
  chat(params: ChatParams): Promise<ChatResponse>;

  /** 流式调用 */
  chatStream(params: ChatParams): AsyncIterable<ChatStreamChunk>;

  /** 模型元信息 */
  getModelInfo(): ModelInfo;
}

interface ChatParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
}

interface ModelInfo {
  name: string;
  provider: ModelProvider;
  contextWindow: number;
  pricing: { input: number; output: number; cacheHit?: number };
  capabilities: {
    toolCalling: boolean;
    streaming: boolean;
    jsonMode: boolean;
    thinking: boolean;
  };
}
```

### 4.2 DeepSeek 适配器

```typescript
// src/adapters/deepseek-adapter.ts
// api.deepseek.com/anthropic — Anthropic 兼容端点

class DeepSeekAdapter implements ModelAdapter {
  readonly provider = "deepseek";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      baseURL: "https://api.deepseek.com/anthropic",
      apiKey,
    });
  }

  getModelInfo(): ModelInfo {
    return {
      name: "deepseek-v4-pro",
      provider: "deepseek",
      contextWindow: 1_000_000,
      pricing: { input: 0.41, output: 0.82, cacheHit: 0.0034 },
      capabilities: {
        toolCalling: true, streaming: true, jsonMode: true, thinking: true,
      },
    };
  }
  // ...
}
```

### 4.3 GLM 适配器

```typescript
// src/adapters/glm-adapter.ts
// open.bigmodel.cn/api/anthropic — Anthropic 兼容端点

class GLMAdapter implements ModelAdapter {
  readonly provider = "zhipu";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      baseURL: "https://open.bigmodel.cn/api/anthropic",
      apiKey,
    });
  }

  getModelInfo(): ModelInfo {
    return {
      name: "glm-5.1",
      provider: "zhipu",
      contextWindow: 200_000,
      pricing: { input: 1.00, output: 3.20 },
      capabilities: {
        toolCalling: true, streaming: true, jsonMode: true, thinking: true,
      },
    };
  }
  // ...
}
```

> 两个模型都通过 Anthropic 兼容端点接入，适配器代码高度一致，主要差异仅在各厂商的 baseURL 和 error normalization 逻辑。

### 4.4 故障转移

```typescript
// src/adapters/fallback-executor.ts

interface FallbackPolicy {
  maxRetries: number;
  retryDelayMs: number;
  retryableErrors: string[];
  fallbackModel?: { provider: ModelProvider; model: string };
}

class FallbackExecutor {
  constructor(
    private adapters: Map<ModelProvider, ModelAdapter>,
    private policy: FallbackPolicy
  ) {}

  async execute(params: ChatParams, provider: ModelProvider): Promise<ChatResponse> {
    let lastError: Error | undefined;
    let currentProvider = provider;
    let currentModel = params.model;

    for (let attempt = 0; attempt <= this.policy.maxRetries; attempt++) {
      try {
        const adapter = this.adapters.get(currentProvider)!;
        return await adapter.chat({ ...params, model: currentModel });
      } catch (error) {
        lastError = error as Error;
        if (!this.isRetryable(error)) break;
        if (attempt < this.policy.maxRetries) {
          await sleep(this.policy.retryDelayMs * 2 ** attempt);
        }
      }
    }

    // 跨模型 fallback
    if (this.policy.fallbackModel && currentProvider !== this.policy.fallbackModel.provider) {
      logger.warn("fallback.switching", { from: currentProvider, to: this.policy.fallbackModel.provider });
      const adapter = this.adapters.get(this.policy.fallbackModel.provider);
      if (adapter) {
        return adapter.chat({ ...params, model: this.policy.fallbackModel.model });
      }
    }

    throw new ModelUnavailableError(lastError?.message ?? "Unknown error");
  }

  private isRetryable(error: unknown): boolean {
    // 429 / 5xx / timeout → retryable
  }
}
```

---

## 五、Agent 主循环

### 5.1 单 Agent 执行循环（自编排）

```typescript
// src/agent/agent-loop.ts

type AgentPhase = "planning" | "executing" | "complete";

class AgentLoop {
  private adapterSelector: AdapterSelector;
  private permissionResolver: PermissionResolver;
  private costTracker: CostTracker;

  async run(
    task: string,
    definition: AgentDefinition,
    budget: number
  ): Promise<AgentResult> {
    const history: Message[] = [{ role: "user", content: task }];
    let steps = 0;
    let phase: AgentPhase = "planning";

    while (steps < definition.maxSteps) {
      // 1. 选择模型并调用
      const provider = this.adapterSelector.select(task, definition);
      const response = await this.callModel(provider, history, definition.tools);

      // 2. 成本追踪
      this.costTracker.record(response.usage, provider);
      if (this.costTracker.spent > budget) {
        return { status: "budget_exceeded", steps, cost: this.costTracker.spent };
      }

      // 3. 处理 tool calls
      if (response.toolCalls.length === 0) {
        // 无工具调用 → 模型输出最终结果
        return { status: "success", content: response.content, steps, cost: this.costTracker.spent };
      }

      // 4. 执行工具
      for (const tc of response.toolCalls) {
        const { decision, needsApproval } = this.permissionResolver.canUse(
          definition, tc.name, tc.arguments?.command
        );

        if (decision === "deny") {
          history.push({ role: "tool", content: `[denied] ${tc.name}` });
          continue;
        }

        if (needsApproval) {
          const approved = await this.requestUserApproval(tc);
          if (!approved) {
            history.push({ role: "tool", content: `[user denied] ${tc.name}` });
            continue;
          }
        }

        // task 工具：spawn 子 Agent
        if (tc.name === "task") {
          const subResult = await this.spawnSubAgent(tc.arguments);
          history.push({ role: "tool", content: JSON.stringify(subResult) });
        } else {
          const result = await this.executeTool(tc);
          history.push({ role: "tool", content: JSON.stringify(result) });
        }
      }

      steps++;
    }

    return { status: "max_steps_reached", steps, cost: this.costTracker.spent };
  }

  /** 子 Agent 调用：独立会话，结果回传 */
  private async spawnSubAgent(args: SubAgentArgs): Promise<SubAgentResult> {
    const subDef = this.loadAgentDefinition(args.agentType);
    const subLoop = new AgentLoop(/* 相同的依赖注入 */);
    return subLoop.run(args.task, subDef, this.costTracker.remaining);
  }
}
```

### 5.2 task 原语定义

```typescript
interface SubAgentArgs {
  agentType: string;    // 目标 Agent 类型，如 "explore" / "coder" / "reviewer"
  task: string;         // 子任务描述
  context?: {           // 传递给子 Agent 的上下文
    files?: string[];
    description?: string;
  };
}
```

### 5.3 模型选择策略

```typescript
// src/agent/adapter-selector.ts

class AdapterSelector {
  /**
   * 简陋但有效的模型选择：
   * - 有大量推理需求 → DeepSeek（Codeforces 3206，代码能力最强）
   * - 长上下文分析 → DeepSeek（1M context window）
   * - 普通编码任务 → 轮询 / 成本优先 / 可用优先
   */
  select(task: string, definition: AgentDefinition): ModelProvider {
    // 简单规则：Agent 配置里指定了 provider 就沿用
    // 主 Agent 未指定时默认 DeepSeek（能力更强），成本敏感时切 GLM
    if (definition.provider) return definition.provider;
    return "deepseek"; // 默认
  }
}
```

---

## 六、成本与安全控制

### 6.1 双保险：预算上限 + 步数上限

```typescript
// src/observability/cost-tracker.ts

class CostTracker {
  constructor(private budget: number) {}

  private _spent = 0;

  get spent(): number { return this._spent; }
  get remaining(): number { return this.budget - this._spent; }

  /** 每次模型调用后记录 */
  record(usage: Usage, provider: ModelProvider): void {
    const pricing = this.getPricing(provider);
    const cost =
      (usage.inputTokens / 1_000_000) * pricing.input +
      (usage.outputTokens / 1_000_000) * pricing.output;
    this._spent += cost;

    if (this._spent > this.budget * 0.8) {
      logger.warn("cost.budget_warning", { spent: this._spent, budget: this.budget });
    }
  }
}
```

### 6.2 权限架构

```
工具调用到达
    │
    ▼
工具名在 AgentDefinition.tools 中？
    │
 ┌──┴──────────┐
 ▼             ▼
否 → deny     是 → 取值类型？
                   │
          ┌────────┴────────┐
          ▼                 ▼
      "allow"/"ask"     { allow, ask, deny }
      /"deny"           (BashPermission)
      (字符串)              │
          │                 ▼
          │          命令匹配 glob 模式
          │          deny → ask → allow → 默认 ask
          │
          ▼
      allow → 直接执行
      ask   → 弹出用户确认
      deny  → 拒绝并记录
```

---

## 七、配置系统

### 7.1 主配置文件（YAML）

```yaml
# orchestrator.yaml

providers:
  deepseek:
    apiKey: "${DEEPSEEK_API_KEY}"
    baseURL: "https://api.deepseek.com/anthropic"
    defaultModel: "deepseek-v4-pro"

  zhipu:
    apiKey: "${ZHIPU_API_KEY}"
    baseURL: "https://open.bigmodel.cn/api/anthropic"
    defaultModel: "glm-5.1"

fallback:
  maxRetries: 3
  retryDelayMs: 1000
  retryableErrors: ["rate_limit", "timeout", "server_error"]
  fallbackModel:
    provider: "zhipu"
    model: "glm-5.1"

security:
  maxConcurrentAgents: 5
  requireApproval:
    - "file.delete"
    - "git.push"

budget:
  maxDollars: 5.0

observability:
  logLevel: "info"
  metricsEnabled: true
```

### 7.2 Agent 定义文件（Markdown）

```
.agents/
├── main.md           # 主 Agent，全功能
├── explore.md        # 只读探索
├── coder.md          # 代码编写
└── reviewer.md       # 代码审查
```

### 7.3 配置验证（Zod）

```typescript
// src/config/validator.ts
import { z } from "zod";

const ProviderConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseURL: z.string().url(),
  defaultModel: z.string().min(1),
});

const ConfigSchema = z.object({
  providers: z.record(ProviderConfigSchema).refine(
    (p) => Object.keys(p).length >= 1,
    "At least one provider is required"
  ),
  security: z.object({
    maxConcurrentAgents: z.number().int().min(1).max(20).default(5),
  }),
  budget: z.object({
    maxDollars: z.number().positive().default(5),
  }),
  observability: z.object({
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    metricsEnabled: z.boolean().default(true),
  }),
});

type Config = z.infer<typeof ConfigSchema>;
```

---

## 八、CLI 接口

```bash
# 直接执行任务
multi-agent run "重构 auth 模块的 token 刷新逻辑" \
  --config orchestrator.yaml \
  --budget 3.0 \
  --agent main

# 列出可用 Agent
multi-agent list-agents --config orchestrator.yaml

# 校验配置 / Agent 定义
multi-agent validate --config orchestrator.yaml
```

---

## 九、项目结构

```
multi-agent-orchestrator/
├── src/
│   ├── agent/
│   │   ├── agent-loop.ts          # Agent 主执行循环（自编排）
│   │   ├── adapter-selector.ts    # 模型选择
│   │   └── sub-agent-spawner.ts   # task 原语实现
│   ├── adapters/
│   │   ├── types.ts               # ModelAdapter 接口
│   │   ├── anthropic-client.ts    # Anthropic SDK 封装（共享）
│   │   ├── deepseek-adapter.ts
│   │   ├── glm-adapter.ts
│   │   └── fallback-executor.ts   # 重试 + 跨模型切换
│   ├── security/
│   │   ├── permission-resolver.ts # 权限解析引擎（glob 匹配）
│   │   └── safe-exec.ts           # spawn 参数数组执行
│   ├── config/
│   │   ├── loader.ts              # YAML + Markdown 加载
│   │   ├── validator.ts           # Zod schema
│   │   └── types.ts
│   ├── observability/
│   │   ├── logger.ts              # 结构化日志
│   │   ├── cost-tracker.ts        # 预算 + 步数双保险
│   │   └── metrics.ts             # Prometheus 指标
│   └── cli/
│       └── main.ts                # CLI 入口
├── .agents/                       # Agent 定义（Markdown）
│   ├── main.md
│   ├── explore.md
│   ├── coder.md
│   └── reviewer.md
├── orchestrator.yaml              # 主配置
├── tests/
└── package.json
```

---

## 十、与 v4 的关键差异

| 维度 | v4 | v5 |
|------|-----|-----|
| 编排架构 | 独立 Coordinator 四阶段 | Agent 自编排，内嵌判断 |
| 通信 | 内存队列 + 文件邮箱 + HTTP | task 原语，独立会话上下文 |
| Agent 配置 | YAML only | Markdown frontmatter（主）+ YAML（兼容）|
| 权限控制 | 全局 Allowlist | 工具级 allow/ask/deny + Bash glob |
| 成本控制 | 预算上限 + 80% | 预算上限 + steps 双保险 |
| Committee/投票 | 不支持 | 预留接口，v0.3 |
| 隔离 | Git worktree（MVP 包含） | 上下文隔离（worktree → v0.2）|
| 模型 | DeepSeek + Kimi | DeepSeek V4-Pro + GLM-5.1 |
| MVP 周期 | 5-7 周 | 3-4 周（砍掉了队列/worktree 的实现成本）|

---

## 十一、MVP 范围与后续路线

### MVP（3-4 周）
- Agent 主循环 + task 原语
- DeepSeek + GLM 适配器（Anthropic 兼容端点）
- Markdown 定义 Agent + YAML 主配置
- 权限解析引擎（allow/ask/deny + Bash glob）
- 故障转移（同一模型重试 3 次 → 切备用模型）
- 成本双保险（budget + steps）
- 结构化日志

### v0.2（+2 周）
- Git worktree 隔离
- Committee 模式（多 Agent 投票）

### v0.3（+2 周）
- 文件邮箱（跨进程持久化）
- HTTP API（独立部署模式）

### v1.0（+3-4 周）
- GLM + MiniMax 适配
- Web 监控面板
- 生产就绪测试
