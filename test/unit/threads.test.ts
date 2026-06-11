import nock from "nock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOctokit } from "../../src/github/client.js";
import { listReviewThreads, resolveFixedFindings } from "../../src/github/threads.js";

const API = "https://api.github.com";

beforeAll(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
});

function thread(id: string, dbId: number | null, findingId: string | null, isResolved = false) {
  return {
    id,
    isResolved,
    comments: {
      nodes: [{ databaseId: dbId, body: findingId ? `**finding**\n<!-- recensio:finding:${findingId} -->` : "plain comment" }],
    },
  };
}

function graphqlPage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } } } },
  };
}

describe("listReviewThreads", () => {
  it("paginates and tags threads with their finding id", async () => {
    nock(API)
      .post("/graphql", (b) => b.query.includes("reviewThreads") && b.variables.cursor === null)
      .reply(200, graphqlPage([thread("T1", 101, "F1")], true, "CUR"))
      .post("/graphql", (b) => b.variables.cursor === "CUR")
      .reply(200, graphqlPage([thread("T2", 102, null), thread("T3", null, "F9")]));

    const threads = await listReviewThreads(makeOctokit("t"), "acme", "widgets", 7);
    expect(threads).toEqual([
      { id: "T1", isResolved: false, rootCommentId: 101, findingId: "F1" },
      { id: "T2", isResolved: false, rootCommentId: 102, findingId: undefined },
      // T3 dropped: no databaseId
    ]);
  });
});

describe("resolveFixedFindings", () => {
  it("no-ops on empty input without any network call", async () => {
    const t = await resolveFixedFindings(makeOctokit("t"), "acme", "widgets", 7, [], "a".repeat(40));
    expect(t).toEqual({ attempted: 0, replied: 0, resolved: 0, forbidden: 0 });
  });

  it("replies to and resolves the matching unresolved thread", async () => {
    let reply: any;
    let mutation: any;
    nock(API)
      .post("/graphql", (b) => b.query.includes("reviewThreads"))
      .reply(200, graphqlPage([thread("T1", 101, "F1"), thread("T2", 102, "F2", true)]))
      .post("/repos/acme/widgets/pulls/7/comments/101/replies", (b) => ((reply = b), true))
      .reply(201, {})
      .post("/graphql", (b) => (b.query.includes("resolveReviewThread") ? ((mutation = b), true) : false))
      .reply(200, { data: { resolveReviewThread: { thread: { isResolved: true } } } });

    const t = await resolveFixedFindings(
      makeOctokit("t"),
      "acme",
      "widgets",
      7,
      [{ id: "F1", evidence: "param now uses $1 placeholder" }],
      "abcdef1234567890",
    );
    expect(t).toEqual({ attempted: 1, replied: 1, resolved: 1, forbidden: 0 });
    expect(reply.body).toContain("✅ Recensio verified this fixed at `abcdef1234`");
    expect(reply.body).toContain("param now uses $1 placeholder");
    expect(mutation.variables.threadId).toBe("T1");
  });

  it("counts FORBIDDEN resolution but still posts the reply", async () => {
    nock(API)
      .post("/graphql", (b) => b.query.includes("reviewThreads"))
      .reply(200, graphqlPage([thread("T1", 101, "F1")]))
      .post("/repos/acme/widgets/pulls/7/comments/101/replies")
      .reply(201, {})
      .post("/graphql", (b) => b.query.includes("resolveReviewThread"))
      .reply(200, { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });

    const t = await resolveFixedFindings(makeOctokit("t"), "acme", "widgets", 7, [{ id: "F1", evidence: "fixed" }], "sha");
    expect(t).toMatchObject({ attempted: 1, replied: 1, resolved: 0, forbidden: 1 });
  });

  it("skips findings whose thread is already resolved or missing", async () => {
    nock(API)
      .post("/graphql", (b) => b.query.includes("reviewThreads"))
      .reply(200, graphqlPage([thread("T2", 102, "F2", true)]));

    const t = await resolveFixedFindings(
      makeOctokit("t"),
      "acme",
      "widgets",
      7,
      [
        { id: "F2", evidence: "already resolved thread" }, // thread isResolved → skip
        { id: "F8", evidence: "no thread for this id" }, // no match → skip
      ],
      "sha",
    );
    expect(t).toEqual({ attempted: 0, replied: 0, resolved: 0, forbidden: 0 });
  });
});
