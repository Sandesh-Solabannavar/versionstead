import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import { MonitoringStorage } from "../dist/storage.js";
import { inspectProject, InputError, selectDirectory } from "../dist/adapters/projects.js";
import { identity } from "../dist/adapters/projects.js";
import { lookupDependencies } from "../dist/adapters/lookups.js";

async function temporary(t) {
  const path = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-monitoring-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function npmFixture(root, extra = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { install: "node -e \"require('node:fs').writeFileSync('executed','unsafe')\"" },
      dependencies: { alias: "npm:public-example@^1.0.0" },
      ...extra,
    }),
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
        "node_modules/transitive": {
          version: "2.0.0",
          resolved: "https://registry.npmjs.org/transitive/-/transitive-2.0.0.tgz",
        },
      },
    }),
  );
}

async function waitFor(predicate) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a scan.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function scan(coordinator, projectId) {
  const previous = coordinator.snapshot().history[0]?.id;
  coordinator.requestScan({ target: "projects", projectId });
  await waitFor(() => {
    const latest = coordinator.snapshot().history[0];
    return latest?.id !== previous && latest?.status !== "scanning";
  });
}

test("npm aliases and transitive identities are preserved without executing repository scripts", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const inputs = await inspectProject(root);
  assert.equal(inputs.packageManager, "npm");
  assert.equal(inputs.dependencies.length, 2);
  const alias = inputs.dependencies.find((d) => d.name === "alias");
  assert.equal(alias.packageName, "public-example");
  assert.equal(alias.requested, "npm:public-example@^1.0.0");
  assert.equal(alias.resolved, "1.0.0");
  assert.equal(alias.role, "production");
  assert.equal(inputs.dependencies.find((d) => d.name === "transitive").role, "transitive");
  await assert.rejects(readFile(join(root, "executed")), { code: "ENOENT" });
  const firstFingerprint = inputs.inputFingerprint;
  assert.match(firstFingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await inspectProject(root)).inputFingerprint, firstFingerprint);
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  lock.lockfileVersion = 2;
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
  const changedLock = await inspectProject(root);
  assert.notEqual(changedLock.inputFingerprint, firstFingerprint);
  assert.equal(changedLock.errors.length, 0);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { alias: "npm:different-public-name@^2.0.0" } }),
  );
  const changedManifest = await inspectProject(root);
  assert.notEqual(changedManifest.inputFingerprint, changedLock.inputFingerprint);
  assert.equal(
    changedManifest.dependencies.find((d) => d.name === "alias").packageName,
    "public-example",
    "The lockfile's actual alias identity must survive a changed manifest target.",
  );
  assert.ok(changedManifest.errors.some((e) => e.includes("alias target")));
  assert.ok(changedManifest.errors.some((e) => e.includes("manifest range")));
});

