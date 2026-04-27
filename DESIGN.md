# Multi-Agent Orchestrator - 混合编排层设计方案

## 项目概述

基于 Claude Code 泄露源码中的 Coordinator Mode 设计理念，构建一个支持多厂商大模型（Claude/DeepSeek/Kimi/GLM/MiniMax 等）的混合 Agent 编排层。

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     User Interface Layer                     │
│              (CLI / Web UI / IDE Extension)                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   Coordinator Core                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Task Planner │  │ Agent Router │  │ Permission Manager │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ State Manager│  │ Comm Hub    │  │ Lifecycle Manager  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
┌───────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐
│  Claude      │ │ DeepSeek │ │   Kimi     │
│  Agent Pool  │ │ Agent    │ │  Agent     │
│  (Native)    │ │  Pool    │ │  Pool      │
└──────────────┘ └──────────┘ └────────────┘
        │              │              │
        └──────────────┼──────────────┘
                       │
              ┌────────▼────────┐
              │   GLM/MiniMax   │
              │   Agent Pool    │
              └─────────────────┘
```

### 核心设计原则

1. **模型无关性**：Coordinator 不依赖任何特定模型，通过适配器统一调用
2. **权限始终由人类把控**：危险操作层层上报，最终由用户确认
3. **优雅降级**：模型不可用时自动 fallback
4. **Fire-and-forget**：后台 Agent 完成后异步通知
5. **Git Worktree 隔离**：并行修改时代码隔离

---

## 二、Coordinator 核心模块

### 2.1 四阶段工作流（参考 Claude Code Coordinator Mode）

```typescript
enum CoordinatorPhase {
  RESEARCH   = 'research',   // 研究：并行派遣多个 Worker 探索不同维度
  SYNTHESIZE = 'synthesize', // 综合：整合 Worker 返回的信息为执行计划
  IMPLEMENT  = 'implement',  // 实现：派遣 Worker 执行具体代码修改
  VERIFY     = 'verify'      // 验证：对抗性测试，确保结果正确
}
```

### 2.2 Coordinator 核心类

```typescript
// src/coordinator/coordinator.ts
class Coordinator {
  private state: CoordinatorState;
  private router: AgentRouter;
  private planner: TaskPlanner;
  private permissionManager: PermissionManager;
  private commHub: CommunicationHub;
  private lifecycleManager: LifecycleManager;

  async executeTask(userRequest: string): Promise<TaskResult> {
    // Phase 1: Research
    const researchResults = await this.phaseResearch(userRequest);
    
    // Phase 2: Synthesize
    const executionPlan = await this.phaseSynthesize(researchResults);
    
    // Phase 3: Implement
    const implementationResults = await this.phaseImplement(executionPlan);
    
    // Phase 4: Verify
    const verificationResult = await this.phaseVerify(implementationResults);
    
    return this.compileFinalResult(verificationResult);
  }

  private async phaseResearch(request: string): Promise<ResearchResult[]> {
    // 并行派遣多个 Research Worker
    const researchTasks = [
      this.spawnWorker('explore-codebase', request),
      this.spawnWorker('analyze-requirements', request),
      this.spawnWorker('check-dependencies', request)
    ];
    return Promise.all(researchTasks);
  }

  private async phaseSynthesize(results: ResearchResult[]): Promise<ExecutionPlan> {
    const synthesizer = this.router.getOptimalAgent('synthesize');
    return synthesizer.execute({
      task: 'synthesize_plan',
      context: results,
      outputFormat: 'execution_plan'
    });
  }

  private async phaseImplement(plan: ExecutionPlan): Promise<ImplementationResult> {
    // 根据计划并行/串行派遣 Implement Worker
    const implementations = await this.executePlan(plan);
    return implementations;
  }

