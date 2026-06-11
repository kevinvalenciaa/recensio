import nock from "nock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOctokit } from "../../src/github/client.js";
import { checkReviewRateLimit, rateLimitCommentBody } from "../../src/github/ratelimit.js";

const API = "https://api.github.com";
const RUN_ID = 999;

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function run(id: number, createdMinutesAgo: number, conclusion: string | null = "success") {
  return { id, created_at: minutesAgo(createdMinutesAgo), conclusion };
}

function mockRuns(workflowRuns: unknown[]) {
  return nock(API)
    .get(`/repos/acme/widgets/actions/runs/${RUN_ID}`)
    .reply(200, { id: RUN_ID, workflow_id: 55 })
    .get("/repos/acme/widgets/actions/workflows/55/runs")
    .query(true)
    .reply(200, { total_count: workflowRuns.length, workflow_runs: workflowRuns });
}

describe("checkReviewRateLimit", () => {
  it("allows runs under the limit", async () => {
    mockRuns([run(1, 50), run(2, 30), run(3, 10)]);
    const r = await checkReviewRateLimit(makeOctokit("t"), "acme", "widgets", 8, RUN_ID);
    expect(r).toMatchObject({ limited: false, recentRuns: 3, limit: 8 });
  });

  it("throttles at the limit and reports when a slot frees", async () => {
    mockRuns(Array.from({ length: 8 }, (_, i) => run(i + 1, 55 - i * 5)));
    const r = await checkReviewRateLimit(makeOctokit("t"), "acme", "widgets", 8, RUN_ID);
    expect(r.limited).toBe(true);
    expect(r.recentRuns).toBe(8);
    // oldest counted run was ~55m ago → slot frees in ~5m
    const minutesUntil = (r.retryAt!.getTime() - Date.now()) / 60_000;
    expect(minutesUntil).toBeGreaterThan(3);
    expect(minutesUntil).toBeLessThan(7);
    expect(rateLimitCommentBody(r)).toContain("8 runs in the past hour (limit 8)");
    expect(rateLimitCommentBody(r)).toContain("<!-- recensio:ratelimit -->");
  });

  it("excludes the current run, cancelled/skipped runs, and runs older than an hour", async () => {
    mockRuns([
      run(RUN_ID, 1), // current run
      run(1, 5, "cancelled"), // superseded by concurrency group
      run(2, 5, "skipped"),
      run(3, 90), // outside the window (defensive: API filter should already drop it)
      run(4, 10),
    ]);
    const r = await checkReviewRateLimit(makeOctokit("t"), "acme", "widgets", 8, RUN_ID);
    expect(r).toMatchObject({ limited: false, recentRuns: 1 });
  });

  it("counts in-progress and failed runs as consumed slots", async () => {
    mockRuns([run(1, 5, null), run(2, 10, "failure")]);
    const r = await checkReviewRateLimit(makeOctokit("t"), "acme", "widgets", 2, RUN_ID);
    expect(r.limited).toBe(true);
  });

  it("is disabled when the limit is 0 or there is no run id (CLI)", async () => {
    // no nock mocks: any API call would throw via disableNetConnect
    expect((await checkReviewRateLimit(makeOctokit("t"), "acme", "widgets", 0, RUN_ID)).limited).toBe(false);
    expect((await checkReviewRateLimit(makeOctokit("t"), "acme", "widgets", 8, undefined)).limited).toBe(false);
    expect((await checkReviewRateLimit(makeOctokit("t"), "acme", "widgets", 8, Number.NaN)).limited).toBe(false);
  });

  it("fails open when run history is not readable (missing actions: read)", async () => {
    nock(API).get(`/repos/acme/widgets/actions/runs/${RUN_ID}`).reply(403, { message: "Resource not accessible" });
    const r = await checkReviewRateLimit(makeOctokit("t"), "acme", "widgets", 8, RUN_ID);
    expect(r.limited).toBe(false);
  });
});
