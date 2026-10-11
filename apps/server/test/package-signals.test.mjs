import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  createSourceCache,
  lookupDependencies,
  plainMessage,
  publicPackageVersions,
} from "../dist/adapters/lookups.js";
import { selectDirectory } from "../dist/adapters/projects.js";
import { MonitoringCoordinator } from "../dist/monitoring.js";

function dependency(id, extra = {}) {
  return {
    id,
    name: "example",
    packageName: "example",
    importer: ".",
    requested: "^1.0.0",
    resolved: "1.0.0",
    origin: "registry",
    role: "production",
    availableVersion: null,
    latestVersion: null,
    advisoryStatus: "not-checked",
    advisoryIds: [],
    ...extra,
  };
}
const native = (checked) => async () => ({
  checked: new Map(
    Object.entries(checked).map(([id, versions]) => [
      id,
      { source: "npm outdated 11.7.0", ...versions },
    ]),
  ),
  coverage: [],
});
const nativeResult = (id) => native({ [id]: { compatible: "1.5.0", latest: "2.0.0" } });
// Retries pause for real by default; this cache returns at once.
const quick = () => createSourceCache(async () => {});
const signalsError =
  "Deprecation and install-script checks failed for some packages; their previous results are kept and new ones are unknown.";
const registryName = (url) => decodeURIComponent(new URL(url).pathname.slice(1));

test("publisher messages become bounded plain text in the cached details, and install scripts are read per version", async () => {
  const { details } = await publicPackageVersions("example", async () =>
    Response.json({
      name: "example",
      "dist-tags": { latest: "3.0.0" },
      versions: {
        "1.0.0": { deprecated: '<img src=x onerror="alert(1)"> moved to <b>other</b>' },
        "1.1.0": { deprecated: "\u001b[31mred\u001b[0m line\nbreak\u202Eevil\u0007" },
        "1.2.0": { deprecated: "Use the maintained fork. ".repeat(4200) },
        "1.2.1": { deprecated: "x".repeat(4097) },
        "1.2.2": { deprecated: "x".repeat(4096) },
        "1.3.0": { deprecated: "   " },
        "1.4.0": { deprecated: true },
        "1.5.0": { deprecated: "\u200B\u202E\u061C" },
        "1.6.0": { deprecated: "hidden\u{e0041}\u{e0042}\u2060text\u00AD" },
        "2.0.0": { hasInstallScript: true },
        "2.1.0": { hasInstallScript: "yes" },
        "3.0.0": null,
      },
    }),
  );
  assert.equal(
    details["1.0.0"].deprecated,
    '<img src=x onerror="alert(1)"> moved to <b>other</b>',
    "HTML stays literal text",
  );
  assert.equal(
    details["1.1.0"].deprecated,
    "red line break evil",
    "Escapes and invisible characters are removed",
  );
  assert.equal(details["1.2.0"].deprecated.length, 300, "A 105,000-character message is kept");
  assert.ok(details["1.2.0"].deprecated.endsWith("…"));
  assert.ok(details["1.2.0"].deprecated.startsWith("Use the maintained fork. Use the"));
  for (const version of ["1.2.1", "1.2.2"]) {
    assert.equal(
      details[version].deprecated,
      `${"x".repeat(299)}…`,
      `${version}: a message at or over 4,096 characters is still a deprecation`,
    );
  }
  assert.equal("deprecated" in details["1.3.0"], false, "A blank message is not a deprecation");
  assert.equal("deprecated" in details["1.4.0"], false, "Only a string is a deprecation");
  assert.equal(
    details["1.5.0"].deprecated,
    "Deprecated by its publisher.",
    "A message that is nothing but invisible characters is still a deprecation",
  );
  assert.equal(details["1.6.0"].deprecated, "hidden text", "Tag and joiner characters are removed");
  assert.deepEqual(details["2.0.0"], { hasInstallScript: true });
  assert.deepEqual(details["2.1.0"], {}, "Only a boolean true is an install script");
  assert.deepEqual(details["3.0.0"], {});
  assert.equal(plainMessage("a\tb\u200Bc"), "a b c");
  assert.equal(plainMessage("é漢🙂 ok"), "é漢🙂 ok", "Other text is untouched");
  assert.equal(
    plainMessage("🙂".repeat(150), 100),
    `${"🙂".repeat(99)}…`,
    "Limits count characters",
  );
});

