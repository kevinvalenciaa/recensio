# Recensio

Staff-engineer-depth pull-request review, as a GitHub Action. Recensio reads the whole PR — not just the hunks — traces blast radius through the repository, verifies every candidate issue from scratch, and posts a single review with:

- **Inline comments anchored to the exact lines** each finding is about, with copy-paste-ready ```suggestion blocks where a mechanical fix exists
- A verdict (`APPROVE` / `APPROVE WITH COMMENTS` / `REQUEST CHANGES` / `BLOCK`), a mergability-confidence grade, and merge-readiness scores
- Verified findings with per-finding confidence (0–100), an Unconfirmed section, and a discarded-candidates audit trail
- **`@recensio` / `/recensio` re-reviews**: comment on the PR and it re-reviews, checking whether prior findings were fixed

It is powered by the Claude API (default model `claude-opus-4-8`) running an agentic loop with read/grep tools over a clone of the PR head.

---

## Setup (two steps)

**0. Host this repo on GitHub.** Push this repository to your account/org (e.g. `you/recensio`). It is the action: `action.yml` + the committed `dist/` bundles. Tag a release so workflows can pin it:

```bash
git tag v1 && git push origin v1
```

**1. Add the workflow to a repository you want reviewed.** Copy [`examples/recensio.yml`](examples/recensio.yml) to `.github/workflows/recensio.yml`, and point the `uses:` line at your copy (`you/recensio@v1`).

**2. Add the API key secret.** In that repository: Settings → Secrets and variables → Actions → New repository secret → `ANTHROPIC_API_KEY`.

That's it. No server, no checkout step (the action shallow-clones the PR head itself), no other configuration required.

### What happens after wiring

| Event | Behavior |
|---|---|
| PR opened / reopened / marked ready | Size gate runs. ≥ 500 changed LOC → full review. Below → a `⏭️ SKIPPED` notice (updated in place, never duplicated). |
| Collaborator comments `@recensio` or `/recensio` | 👀 reaction, then a full review **regardless of size** (explicit human request bypasses the gate). Re-reviews check prior findings and report what was fixed. |
| Every push (`synchronize`) | Off by default (cost control). Enable with `review-on-synchronize: "true"`. |
| Draft PR | Skipped silently; summon with `@recensio` if you want a draft reviewed. |
| Failure (bad key, API outage…) | A `⚠️ Recensio failed` comment with the reason and a retry hint; the check run fails. |

Only users with **write/maintain/admin** access can summon `@recensio`; bot comments are ignored (no loops).

## Inputs

| Input | Default | Notes |
|---|---|---|
| `anthropic-api-key` | — (required) | |
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write`, `issues: write`, `contents: read` |
| `model` | `claude-opus-4-8` | Any current Claude model id |
| `effort` | `xhigh` | `low` \| `medium` \| `high` \| `xhigh` \| `max` — depth vs. cost |
| `min-loc` | `500` | Size-gate threshold (additions+deletions, excluding lockfiles/generated/vendored) |
| `review-on-synchronize` | `false` | Review every push |
| `never-approve` | `false` | Post approval verdicts as `COMMENT` |
| `max-turns` | `40` | Agent turn cap |

Outputs: `verdict`, `review-url`, `skipped`.

## Approvals and the default token

