import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ChangeSettings, MonitoringSettings } from "@versionstead/contracts/monitoring";
import * as Schema from "effect/Schema";
import { lookupDependencies } from "../dist/adapters/lookups.js";
import { lookupReleaseFacts } from "../dist/adapters/release-facts.js";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import { MonitoringStorage } from "../dist/storage.js";

// Windows cannot delete a SQLite database that is still open. The directories are removed once,
// after every test has run its own `finally` and closed its storage.
const directories = [];
after(() =>
  Promise.all(
    directories.map((path) =>
      rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  ),
);
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "versionstead-release-facts-"));
  directories.push(path);
  return path;
}

function memoryCache() {
  const rows = new Map();
  const pruned = [];
  return {
    rows,
    pruned,
    readSource: (key) => rows.get(key) ?? null,
    writeSource: (key, value, fetchedAt) =>
      rows.set(key, { value: structuredClone(value), fetchedAt }),
    pruneSources: (prefix, keep) => pruned.push([prefix, keep]),
  };
}
// The shape deps.dev API v3 GetVersion returned on 2026-10-08, extras included.
const depsDev = (name, version, changes = {}) => ({
  versionKey: { system: "NPM", name, version },
  publishedAt: "2026-10-08T06:00:00Z",
  isDefault: true,
  isDeprecated: false,
  deprecatedReason: "",
  licenses: ["MIT"],
  advisoryKeys: [],
  links: [{ label: "SOURCE_REPO", url: "git+https://github.com/example/example.git" }],
  slsaProvenances: [
    {
      sourceRepository: "https://github.com/example/example",
      commit: "0".repeat(40),
      url: `https://registry.npmjs.org/-/npm/v1/attestations/${name}@${version}`,
      verified: true,
    },
  ],
  attestations: [],
  registries: ["https://registry.npmjs.org/"],
  ...changes,
});
const requested = (url) => decodeURIComponent(url.split("/packages/")[1].split("/")[0]);
// A right-to-left override: a bidirectional control that must not survive into a displayed license.
const override = String.fromCodePoint(0x202e);

test("deps.dev facts are parsed, cached for good, and only names and versions are sent", async () => {
  const cache = memoryCache();
  const sent = [];
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { Accept: "application/json" });
    assert.ok(options.method === undefined && options.body === undefined, "A plain GET");
    sent.push(url);
    const match =
      /^https:\/\/api\.deps\.dev\/v3\/systems\/npm\/packages\/([^/]+)\/versions\/([^/]+)$/.exec(
        url,
      );
    assert.ok(match, url);
    return Response.json(depsDev(decodeURIComponent(match[1]), decodeURIComponent(match[2])));
  };
  const progress = [];
  const first = await lookupReleaseFacts(
    [
      { name: "@types/node", version: "24.0.0" },
      { name: "esbuild", version: "0.28.2" },
      { name: "esbuild", version: "0.28.2" },
      { name: "tool", version: "2.0.0-rc.1+build.5" },
    ],
    cache,
    fetcher,
    undefined,
    (completed, total) => progress.push([completed, total]),
  );
  assert.deepEqual(sent.sort(), [
    "https://api.deps.dev/v3/systems/npm/packages/%40types%2Fnode/versions/24.0.0",
    "https://api.deps.dev/v3/systems/npm/packages/esbuild/versions/0.28.2",
    "https://api.deps.dev/v3/systems/npm/packages/tool/versions/2.0.0-rc.1%2Bbuild.5",
  ]);
  assert.deepEqual(first.facts.get("esbuild@0.28.2"), {
    publishedAt: "2026-10-08T06:00:00.000Z",
    license: "MIT",
    provenance: true,
  });
  assert.deepEqual([first.checked, first.total], [3, 3]);
  assert.deepEqual(
    progress,
    [
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ],
    "Progress counts each release asked about once",
  );
  assert.deepEqual(cache.pruned, [["deps.dev:", 10_000]], "The newest 10,000 answers are kept");
  assert.ok(cache.rows.has("deps.dev:npm:@types/node@24.0.0"));
  // A throwing fetcher would not do: the shared request code swallows what a fetcher throws.
  const asked = [];
  const again = await lookupReleaseFacts(
    [{ name: "esbuild", version: "0.28.2" }],
    cache,
    async (url) => {
      asked.push(url);
      return Response.json(depsDev("esbuild", "0.28.2"));
    },
  );
  assert.deepEqual(asked, [], "A cached release is never asked again");
  assert.deepEqual(again.facts.get("esbuild@0.28.2"), first.facts.get("esbuild@0.28.2"));
  const offlineProgress = [];
  const offline = await lookupReleaseFacts(
    [
      { name: "esbuild", version: "0.28.2" },
      { name: "left-pad", version: "1.3.0" },
    ],
    cache,
    null,
    undefined,
    (completed, total) => offlineProgress.push([completed, total]),
  );
  assert.deepEqual(
    [offline.checked, offline.total],
    [1, 2],
    "Without a fetcher only cached facts are known",
  );
  assert.deepEqual(offlineProgress, [[0, 1]], "and nothing is asked");
});

