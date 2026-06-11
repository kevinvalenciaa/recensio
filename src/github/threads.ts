import type { Octokit } from "./client.js";
import { log } from "../shared/log.js";

const FINDING_MARKER_RE = /<!-- recensio:finding:(F\d+) -->/;

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  /** Root comment's REST database id (for posting replies). */
  rootCommentId: number;
  /** Finding id parsed from the root comment's hidden marker, if any. */
  findingId?: string;
}

interface ThreadsQueryResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: { nodes: Array<{ databaseId: number | null; body: string }> };
        }>;
      };
    };
  };
}

const THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ id isResolved comments(first:1){ nodes{ databaseId body } } }
      }
    }
  }
}`;

/** Enumerates a PR's review threads, tagging each with its Recensio finding id. */
export async function listReviewThreads(
  ok: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  // Bound the walk so a pathological PR can't loop forever.
  for (let page = 0; page < 20; page++) {
    const data: ThreadsQueryResult = await ok.graphql(THREADS_QUERY, { owner, repo, number, cursor });
    const tr = data.repository.pullRequest.reviewThreads;
    for (const node of tr.nodes) {
      const root = node.comments.nodes[0];
      if (!root || root.databaseId == null) continue;
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        rootCommentId: root.databaseId,
        findingId: root.body.match(FINDING_MARKER_RE)?.[1],
      });
    }
    if (!tr.pageInfo.hasNextPage) break;
    cursor = tr.pageInfo.endCursor;
  }
  return threads;
}

const RESOLVE_MUTATION = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } }
}`;

export interface ResolutionTelemetry {
  attempted: number;
  replied: number;
  resolved: number;
  forbidden: number;
}

/**
 * For each prior finding the agent verified fixed, posts a "verified fixed"
 * reply on its thread and attempts to resolve it. Resolution requires the
 * token to hold Contents: write — which most consumers won't grant — so the
 * reply (which needs only pull-requests: write) is the guaranteed step and
 * resolution is best-effort. Only touches our own, currently-unresolved
 * threads whose finding the agent reported fixed.
 */
export async function resolveFixedFindings(
  ok: Octokit,
  owner: string,
  repo: string,
  number: number,
  resolved: Array<{ id: string; evidence: string }>,
  headSha: string,
): Promise<ResolutionTelemetry> {
  const telemetry: ResolutionTelemetry = { attempted: 0, replied: 0, resolved: 0, forbidden: 0 };
  if (resolved.length === 0) return telemetry;

  let threads: ReviewThread[];
  try {
    threads = await listReviewThreads(ok, owner, repo, number);
  } catch (err) {
    log.warn(`could not list review threads (resolution skipped): ${String(err)}`);
    return telemetry;
  }
  const byFinding = new Map<string, ReviewThread>();
  for (const t of threads) {
    if (t.findingId && !t.isResolved && !byFinding.has(t.findingId)) byFinding.set(t.findingId, t);
  }

  for (const r of resolved) {
    const thread = byFinding.get(r.id);
    if (!thread) continue;
    telemetry.attempted += 1;

    try {
      await ok.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: number,
        comment_id: thread.rootCommentId,
        body: `✅ Recensio verified this fixed at \`${headSha.slice(0, 10)}\`: ${r.evidence}`,
      });
      telemetry.replied += 1;
    } catch (err) {
      log.warn(`could not reply to thread for ${r.id}: ${String(err)}`);
    }

    try {
      await ok.graphql(RESOLVE_MUTATION, { threadId: thread.id });
      telemetry.resolved += 1;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/not accessible|forbidden|FORBIDDEN/i.test(msg)) {
        telemetry.forbidden += 1;
      } else {
        log.warn(`could not resolve thread for ${r.id}: ${msg}`);
      }
    }
  }

  if (telemetry.forbidden > 0) {
    log.warn(
      `resolved ${telemetry.resolved}/${telemetry.attempted} threads; ${telemetry.forbidden} need the token to have "contents: write" to collapse (replies were still posted).`,
    );
  }
  return telemetry;
}
