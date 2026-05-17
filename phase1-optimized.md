# Phase 1 优化版: Workflow 作为复合 Agent + 智能推荐

> 核心理念：用户无需感知 Agent 和 Workflow 的区别，系统自动路由

---

## 1. 设计目标

### 1.1 问题

原 Phase 1 的 Workflow 是独立模块，需要用户显式指定文件路径执行：

```bash
# 原方案 — 用户需要知道 workflow 文件在哪
agent-orch workflow run .workflows/code-review.yaml
```

这导致：
- 用户需要记住 workflow 文件路径
- 用户需要理解 "workflow" 和 "agent" 的区别
- 无法在交互式会话中自然地使用 workflow

### 1.2 目标

**用户只管提需求，系统决定怎么执行。**

```bash
$ agent-orch
> 帮我做 code review
检测到 workflow "code-review" (3步骤: explore → review → fix)
使用此 workflow？[Y/n]
```

Workflow 成为一等公民，跟普通 Agent 一样可以被自动路由到。

---

## 2. 核心概念：统一执行单元

### 2.1 两种执行单元

| | 普通 Agent | Workflow Agent |
|---|---|---|
| 定义文件 | `.agents/*.md` | `.workflows/*.yaml` |
| 执行方式 | AgentLoop（单轮 tool-use） | WorkflowEngine（多步骤 DAG） |
| 适用场景 | 简单、单一任务 | 复杂、需要多步协作的任务 |
| 用户感知 | 无差别 | 无差别 |

### 2.2 统一注册

启动时，Orchestrator 同时加载 `.agents/` 和 `.workflows/`，注册为统一的 "可执行单元"：

```
Orchestrator.init()
  ├─ 加载 .agents/*.md      → AgentRegistry
  ├─ 加载 .workflows/*.yaml  → AgentRegistry (标记为 composite)
  └─ 合并为统一的执行单元列表
```

---

## 3. 交互流程

### 3.1 主流程

```
用户启动 agent-orch
       │
  进入交互式 REPL
       │
  用户输入任务
       │
  ┌────┴─────────────────────────────┐
  │ 智能匹配                          │
  │ 1. 扫描所有 workflow 的 name +     │
  │    description                    │
  │ 2. 用 LLM 判断任务与哪个最匹配     │
  └────┬─────────────────────────────┘
       │
  ┌────┴────────────┐
  │ 匹配到 workflow? │
  └────┬────────────┘
   Y   │       N
   │   │       │
   ▼   │       ▼
 显示推荐│   直接用普通 Agent 执行
 [Y/n]  │
   │    │
 Y │    │ N (用户拒绝)
   ▼    ▼
Workflow  普通 Agent 执行
Engine
```

### 3.2 推荐展示

```
> 帮我做 code review

  找到匹配的 workflow: code-review
  描述: 代码审查完整流程
  步骤: explore → review → fix (3步)

  使用 workflow？[Y/n]
```

简洁明了，一个确认就够。用户说 N 后不再追问，直接用普通 Agent 执行。

### 3.3 边界情况

| 场景 | 行为 |
|---|---|
| 匹配到 1 个 workflow | 推荐该 workflow |
| 匹配到多个 workflow | 列出候选，让用户选 |
| 未匹配到任何 workflow | 直接用普通 Agent 执行 |
| 用户明确指定 `/workflow xxx` | 直接执行，不问 |
| 用户明确指定 `/agent xxx` | 直接用普通 Agent，不推荐 workflow |

---

## 4. 指令体系

### 4.1 执行指令

```bash
# 直接输入任务 — 系统自动匹配
> 帮我做 code review

# 显式指定 workflow
> /workflow code-review

# 显式指定普通 agent
> /agent explore
```

### 4.2 管理指令

```bash
# Workflow 管理
> /workflow list              # 列出所有 workflow
> /workflow new               # 交互式创建新 workflow
> /workflow edit code-review  # 编辑已有 workflow
> /workflow delete xxx        # 删除 workflow
> /workflow status <run-id>   # 查看运行状态

# Agent 管理
> /agent list                 # 列出所有 agent
> /agent new                  # 交互式创建新 agent
> /agent edit xxx             # 编辑已有 agent
```

### 4.3 `/workflow new` 交互式创建

```
> /workflow new

名称: deploy-check
描述: 部署前的质量检查流程

步骤 1 — 选择类型:
  1. agent    (单个 agent 执行)
  2. committee (多个 agent 并行)
  3. checkpoint (人工审批)
> 1

步骤 1 — 选择 agent:
  可用: explore, coder, reviewer, tester
> reviewer

步骤 1 — 任务描述:
> 审查代码质量和潜在问题

添加下一步？[Y/n]
> y

步骤 2 — 选择类型:
> 1

步骤 2 — 选择 agent:
> tester

步骤 2 — 任务描述:
> 运行测试套件并报告结果

添加下一步？[Y/n]
> n

生成的 workflow 定义:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
name: deploy-check
description: 部署前的质量检查流程
steps:
  - id: step1
    type: agent
    agentType: reviewer
    task: 审查代码质量和潜在问题
  - id: step2
    type: agent
    agentType: tester
    task: 运行测试套件并报告结果
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

保存？[Y/修改/取消]
> y

✓ Workflow "deploy-check" 已创建
```

---

## 5. 智能匹配机制

### 5.1 匹配策略

使用轻量级 LLM 调用进行意图匹配，而非关键词硬匹配：

```
输入: 用户任务描述
候选: 所有 workflow 的 { name, description }

Prompt:
  以下是用户任务: "{task}"
  以下是可用的 workflow:
  1. {name}: {description}
  2. {name}: {description}
  ...

  如果有匹配的 workflow，返回其 name。
  如果没有匹配，返回 "none"。
  只返回 name 或 "none"，不要解释。
```