  private async phaseVerify(results: ImplementationResult): Promise<VerificationResult> {
    const verifier = this.router.getOptimalAgent('verify');
    return verifier.execute({
      task: 'verify_implementation',
      context: results,
      mode: 'adversarial'
    });
  }
}
```

### 2.3 Task Planner（任务规划器）

```typescript
// src/coordinator/task-planner.ts
class TaskPlanner {
  async decomposeTask(
    request: string,
    context: TaskContext
  ): Promise<ExecutionPlan> {
    // 使用最强模型进行任务分解
    const planner = this.modelRouter.getModelForTask('planning');
    
    const decomposition = await planner.chat({
      messages: [{
        role: 'system',
        content: `你是一个任务分解专家。将用户请求分解为可并行/串行的子任务。
                 输出格式：JSON，包含任务依赖关系、预估复杂度、推荐模型。`
      }, {
        role: 'user',
        content: request
      }]
    });

    return this.parseExecutionPlan(decomposition);
  }

  private parseExecutionPlan(raw: string): ExecutionPlan {
    // 解析模型返回的计划，构建依赖图
    const plan = JSON.parse(raw);
    return {
      tasks: plan.tasks.map(t => ({
        id: t.id,
        description: t.description,
        dependencies: t.dependencies || [],
        estimatedComplexity: t.complexity,
        recommendedModel: t.recommended_model,
        recommendedAgentType: t.agent_type,
        parallelizable: t.parallelizable ?? true
      })),
      criticalPath: this.calculateCriticalPath(plan.tasks)
    };
  }
}
```

---

## 三、Worker Agent 抽象与多模型适配

### 3.1 Agent 定义系统

```typescript
// src/agents/agent-definition.ts
interface AgentDefinition {
  agentType: string;           // 唯一标识
  whenToUse: string;           // 使用场景描述
  model: string;               // 模型标识
  modelProvider: ModelProvider; // 模型提供商
  tools: string[];             // 可用工具
  disallowedTools: string[];   // 禁用工具
  permissionMode: PermissionMode; // 权限模式
  maxTurns: number;            // 最大对话轮次
  background: boolean;         // 是否后台运行
  isolation: IsolationMode;    // 隔离方式
  systemPrompt: string;        // 系统提示词
  timeout: number;             // 超时时间（秒）
}

type ModelProvider = 
  | 'anthropic'    // Claude
  | 'deepseek'     // DeepSeek
  | 'moonshot'     // Kimi
  | 'zhipu'        // GLM
  | 'minimax'      // MiniMax
  | 'openai'       // OpenAI
  | 'openrouter';  // OpenRouter

type PermissionMode = 'plan' | 'acceptEdits' | 'full';
type IsolationMode = 'none' | 'worktree' | 'container';
```

### 3.2 模型适配器层

```typescript
// src/adapters/base-adapter.ts
abstract class BaseModelAdapter {
  abstract readonly provider: ModelProvider;
  abstract readonly baseURL: string;
  
  protected apiKey: string;
  protected client: any;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.initializeClient();
  }

  abstract initializeClient(): void;
  
  abstract chat(params: ChatParams): Promise<ChatResponse>;
  abstract chatStream(params: ChatParams): AsyncIterable<ChatResponse>;
  abstract callTools(params: ToolCallParams): Promise<ToolCallResponse>;
  
  // 统一异常转换
  abstract normalizeError(error: any): ModelError;
}

// DeepSeek 适配器
class DeepSeekAdapter extends BaseModelAdapter {
  readonly provider = 'deepseek';
  readonly baseURL = 'https://api.deepseek.com';

  initializeClient() {
    this.client = new OpenAI({
      baseURL: this.baseURL,
      apiKey: this.apiKey
    });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens,
      tools: params.tools,
      tool_choice: params.toolChoice
    });

    return {
      content: response.choices[0].message.content,
      toolCalls: response.choices[0].message.tool_calls,
      usage: response.usage,
      raw: response
    };
  }

  normalizeError(error: any): ModelError {
    if (error.status === 401) {
      return { type: 'auth', message: 'API Key 无效', retryable: false };
    }
    if (error.status === 429) {
      return { type: 'rate_limit', message: '请求过于频繁', retryable: true };
    }
    return { type: 'unknown', message: error.message, retryable: true };
  }
}

// Kimi 适配器
class KimiAdapter extends BaseModelAdapter {
  readonly provider = 'moonshot';
  readonly baseURL = 'https://api.moonshot.cn/v1';

  initializeClient() {
    this.client = new OpenAI({
      baseURL: this.baseURL,
      apiKey: this.apiKey
    });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    // Kimi 特有参数处理
    const response = await this.client.chat.completions.create({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens
    });
    return this.normalizeResponse(response);
  }
}

