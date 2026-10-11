import * as Schema from "effect/Schema";
import semver from "semver";
import type { SourceStore } from "../storage.ts";
import { inParallel, json, pause, plainMessage } from "./lookups.ts";
import { packageName } from "./projects.ts";

export type ReleaseFacts = {
  publishedAt: string | null;
  license: string | null;
  provenance: boolean;
};
export type ReleaseCandidate = { name: string; version: string };

const Verified = Schema.Array(Schema.Struct({ verified: Schema.optional(Schema.Boolean) })).check(
  Schema.isMaxLength(100),
);
// RFC 3339 exactly: uppercase T and Z, a Z or a numeric offset, at most nine fraction digits. A looser
// string is read differently by each parser (a bare "1", "Oct 8 2026") or by this machine's time
// zone (no offset), so it is refused rather than guessed.
const rfc3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/;
/** The instant of an RFC 3339 time that names a real calendar day, else null. */
function publishTime(value: string): number | null {
  const match = rfc3339.exec(value);
  const time = match ? Date.parse(value) : Number.NaN;
  if (!match || Number.isNaN(time)) return null;
  const offset = match[1]
    ? Number(`${match[1]}1`) * (Number(match[2]) * 60 + Number(match[3])) * 60_000
    : 0;
  // February 31 and hour 24 parse as the day after, so the same wall-clock reading must come back.
  return new Date(time + offset).toISOString().slice(0, 19) === value.slice(0, 19) ? time : null;
}
const PublishedAt = Schema.String.check(
  Schema.makeFilter((value: string) => publishTime(value) !== null, {
    expected: "an RFC 3339 time naming a real calendar day",
  }),
);
// deps.dev API v3 GetVersion (checked 2026-10-08): unknown fields are ignored; a missing one is unknown.
const decodeVersion = Schema.decodeUnknownSync(
  Schema.Struct({
    versionKey: Schema.Struct({
      system: Schema.String,
      name: Schema.String,
      version: Schema.String,
    }),
    publishedAt: Schema.optional(PublishedAt),
    licenses: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(20)),
    ),
    slsaProvenances: Schema.optional(Verified),
    attestations: Schema.optional(Verified),
  }),
);
// A cached answer always has its publish time; one without it is damaged and asked again.
const decodeFacts = Schema.decodeUnknownSync(
  Schema.Struct({
    publishedAt: Schema.String,
    license: Schema.NullOr(Schema.String),
    provenance: Schema.Boolean,
  }),
);
const cacheKey = (candidate: ReleaseCandidate) =>
  `deps.dev:npm:${candidate.name}@${candidate.version}`;

/**
 * deps.dev facts for public npm update candidates: publish time, declared licenses, and verified
 * provenance. A released version never changes, so an answer with its publish time is cached for good
 * (the newest 10,000 are kept). A failure, a malformed answer, a version deps.dev does not know yet,
 * and an answer without a publish time (the cooldown needs it, and deps.dev may date a new release
 * later) are not cached and are asked again on a later scan; the last is still used for this scan but
 * is not counted as checked. Only the package name and version are sent.
 */
export async function lookupReleaseFacts(
  candidates: readonly ReleaseCandidate[],
  cache: SourceStore,
  fetcher: typeof fetch | null,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ facts: Map<string, ReleaseFacts>; checked: number; total: number }> {
  const unique = [
    ...new Map(
      candidates
        .filter(
          (candidate) => packageName(candidate.name) && semver.valid(candidate.version) !== null,
        )
        .map((candidate) => [`${candidate.name}@${candidate.version}`, candidate]),
    ).values(),
  ];
  const facts = new Map<string, ReleaseFacts>();
  const missing: ReleaseCandidate[] = [];
  for (const candidate of unique) {
    try {
      const row = cache.readSource(cacheKey(candidate));
      if (row) {
        facts.set(`${candidate.name}@${candidate.version}`, decodeFacts(row.value));
        continue;
      }
    } catch {
      // A corrupt cached answer is asked again.
    }
    missing.push(candidate);
  }
  let completed = 0;
  onProgress?.(0, missing.length);
  if (fetcher && missing.length) {
    const deadline = Date.now() + Math.max(90_000, Math.ceil(missing.length / 4) * 12_000 + 12_000);
    // ponytail: while deps.dev hangs, every unknown release is asked again on each scan, up to
    // ceil(n/4) x 12 s per scan (four at a time, within this budget); stop after repeated failures
    // if scans noticeably stall.
    await inParallel(
      missing,
      async (candidate) => {
        try {
          const body = decodeVersion(
            await json(
              `https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(candidate.name)}/versions/${encodeURIComponent(candidate.version)}`,
              { headers: { Accept: "application/json" } },
              { fetcher, deadline, signal, sleep: pause },
              1024 * 1024,
            ),
          );
          if (
            body.versionKey.system !== "NPM" ||
            body.versionKey.name !== candidate.name ||
            body.versionKey.version !== candidate.version
          )
            throw new Error("deps.dev answered for another package.");
          const published = body.publishedAt === undefined ? null : publishTime(body.publishedAt);
          const license = (body.licenses ?? [])
            .map((value) => plainMessage(value, 100))
            .filter(Boolean)
            .join(", ");
          const value: ReleaseFacts = {
            publishedAt: published === null ? null : new Date(published).toISOString(),
            license: license ? plainMessage(license, 200) : null,
            provenance: [...(body.slsaProvenances ?? []), ...(body.attestations ?? [])].some(
              (item) => item.verified === true,
            ),
          };
          facts.set(`${candidate.name}@${candidate.version}`, value);
          // Used for this scan either way; without its publish time the release is asked again.
          if (value.publishedAt !== null)
            try {
              cache.writeSource(cacheKey(candidate), value, new Date().toISOString());
            } catch {
              // Used for this scan; an unsaved answer is asked again next time.
            }
        } catch {
          // Unknown for this scan: deps.dev may not know the release yet, or be unreachable.
        } finally {
          onProgress?.(++completed, missing.length);
        }
      },
      signal,
    );
    try {
      cache.pruneSources("deps.dev:", 10_000);
    } catch {
      // The bound is restored by a later prune.
    }
  }
  const checked = [...facts.values()].filter((fact) => fact.publishedAt !== null).length;
  return { facts, checked, total: unique.length };
}
