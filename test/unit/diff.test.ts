import { describe, expect, it } from "vitest";
import { buildRepoDiffModel, hunkContaining, normalizePath, parseFilePatch } from "../../src/github/diff.js";
import type { PrFile } from "../../src/shared/types.js";

function prFile(patch: string | undefined, filename = "src/app.ts", status: PrFile["status"] = "modified"): PrFile {
  return { filename, status, additions: 0, deletions: 0, changes: 0, patch };
}

// Mirrors GitHub's patch format: hunk of context/-/+ lines.
const MIXED_PATCH = [
  "@@ -10,7 +10,8 @@ function handler() {",
  "   const a = 1;", // old 10 / new 10 (context) — note: real patches use single space prefix
  "-  const removed = 2;", // old 11
  "-  const alsoRemoved = 3;", // old 12
  "+  const added = 2;", // new 11
  "+  const alsoAdded = 3;", // new 12
  "+  const third = 4;", // new 13
  "   const b = 5;", // old 13 / new 14
  "   const c = 6;", // old 14 / new 15
  "   return a + b;", // old 15 / new 16
  "@@ -40,3 +41,4 @@ function other() {",
  "   let x = 0;", // old 40 / new 41
  "+  x += 1;", // new 42
  "   return x;", // old 41 / new 43
  "   }", // old 42 / new 44
].join("\n");

// GitHub uses a single leading space for context lines; the fixture above uses
// three-char indents for readability, so normalize: context lines must start
// with exactly one space in the real format. Build the real patch here.
const REAL_MIXED_PATCH = MIXED_PATCH.split("\n")
  .map((l) => (l.startsWith("   ") ? ` ${l.slice(3)}` : l))
  .join("\n");

describe("parseFilePatch", () => {
  it("maps a mixed add/remove/context patch to RIGHT and LEFT line sets", () => {
    const m = parseFilePatch(prFile(REAL_MIXED_PATCH));
    expect(m.right.get(10)).toBe("context");
    expect(m.right.get(11)).toBe("add");
    expect(m.right.get(12)).toBe("add");
    expect(m.right.get(13)).toBe("add");
    expect(m.right.get(14)).toBe("context");
    expect(m.right.get(16)).toBe("context");
    expect(m.right.has(17)).toBe(false); // beyond hunk 1
    expect(m.right.get(41)).toBe("context");
    expect(m.right.get(42)).toBe("add");
    expect(m.right.get(44)).toBe("context");
    expect(m.left).toEqual(new Set([11, 12]));
    expect(m.hunks).toEqual([
      { rightStart: 10, rightEnd: 16 },
      { rightStart: 41, rightEnd: 44 },
    ]);
  });

  it("handles an added file (all additions from line 1)", () => {
    const patch = ["@@ -0,0 +1,3 @@", "+line one", "+line two", "+line three"].join("\n");
    const m = parseFilePatch(prFile(patch, "new.ts", "added"));
    expect([...m.right.keys()]).toEqual([1, 2, 3]);
    expect(m.left.size).toBe(0);
    expect(m.hunks).toEqual([{ rightStart: 1, rightEnd: 3 }]);
  });

  it("handles a pure-deletion hunk (empty RIGHT range)", () => {
    const patch = ["@@ -5,2 +4,0 @@", "-gone", "-also gone"].join("\n");
    const m = parseFilePatch(prFile(patch));
    expect(m.right.size).toBe(0);
    expect(m.left).toEqual(new Set([5, 6]));
    const h = m.hunks[0]!;
    expect(h.rightEnd).toBeLessThan(h.rightStart);
  });

  it("ignores '\\ No newline at end of file' markers", () => {
    const patch = ["@@ -1,2 +1,2 @@", " keep", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"].join("\n");
    const m = parseFilePatch(prFile(patch));
    expect(m.right.get(1)).toBe("context");
    expect(m.right.get(2)).toBe("add");
    expect(m.left).toEqual(new Set([2]));
  });

  it("handles hunk headers without explicit counts (@@ -1 +1 @@)", () => {
    const patch = ["@@ -1 +1 @@", "-a", "+b"].join("\n");
    const m = parseFilePatch(prFile(patch));
    expect(m.right.get(1)).toBe("add");
    expect(m.left).toEqual(new Set([1]));
  });

  it("models a file without a patch (binary / oversized) as non-commentable", () => {
    const m = parseFilePatch(prFile(undefined, "img.png"));
    expect(m.hasPatch).toBe(false);
    expect(m.right.size).toBe(0);
  });

  it("keys renamed files by their new path", () => {
    const files: PrFile[] = [
      { filename: "src/new-name.ts", previousFilename: "src/old-name.ts", status: "renamed", additions: 1, deletions: 1, changes: 2, patch: ["@@ -1,1 +1,1 @@", "-x", "+y"].join("\n") },
    ];
    const repo = buildRepoDiffModel(files);
    expect(repo.has("src/new-name.ts")).toBe(true);
    expect(repo.has("src/old-name.ts")).toBe(false);
  });
});

describe("hunkContaining", () => {
  it("finds the hunk only when the whole range fits", () => {
    const m = parseFilePatch(prFile(REAL_MIXED_PATCH));
    expect(hunkContaining(m, 11, 13)).toEqual({ rightStart: 10, rightEnd: 16 });
    expect(hunkContaining(m, 15, 42)).toBeUndefined(); // spans both hunks
  });
});

describe("normalizePath", () => {
  it.each([
    ["./src/a.ts", "src/a.ts"],
    ["src//a.ts", "src/a.ts"],
    ["/src/a.ts", "src/a.ts"],
    ["src\\a.ts", "src/a.ts"],
    [" src/a.ts ", "src/a.ts"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});
