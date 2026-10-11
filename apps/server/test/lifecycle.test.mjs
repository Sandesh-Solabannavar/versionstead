import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { decodeRemoteEvidence } from "@versionstead/contracts/application";
import { decodeMonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import { MonitoringStorage } from "../dist/storage.js";
import { lifecycleVerdict, loadLifecycle } from "../dist/adapters/lifecycle.js";
import { selectDirectory } from "../dist/adapters/projects.js";

// Windows cannot delete a SQLite database that is still open. The directories are removed once,
// after every test has run its own `t.after` hooks and closed its coordinators and storage.
const directories = [];
after(() =>
  Promise.all(
    directories.map((path) =>
      rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  ),
);
async function temporary() {
  const path = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-lifecycle-")));
  directories.push(path);
  return path;
}

test("lifecycle findings with an effective date survive storage, and the coordinator reports v10", async (t) => {
  const dataDir = join(await temporary(), "state");
  let coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  const device = coordinator.snapshot().device;
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  try {
    const stored = storage.read();
    stored.snapshot.findings.push({
      id: "lifecycle-fixture",
      kind: "lifecycle",
      subjectId: device.id,
      subjectLabel: device.label,
      name: "Node.js 20",
      packageName: null,
      installedVersion: "20.11.1",
      availableVersion: null,
      severity: "high",
      source: "endoflife.date",
      description:
        "Node.js 20 reached end of life on 2026-04-30 (endoflife.date, checked 2026-10-08).",
      advisoryUrl: null,
      detectedAt: "2026-10-08T00:00:00.000Z",
      lastSeenAt: "2026-10-08T00:00:00.000Z",
      effectiveDate: "2026-04-30",
    });
    storage.write(stored);
  } finally {
    storage.close();
  }
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  t.after(() => coordinator.close());
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.features, "settings-repositories-connections-v10");
  const finding = snapshot.findings.find((item) => item.id === "lifecycle-fixture");
  assert.equal(finding.kind, "lifecycle");
  assert.equal(finding.effectiveDate, "2026-04-30");
  assert.deepEqual(JSON.parse(coordinator.snapshotJson()).findings, snapshot.findings);
});

// A second connection to the database file, closed even when the callback or its caller throws.
function withDatabase(dataDir, run) {
  const database = new DatabaseSync(join(dataDir, "monitoring.sqlite"));
  try {
    return run(database);
  } finally {
    database.close();
  }
}

test("the public-source store is created on first use in an existing database without touching monitoring state", async () => {
  const dataDir = join(await temporary(), "state");
  const coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  try {
    coordinator.changeSettings({ paused: true, projectIntervalMinutes: 30 });
  } finally {
    await coordinator.close();
  }
  assert.equal(
    withDatabase(dataDir, (database) =>
      database.prepare("SELECT name FROM sqlite_master WHERE name='source_cache'").get(),
    ),
    undefined,
    "A database written before this change has no cache table",
  );
  const storage = new MonitoringStorage(dataDir);
  try {
    const before = storage.read();
    assert.equal(storage.readSource("endoflife:nodejs"), null);
    storage.writeSource("endoflife:nodejs", { releases: [] }, "2026-10-08T00:00:00.000Z");
    assert.deepEqual(storage.readSource("endoflife:nodejs"), {
      value: { releases: [] },
      fetchedAt: "2026-10-08T00:00:00.000Z",
    });
    storage.writeSource("endoflife:nodejs", { releases: ["24"] }, "2026-10-09T00:00:00.000Z");
    assert.deepEqual(
      storage.readSource("endoflife:nodejs"),
      { value: { releases: ["24"] }, fetchedAt: "2026-10-09T00:00:00.000Z" },
      "A newer fetch replaces the older copy of the same source",
    );
    for (let index = 0; index < 5; index++)
      storage.writeSource(
        `deps.dev:npm:fixture@1.0.${index}`,
        { index },
        `2026-10-0${index + 1}T00:00:00.000Z`,
      );
    storage.pruneSources("deps.dev:", 2);
    assert.deepEqual(
      [0, 1, 2, 3, 4].map(
        (index) => storage.readSource(`deps.dev:npm:fixture@1.0.${index}`)?.value.index ?? null,
      ),
      [null, null, null, 3, 4],
      "Only the newest entries of one source are kept",
    );
    assert.notEqual(
      storage.readSource("endoflife:nodejs"),
      null,
      "Pruning one source keeps the others",
    );
    withDatabase(dataDir, (database) => {
      database
        .prepare("UPDATE source_cache SET value='{broken' WHERE key='endoflife:nodejs'")
        .run();
      database
        .prepare("UPDATE source_cache SET fetched_at='yesterday' WHERE key=?")
        .run("deps.dev:npm:fixture@1.0.4");
    });
    assert.equal(storage.readSource("endoflife:nodejs"), null, "A corrupt copy reads as no copy");
    assert.equal(
      storage.readSource("deps.dev:npm:fixture@1.0.4"),
      null,
      "A copy whose fetch time cannot be read is no copy either, so it never reads as fresh",
    );
    assert.notEqual(
      storage.readSource("deps.dev:npm:fixture@1.0.3"),
      null,
      "A corrupt neighbour leaves the other copies readable",
    );
    assert.deepEqual(storage.read(), before, "Monitoring state is untouched by the cache");
  } finally {
    storage.close();
  }
});

const day = 86_400_000;
const fixedNow = Date.parse("2026-10-08T12:00:00.000Z");
function memoryCache() {
  const rows = new Map();
  return {
    rows,
    readSource: (key) => rows.get(key) ?? null,
    writeSource: (key, value, fetchedAt) =>
      rows.set(key, { value: structuredClone(value), fetchedAt }),
    pruneSources: () => {},
  };
}
// The shape endoflife.date API v1 (schema 1.2.1) returned on 2026-10-08, trimmed, extras included.
const nodejs = {
  schema_version: "1.2.1",
  generated_at: "2026-10-08T09:06:43+00:00",
  last_modified: "2026-10-08T00:10:03+00:00",
  result: {
    name: "nodejs",
    label: "Node.js",
    releases: [
      {
        name: "24",
        codename: null,
        label: "24 (LTS)",
        releaseDate: "2025-05-06",
        isLts: true,
        ltsFrom: "2025-10-28",
        isEoas: false,
        eoasFrom: "2026-10-20",
        isEol: false,
        eolFrom: "2028-04-30",
        isEoes: null,
        eoesFrom: null,
        isMaintained: true,
        latest: { name: "24.21.0", date: "2026-09-08", link: "https://nodejs.org/" },
        custom: null,
      },
      { name: "20", isEoas: true, eoasFrom: "2024-10-22", isEol: true, eolFrom: "2026-04-30" },
    ],
  },
};
const electron = {
  result: {
    name: "electron",
    releases: [
      { name: "44", isEol: false, eolFrom: "2027-03-02", isMaintained: true, latest: null },
      { name: "42", isEol: false, eolFrom: "2026-10-20", isMaintained: true, latest: null },
    ],
  },
};
// Not retried by the lookups' one-retry rule, which a thrown error, a 429 or a 503 would trigger.
const down = async () => new Response("down", { status: 500 });

test("endoflife.date data is fetched once per product per day and cached with its fetch time", async () => {
  const cache = memoryCache();
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    return Response.json(url.endsWith("/nodejs/") ? nodejs : electron);
  };
  const attempts = new Map();
  const first = await loadLifecycle(
    ["nodejs", "electron", "nodejs"],
    cache,
    fetcher,
    attempts,
    fixedNow,
  );
  assert.deepEqual(calls.sort(), [
    "https://endoflife.date/api/v1/products/electron/",
    "https://endoflife.date/api/v1/products/nodejs/",
  ]);
  assert.deepEqual(first.notes, []);
  assert.equal(first.data.get("nodejs").fetchedAt, "2026-10-08T12:00:00.000Z");
  assert.deepEqual(first.data.get("nodejs").releases[0], {
    cycle: "24",
    isEol: false,
    eolFrom: "2028-04-30",
    isEoas: false,
    eoasFrom: "2026-10-20",
  });
  assert.deepEqual(first.data.get("electron").releases[1], {
    cycle: "42",
    isEol: false,
    eolFrom: "2026-10-20",
    isEoas: null,
    eoasFrom: null,
  });
  await loadLifecycle(["nodejs"], cache, fetcher, attempts, fixedNow + 23 * 3_600_000);
  assert.equal(calls.length, 2, "A copy younger than 24 hours is used without a request");
  await loadLifecycle(["nodejs"], cache, fetcher, attempts, fixedNow + day);
  assert.equal(calls.length, 3, "A day-old copy is refreshed");
});

