# DESIGN-v8: 打包分发方案

> 包名: **`agent-orch`**
> 状态: 设计完成，待 v1.0 实施

---

## 目标

让其他用户可以通过以下方式直接下载部署:

```
npm install -g agent-orch         # 全局安装
npx agent-orch init               # 一键脚手架
docker run agent-orch run "task"  # 容器化部署
GitHub Release 下载 zip/tar.gz    # 离线部署
```

---

## 1. 构建策略: esbuild 打包

### 为什么不用 tsc

| 维度 | tsc (现状) | esbuild (方案) |
|------|-----------|----------------|
| 输出 | `dist/` 目录 + node_modules (154MB) | 单个 bundle 文件 (~1-2MB) |
| CJS/ESM 互操作 | 依赖 Node 运行时转换 | 编译期自动处理 |
| 动态 import 拆分 | 不支持 | `splitting: true` 自动拆分 |
| 安装速度 | 需要 npm install 所有依赖 | 无需安装 node_modules |

### esbuild 配置

```javascript
// esbuild.config.mjs
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  splitting: true,           // ink/cheerio 动态 import 自动拆分为独立 chunk
  minify: false,             // 保留可读性便于调试
  sourcemap: true,
  external: [
    "ink", "react", "react-dom",  // TUI dashboard 可选依赖
    "cheerio",                     // HTML 解析可选依赖
  ],
  banner: { js: "#!/usr/bin/env node" },
});
```

### External 依赖策略

| 依赖 | 处理方式 | 原因 |
|------|---------|------|
| `@anthropic-ai/sdk` | 打入 bundle | 核心依赖，CJS 包由 esbuild 自动转换 |
| `commander` | 打入 bundle | CLI 框架，体积小 |
| `gray-matter` | 打入 bundle | frontmatter 解析 |
| `minimatch` | 打入 bundle | glob 匹配 |
| `winston` | 打入 bundle | 日志 |
| `yaml` | 打入 bundle | YAML 解析 |
| `zod` | 打入 bundle | schema 校验 |
| `ink` + `react` | **external** | 避免 "two Reacts" 问题（hooks 要求单一实例） |
| `cheerio` | **external** | 已有 regex fallback，运行时可选 |

### 构建脚本

```json
{
  "scripts": {
    "build": "node esbuild.config.mjs",
    "build:types": "tsc --emitDeclarationOnly",
    "prepublishOnly": "npm run build && npm run build:types"
  }
}
```

`build:types` 仅生成 `.d.ts` 类型声明，供库消费者使用。

---

## 2. 包结构

### 发布到 npm 的内容

```
agent-orch@1.0.0
├── dist/
│   ├── cli/main.js          # 打包后的 CLI 入口 (带 shebang)
│   ├── cli/main.js.map      # source map
│   └── ...                  # code-split chunks (ink/dashboard)
├── templates/
│   ├── agents/
│   │   ├── main.md
│   │   ├── explore.md
│   │   ├── coder.md
│   │   ├── reviewer.md
│   │   └── architect.md
│   ├── orchestrator.yaml.example
│   └── .env.example
├── package.json
├── README.md
└── LICENSE
```

### `files` 字段控制

```json
{
  "files": ["dist", "templates", "README.md", "LICENSE"]
}
```

仅发布必要文件，排除源码、测试、.agents、.env 等。

---

## 3. 依赖分类

### package.json 目标状态

```json
{
  "name": "agent-orch",
  "version": "1.0.0",
  "description": "Lightweight self-orchestrating multi-agent CLI for DeepSeek + GLM + MiMo",
  "type": "module",
  "bin": { "agent-orch": "dist/cli/main.js" },
  "files": ["dist", "templates", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "license": "MIT",
  "keywords": ["multi-agent", "cli", "orchestrator", "deepseek", "glm", "mimo", "llm"],

  "dependencies": {
    "@anthropic-ai/sdk": "^0.54.0",
    "commander": "^13.1.0",
    "gray-matter": "^4.0.3",
    "minimatch": "^10.0.3",
    "winston": "^3.17.0",
    "yaml": "^2.7.0",
    "zod": "^3.24.0"
  },
  "optionalDependencies": {
    "cheerio": "^1.2.0"
  },
  "peerDependencies": {
    "ink": "^5.0.0",
    "react": "^18.3.0"
  },
  "peerDependenciesMeta": {
    "ink": { "optional": true },
    "react": { "optional": true }
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "esbuild": "^0.27.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

### 变更对照

| 字段 | 现状 | 目标 | 原因 |
|------|------|------|------|
| `name` | `multi-agent-orchestrator` | `agent-orch` | 简洁好记 |
| `bin` | `multi-agent` | `agent-orch` | 与包名一致 |
| `files` | 无 | `["dist", "templates", ...]` | 控制 npm 发布内容 |
| `dependencies` | 含 cheerio/ink/react | 移除三者 | 分类到 optional/peer |
| `optionalDependencies` | 无 | `{ "cheerio" }` | 运行时可选 |
| `peerDependencies` | 无 | `{ "ink", "react" }` | dashboard 可选 |
| `license` | 无 | `"MIT"` | 必需 |
| `keywords` | 无 | 数组 | npm 可发现性 |

---

## 4. Init 命令

### 用户体验

```bash
$ mkdir my-project && cd my-project
$ agent-orch init

  ✓ Created orchestrator.yaml
  ✓ Created .env.example
  ✓ Created .agents/main.md
  ✓ Created .agents/explore.md
  ✓ Created .agents/coder.md
  ✓ Created .agents/reviewer.md
  ✓ Created .agents/architect.md

  Next steps:
    1. cp .env.example .env    # Edit and add your API keys
    2. agent-orch run "your first task"
