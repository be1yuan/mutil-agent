// OpenAI-compatible API adapter.
// Used for providers that expose standard OpenAI-format endpoints
// (e.g. DashScope-hosted Kimi/Qwen models).
// Uses fetch directly — no additional SDK dependency needed.

import type {
  ModelAdapter,
  ModelInfo,
  ChatParams,
  ChatResponse,
  ChatStreamChunk,
  ContentBlock,
  Message,
  ToolResult,
} from "./types.js";
import type { ModelProvider } from "../types/core.js";
import { getLogger } from "../observability/logger.js";

// ── OpenAI API types ──

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAICompletionToolCall[];
  tool_call_id?: string;
}

interface OpenAICompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    param?: string | null;
  };
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  choices: Array<{
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
    index: number;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  model: string;
}

interface OpenAICompletionResponse {
  id: string;
  object: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAICompletionToolCall[];
    };
    finish_reason: string | null;
    index: number;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  model: string;
}

// ── Message format conversion ──

/**
 * Check if a message is a ToolResult (user message containing tool_result blocks).
 */
function isToolResult(msg: Message | ToolResult): msg is ToolResult {
  return (
    msg.role === "user" &&
    "content" in msg &&
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    "tool_use_id" in msg.content[0]
  );
}

/**
 * Convert our internal (Message | ToolResult)[] to OpenAI message format.
 *
 * Key differences from Anthropic format:
 *  - System prompt is a system message at index 0, not a separate parameter
 *  - Tool calls live in assistant.tool_calls[]
 *  - Tool results use role: "tool" with tool_call_id
 *  - No thinking block support (skipped silently)
 */
function toOpenAIMessages(
  messages: (Message | ToolResult)[],
  system?: string
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System prompt → system message
  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    if (isToolResult(msg)) {
      // Tool result → OpenAI tool role
      for (const block of msg.content) {
        result.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      }
    } else if (msg.role === "user") {
      // User message: string content → direct, array → join text blocks
      const content = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
              .map((b) => b.text)
              .join("\n")
          : String(msg.content);
      result.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Split content blocks: text → content, tool_use → tool_calls
        const textParts: string[] = [];
        const toolCalls: OpenAICompletionToolCall[] = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
          // thinking blocks are not supported by OpenAI — skip silently
        }

        const entry: OpenAIMessage = {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("\n") : null,
        };
        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls;
        }
        result.push(entry);
      }
    }
  }

  return result;
}

/**
 * Convert our ToolDefinition[] to OpenAI tool format.
 */
function toOpenAITools(
  tools?: ChatParams["tools"]
): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }));
}

/**
 * Normalize OpenAI finish_reason to our StopReason format.
 */
function normalizeStopReason(
  finishReason: string | null
): ChatResponse["stopReason"] {
  switch (finishReason) {
    case "stop":
      return { type: "end_turn" };
    case "length":
      return { type: "max_tokens" };
    case "tool_calls":
      return { type: "tool_use" };
    case "content_filter":
      return { type: "refusal" };
    default:
      return { type: "stop_sequence" };
  }
}

/**
 * Normalize a non-streaming OpenAI response to our ChatResponse format.
 */
function normalizeResponse(
  data: OpenAICompletionResponse
): ChatResponse {
  const choice = data.choices[0];
  const message = choice.message;

  const content = message.content ?? undefined;
  const toolCalls: ChatResponse["toolCalls"] = [];
  const contentBlocks: ContentBlock[] = [];

  // Text content
  if (content) {
    contentBlocks.push({ type: "text", text: content });
  }

  // Tool calls
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(tc.function.arguments);
      } catch {
        parsed = { _raw: tc.function.arguments };
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, arguments: parsed });
      contentBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsed,
      });
    }
  }

  return {
    content: content ?? null,
    toolCalls,
    contentBlocks,
    usage: {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0, // OpenAI doesn't expose this
    },
    stopReason: normalizeStopReason(choice.finish_reason),
  };
}

/**
 * Parse an OpenAI API error response into a useful Error.
 */
function parseOpenAIError(
  status: number,
  bodyText: string
): Error {
  try {
    const body = JSON.parse(bodyText) as OpenAIErrorBody;
    const msg = body.error?.message ?? bodyText.slice(0, 200);
    const code = body.error?.code ?? "unknown";
    const err = new Error(`OpenAI API error (${status}): ${msg} [code: ${code}]`);
    (err as any).status = status;
    return err;
  } catch {
    return new Error(`OpenAI API error (${status}): ${bodyText.slice(0, 200)}`);
  }
}

// ── Adapter ──

export class OpenAIAdapter implements ModelAdapter {
  readonly provider: ModelProvider;
  private apiKey: string;
  private baseURL: string;
  private info: ModelInfo;
  private nativeSearch: boolean;

  constructor(
    provider: ModelProvider,
    apiKey: string,
    baseURL: string,
    info: ModelInfo,
    nativeSearch = false
  ) {
    this.provider = provider;
    this.apiKey = apiKey;
    // Normalize: strip trailing slashes and /chat/completions suffix
    this.baseURL = baseURL
      .replace(/\/chat\/completions$/, "")
      .replace(/\/+$/, "");
    this.info = info;
    this.nativeSearch = nativeSearch;
  }

  getModelInfo(): ModelInfo {
    return this.info;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    if (params.stream) {
      return this.chatViaStream(params);
    }

    const body = this.buildRequestBody(params);
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw parseOpenAIError(response.status, bodyText);
    }

