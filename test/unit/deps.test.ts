import nock from "nock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOctokit } from "../../src/github/client.js";
import { fetchDependencyChanges, renderDependencyBlock } from "../../src/github/deps.js";

const API = "https://api.github.com";
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());

function dep(overrides: Record<string, unknown>) {
  return {
    change_type: "added",
    manifest: "package-lock.json",
    ecosystem: "npm",
    name: "lodash",
    version: "4.17.20",
    license: "MIT",
    scope: "runtime",
    vulnerabilities: [],
    ...overrides,
  };
}

function mockCompare(body: unknown[], status = 200) {
  nock(API)
    .get(`/repos/acme/widgets/dependency-graph/compare/${BASE}...${HEAD}`)
    .query(true)
    .reply(status, body);
}

describe("fetchDependencyChanges", () => {
  it("returns undefined when there are no changes", async () => {
    mockCompare([]);
    expect(await fetchDependencyChanges(makeOctokit("t"), "acme", "widgets", BASE, HEAD)).toBeUndefined();
  });

  it("surfaces a vulnerable addition and sorts it first", async () => {
    mockCompare([
      dep({ name: "safe-pkg", version: "1.0.0" }),
      dep({
        name: "evil-pkg",
        version: "2.0.0",
        vulnerabilities: [
          { severity: "critical", advisory_ghsa_id: "GHSA-xxxx", advisory_summary: "RCE", advisory_url: "https://x" },
        ],
      }),
    ]);
    const result = await fetchDependencyChanges(makeOctokit("t"), "acme", "widgets", BASE, HEAD);
    expect(result?.hasVulnerabilities).toBe(true);
    expect(result?.changes[0]!.name).toBe("evil-pkg"); // vulnerable sorts first
    const block = renderDependencyBlock(result!);
    expect(block).toContain("<dependency_changes>");
    expect(block).toContain("known advisories");
    expect(block).toContain("⚠️ CRITICAL GHSA-xxxx: RCE");
    expect(block).toContain("added evil-pkg 2.0.0");
    expect(block).toContain("untrusted data");
  });

  it("collapses an added+removed pair into an updated line", async () => {
    mockCompare([
      dep({ change_type: "removed", name: "axios", version: "0.21.0" }),
      dep({ change_type: "added", name: "axios", version: "1.6.0" }),
    ]);
    const result = await fetchDependencyChanges(makeOctokit("t"), "acme", "widgets", BASE, HEAD);
    const block = renderDependencyBlock(result!);
    expect(block).toContain("updated axios 0.21.0 → 1.6.0");
    expect(block).not.toContain("added axios");
    expect(block).not.toContain("removed axios");
  });

  it("fails soft on 404 (dependency graph disabled / unsupported manifests)", async () => {
    mockCompare([], 404);
    expect(await fetchDependencyChanges(makeOctokit("t"), "acme", "widgets", BASE, HEAD)).toBeUndefined();
  });

  it("fails soft on 403 (fork head / no GHAS)", async () => {
    mockCompare([], 403);
    expect(await fetchDependencyChanges(makeOctokit("t"), "acme", "widgets", BASE, HEAD)).toBeUndefined();
  });

  it("renders a plain header when no advisories are present", async () => {
    mockCompare([dep({ name: "left-pad", version: "1.3.0" })]);
    const result = await fetchDependencyChanges(makeOctokit("t"), "acme", "widgets", BASE, HEAD);
    const block = renderDependencyBlock(result!);
    expect(block).toContain("added left-pad 1.3.0 (runtime) [package-lock.json] · license: MIT");
    expect(block).not.toContain("known advisories");
  });
});
