import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPrTemplate } from "../../src/github/template.js";
import { buildInitialUserText } from "../../src/engine/prompt.js";
import { buildConfig } from "../../src/shared/config.js";
import type { GateResult, PrContext, TriggerContext } from "../../src/shared/types.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>): string {
  dir = mkdtempSync(path.join(tmpdir(), "recensio-tpl-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe("findPrTemplate", () => {
  it("finds .github/pull_request_template.md first", () => {
    const repo = makeRepo({
      ".github/pull_request_template.md": "## Checklist\n- [ ] tests added",
      "PULL_REQUEST_TEMPLATE.md": "root variant",
    });
    expect(findPrTemplate(repo)).toEqual({
      path: ".github/pull_request_template.md",
      content: "## Checklist\n- [ ] tests added",
    });
  });

  it("falls back through the other GitHub-recognized locations", () => {
    // Case-insensitive path comparison: macOS finds either casing at the
    // first probe, Linux at the exact-match probe — content is what matters.
    expect(findPrTemplate(makeRepo({ ".github/PULL_REQUEST_TEMPLATE.md": "A" }))?.path.toLowerCase()).toBe(
      ".github/pull_request_template.md",
    );
    expect(findPrTemplate(makeRepo({ "docs/pull_request_template.md": "B" }))).toMatchObject({
      path: "docs/pull_request_template.md",
      content: "B",
    });
    expect(findPrTemplate(makeRepo({ "PULL_REQUEST_TEMPLATE.md": "C" }))?.path.toLowerCase()).toBe(
      "pull_request_template.md",
    );
  });

  it("returns undefined when absent or empty", () => {
    expect(findPrTemplate(makeRepo({ "README.md": "hi" }))).toBeUndefined();
    expect(findPrTemplate(makeRepo({ ".github/pull_request_template.md": "   \n  " }))).toBeUndefined();
  });

  it("truncates oversized templates", () => {
    const repo = makeRepo({ ".github/pull_request_template.md": "x".repeat(20_000) });
    const tpl = findPrTemplate(repo)!;
    expect(tpl.content.length).toBeLessThan(9_000);
    expect(tpl.content).toContain("[truncated]");
  });
});

describe("prompt integration", () => {
  const cfg = buildConfig({ anthropicApiKey: "k", githubToken: "t" });
  const gate: GateResult = { changedLoc: 600, filesChanged: 1, excluded: [], threshold: 500, belowThreshold: false };
  const trigger: TriggerContext = { kind: "auto", owner: "a", repo: "r", prNumber: 1, bypassGate: false };

  function ctx(prTemplate?: PrContext["prTemplate"]): PrContext {
    return {
      meta: {
        owner: "a", repo: "r", number: 1, title: "t", body: "", author: "u",
        baseRef: "main", baseSha: "b", headRef: "h", headSha: "s",
        headRepoFullName: "a/r", draft: false, url: "",
      },
      files: [],
      filesTruncated: false,
      prTemplate,
    };
  }

  it("includes the <pr_template> block with compliance instructions when present", () => {
    const text = buildInitialUserText(
      ctx({ path: ".github/pull_request_template.md", content: "## Checklist\n- [ ] tests added" }),
      gate,
      trigger,
      cfg,
    );
    expect(text).toContain("<pr_template>");
    expect(text).toContain(".github/pull_request_template.md");
    expect(text).toContain("- [ ] tests added");
    expect(text).toContain("code-quality standards the template states honored by the diff");
  });

  it("omits the block when the repo has no template", () => {
    expect(buildInitialUserText(ctx(), gate, trigger, cfg)).not.toContain("<pr_template>");
  });
});
