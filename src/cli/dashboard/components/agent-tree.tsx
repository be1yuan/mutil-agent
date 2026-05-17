/**
 * Agent tree component — displays the hierarchy of running agents
 * with their current status.
 */

import React from "react";
import { Box, Text } from "ink";
import { STATUS_COLOR, STATUS_ICON } from "../theme.js";
import type { AgentInfo } from "../types.js";

interface AgentTreeProps {
  agents: Map<string, AgentInfo>;
  mainAgentType: string;
}

export function AgentTree({ agents, mainAgentType }: AgentTreeProps) {
  if (agents.size === 0) {
    return (
      <Text color="cyan">
        {"  "}{STATUS_ICON.running} {mainAgentType} [initializing...]
      </Text>
    );
  }

  const allDone = Array.from(agents.values()).every(
    (a) => a.status === "done" || a.status === "error"
  );

  const mainStatus = agents.get(mainAgentType)?.status ?? "running";
  const mainColor = allDone ? "gray" : STATUS_COLOR[mainStatus] ?? "white";

  // Sub-agents
  const subAgents = Array.from(agents.values()).filter(
    (a) => a.agentType !== mainAgentType
  );

  return (
    <Box flexDirection="column">
      {/* Main agent */}
      <Text>
        {" "} {STATUS_ICON[mainStatus] ?? "●"} {mainAgentType}{" "}
        <Text color={mainColor}>
          [{mainStatus}]
        </Text>
      </Text>

      {/* Sub-agents */}
      {subAgents.map((agent, i) => {
        const isLast = i === subAgents.length - 1;
        const connector = isLast ? " └▸ " : " ├▸ ";
        const icon = STATUS_ICON[agent.status] ?? "●";
        const color = allDone ? "gray" : STATUS_COLOR[agent.status] ?? "white";

        return (
          <Text key={agent.agentType}>
            {connector}{icon} {agent.agentType}{" "}
            <Text color={color}>[{agent.status}]</Text>
            {agent.steps > 0 ? <Text dimColor> {agent.steps} steps</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
