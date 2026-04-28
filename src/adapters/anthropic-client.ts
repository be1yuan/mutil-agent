// Shared Anthropic SDK client for both DeepSeek and GLM.
// Both providers expose Anthropic-compatible API endpoints.
// Actual provider differentiation is just baseURL — everything else is identical.

import Anthropic from "@anthropic-ai/sdk";
import type {
  ModelAdapter,
  ModelInfo,
  ChatParams,
  ChatResponse,
  ChatStreamChunk,
  Message,
  ToolResult,
  ContentBlock,
} from "./types.js";
import type { ModelProvider } from "../types/core.js";
import { getLogger } from "../observability/logger.js";

// ── Message format conversion ──

/**
 * Check if a message is a ToolResult (user message containing tool_result blocks).
 * Uses structural typing instead of `as` casts.
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
 * Convert our internal (Message | ToolResult)[] to Anthropic SDK format.
 * The key invariant: user/assistant must alternate; tool results are user messages
 * with tool_result blocks.
 */
function toAnthropicMessages(
  messages: (Message | ToolResult)[]
): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    if (isToolResult(msg)) {
      // Tool result — special user message
      result.push({
        role: "user",
        content: msg.content.map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.tool_use_id,
          content: b.content,
        })),
      });
    } else if (msg.role === "user") {
      // Regular user message
      result.push({
        role: "user",
        content: typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((b) => {
                if ("text" in b) return { type: "text" as const, text: b.text };
                return { type: "tool_result" as const, tool_use_id: b.tool_use_id, content: b.content };
              })
            : String(msg.content),
      });
    } else if (msg.role === "assistant") {
      // Assistant message
      result.push({
        role: "assistant",
        content: typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((b) => {
                if (b.type === "tool_use") {
                  return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input };
                }
                return { type: "text" as const, text: b.text };
              })
            : String(msg.content),
      });
    }
  }

  return result;
}

// ── Response conversion ──

function normalizeResponse(
  response: Anthropic.Messages.Message,
  provider: ModelProvider
): ChatResponse {
  const content: string[] = [];
  const toolCalls: ChatResponse["toolCalls"] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      content.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      });
    }
  }

  return {
    content: content.length > 0 ? content.join("\n") : null,
    toolCalls,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    stopReason: { type: response.stop_reason as ChatResponse["stopReason"]["type"] },
  };
}

// ── Adapter implementations ──

function createAnthropicClient(apiKey: string, baseURL: string): Anthropic {
  return new Anthropic({ apiKey, baseURL });
}

class BaseAnthropicAdapter implements ModelAdapter {
  readonly provider: ModelProvider;
  protected client: Anthropic;
  private info: ModelInfo;

  constructor(
    provider: ModelProvider,
    apiKey: string,
    baseURL: string,
    info: ModelInfo
  ) {
    this.provider = provider;
    this.client = createAnthropicClient(apiKey, baseURL);
    this.info = info;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    // Streaming mode: consume the stream internally, emit text deltas
    // via callback, but still return a complete ChatResponse.
    if (params.stream) {
      return this.chatViaStream(params);
    }

    // Non-streaming mode (original path)
    const response = await this.client.messages.create(this.buildRequestParams(params));
    return normalizeResponse(response, this.provider);
  }

