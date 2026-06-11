import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "../shared/log.js";

export interface ClonedRepo {
  dir: string;
  headSha: string;
  baseSha: string;
  /** True when full commit history is present (blobless clone succeeded). */
  historyAvailable: boolean;
  /** `-c http.<server>/.extraheader=...` prefix; re-applied on every git call so
   *  on-demand blob faults (blame/diff) authenticate without writing the token
   *  to .git/config. */
  gitConfigArgs: string[];
  cleanup(): Promise<void>;
}

export function runGit(args: string[], cwd: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args[0]} exited with ${code}: ${stderr.slice(0, 2000)}`));
    });
  });
}

/**
 * Fetches the PR head into a fresh temp directory. Tries a blobless partial
 * clone that also fetches the base commit — giving the agent full commit
 * history (git_log/blame/diff, provenance grounding, incremental re-review)
 * while blobs fault in lazily over the authenticated transport. Falls back to
 * a head-only `--depth=1` shallow fetch if the partial fetch fails, with
 * history tools disabled.
 *
 * `refs/pull/N/head` lives on the base repository, so this works for fork PRs.
 */
export async function clonePrHead(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  serverUrl = "https://github.com",
  baseSha = "",
): Promise<ClonedRepo> {
  const base = process.env.RUNNER_TEMP || tmpdir();
  const dir = await mkdtemp(path.join(base, "recensio-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  const url = `${serverUrl}/${owner}/${repo}.git`;
  const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const gitConfigArgs = ["-c", `http.${serverUrl}/.extraheader=${authHeader}`];

  try {
    await runGit(["init", "-q"], dir);
    let historyAvailable = false;

    try {
      // Blobless: all commits + trees, blobs on demand. Fetch the base commit
      // too so merge-base / log base..HEAD / blame work.
      await runGit(
        [...gitConfigArgs, "fetch", "-q", "--filter=blob:none", url, `pull/${prNumber}/head`],
        dir,
        300_000,
      );
      await runGit(["checkout", "-q", "--detach", "FETCH_HEAD"], dir);
      if (baseSha) {
        await runGit([...gitConfigArgs, "fetch", "-q", "--filter=blob:none", url, baseSha], dir, 300_000);
      }
      historyAvailable = true;
    } catch (partialErr) {
      log.warn(`partial clone failed (${String(partialErr).slice(0, 200)}) — falling back to shallow; history tools disabled`);
      await runGit([...gitConfigArgs, "fetch", "-q", "--depth=1", url, `pull/${prNumber}/head`], dir, 300_000);
      await runGit(["checkout", "-q", "--detach", "FETCH_HEAD"], dir);
    }

    const { stdout } = await runGit(["rev-parse", "HEAD"], dir);
    const headSha = stdout.trim();
    log.info(
      `cloned ${owner}/${repo}#${prNumber} head ${headSha.slice(0, 10)} into ${dir} (history ${historyAvailable ? "available" : "unavailable"})`,
    );
    return { dir, headSha, baseSha, historyAvailable, gitConfigArgs, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** True when `ancestor` is an ancestor of HEAD (history must be available). */
export async function isAncestor(dir: string, ancestor: string): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, "HEAD"], dir);
    return true;
  } catch {
    return false;
  }
}
