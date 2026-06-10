import systemPromptText from "../../prompts/system.md";
import type { Config } from "../shared/config.js";
import type { GateResult, PrContext, TriggerContext } from "../shared/types.js";
import { isExcludedFromGate } from "../github/sizegate.js";

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * The system prompt is a single frozen block with a cache breakpoint — it,
 * plus the tool definitions that render before it, form the stable prefix
 * shared by every turn (and every run against the same deployment).
 */
export function buildSystem(): SystemBlock[] {
  return [{ type: "text", text: systemPromptText, cache_control: { type: "ephemeral" } }];
}

const PR_BODY_MAX = 4_000;
const COMMENT_MAX = 1_000;
const PREV_SUMMARY_MAX = 2_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated]`;
}

export function buildInitialUserText(
  ctx: PrContext,
  gate: GateResult,
  trigger: TriggerContext,
  cfg: Config,
): string {
  const { meta } = ctx;
  const sections: string[] = [];

  const triggerLine =
    trigger.kind === "command"
      ? `re-review explicitly requested by @${trigger.commenter ?? "a maintainer"} via PR comment` +
        (gate.belowThreshold ? " (size gate bypassed by this explicit request)" : "") +
        (trigger.commentBody ? `\nRequest comment: ${truncate(trigger.commentBody.replace(/\s+/g, " ").trim(), COMMENT_MAX)}` : "")
      : "automatic review on pull request update";

  sections.push(
    `<pr_meta>
Repository: ${meta.owner}/${meta.repo}
PR #${meta.number}: ${meta.title}
Author: ${meta.author}
Base: ${meta.baseRef} ← Head: ${meta.headRef} (${meta.headSha})${meta.headRepoFullName !== `${meta.owner}/${meta.repo}` ? `\nHead repository (fork): ${meta.headRepoFullName}` : ""}
Trigger: ${triggerLine}

Description:
${truncate(meta.body.trim() || "(empty)", PR_BODY_MAX)}
</pr_meta>`,
  );

  const statLines = ctx.files.map((f) => {
    const excluded = isExcludedFromGate(f.filename) ? "  [excluded from gate]" : "";
    const renamed = f.previousFilename ? `  (renamed from ${f.previousFilename})` : "";
    return `${f.status.padEnd(8)} ${f.filename}  +${f.additions}/-${f.deletions}${renamed}${excluded}`;
  });
  sections.push(
    `<file_stats>
${statLines.join("\n")}${ctx.filesTruncated ? "\n[file list truncated at GitHub's 3000-file cap]" : ""}

Size gate (computed by the harness): changed LOC ${gate.changedLoc} vs threshold ${gate.threshold} across ${gate.filesChanged} files (${gate.excluded.length} excluded). ${gate.belowThreshold ? "Below threshold — reviewed anyway because a maintainer explicitly requested it." : "Gate passed."}
</file_stats>`,
  );

  if (ctx.prTemplate) {
    sections.push(
      `<pr_template>
This repository defines a pull request template at ${ctx.prTemplate.path}. Verify this PR complies with it: required sections genuinely filled in (not placeholders), checklists addressed, and any code-quality standards the template states honored by the diff itself.

${ctx.prTemplate.content}
</pr_template>`,
    );
  }

  sections.push(buildPatchesSection(ctx, cfg));

  if (ctx.previousReview) {
    const prev = ctx.previousReview;
    const findingLines = prev.findings.map(
      (f) => `- ${f.id} [${f.severity}] ${f.path}${f.line ? `:${f.line}` : ""} — ${f.title}`,
    );
    sections.push(
      `<previous_review>
You previously reviewed this PR${prev.reviewedSha ? ` at commit ${prev.reviewedSha}` : ""}${prev.verdict ? ` with verdict ${prev.verdict}` : ""}.
Prior findings:
${findingLines.join("\n") || "(none recorded)"}

Prior summary excerpt:
${truncate(prev.summaryExcerpt, PREV_SUMMARY_MAX)}
</previous_review>`,
    );
  }

  sections.push(
    "Investigate with the tools (the patches above may be truncated — full files are available via read_file), then call submit_review exactly once.",
  );

  return sections.join("\n\n");
}

function buildPatchesSection(ctx: PrContext, cfg: Config): string {
  // Reviewable source first, then gate-excluded noise; large files last.
  const ordered = [...ctx.files].sort((a, b) => {
    const exA = isExcludedFromGate(a.filename) ? 1 : 0;
    const exB = isExcludedFromGate(b.filename) ? 1 : 0;
    if (exA !== exB) return exA - exB;
    return b.changes - a.changes;
  });

  let budget = cfg.patchCharBudget;
  const chunks: string[] = [];
  const omitted: string[] = [];

  for (const f of ordered) {
    const header = `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`;
    if (!f.patch) {
      chunks.push(`${header}\n(no text diff — binary or oversized; use read_file if text)`);
      continue;
    }
    if (isExcludedFromGate(f.filename)) {
      chunks.push(`${header}\n(patch omitted — excluded from gate as lockfile/vendored/generated)`);
      continue;
    }
    let body = f.patch;
    let note = "";
    if (body.length > cfg.patchCharPerFile) {
      body = body.slice(0, cfg.patchCharPerFile);
      note = "\n[patch truncated — use read_file for the full file]";
    }
    const cost = header.length + body.length + 16;
    if (cost > budget) {
      omitted.push(f.filename);
      continue;
    }
    budget -= cost;
    chunks.push(`${header}\n\`\`\`diff\n${body}\n\`\`\`${note}`);
  }

  if (omitted.length > 0) {
    chunks.push(`Patches omitted for budget (use read_file): ${omitted.join(", ")}`);
  }
  return `<patches>\n${chunks.join("\n\n")}\n</patches>`;
}
