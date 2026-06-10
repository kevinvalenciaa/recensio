import { z } from "zod";

/**
 * Structural shape of the submit_review tool input. Kept refinement-free so it
 * converts cleanly to the JSON schema sent to the API (strict tool use);
 * semantic rules (integer-ness, ranges, line ordering) live in
 * validateSemantics so the model gets actionable error messages.
 */
export const FindingSchema = z.strictObject({
  id: z.string().describe('Stable finding id, "F" + number, e.g. "F1"'),
  severity: z.enum(["P0", "P1", "P2"]),
  provenance: z.enum(["INTRODUCED", "EXPOSED", "PRE-EXISTING"]),
  confidence: z.number().describe("0-100, per the confidence rubric"),
  path: z.string().describe("Repo-relative path at the head revision"),
  line: z.number().describe("Head-revision line number the finding anchors to"),
  end_line: z
    .number()
    .optional()
    .describe("Last line of a multi-line anchor; omit for single-line findings"),
  title: z.string().describe("One-line summary of the issue"),
  body: z
    .string()
    .describe(
      "Markdown containing **Issue**, **Risk**, **Trigger**, and **Verification trail** lines, with the offending code quoted",
    ),
  suggestion: z
    .string()
    .optional()
    .describe(
      "Complete replacement text for exactly lines line..end_line (GitHub suggestion). Omit when the fix is not expressible as a replacement of those exact lines.",
    ),
});

export const UnconfirmedSchema = FindingSchema.extend({
  to_confirm: z.string().describe("The exact check a human should run to settle this"),
});

export const ScoresSchema = z.strictObject({
  security: z.number(),
  correctness: z.number(),
  reliability: z.number(),
  tests: z.number(),
  quality: z.number(),
  overall: z.number(),
});

export const SubmitReviewSchema = z.strictObject({
  verdict: z.enum(["APPROVE", "APPROVE_WITH_COMMENTS", "REQUEST_CHANGES", "BLOCK"]),
  mergability_confidence: z.number().describe("1-5 per the grade table"),
  scores: ScoresSchema.describe("Merge Readiness dimensions, each 0-100"),
  summary: z
    .string()
    .describe(
      "PR intent, what the diff actually does vs claims, mergability rationale, checklist state, one good decision",
    ),
  findings: z.array(FindingSchema).describe("Verified findings only (confidence >= 80, severity P0-P2)"),
  unconfirmed: z.array(UnconfirmedSchema).describe("Confidence 50-79 items"),
  discarded: z
    .array(z.string())
    .describe('One line each: "[candidate] — discarded (confidence NN): [disproving evidence]"'),
  required_tests: z.array(z.string()),
  top_actions: z.array(z.string()).describe("Ranked by risk reduction, max 5"),
  nits_markdown: z.string().describe("ALL P3 nits as one batched markdown list; empty string if none"),
});

export type Finding = z.infer<typeof FindingSchema>;
export type UnconfirmedFinding = z.infer<typeof UnconfirmedSchema>;
export type ReviewResult = z.infer<typeof SubmitReviewSchema>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/**
 * Applies semantic rules on top of the structural parse. Harmless drift
 * (fractional or out-of-range scores) is normalized in place; anchoring
 * fields the harness cannot safely guess about produce errors for the model.
 */
export function validateSemantics(review: ReviewResult): { ok: true; review: ReviewResult } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  review.mergability_confidence = clamp(review.mergability_confidence, 1, 5);
  for (const key of Object.keys(review.scores) as Array<keyof ReviewResult["scores"]>) {
    review.scores[key] = clamp(review.scores[key], 0, 100);
  }

  const checkFinding = (f: Finding, where: string) => {
    f.confidence = clamp(f.confidence, 0, 100);
    if (!/^F\d+$/.test(f.id)) errors.push(`${where}.id must match F<number>, got "${f.id}"`);
    if (!Number.isInteger(f.line) || f.line < 1) errors.push(`${where}.line must be a positive integer, got ${f.line}`);
    if (f.end_line !== undefined) {
      if (!Number.isInteger(f.end_line) || f.end_line < 1) {
        errors.push(`${where}.end_line must be a positive integer, got ${f.end_line}`);
      } else if (f.end_line < f.line) {
        errors.push(`${where}.end_line (${f.end_line}) must be >= line (${f.line})`);
      } else if (f.end_line === f.line) {
        f.end_line = undefined;
      }
    }
    if (f.path.trim() === "") errors.push(`${where}.path must not be empty`);
  };

  review.findings.forEach((f, i) => checkFinding(f, `findings[${i}]`));
  review.unconfirmed.forEach((f, i) => checkFinding(f, `unconfirmed[${i}]`));

  const ids = new Set<string>();
  for (const f of [...review.findings, ...review.unconfirmed]) {
    if (ids.has(f.id)) errors.push(`duplicate finding id ${f.id} — ids must be unique across findings and unconfirmed`);
    ids.add(f.id);
  }

  if (review.findings.length > 50) errors.push("findings exceeds 50 — cut to the highest-risk items (Operating Instruction 5)");
  if (review.top_actions.length > 10) review.top_actions = review.top_actions.slice(0, 10);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, review };
}

const STRICT_UNSUPPORTED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "format",
  "default",
]);

/** Strips JSON-schema keywords the API's strict mode rejects. */
export function sanitizeForStrictMode(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeForStrictMode);
  if (schema !== null && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (STRICT_UNSUPPORTED_KEYWORDS.has(k)) continue;
      out[k] = sanitizeForStrictMode(v);
    }
    return out;
  }
  return schema;
}

export function submitReviewJsonSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(SubmitReviewSchema) as Record<string, unknown>;
  delete raw.$schema;
  return sanitizeForStrictMode(raw) as Record<string, unknown>;
}

export function formatZodIssues(error: z.ZodError): string {
  const lines = error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `submit_review input is invalid. Fix these fields and call submit_review again:\n${lines.join("\n")}`;
}
