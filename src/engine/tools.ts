import { spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sanitizeForStrictMode, submitReviewJsonSchema } from "./schema.js";
import { astAvailable, classifyInSource, langForFile, loadLanguage } from "./references.js";

export interface ToolResultPayload {
  content: string;
  isError: boolean;
}

const READ_MAX_LINES = 400;
const READ_MAX_BYTES = 40_000;
const LIST_MAX_ENTRIES = 500;
const GREP_MAX_LINES = 200;
const GREP_MAX_BYTES = 20_000;
const GREP_TIMEOUT_MS = 5_000;

const ReadFileInput = z.strictObject({
  path: z.string().describe("Repo-relative file path"),
  start_line: z.number().optional().describe("1-based first line to return"),
  end_line: z.number().optional().describe("1-based last line to return (inclusive)"),
});

const ListDirInput = z.strictObject({
  path: z.string().optional().describe('Repo-relative directory; omit or "." for the root'),
  depth: z.number().optional().describe("How many levels to descend (default 2)"),
});

const GrepInput = z.strictObject({
  pattern: z.string().describe("Regex (POSIX ERE) to search for; set fixed_strings for a literal"),
  path: z.string().optional().describe("Restrict the search to this file or directory"),
  ignore_case: z.boolean().optional(),
  fixed_strings: z.boolean().optional().describe("Treat pattern as a literal string"),
  context: z.number().optional().describe("Lines of context around each match (max 5)"),
});

const GitLogInput = z.strictObject({
  range: z.string().optional().describe('Commit range, e.g. "<baseSha>..HEAD" (the PR commits). Omit for recent history.'),
  path: z.string().optional().describe("Restrict to a file or directory"),
  max: z.number().optional().describe("Max commits to return (default 30, cap 100)"),
});

const GitBlameInput = z.strictObject({
  path: z.string().describe("File to blame (head revision)"),
  start_line: z.number().optional().describe("1-based first line"),
  end_line: z.number().optional().describe("1-based last line"),
});

const GitDiffRangeInput = z.strictObject({
  range: z.string().describe('Commit range, e.g. "<baseSha>..HEAD" or "<oldSha>..<newSha>"'),
  path: z.string().optional().describe("Restrict the diff to a file or directory"),
});

const FindRefsInput = z.strictObject({
  symbol: z.string().describe("Exact identifier to find references to (function, class, variable, type)"),
  lang: z
    .string()
    .optional()
    .describe("Override language (typescript|tsx|javascript|python|go|java); inferred from extension otherwise"),
});

function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  delete raw.$schema;
  return sanitizeForStrictMode(raw) as Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict: boolean;
}

/**
 * Tool definitions in a fixed order so the cached prompt prefix stays
 * byte-stable. The git-history tools are appended in one fixed position (after
 * find_references, before submit_review) only when history is available.
 *
 * Only `submit_review` is `strict`. The API compiles a constrained-decoding
 * grammar per strict tool, and the sum of many strict grammars hits a hard
 * size limit — so the navigation tools (which have trivial inputs and are
 * zod-validated in execute() anyway) are left non-strict; the budget goes to
 * the one tool where structured-output correctness matters.
 */
