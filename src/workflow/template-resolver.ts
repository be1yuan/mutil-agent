/**
 * Template resolver — interpolates ${var} and ${steps.id.content} references
 * in workflow step task strings.
 */

import type { StepResult } from "./types.js";

/**
 * Resolve all ${...} references in a template string.
 *
 * Supported patterns:
 *   ${varName}               → workflow-level variable
 *   ${steps.stepId.content}  → content output of a completed step
 *   ${steps.stepId.status}   → status of a completed step
 *   ${steps.stepId.cost}     → cost of a completed step
 *
 * Unknown references are left as-is (no error).
 */
export function resolveTemplate(
  template: string,
  variables: Record<string, string>,
  stepResults: Map<string, StepResult>
): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
    const trimmed = key.trim();

    // steps.xxx.yyy pattern
    const stepsMatch = trimmed.match(/^steps\.(\w+)\.(content|status|cost)$/);
    if (stepsMatch) {
      const [, stepId, field] = stepsMatch;
      const result = stepResults.get(stepId);
      if (!result) return _match; // step not found, leave as-is

      switch (field) {
        case "content":
          return result.result?.content ?? "";
        case "status":
          return result.status;
        case "cost":
          return String(result.result?.cost ?? 0);
      }
    }

    // Simple variable lookup
    if (Object.hasOwn(variables, trimmed)) {
      return variables[trimmed];
    }

    // Unknown reference — leave as-is
    return _match;
  });
}
