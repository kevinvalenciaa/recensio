import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTools, toolDefinitions, type RepoTools } from "../../src/engine/tools.js";

let repoDir: string;
let outside: string;
let tools: RepoTools;
let gitTools: RepoTools;
let firstSha: string;

beforeAll(() => {
  repoDir = mkdtempSync(path.join(tmpdir(), "recensio-tools-"));
  outside = mkdtempSync(path.join(tmpdir(), "recensio-outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "leaky");

  mkdirSync(path.join(repoDir, "src", "api"), { recursive: true });
  writeFileSync(
    path.join(repoDir, "src", "api", "users.ts"),
    Array.from({ length: 950 }, (_, i) => `// line ${i + 1}: const q${i} = sanitize(input);`).join("\n"),
  );
  writeFileSync(path.join(repoDir, "src", "index.ts"), "export const main = () => 'hello recensio';\n");
  writeFileSync(path.join(repoDir, "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  symlinkSync(path.join(outside, "secret.txt"), path.join(repoDir, "escape.txt"));

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  firstSha = git("rev-parse", "HEAD").toString().trim();
  // Second commit (new file) so log/diff_range have a range to work with;
  // leaves the files the other tests assert on untouched.
  writeFileSync(path.join(repoDir, "src", "added.ts"), "export const added = 42;\n");
  git("add", "-A");
  git("commit", "-qm", "second change");

  tools = makeTools(repoDir);
  gitTools = makeTools(repoDir, { historyAvailable: true });
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("toolDefinitions", () => {
  it("is byte-stable across calls (cache prefix requirement)", () => {
    expect(JSON.stringify(toolDefinitions())).toBe(JSON.stringify(toolDefinitions()));
  });

  it("declares the four tools in fixed order, all strict", () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(["read_file", "list_dir", "grep", "submit_review"]);
    expect(defs.every((d) => d.strict)).toBe(true);
  });

  it("inserts git tools between grep and submit_review when history is available", () => {
    const defs = toolDefinitions(true);
    expect(defs.map((d) => d.name)).toEqual([
      "read_file",
      "list_dir",
      "grep",
      "git_log",
      "git_blame",
      "git_diff_range",
      "submit_review",
    ]);
  });
});

describe("read_file", () => {
  it("returns numbered lines with header", async () => {
    const r = await tools.execute("read_file", { path: "src/index.ts" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("src/index.ts (lines 1-");
    expect(r.content).toMatch(/ {5}1\texport const main/);
  });

  it("caps at 400 lines and points at the continuation", async () => {
    const r = await tools.execute("read_file", { path: "src/api/users.ts" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("lines 1-400 of 950");
    expect(r.content).toContain("continue from start_line 401");
  });

  it("honors ranges and reports requested-range truncation", async () => {
    const r = await tools.execute("read_file", { path: "src/api/users.ts", start_line: 100, end_line: 102 });
    expect(r.content).toContain("lines 100-102 of 950");
    expect(r.content).toMatch(/ +100\t\/\/ line 100/);

    const big = await tools.execute("read_file", { path: "src/api/users.ts", start_line: 1, end_line: 900 });
    expect(big.content).toContain("[truncated:");
  });

  it("rejects path traversal and symlink escape", async () => {
    const dotdot = await tools.execute("read_file", { path: "../outside.txt" });
    expect(dotdot.isError).toBe(true);
    const link = await tools.execute("read_file", { path: "escape.txt" });
    expect(link.isError).toBe(true);
    const git = await tools.execute("read_file", { path: ".git/config" });
    expect(git.isError).toBe(true);
  });

  it("rejects binary files and bad ranges", async () => {
    const bin = await tools.execute("read_file", { path: "binary.dat" });
    expect(bin.isError).toBe(true);
    expect(bin.content).toContain("binary");
    const past = await tools.execute("read_file", { path: "src/index.ts", start_line: 999 });
    expect(past.isError).toBe(true);
  });

  it("rejects invalid input shapes with field-level messages", async () => {
    const r = await tools.execute("read_file", { file: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Invalid tool input");
  });
});

describe("list_dir", () => {
  it("lists with directories suffixed and .git hidden", async () => {
    const r = await tools.execute("list_dir", {});
    expect(r.isError).toBe(false);
    expect(r.content).toContain("src/");
    expect(r.content).toContain("src/index.ts");
    expect(r.content).not.toContain(".git/");
  });

  it("respects depth", async () => {
    const r = await tools.execute("list_dir", { path: "src", depth: 1 });
    expect(r.content).toContain("api/");
    expect(r.content).not.toContain("api/users.ts");
  });
});

describe("grep", () => {
  it("finds matches as path:line:text", async () => {
    const r = await tools.execute("grep", { pattern: "hello recensio" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("src/index.ts:1:");
  });

  it("treats regex metacharacters safely (no shell)", async () => {
    const r = await tools.execute("grep", { pattern: "'; rm -rf / #", fixed_strings: true });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("No matches");
  });

  it("caps long outputs with a notice", async () => {
    const r = await tools.execute("grep", { pattern: "sanitize" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("[truncated");
    expect(r.content.split("\n").length).toBeLessThanOrEqual(202);
  });

  it("restricts to a path", async () => {
    const r = await tools.execute("grep", { pattern: "hello", path: "src/api" });
    expect(r.content).toContain("No matches");
  });
});

describe("readLines", () => {
  it("reads head-revision lines for suggestion gating", () => {
    const lines = tools.readLines("src/index.ts");
    expect(lines?.[0]).toBe("export const main = () => 'hello recensio';");
    expect(tools.readLines("nope.ts")).toBeUndefined();
    expect(tools.readLines("binary.dat")).toBeUndefined();
  });
});

describe("git tools", () => {
  it("git_log lists commits, honoring a range", async () => {
    const all = await gitTools.execute("git_log", {});
    expect(all.isError).toBe(false);
    expect(all.content).toContain("second change");
    expect(all.content).toContain("fixture");

    const ranged = await gitTools.execute("git_log", { range: `${firstSha}..HEAD` });
    expect(ranged.content).toContain("second change");
    expect(ranged.content).not.toContain("fixture");
  });

  it("git_blame attributes lines to commits", async () => {
    const r = await gitTools.execute("git_blame", { path: "src/index.ts", start_line: 1, end_line: 1 });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("hello recensio");
  });

  it("git_diff_range shows changes between commits", async () => {
    const r = await gitTools.execute("git_diff_range", { range: `${firstSha}..HEAD` });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("added.ts");
    expect(r.content).toContain("+export const added = 42;");
  });

  it("rejects option-injection in ranges and paths", async () => {
    expect((await gitTools.execute("git_diff_range", { range: "--output=/tmp/x" })).isError).toBe(true);
    expect((await gitTools.execute("git_log", { path: "--all" })).isError).toBe(true);
    expect((await gitTools.execute("git_blame", { path: "-L/etc/passwd" })).isError).toBe(true);
  });

  it("git tools are unavailable when history was not fetched", async () => {
    const r = await tools.execute("git_log", {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unavailable");
  });
});
