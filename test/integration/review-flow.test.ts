import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nock from "nock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { makeOctokit } from "../../src/github/client.js";
import { runReview } from "../../src/engine/review.js";
import type { TurnRunner } from "../../src/engine/agent.js";
import { buildConfig, type Config } from "../../src/shared/config.js";
import type { TriggerContext } from "../../src/shared/types.js";
import { validReview } from "../helpers/review.js";

const API = "https://api.github.com";
const HEAD_SHA = "a".repeat(40);

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());

function cfg(overrides: Partial<Config> = {}): Config {
  return { ...buildConfig({ anthropicApiKey: "k", githubToken: "t" }), ...overrides };
}

const autoTrigger: TriggerContext = { kind: "auto", owner: "acme", repo: "widgets", prNumber: 7, bypassGate: false };

// Patch: head lines 140..146 visible, 142-143 added.
const PATCH = [
  "@@ -140,5 +140,7 @@",
  " function getUsers(req, res) {",
  "  const name = req.query.name;",
  "+ const q = `SELECT * FROM users WHERE name = '${name}'`;",
  "+ const rows = db.query(q);",
  "  res.json(rows);",
  " }",
  " module.exports = { getUsers };",
].join("\n");

function prGetResponse(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "Add users endpoint",
    body: "Adds GET /users",
    user: { login: "alice" },
    base: { ref: "main", sha: "b".repeat(40) },
    head: { ref: "feat", sha: HEAD_SHA, repo: { full_name: "acme/widgets" } },
    draft: false,
    html_url: "https://github.com/acme/widgets/pull/7",
    ...overrides,
  };
}

function fileEntry(additions: number, deletions: number) {
  return { filename: "src/api/users.ts", status: "modified", additions, deletions, changes: additions + deletions, patch: PATCH };
}

/** A fake checkout containing the file the finding anchors to. */
function fakeClone(sha = HEAD_SHA) {
  const dir = mkdtempSync(path.join(tmpdir(), "recensio-int-"));
  mkdirSync(path.join(dir, "src", "api"), { recursive: true });
  const lines = Array.from({ length: 200 }, (_, i) => `// filler ${i + 1}`);
  lines[141] = " const q = `SELECT * FROM users WHERE name = '${name}'`;";
  writeFileSync(path.join(dir, "src", "api", "users.ts"), lines.join("\n"));
  return async () => ({
    dir,
    headSha: sha,
    baseSha: "b".repeat(40),
    historyAvailable: false,
    gitConfigArgs: [],
    cleanup: async () => {},
  });
}

function submittingRunner(review = validReview()): { runTurn: TurnRunner; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const responses: Anthropic.Message[] = [
    {
      content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "src/api/users.ts", start_line: 130, end_line: 160 } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 5000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 },
    } as unknown as Anthropic.Message,
    {
      content: [{ type: "tool_use", id: "t2", name: "submit_review", input: review }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 900, cache_read_input_tokens: 14000, cache_creation_input_tokens: 400 },
    } as unknown as Anthropic.Message,
  ];
  const runTurn: TurnRunner = async (params) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    const next = responses.shift();
    if (!next) throw new Error("exhausted");
    return next;
  };
  return { runTurn, requests };
}

function mockPrFetch(files: unknown[], reviews: unknown[] = []) {
  const scope = nock(API)
    .get("/repos/acme/widgets/pulls/7")
    .reply(200, prGetResponse())
    .get("/repos/acme/widgets/pulls/7/files")
    .query(true)
    .reply(200, files)
    .get("/repos/acme/widgets/pulls/7/reviews")
    .query(true)
    .reply(200, reviews);
  // Config load (M4): runs before the gate on every path. Default = no config.
  scope
    .get("/repos/acme/widgets")
    .reply(200, { default_branch: "main" })
    .get("/repos/acme/widgets/contents/.recensio.yml")
    .query(true)
    .reply(404, {});
  // Dependency block (M1): runs after clone, so skip-at-gate tests never hit it.
  scope
    .get((uri) => uri.startsWith("/repos/acme/widgets/dependency-graph/compare/"))
    .query(true)
    .optionally()
    .reply(200, []);
  return scope;
}