// GLM 适配器
class GLMAdapter extends BaseModelAdapter {
  readonly provider = 'zhipu';
  readonly baseURL = 'https://open.bigmodel.cn/api/paas/v4';

  initializeClient() {
    this.client = new OpenAI({
      baseURL: this.baseURL,
      apiKey: this.apiKey
    });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    // GLM 支持 thinking 模式
    const body: any = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 1.0
    };
    
    if (params.enableThinking) {
      body.thinking = { type: 'enabled' };
    }

    const response = await this.client.chat.completions.create(body);
    return this.normalizeResponse(response);
  }
}

// MiniMax 适配器
class MiniMaxAdapter extends BaseModelAdapter {
  readonly provider = 'minimax';
  readonly baseURL = 'https://api.minimaxi.com/v1';

  initializeClient() {
    this.client = new OpenAI({
      baseURL: this.baseURL,
      apiKey: this.apiKey
    });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: params.model,
      messages: params.messages
    });
    return this.normalizeResponse(response);
  }
}

// 适配器工厂
class AdapterFactory {
  private adapters: Map<ModelProvider, BaseModelAdapter> = new Map();

  getAdapter(provider: ModelProvider, apiKey: string): BaseModelAdapter {
    if (!this.adapters.has(provider)) {
      const adapter = this.createAdapter(provider, apiKey);
      this.adapters.set(provider, adapter);
    }
    return this.adapters.get(provider)!;
  }

