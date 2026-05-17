/**
 * Cost gauge component — top-right area showing budget consumption
 * with a visual progress bar and percentage.
 */

import React from "react";
import { Box, Text } from "ink";
import { getBudgetColor, components } from "../theme.js";

interface CostGaugeProps {
  spent: number;
  budget: number;
  provider?: string;
  currentStep?: number;
}

export function CostGauge({ spent, budget, provider, currentStep }: CostGaugeProps) {
  const { barWidth, barChar, emptyChar } = components.gauge;
  const ratio = budget > 0 ? spent / budget : 0;
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * barWidth);
  const empty = barWidth - filled;
  const bar = barChar.repeat(filled) + emptyChar.repeat(empty);
  const pct = (clamped * 100).toFixed(1);
  const barColor = getBudgetColor(clamped);

  return (
    <Box flexDirection="column" width="50%" paddingLeft={1}>
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
      {currentStep && currentStep > 0 && spent > 0 ? (
        <Text dimColor>
          {" ~¥"}{(spent / currentStep).toFixed(4)}{"/step"}
        </Text>
      ) : null}
      {provider ? (
        <Text dimColor>
          {" Provider: "}{provider}
        </Text>
      ) : null}
    </Box>
  );
}
