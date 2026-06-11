import type { Octokit } from "./client.js";
import type { ReviewResult } from "../engine/schema.js";
import type { FallbackFinding, InlineComment, PlacedReview, PrContext, ReviewEvent } from "../shared/types.js";
import { log } from "../shared/log.js";
import { REVIEW_MARKER } from "./pr.js";

const VERDICT_LABELS: Record<ReviewResult["verdict"], string> = {
  APPROVE: "✅ APPROVE",
  APPROVE_WITH_COMMENTS: "✅ APPROVE WITH COMMENTS",
  REQUEST_CHANGES: "🔁 REQUEST CHANGES",
  BLOCK: "⛔ BLOCK",
};

export function mapVerdict(verdict: ReviewResult["verdict"], neverApprove: boolean): ReviewEvent {
  switch (verdict) {
    case "APPROVE":
    case "APPROVE_WITH_COMMENTS":
      return neverApprove ? "COMMENT" : "APPROVE";
    case "REQUEST_CHANGES":
    case "BLOCK":
      return "REQUEST_CHANGES";
  }
}

export interface BodyContext {
  headSha: string;
  /** Total files in the PR (the "files reviewed" stat). */
  filesReviewed: number;
  /** Inline review comments being posted alongside this body. */
  inlineCommentCount: number;
}

export function renderReviewBody(
  review: ReviewResult,
  fallbacks: { verified: FallbackFinding[]; unconfirmed: FallbackFinding[] },
  ctx: BodyContext,
): string {
  const s: string[] = [];
  s.push(`${REVIEW_MARKER}\n<!-- recensio:commit:${ctx.headSha} -->`);
  // Sections mirror the review spec's Phase 5 deliverable, in its order
  // (discarded renders last because the spec calls it an appendix).
  s.push(
    `## Mergability Confidence: ${review.mergability_confidence}/5\n\n**${VERDICT_LABELS[review.verdict]}**\n\n${review.summary.trim()}`,
  );

  s.push(
    [
      "| Dimension | Weight | Score |",
      "|---|---|---|",
      `| 🔒 Security of the change | 30% | ${review.scores.security}/100 |`,
      `| 🛡️ Correctness & data integrity | 25% | ${review.scores.correctness}/100 |`,
      `| ⚡ Reliability & error handling | 20% | ${review.scores.reliability}/100 |`,
      `| 🧪 Tests for changed behavior | 15% | ${review.scores.tests}/100 |`,
      `| 📐 Code quality of the diff | 10% | ${review.scores.quality}/100 |`,
      `| **OVERALL** | 100% | **${review.scores.overall}/100** |`,
    ].join("\n"),
  );

  const reasons: Record<FallbackFinding["reason"], string> = {
    "file-not-in-pr": "file not changed in this PR",
    "no-text-diff": "no text diff for this file",
    "line-not-in-diff": "line not visible in the diff",
    "range-not-anchorable": "range not anchorable in the diff",
  };
  const renderFallbacks = (items: FallbackFinding[]) =>
    items.map((f) => `${f.renderedBody}\n\n_(shown here: ${reasons[f.reason]})_`).join("\n\n---\n\n");

  if (fallbacks.verified.length > 0) {
    s.push(`### Findings outside the visible diff\n\n${renderFallbacks(fallbacks.verified)}`);
  }

  if (fallbacks.unconfirmed.length > 0) {
    s.push(`### ⚠️ Unconfirmed (confidence 50–79)\n\n${renderFallbacks(fallbacks.unconfirmed)}`);
  }

  if (review.required_tests.length > 0) {
    s.push(`### Required tests\n\n${review.required_tests.map((t) => `- [ ] ${t}`).join("\n")}`);
  }

  if (review.top_actions.length > 0) {
    s.push(`### Top actions\n\n${review.top_actions.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
  }

  if (review.nits_markdown.trim() !== "") {
    s.push(`### 🟢 Nits (batched, non-blocking)\n\n${review.nits_markdown.trim()}`);
  }

  if (review.discarded.length > 0) {
    s.push(
      `<details>\n<summary>Discarded candidates (${review.discarded.length}) — audit trail</summary>\n\n${review.discarded
        .map((d) => `- ${d}`)
        .join("\n")}\n\n</details>`,
    );
  }

  s.push(`---\n${statsBlock(review, ctx)}`);

  return s.join("\n\n");
}

function statsBlock(review: ReviewResult, ctx: BodyContext): string {
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const f of [...review.findings, ...review.unconfirmed]) counts[f.severity] += 1;
  const parts: string[] = [];
  if (counts.P0 > 0) parts.push(`Critical (P0): ${counts.P0}`);
  if (counts.P1 > 0) parts.push(`High (P1): ${counts.P1}`);
  if (counts.P2 > 0) parts.push(`Medium (P2): ${counts.P2}`);
  const commentsWord = ctx.inlineCommentCount === 1 ? "comment" : "comments";
  const filesWord = ctx.filesReviewed === 1 ? "file" : "files";
  const head = `${ctx.filesReviewed} ${filesWord} reviewed, ${ctx.inlineCommentCount} ${commentsWord}`;
  return parts.length > 0 ? `${head}\n\nSeverity breakdown: ${parts.join(", ")}` : `${head}\n\nNo issues found.`;
}