test("direct dependencies the package manager checked still read npm metadata, once per name", async () => {
  const requests = [];
  const fetcher = async (url) => {
    if (url.endsWith("/querybatch")) return Response.json({ results: [{}, {}] });
    const name = registryName(url);
    requests.push(name);
    return Response.json({
      name,
      "dist-tags": { latest: "2.0.0" },
      versions: {
        "1.0.0": { deprecated: "Moved to @scope/new." },
        "1.5.0": {},
        "2.0.0": {
          hasInstallScript: true,
          deprecated: "2.0.0 was published by mistake; use 1.5.0.",
        },
      },
    });
  };
  const result = await lookupDependencies(
    [
      dependency("native"),
      dependency("registry", {
        name: "other",
        packageName: "other",
        requested: "^1.0.0 || ^2.0.0",
      }),
    ],
    fetcher,
    undefined,
    undefined,
    nativeResult("native"),
  );
  assert.deepEqual(
    requests.sort(),
    ["example", "other"],
    "Each direct name is read once, native or not",
  );
  const byId = (id) => result.dependencies.find((d) => d.id === id);
  assert.equal(
    byId("native").versionSource,
    "npm outdated 11.7.0",
    "Native candidates are not replaced",
  );
  assert.equal(byId("native").availableVersion, "1.5.0");
  assert.equal(byId("registry").versionSource, "npm registry");
  assert.deepEqual(result.signals.get("native"), {
    deprecated: "Moved to @scope/new.",
    installScript: false,
    candidateDeprecated: null,
  });
  assert.deepEqual(result.signals.get("registry"), {
    deprecated: "Moved to @scope/new.",
    installScript: true,
    candidateDeprecated: "2.0.0 was published by mistake; use 1.5.0.",
  });
  assert.ok(
    result.coverage.includes(
      "Public npm registry version checks: 1/1 unique direct package names, SemVer requested ranges and latest dist-tag",
    ),
    "Version coverage counts only the names the package manager did not answer",
  );
  assert.ok(
    result.coverage.includes(
      "Deprecation and install-script checks: 2/2 unique direct package names (npm registry metadata)",
    ),
  );
  assert.deepEqual(result.errors, []);
});

test("unavailable metadata on the native path is an incomplete check, never a clean result", async () => {
  const result = await lookupDependencies(
    [dependency("native")],
    async (url) =>
      url.endsWith("/querybatch")
        ? Response.json({ results: [{}] })
        : new Response("unavailable", { status: 503 }),
    undefined,
    undefined,
    nativeResult("native"),
    quick(),
  );
  assert.equal(result.signals.has("native"), false);
  assert.equal(
    result.dependencies[0].versionStatus,
    "checked",
    "The package manager's answer stands",
  );
  assert.equal(result.dependencies[0].availableVersion, "1.5.0");
  assert.ok(result.errors.includes(signalsError));
  assert.ok(!result.errors.some((error) => /version lookup failed/.test(error)));
  assert.ok(
    result.coverage.includes(
      "Deprecation and install-script checks: 0/1 unique direct package names (npm registry metadata)",
    ),
  );
  assert.ok(!result.coverage.some((line) => /^Public npm registry version checks/.test(line)));
});

test("a failed registry read leaves no signals for a name and keeps the other names", async () => {
  const result = await lookupDependencies(
    [
      dependency("good"),
      dependency("bad", { name: "bad", packageName: "bad" }),
      dependency("fallback", { name: "fallback", packageName: "fallback" }),
    ],
    async (url) => {
      if (url.endsWith("/querybatch")) return Response.json({ results: [{}, {}, {}] });
      const name = registryName(url);
      if (name === "bad") return new Response("unavailable", { status: 500 });
      return Response.json({
        name,
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { deprecated: `${name} is deprecated.` } },
      });
    },
    undefined,
    undefined,
    native({ good: { compatible: "1.0.0", latest: "1.0.0" } }),
    quick(),
  );
  const byId = (id) => result.dependencies.find((d) => d.id === id);
  assert.deepEqual([...result.signals.keys()].sort(), ["fallback", "good"]);
  assert.equal(result.signals.get("good").deprecated, "example is deprecated.");
  assert.equal(result.signals.get("fallback").deprecated, "fallback is deprecated.");
  assert.equal(byId("bad").versionStatus, "failed");
  assert.equal(byId("fallback").versionStatus, "checked");
  assert.ok(result.errors.includes(signalsError));
  assert.ok(result.errors.some((error) => /version lookup failed/.test(error)));
  assert.ok(
    result.coverage.includes(
      "Deprecation and install-script checks: 2/3 unique direct package names (npm registry metadata)",
    ),
  );
});

