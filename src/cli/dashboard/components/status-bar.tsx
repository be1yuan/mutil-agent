/**
 * Status bar component — top-left area showing agent status tree
 * and current step counter.
 */

import React from "react";
import { Box, Text } from "ink";
import { AgentTree } from "./agent-tree.js";
import type { AgentInfo } from "../types.js";

interface StatusBarProps {
  agentType: string;
  model: string;
  currentStep: number;
  maxSteps: number;
  agents: Map<string, AgentInfo>;
}

export function StatusBar({
  agentType,
  model,
  currentStep,
  maxSteps,
  agents,
}: StatusBarProps) {
  return (
    <Box flexDirection="column" width="50%" borderStyle="classic" borderColor="cyan" paddingLeft={1}>
      <Box flexDirection="column">
        <AgentTree agents={agents} mainAgentType={agentType} />
        <Text dimColor>
          {"  Model: "}{model}
        </Text>
        <Text dimColor>
          {"  Step: "}{currentStep}/{maxSteps}
        </Text>
      </Box>
    </Box>
  );
}
