import { setTimeout as delay } from "node:timers/promises";
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
type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
// What a later check reads from each published version. Whole abbreviated manifests (about 1 KiB
// each) would put several hundred MiB behind 2,000 cached names.
type VersionDetails = Readonly<{ deprecated?: string; hasInstallScript?: true }>;
type PackageEntry = {
  latest: string;
  versions: Readonly<Record<string, VersionDetails>>;
  etag: string | null;
  // When the registry last confirmed this metadata: a 200, or a 304 to our If-None-Match.
  checkedAt: number;
};
// The request settings that one lookup stage shares: its fetcher, budget, cancellation and pacing.
type Stage = {
  fetcher: typeof fetch;
  deadline: number;
  signal: AbortSignal | undefined;
  sleep: Sleep;
};

// ponytail: bounded by entry count, not bytes. A package's record averaged about 16 KiB over 500
// real registry documents (at most 50,000 versions); weigh entries by version count if that matters.
const cacheLimit = 2000;
const freshFor = 30 * 60 * 1000;
const stopped = () => new InputError("The scan stopped before public package checks finished.");
const unavailable = () => new InputError("A public package source is unavailable.");
// RFC 9110 entity-tag characters only, so a validator is safe to send back as a header.
const entityTag = /^(?:W\/)?"[\x21\x23-\x7e]{0,128}"$/;

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

// A bounded least-recently-used map. Concurrent loads of one key share a single request, and a
// value that is no longer fresh goes to the loader so it can revalidate instead of refetching.
// A failed load stores nothing: the stale value is kept only to revalidate, never to be served.
function sharedLoads<V>(fresh: (value: V) => boolean) {
  const values = new Map<string, V>();
  const loads = new Map<string, Promise<V>>();
  return (key: string, load: (stale: V | undefined) => Promise<V>): Promise<V> => {
    const known = values.get(key);
    if (known !== undefined && fresh(known)) {
      values.delete(key);
      values.set(key, known);
      return Promise.resolve(known);
    }
    const running = loads.get(key);
    if (running) return running;
    const started = load(known)
      .then((value) => {
        values.delete(key);
        values.set(key, value);
        if (values.size > cacheLimit) values.delete(values.keys().next().value!);
        return value;
      })
      .finally(() => loads.delete(key));
    loads.set(key, started);
    return started;
  };
}

const pause: Sleep = async (milliseconds, signal) => {
  try {
    await delay(milliseconds, undefined, signal ? { signal } : {});
  } catch {
    throw stopped();
  }
};

// What public lookups remember between scans. One instance belongs to one coordinator, so its
// projects and This PC share requests; `sleep` is replaceable so that tests need not wait.
export function createSourceCache(sleep: Sleep = pause) {
  return {
    packages: sharedLoads<PackageEntry>((entry) => {
      const age = Date.now() - entry.checkedAt;
      return age >= 0 && age < freshFor;
    }),
    // Keyed by advisory id and the `modified` time that querybatch reported, so it never goes stale.
    advisories: sharedLoads<Record<string, unknown>>(() => true),
    sleep,
  };
}
export type SourceCache = ReturnType<typeof createSourceCache>;

// How long to pause before the one retry: the Retry-After the source asked for (seconds or an HTTP
// date) or 500 ms, plus up to 500 ms of jitter so requests that failed together do not retry together.
function retryDelay(header: string | null | undefined) {
  const value = header?.trim() ?? "";
  const asked = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return (Number.isNaN(asked) ? 500 : Math.max(0, asked)) + Math.random() * 500;
}

// Sends a request, retrying it once after a pause when the source answers 429 or 503 or the
// connection fails, unless the scan was cancelled, the request timed out (it already used its
// 12 seconds), or the pause would end past the stage deadline. Any other response, including a
// failing status the caller turns into an error, is returned as it is.
async function exchange(url: string, options: RequestInit, stage: Stage): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    if (stage.signal?.aborted) throw stopped();
    const remaining = stage.deadline - Date.now();
    if (remaining <= 0)
      throw new InputError("Public package checks exceeded their scan time budget.");
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await stage.fetcher(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(Math.min(12000, remaining)),
          ...(stage.signal ? [stage.signal] : []),
        ]),
      });
    } catch (error) {
      failure = error;
    }
    const transient = response
      ? response.status === 429 || response.status === 503
      : !stage.signal?.aborted &&
        (failure as { name?: unknown } | null | undefined)?.name !== "TimeoutError";
    const wait =
      transient && attempt === 0 ? retryDelay(response?.headers.get("retry-after")) : Infinity;
    if (wait >= stage.deadline - Date.now()) {
      if (response) return response;
      throw failure;
    }
    await response?.body?.cancel();
    await stage.sleep(wait, stage.signal);
  }
}

