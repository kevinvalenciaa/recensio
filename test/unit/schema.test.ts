import { describe, expect, it } from "vitest";
import {
  SubmitReviewSchema,
  formatZodIssues,
  submitReviewJsonSchema,
  validateSemantics,
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
  it("clamps and rounds harmless numeric drift", () => {
    const r = validReview();
    r.mergability_confidence = 7.4;
    r.scores.security = 150;
    r.findings[0]!.confidence = 96.6;
    const out = validateSemantics(r);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.review.mergability_confidence).toBe(5);
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
      expect.arrayContaining(["verdict", "scores", "findings", "unconfirmed", "pre_merge_checklist", "nits_markdown"]),
    );
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