test("endoflife.date outages, rejected redirects, HTML pages and schema drift keep the last good copy and say so", async () => {
  const cache = memoryCache();
  const never = await loadLifecycle(["nodejs"], cache, down, new Map(), fixedNow);
  assert.equal(never.data.size, 0, "Never fetched means no lifecycle data");
  assert.match(never.notes[0], /^Node\.js lifecycle data is unavailable/);
  await loadLifecycle(["nodejs"], cache, async () => Response.json(nodejs), new Map(), fixedNow);
  const failures = [
    // A renamed product answers 301; with redirect "error" fetch rejects like an outage.
    async () => {
      throw new TypeError("fetch failed");
    },
    async () => new Response("<!doctype html><title>Not found</title>", { status: 404 }),
    async () =>
      Response.json({ result: { releases: [{ name: "24", isEol: "no", eolFrom: null }] } }),
    async () => Response.json({ result: { releases: [] } }),
    async () =>
      Response.json({
        result: { releases: [{ name: "24", isEol: false, eolFrom: "next April" }] },
      }),
    // Well-formed, but about another product, or about none: not an answer for the one asked.
    async () => Response.json({ ...nodejs, result: { ...nodejs.result, name: "bun" } }),
    async () => Response.json({ result: { releases: nodejs.result.releases } }),
  ];
  for (const [index, failure] of failures.entries()) {
    const result = await loadLifecycle(
      ["nodejs"],
      cache,
      failure,
      new Map(),
      fixedNow + (index + 2) * day,
    );
    assert.equal(
      result.data.get("nodejs").fetchedAt,
      "2026-10-08T12:00:00.000Z",
      `failure ${index}`,
    );
    assert.match(
      result.notes[0],
      /from 2026-10-08 is used; endoflife\.date could not be refreshed/,
    );
  }
  let calls = 0;
  const counting = async () => {
    calls++;
    return down();
  };
  const backoff = new Map();
  await loadLifecycle(["nodejs"], cache, counting, backoff, fixedNow + 10 * day);
  await loadLifecycle(["nodejs"], cache, counting, backoff, fixedNow + 10 * day + 59 * 60_000);
  assert.equal(calls, 1, "A failed product waits an hour before the next request");
  await loadLifecycle(["nodejs"], cache, counting, backoff, fixedNow + 10 * day + 60 * 60_000);
  assert.equal(calls, 2);
  await loadLifecycle(
    ["nodejs"],
    cache,
    counting,
    new Map([["nodejs", fixedNow + 20 * day]]),
    fixedNow + 10 * day,
  );
  assert.equal(
    calls,
    3,
    "A failure stamped in the future, after the clock went back, holds nothing",
  );
  cache.rows.set("endoflife:nodejs", {
    value: { product: "nodejs", releases: "corrupt" },
    fetchedAt: "x",
  });
  const corrupt = await loadLifecycle(["nodejs"], cache, null, new Map(), fixedNow);
  assert.equal(corrupt.data.size, 0, "A corrupt copy is not used");
  assert.match(corrupt.notes[0], /unavailable/);
});

