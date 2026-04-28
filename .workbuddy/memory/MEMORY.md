# 长期记忆

## 项目概况
- 项目路径: D:/MutilAgentWork
- 设计文档: DESIGN-v6.md（当前版本）
- 进度文档: PROGRESS.md
- v0.1 (MVP) 已完成，v0.2 已完成
- 技术栈: TypeScript + Node.js + Anthropic SDK + Vitest

## 架构决策
- 废弃独立 Orchestrator 层，Agent 自编排
- DeepSeek + GLM 均通过 Anthropic 兼容端点接入（统一 BaseAnthropicAdapter）
- Markdown frontmatter 定义 Agent，YAML 主配置
- 权限三级: allow/ask/deny + Bash glob + 全局基线

## 当前代码规模
- 22+ 个 TypeScript 源文件（src/ 目录）
- 3 个测试文件（45 个测试用例）
- 5 个 Agent 定义（.agents/ 目录）: main, coder, explore, reviewer, architect

## 模型 Provider
- deepseek: DeepSeek V4-Pro / V4-Flash（Anthropic 兼容端点）
- zhipu: GLM-5.1 / GLM-4.7（Anthropic 兼容端点）
- mimo: MiMo-V2.5-Pro（Anthropic 兼容端点，Bearer 认证）

## Agent 角色分配
- main: deepseek-v4-pro，全能调度 + task 自编排
- coder: GLM-4.7 (zhipu)，代码编写 + 工具执行
- explore: deepseek-v4-flash，只读代码探索
- reviewer: deepseek-v4-flash，代码审查
- architect: MiMo-V2.5-Pro (mimo)，只读架构顾问（不写代码）

## 已完成功能
- Agent 主循环 + task 原语（自编排）
- DeepSeek V4-Pro + GLM-5.1 适配器
- 故障转移（3 次重试 + 指数退避 + 跨模型切换）
- WebSearch（DDG HTML 解析 + redirect URL + 缓存 + 限速）
- WebFetch（DNS rebinding 防护 + 缓存 + cheerio/regex 双模式）
- 流式响应（chatViaStream + onTextDelta 回调）
- Git worktree 隔离（子 Agent 独立工作目录）
- Committee 模式（多 Agent 并行 + concat/majority/best 聚合）
- 权限解析、成本控制、并发控制、配置系统、CLI

## 已知 Bug 和注意事项
- `const IDLE` 声明顺序必须在 `let searchQueue` 之前（TDZ 问题）
- `Promise.resolve()` 每次调用返回新对象，不能用于身份比较
- DDG redirect URL 必须解析 `uddg` 参数，不能直接 `decodeURIComponent`
- `enqueueSearch` 首个请求不等待，用 `IDLE` 哨兵检测
- Bash 输出 50KB 截断，Read 输出 100KB 截断
- collectFiles 用 async 生成器 + 精确目录名匹配（非 String.includes）

## 已解决的限制（v0.2+）
- 流式重试输出重复 → `onRetry` 回调 + `[retry attempt N]` 标记
- 单次调用可能超预算 → `estimateWorstCase()` 前置检查 + `maxTokensPerStep`
- Worktree 残留 → process exit 钩子 + 启动时 `git worktree prune`
- cheerio 静默降级 → `isCheerioAvailable()` + 日志提示 + validate 展示

## 并行模型说明
- **task 工具**：当前串行执行（`for...await`），模型一次返回多个 toolCall 时逐个执行
- **Committee 模式**：真正并行（`Promise.allSettled`），各 Agent 独立运行同一任务
- task 并行化的风险：工具结果顺序不确定、子 Agent 间依赖被打破
- Committee 无此问题因为设计本意就是"各干各的，最后汇总"
