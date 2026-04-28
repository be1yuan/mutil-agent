# Multi-Agent Orchestrator v7 — 终端可视化方案

## 一、问题分析

### 1.1 现状：Web 监控面板方案的缺陷

DESIGN-v6 v1.0 路线图规划了 "Web 监控面板" 用于实时监控 Agent 状态和成本。该方案存在以下根本性问题：

| 问题 | 影响 |
|------|------|
| **启动成本高** | 每次监控需要打开浏览器、输入 URL，与 CLI 工具的即时性相悖 |
| **架构复杂度膨胀** | 需要 HTTP Server + WebSocket + 前端框架，从 CLI 工具变成 Web 应用 |
| **与现有架构脱节** | AgentLoop 无事件总线、无回调机制，接入 Web 面板需要大规模重构 |
| **使用场景错配** | 多 Agent CLI 工具的用户在终端中工作，浏览器面板是上下文切换 |

### 1.2 当前用户体验的具体痛点

**痛点 1：无实时状态反馈**

```
$ npm run dev run "重构 auth 模块" --agent coder

[info]: agent.task.started {"agentType":"coder","model":"deepseek-v4-pro"}
> 用户看到的：模型输出的原始文本流，无上下文
> 用户不知道的：当前第几步？在执行什么工具？花了多少钱？
```

**痛点 2：Committee 输出交错混乱**

```
$ npm run dev committee "审查代码" --agents "explore,reviewer"

> explore 的输出...
> reviewer 的输出混在一起...
> 无法区分谁在说什么
```

**痛点 3：结果摘要过于简陋**

```
--- Result ---
Status: success
Content: ...（大段文本）
Steps: 16
Cost: $0.027
```

**痛点 4：工具执行期间沉默**

模型输出文本后，进入工具执行阶段 —— 此时终端完全无输出。用户不知道 Agent 是在工作还是卡死了。

### 1.3 设计目标

| 目标 | 说明 |
|------|------|
| **零浏览器依赖** | 纯终端原生，ANSI 颜色 + Unicode 符号 |
| **零新依赖（Phase 1）** | 增强现有输出，不引入新 npm 包 |
| **渐进式增强** | Phase 1 基础美化 → Phase 2 全屏仪表盘，可选启用 |
| **操作简化** | 减少手动输入，提供直观的状态反馈 |
| **Committee 可区分** | 多 Agent 并行时，每个 Agent 的输出带颜色标识 |

---

## 二、整体方案

### 2.1 两阶段递进架构

```
Phase 1: 增强终端输出（零新依赖）
├── ANSI 颜色 + Unicode 符号
├── 结构化状态行（步骤、工具、成本）
├── 带颜色前缀的 Committee 输出
└── CLI 选项：--verbose / --quiet

Phase 2: 交互式 TUI 仪表盘（可选，ink 框架）
├── 全屏 Alternate Screen Buffer
├── 四区域布局：状态栏 | 输出区 | 成本条 | 审批区
├── 实时更新：事件驱动 + React 状态管理
└── CLI 标志：--dashboard 启用
```

### 2.2 对比

| 维度 | Web 面板（v6 v1.0） | 终端可视化（v7） |
|------|---------------------|-----------------|
| 启动方式 | 打开浏览器 → 输入 URL | 终端内直接显示，零额外操作 |
| 依赖 | HTTP Server + WebSocket + 前端 | Phase 1: 零依赖；Phase 2: ink（单包） |
| 架构改动 | 需要事件总线 + API 端点 | 仅新增可选回调到 AgentLoopDeps |
| 使用场景 | 独立监控窗口 | 与工作流一体，无上下文切换 |
| Committee 支持 | 需要多面板/多标签 | 颜色前缀（Phase 1）/ 分区面板（Phase 2） |
| 交互能力 | 鼠标点击 | 键盘快捷键（Phase 2） |

---

## 三、Phase 1 — 增强终端输出

### 3.1 设计原则

- **不改变现有行为**：logger 仍然输出到文件，新增的是面向用户的美化输出
- **向后兼容**：`--quiet` 模式恢复原始行为
- **零新依赖**：纯 ANSI 转义码 + Unicode 字符

