/**
 * Dashboard App — main component for the interactive TUI dashboard.
 *
 * Four-area layout:
 * ┌─ Agent Status ──────┬─ Cost ──────────────────┐
 * │ (status-bar)        │ (cost-gauge)            │
 * ├─────────────────────┴─────────────────────────┤
 * │ (output-panel)                                 │
 * ├────────────────────────────────────────────────┤
 * │ (approval-bar)                                 │
 * └────────────────────────────────────────────────┘
 *
 * Subscribes to DashboardEventBridge events and translates them
 * into React state updates for real-time rendering.
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
}

// ── Main App component ──

export function App({
  bridge,
  agentType,
  model,
  provider,
  budget,
  maxSteps,
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
        // Keep at most 500 lines to prevent memory growth
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

          // Update main agent steps
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
          // Buffer stream text: append to the last stream line instead of
          // creating a new line per chunk. Split on newlines to create
          // separate lines when the model emits line breaks.
          const parts = d.text.split("\n");
          setOutputLines((prev) => {
            let next = [...prev];
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i];
              if (i === 0) {
                // First part: append to last line if it's a stream line
                const last = next[next.length - 1];
                if (last && last.type === "stream") {
                  next[next.length - 1] = {
                    ...last,
                    text: last.text + part,
                  };
                } else if (part) {
                  const id = ++lineIdRef.current;
                  next.push({ id, text: part, type: "stream", timestamp: Date.now() });
                }
              } else {
                // Subsequent parts (after a newline): always new line
                if (part || i < parts.length - 1) {
                  const id = ++lineIdRef.current;
                  next.push({ id, text: part, type: "stream", timestamp: Date.now() });
                }
              }
            }
            // Trim to max 500 lines
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
          addLine(
            `\n━━━ Task ${d.status.toUpperCase()} ─━━ Steps: ${d.steps} │ Cost: ¥${d.cost.toFixed(4)}`,
            "system"
          );
          break;
        }
      }
    };

    bridge.on("event", handler);
    return () => {
      bridge.off("event", handler);
    };
  }, [bridge, addLine]);

  // ── Keyboard input: approval flow ──

  useInput((input) => {
    if (!approvalRequest) return;
    const key = input.toLowerCase();
    if (key === "a") {
      bridge.resolveApproval(true);
      setApprovalRequest(undefined);
      addLine("  ✓ Approved", "system");
    } else if (key === "d") {
      bridge.resolveApproval(false);
      setApprovalRequest(undefined);
      addLine("  ✗ Denied", "system");
    }
  });

  // ── Auto-exit after done ──

  useEffect(() => {
    if (!isDone) return;
    const timer = setTimeout(() => {
      exit();
    }, 1200);
    return () => clearTimeout(timer);
  }, [isDone, exit]);

  // ── Render ──

  if (isDone) {
    const statusIcon =
      finalStatus === "success" ? "✓" : finalStatus === "error" ? "✗" : "⚠";
    const statusColor =
      finalStatus === "success"
        ? "green"
        : finalStatus === "error"
          ? "red"
          : "yellow";

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          {"\n"}
          <Text bold color={statusColor}>
            {statusIcon} {finalStatus.toUpperCase()}
          </Text>
          {" │ Steps: "}{currentStep} │ Cost: ¥{spent.toFixed(4)}
        </Text>
        <Text dimColor>{"  Dashboard session ended."}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {/* Top: Status + Cost */}
      <Box flexDirection="row">
        <StatusBar
          agentType={agentType}
          model={model}
          currentStep={currentStep}
          maxSteps={maxSteps}
          agents={agents}
        />
        <CostGauge spent={spent} budget={budget} provider={provider} />
      </Box>

      {/* Middle: Output */}
      <OutputPanel lines={outputLines} />

      {/* Bottom: Approval */}
      <ApprovalBar request={approvalRequest} />
    </Box>
  );
}



