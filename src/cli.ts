import { makeOctokit } from "./github/client.js";
import { runReview } from "./engine/review.js";
import { buildConfig } from "./shared/config.js";
import { log } from "./shared/log.js";
import type { TriggerContext } from "./shared/types.js";

const USAGE = `recensio — Staff-engineer-depth PR review agent

Usage:
  recensio review <pr-url> [options]

By default the review is printed to stdout (dry run) and nothing is posted.

Options:
  --post                 Post the review to GitHub instead of printing it
  --model <id>           Claude model (default claude-opus-4-8, env RECENSIO_MODEL)
  --effort <level>       low|medium|high|xhigh|max (default xhigh, env RECENSIO_EFFORT)
  --min-loc <n>          Size-gate threshold (default 500, env RECENSIO_MIN_LOC)
  --max-turns <n>        Agent turn cap (default 40, env RECENSIO_MAX_TURNS)
  --never-approve        Map approval verdicts to COMMENT
  --force                Bypass the size gate (like an explicit @recensio request)
  -h, --help             Show this help

Environment:
  ANTHROPIC_API_KEY      required
  GITHUB_TOKEN           required (repo read; PR write for --post)
`;

const PR_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

interface CliArgs {
  prUrl: string;
  post: boolean;
  force: boolean;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): CliArgs | { help: true } | { error: string } {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help") || args.length === 0) return { help: true };
  const command = args.shift();
  if (command !== "review") return { error: `unknown command "${command}" — expected "review"` };

  let prUrl = "";
  let post = false;
  let force = false;
  const flags: Record<string, string | boolean> = {};
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--post") post = true;
    else if (a === "--force") force = true;
    else if (a === "--never-approve") flags.neverApprove = "true";
    else if (a === "--model" || a === "--effort" || a === "--min-loc" || a === "--max-turns") {
      const v = args.shift();
      if (v === undefined) return { error: `${a} requires a value` };
      flags[a.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
    } else if (!a.startsWith("-") && prUrl === "") prUrl = a;
    else return { error: `unexpected argument "${a}"` };
  }
  if (prUrl === "") return { error: "missing <pr-url>" };
  if (!PR_URL_RE.test(prUrl)) return { error: `not a GitHub PR URL: ${prUrl}` };
  return { prUrl, post, force, flags };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`error: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const m = parsed.prUrl.match(PR_URL_RE)!;
  const [, owner, repo, num] = m;

  const cfg = buildConfig({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    githubToken: process.env.GITHUB_TOKEN,
    model: (parsed.flags.model as string) ?? process.env.RECENSIO_MODEL,
    effort: (parsed.flags.effort as string) ?? process.env.RECENSIO_EFFORT,
    minLoc: (parsed.flags.minLoc as string) ?? process.env.RECENSIO_MIN_LOC,
    maxTurns: (parsed.flags.maxTurns as string) ?? process.env.RECENSIO_MAX_TURNS,
    neverApprove: parsed.flags.neverApprove as string | undefined,
    dryRun: !parsed.post,
  });

  const trigger: TriggerContext = {
    kind: parsed.force ? "command" : "auto",
    owner: owner!,
    repo: repo!,
    prNumber: Number(num),
    bypassGate: parsed.force,
    ...(parsed.force ? { commenter: "cli", commentBody: "manual run with --force" } : {}),
  };

  const ok = makeOctokit(cfg.githubToken);
  const outcome = await runReview(trigger, cfg, ok);

  if (outcome.kind === "skipped-draft") {
    process.stdout.write("PR is a draft — skipped. Use --force to review anyway.\n");
    return 0;
  }
  if (outcome.kind === "skipped-gate") {
    const g = outcome.gate;
    process.stdout.write(
      [
        "⏭️ SKIPPED — PR below review threshold",
        `Changed LOC: ${g.changedLoc} (threshold: ${g.threshold}) · Files changed: ${g.filesChanged}`,
        "This PR is too small for automated deep review. Route to standard human review.",
        "",
        `(excluded from gate: ${g.excluded.length > 0 ? g.excluded.join(", ") : "none"})`,
        cfg.dryRun ? "(dry run — no skip comment posted; use --force to review anyway)" : "(skip comment posted/updated)",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (outcome.rendered) {
    const lines: string[] = [];
    lines.push("═".repeat(72));
    lines.push(`DRY RUN — nothing posted. Verdict: ${outcome.verdict} (would post as ${outcome.event})`);
    lines.push(`Usage: ${outcome.usageFooter}`);
    lines.push("═".repeat(72));
    lines.push("");
    if (outcome.rendered.comments.length > 0) {
      lines.push(`INLINE COMMENTS (${outcome.rendered.comments.length}):`);
      for (const c of outcome.rendered.comments) {
        const range = c.start_line !== undefined ? `${c.start_line}-${c.line}` : `${c.line}`;
        const firstLine = c.body.split("\n")[0] ?? "";
        lines.push(`  ${c.path}:${range}  ${firstLine.slice(0, 100)}${c.body.includes("```suggestion") ? "  [suggestion]" : ""}`);
      }
      lines.push("");
    }
    lines.push("REVIEW BODY:");
    lines.push("");
    lines.push(outcome.rendered.body);
    lines.push("");
    process.stdout.write(lines.join("\n"));
  } else {
    process.stdout.write(
      `Posted review: ${outcome.verdict} (as ${outcome.event}) · inline=${outcome.inlineCount} body-only=${outcome.fallbackCount}\n` +
        (outcome.reviewUrl ? `${outcome.reviewUrl}\n` : "") +
        (outcome.degraded.length > 0 ? `degradations:\n${outcome.degraded.map((d) => `  - ${d}`).join("\n")}\n` : ""),
    );
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.warn(String(err instanceof Error ? (err.stack ?? err.message) : err));
    process.stderr.write(`recensio failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
