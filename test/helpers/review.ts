import type { ReviewResult } from "../../src/engine/schema.js";

export function validReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: "REQUEST_CHANGES",
    mergability_confidence: 2,
    scores: { security: 40, correctness: 70, reliability: 80, tests: 60, quality: 75, overall: 60 },
    summary: "Adds a users endpoint; SQL injection found.",
    findings: [
      {
        id: "F1",
        severity: "P0",
        provenance: "INTRODUCED",
        confidence: 96,
        path: "src/api/users.ts",
        line: 142,
        title: "SQL injection via name query param",
        body: "**Issue**: ...\n**Risk**: ...\n**Trigger**: ...\n**Verification trail**: ...",
        suggestion: "const q = 'SELECT * FROM users WHERE name = $1';",
      },
    ],
    unconfirmed: [],
    discarded: ["F0 missing await — discarded (confidence 20): call is intentionally fire-and-forget"],
    required_tests: ["users endpoint rejects quote characters"],
    top_actions: ["Parameterize the users query"],
    nits_markdown: "",
    ...overrides,
  };
}
