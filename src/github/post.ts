import type { Octokit } from "./client.js";
import type { ReviewResult, UnconfirmedFinding } from "../engine/schema.js";
import type { FallbackFinding, InlineComment, PlacedReview, PrContext, ReviewEvent } from "../shared/types.js";
import { log } from "../shared/log.js";
import { REVIEW_MARKER } from "./pr.js";

const VERDICT_LABELS: Record<ReviewResult["verdict"], string> = {
  APPROVE: "✅ APPROVE",
  APPROVE_WITH_COMMENTS: "💬 APPROVE WITH COMMENTS",
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

export function renderReviewBody(
  review: ReviewResult,
  fallbacks: FallbackFinding[],
  ctx: { headSha: string; model: string; effort: string; usageFooter: string },
): string {
  const s: string[] = [];
  s.push(`${REVIEW_MARKER}\n<!-- recensio:commit:${ctx.headSha} -->`);
  // Sections mirror the review spec's Phase 5 deliverable, in its order
  // (discarded renders last because the spec calls it an appendix).
  s.push(`## ${VERDICT_LABELS[review.verdict]}\n\n**Mergability Confidence: ${review.mergability_confidence}/5**\n\n${review.summary.trim()}`);

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

  const inlineCount = review.findings.length - fallbacks.length;
  if (review.findings.length > 0) {
    const parts = [];
    if (inlineCount > 0) parts.push(`${inlineCount} posted inline on the changed lines`);
    if (fallbacks.length > 0) parts.push(`${fallbacks.length} below (not anchorable in the diff)`);
    s.push(`**✅ Verified findings:** ${parts.join(" · ")}`);
  }

  if (fallbacks.length > 0) {
    const reasons: Record<FallbackFinding["reason"], string> = {
      "file-not-in-pr": "file not changed in this PR",
      "no-text-diff": "no text diff for this file",
      "line-not-in-diff": "line not visible in the diff",
      "range-not-anchorable": "range not anchorable in the diff",
    };
    const items = fallbacks.map((f) => `${f.renderedBody}\n\n_(shown here: ${reasons[f.reason]})_`);
    s.push(`### Findings outside the visible diff\n\n${items.join("\n\n---\n\n")}`);
  }

  if (review.unconfirmed.length > 0) {
    s.push(`### ⚠️ Unconfirmed (confidence 50–79)\n\n${review.unconfirmed.map(renderUnconfirmed).join("\n\n---\n\n")}`);
  }

  if (review.required_tests.length > 0) {
    s.push(`### Required tests\n\n${review.required_tests.map((t) => `- [ ] ${t}`).join("\n")}`);
  }

  if (review.pre_merge_checklist.trim() !== "") {
    s.push(`### Pre-merge checklist\n\n${review.pre_merge_checklist.trim()}`);
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

  s.push(
    `---\n_Recensio · ${ctx.model} (effort: ${ctx.effort}) · ${ctx.usageFooter} · comment \`@recensio\` to re-review_`,
  );
  return s.join("\n\n");
}

function renderUnconfirmed(f: UnconfirmedFinding): string {
  return [
    `**[${f.severity}][${f.provenance}] ${f.title}** · \`${f.id}\` · confidence ${f.confidence}/100`,
    `\`${f.path}:${f.line}${f.end_line ? `–${f.end_line}` : ""}\``,
    f.body.trim(),
    `**To confirm:** ${f.to_confirm}`,
    `<!-- recensio:finding:${f.id} -->`,
  ].join("\n\n");
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

      if (event === "APPROVE" && (status === 403 || status === 422)) {
        degraded.push(`approval not permitted (status ${status}) — posted as COMMENT instead`);
        event = "COMMENT";
        body = approvalDowngradeNote(placed.verdict) + body;
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
        body = `> Recensio verdict: **${placed.verdict.replace(/_/g, " ")}** (posted as a comment — the workflow token may not request changes on this PR).\n\n` + body;
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

function approvalDowngradeNote(verdict: string): string {
  return `> Recensio verdict: **${verdict.replace(/_/g, " ")}** — posted as a comment because the workflow token is not allowed to approve PRs (repo setting "Allow GitHub Actions to create and approve pull requests").\n\n`;
}

function foldCommentsIntoBody(body: string, comments: InlineComment[]): string {
  if (comments.length === 0) return body;
  const items = comments.map((c) => {
    const range = c.start_line !== undefined ? `${c.start_line}–${c.line}` : `${c.line}`;
    return `**\`${c.path}:${range}\`**\n\n${c.body}`;
  });
  const section = `### Inline findings (could not be anchored)\n\n${items.join("\n\n---\n\n")}`;
  // Keep the footer last.
  const footerIdx = body.lastIndexOf("\n---\n_Recensio");
  if (footerIdx >= 0) return body.slice(0, footerIdx) + "\n\n" + section + body.slice(footerIdx);
  return body + "\n\n" + section;
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
