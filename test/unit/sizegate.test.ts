import { describe, expect, it } from "vitest";
import { computeGate, isExcludedFromGate, skipCommentBody } from "../../src/github/sizegate.js";
import type { PrFile } from "../../src/shared/types.js";

function file(filename: string, additions = 10, deletions = 5): PrFile {
  return { filename, status: "modified", additions, deletions, changes: additions + deletions };
}

describe("isExcludedFromGate", () => {
  it.each([
    "package-lock.json",
    "frontend/package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "Gemfile.lock",
    "composer.lock",
    "go.sum",
    "gradle.lockfile",
    "flake.lock",
    "vendor/lib/foo.go",
    "pkg/third_party/x.cc",
    "app/node_modules/dep/index.js",
    "assets/app.min.js",
    "styles/app.min.css",
    "assets/app.js.map",
    "dist/bundle.js",
    "build/out.o",
    "src/__generated__/schema.ts",
    "api/client.generated.ts",
    "proto/svc.pb.go",
    "proto/svc_pb2.py",
    "proto/svc_pb2_grpc.py",
    "src/__snapshots__/app.test.ts.snap",
    "test/foo.snap",
  ])("excludes %s", (name) => {
    expect(isExcludedFromGate(name)).toBe(true);
  });

  it.each([
    "src/index.ts",
    "go.mod",
    "src/locks.ts",
    "distance.py", // "dist" must match as a path segment, not a prefix
    "builder/main.go",
    "src/build_info.ts",
    "vendors.ts",
    "Cargo.toml",
  ])("keeps %s", (name) => {
    expect(isExcludedFromGate(name)).toBe(false);
  });
});

describe("computeGate", () => {
  it("sums additions+deletions over included files only", () => {
    const files = [file("src/a.ts", 300, 100), file("package-lock.json", 5000, 4000), file("src/b.ts", 80, 20)];
    const gate = computeGate(files, 500);
    expect(gate.changedLoc).toBe(500);
    expect(gate.filesChanged).toBe(3);
    expect(gate.excluded).toEqual(["package-lock.json"]);
  });

  it.each([
    [499, true],
    [500, false],
    [501, false],
  ])("LOC %i → belowThreshold %s", (loc, below) => {
    const gate = computeGate([file("src/a.ts", loc, 0)], 500);
    expect(gate.belowThreshold).toBe(below);
  });

  it("counts files without a patch field (binary/huge) by their stats", () => {
    const f: PrFile = { filename: "data/big.bin", status: "modified", additions: 600, deletions: 0, changes: 600 };
    expect(computeGate([f], 500).belowThreshold).toBe(false);
  });
});

describe("skipCommentBody", () => {
  it("matches the spec's exact format", () => {
    const body = skipCommentBody({ changedLoc: 142, filesChanged: 7, excluded: [], threshold: 500, belowThreshold: true });
    expect(body).toContain(
      "⏭️ SKIPPED — PR below review threshold\n" +
        "Changed LOC: 142 (threshold: 500) · Files changed: 7\n" +
        "This PR is too small for automated deep review. Route to standard human review.",
    );
    expect(body).toContain("<!-- recensio:skip -->");
  });
});
