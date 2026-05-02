import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const _moduleDir = path.dirname(fileURLToPath(import.meta.url));

interface InitOptions {
  dashboard?: boolean;
}

const TEMPLATE_DIR = path.join(_moduleDir, "..", "..", "templates");

const AGENT_FILES = [
  "main.md",
  "explore.md",
  "coder.md",
  "reviewer.md",
  "architect.md",
];

export async function initProject(options: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();

  // 1. orchestrator.yaml
  await copyTemplate(
    path.join(TEMPLATE_DIR, "orchestrator.yaml.example"),
    path.join(cwd, "orchestrator.yaml")
  );

  // 2. .env.example
  await copyTemplate(
    path.join(TEMPLATE_DIR, ".env.example"),
    path.join(cwd, ".env.example")
  );

  // 3. .agents/*.md
  const agentsDir = path.join(cwd, ".agents");
  await fs.mkdir(agentsDir, { recursive: true });

  for (const agentFile of AGENT_FILES) {
    await copyTemplate(
      path.join(TEMPLATE_DIR, "agents", agentFile),
      path.join(agentsDir, agentFile)
    );
  }

  // 4. --dashboard: scaffold package.json with ink + react
  if (options.dashboard) {
    const pkgPath = path.join(cwd, "package.json");
    try {
      await fs.access(pkgPath);
      console.log(`  ⚠️  package.json already exists — skipping dashboard scaffold`);
      console.log(`     To enable dashboard, add manually: npm install ink react`);
    } catch {
      const pkg = {
        name: path.basename(cwd),
        version: "0.0.0",
        private: true,
        type: "module",
        description: "Agent-orch project with dashboard support",
        dependencies: {
          ink: "^5.0.0",
          react: "^18.3.0",
        },
      };
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      console.log("  ✓ Created package.json (dashboard dependencies)");
      console.log();
      console.log("  Run `npm install` to install ink + react for dashboard mode.");
    }
  }

  // Next steps
  console.log();
  console.log("  Next steps:");
  console.log("    1. cp .env.example .env    # Edit and add your API keys");
  console.log('    2. agent-orch run "your first task"');
}

async function copyTemplate(src: string, dest: string): Promise<void> {
  const name = path.basename(dest);
  try {
    await fs.access(dest);
    console.log(`  ⚠️  ${name} already exists — skipping`);
    return;
  } catch {
    // File does not exist, proceed
  }

  try {
    await fs.access(src);
  } catch {
    console.error(`  ✗ Template not found: ${src}`);
    return;
  }

  await fs.copyFile(src, dest);
  console.log(`  ✓ Created ${name}`);
}
