import { Octokit } from "@octokit/rest";

// Note: github.com only. GHES support would need `baseUrl` wired here (and the
// GraphQL endpoint becomes `${server}/api/graphql`); the clone path already
// threads serverUrl, the API client does not yet.
export function makeOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    userAgent: "recensio",
    request: { timeout: 30_000 },
  });
}

export type { Octokit };
