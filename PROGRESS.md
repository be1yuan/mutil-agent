o# Multi-Agent Orchestrator - 开发进度

> 基于 DESIGN-v6 轻量自编排架构

---

## 总体进度

| 阶段 | 状态 | 完成度 | 设计文档 |
|------|------|--------|----------|
| MVP (v0.1) | ✅ 已完成 | 100% | DESIGN-v6 |
| v0.2 | ✅ 已完成 | 100% | DESIGN-v6 |
| v0.3 | ✅ 已完成 | 100% | DESIGN-v6 |
| v0.4 | ✅ 已完成 | 100% | DESIGN-v7 Phase 1 |
| v0.5 | ✅ 已完成 | 100% | DESIGN-v7 Phase 2 |
| v0.6 | 📋 待规划 | 0% | 生产加固 |
| v1.0 | 📋 待规划 | 0% | DESIGN-v6 + v7 |

---

## MVP (v0.1) 详细进度

### ✅ 已完成的核心功能

#### 1. Agent 主循环 + 自编排
- **文件**: `src/agent/agent-loop.ts`
- **状态**: ✅ 已完成
- **说明**: Agent 内嵌复杂度判断，通过 `task` 原语拆分子 Agent

#### 2. 模型适配器
- **文件**: `src/adapters/anthropic-client.ts`, `src/adapters/fallback-executor.ts`
- **状态**: ✅ 已完成
- **支持模型**:
  - DeepSeek V4-Pro (Anthropic 兼容端点, api.deepseek.com/anthropic)
  - GLM-5.1 / GLM-4.7 (智谱 Anthropic 兼容端点, open.bigmodel.cn/api/anthropic)
  - MiMo-V2.5-Pro (小米 Anthropic 兼容端点, api.xiaomimimo.com/anthropic, Bearer 认证)
- **架构**: BaseAnthropicAdapter 基类 + DeepSeekAdapter / GLMAdapter / MiMoAdapter 子类
- **功能**:
  - 统一 Anthropic SDK 封装
  - 故障转移（3次重试 + 指数退避 + 跨模型切换）
  - chatStream() 流式接口已预实现（主循环未接入）

#### 3. Agent 定义系统
- **文件**: `.agents/*.md`, `src/config/loader.ts`
- **状态**: ✅ 已完成
- **格式**: Markdown Frontmatter
- **内置 Agent**:
  - `main` - 通用编排，可派生子 Agent
  - `explore` - 只读代码库分析
  - `coder` - 代码编写
  - `reviewer` - 代码审查
  - `architect` - 架构顾问（只读分析，不写代码）

#### 4. 权限系统
- **文件**: `src/security/permission-resolver.ts`
- **状态**: ✅ 已完成
- **特性**:
  - 三级权限: allow / ask / deny
  - Bash glob 模式匹配（minimatch）
  - 全局安全基线（Agent 配置只能更严格）
  - deny > ask > allow 优先级

#### 5. 工具执行逻辑
- **文件**: `src/agent/tool-executor.ts`, `src/security/safe-exec.ts`, `src/agent/web-tools.ts`
- **状态**: ✅ 已完成
- **已实现工具**:
  | 工具 | 状态 | 说明 |
  |------|------|------|
  | Read | ✅ | 读取文件内容（100KB 截断）|
  | Write | ✅ | 写入文件 |
  | Edit | ✅ | 替换文件内容（唯一匹配检查）|
  | Bash | ✅ | 安全执行命令（spawn 数组 + 50KB 输出截断）|
  | Grep | ✅ | 正则搜索文件内容（minimatch 文件过滤）|
  | Glob | ✅ | 文件模式匹配（async 生成器 + 精确 skip）|
  | WebSearch | ✅ | DuckDuckGo HTML 搜索（redirect URL 解析 + 缓存 + 限速）|
  | WebFetch | ✅ | URL 抓取（DNS rebinding 防护 + 缓存 + cheerio/regex 双模式）|
  | MailboxSend | ✅ | 发送邮箱消息（跨进程通信，支持广播 to="*"）|
  | MailboxReceive | ✅ | 接收邮箱消息（支持 waitFor 阻塞等待）|

