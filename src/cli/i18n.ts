/**
 * i18n — lightweight Chinese/English toggle for REPL UI strings.
 *
 * Flat key namespace, module-level locale state.
 * Usage: import { t, toggleLocale, getLocale } from "./i18n.js";
 */

export type Locale = "en" | "zh";

let currentLocale: Locale = "en";

const translations: Record<string, Record<Locale, string>> = {
  // ── Welcome & help ──
  "welcome.title": {
    en: "Welcome to agent-orch — self-orchestrating multi-agent CLI",
    zh: "欢迎使用 agent-orch — 自组织多智能体 CLI",
  },
  "welcome.hint": {
    en: "Type your task below and press Enter. Subcommands: run | committee | serve | list-agents | validate | init",
    zh: "输入任务描述后按回车。子命令: run | committee | serve | list-agents | validate | init",
  },
  "welcome.commands": {
    en: "/model to switch model  /workflow for workflows  /agent to manage agents  /help for commands  Esc to quit",
    zh: "/model 切换模型  /workflow 工作流  /agent 管理智能体  /help 帮助  Esc 退出",
  },

  // ── Help ──
  "help.title": { en: "Slash commands:", zh: "斜杠命令:" },
  "help.model": { en: "Switch AI model", zh: "切换 AI 模型" },
  "help.meeting": { en: "Guided meeting setup (debate, review chain, committee)", zh: "引导式会议设置 (辩论, 审查链, 委员会)" },
  "help.workflow": { en: "Workflow management (list, run, new, status)", zh: "工作流管理 (list, run, new, status)" },
  "help.agent": { en: "Interactive agent management", zh: "交互式智能体管理" },
  "help.language": { en: "Switch language (中文/English)", zh: "切换语言 (中文/English)" },
  "help.save": { en: "Save result to file", zh: "保存结果到文件" },
  "help.exit": { en: "Press Esc to exit", zh: "按 Esc 退出" },

  // ── Post-task ──
  "posttask.save": { en: "Save result to file", zh: "保存结果到文件" },
  "posttask.model": { en: "Switch AI model", zh: "切换 AI 模型" },
  "posttask.exit": { en: "Exit", zh: "退出" },
  "posttask.continuing": { en: "─── Continuing conversation ───", zh: "─── 继续对话 ───" },

  // ── Commands ──
  "cmd.unknown": { en: "Unknown command:", zh: "未知命令:" },
  "cmd.didYouMean": { en: "Did you mean", zh: "你是不是想输入" },
  "cmd.typeHelp": { en: "Type /help to see available commands.", zh: "输入 /help 查看可用命令。" },
  "cmd.goodbye": { en: "Goodbye.", zh: "再见。" },
  "cmd.taskEmpty": { en: "Task cannot be empty. Type /help for commands, Esc to quit.", zh: "任务不能为空。输入 /help 查看命令，Esc 退出。" },

  // ── Mode selection ──
  "mode.title": { en: "How would you like to execute this task?", zh: "你希望如何执行此任务?" },
  "mode.single": { en: "Single Agent", zh: "单智能体" },
  "mode.single.desc": { en: "Main agent executes directly — fast, no sub-agent delegation", zh: "主智能体直接执行 — 快速，不委派子任务" },
  "mode.auto": { en: "Self-Orchestration (default)", zh: "自编排 (默认)" },
  "mode.auto.desc": { en: "Main agent decides whether to delegate via task tool", zh: "主智能体决定是否通过 task 工具委派子任务" },
  "mode.committee": { en: "Multi-Agent Committee", zh: "多智能体委员会" },
  "mode.committee.desc": { en: "explore + coder + reviewer + architect work in parallel", zh: "explore + coder + reviewer + architect 并行工作" },
  "mode.select": { en: "Select", zh: "选择" },

  // ── Model picker ──
  "model.title": { en: "Models:", zh: "模型:" },
  "model.select": { en: "Select", zh: "选择" },
  "model.cancel": { en: "Esc to cancel", zh: "Esc 取消" },
  "model.switched": { en: "Switched to", zh: "已切换到" },

  // ── Workflow ──
  "wf.found": { en: "Found matching workflow:", zh: "找到匹配的工作流:" },
  "wf.steps": { en: "steps", zh: "步骤" },
  "wf.use": { en: "Use this workflow? [Y/n]", zh: "使用此工作流? [Y/n]" },
  "wf.none": { en: "No workflows loaded.", zh: "没有已加载的工作流。" },
  "wf.available": { en: "Available workflows:", zh: "可用工作流:" },
  "wf.notFound": { en: "not found", zh: "未找到" },
  "wf.title": { en: "/workflow commands:", zh: "/workflow 命令:" },
  "wf.list": { en: "List available workflows", zh: "列出可用工作流" },
  "wf.run": { en: "Run a workflow by name", zh: "按名称运行工作流" },
  "wf.new": { en: "Create a new workflow interactively", zh: "交互式创建新工作流" },
  "wf.status": { en: "Check workflow run status", zh: "查看工作流运行状态" },
  "wf.budget": { en: "Budget:", zh: "预算:" },

  // ── Agent ──
  "agent.title": { en: "/agent commands:", zh: "/agent 命令:" },
  "agent.list": { en: "List available agents", zh: "列出可用智能体" },
  "agent.noDescription": { en: "No description", zh: "无描述" },
  "agent.noAgents": { en: "No agents loaded", zh: "没有已加载的智能体" },
  "agent.notFound": { en: "not found", zh: "未找到" },
  "agent.selectAgent": { en: "Select an agent", zh: "选择一个智能体" },
  "agent.selectPrompt": { en: "Enter number or name (Esc to cancel):", zh: "输入编号或名称 (Esc 取消):" },
  "agent.actionsFor": { en: "— actions", zh: "— 操作" },
  "agent.action.show": { en: "Show configuration", zh: "查看配置" },
  "agent.action.model": { en: "Change model", zh: "切换模型" },
  "agent.action.edit": { en: "Edit configuration", zh: "编辑配置" },
  "agent.action.back": { en: "Back to list", zh: "返回列表" },
  "agent.actionPrompt": { en: "Select [1-4] (Esc to exit):", zh: "选择 [1-4] (Esc 退出):" },
  "agent.detail.type": { en: "Type", zh: "类型" },
  "agent.detail.model": { en: "Model", zh: "模型" },
  "agent.detail.desc": { en: "Description", zh: "描述" },
  "agent.detail.maxSteps": { en: "Max steps", zh: "最大步骤" },
  "agent.detail.timeout": { en: "Timeout", zh: "超时" },
  "agent.detail.isolation": { en: "Isolation", zh: "隔离模式" },
  "agent.detail.none": { en: "none", zh: "无" },
  "agent.detail.tools": { en: "Tools", zh: "工具" },
  "agent.detail.systemPrompt": { en: "System prompt", zh: "系统提示词" },
  "agent.detail.promptPreview": { en: "(showing first 300 chars)", zh: "(显示前300字符)" },
  "agent.model.select": { en: "Select model for", zh: "为以下智能体选择模型" },
  "agent.model.prompt": { en: "Enter number (Esc to cancel):", zh: "输入编号 (Esc 取消):" },
  "agent.model.switched": { en: "Model changed to", zh: "模型已切换为" },
  "agent.edit.title": { en: "Editing", zh: "编辑" },
  "agent.edit.hint": { en: "Press Enter to keep current value", zh: "回车保持当前值" },
  "agent.edit.current": { en: "current", zh: "当前" },
  "agent.edit.currentLen": { en: "current length", zh: "当前长度" },
  "agent.edit.prompt": { en: "System prompt", zh: "系统提示词" },
  "agent.edit.maxSteps": { en: "Max steps", zh: "最大步骤" },
  "agent.edit.timeout": { en: "Timeout (ms)", zh: "超时(毫秒)" },
  "agent.edit.isolation": { en: "Isolation (context/worktree/none)", zh: "隔离 (context/worktree/无)" },
  "agent.edit.none": { en: "none", zh: "无" },
  "agent.edit.updated": { en: "Agent updated", zh: "智能体已更新" },

  // ── Wizard ──
  "wizard.create": { en: "Create New Workflow", zh: "创建新工作流" },
  "wizard.name": { en: "Name:", zh: "名称:" },
  "wizard.description": { en: "Description:", zh: "描述:" },
  "wizard.step": { en: "Step", zh: "步骤" },
  "wizard.chooseType": { en: "Choose type:", zh: "选择类型:" },
  "wizard.type.agent": { en: "agent      (single agent)", zh: "agent      (单智能体)" },
  "wizard.type.committee": { en: "committee  (multiple agents in parallel)", zh: "committee  (多智能体并行)" },
  "wizard.type.checkpoint": { en: "checkpoint (human approval)", zh: "checkpoint (人工审批)" },
  "wizard.agents": { en: "Agents (comma-separated):", zh: "智能体 (逗号分隔):" },
  "wizard.agent": { en: "Agent:", zh: "智能体:" },
  "wizard.task": { en: "Task description:", zh: "任务描述:" },
  "wizard.addMore": { en: "Add another step? [Y/n]", zh: "添加更多步骤? [Y/n]" },
  "wizard.preview": { en: "Generated workflow:", zh: "生成的工作流:" },
  "wizard.save": { en: "Save? [Y/n]", zh: "保存? [Y/n]" },
  "wizard.saved": { en: "saved to", zh: "已保存到" },
  "wizard.cancelled": { en: "Cancelled.", zh: "已取消。" },
  "wizard.availableAgents": { en: "Available agents:", zh: "可用智能体:" },

  // ── Language ──
  "lang.switched": { en: "Language switched to English", zh: "语言已切换为中文" },

  // ── Memory ──
  "memory.list": { en: "Knowledge entries:", zh: "知识条目:" },
  "memory.empty": { en: "No knowledge entries found.", zh: "没有找到知识条目。" },
  "memory.search": { en: "Search results for", zh: "搜索结果:" },
  "memory.noResults": { en: "No results found for", zh: "没有找到结果:" },
  "memory.cleared": { en: "All knowledge entries cleared.", zh: "所有知识条目已清除。" },
  "memory.notEnabled": { en: "Memory is not enabled. Add memory config to orchestrator.yaml.", zh: "记忆系统未启用。请在 orchestrator.yaml 中添加 memory 配置。" },

  // ── Meeting wizard ──
  "meeting.title": { en: "Choose meeting mode:", zh: "选择会议模式:" },
  "meeting.selectMode": { en: "Select", zh: "选择" },
  "meeting.cancelled": { en: "Cancelled.", zh: "已取消。" },
  "meeting.available": { en: "Available", zh: "可用" },
  "meeting.default": { en: "Default", zh: "默认" },
  "meeting.invalidAgent": { en: "Agent not found", zh: "未找到智能体" },

  "meeting.mode.debate": { en: "Debate — multi-agent multi-round with LLM judging", zh: "辩论 — 多Agent多轮辩论 + LLM评委打分" },
  "meeting.mode.debate.desc": { en: "Parallel debate with judge scoring and optional moderator", zh: "并行辩论 + 评委评分 + 可选主持人总结" },
  "meeting.mode.reviewChain": { en: "Review Chain — coder + reviewer iterative improvement", zh: "审查链 — coder+reviewer 迭代改进" },
  "meeting.mode.reviewChain.desc": { en: "Iterative code-review loop until LGTM", zh: "编码-审查迭代循环直到通过" },
  "meeting.mode.committee": { en: "Committee — multiple agents in parallel", zh: "委员会 — 多Agent并行执行" },
  "meeting.mode.committee.desc": { en: "Parallel execution with aggregation strategy", zh: "并行执行 + 聚合策略" },

  // Debate wizard
  "meeting.debate.title": { en: "Debate Setup", zh: "辩论设置" },
  "meeting.debate.topic": { en: "Debate topic", zh: "辩论主题" },
  "meeting.debate.participants": { en: "Participants (comma-separated)", zh: "参与辩论的Agent (逗号分隔)" },
  "meeting.debate.rounds": { en: "Number of rounds", zh: "辩论轮数" },
  "meeting.debate.enableJudge": { en: "Enable judge scoring?", zh: "启用评委打分?" },
  "meeting.debate.judgeAgent": { en: "Judge agent", zh: "评委Agent" },
  "meeting.debate.judge": { en: "Judge", zh: "评委" },
  "meeting.debate.judgeOff": { en: "off", zh: "关闭" },
  "meeting.debate.enableModerator": { en: "Enable moderator synthesis?", zh: "需要主持人总结?" },
  "meeting.debate.moderatorAgent": { en: "Moderator agent", zh: "主持人Agent" },
  "meeting.debate.moderator": { en: "Moderator", zh: "主持人" },
  "meeting.debate.noModerator": { en: "none", zh: "无" },
  "meeting.debate.start": { en: "Start debate?", zh: "开始辩论?" },

  // Review chain wizard
  "meeting.reviewChain.title": { en: "Review Chain Setup", zh: "审查链设置" },
  "meeting.reviewChain.task": { en: "Task description", zh: "任务描述" },
  "meeting.reviewChain.coder": { en: "Coder agent", zh: "编码Agent" },
  "meeting.reviewChain.reviewer": { en: "Reviewer agent", zh: "审查Agent" },
  "meeting.reviewChain.maxIterations": { en: "Max iterations", zh: "最大迭代次数" },
  "meeting.reviewChain.manualApproval": { en: "Enable manual approval?", zh: "是否启用人工审批?" },
  "meeting.reviewChain.approval": { en: "Approval", zh: "审批" },
  "meeting.reviewChain.auto": { en: "auto", zh: "自动" },
  "meeting.reviewChain.manual": { en: "manual", zh: "手动" },
  "meeting.reviewChain.start": { en: "Start review chain?", zh: "开始审查链?" },

  // Committee wizard
  "meeting.committee.title": { en: "Committee Setup", zh: "委员会设置" },
  "meeting.committee.task": { en: "Task", zh: "任务" },
  "meeting.committee.agents": { en: "Agents (comma-separated)", zh: "参与Agent (逗号分隔)" },
  "meeting.committee.strategy": { en: "Aggregation strategy:", zh: "聚合策略:" },
  "meeting.committee.strategyLabel": { en: "Strategy", zh: "策略" },
  "meeting.committee.strategy.concat": { en: "Concatenate all results", zh: "拼接所有结果" },
  "meeting.committee.strategy.majority": { en: "Majority vote", zh: "多数投票" },
  "meeting.committee.strategy.best": { en: "Longest response", zh: "最长回答" },
  "meeting.committee.strategy.weightedMajority": { en: "Weighted majority vote", zh: "加权多数投票" },
  "meeting.committee.strategy.weightedBest": { en: "Weighted best response", zh: "加权最佳回答" },
  "meeting.committee.selectStrategy": { en: "Select", zh: "选择" },
  "meeting.committee.weightsHint": { en: "Format: agent:weight, agent:weight (default: 1.0 each)", zh: "格式: agent:权重, agent:权重 (默认每项1.0)" },
  "meeting.committee.weights": { en: "Weights", zh: "权重" },
  "meeting.committee.start": { en: "Start committee?", zh: "开始委员会?" },

  // Confirm
  "meeting.confirm.title": { en: "Meeting Config", zh: "会议配置确认" },
  "meeting.confirm.mode": { en: "Mode", zh: "模式" },
  "meeting.contributions": { en: "Agent Contributions", zh: "Agent贡献摘要" },
  "meeting.noOutput": { en: "(no output)", zh: "(无输出)" },

  // ── Generic ──
  "generic.yes": { en: "Y/n", zh: "Y/n" },
  "generic.cancel": { en: "Esc to cancel", zh: "Esc 取消" },
};

/** Translate a key to the current locale. Falls back to English. */
export function t(key: string): string {
  const entry = translations[key];
  if (!entry) return key;
  return entry[currentLocale] ?? entry.en ?? key;
}

/** Toggle between Chinese and English. Returns the new locale. */
export function toggleLocale(): Locale {
  currentLocale = currentLocale === "en" ? "zh" : "en";
  return currentLocale;
}

/** Set locale explicitly. */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/** Get current locale. */
export function getLocale(): Locale {
  return currentLocale;
}
