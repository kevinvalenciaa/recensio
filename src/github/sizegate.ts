import type { GateResult, PrFile } from "../shared/types.js";

/**
 * Files excluded from the changed-LOC computation: lockfiles, vendored code,
 * and generated artifacts. The spec's "pure-formatting noise" cannot be
 * detected reliably from diff stats and is intentionally not attempted.
 */
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "deno.lock",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "pdm.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "gradle.lockfile",
  "podfile.lock",
  "packages.lock.json",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
]);

const EXCLUDE_PATTERNS: RegExp[] = [
  /(^|\/)vendor\//,
  /(^|\/)third_party\//,
  /(^|\/)node_modules\//,
  /\.min\.(js|css)$/,
  /\.(js|css)\.map$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)__generated__\//,
  /\.generated\.[^/]+$/,
  /_generated\.[^/]+$/,
  /\.pb\.(go|py|rb|cc|h|swift)$/,
  /_pb2(_grpc)?\.py$/,
  /\.pb\.ts$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
];

export function isExcludedFromGate(filename: string): boolean {
  const base = filename.split("/").pop()?.toLowerCase() ?? "";
  if (LOCKFILE_BASENAMES.has(base)) return true;
  return EXCLUDE_PATTERNS.some((re) => re.test(filename));
}

export function computeGate(
  files: PrFile[],
  threshold: number,
  extraExclude?: (filename: string) => boolean,
): GateResult {
  let changedLoc = 0;
  const excluded: string[] = [];
  for (const f of files) {
    if (isExcludedFromGate(f.filename) || extraExclude?.(f.filename)) {
      excluded.push(f.filename);
    } else {
      changedLoc += f.additions + f.deletions;
    }
  }
  return {
    changedLoc,
    filesChanged: files.length,
    excluded,
    threshold,
    belowThreshold: changedLoc < threshold,
  };
}

export const SKIP_MARKER = "<!-- recensio:skip -->";

/** Exact format mandated by the review spec's Phase 0, plus our hidden marker. */
export function skipCommentBody(gate: GateResult): string {
  return [
    "⏭️ SKIPPED — PR below review threshold",
    `Changed LOC: ${gate.changedLoc} (threshold: ${gate.threshold}) · Files changed: ${gate.filesChanged}`,
    "This PR is too small for automated deep review. Route to standard human review.",
    "",
    `_Comment \`@recensio\` to request a full review anyway._`,
    SKIP_MARKER,
  ].join("\n");
}
