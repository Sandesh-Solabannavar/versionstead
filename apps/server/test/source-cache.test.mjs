import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import test from "node:test";
import { inspectGlobalSources } from "../dist/adapters/inventory.js";
import {
  createSourceCache,
  lookupDependencies,
  publicPackageVersions,
} from "../dist/adapters/lookups.js";
import { MonitoringCoordinator } from "../dist/monitoring.js";

const start = Date.parse("2026-10-08T12:00:00Z");
const minutes = (count) => count * 60 * 1000;
const budget = () => Date.now() + 90000;

// The cache reads Date.now(), so a mocked Date is the injected clock; sleeping only records the wait
// and advances that clock, so no test waits for real.
function clock(t) {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const waits = [];
  return {
    waits,
    tick: (milliseconds) => t.mock.timers.tick(milliseconds),
    reset: () => t.mock.timers.setTime(start),
    cache: () =>
      createSourceCache(async (milliseconds) => {
        waits.push(milliseconds);
        t.mock.timers.tick(milliseconds);
      }),
  };
}

const metadata = (name, versions = ["1.0.0", "1.5.0", "2.0.0"]) => ({
  name,
  "dist-tags": { latest: versions.at(-1) },
  versions: Object.fromEntries(versions.map((version) => [version, {}])),
});
const advisory = (name) => ({
  id: "GHSA-shared-advisory",
  summary: "Shared fixture advisory",
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { ecosystem: "npm", name },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.5.0" }] }],
    },
  ],
});
const dependency = (name, extra = {}) => ({
  id: `${name}@1.0.0`,
  name,
  packageName: name,
  requested: "^1.0.0",
  resolved: "1.0.0",
  origin: "registry",
  role: "production",
  importer: ".",
  availableVersion: null,
  latestVersion: null,
  advisoryStatus: "not-checked",
  advisoryIds: [],
  ...extra,
});

// A scripted public source. `route` answers registry, querybatch and advisory-detail requests.
function sources(route = {}) {
  const calls = [];
  const answer = {
    registry: (name) => Response.json(metadata(name)),
    querybatch: (queries) =>
      Response.json({
        results: queries.map((query) =>
          route.vulnerable?.includes(query.package.name)
            ? {
                vulns: [
                  {
                    id: "GHSA-shared-advisory",
                    modified: route.modified ?? "2026-09-01T00:00:00Z",
                  },
                ],
              }
            : {},
        ),
      }),
    detail: (id) => Response.json({ ...advisory(route.vulnerable?.[0] ?? "x"), id }),
    ...route.answer,
  };
  const fetcher = async (url, options = {}) => {
    assert.equal(options.redirect, "error");
    const path = new URL(url).pathname;
    const kind = url.endsWith("/querybatch")
      ? "querybatch"
      : path.startsWith("/v1/vulns/")
        ? "detail"
        : "registry";
    const call = {
      kind,
      url,
      headers: { ...options.headers },
      name: kind === "registry" ? decodeURIComponent(path.slice(1)) : path.split("/").at(-1),
    };
    calls.push(call);
    if (route.respond) {
      const custom = await route.respond(call, calls.filter((c) => c.kind === kind).length);
      if (custom) return custom;
    }
    return kind === "querybatch"
      ? answer.querybatch(JSON.parse(options.body).queries)
      : answer[kind](call.name);
  };
  const count = (kind, name) =>
    calls.filter((call) => call.kind === kind && (name === undefined || call.name === name)).length;
  return { fetcher, calls, count };
}
const get = (name, fetcher, cache, signal, deadline = budget()) =>
  publicPackageVersions(name, fetcher, deadline, signal, cache);