export interface PostResult {
  reviewUrl?: string;
  degraded: string[];
}

/**
 * Posts the review with a degradation ladder so a review always lands:
 *  1. full review (inline comments + mapped event)
 *  2. approval not permitted → same review as COMMENT with a verdict note
 *  3. inline anchors rejected → review without inline comments, findings in body
 *  4. reviews API failing entirely → plain issue comment with the markdown
 */
export async function postReview(
  ok: Octokit,
  ctx: PrContext,
  placed: PlacedReview,
  headSha: string,
): Promise<PostResult> {
  const { owner, repo, number } = ctx.meta;
  const degraded: string[] = [];

  let event = placed.event;
  let body = placed.body;
  let comments: InlineComment[] = placed.comments;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { data } = await ok.rest.pulls.createReview({
        owner,
        repo,
        pull_number: number,
        commit_id: headSha,
        event,
        body,
        comments: comments.length > 0 ? comments : undefined,
      });
      return { reviewUrl: data.html_url ?? undefined, degraded };
    } catch (err: any) {
      const status: number | undefined = err?.status;
      const detail = extractErrorText(err);
      log.warn(`createReview failed (status ${status ?? "?"}): ${detail.slice(0, 500)}`);

      // Downgrades change only the review event — the body already opens with
      // the verdict line, so no explanatory note is prepended.
      if (event === "APPROVE" && (status === 403 || status === 422)) {
        degraded.push(`approval not permitted (status ${status}) — posted as COMMENT instead`);
        event = "COMMENT";
        continue;
      }
      if (comments.length > 0 && status === 422) {
        degraded.push("inline comments rejected (422) — findings moved into the review body");
        body = foldCommentsIntoBody(body, comments);
        comments = [];
        continue;
      }
      if (status === 403 && event === "REQUEST_CHANGES") {
        degraded.push("REQUEST_CHANGES not permitted (403) — posted as COMMENT");
        event = "COMMENT";
        continue;
      }

      // Last resort: plain issue comment so the work is not lost.
      degraded.push(`review API failed (${status ?? "unknown"}) — posted as an issue comment`);
      const fallbackBody = foldCommentsIntoBody(body, comments);
      const { data } = await ok.rest.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body: fallbackBody,
      });
      return { reviewUrl: data.html_url, degraded };
    }
  }
  throw new Error("postReview exhausted its degradation ladder");
}

function foldCommentsIntoBody(body: string, comments: InlineComment[]): string {
  if (comments.length === 0) return body;
  const items = comments.map((c) => {
    const range = c.start_line !== undefined ? `${c.start_line}–${c.line}` : `${c.line}`;
    return `**\`${c.path}:${range}\`**\n\n${c.body}`;
  });
  return `${body}\n\n### Inline findings (could not be anchored)\n\n${items.join("\n\n---\n\n")}`;
}

function extractErrorText(err: any): string {
  const parts = [err?.message ?? String(err)];
  const ghErrors = err?.response?.data?.errors;
  if (ghErrors) parts.push(JSON.stringify(ghErrors));
  return parts.join(" · ");
}

/** Creates or updates the single marker-tagged comment (skip / error notices). */
export async function upsertMarkerComment(
  ok: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  const comments = await ok.paginate(ok.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(marker));
  if (existing) {
    await ok.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await ok.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
}
