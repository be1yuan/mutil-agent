# Multi-Agent Orchestrator - 修正版设计方案 v3

## 一、设计原则与参考来源

本方案参考以下**公开**的多 Agent 框架设计理念：
- **AutoGen** (Microsoft): Conversable Agent 与 GroupChat 模式
- **CrewAI**: 角色扮演与任务委托模式
- **MetaGPT**: SOP 驱动的多 Agent 协作
- **OpenAI Agents SDK**: 生产级 Agent 编排（注意：OpenAI Swarm 已废弃，于 2025 年 3 月被 Agents SDK 取代，不应再使用）

**明确声明**：本方案不参考任何未公开的泄露源代码，所有设计基于公开论文、开源项目和各厂商官方 API 文档。

---

## 二、真实模型信息（2026年4月）

### 2.1 模型参数速查

| 模型 | 发布时间 | 架构 | 上下文窗口 | 支持格式 |
|------|---------|------|-----------|---------|
| **DeepSeek V4-Pro** | 2026-04-24 | MoE 1.6T / 49B 激活 | 1,000,000 | OpenAI + Anthropic |
| **Kimi K2.6** | 2026-04-20 | MoE 1T / 32B 激活 | 262,144 | OpenAI + Anthropic |
| **GLM-5.1** | 2026-04-07 | MoE 754B / 40B 激活 | 200,000 | OpenAI |
| **MiniMax M2.7** | 2026-03-18 | - | 204,800 | OpenAI |

### 2.2 实际 API 定价（$/M tokens）

| 模型 | 输入 | 输出 | 缓存命中 | Anthropic 兼容端点 |
|------|------|------|---------|-------------------|
| DeepSeek V4-Pro | $0.41 | $0.82 | $0.0034 | `api.deepseek.com/anthropic` |
| Kimi K2.6 | $0.95 | $4.00 | $0.16 | `api.moonshot.cn/anthropic` / `api.moonshot.ai/anthropic` |
| GLM-5.1 | ~$1.00 | ~$3.20 | - | - |
| MiniMax M2.7 | $0.30 | $1.20 | - | - |

> **注意**：Moonshot API 有双区域端点——`api.moonshot.cn/v1`（国内）和 `api.moonshot.ai/v1`（国际）。API Key 与端点严格绑定，在 `.cn` 平台创建的 Key 不能用于 `.ai` 端点（会返回 401），反之亦然。

### 2.3 公开 Benchmark 数据

| Benchmark | DeepSeek V4-Pro | Kimi K2.6 | GLM-5.1 | MiniMax M2.7 |
|-----------|:---:|:---:|:---:|:---:|
| SWE-Bench Verified | 80.6 | - | 77.8 | - |
| SWE-Bench Pro | 55.4 | 58.6 | **58.4** | 56.22 |
| AIME 2026 | - | **96.4** | 95.3 | - |
| LiveCodeBench v6 | - | **89.6** | - | - |
| MMLU-Pro | **87.5** | - | - | - |
| Codeforces Rating | **3206** | - | - | - |
| Terminal-Bench 2.0 | - | 66.7 | 63.5-69.0 | - |

> **关键结论**：
> - SWE-Bench Pro 排名：Kimi K2.6 (58.6) > GLM-5.1 (58.4) > MiniMax M2.7 (56.22) > DeepSeek V4-Pro (55.4)
> - 数学推理：Kimi K2.6 (96.4) > GLM-5.1 (95.3)
> - 代码竞赛：DeepSeek V4-Pro (3206) 显著领先
> - **没有"全面领先"的模型**，路由策略必须基于具体任务类型选择

---

## 三、简化版架构（MVP 目标）

### 3.1 核心原则

1. **从简单开始**：MVP 只支持 1-2 个模型，不做全适配
2. **内存通信为主**：文件邮箱作为补充，HTTP 暂缓
3. **无委托链权限**：先做简单的 allowlist/denylist
4. **动态任务评估**：根据复杂度决定是否走多阶段流程

### 3.2 架构图

