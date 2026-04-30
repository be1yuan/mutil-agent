# DESIGN-v9: v0.6 生产加固

> 状态: 设计完成，实施中
> 前置: v0.1~v0.5 全部完成（78/78 测试通过）

---

## 目标

将项目从"开发可用"提升到"生产可用"，覆盖三个维度：

1. **构建与分发** — esbuild 打包 + npm 元数据，支持 `npm install -g agent-orch`
2. **测试覆盖** — 集成测试补齐关键路径（API、AgentLoop、邮箱跨进程）
3. **健壮性** — 错误恢复策略 + 可观测性增强 + validate 命令完善

---

## 1. esbuild 构建（DESIGN-v8 Phase 1）

### 1.1 构建配置

文件: `esbuild.config.mjs`

```javascript
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  splitting: true,
  minify: false,
  sourcemap: true,
  external: [
    "ink", "react", "react-dom",
    "cheerio",
  ],
  banner: { js: "#!/usr/bin/env node" },
});
```

### 1.2 package.json 目标状态

| 字段 | 现状 | 目标 |
|------|------|------|
| `name` | `multi-agent-orchestrator` | `agent-orch` |
| `version` | `0.1.0` | `0.6.0` |
| `bin` | `multi-agent` → `dist/cli/main.js` | `agent-orch` → `dist/cli/main.js` |
| `files` | 无 | `["dist", "templates", "README.md", "LICENSE"]` |
| `dependencies` | 含 cheerio/ink/react | 移除三者 |
| `optionalDependencies` | 无 | `{ "cheerio": "^1.2.0" }` |
| `peerDependencies` | 无 | `{ "ink": "^5.0.0", "react": "^18.3.0" }` |
| `peerDependenciesMeta` | 无 | `{ "ink": { "optional": true }, "react": { "optional": true } }` |
| `license` | 无 | `"MIT"` |
| `scripts.build` | `tsc` | `node esbuild.config.mjs` |
| `scripts.build:types` | 无 | `tsc --emitDeclarationOnly` |

### 1.3 惰性依赖检测

CLI 启动时检测可选依赖是否可用，不可用时给出友好提示：

```typescript
// src/cli/main.ts 顶部
async function checkOptionalDeps() {
  try { await import("ink"); } catch {
    console.warn("Tip: Install ink + react for dashboard support: npm install ink react");
  }
  try { await import("cheerio"); } catch {
    // WebFetch regex fallback 已内置，无需警告
  }
}
```

---

## 2. API 集成测试

### 2.1 测试文件

`src/api/server.test.ts`

### 2.2 测试用例

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | POST /api/tasks 提交任务 | 返回 201 + task id + status=queued |
| 2 | POST /api/tasks 缺少 task 字段 | 返回 400 |
| 3 | GET /api/tasks/:id 查询任务 | 返回 200 + 完整 task record |
| 4 | GET /api/tasks/:id 不存在的 ID | 返回 404 |
| 5 | GET /api/health | 返回 200 + { status: "ok" } |
| 6 | GET /api/agents | 返回 200 + agents 列表 |
| 7 | GET /api/cost | 返回 200 + cost info |
| 8 | 认证：无 token | 返回 401 |
| 9 | 认证：错误 token | 返回 401 |
| 10 | 认证：正确 token | 返回 200 |
| 11 | 速率限制 | 超过 60 次/分钟后返回 429 |
| 12 | 请求体超限 | 超过 1MB 返回 413 |
| 13 | SSE 流连接 | 连接后收到 status 事件 |
| 14 | 404 路由 | 返回 404 |

测试策略：用 Node.js 内置 `http` 模块发请求，mock AgentLoopDeps（模型调用跳过），真实启动 ApiServer。

---

## 3. AgentLoop 集成测试

### 3.1 测试文件

`src/agent/agent-loop.test.ts`

### 3.2 测试策略

mock ModelAdapter 的 chat 方法，返回预设的 tool_calls + content，验证完整的 AgentLoop 循环：

```
用户输入 → mock 模型返回 tool_calls → 执行真实工具 → mock 模型返回 content → 完成
```

### 3.3 测试用例

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | 简单回答（无 tool call） | 返回 status=success, steps=1 |
| 2 | 单次工具调用（Read） | 模型返回 Read tool_call → 执行 → 返回文件内容 |
| 3 | 多步工具调用 | 模型连续返回 2 次 tool_call → 第 3 次返回 content |
| 4 | 预算超限 | canAfford 返回 false → status=budget_exceeded |
| 5 | 步数上限 | 达到 maxSteps → status=max_steps_reached |
| 6 | 权限拒绝 | deny 权限 → 工具返回 [denied] |
| 7 | 审批流 | ask 权限 → onApprovalRequest 被调用 |
| 8 | 子 Agent 派生 | task tool_call → spawnSubAgent → 验证回调 |
| 9 | 模型调用失败 | mock 抛错 → status=error |
| 10 | 流式文本 | onStreamText 被调用，文本内容正确 |

---

## 4. 邮箱跨进程测试

### 4.1 测试文件

