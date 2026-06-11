import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderCheckBlock, runChecks } from "../../src/checks/run.js";
import { parseConfig } from "../../src/github/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "recensio-checks-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("checks config parsing", () => {
  it("parses commands and install, and drops empty blocks", () => {
    const cfg = parseConfig("checks:\n  install: npm ci --ignore-scripts\n  commands:\n    - 'tsc --noEmit'\n    - 'eslint .'");
    expect(cfg.checks).toEqual({ install: "npm ci --ignore-scripts", commands: ["tsc --noEmit", "eslint ."] });
    expect(parseConfig("checks:\n  commands: []").checks).toBeUndefined();
    expect(parseConfig("checks: {}").checks).toBeUndefined();
  });
});

describe("runChecks", () => {
  it("reports pass/fail per command", async () => {
    const results = await runChecks({ commands: ["node -e process.exit(0)", "node -e process.exit(1)"] }, dir);
    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
  });

  it("captures output", async () => {
    const results = await runChecks({ commands: ["node -e console.error('boom-msg')"] }, dir);
    expect(results[0]!.output).toContain("boom-msg");
  });

  it("runs the child with a scrubbed env — no API tokens leak in", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    process.env.GITHUB_TOKEN = "ghp-secret";
    try {
      // Node prints 'undefined' for unset env vars.
      const results = await runChecks(
        { commands: ["node -e console.log(String(process.env.ANTHROPIC_API_KEY)+'|'+String(process.env.GITHUB_TOKEN)+'|'+String(process.env.CI))"] },
        dir,
      );
      expect(results[0]!.output).toBe("undefined|undefined|true");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("stops after a failed install", async () => {
    const results = await runChecks({ install: "node -e process.exit(2)", commands: ["node -e process.exit(0)"] }, dir);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("install");
    expect(results[0]!.ok).toBe(false);
  });

  it("reports a failure to start (bad binary) without throwing", async () => {
    const results = await runChecks({ commands: ["definitely-not-a-real-binary-xyz --x"] }, dir);
    expect(results[0]!.ok).toBe(false);
  });
});

describe("renderCheckBlock", () => {
  it("shows status and folds failing output", () => {
    const block = renderCheckBlock([
      { name: "tsc", ok: false, timedOut: false, output: "error TS2304" },
      { name: "eslint", ok: true, timedOut: false, output: "" },
    ]);
    expect(block).toContain("<check_results>");
    expect(block).toContain("### tsc — ❌ FAILED");
    expect(block).toContain("error TS2304");
    expect(block).toContain("### eslint — ✅ passed");
  });
});
