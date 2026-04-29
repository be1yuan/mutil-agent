/**
 * Agent tree component — displays the hierarchy of running agents
 * with their current status.
 */

import React from "react";
import { Box, Text } from "ink";
import type { AgentInfo } from "../types.js";

interface AgentTreeProps {
  agents: Map<string, AgentInfo>;
  mainAgentType: string;
}

const STATUS_ICON: Record<string, string> = {
  running: "◌",
  done: "✓",
  waiting: "○",
  error: "✗",
};

const STATUS_COLOR: Record<string, string> = {
  running: "cyan",
  done: "green",
  waiting: "gray",
  error: "red",
};

export function AgentTree({ agents, mainAgentType }: AgentTreeProps) {
  if (agents.size === 0) {
    return (
      <Text dimColor>
        {" "} {STATUS_ICON.running} {mainAgentType} <Text color="cyan">[running]</Text>
      </Text>
    );
  }

  const lines: React.ReactNode[] = [];

  // Main agent always first
  const mainStatus = agents.get(mainAgentType)?.status ?? "running";
  lines.push(
    <Text key="main">
      {" "} {STATUS_ICON[mainStatus] ?? "●"} {mainAgentType}{" "}
      <Text color={STATUS_COLOR[mainStatus] ?? "white"}>
        [{mainStatus}]
      </Text>
    </Text>
  );

  // Sub-agents
  const subAgents = Array.from(agents.values()).filter(
    (a) => a.agentType !== mainAgentType
  );

  for (let i = 0; i < subAgents.length; i++) {
    const agent = subAgents[i];
    const isLast = i === subAgents.length - 1;
    const connector = isLast ? " └▸ " : " ├▸ ";
    const icon = STATUS_ICON[agent.status] ?? "●";
    const color = STATUS_COLOR[agent.status] ?? "white";

    lines.push(
      <Text key={agent.agentType}>
        {connector}{icon} {agent.agentType}{" "}
        <Text color={color}>[{agent.status}]</Text>
        {agent.steps > 0 ? <Text dimColor> {agent.steps} steps</Text> : null}
      </Text>
    );
  }

  return <Box flexDirection="column">{lines}</Box>;
}
