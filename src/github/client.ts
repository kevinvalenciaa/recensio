import { Octokit } from "@octokit/rest";

export function makeOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    userAgent: "recensio",
    request: { timeout: 30_000 },
  });
}

export type { Octokit };