export function toolDefinitions(withGit = false): ToolDef[] {
  const defs: ToolDef[] = [
    {
      name: "read_file",
      description:
        "Read a file from the PR head revision with line numbers. Returns at most 400 lines per call; pass start_line/end_line to read a specific range. Line numbers shown are the head-revision numbers to use in findings.",
      input_schema: toInputSchema(ReadFileInput),
      strict: false,
    },
    {
      name: "list_dir",
      description:
        "List files and directories under a path at the PR head revision. Directories are suffixed with '/'. Use to orient before reading.",
      input_schema: toInputSchema(ListDirInput),
      strict: false,
    },
    {
      name: "grep",
      description:
        "Search file contents across the PR head revision with git grep. Returns matching lines as path:lineno:text. Prefer grep then a targeted read_file over crawling directories.",
      input_schema: toInputSchema(GrepInput),
      strict: false,
    },
    {
      name: "find_references",
      description:
        "Find where a symbol is used across the repo, classified as declaration / call / import / reference (via AST parsing, so matches inside strings and comments are excluded). Use for blast-radius: callers of a changed function, consumers of a changed type. Falls back to a textual word match for unsupported languages.",
      input_schema: toInputSchema(FindRefsInput),
      strict: false,
    },
  ];
  if (withGit) {
    defs.push(
      {
        name: "git_log",
        description:
          "List commits (hash, author, date, subject). Pass range like \"<baseSha>..HEAD\" to see only this PR's commits. Use to understand how the change was built and what each commit did.",
        input_schema: toInputSchema(GitLogInput),
        strict: false,
      },
      {
        name: "git_blame",
        description:
          "Show, per line, the commit that last changed it. Use to confirm whether a line is genuinely INTRODUCED by this PR vs pre-existing (EXPOSED/PRE-EXISTING), rather than guessing.",
        input_schema: toInputSchema(GitBlameInput),
        strict: false,
      },
      {
        name: "git_diff_range",
        description:
          'Show the diff between two commits, e.g. "<baseSha>..HEAD" for the whole PR or "<lastReviewedSha>..HEAD" to see only what changed since a prior review.',
        input_schema: toInputSchema(GitDiffRangeInput),
        strict: false,
      },
    );
  }
  defs.push({
    name: "submit_review",
    description:
      "Submit the completed review. Call exactly once, as your final action, after Phases 1-4 are done. If validation fails, fix the listed fields and call again.",
    input_schema: submitReviewJsonSchema(),
    strict: true,
  });
  return defs;
}

export interface RepoTools {
  definitions: ToolDef[];
  execute(name: string, input: unknown): Promise<ToolResultPayload>;
  /** Head-revision file reader used for suggestion no-op checks. */
  readLines(relPath: string): string[] | undefined;
}

export interface MakeToolsOptions {
  /** `-c http....extraheader=...` prefix so blame/diff can fault blobs. */
  gitConfigArgs?: string[];
  /** When true, expose git_log/git_blame/git_diff_range. */
  historyAvailable?: boolean;
}

const GIT_MAX_BYTES = 20_000;
const GIT_TIMEOUT_MS = 15_000;
// A git revision/range: shas, refs, HEAD, ^ ~ . / and .. /... ranges. No
// leading dash (blocks option injection); paths always go after `--`.
const SAFE_REV_RE = /^[A-Za-z0-9_][A-Za-z0-9_./^~-]*(\.\.\.?[A-Za-z0-9_][A-Za-z0-9_./^~-]*)?$/;