### 3.2 ANSI 工具模块

新增 `src/cli/ansi.ts`，提供终端格式化的基础工具。

#### 颜色系统

```typescript
// src/cli/ansi.ts

/** ANSI 转义码 — 零依赖 */
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

/** 前景色 */
const fg = {
  green:  (s: string) => `${ESC}32m${s}${RESET}`,
  red:    (s: string) => `${ESC}31m${s}${RESET}`,
  yellow: (s: string) => `${ESC}33m${s}${RESET}`,
  cyan:   (s: string) => `${ESC}36m${s}${RESET}`,
  blue:   (s: string) => `${ESC}34m${s}${RESET}`,
  magenta:(s: string) => `${ESC}35m${s}${RESET}`,
  gray:   (s: string) => `${ESC}90m${s}${RESET}`,
  white:  (s: string) => `${ESC}97m${s}${RESET}`,
};

/** 组合样式 */
const style = {
  bold:    (s: string) => `${BOLD}${s}${RESET}`,
  dim:     (s: string) => `${DIM}${s}${RESET}`,
  success: (s: string) => fg.green(s),
  error:   (s: string) => fg.red(s),
  warning: (s: string) => fg.yellow(s),
  info:    (s: string) => fg.cyan(s),
  muted:   (s: string) => fg.gray(s),
};
```

#### Unicode 符号表

```typescript
/** 工具/状态对应的符号 */
export const symbols = {
  // 步骤
  step:      "▸",   // 步骤开始
  stepSub:   "├▸",  // 子步骤
  stepLast:  "└▸",  // 最后一个子步骤

  // 工具
  read:      "📄",  // 文件读取
  write:     "📝",  // 文件写入
  edit:      "✏️",   // 文件编辑
  bash:      "⚙️",   // 命令执行
  grep:      "🔍",  // 搜索
  glob:      "📂",  // 文件匹配
  webSearch: "🌐",  // 网页搜索
  webFetch:  "🔗",  // 网页抓取
  spawn:     "┬",   // 子 Agent 派生

  // 状态
  ok:        "✓",   // 成功
  fail:      "✗",   // 失败
  warn:      "⚠",   // 警告
  info:      "●",   // 信息
  running:   "◌",   // 运行中
  done:      "✓",   // 完成
  pending:   "○",   // 等待中

  // 框线
  boxH:      "─",   // 水平线
  boxV:      "│",   // 垂直线
  boxTL:     "╭",   // 左上角
  boxTR:     "╮",   // 右上角
  boxBL:     "╰",   // 左下角
  boxBR:     "╯",   // 右下角
};
```

#### 格式化函数

```typescript
/** 工具名称到符号的映射 */
export function toolSymbol(toolName: string): string {
  const map: Record<string, string> = {
    Read: symbols.read, Write: symbols.write, Edit: symbols.edit,
    Bash: symbols.bash, Grep: symbols.grep, Glob: symbols.glob,
    WebSearch: symbols.webSearch, WebFetch: symbols.webFetch,
    task: symbols.spawn,
  };
  return map[toolName] ?? symbols.info;
}

/** 带边框的横幅 */
export function banner(lines: string[], width = 60): string {
  const top    = `${symbols.boxTL}${symbols.boxH.repeat(width - 2)}${symbols.boxTR}`;
  const bottom = `${symbols.boxBL}${symbols.boxH.repeat(width - 2)}${symbols.boxBR}`;
  const body = lines.map(line => {
    const padded = ` ${line}`.padEnd(width - 1) + symbols.boxV;
    return `${symbols.boxV}${padded}`;
  });
  return [top, ...body, bottom].join("\n");
}

/** 进度条 */
export function progressBar(ratio: number, width = 20): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pct = (ratio * 100).toFixed(1) + "%";
  return `[${bar}] ${pct}`;
}

/** 截断字符串 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}
```

### 3.3 状态渲染器

新增 `src/cli/status-renderer.ts`，组合 ansi.ts 的工具为面向业务的渲染函数。

