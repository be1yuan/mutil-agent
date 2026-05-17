/**
 * Dashboard App — main component for the interactive TUI dashboard.
 *
 * Four-area layout:
 * ┌─ Agent Status ──────┬─ Cost ──────────────────┐
 * │ (status-bar)        │ (cost-gauge)            │
 * ├─────────────────────┴─────────────────────────┤
 * │ (output-panel)                                 │
 * ├────────────────────────────────────────────────┤
 * │ (result section — shown when done)             │
 * ├────────────────────────────────────────────────┤
 * │ (approval-bar / save prompt)                   │
 * └────────────────────────────────────────────────┘
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ApprovalEventData } from "./types.js";
import { StatusBar } from "./components/status-bar.js";
import { CostGauge } from "./components/cost-gauge.js";
import { OutputPanel } from "./components/output-panel.js";
import { ApprovalBar } from "./components/approval-bar.js";
import { DashboardEventBridge } from "./event-bridge.js";
import { toolSymbol, summarizeToolArgs, symbols } from "../ansi.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import { getDividerWidth } from "./theme.js";
import type {
  DashboardEvent,
  AgentInfo,
  OutputLine,
  ApprovalRequest,
  StepEventData,
  ToolStartEventData,
  ToolCompleteEventData,
  SubAgentSpawnEventData,
  SubAgentCompleteEventData,
  BudgetEventData,
  StreamEventData,
  DoneEventData,
} from "./types.js";

interface AppProps {
  bridge: DashboardEventBridge;
  agentType: string;
  model: string;
  provider: string;
  budget: number;
  maxSteps: number;
  /** If not provided, App starts in task input mode before running */
  initialTask?: string;
  /** Called when user chooses to save the result. Returns the saved file path. */
  onSave?: (content: string) => string | undefined;
}

/** Post-task action menu items */
const ACTION_ITEMS = [
  { key: "1", label: "Continue chatting", action: "continue" as const },
  { key: "2", label: "Save result to file", action: "save" as const },
  { key: "3", label: "Exit", action: "exit" as const },
];

// ── Main App component ──