test("lifecycle verdicts follow end of life, the 90-day window, and active support", () => {
  const data = {
    product: "nodejs",
    fetchedAt: "2026-10-08T09:00:00.000Z",
    releases: [
      { cycle: "24", isEol: false, eolFrom: "2028-04-30", isEoas: false, eoasFrom: "2026-10-20" },
      { cycle: "22", isEol: false, eolFrom: "2027-04-30", isEoas: true, eoasFrom: "2025-10-21" },
      { cycle: "20", isEol: true, eolFrom: "2026-04-30", isEoas: true, eoasFrom: "2024-10-22" },
      { cycle: "3", isEol: true, eolFrom: null, isEoas: true, eoasFrom: null },
      { cycle: "90", isEol: false, eolFrom: "2027-01-06", isEoas: null, eoasFrom: null },
      { cycle: "91", isEol: false, eolFrom: "2027-01-07", isEoas: null, eoasFrom: null },
      { cycle: "18", isEol: false, eolFrom: "2026-10-08", isEoas: true, eoasFrom: "2023-10-18" },
      { cycle: "26", isEol: false, eolFrom: "2029-04-30", isEoas: false, eoasFrom: "2027-10-27" },
    ],
  };
  const verdict = (cycle) =>
    lifecycleVerdict(
      { product: "nodejs", cycle, version: `${cycle}.1.0`, sources: ["engines.node"] },
      data,
      fixedNow,
    );
  assert.deepEqual(verdict("24"), {
    kind: "finding",
    severity: "low",
    effectiveDate: "2026-10-20",
    description:
      "Node.js 24 leaves active support on 2026-10-20; security support ends 2028-04-30 (endoflife.date, checked 2026-10-08). Source: engines.node.",
  });
  assert.equal(verdict("22").severity, "low");
  assert.match(
    verdict("22").description,
    /left active support on 2025-10-21; security support ends 2027-04-30/,
  );
  assert.deepEqual([verdict("20").severity, verdict("20").effectiveDate], ["high", "2026-04-30"]);
  assert.match(verdict("20").description, /^Node\.js 20 reached end of life on 2026-04-30/);
  assert.deepEqual([verdict("3").severity, verdict("3").effectiveDate], ["high", null]);
  assert.match(verdict("3").description, /^Node\.js 3 has reached end of life/);
  assert.equal(verdict("90").severity, "moderate", "Exactly 90 days is within the window");
  assert.equal(verdict("91"), null);
  assert.equal(verdict("18").severity, "high", "A reached date outranks a day-old flag");
  assert.equal(verdict("26"), null);
  assert.deepEqual(verdict("27"), {
    kind: "note",
    text: "Node.js 27 is not listed by endoflife.date (checked 2026-10-08); its lifecycle is unknown.",
  });
});