test("metadata fresh for 30 minutes is served without a request and keeps the time it was checked", async (t) => {
  const time = clock(t);
  const { fetcher, calls } = sources();
  const cache = time.cache();
  const first = await get("pkg", fetcher, cache);
  time.tick(minutes(29));
  const second = await get("pkg", fetcher, cache);
  assert.equal(calls.length, 1, "A hit inside the freshness window sends nothing");
  assert.equal(first.checkedAt, start);
  assert.equal(second.checkedAt, start, "A hit reports when the registry last confirmed the data");
  assert.deepEqual(second.versions, ["1.0.0", "1.5.0", "2.0.0"]);
  assert.equal(second.latest, "2.0.0");
});

test("a stale entry is revalidated with If-None-Match: 304 renews it and 200 replaces it", async (t) => {
  const time = clock(t);
  let version = 1;
  const { fetcher, calls } = sources({
    respond: (call) => {
      if (call.kind !== "registry") return undefined;
      const sent = call.headers["If-None-Match"];
      if (sent === `W/"v${version}"`) return new Response(null, { status: 304 });
      return Response.json(metadata("pkg", version === 1 ? ["1.0.0"] : ["1.0.0", "2.0.0"]), {
        headers: { ETag: `W/"v${version}"` },
      });
    },
  });
  const cache = time.cache();
  await get("pkg", fetcher, cache);
  assert.equal(calls[0].headers["If-None-Match"], undefined);
  assert.equal(calls[0].headers.Accept, "application/vnd.npm.install-v1+json");

  time.tick(minutes(31));
  const renewed = await get("pkg", fetcher, cache);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers["If-None-Match"], 'W/"v1"');
  assert.equal(calls[1].headers.Accept, "application/vnd.npm.install-v1+json");
  assert.deepEqual(renewed.versions, ["1.0.0"]);
  assert.equal(renewed.checkedAt, start + minutes(31), "A 304 confirms the data as of now");

  time.tick(minutes(10));
  await get("pkg", fetcher, cache);
  assert.equal(calls.length, 2, "A renewed entry is fresh again");

  version = 2;
  time.tick(minutes(25));
  const replaced = await get("pkg", fetcher, cache);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].headers["If-None-Match"], 'W/"v1"');
  assert.deepEqual(replaced.versions, ["1.0.0", "2.0.0"], "A changed document replaces the entry");
  assert.equal(replaced.latest, "2.0.0");
  time.tick(minutes(31));
  await get("pkg", fetcher, cache);
  assert.equal(calls[3].headers["If-None-Match"], 'W/"v2"', "The new validator is used next");
});

test("an entry without an ETag is fetched in full once it is stale, and unsafe validators are not sent back", async (t) => {
  const time = clock(t);
  const bare = sources();
  const cache = time.cache();
  await get("pkg", bare.fetcher, cache);
  time.tick(minutes(31));
  await get("pkg", bare.fetcher, cache);
  assert.equal(bare.calls.length, 2);
  assert.equal(bare.calls[1].headers["If-None-Match"], undefined);

  const odd = sources({
    respond: (call) =>
      call.kind === "registry"
        ? Response.json(metadata(call.name), { headers: { ETag: 'W/"a b\u007f"' } })
        : undefined,
  });
  await get("other", odd.fetcher, cache);
  time.tick(minutes(31));
  await get("other", odd.fetcher, cache);
  assert.equal(odd.calls[1].headers["If-None-Match"], undefined);
});

