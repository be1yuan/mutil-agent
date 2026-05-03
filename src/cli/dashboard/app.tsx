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
import type { ApprovalEventData } from "./types.js";
import { StatusBar } from "./components/status-bar.js";
import { CostGauge } from "./components/cost-gauge.js";
import { OutputPanel } from "./components/output-panel.js";
import { ApprovalBar } from "./components/approval-bar.js";
import { DashboardEventBridge } from "./event-bridge.js";
import { toolSymbol, summarizeToolArgs } from "../ansi.js";
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
  /** Called when user chooses to save the result. Returns the saved file path. */
  onSave?: (content: string) => string | undefined;
}

// ── Main App component ──

export function App({
  bridge,
  agentType,
  model,
  provider,
  budget,
  maxSteps,
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

  // Counter for output line IDs
  const lineIdRef = useRef(0);

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

  useInput((input) => {
    const key = input.toLowerCase();

    // Approval flow
    if (approvalRequest) {
      if (key === "a") {
        bridge.resolveApproval(true);
        setApprovalRequest(undefined);
        addLine("  ✓ Approved", "system");
      } else if (key === "d") {
        bridge.resolveApproval(false);
        setApprovalRequest(undefined);
        addLine("  ✗ Denied", "system");
      }
      return;
    }

    // Done flow: save or exit
    if (isDone) {
      if (key === "s" && !savedPath && onSave) {
        const path = onSave(finalContent);
        if (path) setSavedPath(path);
      } else if (key === "e") {
        exit();
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
        />
        <CostGauge spent={spent} budget={budget} provider={provider} />
      </Box>

      {/* Divider */}
      <Box width="100%">
        <Text dimColor>{"─".repeat(60)}</Text>
      </Box>

      {/* Middle: Output */}
      <OutputPanel lines={outputLines} maxHeight={isDone ? 12 : 20} />

      {/* Result section (when done with content) */}
      {isDone && contentLines.length > 0 && (
        <>
          <Box width="100%">
            <Text dimColor>{"─".repeat(60)}</Text>
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

      {/* Bottom: Save prompt or status bar */}
      {isDone ? (
        <Box width="100%" paddingX={1}>
          {savedPath ? (
            <Text color="green">{"  ✓ Saved to: "}{savedPath}{"  │  [E]xit"}</Text>
          ) : canSave ? (
            <Text>
              <Text color="yellow">{"  [S]ave to file"}</Text>
              {"  │  "}
              <Text color="gray">"[E]xit"</Text>
            </Text>
          ) : (
            <Text>
              <Text bold color={statusColor}>{statusIcon} {"Done"}</Text>
              {" │ Steps: "}{finalSteps}{" │ Cost: ¥"}{finalCost.toFixed(4)}
              {"  │  "}
              <Text color="gray">"[E]xit"</Text>
            </Text>
          )}
        </Box>
      ) : (
        <ApprovalBar request={approvalRequest} />
      )}
    </Box>
  );
}