test("endoflife.date days must be real calendar days, or the product's data is unusable", async () => {
  const withDays = (eolFrom, eoasFrom) => ({
    result: {
      name: "nodejs",
      releases: [{ name: "24", isEol: false, eolFrom, isEoas: false, eoasFrom }],
    },
  });
  const leap = await loadLifecycle(
    ["nodejs"],
    memoryCache(),
    async () => Response.json(withDays("2028-02-29", "2024-02-29")),
    new Map(),
    fixedNow,
  );
  assert.deepEqual(leap.notes, [], "A leap day is a day");
  for (const bad of [
    "2027-02-29",
    "2026-02-31",
    "2026-04-31",
    "2026-13-45",
    "2026-00-10",
    "2026-10-00",
  ]) {
    for (const body of [withDays(bad, null), withDays("2028-04-30", bad)]) {
      const fetcher = async () => Response.json(body);
      const empty = memoryCache();
      const refused = await loadLifecycle(["nodejs"], empty, fetcher, new Map(), fixedNow);
      assert.equal(refused.data.size, 0, bad);
      assert.match(refused.notes[0], /^Node\.js lifecycle data is unavailable/, bad);
      assert.equal(empty.rows.size, 0, "A refused response is not cached");
      const kept = memoryCache();
      await loadLifecycle(["nodejs"], kept, async () => Response.json(nodejs), new Map(), fixedNow);
      const stale = await loadLifecycle(["nodejs"], kept, fetcher, new Map(), fixedNow + 2 * day);
      assert.equal(stale.data.get("nodejs").fetchedAt, "2026-10-08T12:00:00.000Z", bad);
      assert.match(
        stale.notes[0],
        /from 2026-10-08 is used; endoflife\.date could not be refreshed/,
      );
    }
  }
  // A stored copy holding an impossible day is as unusable as a response holding one.
  const stored = memoryCache();
  stored.rows.set("endoflife:nodejs", {
    value: {
      product: "nodejs",
      fetchedAt: "2026-10-08T12:00:00.000Z",
      releases: [
        { cycle: "24", isEol: false, eolFrom: "2026-02-31", isEoas: null, eoasFrom: null },
      ],
    },
    fetchedAt: "2026-10-08T12:00:00.000Z",
  });
  const unusable = await loadLifecycle(["nodejs"], stored, null, new Map(), fixedNow);
  assert.equal(unusable.data.size, 0);
  assert.match(unusable.notes[0], /^Node\.js lifecycle data is unavailable/);
});

test("a cached copy is fresh only when it is under 24 hours old and not dated in the future", async () => {
  const askedAgain = async (copyMadeAt) => {
    const cache = memoryCache();
    await loadLifecycle(
      ["nodejs"],
      cache,
      async () => Response.json(nodejs),
      new Map(),
      copyMadeAt,
    );
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return Response.json(nodejs);
    };
    await loadLifecycle(["nodejs"], cache, fetcher, new Map(), fixedNow);
    return calls === 1;
  };
  assert.equal(await askedAgain(fixedNow), false, "A copy made this very moment is fresh");
  assert.equal(
    await askedAgain(fixedNow - day + 1),
    false,
    "A millisecond short of a day is fresh",
  );
  assert.equal(await askedAgain(fixedNow - day), true, "A day-old copy is asked again");
  assert.equal(await askedAgain(fixedNow + 1), true, "A copy dated in the future is asked again");
  assert.equal(await askedAgain(fixedNow + 400 * day), true);
  // When asking fails, the dated copy is still the last good one, and its date is not hidden.
  const cache = memoryCache();
  await loadLifecycle(
    ["nodejs"],
    cache,
    async () => Response.json(nodejs),
    new Map(),
    fixedNow + 3 * day,
  );
  const failed = await loadLifecycle(["nodejs"], cache, down, new Map(), fixedNow);
  assert.equal(failed.data.get("nodejs").fetchedAt, "2026-10-11T12:00:00.000Z");
  assert.match(failed.notes[0], /from 2026-10-11 is used; endoflife\.date could not be refreshed/);
  // A fetch time that is not an ISO time cannot be aged, so the copy is not used at all.
  const junk = memoryCache();
  junk.rows.set("endoflife:nodejs", {
    value: { product: "nodejs", fetchedAt: "yesterday", releases: [] },
    fetchedAt: "2026-10-07T12:00:00.000Z",
  });
  const unaged = await loadLifecycle(["nodejs"], junk, null, new Map(), fixedNow);
  assert.equal(unaged.data.size, 0);
  assert.match(unaged.notes[0], /^Node\.js lifecycle data is unavailable/);
});

test("an endoflife.date response over 1 MiB is refused", async () => {
  const oversized = { ...nodejs, result: { ...nodejs.result, padding: "x".repeat(1024 * 1024) } };
  const result = await loadLifecycle(
    ["nodejs"],
    memoryCache(),
    async () => Response.json(oversized),
    new Map(),
    fixedNow,
  );
  assert.equal(result.data.size, 0);
  assert.match(result.notes[0], /^Node\.js lifecycle data is unavailable/);
});