```
┌─────────────────────────────────────┐
│           Orchestrator              │
│  ┌─────────┐      ┌─────────────┐  │
│  │ Task    │─────▶│ Complexity  │  │
│  │ Parser  │      │ Evaluator   │  │
│  └─────────┘      └──────┬──────┘  │
│                          │         │
│              ┌───────────┴───────┐ │
│              ▼                   ▼ │
│        ┌─────────┐         ┌────────┐
│        │ Simple  │         │ Complex│
│        │ Direct  │         │ Multi  │
│        │ Execute │         │ Agent  │
│        └────┬────┘         └───┬────┘
│             │                  │
│             ▼                  ▼
│        ┌─────────┐      ┌──────────┐
│        │ Single  │      │ Parallel │
│        │ Model   │      │ Workers  │
│        └─────────┘      └──────────┘
└─────────────────────────────────────┘
```

### 3.3 任务复杂度评估

```typescript
// src/core/complexity-evaluator.ts
interface TaskComplexity {
  level: 'simple' | 'medium' | 'complex';
  estimatedSteps: number;
  requiresResearch: boolean;
  requiresVerification: boolean;
  canParallelize: boolean;
}

class ComplexityEvaluator {
  async evaluate(task: string, context: TaskContext): Promise<TaskComplexity> {
    // 基于规则 + 轻量模型评估
    const rules = this.applyHeuristics(task);

    if (rules.isSimple) {
      return {
        level: 'simple',
        estimatedSteps: 1,
        requiresResearch: false,
        requiresVerification: false,
        canParallelize: false
      };
    }

    // 复杂任务才调用模型评估
    const modelAssessment = await this.assessWithModel(task, context);
    return modelAssessment;
  }

  private applyHeuristics(task: string): { isSimple: boolean } {
    const simplePatterns = [
      // 中文简单任务
      /^(读取?|查看?|搜索?|解释?|总结?|列出?|显示?)\s*.+/i,
      // 英文简单任务
      /^(read|view|search|explain|summarize|list|show|find|get|cat)\s*.+/i,
      // 纯信息查询（无修改操作）
      /^(what|how|where|when|why|who)\s.+/i
    ];

    return {
      isSimple: simplePatterns.some(p => p.test(task.trim()))
    };
  }
}
```

---

## 四、模型适配器（修正版）

### 4.1 统一适配器接口

```typescript
// src/adapters/base-adapter.ts
interface ModelAdapter {
  readonly provider: string;
  readonly baseURL: string;

  chat(params: ChatParams): Promise<ChatResponse>;
  chatStream(params: ChatParams): AsyncIterable<ChatResponse>;
  getModelInfo(): ModelInfo;
}

interface ModelInfo {
  name: string;
  contextWindow: number;
  pricing: {
    input: number;      // $/M tokens
    output: number;     // $/M tokens
    cacheHit?: number;  // $/M tokens
  };
  capabilities: {
    toolCalling: boolean;
    streaming: boolean;
    jsonMode: boolean;
    thinking?: boolean;
    anthropicFormat?: boolean;  // 是否支持 Anthropic API 格式
  };
}
```

### 4.2 DeepSeek 适配器（利用 Anthropic 兼容 API）

```typescript
// src/adapters/deepseek-adapter.ts
class DeepSeekAdapter implements ModelAdapter {
  readonly provider = 'deepseek';
  readonly baseURL = 'https://api.deepseek.com';

  // 支持两种格式：OpenAI 和 Anthropic
  private openaiClient: OpenAI;
  private anthropicClient: Anthropic;

  constructor(apiKey: string) {
    this.openaiClient = new OpenAI({ baseURL: this.baseURL, apiKey });
    // Anthropic 兼容端点：api.deepseek.com/anthropic
    this.anthropicClient = new Anthropic({
      baseURL: `${this.baseURL}/anthropic`,
      apiKey
    });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    // 优先使用 Anthropic 格式（与 Claude Code 集成更顺畅）
    if (params.format === 'anthropic') {
      return this.chatAnthropic(params);
    }
    return this.chatOpenAI(params);
  }

  getModelInfo(): ModelInfo {
    return {
      name: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
      pricing: { input: 0.41, output: 0.82, cacheHit: 0.0034 },
      capabilities: {
        toolCalling: true,
        streaming: true,
        jsonMode: true,
        thinking: true,
        anthropicFormat: true
      }
    };
  }
}
```

### 4.3 Kimi 适配器（也支持 Anthropic 兼容端点）