#### 启动横幅

```typescript
export function renderBanner(agentType: string, model: string, budget: number): string {
  return banner([
    style.bold(`Agent: ${agentType}`) + " │ " +
    style.info(`Model: ${model}`) + " │ " +
    style.success(`Budget: $${budget.toFixed(2)}`),
  ]);
}
```

**输出效果：**
```
╭────────────────────────────────────────────────────────╮
│ Agent: coder │ Model: deepseek-v4-pro │ Budget: $5.00  │
╰────────────────────────────────────────────────────────╯
```

#### 步骤头

```typescript
export function renderStepStart(step: number, maxSteps: number): string {
  return style.bold(fg.cyan(`▸ Step ${step}/${maxSteps}`));
}
```

**输出效果：**
```
▸ Step 3/50
```

#### 工具执行行

```typescript
export function renderToolStart(toolName: string, detail: string): string {
  const sym = toolSymbol(toolName);
  const name = style.bold(toolName.padEnd(10));
  const det = style.dim(truncate(detail, 60));
  return `  ${sym} ${name} ${det}`;
}

export function renderToolComplete(toolName: string, detail: string, success: boolean, duration: number): string {
  const sym = toolSymbol(toolName);
  const name = style.bold(toolName.padEnd(10));
  const det = style.dim(truncate(detail, 40));
  const status = success ? style.success(`✓ ${duration}ms`) : style.error(`✗ ${duration}ms`);
  return `  ${sym} ${name} ${det}  ${status}`;
}
```

**输出效果：**
```
  📄 Read       src/auth/login.ts                    ✓ 12ms
  ✏️  Edit       src/auth/login.ts (token refresh)    ✓ 8ms
  ⚙️  Bash       npm test                             ✓ 2341ms
```

#### 子 Agent 派生

```typescript
export function renderSubAgentSpawn(parent: string, child: string, task: string): string {
  return `  ${symbols.spawn} ${style.dim(`[${parent}]`)} → ${style.info(`[${child}]`)} ${style.dim(truncate(task, 50))}`;
}

export function renderSubAgentComplete(child: string, status: string, cost: number): string {
  const icon = status === "success" ? symbols.ok : symbols.fail;
  const color = status === "success" ? style.success : style.error;
  return `  ${symbols.done} ${color(`[${child}]`)} ${status} ${style.dim(`($${cost.toFixed(4)})`)}`;
}
```

**输出效果：**
```
  ┬ [coder] → [explore] 搜索 refresh token 的使用位置
  ╰ [explore] success ($0.0123)
```

#### 成本状态栏

```typescript
export function renderCostStatus(spent: number, budget: number, steps: number, maxSteps: number): string {
  const ratio = budget > 0 ? spent / budget : 0;
  const bar = progressBar(ratio, 20);
  const costColor = ratio > 0.8 ? style.error : ratio > 0.5 ? style.warning : style.success;

  return [
    `${symbols.boxTL}${symbols.boxH.repeat(58)}${symbols.boxTR}`,
    `${symbols.boxV} ${style.bold("Status")} │ Steps: ${steps}/${maxSteps} │ Cost: ${costColor(`$${spent.toFixed(4)}`)} │ Budget: ${bar} ${symbols.boxV}`,
    `${symbols.boxBL}${symbols.boxH.repeat(58)}${symbols.boxBR}`,
  ].join("\n");
}
```

**输出效果：**
```
╭──────────────────────────────────────────────────────────╮
│ Status │ Steps: 3/50 │ Cost: $0.0312 │ Budget: [████░░░░░░░░░░░░░░░░] 6.2% │
╰──────────────────────────────────────────────────────────╯
```

#### 最终结果块

```typescript
export function renderResult(result: AgentResult): string {
  const statusIcon = result.status === "success" ? symbols.ok : symbols.fail;
  const statusColor = result.status === "success" ? style.success : style.error;

  return banner([
    `${statusIcon} ${statusColor(result.status.toUpperCase())}`,
    `Steps: ${result.steps} │ Cost: $${result.cost.toFixed(4)}`,
    result.error ? style.error(`Error: ${truncate(result.error, 40)}`) : "",
  ].filter(Boolean));
}
```

