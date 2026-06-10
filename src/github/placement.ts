import type { Finding } from "../engine/schema.js";
import type { FallbackFinding, InlineComment } from "../shared/types.js";
import { hunkContaining, normalizePath, type RepoDiffModel } from "./diff.js";

export interface PlacementInput {
  findings: Finding[];
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
  fallbacks: FallbackFinding[];
}

const SNAP_DISTANCE = 3;

/**
 * Decides, deterministically, where each finding can legally attach on
 * GitHub. The model's line numbers are head-revision truth, but GitHub only
 * accepts inline comments on lines visible in the diff — everything else is
 * demoted to the review body rather than risking a 422 that would sink the
 * whole review.
 */
export function planPlacement(input: PlacementInput): PlacementResult {
  const comments: InlineComment[] = [];
  const fallbacks: FallbackFinding[] = [];

  for (const finding of input.findings) {
    const path = normalizePath(finding.path);
    const model = input.diff.get(path);
    if (!model) {
      fallbacks.push(fallback(finding, path, "file-not-in-pr", input));
      continue;
    }
    if (!model.hasPatch) {
      fallbacks.push(fallback(finding, path, "no-text-diff", input));
      continue;
    }

    const start = finding.line;
    const end = finding.end_line ?? finding.line;

    if (end > start) {
      const allVisible = rangeVisible(model.right, start, end);
      if (allVisible && hunkContaining(model, start, end)) {
        comments.push({
          path,
          start_line: start,
          start_side: "RIGHT",
          line: end,
          side: "RIGHT",
          body: renderCommentBody(finding, { suggestion: gateSuggestion(finding, path, start, end, input) }),
        });
        continue;
      }
      // Shrink: anchor on the last line if that one is visible. The
      // suggestion no longer replaces exactly the anchored lines, so drop it.
      if (model.right.has(end)) {
        comments.push({
          path,
          line: end,
          side: "RIGHT",
          body: renderCommentBody(finding, {
            suggestion: undefined,
            note: `_(refers to lines ${start}–${end}; anchored to line ${end})_`,
          }),
        });
        continue;
      }
      fallbacks.push(fallback(finding, path, "range-not-anchorable", input));
      continue;
    }

    // Single line.
    if (model.right.has(start)) {
      comments.push({
        path,
        line: start,
        side: "RIGHT",
        body: renderCommentBody(finding, { suggestion: gateSuggestion(finding, path, start, start, input) }),
      });
      continue;
    }
    // Snap to a nearby visible line only when there is no suggestion — a
    // suggestion applied to the wrong line is worse than a body finding.
    if (finding.suggestion === undefined) {
      const snapped = nearestVisible(model.right, start);
      if (snapped !== undefined) {
        comments.push({
          path,
          line: snapped,
          side: "RIGHT",
          body: renderCommentBody(finding, {
            suggestion: undefined,
            note: `_(reported at line ${start}; anchored to nearest diff line ${snapped})_`,
          }),
        });
        continue;
      }
    }
    fallbacks.push(fallback(finding, path, "line-not-in-diff", input));
  }

  return { comments, fallbacks };
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
  finding: Finding,
  path: string,
  start: number,
  end: number,
  input: PlacementInput,
): string | undefined {
  const suggestion = finding.suggestion;
  if (suggestion === undefined) return undefined;
  const lines = input.readLines?.(path);
  if (lines) {
    const current = lines.slice(start - 1, end).join("\n");
    const proposed = suggestion.replace(/\n$/, "");
    if (current === proposed) return undefined;
  }
  return suggestion;
}

export function renderCommentBody(
  finding: Finding,
  opts: { suggestion: string | undefined; note?: string } = { suggestion: finding.suggestion },
): string {
  const parts = [
    `**[${finding.severity}][${finding.provenance}] ${finding.title}** · \`${finding.id}\` · confidence ${finding.confidence}/100`,
  ];
  if (opts.note) parts.push(opts.note);
  parts.push(finding.body.trim());
  if (opts.suggestion !== undefined) {
    parts.push("```suggestion\n" + opts.suggestion.replace(/\n$/, "") + "\n```");
  }
  parts.push(`<!-- recensio:finding:${finding.id} -->`);
  return parts.join("\n\n");
}

function fallback(
  finding: Finding,
  path: string,
  reason: FallbackFinding["reason"],
  input: PlacementInput,
): FallbackFinding {
  const lineRef = finding.end_line ? `L${finding.line}-L${finding.end_line}` : `L${finding.line}`;
  const permalink = `https://github.com/${input.owner}/${input.repo}/blob/${input.headSha}/${path}#${lineRef}`;
  const heading = `**[${finding.severity}][${finding.provenance}] ${finding.title}** · \`${finding.id}\` · confidence ${finding.confidence}/100`;
  const location = `[\`${path}:${finding.line}${finding.end_line ? `–${finding.end_line}` : ""}\`](${permalink})`;
  const suggestionBlock =
    finding.suggestion !== undefined ? `\n\nProposed fix:\n\n\`\`\`\n${finding.suggestion.replace(/\n$/, "")}\n\`\`\`` : "";
  return {
    findingId: finding.id,
    reason,
    renderedBody: `${heading}\n\n${location}\n\n${finding.body.trim()}${suggestionBlock}\n\n<!-- recensio:finding:${finding.id} -->`,
  };
}
