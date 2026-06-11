import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clonePrHead, isAncestor, runGit } from "../../src/github/clone.js";

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

describe("clonePrHead auth invariant", () => {
  it("passes the auth header to every blob-faulting command (checkout + fetches)", async () => {
    // Regression guard for the v1 bug: a blobless checkout faults HEAD's blobs
    // over the network and MUST carry the -c http.extraheader auth, or git
    // prompts for credentials and exits 128.
    const calls: string[][] = [];
    const fakeRun = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse") return { stdout: "f".repeat(40), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const cloned = await clonePrHead("o", "r", 5, "tok", "https://github.com", "b".repeat(40), fakeRun as any);
    await cloned.cleanup();

    const authArg = (a: string[]) => a.some((x) => x.startsWith("http.https://github.com/.extraheader="));
    const finds = (verb: string) => calls.filter((a) => a.includes(verb));
    // every checkout and every fetch must be authenticated
    expect(finds("checkout").length).toBeGreaterThan(0);
    for (const c of finds("checkout")) expect(authArg(c)).toBe(true);
    for (const f of finds("fetch")) expect(authArg(f)).toBe(true);
    // the token must never be written to git config
    for (const c of calls.filter((a) => a[0] === "config")) {
      expect(c.join(" ")).not.toContain("extraheader");
      expect(c.join(" ")).not.toContain("tok");
    }
  });
});