test("a failed revalidation fails the check instead of serving old data as current", async (t) => {
  const time = clock(t);
  let unavailable = false;
  const { fetcher, calls } = sources({
    respond: (call) => {
      if (call.kind !== "registry") return undefined;
      if (unavailable) return new Response("", { status: 503 });
      return call.headers["If-None-Match"]
        ? new Response(null, { status: 304 })
        : Response.json(metadata(call.name, ["1.0.0", "2.0.0"]), { headers: { ETag: 'W/"v1"' } });
    },
  });
  const cache = time.cache();
  const dependencies = [dependency("pkg")];
  const first = await lookupDependencies(
    dependencies,
    fetcher,
    undefined,
    undefined,
    undefined,
    cache,
  );
  assert.equal(first.dependencies[0].versionStatus, "checked");
  assert.equal(first.dependencies[0].latestVersion, "2.0.0");

  time.tick(minutes(31));
  unavailable = true;
  const failed = await lookupDependencies(
    dependencies,
    fetcher,
    undefined,
    undefined,
    undefined,
    cache,
  );
  assert.equal(failed.dependencies[0].versionStatus, "failed");
  assert.equal(failed.dependencies[0].latestVersion, null, "Unknown stays unknown");
  assert.equal(failed.dependencies[0].availableVersion, null);
  assert.equal(failed.versionChecked.size, 0);
  assert.ok(failed.errors.some((error) => /version lookup failed/i.test(error)));

  unavailable = false;
  const renewed = await get("pkg", fetcher, cache);
  assert.equal(renewed.checkedAt, Date.now(), "The old entry still revalidates later");
  assert.ok(renewed.checkedAt > start + minutes(31));
  assert.equal(calls.at(-1).headers["If-None-Match"], 'W/"v1"');
});

test("invalid responses are validated like fresh ones and are never cached", async (t) => {
  const time = clock(t);
  const bad = [
    Response.json({ name: "another", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } }),
    Response.json({ name: "pkg", "dist-tags": { latest: "not-a-version" }, versions: {} }),
    Response.json({ name: "pkg", "dist-tags": { latest: "1.0.0" }, versions: [] }),
  ];
  const { fetcher, calls } = sources({
    respond: (call) => (call.kind === "registry" ? bad.shift() : undefined),
  });
  const cache = time.cache();
  await assert.rejects(get("pkg", fetcher, cache), /another identity/);
  await assert.rejects(get("pkg", fetcher, cache), /invalid versions/);
  await assert.rejects(get("pkg", fetcher, cache));
  assert.equal(calls.length, 3);
  assert.equal((await get("pkg", fetcher, cache)).latest, "2.0.0");
  assert.equal(calls.length, 4, "A failure leaves nothing behind to be served");
});

test("concurrent requests for one name share a single in-flight request, also when it fails", async (t) => {
  const time = clock(t);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let broken = false;
  const { fetcher, calls } = sources({
    respond: async (call) => {
      if (call.kind !== "registry") return undefined;
      await gate;
      return broken ? new Response("", { status: 404 }) : undefined;
    },
  });
  const cache = time.cache();
  const pending = [
    get("pkg", fetcher, cache),
    get("pkg", fetcher, cache),
    get("other", fetcher, cache),
  ];
  await flush();
  const again = get("pkg", fetcher, cache);
  release();
  const [a, b, other] = await Promise.all([...pending, again]);
  assert.equal(calls.filter((call) => call.name === "pkg").length, 1);
  assert.equal(calls.filter((call) => call.name === "other").length, 1, "Other names are separate");
  assert.deepEqual(a, b);
  assert.equal(other.latest, "2.0.0");

  broken = true;
  const failing = [get("down", fetcher, cache), get("down", fetcher, cache)];
  const settled = await Promise.allSettled(failing);
  assert.deepEqual(
    settled.map((r) => r.status),
    ["rejected", "rejected"],
  );
  assert.equal(calls.filter((call) => call.name === "down").length, 1);
  broken = false;
  assert.equal((await get("down", fetcher, cache)).latest, "2.0.0", "A failed load can be retried");
});

test("the metadata cache holds 2,000 names and evicts the least recently used", async (t) => {
  const time = clock(t);
  const { fetcher, count } = sources();
  const cache = time.cache();
  for (let index = 0; index < 2000; index++) await get(`pkg-${index}`, fetcher, cache);
  assert.equal(count("registry"), 2000);
  await get("pkg-0", fetcher, cache); // a hit makes the oldest entry the newest
  assert.equal(count("registry"), 2000);
  await get("pkg-2000", fetcher, cache); // the 2,001st name evicts pkg-1, not pkg-0
  assert.equal(count("registry"), 2001);
  await get("pkg-0", fetcher, cache);
  assert.equal(count("registry"), 2001, "A recently used name survives");
  await get("pkg-1", fetcher, cache);
  assert.equal(count("registry"), 2002, "The least recently used name was evicted");
});

