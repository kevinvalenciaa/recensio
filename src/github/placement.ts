import type { Finding, UnconfirmedFinding } from "../engine/schema.js";
import type { FallbackFinding, InlineComment } from "../shared/types.js";
import { hunkContaining, normalizePath, type RepoDiffModel } from "./diff.js";

export interface PlacementInput {
  findings: Finding[];
  unconfirmed: UnconfirmedFinding[];
  diff: RepoDiffModel;
  owner: string;
  repo: string;
  headSha: string;
  /**
   * Returns the file's lines at the head revision, or undefined when
   * unavailable. Used to drop no-op suggestions; placement never fails
   * without it.
   */
  readLines?: (path: string) => string[] | undefined;
}

export interface PlacementResult {
  comments: InlineComment[];
  /** Verified findings that could not be anchored — rendered in the body. */
  fallbacks: FallbackFinding[];
  /** Unconfirmed findings that could not be anchored — rendered in the body. */
  unconfirmedFallbacks: FallbackFinding[];
}

const SNAP_DISTANCE = 3;

export const SEVERITY_BADGE: Record<Finding["severity"], string> = {
  P0: "🔴 P0 CRITICAL",
  P1: "🟠 P1 HIGH",
  P2: "🟡 P2 MEDIUM",
};

/**
 * Decides, deterministically, where each finding can legally attach on
 * GitHub. The model's line numbers are head-revision truth, but GitHub only
 * accepts inline comments on lines visible in the diff — everything else is
 * demoted to the review body rather than risking a 422 that would sink the
 * whole review. Verified and unconfirmed findings both anchor inline;
 * unconfirmed ones are labeled as such and never carry apply-able suggestions.
 */
export function planPlacement(input: PlacementInput): PlacementResult {
  const result: PlacementResult = { comments: [], fallbacks: [], unconfirmedFallbacks: [] };
  for (const finding of input.findings) {
    placeOne(finding, "verified", input, result.comments, result.fallbacks);
  }
  for (const finding of input.unconfirmed) {
    placeOne(finding, "unconfirmed", input, result.comments, result.unconfirmedFallbacks);
  }
  return result;
}

function placeOne(
  finding: Finding & { to_confirm?: string },
  kind: "verified" | "unconfirmed",
  input: PlacementInput,
  comments: InlineComment[],
  fallbacks: FallbackFinding[],
): void {
  const path = normalizePath(finding.path);
  const model = input.diff.get(path);
  if (!model) {
    fallbacks.push(fallback(finding, kind, path, "file-not-in-pr", input));
    return;
  }
  if (!model.hasPatch) {
    fallbacks.push(fallback(finding, kind, path, "no-text-diff", input));
    return;
  }

  const start = finding.line;
  const end = finding.end_line ?? finding.line;
  // Apply-able suggestions are reserved for verified findings; an unconfirmed
  // fix renders as a plain proposed-fix block instead.
  const applyable = kind === "verified" ? finding.suggestion : undefined;

  if (end > start) {
    const allVisible = rangeVisible(model.right, start, end);
    if (allVisible && hunkContaining(model, start, end)) {
      comments.push({
        path,
        start_line: start,
        start_side: "RIGHT",
        line: end,
        side: "RIGHT",
        body: renderCommentBody(finding, kind, { suggestion: gateSuggestion(applyable, path, start, end, input) }),
      });
      return;
    }
    // Shrink: anchor on the last line if that one is visible. The suggestion
    // no longer replaces exactly the anchored lines, so drop it.
    if (model.right.has(end)) {
      comments.push({
        path,
        line: end,
        side: "RIGHT",
        body: renderCommentBody(finding, kind, {
          suggestion: undefined,
          note: `_(refers to lines ${start}–${end}; anchored to line ${end})_`,
        }),
      });
      return;
    }
    fallbacks.push(fallback(finding, kind, path, "range-not-anchorable", input));
    return;
  }

  // Single line.
  if (model.right.has(start)) {
    comments.push({
      path,
      line: start,
      side: "RIGHT",
      body: renderCommentBody(finding, kind, { suggestion: gateSuggestion(applyable, path, start, start, input) }),
    });
    return;
  }
  // Snap to a nearby visible line only when no apply-able suggestion rides
  // along — a suggestion applied to the wrong line is worse than a body finding.
  if (applyable === undefined) {
    const snapped = nearestVisible(model.right, start);
    if (snapped !== undefined) {
      comments.push({
        path,
        line: snapped,
        side: "RIGHT",
        body: renderCommentBody(finding, kind, {
          suggestion: undefined,
          note: `_(reported at line ${start}; anchored to nearest diff line ${snapped})_`,
        }),
      });
      return;
    }
  }
  fallbacks.push(fallback(finding, kind, path, "line-not-in-diff", input));
}