test("deps.dev 404s, other identities, outages and odd names stay unknown and are asked again", async () => {
  const cache = memoryCache();
  const sent = [];
  const answers = {
    "fresh-release": () => new Response("version not found", { status: 404 }),
    renamed: () => Response.json(depsDev("someone-else", "1.0.0")),
    "other-version": () => Response.json(depsDev("other-version", "1.0.1")),
    "other-system": () =>
      Response.json({
        ...depsDev("other-system", "1.0.0"),
        versionKey: { system: "PYPI", name: "other-system", version: "1.0.0" },
      }),
    // Not retried by the lookups' one-retry rule, which a thrown error, a 429 or a 503 would trigger.
    flaky: () => new Response("down", { status: 500 }),
    "no-facts": () =>
      Response.json({ versionKey: { system: "NPM", name: "no-facts", version: "1.0.0" } }),
    "odd-license": () =>
      Response.json(
        depsDev("odd-license", "1.0.0", {
          licenses: [
            `MIT <b>x</b>${override}${"y".repeat(400)}`,
            "  ",
            "Apache-2.0",
            ...Array(3).fill("z".repeat(150)),
          ],
        }),
      ),
  };
  const fetcher = async (url) => {
    const name = requested(url);
    sent.push(name);
    return answers[name]();
  };
  const candidates = [
    ...Object.keys(answers).map((name) => ({ name, version: "1.0.0" })),
    { name: "../escape", version: "1.0.0" },
    { name: "@scope/", version: "1.0.0" },
    { name: "name?query=1", version: "1.0.0" },
    { name: "x".repeat(215), version: "1.0.0" },
    { name: "", version: "1.0.0" },
    { name: "valid-name", version: "latest" },
    { name: "valid-name", version: "^1.0.0" },
    { name: "valid-name", version: "1.0.0/../x" },
  ];
  const result = await lookupReleaseFacts(candidates, cache, fetcher);
  assert.deepEqual(
    sent.sort(),
    Object.keys(answers).sort(),
    "Invalid names and versions are never sent",
  );
  assert.deepEqual([...result.facts.keys()].sort(), ["no-facts@1.0.0", "odd-license@1.0.0"]);
  assert.equal(result.checked, 1, "Only an answer with a publish time counts as checked");
  assert.deepEqual(result.facts.get("no-facts@1.0.0"), {
    publishedAt: null,
    license: null,
    provenance: false,
  });
  const license = result.facts.get("odd-license@1.0.0").license;
  assert.ok(license.length <= 200);
  assert.ok(license.includes(", Apache-2.0, "), "A long first license does not crowd out the rest");
  assert.ok(!license.includes(", ,"), "A blank license is left out");
  assert.ok(!license.includes(override));
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(license), "No control or format characters remain");
  assert.equal(result.total, Object.keys(answers).length);
  assert.deepEqual(
    [...cache.rows.keys()],
    ["deps.dev:npm:odd-license@1.0.0"],
    "Only a release deps.dev answered for, with its publish time, is cached",
  );
  sent.length = 0;
  await lookupReleaseFacts(candidates, cache, fetcher);
  assert.deepEqual(
    sent.sort(),
    ["flaky", "fresh-release", "no-facts", "other-system", "other-version", "renamed"],
    "Unknown answers, and an answer without a publish time, are asked again",
  );
});

test("provenance needs a verified entry, and answers outside the bounds are refused", async () => {
  const bodies = {
    "verified-attestation": depsDev("verified-attestation", "1.0.0", {
      slsaProvenances: [],
      attestations: [{ verified: true }],
    }),
    unverified: depsDev("unverified", "1.0.0", {
      slsaProvenances: [{ verified: false }, {}],
      attestations: [{ verified: false }],
    }),
    offset: depsDev("offset", "1.0.0", { publishedAt: "2026-10-08T08:00:00+02:00" }),
    "many-licenses": depsDev("many-licenses", "1.0.0", { licenses: Array(21).fill("MIT") }),
    "long-license": depsDev("long-license", "1.0.0", { licenses: ["L".repeat(501)] }),
    "many-proofs": depsDev("many-proofs", "1.0.0", { attestations: Array(101).fill({}) }),
    "bad-type": depsDev("bad-type", "1.0.0", { publishedAt: 20261008 }),
    oversized: { ...depsDev("oversized", "1.0.0"), padding: "x".repeat(1024 * 1024) },
  };
  const cache = memoryCache();
  const { facts, total } = await lookupReleaseFacts(
    Object.keys(bodies).map((name) => ({ name, version: "1.0.0" })),
    cache,
    async (url) => Response.json(bodies[requested(url)]),
  );
  assert.equal(total, 8);
  assert.deepEqual(
    [...facts.keys()].sort(),
    ["offset@1.0.0", "unverified@1.0.0", "verified-attestation@1.0.0"],
    "An answer that breaks the schema or the 1 MiB limit is unknown",
  );
  assert.equal(cache.rows.size, 3);
  assert.equal(facts.get("verified-attestation@1.0.0").provenance, true);
  assert.equal(facts.get("unverified@1.0.0").provenance, false, "Unverified is not attested");
  assert.equal(facts.get("offset@1.0.0").publishedAt, "2026-10-08T06:00:00.000Z");
});