test("the cached record keeps each version's deprecation and install-script flags, not whole manifests", async (t) => {
  const time = clock(t);
  const { fetcher } = sources({
    respond: (call) =>
      call.kind === "registry"
        ? Response.json({
            name: "pkg",
            "dist-tags": { latest: "3.0.0" },
            versions: {
              "1.0.0": {
                deprecated: "Use 2.x",
                hasInstallScript: true,
                dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
                dependencies: { left: "^1.0.0" },
              },
              "2.0.0": { deprecated: "", hasInstallScript: false },
              "3.0.0": null,
            },
          })
        : undefined,
  });
  const result = await get("pkg", fetcher, time.cache());
  assert.deepEqual(result.versions, ["1.0.0", "2.0.0", "3.0.0"]);
  assert.deepEqual(result.details, {
    "1.0.0": { deprecated: "Use 2.x", hasInstallScript: true },
    "2.0.0": {},
    "3.0.0": {},
  });
});

test("one retry follows a 429 or 503 after Retry-After plus jitter, or a network error after a short pause", async (t) => {
  const time = clock(t);
  const cases = [
    [
      "429 with delta-seconds",
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }),
      7000,
    ],
    [
      "503 with an HTTP date",
      () =>
        new Response("", {
          status: 503,
          headers: { "Retry-After": new Date(Date.now() + 5000).toUTCString() },
        }),
      5000,
    ],
    [
      "503 with an HTTP date already past",
      () =>
        new Response("", {
          status: 503,
          headers: { "Retry-After": new Date(Date.now() - 60000).toUTCString() },
        }),
      0,
    ],
    [
      "429 with Retry-After 0",
      () => new Response("", { status: 429, headers: { "Retry-After": "0" } }),
      0,
    ],
    ["503 without a header", () => new Response("", { status: 503 }), 500],
    [
      "429 with an unusable header",
      () => new Response("", { status: 429, headers: { "Retry-After": "soon" } }),
      500,
    ],
    [
      "network error",
      () => {
        throw new TypeError("fetch failed");
      },
      500,
    ],
  ];
  let random = 0;
  t.mock.method(Math, "random", () => random);
  for (const [index, [label, failure, floor]] of cases.entries()) {
    for (const [jitter, upper] of [
      [0, floor],
      [0.999, floor + 500],
    ]) {
      random = jitter;
      time.waits.length = 0;
      time.reset(); // an HTTP date has whole-second resolution
      const { fetcher, calls } = sources({
        respond: (call, number) =>
          call.kind === "registry" && number === 1 ? failure() : undefined,
      });
      const result = await get(`pkg-${index}`, fetcher, time.cache());
      assert.equal(result.latest, "2.0.0", label);
      assert.equal(calls.length, 2, label);
      assert.equal(time.waits.length, 1, label);
      assert.ok(time.waits[0] >= floor && time.waits[0] <= upper, `${label}: ${time.waits[0]}`);
      if (jitter > 0) assert.ok(time.waits[0] > floor, `${label} adds jitter`);
    }
  }
});