test("a cancelled scan sends no request and does not count as a failed one", async () => {
  const controller = new AbortController();
  controller.abort();
  const cache = memoryCache();
  const attempts = new Map();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return Response.json(nodejs);
  };
  await loadLifecycle(["nodejs"], cache, fetcher, attempts, fixedNow, controller.signal);
  assert.equal(calls, 0);
  assert.equal(attempts.size, 0, "A cancelled request is not an outage to back off from");
  await loadLifecycle(["nodejs"], cache, fetcher, attempts, fixedNow + 1000);
  assert.equal(calls, 1, "The next scan asks straight away");
});

test("lifecycle data is kept in the SQLite store between runs", async () => {
  const dataDir = join(await temporary(), "state");
  const first = new MonitoringStorage(dataDir);
  try {
    await loadLifecycle(["nodejs"], first, async () => Response.json(nodejs), new Map(), fixedNow);
  } finally {
    first.close();
  }
  const second = new MonitoringStorage(dataDir);
  try {
    // No fetcher: the copy must come from the database, and it is young enough to need no request.
    const result = await loadLifecycle(["nodejs"], second, null, new Map(), fixedNow + 3_600_000);
    assert.deepEqual(result.notes, []);
    assert.equal(result.data.get("nodejs").fetchedAt, "2026-10-08T12:00:00.000Z");
    assert.equal(result.data.get("nodejs").releases[0].cycle, "24");
  } finally {
    second.close();
  }
});

const isoDay = (offset) => new Date(Date.now() + offset * day).toISOString().slice(0, 10);
async function waitFor(predicate) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a scan.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function finishScan(coordinator, request) {
  const previous = coordinator.snapshot().history[0]?.id;
  coordinator.requestScan(request);
  await waitFor(() => {
    const latest = coordinator.snapshot().history[0];
    return latest?.id !== previous && latest?.status !== "scanning";
  });
}
async function projectFixture(root, manifest = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { example: "^1.0.0" }, ...manifest }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", dependencies: { example: "^1.0.0" } },
        "node_modules/example": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
        },
      },
    }),
  );
}
const unchanged = async (dependencies) => ({
  dependencies,
  advisories: new Map(),
  coverage: [],
  errors: [],
});
// The two global tool sources of a PC whose PATH Node.js is `nodeVersion` (null: not captured).
function pcSources(root, nodeVersion, bunVersion = null) {
  const source = { registry: "public", blockedScopes: [], checkedAt: new Date().toISOString() };
  return [
    {
      ...source,
      manager: "npm",
      status: "detected",
      version: "11.7.0",
      root: join(root, "npm", "node_modules"),
      error: null,
      nodeVersion,
    },
    bunVersion
      ? {
          ...source,
          manager: "bun",
          status: "detected",
          version: bunVersion,
          root: join(root, "bun", "node_modules"),
          error: null,
        }
      : {
          ...source,
          manager: "bun",
          status: "not-installed",
          version: null,
          root: null,
          registry: "unknown",
          error: null,
        },
  ];
}
const inventoryOf = (managers) => async () => ({
  installations: [],
  managers: managers(),
  checkedRoots: [],
  coverage: [],
  errors: [],
  inventoryChecks: "complete",
  updateChecks: "complete",
});
const lifecycleOf = (coordinator) =>
  coordinator.snapshot().findings.filter((finding) => finding.kind === "lifecycle");
// The line a lifecycle check that reached endoflife.date for every runtime adds to the coverage.
const checkedLine = (products) =>
  `Runtime end of life checked against endoflife.date (${products} product${products === 1 ? "" : "s"}).`;
const isCheckedLine = (line) => /^Runtime end of life checked against endoflife\.date/.test(line);
function endoflife(calls, releases) {
  return async (url, options) => {
    assert.equal(options.redirect, "error");
    const product = /^https:\/\/endoflife\.date\/api\/v1\/products\/([a-z]+)\/$/.exec(url)?.[1];
    assert.ok(product, `Only endoflife.date product pages are requested: ${url}`);
    calls.push(product);
    return Response.json({ result: { name: product, releases: releases[product] ?? [] } });
  };
}