async function read(response: Response, limit: number): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw unavailable();
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

const json = async (url: string, options: RequestInit, stage: Stage, limit = 4 * 1024 * 1024) =>
  read(await exchange(url, options, stage), limit);

function eligible(dependency: Dependency) {
  return (
    dependency.origin === "registry" &&
    packageName(dependency.packageName) &&
    dependency.resolved &&
    semver.valid(dependency.resolved)
  );
}

function versionDetails(manifest: unknown): VersionDetails {
  const fields =
    manifest !== null && typeof manifest === "object" ? (manifest as Record<string, unknown>) : {};
  const deprecated = string(fields.deprecated);
  return {
    ...(deprecated ? { deprecated } : {}),
    ...(fields.hasInstallScript === true ? { hasInstallScript: true as const } : {}),
  };
}

export async function publicPackageVersions(
  name: string,
  fetcher: typeof fetch = fetch,
  deadline = Date.now() + 90000,
  signal?: AbortSignal,
  cache: SourceCache = createSourceCache(),
) {
  if (!packageName(name)) throw new InputError("A public package identity is invalid.");
  // ponytail: a shared request runs under its first requester's signal and deadline, which is
  // enough while scans run one at a time; give each waiter its own cancellation if they overlap.
  const entry = await cache.packages(name, async (stale) => {
    const response = await exchange(
      `https://registry.npmjs.org/${encodeURIComponent(name)}`,
      {
        headers: {
          Accept: "application/vnd.npm.install-v1+json",
          ...(stale?.etag ? { "If-None-Match": stale.etag } : {}),
        },
      },
      { fetcher, deadline, signal, sleep: cache.sleep },
    );
    if (response.status === 304 && stale?.etag) {
      // The registry confirmed the stored metadata, which was validated when it was fetched.
      await response.body?.cancel();
      return { ...stale, checkedAt: Date.now() };
    }
    const metadata = object(await read(response, 16 * 1024 * 1024));
    if (metadata.name !== name)
      throw new InputError("The package source returned another identity.");
    const published = object(metadata.versions);
    const latest = string(object(metadata["dist-tags"]).latest);
    if (!latest || !semver.valid(latest) || Object.keys(published).length > 50000)
      throw new InputError("The package source returned invalid versions.");
    const etag = response.headers.get("etag");
    return {
      latest,
      versions: Object.fromEntries(
        Object.entries(published).map(([version, manifest]) => [version, versionDetails(manifest)]),
      ),
      etag: etag && entityTag.test(etag) ? etag : null,
      checkedAt: Date.now(),
    };
  });
  return {
    versions: Object.keys(entry.versions),
    latest: entry.latest,
    checkedAt: entry.checkedAt,
    details: entry.versions,
  };
}

export async function lookupDependencies(
  dependencies: readonly Dependency[],
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  onProgress?: (progress: LookupProgress) => void,
  nativeCheck?: () => Promise<NativeVersions>,
  cache: SourceCache = createSourceCache(),
): Promise<LookupResult> {
  const stage = (deadline: number): Stage => ({ fetcher, deadline, signal, sleep: cache.sleep });
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
  // Each advisory id with the `modified` time that querybatch reported for it.
  const advisoryIds = new Map<string, string | null>();
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
          stage(advisoryDeadline),
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
          const vuln = object(v);
          const id = string(vuln.id);
          if (!id || !/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw new Error();
          if (!advisoryIds.has(id)) advisoryIds.set(id, string(vuln.modified));
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
    async ([id, modified]) => {
      try {
        const load = async () =>
          object(
            await json(
              `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`,
              {},
              stage(detailDeadline),
            ),
          );
        // OSV changes `modified` whenever it changes a record, so an id and its modified time
        // name one immutable version. Without a modified time the record is fetched every time.
        details.set(id, await (modified ? cache.advisories(`${id} ${modified}`, load) : load()));
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
          cache,
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
