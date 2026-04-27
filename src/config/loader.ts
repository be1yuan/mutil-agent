import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import matter from "gray-matter";
import type { OrchestratorConfig } from "./types.js";
import type { AgentDefinition } from "../agent/types.js";

// ── YAML config loader ──

export async function loadConfig(configPath: string): Promise<OrchestratorConfig> {
  const raw = await fs.readFile(configPath, "utf-8");
  // Simple env substitution: ${VAR} or ${VAR:-default}
  const substituted = raw.replace(/\$\{(\w+)(?::-([^}]+))?\}/g, (_match, varName, defaultValue) => {
    return process.env[varName] ?? defaultValue ?? "";
  });
  const parsed = YAML.parse(substituted);
  return parsed as OrchestratorConfig;
}

// ── Markdown agent definition loader ──

export interface LoadedAgent {
  definition: AgentDefinition;
  sourcePath: string;
}

export async function loadAgents(agentsDir: string): Promise<Map<string, LoadedAgent>> {
  const agents = new Map<string, LoadedAgent>();

  let entries: string[] = [];
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    // Directory doesn't exist — return empty
    return agents;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = path.join(agentsDir, entry);
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = matter(raw);

    const agentType = entry.replace(/\.md$/, "");
    const frontmatter = parsed.data as Record<string, unknown>;

    const definition: AgentDefinition = {
      agentType,
      model: String(frontmatter.model ?? ""),
      provider: frontmatter.provider as AgentDefinition["provider"],
      description: frontmatter.description ? String(frontmatter.description) : undefined,
      systemPrompt: parsed.content,
      tools: (frontmatter.tools as Record<string, import("../agent/types.js").ToolPermission>) ?? {},
      maxSteps: Number(frontmatter.maxSteps ?? 50),
      timeout: Number(frontmatter.timeout ?? 300_000),
      isolation: frontmatter.isolation as "context" | "worktree" | undefined,
    };

    agents.set(agentType, { definition, sourcePath: filePath });
  }

  return agents;
}
