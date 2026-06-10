import nock from "nock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOctokit } from "../../src/github/client.js";
import { COMMAND_RE, checkCommenterPermission, parseEvent } from "../../src/github/trigger.js";
import { buildConfig } from "../../src/shared/config.js";

const cfg = buildConfig({ anthropicApiKey: "k", githubToken: "t" });

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());

describe("COMMAND_RE", () => {
  it.each([
    "@recensio",
    "/recensio",
    "@recensio please re-review",
    "hey @recensio take another look",
    "Sure thing.\n/recensio",
    "@Recensio", // case-insensitive
    "/RECENSIO rerun",
  ])("matches %j", (body) => {
    expect(COMMAND_RE.test(body)).toBe(true);
  });

  it.each([
    "recensio is great",
    "email me at a@recensio.dev",
    "see http://x.com/recensiology",
    "/recensiox",
    "@recensioteam hello",
    "",
  ])("does not match %j", (body) => {
    expect(COMMAND_RE.test(body)).toBe(false);
  });
});

const repository = { name: "widgets", owner: { login: "acme" } };

describe("parseEvent: pull_request", () => {
  const pr = (overrides: Record<string, unknown> = {}) => ({
    action: "opened",
    repository,
    pull_request: { number: 7, draft: false, ...overrides },
  });

  it.each(["opened", "ready_for_review", "reopened"])("routes %s to an auto review", (action) => {
    const routed = parseEvent("pull_request", { ...pr(), action }, cfg);
    expect(routed).toMatchObject({
      kind: "review",
      trigger: { kind: "auto", owner: "acme", repo: "widgets", prNumber: 7, bypassGate: false },
    });
  });

  it("skips synchronize unless enabled", () => {
    expect(parseEvent("pull_request", { ...pr(), action: "synchronize" }, cfg)).toMatchObject({
      kind: "skip",
      reason: "unsupported-action",
    });
    const enabled = { ...cfg, reviewOnSynchronize: true };
    expect(parseEvent("pull_request", { ...pr(), action: "synchronize" }, enabled)).toMatchObject({ kind: "review" });
  });

  it("skips drafts and unrelated actions", () => {
    expect(parseEvent("pull_request", pr({ draft: true }), cfg)).toMatchObject({ kind: "skip", reason: "draft" });
    expect(parseEvent("pull_request", { ...pr(), action: "labeled" }, cfg)).toMatchObject({
      kind: "skip",
      reason: "unsupported-action",
    });
  });

  it("accepts pull_request_target the same way", () => {
    expect(parseEvent("pull_request_target", pr(), cfg)).toMatchObject({ kind: "review" });
  });
});

describe("parseEvent: issue_comment", () => {
  const comment = (body: string, overrides: Record<string, unknown> = {}) => ({
    action: "created",
    repository,
    issue: { number: 7, pull_request: { url: "x" } },
    comment: { id: 42, body, user: { login: "bob", type: "User" }, ...overrides },
  });

  it("routes an @recensio comment to a gate-bypassing command review", () => {
    const routed = parseEvent("issue_comment", comment("@recensio re-review please"), cfg);
    expect(routed).toMatchObject({
      kind: "review",
      trigger: {
        kind: "command",
        prNumber: 7,
        commentId: 42,
        commenter: "bob",
        bypassGate: true,
      },
    });
  });

  it("ignores comments without the command, on issues, from bots, or non-created actions", () => {
    expect(parseEvent("issue_comment", comment("nice work!"), cfg)).toMatchObject({ kind: "skip", reason: "no-command" });
    const onIssue = { action: "created", repository, issue: { number: 7 }, comment: { id: 1, body: "@recensio", user: { login: "bob", type: "User" } } };
    expect(parseEvent("issue_comment", onIssue, cfg)).toMatchObject({ kind: "skip", reason: "not-a-pr" });
    expect(
      parseEvent("issue_comment", comment("@recensio", { user: { login: "recensio[bot]", type: "Bot" } }), cfg),
    ).toMatchObject({ kind: "skip", reason: "bot-comment" });
    expect(parseEvent("issue_comment", { ...comment("@recensio"), action: "edited" }, cfg)).toMatchObject({
      kind: "skip",
      reason: "unsupported-action",
    });
  });
});

describe("parseEvent: other events", () => {
  it("skips unknown events", () => {
    expect(parseEvent("push", {}, cfg)).toMatchObject({ kind: "skip", reason: "unsupported-event" });
  });
});

describe("checkCommenterPermission", () => {
  it.each([
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["read", false],
    ["none", false],
  ])("permission %s → %s", async (permission, expected) => {
    nock("https://api.github.com")
      .get("/repos/acme/widgets/collaborators/bob/permission")
      .reply(200, { permission });
    await expect(checkCommenterPermission(makeOctokit("t"), "acme", "widgets", "bob")).resolves.toBe(expected);
  });

  it("treats a 404 (not a collaborator) as denied", async () => {
    nock("https://api.github.com").get("/repos/acme/widgets/collaborators/mallory/permission").reply(404, {});
    await expect(checkCommenterPermission(makeOctokit("t"), "acme", "widgets", "mallory")).resolves.toBe(false);
  });
});
