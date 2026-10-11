import * as Schema from "effect/Schema";
import type { SourceStore } from "../storage.ts";
import { json, pause } from "./lookups.ts";

const Product = Schema.Literals(["nodejs", "bun", "electron", "pnpm"]);
/** The endoflife.date products checked; fixed names, never taken from scanned input. */
export type LifecycleProduct = typeof Product.Type;
export const lifecycleLabels: Record<LifecycleProduct, string> = {
  nodejs: "Node.js",
  bun: "Bun",
  electron: "Electron",
  pnpm: "pnpm",
};

/** A runtime line a PC runs or a project declares, with where it was found. */
export type DeclaredRuntime = {
  product: LifecycleProduct;
  /** The endoflife.date release cycle: the major version as written there ("24"). */
  cycle: string;
  /** The version or range as found ("24.13.1", ">=20", "10.14.0"). */
  version: string;
  sources: string[];
};

// A real calendar day: the shape alone would pass 2026-02-31, which Date.UTC rolls into March.
const Day = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      new Date(Date.UTC(+value.slice(0, 4), +value.slice(5, 7) - 1, +value.slice(8)))
        .toISOString()
        .startsWith(value),
    { expected: "a calendar day as YYYY-MM-DD" },
  ),
);
// An ISO time exactly as toISOString writes it: it can be aged, and its first ten characters are
// a real day.
const Instant = Schema.String.check(
  Schema.makeFilter(
    (value: string) => {
      const time = Date.parse(value);
      return !Number.isNaN(time) && new Date(time).toISOString() === value;
    },
    { expected: "an ISO 8601 UTC time" },
  ),
);
const StoredLifecycle = Schema.Struct({
  product: Product,
  fetchedAt: Instant,
  releases: Schema.Array(
    Schema.Struct({
      cycle: Schema.String,
      isEol: Schema.Boolean,
      eolFrom: Schema.NullOr(Day),
      isEoas: Schema.NullOr(Schema.Boolean),
      eoasFrom: Schema.NullOr(Day),
    }),
  ),
});
export type LifecycleData = typeof StoredLifecycle.Type;
const decodeStored = Schema.decodeUnknownSync(StoredLifecycle);
// endoflife.date API v1, schema 1.2.1 (checked against all four products on 2026-10-10): `isEoas`
// and `eoasFrom` are omitted for products without an active-support phase, dates may be null, and
// unknown fields are ignored.
const decodeProduct = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      // The product the page is about; compared with the one asked for, below.
      name: Schema.String,
      releases: Schema.Array(
        Schema.Struct({
          name: Schema.String.check(Schema.isPattern(/^[0-9A-Za-z.]{1,20}$/)),
          isEol: Schema.Boolean,
          eolFrom: Schema.NullOr(Day),
          isEoas: Schema.optional(Schema.Boolean),
          eoasFrom: Schema.optional(Schema.NullOr(Day)),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    }),
  }),
);

const hour = 3_600_000;
const day = 24 * hour;
// Whether `at` is at most `span` before `now`. A time in the future is not, and neither is NaN.
const within = (now: number, at: number, span: number) => now - at >= 0 && now - at < span;

export type LifecycleLoad = { data: Map<LifecycleProduct, LifecycleData>; notes: string[] };

/**
 * Lifecycle data for products: a cached copy younger than 24 hours, else one bounded request. A
 * failed request keeps the last good copy and says how old it is; with no copy there is no data and
 * a note. A product whose request failed is not asked again within an hour.
 */