By default, GitHub forbids the Actions token from **approving** PRs (Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"). When approval is rejected, Recensio automatically downgrades to a `COMMENT` review that still states the verdict — nothing is lost. Enable that setting if you want real ✅ approvals, or set `never-approve: "true"` to always use comments. `REQUEST_CHANGES` verdicts are unaffected.

## Fork PRs

On `pull_request` events from forks, GitHub hands workflows a **read-only** token, so the review cannot be posted (Recensio fails with a clear message). Options:

1. **Use the comment path** — `@recensio` on the fork PR works as-is (issue_comment runs in the base repo with a write token).
2. **Switch the trigger to `pull_request_target`** in your workflow. The standard warning about `pull_request_target` is executing untrusted PR code with elevated permissions; Recensio only `git fetch`es and *reads* the PR's files — it never builds, installs, or executes them. The reviewed code does flow into the model's context, so treat the posted review text accordingly.

## Cost & runtime

A deep review of a 500–2000-LOC PR typically runs several minutes and a few dollars of API usage at the default `xhigh` effort (the review footer and the workflow step summary show exact token counts and an estimated cost per run). Levers, in order of impact: `effort` (e.g. `high` or `medium`), `model` (`claude-sonnet-4-6` is ~40% the price), `min-loc`, and leaving `review-on-synchronize` off.

## CLI (local runs & testing)

The same engine ships as a CLI — useful before wiring the workflow, or for reviewing any PR ad hoc. **Dry run is the default: nothing is posted.**

```bash
npm ci && npm run build

export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=ghp_...           # repo read; PR write only needed for --post

# print the full review (gate math, planned inline anchors, body) to stdout
node dist/cli.js review https://github.com/owner/repo/pull/123

# actually post it
node dist/cli.js review https://github.com/owner/repo/pull/123 --post

# bypass the size gate, like an explicit @recensio request
node dist/cli.js review https://github.com/owner/repo/pull/123 --force
```

Flags: `--post`, `--force`, `--model`, `--effort`, `--min-loc`, `--max-turns`, `--never-approve` (env equivalents: `RECENSIO_MODEL`, `RECENSIO_EFFORT`, `RECENSIO_MIN_LOC`, `RECENSIO_MAX_TURNS`).

## How it works

```
event ──► trigger router ──► size gate (deterministic, pre-LLM)
                                 │ pass (or @recensio bypass)
                                 ▼
                    shallow clone of pull/N/head (fork-safe)
                                 ▼
              Claude agent loop: read_file / list_dir / grep
              (adaptive thinking, prompt caching, turn caps)
                                 ▼
                  submit_review (strict JSON, zod-validated)
                                 ▼
        placement planner: model line numbers → diff-legal anchors
        (multi-line in one hunk · snap ≤3 lines · body fallback)
                                 ▼
        POST /pulls/:n/reviews — verdict + inline comments
        (degradation ladder: approve→comment, anchors→body, →issue comment)
```

Design properties worth knowing:

- **The review spec is the system prompt.** `prompts/system.md` contains the full Staff-engineer review protocol (phases, severity taxonomy, verification pass, confidence rubric) verbatim, plus a harness contract describing the tools and output schema. Edit it there; it's inlined into the bundle at build time.
- **The size gate never costs tokens.** It's computed from the PR's file stats in code, before any model call, with lockfiles/vendored/generated files excluded.
- **Inline anchors can't 422 the review.** The model reports head-revision line numbers; a deterministic planner maps them onto lines GitHub legally accepts (added + context lines inside hunks) and demotes everything else into a "Findings outside the visible diff" body section with permalinks. If GitHub still rejects something, a degradation ladder retries without inline comments and, last resort, posts the review as an issue comment — a review always lands.
- **Suggestions are gated.** A ```suggestion block only ships when it would replace exactly the anchored lines (and isn't a byte-for-byte no-op), so "Apply suggestion" always applies cleanly.
- **Re-reviews are stateful.** Recensio finds its previous review via a hidden marker, digests its findings, and instructs the agent to verify each one against the new head rather than re-deriving (or duplicating) them.
- **PR-template compliance.** When the reviewed repository has a pull request template (`.github/pull_request_template.md` or the other GitHub-recognized locations), the agent checks the PR description against its required sections and enforces any code-quality standards the template states (e.g. "all new code must have tests") as review criteria, citing the template line in each finding.
- **Prompt caching keeps turns cheap.** Tool definitions and the system prompt are byte-stable, and a sliding cache breakpoint follows the newest tool results; steady-state turns re-read the transcript at ~0.1× input price. Per-turn cache hits and the total cost are logged.

## Development

```bash
npm ci
npm run typecheck && npm run lint && npm test   # 120+ tests, no network
npm run build                                    # rebuild dist/ (committed; CI verifies it's current)
```

`dist/` is part of the action contract — commit it after any source change (`npm run build`), or CI will fail the "dist is stale" check.

### End-to-end verification runbook

Phase A — dry runs against real PRs (read-only, posts nothing):

1. `node dist/cli.js review <big-public-pr-url>` → gate math matches the PR's +/− stats; every planned anchor is on a diff line; all body sections render; per-turn `cacheRead` is non-zero from turn 2; cost is sane.
2. A tiny PR → the exact `⏭️ SKIPPED` block. With `--force` → full review.
3. A lockfile-churn PR → exclusions listed in the gate output.

Phase B — a scratch repo with the workflow installed:

1. Open a >500-LOC PR with planted bugs (string-concatenated SQL, off-by-one, missing `await`, swallowed error) → inline comments on the planted lines; suggestions apply cleanly; `REQUEST CHANGES`.
2. Push fixes, comment `@recensio` → 👀 reaction, prior findings reported resolved, no duplicate inline comments.
3. Tiny PR → skip notice; another tiny push → the notice is **edited**, not duplicated; `@recensio` → full review.
4. With repo approval setting off, a clean PR → verdict posted as COMMENT with the downgrade note; flip the setting on → real APPROVE.
5. `@recensio` from a read-only user → ignored (no reaction, no review).
6. Break the secret → `⚠️ Recensio failed` comment + failed check; fix it, `@recensio` → recovers.

## License

MIT
