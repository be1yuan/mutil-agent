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
import { OpenAIAdapter } from "./openai-client.js";
import type { ProviderConfig } from "../config/types.js";
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
                // tool_result block — structural check passed in isToolResult
                const tr = b as unknown as { tool_use_id: string; content: string };
                return { type: "tool_result" as const, tool_use_id: tr.tool_use_id, content: tr.content };
              })
            : String(msg.content),
      });
    } else if (msg.role === "assistant") {
      // Assistant message — must preserve thinking blocks for DeepSeek/Anthropic round-trip
      result.push({
        role: "assistant",
        content: typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((b) => {
                if (b.type === "tool_use") {
                  return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input };
                }
                if (b.type === "thinking") {
                  // DeepSeek/Anthropic require thinking blocks to be passed back verbatim
                  const tb = b as import("./types.js").ThinkingBlock;
                  const block: Anthropic.Messages.ThinkingBlockParam = {
                    type: "thinking" as const,
                    thinking: tb.thinking,
                    ...(tb.signature ? { signature: tb.signature } : {}),
                  } as Anthropic.Messages.ThinkingBlockParam;
                  return block;
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
  // Preserve thinking blocks for round-trip (DeepSeek/Anthropic require them)
  const contentBlocks: import("./types.js").ContentBlock[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      content.push(block.text);
      contentBlocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      });
      contentBlocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    } else if (block.type === "thinking") {
      // Preserve thinking block with signature for round-trip
      const thinkingBlock = block as { type: "thinking"; thinking: string; signature?: string };
      contentBlocks.push({
        type: "thinking",
        thinking: thinkingBlock.thinking,
        signature: thinkingBlock.signature,
      });
    } else if (block.type === "web_search_tool_result") {
      // Native web search results from the provider API.
      // Extract readable text from search results so they're visible in the output.
      const results = (block as any).content;
      if (Array.isArray(results)) {
        const searchLines = results.map((r: any) =>
          `- ${r.title ?? "(no title)"}: ${r.url ?? ""}`
        );
        content.push(`[web search results]\n${searchLines.join("\n")}`);
      }
    }
    // server_tool_use blocks are handled server-side — no client action needed
  }

  return {
    content: content.length > 0 ? content.join("\n") : null,
    toolCalls,
    contentBlocks,
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
  // Prevent the SDK from reading ANTHROPIC_AUTH_TOKEN env var and sending it
  // as a Bearer token. Some providers (e.g. DeepSeek) prioritize Bearer auth
  // over x-api-key, which causes 401 errors when ANTHROPIC_AUTH_TOKEN is set
  // to a different provider's key.
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  // Diagnostic: log masked API key at debug level for auth debugging
  const masked = apiKey.length > 10 ? apiKey.slice(0, 6) + "..." + apiKey.slice(-4) : "***";
  getLogger().debug(`[adapter] ${baseURL.split("/").slice(-2).join("/")} key=${masked}`);
  return new Anthropic({ apiKey, baseURL });
}

class BaseAnthropicAdapter implements ModelAdapter {
  readonly provider: ModelProvider;
  protected client: Anthropic;
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
    this.client = createAnthropicClient(apiKey, baseURL);
    this.info = info;
    this.nativeSearch = nativeSearch;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    // Streaming mode: consume the stream internally, emit text deltas
    // via callback, but still return a complete ChatResponse.
    if (params.stream) {
      return this.chatViaStream(params);
    }

    // Non-streaming mode (original path)
    // Cast to non-streaming return type — buildRequestParams never sets stream: true,
    // but the SDK's overload resolution sees the base params type and returns a union.
    const response = await this.client.messages.create(
      this.buildRequestParams(params)
    ) as Anthropic.Messages.Message;
    return normalizeResponse(response, this.provider);
  }

  /**
   * Build Anthropic SDK request params from our ChatParams.
   * When nativeSearch is enabled, injects a provider-native web_search tool
   * so the model can search the web without our custom WebSearch tool.
   */
  private buildRequestParams(params: ChatParams): Anthropic.Messages.MessageCreateParams {
    const tools: Anthropic.Messages.Tool[] = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
    })) ?? [];

    if (this.nativeSearch) {
      tools.push({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      } as unknown as Anthropic.Messages.Tool);
    }

    return {
      model: params.model,
      system: params.system,
      messages: toAnthropicMessages(params.messages),
      tools: tools.length > 0 ? tools : undefined,
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
        // thinking blocks are accumulated via finalMessage.content (includes signatures)
      } else if (event.type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === "text_delta" && delta.text) {
          textParts.push(delta.text);
          params.onTextDelta?.(delta.text);
        } else if (delta.type === "input_json_delta" && delta.partial_json && currentToolCall) {
          currentToolCall.inputJson += delta.partial_json;
        }
        // thinking_delta events are captured by finalMessage, no need to accumulate here
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

    // Build contentBlocks with thinking blocks for round-trip.
    // Prefer finalMessage's content blocks (they include signatures) over
    // our accumulated stream data.
    const contentBlocks: import("./types.js").ContentBlock[] = [];
    for (const block of finalMessage.content) {
      if (block.type === "thinking") {
        const tb = block as { type: "thinking"; thinking: string; signature?: string };
        contentBlocks.push({ type: "thinking", thinking: tb.thinking, signature: tb.signature });
      } else if (block.type === "text") {
        contentBlocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        contentBlocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
      // Skip web_search_tool_result etc. — not needed for round-trip
    }

    return {
      content: textParts.length > 0 ? textParts.join("") : null,
      toolCalls: parsedToolCalls,
      contentBlocks,
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
  constructor(apiKey: string, nativeSearch = false) {
    super("deepseek", apiKey, "https://api.deepseek.com/anthropic", {
      name: "deepseek-v4-pro",
      provider: "deepseek",
      contextWindow: 1_000_000,
      pricing: { input: 2.87, output: 5.74, cacheHit: 0.0238 }, // converted to yuan (RMB), 1 USD = 7 CNY
      capabilities: {
        toolCalling: true,
        streaming: true,
        jsonMode: true,
        thinking: true,
      },
    }, nativeSearch);
  }
}

export class GLMAdapter extends BaseAnthropicAdapter {
  constructor(apiKey: string) {
    super("zhipu", apiKey, "https://open.bigmodel.cn/api/anthropic", {
      name: "glm-5.1",
      provider: "zhipu",
      contextWindow: 200_000,
      pricing: { input: 7.0, output: 22.4 }, // converted to yuan (RMB), 1 USD = 7 CNY
      capabilities: {
        toolCalling: true,
        streaming: true,
        jsonMode: true,
        thinking: true,
      },
    });
  }
}

export class MiMoAdapter extends BaseAnthropicAdapter {
  constructor(apiKey: string, nativeSearch = false) {
    // MiMo's Anthropic-compatible endpoint does NOT use the standard
    // x-api-key header. It supports two auth methods:
    //   方式一: api-key: $MIMO_API_KEY
    //   方式二: Authorization: Bearer $MIMO_API_KEY
    //
    // The Anthropic SDK always sends x-api-key, which MiMo may reject.
    // We use a custom fetch override to strip x-api-key and inject the
    // correct auth header instead.
    super("mimo", "dummy", "https://api.xiaomimimo.com/anthropic", {
      name: "MiMo-V2.5-Pro",
      provider: "mimo",
      contextWindow: 1_000_000,
      pricing: { input: 7.0, output: 21.0, cacheHit: 1.4 }, // converted to yuan (RMB), 1 USD = 7 CNY
      capabilities: {
        toolCalling: true,
        streaming: true,
        jsonMode: true,
        thinking: true,
      },
    }, nativeSearch);
    // Re-create client with custom fetch to control auth headers
    this.client = new Anthropic({
      apiKey: "dummy",
      baseURL: "https://api.xiaomimimo.com/anthropic",
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.delete("x-api-key");
        // MiMo 方式一: api-key header (simpler than Bearer, matches the
        // API provider's recommended auth format)
        headers.set("api-key", apiKey);
        return fetch(url, { ...init, headers });
      },
    });
  }
}