test("a project's declared runtimes become lifecycle findings that never notify and survive a failed scan", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await projectFixture(projectRoot, { engines: { node: ">=20" } });
  await writeFile(join(projectRoot, ".nvmrc"), "24.1.0\n");
  const calls = [];
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: unchanged,
    sourceFetch: endoflife(calls, {
      nodejs: [
        { name: "24", isEol: false, eolFrom: isoDay(600), isEoas: false, eoasFrom: isoDay(12) },
        { name: "20", isEol: true, eolFrom: isoDay(-30), isEoas: true, eoasFrom: isoDay(-400) },
      ],
    }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  let snapshot = coordinator.snapshot();
  const lifecycle = lifecycleOf(coordinator).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    lifecycle.map((f) => [
      f.name,
      f.severity,
      f.effectiveDate,
      f.installedVersion,
      f.packageName,
      f.source,
    ]),
    [
      ["Node.js 20", "high", isoDay(-30), ">=20", null, "endoflife.date"],
      ["Node.js 24", "low", isoDay(12), "24.1.0", null, "endoflife.date"],
    ],
  );
  assert.match(
    lifecycle[1].description,
    /^Node\.js 24 leaves active support on .* Source: \.nvmrc\.$/,
  );
  assert.equal(snapshot.notifications.length, 0, "Lifecycle findings do not notify");
  assert.ok(
    snapshot.projects[0].evidence.coverage.includes(checkedLine(1)),
    "A complete check says so, once",
  );
  assert.equal(snapshot.projects[0].evidence.coverage.filter(isCheckedLine).length, 1);
  assert.deepEqual(calls, ["nodejs"]);
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  assert.deepEqual(calls, ["nodejs"], "A copy younger than a day is reused");
  await writeFile(join(projectRoot, "package-lock.json"), "broken");
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  snapshot = coordinator.snapshot();
  assert.equal(snapshot.projects[0].evidence.status, "failed");
  assert.deepEqual(
    lifecycleOf(coordinator)
      .map((f) => f.id)
      .sort(),
    lifecycle.map((f) => f.id).sort(),
    "A failed scan keeps lifecycle evidence",
  );
});

