import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import matter from "gray-matter";
import type { OrchestratorConfig } from "./types.js";
import type { AgentDefinition } from "../agent/types.js";

// ── .env file loader ──

/**
 * Load a .env file and populate process.env.
 * Format: KEY=VALUE per line, # for comments, empty lines ignored.
 * Does NOT override existing env vars (env vars take precedence).
 */
async function loadDotEnv(configPath: string): Promise<void> {
  const configDir = path.dirname(path.resolve(configPath));
  const envPath = path.join(configDir, ".env");

  try {
    const raw = await fs.readFile(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();

      // Don't override existing env vars
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file doesn't exist — that's fine
  }
}

// ── YAML config loader ──

export async function loadConfig(configPath: string): Promise<OrchestratorConfig> {
  // Load .env first (before reading config, so vars are available for substitution)
  await loadDotEnv(configPath);

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

/**
 * Save an AgentDefinition back to its source .md file.
 * Reconstructs the YAML frontmatter + markdown body using gray-matter.
 */
export async function saveAgent(sourcePath: string, definition: AgentDefinition): Promise<void> {
  const frontmatter: Record<string, unknown> = {
    model: definition.model,
    maxSteps: definition.maxSteps,
    timeout: definition.timeout,
  };
  if (definition.provider) frontmatter.provider = definition.provider;
  if (definition.description) frontmatter.description = definition.description;
  if (definition.isolation) frontmatter.isolation = definition.isolation;
  if (Object.keys(definition.tools).length > 0) frontmatter.tools = definition.tools;

  const output = matter.stringify(definition.systemPrompt, frontmatter);
  await fs.writeFile(sourcePath, output, "utf-8");
}