test("pnpm v9 workspace importers, npm aliases, peer identities and unsupported workspace origins", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { alias: "npm:public-example@^1.0.0", local: "workspace:*" } }),
  );
  await writeFile(
    join(root, "apps", "web", "package.json"),
    JSON.stringify({ devDependencies: { tool: "^2.0.0" } }),
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      alias: {specifier: 'npm:public-example@^1.0.0', version: 'public-example@1.0.0(peer@3.0.0)'}
      local: {specifier: 'workspace:*', version: 'link:apps/web'}
  apps/web:
    devDependencies:
      tool: {specifier: '^2.0.0', version: '2.0.0'}
packages:
  public-example@1.0.0: {resolution: {integrity: sha512-example}}
  tool@2.0.0: {resolution: {integrity: sha512-example}}
  peer@3.0.0: {resolution: {integrity: sha512-example}}
snapshots:
  public-example@1.0.0(peer@3.0.0): {dependencies: {peer: 3.0.0}}
  tool@2.0.0: {}
  peer@3.0.0: {}
`,
  );
  const inputs = await inspectProject(root);
  assert.equal(inputs.packageManager, "pnpm");
  assert.equal(inputs.dependencies.find((d) => d.name === "alias").packageName, "public-example");
  assert.equal(inputs.dependencies.find((d) => d.name === "local").origin, "workspace");
  assert.equal(inputs.dependencies.find((d) => d.name === "tool").importer, "apps/web");
  assert.equal(inputs.dependencies.find((d) => d.name === "tool").role, "development");
  assert.equal(inputs.dependencies.find((d) => d.name === "peer").role, "transitive");
  assert.equal(inputs.dependencies.filter((d) => d.name === "public-example").length, 0);
  assert.ok(inputs.coverage.some((e) => e.includes("internal workspace/local")));
});

test("missing, malformed and unsupported inputs never produce complete coverage", async (t) => {
  const root = await temporary(t);
  await assert.rejects(
    inspectProject(root),
    (e) => e instanceof InputError && e.status === "unsupported",
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
  await assert.rejects(inspectProject(root), /No supported lockfile/);
  await writeFile(join(root, "package-lock.json"), "{broken}");
  await assert.rejects(inspectProject(root), /malformed/);
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 1 }));
  await assert.rejects(inspectProject(root), (e) => e.status === "unsupported");
  await rm(join(root, "package-lock.json"));
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nimporters: {.: {}}\npackages: []\n",
  );
  await assert.rejects(inspectProject(root));
});

test("selected roots reject files, workspace traversal and escaping lockfile symlinks", async (t) => {
  const root = await temporary(t);
  const outside = await temporary(t);
  await npmFixture(root);
  await assert.rejects(selectDirectory(join(root, "package.json")), /directory/);
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "../escape": {} } }),
  );
  await assert.rejects(inspectProject(root), /escapes/);
  await rm(join(root, "package-lock.json"));
  await writeFile(join(outside, "lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  try {
    await symlink(join(outside, "lock.json"), join(root, "package-lock.json"), "file");
  } catch (error) {
    if (error.code === "EPERM") {
      t.diagnostic(
        "File symlink creation requires Windows privilege; traversal rejection remains verified.",
      );
      return;
    }
    throw error;
  }
  await assert.rejects(inspectProject(root), /symlink escapes/);
});

test("public lookups use real alias identity, compatible SemVer and OSV; private inputs remain unqueried", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const inputs = await inspectProject(root);
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, "error");
    if (url.endsWith("/querybatch")) {
      const queries = JSON.parse(options.body).queries;
      return Response.json({
        results: queries.map((query) =>
          query.package.name === "public-example" ? { vulns: [{ id: "GHSA-example" }] } : {},
        ),
      });
    }
    if (url.includes("/vulns/"))
      return Response.json({
        id: "GHSA-example",
        summary: "Fixture advisory",
        database_specific: { severity: "HIGH" },
        affected: [
          {
            package: { ecosystem: "npm", name: "public-example" },
            ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.5.0" }] }],
          },
        ],
      });
    return Response.json({
      name: "public-example",
      "dist-tags": { latest: "2.0.0" },
      versions: { "1.0.0": {}, "1.5.0": {}, "1.7.0-beta.1": {}, "2.0.0": {} },
    });
  };
  const lookedUp = await lookupDependencies(inputs.dependencies, fetcher);
  const alias = lookedUp.dependencies.find((d) => d.name === "alias");
  assert.equal(alias.availableVersion, "1.5.0");
  assert.equal(alias.latestVersion, "2.0.0");
  assert.equal(alias.versionStatus, "checked");
  assert.equal(alias.advisoryStatus, "checked");
  assert.deepEqual(alias.advisoryIds, ["GHSA-example"]);
  assert.equal(lookedUp.advisories.get(alias.id)[0].fixed, "1.5.0");
  assert.equal(lookedUp.advisories.get(alias.id)[0].severity, "high");
  assert.ok(requests.every((r) => !r.url.endsWith("/alias")));
  await writeFile(
    join(root, ".npmrc"),
    "registry=https://private.example.invalid\n//private.example.invalid/:_authToken=never-log-me\n",
  );
  const privateInputs = await inspectProject(root);
  assert.ok(privateInputs.dependencies.every((d) => d.origin === "unknown"));
  let queried = false;
  await lookupDependencies(privateInputs.dependencies, async () => {
    queried = true;
    throw new Error();
  });
  assert.equal(queried, false);
});

test("offline and paginated OSV responses stay failed instead of reassuring clean results", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const inputs = await inspectProject(root);
  const offline = await lookupDependencies(inputs.dependencies, async () => {
    throw new Error("offline");
  });
  assert.ok(offline.dependencies.every((d) => d.advisoryStatus === "failed"));
  assert.equal(offline.dependencies.find((d) => d.name === "alias").versionStatus, "failed");
  assert.equal(
    offline.dependencies.find((d) => d.name === "transitive").versionStatus,
    "unsupported",
  );
  assert.ok(offline.errors.length);
  const paginated = await lookupDependencies(inputs.dependencies, async (url) =>
    url.endsWith("/querybatch")
      ? Response.json({ results: [{ next_page_token: "more" }, {}] })
      : Response.json({}),
  );
  assert.ok(paginated.dependencies.every((d) => d.advisoryStatus === "failed"));
});

test("successfully current direct dependencies differ from failed checks and every eligible name is attempted", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const inputs = await inspectProject(root);
  const current = await lookupDependencies(inputs.dependencies, async (url) =>
    url.endsWith("/querybatch")
      ? Response.json({ results: [{}, {}] })
      : Response.json({
          name: "public-example",
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": {} },
        }),
  );
  const checked = current.dependencies.find((d) => d.name === "alias");
  assert.equal(checked.versionStatus, "checked");
  assert.equal(checked.availableVersion, null);
  assert.equal(checked.latestVersion, null);
  assert.equal(inputs.dependencies.find((d) => d.name === "alias").versionStatus, "not-checked");
  const direct = inputs.dependencies.find((d) => d.name === "alias");
  const additional = {
    ...direct,
    id: "another-id",
    name: "another-name",
    packageName: "another-name",
  };
  const failed = await lookupDependencies([...inputs.dependencies, additional], async () => {
    throw new Error("offline");
  });
  assert.equal(failed.dependencies.find((d) => d.name === "alias").versionStatus, "failed");
  assert.equal(failed.dependencies.find((d) => d.name === "another-name").versionStatus, "failed");
});

test("lookup progress measures actual batches and attempts while failed names leave other checks running", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const base = (await inspectProject(root)).dependencies.find((d) => d.name === "alias");
  const dependencies = Array.from({ length: 121 }, (_, index) => ({
    ...base,
    id: `progress-${index}`,
    name: `progress-${index}`,
    packageName: `progress-${index}`,
    role: index < 3 ? "production" : "transitive",
  }));
  const progress = [];
  const results = await lookupDependencies(
    dependencies,
    async (url, options) => {
      if (url.endsWith("/querybatch")) {
        const queries = JSON.parse(options.body).queries;
        return Response.json({
          results: queries.map((query) =>
            query.package.name === "progress-0" ? { vulns: [{ id: "GHSA-progress" }] } : {},
          ),
        });
      }
      if (url.includes("/vulns/")) throw new Error("Detail source unavailable");
      if (url.endsWith("/progress-1")) throw new Error("Registry unavailable");
      return Response.json({
        name: decodeURIComponent(new URL(url).pathname.slice(1)),
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": {} },
      });
    },
    undefined,
    (value) => progress.push(value),
  );
  assert.deepEqual(
    progress.filter((p) => p.stage === "advisories"),
    [0, 100, 121].map((completed) => ({ stage: "advisories", completed, total: 121 })),
  );
  assert.deepEqual(
    progress.filter((p) => p.stage === "advisory-details"),
    [0, 1].map((completed) => ({ stage: "advisory-details", completed, total: 1 })),
  );
  assert.deepEqual(
    progress.filter((p) => p.stage === "versions"),
    [0, 1, 2, 3].map((completed) => ({ stage: "versions", completed, total: 3 })),
  );
  assert.equal(results.dependencies[1].versionStatus, "failed");
  assert.equal(results.dependencies[2].versionStatus, "checked");
  assert.equal(results.advisories.get("progress-0")[0].detailsUnavailable, true);
});

test("a failed OSV batch remains unverified while later batches collect advisory evidence", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const base = (await inspectProject(root)).dependencies.find((d) => d.name === "alias");
  const dependencies = Array.from({ length: 121 }, (_, index) => ({
    ...base,
    id: `osv-batch-${index}`,
    name: `osv-batch-${index}`,
    packageName: `osv-batch-${index}`,
    requested: "^1.0.0",
    role: index === 120 ? "production" : "transitive",
  }));
  const batches = [];
  const progress = [];
  const result = await lookupDependencies(
    dependencies,
    async (url, options) => {
      if (url.endsWith("/querybatch")) {
        const queries = JSON.parse(options.body).queries;
        batches.push(queries.length);
        if (batches.length === 1) return new Response("OSV unavailable", { status: 503 });
        return Response.json({
          results: queries.map((query) =>
            query.package.name === "osv-batch-120" ? { vulns: [{ id: "GHSA-late-batch" }] } : {},
          ),
        });
      }
      if (url.includes("/vulns/"))
        return Response.json({
          id: "GHSA-late-batch",
          summary: "Advisory in the later batch",
          database_specific: { severity: "HIGH" },
        });
      return Response.json({
        name: "osv-batch-120",
        "dist-tags": { latest: "1.5.0" },
        versions: { "1.0.0": {}, "1.5.0": {} },
      });
    },
    undefined,
    (value) => progress.push(value),
  );
  assert.deepEqual(batches, [100, 21]);
  for (let index = 0; index < result.dependencies.length; index++)
    assert.equal(result.dependencies[index].advisoryStatus, index < 100 ? "failed" : "checked");
  assert.deepEqual(result.dependencies[120].advisoryIds, ["GHSA-late-batch"]);
  assert.equal(result.advisories.get("osv-batch-120")[0].severity, "high");
  assert.equal(result.dependencies[120].versionStatus, "checked");
  assert.ok(result.errors.some((error) => /Known-advisory lookup failed/.test(error)));
  assert.ok(
    result.coverage.includes("OSV npm version queries: 21/121 resolved dependency records"),
  );
  assert.deepEqual(
    progress.filter((value) => value.stage === "advisories"),
    [0, 100, 121].map((completed) => ({ stage: "advisories", completed, total: 121 })),
  );
});

test("project lookups check every unique direct name beyond 100 with bounded concurrency and isolated failures", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const base = (await inspectProject(root)).dependencies.find((d) => d.name === "alias");
  const dependencies = Array.from({ length: 105 }, (_, index) => ({
    ...base,
    id: `complete-${index}`,
    name: `complete-${index}`,
    packageName: `complete-${index}`,
    requested: "^1.0.0",
    role: ["production", "development", "optional"][index % 3],
  }));
  dependencies.push(
    {
      ...dependencies[104],
      id: "alias-last",
      name: "alias-last",
      requested: "npm:complete-104@^1.0.0",
      importer: "packages/alias",
    },
    {
      ...dependencies[104],
      id: "second-importer",
      requested: "^2.0.0",
      importer: "packages/other",
    },
    { ...base, id: "transitive-only", packageName: "transitive-only", role: "transitive" },
    { ...base, id: "private-only", packageName: "private-only", origin: "unknown" },
  );
  const requests = [];
  const progress = [];
  let active = 0;
  let maximum = 0;
  let failedResponseCanceled = false;
  const startedAt = Date.now();
  let scanClock = startedAt;
  t.mock.method(Date, "now", () => scanClock);
  const result = await lookupDependencies(
    dependencies,
    async (url, options) => {
      if (url.endsWith("/querybatch"))
        return Response.json({ results: JSON.parse(options.body).queries.map(() => ({})) });
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      requests.push(name);
      maximum = Math.max(maximum, ++active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        scanClock += 1000;
        if (name === "complete-0")
          return new Response(
            new ReadableStream({
              cancel() {
                failedResponseCanceled = true;
              },
            }),
            { status: 503 },
          );
        return Response.json({
          name: name === "complete-2" ? "another-package" : name,
          "dist-tags": { latest: "2.0.0" },
          versions: { "1.0.0": {}, "1.5.0": {}, "2.0.0": {} },
        });
      } finally {
        active--;
      }
    },
    undefined,
    (value) => progress.push(value),
  );
  assert.equal(requests.length, 105);
  assert.equal(
    failedResponseCanceled,
    true,
    "An unavailable response must release its unread body",
  );
  assert.ok(
    scanClock - startedAt > 90000,
    "A fixed 90-second scan ceiling must not skip later names",
  );
  assert.equal(
    new Set(requests).size,
    105,
    "Aliases and importers share canonical metadata requests",
  );
  assert.ok(
    maximum > 1 && maximum <= 4,
    `Registry concurrency must be bounded at four, got ${maximum}`,
  );
  assert.ok(!requests.includes("alias-last"));
  assert.ok(!requests.includes("transitive-only"));
  assert.ok(!requests.includes("private-only"));
  for (const dependency of result.dependencies) {
    if (["private-only", "transitive-only"].includes(dependency.id)) {
      assert.equal(dependency.versionStatus, "unsupported");
      continue;
    }
    const failed = ["complete-0", "complete-2"].includes(dependency.packageName);
    assert.equal(dependency.versionStatus, failed ? "failed" : "checked");
    assert.equal(result.versionChecked.has(dependency.id), !failed);
  }
  assert.equal(result.dependencies.find((d) => d.id === "complete-104").availableVersion, "1.5.0");
  assert.equal(result.dependencies.find((d) => d.id === "alias-last").availableVersion, "1.5.0");
  assert.equal(
    result.dependencies.find((d) => d.id === "second-importer").availableVersion,
    "2.0.0",
  );
  assert.deepEqual(
    progress.filter((value) => value.stage === "versions"),
    Array.from({ length: 106 }, (_, completed) => ({ stage: "versions", completed, total: 105 })),
  );
  assert.ok(result.errors.some((error) => /version lookup failed/.test(error)));
  assert.ok(!result.errors.some((error) => /limited to/.test(error)));
});

test("all advisory details beyond 50 are attempted with bounded concurrency and unavailable IDs retained", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const dependencies = (await inspectProject(root)).dependencies;
  const ids = Array.from({ length: 55 }, (_, index) => `GHSA-detail-${index}`);
  const requests = [];
  const progress = [];
  let active = 0;
  let maximum = 0;
  const result = await lookupDependencies(
    dependencies,
    async (url, options) => {
      if (url.endsWith("/querybatch"))
        return Response.json({
          results: JSON.parse(options.body).queries.map((query) =>
            query.package.name === "public-example" ? { vulns: ids.map((id) => ({ id })) } : {},
          ),
        });
      if (url.includes("/vulns/")) {
        const id = new URL(url).pathname.split("/").at(-1);
        requests.push(id);
        maximum = Math.max(maximum, ++active);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          if (id === "GHSA-detail-3") throw new Error("Advisory source unavailable");
          return Response.json({
            id,
            summary: "Known advisory " + id,
            database_specific: { severity: "HIGH" },
            affected: [
              {
                package: { ecosystem: "npm", name: "public-example" },
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.5.0" }] }],
              },
            ],
          });
        } finally {
          active--;
        }
      }
      return Response.json({
        name: "public-example",
        "dist-tags": { latest: "1.5.0" },
        versions: { "1.0.0": {}, "1.5.0": {} },
      });
    },
    undefined,
    (value) => progress.push(value),
  );
  assert.deepEqual([...requests].sort(), [...ids].sort());
  assert.ok(
    maximum > 1 && maximum <= 4,
    `Advisory detail concurrency must be bounded at four, got ${maximum}`,
  );
  const advisory = result.advisories.get(dependencies.find((d) => d.name === "alias").id);
  assert.equal(advisory.length, 55);
  assert.equal(advisory.find((item) => item.id === "GHSA-detail-54").fixed, "1.5.0");
  assert.equal(advisory.find((item) => item.id === "GHSA-detail-54").severity, "high");
  assert.equal(advisory.find((item) => item.id === "GHSA-detail-3").detailsUnavailable, true);
  assert.equal(advisory.find((item) => item.id === "GHSA-detail-3").severity, "unknown");
  assert.deepEqual(
    progress.filter((value) => value.stage === "advisory-details"),
    Array.from({ length: 56 }, (_, completed) => ({
      stage: "advisory-details",
      completed,
      total: 55,
    })),
  );
  assert.ok(result.errors.some((error) => /advisory details are unavailable/.test(error)));
  assert.ok(!result.errors.some((error) => /limited to/.test(error)));
});

test("cancelling project lookup stops launching further registry batches", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const base = (await inspectProject(root)).dependencies.find((d) => d.name === "alias");
  const dependencies = Array.from({ length: 12 }, (_, index) => ({
    ...base,
    id: `cancel-${index}`,
    name: `cancel-${index}`,
    packageName: `cancel-${index}`,
  }));
  const controller = new AbortController();
  const requests = [];
  let launchedAfterAbort = 0;
  await assert.rejects(
    lookupDependencies(
      dependencies,
      async (url, options) => {
        if (url.endsWith("/querybatch"))
          return Response.json({ results: JSON.parse(options.body).queries.map(() => ({})) });
        if (controller.signal.aborted) launchedAfterAbort++;
        requests.push(url);
        if (requests.length === 1) queueMicrotask(() => controller.abort());
        return new Promise((_, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else
            options.signal.addEventListener("abort", () => reject(options.signal.reason), {
              once: true,
            });
        });
      },
      controller.signal,
    ),
    /scan stopped|scan cancelled/i,
  );
  assert.ok(requests.length > 0 && requests.length <= 4);
  assert.equal(launchedAfterAbort, 0);
});

test("durable attempts preserve successful evidence on failure and restart; new findings notify once", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  const lookup = async (dependencies) => ({
    dependencies: dependencies.map((d) => ({
      ...d,
      availableVersion: d.name === "alias" ? "1.5.0" : null,
      advisoryStatus: "checked",
    })),
    advisories: new Map(),
    coverage: ["Injected public-source evidence"],
    errors: [],
  });
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  const first = coordinator.snapshot();
  assert.equal(first.projects[0].evidence.status, "complete");
  assert.match(first.projects[0].inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.history[0].inputFingerprint, first.projects[0].inputFingerprint);
  assert.equal(first.notifications.length, 1);
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 1);
  const lastSuccess = coordinator.snapshot().projects[0].evidence.lastSuccess;
  coordinator.acknowledgeNotification(first.notifications[0].id);
  await writeFile(join(projectRoot, "package-lock.json"), "broken");
  await scan(coordinator, project.id);
  const failed = coordinator.snapshot();
  assert.equal(failed.projects[0].evidence.status, "failed");
  assert.equal(failed.projects[0].evidence.lastSuccess, lastSuccess);
  assert.equal(failed.projects[0].dependencies.length, first.projects[0].dependencies.length);
  assert.ok(failed.findings.some((f) => f.kind === "update"));
  assert.notEqual(failed.projects[0].evidence.lastAttempt, failed.projects[0].evidence.lastSuccess);
  await coordinator.close();
  const storage = new MonitoringStorage(join(root, "state"));
  const interrupted = storage.read();
  interrupted.snapshot.projects[0].evidence.status = "scanning";
  interrupted.snapshot.history[0].status = "scanning";
  interrupted.snapshot.history[0].finishedAt = null;
  storage.write(interrupted);
  storage.close();
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  const restarted = coordinator.snapshot();
  assert.equal(restarted.settings.paused, true);
  assert.equal(restarted.projects[0].evidence.status, "failed");
  assert.match(restarted.projects[0].evidence.errors[0], /stopped before/);
  assert.equal(restarted.projects[0].dependencies.length, first.projects[0].dependencies.length);
  assert.ok(restarted.notifications[0].deliveredAt);
  await npmFixture(projectRoot);
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 1);
});

test("single scan queue coalesces repeated requests and paused schedules catch up only once", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  let release;
  let entered = false;
  const lookup = async (dependencies) => {
    entered = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    return { dependencies, advisories: new Map(), coverage: [], errors: [] };
  };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
    inventoryLookup: async () => ({
      installations: [],
      managers: [],
      checkedRoots: [],
      coverage: [],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: "complete",
    }),
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "watch" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(coordinator.snapshot().history.length, 0);
  coordinator.requestScan({ target: "projects", projectId: project.id });
  await waitFor(() => entered);
  for (let i = 0; i < 10; i++)
    coordinator.requestScan({ target: "projects", projectId: project.id });
  release();
  await waitFor(() => coordinator.snapshot().projects[0].evidence.status !== "scanning");
  assert.equal(coordinator.snapshot().history.filter((a) => a.targetId === project.id).length, 1);
  assert.throws(() => coordinator.changeSettings({ projectIntervalMinutes: 1 }));
  assert.throws(() => coordinator.changeSettings({ pcIntervalMinutes: Number.NaN }));
  assert.equal(coordinator.snapshot().runtime.nextScanAt, null);
  coordinator.changeSettings({ paused: false });
  coordinator.requestScan({ target: "pc" });
  await waitFor(() =>
    coordinator.snapshot().history.some((a) => a.kind === "pc" && a.status !== "scanning"),
  );
  assert.equal(coordinator.snapshot().history.filter((a) => a.targetId === project.id).length, 1);
  assert.ok(coordinator.snapshot().runtime.nextScanAt);
});

test("first-use PC evidence stays empty until a manual scan starts its normal schedule", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const inventoryLookup = async (_platform, _mode, _signal, progress) => {
    progress?.({ stage: "inventory", completed: null, total: null });
    return {
      installations: [],
      coverage: [],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: "complete",
      checkedRoots: [],
      managers: [],
    };
  };
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  coordinator.changeSettings({ pcIntervalMinutes: 5 });
  assert.equal(coordinator.snapshot().runtime.nextScanAt, null);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(coordinator.snapshot().inventory.evidence.status, "not-scanned");
  assert.equal(coordinator.snapshot().history.length, 0);
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  const legacyUnscanned = storage.read();
  legacyUnscanned.due.pc = Date.now() - 60000;
  storage.write(legacyUnscanned);
  storage.close();
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  assert.equal(
    coordinator.snapshot().runtime.nextScanAt,
    null,
    "Legacy unscanned automatic due times must also preserve the first-use prompt",
  );
  coordinator.requestScan({ target: "pc" });
  await waitFor(() => coordinator.snapshot().history[0]?.status === "complete");
  assert.equal(coordinator.snapshot().inventory.updateEvidence.status, "complete");
  assert.ok(Date.parse(coordinator.snapshot().runtime.nextScanAt) > Date.now());
});

test("global tool findings preserve failed roots and distinguish npm/Bun installations", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const checkedAt = "2026-10-02T08:00:00.000Z";
  const source = (manager) => ({
    manager,
    status: "detected",
    version: manager === "npm" ? "11.6.0" : "1.3.0",
    root: join(root, manager, "node_modules"),
    registry: "public",
    blockedScopes: [],
    checkedAt,
    error: null,
  });
  const managers = [source("npm"), source("bun")];
  const rootId = (manager) => identity("global-root", manager, source(manager).root);
  const installation = (
    manager,
    version = "1.0.0",
    availableVersion = "2.0.0",
    alias = "public-example",
  ) => ({
    id: identity("global-tool", manager, source(manager).root, alias, version),
    name: alias,
    packageId: "public-example",
    version,
    manager,
    rootId: rootId(manager),
    origin: "registry",
    source: manager,
    scope: "user",
    channel: "stable",
    availableVersion,
    updateStatus: availableVersion ? "available" : "current",
    updateCheckedAt: checkedAt,
  });
  let result = {
    installations: [installation("npm"), installation("bun")],
    coverage: ["Top-level npm/Bun global roots and public npm stable releases"],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
    checkedRoots: managers.map((m) => rootId(m.manager)),
    managers,
  };
  const passedSources = [];
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    mode: "background",
    inventoryLookup: async (_platform, _mode, _signal, _progress, sources) => {
      passedSources.push(structuredClone(sources));
      return result;
    },
  });
  coordinator.changeSettings({ paused: true });
  const pcScan = async () => {
    const previous = coordinator.snapshot().history[0]?.id;
    coordinator.requestScan({ target: "pc" });
    await waitFor(() => {
      const latest = coordinator.snapshot().history[0];
      return latest?.id !== previous && latest?.status !== "scanning";
    });
  };
  await pcScan();
  assert.equal(coordinator.snapshot().inventory.installations.length, 2);
  assert.equal(
    coordinator.snapshot().inventory.updateEvidence.status,
    "complete",
    "Background collection of captured owner roots must not force partial coverage",
  );
  assert.deepEqual(coordinator.snapshot().inventory.managers, managers);
  assert.deepEqual(passedSources[0], []);
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  assert.equal(
    coordinator.snapshot().notificationSummary.updateCount,
    2,
    "Identical tools in npm and Bun are separate actual installations",
  );
  assert.equal(coordinator.snapshot().notificationSummary.pcCount, 1);
  const bunFinding = coordinator.snapshot().findings.find((f) => f.source === "bun");
  result = {
    ...result,
    installations: [installation("npm", "1.0.0", null)],
    inventoryChecks: "partial",
    updateChecks: "partial",
    checkedRoots: [rootId("npm")],
    errors: ["The captured Bun global root is inaccessible."],
    managers: [
      source("npm"),
      { ...source("bun"), status: "unavailable", error: "Global root is inaccessible." },
    ],
  };
  await pcScan();
  const partial = coordinator.snapshot();
  const retained = partial.inventory.installations.find((i) => i.manager === "bun");
  assert.equal(retained.updateStatus, "unknown");
  assert.equal(retained.availableVersion, "2.0.0");
  assert.equal(retained.updateCheckedAt, checkedAt);
  assert.equal(partial.findings.filter((f) => f.kind === "update").length, 1);
  assert.equal(
    partial.findings.find((f) => f.id === bunFinding.id).lastSeenAt,
    bunFinding.lastSeenAt,
    "Failed root refresh must not make previous registry evidence look fresh",
  );
  assert.equal(partial.notifications.length, 1, "The freshly resolved npm event must be pruned");
  assert.deepEqual(passedSources[1], managers);
  const updateSuccess = partial.inventory.updateEvidence.lastSuccess;
  const inventorySuccess = partial.inventory.evidence.lastSuccess;
  result = {
    ...result,
    installations: [],
    inventoryChecks: "failed",
    updateChecks: "failed",
    checkedRoots: [],
    errors: ["Global tool roots could not be inspected."],
  };
  await pcScan();
  const failed = coordinator.snapshot();
  assert.equal(failed.inventory.evidence.status, "failed");
  assert.equal(failed.inventory.evidence.lastSuccess, inventorySuccess);
  assert.equal(failed.inventory.updateEvidence.status, "failed");
  assert.equal(failed.inventory.updateEvidence.lastSuccess, updateSuccess);
  assert.equal(
    failed.notifications.length,
    1,
    "Failed refresh must not create another notification",
  );
  assert.equal(failed.findings.filter((f) => f.kind === "update").length, 1);
  result = {
    ...result,
    installations: [installation("bun", "2.0.0", null)],
    inventoryChecks: "partial",
    updateChecks: "partial",
    checkedRoots: [rootId("bun")],
    errors: ["The npm global root is inaccessible."],
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().findings.filter((f) => f.kind === "update").length,
    0,
    "A fresh observed installed version replaces stale evidence in a partial scan",
  );
  assert.equal(coordinator.snapshot().notifications.length, 0);
  result = {
    ...result,
    installations: [],
    checkedRoots: [rootId("bun")],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().inventory.installations.length,
    1,
    "An empty covered Bun root removes its observations; unread npm observations remain",
  );
  result = {
    ...result,
    installations: [installation("npm")],
    managers,
    checkedRoots: [rootId("npm")],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  };
  await pcScan();
  const replacement = { ...source("npm"), root: join(root, "replacement-npm", "node_modules") };
  const changedSources = [replacement, source("bun")];
  await coordinator.changeGlobalToolSources(changedSources);
  result = {
    ...result,
    installations: [],
    managers: changedSources,
    checkedRoots: [],
    inventoryChecks: "failed",
    updateChecks: "failed",
    errors: ["The replacement root is inaccessible."],
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().inventory.installations.length,
    1,
    "Changing captured sources must not erase evidence while the new root cannot be inspected",
  );
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 1);
  result = {
    ...result,
    checkedRoots: [identity("global-root", "npm", replacement.root)],
    inventoryChecks: "complete",
    updateChecks: "complete",
    errors: [],
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().inventory.installations.length,
    0,
    "A covered replacement root retires the old root even after source capture overwrote its descriptor",
  );
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 0);
  assert.equal(coordinator.snapshot().notifications.length, 0);
  result = {
    ...result,
    installations: [installation("bun")],
    managers,
    checkedRoots: [rootId("bun")],
  };
  await pcScan();
  result = {
    ...result,
    installations: [],
    checkedRoots: [],
    managers: [
      source("npm"),
      { ...source("bun"), status: "not-installed", root: null, version: null },
    ],
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().inventory.installations.length,
    0,
    "Confirmed manager removal retires its previous roots without a successful package enumeration",
  );
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 0);
  const aliases = [
    installation("npm", "1.0.0", "2.0.0", "first-alias"),
    installation("npm", "1.0.0", "2.0.0", "second-alias"),
  ];
  result = {
    ...result,
    installations: aliases,
    managers,
    checkedRoots: [rootId("npm")],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().findings.filter((f) => f.kind === "update").length,
    2,
    "Aliases of one canonical package are different global installation locations",
  );
  result = {
    ...result,
    installations: [installation("npm", "1.0.0", null, "first-alias")],
    checkedRoots: [],
    errors: ["The second alias could not be read."],
    inventoryChecks: "partial",
    updateChecks: "partial",
  };
  await pcScan();
  const unreadAlias = coordinator
    .snapshot()
    .inventory.installations.find((i) => i.name === "second-alias");
  assert.ok(
    unreadAlias,
    "Failed alias evidence must remain visible after another alias is observed",
  );
  assert.equal(
    unreadAlias.availableVersion,
    "2.0.0",
    "Observing another alias of the same canonical package must not erase failed alias evidence",
  );
  assert.equal(unreadAlias.updateStatus, "unknown");
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 1);
  result = {
    ...result,
    installations: [
      {
        ...aliases[1],
        packageId: "different-public-example",
        updateStatus: "unknown",
        availableVersion: null,
        updateCheckedAt: null,
      },
    ],
  };
  await pcScan();
  const retargeted = coordinator
    .snapshot()
    .inventory.installations.filter((i) => i.name === "second-alias");
  assert.equal(
    retargeted.length,
    1,
    "A fresh alias location replaces its previous canonical identity",
  );
  assert.equal(
    retargeted[0].availableVersion,
    null,
    "Retargeting an alias to another package at the same version must not inherit the old upgrade candidate",
  );
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 0);
  assert.equal(coordinator.snapshot().notifications.length, 0);
});

test("captured global roots persist and cannot be replaced during their active scan", async (t) => {
  let coordinator;
  let release;
  t.after(() => {
    release?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const sourceRoot = join(root, "npm", "node_modules");
  const otherRoot = join(root, "other-npm", "node_modules");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(otherRoot, { recursive: true });
  const source = {
    manager: "npm",
    status: "detected",
    version: "11.6.0",
    root: sourceRoot,
    registry: "public",
    blockedScopes: [],
    checkedAt: new Date().toISOString(),
    error: null,
  };
  const missingBun = {
    manager: "bun",
    status: "not-installed",
    version: null,
    root: null,
    registry: "unknown",
    blockedScopes: [],
    checkedAt: source.checkedAt,
    error: null,
  };
  const sources = [source, missingBun];
  let entered = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const inventoryLookup = async (_platform, _mode, _signal, _progress, capturedSources) => {
    entered = true;
    await gate;
    return {
      installations: [],
      managers: [...capturedSources],
      checkedRoots: [identity("global-root", "npm", sourceRoot)],
      coverage: ["Captured global root"],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: "complete",
    };
  };
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  const captured = await coordinator.changeGlobalToolSources(sources);
  assert.deepEqual(captured.inventory.managers, sources);
  assert.equal(captured.inventory.evidence.status, "not-scanned");
  const unavailable = {
    ...source,
    status: "unavailable",
    root: null,
    version: null,
    registry: "unknown",
    error: "The manager configuration could not be checked.",
  };
  const fallback = await coordinator.changeGlobalToolSources([unavailable, missingBun]);
  const previousLocation = [
    { ...unavailable, root: source.root, version: source.version },
    missingBun,
  ];
  assert.deepEqual(
    fallback.inventory.managers,
    previousLocation,
    "An unavailable capture retains its last known location without reusing public registry trust",
  );
  await coordinator.close();
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  assert.deepEqual(coordinator.snapshot().inventory.managers, previousLocation);
  await coordinator.changeGlobalToolSources(sources);
  coordinator.requestScan({ target: "pc" });
  await waitFor(() => entered);
  await assert.rejects(
    coordinator.changeGlobalToolSources([{ ...source, root: otherRoot }, missingBun]),
    /Wait for the PC scan/,
  );
  release();
  await waitFor(() => coordinator.snapshot().history[0]?.status === "complete");
  assert.deepEqual(coordinator.snapshot().inventory.managers, sources);
  await coordinator.close();
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  assert.deepEqual(coordinator.snapshot().inventory.managers, sources);
});

test("legacy Windows inventory migration clears only active PC data and runs once", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "selected");
  await npmFixture(projectRoot);
  const dataDir = join(root, "state");
  const inventoryLookup = async () => ({
    installations: [
      {
        id: "global-new",
        name: "public-example",
        packageId: "public-example",
        version: "1.0.0",
        manager: "npm",
        rootId: "npm-root",
        origin: "registry",
        source: "npm",
        scope: "user",
        channel: "stable",
        updateStatus: "current",
        availableVersion: null,
      },
    ],
    managers: [],
    checkedRoots: ["npm-root"],
    coverage: ["Captured global root"],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  });
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false, inventoryLookup });
  coordinator.changeSettings({ paused: true, pcIntervalMinutes: 15 });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  const before = coordinator.snapshot();
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  const saved = storage.read();
  delete saved.snapshot.inventory.collector;
  delete saved.snapshot.inventory.managers;
  saved.snapshot.inventory.installations = [
    {
      id: "old-winget",
      name: "Old Windows app",
      version: "1.0",
      source: "WinGet",
      scope: "machine",
      channel: "Unknown",
      packageId: "Publisher.App",
      updateStatus: "available",
      availableVersion: "2.0",
    },
  ];
  saved.snapshot.inventory.evidence = {
    status: "complete",
    lastAttempt: "2026-10-01T10:00:00.000Z",
    lastSuccess: "2026-10-01T10:00:00.000Z",
    coverage: ["Windows registry"],
    errors: [],
  };
  const finding = (subjectId, id) => ({
    id,
    subjectId,
    subjectLabel: "Fixture",
    kind: "update",
    name: "Tool",
    packageName: "tool",
    installedVersion: "1.0.0",
    availableVersion: "2.0.0",
    severity: "info",
    source: "Fixture",
    description: "Update",
    advisoryUrl: null,
    detectedAt: "2026-10-01T10:00:00.000Z",
    lastSeenAt: "2026-10-01T10:00:00.000Z",
  });
  saved.snapshot.findings = [
    finding(before.device.id, "old-pc"),
    finding(project.id, "project-finding"),
  ];
  saved.snapshot.notifications = ["old-pc", "project-finding"].map((id) => ({
    id: `notification-${id}`,
    findingId: id,
    title: "Update",
    body: "Update",
    createdAt: "2026-10-01T10:00:00.000Z",
    deliveredAt: null,
  }));
  saved.notified = ["old-pc", "project-finding"];
  saved.due.pc = Date.now() - 60000;
  storage.write(saved);
  storage.close();
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false, inventoryLookup });
  const migrated = coordinator.snapshot();
  assert.equal(migrated.inventory.collector, "npm-bun-global-v1");
  assert.equal(migrated.inventory.evidence.status, "not-scanned");
  assert.deepEqual(migrated.inventory.installations, []);
  assert.deepEqual(migrated.inventory.managers, []);
  assert.deepEqual(migrated.projects, before.projects);
  assert.deepEqual(migrated.history, before.history);
  assert.deepEqual(migrated.settings, before.settings);
  assert.equal(migrated.device.id, before.device.id);
  assert.deepEqual(
    migrated.findings.map((f) => f.id),
    ["project-finding"],
  );
  assert.deepEqual(
    migrated.notifications.map((n) => n.findingId),
    ["project-finding"],
  );
  coordinator.requestScan({ target: "pc" });
  await waitFor(() => coordinator.snapshot().history[0]?.status === "complete");
  const collected = coordinator.snapshot().inventory;
  await coordinator.close();
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false, inventoryLookup });
  assert.deepEqual(
    coordinator.snapshot().inventory,
    collected,
    "Migration must not repeat on next startup",
  );
});

test("severity/fix changes notify, while failed detail and version refreshes retain known evidence quietly", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  let severity = "high";
  let fixed = "1.5.0";
  let detailsUnavailable = false;
  let versionsFailed = false;
  const lookup = async (dependencies) => {
    const alias = dependencies.find((d) => d.name === "alias");
    return {
      dependencies: dependencies.map((d) => ({
        ...d,
        availableVersion: !versionsFailed && d.id === alias.id ? "1.5.0" : null,
        versionStatus:
          d.role === "transitive" ? "unsupported" : versionsFailed ? "failed" : "checked",
        advisoryStatus: "checked",
        advisoryIds: d.id === alias.id ? ["GHSA-fixture"] : [],
      })),
      advisories: new Map([
        [
          alias.id,
          [
            {
              id: "GHSA-fixture",
              summary: "Fixture advisory",
              severity: detailsUnavailable ? "unknown" : severity,
              fixed: detailsUnavailable ? null : fixed,
              url: "https://osv.dev/vulnerability/GHSA-fixture",
              detailsUnavailable,
            },
          ],
        ],
      ]),
      coverage: [],
      errors: versionsFailed
        ? ["Public-registry version lookup failed."]
        : detailsUnavailable
          ? ["Some advisory details are unavailable."]
          : [],
    };
  };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 2);
  const firstAdvisory = coordinator.snapshot().findings.find((f) => f.kind === "advisory").id;
  severity = "critical";
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 2);
  const criticalAdvisory = coordinator.snapshot().findings.find((f) => f.kind === "advisory").id;
  assert.notEqual(criticalAdvisory, firstAdvisory);
  assert.ok(coordinator.snapshot().notifications.every((n) => n.findingId !== firstAdvisory));
  fixed = "1.7.0";
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 2);
  assert.ok(coordinator.snapshot().notifications.every((n) => n.findingId !== criticalAdvisory));
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 2);
  detailsUnavailable = true;
  versionsFailed = true;
  await scan(coordinator, project.id);
  const failedRefresh = coordinator.snapshot();
  assert.equal(failedRefresh.notifications.length, 2);
  assert.equal(failedRefresh.projects[0].evidence.status, "partial");
  assert.equal(
    failedRefresh.projects[0].dependencies.find((d) => d.name === "alias").availableVersion,
    "1.5.0",
  );
  assert.equal(
    failedRefresh.projects[0].dependencies.find((d) => d.name === "alias").versionStatus,
    "failed",
  );
  const advisory = failedRefresh.findings.find((f) => f.kind === "advisory");
  assert.equal(advisory.severity, "critical");
  assert.equal(advisory.availableVersion, "1.7.0");
});

test("mixed project refreshes clear checked identities while retaining failed identities and quiet notifications", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot, {
    dependencies: {
      alias: "npm:public-example@^1.0.0",
      refreshed: "^1.0.0",
      failed: "^1.0.0",
    },
  });
  const lock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
  for (const name of ["refreshed", "failed"])
    lock.packages[`node_modules/${name}`] = {
      version: "1.0.0",
      resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    };
  await writeFile(join(projectRoot, "package-lock.json"), JSON.stringify(lock));
  let phase = 1;
  const lookup = async (dependencies) => {
    if (phase === 3) throw new Error("Whole source lookup interrupted");
    const direct = dependencies.filter((d) => d.role !== "transitive");
    const checked = dependencies.map((d) => {
      const failed = phase === 2 && d.name === "failed";
      const actionable =
        d.role !== "transitive" && !failed && !(phase === 2 && d.name === "refreshed");
      return {
        ...d,
        availableVersion: actionable ? (phase === 2 ? "1.7.0" : "1.5.0") : null,
        versionStatus: d.role === "transitive" ? "unsupported" : failed ? "failed" : "checked",
        advisoryStatus: failed ? "failed" : "checked",
        advisoryIds: actionable ? [`GHSA-${d.packageName}`] : [],
      };
    });
    return {
      dependencies: checked,
      versionChecked: new Set(
        direct.filter((d) => !(phase === 2 && d.name === "failed")).map((d) => d.id),
      ),
      advisories: new Map(
        checked
          .filter((d) => d.advisoryIds.length)
          .map((d) => [
            d.id,
            [
              {
                id: d.advisoryIds[0],
                summary: "Mixed refresh fixture advisory",
                severity: phase === 2 ? "critical" : "high",
                fixed: phase === 2 ? "1.7.0" : "1.5.0",
                url: `https://osv.dev/vulnerability/${d.advisoryIds[0]}`,
              },
            ],
          ]),
      ),
      coverage: [],
      errors:
        phase === 2
          ? ["Public-registry version lookup failed.", "Known-advisory lookup failed."]
          : [],
    };
  };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 6);
  phase = 2;
  await scan(coordinator, project.id);
  const mixed = coordinator.snapshot();
  const actionable = mixed.findings.filter((f) => f.kind !== "coverage");
  assert.equal(actionable.length, 4);
  assert.equal(
    actionable.filter((f) => f.name === "refreshed").length,
    0,
    "Fresh current/nonaffected results must clear findings even when another identity fails",
  );
  assert.equal(actionable.filter((f) => f.name === "alias").length, 2);
  assert.ok(
    actionable.filter((f) => f.name === "alias").every((f) => f.availableVersion === "1.7.0"),
  );
  assert.equal(actionable.filter((f) => f.name === "failed").length, 2);
  assert.ok(
    actionable.filter((f) => f.name === "failed").every((f) => f.availableVersion === "1.5.0"),
  );
  assert.equal(mixed.notifications.length, 4);
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  assert.equal(coordinator.snapshot().notificationSummary.updateCount, 2);
  assert.equal(coordinator.snapshot().notificationSummary.advisoryCount, 2);
  const pendingIds = mixed.notifications.map((n) => n.id).sort();
  await scan(coordinator, project.id);
  assert.deepEqual(
    coordinator
      .snapshot()
      .notifications.map((n) => n.id)
      .sort(),
    pendingIds,
    "An identical partial rescan must not add notifications",
  );
  phase = 3;
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().projects[0].evidence.status, "failed");
  assert.deepEqual(
    coordinator
      .snapshot()
      .findings.filter((f) => f.kind !== "coverage")
      .map((f) => f.id)
      .sort(),
    actionable.map((f) => f.id).sort(),
    "A whole lookup failure must retain every previous actionable identity",
  );
  assert.deepEqual(
    coordinator
      .snapshot()
      .notifications.map((n) => n.id)
      .sort(),
    pendingIds,
  );
});