test("there is only one retry, and a released failed response body is not left open", async (t) => {
  const time = clock(t);
  let canceled = 0;
  const throttled = () =>
    new Response(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
      { status: 429, headers: { "Retry-After": "1" } },
    );
  const persistent = sources({
    respond: (call) => (call.kind === "registry" ? throttled() : undefined),
  });
  await assert.rejects(get("pkg", persistent.fetcher, time.cache()), /unavailable/);
  assert.equal(persistent.calls.length, 2, "A second 429 is final");
  assert.equal(canceled, 2, "Both unread bodies are released");
  assert.equal(time.waits.length, 1);

  time.waits.length = 0;
  const offline = sources({
    respond: (call) => {
      if (call.kind === "registry") throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(get("pkg", offline.fetcher, time.cache()), /fetch failed/);
  assert.equal(offline.calls.length, 2);
  assert.equal(time.waits.length, 1);
});

test("a retry never outlasts the stage budget", async (t) => {
  const time = clock(t);
  const throttled = (seconds) => (call) =>
    call.kind === "registry"
      ? new Response("", { status: 429, headers: { "Retry-After": String(seconds) } })
      : undefined;

  const tooLong = sources({ respond: throttled(120) });
  await assert.rejects(
    get("pkg", tooLong.fetcher, time.cache(), undefined, Date.now() + 60000),
    /unavailable/,
  );
  assert.equal(tooLong.calls.length, 1, "A wait longer than the remaining budget is not started");
  assert.equal(time.waits.length, 0);

  const absurd = sources({ respond: throttled("9".repeat(400)) });
  await assert.rejects(get("pkg", absurd.fetcher, time.cache()), /unavailable/);
  assert.equal(absurd.calls.length, 1, "A Retry-After beyond any number is still a long wait");

  const fits = sources({ respond: (call, n) => (n === 1 ? throttled(30)(call) : undefined) });
  assert.equal(
    (await get("pkg", fits.fetcher, time.cache(), undefined, Date.now() + 60000)).latest,
    "2.0.0",
  );
  assert.equal(fits.calls.length, 2);
  assert.ok(time.waits[0] >= 30000 && time.waits[0] < 30500);

  const edge = sources({
    respond: (call) => (call.kind === "registry" ? new Response("", { status: 503 }) : undefined),
  });
  time.waits.length = 0;
  await assert.rejects(
    get("pkg", edge.fetcher, time.cache(), undefined, Date.now() + 400),
    /unavailable/,
  );
  assert.equal(edge.calls.length, 1, "Even the short default pause must fit in what is left");

  time.waits.length = 0;
  const slowWait = sources({ respond: (call, n) => (n === 1 ? throttled(5)(call) : undefined) });
  const slow = createSourceCache(async (milliseconds) => {
    time.waits.push(milliseconds);
    time.tick(milliseconds + 60000); // the wait overran the deadline
  });
  await assert.rejects(
    get("pkg", slowWait.fetcher, slow, undefined, Date.now() + 10000),
    /time budget/,
  );
  assert.equal(slowWait.calls.length, 1, "No request starts after the deadline");
});

test("other client errors, server errors and timeouts are not retried", async (t) => {
  const time = clock(t);
  for (const status of [400, 401, 403, 404, 410, 500, 502, 504]) {
    const { fetcher, calls } = sources({
      respond: (call) => (call.kind === "registry" ? new Response("", { status }) : undefined),
    });
    await assert.rejects(get("pkg", fetcher, time.cache()), /unavailable/, String(status));
    assert.equal(calls.length, 1, `HTTP ${status}`);
  }
  const timedOut = sources({
    respond: () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  });
  await assert.rejects(get("pkg", timedOut.fetcher, time.cache()), { name: "TimeoutError" });
  assert.equal(timedOut.calls.length, 1, "A timeout already used its 12 seconds");
  const controller = new AbortController();
  const cancelled = sources({
    respond: () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
  });
  await assert.rejects(get("pkg", cancelled.fetcher, time.cache(), controller.signal), {
    name: "AbortError",
  });
  assert.equal(cancelled.calls.length, 1);
  assert.equal(time.waits.length, 0);
});

test("cancelling during a retry wait stops at once", async () => {
  const controller = new AbortController();
  const { fetcher, calls } = sources({
    respond: (call) => {
      if (call.kind !== "registry") return undefined;
      queueMicrotask(() => controller.abort());
      return new Response("", { status: 429, headers: { "Retry-After": "30" } });
    },
  });
  const started = Date.now();
  await assert.rejects(get("pkg", fetcher, createSourceCache(), controller.signal), /scan stopped/);
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 5000, "The 30-second wait must not be served");
});

test("a failed OSV batch is retried instead of leaving every record unchecked", async (t) => {
  const time = clock(t);
  const { fetcher, count } = sources({
    respond: (call, number) =>
      call.kind === "querybatch" && number === 1
        ? new Response("busy", { status: 503 })
        : undefined,
  });
  const result = await lookupDependencies(
    [dependency("pkg")],
    fetcher,
    undefined,
    undefined,
    undefined,
    time.cache(),
  );
  assert.equal(count("querybatch"), 2);
  assert.equal(result.dependencies[0].advisoryStatus, "checked");
  assert.deepEqual(result.errors, []);
  assert.equal(time.waits.length, 1);
});

test("advisory details are cached by id and modified time and shared by projects", async (t) => {
  const time = clock(t);
  let modified = "2026-09-01T00:00:00Z";
  const route = {
    vulnerable: ["shared-a"],
    get modified() {
      return modified;
    },
  };
  const { fetcher, count } = sources(route);
  const cache = time.cache();
  const run = (names) =>
    lookupDependencies(
      names.map((name) => dependency(name)),
      fetcher,
      undefined,
      undefined,
      undefined,
      cache,
    );

  const first = await run(["shared-a", "only-one"]);
  const second = await run(["shared-a", "only-two"]);
  assert.equal(count("detail"), 1, "The second project reuses the first project's details");
  for (const result of [first, second]) {
    const found = result.advisories.get("shared-a@1.0.0");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "high");
    assert.equal(found[0].fixed, "1.5.0");
    assert.equal(found[0].detailsUnavailable, false);
  }
  assert.equal(count("querybatch"), 2, "Queries depend on each project's own packages");

  modified = "2026-09-20T00:00:00Z";
  await run(["shared-a"]);
  assert.equal(count("detail"), 2, "A newer modified time is a new record");
  await run(["shared-a"]);
  assert.equal(count("detail"), 2);
});

test("advisory details without a modified time are not reused, and failures are not cached", async (t) => {
  const time = clock(t);
  const cache = time.cache();
  const undated = sources({
    vulnerable: ["shared-a"],
    answer: {
      querybatch: (queries) =>
        Response.json({
          results: queries.map((query) =>
            query.package.name === "shared-a" ? { vulns: [{ id: "GHSA-shared-advisory" }] } : {},
          ),
        }),
    },
  });
  for (let round = 0; round < 2; round++)
    await lookupDependencies(
      [dependency("shared-a")],
      undated.fetcher,
      undefined,
      undefined,
      undefined,
      cache,
    );
  assert.equal(undated.count("detail"), 2);

  let broken = true;
  const flaky = sources({
    vulnerable: ["shared-a"],
    respond: (call) =>
      call.kind === "detail" && broken ? new Response("", { status: 404 }) : undefined,
  });
  const failed = await lookupDependencies(
    [dependency("shared-a")],
    flaky.fetcher,
    undefined,
    undefined,
    undefined,
    cache,
  );
  assert.equal(failed.advisories.get("shared-a@1.0.0")[0].detailsUnavailable, true);
  assert.ok(failed.errors.some((error) => /advisory details are unavailable/.test(error)));
  broken = false;
  const recovered = await lookupDependencies(
    [dependency("shared-a")],
    flaky.fetcher,
    undefined,
    undefined,
    undefined,
    cache,
  );
  assert.equal(recovered.advisories.get("shared-a@1.0.0")[0].detailsUnavailable, false);
  assert.equal(flaky.count("detail"), 2);
});

test("projects scanned at the same time share one advisory-detail and one registry request", async (t) => {
  const time = clock(t);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { fetcher, count } = sources({
    vulnerable: ["shared-a"],
    respond: async (call) => {
      if (call.kind === "detail") await gate;
    },
  });
  const cache = time.cache();
  const run = (names) =>
    lookupDependencies(
      names.map((name) => dependency(name)),
      fetcher,
      undefined,
      undefined,
      undefined,
      cache,
    );
  const both = Promise.all([run(["shared-a", "shared-b"]), run(["shared-a", "shared-b"])]);
  // Both projects reach the held detail request before it is released.
  while (count("detail") < 1) await flush();
  for (let turn = 0; turn < 5; turn++) await flush();
  release();
  const [first, second] = await both;
  assert.equal(count("detail"), 1);
  assert.equal(count("registry", "shared-a"), 1);
  assert.equal(count("registry", "shared-b"), 1);
  for (const result of [first, second])
    assert.equal(result.advisories.get("shared-a@1.0.0")[0].detailsUnavailable, false);
});

test("two projects sharing dependencies send fewer requests with the shared cache (before and after)", async (t) => {
  const time = clock(t);
  const projectOne = ["shared-a", "shared-b", "shared-c", "only-one"];
  const projectTwo = ["shared-a", "shared-b", "shared-c", "only-two"];
  const scanBoth = async (cacheFor) => {
    const { fetcher, count } = sources({ vulnerable: ["shared-a", "shared-b"] });
    for (const names of [projectOne, projectTwo])
      await lookupDependencies(
        names.map((name) => dependency(name)),
        fetcher,
        undefined,
        undefined,
        undefined,
        cacheFor(),
      );
    return {
      registry: count("registry"),
      querybatch: count("querybatch"),
      detail: count("detail"),
    };
  };
  const before = await scanBoth(() => createSourceCache()); // a private cache per scan: the old behavior
  const shared = time.cache();
  const after = await scanBoth(() => shared);
  assert.deepEqual(before, { registry: 8, querybatch: 2, detail: 2 });
  assert.deepEqual(after, { registry: 5, querybatch: 2, detail: 1 });
  t.diagnostic(
    `requests for two projects sharing dependencies: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
  );
});

test("This PC reuses project metadata and reports when it was actually checked", async (t) => {
  const time = clock(t);
  const base = await realpath(await mkdtemp(join(tmpdir(), "versionstead-source-cache-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "npm", "node_modules");
  await mkdir(join(root, "shared-a"), { recursive: true });
  await writeFile(
    join(root, "shared-a", "package.json"),
    JSON.stringify({ name: "shared-a", version: "1.0.0" }),
  );
  const managers = () => [
    {
      manager: "npm",
      status: "detected",
      version: "11.0.0",
      root,
      registry: "public",
      blockedScopes: [],
      checkedAt: "2026-10-01T00:00:00.000Z",
      error: null,
    },
    {
      manager: "bun",
      status: "not-installed",
      version: null,
      root: null,
      registry: "unknown",
      blockedScopes: [],
      checkedAt: "2026-10-01T00:00:00.000Z",
      error: null,
    },
  ];
  let unavailable = false;
  const { fetcher, calls, count } = sources({
    respond: (call) => {
      if (call.kind !== "registry") return undefined;
      if (unavailable) return new Response("", { status: 503 });
      return call.headers["If-None-Match"]
        ? new Response(null, { status: 304 })
        : Response.json(metadata(call.name), { headers: { ETag: 'W/"v1"' } });
    },
  });
  const cache = time.cache();
  await lookupDependencies(
    [dependency("shared-a")],
    fetcher,
    undefined,
    undefined,
    undefined,
    cache,
  );
  assert.equal(count("registry"), 1);

  time.tick(minutes(10));
  const scanned = await inspectGlobalSources(managers(), undefined, undefined, fetcher, cache);
  assert.equal(count("registry"), 1, "The PC scan needs no second request");
  const tool = scanned.installations[0];
  assert.equal(tool.updateStatus, "available");
  assert.equal(tool.availableVersion, "2.0.0");
  assert.equal(
    tool.updateCheckedAt,
    new Date(start).toISOString(),
    "Cached data keeps its fetch time",
  );

  time.tick(minutes(25));
  const revalidated = await inspectGlobalSources(managers(), undefined, undefined, fetcher, cache);
  assert.equal(calls.at(-1).headers["If-None-Match"], 'W/"v1"');
  assert.equal(
    revalidated.installations[0].updateCheckedAt,
    new Date(start + minutes(35)).toISOString(),
  );

  time.tick(minutes(31));
  unavailable = true;
  const failed = await inspectGlobalSources(managers(), undefined, undefined, fetcher, cache);
  assert.equal(failed.installations[0].updateStatus, "unknown", "Never reported as current");
  assert.equal(failed.installations[0].updateCheckedAt, null);
  assert.equal(failed.updateChecks, "failed");
});

test("one coordinator shares registry and advisory data between its project and PC scans", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "versionstead-source-cache-")));
  let coordinator;
  t.after(async () => {
    await coordinator?.close();
    await rm(base, { recursive: true, force: true });
  });
  const project = async (name, extra) => {
    const path = join(base, name);
    await mkdir(path, { recursive: true });
    const dependencies = { "shared-a": "^1.0.0", ...extra };
    await writeFile(join(path, "package.json"), JSON.stringify({ name, dependencies }));
    await writeFile(
      join(path, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name, dependencies },
          ...Object.fromEntries(
            Object.keys(dependencies).map((dep) => [
              `node_modules/${dep}`,
              {
                version: "1.0.0",
                resolved: `https://registry.npmjs.org/${dep}/-/${dep}-1.0.0.tgz`,
              },
            ]),
          ),
        },
      }),
    );
    return path;
  };
  const root = join(base, "global", "node_modules");
  await mkdir(join(root, "shared-a"), { recursive: true });
  await writeFile(
    join(root, "shared-a", "package.json"),
    JSON.stringify({ name: "shared-a", version: "1.0.0" }),
  );
  const { fetcher, count } = sources({ vulnerable: ["shared-a"] });
  t.mock.method(globalThis, "fetch", fetcher);
  coordinator = new MonitoringCoordinator({
    dataDir: join(base, "state"),
    mode: "background",
    nativeVersionLookup: false,
  });
  coordinator.changeSettings({ paused: true });
  await coordinator.changeGlobalToolSources([
    {
      manager: "npm",
      status: "detected",
      version: "11.0.0",
      root,
      registry: "public",
      blockedScopes: [],
      checkedAt: "2026-10-01T00:00:00.000Z",
      error: null,
    },
    {
      manager: "bun",
      status: "not-installed",
      version: null,
      root: null,
      registry: "unknown",
      blockedScopes: [],
      checkedAt: "2026-10-01T00:00:00.000Z",
      error: null,
    },
  ]);
  const one = await coordinator.addProject({
    path: await project("one", { "only-one": "^1.0.0" }),
    mode: "maintained",
  });
  const two = await coordinator.addProject({
    path: await project("two", { "only-two": "^1.0.0" }),
    mode: "maintained",
  });
  const scan = async (request) => {
    const previous = coordinator.snapshot().history[0]?.id;
    coordinator.requestScan(request);
    const giveUp = performance.now() + 20000;
    while (true) {
      const latest = coordinator.snapshot().history[0];
      if (latest?.id !== previous && latest?.status !== "scanning") return latest;
      assert.ok(performance.now() < giveUp, "Timed out waiting for a scan");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await scan({ target: "projects", projectId: one.id });
  await scan({ target: "projects", projectId: two.id });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const pc = await scan({ target: "pc" });
  assert.equal(
    count("registry", "shared-a"),
    1,
    "Both projects and the PC share one metadata request",
  );
  assert.equal(count("registry", "only-one"), 1);
  assert.equal(count("registry", "only-two"), 1);
  assert.equal(count("detail"), 1, "Both projects share one advisory-detail request");
  assert.notEqual(pc.status, "failed");
  const installed = coordinator
    .snapshot()
    .inventory.installations.find((i) => i.name === "shared-a");
  assert.equal(installed.updateStatus, "available");
  assert.ok(
    Date.parse(installed.updateCheckedAt) < Date.parse(pc.startedAt),
    "The PC reports when the registry data was fetched, not when its own scan ran",
  );
});