  private createAdapter(provider: ModelProvider, apiKey: string): BaseModelAdapter {
    switch (provider) {
      case 'deepseek': return new DeepSeekAdapter(apiKey);
      case 'moonshot': return new KimiAdapter(apiKey);
      case 'zhipu': return new GLMAdapter(apiKey);
      case 'minimax': return new MiniMaxAdapter(apiKey);
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}
```

### 3.3 Agent 路由器

```typescript
// src/coordinator/agent-router.ts
class AgentRouter {
  private modelCapabilities: Map<string, ModelCapability>;
  private costTracker: CostTracker;

  constructor() {
    this.initializeCapabilities();
  }

  private initializeCapabilities() {
    this.modelCapabilities = new Map([
      ['deepseek-v4-pro', {
        coding: 0.95,
        reasoning: 0.93,
        longContext: 0.90,
        toolUse: 0.88,
        costPer1K: 0.024,
        maxContext: 1_000_000
      }],
      ['kimi-k2.6', {
        coding: 0.92,
        reasoning: 0.90,
        longContext: 0.95,
        toolUse: 0.85,
        costPer1K: 0.018,
        maxContext: 262_000
      }],
      ['glm-5.1', {
        coding: 0.93,
        reasoning: 0.91,
        longContext: 0.88,
        toolUse: 0.90,
        costPer1K: 0.020,
        maxContext: 200_000
      }],
      ['minimax-m2.7', {
        coding: 0.88,
        reasoning: 0.85,
        longContext: 0.92,
        toolUse: 0.82,
        costPer1K: 0.008,
        maxContext: 1_000_000
      }]
    ]);
  }

  getOptimalAgent(taskType: TaskType, constraints: Constraints): AgentDefinition {
    const candidates = this.filterByConstraints(constraints);
    
    // 根据任务类型评分
    const scored = candidates.map(model => ({
      model,
      score: this.calculateTaskScore(taskType, model)
    }));

    // 按评分排序，考虑成本约束
    scored.sort((a, b) => {
      if (constraints.maxCost) {
        return this.balanceScoreAndCost(a, b, constraints.maxCost);
      }
      return b.score - a.score;
    });

    const best = scored[0];
    return this.createAgentDefinition(best.model, taskType);
  }

  private calculateTaskScore(taskType: TaskType, model: string): number {
    const caps = this.modelCapabilities.get(model);
    if (!caps) return 0;

    const weights = {
      'coding': { coding: 0.5, reasoning: 0.3, toolUse: 0.2 },
      'planning': { reasoning: 0.5, longContext: 0.3, toolUse: 0.2 },
      'research': { longContext: 0.4, reasoning: 0.3, toolUse: 0.3 },
      'verify': { reasoning: 0.4, coding: 0.3, toolUse: 0.3 }
    };

    const w = weights[taskType] || weights['coding'];
    return (
      caps.coding * w.coding +
      caps.reasoning * w.reasoning +
      caps.longContext * w.longContext +
      caps.toolUse * w.toolUse
    );
  }

  private balanceScoreAndCost(a: ScoredModel, b: ScoredModel, maxCost: number): number {
    const aValue = a.score / (a.cost * 1000);
    const bValue = b.score / (b.cost * 1000);
    return bValue - aValue;
  }
}
```

---

## 四、通信层设计

### 4.1 三层通信机制

参考 Claude Code 的设计，采用三层通信：

```
┌─────────────────────────────────────────┐
│           Communication Hub             │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ In-Mem  │ │ File    │ │ HTTP/    │  │
│  │ Queue   │ │ Mailbox │ │ WebSocket│  │
│  │ (同进程) │ │ (跨进程)│ │ (跨机器) │  │
│  └─────────┘ └─────────┘ └──────────┘  │
└─────────────────────────────────────────┘
```

### 4.2 文件邮箱系统（参考 Claude Code）

```typescript
// src/communication/file-mailbox.ts
class FileMailbox {
  private mailboxDir: string;
  private lockOptions = {
    retries: 10,
    retryWait: () => Math.random() * 95 + 5  // 5-100ms 随机退避
  };

  constructor(teamName: string) {
    this.mailboxDir = path.join(
      os.homedir(),
      '.multi-agent',
      'teams',
      teamName,
      'inboxes'
    );
    fs.ensureDirSync(this.mailboxDir);
  }

  async sendMessage(to: string, message: AgentMessage): Promise<void> {
    const mailboxPath = this.getMailboxPath(to);
    
    // 使用文件锁实现原子写入
    const release = await lockfile.lock(mailboxPath + '.lock', this.lockOptions);
    
    try {
      const mailbox = await this.readMailbox(to);
      mailbox.messages.push({
        ...message,
        timestamp: new Date().toISOString(),
        read: false
      });
      await fs.writeJson(mailboxPath, mailbox, { spaces: 2 });
    } finally {
      await release();
    }
  }

  async readUnreadMessages(agentName: string): Promise<AgentMessage[]> {
    const mailbox = await this.readMailbox(agentName);
    const unread = mailbox.messages.filter(m => !m.read);
    
    // 标记为已读
    mailbox.messages.forEach(m => { if (!m.read) m.read = true; });
    await fs.writeJson(this.getMailboxPath(agentName), mailbox);
    
    return unread;
  }

  private getMailboxPath(agentName: string): string {
    return path.join(this.mailboxDir, `${agentName}.json`);
  }
}

interface AgentMessage {
  from: string;
  to: string;
  type: MessageType;
  text: string;
  summary?: string;
  payload?: any;
  timestamp?: string;
  read?: boolean;
}

type MessageType = 
  | 'task_request'      // 分配任务
  | 'task_response'     // 返回结果
  | 'shutdown_request'  // 请求关闭
  | 'idle_notification' // 空闲通知
  | 'permission_request'// 权限申请
  | 'error_report';     // 错误报告
```

### 4.3 内存队列（同进程）

```typescript
// src/communication/memory-queue.ts
class MemoryQueue {
  private queues: Map<string, Array<AgentMessage>> = new Map();
  private subscribers: Map<string, Set<(msg: AgentMessage) => void>> = new Map();

  async enqueue(agentName: string, message: AgentMessage): Promise<void> {
    if (!this.queues.has(agentName)) {
      this.queues.set(agentName, []);
    }
    this.queues.get(agentName)!.push(message);
    
    // 通知订阅者
    const subs = this.subscribers.get(agentName);
    if (subs) {
      subs.forEach(cb => cb(message));
    }
  }

  async dequeue(agentName: string): Promise<AgentMessage | undefined> {
    const queue = this.queues.get(agentName);
    return queue?.shift();
  }

  subscribe(agentName: string, callback: (msg: AgentMessage) => void): () => void {
    if (!this.subscribers.has(agentName)) {
      this.subscribers.set(agentName, new Set());
    }
    this.subscribers.get(agentName)!.add(callback);
    
    return () => {
      this.subscribers.get(agentName)?.delete(callback);
    };
  }
}
```

### 4.4 HTTP 通信（跨机器）

```typescript
// src/communication/http-bridge.ts
class HTTPBridge {
  private server: FastifyInstance;
  private messageHandlers: Map<string, (msg: AgentMessage) => Promise<void>>;

  async start(port: number): Promise<void> {
    this.server = fastify();
    
    this.server.post('/agent/:agentName/message', async (request, reply) => {
      const { agentName } = request.params as { agentName: string };
      const message = request.body as AgentMessage;
      
      const handler = this.messageHandlers.get(agentName);
      if (handler) {
        await handler(message);
        return { status: 'delivered' };
      }
      
      return reply.status(404).send({ error: 'Agent not found' });
    });

    await this.server.listen({ port, host: '0.0.0.0' });
  }

  async sendRemote(
    targetHost: string,
    targetAgent: string,
    message: AgentMessage
  ): Promise<void> {
    const response = await fetch(`http://${targetHost}/agent/${targetAgent}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`);
    }
  }
}
```

---

## 五、权限与安全机制

### 5.1 权限委托架构

```typescript
// src/security/permission-manager.ts
class PermissionManager {
  private delegateChain: Map<string, string> = new Map(); // agent -> parent
  
