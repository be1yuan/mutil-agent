/**
 * Output panel component — central scrolling area that displays
 * agent output lines (stream text, tool results, step markers).
 */

import React from "react";
import { Box, Text } from "ink";
import type { OutputLine } from "../types.js";

interface OutputPanelProps {
  lines: OutputLine[];
  maxHeight?: number;
}

/** Color for each output line type */
const LINE_COLOR: Record<OutputLine["type"], string | undefined> = {
  stream: undefined,    // default color
  tool: "cyan",
  step: "yellow",
  system: "gray",
};

export function OutputPanel({ lines, maxHeight = 20 }: OutputPanelProps) {
  // Show only the most recent lines that fit
  const visible = lines.slice(-maxHeight);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="white">
      <Box flexDirection="column" marginLeft={1} minHeight={maxHeight}>
        {visible.length === 0 ? (
          <Text dimColor>{"  (waiting for output...)"}</Text>
        ) : (
          visible.map((line) => (
            <Text key={line.id} color={LINE_COLOR[line.type]}>
              {" "}{line.text}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
