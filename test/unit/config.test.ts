import nock from "nock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOctokit } from "../../src/github/client.js";
import { isConfigIgnored, loadConfig, matchedInstructions, parseConfig } from "../../src/github/config.js";

const API = "https://api.github.com";

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());

describe("parseConfig", () => {
  it("parses instructions and ignore globs", () => {
    const cfg = parseConfig(
      [
        "instructions:",
        "  - path: 'src/api/**'",
        "    guidance: All handlers must validate input with zod.",
        "  - path: '**/*.test.ts'",
        "    guidance: Tests must assert error paths.",
        "ignore:",
        "  - 'generated/**'",
        "  - '**/*.snap'",
      ].join("\n"),
    );
    expect(cfg.instructions).toHaveLength(2);
    expect(cfg.instructions[0]).toEqual({ path: "src/api/**", guidance: "All handlers must validate input with zod." });
    expect(cfg.ignore).toEqual(["generated/**", "**/*.snap"]);
  });

  it("parses a checks block and reserves history", () => {
    const cfg = parseConfig("checks:\n  install: npm ci\n  commands:\n    - 'tsc --noEmit'\nhistory:\n  depth: 50");
    expect(cfg.checks).toEqual({ install: "npm ci", commands: ["tsc --noEmit"] });
    expect(cfg.history).toEqual({ depth: 50 });
  });

  it("fails soft on bad YAML and non-object roots", () => {
    expect(parseConfig("instructions: [unclosed").instructions).toEqual([]);
    expect(parseConfig("just a string")).toEqual({ instructions: [], ignore: [] });
    expect(parseConfig("")).toEqual({ instructions: [], ignore: [] });
  });

  it("ignores malformed instruction entries", () => {
    const cfg = parseConfig("instructions:\n  - path: 'a/**'\n  - guidance: 'no path'\n  - {}");
    expect(cfg.instructions).toEqual([]); // first entry lacks guidance
  });
});

describe("matchedInstructions", () => {
  it("returns only instructions whose glob matches a changed file", () => {
    const cfg = parseConfig(
      "instructions:\n  - path: 'src/api/**'\n    guidance: A\n  - path: 'docs/**'\n    guidance: B",
    );
    const matched = matchedInstructions(cfg, ["src/api/users.ts", "README.md"]);
    expect(matched.map((m) => m.guidance)).toEqual(["A"]);
  });
});

describe("isConfigIgnored", () => {
  it("matches ignore globs (dot files included)", () => {
    const cfg = parseConfig("ignore:\n  - 'generated/**'\n  - '**/*.pb.go'");
    expect(isConfigIgnored(cfg, "generated/client.ts")).toBe(true);
    expect(isConfigIgnored(cfg, "proto/svc.pb.go")).toBe(true);
    expect(isConfigIgnored(cfg, "src/app.ts")).toBe(false);
  });
});

describe("loadConfig", () => {
  it("reads from the base default branch and parses it", async () => {
    const yaml = "instructions:\n  - path: 'src/**'\n    guidance: Be careful.";
    nock(API)
      .get("/repos/acme/widgets")
      .reply(200, { default_branch: "trunk" })
      .get("/repos/acme/widgets/contents/.recensio.yml")
      .query((q) => q.ref === "trunk")
      .reply(200, { type: "file", content: Buffer.from(yaml).toString("base64"), encoding: "base64" });

    const cfg = await loadConfig(makeOctokit("t"), "acme", "widgets", ".recensio.yml");
    expect(cfg.instructions[0]!.guidance).toBe("Be careful.");
  });

  it("returns empty config when the file is absent (404)", async () => {
    nock(API)
      .get("/repos/acme/widgets")
      .reply(200, { default_branch: "main" })
      .get("/repos/acme/widgets/contents/.recensio.yml")
      .query(true)
      .reply(404, {});
    expect(await loadConfig(makeOctokit("t"), "acme", "widgets", ".recensio.yml")).toEqual({ instructions: [], ignore: [] });
  });
});
