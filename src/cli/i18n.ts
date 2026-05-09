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
    en: "/model to switch model  /workflow for workflows  /agent for agents  /exit to quit  /help for commands",
    zh: "/model 切换模型  /workflow 工作流  /agent 智能体  /exit 退出  /help 帮助",
  },

  // ── Help ──
  "help.title": { en: "Slash commands:", zh: "斜杠命令:" },
  "help.model": { en: "Switch AI model", zh: "切换 AI 模型" },
  "help.workflow": { en: "Workflow management (list, run, new, status)", zh: "工作流管理 (list, run, new, status)" },
  "help.agent": { en: "Agent management (list)", zh: "智能体管理 (list)" },
  "help.language": { en: "Switch language (中文/English)", zh: "切换语言 (中文/English)" },
  "help.save": { en: "Save result to file", zh: "保存结果到文件" },
  "help.exit": { en: "Exit", zh: "退出" },

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
  "cmd.taskEmpty": { en: "Task cannot be empty. Type /help for commands, /exit to quit.", zh: "任务不能为空。输入 /help 查看命令，/exit 退出。" },

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
  "model.cancel": { en: "Enter to cancel", zh: "按回车取消" },
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

  // ── Generic ──
  "generic.yes": { en: "Y/n", zh: "Y/n" },
  "generic.cancel": { en: "Enter to cancel", zh: "按回车取消" },
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