  async requestPermission(
    agent: string,
    operation: DangerousOperation,
    context: OperationContext
  ): Promise<PermissionResult> {
    // 构建权限申请
    const request: PermissionRequest = {
      agent,
      operation: operation.type,
      details: operation.details,
      riskLevel: this.assessRisk(operation),
      timestamp: Date.now()
    };

    // 层层上报
    let current = agent;
    while (this.delegateChain.has(current)) {
      current = this.delegateChain.get(current)!;
    }

    // 最终到达 Leader（人类用户）
    return await this.promptUserForPermission(current, request);
  }

  private assessRisk(operation: DangerousOperation): RiskLevel {
    const riskMap: Record<string, RiskLevel> = {
      'file.delete': 'high',
      'file.write': 'medium',
      'file.read': 'low',
      'bash.exec': 'high',
      'git.push': 'high',
      'api.call': 'medium'
    };
    return riskMap[operation.type] || 'medium';
  }

  private async promptUserForPermission(
    leader: string,
    request: PermissionRequest
  ): Promise<PermissionResult> {
    // 在 Leader UI 弹出确认对话框
    // 返回用户决策
  }
}

interface DangerousOperation {
  type: string;
  details: any;
}

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type PermissionResult = { granted: true } | { granted: false; reason: string };
```

### 5.2 工具过滤

```typescript
// src/security/tool-filter.ts
const ALL_AGENT_DISALLOWED_TOOLS = [
  'TaskOutput',
  'ExitPlanMode', 
  'EnterPlanMode',
  'AskUserQuestion',
  'TaskStop'
];

const CUSTOM_AGENT_DISALLOWED_TOOLS = [
  ...ALL_AGENT_DISALLOWED_TOOLS,
  'AgentTool'  // 禁止非内置 Agent 嵌套子 Agent
];

const ASYNC_AGENT_ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write',
  'WebSearch', 'FetchURL'
];

const COORDINATOR_ALLOWED_TOOLS = [
  'Agent', 'TaskStop', 'SendMessage', 'SyntheticOutput'
];

function filterToolsForAgent(
  agentType: string,
  isCustom: boolean,
  isAsync: boolean
): string[] {
  if (isAsync) {
    return ASYNC_AGENT_ALLOWED_TOOLS;
  }
  if (agentType === 'coordinator') {
    return COORDINATOR_ALLOWED_TOOLS;
  }
  if (isCustom) {
    return allTools.filter(t => !CUSTOM_AGENT_DISALLOWED_TOOLS.includes(t));
  }
  return allTools.filter(t => !ALL_AGENT_DISALLOWED_TOOLS.includes(t));
}
```

---

## 六、任务调度与生命周期管理

### 6.1 Worker 生命周期

```typescript
// src/lifecycle/lifecycle-manager.ts
class LifecycleManager {
  private activeAgents: Map<string, AgentInstance> = new Map();
  private worktreeManager: WorktreeManager;

