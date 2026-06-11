import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// Vendor the tree-sitter runtime + grammar wasm into dist/grammars/ so the
// committed bundle is self-contained (loaded at runtime by absolute path).
const GRAMMAR_LANGS = ["typescript", "tsx", "javascript", "python", "go", "java"];
const grammarsDir = path.join(root, "dist", "grammars");
mkdirSync(grammarsDir, { recursive: true });
copyFileSync(
  path.join(root, "node_modules", "web-tree-sitter", "tree-sitter.wasm"),
  path.join(grammarsDir, "tree-sitter.wasm"),
);
for (const lang of GRAMMAR_LANGS) {
  copyFileSync(
    path.join(root, "node_modules", "tree-sitter-wasms", "out", `tree-sitter-${lang}.wasm`),
    path.join(grammarsDir, `tree-sitter-${lang}.wasm`),
  );
}

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
  define: { "process.env.RECENSIO_VERSION": JSON.stringify(pkg.version) },
  // prompts/system.md is inlined via the `text` loader so the bundle is self-contained.
  loader: { ".md": "text" },
};

await build({
  ...common,
  entryPoints: ["src/main.ts"],
  outfile: "dist/index.js",
});

await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});
