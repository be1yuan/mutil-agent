/**
 * Memory tool definitions — MemoryRead / MemoryWrite / MemorySearch.
 *
 * These are registered in the agent's tool set so the LLM can
 * read, write, and search persistent memory during task execution.
 */

import type { ToolDefinition } from "../adapters/types.js";

export const memoryReadTool: ToolDefinition = {
  name: "MemoryRead",
  description:
    "Retrieve relevant facts, decisions, and context from persistent memory. " +
    "Use this before starting a task to recall past decisions and project knowledge.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keywords" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Filter by tags (e.g. architecture, decision, bug)",
      },
      type: {
        type: "string",
        enum: ["fact", "decision", "preference", "summary", "context"],
        description: "Filter by memory type",
      },
      limit: {
        type: "number",
        description: "Max results to return, default 10",
      },
    },
    required: ["query"],
  },
};

export const memoryWriteTool: ToolDefinition = {
  name: "MemoryWrite",
  description:
    "Write a fact, decision, or preference to persistent memory. " +
    "Use this after completing a task to record important learnings.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["fact", "decision", "preference", "context"],
        description: "Memory entry type",
      },
      content: {
        type: "string",
        description: "The content to store",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags for retrieval (e.g. [\"architecture\", \"conventions\"])",
      },
    },
    required: ["type", "content", "tags"],
  },
};

export const memorySearchTool: ToolDefinition = {
  name: "MemorySearch",
  description:
    "Search across all memory types. Returns ranked results by relevance.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keywords" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tag filters",
      },
    },
    required: ["query"],
  },
};

export const memoryTools: ToolDefinition[] = [
  memoryReadTool,
  memoryWriteTool,
  memorySearchTool,
];