    const data = (await response.json()) as OpenAICompletionResponse;
    return normalizeResponse(data);
  }

  /**
   * Streaming implementation: reads SSE events from the response body
   * and emits ChatStreamChunk objects.
   */
  async *chatStream(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    const body = this.buildRequestBody(params, true);
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw parseOpenAIError(response.status, bodyText);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulators for building final tool calls across chunks
    const toolCallAccumulators: Map<
      number,
      { id: string; name: string; arguments: string }
    > = new Map();
    let accumulatedContent = "";
    let accumulatedUsage: ChatStreamChunk["usage"];
    let accumulatedStopReason: ChatStreamChunk["stopReason"];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (trimmed === "data: [DONE]") continue;

          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            try {
              const chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
              const delta = chunk.choices?.[0]?.delta;

              // Text delta
              if (delta?.content) {
                accumulatedContent += delta.content;
                yield { content: delta.content };
              }

              // Tool call deltas
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  let acc = toolCallAccumulators.get(tc.index);
                  if (!acc) {
                    acc = {
                      id: tc.id ?? "",
                      name: tc.function?.name ?? "",
                      arguments: "",
                    };
                    toolCallAccumulators.set(tc.index, acc);
                  }
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name) acc.name = tc.function.name;
                  if (tc.function?.arguments) {
                    acc.arguments += tc.function.arguments;
                  }
                }
              }

              // Finish reason
              const finishReason = chunk.choices?.[0]?.finish_reason;
              if (finishReason) {
                accumulatedStopReason = normalizeStopReason(finishReason);
              }

              // Usage (may appear in final chunk)
              if (chunk.usage) {
                accumulatedUsage = {
                  inputTokens: chunk.usage.prompt_tokens,
                  outputTokens: chunk.usage.completion_tokens,
                  cacheReadTokens:
                    chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                  cacheWriteTokens: 0,
                };
              }
            } catch {
              // Malformed JSON in a chunk — skip
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Build final tool calls from accumulators
    const toolCalls: ChatResponse["toolCalls"] = [];
    for (const acc of toolCallAccumulators.values()) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(acc.arguments || "{}");
      } catch {
        parsed = { _raw: acc.arguments };
      }
      toolCalls.push({ id: acc.id, name: acc.name, arguments: parsed });
    }

    yield {
      content: undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: accumulatedUsage,
      stopReason: accumulatedStopReason,
    };
  }

  // ── Private helpers ──

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private buildRequestBody(
    params: ChatParams,
    stream = false
  ): Record<string, unknown> {
    const tools = toOpenAITools(params.tools);
    const body: Record<string, unknown> = {
      model: params.model,
      messages: toOpenAIMessages(params.messages, params.system),
      max_tokens: params.maxTokens ?? 4096,
      stream,
    };

    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    // Native web search is not supported by the generic OpenAI adapter.
    // Providers like DashScope may offer search via their own params,
    // but that requires provider-specific handling.

    return body;
  }

  /**
   * Streaming internal helper: consume the full stream and return a ChatResponse.
   */
  private async chatViaStream(params: ChatParams): Promise<ChatResponse> {
    const textParts: string[] = [];
    const toolCallAccumulators: Map<
      number,
      { id: string; name: string; arguments: string }
    > = new Map();

    const body = this.buildRequestBody(params, true);
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw parseOpenAIError(response.status, bodyText);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    const decoder = new TextDecoder();
    let buffer = "";
    let finalUsage: ChatResponse["usage"] | undefined;
    let finalStopReason: ChatResponse["stopReason"] | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (trimmed === "data: [DONE]") continue;

          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            try {
              const chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
              const delta = chunk.choices?.[0]?.delta;

              if (delta?.content) {
                textParts.push(delta.content);
                params.onTextDelta?.(delta.content);
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  let acc = toolCallAccumulators.get(tc.index);
                  if (!acc) {
                    acc = {
                      id: tc.id ?? "",
                      name: tc.function?.name ?? "",
                      arguments: "",
                    };
                    toolCallAccumulators.set(tc.index, acc);
                  }
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name) acc.name = tc.function.name;
                  if (tc.function?.arguments) {
                    acc.arguments += tc.function.arguments;
                  }
                }
              }

              const finishReason = chunk.choices?.[0]?.finish_reason;
              if (finishReason) {
                finalStopReason = normalizeStopReason(finishReason);
              }

              if (chunk.usage) {
                finalUsage = {
                  inputTokens: chunk.usage.prompt_tokens,
                  outputTokens: chunk.usage.completion_tokens,
                  cacheReadTokens:
                    chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                  cacheWriteTokens: 0,
                };
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ChatResponse["toolCalls"] = [];
    const contentBlocks: ContentBlock[] = [];

    if (textParts.length > 0) {
      const text = textParts.join("");
      contentBlocks.push({ type: "text", text });
    }

    for (const acc of toolCallAccumulators.values()) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(acc.arguments || "{}");
      } catch {
        parsed = { _raw: acc.arguments };
      }
      toolCalls.push({ id: acc.id, name: acc.name, arguments: parsed });
      contentBlocks.push({
        type: "tool_use",
        id: acc.id,
        name: acc.name,
        input: parsed,
      });
    }

    const logger = getLogger();
    if (!finalUsage) {
      logger.warn("adapter.openai.missing_usage", {
        provider: this.provider,
        message: "No usage data in stream — using zeros",
      });
    }

    return {
      content: textParts.length > 0 ? textParts.join("") : null,
      toolCalls,
      contentBlocks,
      usage: finalUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      stopReason: finalStopReason ?? { type: "end_turn" },
    };
  }
}
