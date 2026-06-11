import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAncestor, runGit } from "../../src/github/clone.js";

// Exercises the git-history primitives against a local bare repo over file://,
// avoiding any network. (clonePrHead itself targets GitHub's pull/N/head ref,
// which can't be reproduced locally; its git mechanics are covered here.)
let workDir: string;
let bareDir: string;
let baseSha: string;
let headSha: string;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

beforeAll(() => {
  const src = mkdtempSync(path.join(tmpdir(), "recensio-src-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: src, env: ENV }).toString().trim();
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(src, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  baseSha = git("rev-parse", "HEAD");
  writeFileSync(path.join(src, "a.txt"), "one\ntwo\n");
  git("add", "-A");
  git("commit", "-qm", "head");
  headSha = git("rev-parse", "HEAD");

  bareDir = mkdtempSync(path.join(tmpdir(), "recensio-bare-")) + "/repo.git";
  execFileSync("git", ["clone", "-q", "--bare", src, bareDir], { env: ENV });
  rmSync(src, { recursive: true, force: true });
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  rmSync(path.dirname(bareDir), { recursive: true, force: true });
});

describe("git history primitives", () => {
  it("blobless-fetches head + base and resolves ancestry / ranges", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "recensio-work-"));
    mkdirSync(workDir, { recursive: true });
    const url = `file://${bareDir}`;

    await runGit(["init", "-q"], workDir);
    await runGit(["fetch", "-q", "--filter=blob:none", url, headSha], workDir);
    await runGit(["checkout", "-q", "--detach", "FETCH_HEAD"], workDir);
    await runGit(["fetch", "-q", "--filter=blob:none", url, baseSha], workDir);

    // base is an ancestor of head; a random sha is not.
    expect(await isAncestor(workDir, baseSha)).toBe(true);
    expect(await isAncestor(workDir, "0".repeat(40))).toBe(false);

    const { stdout } = await runGit(["log", "--format=%s", `${baseSha}..HEAD`], workDir);
    expect(stdout.trim()).toBe("head");

    const diff = await runGit(["diff", "--no-color", `${baseSha}..HEAD`], workDir);
    expect(diff.stdout).toContain("+two");
  });
});
