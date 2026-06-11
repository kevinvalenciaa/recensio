import type { Octokit } from "./client.js";
import { log } from "../shared/log.js";

export const RATELIMIT_MARKER = "<!-- recensio:ratelimit -->";

export interface RateLimitResult {
  limited: boolean;
  recentRuns: number;
  limit: number;
  /** When the oldest counted slot ages out of the 1-hour window. */
  retryAt?: Date;
}

const WINDOW_MS = 60 * 60 * 1000;

/**
 * Caps how many reviews this repository runs per hour, using the workflow's
 * own run history as the ledger (no external state). Counts runs of the
 * current workflow created in the past hour, excluding the current run and
 * runs cancelled by the concurrency group. The count is slightly conservative
 * — a no-op run (e.g. a bot comment that matched the workflow prefilter)
 * consumes a slot — which is the right bias for a cost-protection limit.
 *
 * Fails open: if run history cannot be read (e.g. the workflow lacks
 * `actions: read`), the review proceeds and a warning is logged.
 */
export async function checkReviewRateLimit(
  ok: Octokit,
  owner: string,
  repo: string,
  limit: number,
  currentRunId: number | undefined,
): Promise<RateLimitResult> {
  if (limit <= 0 || currentRunId === undefined || Number.isNaN(currentRunId)) {
    return { limited: false, recentRuns: 0, limit };
  }

  const cutoff = new Date(Date.now() - WINDOW_MS);
  try {
    const { data: currentRun } = await ok.rest.actions.getWorkflowRun({ owner, repo, run_id: currentRunId });
    const { data } = await ok.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: currentRun.workflow_id,
      created: `>=${cutoff.toISOString()}`,
      per_page: 100,
    });

    const counted = data.workflow_runs
      .filter(
        (r) =>
          r.id !== currentRunId &&
          r.conclusion !== "cancelled" &&
          r.conclusion !== "skipped" &&
          new Date(r.created_at) >= cutoff,
      )
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    if (counted.length < limit) {
      return { limited: false, recentRuns: counted.length, limit };
    }
    // The window drops below the limit once the oldest (count - limit + 1)
    // runs age out; the last of those is index (count - limit).
    const freeing = counted[counted.length - limit]!;
    return {
      limited: true,
      recentRuns: counted.length,
      limit,
      retryAt: new Date(new Date(freeing.created_at).getTime() + WINDOW_MS),
    };
  } catch (err: any) {
    log.warn(
      `rate-limit check unavailable (${err?.status ?? "?"}) — proceeding. Grant the workflow "actions: read" to enable it.`,
    );
    return { limited: false, recentRuns: 0, limit };
  }
}

export function rateLimitCommentBody(result: RateLimitResult): string {
  const retry =
    result.retryAt !== undefined
      ? ` Try again after ${result.retryAt.toISOString().slice(11, 16)} UTC, or raise \`max-reviews-per-hour\`.`
      : "";
  return [
    `⏳ **Recensio is rate-limited:** ${result.recentRuns} runs in the past hour (limit ${result.limit}).${retry}`,
    RATELIMIT_MARKER,
  ].join("\n");
}
