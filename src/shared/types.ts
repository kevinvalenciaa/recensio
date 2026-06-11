/** A file entry from GET /repos/{o}/{r}/pulls/{n}/files. */
export interface PrFile {
  filename: string;
  previousFilename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  /** Unified diff hunks. Absent for binary files and very large per-file diffs. */
  patch?: string;
}

export interface PrMeta {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  /** e.g. "owner/repo" — differs from base for fork PRs. */
  headRepoFullName: string;
  draft: boolean;
  url: string;
}

export interface PreviousReviewFinding {
  id: string;
  severity: string;
  path: string;
  line: number | null;
  title: string;
}

export interface PreviousReviewDigest {
  reviewedSha: string | null;
  verdict: string | null;
  submittedAt: string;
  findings: PreviousReviewFinding[];
  summaryExcerpt: string;
}

export interface PrContext {
  meta: PrMeta;
  files: PrFile[];
  /** True when GET /pulls/{n}/files hit GitHub's 3000-file response cap. */
  filesTruncated: boolean;
  previousReview?: PreviousReviewDigest;
  /** The repository's PR template (head revision), when one exists. */
  prTemplate?: { path: string; content: string };
  /** Dependency manifest diff with advisories, when the graph is available. */
  dependencyChanges?: import("../github/deps.js").DependencyChanges;
  /** Parsed `.recensio.yml` from the base default branch (M4). */
  repoConfig?: import("../github/config.js").RecensioConfig;
  /** Prior findings the team pushed back on, to avoid re-raising (M4). */
  dismissedFindings?: import("../github/feedback.js").DismissedFinding[];
  /** True when git history tools (log/blame/diff) are available (M5). */
  historyAvailable?: boolean;
  /** On re-review, the prior reviewed SHA when it's an ancestor of head (M5). */
  incrementalSinceSha?: string;
  /** Results of configured checks run against the PR (M6), same-repo only. */
  checkResults?: import("../checks/run.js").CheckResult[];
}

export interface GateResult {
  changedLoc: number;
  filesChanged: number;
  excluded: string[];
  threshold: number;
  belowThreshold: boolean;
}

export interface TriggerContext {
  kind: "auto" | "command";
  owner: string;
  repo: string;
  prNumber: number;
  /** Set on command triggers: the comment that summoned the review. */
  commentId?: number;
  commenter?: string;
  commentBody?: string;
  bypassGate: boolean;
}

export type RoutedEvent =
  | { kind: "review"; trigger: TriggerContext }
  | {
      kind: "skip";
      reason:
        | "draft"
        | "auto-review-disabled"
        | "unsupported-event"
        | "unsupported-action"
        | "no-command"
        | "bot-comment"
        | "not-a-pr";
      detail?: string;
    };

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface FallbackFinding {
  findingId: string;
  reason: "file-not-in-pr" | "no-text-diff" | "line-not-in-diff" | "range-not-anchorable";
  renderedBody: string;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PlacedReview {
  event: ReviewEvent;
  /** The verdict as the agent stated it, before any permission downgrade. */
  verdict: string;
  body: string;
  comments: InlineComment[];
  fallbacks: FallbackFinding[];
}

export type ReviewOutcome =
  | { kind: "skipped-gate"; gate: GateResult }
  | { kind: "skipped-draft" }
  | {
      kind: "reviewed";
      verdict: string;
      event: ReviewEvent;
      reviewUrl?: string;
      degraded: string[];
      inlineCount: number;
      fallbackCount: number;
      usageFooter: string;
      /** Stale-thread resolution counts on re-review (M3). */
      resolution?: { attempted: number; replied: number; resolved: number; forbidden: number };
      /** Populated for dry runs so the CLI can render what would be posted. */
      rendered?: { body: string; comments: InlineComment[] };
    };
