import nock from "nock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOctokit } from "../../src/github/client.js";
import { fetchDismissedFindings } from "../../src/github/feedback.js";

const API = "https://api.github.com";

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());

function findingComment(id: number, fid: string, title = "race condition") {
  return { id, path: "src/x.ts", line: 10, body: `**🟠 P1 HIGH: ${title}**\n\n<!-- recensio:finding:${fid} -->` };
}

describe("fetchDismissedFindings", () => {
  it("flags a finding when a human reply dismisses it", async () => {
    nock(API)
      .get("/repos/acme/widgets/pulls/7/comments")
      .query(true)
      .reply(200, [
        findingComment(1, "F1"),
        { id: 2, in_reply_to_id: 1, user: { login: "alice", type: "User" }, body: "This is by design, not a bug." },
      ])
      // F1 already dismissed via reply, so its reactions aren't checked.
      .get("/repos/acme/widgets/pulls/comments/1/reactions")
      .query(true)
      .optionally()
      .reply(200, []);

    const dismissed = await fetchDismissedFindings(makeOctokit("t"), "acme", "widgets", 7, new Set());
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]).toMatchObject({ priorId: "F1", path: "src/x.ts", line: 10 });
    expect(dismissed[0]!.signal).toContain("@alice");
    expect(dismissed[0]!.signal).toContain("by design");
  });

  it("flags a finding with a 👎 reaction", async () => {
    nock(API)
      .get("/repos/acme/widgets/pulls/7/comments")
      .query(true)
      .reply(200, [findingComment(1, "F1")])
      .get("/repos/acme/widgets/pulls/comments/1/reactions")
      .query(true)
      .reply(200, [{ content: "-1", user: { login: "bob" } }]);

    const dismissed = await fetchDismissedFindings(makeOctokit("t"), "acme", "widgets", 7, new Set());
    expect(dismissed[0]).toMatchObject({ priorId: "F1", signal: "👎 from @bob" });
  });

  it("ignores bot replies and non-dismissive human replies", async () => {
    nock(API)
      .get("/repos/acme/widgets/pulls/7/comments")
      .query(true)
      .reply(200, [
        findingComment(1, "F1"),
        { id: 2, in_reply_to_id: 1, user: { login: "recensio[bot]", type: "Bot" }, body: "not a bug anymore, fixed" },
        { id: 3, in_reply_to_id: 1, user: { login: "carol", type: "User" }, body: "good catch, will fix" },
      ])
      .get("/repos/acme/widgets/pulls/comments/1/reactions")
      .query(true)
      .reply(200, [{ content: "+1", user: { login: "carol" } }]);

    const dismissed = await fetchDismissedFindings(makeOctokit("t"), "acme", "widgets", 7, new Set());
    expect(dismissed).toEqual([]);
  });

  it("returns empty when there are no Recensio finding comments", async () => {
    nock(API)
      .get("/repos/acme/widgets/pulls/7/comments")
      .query(true)
      .reply(200, [{ id: 1, body: "a human comment", user: { login: "x" } }]);
    expect(await fetchDismissedFindings(makeOctokit("t"), "acme", "widgets", 7, new Set())).toEqual([]);
  });
});