test("a publish time must be an RFC 3339 instant naming a real day, or the whole answer is unknown", async () => {
  // Read and written the way toISOString writes a time.
  const accepted = [
    ["2026-10-08T06:00:00Z", "2026-10-08T06:00:00.000Z"],
    ["2026-10-08T06:00:00.123456789Z", "2026-10-08T06:00:00.123Z"],
    ["2026-10-08T08:00:00+02:00", "2026-10-08T06:00:00.000Z"],
    ["2026-10-08T01:00:00.5-05:00", "2026-10-08T06:00:00.500Z"],
    ["2024-02-29T12:00:00Z", "2024-02-29T12:00:00.000Z"],
  ];
  // Each of these is read differently by another parser, or by another time zone, or rolls over.
  const refused = [
    "1",
    "Oct 8 2026",
    "yesterday",
    "2026-02-31T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-10-08T24:00:00Z",
    "2026-10-08T06:00:00",
    "2026-10-08",
    "2026-10-08 06:00:00Z",
    "2026-10-08t06:00:00z",
    "2026-10-08T06:00:00z",
    "2026-10-08T06:00:00+99:99",
    "2026-10-08T06:00:00.1234567890Z",
    "",
    20261008,
  ];
  const times = [...accepted.map(([time]) => time), ...refused];
  // A time without a zone reads as UTC on a machine set to UTC, where only its format gives it
  // away, and differently on any other: the verdict must be the same under both.
  const zone = process.env.TZ;
  try {
    for (const tz of ["UTC", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      const cache = memoryCache();
      const { facts, total } = await lookupReleaseFacts(
        times.map((_, index) => ({ name: `time-${index}`, version: "1.0.0" })),
        cache,
        async (url) =>
          Response.json(
            depsDev(requested(url), "1.0.0", {
              publishedAt: times[Number(requested(url).slice(5))],
            }),
          ),
      );
      assert.equal(total, times.length);
      accepted.forEach(([time, instant], index) =>
        assert.equal(facts.get(`time-${index}@1.0.0`)?.publishedAt, instant, `${tz}: ${time}`),
      );
      refused.forEach((time, index) => {
        const name = `time-${accepted.length + index}@1.0.0`;
        const shown = `${tz}: ${JSON.stringify(time)}`;
        assert.equal(facts.has(name), false, `${shown} makes the answer unknown`);
        assert.equal(cache.rows.has(`deps.dev:npm:${name}`), false, `${shown} is not cached`);
      });
      assert.equal(cache.rows.size, accepted.length);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("an answer without a publish time is used now and asked for again, so the time can arrive later", async () => {
  const cache = memoryCache();
  const sent = [];
  let body = {
    versionKey: { system: "NPM", name: "new-release", version: "1.0.0" },
    licenses: ["MIT"],
  };
  const fetcher = async (url) => {
    sent.push(url);
    return Response.json(body);
  };
  const candidates = [{ name: "new-release", version: "1.0.0" }];
  const first = await lookupReleaseFacts(candidates, cache, fetcher);
  assert.deepEqual(first.facts.get("new-release@1.0.0"), {
    publishedAt: null,
    license: "MIT",
    provenance: false,
  });
  assert.deepEqual(
    [first.checked, first.total],
    [0, 1],
    "An answer without a publish time is used but not counted as checked",
  );
  assert.equal(cache.rows.size, 0, "Nothing is kept without the time the cooldown needs");
  body = { ...body, publishedAt: "2026-10-08T06:00:00Z" };
  const second = await lookupReleaseFacts(candidates, cache, fetcher);
  assert.equal(sent.length, 2, "Asked again");
  assert.equal(second.facts.get("new-release@1.0.0").publishedAt, "2026-10-08T06:00:00.000Z");
  assert.deepEqual([second.checked, second.total], [1, 1]);
  assert.equal(cache.rows.size, 1);
  await lookupReleaseFacts(candidates, cache, fetcher);
  assert.equal(sent.length, 2, "Once it has its time the release is cached for good");
});

test("a damaged, unreadable or unwritable cache never fails a lookup", async () => {
  const candidates = [{ name: "esbuild", version: "0.28.2" }];
  const sent = [];
  const fetcher = async (url) => {
    sent.push(url);
    return Response.json(depsDev("esbuild", "0.28.2"));
  };
  const cache = memoryCache();
  cache.rows.set("deps.dev:npm:esbuild@0.28.2", {
    value: { publishedAt: 42, license: null },
    fetchedAt: "2026-10-08T00:00:00.000Z",
  });
  const repaired = await lookupReleaseFacts(candidates, cache, fetcher);
  assert.equal(sent.length, 1, "A damaged cached answer is asked again");
  assert.equal(repaired.facts.get("esbuild@0.28.2").license, "MIT");
  assert.equal(cache.rows.get("deps.dev:npm:esbuild@0.28.2").value.license, "MIT", "and replaced");
  // An answer kept without its publish time, as an earlier build could have, is damaged too.
  cache.rows.set("deps.dev:npm:esbuild@0.28.2", {
    value: { publishedAt: null, license: "MIT", provenance: false },
    fetchedAt: "2026-10-08T00:00:00.000Z",
  });
  const dated = await lookupReleaseFacts(candidates, cache, fetcher);
  assert.equal(sent.length, 2, "so an undated cached answer is asked again");
  assert.equal(dated.facts.get("esbuild@0.28.2").publishedAt, "2026-10-08T06:00:00.000Z");
  const failing = (message) => () => {
    throw new Error(message);
  };
  const locked = await lookupReleaseFacts(
    candidates,
    {
      readSource: failing("database is locked"),
      writeSource: failing("disk is full"),
      pruneSources: failing("disk is full"),
    },
    fetcher,
  );
  assert.equal(sent.length, 3, "A cache that cannot be read is no cache");
  assert.equal(locked.facts.get("esbuild@0.28.2").provenance, true, "The answer is still used");
});

test(
  "cancelling a scan stops the request in flight and the ones not yet sent",
  {
    timeout: 5000,
  },
  async () => {
    const cache = memoryCache();
    const sent = [];
    const cancelled = new AbortController();
    cancelled.abort();
    const idle = await lookupReleaseFacts(
      [{ name: "esbuild", version: "0.28.2" }],
      cache,
      async (url) => {
        sent.push(url);
        return Response.json(depsDev("esbuild", "0.28.2"));
      },
      cancelled.signal,
    );
    assert.deepEqual([sent.length, idle.facts.size, cache.rows.size], [0, 0, 0]);
    const scan = new AbortController();
    // The owner presses Cancel while this request is out: only the scan's signal can end it.
    const hanging = (url, options) =>
      new Promise((_, reject) => {
        sent.push(url);
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
        scan.abort();
      });
    const result = await lookupReleaseFacts(
      ["a", "b", "c", "d", "e", "f"].map((name) => ({ name, version: "1.0.0" })),
      cache,
      hanging,
      scan.signal,
    );
    assert.equal(sent.length, 1, "Nothing more is sent after the first request is cancelled");
    assert.deepEqual([result.facts.size, cache.rows.size, result.total], [0, 0, 6]);
  },
);

test("release facts are kept in the SQLite store between runs", async () => {
  const dataDir = join(await temporary(), "state");
  const candidates = [{ name: "esbuild", version: "0.28.2" }];
  const first = new MonitoringStorage(dataDir);
  try {
    await lookupReleaseFacts(candidates, first, async () =>
      Response.json(depsDev("esbuild", "0.28.2")),
    );
    assert.equal(first.readSource("deps.dev:npm:esbuild@0.28.2")?.value.license, "MIT");
  } finally {
    first.close();
  }
  const second = new MonitoringStorage(dataDir);
  try {
    // No fetcher: the facts must come from the database.
    const result = await lookupReleaseFacts(candidates, second, null);
    assert.deepEqual(result.facts.get("esbuild@0.28.2"), {
      publishedAt: "2026-10-08T06:00:00.000Z",
      license: "MIT",
      provenance: true,
    });
    assert.deepEqual([result.checked, result.total], [1, 1]);
  } finally {
    second.close();
  }
});

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
// A project whose one direct dependency, `alias`, is the public package `public-example` 1.0.0.
async function aliasFixture(root) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { alias: "npm:public-example@^1.0.0" } }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", dependencies: { alias: "npm:public-example@^1.0.0" } },
        "node_modules/alias": {
          name: "public-example",
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/public-example/-/public-example-1.0.0.tgz",
        },
      },
    }),
  );
}
// A dependency lookup that offers `version` as the update of the dependencies `offered` accepts.
const offering =
  (version, offered = (d) => d.name === "alias") =>
  async (dependencies) => ({
    dependencies: dependencies.map((d) => ({
      ...d,
      availableVersion: offered(d) ? version : null,
      versionStatus: "checked",
      advisoryStatus: "checked",
    })),
    versionChecked: new Set(dependencies.map((d) => d.id)),
    advisories: new Map(),
    coverage: [],
    errors: [],
  });