### 5.2 为什么不用关键词

- 关键词匹配太脆弱（"帮我看看代码" 不含 "review" 但可能是 code review）
- 不同语言的表述差异大
- LLM 匹配成本极低（一次小模型调用），准确率远高于规则

### 5.3 匹配缓存

同一会话中，相同任务不重复匹配。用任务文本的 hash 做 key。

---

## 6. 技术实现

### 6.1 新建文件

| 文件 | 用途 |
|---|---|
| `src/agent/workflow-matcher.ts` | 智能匹配：用户意图 → workflow name |
| `src/agent/workflow-matcher.test.ts` | 匹配逻辑测试 |
| `src/cli/repl-commands.ts` | `/workflow` `/agent` 指令处理 |
| `src/cli/repl-commands.test.ts` | 指令解析测试 |
| `src/cli/workflow-wizard.ts` | `/workflow new` 交互式创建向导 |
| `src/cli/workflow-wizard.test.ts` | 向导测试 |

### 6.2 修改文件

| 文件 | 改动 |
|---|---|
| `src/workflow/parser.ts` | `description` 字段改为必填（匹配依赖它） |
| `src/workflow/types.ts` | WorkflowDefinition.description 从可选改为必填 |
| `src/cli/main.ts` | 1. REPL 输入处理：先匹配 workflow，再执行<br>2. 注册 `/workflow` `/agent` 指令<br>3. 启动时加载 `.workflows/` 到执行单元列表 |
| `src/config/types.ts` | `WorkflowsConfig` 新增 `autoRecommend: boolean` |
| `src/config/validator.ts` | 对应 Zod schema 更新 |

### 6.3 关键模块设计

**WorkflowMatcher**

```typescript
// src/agent/workflow-matcher.ts

interface WorkflowMatchResult {
  matched: boolean;
  workflowName?: string;
  workflowDescription?: string;
  stepCount?: number;
  confidence?: number;
}

class WorkflowMatcher {
  /**
   * 分析用户任务，匹配最合适的 workflow。
   * 返回匹配结果，调用方决定是否推荐给用户。
   */
  async match(
    task: string,
    workflows: WorkflowDefinition[]
  ): Promise<WorkflowMatchResult>

  /**
   * 匹配多个候选（当有多个相似 workflow 时）。
   */
  async matchMultiple(
    task: string,
    workflows: WorkflowDefinition[],
    limit?: number
  ): Promise<WorkflowMatchResult[]>
}
```

**ReplCommands**

```typescript
// src/cli/repl-commands.ts

interface CommandContext {
  workflows: WorkflowDefinition[];
  agents: Map<string, AgentDefinition>;
  engine: WorkflowEngine;
  matcher: WorkflowMatcher;
  // ... 其他依赖
}

/**
 * 处理用户输入。
 * 如果是 /指令，路由到对应处理器。
 * 如果是普通文本，匹配 workflow 或执行 agent。
 */
async function handleInput(
  input: string,
  ctx: CommandContext
): Promise<string | null>
```

---

## 7. 配置变更

```yaml
workflows:
  dir: .workflows
  stateDir: .workflow-state
  defaultTimeout: 600000
  autoRecommend: true          # 是否自动推荐匹配的 workflow
```

`autoRecommend: false` 时，系统不主动推荐，但用户仍可通过 `/workflow xxx` 显式执行。

---

## 8. 与已实现代码的关系

Phase 1 原版已实现的核心模块（engine、state-store、parser、template-resolver）**全部保留**，不做重写。本次优化是在其上层增加：

```
新增层:  智能匹配 + REPL 指令 + 交互式创建
           │
已有层:  WorkflowEngine / StateStore / Parser / TemplateResolver  ← 不变
           │
已有层:  AgentLoop / Committee / Tools                            ← 不变
```

具体来说：
- `src/workflow/engine.ts` — 不改
- `src/workflow/state-store.ts` — 不改
- `src/workflow/template-resolver.ts` — 不改
- `src/workflow/parser.ts` — 仅 `description` 改为必填
- `src/workflow/types.ts` — 仅 `description` 类型变更

---

## 9. 测试计划

| 测试 | 说明 |
|---|---|
| matcher: single match | 1 个 workflow，匹配正确 |
| matcher: multiple matches | 多个候选，返回最佳匹配 |
| matcher: no match | 无匹配，返回 matched: false |
| matcher: cache | 相同任务不重复调用 LLM |
| repl: /workflow list | 列出所有 workflow |
| repl: /workflow new | 交互式创建流程 |
| repl: /agent list | 列出所有 agent |
| repl: task with match | 输入任务 → 推荐 workflow |
| repl: task no match | 输入任务 → 直接 agent 执行 |
| repl: decline workflow | 用户拒绝 → 走 agent |
| wizard: basic flow | 完整创建流程 |
| wizard: with condition | 创建带条件分支的 workflow |
| wizard: with checkpoint | 创建带审批点的 workflow |

---

## 10. 实现步骤

```
Step 1: WorkflowMatcher
  - 实现 LLM 匹配逻辑
  - 测试：单匹配、多匹配、无匹配、缓存

Step 2: REPL 指令框架
  - 实现 /workflow 和 /agent 指令路由
  - 实现 /workflow list, /agent list

Step 3: 主流程集成
  - REPL 输入 → 匹配 → 推荐 → 执行
  - 修改 cli/main.ts 的输入处理

Step 4: 交互式创建
  - 实现 /workflow new 向导
  - 实现 /workflow edit

Step 5: 配置和收尾
  - autoRecommend 配置
  - description 改为必填
  - 更新示例 workflow
```