- **Web 工具细节**:
  - DDG 正则解析：直接匹配 `.result__a` + `.result__snippet`，不依赖外层 div 嵌套
  - DDG redirect URL：`resolveDdgUrl()` 解析 `/l/?...&uddg=<encoded>` 提取真实 URL
  - 搜索缓存 + 抓取缓存：独立 Map，5 分钟 TTL，200 条上限，LRU 淘汰
  - 请求限速：`enqueueSearch` 串行队列，首个请求立即执行，后续间隔 1.2s
  - DNS rebinding 防护：`validateUrl()` 先解析 DNS 检查 IP 是否为私网地址
  - 内容提取：cheerio 优先（可选依赖），regex fallback

#### 6. 成本控制
- **文件**: `src/observability/cost-tracker.ts`
- **状态**: ✅ 已完成
- **机制**:
  - 预算上限 ($) + 步数上限 (steps) 双保险
  - 父子 Agent 共享 CostTracker（预算真正联通）
  - 80% 预算预警
  - 支持 cacheReadTokens 计费
  - **PRICING 表**: deepseek (¥2.87/¥5.74) / zhipu (¥7.0/¥22.4) / mimo (¥7.0/¥21.0, cacheHit ¥1.4)

#### 7. 并发控制
- **文件**: `src/agent/concurrency-limiter.ts`
- **状态**: ✅ 已完成
- **实现**: Semaphore 信号量限制 maxConcurrentAgents

#### 8. 配置系统
- **文件**: `src/config/loader.ts`, `src/config/validator.ts`
- **状态**: ✅ 已完成
- **特性**:
  - YAML 主配置
  - Markdown Agent 定义（frontmatter 解析）
  - Zod schema 校验
  - `.env` 文件支持
  - 环境变量替换

#### 9. CLI 接口
- **文件**: `src/cli/main.ts`
- **状态**: ✅ 已完成
- **命令**:
  - `run <task>` - 执行任务
  - `list-agents` - 列出 Agent
  - `validate` - 验证配置
  - `committee <task>` - Committee 模式（多 Agent 并行）

#### 10. 可观测性
- **文件**: `src/observability/logger.ts`
- **状态**: ✅ 已完成
- **特性**: 结构化 JSON 日志

---

## 代码质量改进（P0-P2 修复记录）

### 2026-04-28 P0 修复

| 修改 | 文件 | 内容 |
|------|------|------|
| DDG 正则重写 | web-tools.ts | 不匹配整个 `<div class="result">` 块，改为直接匹配 `.result__a` 链接 + 配对最近的 `.result__snippet` |
| DDG redirect URL | web-tools.ts | 新增 `resolveDdgUrl()` 函数，解析 `/l/?...&uddg=<encoded>` 格式提取真实 URL |
| redirect 测试误报 | web-tools.test.ts | 增加 `not.toContain("/l/?kh=")` 和 `not.toContain("uddg=")` 反向断言 |

### 2026-04-28 P1 修复

| 修改 | 文件 | 内容 |
|------|------|------|
| enqueueSearch 优化 | web-tools.ts | 用 `IDLE` 哨兵 Promise 检测队列空闲，首个请求不等待 1.2s |
| executeBash 截断 | tool-executor.ts | 新增 MAX_OUTPUT_SIZE=50KB，超限截断 |
| webFetch 缓存 | web-tools.ts | 新增独立 `fetchCache`，复用参数化 `getCached/setCached` |
| mock fetch AbortSignal | web-tools.test.ts | mock 函数接收 `options?: RequestInit`，监听 abort 事件 |

### 2026-04-28 P2 修复

| 修改 | 文件 | 内容 |
|------|------|------|
| collectFiles 重写 | tool-executor.ts | 改用 `async function* walkDir()` 生成器，遇 SKIP_DIRS 立即剪枝 |
| skip 逻辑修复 | tool-executor.ts | 改为 `SKIP_DIRS.includes(e.name)` 精确匹配，避免 `my.git.config` 误判 |

### 过程中额外修复的 Bug

