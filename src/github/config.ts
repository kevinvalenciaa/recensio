import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import type { Octokit } from "./client.js";
import { log } from "../shared/log.js";

export interface PathInstruction {
  path: string;
  guidance: string;
}

export interface ChecksConfig {
  /** Optional dependency-install command, run before the checks. */
  install?: string;
  /** Commands to run; each is whitespace-split into argv (no shell). */
  commands: string[];
}

export interface RecensioConfig {
  instructions: PathInstruction[];
  ignore: string[];
  /** Reserved for M5 (git history depth) — validated, currently inert. */
  history?: Record<string, unknown>;
  /** Check commands run against the PR (M6); same-repo PRs only. */
  checks?: ChecksConfig;
}

export const EMPTY_CONFIG: RecensioConfig = { instructions: [], ignore: [] };

const GUIDANCE_MAX = 600;
const MAX_INSTRUCTIONS = 50;

/**
 * Loads `.recensio.yml` from the **base repository's default branch** — never
 * the PR head. The review runs in a privileged, comment-triggered context, so
 * reading config (and, later, check commands) from PR-controlled files would
 * be a command/prompt-injection vector. Fail-soft: missing file, bad YAML, or
 * any API error yields the empty config.
 */
export async function loadConfig(
  ok: Octokit,
  owner: string,
  repo: string,
  configPath: string,
): Promise<RecensioConfig> {
  try {
    const { data: repoData } = await ok.rest.repos.get({ owner, repo });
    const ref = repoData.default_branch;
    const { data } = await ok.rest.repos.getContent({ owner, repo, path: configPath, ref });
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") return EMPTY_CONFIG;
    const text = Buffer.from(data.content, "base64").toString("utf8");
    return parseConfig(text);
  } catch (err: any) {
    if (err?.status !== 404) log.warn(`could not load ${configPath}: ${String(err?.message ?? err)}`);
    return EMPTY_CONFIG;
  }
}

/** Parses + validates config text, ignoring unknown keys. Exposed for tests. */
export function parseConfig(text: string): RecensioConfig {
  let raw: any;
  try {
    raw = parseYaml(text);
  } catch (err) {
    log.warn(`.recensio.yml is not valid YAML — ignoring it: ${String(err)}`);
    return EMPTY_CONFIG;
  }
  if (!raw || typeof raw !== "object") return EMPTY_CONFIG;

  const instructions: PathInstruction[] = [];
  if (Array.isArray(raw.instructions)) {
    for (const item of raw.instructions) {
      if (item && typeof item.path === "string" && typeof item.guidance === "string") {
        instructions.push({ path: item.path, guidance: item.guidance.slice(0, GUIDANCE_MAX) });
      }
      if (instructions.length >= MAX_INSTRUCTIONS) break;
    }
  }

  const ignore: string[] = Array.isArray(raw.ignore) ? raw.ignore.filter((g: unknown) => typeof g === "string") : [];

  return {
    instructions,
    ignore,
    history: typeof raw.history === "object" && raw.history ? raw.history : undefined,
    checks: parseChecks(raw.checks),
  };
}

function parseChecks(raw: any): ChecksConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const commands = Array.isArray(raw.commands)
    ? raw.commands.filter((c: unknown) => typeof c === "string" && c.trim() !== "").slice(0, 10)
    : [];
  if (commands.length === 0) return undefined;
  const install = typeof raw.install === "string" && raw.install.trim() !== "" ? raw.install : undefined;
  return { install, commands };
}

/** Instructions whose glob matches at least one changed file. */
export function matchedInstructions(config: RecensioConfig, filenames: string[]): PathInstruction[] {
  return config.instructions.filter((ins) => {
    const isMatch = picomatch(ins.path, { dot: true });
    return filenames.some((f) => isMatch(f));
  });
}

/** True when a changed file is covered by a config `ignore` glob. */
export function isConfigIgnored(config: RecensioConfig, filename: string): boolean {
  if (config.ignore.length === 0) return false;
  return picomatch(config.ignore, { dot: true })(filename);
}