// ── Format detection ──

/**
 * Detect whether a baseURL is an Anthropic-compatible endpoint or an
 * OpenAI-compatible one. Anthropic-compatible endpoints contain "/anthropic"
 * in their URL path (e.g. https://api.deepseek.com/anthropic).
 */
export function isAnthropicEndpoint(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return url.pathname.includes("/anthropic");
  } catch {
    // If URL parsing fails, fall back to string check
    return baseURL.includes("/anthropic");
  }
}

// ── Default model info catalog ──

/**
 * Default ModelInfo for providers that don't have a dedicated adapter class.
 * Used by the generic factory function for kimi, qwen, etc.
 */
export function getDefaultModelInfo(provider: ModelProvider): ModelInfo {
  switch (provider) {
    case "kimi":
      return {
        name: "kimi-k2.6",
        provider: "kimi",
        contextWindow: 128_000,
        pricing: { input: 8.0, output: 24.0 },
        capabilities: {
          toolCalling: true,
          streaming: true,
          jsonMode: true,
          thinking: false,
        },
      };
    case "qwen":
      return {
        name: "qwen-max",
        provider: "qwen",
        contextWindow: 128_000,
        pricing: { input: 4.0, output: 12.0 },
        capabilities: {
          toolCalling: true,
          streaming: true,
          jsonMode: true,
          thinking: false,
        },
      };
    default:
      return {
        name: provider,
        provider,
        contextWindow: 128_000,
        pricing: { input: 5.0, output: 15.0 },
        capabilities: {
          toolCalling: true,
          streaming: true,
          jsonMode: true,
          thinking: false,
        },
      };
  }
}

// ── Adapter factory ──

/**
 * Create a ModelAdapter for any provider by auto-detecting the API format
 * from the baseURL.
 *
 * - If baseURL contains "/anthropic" → Anthropic SDK adapter
 * - Otherwise → OpenAI-compatible adapter
 *
 * Known providers (deepseek, zhipu, mimo) use their dedicated adapter classes
 * for optimal compatibility. New providers use the generic detection path.
 */
export function createModelAdapter(
  provider: ModelProvider,
  config: ProviderConfig
): ModelAdapter {
  const { apiKey, baseURL, nativeSearch } = config;

  if (provider === "deepseek") {
    return new DeepSeekAdapter(apiKey, nativeSearch);
  }
  if (provider === "zhipu") {
    return new GLMAdapter(apiKey);
  }
  if (provider === "mimo") {
    return new MiMoAdapter(apiKey, nativeSearch);
  }

  // Unknown provider — auto-detect format from baseURL
  if (isAnthropicEndpoint(baseURL)) {
    const info = getDefaultModelInfo(provider);
    return new BaseAnthropicAdapter(provider, apiKey, baseURL, info, nativeSearch);
  }

  // OpenAI-compatible endpoint
  const info = getDefaultModelInfo(provider);
  return new OpenAIAdapter(provider, apiKey, baseURL, info, nativeSearch);
}