test("live progress and one settled summary preserve frozen receipts, new arrivals, and restart cooldown", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const releases = [];
  let calls = 0;
  const lookup = async (dependencies, _signal, onProgress) => {
    const call = ++calls;
    onProgress?.({ stage: "advisories", completed: 0, total: 2 });
    if (call <= 2) await new Promise((resolve) => releases.push(resolve));
    onProgress?.({ stage: "advisories", completed: 2, total: 2 });
    const alias = dependencies.find((d) => d.name === "alias");
    const checked = dependencies.map((d) => ({
      ...d,
      availableVersion: d.id === alias.id ? "1.5.0" : null,
      versionStatus: d.role === "transitive" ? "unsupported" : "checked",
      advisoryStatus: "checked",
      advisoryIds: call === 1 && d.id === alias.id ? ["GHSA-summary"] : [],
    }));
    checked.push({
      ...checked.find((d) => d.id === alias.id),
      id: `${alias.id}-duplicate`,
      importer: "other-workspace",
      advisoryIds: [],
    });
    return {
      dependencies: checked,
      versionChecked: new Set(
        checked.filter((d) => d.versionStatus === "checked").map((d) => d.id),
      ),
      advisories: new Map(
        call === 1
          ? [
              [
                alias.id,
                [
                  {
                    id: "GHSA-summary",
                    summary: "Summary fixture advisory",
                    severity: "high",
                    fixed: "1.5.0",
                    url: "https://osv.dev/vulnerability/GHSA-summary",
                  },
                ],
              ],
            ]
          : [],
      ),
      coverage: [],
      errors: [],
    };
  };
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  coordinator.changeSettings({ paused: true });
  const projects = [];
  for (const name of ["first", "second"]) {
    const projectRoot = join(root, name);
    await npmFixture(projectRoot);
    projects.push(await coordinator.addProject({ path: projectRoot, mode: "maintained" }));
  }
  coordinator.requestScan({ target: "projects" });
  await waitFor(() => releases.length === 1);
  const active = coordinator.snapshot();
  assert.equal(active.scanProgress.active.targetId, projects[0].id);
  assert.equal(active.scanProgress.active.stage, "advisories");
  assert.equal(active.scanProgress.active.completed, 0);
  assert.equal(active.scanProgress.active.total, 2);
  assert.equal(active.scanProgress.queued[0].targetId, projects[1].id);
  assert.equal(active.notificationSummary, null);
  releases[0]();
  await waitFor(() => releases.length === 2);
  assert.equal(
    coordinator.snapshot().notificationSummary,
    null,
    "Remaining target must settle first",
  );
  releases[1]();
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  assert.equal(
    coordinator.snapshot().notificationSummary,
    null,
    "Settling interval must remain quiet",
  );
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  const initial = coordinator.snapshot();
  const frozen = initial.notificationSummary;
  assert.equal(frozen.updateCount, 2, "Duplicate importer observations count once per project");
  assert.equal(frozen.newUpdateCount, 2);
  assert.equal(frozen.advisoryCount, 1);
  assert.equal(frozen.newAdvisoryCount, 1);
  assert.equal(frozen.projectCount, 2);
  assert.equal(frozen.pcCount, 0);
  assert.equal(frozen.filter, "all");
  assert.equal(
    initial.notifications.length,
    5,
    "Per-finding events remain durable behind one summary",
  );

  const thirdRoot = join(root, "third");
  await npmFixture(thirdRoot);
  const third = await coordinator.addProject({ path: thirdRoot, mode: "watch" });
  await scan(coordinator, third.id);
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  const newer = coordinator.snapshot().notificationSummary;
  assert.equal(newer.id, frozen.id, "New arrivals must not replace the frozen presentation");
  assert.equal(newer.updateCount, 3);
  assert.equal(newer.newUpdateCount, 2);
  coordinator.acknowledgeNotificationSummary(frozen.id);
  const delivered = coordinator.snapshot();
  assert.equal(delivered.notifications.filter((n) => n.deliveredAt !== null).length, 5);
  assert.equal(
    delivered.notifications.filter((n) => n.deliveredAt === null).length,
    2,
    "The old presentation receipt must leave newly discovered events pending",
  );
  assert.equal(delivered.notificationSummary, null);
  const cooldown = delivered.notificationNextAt;
  coordinator.acknowledgeNotificationSummary(frozen.id);
  assert.equal(
    coordinator.snapshot().notificationNextAt,
    cooldown,
    "Retries must not extend cooldown",
  );
  assert.throws(
    () => coordinator.acknowledgeNotificationSummary("unknown-summary"),
    /no longer available/,
  );
  await coordinator.close();
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  assert.equal(coordinator.snapshot().notificationNextAt, cooldown);
  assert.equal(coordinator.snapshot().notificationSummary, null);
  assert.equal(
    coordinator.snapshot().notifications.filter((n) => n.deliveredAt === null).length,
    2,
  );
  assert.equal(coordinator.snapshot().scanProgress.active, null);
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  const expired = storage.read();
  expired.snapshot.notificationNextAt = new Date(Date.now() - 1000).toISOString();
  storage.write(expired);
  storage.close();
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  const resolved = coordinator.snapshot().notificationSummary;
  coordinator.removeProject(third.id);
  assert.equal(
    coordinator.snapshot().notifications.filter((n) => n.deliveredAt === null).length,
    0,
  );
  const beforeResolvedReceipt = coordinator.snapshot().notificationNextAt;
  coordinator.acknowledgeNotificationSummary(resolved.id);
  assert.equal(
    coordinator.snapshot().notificationNextAt,
    beforeResolvedReceipt,
    "Fully resolved summaries must not postpone future notifications",
  );
});

test("shutdown cancels an in-flight public lookup and durably marks interruption without erasing evidence", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  const dataDir = join(root, "state");
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "watch" });
  await scan(coordinator, project.id);
  const original = coordinator.snapshot().projects[0];
  await coordinator.close();
  let started = false;
  const blockedFetch = async (_url, options) => {
    started = true;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    });
  };
  coordinator = new MonitoringCoordinator({
    dataDir,
    dependencyLookup: (deps, signal) => lookupDependencies(deps, blockedFetch, signal),
  });
  coordinator.requestScan({ target: "projects", projectId: project.id });
  await waitFor(() => started);
  const closing = Date.now();
  await coordinator.close();
  assert.ok(
    Date.now() - closing < 2000,
    "Shutdown should abort requests rather than wait for network timeouts.",
  );
  const storage = new MonitoringStorage(dataDir);
  const retained = storage.read().snapshot;
  storage.close();
  assert.equal(retained.projects[0].evidence.status, "failed");
  assert.equal(retained.projects[0].evidence.lastSuccess, original.evidence.lastSuccess);
  assert.deepEqual(retained.projects[0].dependencies, original.dependencies);
  assert.equal(retained.history[0].status, "failed");
});
