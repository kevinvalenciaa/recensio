import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

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