export function makeTools(repoDir: string, opts: MakeToolsOptions = {}): RepoTools {
  const root = path.resolve(repoDir);
  const gitConfigArgs = opts.gitConfigArgs ?? [];
  const historyAvailable = opts.historyAvailable ?? false;

  async function resolveSafe(rel: string): Promise<string | undefined> {
    const candidate = path.resolve(root, rel.replace(/^\/+/, ""));
    if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;
    if (path.relative(root, candidate).split(path.sep)[0] === ".git") return undefined;
    try {
      const real = await fs.realpath(candidate);
      const realRoot = await fs.realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined;
      return real;
    } catch {
      return undefined; // does not exist
    }
  }

  async function readFile(input: z.infer<typeof ReadFileInput>): Promise<ToolResultPayload> {
    const abs = await resolveSafe(input.path);
    if (!abs) {
      return { content: `File not found: ${input.path}. Use list_dir or grep to locate the right path.`, isError: true };
    }
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      return { content: `${input.path} is a directory. Use list_dir to inspect it.`, isError: true };
    }
    const buf = await fs.readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) {
      return { content: `${input.path} is a binary file (${stat.size} bytes); not readable as text.`, isError: true };
    }
    const lines = buf.toString("utf8").split("\n");
    const total = lines.length;
    const start = Math.max(1, Math.floor(input.start_line ?? 1));
    if (start > total) {
      return { content: `start_line ${start} is past the end of ${input.path} (${total} lines).`, isError: true };
    }
    let end = Math.min(total, Math.floor(input.end_line ?? start + READ_MAX_LINES - 1));
    if (end < start) end = start;
    let truncatedByLines = false;
    if (end - start + 1 > READ_MAX_LINES) {
      end = start + READ_MAX_LINES - 1;
      truncatedByLines = true;
    }

    const out: string[] = [];
    let bytes = 0;
    let lastIncluded = start - 1;
    for (let n = start; n <= end; n++) {
      const line = `${String(n).padStart(6)}\t${lines[n - 1] ?? ""}`;
      bytes += line.length + 1;
      if (bytes > READ_MAX_BYTES) break;
      out.push(line);
      lastIncluded = n;
    }
    const header = `${input.path} (lines ${start}-${lastIncluded} of ${total})`;
    const notices: string[] = [];
    if (lastIncluded < end || truncatedByLines || (input.end_line !== undefined && lastIncluded < Math.floor(input.end_line))) {
      notices.push(`[truncated: ${total - lastIncluded} more lines — request a narrower range starting at ${lastIncluded + 1}]`);
    } else if (input.end_line === undefined && lastIncluded < total) {
      notices.push(`[${total - lastIncluded} more lines — continue from start_line ${lastIncluded + 1}]`);
    }
    return { content: [header, ...out, ...notices].join("\n"), isError: false };
  }

  async function listDir(input: z.infer<typeof ListDirInput>): Promise<ToolResultPayload> {
    const rel = input.path && input.path !== "." ? input.path : ".";
    const abs = await resolveSafe(rel);
    if (!abs) return { content: `Directory not found: ${rel}.`, isError: true };
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return { content: `${rel} is a file. Use read_file.`, isError: true };

    const depth = Math.min(Math.max(Math.floor(input.depth ?? 2), 1), 6);
    const entries: string[] = [];
    let capped = false;

    async function walk(dir: string, prefix: string, level: number): Promise<void> {
      if (capped) return;
      let names: Array<{ name: string; isDir: boolean }> = [];
      try {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        names = dirents
          .filter((d) => d.name !== ".git")
          .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return;
      }
      for (const { name, isDir } of names) {
        if (entries.length >= LIST_MAX_ENTRIES) {
          capped = true;
          return;
        }
        const relPath = prefix ? `${prefix}/${name}` : name;
        entries.push(isDir ? `${relPath}/` : relPath);
        if (isDir && level < depth) await walk(path.join(dir, name), relPath, level + 1);
      }
    }

    await walk(abs, "", 1);
    const lines = [`${rel === "." ? "(repo root)" : rel} — depth ${depth}`, ...entries];
    if (capped) lines.push(`[truncated at ${LIST_MAX_ENTRIES} entries — list a subdirectory or lower depth]`);
    return { content: lines.join("\n"), isError: false };
  }

  function grep(input: z.infer<typeof GrepInput>): Promise<ToolResultPayload> {
    const args = ["grep", "-n", "-I"];
    if (input.ignore_case) args.push("-i");
    if (input.fixed_strings) args.push("-F");
    const ctx = Math.min(Math.max(Math.floor(input.context ?? 0), 0), 5);
    if (ctx > 0) args.push(`-C${ctx}`);
    args.push("-e", input.pattern, "--");
    args.push(input.path ? input.path : ".");

    return new Promise((resolve) => {
      const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: GREP_TIMEOUT_MS });
      let stdout = "";
      let stderr = "";
      let killed = false;
      child.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.length > GREP_MAX_BYTES * 4) {
          killed = true;
          child.kill();
        }
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => resolve({ content: `grep failed to start: ${String(err)}`, isError: true }));
      child.on("close", (code) => {
        if (code === 1 && stdout === "" && !killed) {
          resolve({ content: `No matches for ${JSON.stringify(input.pattern)}.`, isError: false });
          return;
        }
        if (code !== 0 && code !== 1 && !killed && stdout === "") {
          resolve({ content: `grep error: ${stderr.trim().slice(0, 500) || `exit ${code}`}`, isError: true });
          return;
        }
        const allLines = stdout.split("\n").filter((l) => l !== "");
        const lines = allLines.slice(0, GREP_MAX_LINES);
        let text = lines.join("\n");
        if (text.length > GREP_MAX_BYTES) text = text.slice(0, GREP_MAX_BYTES);
        const omitted = allLines.length - lines.length;
        if (omitted > 0 || killed || text.length < lines.join("\n").length) {
          text += `\n[truncated — narrow the pattern or restrict to a path]`;
        }
        resolve({ content: text, isError: false });
      });
    });
  }

  /** Runs a read-only git subcommand with auth, capping output. */
  function runGitTool(subArgs: string[]): Promise<ToolResultPayload> {
    const args = [...gitConfigArgs, "--no-pager", ...subArgs];
    return new Promise((resolve) => {
      const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
      let stdout = "";
      let stderr = "";
      let killed = false;
      child.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.length > GIT_MAX_BYTES * 4) {
          killed = true;
          child.kill();
        }
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => resolve({ content: `git failed to start: ${String(err)}`, isError: true }));
      child.on("close", (code) => {
        if (code !== 0 && !killed && stdout === "") {
          resolve({ content: `git error: ${stderr.trim().slice(0, 500) || `exit ${code}`}`, isError: true });
          return;
        }
        let text = stdout;
        if (text.length > GIT_MAX_BYTES) {
          text = text.slice(0, GIT_MAX_BYTES) + "\n[truncated — narrow the range or restrict to a path]";
        } else if (killed) {
          text += "\n[truncated — narrow the range or restrict to a path]";
        }
        resolve({ content: text || "(no output)", isError: false });
      });
    });
  }

  function gitLog(input: z.infer<typeof GitLogInput>): Promise<ToolResultPayload> {
    if (input.range !== undefined && !SAFE_REV_RE.test(input.range)) {
      return Promise.resolve({ content: `Invalid range: ${JSON.stringify(input.range)}`, isError: true });
    }
    if (input.path !== undefined && input.path.startsWith("-")) {
      return Promise.resolve({ content: "path must not start with '-'", isError: true });
    }
    const max = Math.min(Math.max(Math.floor(input.max ?? 30), 1), 100);
    const args = ["log", "--no-color", `--max-count=${max}`, "--date=short", "--format=%h %ad %an: %s"];
    if (input.range) args.push(input.range);
    args.push("--");
    if (input.path) args.push(input.path);
    return runGitTool(args);
  }

  function gitBlame(input: z.infer<typeof GitBlameInput>): Promise<ToolResultPayload> {
    if (input.path.startsWith("-")) {
      return Promise.resolve({ content: "path must not start with '-'", isError: true });
    }
    const args = ["blame", "--date=short"];
    if (input.start_line !== undefined) {
      const end = input.end_line ?? input.start_line;
      args.push("-L", `${Math.max(1, Math.floor(input.start_line))},${Math.max(1, Math.floor(end))}`);
    }
    args.push("--", input.path);
    return runGitTool(args);
  }

  function gitDiffRange(input: z.infer<typeof GitDiffRangeInput>): Promise<ToolResultPayload> {
    if (!SAFE_REV_RE.test(input.range)) {
      return Promise.resolve({ content: `Invalid range: ${JSON.stringify(input.range)}`, isError: true });
    }
    if (input.path !== undefined && input.path.startsWith("-")) {
      return Promise.resolve({ content: "path must not start with '-'", isError: true });
    }
    const args = ["diff", "--no-color", input.range, "--"];
    if (input.path) args.push(input.path);
    return runGitTool(args);
  }

  /** git grep -nwF prefilter: candidate "path:line:text" hits for a literal symbol. */
  function gitGrepWord(symbol: string): Promise<string[]> {
    return new Promise((resolve) => {
      const child = spawn("git", ["grep", "-n", "-w", "-F", "-I", "-e", symbol, "--", "."], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GREP_TIMEOUT_MS,
      });
      let stdout = "";
      child.stdout.on("data", (d) => {
        if (stdout.length < GREP_MAX_BYTES * 8) stdout += d;
      });
      child.on("error", () => resolve([]));
      child.on("close", () => resolve(stdout.split("\n").filter((l) => l !== "")));
    });
  }

  async function findReferences(input: z.infer<typeof FindRefsInput>): Promise<ToolResultPayload> {
    const hits = await gitGrepWord(input.symbol);
    if (hits.length === 0) {
      return { content: `No references to \`${input.symbol}\` found.`, isError: false };
    }

    // Group raw grep hits by file (cap files parsed).
    const byFile = new Map<string, Array<{ line: number; text: string }>>();
    for (const h of hits) {
      const m = h.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) continue;
      const file = m[1]!;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push({ line: Number(m[2]), text: m[3]!.trim().slice(0, 200) });
    }

    const out: string[] = [];
    const initOk = await astAvailable();
    let classified = 0;

    for (const [file, rawHits] of [...byFile.entries()].slice(0, 60)) {
      const lang = initOk ? langForFile(file, input.lang) : undefined;
      const language = lang ? await loadLanguage(lang) : null;
      if (language) {
        try {
          const source = readFileSync(path.join(root, file), "utf8");
          const refs = classifyInSource(language, source, input.symbol, file);
          for (const r of refs) out.push(`${r.path}:${r.line}: ${r.kind} — ${r.text}`);
          classified += 1;
          continue;
        } catch {
          // fall through to raw hits for this file
        }
      }
      for (const h of rawHits) out.push(`${file}:${h.line}: (unclassified text match) ${h.text}`);
    }

    let text = out.slice(0, 200).join("\n");
    if (text.length > GREP_MAX_BYTES) text = text.slice(0, GREP_MAX_BYTES) + "\n[truncated]";
    else if (out.length > 200) text += "\n[truncated — too many references; narrow with grep]";
    if (classified === 0 && initOk === false) {
      text = `(AST unavailable — showing textual word matches)\n${text}`;
    }
    return { content: text, isError: false };
  }

  function readLinesSync(relPath: string): string[] | undefined {
    try {
      const candidate = path.resolve(root, relPath.replace(/^\/+/, ""));
      if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;
      const data = readFileSync(candidate);
      if (data.subarray(0, 8192).includes(0)) return undefined;
      return data.toString("utf8").split("\n");
    } catch {
      return undefined;
    }
  }

  return {
    definitions: toolDefinitions(historyAvailable),
    async execute(name, input): Promise<ToolResultPayload> {
      try {
        switch (name) {
          case "read_file": {
            const parsed = ReadFileInput.safeParse(input);
            if (!parsed.success) return zodError(parsed.error);
            return await readFile(parsed.data);
          }
          case "list_dir": {
            const parsed = ListDirInput.safeParse(input);
            if (!parsed.success) return zodError(parsed.error);
            return await listDir(parsed.data);
          }
          case "grep": {
            const parsed = GrepInput.safeParse(input);
            if (!parsed.success) return zodError(parsed.error);
            return await grep(parsed.data);
          }
          case "find_references": {
            const parsed = FindRefsInput.safeParse(input);
            if (!parsed.success) return zodError(parsed.error);
            return await findReferences(parsed.data);
          }
          case "git_log":
          case "git_blame":
          case "git_diff_range": {
            if (!historyAvailable) return { content: `${name} is unavailable (git history was not fetched).`, isError: true };
            if (name === "git_log") {
              const parsed = GitLogInput.safeParse(input);
              return parsed.success ? await gitLog(parsed.data) : zodError(parsed.error);
            }
            if (name === "git_blame") {
              const parsed = GitBlameInput.safeParse(input);
              return parsed.success ? await gitBlame(parsed.data) : zodError(parsed.error);
            }
            const parsed = GitDiffRangeInput.safeParse(input);
            return parsed.success ? await gitDiffRange(parsed.data) : zodError(parsed.error);
          }
          default:
            return { content: `Unknown tool: ${name}`, isError: true };
        }
      } catch (err) {
        return { content: `Tool ${name} failed: ${String(err).slice(0, 500)}`, isError: true };
      }
    },
    readLines: readLinesSync,
  };
}

function zodError(error: z.ZodError): ToolResultPayload {
  const lines = error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`);
  return { content: `Invalid tool input:\n${lines.join("\n")}`, isError: true };
}