```

### 实现要点

- 新建 `src/cli/init.ts`，导出 `initProject()` 函数
- 模板路径基于 `import.meta.url` 解析（esbuild ESM 输出保留此特性）
- 已存在的文件跳过 + 打印警告，绝不覆盖用户自定义
- `.env.example` 只复制模板，不复制 `.env`（含密钥）
- `--dashboard` 选项: 额外在 CWD 创建 package.json（含 ink+react），提示 `npm install`

### .env.example 更新

补全 MIMO_API_KEY:

```bash
# DeepSeek API Key (https://platform.deepseek.com)
DEEPSEEK_API_KEY=sk-your-deepseek-key-here

# Zhipu/GLM API Key (https://open.bigmodel.cn)
ZHIPU_API_KEY=your-zhipu-key-here

# MiMo API Key (https://api.xiaomimimo.com)
MIMO_API_KEY=your-mimo-key-here
```

---

## 5. Docker 支持

### Dockerfile (multi-stage)

```dockerfile
# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Stage 2: Runtime
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/package.json ./

# 安装 external 可选依赖
RUN npm install --omit=dev ink react react-dom cheerio 2>/dev/null || true

# 非 root 用户
RUN useradd -m agent
USER agent

ENTRYPOINT ["node", "dist/cli/main.js"]
```

### 用法

```bash
# 构建
docker build -t agent-orch .

# 运行任务（挂载当前目录为工作区）
docker run \
  -e DEEPSEEK_API_KEY=sk-... \
  -e ZHIPU_API_KEY=... \
  -e MIMO_API_KEY=... \
  -v $(pwd):/workspace \
  -w /workspace \
  agent-orch run "fix the authentication bug"

# 启动 API 服务
docker run \
  -e DEEPSEEK_API_KEY=sk-... \
  -p 3100:3100 \
  agent-orch serve --host 0.0.0.0 --port 3100
```

**关键**: `-w /workspace` 设置容器工作目录，CWD 相对路径解析自然生效。

### .dockerignore

```
node_modules
dist
.env
.env.local
.git
tests
logs
.claude
.mailbox
```

---

## 6. GitHub Release + CI

### CI 流水线 (`.github/workflows/ci.yml`)

PR 触发:
- `npm run typecheck`
- `npm test`

### Release 流水线 (`.github/workflows/release.yml`)

tag `v*` 触发:

1. checkout + setup node 20
2. `npm ci && npm run build`
3. 创建归档:
   - `agent-orch-{version}-linux-x64.tar.gz`
   - `agent-orch-{version}-win-x64.zip`
4. `npm publish` (需要 NPM_TOKEN secret)
5. `softprops/action-gh-release` 创建 Release 并附加归档

归档内容: `dist/` + `templates/` + `package.json` + `README.md` + `LICENSE`

---

## 7. 分发渠道总览

| 渠道 | 命令 | 适用场景 |
|------|------|---------|
| **npm 全局** | `npm install -g agent-orch` | 开发者日常使用 |
| **npx** | `npx agent-orch init` | 快速体验，无需全局安装 |
| **Docker** | `docker run agent-orch ...` | CI/CD、服务器部署、隔离环境 |
| **GitHub Release** | 下载 zip/tar.gz | 离线环境、无 npm 访问 |

---

## 8. 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Anthropic SDK 是 CJS，项目是 ESM | esbuild 编译期自动处理 CJS→ESM 转换 |
| `import.meta.url` 在 bundle 中失效 | esbuild ESM 输出保留 `import.meta.url`，需构建后验证 |
| ink+react external 后找不到 | `init --dashboard` 脚手架 package.json；`validate` 命令检测并提示 |
| cheerio external 后找不到 | 已有 regex fallback + `validate` 提示，不影响核心功能 |
| `node_modules` 不存在时 external 模块报错 | 首次运行检测，友好提示 `npm install ink react` 或 `agent-orch init --dashboard` |
| npm 包名 `agent-orch` 被占用 | 发布前检查，备选 `@anthropic/agent-orch` |

---

## 9. 实施计划

按 v1.0 版本规划，预计 2-3 天:

| 阶段 | 内容 | 预计耗时 |
|------|------|---------|
| Phase 1 | esbuild 配置 + package.json 更新 + LICENSE | 0.5 天 |
| Phase 2 | templates/ 目录 + .env.example 更新 | 0.5 天 |
| Phase 3 | init 命令实现 + 测试 | 0.5 天 |
| Phase 4 | Dockerfile + .dockerignore | 0.5 天 |
| Phase 5 | CI/CD workflows | 0.5 天 |
| 验证 | 端到端测试: npm pack / docker build / init 流程 | 0.5 天 |

---

## 与现有版本的关系

| 版本 | 重点 | 本方案归属 |
|------|------|-----------|
| v0.1 ~ v0.5 | 核心功能 + 可视化 | 已完成 |
| v0.6 | 生产加固 | 前置: 本方案中的 esbuild 构建 + npm 元数据 |
| v1.0 | 正式发布 | **本方案完整实施** |

v0.6 可以先引入 esbuild 构建和 package.json 元数据完善（Phase 1），v1.0 完成 init 命令 + Docker + CI/CD（Phase 2-5）。