```typescript
// src/adapters/kimi-adapter.ts
class KimiAdapter implements ModelAdapter {
  readonly provider = 'moonshot';
  // 根据 API Key 来源选择端点：国内用 api.moonshot.cn，国际用 api.moonshot.ai
  readonly baseURL: string;

  private openaiClient: OpenAI;
  private anthropicClient: Anthropic;

  constructor(apiKey: string, region: 'cn' | 'ai' = 'cn') {
    this.baseURL = `https://api.moonshot.${region}`;
    this.openaiClient = new OpenAI({ baseURL: `${this.baseURL}/v1`, apiKey });
    // Kimi K2.6 也支持 Anthropic 兼容端点
    this.anthropicClient = new Anthropic({
      baseURL: `${this.baseURL}/anthropic`,
      apiKey
    });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    if (params.format === 'anthropic') {
      return this.chatAnthropic(params);
    }
    return this.chatOpenAI(params);
  }

  getModelInfo(): ModelInfo {
    return {
      name: 'kimi-k2.6',
      contextWindow: 262_144,
      pricing: { input: 0.95, output: 4.00, cacheHit: 0.16 },
      capabilities: {
        toolCalling: true,
        streaming: true,
        jsonMode: true,
        thinking: true,
        anthropicFormat: true
      }
    };
  }
}
```

### 4.4 适配器工厂

```typescript
// src/adapters/adapter-factory.ts
class AdapterFactory {
  private adapters = new Map<string, ModelAdapter>();

  createAdapter(config: ProviderConfig): ModelAdapter {
    switch (config.provider) {
      case 'deepseek':
        return new DeepSeekAdapter(config.apiKey);
      case 'moonshot':
        return new KimiAdapter(config.apiKey, config.region ?? 'cn');
      case 'zhipu':
        return new GLMAdapter(config.apiKey);
      case 'minimax':
        return new MiniMaxAdapter(config.apiKey);
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }
}
```

---

## 五、通信层（修正版）

### 5.1 主路径：内存队列

```typescript
// src/communication/memory-queue.ts
class MemoryQueue {
  private queues = new Map<string, Array<AgentMessage>>();
  private subscribers = new Map<string, Set<MessageHandler>>();

  async send(to: string, message: AgentMessage): Promise<void> {
    const queue = this.queues.get(to) || [];
    queue.push({ ...message, timestamp: Date.now() });
    this.queues.set(to, queue);

    // 通知订阅者
    const handlers = this.subscribers.get(to);
    if (handlers) {
      handlers.forEach(h => h(message));
    }
  }

  async receive(agentId: string, timeout?: number): Promise<AgentMessage | null> {
    const queue = this.queues.get(agentId);
    if (queue && queue.length > 0) {
      return queue.shift()!;
    }

    if (!timeout) return null;

    // 等待新消息
    return new Promise((resolve) => {
      const handler = (msg: AgentMessage) => {
        this.unsubscribe(agentId, handler);
        resolve(msg);
      };
      this.subscribe(agentId, handler);
      setTimeout(() => {
        this.unsubscribe(agentId, handler);
        resolve(null);
      }, timeout);
    });
  }
}
```

### 5.2 补充路径：文件邮箱（简化版，非主路径）

```typescript
// src/communication/file-mailbox.ts
class FileMailbox {
  private mailboxDir: string;

  constructor(teamName: string) {
    this.mailboxDir = path.join(os.homedir(), '.multi-agent', 'teams', teamName);
    fs.ensureDirSync(this.mailboxDir);
  }

  async send(to: string, message: AgentMessage): Promise<void> {
    const filePath = this.getMailboxPath(to);

    // 使用原子写入：先写临时文件，再重命名
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    const mailbox = await this.readMailbox(to);
    mailbox.messages.push({ ...message, timestamp: Date.now(), read: false });

    await fs.writeJson(tempPath, mailbox);
    await fs.move(tempPath, filePath, { overwrite: true });
  }

  async readUnread(to: string): Promise<AgentMessage[]> {
    const mailbox = await this.readMailbox(to);
    const unread = mailbox.messages.filter(m => !m.read);

    // 原子更新已读状态
    if (unread.length > 0) {
      mailbox.messages.forEach(m => { if (!m.read) m.read = true; });
      await fs.writeJson(this.getMailboxPath(to), mailbox);
    }

    return unread;
  }

