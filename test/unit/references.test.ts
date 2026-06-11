import { describe, expect, it } from "vitest";
import { astAvailable, classifyInSource, langForFile, loadLanguage } from "../../src/engine/references.js";

describe("langForFile", () => {
  it("maps extensions to grammars and honors overrides", () => {
    expect(langForFile("a.ts")).toBe("typescript");
    expect(langForFile("a.tsx")).toBe("tsx");
    expect(langForFile("a.py")).toBe("python");
    expect(langForFile("a.go")).toBe("go");
    expect(langForFile("a.rs")).toBeUndefined();
    expect(langForFile("a.unknown", "python")).toBe("python");
  });
});

describe("classifyInSource", () => {
  it("classifies declaration / call / import and excludes strings & comments", async () => {
    expect(await astAvailable()).toBe(true);
    const ts = await loadLanguage("typescript");
    expect(ts).not.toBeNull();

    const source = [
      `import { handleUser } from "./handlers";`, // import
      `function handleUser(x: number) { return x; }`, // declaration
      `const r = handleUser(5);`, // call
      `const s = "handleUser is not called here";`, // string — excluded
      `// handleUser in a comment — excluded`, // comment — excluded
      `const alias = handleUser;`, // reference
    ].join("\n");

    const refs = classifyInSource(ts!, source, "handleUser", "src/x.ts");
    const kindsByLine = new Map(refs.map((r) => [r.line, r.kind]));
    expect(kindsByLine.get(1)).toBe("import");
    expect(kindsByLine.get(2)).toBe("declaration");
    expect(kindsByLine.get(3)).toBe("call");
    expect(kindsByLine.get(6)).toBe("reference");
    // string (line 4) and comment (line 5) must NOT appear
    expect(kindsByLine.has(4)).toBe(false);
    expect(kindsByLine.has(5)).toBe(false);
  });

  it("classifies python calls and definitions", async () => {
    const py = await loadLanguage("python");
    expect(py).not.toBeNull();
    const source = ["def compute(n):", "    return n + 1", "", "x = compute(3)", "# compute in comment"].join("\n");
    const refs = classifyInSource(py!, source, "compute", "x.py");
    const byLine = new Map(refs.map((r) => [r.line, r.kind]));
    expect(byLine.get(1)).toBe("declaration");
    expect(byLine.get(4)).toBe("call");
    expect(byLine.has(5)).toBe(false); // comment excluded
  });
});