const withUpdate = offering("1.5.0");
const updateOf = (coordinator) => coordinator.snapshot().findings.find((f) => f.kind === "update");
const wireUpdate = (coordinator) =>
  JSON.parse(coordinator.snapshotJson()).findings.find((f) => f.kind === "update");
const facts = (finding) => [finding.publishedAt, finding.license, finding.provenance];
const coverageNote = (checked, total) =>
  `Release age, license and provenance (deps.dev): ${checked}/${total} update candidates`;
const releaseUrl = (name, version) =>
  `https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(name)}/versions/${version}`;

test("update findings carry deps.dev facts once, and the Settings switch stops the lookups", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  const sent = [];
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate,
    sourceFetch: async (url, options) => {
      assert.equal(options.redirect, "error");
      sent.push(url);
      return Response.json(depsDev("public-example", "1.5.0"));
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const release = (settings) => [settings.releaseCooldownDays, settings.useDepsDev];
  assert.deepEqual(release(coordinator.snapshot().settings), [3, true]);
  assert.deepEqual(
    release(coordinator.progressSnapshot().settings),
    [3, true],
    "The tray reads them",
  );
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  const scan = () => finishScan(coordinator, { target: "projects", projectId: project.id });
  await scan();
  const known = ["2026-10-08T06:00:00.000Z", "MIT", true];
  assert.deepEqual(facts(updateOf(coordinator)), known);
  assert.deepEqual(facts(wireUpdate(coordinator)), known, "and the API sends them");
  assert.deepEqual(sent, [releaseUrl("public-example", "1.5.0")]);
  assert.ok(coordinator.snapshot().projects[0].evidence.coverage.includes(coverageNote(1, 1)));
  await scan();
  assert.equal(sent.length, 1, "A cached release is not asked again");
  coordinator.changeSettings({ useDepsDev: false });
  await scan();
  const off = coordinator.snapshot();
  assert.deepEqual(facts(updateOf(coordinator)), [undefined, undefined, undefined]);
  assert.ok(
    off.projects[0].evidence.coverage.includes(
      "deps.dev lookups are off; release age, license and provenance are unknown.",
    ),
  );
  assert.equal(
    off.projects[0].evidence.status,
    "complete",
    "Unknown facts are a note, not an error",
  );
  assert.equal(sent.length, 1, "Nothing is sent while the lookups are off");
  coordinator.changeSettings({ useDepsDev: true });
  await scan();
  assert.deepEqual(facts(updateOf(coordinator)), known);
  assert.equal(sent.length, 1, "Switching the lookups back on reads the cached release");

  for (const releaseCooldownDays of [31, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3"])
    assert.throws(() => coordinator.changeSettings({ releaseCooldownDays }), /0 to 30/);
  assert.throws(() => coordinator.changeSettings({ useDepsDev: "no" }), /Invalid monitoring/);
  assert.deepEqual(
    release(coordinator.snapshot().settings),
    [3, true],
    "A refused change changes nothing",
  );
  assert.equal(coordinator.changeSettings({ releaseCooldownDays: 0 }).releaseCooldownDays, 0);
  assert.equal(coordinator.changeSettings({ releaseCooldownDays: 30 }).releaseCooldownDays, 30);
});

test("private registry dependencies never reach deps.dev, and the same one on the public registry does", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  await writeFile(join(projectRoot, ".npmrc"), "registry=https://private.example.invalid\n");
  const registryRequests = [];
  const sent = [];
  const registry = async (url) => {
    if (url.endsWith("/querybatch")) return Response.json({ results: [{}] });
    registryRequests.push(url);
    return Response.json({
      name: "public-example",
      "dist-tags": { latest: "1.5.0" },
      versions: { "1.0.0": {}, "1.5.0": {} },
    });
  };
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    // The real lookup decides which dependencies are public; deps.dev only hears about its candidates.
    dependencyLookup: (dependencies, signal, progress) =>
      lookupDependencies(dependencies, registry, signal, progress),
    sourceFetch: async (url) => {
      sent.push(url);
      return Response.json(depsDev("public-example", "1.5.0"));
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  assert.deepEqual(registryRequests, [], "A private registry is not asked for versions");
  assert.deepEqual(sent, []);
  assert.equal(updateOf(coordinator), undefined);
  // The control: without the private registry the very same dependency is a public candidate.
  await rm(join(projectRoot, ".npmrc"));
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  assert.equal(registryRequests.length, 1);
  assert.deepEqual(sent, [releaseUrl("public-example", "1.5.0")]);
  assert.deepEqual(facts(updateOf(coordinator)), ["2026-10-08T06:00:00.000Z", "MIT", true]);
});

test("deps.dev not knowing a release, answering for another, or being down leaves the facts unknown and the scan complete", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  const sent = [];
  let answer;
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate,
    sourceFetch: async (url) => {
      sent.push(url);
      return answer();
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  const scan = () => finishScan(coordinator, { target: "projects", projectId: project.id });
  const cases = {
    "a release deps.dev has not ingested yet": () => new Response("not found", { status: 404 }),
    "another package": () => Response.json(depsDev("someone-else", "1.5.0")),
    "an outage": () => new Response("down", { status: 500 }),
    // Retried once after a short pause, then given up on.
    "a connection that fails": () => {
      throw new TypeError("fetch failed");
    },
  };
  for (const [label, respond] of Object.entries(cases)) {
    answer = respond;
    const before = sent.length;
    await scan();
    const snapshot = coordinator.snapshot();
    const evidence = snapshot.projects[0].evidence;
    assert.ok(sent.length > before, `${label}: asked again on every scan`);
    assert.ok(
      snapshot.findings.some((f) => f.kind === "update"),
      label,
    );
    assert.deepEqual(facts(updateOf(coordinator)), [undefined, undefined, undefined], label);
    assert.equal(evidence.status, "complete", `${label}: deps.dev never fails or degrades a scan`);
    assert.deepEqual(evidence.errors, [], label);
    assert.equal(
      snapshot.findings.some((f) => f.kind === "coverage"),
      false,
      label,
    );
    assert.ok(
      evidence.coverage.includes(coverageNote(0, 1)),
      `${label}: the gap is in the coverage`,
    );
  }
  // Once deps.dev knows the release, the next scan has the facts: nothing unknown was cached.
  answer = () => Response.json(depsDev("public-example", "1.5.0"));
  await scan();
  assert.deepEqual(facts(updateOf(coordinator)), ["2026-10-08T06:00:00.000Z", "MIT", true]);
  assert.ok(coordinator.snapshot().projects[0].evidence.coverage.includes(coverageNote(1, 1)));
});

test("global tool updates on This PC carry deps.dev facts, one request per release", async (t) => {
  const root = await temporary();
  const tool = (extra) => ({
    id: "tool-npm",
    name: "tool",
    packageId: "tool",
    manager: "npm",
    rootId: "root-npm",
    origin: "registry",
    version: "1.0.0",
    source: "npm global",
    scope: "user",
    channel: "Stable",
    availableVersion: "2.0.0",
    updateStatus: "available",
    updateCheckedAt: new Date().toISOString(),
    ...extra,
  });
  const sent = [];
  // One object for every scan, as a lookup may hand out: the scan must not write its notes into it.
  const inventory = {
    installations: [tool(), tool({ id: "tool-bun", manager: "bun", rootId: "root-bun" })],
    managers: [],
    checkedRoots: [],
    coverage: [],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  };
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    inventoryLookup: async () => inventory,
    sourceFetch: async (url) => {
      sent.push(url);
      return Response.json(
        depsDev("tool", "2.0.0", { licenses: ["Apache-2.0"], slsaProvenances: [] }),
      );
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  await finishScan(coordinator, { target: "pc" });
  const updates = coordinator.snapshot().findings.filter((f) => f.kind === "update");
  assert.equal(updates.length, 2, "One update for each installation");
  for (const update of updates)
    assert.deepEqual(
      facts(update),
      ["2026-10-08T06:00:00.000Z", "Apache-2.0", undefined],
      "No provenance is unknown, not a negative signal",
    );
  assert.deepEqual(sent, [releaseUrl("tool", "2.0.0")]);
  assert.ok(coordinator.snapshot().inventory.evidence.coverage.includes(coverageNote(1, 1)));
  assert.deepEqual(inventory.coverage, []);
  coordinator.changeSettings({ useDepsDev: false });
  await finishScan(coordinator, { target: "pc" });
  const off = coordinator.snapshot();
  for (const update of off.findings.filter((f) => f.kind === "update"))
    assert.deepEqual(facts(update), [undefined, undefined, undefined]);
  const notes = off.inventory.evidence.coverage.filter((line) =>
    /deps\.dev|Release age/.test(line),
  );
  assert.deepEqual(
    notes,
    ["deps.dev lookups are off; release age, license and provenance are unknown."],
    "The note of the earlier scan is not carried over",
  );
  assert.equal(sent.length, 1);
  assert.deepEqual(inventory.coverage, []);
});

test("the scan reports a release-facts stage with real counts while deps.dev is asked", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  let open;
  const answered = new Promise((resolve) => (open = resolve));
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate,
    sourceFetch: async () => {
      await answered;
      return Response.json(depsDev("public-example", "1.5.0"));
    },
  });
  // Registered first, so a failed assertion cannot leave the request hanging when the coordinator closes.
  t.after(() => open());
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  coordinator.requestScan({ target: "projects", projectId: project.id });
  // The progress is read through the contract, as the HTTP API and the tray read it.
  const current = () => coordinator.progressSnapshot().scanProgress.active;
  await waitFor(() => current()?.stage === "release-facts");
  const active = current();
  assert.deepEqual([active.kind, active.completed, active.total], ["project", 0, 1]);
  assert.equal(JSON.parse(coordinator.snapshotJson()).scanProgress.active.stage, "release-facts");
  open();
  await waitFor(() => coordinator.snapshot().history[0].status !== "scanning");
  assert.equal(coordinator.snapshot().history[0].status, "complete");
  assert.deepEqual(facts(updateOf(coordinator)), ["2026-10-08T06:00:00.000Z", "MIT", true]);
});