test("This PC's Node.js and Bun get lifecycle findings, and unreachable endoflife.date is a note", async (t) => {
  const root = await temporary();
  const inventoryLookup = inventoryOf(() => pcSources(root, "20.11.1", "1.4.0"));
  const calls = [];
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    inventoryLookup,
    sourceFetch: endoflife(calls, {
      nodejs: [{ name: "20", isEol: true, eolFrom: isoDay(-30) }],
      bun: [{ name: "1", isEol: false, eolFrom: null }],
    }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  await finishScan(coordinator, { target: "pc" });
  const snapshot = coordinator.snapshot();
  assert.deepEqual(
    lifecycleOf(coordinator).map((f) => [f.subjectId, f.name, f.severity]),
    [[snapshot.device.id, "Node.js 20", "high"]],
  );
  assert.equal(snapshot.notifications.length, 0, "Lifecycle findings do not notify");
  assert.ok(
    snapshot.inventory.evidence.coverage.includes(checkedLine(2)),
    "Node.js and Bun are two products",
  );
  assert.deepEqual(calls.sort(), ["bun", "nodejs"]);
  const offline = new MonitoringCoordinator({
    dataDir: join(root, "offline"),
    lookup: false,
    inventoryLookup,
    sourceFetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  t.after(() => offline.close());
  offline.changeSettings({ paused: true });
  await finishScan(offline, { target: "pc" });
  const unavailable = offline.snapshot();
  assert.equal(lifecycleOf(offline).length, 0);
  assert.ok(
    unavailable.inventory.evidence.coverage.some((line) =>
      /Node\.js lifecycle data is unavailable/.test(line),
    ),
  );
  assert.equal(
    unavailable.inventory.evidence.status,
    "complete",
    "A lifecycle gap is a note, not a failure",
  );
  assert.equal(
    unavailable.inventory.evidence.coverage.some(isCheckedLine),
    false,
    "A check that reached nothing does not say that it checked",
  );
  const disabled = new MonitoringCoordinator({
    dataDir: join(root, "disabled"),
    lookup: false,
    inventoryLookup,
  });
  t.after(() => disabled.close());
  disabled.changeSettings({ paused: true });
  await finishScan(disabled, { target: "pc" });
  assert.ok(
    disabled
      .snapshot()
      .inventory.evidence.coverage.some((line) =>
        /Node\.js lifecycle data is unavailable/.test(line),
      ),
    "Without a source fetch nothing is requested, and the gap is said",
  );
});

test("a PC scan that cannot capture Node.js keeps its Node.js finding, and one that can replaces it", async (t) => {
  const root = await temporary();
  let nodeVersion = "20.11.1";
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    inventoryLookup: inventoryOf(() => pcSources(root, nodeVersion)),
    sourceFetch: endoflife([], {
      nodejs: [
        { name: "24", isEol: false, eolFrom: isoDay(600), isEoas: false, eoasFrom: isoDay(300) },
        { name: "20", isEol: true, eolFrom: isoDay(-30) },
      ],
    }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  await finishScan(coordinator, { target: "pc" });
  const [finding] = lifecycleOf(coordinator);
  assert.deepEqual([finding.name, finding.severity], ["Node.js 20", "high"]);
  nodeVersion = null;
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(
    lifecycleOf(coordinator).map((f) => f.id),
    [finding.id],
    "Not capturing Node.js is unknown, not supported",
  );
  const { evidence } = coordinator.snapshot().inventory;
  assert.equal(evidence.status, "complete");
  assert.ok(
    evidence.coverage.some((line) =>
      /Node\.js version on the owner's PATH was not captured/.test(line),
    ),
  );
  nodeVersion = "24.3.0";
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(lifecycleOf(coordinator), [], "A scan that checked the Node.js now on PATH");
});

test("a PC scan that cannot read an installed Bun's version keeps its Bun finding and says so", async (t) => {
  const root = await temporary();
  // A version; null for Bun not installed; "unread" for Bun on PATH whose version could not be read,
  // as the probe leaves it.
  let bun = "1.4.0";
  const sources = () => {
    const [npm, installed] = pcSources(root, "24.3.0", bun === "unread" ? null : bun);
    return bun === "unread"
      ? [
          npm,
          {
            ...installed,
            status: "unavailable",
            error: "Bun global location or registry configuration could not be checked.",
          },
        ]
      : [npm, installed];
  };
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    inventoryLookup: inventoryOf(sources),
    sourceFetch: endoflife([], {
      nodejs: [
        { name: "24", isEol: false, eolFrom: isoDay(600), isEoas: false, eoasFrom: isoDay(300) },
      ],
      bun: [{ name: "1", isEol: true, eolFrom: isoDay(-30) }],
    }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  await finishScan(coordinator, { target: "pc" });
  const [finding] = lifecycleOf(coordinator);
  assert.deepEqual([finding.name, finding.severity], ["Bun 1", "high"]);
  bun = "unread";
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(
    lifecycleOf(coordinator).map((f) => f.id),
    [finding.id],
    "A Bun that is installed but cannot be read is unknown, not gone",
  );
  const { evidence } = coordinator.snapshot().inventory;
  assert.equal(evidence.status, "complete");
  assert.ok(
    evidence.coverage.includes("Bun's version could not be read; its end of life was not checked."),
  );
  bun = "1.5.0";
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(
    lifecycleOf(coordinator).map((f) => [f.name, f.installedVersion]),
    [["Bun 1", "1.5.0"]],
    "A Bun that can be read is checked again, and replaces the kept finding",
  );
  bun = null;
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(
    lifecycleOf(coordinator),
    [],
    "A Bun that is not installed is gone, not unknown",
  );
});

test("a project's runtime check that could not finish keeps its previous findings, and a finished one replaces them", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await projectFixture(projectRoot);
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: unchanged,
    sourceFetch: endoflife([], {
      nodejs: [
        { name: "24", isEol: false, eolFrom: isoDay(600), isEoas: false, eoasFrom: isoDay(12) },
        { name: "20", isEol: true, eolFrom: isoDay(-30), isEoas: true, eoasFrom: isoDay(-400) },
      ],
    }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  const rescan = async (files) => {
    for (const [name, text] of Object.entries(files))
      await writeFile(join(projectRoot, name), text);
    await finishScan(coordinator, { target: "projects", projectId: project.id });
    const { evidence } = coordinator.snapshot().projects[0];
    return {
      found: lifecycleOf(coordinator).map((f) => `${f.name} (${f.installedVersion})`),
      coverage: evidence.coverage,
      status: evidence.status,
    };
  };
  const tooLarge = "2".repeat(5000); // Over the 4 KiB a runtime file may have.
  assert.deepEqual((await rescan({ ".nvmrc": "24.1.0\n" })).found, ["Node.js 24 (24.1.0)"]);
  let result = await rescan({ ".nvmrc": tooLarge });
  assert.deepEqual(
    result.found,
    ["Node.js 24 (24.1.0)"],
    "A runtime file that cannot be read does not clear what it declared before",
  );
  assert.ok(result.coverage.some((line) => /\.nvmrc could not be read safely/.test(line)));
  assert.equal(result.status, "complete");
  result = await rescan({ ".nvmrc": "24.2.0\n", ".node-version": tooLarge });
  assert.deepEqual(
    result.found,
    ["Node.js 24 (24.2.0)"],
    "A runtime checked again is shown once, as it is now declared",
  );
  result = await rescan({ ".nvmrc": "20.0.0\n", ".node-version": "20.1.0\n" });
  assert.deepEqual(
    result.found,
    ["Node.js 20 (20.0.0)"],
    "Once every file is read and every product has data, only what is declared now remains",
  );
});

test("unavailable lifecycle data keeps the previous findings of a project and of This PC", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await projectFixture(projectRoot, { engines: { node: ">=20" } });
  const dataDir = join(root, "state");
  const open = (sourceFetch) =>
    new MonitoringCoordinator({
      dataDir,
      dependencyLookup: unchanged,
      inventoryLookup: inventoryOf(() => pcSources(root, "20.11.1")),
      sourceFetch,
    });
  const scanBoth = async (coordinator) => {
    await finishScan(coordinator, { target: "pc" });
    await finishScan(coordinator, {
      target: "projects",
      projectId: coordinator.snapshot().projects[0].id,
    });
  };
  let ids;
  const first = open(
    endoflife([], { nodejs: [{ name: "20", isEol: true, eolFrom: isoDay(-30) }] }),
  );
  try {
    first.changeSettings({ paused: true });
    await first.addProject({ path: projectRoot, mode: "maintained" });
    await scanBoth(first);
    ids = lifecycleOf(first)
      .map((f) => f.id)
      .sort();
    assert.equal(ids.length, 2, "The project's and This PC's Node.js 20");
  } finally {
    await first.close();
  }
  // Only the database carries state to the next coordinator; with no cached copy of the product,
  // endoflife.date is the one place left to ask, and it is down.
  withDatabase(dataDir, (database) => database.exec("DELETE FROM source_cache"));
  const second = open(down);
  t.after(() => second.close());
  await scanBoth(second);
  assert.deepEqual(
    lifecycleOf(second)
      .map((f) => f.id)
      .sort(),
    ids,
  );
  const snapshot = second.snapshot();
  for (const evidence of [snapshot.inventory.evidence, snapshot.projects[0].evidence]) {
    assert.equal(evidence.status, "complete");
    assert.ok(
      evidence.coverage.some((line) => /^Node\.js lifecycle data is unavailable/.test(line)),
    );
  }
});

test("a coordinator that cannot read its stored state closes its database before it throws", async (t) => {
  const dataDir = join(await temporary(), "state");
  await new MonitoringCoordinator({ dataDir, lookup: false }).close();
  withDatabase(dataDir, (database) => database.exec("UPDATE monitoring_meta SET value='{broken'"));
  // A constructor that throws leaves nothing to call close() on, so the test watches the storage.
  const opened = [];
  const read = MonitoringStorage.prototype.read;
  t.mock.method(MonitoringStorage.prototype, "read", function () {
    opened.push(this);
    return read.call(this);
  });
  assert.throws(
    () => new MonitoringCoordinator({ dataDir, lookup: false }),
    /invalid monitoring state record/,
  );
  assert.equal(opened.length, 1);
  // Closing an open database succeeds (and ends the leak); a closed one refuses.
  assert.throws(() => opened[0].close(), /database is not open/, "The storage was left open");
});

test("a finding kind from a newer Versionstead decodes as other, while malformed findings stay invalid", async (t) => {
  const dataDir = join(await temporary(), "state");
  let coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  const base = coordinator.snapshot();
  await coordinator.close();
  const drift = {
    id: "drift-fixture",
    kind: "drift",
    subjectId: base.device.id,
    subjectLabel: base.device.label,
    name: "typescript",
    packageName: "typescript",
    installedVersion: "5.4.0",
    availableVersion: null,
    severity: "info",
    source: "Version drift",
    description: "Resolved at different versions across projects.",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00.000Z",
    lastSeenAt: "2026-10-08T00:00:00.000Z",
  };
  // What a newer build left in the database before the owner went back to this one.
  const storage = new MonitoringStorage(dataDir);
  try {
    const stored = storage.read();
    stored.snapshot.findings.push(drift);
    storage.write(stored);
  } finally {
    storage.close();
  }
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  t.after(() => coordinator.close());
  const kindOf = (snapshot) => snapshot.findings.find((f) => f.id === "drift-fixture").kind;
  assert.equal(kindOf(coordinator.snapshot()), "other");
  assert.equal(
    kindOf(JSON.parse(coordinator.snapshotJson())),
    "other",
    "The interface is served other",
  );
  // Evidence from a paired PC on a later build is read the same way.
  assert.equal(
    kindOf(
      decodeRemoteEvidence({ nonce: "nonce", snapshot: { ...base, findings: [drift] } }).snapshot,
    ),
    "other",
  );

  const decode = (changes) =>
    decodeMonitoringSnapshot({ ...base, findings: [{ ...drift, ...changes }] });
  for (const kind of ["update", "advisory", "coverage", "lifecycle", "other"])
    assert.equal(kindOf(decode({ kind })), kind, "A kind this build knows keeps its meaning");
  for (const kind of ["", "constructor", "x".repeat(50)])
    assert.equal(kindOf(decode({ kind })), "other", kind);
  for (const kind of [42, null, undefined, ["update"], { name: "update" }, "x".repeat(51)])
    assert.throws(() => decode({ kind }), String(kind).slice(0, 20));
  assert.throws(() => decode({ severity: "medium" }), "Other fields stay strict");
  assert.throws(() => decode({ detectedAt: 5 }), "Other fields stay strict");
  const { kind: _omitted, ...nameless } = drift;
  assert.throws(
    () => decodeMonitoringSnapshot({ ...base, findings: [nameless] }),
    "A finding must still name its kind",
  );
});