test("a candidate newer than the metadata is recorded as unchecked, never as clean", async () => {
  const fetcher = async (url) =>
    url.endsWith("/querybatch")
      ? Response.json({ results: [{}, {}] })
      : Response.json({
          name: "example",
          "dist-tags": { latest: "1.5.0" },
          versions: {
            "1.0.0": { deprecated: "Use something else." },
            "1.5.0": { hasInstallScript: true, deprecated: "1.5.0 is broken." },
          },
        });
  const result = await lookupDependencies(
    [dependency("ahead"), dependency("current", { resolved: "1.5.0" })],
    fetcher,
    undefined,
    undefined,
    // npm outdated can report a release published after the metadata was fetched.
    native({
      ahead: { compatible: "1.6.0", latest: "2.0.0" },
      current: { compatible: "1.5.0", latest: "1.5.0" },
    }),
  );
  assert.deepEqual(result.signals.get("ahead"), {
    deprecated: "Use something else.",
    installScript: null,
    candidateDeprecated: undefined,
  });
  assert.deepEqual(result.signals.get("current"), {
    deprecated: "1.5.0 is broken.",
    installScript: null,
    candidateDeprecated: null,
  });
});

test("an installed version the metadata does not list is recorded as unchecked, never as clean", async () => {
  const requests = [];
  const result = await lookupDependencies(
    ["listed", "none", "ahead"].map((id) => dependency(id, { resolved: "0.9.0" })),
    async (url) => {
      if (url.endsWith("/querybatch")) return Response.json({ results: [{}] });
      requests.push(registryName(url));
      return Response.json({
        name: "example",
        "dist-tags": { latest: "1.5.0" },
        versions: { "1.5.0": { hasInstallScript: true, deprecated: "1.5.0 is broken." } },
      });
    },
    undefined,
    undefined,
    native({
      listed: { compatible: "1.5.0", latest: "1.5.0" },
      none: { compatible: "0.9.0", latest: "0.9.0" },
      ahead: { compatible: "1.6.0", latest: "1.6.0" },
    }),
  );
  assert.deepEqual(requests, ["example"]);
  // Not deprecated and not "adds a script" are claims about the installed version, which is unknown.
  assert.deepEqual(result.signals.get("listed"), {
    deprecated: undefined,
    installScript: null,
    candidateDeprecated: "1.5.0 is broken.",
  });
  assert.deepEqual(result.signals.get("none"), {
    deprecated: undefined,
    installScript: null,
    candidateDeprecated: null,
  });
  assert.deepEqual(result.signals.get("ahead"), {
    deprecated: undefined,
    installScript: null,
    candidateDeprecated: undefined,
  });
  assert.deepEqual(
    result.errors,
    [],
    "A version the registry does not know is not an incomplete check",
  );
  assert.ok(
    result.coverage.includes(
      "Deprecation and install-script checks: 1/1 unique direct package names (npm registry metadata)",
    ),
  );
});

test("an install script is added only when the installed version lacks it", async () => {
  const result = await lookupDependencies(
    [dependency("had"), dependency("lacked", { name: "other", packageName: "other" })],
    async (url) => {
      if (url.endsWith("/querybatch")) return Response.json({ results: [{}, {}] });
      const name = registryName(url);
      return Response.json({
        name,
        "dist-tags": { latest: "2.0.0" },
        versions: {
          "1.0.0": name === "example" ? { hasInstallScript: true } : {},
          "2.0.0": { hasInstallScript: true },
        },
      });
    },
  );
  assert.equal(result.signals.get("had").installScript, false, "The installed version has one too");
  assert.equal(result.signals.get("lacked").installScript, true);
});

test("a cached copy of the metadata carries the same signals without another request", async () => {
  const requests = [];
  const fetcher = async (url) => {
    if (url.endsWith("/querybatch")) return Response.json({ results: [{}] });
    requests.push(registryName(url));
    return Response.json({
      name: "example",
      "dist-tags": { latest: "2.0.0" },
      versions: {
        "1.0.0": { deprecated: "Use the maintained fork. ".repeat(4200) },
        "2.0.0": { hasInstallScript: true },
      },
    });
  };
  const cache = quick();
  const scan = () =>
    lookupDependencies([dependency("a")], fetcher, undefined, undefined, undefined, cache);
  const first = await scan();
  const second = await scan();
  assert.deepEqual(requests, ["example"], "The second scan is served from the shared cache");
  assert.deepEqual(second.signals.get("a"), first.signals.get("a"));
  assert.equal(second.signals.get("a").deprecated.length, 300);
  assert.equal(second.signals.get("a").installScript, true);
});

