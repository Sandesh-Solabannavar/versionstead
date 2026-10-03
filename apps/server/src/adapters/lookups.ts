import semver from "semver";
import type { Dependency, Project } from "@versionstead/contracts/monitoring";
import type { NativeVersions } from "./outdated.ts";
import { InputError, object, packageName, requestedRange, string } from "./projects.ts";

export type Advisory = {
  id: string;
  summary: string;
  severity: "info" | "low" | "moderate" | "high" | "critical" | "unknown";
  url: string;
  fixed: string | null;
  detailsUnavailable?: boolean;
};
export type LookupResult = {
  dependencies: Dependency[];
  advisories: Map<string, Advisory[]>;
  coverage: string[];
  errors: string[];
  versionChecked?: Set<string>;
};
export type DependencyLookup = (
  dependencies: readonly Dependency[],
  signal?: AbortSignal,
  onProgress?: (progress: LookupProgress) => void,
  localProject?: { root: string; packageManager: Project["packageManager"] },
) => Promise<LookupResult>;
export type LookupProgress = {
  stage: "advisories" | "advisory-details" | "native-versions" | "versions";
  completed: number;
  total: number;
};
type CheckedDependency = {
  -readonly [K in keyof Dependency]: K extends "advisoryIds" ? string[] : Dependency[K];
};

async function inParallel<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  signal?: AbortSignal,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        if (signal?.aborted) return;
        await run(items[next++]!);
      }
    }),
  );
}