  async spawnAgent(definition: AgentDefinition): Promise<AgentInstance> {
    const id = this.generateAgentId();
    
    // 创建隔离环境
    const worktree = definition.isolation === 'worktree'
      ? await this.worktreeManager.createWorktree(id)
      : null;

    const instance: AgentInstance = {
      id,
      definition,
      status: 'initializing',
      worktree,
      abortController: new AbortController(),
      startTime: Date.now()
    };

    this.activeAgents.set(id, instance);
    
    // 启动 Agent 执行循环
    this.runAgentLoop(instance);
    
    return instance;
  }

  async killAgent(id: string, graceful: boolean = true): Promise<void> {
    const agent = this.activeAgents.get(id);
    if (!agent) return;

    if (graceful) {
      // 发送 shutdown_request，等待优雅关闭
      await this.sendShutdownRequest(id);
      await this.waitForShutdown(id, 5000);
    }

    // 强制终止
    agent.abortController.abort();
    
    // 清理 worktree
    if (agent.worktree) {
      await this.worktreeManager.cleanupWorktree(agent.worktree);
    }

    this.activeAgents.delete(id);
  }

  private async runAgentLoop(instance: AgentInstance): Promise<void> {
    const { abortController, definition } = instance;
    
    try {
      instance.status = 'running';
      
      while (!abortController.signal.aborted) {
        // 1. 读取消息
        const messages = await this.commHub.readMessages(instance.id);
        
        // 2. 处理任务
        for (const msg of messages) {
          if (msg.type === 'task_request') {
            await this.executeTask(instance, msg);
          } else if (msg.type === 'shutdown_request') {
            return;
          }
        }
        
        // 3. 检查最大轮次
        if (this.getTurnCount(instance) >= definition.maxTurns) {
          await this.sendIdleNotification(instance.id);
          break;
        }
      }
    } catch (error) {
      instance.status = 'error';
      await this.reportError(instance, error);
    } finally {
      instance.status = 'completed';
    }
  }
}
```

### 6.2 Git Worktree 隔离

```typescript
// src/lifecycle/worktree-manager.ts
class WorktreeManager {
  private baseDir: string;

  async createWorktree(agentId: string): Promise<WorktreeInfo> {
    const slug = this.validateSlug(`agent-${agentId.slice(0, 8)}`);
    const branchName = `worktree-${slug}`;
    const worktreePath = path.join(this.baseDir, 'worktrees', slug);

    // 创建 worktree
    await execAsync(`git worktree add -B ${branchName} ${worktreePath}`);

    // 复制环境文件
    await this.copyWorktreeIncludes(worktreePath);

    return {
      path: worktreePath,
      branch: branchName,
      slug
    };
  }

  async cleanupWorktree(info: WorktreeInfo): Promise<void> {
    // 检查是否有实质性改动
    const hasChanges = await this.checkForChanges(info.path);
    
    if (hasChanges) {
      // 保留并通知 Leader
      await this.notifyLeaderOfPendingChanges(info);
    } else {
      // 自动清理
      await execAsync(`git worktree remove ${info.path}`);
      await execAsync(`git branch -D ${info.branch}`);
    }
  }

  private validateSlug(slug: string): string {
    // 防止路径穿越
    if (slug.includes('..') || slug.includes('/')) {
      throw new Error('Invalid worktree slug');
    }
    if (slug.length > 64) {
      throw new Error('Worktree slug too long');
    }
    return slug;
  }

