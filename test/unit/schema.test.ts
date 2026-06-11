import { describe, expect, it } from "vitest";
import {
  SubmitReviewSchema,
  formatZodIssues,
  submitReviewJsonSchema,
  validateSemantics,
  type ReviewResult,
} from "../../src/engine/schema.js";
import { validReview } from "../helpers/review.js";

describe("SubmitReviewSchema", () => {
  it("accepts a valid review", () => {
    expect(SubmitReviewSchema.safeParse(validReview()).success).toBe(true);
  });

  it("rejects unknown keys, bad enums, and missing fields with readable messages", () => {
    const bad = { ...validReview(), verdict: "SHIP_IT", extra: 1 } as unknown;
    const parsed = SubmitReviewSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatZodIssues(parsed.error);
      expect(msg).toContain("verdict");
      expect(msg).toContain("call submit_review again");
    }
  });
});

describe("validateSemantics", () => {
  it("clamps and rounds harmless numeric drift (scores, confidence)", () => {
    const r = validReview();
    r.scores.security = 150;
    r.findings[0]!.confidence = 96.6;
    const out = validateSemantics(r);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.review.scores.security).toBe(100);
      expect(out.review.findings[0]!.confidence).toBe(97);
    }
  });

  it("rejects bad anchors with actionable errors", () => {
    const r = validReview();
    r.findings[0]!.line = 0;
    r.findings.push({ ...r.findings[0]!, id: "F1", line: 10, end_line: 5 });
    const out = validateSemantics(r);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.join("\n")).toMatch(/line must be a positive integer/);
      expect(out.errors.join("\n")).toMatch(/end_line \(5\) must be >= line \(10\)/);
      expect(out.errors.join("\n")).toMatch(/duplicate finding id F1/);
    }
  });

  it("normalizes end_line === line to a single-line anchor", () => {
    const r = validReview();
    r.findings[0]!.end_line = r.findings[0]!.line;
    const out = validateSemantics(r);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.review.findings[0]!.end_line).toBeUndefined();
  });
});

describe("verdict/score enforcement", () => {
  function withFindings(severities: Array<"P0" | "P1" | "P2">, verdict: ReviewResult["verdict"]) {
    const base = validReview();
    const f0 = base.findings[0]!;
    return validReview({
      verdict,
      findings: severities.map((severity, i) => ({ ...f0, id: `F${i + 1}`, severity })),
    });
  }

  it("recomputes overall as the weighted dimension sum", () => {
    const r = validReview({ scores: { security: 40, correctness: 70, reliability: 80, tests: 60, quality: 75, overall: 999 } });
    const out = validateSemantics(r);
    expect(out.ok).toBe(true);
    // 40*.3 + 70*.25 + 80*.2 + 60*.15 + 75*.1 = 12+17.5+16+9+7.5 = 62
    if (out.ok) expect(out.review.scores.overall).toBe(62);
  });

  it("coerces a verified P0 with APPROVE down to REQUEST_CHANGES and grade ≤2", () => {
    const out = validateSemantics(withFindings(["P0"], "APPROVE"));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.review.verdict).toBe("REQUEST_CHANGES");
      expect(out.review.mergability_confidence).toBeLessThanOrEqual(2);
    }
  });

  it("coerces ≥2 verified P1s to REQUEST_CHANGES and grade ≤2", () => {
    const out = validateSemantics(withFindings(["P1", "P1"], "APPROVE_WITH_COMMENTS"));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.review.verdict).toBe("REQUEST_CHANGES");
      expect(out.review.mergability_confidence).toBeLessThanOrEqual(2);
    }
  });

  it("downgrades a single verified P1 + APPROVE to APPROVE_WITH_COMMENTS and grade ≤3", () => {
    const out = validateSemantics(withFindings(["P1"], "APPROVE"));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.review.verdict).toBe("APPROVE_WITH_COMMENTS");
      expect(out.review.mergability_confidence).toBeLessThanOrEqual(3);
    }
  });

  it("caps grade at 4 when only verified P2s exist, leaving the verdict alone", () => {
    const r = withFindings(["P2"], "APPROVE_WITH_COMMENTS");
    r.scores = { security: 95, correctness: 95, reliability: 95, tests: 95, quality: 95, overall: 95 };
    const out = validateSemantics(r);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.review.verdict).toBe("APPROVE_WITH_COMMENTS");
      expect(out.review.mergability_confidence).toBe(4); // band would be 5; P2 caps at 4
    }
  });

  it("allows a clean APPROVE at 5/5 when there are no findings", () => {
    const r = validReview({ verdict: "APPROVE", findings: [], discarded: [] });
    r.scores = { security: 95, correctness: 95, reliability: 95, tests: 95, quality: 95, overall: 0 };
    const out = validateSemantics(r);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.review.verdict).toBe("APPROVE");
      expect(out.review.mergability_confidence).toBe(5);
    }
  });
});

describe("submitReviewJsonSchema", () => {
  it("produces a strict-mode-safe JSON schema", () => {
    const schema = submitReviewJsonSchema();
    const text = JSON.stringify(schema);
    expect(schema).toMatchObject({ type: "object" });
    expect(text).toContain('"additionalProperties":false');
    expect(text).toContain('"verdict"');
    expect(text).toContain("APPROVE_WITH_COMMENTS");
    // keywords unsupported by strict mode must be stripped
    for (const kw of ["minimum", "maximum", "minLength", "maxLength", "pattern", "format", "default"]) {
      expect(text).not.toContain(`"${kw}":`);
    }
    // every property must be listed in required (or be genuinely optional)
    const props = Object.keys((schema as any).properties);
    expect(props).toEqual(
      expect.arrayContaining(["verdict", "scores", "findings", "unconfirmed", "nits_markdown"]),
    );
    expect(props).not.toContain("pre_merge_checklist");
  });
});

describe("brevity caps", () => {
  it("bounces a summary over the 400-char cap back as a validation error", () => {
    const r = validReview({ summary: "x".repeat(401) });
    const out = validateSemantics(r);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join("\n")).toMatch(/summary is 401 chars — hard cap is 400/);
    expect(validateSemantics(validReview({ summary: "x".repeat(400) })).ok).toBe(true);
  });

  it("bounces over-cap finding subsections (250) and ai_fix_prompt (400)", () => {
    const r = validReview();
    r.findings[0]!.issue = "y".repeat(251);
    r.findings[0]!.verification_trail = "y".repeat(300);
    r.findings[0]!.ai_fix_prompt = "y".repeat(401);
    const out = validateSemantics(r);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      const text = out.errors.join("\n");
      expect(text).toMatch(/findings\[0\]\.issue is 251 chars — hard cap is 250/);
      expect(text).toMatch(/findings\[0\]\.verification_trail is 300 chars/);
      expect(text).toMatch(/findings\[0\]\.ai_fix_prompt is 401 chars — hard cap is 400/);
    }
  });

  it("caps to_confirm on unconfirmed items at 250", () => {
    const r = validReview();
    r.unconfirmed = [{ ...r.findings[0]!, id: "F9", to_confirm: "z".repeat(251) }];
    const out = validateSemantics(r);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join("\n")).toMatch(/unconfirmed\[0\]\.to_confirm is 251 chars/);
  });

  it("accepts compact content", () => {
    expect(validateSemantics(validReview()).ok).toBe(true);
  });
});
