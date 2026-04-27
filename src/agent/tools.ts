import type { ToolDefinition } from "../adapters/types.js";

// ── Task tool: spawn sub-agent ──

export const taskTool: ToolDefinition = {
  name: "task",
  description:
    "Spawn a sub-agent to handle a subtask. Use this when the current task is complex and can be broken into smaller, independent pieces. The sub-agent runs in an isolated context and returns a summary of its work.",
  parameters: {
    type: "object",
    properties: {
      agentType: {
        type: "string",
        description: "The type of sub-agent to spawn (must match an agent definition in .agents/ directory, e.g. 'explore', 'coder', 'reviewer')",
      },
      task: {
        type: "string",
        description: "A clear, self-contained description of the subtask",
      },
      context: {
        type: "object",
        description: "Optional context to pass to the sub-agent",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "List of file paths the sub-agent should read",
          },
          description: {
            type: "string",
            description: "Additional context or constraints for the sub-agent",
          },
        },
      },
    },
    required: ["agentType", "task"],
  },
};

/**
 * Build a task tool with dynamic agentType enum from loaded agent definitions.
 * Falls back to plain string if no agents are loaded yet.
 */
export function buildTaskTool(agentTypes: string[]): ToolDefinition {
  if (agentTypes.length === 0) return taskTool;
  return {
    ...taskTool,
    parameters: {
      ...taskTool.parameters,
      properties: {
        ...taskTool.parameters.properties,
        agentType: {
          type: "string",
          enum: agentTypes,
          description: "The type of sub-agent to spawn (must match an agent definition in .agents/ directory)",
        },
      },
    },
  };
}

// ── Built-in tool definitions ──

export const readTool: ToolDefinition = {
  name: "Read",
  description: "Read the contents of a file at the specified path.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path to the file" },
    },
    required: ["filePath"],
  },
};

export const writeTool: ToolDefinition = {
  name: "Write",
  description: "Write content to a file at the specified path.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["filePath", "content"],
  },
};

export const editTool: ToolDefinition = {
  name: "Edit",
  description: "Replace a string in a file with another string.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path to the file" },
      oldString: { type: "string", description: "String to replace" },
      newString: { type: "string", description: "Replacement string" },
    },
    required: ["filePath", "oldString", "newString"],
  },
};

export const bashTool: ToolDefinition = {
  name: "Bash",
  description: "Execute a shell command with arguments array.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to execute" },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Command arguments",
      },
      cwd: { type: "string", description: "Working directory" },
    },
    required: ["command", "args"],
  },
};

export const grepTool: ToolDefinition = {
  name: "Grep",
  description: "Search for a pattern in file contents.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search" },
      path: { type: "string", description: "Directory or file to search in" },
    },
    required: ["pattern", "path"],
  },
};

export const globTool: ToolDefinition = {
  name: "Glob",
  description: "Find files matching a glob pattern.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search in" },
    },
    required: ["pattern", "path"],
  },
};

export const webSearchTool: ToolDefinition = {
  name: "WebSearch",
  description: "Search the web for information.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
};

export const webFetchTool: ToolDefinition = {
  name: "WebFetch",
  description: "Fetch and read a web page.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
};

/** All built-in tools */
export const allTools: ToolDefinition[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  globTool,
  webSearchTool,
  webFetchTool,
  taskTool,
];

/** Get tools filtered by what an agent is allowed to use */
export function getAllowedTools(
  allowedToolNames: string[],
  all: ToolDefinition[] = allTools,
  agentTypes: string[] = []
): ToolDefinition[] {
  const allowed = new Set(allowedToolNames);
  return all
    .filter((t) => allowed.has(t.name))
    .map((t) => {
      // Replace task tool with dynamic version if agentTypes provided
      if (t.name === "task" && agentTypes.length > 0) {
        return buildTaskTool(agentTypes);
      }
      return t;
    });
}
