/**
 * Output panel component — central scrolling area that displays
 * agent output lines (stream text, tool results, step markers).
 */

import React from "react";
import { Box, Text } from "ink";
import { LINE_COLOR } from "../theme.js";
import type { OutputLine } from "../types.js";

interface OutputPanelProps {
  lines: OutputLine[];
  maxHeight?: number;
  isDone?: boolean;
}


export function OutputPanel({ lines, maxHeight = 20, isDone }: OutputPanelProps) {
  // Show only the most recent lines that fit
  const visible = lines.slice(-maxHeight);
  const overscroll = lines.length > maxHeight ? lines.length - maxHeight : 0;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginLeft={1} minHeight={maxHeight}>
        {visible.length === 0 ? (
          <Text dimColor>
            {isDone ? "  (no output)" : "  (waiting for output...)"}
          </Text>
        ) : (
          <>
            {overscroll > 0 && (
              <Text dimColor>
                {"  "}... {overscroll} more line{overscroll !== 1 ? "s" : ""}
              </Text>
            )}
            {visible.map((line) => (
              <Text key={line.id} color={LINE_COLOR[line.type]}>
                {" "}{line.text}
              </Text>
            ))}
          </>
        )}
      </Box>
    </Box>
  );
}