function rangeVisible(right: Map<number, unknown>, start: number, end: number): boolean {
  for (let n = start; n <= end; n++) if (!right.has(n)) return false;
  return true;
}

function nearestVisible(right: Map<number, unknown>, line: number): number | undefined {
  for (let d = 1; d <= SNAP_DISTANCE; d++) {
    if (right.has(line + d)) return line + d;
    if (right.has(line - d)) return line - d;
  }
  return undefined;
}

/**
 * A suggestion may only ship when it would replace exactly the anchored
 * lines. Drops it when it is a byte-for-byte no-op against the head revision.
 */
function gateSuggestion(
  suggestion: string | undefined,
  path: string,
  start: number,
  end: number,
  input: PlacementInput,
): string | undefined {
  if (suggestion === undefined) return undefined;
  const lines = input.readLines?.(path);
  if (lines) {
    const current = lines.slice(start - 1, end).join("\n");
    if (current === suggestion.replace(/\n$/, "")) return undefined;
  }
  return suggestion;
}

function headerLine(finding: Finding, _kind: "verified" | "unconfirmed"): string {
  return `### **${SEVERITY_BADGE[finding.severity]}: ${finding.title} (CONFIDENCE: ${finding.confidence}/100)**`;
}

function fieldLines(finding: Finding): string {
  return [
    `**Issue**: ${finding.issue.trim()}`,
    `**Risk**: ${finding.risk.trim()}`,
    `**Trigger**: ${finding.trigger.trim()}`,
    `**Verification trail**: ${finding.verification_trail.trim()}`,
  ].join("\n\n");
}

function aiFixPromptBlock(finding: Finding): string {
  return `**AI Fix Prompt:**\n\n\`\`\`\n${finding.ai_fix_prompt.trim()}\n\`\`\``;
}

export function renderCommentBody(
  finding: Finding & { to_confirm?: string },
  kind: "verified" | "unconfirmed",
  opts: { suggestion: string | undefined; note?: string },
): string {
  const parts = [headerLine(finding, kind)];
  if (opts.note) parts.push(opts.note);
  parts.push(fieldLines(finding));
  if (opts.suggestion !== undefined) {
    parts.push("```suggestion\n" + opts.suggestion.replace(/\n$/, "") + "\n```");
  } else if (kind === "unconfirmed" && finding.suggestion !== undefined) {
    parts.push(`Proposed fix:\n\n\`\`\`\n${finding.suggestion.replace(/\n$/, "")}\n\`\`\``);
  }
  if (kind === "unconfirmed" && finding.to_confirm) {
    parts.push(`**To confirm:** ${finding.to_confirm}`);
  }
  parts.push(aiFixPromptBlock(finding));
  parts.push(`<!-- recensio:finding:${finding.id} -->`);
  return parts.join("\n\n");
}

function fallback(
  finding: Finding & { to_confirm?: string },
  kind: "verified" | "unconfirmed",
  path: string,
  reason: FallbackFinding["reason"],
  input: PlacementInput,
): FallbackFinding {
  const lineRef = finding.end_line ? `L${finding.line}-L${finding.end_line}` : `L${finding.line}`;
  const permalink = `https://github.com/${input.owner}/${input.repo}/blob/${input.headSha}/${path}#${lineRef}`;
  const location = `[\`${path}:${finding.line}${finding.end_line ? `–${finding.end_line}` : ""}\`](${permalink})`;
  const suggestionBlock =
    finding.suggestion !== undefined ? `\n\nProposed fix:\n\n\`\`\`\n${finding.suggestion.replace(/\n$/, "")}\n\`\`\`` : "";
  const toConfirm = kind === "unconfirmed" && finding.to_confirm ? `\n\n**To confirm:** ${finding.to_confirm}` : "";
  return {
    findingId: finding.id,
    reason,
    renderedBody: `${headerLine(finding, kind)}\n\n${location}\n\n${fieldLines(finding)}${suggestionBlock}${toConfirm}\n\n${aiFixPromptBlock(finding)}\n\n<!-- recensio:finding:${finding.id} -->`,
  };
}