| Bug | 修复 |
|-----|------|
| `const IDLE` 定义在 `let searchQueue = IDLE` 之后，TDZ 导致 ReferenceError | 调整声明顺序 |
| `searchQueue !== Promise.resolve()` 永远为 true | 改用共享 `IDLE` 哨兵对象 |
| `clearSearchCache()` 不重置 searchQueue | 改为同时重置 `searchQueue = IDLE` |
| mock fetch 不尊重 AbortSignal 导致 timeout 测试假死 | mock 监听 `options.signal` 的 abort 事件 |

---

## 2026-04-29 新增：MiMo Provider + Architect Agent

### 新增 Provider: mimo

| 属性 | 值 |
|------|-----|
| 模型 | MiMo-V2.5-Pro |
| 端点 | `https://api.xiaomimimo.com/anthropic` |
| 认证 | `api-key` header（Anthropic SDK 默认 `x-api-key` 被 MiMo 拒绝）|
| 上下文 | 1,000,000 tokens |
| 定价 | input ¥7.0 / output ¥21.0 / cacheHit ¥1.4 per 1M tokens |
| 能力 | toolCalling, streaming, jsonMode, thinking |

**适配器实现**: `MiMoAdapter` 通过自定义 `fetch` 参数覆盖认证头，移除 `x-api-key` 并注入 `api-key`。

### 新增 Agent: architect

| 属性 | 值 |
|------|-----|
| 类型 | architect |
| 模型 | MiMo-V2.5-Pro (mimo provider) |
| 定位 | 只读架构顾问 |
| 权限 | Read/Grep/Glob/WebSearch/WebFetch allow；Write/Edit/Bash deny；task deny |
| maxSteps | 20 |
| maxTokensPerStep | 8192 |

