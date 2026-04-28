# Multi-Agent Orchestrator - 开发进度

> 基于 DESIGN-v6 轻量自编排架构

---

## 总体进度

| 阶段 | 状态 | 完成度 |
|------|------|--------|
| MVP (v0.1) | ✅ 已完成 | 100% |
| v0.2 | ✅ 已完成 | 100% |
| v0.3 | 📋 待规划 | 0% |
| v1.0 | 📋 待规划 | 0% |

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
  - GLM-5.1 (智谱 Anthropic 兼容端点, open.bigmodel.cn/api/anthropic)
- **架构**: BaseAnthropicAdapter 基类 + DeepSeekAdapter / GLMAdapter 子类（比 v6 设计的独立文件更精简）
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

## 验证测试结果

### 2026-04-28 端到端测试

```powershell
pnpm dev run "分析代码库" --agent explore
```

**结果**: ✅ 成功

- 16 步完成代码库分析
- 成本: $0.027
- 工具调用: Glob(4次) + Read(11次)
- Bash 被正确拒绝（explore 无 Bash 权限）

### 2026-04-28 单元测试

- 类型检查：`tsc --noEmit` 通过
- 测试：45/45 全部通过（2.94s）
- 覆盖：
  - web-tools（搜索、抓取、缓存、超时、redirect）— 35 测试
  - committee（聚合策略：concat/majority/best、边界条件）— 6 测试
  - worktree-manager（resolveIsolation 逻辑）— 4 测试

---

## v0.2 开发进度

### ✅ 已完成

| 特性 | 文件 | 说明 |
|------|------|------|
| 流式响应 | adapters/types.ts, anthropic-client.ts, agent-loop.ts, cli/main.ts | chatStream 内嵌到 chat()，AgentLoop 通过 onStreamText 回调实时输出，CLI 打印到 stdout |
| Git worktree 隔离 | agent/worktree-manager.ts, agent-loop.ts | 子 Agent isolation=worktree 时在独立 worktree 中工作，完成后自动清理 |
| Committee 模式 | agent/committee.ts, cli/main.ts | 多 Agent 并行执行 + 三种聚合策略 (concat/majority/best)，CLI committee 命令 |
| chatStream 增强 | anthropic-client.ts | 修复 tool_use 流式事件缺失，支持 content_block_start/delta/stop 完整流式处理 |

### 已从 v0.2 提前完成

| 特性 | 说明 |
|------|------|
| ✅ WebSearch 完整实现 | DuckDuckGo HTML 搜索 + redirect 解析 + 缓存 + 限速 |
| ✅ WebFetch 完整实现 | DNS rebinding 防护 + 缓存 + cheerio/regex 双模式 |
| ✅ chatStream 代码 | BaseAnthropicAdapter 中已实现流式接口 |

---

## v0.3 计划 (+2周)

- [ ] 文件邮箱（跨进程持久化）
- [ ] HTTP API（独立部署模式）

## v1.0 计划 (+3-4周)

- [ ] MiniMax 适配
- [ ] Web 监控面板
- [ ] Prometheus 指标 (metrics.ts)
- [ ] 生产就绪测试套件

---

## 架构符合度

与 DESIGN-v6 的对比:

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

---

## 已知限制

1. **token 计费固有特性**: 单次模型调用输出 token 无法预先精确知道，可能出现调用后超预算的情况。已通过 80% 预警 + steps 上限缓解。

2. **Metrics 未实现**: 设计文档中的 Prometheus 指标 (metrics.ts) 尚未创建，推到 v1.0。

3. **Committee 模式无并行工具执行**: Committee 内每个 Agent 仍是串行工具执行，v0.3 可考虑工具级并行。

4. **Worktree 清理依赖 git**: 如果进程异常退出，worktree 可能残留。需要手动 `git worktree prune`。

---

## 下一步行动

1. **v0.3: 文件邮箱**: 跨进程持久化的 Agent 间通信
2. **v0.3: HTTP API**: 独立部署模式
3. **v1.0: MiniMax 适配**: 新增 MiniMax M2.7 适配器
4. **v1.0: Web 监控面板**: 实时查看 Agent 状态和成本
