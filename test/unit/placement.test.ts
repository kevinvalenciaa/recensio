import { describe, expect, it } from "vitest";
import { planPlacement } from "../../src/github/placement.js";
import { buildRepoDiffModel } from "../../src/github/diff.js";
import type { Finding } from "../../src/engine/schema.js";
import type { PrFile } from "../../src/shared/types.js";

// One file, one hunk: new lines 10..16 visible (11-13 added, rest context),
// second hunk: new lines 41..44 (42 added).
const PATCH = [
  "@@ -10,7 +10,8 @@",
  " const a = 1;",
  "-const removed = 2;",
  "-const alsoRemoved = 3;",
  "+const added = 2;",
  "+const alsoAdded = 3;",
  "+const third = 4;",
  " const b = 5;",
  " const c = 6;",
  " return a + b;",
  "@@ -40,3 +41,4 @@",
  " let x = 0;",
  "+x += 1;",
  " return x;",
  " }",
].join("\n");

const FILES: PrFile[] = [
  { filename: "src/app.ts", status: "modified", additions: 4, deletions: 2, changes: 6, patch: PATCH },
  { filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0, changes: 0, patch: undefined },
];

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "F1",
    severity: "P1",
    provenance: "INTRODUCED",
    confidence: 90,
    path: "src/app.ts",
    line: 11,
    title: "test finding",
    body: "**Issue**: x\n**Risk**: y\n**Trigger**: z\n**Verification trail**: w",
    ...overrides,
  };
}

function plan(findings: Finding[], readLines?: (p: string) => string[] | undefined) {
  return planPlacement({
    findings,
    diff: buildRepoDiffModel(FILES),
    owner: "acme",
    repo: "widgets",
    headSha: "abc1234",
    readLines,
  });
}

describe("planPlacement", () => {
  it("anchors a single-line finding on an added line", () => {
    const { comments, fallbacks } = plan([finding({ line: 11 })]);
    expect(fallbacks).toHaveLength(0);
    expect(comments[0]).toMatchObject({ path: "src/app.ts", line: 11, side: "RIGHT" });
    expect(comments[0]!.start_line).toBeUndefined();
    expect(comments[0]!.body).toContain("[P1][INTRODUCED]");
    expect(comments[0]!.body).toContain("<!-- recensio:finding:F1 -->");
  });

  it("anchors on context (unchanged) lines shown in the diff", () => {
    const { comments, fallbacks } = plan([finding({ line: 14 })]);
    expect(fallbacks).toHaveLength(0);
    expect(comments[0]).toMatchObject({ line: 14, side: "RIGHT" });
  });

  it("emits a multi-line anchor when the whole range is visible in one hunk", () => {
    const { comments } = plan([finding({ line: 11, end_line: 13, suggestion: "const merged = 9;" })]);
    expect(comments[0]).toMatchObject({ start_line: 11, start_side: "RIGHT", line: 13, side: "RIGHT" });
    expect(comments[0]!.body).toContain("```suggestion\nconst merged = 9;\n```");
  });

  it("shrinks a cross-hunk range to its end line and drops the suggestion", () => {
    const { comments, fallbacks } = plan([finding({ line: 14, end_line: 42, suggestion: "x" })]);
    expect(fallbacks).toHaveLength(0);
    expect(comments[0]).toMatchObject({ line: 42, side: "RIGHT" });
    expect(comments[0]!.start_line).toBeUndefined();
    expect(comments[0]!.body).not.toContain("```suggestion");
    expect(comments[0]!.body).toContain("lines 14–42");
  });

  it("falls back when a range is not anchorable at all", () => {
    const { comments, fallbacks } = plan([finding({ line: 100, end_line: 120 })]);
    expect(comments).toHaveLength(0);
    expect(fallbacks[0]).toMatchObject({ findingId: "F1", reason: "range-not-anchorable" });
    expect(fallbacks[0]!.renderedBody).toContain("blob/abc1234/src/app.ts#L100-L120");
  });

  it("snaps a near-miss line (no suggestion) to the nearest diff line", () => {
    // line 17 is 1 past the hunk end (16)
    const { comments, fallbacks } = plan([finding({ line: 17 })]);
    expect(fallbacks).toHaveLength(0);
    expect(comments[0]).toMatchObject({ line: 16, side: "RIGHT" });
    expect(comments[0]!.body).toContain("reported at line 17");
  });

  it("never snaps when the finding carries a suggestion", () => {
    const { comments, fallbacks } = plan([finding({ line: 17, suggestion: "fixed line" })]);
    expect(comments).toHaveLength(0);
    expect(fallbacks[0]).toMatchObject({ reason: "line-not-in-diff" });
    expect(fallbacks[0]!.renderedBody).toContain("Proposed fix");
  });

  it("falls back for lines far outside the diff", () => {
    const { fallbacks } = plan([finding({ line: 500 })]);
    expect(fallbacks[0]).toMatchObject({ reason: "line-not-in-diff" });
  });

  it("falls back for files not in the PR", () => {
    const { fallbacks } = plan([finding({ path: "src/other.ts" })]);
    expect(fallbacks[0]).toMatchObject({ reason: "file-not-in-pr" });
  });

  it("falls back for files without a text diff (binary)", () => {
    const { fallbacks } = plan([finding({ path: "assets/logo.png", line: 1 })]);
    expect(fallbacks[0]).toMatchObject({ reason: "no-text-diff" });
  });

  it("normalizes paths before lookup", () => {
    const { comments } = plan([finding({ path: "./src/app.ts", line: 11 })]);
    expect(comments[0]).toMatchObject({ path: "src/app.ts", line: 11 });
  });

  it("drops a suggestion identical to the current file content", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    lines[10] = "const added = 2;"; // head line 11
    const { comments } = plan(
      [finding({ line: 11, suggestion: "const added = 2;" })],
      (p) => (p === "src/app.ts" ? lines : undefined),
    );
    expect(comments[0]!.body).not.toContain("```suggestion");
  });

  it("keeps a suggestion that differs from current content", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const { comments } = plan(
      [finding({ line: 11, suggestion: "const fixed = 2;" })],
      (p) => (p === "src/app.ts" ? lines : undefined),
    );
    expect(comments[0]!.body).toContain("```suggestion\nconst fixed = 2;\n```");
  });
});