**职责**: 设计审查、风险分析、任务拆解策略。不写代码，专注分析和判断。

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/types/core.ts` | `ModelProvider` 联合类型加 `"mimo"` |
| `src/config/validator.ts` | Zod schema `z.enum` 加 `"mimo"`（providers + fallbackModel） |
| `src/adapters/anthropic-client.ts` | 新增 `MiMoAdapter` 类（自定义 fetch 控制认证头） |
| `src/cli/main.ts` | 导入 `MiMoAdapter` + 注册 mimo provider；committee 参数解析兼容空格分隔 |
| `src/observability/cost-tracker.ts` | PRICING 表加 `mimo` 定价 |
| `orchestrator.yaml` | 新增 mimo provider 配置（`apiKey: ${MIMO_API_KEY}`） |
| `.agents/architect.md` | 新增 architect agent 定义 |

### 审查修复（2026-04-29）

| 等级 | 问题 | 文件 | 修复 |
|------|------|------|------|
| **P0** | cost-tracker.ts PRICING 表缺少 `mimo`，运行时崩溃 | `cost-tracker.ts:5-8` | 添加 `mimo: { input: 7.0, output: 21.0, cacheHit: 1.4 }` |
| **P1** | MiMoAdapter `undefined as unknown as string` 类型逃逸，认证头不可靠 | `anthropic-client.ts:366-374` | 使用自定义 `fetch` 精确控制 header，移除 `x-api-key` |
| **P2** | committee 验证循环重复 trim | `main.ts:141,148` | 去掉冗余 `.trim()` |

---

## 验证测试结果

### 2026-04-28 端到端测试

```powershell
pnpm dev run "分析代码库" --agent explore
```

**结果**: ✅ 成功

- 16 步完成代码库分析
- 成本: ¥0.19
- 工具调用: Glob(4次) + Read(11次)
- Bash 被正确拒绝（explore 无 Bash 权限）

### 2026-04-29 单元测试

- 类型检查：`tsc --noEmit` 通过
- 测试：78/78 全部通过（45 原有 + 17 邮箱 + 16 Dashboard EventBridge）
- 覆盖：
  - web-tools（搜索、抓取、缓存、超时、redirect）— 35 测试
  - committee（聚合策略：concat/majority/best、边界条件）— 6 测试
  - worktree-manager（resolveIsolation 逻辑）— 4 测试
  - mailbox（发送/接收/广播/已读/回复/waitFor/stats/cleanup/原子写入/广播已读/广播等待）— 17 测试
  - dashboard-event-bridge（事件桥接、回调转发、审批流、budget 节流）— 16 测试

---

## v0.2 开发进度 — ✅ 已完成

### ✅ 已完成

| 特性 | 文件 | 说明 |
|------|------|------|
| 流式响应 | adapters/types.ts, anthropic-client.ts, agent-loop.ts, cli/main.ts | chatStream 内嵌到 chat()，AgentLoop 通过 onStreamText 回调实时输出，CLI 打印到 stdout |
| Git worktree 隔离 | agent/worktree-manager.ts, agent-loop.ts | 子 Agent isolation=worktree 时在独立 worktree 中工作，完成后自动清理 |
| Committee 模式 | agent/committee.ts, cli/main.ts | 多 Agent 并行执行 + 三种聚合策略 (concat/majority/best)，CLI committee 命令 |
| chatStream 增强 | anthropic-client.ts | 修复 tool_use 流式事件缺失，支持 content_block_start/delta/stop 完整流式处理 |
| MiMo Provider | adapters/anthropic-client.ts | 新增 MiMoAdapter，自定义 fetch 控制认证头 |
| Architect Agent | .agents/architect.md | 只读架构顾问，MiMo-V2.5-Pro 驱动 |

### 已从 v0.2 提前完成

| 特性 | 说明 |
|------|------|
| ✅ WebSearch 完整实现 | DuckDuckGo HTML 搜索 + redirect 解析 + 缓存 + 限速 |
| ✅ WebFetch 完整实现 | DNS rebinding 防护 + 缓存 + cheerio/regex 双模式 |
| ✅ chatStream 代码 | BaseAnthropicAdapter 中已实现流式接口 |

---

## v0.3 — 文件邮箱 + HTTP API（DESIGN-v6）✅ 已完成

### ✅ 文件邮箱（跨进程持久化）

| 特性 | 文件 | 状态 | 说明 |
|------|------|------|------|
| Mailbox 核心类 | `src/agent/mailbox.ts` | ✅ 已完成 | send/receive/waitFor/reply/markRead/cleanup/stats + 原子写入 |
| 邮箱工具定义 | `src/agent/tools.ts` | ✅ 已完成 | MailboxSend + MailboxReceive 工具 schema |
| 工具执行集成 | `src/agent/tool-executor.ts` | ✅ 已完成 | ToolContext 注入 mailbox + currentAgentType |
| AgentLoop 集成 | `src/agent/agent-loop.ts` | ✅ 已完成 | AgentLoopDeps 新增 mailbox 字段，传递到 executeTool |
| main Agent 配置 | `.agents/main.md` | ✅ 已完成 | 新增 MailboxSend:allow + MailboxReceive:allow |
| 邮箱测试 | `src/agent/mailbox.test.ts` | ✅ 已完成 | 17 个测试用例全通过 |
| 配置扩展 | `src/config/types.ts` + `validator.ts` | ✅ 已完成 | MailboxConfig + ApiConfig Zod schema |
| 配置文件 | `orchestrator.yaml` | ✅ 已完成 | mailbox + api 配置段 |

**文件邮箱存储布局**:
```
.mailbox/
├── {agentType}/inbox/          # 未读消息
├── {agentType}/inbox/.read/    # 已读消息（agent 专属）
├── {agentType}/.bc_read/       # 广播消息已读标记（per-agent）
├── _broadcast/inbox/           # 广播消息（to="*"，共享）
└── _dead_letter/               # 无效投递
```

**消息格式**: `{id, from, to, subject, body, timestamp, priority, replyTo?, correlationId?}`

**关键设计决策**:
- 原子写入: `writeFile(temp) → rename(temp, target)`，无需文件锁
- Windows 兼容: 广播目标 `to="*"` 映射到 `_broadcast` 目录（`*` 在 Windows 不是合法目录名）
- waitFor 语义: 只返回新消息（预填 seenIds 排除已有消息）；需要已有消息时先调用 receive()
- 广播已读: 使用 per-agent `.bc_read/` 标记，不移动共享的广播原文件
- mailbox opt-in: 默认不启用，需在配置中设置 `mailbox.enabled: true`
- API 安全: 1MB body 限制 + 60 req/min IP 速率限制 + 可选 Bearer 认证
- Per-task 预算: 每个任务独立 CostTracker，避免全局预算竞争

### ✅ HTTP API（独立部署模式）

| 特性 | 文件 | 状态 | 说明 |
|------|------|------|------|
| SSE 工具 | `src/api/sse.ts` | ✅ 已完成 | initSSE/sendSSE/closeSSE/SSEClientSet + 30s 心跳 |
| 任务管理器 | `src/api/task-manager.ts` | ✅ 已完成 | TaskRecord 生命周期（queued→running→completed/failed）+ SSE 事件广播 |
| HTTP 服务器 | `src/api/server.ts` | ✅ 已完成 | 零依赖 node:http + 6 个端点 + Bearer 认证 + CORS |
| CLI serve 命令 | `src/cli/main.ts` | ✅ 已完成 | `multi-agent serve [--host] [--port]` |
| Orchestrator 集成 | `src/cli/main.ts` | ✅ 已完成 | init() 初始化 mailbox；serve() 启动 API 服务器 |
| API 集成测试 | — | 📋 待编写 | 需要集成测试验证端到端流程 |

**API 端点**:
| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/tasks` | 提交新任务 |
| `GET` | `/api/tasks/:id` | 查询任务状态/结果 |
| `GET` | `/api/tasks/:id/stream` | SSE 实时流 |
| `GET` | `/api/agents` | 列出可用 Agent |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/cost` | 成本追踪 |

**SSE 事件**: `step` / `tool` / `delta` / `cost` / `result` / `done`

**认证**: 可选 Bearer token 认证，在 `orchestrator.yaml` 中配置 `api.authToken`

**安全防护**:
- 请求体大小限制：1MB（超限返回 413）
- IP 级速率限制：60 次/分钟（超限返回 429）
- 可选 Bearer token 认证

**Per-task 预算**: 每个任务创建独立 CostTracker，避免全局预算竞争

**技术选型**: 零新依赖，纯 Node.js `node:http` 模块

## v0.4 — 终端可视化 Phase 1（DESIGN-v7）✅ 已完成

基于 DESIGN-v7 的终端可视化方案，替代原 v1.0 的 Web 监控面板。

| 特性 | 文件 | 状态 | 说明 |
|------|------|------|------|
| ANSI 颜色工具 | `src/cli/ansi.ts` | ✅ 已完成 | 零依赖，前景色 + 组合样式 + Unicode 符号 |
| 状态渲染器 | `src/cli/status-renderer.ts` | ✅ 已完成 | banner、stepHeader、toolLine、costBar、resultBlock、committeeTree |
| AgentLoop 生命周期回调 | `src/agent/agent-loop.ts` | ✅ 已完成 | 6 个可选回调：onStepStart / onToolStart / onToolComplete / onSubAgentSpawn / onSubAgentComplete / onBudgetUpdate |
| Committee 颜色前缀 | `src/agent/committee.ts` | ✅ 已完成 | MEMBER_COLORS 循环分配 + getStreamPrefix 回调 |
| CLI 选项扩展 | `src/cli/main.ts` | ✅ 已完成 | --verbose / --quiet 选项，quiet 模式抑制实时输出 |
| 流式重试标记 | `src/agent/agent-loop.ts` | ✅ 已完成 | onRetry 回调输出 `[retry attempt N]` 提示 |

**设计原则**（DESIGN-v7）：
- 零新依赖（Phase 1）：纯 ANSI 转义码 + Unicode 字符
- 不改变现有行为：logger 仍输出到文件，新增面向用户的美化输出
- 向后兼容：`--quiet` 模式恢复原始行为
- Committee 可区分：多 Agent 并行时每个 Agent 输出带颜色标识

## v0.5 计划 — 交互式 TUI 仪表盘 Phase 2（DESIGN-v7）

| 特性 | 文件 | 状态 | 说明 |
|------|------|------|------|
| ink 框架集成 | `package.json`, `tsconfig.json` | ✅ 已完成 | ink 5.2.1 + React 18.3.1 + jsx: react-jsx |
| Dashboard 专用类型 | `src/cli/dashboard/types.ts` | ✅ 已完成 | DashboardEvent / AgentInfo / OutputLine / ApprovalRequest |
| 事件桥接 | `src/cli/dashboard/event-bridge.ts` | ✅ 已完成 | AgentLoopDeps 回调 → EventEmitter → React 状态 |
| Agent 状态树 | `src/cli/dashboard/components/agent-tree.tsx` | ✅ 已完成 | 层级显示 + 运行状态标识 |
| 状态栏 | `src/cli/dashboard/components/status-bar.tsx` | ✅ 已完成 | Agent 状态 + 模型 + 步数 |
| 成本进度条 | `src/cli/dashboard/components/cost-gauge.tsx` | ✅ 已完成 | 预算消耗进度 + 颜色分级 |
| 滚动输出区 | `src/cli/dashboard/components/output-panel.tsx` | ✅ 已完成 | 500 行缓冲 + 类型着色 |
| 审批交互栏 | `src/cli/dashboard/components/approval-bar.tsx` | ✅ 已完成 | 条件渲染 + 工具详情 + 键盘提示 |
| 主 Dashboard 组件 | `src/cli/dashboard/app.tsx` | ✅ 已完成 | 四区域布局 + 事件驱动 + stream 缓冲 + approval useInput + done 自动退出 |
| CLI --dashboard 标志 | `src/cli/main.ts` | ✅ 已完成 | `run` 支持 -d/--dashboard；committee 提示不支持 |
| Dashboard EventBridge 测试 | `src/cli/dashboard/event-bridge.test.ts` | ✅ 已完成 | 16 个测试用例全通过（含审批流 + budget 节流） |

## 2026-04-30: 原生 Web Search + 认证修复

### 原生搜索（Provider-Native Web Search）

| 属性 | 说明 |
|------|------|
| 功能 | DeepSeek/MiMo API 内置 `web_search` 工具，服务端执行搜索，无需自定义 DuckDuckGo 抓取 |
| 配置 | `orchestrator.yaml` 中 provider 级别 `nativeSearch: true` |
| 工具格式 | `{ type: "web_search_20250305", name: "web_search", max_uses: 5 }` |
| 降级策略 | 自定义 `WebSearch` 工具（DuckDuckGo）始终可用作为 fallback |
| 搜索结果 | `normalizeResponse` 解析 `web_search_tool_result` 内容块，提取标题+URL |

**改动文件**:

| 文件 | 改动 |
|------|------|
| `src/config/types.ts` | `ProviderConfig` 新增 `nativeSearch?: boolean` |
| `src/config/validator.ts` | Zod schema 新增 `nativeSearch: z.boolean().optional()` |
| `src/adapters/anthropic-client.ts` | `BaseAnthropicAdapter` 新增 `nativeSearch` 字段；`buildRequestParams` 注入原生搜索工具；`normalizeResponse` 解析搜索结果块 |
| `src/cli/main.ts` | 创建 adapter 时传递 `providerConfig.nativeSearch` |
| `orchestrator.yaml` | deepseek/mimo 启用 `nativeSearch: true` |

### 认证修复（ANTHROPIC_AUTH_TOKEN 冲突）

**问题**: 系统环境变量 `ANTHROPIC_AUTH_TOKEN` 被设置为 MiMo key。Anthropic SDK 自动读取它并作为 `authorization: Bearer` 头发送。DeepSeek API 优先使用 Bearer 认证而非 `x-api-key`，导致 401。

**修复**: `createAnthropicClient()` 中 `delete process.env.ANTHROPIC_AUTH_TOKEN`，阻止 SDK 注入无关的 Bearer token。

**改动文件**: `src/adapters/anthropic-client.ts` (createAnthropicClient 函数)

## v1.0 计划 (+3-4周)

- [ ] ~~MiniMax 适配~~（已替换为 MiMo 适配，已提前完成）
- [ ] ~~Web 监控面板~~（已替换为 DESIGN-v7 终端可视化方案）
- [ ] Prometheus 指标 (metrics.ts)
- [ ] 生产就绪测试套件

---

## 架构符合度

### 与 DESIGN-v6 的对比

| 维度 | v6 设计 | 当前实现 | 符合度 |
|------|---------|----------|--------|
| 编排模型 | Agent 自编排 | ✅ 已实现 | 100% |
| task 原语 | 子 Agent 派生 | ✅ 已实现 | 100% |
| 权限系统 | allow/ask/deny + glob | ✅ 已实现 | 100% |
| 成本控制 | 预算 + steps 双保险 | ✅ 已实现 | 100% |
| 并发控制 | 信号量 | ✅ 已实现 | 100% |
| 故障转移 | 重试 + 跨模型切换 | ✅ 已实现 | 100% |
| 流式响应 | v0.2 实现 | ✅ 已实现 | 100% |
| Git worktree | v0.2 实现 | ✅ 已实现 | 100% |
| Web 工具 | v0.2 实现 | ✅ 已实现 | 100% |
| Committee 模式 | v0.2 实现 | ✅ 已实现 | 100% |
| MiMo 适配 | v1.0 计划 | ✅ 已提前完成 | 100% |
| 文件邮箱 | v0.3 计划 | ✅ 已完成 | 100% |
| HTTP API | v0.3 计划 | ✅ 已完成（代码），📋 测试待补 | 90% |

### 与 DESIGN-v7 的对比

DESIGN-v7 提出用终端可视化替代 Web 监控面板，分两个阶段实现。

| 维度 | v7 设计 | 当前实现 | 符合度 |
|------|---------|----------|--------|
| **Phase 1: 增强终端输出** |
| ANSI 颜色系统 | `src/cli/ansi.ts`：fg + style + symbols | ✅ 已实现 | 100% |
| 状态渲染器 | `src/cli/status-renderer.ts`：banner / step / tool / cost / result / committee | ✅ 已实现 | 100% |
| AgentLoop 生命周期回调 | 6 个可选回调注入 AgentLoopDeps | ✅ 已实现 | 100% |
| Committee 颜色前缀 | MEMBER_COLORS + getStreamPrefix | ✅ 已实现 | 100% |
| CLI --verbose/--quiet | main.ts 选项 + 条件渲染 | ✅ 已实现 | 100% |
| **Phase 2: TUI 仪表盘** |
| ink 框架集成 | `package.json` 新增 ink + react | ✅ 已实现 | 100% |
| Dashboard 四区域布局 | 状态栏 / 输出区 / 成本条 / 审批区 | ✅ 已实现 | 100% |
| 事件桥接 | AgentLoopDeps → EventEmitter → React | ✅ 已实现 | 100% |
| --dashboard CLI 标志 | 可选启用全屏 TUI | ✅ 已实现 | 100% |

---

## 已知限制

1. **token 计费固有特性**: 单次模型调用输出 token 无法预先精确知道。已通过 **前置最坏情况预算检查**（`estimateWorstCase` + `canAfford`）+ 80% 预警 + steps 上限 **三重缓解**。

2. **Metrics 未实现**: 设计文档中的 Prometheus 指标 (metrics.ts) 尚未创建，推到 v1.0。

3. **Committee 模式无并行工具执行**: Committee 内每个 Agent 仍是串行工具执行，v0.3 可考虑工具级并行。

4. **cheerio 为可选依赖**: 未安装时 WebFetch 自动降级到 regex 模式。validate 命令会提示安装，运行时首次降级会记日志。

5. **TUI 仪表盘已实现**: DESIGN-v7 Phase 2 的 ink 全屏仪表盘已开发完成，通过 `--dashboard` 标志启用。

### 已解决的限制

| 原限制 | 解决方案 | 版本 |
|--------|---------|------|
| 流式重试输出重复 | `onRetry` 回调 + `[retry attempt N]` 标记 | v0.2+ |
| 单次调用可能超预算 | `estimateWorstCase()` 前置检查 + `maxTokensPerStep` 字段 | v0.2+ |
| Worktree 残留 | process exit 钩子自动清理 + 启动时 `git worktree prune` | v0.2+ |
| cheerio 静默降级 | `isCheerioAvailable()` 检测 + 日志提示 + validate 命令展示 | v0.2+ |
| PowerShell 逗号参数展开 | committee `--agents` 参数解析兼容空格分隔 | v0.2+ |
| 终端输出无结构化状态 | DESIGN-v7 Phase 1：ANSI 颜色 + 生命周期回调 + 状态渲染器 | v0.4 |
| Windows `*` 不是合法目录名 | 广播目标 `to="*"` 映射到 `_broadcast` 目录 | v0.3 |
| waitFor 有消息时仍超时 | 改为只预填 seenIds 不返回已有消息；waitFor 专门等待新消息 | v0.3 |
| receive 不搜索广播目录 | receive/waitFor/stats 同时读取 agent inbox 和 _broadcast inbox | v0.3+ |
| 广播消息 markRead 影响其他 Agent | 广播消息使用 per-agent `.bc_read/` 标记而非移动原文件 | v0.3+ |
| API 无请求体大小限制 | 添加 1MB MAX_BODY_SIZE + 413 响应 | v0.3+ |
| API 无速率限制 | 添加 IP 级 RateLimiter（60 req/min）+ 429 响应 | v0.3+ |
| API 全局 CostTracker 竞争 | 每个任务创建独立 CostTracker（per-task budget） | v0.3+ |
| mailbox 默认启用（可能创建不需要的目录） | 改为 opt-in：`mailbox.enabled === true` 才初始化 | v0.3+ |
| 终端输出无交互式全屏状态 | DESIGN-v7 Phase 2：ink TUI 仪表盘 + 事件桥接 + 四区域布局 | v0.5 |
| Dashboard 审批交互为死代码 | bridge Promise + useInput 键盘处理 + resolveApproval | v0.5 |
| stream 逐 chunk 新行碎片化 | 追加到最后 stream 行 + 遇换行切行 | v0.5 |
| committee --dashboard 静默忽略 | 添加警告提示 committee 暂不支持 dashboard | v0.5 |
| 固定宽度边框错位 | ink Box borderStyle="single" 自动适应 | v0.5 |
| setTimeout(unmount) 退出脆弱 | App useEffect + exit() 自行退出 | v0.5 |
| budget 事件无节流 | 200ms 节流 + done 时 flush 最终值 | v0.5 |
| summarizeArgs/toolSymbol 重复 | 统一复用 ansi.ts 版本 | v0.5 |

---

## 下一步行动

### 近期（v0.5 收尾 + v0.6 规划）
1. **Dashboard 实际运行验证**: 用真实 Agent 任务测试 TUI 仪表盘
2. **API 集成测试**: 验证 HTTP API 端到端流程
3. **邮箱跨进程测试**: 多进程场景下邮箱通信验证

### 远期（v0.6 — 生产加固）
5. **Dashboard 性能调优**: ink 渲染频率优化，减少不必要的 re-render
6. **Committee Dashboard 支持**: 多 Agent 并行时 Dashboard 的颜色区分
7. **Prometheus 指标**: metrics.ts 实现
8. **生产就绪测试套件**: 端到端测试覆盖

---

## 设计文档索引

| 文档 | 说明 | 对应版本 |
|------|------|----------|
| `DESIGN-v6.md` | 轻量自编排架构总纲：Agent 自编排、task 原语、权限系统、成本控制、并发控制、故障转移 | MVP ~ v0.3 |
| `DESIGN-v7.md` | 终端可视化方案：替代 Web 监控面板，Phase 1（增强终端输出）+ Phase 2（ink TUI 仪表盘） | v0.4 ~ v0.5 ✅ |

**v6 与 v7 的关系**：v7 不是架构重构，而是 v6 的**可视化增强层**。v7 的所有改动都集中在 `src/cli/` 和 `src/agent/agent-loop.ts` 的回调注入，不影响 v6 的核心架构（适配器、权限、成本、并发等）。

---

## 环境配置要求

### 必需环境变量（.env）

```bash
# DeepSeek
DEEPSEEK_API_KEY=your_deepseek_key

# Zhipu (GLM)
ZHIPU_API_KEY=your_zhipu_key

# MiMo (Xiaomi)
MIMO_API_KEY=your_mimo_key
```

### 可选依赖

```bash
# 更好的 WebFetch HTML 提取
npm install cheerio
```

### 预算配置

预算单位为人民币（元），在 `orchestrator.yaml` 中配置：

```yaml
budget:
  maxYuan: 35.0
```

CLI 中通过 `--budget` 覆盖：

```bash
pnpm run dev run "任务" --budget 20.0
```

### 验证配置

```bash
pnpm run dev validate
```
