/**
 * Status bar component — top-left area showing agent status tree
 * and current step counter.
 */

import React from "react";
import { Box, Text } from "ink";
import { AgentTree } from "./agent-tree.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import type { AgentInfo } from "../types.js";

interface StatusBarProps {
  agentType: string;
  model: string;
  currentStep: number;
  maxSteps: number;
  agents: Map<string, AgentInfo>;
  startTime?: number;
}

export function StatusBar({
  agentType,
  model,
  currentStep,
  maxSteps,
  agents,
  startTime,
}: StatusBarProps) {
  const { columns } = useTerminalSize();
  const width = columns >= 100 ? "45%" : "40%";

  const elapsedText =
    startTime !== undefined ? formatElapsed(Date.now() - startTime) : null;

  let totalAgents = 0;
  let runningAgents = 0;
  let doneAgents = 0;
  for (const info of agents.values()) {
    totalAgents++;
    if (info.status === "running") runningAgents++;
    else if (info.status === "done") doneAgents++;
  }

  return (
    <Box flexDirection="column" width={width} paddingLeft={1}>
      <Box flexDirection="column">
        <AgentTree agents={agents} mainAgentType={agentType} />
        <Text dimColor>
          {"  Model: "}{model}
        </Text>
        <Text dimColor>
          {"  Step: "}{currentStep}/{maxSteps}
        </Text>
        <Text dimColor>
          {"  Agents: "}{totalAgents}{" ("}{runningAgents}{" running, "}{doneAgents}{" done)"}
        </Text>
        {elapsedText !== null && (
          <Text dimColor>
            {"  Elapsed: "}{elapsedText}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
