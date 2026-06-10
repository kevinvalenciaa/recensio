import { describe, expect, it } from "vitest";
import { buildInitialUserText, buildSystem } from "../../src/engine/prompt.js";
import { buildConfig } from "../../src/shared/config.js";
import type { GateResult, PrContext, TriggerContext } from "../../src/shared/types.js";

const cfg = buildConfig({ anthropicApiKey: "k", githubToken: "t" });

function ctx(overrides: Partial<PrContext> = {}): PrContext {
  return {
    meta: {
      owner: "acme",
      repo: "widgets",
      number: 7,
      title: "Add users endpoint",
      body: "Implements #123",
      author: "alice",
      baseRef: "main",
      baseSha: "b".repeat(40),
      headRef: "feat/users",
      headSha: "a".repeat(40),
      headRepoFullName: "acme/widgets",
      draft: false,
      url: "https://github.com/acme/widgets/pull/7",
    },
    files: [
      { filename: "src/users.ts", status: "added", additions: 400, deletions: 0, changes: 400, patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
      { filename: "package-lock.json", status: "modified", additions: 900, deletions: 900, changes: 1800, patch: "@@ -1,1 +1,1 @@\n-x\n+y" },
      { filename: "img.png", status: "added", additions: 0, deletions: 0, changes: 0 },
      { filename: "src/big.ts", status: "modified", additions: 200, deletions: 100, changes: 300, patch: "@@ -1,1 +1,1 @@\n-old\n+new" },
    ],
    filesTruncated: false,
    ...overrides,
  };
}

const gate: GateResult = { changedLoc: 700, filesChanged: 4, excluded: ["package-lock.json"], threshold: 500, belowThreshold: false };

const autoTrigger: TriggerContext = { kind: "auto", owner: "acme", repo: "widgets", prNumber: 7, bypassGate: false };

describe("buildSystem", () => {
  it("is a single cached block containing the verbatim spec and the harness contract", () => {
    const system = buildSystem();
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text).toContain("PR Review Agent — System Prompt");
    expect(system[0]!.text).toContain('"LGTM" is the most expensive phrase in software');
    expect(system[0]!.text).toContain("Recensio Harness Contract");
    expect(system[0]!.text).toContain("submit_review");
  });
});

describe("buildInitialUserText", () => {
  it("is deterministic for identical input (cache-stable, no timestamps)", () => {
    expect(buildInitialUserText(ctx(), gate, autoTrigger, cfg)).toBe(buildInitialUserText(ctx(), gate, autoTrigger, cfg));
  });

  it("includes meta, stats with gate flags, and ordered patches", () => {
    const text = buildInitialUserText(ctx(), gate, autoTrigger, cfg);
    expect(text).toContain("PR #7: Add users endpoint");
    expect(text).toContain("Base: main ← Head: feat/users");
    expect(text).toContain("package-lock.json  +900/-900  [excluded from gate]");
    expect(text).toContain("Size gate (computed by the harness): changed LOC 700");
    // excluded files contribute no patch body; binary noted
    expect(text).toContain("(patch omitted — excluded from gate as lockfile/vendored/generated)");
    expect(text).toContain("(no text diff — binary or oversized; use read_file if text)");
    // source files ordered before excluded ones
    expect(text.indexOf("### src/users.ts")).toBeLessThan(text.indexOf("### package-lock.json"));
    expect(text).toContain("call submit_review exactly once");
  });

  it("notes the explicit-request bypass and quotes the comment on command triggers", () => {
    const cmd: TriggerContext = {
      kind: "command",
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      commenter: "bob",
      commentBody: "@recensio please take another look",
      bypassGate: true,
    };
    const below = { ...gate, changedLoc: 80, belowThreshold: true };
    const text = buildInitialUserText(ctx(), below, cmd, cfg);
    expect(text).toContain("re-review explicitly requested by @bob");
    expect(text).toContain("size gate bypassed by this explicit request");
    expect(text).toContain("@recensio please take another look");
    expect(text).toContain("Below threshold — reviewed anyway");
  });

  it("renders the previous-review digest when present", () => {
    const withPrev = ctx({
      previousReview: {
        reviewedSha: "c".repeat(40),
        verdict: "REQUEST_CHANGES",
        submittedAt: "2026-06-01T00:00:00Z",
        findings: [{ id: "F1", severity: "P0", path: "src/users.ts", line: 42, title: "SQL injection" }],
        summaryExcerpt: "Previously requested changes.",
      },
    });
    const text = buildInitialUserText(withPrev, gate, autoTrigger, cfg);
    expect(text).toContain("<previous_review>");
    expect(text).toContain("- F1 [P0] src/users.ts:42 — SQL injection");
  });

  it("enforces the global patch budget and lists omitted files", () => {
    const tight = { ...cfg, patchCharBudget: 120, patchCharPerFile: 100 };
    const text = buildInitialUserText(ctx(), gate, autoTrigger, tight);
    expect(text).toContain("Patches omitted for budget (use read_file):");
  });

  it("truncates oversized per-file patches with a notice", () => {
    const huge = ctx({
      files: [
        {
          filename: "src/huge.ts",
          status: "modified",
          additions: 5000,
          deletions: 0,
          changes: 5000,
          patch: "@@ -1,1 +1,5000 @@\n" + "+x\n".repeat(20_000),
        },
      ],
    });
    const text = buildInitialUserText(huge, gate, autoTrigger, cfg);
    expect(text).toContain("[patch truncated — use read_file for the full file]");
  });
});