describe("runReview end to end (mocked GitHub + scripted agent)", () => {
  it("reviews a gate-passing PR and posts inline comments anchored to the diff", async () => {
    const review = validReview();
    review.findings[0]!.path = "src/api/users.ts";
    review.findings[0]!.line = 142;

    let posted: any;
    mockPrFetch([fileEntry(400, 200)])
      .post("/repos/acme/widgets/pulls/7/reviews", (b) => ((posted = b), true))
      .reply(200, { html_url: "review-url" });

    const { runTurn, requests } = submittingRunner(review);
    const outcome = await runReview(autoTrigger, cfg(), makeOctokit("t"), { turnRunner: runTurn, clone: fakeClone() });

    expect(outcome).toMatchObject({ kind: "reviewed", verdict: "REQUEST_CHANGES", event: "REQUEST_CHANGES", inlineCount: 1, fallbackCount: 0, reviewUrl: "review-url" });
    expect(posted.commit_id).toBe(HEAD_SHA);
    expect(posted.event).toBe("REQUEST_CHANGES");
    expect(posted.comments).toHaveLength(1);
    expect(posted.comments[0]).toMatchObject({ path: "src/api/users.ts", line: 142, side: "RIGHT" });
    expect(posted.comments[0].body).toContain("```suggestion");
    expect(posted.body).toContain("<!-- recensio:review -->");
    expect(posted.body).toContain(`<!-- recensio:commit:${HEAD_SHA} -->`);

    // the agent really got the PR context and executed the read_file call
    const initialText = JSON.stringify(requests[0]!.messages);
    expect(initialText).toContain("Add users endpoint");
    expect(initialText).toContain("SELECT * FROM users");
    const secondTurn = requests[1]!.messages as Array<{ content: unknown }>;
    expect(JSON.stringify(secondTurn[2])).toContain("filler 131");
  });

  it("demotes findings that are not anchorable into the review body", async () => {
    const review = validReview();
    review.findings[0]!.path = "src/api/users.ts";
    review.findings[0]!.line = 30; // far outside the hunk

    let posted: any;
    mockPrFetch([fileEntry(400, 200)])
      .post("/repos/acme/widgets/pulls/7/reviews", (b) => ((posted = b), true))
      .reply(200, { html_url: "u" });

    const outcome = await runReview(autoTrigger, cfg(), makeOctokit("t"), {
      turnRunner: submittingRunner(review).runTurn,
      clone: fakeClone(),
    });
    expect(outcome).toMatchObject({ kind: "reviewed", inlineCount: 0, fallbackCount: 1 });
    expect(posted.comments).toBeUndefined();
    expect(posted.body).toContain("Findings outside the visible diff");
    expect(posted.body).toContain(`blob/${HEAD_SHA}/src/api/users.ts#L30`);
  });

  it("skips below-threshold PRs with the exact spec message and never calls the model", async () => {
    let skipBody: any;
    mockPrFetch([fileEntry(100, 50)])
      .get("/repos/acme/widgets/issues/7/comments")
      .query(true)
      .reply(200, [])
      .post("/repos/acme/widgets/issues/7/comments", (b) => ((skipBody = b), true))
      .reply(201, {});

    const runTurn: TurnRunner = async () => {
      throw new Error("the model must not be called for gated PRs");
    };
    const outcome = await runReview(autoTrigger, cfg(), makeOctokit("t"), { turnRunner: runTurn, clone: fakeClone() });
    expect(outcome).toMatchObject({ kind: "skipped-gate", gate: { changedLoc: 150, belowThreshold: true } });
    expect(skipBody.body).toContain("⏭️ SKIPPED — PR below review threshold");
    expect(skipBody.body).toContain("Changed LOC: 150 (threshold: 500) · Files changed: 1");
    expect(skipBody.body).toContain("<!-- recensio:skip -->");
  });

  it("updates the existing skip comment instead of posting a duplicate", async () => {
    let patched: any;
    mockPrFetch([fileEntry(100, 50)])
      .get("/repos/acme/widgets/issues/7/comments")
      .query(true)
      .reply(200, [{ id: 9, body: "old\n<!-- recensio:skip -->" }])
      .patch("/repos/acme/widgets/issues/comments/9", (b) => ((patched = b), true))
      .reply(200, {});

    await runReview(autoTrigger, cfg(), makeOctokit("t"), {
      turnRunner: async () => {
        throw new Error("no model call");
      },
      clone: fakeClone(),
    });
    expect(patched.body).toContain("Changed LOC: 150");
  });

  it("bypasses the gate for explicit command triggers", async () => {
    const review = validReview();
    review.findings = [];
    mockPrFetch([fileEntry(100, 50)])
      .post("/repos/acme/widgets/pulls/7/reviews")
      .reply(200, { html_url: "u" });

    const command: TriggerContext = { ...autoTrigger, kind: "command", commenter: "bob", commentBody: "@recensio go", bypassGate: true };
    const { runTurn, requests } = submittingRunner(review);
    const outcome = await runReview(command, cfg(), makeOctokit("t"), { turnRunner: runTurn, clone: fakeClone() });
    expect(outcome.kind).toBe("reviewed");
    expect(JSON.stringify(requests[0]!.messages)).toContain("size gate bypassed by this explicit request");
  });

  it("re-syncs the file list when the cloned head differs (force-push race)", async () => {
    const newSha = "c".repeat(40);
    const review = validReview();
    review.findings[0]!.path = "src/api/users.ts";
    review.findings[0]!.line = 142;

    let posted: any;
    mockPrFetch([fileEntry(400, 200)])
      .get("/repos/acme/widgets/pulls/7/files")
      .query(true)
      .reply(200, [fileEntry(450, 250)]) // refetched list
      .post("/repos/acme/widgets/pulls/7/reviews", (b) => ((posted = b), true))
      .reply(200, { html_url: "u" });

    const outcome = await runReview(autoTrigger, cfg(), makeOctokit("t"), {
      turnRunner: submittingRunner(review).runTurn,
      clone: fakeClone(newSha),
    });
    expect(outcome.kind).toBe("reviewed");
    expect(posted.commit_id).toBe(newSha);
    expect(posted.body).toContain(`<!-- recensio:commit:${newSha} -->`);
  });

  it("skips drafts on auto triggers without touching the network further", async () => {
    nock(API)
      .get("/repos/acme/widgets/pulls/7")
      .reply(200, prGetResponse({ draft: true }))
      .get("/repos/acme/widgets/pulls/7/files")
      .query(true)
      .reply(200, [fileEntry(400, 200)])
      .get("/repos/acme/widgets/pulls/7/reviews")
      .query(true)
      .reply(200, []);

    const outcome = await runReview(autoTrigger, cfg(), makeOctokit("t"), {
      turnRunner: async () => {
        throw new Error("no model call");
      },
      clone: fakeClone(),
    });
    expect(outcome).toMatchObject({ kind: "skipped-draft" });
  });

  it("returns the rendered review without posting on dry runs", async () => {
    const review = validReview();
    review.findings[0]!.path = "src/api/users.ts";
    review.findings[0]!.line = 142;
    mockPrFetch([fileEntry(400, 200)]);

    const outcome = await runReview(autoTrigger, cfg({ dryRun: true }), makeOctokit("t"), {
      turnRunner: submittingRunner(review).runTurn,
      clone: fakeClone(),
    });
    expect(outcome.kind).toBe("reviewed");
    if (outcome.kind === "reviewed") {
      expect(outcome.rendered?.body).toContain("<!-- recensio:review -->");
      expect(outcome.rendered?.comments).toHaveLength(1);
    }
  });

  it("includes the previous-review digest on re-reviews", async () => {
    const prevBody = `<!-- recensio:review -->\n<!-- recensio:commit:${"d".repeat(40)} -->\n## 🔁 REQUEST CHANGES\n\n**Mergability Confidence: 2/5** · Verdict: **REQUEST CHANGES**\n\nfound stuff`;
    const review = validReview();
    review.findings = [];

    mockPrFetch(
      [fileEntry(400, 200)],
      [{ id: 1, body: prevBody, commit_id: "d".repeat(40), submitted_at: "2026-06-01T00:00:00Z", user: { login: "github-actions[bot]" } }],
    )
      .get("/repos/acme/widgets/pulls/7/comments")
      .query(true)
      .reply(200, [
        {
          id: 5,
          path: "src/api/users.ts",
          line: 142,
          body: "**[P0][INTRODUCED] SQL injection** · `F1` · confidence 96/100\n\nstuff\n\n<!-- recensio:finding:F1 -->",
        },
      ])
      .post("/repos/acme/widgets/pulls/7/reviews")
      .reply(200, { html_url: "u" });

    const command: TriggerContext = { ...autoTrigger, kind: "command", commenter: "bob", bypassGate: true };
    const { runTurn, requests } = submittingRunner(review);
    await runReview(command, cfg(), makeOctokit("t"), { turnRunner: runTurn, clone: fakeClone() });

    const initial = JSON.stringify(requests[0]!.messages);
    expect(initial).toContain("previous_review");
    expect(initial).toContain("F1 [P0] src/api/users.ts:142");
    expect(initial).toContain("REQUEST CHANGES");
  });

  it("replies to and resolves a prior finding the agent reports fixed", async () => {
    const prevBody = `<!-- recensio:review -->\n<!-- recensio:commit:${"d".repeat(40)} -->\n## 🔁 REQUEST CHANGES\n\nfound stuff`;
    const review = validReview({ findings: [], resolved_findings: [{ id: "F1", evidence: "now parameterized" }] });

    let reply: any;
    let mutation: any;
    mockPrFetch(
      [fileEntry(400, 200)],
      [{ id: 1, body: prevBody, commit_id: "d".repeat(40), submitted_at: "2026-06-01T00:00:00Z", user: { login: "x[bot]" } }],
    )
      .get("/repos/acme/widgets/pulls/7/comments")
      .query(true)
      .reply(200, [
        { id: 5, path: "src/api/users.ts", line: 142, body: "**F1**\n\n<!-- recensio:finding:F1 -->" },
      ])
      .post("/repos/acme/widgets/pulls/7/reviews")
      .reply(200, { html_url: "u" })
      .post("/graphql", (b: any) => b.query.includes("reviewThreads"))
      .reply(200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 5, body: "x\n<!-- recensio:finding:F1 -->" }] } }],
              },
            },
          },
        },
      })
      .post("/repos/acme/widgets/pulls/7/comments/5/replies", (b: any) => ((reply = b), true))
      .reply(201, {})
      .post("/graphql", (b: any) => (b.query.includes("resolveReviewThread") ? ((mutation = b), true) : false))
      .reply(200, { data: { resolveReviewThread: { thread: { isResolved: true } } } });

    const command: TriggerContext = { ...autoTrigger, kind: "command", commenter: "bob", bypassGate: true };
    const outcome = await runReview(command, cfg(), makeOctokit("t"), {
      turnRunner: submittingRunner(review).runTurn,
      clone: fakeClone(),
    });

    expect(reply.body).toContain("now parameterized");
    expect(mutation.variables.threadId).toBe("T1");
    if (outcome.kind === "reviewed") {
      expect(outcome.resolution).toMatchObject({ attempted: 1, replied: 1, resolved: 1, forbidden: 0 });
    }
  });
});
