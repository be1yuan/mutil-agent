# 长期记忆

## 项目概况
- 项目路径: D:/MutilAgentWork
- 设计文档: DESIGN-v6.md + DESIGN-v7.md
- 进度文档: PROGRESS.md
- v0.1 ~ v0.5 全部完成，v0.6 待规划
- 技术栈: TypeScript + Node.js + Anthropic SDK + ink + React + Vitest

## 架构决策
- 废弃独立 Orchestrator 层，Agent 自编排
- DeepSeek + GLM + MiMo 均通过 Anthropic 兼容端点接入（统一 BaseAnthropicAdapter）
- Markdown frontmatter 定义 Agent，YAML 主配置
- 权限三级: allow/ask/deny + Bash glob + 全局基线
- 预算单位: 人民币（元），maxYuan 字段
- HTTP API: 零新依赖，纯 node:http 模块
- 文件邮箱: 原子写入（temp→rename），无需文件锁
- TUI 仪表盘: ink 5.x + React 18，惰性加载，--dashboard 可选启用
- Dashboard 组件用 ink Box borderStyle 替代硬编码边框（自适应终端宽度）
- summarizeArgs / toolSymbol 统一复用 ansi.ts 版本，不重复定义

## 当前代码规模
- 38+ 个 TypeScript/TSX 源文件（src/ 目录）
- 5 个测试文件（78 个测试用例）
- 5 个 Agent 定义（.agents/ 目录）: main, coder, explore, reviewer, architect
- Dashboard 组件: 7 个 .tsx 文件 + 1 个 .ts 类型文件 + 1 个 .ts 桥接文件

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
- DeepSeek V4-Pro + GLM-5.1 + MiMo-V2.5-Pro 适配器
- 故障转移（3 次重试 + 指数退避 + 跨模型切换）
- WebSearch（DDG HTML 解析 + redirect URL + 缓存 + 限速）
- WebFetch（DNS rebinding 防护 + 缓存 + cheerio/regex 双模式）
- 流式响应（chatViaStream + onTextDelta 回调）
- Git worktree 隔离（子 Agent 独立工作目录）
- Committee 模式（多 Agent 并行 + concat/majority/best 聚合）
- 文件邮箱（v0.3）：跨进程持久化 Agent 通信，原子写入，广播/回复/等待
- HTTP API（v0.3）：零依赖 HTTP 服务器 + SSE 流 + Bearer 认证 + 任务管理
- 终端可视化 Phase 1（v0.4）：ANSI 颜色 + 6 个 AgentLoop 生命周期回调
- TUI 仪表盘 Phase 2（v0.5）：ink 框架 + 四区域布局 + EventBridge 事件驱动 + 审批交互 + stream 缓冲 + budget 节流
- 权限解析、成本控制、并发控制、配置系统、CLI

## 已知 Bug 和注意事项
- `const IDLE` 声明顺序必须在 `let searchQueue` 之前（TDZ 问题）
- `Promise.resolve()` 每次调用返回新对象，不能用于身份比较
- DDG redirect URL 必须解析 `uddg` 参数，不能直接 `decodeURIComponent`
- `enqueueSearch` 首个请求不等待，用 `IDLE` 哨兵检测
- Bash 输出 50KB 截断，Read 输出 100KB 截断
- collectFiles 用 async 生成器 + 精确目录名匹配（非 String.includes）
- Windows 上 `*` 不是合法目录名，邮箱广播用 `_broadcast` 代替
- 邮箱 waitFor: 已有消息时立即返回，不进入轮询
- ink 惰性加载：`import("ink")` 在 executeWithDashboard 中动态导入，非 dashboard 模式零开销
- tsconfig.json 需 `jsx: "react-jsx"` + include `src/**/*.tsx` 才能编译 .tsx
- committee 模式不支持 --dashboard，传入时打印警告
- DashboardEventBridge.budget 事件有 200ms 节流，emitDone 时 flush 最终值
- Dashboard 审批流：bridge.onApprovalRequest 返回 Promise，App 用 useInput(A/D) 调用 bridge.resolveApproval

## 已解决的限制（v0.2+）
- 流式重试输出重复 → `onRetry` 回调 + `[retry attempt N]` 标记
- 单次调用可能超预算 → `estimateWorstCase()` 前置检查 + `maxTokensPerStep`
- Worktree 残留 → process exit 钩子 + 启动时 `git worktree prune`
- cheerio 静默降级 → `isCheerioAvailable()` + 日志提示 + validate 展示
- 终端输出无交互式全屏状态 → ink TUI 仪表盘 + EventBridge + 四区域布局
- Dashboard 审批死代码 → bridge Promise + useInput 键盘处理
- stream 逐 chunk 新行碎片化 → 追加到最后 stream 行 + 遇换行切行
- 固定宽度边框错位 → ink Box borderStyle="single" 自适应
- setTimeout(unmount) 退出脆弱 → App useEffect + exit() 自行退出
- budget 事件无节流 → 200ms 节流 + done 时 flush

## 并行模型说明
- **task 工具**：当前串行执行（`for...await`），模型一次返回多个 toolCall 时逐个执行
- **Committee 模式**：真正并行（`Promise.allSettled`），各 Agent 独立运行同一任务
- task 并行化的风险：工具结果顺序不确定、子 Agent 间依赖被打破
- Committee 无此问题因为设计本意就是"各干各的，最后汇总"
