/**
 * Approval bar component — bottom area for tool approval interaction.
 * Only rendered when there's a pending approval request.
 * Supports keyboard input: [A]pprove, [D]eny.
 */

import React from "react";
import { Box, Text } from "ink";
import { summarizeToolArgs, truncate } from "../../ansi.js";
import type { ApprovalRequest } from "../types.js";

interface ApprovalBarProps {
  request?: ApprovalRequest;
  onApprove?: () => void;
  onDeny?: () => void;
}

export function ApprovalBar({ request, onApprove, onDeny }: ApprovalBarProps) {
  if (!request) {
    // No pending approval — show a minimal bottom border
    return (
      <Box>
        <Text dimColor>{"  ◌  Agent running..."}</Text>
      </Box>
    );
  }

  const argsSummary = truncate(summarizeToolArgs(request.toolName, request.args), 80);

  return (
    <Box flexDirection="column">
      <Box marginLeft={1}>
        <Text>
          {" Tool: "}
          <Text bold color="yellow">{request.toolName}</Text>
          {" │ "}{argsSummary}
        </Text>
      </Box>

      <Box marginLeft={1}>
        <Text>
          {" Agent: "}
          <Text color="cyan">{request.agentType}</Text>
          {" │ "}
          <Text bold color="green">[A]</Text>pprove{" "}
          <Text bold color="red">[D]</Text>eny
        </Text>
      </Box>
    </Box>
  );
}