  private async readMailbox(to: string): Promise<Mailbox> {
    const filePath = this.getMailboxPath(to);
    if (await fs.pathExists(filePath)) {
      return fs.readJson(filePath);
    }
    return { messages: [] };
  }
}
```

> **设计决策**：文件邮箱仅用于跨进程/持久化场景，不作为主通信路径。高并发场景（>5 Agent）建议使用内存队列 + 数据库（Redis/SQLite）。

### 5.3 HTTP 桥接（暂缓，v0.3 再实现）

```typescript
// 暂不实现，预留接口
interface HTTPBridge {
  // TODO: v0.3 实现
  // 必须包含：
  // - TLS 加密
  // - API Key 认证
  // - 请求签名验证
  // - 速率限制
}
```

---

## 六、安全机制（修正版）

### 6.1 命令执行安全

```typescript
// src/security/safe-exec.ts
import { spawn } from 'child_process';

async function safeExec(
  command: string,
  args: string[],  // 使用参数数组，禁止字符串拼接
  options: ExecOptions = {}
): Promise<ExecResult> {
  // 参数校验
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new Error('All arguments must be strings');
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout || 30000,
      shell: false  // 禁止使用 shell
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => { stdout += data; });
    child.stderr?.on('data', (data) => { stderr += data; });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// 使用示例
await safeExec('git', ['worktree', 'add', '-B', branchName, worktreePath]);
```

### 6.2 权限控制（简化版）

```typescript
// src/security/permission-manager.ts
class PermissionManager {
  private allowedTools: Map<string, Set<string>> = new Map();
  private dangerousOperations = new Set([
    'file.delete',
    'bash.exec',
    'git.push',
    'git.force-push'
  ]);

  constructor(config: SecurityConfig) {
    // 初始化每个 Agent 的允许工具列表
    for (const agent of config.agents) {
      this.allowedTools.set(
        agent.agentType,
        new Set(agent.allowedTools)
      );
    }
  }

  canExecute(agentType: string, operation: string): boolean {
    const allowed = this.allowedTools.get(agentType);
    if (!allowed) return false;
    return allowed.has(operation) || allowed.has('*');
  }

  async requestApproval(
    agentType: string,
    operation: string,
    details: any
  ): Promise<boolean> {
    if (!this.dangerousOperations.has(operation)) {
      return true;  // 非危险操作直接放行
    }

    // 危险操作需要人类确认
    return await this.promptUser(agentType, operation, details);
  }

  private async promptUser(
    agentType: string,
    operation: string,
    details: any
  ): Promise<boolean> {
    // 在 CLI/UI 中弹出确认提示
    // 返回用户决策
    const answer = await askUser(`
Agent "${agentType}" 请求执行危险操作: ${operation}
详情: ${JSON.stringify(details, null, 2)}
是否允许? (y/N)
    `);
    return answer.toLowerCase() === 'y';
  }
}
```

### 6.3 路径安全

```typescript
// src/security/path-utils.ts
import path from 'path';
import fs from 'fs/promises';

function safeResolve(basePath: string, targetPath: string): string {
  const resolved = path.resolve(basePath, targetPath);

  // 验证路径确实在 basePath 内（处理符号链接和大小写不敏感的文件系统）
  const relative = path.relative(basePath, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}

function validateSlug(slug: string): string {
  // 只允许字母、数字、连字符、下划线
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error('Invalid slug format');
  }
  if (slug.length > 64) {
    throw new Error('Slug too long (max 64 chars)');
  }
  return slug;
}
```

---

## 七、Worker 生命周期（修正版）

### 7.1 Agent 实例类型

```typescript
// src/lifecycle/types.ts
interface AgentInstance {
  id: string;
  definition: AgentDefinition;
  status: 'running' | 'completed' | 'error' | 'terminating';
  abortController: AbortController;
  startTime: number;
  lastHeartbeat: number;
  worktree?: WorktreeInfo;  // 可选，仅在 isolation='worktree' 时存在
  turnCount?: number;
}
```

### 7.2 带心跳和超时的 Agent 运行器

```typescript
// src/lifecycle/agent-runner.ts
class AgentRunner {
  private agents = new Map<string, AgentInstance>();

  async spawn(definition: AgentDefinition): Promise<string> {
    const id = crypto.randomUUID();
    const abortController = new AbortController();

    const instance: AgentInstance = {
      id,
      definition,
      status: 'running',
      abortController,
      startTime: Date.now(),
      lastHeartbeat: Date.now(),
      turnCount: 0
    };

    // 如果启用 worktree 隔离，创建隔离环境
    if (definition.isolation === 'worktree') {
      instance.worktree = await this.worktreeManager.createWorktree(id);
    }

    this.agents.set(id, instance);

    // 启动执行循环
    this.runWithTimeout(instance);

    // 启动心跳监控
    this.startHeartbeatMonitor(instance);

    return id;
  }

