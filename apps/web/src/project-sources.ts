import type { ProviderKind, Repository } from "@versionstead/contracts/application";

export function repositoryLocation(input: string): { kind: ProviderKind; name: string } | null {
  const text = input.trim();
  const ssh = /^git@(github\.com|gitlab\.com):(.+)$/.exec(text);
  let host: string;
  let path: string;
  if (ssh) {
    host = ssh[1]!;
    path = ssh[2]!;
  } else {
    try {
      const url = new URL(text);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash
      )
        return null;
      host = url.hostname;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  const kind = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : null;
  const name = path.replace(/\/$/, "").replace(/\.git$/, "");
  if (
    !kind ||
    !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(name) ||
    name.split("/").some((part) => part === "." || part === "..") ||
    (kind === "github" && name.split("/").length !== 2)
  )
    return null;
  return { kind, name };
}

export function repositoryMatches(repository: Repository, query: string) {
  return repository.name
    .toLowerCase()
    .includes((repositoryLocation(query)?.name ?? query.trim()).toLowerCase());
}
