import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

// Mirrors esbuild's `loader: { ".md": "text" }` so source files can import
// prompts/system.md as a string under vitest too.
const mdAsText: Plugin = {
  name: "md-as-text",
  enforce: "pre",
  load(id) {
    if (id.endsWith(".md")) {
      return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
    }
    return null;
  },
};

export default defineConfig({
  plugins: [mdAsText],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    env: {
      // Tests must never reach real APIs.
      ANTHROPIC_API_KEY: "",
      GITHUB_TOKEN: "",
    },
  },
});
