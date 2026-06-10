import { spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sanitizeForStrictMode, submitReviewJsonSchema } from "./schema.js";

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

function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  delete raw.$schema;
  return sanitizeForStrictMode(raw) as Record<string, unknown>;
}

/** Tool definitions in a fixed order so the cached prompt prefix stays byte-stable. */
export function toolDefinitions(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict: boolean;
}> {
  return [
    {
      name: "read_file",
      description:
        "Read a file from the PR head revision with line numbers. Returns at most 400 lines per call; pass start_line/end_line to read a specific range. Line numbers shown are the head-revision numbers to use in findings.",
      input_schema: toInputSchema(ReadFileInput),
      strict: true,
    },
    {
      name: "list_dir",
      description:
        "List files and directories under a path at the PR head revision. Directories are suffixed with '/'. Use to orient before reading.",
      input_schema: toInputSchema(ListDirInput),
      strict: true,
    },
    {
      name: "grep",
      description:
        "Search file contents across the PR head revision with git grep. Returns matching lines as path:lineno:text. Prefer grep then a targeted read_file over crawling directories.",
      input_schema: toInputSchema(GrepInput),
      strict: true,
    },
    {
      name: "submit_review",
      description:
        "Submit the completed review. Call exactly once, as your final action, after Phases 1-4 are done. If validation fails, fix the listed fields and call again.",
      input_schema: submitReviewJsonSchema(),
      strict: true,
    },
  ];
}

export interface RepoTools {
  definitions: ReturnType<typeof toolDefinitions>;
  execute(name: string, input: unknown): Promise<ToolResultPayload>;
  /** Head-revision file reader used for suggestion no-op checks. */
  readLines(relPath: string): string[] | undefined;
}

export function makeTools(repoDir: string): RepoTools {
  const root = path.resolve(repoDir);

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
    definitions: toolDefinitions(),
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
