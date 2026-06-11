import nock from "nock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOctokit } from "../../src/github/client.js";
import { mapVerdict, postReview, renderReviewBody, upsertMarkerComment } from "../../src/github/post.js";
import type { PlacedReview, PrContext } from "../../src/shared/types.js";
import { validReview } from "../helpers/review.js";

const API = "https://api.github.com";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  if (!nock.isDone()) {
    const pending = nock.pendingMocks();
    nock.cleanAll();
    throw new Error(`pending nock mocks: ${pending.join(", ")}`);
  }
  nock.cleanAll();
});

function ctx(): PrContext {
  return {
    meta: {
      owner: "acme",
      repo: "widgets",
      number: 7,
      title: "t",
      body: "",
      author: "alice",
      baseRef: "main",
      baseSha: "b".repeat(40),
      headRef: "f",
      headSha: "a".repeat(40),
      headRepoFullName: "acme/widgets",
      draft: false,
      url: "",
    },
    files: [],
    filesTruncated: false,
  };
}

function placed(overrides: Partial<PlacedReview> = {}): PlacedReview {
  return {
    event: "REQUEST_CHANGES",
    verdict: "REQUEST_CHANGES",
    body: "## review body",
    comments: [
      { path: "src/a.ts", line: 11, side: "RIGHT", body: "**[P0][INTRODUCED] x**" },
      { path: "src/a.ts", line: 20, side: "RIGHT", start_line: 18, start_side: "RIGHT", body: "**[P1][INTRODUCED] y**" },
    ],
    fallbacks: [],
    ...overrides,
  };
}

describe("mapVerdict", () => {
  it.each([
    ["APPROVE", false, "APPROVE"],
    ["APPROVE_WITH_COMMENTS", false, "APPROVE"],
    ["REQUEST_CHANGES", false, "REQUEST_CHANGES"],
    ["BLOCK", false, "REQUEST_CHANGES"],
    ["APPROVE", true, "COMMENT"],
    ["APPROVE_WITH_COMMENTS", true, "COMMENT"],
    ["REQUEST_CHANGES", true, "REQUEST_CHANGES"],
    ["BLOCK", true, "REQUEST_CHANGES"],
  ] as const)("%s neverApprove=%s → %s", (verdict, neverApprove, expected) => {
    expect(mapVerdict(verdict, neverApprove)).toBe(expected);
  });
});

describe("renderReviewBody", () => {
  it("renders mergability heading, verdict line, scores, sections, markers, and stats", () => {
    const review = validReview({
      unconfirmed: [
        {
          id: "F9",
          severity: "P1",
          provenance: "EXPOSED",
          confidence: 65,
          path: "src/x.ts",
          line: 3,
          title: "maybe racy",
          issue: "shared counter without lock",
          risk: "lost updates",
          trigger: "two concurrent calls",
          verification_trail: "src/x.ts:3 increment; no mutex found",
          ai_fix_prompt: "In src/x.ts:3, trace concurrent callers to confirm the race exists; fix only if confirmed.",
          to_confirm: "run the stress test",
        },
      ],
      nits_markdown: "- prefer const",
    });
    const body = renderReviewBody(
      review,
      {
        verified: [{ findingId: "F2", reason: "line-not-in-diff", renderedBody: "**🟡 P2 MEDIUM: body finding**" }],
        unconfirmed: [
          {
            findingId: "F9",
            reason: "line-not-in-diff",
            renderedBody: "**⚠️ Unconfirmed — 🟠 P1 HIGH: maybe racy**\n\n**To confirm:** run the stress test",
          },
        ],
      },
      { headSha: "a".repeat(40), filesReviewed: 26, inlineCommentCount: 5 },
    );
    expect(body).toContain("<!-- recensio:review -->");
    expect(body).toContain(`<!-- recensio:commit:${"a".repeat(40)} -->`);
    // mergability is the H1; the verdict (✅ for approve-with-comments
    // family, 🔁 here) is the H2 under it
    expect(body).toContain("# Mergability Confidence: 2/5");
    expect(body).toContain("## 🔁 REQUEST CHANGES");
    expect(body).toContain("Adds a users endpoint; SQL injection found.");
    expect(body).not.toContain("### Summary");
    expect(body).toContain("| **OVERALL** | 100% | **60/100** |");
    expect(body).toContain("### Findings outside the visible diff");
    expect(body).toContain("### ⚠️ Unconfirmed (confidence 50–79)");
    expect(body).toContain("**To confirm:** run the stress test");
    expect(body).toContain("### Required tests");
    expect(body).not.toContain("Pre-merge checklist");
    expect(body).toContain("### Top actions");
    expect(body).toContain("### 🟢 Nits (batched, non-blocking)");
    expect(body).toContain("Discarded candidates (1)");
    // stats block at the bottom: validReview has 1 P0 finding + the P1 unconfirmed
    expect(body.trim()).toMatch(/26 files reviewed, 5 comments\n\nSeverity breakdown: Critical \(P0\): 1, High \(P1\): 1$/);
    expect(body).not.toContain("_Recensio ·");
  });

  it("uses ✅ for APPROVE WITH COMMENTS", () => {
    const review = validReview({ verdict: "APPROVE_WITH_COMMENTS" });
    const body = renderReviewBody(review, { verified: [], unconfirmed: [] }, { headSha: "x", filesReviewed: 3, inlineCommentCount: 1 });
    expect(body).toContain("## ✅ APPROVE WITH COMMENTS");
    expect(body).not.toContain("💬");
  });

  it("omits empty sections and reports a clean stats block", () => {
    const review = validReview({ findings: [], unconfirmed: [], discarded: [], required_tests: [], top_actions: [], nits_markdown: "" });
    const body = renderReviewBody(review, { verified: [], unconfirmed: [] }, { headSha: "x", filesReviewed: 1, inlineCommentCount: 0 });
    expect(body).not.toContain("Unconfirmed");
    expect(body).not.toContain("Nits");
    expect(body).not.toContain("Discarded");
    expect(body).toContain("1 file reviewed, 0 comments");
    expect(body).toContain("No issues found.");
  });
});

