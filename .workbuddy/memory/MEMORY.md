# 长期记忆

## 项目概况
- 项目路径: D:/MutilAgentWork
- 设计文档: DESIGN-v6 ~ v9
- 进度文档: PROGRESS.md
- v0.1 ~ v0.6 全部完成，v1.0 待规划
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
- 40+ 个 TypeScript/TSX 源文件（src/ 目录）
- 9 个测试文件（116 个测试用例）
- 5 个 Agent 定义（.agents/ 目录）: main, coder, explore, reviewer, architect
- Dashboard 组件: 7 个 .tsx 文件 + 1 个 .ts 类型文件 + 1 个 .ts 桥接文件
- 新增: metrics.ts, esbuild.config.mjs, templates/

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

## v0.6 进度（100% 完成）
- ✅ esbuild 构建 + package.json 元数据 + LICENSE + templates
- ✅ API 集成测试（13 测试）
- ✅ AgentLoop 集成测试（11 测试）
- ✅ 邮箱跨实例通信测试（6 测试）
- ✅ 错误恢复策略（consecutiveErrors 计数 + 提示注入）
- ✅ validate 命令增强（ink/react/cheerio/git/Node.js/.env 检测）
- ✅ Prometheus metrics（MetricsRegistry + /api/metrics 端点，8 测试）
- ✅ 代码审查修复（12 项 bug：孤立 tool_result、时序安全、标签注入等）
- 📋 v1.0 待做: init 命令、Dockerfile、CI/CD、npm publish

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
