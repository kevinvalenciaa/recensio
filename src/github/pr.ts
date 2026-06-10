import type { Octokit } from "./client.js";
import type {
  PrContext,
  PrFile,
  PrMeta,
  PreviousReviewDigest,
  PreviousReviewFinding,
} from "../shared/types.js";
import { log } from "../shared/log.js";

export const REVIEW_MARKER = "<!-- recensio:review -->";
const COMMIT_MARKER_RE = /<!-- recensio:commit:([0-9a-f]{7,40}) -->/;
const VERDICT_LINE_RE = /Verdict[:*\s]+\**([A-Z_ ]+?)\**\s*(?:\n|·|$)/;
const FINDING_MARKER_RE = /<!-- recensio:finding:(F\d+) -->/;

/** GitHub stops listing files at 3000 per PR. */
const FILE_LIST_HARD_CAP = 3000;

export async function fetchPrMeta(ok: Octokit, owner: string, repo: string, number: number): Promise<PrMeta> {
  const { data } = await ok.rest.pulls.get({ owner, repo, pull_number: number });
  return {
    owner,
    repo,
    number,
    title: data.title,
    body: data.body ?? "",
    author: data.user?.login ?? "unknown",
    baseRef: data.base.ref,
    baseSha: data.base.sha,
    headRef: data.head.ref,
    headSha: data.head.sha,
    headRepoFullName: data.head.repo?.full_name ?? `${owner}/${repo}`,
    draft: data.draft ?? false,
    url: data.html_url,
  };
}

export async function listFiles(
  ok: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<{ files: PrFile[]; truncated: boolean }> {
  const raw = await ok.paginate(ok.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  const files: PrFile[] = raw.map((f) => ({
    filename: f.filename,
    previousFilename: f.previous_filename,
    status: f.status as PrFile["status"],
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch,
  }));
  return { files, truncated: files.length >= FILE_LIST_HARD_CAP };
}

export async function fetchPrContext(
  ok: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PrContext> {
  const meta = await fetchPrMeta(ok, owner, repo, number);
  const { files, truncated } = await listFiles(ok, owner, repo, number);
  const previousReview = await fetchPreviousReviewDigest(ok, owner, repo, number);
  return { meta, files, filesTruncated: truncated, previousReview };
}

/**
 * Finds the most recent Recensio review (identified by its hidden marker) and
 * condenses it so re-review runs can verify prior findings without re-deriving
 * them. Returns undefined when Recensio has not reviewed this PR before.
 */
export async function fetchPreviousReviewDigest(
  ok: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PreviousReviewDigest | undefined> {
  const reviews = await ok.paginate(ok.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  const mine = reviews.filter((r) => r.body?.includes(REVIEW_MARKER));
  const latest = mine[mine.length - 1];
  if (!latest?.body) return undefined;

  const findings: PreviousReviewFinding[] = [];
  try {
    const comments = await ok.paginate(ok.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
    for (const c of comments) {
      const m = c.body?.match(FINDING_MARKER_RE);
      if (!m) continue;
      const titleLine = c.body.split("\n")[0] ?? "";
      const sevMatch = titleLine.match(/\[(P\d)\]/);
      findings.push({
        id: m[1]!,
        severity: sevMatch?.[1] ?? "?",
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        title: titleLine.replace(/\*\*/g, "").slice(0, 160),
      });
    }
  } catch (err) {
    log.warn(`could not list prior review comments: ${String(err)}`);
  }

  // Findings that were demoted to the review body still carry their markers there.
  for (const m of latest.body.matchAll(new RegExp(FINDING_MARKER_RE.source, "g"))) {
    const id = m[1]!;
    if (!findings.some((f) => f.id === id)) {
      findings.push({ id, severity: "?", path: "(review body)", line: null, title: "(see previous review body)" });
    }
  }

  const summaryExcerpt = latest.body
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .slice(0, 2000);

  return {
    reviewedSha: latest.body.match(COMMIT_MARKER_RE)?.[1] ?? latest.commit_id ?? null,
    verdict: latest.body.match(VERDICT_LINE_RE)?.[1]?.trim() ?? null,
    submittedAt: latest.submitted_at ?? "",
    findings: findings.slice(0, 40),
    summaryExcerpt,
  };
}