#### Committee 结果树

```typescript
export function renderCommitteeResult(result: CommitteeResult): string {
  const lines: string[] = [
    style.bold(`Committee │ Strategy: ${result.strategy} │ Members: ${result.members.length}`),
    "",
  ];

  for (let i = 0; i < result.members.length; i++) {
    const m = result.members[i];
    const isLast = i === result.members.length - 1;
    const connector = isLast ? symbols.stepLast : symbols.stepSub;
    const icon = m.result.status === "success" ? symbols.ok : symbols.fail;
    const color = m.result.status === "success" ? style.success : style.error;

    lines.push(
      `  ${connector} ${color(m.agentType)} ${icon} ` +
      `${m.result.status} (${m.result.steps} steps, $${m.result.cost.toFixed(4)})`
    );
  }

  lines.push("");
  lines.push(`Total cost: $${result.totalCost.toFixed(4)} │ Total steps: ${result.totalSteps}`);

  return banner(lines);
}
```

**输出效果：**
```
╭────────────────────────────────────────────────────────╮
│ Committee │ Strategy: concat │ Members: 3              │
│                                                         │
│   ├▸ explore   ✓ success (8 steps, $0.0123)            │
│   ├▸ coder     ✓ success (12 steps, $0.0456)           │
│   └▸ reviewer  ✓ success (5 steps, $0.0089)            │
│                                                         │
│ Total cost: $0.0668 │ Total steps: 25                  │
╰────────────────────────────────────────────────────────╯
```

### 3.4 Agent Loop 生命周期回调

在 `AgentLoopDeps` 接口中新增 6 个可选回调，用于向 CLI 层传递结构化事件。

#### 接口定义

```typescript
// src/agent/agent-loop.ts

export interface AgentLoopDeps {
  // ... 现有字段保持不变 ...

  /** 步骤开始 */
  onStepStart?: (step: number, agentType: string) => void;

  /** 工具开始执行 */
  onToolStart?: (agentType: string, toolName: string, args: Record<string, unknown>) => void;

  /** 工具执行完成 */
  onToolComplete?: (agentType: string, toolName: string, duration: number, success: boolean) => void;

  /** 子 Agent 派生 */
  onSubAgentSpawn?: (parentType: string, childType: string, task: string) => void;

  /** 子 Agent 完成 */
  onSubAgentComplete?: (parentType: string, childType: string, result: SubAgentResult) => void;

  /** 预算更新（每次模型调用后触发） */
  onBudgetUpdate?: (spent: number, remaining: number) => void;
}
```

#### 插入位置

在 `AgentLoop.run()` 方法中：

```typescript
async run(task, definition, budget) {
  // ... 现有代码 ...

  while (steps < definition.maxSteps) {
    // ★ 新增：步骤开始回调
    this.deps.onStepStart?.(steps, definition.agentType);

    // ... 现有的 provider 选择、budget check、model call ...

    // ★ 新增：预算更新回调
    this.deps.onBudgetUpdate?.(this.deps.costTracker.spent, this.deps.costTracker.remaining);

    // ... 现有的 tool call 处理 ...

    for (const tc of response.toolCalls) {
      // ★ 新增：工具开始回调
      const toolStart = Date.now();
      this.deps.onToolStart?.(definition.agentType, tc.name, tc.arguments);

      const result = await this.executeToolCall(tc, definition);

      // ★ 新增：工具完成回调
      const duration = Date.now() - toolStart;
      const success = !result.startsWith("[denied]") && !result.startsWith("[tool error]");
      this.deps.onToolComplete?.(definition.agentType, tc.name, duration, success);

      // ... 现有的 toolResults 处理 ...
    }

    steps++;
  }
}
```

在 `spawnSubAgent()` 方法中：

