import type { ModelProvider } from "../types/core.js";
import type { AgentDefinition } from "./types.js";

// ── Adapter selector ──

export class AdapterSelector {
  /**
   * Select the model provider for a task.
   *
   * Rules:
   * - If the agent definition specifies a provider, use it.
   * - Otherwise default to deepseek (stronger overall capabilities).
   */
  select(_task: string, definition: AgentDefinition): ModelProvider {
    if (definition.provider) return definition.provider;
    return "deepseek";
  }
}
