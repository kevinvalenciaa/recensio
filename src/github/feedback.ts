import type { Octokit } from "./client.js";
import { log } from "../shared/log.js";

const FINDING_MARKER_RE = /<!-- recensio:finding:(F\d+) -->/;
const DISMISS_RE = /\b(not a bug|false[ -]positive|wont?'?t fix|won'?t fix|by design|intended|as intended|ignore this|disagree|incorrect)\b/i;
const MAX_DISMISSED = 20;
const SIGNAL_MAX = 160;

export interface DismissedFinding {
  /** Prior-review finding id (content recognition; the new run assigns fresh ids). */
  priorId: string;
  path: string;
  line: number | null;
  title: string;
  /** Why we think it was dismissed (a 👎 or a paraphrased human reply). */
  signal: string;
}

/**
 * Mines human pushback on Recensio's own prior comments so the next run won't
 * re-raise findings the team already rejected. Two unambiguous signals: a 👎
 * reaction on the finding comment, or a human reply with dismissive wording.
 * Deliberately does NOT treat a resolved thread as dismissal — Recensio
 * resolves its own threads (M3), which would create a feedback loop.
 */
export async function fetchDismissedFindings(
  ok: Octokit,
  owner: string,
  repo: string,
  number: number,
  botLogins: Set<string>,
): Promise<DismissedFinding[]> {
  let comments: Array<Record<string, any>>;
  try {
    comments = (await ok.paginate(ok.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    })) as Array<Record<string, any>>;
  } catch (err) {
    log.warn(`could not mine prior feedback: ${String(err)}`);
    return [];
  }

  // Index Recensio finding comments by their database id.
  const findingComments = new Map<number, { priorId: string; path: string; line: number | null; title: string }>();
  for (const c of comments) {
    const m = (c.body as string | undefined)?.match(FINDING_MARKER_RE);
    if (!m) continue;
    const title = (c.body as string).split("\n")[0]!.replace(/\*\*/g, "").slice(0, 160);
    findingComments.set(c.id, { priorId: m[1]!, path: c.path, line: c.line ?? c.original_line ?? null, title });
  }
  if (findingComments.size === 0) return [];

  const dismissed = new Map<string, DismissedFinding>();

  // Signal 1: a human reply with dismissive wording.
  for (const c of comments) {
    const replyTo: number | undefined = c.in_reply_to_id;
    if (replyTo === undefined || !findingComments.has(replyTo)) continue;
    const author: string = c.user?.login ?? "";
    if (botLogins.has(author) || author.endsWith("[bot]")) continue;
    const body: string = c.body ?? "";
    if (DISMISS_RE.test(body)) {
      const fc = findingComments.get(replyTo)!;
      dismissed.set(fc.priorId, { ...fc, signal: `@${author}: ${body.replace(/\s+/g, " ").trim().slice(0, SIGNAL_MAX)}` });
    }
  }

  // Signal 2: a 👎 reaction on the finding comment.
  for (const [commentId, fc] of findingComments) {
    if (dismissed.has(fc.priorId) || dismissed.size >= MAX_DISMISSED) continue;
    try {
      const reactions = (await ok.paginate(ok.rest.reactions.listForPullRequestReviewComment, {
        owner,
        repo,
        comment_id: commentId,
        per_page: 100,
      })) as Array<Record<string, any>>;
      const downvoter = reactions.find((r) => r.content === "-1" && !botLogins.has(r.user?.login ?? ""));
      if (downvoter) {
        dismissed.set(fc.priorId, { ...fc, signal: `👎 from @${downvoter.user?.login ?? "a reviewer"}` });
      }
    } catch {
      // reactions may be unavailable — skip this comment's reaction signal
    }
  }

  return [...dismissed.values()].slice(0, MAX_DISMISSED);
}