```typescript
private async spawnSubAgent(args, definition) {
  // ★ 新增：子 Agent 派生回调
  this.deps.onSubAgentSpawn?.(definition.agentType, args.agentType, args.task);

  // ... 现有的子 Agent 执行逻辑 ...

  // ★ 新增：子 Agent 完成回调（在 result 获取后）
  this.deps.onSubAgentComplete?.(definition.agentType, args.agentType, subResult);
}
```

### 3.5 Committee 颜色前缀

修改 `Committee.run()` 方法，为每个成员的流式输出添加带颜色的前缀。

#### 颜色分配方案

```typescript
// src/agent/committee.ts

/** 为 committee 成员分配颜色 */
const MEMBER_COLORS = [
  (s: string) => `\x1b[36m${s}\x1b[0m`,  // cyan
  (s: string) => `\x1b[33m${s}\x1b[0m`,  // yellow
  (s: string) => `\x1b[35m${s}\x1b[0m`,  // magenta
  (s: string) => `\x1b[32m${s}\x1b[0m`,  // green
  (s: string) => `\x1b[34m${s}\x1b[0m`,  // blue
];
```

#### 修改 Committee.run()

```typescript
// 在 Committee.run() 中，为每个 agent 的 deps 添加带前缀的 onStreamText

const promises = config.agentTypes.map(async (agentType, index) => {
  const color = MEMBER_COLORS[index % MEMBER_COLORS.length];
  const prefix = color(`[${agentType}] `);

  // 创建该 agent 专用的 deps，替换 onStreamText
  const memberDeps = {
    ...this.deps,
    onStreamText: (text: string) => {
      // 为每行添加颜色前缀
      const prefixed = text.split("\n").map((line, i) =>
        i === 0 ? prefix + line : " ".repeat(prefix.length - 10) + line
      ).join("\n");
      this.deps.onStreamText?.(prefixed);
    },
  };

  const loop = new AgentLoop(memberDeps);
  const result = await loop.run(task, definition, this.deps.costTracker.remaining);
  return { agentType, result };
});
```

### 3.6 CLI 选项扩展

在 Commander 命令定义中新增选项：

```typescript
// src/cli/main.ts

program
  .command("run")
  .option("-v, --verbose", "显示完整工具参数和返回值")
  .option("-q, --quiet", "只显示最终结果，抑制实时输出")
  // ...

program
  .command("committee")
  .option("-v, --verbose", "显示完整工具参数和返回值")
  .option("-q, --quiet", "只显示最终结果，抑制实时输出")
  // ...
```

#### quiet 模式

```typescript
// 当 --quiet 时，不注册 onStreamText，只在结束时输出结果块
const onStreamText = options.quiet ? undefined : (text: string) => {
  process.stdout.write(text);
};
```

#### verbose 模式

```typescript
// 当 --verbose 时，onToolStart 输出完整参数
onToolStart: (agentType, toolName, args) => {
  if (options.verbose) {
    console.log(renderToolStart(toolName, JSON.stringify(args)));
  } else {
    console.log(renderToolStart(toolName, summarizeArgs(toolName, args)));
  }
},
```

### 3.7 完整执行流程示例

```
$ npm run dev run "重构 auth 模块的 token 刷新逻辑" --agent coder

╭────────────────────────────────────────────────────────╮
│ Agent: coder │ Model: deepseek-v4-pro │ Budget: $5.00  │
╰────────────────────────────────────────────────────────╯

▸ Step 1/50
  📄 Read       src/auth/login.ts
  📄 Read       src/auth/types.ts
  📄 Read       src/auth/token.ts                    ✓ 15ms

▸ Step 2/50
  🔍 Grep       "refreshToken" src/                   ✓ 234ms
  📂 Glob       "src/auth/**/*.ts"                     ✓ 8ms

▸ Step 3/50
  ✏️  Edit       src/auth/token.ts (refresh logic)     ✓ 12ms

▸ Step 4/50
  ┬ [coder] → [explore] 搜索 refreshToken 的调用链
  ╰ [explore] ✓ success ($0.0089)

▸ Step 5/50
  ⚙️  Bash       npm test                              ✓ 4521ms

╭──────────────────────────────────────────────────────────╮
│ Status │ Steps: 5/50 │ Cost: $0.0412 │ Budget: [█░░░░░░░░░░░░░░░░░░░] 0.8% │
╰──────────────────────────────────────────────────────────╯

╭────────────────────────────────────────────────────────╮
│ ✓ SUCCESS                                              │
│ Steps: 5 │ Cost: $0.0412                              │
╰────────────────────────────────────────────────────────╯
```

---

## 四、Phase 2 — 交互式 TUI 仪表盘

### 4.1 技术选型：ink

| 维度 | 选择 | 理由 |
|------|------|------|
| 框架 | `ink` v7 | Claude Code / Gemini CLI 同款；React 组件模型；活跃维护（2026-04-17 发布）|
| 语言 | TypeScript | 项目统一 TS；ink 本身就是 TS 编写 |
| 平台 | Windows 兼容 | 纯 ANSI 转义码，无原生依赖 |
| 依赖 | ink + react | ~25 个直接依赖，可控 |

**为什么不用 blessed/terminal-kit？**
- `blessed` 已废弃（2018），`neo-blessed` 维护力度不足
- `terminal-kit` API 偏过程式，与项目的面向对象/函数式风格不一致
- `ink` 的 React 模型天然适合实时 UI 更新，且有 Claude Code 级别的实践验证

### 4.2 仪表盘布局

```
┌─ Agent Status ──────────────────┬─ Cost ───────────────────────────┐
│ ▸ coder        [running] step 3 │ Spent: $0.0312 / $5.00          │
│   ├▸ explore   [done]    8 step │ ████████░░░░░░░░░░░░ 6.2%       │
│   └▸ reviewer  [waiting] 0 step │ Provider: deepseek-v4-pro       │
│                                  │ Cache hit: 45%                   │
├──────────────────────────────────┴──────────────────────────────────┤
│ Output                                                              │
│ > Reading src/auth/login.ts...                                      │
│ > Found token refresh at line 42                                    │
│ > Editing: replacing old refresh logic...                           │
│ > [explore] grep "refreshToken" → 3 matches in 2 files             │
│ > [coder] Running npm test...                                       │
│ > ✓ Tests passed (12/12)                                           │
│                                                                     │
│                                                                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ Tool: Bash │ cmd: npm test │ [A]pprove / [D]eny / [V]iew details   │
└─────────────────────────────────────────────────────────────────────┘
```

#### 四个区域

| 区域 | 位置 | 高度 | 功能 |
|------|------|------|------|
| **Agent Status** | 顶部 | 自适应 | Agent 层级树 + 运行状态 |
| **Cost** | 顶部右侧 | 与 Status 同高 | 预算消耗进度条 + 百分比 |
| **Output** | 中间 | 填充剩余 | 滚动输出区（工具结果 + 模型文本） |
| **Approval** | 底部 | 2 行 | 工具审批交互（条件渲染） |

### 4.3 组件架构

```
src/cli/dashboard/
├── app.tsx              # 主组件（布局编排）
├── components/
│   ├── status-bar.tsx   # Agent 状态栏
│   ├── cost-gauge.tsx   # 成本进度条
│   ├── output-panel.tsx # 滚动输出区
│   ├── approval-bar.tsx # 审批交互栏
│   └── agent-tree.tsx   # Agent 层级树
├── event-bridge.ts      # AgentLoopDeps 回调 → EventEmitter
└── types.ts             # Dashboard 专用类型
```

### 4.4 事件桥接

```typescript
// src/cli/dashboard/event-bridge.ts

import { EventEmitter } from "node:events";
import type { AgentLoopDeps } from "../../agent/agent-loop.js";

export interface DashboardEvent {
  type: "step" | "tool_start" | "tool_complete" | "subagent_spawn" |
        "subagent_complete" | "budget" | "stream" | "approval";
  data: unknown;
  timestamp: number;
}

export class DashboardEventBridge extends EventEmitter {
  /** 创建一个绑定了 Dashboard 事件的 AgentLoopDeps */
  createDeps(baseDeps: AgentLoopDeps): AgentLoopDeps {
    return {
      ...baseDeps,

      onStreamText: (text) => {
        this.emit("event", { type: "stream", data: { text }, timestamp: Date.now() });
      },

      onStepStart: (step, agentType) => {
        this.emit("event", { type: "step", data: { step, agentType }, timestamp: Date.now() });
      },

      onToolStart: (agentType, toolName, args) => {
        this.emit("event", { type: "tool_start", data: { agentType, toolName, args }, timestamp: Date.now() });
      },

      onToolComplete: (agentType, toolName, duration, success) => {
        this.emit("event", { type: "tool_complete", data: { agentType, toolName, duration, success }, timestamp: Date.now() });
      },

      onSubAgentSpawn: (parent, child, task) => {
        this.emit("event", { type: "subagent_spawn", data: { parent, child, task }, timestamp: Date.now() });
      },

      onSubAgentComplete: (parent, child, result) => {
        this.emit("event", { type: "subagent_complete", data: { parent, child, result }, timestamp: Date.now() });
      },

      onBudgetUpdate: (spent, remaining) => {
        this.emit("event", { type: "budget", data: { spent, remaining }, timestamp: Date.now() });
      },
    };
  }
}
```

### 4.5 核心组件实现

#### App 主组件

```tsx
// src/cli/dashboard/app.tsx

import React, { useState, useEffect } from "react";
import { Box } from "ink";
import { StatusBar } from "./components/status-bar.js";
import { CostGauge } from "./components/cost-gauge.js";
import { OutputPanel } from "./components/output-panel.js";
import { ApprovalBar } from "./components/approval-bar.js";
import { DashboardEventBridge, type DashboardEvent } from "./event-bridge.js";

interface AppProps {
  bridge: DashboardEventBridge;
  agentType: string;
  model: string;
  budget: number;
}

export function App({ bridge, agentType, model, budget }: AppProps) {
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [spent, setSpent] = useState(0);
  const [currentStep, setCurrentStep] = useState(0);
  const [agents, setAgents] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const handler = (event: DashboardEvent) => {
      setEvents(prev => [...prev.slice(-200), event]); // 保留最近 200 条

      if (event.type === "budget") {
        setSpent((event.data as { spent: number }).spent);
      }
      if (event.type === "step") {
        setCurrentStep((event.data as { step: number }).step);
      }
      if (event.type === "subagent_spawn") {
        const d = event.data as { child: string };
        setAgents(prev => new Map(prev).set(d.child, "running"));
      }
      if (event.type === "subagent_complete") {
        const d = event.data as { child: string; result: { status: string } };
        setAgents(prev => new Map(prev).set(d.child, d.result.status));
      }
    };

    bridge.on("event", handler);
    return () => { bridge.off("event", handler); };
  }, [bridge]);

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row">
        <StatusBar agentType={agentType} model={model} step={currentStep} agents={agents} />
        <CostGauge spent={spent} budget={budget} />
      </Box>
      <OutputPanel events={events} flexGrow={1} />
      <ApprovalBar />
    </Box>
  );
}
```

### 4.6 CLI 集成

```typescript
// src/cli/main.ts — 新增 --dashboard 标志

import { render } from "ink";
import React from "react";
import { App } from "./dashboard/app.js";
import { DashboardEventBridge } from "./dashboard/event-bridge.js";

program
  .command("run")
  .option("--dashboard", "启用交互式终端仪表盘")
  .action(async (task, options) => {
    // ... 现有的 orchestrator 初始化 ...

    if (options.dashboard) {
      const bridge = new DashboardEventBridge();
      const deps = bridge.createDeps(baseDeps);

      // 渲染 Dashboard UI
      const { unmount, rerender } = render(
        React.createElement(App, {
          bridge,
          agentType: options.agent ?? "main",
          model: definition.model,
          budget,
        })
      );

      // 后台执行任务
      const loop = new AgentLoop(deps);
      loop.run(task, definition, budget).then(result => {
        // 渲染最终结果
        setTimeout(() => {
          unmount();
          console.log(renderResult(result));
          process.exit(0);
        }, 500);
      });
    } else {
      // 现有的非 dashboard 模式（Phase 1 增强输出）
      // ...
    }
  });
```

### 4.7 安装依赖

```bash
npm install ink react
npm install -D @types/react
```

**依赖影响评估：**
- `ink` v7：~25 直接依赖（含 `yoga-wasm-web` 用于 Flexbox 布局）
- `react` v19：运行时依赖
- 总增加约 15MB `node_modules`（可接受）

---

## 五、与 v6 路线图的关系

### 5.1 替代关系

| v6 v1.0 计划 | v7 替代方案 | 变化 |
|-------------|-----------|------|
| Web 监控面板 | Phase 1: 增强终端输出 | **完全替代**，零新依赖 |
| Web 监控面板 | Phase 2: TUI 仪表盘 | **降级替代**，从 Web 变为终端 |
| Prometheus 指标 (metrics.ts) | 不变 | 保持 v1.0 计划 |

### 5.2 路线图调整建议

```
v0.3 (保持不变)
├── 文件邮箱
└── HTTP API

v0.4 (新增)
├── Phase 1: 增强终端输出（ANSI + 结构化状态）
└── AgentLoop 生命周期回调

v0.5 (新增)
├── Phase 2: ink TUI 仪表盘
└── --dashboard 标志

v1.0 (调整)
├── MiniMax 适配
├── Prometheus 指标 (metrics.ts)  ← 从 v1.0 保留
└── 生产就绪测试套件
```

---

## 六、文件改动总览

### Phase 1

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/cli/ansi.ts` | 新增 | ANSI 颜色、符号、格式化工具（零依赖） |
| `src/cli/status-renderer.ts` | 新增 | 业务级渲染函数（banner、stepHeader、toolLine、costBar 等） |
| `src/agent/agent-loop.ts` | 修改 | AgentLoopDeps 新增 6 个可选回调 + 在循环中触发 |
| `src/agent/committee.ts` | 修改 | 每个成员的 onStreamText 添加颜色前缀 |
| `src/cli/main.ts` | 修改 | 接入 status-renderer，新增 --verbose/--quiet 选项 |
| `src/adapters/fallback-executor.ts` | 修改 | 暴露 onRetry 到外部回调（可选） |

### Phase 2

| 文件 | 类型 | 说明 |
|------|------|------|
| `package.json` | 修改 | 新增 ink、react、@types/react 依赖 |
| `src/cli/dashboard/app.tsx` | 新增 | 主 Dashboard 组件 |
| `src/cli/dashboard/components/status-bar.tsx` | 新增 | Agent 状态栏 |
| `src/cli/dashboard/components/cost-gauge.tsx` | 新增 | 成本进度条 |
| `src/cli/dashboard/components/output-panel.tsx` | 新增 | 滚动输出区 |
| `src/cli/dashboard/components/approval-bar.tsx` | 新增 | 审批交互栏 |
| `src/cli/dashboard/components/agent-tree.tsx` | 新增 | Agent 层级树 |
| `src/cli/dashboard/event-bridge.ts` | 新增 | 回调 → EventEmitter 桥接 |
| `src/cli/dashboard/types.ts` | 新增 | Dashboard 专用类型 |
| `src/cli/main.ts` | 修改 | 新增 --dashboard 标志 + ink 渲染入口 |

---

## 七、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| ink 的 React 运行时开销 | 内存增加 ~50MB | 仅在 --dashboard 模式加载；Phase 1 零开销 |
| Windows 旧终端不支持 Unicode | 符号显示为方块 | ansi.ts 提供 fallback：`✓` → `[ok]`，`▸` → `>` |
| AgentLoop 新增回调增加代码量 | 维护负担 | 回调全部可选，不影响现有逻辑；6 个回调约 30 行代码 |
| Committee 颜色前缀破坏现有输出解析 | 自动化脚本受影响 | 仅在交互式终端启用（检测 `process.stdout.isTTY`） |
| ink JSX 需要 TypeScript 配置调整 | 构建复杂度 | tsconfig 中新增 `jsx: "react-jsx"`；或用 `React.createElement` 避免 JSX |