test("the contract takes a whole number of cooldown days from 0 to 30 and a true or false switch", () => {
  const change = Schema.decodeUnknownSync(ChangeSettings);
  for (const releaseCooldownDays of [0, 3, 30])
    assert.equal(change({ releaseCooldownDays }).releaseCooldownDays, releaseCooldownDays);
  for (const releaseCooldownDays of [-1, 31, 1.5, "3", null, Number.NaN])
    assert.throws(() => change({ releaseCooldownDays }), undefined, String(releaseCooldownDays));
  for (const useDepsDev of [true, false])
    assert.equal(change({ useDepsDev }).useDepsDev, useDepsDev);
  for (const useDepsDev of ["no", 1, null])
    assert.throws(() => change({ useDepsDev }), undefined, String(useDepsDev));
  // The saved settings follow the same bounds, and settings saved before these fields still read.
  const stored = Schema.decodeUnknownSync(MonitoringSettings);
  const settings = {
    paused: false,
    pcIntervalMinutes: 360,
    projectIntervalMinutes: 60,
    notifyNewFindings: true,
  };
  assert.deepEqual(stored(settings), settings);
  assert.deepEqual(stored({ ...settings, releaseCooldownDays: 7, useDepsDev: false }), {
    ...settings,
    releaseCooldownDays: 7,
    useDepsDev: false,
  });
  assert.throws(() => stored({ ...settings, releaseCooldownDays: 31 }));
  assert.throws(() => stored({ ...settings, useDepsDev: "yes" }));
});

