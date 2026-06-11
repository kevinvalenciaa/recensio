import { spawn } from "node:child_process";
import type { ChecksConfig } from "../github/config.js";
import { log } from "../shared/log.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  timedOut: boolean;
  output: string;
}

const INSTALL_TIMEOUT_MS = 8 * 60_000;
const CHECK_TIMEOUT_MS = 4 * 60_000;
const OUTPUT_MAX = 8_000;
/** Env keys passed to checks. Notably excludes ANTHROPIC_API_KEY / GITHUB_TOKEN. */
const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL", "TERM"];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "true" };
  for (const k of ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

/** Splits a command string into argv on whitespace (no shell). */
function toArgv(command: string): string[] {
  return command.trim().split(/\s+/);
}

function runOne(name: string, command: string, cwd: string, timeoutMs: number): Promise<CheckResult> {
  const [bin, ...args] = toArgv(command);
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ name, ok: false, timedOut: false, output: "empty command" });
      return;
    }
    const child = spawn(bin, args, {
      cwd,
      env: scrubbedEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    let out = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      if (out.length < OUTPUT_MAX * 4) out += d.toString();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => resolve({ name, ok: false, timedOut: false, output: `failed to start: ${String(err)}` }));
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM") timedOut = true;
      let output = out.trim();
      if (output.length > OUTPUT_MAX) output = output.slice(-OUTPUT_MAX); // tail: errors are usually last
      resolve({ name, ok: code === 0 && !timedOut, timedOut, output });
    });
  });
}

/**
 * Runs the configured checks against the cloned PR worktree and returns their
 * results for the agent to verify against. This executes repository code, so
 * the caller MUST gate it to same-repo PRs (never forks, never
 * pull_request_target). Commands run with a scrubbed environment (no API
 * tokens), `npm ci --ignore-scripts`-style installs, and per-command timeouts.
 */
export async function runChecks(checks: ChecksConfig, repoDir: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  if (checks.install) {
    log.info(`running install: ${checks.install}`);
    const r = await runOne("install", checks.install, repoDir, INSTALL_TIMEOUT_MS);
    results.push(r);
    if (!r.ok) {
      // Without dependencies the checks will be noise; stop here.
      log.warn(`install failed${r.timedOut ? " (timed out)" : ""} — skipping remaining checks`);
      return results;
    }
  }

  for (const command of checks.commands) {
    const name = toArgv(command)[0] ?? command;
    log.info(`running check: ${command}`);
    results.push(await runOne(name, command, repoDir, CHECK_TIMEOUT_MS));
  }
  return results;
}

export function renderCheckBlock(results: CheckResult[]): string {
  const lines = results.map((r) => {
    const status = r.timedOut ? "⏱️ TIMED OUT" : r.ok ? "✅ passed" : "❌ FAILED";
    const body = r.output ? `\n\`\`\`\n${r.output}\n\`\`\`` : "";
    return `### ${r.name} — ${status}${r.ok ? "" : body}`;
  });
  return `<check_results>\nThe repository's configured checks were run against this PR's head. A failure here is ground truth — trace it to the offending change and report it (don't re-run the check, you can't; verify by reading the code). A pass does not prove the change is correct.\n\n${lines.join("\n\n")}\n</check_results>`;
}
