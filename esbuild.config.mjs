import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// esbuild preserves the shebang from src/cli/main.ts automatically.
// Node.js strips hashbangs before parsing, so they work in ESM too.

await build({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist/cli",
  outbase: "src/cli",
  splitting: true,
  minify: false,
  sourcemap: true,
  // CJS interop: esbuild generates __require2 wrappers for CJS deps,
  // but Node.js built-ins (like "util") must use actual require().
  // Setting banner to inject createRequire handles this.
  banner: {
    js: `
import { createRequire } from "node:module";
import { fileURLToPath as __urlToPath } from "node:url";
import { dirname as __dirName } from "node:path";
const require = createRequire(import.meta.url);
const __filename = __urlToPath(import.meta.url);
const __dirname = __dirName(__filename);
`.trim(),
  },
  external: [
    // ink + react: peer dependencies for dashboard (optional)
    "ink",
    "react",
    "react-dom",
    // cheerio: optional dependency for WebFetch HTML extraction
    "cheerio",
  ],
  logLevel: "info",
});