`src/agent/mailbox-cross-process.test.ts`

### 4.2 测试策略

用 `child_process.fork` 启动子进程，子进程通过 MailboxSend 发送消息，主进程通过 MailboxReceive 接收。

### 4.3 测试用例

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | 点对点消息 | 子进程发送 → 主进程 receive |
| 2 | 广播消息 | 子进程广播 → 主进程 receive (to="*") |
| 3 | waitFor 等待 | 主进程 waitFor → 子进程发送 → 收到 |
| 4 | 回复消息 | 子进程 reply → 主进程收到 replyTo 匹配的消息 |

---

## 5. 错误恢复策略增强

### 5.1 当前状态

- 模型调用：3 次重试 + 指数退避 + 跨模型切换 ✅
- 预算超限：graceful 返回 budget_exceeded ✅
- 工具执行异常：返回 `[tool error]` 字符串 ✅

### 5.2 新增策略

| 场景 | 当前行为 | 改进 |
|------|---------|------|
| 工具返回 `[tool error]` | 模型收到错误字符串，自行决定 | 不变（已足够） |
| 工具返回 `[denied]` | 模型收到拒绝字符串 | 不变 |
| 连续 3 次工具错误 | 无特殊处理 | 添加 `consecutiveErrors` 计数器，超过 3 次时在模型消息中追加提示 |
| Read 文件不存在 | 返回 `[error] Cannot read...` | 不变 |
| Write 磁盘满 | 抛出异常 → `[tool error]` | 不变 |
| 子 Agent 返回 error status | 返回 JSON 字符串给父 Agent | 不变 |
| 邮箱磁盘写入失败 | 抛出异常 | 捕获并返回 `[mailbox error]` |

**实现**：在 `AgentLoop.run()` 中跟踪连续工具错误，超过阈值时注入提示消息。

### 5.3 邮箱错误处理

`tool-executor.ts` 中 MailboxSend/MailboxReceive 的 try/catch 已覆盖，但需要确保错误消息格式一致。

---

## 6. validate 命令增强

### 6.1 当前行为

`agent-orch validate` 检查：
- orchestrator.yaml 存在 + Zod 校验
- .agents/ 目录存在
- API keys 环境变量

### 6.2 新增检查

| 检查项 | 说明 | 严重性 |
|--------|------|--------|
| ink + react 可用性 | dashboard 需要 | warning |
| cheerio 可用性 | WebFetch HTML 提取增强 | info |
| Node.js 版本 | >= 20 | error |
| .env 文件存在 | 避免运行时找不到 key | warning |
| git 可用性 | worktree 隔离需要 | warning |

### 6.3 输出格式

```
✅ orchestrator.yaml — valid
✅ 5 agent definitions loaded
✅ API keys: DEEPSEEK_API_KEY, ZHIPU_API_KEY, MIMO_API_KEY
⚠️  Optional: ink + react not installed (dashboard requires `npm install ink react`)
ℹ️  Optional: cheerio not installed (WebFetch will use regex fallback)
⚠️  Git not found in PATH (worktree isolation unavailable)
```

---

## 7. Prometheus 指标

### 7.1 文件

`src/observability/metrics.ts`

### 7.2 指标定义

| 指标 | 类型 | 标签 | 说明 |
|------|------|------|------|
| `agent_tasks_total` | Counter | agent_type, status | 任务总数 |
| `agent_steps_total` | Counter | agent_type | 执行步数 |
| `agent_tool_calls_total` | Counter | agent_type, tool_name, success | 工具调用次数 |
| `agent_tokens_total` | Counter | provider, type(input/output/cache) | Token 消耗 |
| `agent_cost_yuan_total` | Counter | provider | 累计花费（元） |
| `agent_duration_seconds` | Histogram | agent_type | 任务耗时 |
| `agent_active_tasks` | Gauge | agent_type | 当前运行中任务 |

### 7.3 暴露方式

- CLI 模式：写入 JSON 文件 `metrics.json`（用户可选 `--metrics` 标志）
- API 模式：新增 `GET /api/metrics` 端点，返回 Prometheus text format
- 不引入 prom-client 依赖，自行实现简单的文本格式化

---

## 实施计划

| Phase | 内容 | 预计耗时 |
|-------|------|---------|
| Phase 1 | esbuild 配置 + package.json + 依赖检测 | 0.5 天 |
| Phase 2 | API 集成测试 | 1 天 |
| Phase 3 | AgentLoop 集成测试 | 1 天 |
| Phase 4 | 邮箱跨进程测试 | 0.5 天 |
| Phase 5 | 错误恢复 + validate 增强 | 0.5 天 |
| Phase 6 | Prometheus metrics | 1 天 |
| 验证 | 类型检查 + 全量测试 + 端到端验证 | 0.5 天 |

**总计**: 约 5 天

---

## 与 v1.0 的关系

v0.6 完成后，v1.0 只需补充（DESIGN-v8）：
- `init` 命令（脚手架生成）
- Dockerfile + .dockerignore
- GitHub CI/CD workflows
- npm publish
