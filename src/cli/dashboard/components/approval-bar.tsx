/**
 * Approval bar component — bottom area for tool approval interaction.
 * Only rendered when there's a pending approval request.
 * Supports keyboard input: [A]pprove, [D]eny.
 */

import React from "react";
import { Box, Text } from "ink";
import { summarizeToolArgs } from "../../ansi.js";
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
      <Box borderStyle="single" borderColor="white">
        <Text dimColor>{" Ready"}</Text>
      </Box>
    );
  }

  const argsSummary = summarizeToolArgs(request.toolName, request.args);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="magenta">
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