  private async copyWorktreeIncludes(worktreePath: string): Promise<void> {
    // 按 .worktreeinclude 复制必要文件
    const includeFile = path.join(process.cwd(), '.worktreeinclude');
    if (await fs.pathExists(includeFile)) {
      const includes = await fs.readFile(includeFile, 'utf-8');
      for (const pattern of includes.split('\n').filter(Boolean)) {
        const files = await glob(pattern);
        for (const file of files) {
          const dest = path.join(worktreePath, path.relative(process.cwd(), file));
          await fs.copy(file, dest);
        }
      }
    }
  }
}
```

---

## 七、配置示例

### 7.1 完整配置文件

```yaml
# config.yaml
orchestrator:
  coordinator:
    model: "deepseek-v4-pro"  # Coordinator 自身使用的模型
    maxConcurrentAgents: 10
    defaultTimeout: 300

  agents:
    # 内置 Agent 定义
    - agentType: "architect"
      model: "deepseek-v4-pro"
      modelProvider: "deepseek"
      whenToUse: "系统架构设计和任务分解"
      tools: ["Read", "Grep", "WebSearch"]
      permissionMode: "plan"
      maxTurns: 50

    - agentType: "builder"
      model: "kimi-k2.6"
      modelProvider: "moonshot"
      whenToUse: "代码编写和修改"
      tools: ["Read", "Edit", "Write", "Bash"]
      permissionMode: "acceptEdits"
      maxTurns: 100

    - agentType: "reviewer"
      model: "glm-5.1"
      modelProvider: "zhipu"
      whenToUse: "代码审查和测试"
      tools: ["Read", "Bash"]
      permissionMode: "plan"
      maxTurns: 50
      background: true

    - agentType: "cost-optimizer"
      model: "minimax-m2.7"
      modelProvider: "minimax"
      whenToUse: "成本敏感的任务"
      tools: ["Read", "Grep"]
      permissionMode: "plan"
      maxTurns: 30

  # 模型提供商配置
  providers:
    anthropic:
      apiKey: "${ANTHROPIC_API_KEY}"
      baseURL: "https://api.anthropic.com"
    
    deepseek:
      apiKey: "${DEEPSEEK_API_KEY}"
      baseURL: "https://api.deepseek.com"
    
    moonshot:
      apiKey: "${MOONSHOT_API_KEY}"
      baseURL: "https://api.moonshot.cn/v1"
    
    zhipu:
      apiKey: "${ZHIPU_API_KEY}"
      baseURL: "https://open.bigmodel.cn/api/paas/v4"
    
    minimax:
      apiKey: "${MINIMAX_API_KEY}"
      baseURL: "https://api.minimaxi.com/v1"

  # 路由策略
  routing:
    defaultStrategy: "quality-first"
    strategies:
      quality-first:
        weightScore: 0.7
        weightCost: 0.3
      cost-first:
        weightScore: 0.3
        weightCost: 0.7
      balanced:
        weightScore: 0.5
        weightCost: 0.5

  # 通信配置
  communication:
    defaultMode: "auto"  # auto | memory | file | http
    fileMailbox:
      baseDir: "~/.multi-agent/teams"
    httpBridge:
      enabled: false
      port: 8080

  # 安全配置
  security:
    requireHumanApproval:
      - "file.delete"
      - "bash.exec"
      - "git.push"
    maxDelegationDepth: 3
```

---

## 八、使用示例

### 8.1 启动 Coordinator

```bash
# 设置环境变量
export ANTHROPIC_API_KEY="sk-ant-..."
export DEEPSEEK_API_KEY="sk-..."
export MOONSHOT_API_KEY="sk-..."
export ZHIPU_API_KEY="..."
export MINIMAX_API_KEY="..."

# 启动编排器
multi-agent-orchestrator --config config.yaml
```

### 8.2 提交任务

```typescript
// 通过 API 提交任务
const orchestrator = new MultiAgentOrchestrator({
  configPath: './config.yaml'
});

const result = await orchestrator.execute({
  task: '重构用户认证模块，添加 OAuth2.0 支持',
  constraints: {
    maxCost: 0.5,  // 最多花费 $0.5
    maxTime: 1800, // 最多 30 分钟
    preferredModels: ['deepseek-v4-pro', 'kimi-k2.6']
  }
});

