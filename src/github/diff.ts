import type { PrFile } from "../shared/types.js";

/**
 * Model of which lines GitHub will accept inline review comments on.
 *
 * GitHub anchors comments with `line` + `side`. RIGHT covers added lines and
 * unchanged context lines as they appear in the head revision; LEFT covers
 * deleted lines by old-revision numbers. Any line not visible in a diff hunk
 * is rejected with a 422, which is why placement always consults this model.
 */
export interface FileDiffModel {
  path: string;
  status: PrFile["status"];
  hasPatch: boolean;
  /** Head-revision line number → how it appears in the diff. */
  right: Map<number, "add" | "context">;
  /** Old-revision line numbers shown as deletions. */
  left: Set<number>;
  /** Contiguous RIGHT-side ranges, one per hunk (rightEnd < rightStart for pure-deletion hunks). */
  hunks: Array<{ rightStart: number; rightEnd: number }>;
}

export type RepoDiffModel = Map<string, FileDiffModel>;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseFilePatch(file: PrFile): FileDiffModel {
  const model: FileDiffModel = {
    path: file.filename,
    status: file.status,
    hasPatch: typeof file.patch === "string" && file.patch.length > 0,
    right: new Map(),
    left: new Set(),
    hunks: [],
  };
  if (!model.hasPatch) return model;

  let oldLine = 0;
  let newLine = 0;
  let hunkRightStart = 0;
  let inHunk = false;

  const closeHunk = () => {
    if (inHunk) model.hunks.push({ rightStart: hunkRightStart, rightEnd: newLine - 1 });
  };

  for (const raw of file.patch!.split("\n")) {
    const hunkHeader = raw.match(HUNK_RE);
    if (hunkHeader) {
      closeHunk();
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[3]);
      hunkRightStart = newLine;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // preamble before the first hunk (not present in API patches, but harmless)
    switch (raw[0]) {
      case " ":
        model.right.set(newLine, "context");
        oldLine += 1;
        newLine += 1;
        break;
      case "+":
        model.right.set(newLine, "add");
        newLine += 1;
        break;
      case "-":
        model.left.add(oldLine);
        oldLine += 1;
        break;
      case "\\": // "\ No newline at end of file"
        break;
      case undefined: // trailing empty line in the patch string
        break;
      default:
        // Unrecognized line inside a hunk — patches from the API shouldn't
        // produce this; treat it as hunk terminator to stay conservative.
        closeHunk();
        inHunk = false;
        break;
    }
  }
  closeHunk();
  return model;
}

/** Keyed by head-revision path (renames keyed by the NEW name). */
export function buildRepoDiffModel(files: PrFile[]): RepoDiffModel {
  const model: RepoDiffModel = new Map();
  for (const f of files) model.set(f.filename, parseFilePatch(f));
  return model;
}

export function normalizePath(p: string): string {
  let out = p.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  out = out.replace(/\/{2,}/g, "/");
  return out.replace(/^\//, "");
}

/** The single hunk containing the full RIGHT-side range, if any. */
export function hunkContaining(model: FileDiffModel, start: number, end: number) {
  return model.hunks.find((h) => start >= h.rightStart && end <= h.rightEnd);
}
