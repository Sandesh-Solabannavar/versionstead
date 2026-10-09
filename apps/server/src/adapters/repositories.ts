import type { ProviderKind, Repository } from "@versionstead/contracts/application";
import { decodeRepositoryList } from "@versionstead/contracts/application";
import type { Project } from "@versionstead/contracts/monitoring";
import { InputError, inspectProjectFiles, object, string } from "./projects.ts";
import { readSource } from "./source-http.ts";

const hosts = { github: "https://api.github.com", gitlab: "https://gitlab.com/api/v4" } as const;
const repositoryName = (name: string, kind: ProviderKind) =>
  /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(name) &&
  name.split("/").every((part) => part !== "." && part !== "..") &&
  (kind !== "github" || name.split("/").length === 2);
export function providerHeaders(kind: ProviderKind, token: string) {
  return kind === "github"
    ? {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-GitHub-Api-Version": "2026-03-10",
      }
    : { "PRIVATE-TOKEN": token };
}

async function json(
  kind: ProviderKind,
  token: string,
  path: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  missing = false,
) {
  const text = await readSource(hosts[kind] + path, {
    headers: providerHeaders(kind, token),
    fetcher,
    ...(signal ? { signal } : {}),
    missing,
  });
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError("The provider returned malformed metadata.");
  }
}

export async function providerAccount(
  kind: ProviderKind,
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const value = object(await json(kind, token, "/user", fetcher, signal));
  const account = string(kind === "github" ? value.login : value.username);
  if (
    !account ||
    account.length > 200 ||
    Array.from(account).some((char) => char.charCodeAt(0) < 32)
  )
    throw new InputError("The provider returned an invalid account identity.");
  return account;
}

export async function listRepositories(
  kind: ProviderKind,
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const repositories: Repository[] = [];
  const discoverySignal = AbortSignal.any([
    AbortSignal.timeout(25000),
    ...(signal ? [signal] : []),
  ]);
  for (let page = 1; ; page++) {
    const path =
      kind === "github"
        ? `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
        : `/projects?membership=true&per_page=100&page=${page}&order_by=last_activity_at`;
    discoverySignal.throwIfAborted();
    const value = await json(kind, token, path, fetcher, discoverySignal);
    if (!Array.isArray(value))
      throw new InputError("The provider returned an invalid repository list.");
    for (const raw of value) {
      const row = object(raw);
      const id = String(row.id ?? "");
      const name = string(kind === "github" ? row.full_name : row.path_with_namespace);
      const branch = string(row.default_branch);
      if (!/^\d+$/.test(id) || !name || !repositoryName(name, kind))
        throw new InputError("The provider returned an invalid repository identity.");
      if (!branch) continue; // Empty repositories have no commit to scan.
      repositories.push({
        id,
        name,
        defaultBranch: branch,
        url: `https://${kind === "github" ? "github.com" : "gitlab.com"}/${name}`,
        private: kind === "github" ? row.private === true : row.visibility !== "public",
      });
    }
    if (value.length < 100) return decodeRepositoryList(repositories);
    // ponytail: repository discovery is bounded at 10,000 entries; add paged server-side search if an owner exceeds it.
    if (page >= 100)
      throw new InputError(
        "Repository discovery exceeds 10,000 entries; narrow provider access before connecting.",
      );
  }
}

export async function inspectRepository(
  project: Project,
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const source = project.repository;
  if (
    !source ||
    !repositoryName(source.name, source.provider) ||
    !/^\d+$/.test(source.repositoryId) ||
    !source.ref ||
    source.ref.length > 200 ||
    Array.from(source.ref).some((char) => char.charCodeAt(0) < 32)
  )
    throw new InputError("Invalid selected repository identity.");
  const base =
    source.provider === "github"
      ? `/repos/${source.name}`
      : `/projects/${encodeURIComponent(source.repositoryId)}`;
  const resolved = object(
    await json(
      source.provider,
      token,
      `${base}/${source.provider === "github" ? "commits" : "repository/commits"}/${encodeURIComponent(source.ref)}`,
      fetcher,
      signal,
    ),
  );
  const commit = string(source.provider === "github" ? resolved.sha : resolved.id);
  if (!commit || !/^[a-f0-9]{40,64}$/.test(commit))
    throw new InputError("The provider returned an invalid commit identity.");
  const inputs = await inspectProjectFiles(async (name, limit = 10 * 1024 * 1024) => {
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.split("/").some((p) => p === ".." || p === "" || p === ".") ||
      !(
        /(^|\/)package\.json$/.test(name) ||
        ["package-lock.json", "pnpm-lock.yaml", "bun.lock", "bunfig.toml", ".npmrc"].includes(name)
      )
    )
      throw new InputError("A repository input path is unsupported.");
    if (source.provider === "github") {
      return readSource(
        hosts.github +
          `${base}/contents/${name.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`,
        {
          headers: {
            ...providerHeaders("github", token),
            Accept: "application/vnd.github.raw+json",
          },
          fetcher,
          ...(signal ? { signal } : {}),
          limit,
          missing: true,
        },
      );
    }
    const raw = await json(
      "gitlab",
      token,
      `${base}/repository/files/${encodeURIComponent(name)}?ref=${commit}`,
      fetcher,
      signal,
      true,
    );
    if (raw === null) return null;
    const data = object(raw);
    if (
      data.encoding !== "base64" ||
      typeof data.content !== "string" ||
      data.content.length > Math.ceil(limit / 3) * 4 + 100
    )
      throw new InputError("A repository file exceeds its supported size or encoding.");
    const bytes = Buffer.from(data.content, "base64");
    if (
      bytes.length > limit ||
      data.file_path !== name ||
      (data.commit_id !== undefined && data.commit_id !== commit)
    )
      throw new InputError("A repository file has incomplete or mismatched commit evidence.");
    return bytes.toString("utf8");
  }, signal);
  inputs.repositoryCommit = commit;
  inputs.coverage.unshift(
    `${source.provider === "github" ? "GitHub" : "GitLab"} read-only repository files at commit ${commit}`,
  );
  return inputs;
}