console.log(result.summary);
console.log(result.changes);
console.log(result.cost);
```

---

## 九、项目结构

```
multi-agent-orchestrator/
├── src/
│   ├── coordinator/
│   │   ├── coordinator.ts      # 主协调器
│   │   ├── task-planner.ts     # 任务规划器
│   │   └── agent-router.ts     # Agent 路由器
│   ├── agents/
│   │   ├── agent-definition.ts # Agent 定义
│   │   ├── agent-factory.ts    # Agent 工厂
│   │   └── base-agent.ts       # Agent 基类
│   ├── adapters/
│   │   ├── base-adapter.ts     # 适配器基类
│   │   ├── deepseek-adapter.ts
│   │   ├── kimi-adapter.ts
│   │   ├── glm-adapter.ts
│   │   └── minimax-adapter.ts
│   ├── communication/
│   │   ├── comm-hub.ts         # 通信中心
│   │   ├── file-mailbox.ts     # 文件邮箱
│   │   ├── memory-queue.ts     # 内存队列
│   │   └── http-bridge.ts      # HTTP 桥接
│   ├── lifecycle/
│   │   ├── lifecycle-manager.ts
│   │   └── worktree-manager.ts
│   ├── security/
│   │   ├── permission-manager.ts
│   │   └── tool-filter.ts
│   ├── tools/
│   │   ├── base-tool.ts
│   │   ├── file-tools.ts
│   │   ├── bash-tool.ts
│   │   └── web-tools.ts
│   └── types/
│       └── index.ts
├── config/
│   └── default.yaml
├── tests/
├── docs/
└── package.json
```

---

## 十、关键技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 语言 | TypeScript/Node.js | 与 Claude Code 同源，便于集成 |
| 通信机制 | 文件邮箱 + 内存队列 + HTTP | 参考 Claude Code 设计，分层降级 |
| 隔离方式 | Git Worktree | 轻量、原生、可审计 |
| 配置格式 | YAML | 人类可读，支持注释 |
| 协议兼容 | OpenAI API 格式 | 行业事实标准，各厂商均支持 |

---

---

## 十一、与 Claude Code 的集成方案

### 11.1 集成架构

```
Claude Code (with Agent Teams)
    ├── Native Claude Agents
    └── External Orchestrator Bridge
            │
            ▼
    Multi-Agent Orchestrator
            │
    ┌───────┼───────┐
    ▼       ▼       ▼
DeepSeek  Kimi    GLM
```

### 11.2 桥接实现

通过 Claude Code 的 `Bash` 工具调用外部编排器：

```typescript
// Claude Code Skill: external-orchestrator
{
  "name": "external-orchestrator",
  "description": "调用外部多模型编排器处理复杂任务",
  "tools": ["Bash", "Read", "Write"],
  "prompt": `
当任务需要调用 DeepSeek/Kimi/GLM/MiniMax 等非 Claude 模型时：
1. 构造任务描述 JSON
2. 调用 orchestrator CLI: multi-agent-orchestrator execute --task-file task.json
3. 读取返回结果
4. 将结果整合到当前工作流
  `
}
```

### 11.3 任务文件格式

```json
{
  "task": "重构用户认证模块",
  "context": {
    "codebase": "/path/to/project",
    "relevantFiles": ["auth.py", "models.py"]
  },
  "constraints": {
    "maxCost": 0.5,
    "maxTime": 1800,
    "preferredModels": ["deepseek-v4-pro", "kimi-k2.6"]
  },
  "output": {
    "format": "git-patch",
    "destination": "/path/to/output"
  }
}
```

### 11.4 结果回传

编排器完成后，通过文件邮箱通知 Claude Code：

```json
{
  "from": "orchestrator",
  "to": "claude-code-leader",
  "type": "task_response",
  "summary": "认证模块重构完成",
  "payload": {
    "status": "success",
    "changes": 12,
    "filesModified": ["auth.py", "oauth.py", "tests/test_auth.py"],
    "cost": 0.32,
    "duration": 1200,
    "patchFile": "/tmp/orchestrator-result.patch"
  }
}
```

---

## 十二、演进路线

| 阶段 | 目标 | 时间 |
|------|------|------|
| **MVP** | 支持 DeepSeek + Kimi，基础 Coordinator 四阶段 | 2 周 |
| **v0.2** | 添加 GLM + MiniMax，完善权限系统 | 1 周 |
| **v0.3** | 支持 Claude Code 桥接，文件邮箱通信 | 1 周 |
| **v0.4** | 添加可视化监控，成本追踪 | 1 周 |
| **v1.0** | 生产就绪，完整测试覆盖，文档完善 | 2 周 |

---

这份设计方案完整参考了 Claude Code 泄露源码中的 Coordinator Mode 架构，同时扩展了多模型适配能力。需要我进一步细化某个模块的实现代码吗？