// Windows cannot delete a SQLite database that is still open. The directories are removed once,
// after every test has run its own `t.after` hooks and closed its coordinator.
const directories = [];
after(() =>
  Promise.all(
    directories.map((path) =>
      rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  ),
);
async function temporary() {
  const path = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-signals-")));
  directories.push(path);
  return path;
}
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
// Timestamps have millisecond resolution: let one pass so that a refreshed time would differ.
const later = () => new Promise((resolve) => setTimeout(resolve, 5));
// A project whose one direct dependency, `alias`, is the public package `public-example`.
async function aliasFixture(root, version = "1.0.0") {
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
          version,
          resolved: `https://registry.npmjs.org/public-example/-/public-example-${version}.tgz`,
        },
      },
    }),
  );
}
// A global npm tool with an update available.
const globalTool = (extra = {}) => ({
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
const npmSource = (nodeVersion) => ({
  manager: "npm",
  status: "detected",
  version: "11.7.0",
  root: "npm-root",
  registry: "public",
  blockedScopes: [],
  checkedAt: new Date().toISOString(),
  error: null,
  nodeVersion,
});
const inventoryOf = (installations, extra = {}) => ({
  installations,
  managers: [],
  checkedRoots: [],
  coverage: [],
  errors: [],
  inventoryChecks: "complete",
  updateChecks: "complete",
  ...extra,
});
const lifecycleOf = (coordinator) =>
  coordinator.snapshot().findings.filter((f) => f.kind === "lifecycle");
const updateOf = (coordinator) => coordinator.snapshot().findings.find((f) => f.kind === "update");
// The update finding as the HTTP API sends it.
const wireUpdate = (coordinator) =>
  JSON.parse(coordinator.snapshotJson()).findings.find((f) => f.kind === "update");
// An update finding that carries neither answer, so its page says "Not checked" twice.
function assertNoAnswers(update, message) {
  assert.deepEqual(
    ["installScript" in update, "candidateDeprecated" in update],
    [false, false],
    message,
  );
}

test("a deprecated direct dependency is a lifecycle finding, and unchecked metadata keeps its previous answers", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  // What the metadata says in the scan that is about to run; null: it could not be read.
  const read = {
    deprecated: {
      deprecated: "Moved to <b>new-name</b>.",
      installScript: true,
      candidateDeprecated: "1.5.0 is broken; wait for 1.5.1.",
    },
    clean: { deprecated: null, installScript: false, candidateDeprecated: null },
  };
  let answer = read.deprecated;
  let candidate = "1.5.0";
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => {
      const alias = dependencies.find((d) => d.name === "alias");
      return {
        dependencies: dependencies.map((d) => ({
          ...d,
          availableVersion: d.id === alias.id ? candidate : null,
          versionStatus: "checked",
          advisoryStatus: "checked",
        })),
        versionChecked: new Set([alias.id]),
        signals: answer ? new Map([[alias.id, answer]]) : new Map(),
        advisories: new Map(),
        coverage: [],
        errors: answer ? [] : [signalsError],
      };
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  const rescan = async () => {
    await finishScan(coordinator, { target: "projects", projectId: project.id });
    return coordinator.snapshot();
  };
  let snapshot = await rescan();
  const deprecated = snapshot.findings.find((f) => f.kind === "lifecycle");
  assert.equal(deprecated.description, "Deprecated by its publisher: Moved to <b>new-name</b>.");
  assert.deepEqual(
    [
      deprecated.severity,
      deprecated.name,
      deprecated.packageName,
      deprecated.installedVersion,
      deprecated.availableVersion,
      deprecated.source,
    ],
    ["low", "alias", "public-example", "1.0.0", null, "npm registry"],
  );
  let update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual(
    [update.installScript, update.candidateDeprecated],
    [true, "1.5.0 is broken; wait for 1.5.1."],
  );
  assert.deepEqual(
    [wireUpdate(coordinator).installScript, wireUpdate(coordinator).candidateDeprecated],
    [true, "1.5.0 is broken; wait for 1.5.1."],
    "The answers are part of the wire contract",
  );
  assert.equal(snapshot.notifications.length, 1, "Only the update notifies");

  answer = null;
  await later();
  snapshot = await rescan();
  assert.equal(snapshot.projects[0].evidence.status, "partial");
  const kept = snapshot.findings.find((f) => f.id === deprecated.id);
  assert.ok(kept, "Unchecked metadata keeps the deprecation");
  assert.equal(kept.lastSeenAt, deprecated.lastSeenAt, "A kept notice keeps the age it had");
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual(
    [update.installScript, update.candidateDeprecated],
    [true, "1.5.0 is broken; wait for 1.5.1."],
    "Unchecked flags never turn into 'none'",
  );

  answer = read.clean;
  snapshot = await rescan();
  assert.equal(
    snapshot.findings.some((f) => f.kind === "lifecycle"),
    false,
  );
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual([update.installScript, update.candidateDeprecated], [false, null]);
  assert.equal(snapshot.notifications.length, 1, "A deprecation never adds a notification");

  // The answers describe one installed version and one candidate. With nothing read, a different
  // candidate for the same installed version starts from nothing...
  candidate = "1.6.0";
  answer = null;
  snapshot = await rescan();
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.equal(update.availableVersion, "1.6.0");
  assertNoAnswers(update, "The answers for 1.5.0 say nothing about 1.6.0");
  // ...and so does a different installed version for the same candidate.
  candidate = "1.5.0";
  answer = read.clean;
  snapshot = await rescan();
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual([update.installScript, update.candidateDeprecated], [false, null]);
  await aliasFixture(projectRoot, "1.0.1");
  answer = null;
  snapshot = await rescan();
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual([update.installedVersion, update.availableVersion], ["1.0.1", "1.5.0"]);
  assertNoAnswers(update, "The answers for 1.0.0 say nothing about 1.0.1");
});

test("a deprecated global tool keeps its notice when a later check cannot read metadata", async (t) => {
  const root = await temporary();
  let signals = new Map([
    ["tool-npm", { deprecated: "Use new-tool.", installScript: true, candidateDeprecated: null }],
  ]);
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    inventoryLookup: async () => inventoryOf([globalTool()], { signals }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  await finishScan(coordinator, { target: "pc" });
  let snapshot = coordinator.snapshot();
  const notice = snapshot.findings.find((f) => f.kind === "lifecycle");
  assert.deepEqual(
    [
      notice.subjectId,
      notice.name,
      notice.packageName,
      notice.source,
      notice.severity,
      notice.description,
    ],
    [
      snapshot.device.id,
      "tool",
      "tool",
      "npm global",
      "low",
      "Deprecated by its publisher: Use new-tool.",
    ],
  );
  assert.deepEqual(
    [updateOf(coordinator).installScript, updateOf(coordinator).candidateDeprecated],
    [true, null],
  );
  assert.deepEqual(
    [wireUpdate(coordinator).installScript, wireUpdate(coordinator).candidateDeprecated],
    [true, null],
    "The answers are part of the wire contract",
  );
  assert.equal(snapshot.notifications.length, 1, "Only the update notifies");
  signals = new Map();
  await later();
  await finishScan(coordinator, { target: "pc" });
  snapshot = coordinator.snapshot();
  const kept = snapshot.findings.find((f) => f.id === notice.id);
  assert.ok(kept, "Unchecked metadata keeps the notice");
  assert.equal(kept.lastSeenAt, notice.lastSeenAt, "A kept notice keeps the age it had");
  assert.equal(updateOf(coordinator).installScript, true);
});

test("a global tool's deprecation notice follows what was read and the version it was read for", async (t) => {
  const root = await temporary();
  const deprecated = {
    deprecated: "Use new-tool.",
    installScript: false,
    candidateDeprecated: null,
  };
  let signals = new Map([["tool-npm", deprecated]]);
  let installed = { version: "1.0.0", availableVersion: "2.0.0" };
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    inventoryLookup: async () => inventoryOf([globalTool(installed)], { signals }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  await finishScan(coordinator, { target: "pc" });
  const [notice] = lifecycleOf(coordinator);
  assert.equal(notice.installedVersion, "1.0.0");
  signals = new Map([["tool-npm", { ...deprecated, deprecated: null }]]);
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(
    lifecycleOf(coordinator),
    [],
    "Metadata that was read and no longer deprecates it",
  );
  assert.equal(updateOf(coordinator).installScript, false);
  signals = new Map([["tool-npm", deprecated]]);
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(
    lifecycleOf(coordinator).map((f) => f.id),
    [notice.id],
    "The same notice, found again",
  );
  // The metadata no longer lists the installed version: its deprecation and its install script
  // cannot be read, which neither confirms nor withdraws what an earlier scan found.
  const unlisted = { deprecated: undefined, installScript: null, candidateDeprecated: null };
  signals = new Map([["tool-npm", unlisted]]);
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(
    lifecycleOf(coordinator).map((f) => f.id),
    [notice.id],
    "An unlisted version is unchecked, not 'not deprecated'",
  );
  assert.equal(updateOf(coordinator).installScript, false);
  // The answers describe one installed version and one candidate. With nothing read, a newer
  // candidate for the same installed version starts from nothing, and the notice, which is about
  // the installed version, stays.
  signals = new Map();
  installed = { version: "1.0.0", availableVersion: "2.1.0" };
  await finishScan(coordinator, { target: "pc" });
  assert.equal(updateOf(coordinator).availableVersion, "2.1.0");
  assertNoAnswers(updateOf(coordinator), "The answers for 2.0.0 say nothing about 2.1.0");
  assert.deepEqual(
    lifecycleOf(coordinator).map((f) => f.id),
    [notice.id],
  );
  // The same candidate on a newer installed version does not inherit them either, and the notice,
  // which describes the old installed version, goes.
  signals = new Map([["tool-npm", deprecated]]);
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(
    [updateOf(coordinator).installScript, updateOf(coordinator).candidateDeprecated],
    [false, null],
  );
  signals = new Map();
  installed = { version: "1.0.1", availableVersion: "2.1.0" };
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(lifecycleOf(coordinator), []);
  assert.equal(updateOf(coordinator).installedVersion, "1.0.1");
  assertNoAnswers(updateOf(coordinator), "The answers for 1.0.0 say nothing about 1.0.1");
  // Nothing was read for the new version either: no notice, and no claim about its install script.
  signals = new Map([["tool-npm", unlisted]]);
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(lifecycleOf(coordinator), []);
  assert.equal("installScript" in updateOf(coordinator), false);
  assert.equal(updateOf(coordinator).candidateDeprecated, null);
});

test("a deprecated tool that is gone loses its notice even when the runtime check was incomplete, and a failed scan keeps it", async (t) => {
  const root = await temporary();
  let scan = "installed";
  let nodeVersion = "20.11.1";
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    sourceFetch: async () =>
      Response.json({
        result: { name: "nodejs", releases: [{ name: "20", isEol: true, eolFrom: "2026-04-30" }] },
      }),
    inventoryLookup: async () => {
      if (scan === "failing") throw new Error("The global tools could not be read.");
      return inventoryOf(scan === "installed" ? [globalTool()] : [], {
        managers: [npmSource(nodeVersion)],
        checkedRoots: ["root-npm"],
        signals: new Map([
          [
            "tool-npm",
            { deprecated: "Use new-tool.", installScript: false, candidateDeprecated: null },
          ],
        ]),
      });
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const names = () =>
    lifecycleOf(coordinator)
      .map((f) => f.name)
      .sort();
  await finishScan(coordinator, { target: "pc" });
  assert.deepEqual(names(), ["Node.js 20", "tool"], "A runtime line and a deprecated tool");
  scan = "failing";
  await finishScan(coordinator, { target: "pc" });
  assert.equal(coordinator.snapshot().inventory.evidence.status, "failed");
  assert.deepEqual(names(), ["Node.js 20", "tool"], "A failed scan keeps what it could not check");
  scan = "gone";
  nodeVersion = null;
  await finishScan(coordinator, { target: "pc" });
  assert.equal(coordinator.snapshot().inventory.evidence.status, "complete");
  assert.deepEqual(
    names(),
    ["Node.js 20"],
    "The uncaptured runtime stays unknown, but a tool that is gone has nothing to be deprecated",
  );
  assert.equal(
    coordinator.snapshot().findings.some((f) => f.kind === "update"),
    false,
  );
});

test("a candidate newer than the metadata read carries no install-script or deprecation answer", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  const unlisted = { deprecated: null, installScript: null, candidateDeprecated: undefined };
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => {
      const alias = dependencies.find((d) => d.name === "alias");
      return {
        dependencies: dependencies.map((d) => ({
          ...d,
          availableVersion: d.id === alias.id ? "1.6.0" : null,
          versionStatus: "checked",
          advisoryStatus: "checked",
        })),
        versionChecked: new Set([alias.id]),
        signals: new Map([[alias.id, unlisted]]),
        advisories: new Map(),
        coverage: [],
        errors: [],
      };
    },
    inventoryLookup: async () =>
      inventoryOf([globalTool()], { signals: new Map([["tool-npm", unlisted]]) }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  await finishScan(coordinator, { target: "pc" });
  const updates = JSON.parse(coordinator.snapshotJson()).findings.filter(
    (f) => f.kind === "update",
  );
  assert.equal(updates.length, 2, "One update for the project and one for the tool");
  for (const update of updates) {
    assert.equal("installScript" in update, false, `${update.name}: not checked is not 'none'`);
    assert.equal("candidateDeprecated" in update, false, `${update.name}: nor 'not deprecated'`);
  }
  assert.deepEqual(lifecycleOf(coordinator), [], "Neither installed version is deprecated");
});

test("metadata that cannot be read for a name the package manager checked keeps the deprecation and the flags, and says so", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  // The installed 1.0.0 and its candidate 1.5.0, as the registry lists them in each state.
  const registries = {
    listed: {
      "1.0.0": { deprecated: "Moved to new-name." },
      "1.5.0": { hasInstallScript: true, deprecated: "1.5.0 is broken." },
    },
    unlisted: { "1.5.0": { hasInstallScript: true, deprecated: "1.5.0 is broken." } },
    clean: { "1.0.0": {}, "1.5.0": {} },
  };
  let registry = "unlisted";
  const fetcher = async (url) => {
    if (url.endsWith("/querybatch")) return Response.json({ results: [{}] });
    if (registry === "down") return new Response("unavailable", { status: 503 });
    return Response.json({
      name: "public-example",
      "dist-tags": { latest: "1.5.0" },
      versions: registries[registry],
    });
  };
  const open = () =>
    new MonitoringCoordinator({
      dataDir: join(root, "state"),
      // The real lookup: the package manager answers the versions, the registry the flags.
      dependencyLookup: (dependencies, signal, onProgress) => {
        const alias = dependencies.find((d) => d.name === "alias");
        return lookupDependencies(
          dependencies,
          fetcher,
          signal,
          onProgress,
          native({ [alias.id]: { compatible: "1.5.0", latest: "1.5.0" } }),
          quick(),
        );
      },
    });
  let coordinator = open();
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  const rescan = async (state) => {
    registry = state;
    await finishScan(coordinator, { target: "projects", projectId: project.id });
    return coordinator.snapshot();
  };
  const noGap = (snapshot) => {
    assert.equal(snapshot.projects[0].evidence.status, "complete");
    assert.deepEqual(snapshot.projects[0].evidence.errors, []);
    assert.equal(
      snapshot.findings.some((f) => f.kind === "coverage"),
      false,
    );
  };

  // The registry does not list the installed version, so nothing is known about its deprecation
  // or its install script: no finding, no claim, and no incomplete check either.
  let snapshot = await rescan("unlisted");
  noGap(snapshot);
  assert.deepEqual(
    snapshot.findings.filter((f) => f.kind === "lifecycle"),
    [],
  );
  let update = snapshot.findings.find((f) => f.kind === "update");
  assert.equal("installScript" in update, false, "Not 'adds an install script', not 'none'");
  assert.equal(update.candidateDeprecated, "1.5.0 is broken.", "The candidate itself was read");

  snapshot = await rescan("listed");
  noGap(snapshot);
  const deprecated = snapshot.findings.find((f) => f.kind === "lifecycle");
  assert.equal(deprecated.description, "Deprecated by its publisher: Moved to new-name.");
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual([update.installScript, update.candidateDeprecated], [true, "1.5.0 is broken."]);

  // The answers are stored with the evidence, so they are still there after a restart.
  await coordinator.close();
  coordinator = open();
  snapshot = await rescan("down");
  assert.equal(snapshot.projects[0].evidence.status, "partial");
  assert.ok(snapshot.projects[0].evidence.errors.includes(signalsError));
  assert.ok(
    snapshot.findings.some((f) => f.kind === "coverage" && f.description.includes(signalsError)),
    "The gap is a finding, not only a log line",
  );
  assert.ok(snapshot.findings.some((f) => f.id === deprecated.id));
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual([update.installScript, update.candidateDeprecated], [true, "1.5.0 is broken."]);

  // A scan that fails outright keeps them too.
  await writeFile(join(projectRoot, "package-lock.json"), "broken");
  snapshot = await rescan("listed");
  assert.equal(snapshot.projects[0].evidence.status, "failed");
  assert.ok(snapshot.findings.some((f) => f.id === deprecated.id));
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual([update.installScript, update.candidateDeprecated], [true, "1.5.0 is broken."]);
  await aliasFixture(projectRoot);

  // The registry answers but no longer lists the installed version: that neither confirms nor
  // withdraws what was found, and a version the registry does not know is not an incomplete check.
  snapshot = await rescan("unlisted");
  noGap(snapshot);
  assert.ok(snapshot.findings.some((f) => f.id === deprecated.id));
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual([update.installScript, update.candidateDeprecated], [true, "1.5.0 is broken."]);

  // Listed again without a deprecation or a script, the notice is withdrawn and the answers are "none".
  snapshot = await rescan("clean");
  noGap(snapshot);
  assert.deepEqual(
    snapshot.findings.filter((f) => f.kind === "lifecycle"),
    [],
  );
  update = snapshot.findings.find((f) => f.kind === "update");
  assert.deepEqual([update.installScript, update.candidateDeprecated], [false, null]);
});

test("a deprecated dependency with no newer release is still a lifecycle finding, and never a notification", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => {
      const alias = dependencies.find((d) => d.name === "alias");
      return {
        dependencies: dependencies.map((d) => ({
          ...d,
          availableVersion: null,
          latestVersion: null,
          versionStatus: "checked",
          advisoryStatus: "checked",
        })),
        versionChecked: new Set([alias.id]),
        signals: new Map([
          [
            alias.id,
            { deprecated: "Moved to new-name.", installScript: null, candidateDeprecated: null },
          ],
        ]),
        advisories: new Map(),
        coverage: [],
        errors: [],
      };
    },
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  const snapshot = coordinator.snapshot();
  assert.deepEqual(
    snapshot.findings.map((f) => [f.kind, f.name, f.severity, f.availableVersion, f.description]),
    [["lifecycle", "alias", "low", null, "Deprecated by its publisher: Moved to new-name."]],
    "One notice, and no update finding because there is no newer release",
  );
  assert.equal(snapshot.notifications.length, 0, "Nothing is announced");
});

test("a deprecated global tool with no newer release is still a lifecycle finding, and never a notification", async (t) => {
  const root = await temporary();
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    inventoryLookup: async () =>
      inventoryOf([globalTool({ availableVersion: null, updateStatus: "current" })], {
        signals: new Map([
          [
            "tool-npm",
            { deprecated: "Use new-tool.", installScript: null, candidateDeprecated: null },
          ],
        ]),
      }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  await finishScan(coordinator, { target: "pc" });
  const snapshot = coordinator.snapshot();
  assert.deepEqual(
    snapshot.findings.map((f) => [f.kind, f.name, f.severity, f.availableVersion, f.description]),
    [["lifecycle", "tool", "low", null, "Deprecated by its publisher: Use new-tool."]],
    "One notice, and no update finding because the tool is current",
  );
  assert.equal(snapshot.notifications.length, 0, "Nothing is announced");
});

test("a notice kept for one version of a package is not dropped by a fresh notice for another version of it", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  // Two workspaces depend on one package, under one name, at two versions.
  const workspace = (importer, resolved) => ({
    id: `${importer}/alias`,
    name: "alias",
    packageName: "public-example",
    importer,
    requested: "^1.0.0",
    resolved,
    origin: "registry",
    role: "production",
    availableVersion: null,
    latestVersion: null,
    advisoryStatus: "not-checked",
    advisoryIds: [],
  });
  const dependencies = [workspace("apps/a", "1.0.0"), workspace("apps/b", "1.0.1")];
  // The registry deprecates both versions, then no longer lists the second.
  let secondListed = true;
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (inputs) => ({
      dependencies: inputs.map((d) => ({
        ...d,
        versionStatus: "checked",
        advisoryStatus: "checked",
      })),
      versionChecked: new Set(inputs.map((d) => d.id)),
      signals: new Map(
        inputs.map((d) => [
          d.id,
          {
            deprecated: d.importer === "apps/b" && !secondListed ? undefined : "Moved to new-name.",
            installScript: null,
            candidateDeprecated: null,
          },
        ]),
      ),
      advisories: new Map(),
      coverage: [],
      errors: [],
    }),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  coordinator.configureProjectInspection(
    async () => ({
      packageManager: "npm",
      manifestPath: join(projectRoot, "package.json"),
      lockfilePath: join(projectRoot, "package-lock.json"),
      dependencies,
      coverage: [],
      errors: [],
      inputFingerprint: "two versions of one name",
    }),
    () => false,
  );
  const noticed = () =>
    lifecycleOf(coordinator)
      .map((f) => f.installedVersion)
      .sort();
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  assert.deepEqual(noticed(), ["1.0.0", "1.0.1"]);
  secondListed = false;
  await finishScan(coordinator, { target: "projects", projectId: project.id });
  assert.deepEqual(
    noticed(),
    ["1.0.0", "1.0.1"],
    "The fresh notice for 1.0.0 does not replace the kept notice for 1.0.1, which has the same name",
  );
});
