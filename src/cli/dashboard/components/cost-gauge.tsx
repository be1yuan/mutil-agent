/**
 * Cost gauge component — top-right area showing budget consumption
 * with a visual progress bar and percentage.
 */

import React from "react";
import { Box, Text } from "ink";

interface CostGaugeProps {
  spent: number;
  budget: number;
  provider?: string;
}

export function CostGauge({ spent, budget, provider }: CostGaugeProps) {
  const ratio = budget > 0 ? spent / budget : 0;
  const clamped = Math.max(0, Math.min(1, ratio));
  const width = 16;
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pct = (clamped * 100).toFixed(1);

  // Color based on budget usage
  let barColor: string;
  if (clamped > 0.8) barColor = "red";
  else if (clamped > 0.5) barColor = "yellow";
  else barColor = "green";

  return (
    <Box flexDirection="column" width="50%" borderStyle="classic" borderColor="yellow" paddingLeft={1}>
      <Text>
        {" Spent: "}
        <Text color={barColor}>¥{spent.toFixed(4)}</Text>
        {" / ¥"}{budget.toFixed(2)}
      </Text>
      <Text>
        {" "}
        <Text color={barColor}>[{bar}]</Text>
        {" "}{pct}%
      </Text>
      {provider ? (
        <Text dimColor>
          {" Provider: "}{provider}
        </Text>
      ) : null}
    </Box>
  );
}
