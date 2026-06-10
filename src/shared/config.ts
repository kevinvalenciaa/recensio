export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface Config {
  anthropicApiKey: string;
  githubToken: string;
  model: string;
  effort: Effort;
  minLoc: number;
  /** Review automatically on PR open/ready/reopen. Off: @recensio comments only. */
  autoReview: boolean;
  reviewOnSynchronize: boolean;
  neverApprove: boolean;
  maxTurns: number;
  maxTokensPerTurn: number;
  /** Total characters of inline patches embedded in the first message. */
  patchCharBudget: number;
  /** Per-file cap on inline patch characters. */
  patchCharPerFile: number;
  dryRun: boolean;
}

export const DEFAULTS = {
  model: "claude-opus-4-8",
  effort: "xhigh" as Effort,
  minLoc: 500,
  maxTurns: 40,
  maxTokensPerTurn: 32_000,
  patchCharBudget: 240_000,
  patchCharPerFile: 30_000,
};

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer, got "${raw}"`);
  return n;
}

function parseEffort(raw: string | undefined, fallback: Effort): Effort {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (!(EFFORT_LEVELS as readonly string[]).includes(v)) {
    throw new Error(`effort must be one of ${EFFORT_LEVELS.join("|")}, got "${raw}"`);
  }
  return v as Effort;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["true", "1", "yes"].includes(raw.trim().toLowerCase());
}

export interface RawConfigInputs {
  anthropicApiKey?: string;
  githubToken?: string;
  model?: string;
  effort?: string;
  minLoc?: string;
  autoReview?: string;
  reviewOnSynchronize?: string;
  neverApprove?: string;
  maxTurns?: string;
  dryRun?: boolean;
}

export function buildConfig(raw: RawConfigInputs): Config {
  const anthropicApiKey = raw.anthropicApiKey?.trim() ?? "";
  const githubToken = raw.githubToken?.trim() ?? "";
  if (!anthropicApiKey) throw new Error("anthropic-api-key is required (or set ANTHROPIC_API_KEY)");
  if (!githubToken) throw new Error("github-token is required (or set GITHUB_TOKEN)");
  return {
    anthropicApiKey,
    githubToken,
    model: raw.model?.trim() || DEFAULTS.model,
    effort: parseEffort(raw.effort, DEFAULTS.effort),
    minLoc: parsePositiveInt(raw.minLoc, DEFAULTS.minLoc, "min-loc"),
    autoReview: parseBool(raw.autoReview, false),
    reviewOnSynchronize: parseBool(raw.reviewOnSynchronize, false),
    neverApprove: parseBool(raw.neverApprove, false),
    maxTurns: parsePositiveInt(raw.maxTurns, DEFAULTS.maxTurns, "max-turns"),
    maxTokensPerTurn: DEFAULTS.maxTokensPerTurn,
    patchCharBudget: DEFAULTS.patchCharBudget,
    patchCharPerFile: DEFAULTS.patchCharPerFile,
    dryRun: raw.dryRun ?? false,
  };
}
