import type { Octokit } from "./client.js";
import type { Config } from "../shared/config.js";
import type { RoutedEvent } from "../shared/types.js";
import { log } from "../shared/log.js";

/**
 * Matches "@recensio" / "/recensio" as a standalone token. The leading
 * (^|\s) guard keeps email-like strings (a@recensio.dev) from triggering.
 */
export const COMMAND_RE = /(^|\s)[@/]recensio\b/i;

const AUTO_ACTIONS = new Set(["opened", "ready_for_review", "reopened"]);

export function parseEvent(eventName: string, payload: any, cfg: Config): RoutedEvent {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const action: string = payload?.action ?? "";
    const pr = payload?.pull_request;
    if (!pr) return { kind: "skip", reason: "not-a-pr", detail: "payload has no pull_request" };
    const allowed = AUTO_ACTIONS.has(action) || (action === "synchronize" && cfg.reviewOnSynchronize);
    if (!allowed) return { kind: "skip", reason: "unsupported-action", detail: action };
    if (pr.draft) return { kind: "skip", reason: "draft" };
    return {
      kind: "review",
      trigger: {
        kind: "auto",
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        prNumber: pr.number,
        bypassGate: false,
      },
    };
  }

  if (eventName === "issue_comment") {
    if (payload?.action !== "created") return { kind: "skip", reason: "unsupported-action", detail: payload?.action };
    const issue = payload?.issue;
    const comment = payload?.comment;
    if (!issue?.pull_request) return { kind: "skip", reason: "not-a-pr", detail: "comment is on an issue, not a PR" };
    const login: string = comment?.user?.login ?? "";
    if (comment?.user?.type === "Bot" || login.endsWith("[bot]")) {
      return { kind: "skip", reason: "bot-comment", detail: login };
    }
    const body: string = comment?.body ?? "";
    if (!COMMAND_RE.test(body)) return { kind: "skip", reason: "no-command" };
    return {
      kind: "review",
      trigger: {
        kind: "command",
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        prNumber: issue.number,
        commentId: comment.id,
        commenter: login,
        commentBody: body,
        bypassGate: true,
      },
    };
  }

  return { kind: "skip", reason: "unsupported-event", detail: eventName };
}

/** Only collaborators with write access (or better) may summon a review. */
export async function checkCommenterPermission(
  ok: Octokit,
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  try {
    const { data } = await ok.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return ["admin", "maintain", "write"].includes(data.permission);
  } catch (err: any) {
    if (err?.status === 404) return false; // not a collaborator
    throw err;
  }
}

/** Acknowledges the summoning comment with 👀. Non-fatal on failure. */
export async function reactEyes(ok: Octokit, owner: string, repo: string, commentId: number): Promise<void> {
  try {
    await ok.rest.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content: "eyes" });
  } catch (err) {
    log.warn(`could not add reaction to comment ${commentId}: ${String(err)}`);
  }
}