async function json(
  url: string,
  options: RequestInit,
  fetcher: typeof fetch,
  deadline: number,
  signal?: AbortSignal,
  limit = 4 * 1024 * 1024,
): Promise<unknown> {
  if (signal?.aborted)
    throw new InputError("The scan stopped before public package checks finished.");
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new InputError("Public package checks exceeded their scan time budget.");
  const response = await fetcher(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(Math.min(12000, remaining)),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new InputError("A public package source is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new InputError("A package source exceeded its response limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}

function eligible(dependency: Dependency) {
  return (
    dependency.origin === "registry" &&
    packageName(dependency.packageName) &&
    dependency.resolved &&
    semver.valid(dependency.resolved)
  );
}

export async function publicPackageVersions(
  name: string,
  fetcher: typeof fetch = fetch,
  deadline = Date.now() + 90000,
  signal?: AbortSignal,
) {
  if (!packageName(name)) throw new InputError("A public package identity is invalid.");
  const metadata = object(
    await json(
      `https://registry.npmjs.org/${encodeURIComponent(name)}`,
      { headers: { Accept: "application/vnd.npm.install-v1+json" } },
      fetcher,
      deadline,
      signal,
      16 * 1024 * 1024,
    ),
  );
  if (metadata.name !== name) throw new InputError("The package source returned another identity.");
  const versions = Object.keys(object(metadata.versions));
  const latest = string(object(metadata["dist-tags"]).latest);
  if (!latest || !semver.valid(latest) || versions.length > 50000)
    throw new InputError("The package source returned invalid versions.");
  return { versions, latest };
}

export async function lookupDependencies(
  dependencies: readonly Dependency[],
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  onProgress?: (progress: LookupProgress) => void,
  nativeCheck?: () => Promise<NativeVersions>,
): Promise<LookupResult> {
  const result: Omit<LookupResult, "dependencies"> & { dependencies: CheckedDependency[] } = {
    dependencies: dependencies.map((d) => ({
      ...d,
      advisoryIds: [...d.advisoryIds],
      versionStatus: eligible(d) && d.role !== "transitive" ? "not-checked" : "unsupported",
    })),
    advisories: new Map(),
    coverage: [],
    errors: [],
    versionChecked: new Set(),
  };
  const candidates = result.dependencies.filter(eligible);
  const unique = [
    ...new Map(candidates.map((dep) => [`${dep.packageName}@${dep.resolved}`, dep])).values(),
  ];
  const advisoryIds = new Set<string>();
  const advisoryDeadline =
    Date.now() + Math.max(90000, Math.ceil(unique.length / 100) * 12000 + 12000);
  onProgress?.({ stage: "advisories", completed: 0, total: unique.length });
  for (let offset = 0; offset < unique.length; offset += 100) {
    if (signal?.aborted) break;
    const batch = unique.slice(offset, offset + 100);
    try {
      const response = object(
        await json(
          "https://api.osv.dev/v1/querybatch",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              queries: batch.map((d) => ({
                package: { name: d.packageName, ecosystem: "npm" },
                version: d.resolved,
              })),
            }),
          },
          fetcher,
          advisoryDeadline,
          signal,
        ),
      );
      if (!Array.isArray(response.results) || response.results.length !== batch.length)
        throw new Error();
      for (let i = 0; i < batch.length; i++) {
        const row = object(response.results[i]);
        if (row.next_page_token !== undefined)
          throw new InputError("OSV returned paginated results; coverage is incomplete.");
        if (row.vulns !== undefined && !Array.isArray(row.vulns)) throw new Error();
        const ids = ((row.vulns ?? []) as unknown[]).map((v) => {
          const id = string(object(v).id);
          if (!id || !/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw new Error();
          advisoryIds.add(id);
          return id;
        });
        const candidate = batch[i]!;
        for (const dep of candidates.filter(
          (d) => d.packageName === candidate.packageName && d.resolved === candidate.resolved,
        )) {
          dep.advisoryStatus = "checked";
          dep.advisoryIds = ids;
        }
      }
    } catch {
      result.errors.push(
        "Known-advisory lookup failed or returned incomplete data; this is not a clean result.",
      );
      for (const candidate of batch) {
        for (const dep of candidates.filter(
          (d) => d.packageName === candidate.packageName && d.resolved === candidate.resolved,
        )) {
          dep.advisoryStatus = "failed";
        }
      }
    } finally {
      onProgress?.({
        stage: "advisories",
        completed: offset + batch.length,
        total: unique.length,
      });
    }
  }
  if (candidates.length)
    result.coverage.push(
      `OSV npm version queries: ${candidates.filter((d) => d.advisoryStatus === "checked").length}/${candidates.length} resolved dependency records`,
    );
  const details = new Map<string, Record<string, unknown>>();
  const detailIds = [...advisoryIds];
  const detailDeadline =
    Date.now() + Math.max(90000, Math.ceil(detailIds.length / 4) * 12000 + 12000);
  let detailCount = 0;
  onProgress?.({ stage: "advisory-details", completed: 0, total: detailIds.length });
  await inParallel(
    detailIds,
    async (id) => {
      try {
        details.set(
          id,
          object(
            await json(
              `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`,
              {},
              fetcher,
              detailDeadline,
              signal,
            ),
          ),
        );
      } catch {
        result.errors.push(
          "Some advisory details are unavailable; affected IDs are retained with unknown severity.",
        );
      } finally {
        onProgress?.({
          stage: "advisory-details",
          completed: ++detailCount,
          total: detailIds.length,
        });
      }
    },
    signal,
  );
  for (const dep of candidates) {
    const advisories = dep.advisoryIds.map((id): Advisory => {
      const data = details.get(id);
      let fixed: string | null = null;
      let severity: Advisory["severity"] = "unknown";
      const severityValue = data
        ? string(object(data.database_specific ?? {}).severity)?.toLowerCase()
        : null;
      if (severityValue && ["low", "moderate", "high", "critical"].includes(severityValue))
        severity = severityValue as Advisory["severity"];
      if (data && Array.isArray(data.affected)) {
        const fixes: string[] = [];
        for (const raw of data.affected) {
          const affected = object(raw);
          const pkg = object(affected.package ?? {});
          if (
            pkg.ecosystem !== "npm" ||
            pkg.name !== dep.packageName ||
            !Array.isArray(affected.ranges)
          )
            continue;
          for (const rawRange of affected.ranges) {
            const range = object(rawRange);
            if (range.type !== "SEMVER" || !Array.isArray(range.events)) continue;
            for (const rawEvent of range.events) {
              const candidate = string(object(rawEvent).fixed);
              if (candidate && semver.valid(candidate) && semver.gt(candidate, dep.resolved!))
                fixes.push(candidate);
            }
          }
        }
        // These are provider-listed fixed boundaries, not a claim that installing one resolves every advisory.
        fixed = fixes.sort(semver.compare)[0] ?? null;
      }
      return {
        id,
        summary: string(data?.summary) ?? `Known advisory ${id}`,
        severity,
        url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
        fixed,
        detailsUnavailable: !data,
      };
    });
    result.advisories.set(dep.id, advisories);
  }
  if (nativeCheck) {
    const native = await nativeCheck();
    result.coverage.push(...native.coverage);
    for (const dep of candidates.filter((candidate) => candidate.role !== "transitive")) {
      const versions = native.checked.get(dep.id);
      if (!versions) continue;
      dep.availableVersion =
        versions.compatible && semver.gt(versions.compatible, dep.resolved!)
          ? versions.compatible
          : null;
      dep.latestVersion = semver.gt(versions.latest, dep.resolved!) ? versions.latest : null;
      dep.versionSource = versions.source;
      dep.versionStatus = "checked";
      result.versionChecked!.add(dep.id);
    }
  }
  const versionCandidates = candidates.filter(
    (dep) => dep.role !== "transitive" && !result.versionChecked!.has(dep.id),
  );
  const directNames = [...new Set(versionCandidates.map((dep) => dep.packageName))];
  const versionDeadline =
    Date.now() + Math.max(90000, Math.ceil(directNames.length / 4) * 12000 + 12000);
  let versionCount = 0;
  let checkedVersions = 0;
  onProgress?.({ stage: "versions", completed: 0, total: directNames.length });
  await inParallel(
    directNames,
    async (name) => {
      try {
        const { versions, latest } = await publicPackageVersions(
          name,
          fetcher,
          versionDeadline,
          signal,
        );
        for (const dep of versionCandidates.filter((d) => d.packageName === name)) {
          const range = requestedRange(dep);
          const compatible =
            range && semver.validRange(range) ? semver.maxSatisfying(versions, range) : null;
          dep.availableVersion =
            compatible && semver.gt(compatible, dep.resolved!) ? compatible : null;
          dep.latestVersion = semver.gt(latest, dep.resolved!) ? latest : null;
          dep.versionStatus = "checked";
          dep.versionSource = "npm registry";
          result.versionChecked!.add(dep.id);
        }
        checkedVersions++;
      } catch {
        for (const dep of versionCandidates.filter((d) => d.packageName === name))
          dep.versionStatus = "failed";
        result.errors.push(
          "Public-registry version lookup failed; unavailable update evidence remains unknown.",
        );
      } finally {
        onProgress?.({ stage: "versions", completed: ++versionCount, total: directNames.length });
      }
    },
    signal,
  );
  if (directNames.length)
    result.coverage.push(
      `Public npm registry version checks: ${checkedVersions}/${directNames.length} unique direct package names, SemVer requested ranges and latest dist-tag`,
    );
  result.errors = [...new Set(result.errors)];
  if (signal?.aborted)
    throw new InputError("The scan stopped before public package checks finished.");
  return result;
}