export async function loadLifecycle(
  products: readonly LifecycleProduct[],
  cache: SourceStore,
  fetcher: typeof fetch | null,
  attempts: Map<LifecycleProduct, number>,
  now: number,
  signal?: AbortSignal,
): Promise<LifecycleLoad> {
  const load: LifecycleLoad = { data: new Map(), notes: [] };
  await Promise.all(
    [...new Set(products)].map(async (product) => {
      const key = `endoflife:${product}`;
      let cached: LifecycleData | null = null;
      try {
        const row = cache.readSource(key);
        const value = row ? decodeStored(row.value) : null;
        cached = value?.product === product ? value : null;
      } catch {
        cached = null; // A corrupt copy is no copy.
      }
      if (cached && within(now, Date.parse(cached.fetchedAt), day)) {
        load.data.set(product, cached);
        return;
      }
      const failedAt = attempts.get(product);
      const waiting = failedAt !== undefined && within(now, failedAt, hour);
      if (fetcher && !waiting) {
        try {
          const response = decodeProduct(
            await json(
              `https://endoflife.date/api/v1/products/${product}/`,
              { headers: { Accept: "application/json" } },
              { fetcher, deadline: Date.now() + 12_000, signal, sleep: pause },
              1024 * 1024,
            ),
          );
          // An answer for another product is as unusable as a malformed one.
          if (response.result.name !== product)
            throw new Error("endoflife.date answered for another product.");
          const fresh: LifecycleData = {
            product,
            fetchedAt: new Date(now).toISOString(),
            releases: response.result.releases.map((release) => ({
              cycle: release.name,
              isEol: release.isEol,
              eolFrom: release.eolFrom,
              isEoas: release.isEoas ?? null,
              eoasFrom: release.eoasFrom ?? null,
            })),
          };
          attempts.delete(product);
          load.data.set(product, fresh);
          try {
            cache.writeSource(key, fresh, fresh.fetchedAt);
          } catch {
            // Used for this scan; an unsaved copy is fetched again next time.
          }
          return;
        } catch {
          // A cancelled request is not an outage; only a failed one makes the product wait.
          if (!signal?.aborted) attempts.set(product, now);
        }
      }
      const label = lifecycleLabels[product];
      if (cached) {
        load.data.set(product, cached);
        load.notes.push(
          `${label} lifecycle data from ${cached.fetchedAt.slice(0, 10)} is used; endoflife.date could not be refreshed.`,
        );
      } else
        load.notes.push(
          `${label} lifecycle data is unavailable: endoflife.date has not been reached yet, so its end-of-life status is unknown.`,
        );
    }),
  );
  return load;
}

export type LifecycleVerdict =
  | {
      kind: "finding";
      severity: "high" | "moderate" | "low";
      effectiveDate: string | null;
      description: string;
    }
  | { kind: "note"; text: string };

/**
 * What endoflife.date says about a runtime line today: past end of life is high, end of life within
 * 90 days moderate, out of (or within 90 days of leaving) active support low, otherwise nothing. A
 * known date decides by today, since a copy can be a day old; without one, the flag decides.
 */
export function lifecycleVerdict(
  runtime: DeclaredRuntime,
  data: LifecycleData,
  now: number,
): LifecycleVerdict | null {
  const label = `${lifecycleLabels[runtime.product]} ${runtime.cycle}`;
  const checkedOn = data.fetchedAt.slice(0, 10);
  const release = data.releases.find((item) => item.cycle === runtime.cycle);
  if (!release)
    return {
      kind: "note",
      text: `${label} is not listed by endoflife.date (checked ${checkedOn}); its lifecycle is unknown.`,
    };
  const today = new Date(now).toISOString().slice(0, 10);
  const daysUntil = (date: string) => Math.round((Date.parse(date) - Date.parse(today)) / day);
  const evidence = `(endoflife.date, checked ${checkedOn}). Source: ${runtime.sources.join(", ")}.`;
  const ended = release.eolFrom !== null ? release.eolFrom <= today : release.isEol;
  if (ended)
    return {
      kind: "finding",
      severity: "high",
      effectiveDate: release.eolFrom,
      description: `${label} ${release.eolFrom ? `reached end of life on ${release.eolFrom}` : "has reached end of life"} ${evidence}`,
    };
  if (release.eolFrom !== null && daysUntil(release.eolFrom) <= 90)
    return {
      kind: "finding",
      severity: "moderate",
      effectiveDate: release.eolFrom,
      description: `${label} reaches end of life on ${release.eolFrom} ${evidence}`,
    };
  const security = release.eolFrom
    ? `security support ends ${release.eolFrom}`
    : "no end-of-life date is announced";
  const activeEnded =
    release.eoasFrom !== null ? release.eoasFrom <= today : release.isEoas === true;
  if (activeEnded)
    return {
      kind: "finding",
      severity: "low",
      effectiveDate: release.eoasFrom,
      description: `${label} ${release.eoasFrom ? `left active support on ${release.eoasFrom}` : "is out of active support"}; ${security} ${evidence}`,
    };
  if (release.eoasFrom !== null && daysUntil(release.eoasFrom) <= 90)
    return {
      kind: "finding",
      severity: "low",
      effectiveDate: release.eoasFrom,
      description: `${label} leaves active support on ${release.eoasFrom}; ${security} ${evidence}`,
    };
  return null;
}