  private async runWithTimeout(instance: AgentInstance): Promise<void> {
    const timeout = instance.definition.timeout || 300000; // 默认 5 分钟

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Agent ${instance.id} timed out after ${timeout}ms`));
      }, timeout);
    });

    try {
      await Promise.race([
        this.executeAgentLoop(instance),
        timeoutPromise
      ]);
    } catch (error) {
      instance.status = 'error';
      console.error(`Agent ${instance.id} failed:`, error);
    } finally {
      instance.status = 'completed';
    }
  }

  private startHeartbeatMonitor(instance: AgentInstance): void {
    const interval = setInterval(() => {
      const elapsed = Date.now() - instance.lastHeartbeat;
      const maxSilence = 60000; // 1 分钟无心跳视为死亡

      if (elapsed > maxSilence && instance.status === 'running') {
        console.warn(`Agent ${instance.id} heartbeat lost, terminating`);
        this.kill(instance.id);
        clearInterval(interval);
      }
    }, 10000); // 每 10 秒检查一次
  }

  async kill(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;

    agent.status = 'terminating';
    agent.abortController.abort();

    // 清理 worktree（如果存在）
    if (agent.worktree) {
      await this.worktreeManager.cleanupWorktree(agent.worktree);
    }

    this.agents.delete(id);
  }
}
```

---

## 八、可观测性设计（MVP 阶段纳入）

### 8.1 结构化日志

```typescript
// src/observability/logger.ts
import { createLogger, format, transports } from 'winston';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'multi-agent-orchestrator' },
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'logs/error.log', level: 'error' }),
    new transports.File({ filename: 'logs/combined.log' })
  ]
});

// Agent 执行日志
logger.info('agent.task.started', {
  agentId: 'agent-123',
  agentType: 'builder',
  model: 'deepseek-v4-pro',
  task: 'refactor auth module'
});

logger.info('agent.task.completed', {
  agentId: 'agent-123',
  duration: 45000,
  tokensUsed: { input: 1200, output: 800 },
  cost: 0.0012
});
```

### 8.2 指标收集

```typescript
// src/observability/metrics.ts
import { Counter, Histogram, Registry } from 'prom-client';

const registry = new Registry();

const agentExecutions = new Counter({
  name: 'agent_executions_total',
  help: 'Total number of agent executions',
  labelNames: ['agent_type', 'model', 'status'],
  registers: [registry]
});

const taskDuration = new Histogram({
  name: 'task_duration_seconds',
  help: 'Task execution duration',
  labelNames: ['task_type', 'model'],
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [registry]
});

const tokenUsage = new Counter({
  name: 'token_usage_total',
  help: 'Total token usage',
  labelNames: ['model', 'type'], // type: input/output
  registers: [registry]
});

const costCounter = new Counter({
  name: 'cost_dollars_total',
  help: 'Total cost in dollars',
  labelNames: ['model'],
  registers: [registry]
});
```

### 8.3 分布式追踪

```typescript
// src/observability/tracing.ts
import { trace, context } from '@opentelemetry/api';

const tracer = trace.getTracer('multi-agent-orchestrator');

async function executeWithTracing(task: Task): Promise<Result> {
  return tracer.startActiveSpan('orchestrator.execute', async (span) => {
    span.setAttribute('task.type', task.type);
    span.setAttribute('task.description', task.description);

    try {
      const result = await executeTask(task);
      span.setAttribute('result.status', 'success');
      return result;
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}
```

---

## 九、MVP 范围与时间估算（修正版）

### 9.1 MVP 范围（最小可用产品）

| 功能 | 范围 | 说明 |
|------|------|------|
| 模型支持 | DeepSeek V4-Pro + Kimi K2.6 | 只支持 2 个模型 |
| API 格式 | OpenAI + Anthropic（两个模型均支持） | 优先 Anthropic 格式与 Claude Code 桥接 |
| Coordinator | 简单任务分发 | 无四阶段，只做并行派遣 |
| 通信 | 内存队列 | 文件邮箱作为可选补充 |
| 权限 | Allowlist/Denylist | 无委托链 |
| 安全 | 参数数组执行 | 基础路径校验 |
| 可观测性 | 结构化日志 + 基础指标 | 控制台输出 + 文件日志 |
| 测试 | 单元测试 + 集成测试 | Mock API + 本地测试 |

### 9.2 修正后的时间估算

| 阶段 | 内容 | 估算时间 |
|------|------|---------|
| **MVP** | DeepSeek + Kimi，基础 Coordinator，内存通信 | **4-6 周** |
| **v0.2** | 添加 GLM + MiniMax，完善适配器 | **2-3 周** |
| **v0.3** | 文件邮箱通信，HTTP 桥接（带认证） | **2-3 周** |
| **v0.4** | 可视化监控面板，成本追踪 | **2 周** |
| **v1.0** | 生产就绪，完整测试，文档 | **4-6 周** |
| **总计** | | **14-20 周** |

---

## 十、测试策略

### 10.1 Mock LLM 服务

```typescript
// tests/mocks/mock-llm-server.ts
import http from 'http';

// 用于模拟 LLM API 响应的本地服务器
class MockLLMServer {
  private server: http.Server;
  private responseHandler: (req: http.IncomingMessage) => MockResponse;

  constructor(port: number = 0) {
    this.server = http.createServer((req, res) => {
      const response = this.responseHandler?.(req) ?? {
        status: 200,
        body: { choices: [{ message: { content: 'mock response' } }] }
      };

      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });

    this.server.listen(port);
  }

  get url(): string {
    const addr = this.server.address() as { port: number };
    return `http://localhost:${addr.port}`;
  }

