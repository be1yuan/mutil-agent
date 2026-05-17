# 长期记忆

## 项目概况
- 项目路径: D:/MutilAgentWork
- 设计文档: DESIGN-v6 ~ v10（agent-orchV2-0.md）
- 进度文档: PROGRESS.md
- v0.1 ~ v1.0 全部完成，v2.0 Phase 1（工作流引擎）已完成
- ✅ 端到端验证通过：npm link + agent-orch run/list-agents/validate/init/serve 全部可用
- 真实 LLM 调用成功（DeepSeek V4-Pro + explore agent + Glob/Read 工具）
- ✅ 交互式 UX：任务后操作菜单（继续聊天/保存/退出）、-i 交互式模式选择、-m single/committee
- 技术栈: TypeScript + Node.js + Anthropic SDK + ink + React + Vitest + esbuild

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
- esbuild 打包: ESM + code splitting + createRequire banner 解决 CJS 依赖
- ink/React/cheerio 标记为 external/peer/optional，运行时按需加载

## 当前代码规模
- 55+ 个 TypeScript/TSX 源文件（src/ 目录，含 workflow 模块）
- 13 个测试文件（160 个测试用例）—— 新增 workflow 测试 45 个
- 5 个 Agent 定义（.agents/ 目录）: main, coder, explore, reviewer, architect
- Dashboard 组件: 7 个 .tsx 文件 + 1 个 .ts 类型文件 + 1 个 .ts 桥接文件
- 新增: src/workflow/（5 个源文件 + 4 个测试文件），.workflows/（2 个示例 YAML）
- 新增: ink-text-input v6（可选 peer 依赖，用于 Dashboard 文本输入）

## 模型 Provider
- deepseek: DeepSeek V4-Pro / V4-Flash（Anthropic 兼容端点）
- zhipu: GLM-5.1 / GLM-4.7（Anthropic 兼容端点）
- mimo: MiMo-V2.5-Pro（Anthropic 兼容端点，Bearer 认证）

## Agent 角色分配
- main: deepseek-v4-pro，全能调度 + task 自编排
- coder: GLM-4.7 (zhipu)，代码编写 + 工具执行
- explore: deepseek-v4-flash，只读代码探索
- reviewer: deepseek-v4-pro，代码审查
- architect: MiMo-V2.5-Pro (mimo)，只读架构顾问（不写代码）

## 执行模式
- **single**: main agent 直接执行，无 task 工具（快速）
- **auto**: main agent 自编排，AI 决定是否通过 task 派生子 agent（默认）
- **committee**: explore + coder + reviewer + architect 并行执行
- CLI: `-m <single|auto|committee>` 或 `-i` 交互选择

## v1.0 完成（DESIGN-v8）
- ✅ esbuild 构建 + package.json 元数据 + LICENSE + templates
- ✅ API 集成测试（13 测试）
- ✅ AgentLoop 集成测试（11 测试）
- ✅ 邮箱跨实例通信测试（6 测试）
- ✅ 错误恢复策略（consecutiveErrors 计数 + 提示注入）
- ✅ validate 命令增强（ink/react/cheerio/git/Node.js/.env 检测）
- ✅ Prometheus metrics（MetricsRegistry + /api/metrics 端点，8 测试）
- ✅ 代码审查修复（12 项 bug：孤立 tool_result、时序安全、标签注入等）
- ✅ Dockerfile + CI/CD + npm publish 准备就绪
- ✅ init 命令 — 一键脚手架生成

## v2.0 Phase 1 完成 — 工作流引擎
- ✅ 工作流类型定义 + YAML 解析 + Zod 校验（parser + parser.test.ts，13 测试）
- ✅ WorkflowEngine：步骤遍历、条件分支、委员会步骤、检查点暂停/恢复（engine + engine.test.ts，13 测试）
- ✅ 状态持久化（state-store + state-store.test.ts，11 测试）
- ✅ 变量插值（template-resolver + template-resolver.test.ts，9 测试）
- ✅ CLI命令：`workflow run/list/status/resume`
- ✅ API 端点：`POST /api/workflows` / `GET /api/workflows/:id` / `POST /api/workflows/:id/resume`
- ✅ 160 全量测试通过

## 关键细节
- AgentLoop.run() 支持 options.initialHistory 参数和 result.history 返回，用于多轮对话
- EventBridge 新增 waitForUserAction()/resolveUserAction()/waitForTask() 支持 Dashboard 继续对话
- AgentResult.history 类型为 (Message | ToolResult)[]，不是 Message[]（因包含 tool_result）
- 标准模式用 readline 交互菜单，Dashboard 模式用 ink 可选择菜单（上下箭头+回车+数字快捷键）
- committee 模式只有保存/退出，没有继续聊天（多 agent 并行无对话上下文可延续）
- 后任务交互：/save /model /exit 斜杠命令（Claude Code 风格）
- 执行模式：-m single/auto/committee，-i 交互选择

## 已知 Bug 和注意事项
- `const IDLE` 声明顺序必须在 `let searchQueue` 之前（TDZ 问题）
- DDG redirect URL 必须解析 `uddg` 参数，不能直接 `decodeURIComponent`
- Windows 上 `*` 不是合法目录名，邮箱广播用 `_broadcast` 代替
- ESM bundle 不能用 shebang banner（Node.js 不接受），npm bin 自动处理入口点
- CJS 依赖（winston/colors）需要 `createRequire(import.meta.url)` banner 解决动态 require
- AgentDefinition 必须包含 timeout 字段（测试中容易遗漏）
- Mailbox.send() 接收 Omit<MailMessage, "id"|"timestamp"> 对象，不是独立参数
- Mailbox.cleanup() 只接收一个参数 maxAgeMs，不是 (agentType, maxAgeMs)
- Mailbox.waitFor() 返回单个 MailMessage，不是数组
- **DeepSeek thinking mode**：assistant 消息中的 thinking block 必须在下一轮对话中原样回传，否则 API 返回 400 invalid_request_error（"content[].thinking must be passed back"）
- ChatResponse.contentBlocks 包含完整 ContentBlock（含 ThinkingBlock），AgentLoop 优先用它存储 history