test("the release settings survive a restart, and a database from before them gets the defaults", async (t) => {
  const dataDir = join(await temporary(), "state");
  const release = (coordinator) => {
    const { releaseCooldownDays, useDepsDev } = coordinator.snapshot().settings;
    return [releaseCooldownDays, useDepsDev];
  };
  let coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  try {
    coordinator.changeSettings({ releaseCooldownDays: 7, useDepsDev: false });
  } finally {
    await coordinator.close();
  }
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  try {
    assert.deepEqual(
      release(coordinator),
      [7, false],
      "A saved choice is not reset to the defaults",
    );
  } finally {
    await coordinator.close();
  }
  // Settings saved by a build without these two fields.
  const storage = new MonitoringStorage(dataDir);
  try {
    const stored = storage.read();
    delete stored.snapshot.settings.releaseCooldownDays;
    delete stored.snapshot.settings.useDepsDev;
    storage.write(stored);
  } finally {
    storage.close();
  }
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  t.after(() => coordinator.close());
  assert.deepEqual(release(coordinator), [3, true]);
  const { settings } = JSON.parse(coordinator.snapshotJson());
  assert.deepEqual([settings.releaseCooldownDays, settings.useDepsDev], [3, true]);
});

test("a project asks deps.dev about public registry packages only, even when a lookup offers updates for the rest", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const dependencies = {
    alias: "npm:public-example@^1.0.0",
    "@acme/internal": "^1.0.0",
    "git-lib": "github:owner/git-lib",
    "local-lib": "file:../local-lib",
  };
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({ name: "fixture", dependencies }),
  );
  // The @acme scope is routed to a private registry, so its packages are not public.
  await writeFile(join(projectRoot, ".npmrc"), "@acme:registry=https://private.example.invalid\n");
  await writeFile(
    join(projectRoot, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", dependencies },
        "node_modules/alias": {
          name: "public-example",
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/public-example/-/public-example-1.0.0.tgz",
        },
        "node_modules/@acme/internal": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/@acme/internal/-/internal-1.0.0.tgz",
        },
        "node_modules/git-lib": {
          version: "1.0.0",
          resolved:
            "git+ssh://git@github.com/owner/git-lib.git#0123456789abcdef0123456789abcdef01234567",
        },
        "node_modules/local-lib": { resolved: "../local-lib", link: true },
        "../local-lib": { version: "1.0.0" },
      },
    }),
  );
  const sent = [];
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    // The call site must not depend on the lookup having left the others out.
    dependencyLookup: offering("9.0.0", (d) => d.role !== "transitive"),
    sourceFetch: async (url) => {
      sent.push(url);
      return Response.json(depsDev(requested(url), "9.0.0"));
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  const snapshot = coordinator.snapshot();
  assert.deepEqual(
    snapshot.projects[0].dependencies.map((d) => [d.name, d.origin]).sort(),
    [
      ["@acme/internal", "unknown"],
      ["alias", "registry"],
      ["git-lib", "git"],
      ["local-lib", "workspace"],
    ],
    "The fixture holds one public, one private, one Git and one linked dependency",
  );
  const updates = snapshot.findings.filter((f) => f.kind === "update");
  assert.equal(updates.length, 4, "Each of them was offered an update");
  assert.deepEqual(sent, [releaseUrl("public-example", "9.0.0")]);
  assert.deepEqual(
    updates.filter((f) => f.publishedAt !== undefined).map((f) => f.packageName),
    ["public-example"],
  );
  assert.ok(snapshot.projects[0].evidence.coverage.includes(coverageNote(1, 1)));
});

