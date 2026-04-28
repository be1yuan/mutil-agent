import type { ModelProvider, Usage, StopReason } from "../types/core.js";

// ── Tool definitions (JSON Schema subset) ──

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ── Chat ──

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolResult {
  role: "user";
  content: ToolResultBlock[];
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface ChatParams {
  model: string;
  system?: string;
  messages: (Message | ToolResult)[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** If true, use streaming API internally but still return a complete ChatResponse */
  stream?: boolean;
  /** Callback for real-time text output when streaming */
  onTextDelta?: (text: string) => void;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
}

export interface ChatStreamChunk {
  content?: string;
  toolCall?: Partial<ToolCall>;
  /** Full tool calls list (available in message_stop chunk) */
  toolCalls?: ToolCall[];
  usage?: Usage;
  stopReason?: StopReason;
}

// ── Task tool (sub-agent spawn) ──

export interface SubAgentArgs {
  agentType: string;
  task: string;
  context?: {
    files?: string[];
    description?: string;
  };
}

export interface SubAgentResult {
  status: "success" | "error" | "budget_exceeded" | "max_steps_reached";
  content?: string;
  error?: string;
  steps: number;
  cost: number;
}

// ── Model adapter ──

export interface ModelInfo {
  name: string;
  provider: ModelProvider;
  contextWindow: number;
  pricing: {
    input: number;       // $/M tokens
    output: number;      // $/M tokens
    cacheHit?: number;   // $/M tokens
  };
  capabilities: {
    toolCalling: boolean;
    streaming: boolean;
    jsonMode: boolean;
    thinking: boolean;
  };
}

export interface ModelAdapter {
  readonly provider: ModelProvider;

  /** Non-streaming call */
  chat(params: ChatParams): Promise<ChatResponse>;

  /** Streaming call (v0.2) */
  chatStream(params: ChatParams): AsyncIterable<ChatStreamChunk>;

  /** Model metadata */
  getModelInfo(): ModelInfo;
}

// ── Fallback ──

export interface FallbackPolicy {
  maxRetries: number;
  retryDelayMs: number;
  retryableErrors: string[];
  fallbackModel?: { provider: ModelProvider; model: string };
}
