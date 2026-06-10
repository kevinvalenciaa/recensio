import Anthropic from "@anthropic-ai/sdk";
import type { Octokit } from "../github/client.js";
import { clonePrHead } from "../github/clone.js";
import { buildRepoDiffModel } from "../github/diff.js";
import { planPlacement } from "../github/placement.js";
import { mapVerdict, postReview, renderReviewBody, upsertMarkerComment } from "../github/post.js";
import { fetchPrContext, listFiles } from "../github/pr.js";
import { SKIP_MARKER, computeGate, skipCommentBody } from "../github/sizegate.js";
import { findPrTemplate } from "../github/template.js";
import { anthropicTurnRunner, runAgent, type TurnRunner } from "./agent.js";
import { buildInitialUserText, buildSystem } from "./prompt.js";
import { makeTools } from "./tools.js";
import { UsageMeter } from "../shared/cost.js";
import { log } from "../shared/log.js";
import type { Config } from "../shared/config.js";
import type { PlacedReview, ReviewOutcome, TriggerContext } from "../shared/types.js";

export interface ReviewDeps {
  /** Injected by tests; defaults to a real Anthropic streaming runner. */
  turnRunner?: TurnRunner;
  /** Injected by tests; defaults to a real shallow git fetch of pull/N/head. */
  clone?: typeof clonePrHead;
  serverUrl?: string;
}

export async function runReview(
  trigger: TriggerContext,
  cfg: Config,
  ok: Octokit,
  deps: ReviewDeps = {},
): Promise<ReviewOutcome> {
  const { owner, repo, prNumber } = trigger;
  const ctx = await fetchPrContext(ok, owner, repo, prNumber);

  if (ctx.meta.draft && trigger.kind === "auto") {
    log.info(`PR #${prNumber} is a draft — skipping (comment @recensio to review a draft)`);
    return { kind: "skipped-draft" };
  }

  let gate = computeGate(ctx.files, cfg.minLoc);
  if (gate.belowThreshold && !trigger.bypassGate) {
    log.info(`size gate: ${gate.changedLoc} LOC < ${gate.threshold} — skipping review`);
    if (!cfg.dryRun) {
      await upsertMarkerComment(ok, owner, repo, prNumber, SKIP_MARKER, skipCommentBody(gate));
    }
    return { kind: "skipped-gate", gate };
  }

  const cloned = await (deps.clone ?? clonePrHead)(owner, repo, prNumber, cfg.githubToken, deps.serverUrl);
  try {
    // The cloned SHA is authoritative; on a force-push race, re-sync the file
    // list so diff anchors and commit_id match the tree the agent reads.
    if (cloned.headSha !== ctx.meta.headSha) {
      log.warn(`head moved (${ctx.meta.headSha.slice(0, 8)} → ${cloned.headSha.slice(0, 8)}) — refetching file list`);
      const refreshed = await listFiles(ok, owner, repo, prNumber);
      ctx.files = refreshed.files;
      ctx.filesTruncated = refreshed.truncated;
      ctx.meta.headSha = cloned.headSha;
      gate = computeGate(ctx.files, cfg.minLoc);
      if (gate.belowThreshold && !trigger.bypassGate) {
        if (!cfg.dryRun) {
          await upsertMarkerComment(ok, owner, repo, prNumber, SKIP_MARKER, skipCommentBody(gate));
        }
        return { kind: "skipped-gate", gate };
      }
    }

    ctx.prTemplate = findPrTemplate(cloned.dir);
    if (ctx.prTemplate) log.info(`PR template found at ${ctx.prTemplate.path} — compliance will be reviewed`);

    const tools = makeTools(cloned.dir);
    const meter = new UsageMeter(cfg.model);
    const runTurn =
      deps.turnRunner ??
      anthropicTurnRunner(new Anthropic({ apiKey: cfg.anthropicApiKey, maxRetries: 4 }));

    const review = await runAgent({
      runTurn,
      system: buildSystem(),
      tools,
      initialUserText: buildInitialUserText(ctx, gate, trigger, cfg),
      cfg,
      meter,
    });

    const placement = planPlacement({
      findings: review.findings,
      diff: buildRepoDiffModel(ctx.files),
      owner,
      repo,
      headSha: cloned.headSha,
      readLines: tools.readLines,
    });

    const body = renderReviewBody(review, placement.fallbacks, { headSha: cloned.headSha });

    const placed: PlacedReview = {
      event: mapVerdict(review.verdict, cfg.neverApprove),
      verdict: review.verdict,
      body,
      comments: placement.comments,
      fallbacks: placement.fallbacks,
    };

    log.info(
      `review ready: verdict=${review.verdict} event=${placed.event} inline=${placed.comments.length} fallback=${placed.fallbacks.length} · ${meter.footerLine()}`,
    );

    if (cfg.dryRun) {
      return {
        kind: "reviewed",
        verdict: review.verdict,
        event: placed.event,
        degraded: [],
        inlineCount: placed.comments.length,
        fallbackCount: placed.fallbacks.length,
        usageFooter: meter.footerLine(),
        rendered: { body, comments: placed.comments },
      };
    }

    const posted = await postReview(ok, ctx, placed, cloned.headSha);
    return {
      kind: "reviewed",
      verdict: review.verdict,
      event: placed.event,
      reviewUrl: posted.reviewUrl,
      degraded: posted.degraded,
      inlineCount: placed.comments.length,
      fallbackCount: placed.fallbacks.length,
      usageFooter: meter.footerLine(),
    };
  } finally {
    await cloned.cleanup();
  }
}