test("This PC asks deps.dev about public npm tools only, also for an update kept from an earlier scan", async (t) => {
  const root = await temporary();
  const tool = (extra) => ({
    id: "tool-npm",
    name: "tool",
    packageId: "tool",
    manager: "npm",
    rootId: "root-npm",
    origin: "registry",
    version: "1.0.0",
    source: "npm global",
    scope: "user",
    channel: "Stable",
    availableVersion: "3.0.0",
    updateStatus: "available",
    updateCheckedAt: new Date().toISOString(),
    ...extra,
  });
  // The same tool in three states: found on the public registry, linked from a local checkout, and
  // on the public registry again but with its update check failed.
  const states = {
    public: tool(),
    linked: tool({ origin: "local", availableVersion: null, updateStatus: "unknown" }),
    unverified: tool({ availableVersion: null, updateStatus: "unknown" }),
  };
  let state = "public";
  const sent = [];
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    inventoryLookup: async () => ({
      installations: [states[state]],
      managers: [],
      checkedRoots: [],
      coverage: [],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: "complete",
    }),
    // deps.dev has not ingested the release: nothing is cached, so every scan may ask again.
    sourceFetch: async (url) => {
      sent.push(url);
      return new Response("not found", { status: 404 });
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const scan = async (next) => {
    state = next;
    await finishScan(coordinator, { target: "pc" });
    return coordinator.snapshot().findings.filter((f) => f.kind === "update");
  };
  assert.equal((await scan("public")).length, 1);
  assert.deepEqual(sent, [releaseUrl("tool", "3.0.0")]);

  const kept = await scan("linked");
  assert.deepEqual(
    kept.map((f) => [f.packageName, f.availableVersion]),
    [["tool", "3.0.0"]],
    "The update found earlier is kept, unverified",
  );
  assert.equal(sent.length, 1, "A linked tool is not a public package: nothing is asked");
  assert.ok(
    !coordinator.snapshot().inventory.evidence.coverage.includes(coverageNote(0, 1)),
    "and no release check is claimed for it",
  );

  assert.equal((await scan("unverified")).length, 1);
  assert.equal(sent.length, 2, "A public tool whose update check failed is still asked");
});

// A deps.dev that never answers: only the scan's own signal ends the request, which would otherwise
// last 12 seconds, hence the short limits of the tests that use it.
const silent = (_url, options) =>
  new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });

