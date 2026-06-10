import { readFileSync } from "node:fs";
import path from "node:path";

const TEMPLATE_MAX_CHARS = 8_000;

/**
 * Locations GitHub recognizes for a single PR template, most common first.
 * (Multi-template directories under .github/PULL_REQUEST_TEMPLATE/ are rare
 * and intentionally not resolved — there is no way to know which one a PR
 * author was offered.)
 */
const CANDIDATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];

export interface PrTemplate {
  path: string;
  content: string;
}

/** Reads the repository's PR template from the cloned head revision, if any. */
export function findPrTemplate(repoDir: string): PrTemplate | undefined {
  for (const rel of CANDIDATE_PATHS) {
    try {
      const raw = readFileSync(path.join(repoDir, rel), "utf8");
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const content =
        trimmed.length > TEMPLATE_MAX_CHARS ? `${trimmed.slice(0, TEMPLATE_MAX_CHARS)}\n[truncated]` : trimmed;
      return { path: rel, content };
    } catch {
      // not present at this path — try the next candidate
    }
  }
  return undefined;
}