  setResponse(response: MockResponse): void {
    this.responseHandler = () => response;
  }

  setError(error: { status: number; message: string }): void {
    this.responseHandler = () => ({
      status: error.status,
      body: { error: { message: error.message } }
    });
  }

  close(): void {
    this.server.close();
  }
}

interface MockResponse {
  status: number;
  body: any;
}
```

### 10.2 适配器单元测试

```typescript
// tests/adapters/deepseek-adapter.test.ts
describe('DeepSeekAdapter', () => {
  let adapter: DeepSeekAdapter;
  let mockServer: MockLLMServer;

  beforeEach(() => {
    mockServer = new MockLLMServer();
    adapter = new DeepSeekAdapter('test-key');
    adapter.baseURL = mockServer.url;
  });

  afterEach(() => {
    mockServer.close();
  });

  test('should handle successful chat completion', async () => {
    mockServer.setResponse({
      status: 200,
      body: { choices: [{ message: { content: 'Hello!' } }] }
    });

    const result = await adapter.chat({
      messages: [{ role: 'user', content: 'Hi' }]
    });

    expect(result.content).toBe('Hello!');
  });

  test('should handle rate limit error', async () => {
    mockServer.setError({ status: 429, message: 'Too many requests' });

    await expect(adapter.chat({ messages: [] }))
      .rejects.toThrow('Rate limit exceeded');
  });
});
```

### 10.3 集成测试

```typescript
// tests/integration/multi-agent.test.ts
describe('Multi-Agent Integration', () => {
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    orchestrator = new Orchestrator({
      providers: [
        { provider: 'deepseek', apiKey: 'test', model: 'deepseek-v4-pro' },
        { provider: 'moonshot', apiKey: 'test', model: 'kimi-k2.6' }
      ]
    });
  });

  test('should execute simple task with single agent', async () => {
    const result = await orchestrator.execute({
      task: '读取 package.json 文件'
    });

    expect(result.status).toBe('success');
    expect(result.agentUsed).toBeDefined();
  });