export function App({
  bridge,
  agentType,
  model,
  provider,
  budget,
  maxSteps,
  initialTask,
  onSave,
}: AppProps) {
  const { exit } = useApp();

  // ── State ──

  const [currentStep, setCurrentStep] = useState(0);
  const [spent, setSpent] = useState(0);
  const [agents, setAgents] = useState<Map<string, AgentInfo>>(new Map());
  const [outputLines, setOutputLines] = useState<OutputLine[]>([]);
  const [approvalRequest, setApprovalRequest] = useState<
    ApprovalRequest | undefined
  >(undefined);
  const [isDone, setIsDone] = useState(false);
  const [finalStatus, setFinalStatus] = useState<string>("");
  const [finalContent, setFinalContent] = useState<string>("");
  const [finalSteps, setFinalSteps] = useState(0);
  const [finalCost, setFinalCost] = useState(0);
  const [savedPath, setSavedPath] = useState<string | undefined>(undefined);

  // Task input mode (when no initialTask provided)
  const [isTaskInput, setIsTaskInput] = useState(!initialTask);
  const [taskInput, setTaskInput] = useState("");

  // Action menu state
  const [selectedAction, setSelectedAction] = useState(0); // 0-based index into ACTION_ITEMS
  const [isChatInput, setIsChatInput] = useState(false); // true when user is typing a follow-up message
  const [chatInput, setChatInput] = useState("");

  // Counter for output line IDs
  const lineIdRef = useRef(0);

  // Track when the agent started (set on first event)
  const startTimeRef = useRef<number>(0);

  // Terminal size for responsive layout
  const { columns } = useTerminalSize();

  // ── Initialize main agent in the agents map ──

  useEffect(() => {
    setAgents((prev) => {
      if (prev.has(agentType)) return prev;
      const next = new Map(prev);
      next.set(agentType, {
        agentType,
        status: "running",
        steps: 0,
      });
      return next;
    });
  }, [agentType]);

  // ── Helper: add output line ──

  const addLine = useCallback(
    (text: string, type: OutputLine["type"] = "stream") => {
      setOutputLines((prev) => {
        const id = ++lineIdRef.current;
        const next = [...prev, { id, text, type, timestamp: Date.now() }];
        return next.length > 500 ? next.slice(-400) : next;
      });
    },
    []
  );

  // ── Event subscription ──

  useEffect(() => {
    const handler = (event: DashboardEvent) => {
      // Capture start time on first event
      if (startTimeRef.current === 0) startTimeRef.current = Date.now();

      switch (event.type) {
        case "step": {
          const d = event.data as StepEventData;
          setCurrentStep(d.step);
          addLine(`▸ Step ${d.step} [${d.agentType}]`, "step");
          setAgents((prev) => {
            const next = new Map(prev);
            const existing = next.get(d.agentType);
            next.set(d.agentType, {
              agentType: d.agentType,
              status: "running",
              steps: d.step,
              parentType: existing?.parentType,
            });
            return next;
          });
          break;
        }

        case "tool_start": {
          const d = event.data as ToolStartEventData;
          const sym = toolSymbol(d.toolName);
          const detail = summarizeToolArgs(d.toolName, d.args);
          addLine(`  ${sym} ${d.toolName.padEnd(10)} ${detail}`, "tool");
          break;
        }

        case "tool_complete": {
          const d = event.data as ToolCompleteEventData;
          const icon = d.success ? "✓" : "✗";
          addLine(
            `  ${icon} ${d.toolName} ${d.duration}ms`,
            d.success ? "tool" : "system"
          );
          break;
        }

        case "subagent_spawn": {
          const d = event.data as SubAgentSpawnEventData;
          addLine(
            `  ┬ [${d.parent}] → [${d.child}] ${d.task.slice(0, 50)}`,
            "tool"
          );
          setAgents((prev) => {
            const next = new Map(prev);
            next.set(d.child, {
              agentType: d.child,
              status: "running",
              steps: 0,
              parentType: d.parent,
            });
            return next;
          });
          break;
        }

        case "subagent_complete": {
          const d = event.data as SubAgentCompleteEventData;
          const icon = d.result.status === "success" ? "✓" : "✗";
          addLine(
            `  ╰ [${d.child}] ${icon} ${d.result.status} (¥${d.result.cost.toFixed(4)})`,
            "tool"
          );
          setAgents((prev) => {
            const next = new Map(prev);
            const info = next.get(d.child);
            if (info) {
              next.set(d.child, {
                ...info,
                status: d.result.status === "success" ? "done" : "error",
                steps: d.result.steps,
              });
            }
            return next;
          });
          break;
        }

        case "budget": {
          const d = event.data as BudgetEventData;
          setSpent(d.spent);
          break;
        }

        case "stream": {
          const d = event.data as StreamEventData;
          const parts = d.text.split("\n");
          setOutputLines((prev) => {
            let next = [...prev];
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i];
              if (i === 0) {
                const last = next[next.length - 1];
                if (last && last.type === "stream") {
                  next[next.length - 1] = { ...last, text: last.text + part };
                } else if (part) {
                  const id = ++lineIdRef.current;
                  next.push({ id, text: part, type: "stream", timestamp: Date.now() });
                }
              } else {
                if (part || i < parts.length - 1) {
                  const id = ++lineIdRef.current;
                  next.push({ id, text: part, type: "stream", timestamp: Date.now() });
                }
              }
            }
            return next.length > 500 ? next.slice(-400) : next;
          });
          break;
        }

        case "approval": {
          const d = event.data as ApprovalEventData & { id: number };
          setApprovalRequest({
            id: d.id,
            agentType: d.agentType,
            toolName: d.toolName,
            args: d.args,
          });
          break;
        }

        case "done": {
          const d = event.data as DoneEventData;
          setIsDone(true);
          setFinalStatus(d.status);
          setFinalContent(d.content ?? "");
          setFinalSteps(d.steps);
          setFinalCost(d.cost);
          setSelectedAction(0);
          setIsChatInput(false);
          setChatInput("");
          addLine(
            `\n━━━ Task ${d.status.toUpperCase()} ─━━ Steps: ${d.steps} │ Cost: ¥${d.cost.toFixed(4)}`,
            "system"
          );
          break;
        }
      }
    };

    bridge.on("event", handler);
    return () => { bridge.off("event", handler); };
  }, [bridge, addLine]);

  // ── Keyboard input ──

  useInput((input, key) => {
    // Task input mode (before agent starts — no initialTask)
    if (isTaskInput) {
      if (key.escape) {
        bridge.resolveTask(""); // empty signals cancellation
        setIsTaskInput(false);
        return;
      }
      if (key.return) {
        if (taskInput.trim()) {
          bridge.resolveTask(taskInput.trim());
          setIsTaskInput(false);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setTaskInput((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setTaskInput((prev) => prev + input);
      }
      return;
    }

    // Approval flow (unchanged)
    if (approvalRequest) {
      const k = input.toLowerCase();
      if (k === "a") {
        bridge.resolveApproval(true);
        setApprovalRequest(undefined);
        addLine("  ✓ Approved", "system");
      } else if (k === "d") {
        bridge.resolveApproval(false);
        setApprovalRequest(undefined);
        addLine("  ✗ Denied", "system");
      }
      return;
    }

    // Chat input mode: only handle Escape here (TextInput handles text + Enter)
    if (isDone && isChatInput) {
      if (key.escape) {
        setIsChatInput(false);
        setChatInput("");
      }
      return;
    }

    // Done flow: action menu navigation
    if (isDone) {
      if (key.upArrow) {
        setSelectedAction((prev) => (prev - 1 + ACTION_ITEMS.length) % ACTION_ITEMS.length);
      } else if (key.downArrow) {
        setSelectedAction((prev) => (prev + 1) % ACTION_ITEMS.length);
      } else if (key.return) {
        const item = ACTION_ITEMS[selectedAction];
        if (item.action === "continue") {
          setIsChatInput(true);
        } else if (item.action === "save" && !savedPath && onSave) {
          const path = onSave(finalContent);
          if (path) setSavedPath(path);
          bridge.resolveUserAction({ type: "save" });
        } else if (item.action === "exit") {
          bridge.resolveUserAction({ type: "exit" });
          exit();
        }
      } else if (input === "1" || input === "2" || input === "3") {
        // Quick number shortcuts
        const idx = parseInt(input) - 1;
        if (idx >= 0 && idx < ACTION_ITEMS.length) {
          const item = ACTION_ITEMS[idx];
          if (item.action === "continue") {
            setIsChatInput(true);
          } else if (item.action === "save" && !savedPath && onSave) {
            const path = onSave(finalContent);
            if (path) setSavedPath(path);
            bridge.resolveUserAction({ type: "save" });
          } else if (item.action === "exit") {
            bridge.resolveUserAction({ type: "exit" });
            exit();
          }
        }
      }
    }
  });

  // ── Render ──

  const statusColor =
    finalStatus === "success" ? "green" : finalStatus === "error" ? "red" : "yellow";
  const statusIcon =
    finalStatus === "success" ? "✓" : finalStatus === "error" ? "✗" : "⚠";

  // Truncate content for display (show first 30 lines)
  const contentLines = finalContent ? finalContent.split("\n") : [];
  const displayLines = contentLines.slice(0, 30);
  const hasMore = contentLines.length > 30;
  const canSave = isDone && finalContent && onSave && !savedPath;

  // Task input screen (no initialTask)
  if (isTaskInput) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">agent-orch · {agentType} · {model}</Text>
          <Text dimColor>  Budget: ¥{budget.toFixed(2)}  |  Max steps: {maxSteps}</Text>
        </Box>
        <Box>
          <Text dimColor>{symbols.boxH.repeat(getDividerWidth(columns))}</Text>
        </Box>
        <Box marginY={1}>
          <Text bold>Enter your task:</Text>
        </Box>
        <Box>
          <Text color="gray">{"> "}</Text>
          <Text bold>{taskInput}</Text>
          <Text color="gray">█</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Enter to submit  Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%" borderStyle="round" borderColor={isDone ? statusColor : "cyan"}>
      {/* Top: Status + Cost */}
      <Box flexDirection="row" width="100%">
        <StatusBar
          agentType={agentType}
          model={model}
          currentStep={currentStep}
          maxSteps={maxSteps}
          agents={agents}
          startTime={startTimeRef.current || undefined}
        />
        <CostGauge spent={spent} budget={budget} provider={provider} currentStep={currentStep} />
      </Box>

      {/* Divider */}
      <Box width="100%">
        <Text dimColor>{symbols.boxH.repeat(getDividerWidth(columns))}</Text>
      </Box>

      {/* Middle: Output */}
      <OutputPanel lines={outputLines} maxHeight={isDone ? 12 : 20} isDone={isDone} />

      {/* Result section (when done with content) */}
      {isDone && contentLines.length > 0 && (
        <>
          <Box width="100%">
            <Text dimColor>{symbols.boxH.repeat(getDividerWidth(columns))}</Text>
          </Box>
          <Box flexDirection="column" paddingX={1}>
            <Text bold color={statusColor}>
              {" Result"}{finalStatus === "success" ? "" : ` (${finalStatus})`}
            </Text>
            {displayLines.map((line, i) => (
              <Text key={i}>{" "}{line}</Text>
            ))}
            {hasMore && (
              <Text dimColor>{"  ... ("}{contentLines.length}{" lines total)"}</Text>
            )}
          </Box>
        </>
      )}

      {/* Bottom: Action menu or approval bar */}
      {isDone ? (
        <Box flexDirection="column" width="100%" paddingX={1}>
          {/* Saved path indicator */}
          {savedPath && (
            <Text color="green">{"  ✓ Saved to: "}{savedPath}</Text>
          )}

          {/* Chat input mode */}
          {isChatInput ? (
            <Box flexDirection="column">
              <Text color="cyan">{"  Type your message (Enter to send, Esc to cancel):"}</Text>
              <Box>
                <Text color="gray">{"  > "}</Text>
                <TextInput
                  value={chatInput}
                  onChange={setChatInput}
                  onSubmit={(value: string) => {
                    if (value.trim()) {
                      bridge.resolveUserAction({ type: "continue", message: value.trim() });
                      setIsChatInput(false);
                      setChatInput("");
                      setIsDone(false);
                    }
                  }}
                  focus
                  showCursor
                />
              </Box>
            </Box>
          ) : (
            <>
              {/* Action menu with selectable items */}
              <Text dimColor>{"  What would you like to do?"}</Text>
              {ACTION_ITEMS.map((item, idx) => {
                const isSelected = idx === selectedAction;
                const isDisabled = item.action === "save" && !!savedPath;
                const prefix = isSelected ? " > " : "   ";
                const color = isDisabled ? "gray" : isSelected ? "cyan" : "white";
                const numLabel = item.action === "save" && savedPath
                  ? `${item.key}. ${item.label} (saved)` : `${item.key}. ${item.label}`;
                return (
                  <Text key={item.key} color={color} bold={isSelected}>
                    {prefix}{numLabel}
                  </Text>
                );
              })}
              <Text dimColor>{"  ↑↓ Navigate  Enter Select  Or press 1/2/3"}</Text>
            </>
          )}
        </Box>
      ) : (
        <ApprovalBar request={approvalRequest} />
      )}
    </Box>
  );
}