test(
  "a project scan stopped while deps.dev is asked keeps the facts that arrived, and its dependencies, findings and coverage agree",
  { timeout: 5000 },
  async (t) => {
    const root = await temporary();
    const projectRoot = join(root, "project");
    await aliasFixture(projectRoot);
    let candidate = "1.5.0";
    let hang = false;
    const coordinator = new MonitoringCoordinator({
      dataDir: join(root, "state"),
      dependencyLookup: (dependencies) => offering(candidate)(dependencies),
      sourceFetch: (url, options) =>
        hang
          ? silent(url, options)
          : Promise.resolve(Response.json(depsDev("public-example", candidate))),
    });
    t.after(() => coordinator.close());
    coordinator.changeSettings({ paused: true });
    const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
    await finishScan(coordinator, { target: "projects", projectId: project.id });
    assert.equal(coordinator.snapshot().projects[0].evidence.status, "complete");
    assert.deepEqual(facts(updateOf(coordinator)), ["2026-10-08T06:00:00.000Z", "MIT", true]);

    // 1.6.0 is a release deps.dev has not been asked about; stop the coordinator while it is.
    candidate = "1.6.0";
    hang = true;
    coordinator.requestScan({ target: "projects", projectId: project.id });
    await waitFor(() => coordinator.snapshot().scanProgress.active?.stage === "release-facts");
    await coordinator.close();
    const stopped = coordinator.snapshot();
    const { dependencies, evidence } = stopped.projects[0];
    const updates = stopped.findings.filter((f) => f.kind === "update");
    // The scan had replaced the dependencies before the stop. Its findings and its record are the
    // same scan's, not the previous one's.
    assert.deepEqual(
      [dependencies[0].availableVersion, ...updates.map((f) => f.availableVersion)],
      ["1.6.0", "1.6.0"],
      "The dependency and its update finding name the same candidate",
    );
    assert.deepEqual(
      facts(updates[0]),
      [undefined, undefined, undefined],
      "A release deps.dev was not asked about in time reads unknown",
    );
    assert.deepEqual([evidence.status, evidence.errors], ["complete", []]);
    assert.deepEqual([stopped.history[0].status, stopped.history[0].errors], ["complete", []]);
    assert.ok(evidence.coverage.includes(coverageNote(0, 1)), "The count says how many answered");
    assert.equal(
      stopped.findings.some((f) => f.kind === "coverage"),
      false,
    );
  },
);

test(
  "a PC scan stopped while deps.dev is asked keeps the facts that arrived, and its inventory, findings and coverage agree",
  { timeout: 5000 },
  async (t) => {
    const root = await temporary();
    let candidate = "2.0.0";
    let hang = false;
    const coordinator = new MonitoringCoordinator({
      dataDir: join(root, "state"),
      lookup: false,
      inventoryLookup: async () => ({
        installations: [
          {
            id: "tool-npm",
            name: "tool",
            packageId: "tool",
            manager: "npm",
            rootId: "root-npm",
            origin: "registry",
            version: "1.0.0",
            source: "npm global",
            scope: "user",
            channel: "Stable",
            availableVersion: candidate,
            updateStatus: "available",
            updateCheckedAt: new Date().toISOString(),
          },
        ],
        managers: [],
        checkedRoots: [],
        coverage: [],
        errors: [],
        inventoryChecks: "complete",
        updateChecks: "complete",
      }),
      sourceFetch: (url, options) =>
        hang ? silent(url, options) : Promise.resolve(Response.json(depsDev("tool", candidate))),
    });
    t.after(() => coordinator.close());
    coordinator.changeSettings({ paused: true });
    await finishScan(coordinator, { target: "pc" });
    assert.deepEqual(facts(updateOf(coordinator)), ["2026-10-08T06:00:00.000Z", "MIT", true]);

    candidate = "3.0.0";
    hang = true;
    coordinator.requestScan({ target: "pc" });
    await waitFor(() => coordinator.snapshot().scanProgress.active?.stage === "release-facts");
    await coordinator.close();
    const stopped = coordinator.snapshot();
    const { evidence, updateEvidence, installations } = stopped.inventory;
    const updates = stopped.findings.filter((f) => f.kind === "update");
    assert.deepEqual(
      [installations[0].availableVersion, ...updates.map((f) => f.availableVersion)],
      ["3.0.0", "3.0.0"],
      "The installation and its update finding name the same candidate",
    );
    assert.deepEqual(facts(updates[0]), [undefined, undefined, undefined]);
    assert.deepEqual(
      [evidence.status, updateEvidence.status, evidence.errors, updateEvidence.errors],
      ["complete", "complete", [], []],
      "The update evidence the scan replaced is not recorded as a failed check",
    );
    assert.deepEqual([stopped.history[0].status, stopped.history[0].errors], ["complete", []]);
    assert.ok(evidence.coverage.includes(coverageNote(0, 1)), "The count says how many answered");
  },
);

test("a release deps.dev has no publish time for shows what is known, claims no age, and is asked again", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  const sent = [];
  let body = {
    versionKey: { system: "NPM", name: "public-example", version: "1.5.0" },
    licenses: ["MIT"],
  };
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate,
    sourceFetch: async (url) => {
      sent.push(url);
      return Response.json(body);
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  const scan = () => finishScan(coordinator, { target: "projects", projectId: project.id });
  await scan();
  assert.deepEqual(facts(updateOf(coordinator)), [undefined, "MIT", undefined]);
  const coverage = () => coordinator.snapshot().projects[0].evidence.coverage;
  assert.ok(coverage().includes(coverageNote(0, 1)), "An answer with no time is not a checked one");
  await scan();
  assert.equal(sent.length, 2, "The release is asked about on every scan until it has a time");
  body = { ...body, publishedAt: "2026-10-08T06:00:00Z" };
  await scan();
  assert.deepEqual(facts(updateOf(coordinator)), ["2026-10-08T06:00:00.000Z", "MIT", undefined]);
  assert.ok(coverage().includes(coverageNote(1, 1)));
  await scan();
  assert.equal(sent.length, 3, "Once it has its time the release is cached");
});