describe("postReview", () => {
  it("posts the full review with inline comments and commit_id", async () => {
    let captured: any;
    nock(API)
      .post("/repos/acme/widgets/pulls/7/reviews", (b) => ((captured = b), true))
      .reply(200, { html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1" });

    const result = await postReview(makeOctokit("tok"), ctx(), placed(), "a".repeat(40));
    expect(result.reviewUrl).toContain("pullrequestreview-1");
    expect(result.degraded).toEqual([]);
    expect(captured).toMatchObject({
      event: "REQUEST_CHANGES",
      commit_id: "a".repeat(40),
      comments: [
        { path: "src/a.ts", line: 11, side: "RIGHT" },
        { path: "src/a.ts", line: 20, side: "RIGHT", start_line: 18, start_side: "RIGHT" },
      ],
    });
  });

  it("downgrades APPROVE to COMMENT when the token may not approve", async () => {
    const bodies: any[] = [];
    nock(API)
      .post("/repos/acme/widgets/pulls/7/reviews", (b) => (bodies.push(b), true))
      .reply(422, { message: "GitHub Actions is not permitted to approve pull requests." })
      .post("/repos/acme/widgets/pulls/7/reviews", (b) => (bodies.push(b), true))
      .reply(200, { html_url: "url2" });

    const p = placed({ event: "APPROVE", verdict: "APPROVE_WITH_COMMENTS", comments: [] });
    const result = await postReview(makeOctokit("tok"), ctx(), p, "sha");
    expect(result.degraded).toHaveLength(1);
    expect(bodies[1].event).toBe("COMMENT");
    // the body is reposted unchanged — no downgrade note is prepended
    expect(bodies[1].body).toBe(bodies[0].body);
  });

  it("retries without inline comments on anchor 422s, folding findings into the body", async () => {
    const bodies: any[] = [];
    nock(API)
      .post("/repos/acme/widgets/pulls/7/reviews", (b) => (bodies.push(b), true))
      .reply(422, { message: "Validation Failed", errors: [{ message: "line must be part of the diff" }] })
      .post("/repos/acme/widgets/pulls/7/reviews", (b) => (bodies.push(b), true))
      .reply(200, { html_url: "url3" });

    const result = await postReview(makeOctokit("tok"), ctx(), placed(), "sha");
    expect(result.degraded[0]).toContain("inline comments rejected");
    expect(bodies[1].comments).toBeUndefined();
    expect(bodies[1].body).toContain("Inline findings (could not be anchored)");
    expect(bodies[1].body).toContain("src/a.ts:18–20");
    // folded section is appended after the original body
    expect(bodies[1].body.indexOf("Inline findings")).toBeGreaterThan(bodies[1].body.indexOf("review body"));
  });

  it("falls back to an issue comment when the reviews API keeps failing", async () => {
    nock(API)
      .post("/repos/acme/widgets/pulls/7/reviews")
      .reply(500, { message: "boom" })
      .post("/repos/acme/widgets/issues/7/comments")
      .reply(201, { html_url: "issue-comment-url" });

    const result = await postReview(makeOctokit("tok"), ctx(), placed(), "sha");
    expect(result.reviewUrl).toBe("issue-comment-url");
    expect(result.degraded[0]).toContain("posted as an issue comment");
  });
});

describe("upsertMarkerComment", () => {
  it("updates the existing marker comment instead of duplicating", async () => {
    let patched: any;
    nock(API)
      .get("/repos/acme/widgets/issues/7/comments")
      .query(true)
      .reply(200, [
        { id: 1, body: "unrelated" },
        { id: 2, body: "old skip\n<!-- recensio:skip -->" },
      ])
      .patch("/repos/acme/widgets/issues/comments/2", (b) => ((patched = b), true))
      .reply(200, {});

    await upsertMarkerComment(makeOctokit("t"), "acme", "widgets", 7, "<!-- recensio:skip -->", "new body\n<!-- recensio:skip -->");
    expect(patched.body).toContain("new body");
  });

  it("creates the comment when no marker exists", async () => {
    nock(API)
      .get("/repos/acme/widgets/issues/7/comments")
      .query(true)
      .reply(200, [])
      .post("/repos/acme/widgets/issues/7/comments")
      .reply(201, {});

    await upsertMarkerComment(makeOctokit("t"), "acme", "widgets", 7, "<!-- recensio:error -->", "body");
  });
});
