import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import { makeOctokit } from "./github/client.js";
import { upsertMarkerComment } from "./github/post.js";
import { checkCommenterPermission, parseEvent, reactEyes } from "./github/trigger.js";
import { runReview } from "./engine/review.js";
import { buildConfig } from "./shared/config.js";
import { log, useActionsSink } from "./shared/log.js";
import type { TriggerContext } from "./shared/types.js";

const ERROR_MARKER = "<!-- recensio:error -->";

async function main(): Promise<void> {
  useActionsSink(core);

  const cfg = buildConfig({
    anthropicApiKey: core.getInput("anthropic-api-key") || process.env.ANTHROPIC_API_KEY,
    githubToken: core.getInput("github-token") || process.env.GITHUB_TOKEN,
    model: core.getInput("model"),
    effort: core.getInput("effort"),
    minLoc: core.getInput("min-loc"),
    autoReview: core.getInput("auto-review"),
    reviewOnSynchronize: core.getInput("review-on-synchronize"),
    neverApprove: core.getInput("never-approve"),
    maxTurns: core.getInput("max-turns"),
  });
  core.setSecret(cfg.anthropicApiKey);

  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set — is this running inside GitHub Actions?");
  const payload = JSON.parse(readFileSync(eventPath, "utf8"));

  const routed = parseEvent(eventName, payload, cfg);
  if (routed.kind === "skip") {
    log.info(`nothing to do: ${routed.reason}${routed.detail ? ` (${routed.detail})` : ""}`);
    core.setOutput("skipped", "true");
    return;
  }

  const trigger = routed.trigger;
  const ok = makeOctokit(cfg.githubToken);

  if (trigger.kind === "command") {
    const allowed = await checkCommenterPermission(ok, trigger.owner, trigger.repo, trigger.commenter ?? "");
    if (!allowed) {
      log.info(`@${trigger.commenter} does not have write access — ignoring the request`);
      core.setOutput("skipped", "true");
      return;
    }
    await reactEyes(ok, trigger.owner, trigger.repo, trigger.commentId!);
  }

  try {
    const outcome = await runReview(trigger, cfg, ok, { serverUrl: process.env.GITHUB_SERVER_URL || undefined });

    if (outcome.kind === "reviewed") {
      core.setOutput("skipped", "false");
      core.setOutput("verdict", outcome.verdict);
      if (outcome.reviewUrl) core.setOutput("review-url", outcome.reviewUrl);
      const lines = [
        `## Recensio review posted`,
        ``,
        `- Verdict: **${outcome.verdict.replace(/_/g, " ")}** (as ${outcome.event})`,
        `- Inline comments: ${outcome.inlineCount} · body-only findings: ${outcome.fallbackCount}`,
        `- Usage: ${outcome.usageFooter}`,
        ...(outcome.reviewUrl ? [`- ${outcome.reviewUrl}`] : []),
        ...(outcome.degraded.length > 0 ? [``, `Degradations:`, ...outcome.degraded.map((d) => `- ${d}`)] : []),
      ];
      await core.summary.addRaw(lines.join("\n")).write().catch(() => {});
    } else {
      core.setOutput("skipped", "true");
      if (outcome.kind === "skipped-gate") {
        log.info(`posted/updated size-gate skip notice (${outcome.gate.changedLoc} LOC < ${outcome.gate.threshold})`);
      }
    }
  } catch (err) {
    await reportFailure(trigger, cfg.githubToken, err);
    throw err;
  }
}

async function reportFailure(trigger: TriggerContext, token: string, err: unknown): Promise<void> {
  const reason = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 300) : String(err).slice(0, 300);
  const body = [
    `⚠️ **Recensio failed:** ${reason}`,
    "",
    "Check the workflow run logs for details, then comment `@recensio` to retry.",
    ERROR_MARKER,
  ].join("\n");
  try {
    const ok = makeOctokit(token);
    await upsertMarkerComment(ok, trigger.owner, trigger.repo, trigger.prNumber, ERROR_MARKER, body);
  } catch (postErr) {
    log.warn(`could not post the failure notice: ${String(postErr)}`);
  }
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
