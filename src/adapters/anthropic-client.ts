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

// ── Message format conversion ──

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
    if (msg.role === "user" && "content" in msg && Array.isArray(msg.content) && msg.content.length > 0 && (msg.content as unknown as { type: string }[])[0]?.type === "tool_result") {
      // Tool result — special user message
      result.push({
        role: "user",
        content: (msg as ToolResult).content.map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.tool_use_id,
          content: b.content,
        })),
      });
    } else if (msg.role === "user") {
      // Regular user message
      result.push({
        role: "user",
        content: typeof msg.content === "string" ? msg.content : msg.content as Anthropic.TextBlockParam[],
      });
    } else if (msg.role === "assistant") {
      // Assistant message
      result.push({
        role: "assistant",
        content: typeof msg.content === "string"
          ? msg.content
          : (msg.content as ContentBlock[]).map((b) => {
              if (b.type === "tool_use") {
                return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input };
              }
              return { type: "text" as const, text: b.text };
            }),
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
    const response = await this.client.messages.create({
      model: params.model,
      messages: toAnthropicMessages(params.messages),
      system: params.system,
      tools: params.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
      })),
      temperature: params.temperature,
      max_tokens: params.maxTokens ?? 4096,
    });

    return normalizeResponse(response, this.provider);
  }

  async *chatStream(params: ChatParams): AsyncIterable<ChatStreamChunk> {
    const stream = this.client.messages.stream({
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
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { content: event.delta.text };
      } else if (event.type === "message_stop") {
        const msg = await stream.finalMessage();
        yield {
          content: undefined,
          usage: {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          stopReason: { type: msg.stop_reason as ChatResponse["stopReason"]["type"] },
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