  /**
   * Build Anthropic SDK request params from our ChatParams.
   */
  private buildRequestParams(params: ChatParams): Anthropic.Messages.MessageCreateParams {
    return {
      model: params.model,
      system: params.system,
      messages: toAnthropicMessages(params.messages),
      tools: params.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
      })),
      temperature: params.temperature,
      max_tokens: params.maxTokens ?? 4096,
    };
  }

  /**
   * Streaming implementation: uses the Anthropic streaming API internally,
   * emits text deltas via the onTextDelta callback, and accumulates a
   * complete ChatResponse for the caller.
   */
  private async chatViaStream(params: ChatParams): Promise<ChatResponse> {
    const textParts: string[] = [];
    const toolCalls: { id: string; name: string; inputJson: string }[] = [];
    let currentToolCall: { id: string; name: string; inputJson: string } | null = null;

    const stream = this.client.messages.stream(this.buildRequestParams(params));

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block as { type: string; id?: string; name?: string };
        if (block.type === "tool_use" && block.id && block.name) {
          currentToolCall = { id: block.id, name: block.name, inputJson: "" };
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === "text_delta" && delta.text) {
          textParts.push(delta.text);
          params.onTextDelta?.(delta.text);
        } else if (delta.type === "input_json_delta" && delta.partial_json && currentToolCall) {
          currentToolCall.inputJson += delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (currentToolCall) {
          toolCalls.push(currentToolCall);
          currentToolCall = null;
        }
      }
    }

    // Get final message for usage and stop reason
    let finalMessage: Anthropic.Messages.Message;
    try {
      finalMessage = await stream.finalMessage();
    } catch (finalErr) {
      const logger = getLogger();
      logger.error("adapter.stream_final_message_failed", {
        provider: this.provider,
        error: finalErr instanceof Error ? finalErr.message : String(finalErr),
      });
      // Stream was interrupted — return what we have so far
      return {
        content: textParts.length > 0 ? textParts.join("") : null,
        toolCalls: [], // Can't safely parse without final message
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: { type: "max_tokens" },
      };
    }

    // Parse tool call arguments safely
    const parsedToolCalls: ChatResponse["toolCalls"] = [];
    for (const tc of toolCalls) {
      try {
        parsedToolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: tc.inputJson ? JSON.parse(tc.inputJson) : {},
        });
      } catch (parseErr) {
        const logger = getLogger();
        logger.warn("adapter.tool_parse_failed", {
          provider: this.provider,
          toolName: tc.name,
          rawJson: tc.inputJson.slice(0, 500),
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
        parsedToolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: { _raw: tc.inputJson, _parseError: String(parseErr) },
        });
      }
    }

    return {
      content: textParts.length > 0 ? textParts.join("") : null,
      toolCalls: parsedToolCalls,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        cacheReadTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
      },
      stopReason: { type: finalMessage.stop_reason as ChatResponse["stopReason"]["type"] },
    };
  }

  /**
   * Public streaming API: yields ChatStreamChunk objects.
   * Handles both text deltas and tool_use blocks.
   */
  async *chatStream(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    const stream = this.client.messages.stream(this.buildRequestParams(params));

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === "text_delta" && delta.text) {
          yield { content: delta.text };
        }
      } else if (event.type === "message_stop") {
        const msg = await stream.finalMessage();
        const toolCalls: ChatResponse["toolCalls"] = [];
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, unknown>,
            });
          }
        }
        yield {
          content: undefined,
          usage: {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
          },
          stopReason: { type: msg.stop_reason as ChatResponse["stopReason"]["type"] },
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
      }
    }
  }

  getModelInfo(): ModelInfo {
    return this.info;
  }
}

// ── Concrete adapters ──

export class DeepSeekAdapter extends BaseAnthropicAdapter {
  constructor(apiKey: string) {
    super("deepseek", apiKey, "https://api.deepseek.com/anthropic", {
      name: "deepseek-v4-pro",
      provider: "deepseek",
      contextWindow: 1_000_000,
      pricing: { input: 0.41, output: 0.82, cacheHit: 0.0034 },
      capabilities: {
        toolCalling: true,
        streaming: true,
        jsonMode: true,
        thinking: true,
      },
    });
  }
}

export class GLMAdapter extends BaseAnthropicAdapter {
  constructor(apiKey: string) {
    super("zhipu", apiKey, "https://open.bigmodel.cn/api/anthropic", {
      name: "glm-5.1",
      provider: "zhipu",
      contextWindow: 200_000,
      pricing: { input: 1.0, output: 3.2 },
      capabilities: {
        toolCalling: true,
        streaming: true,
        jsonMode: true,
        thinking: true,
      },
    });
  }
}