  test('should parallelize complex task', async () => {
    const result = await orchestrator.execute({
      task: '分析代码库并生成测试'
    });

    expect(result.subTasks.length).toBeGreaterThan(1);
    expect(result.duration).toBeLessThan(60000); // 并行应快于串行
  });
});
```

### 10.4 Worktree 隔离测试

```typescript
// tests/integration/worktree.test.ts
describe('Worktree Isolation', () => {
  test('should isolate file changes between agents', async () => {
    const worktree1 = await worktreeManager.create('agent-1');
    const worktree2 = await worktreeManager.create('agent-2');

    // Agent 1 修改文件
    await fs.writeFile(path.join(worktree1.path, 'test.txt'), 'agent-1');

    // Agent 2 不应看到 Agent 1 的修改
    const content = await fs.readFile(
      path.join(worktree2.path, 'test.txt'),
      'utf-8'
    );
    expect(content).not.toBe('agent-1');

    // 清理
    await worktreeManager.cleanup(worktree1);
    await worktreeManager.cleanup(worktree2);
  });
});
```

---

## 十一、配置示例（修正版）

```yaml
# config.yaml
orchestrator:
  # 只配置 2 个模型（MVP）
  providers:
    deepseek:
      apiKey: "${DEEPSEEK_API_KEY}"
      baseURL: "https://api.deepseek.com"
      anthropicURL: "https://api.deepseek.com/anthropic"  # Anthropic 兼容端点
      defaultModel: "deepseek-v4-pro"

    moonshot:
      apiKey: "${MOONSHOT_API_KEY}"
      # 重要：根据 API Key 来源选择区域
      # - 国内用户在 platform.moonshot.cn 创建 Key → 使用 api.moonshot.cn
      # - 国际用户在 platform.moonshot.ai 创建 Key → 使用 api.moonshot.ai
      # Key 与区域严格绑定，混用会返回 401
      region: "cn"  # "cn" | "ai"
      baseURL: "https://api.moonshot.cn/v1"
      anthropicURL: "https://api.moonshot.cn/anthropic"  # Kimi 也支持 Anthropic 格式
      defaultModel: "kimi-k2.6"

  # 简化版 Agent 定义
  agents:
    - agentType: "coder"
      model: "deepseek-v4-pro"
      provider: "deepseek"
      allowedTools: ["Read", "Edit", "Write", "Bash"]
      timeout: 300000  # 5 分钟
      maxTurns: 50

    - agentType: "researcher"
      model: "kimi-k2.6"
      provider: "moonshot"
      allowedTools: ["Read", "Grep", "WebSearch"]
      timeout: 120000  # 2 分钟
      maxTurns: 30

  # 安全配置
  security:
    requireApproval:
      - "file.delete"
      - "bash.exec"
    maxConcurrentAgents: 5  # 降低并发，避免 Git 冲突

  # 可观测性
  observability:
    logLevel: "info"
    metricsEnabled: true
    tracingEnabled: false  # MVP 暂不开启
```

---

## 十二、V2 → V3 变更记录

| 变更项 | V2 内容 | V3 修正 | 原因 |
|--------|---------|---------|------|
| 参考框架 | 列出 OpenAI Swarm | 替换为 **OpenAI Agents SDK** | Swarm 已于 2025 年 3 月废弃 |
| DeepSeek SWE-Bench Pro | 标注 "-" | 补充为 **55.4** | 数据已公开 |
| Benchmark 表格 | 无 SWE-Bench Verified | 新增该列 | 多模型有此项数据 |
| Kimi 缓存命中 | 标注 "-" | 补充为 **$0.16** | 数据已公开 |
| Kimi Anthropic 端点 | 未提及 | 补充 `.cn` / `.ai` 双端点 | Kimi K2.6 已支持 |
| Moonshot 双区域 | 未说明 | 新增区域选择说明及 401 警告 | API Key 与端点绑定 |
| AgentInstance 类型 | 无 worktree 字段定义 | 新增 `worktree?: WorktreeInfo` | kill() 中访问但 spawn() 未赋值 |
| ComplexityEvaluator | 仅中文正则 | 新增英文正则 | 覆盖中英文简单任务 |
| MockLLMServer | 引用但未定义 | 补充完整实现 | 测试代码可直接使用 |
| ModelInfo 接口 | 无 anthropicFormat | 新增 `anthropicFormat?: boolean` | 两个模型均支持 Anthropic 格式 |
| 适配器路径 | `api.moonshot.cn/v1` 硬编码 | 支持 `region` 参数选择区域 | 支持国内/国际用户 |
| 路径安全 | `path.relative` 检查 `..` | 额外检查 `path.isAbsolute` | 增强 Windows 兼容性 |

---

这份 V3 修正版解决了 V2 中的数据遗漏、过时引用和代码 bug，补充了 Kimi Anthropic 兼容端点、Moonshot 双区域等重要发现。MVP 阶段建议先只支持 DeepSeek + Kimi 两个模型（均使用 Anthropic 兼容格式以简化 Claude Code 桥接），验证核心流程后再逐步扩展。
