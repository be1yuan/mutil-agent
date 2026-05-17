/**
 * Dashboard design token system.
 * Centralizes colors, status mappings, spacing, and helper functions
 * to eliminate hardcoded values scattered across components.
 */

// ── Layer 1: Primitive color palette ──

const palette = {
  text: "white",
  textDim: "gray",
  textMuted: "gray",
  border: "gray",
  borderActive: "cyan",

  success: "green",
  warning: "yellow",
  error: "red",
  info: "cyan",
  running: "cyan",
  pending: "gray",
  done: "green",
} as const;

// ── Layer 2: Semantic mappings ──

export const STATUS_COLOR: Record<string, string> = {
  running: palette.running,
  done: palette.done,
  waiting: palette.pending,
  error: palette.error,
};

export const STATUS_ICON: Record<string, string> = {
  running: "◌",
  done: "✓",
  waiting: "○",
  error: "✗",
};

export const LINE_COLOR: Record<string, string | undefined> = {
  stream: undefined,
  tool: palette.info,
  step: palette.warning,
  system: palette.textDim,
};

// ── Layer 3: Spacing & layout tokens ──

export const spacing = {
  paddingX: 1,
  paddingY: 1,
  marginLeft: 1,
  gutter: 1,
} as const;

// ── Layer 4: Component tokens ──

export const components = {
  gauge: {
    dangerThreshold: 0.8,
    warningThreshold: 0.5,
    barWidth: 16,
    barChar: "█",
    emptyChar: "░",
  },
  output: {
    defaultMaxHeight: 20,
    doneMaxHeight: 12,
    bufferLimit: 500,
    trimTarget: 400,
  },
  divider: {
    defaultWidth: 60,
    char: "─",
  },
  layout: {
    minWide: 100,
    gaugeMinWidth: 30,
  },
} as const;

// ── Helper functions ──

export function getBudgetColor(ratio: number): string {
  if (ratio > components.gauge.dangerThreshold) return palette.error;
  if (ratio > components.gauge.warningThreshold) return palette.warning;
  return palette.success;
}

export function getDividerWidth(columns?: number): number {
  if (!columns || columns <= 0) return components.divider.defaultWidth;
  return Math.max(40, Math.min(columns - 2, 120));
}
