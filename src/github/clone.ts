import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "../shared/log.js";

export interface ClonedRepo {
  dir: string;
  headSha: string;
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
 * Shallow-fetches the PR head into a fresh temp directory. `refs/pull/N/head`
 * lives on the base repository, so this works for fork PRs without any
 * checkout step in the consumer workflow. The token travels only as a
 * per-invocation header (never written to .git/config) and is redacted from
 * any error text by construction (it is not part of argv that we log).
 */
export async function clonePrHead(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  serverUrl = "https://github.com",
): Promise<ClonedRepo> {
  const base = process.env.RUNNER_TEMP || tmpdir();
  const dir = await mkdtemp(path.join(base, "recensio-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const url = `${serverUrl}/${owner}/${repo}.git`;
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    await runGit(["init", "-q"], dir);
    await runGit(
      ["-c", `http.${serverUrl}/.extraheader=${authHeader}`, "fetch", "-q", "--depth=1", url, `pull/${prNumber}/head`],
      dir,
      300_000,
    );
    await runGit(["checkout", "-q", "--detach", "FETCH_HEAD"], dir);
    const { stdout } = await runGit(["rev-parse", "HEAD"], dir);
    const headSha = stdout.trim();
    log.info(`cloned ${owner}/${repo}#${prNumber} head ${headSha.slice(0, 10)} into ${dir}`);
    return { dir, headSha, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
