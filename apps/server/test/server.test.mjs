import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { fileURLToPath } from "node:url";
import { startServer } from "../dist/server.js";
import { decodeStatus } from "@versionstead/contracts/status";
import { decodeMonitoringProgress } from "@versionstead/contracts/monitoring";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import { InputError } from "../dist/adapters/projects.js";
import {
  acquireCoordinatorLock,
  createDataDirectory,
  CredentialStorageUnavailable,
  credentialStorageIssue,
  DATABASE_FILE,
  dataDirectoryNotRestricted,
  discardSecret,
  dpapi,
  dpapiScript,
  protectSecret,
  readRuntime,
  removeRuntime,
  resolveDataDir,
  runPowerShell,
  unprotectSecret,
  windowsPolicyBlocked,
  windowsPolicyIssue,
  writeRuntime,
} from "../dist/runtime.js";
import { randomBytes } from "node:crypto";
import { fakeKeyring } from "./credentials.mjs";

test("live coordinator reports its environment without claiming scanner coverage", async () => {
  const server = await startServer({ port: 0 });
  try {
    const response = await fetch(`${server.origin}/api/status`);
    assert.equal(response.status, 200);
    const status = decodeStatus(await response.json());
    assert.equal(status.environment.platform, process.platform);
    assert.equal(status.capabilities.inventory, false);
    assert.equal(status.capabilities.vulnerabilities, false);
    assert.throws(() => decodeStatus({ ...status, protocolVersion: 2 }));
    assert.throws(() =>
      decodeStatus({ ...status, capabilities: { ...status.capabilities, inventory: "yes" } }),
    );
    assert.equal((await fetch(`${server.origin}/api/status`, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(`${server.origin}/api/status`, { method: "POST" })).status, 405);
    const hostileHostStatus = await new Promise((resolve, reject) => {
      get(
        `${server.origin}/api/status`,
        { headers: { Host: "attacker.invalid" } },
        (hostileResponse) => {
          hostileResponse.resume();
          resolve(hostileResponse.statusCode);
        },
      ).on("error", reject);
    });
    assert.equal(hostileHostStatus, 403);
  } finally {
    await server.close();
  }
});

test("private monitoring validates capabilities, origins, bodies, and durable mutations", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-auth-"));
  const coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  coordinator.changeSettings({ paused: true });
  const token = randomBytes(32).toString("base64url");
  let shutdowns = 0;
  const server = await startServer({
    port: 0,
    monitoring: coordinator,
    authToken: token,
    onShutdown: () => {
      shutdowns++;
    },
  });
  const call = (path, method = "GET", body, headers = {}) =>
    fetch(`${server.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await fetch(`${server.origin}/api/monitoring`)).status, 401);
    assert.equal(
      (await call("/api/monitoring", "GET", undefined, { Authorization: "Bearer wrong" })).status,
      401,
    );
    assert.equal(
      (await call("/api/monitoring", "GET", undefined, { Origin: "https://attacker.invalid" }))
        .status,
      403,
    );
    assert.equal(
      (await call("/api/settings", "PATCH", { paused: false }, { "Sec-Fetch-Site": "cross-site" }))
        .status,
      403,
    );
    assert.equal((await call("/api/settings", "PATCH", { pcIntervalMinutes: 0 })).status, 400);
    for (const body of [
      { notificationScope: "everything" },
      { notificationScope: null },
      { notificationScope: 1 },
      { notifyWatchOnly: "yes" },
      { notifyWatchOnly: 1 },
      { notifyWatchOnly: null },
    ])
      assert.equal((await call("/api/settings", "PATCH", body)).status, 400, JSON.stringify(body));
    const scope = await call("/api/settings", "PATCH", {
      notificationScope: "high-advisories",
      notifyWatchOnly: true,
    });
    assert.equal(scope.status, 200);
    const routed = await scope.json();
    assert.deepEqual([routed.notificationScope, routed.notifyWatchOnly], ["high-advisories", true]);
    assert.equal((await call("/api/settings", "PATCH", { notifyWatchOnly: false })).status, 200);
    assert.deepEqual(
      [
        coordinator.snapshot().settings.notificationScope,
        coordinator.snapshot().settings.notifyWatchOnly,
      ],
      ["high-advisories", false],
      "A change names only what it changes",
    );
    for (const body of [
      { quietHours: { start: "22:00", end: "22:00" } },
      { quietHours: { start: "7:00", end: "22:00" } },
      { quietHours: { start: "22:00" } },
      { quietHours: { start: "22:00", end: "07:60" } },
      { quietHours: "22:00-07:00" },
      { digestAt: "24:00" },
      { digestAt: "18:60" },
      { digestAt: " 18:00" },
      { digestAt: "18:00:00" },
      { digestAt: "" },
      { digestAt: 1800 },
    ])
      assert.equal((await call("/api/settings", "PATCH", body)).status, 400, JSON.stringify(body));
    const timing = await call("/api/settings", "PATCH", {
      quietHours: { start: "22:00", end: "07:00" },
      digestAt: "18:00",
    });
    assert.equal(timing.status, 200);
    const timed = await timing.json();
    assert.deepEqual(
      [timed.quietHours, timed.digestAt],
      [{ start: "22:00", end: "07:00" }, "18:00"],
    );
    assert.equal((await call("/api/settings", "PATCH", { digestAt: null })).status, 200);
    assert.deepEqual(
      [coordinator.snapshot().settings.quietHours, coordinator.snapshot().settings.digestAt],
      [{ start: "22:00", end: "07:00" }, null],
      "A change names only what it changes, and null turns the digest off",
    );
    assert.equal((await call("/api/settings", "PATCH", { quietHours: null })).status, 200);
    assert.equal(coordinator.snapshot().settings.quietHours, null);
    for (const body of [
      { releaseCooldownDays: 31 },
      { releaseCooldownDays: -1 },
      { releaseCooldownDays: 2.5 },
      { releaseCooldownDays: "3" },
      { releaseCooldownDays: null },
      { useDepsDev: "no" },
      { useDepsDev: 1 },
      { useDepsDev: null },
    ])
      assert.equal((await call("/api/settings", "PATCH", body)).status, 400, JSON.stringify(body));
    const release = await call("/api/settings", "PATCH", {
      releaseCooldownDays: 7,
      useDepsDev: false,
    });
    assert.equal(release.status, 200);
    const saved = await release.json();
    assert.deepEqual([saved.releaseCooldownDays, saved.useDepsDev], [7, false]);
    const edges = await call("/api/settings", "PATCH", { releaseCooldownDays: 30 });
    assert.equal(edges.status, 200);
    assert.deepEqual(
      [(await edges.json()).releaseCooldownDays, coordinator.snapshot().settings.useDepsDev],
      [30, false],
      "A change names only what it changes",
    );
    assert.equal(
      (await call("/api/settings", "PATCH", { releaseCooldownDays: 0 })).status,
      200,
      "0 turns the cooldown off",
    );
    assert.equal(
      (await call("/api/projects", "POST", { path: "relative", mode: "watch" })).status,
      400,
    );
    assert.equal((await call("/api/settings", "PATCH", { paused: "yes" })).status, 400);
    assert.equal(
      (
        await fetch(`${server.origin}/api/global-tools/sources`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sources: [] }),
        })
      ).status,
      401,
    );
    const globalRoot = join(dataDir, "global", "node_modules");
    await mkdir(globalRoot, { recursive: true });
    const source = {
      manager: "npm",
      status: "detected",
      version: "11.6.0",
      root: await realpath(globalRoot),
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
    for (const body of [
      {},
      { sources: "npm" },
      { sources: [{ ...source, manager: "winget" }, missingBun] },
      { sources: [{ ...source, root: "relative/node_modules" }, missingBun] },
      { sources: [{ ...source, blockedScopes: ["https://private.invalid"] }, missingBun] },
    ])
      assert.equal((await call("/api/global-tools/sources", "POST", body)).status, 400);
    const savedSources = await call("/api/global-tools/sources", "POST", {
      sources: [source, missingBun],
    });
    assert.equal(savedSources.status, 200);
    assert.deepEqual((await savedSources.json()).inventory.managers, [source, missingBun]);
    assert.equal(
      coordinator.snapshot().inventory.evidence.status,
      "not-scanned",
      "Capturing roots must not start the first PC scan",
    );
    assert.equal(
      (
        await fetch(`${server.origin}/api/notifications/summary/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ summaryId: "unknown" }),
        })
      ).status,
      401,
    );
    for (const body of [
      {},
      { summaryId: 1 },
      { summaryId: "x".repeat(101) },
      { summaryId: "unknown" },
    ])
      assert.equal((await call("/api/notifications/summary/ack", "POST", body)).status, 400);
    assert.equal((await call("/api/session", "POST", { token: "wrong" })).status, 401);
    assert.equal(
      (await call("/api/settings", "PATCH", { data: "x".repeat(33 * 1024) })).status,
      413,
    );
    const session = await call("/api/session", "POST", { token });
    assert.equal(session.status, 200);
    const cookie = session.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const browser = await fetch(`${server.origin}/api/monitoring`, {
      headers: { Cookie: cookie.split(";")[0] },
    });
    assert.equal(browser.status, 200);
    const snapshot = await browser.json();
    assert.equal(snapshot.settings.paused, true);
    assert.equal(JSON.stringify(snapshot).includes(token), false);
    assert.equal(
      (await call("/api/settings", "PATCH", { projectIntervalMinutes: 30 })).status,
      200,
    );
    const projectResponse = await call("/api/projects", "POST", {
      path: dataDir,
      mode: "maintained",
    });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json();
    assert.equal(
      (await call(`/api/projects/${project.id}`, "PATCH", { mode: "watch" })).status,
      200,
    );
    assert.equal((await call(`/api/projects/${project.id}`, "DELETE")).status, 200);
    assert.equal((await call("/api/shutdown", "POST", {})).status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdowns, 1);
  } finally {
    await server.close();
    await coordinator.close();
    assert.ok(dataDir.startsWith(join(tmpdir(), "versionstead-auth-")));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("authenticated HTTP exposes real scan progress and atomically acknowledges a grouped summary", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-summary-http-"));
  const projectDir = join(dataDir, "selected");
  await mkdir(projectDir);
  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { example: "^1.0.0" } }),
  );
  await writeFile(
    join(projectDir, "package-lock.json"),
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
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const coordinator = new MonitoringCoordinator({
    dataDir,
    dependencyLookup: async (dependencies, _signal, progress) => {
      progress?.({ stage: "versions", completed: 0, total: dependencies.length });
      await gate;
      return {
        dependencies: dependencies.map((d) => ({
          ...d,
          latestVersion: "2.0.0",
          versionStatus: "checked",
          advisoryStatus: "checked",
        })),
        advisories: new Map(),
        coverage: ["Controlled regression metadata"],
        errors: [],
        versionChecked: new Set(dependencies.map((d) => d.id)),
      };
    },
  });
  coordinator.changeSettings({ paused: true });
  const token = randomBytes(32).toString("base64url");
  const server = await startServer({ port: 0, monitoring: coordinator, authToken: token });
  const call = (path, body) =>
    fetch(`${server.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const project = await (
      await call("/api/projects", { path: projectDir, mode: "maintained" })
    ).json();
    assert.equal(
      (await call("/api/scans", { target: "projects", projectId: project.id })).status,
      202,
    );
    let snapshot;
    for (let i = 0; i < 100; i++) {
      snapshot = await (await call("/api/monitoring")).json();
      if (snapshot.scanProgress.active?.stage === "versions") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(snapshot.scanProgress.active.stage, "versions");
    assert.equal(snapshot.scanProgress.active.completed, 0);
    assert.equal(snapshot.scanProgress.active.total, 1);
    assert.equal(snapshot.notificationSummary, null);
    release();
    for (let i = 0; i < 100; i++) {
      if (!coordinator.snapshot().scanProgress.active) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 2100));
    snapshot = await (await call("/api/monitoring")).json();
    assert.equal(snapshot.notificationSummary.newUpdateCount, 1);
    const receipt = { summaryId: snapshot.notificationSummary.id };
    assert.equal((await call("/api/notifications/summary/ack", receipt)).status, 200);
    const after = await (await call("/api/monitoring")).json();
    assert.equal(after.notificationSummary, null);
    assert.ok(after.notifications.every((event) => event.deliveredAt));
    assert.equal((await call("/api/notifications/summary/ack", receipt)).status, 200);
    assert.equal(coordinator.snapshot().notificationNextAt, after.notificationNextAt);
  } finally {
    release();
    await server.close();
    await coordinator.close();
    assert.ok(dataDir.startsWith(join(tmpdir(), "versionstead-summary-http-")));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("snapshot revisions drive ETag/304 responses while live progress has its own endpoint", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-revision-http-"));
  const projectDir = join(dataDir, "selected");
  await mkdir(projectDir);
  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { example: "^1.0.0" } }),
  );
  await writeFile(
    join(projectDir, "package-lock.json"),
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
  const gates = [];
  const dependencyLookup = async (dependencies, _signal, progress) => {
    for (const completed of [0, dependencies.length]) {
      progress?.({ stage: "versions", completed, total: dependencies.length });
      await new Promise((resolve) => gates.push(resolve));
    }
    return { dependencies, advisories: new Map(), coverage: [], errors: [] };
  };
  const token = randomBytes(32).toString("base64url");
  const open = async () => {
    const coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup });
    coordinator.changeSettings({ paused: true });
    return {
      coordinator,
      server: await startServer({ port: 0, monitoring: coordinator, authToken: token }),
    };
  };
  let first = await open();
  let second;
  const call = (path, { method = "GET", headers = {}, body } = {}, instance = first) =>
    fetch(`${instance.server.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const progress = async () =>
    decodeMonitoringProgress(await (await call("/api/monitoring/progress")).json());
  // Fails loudly: a condition that never arrives must not let the next assertion run on stale state.
  const until = async (predicate) => {
    const deadline = Date.now() + 10_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${predicate}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    assert.equal((await fetch(`${first.server.origin}/api/monitoring/progress`)).status, 401);
    const initial = await call("/api/monitoring");
    assert.equal(initial.status, 200);
    const tag = initial.headers.get("etag");
    assert.match(tag, /^"[^"]+"$/, "The revision is one quoted entity tag");
    const body = await initial.json();
    assert.equal(body.features, "settings-repositories-connections-v10");
    assert.deepEqual(body, first.coordinator.snapshot(), "Cached and live parts form the snapshot");
    for (const [method, headers, status] of [
      ["GET", { "If-None-Match": tag }, 304],
      ["GET", { "If-None-Match": `"stale", ${tag}` }, 304],
      ["HEAD", {}, 200],
      ["HEAD", { "If-None-Match": tag }, 304],
    ]) {
      const response = await call("/api/monitoring", { method, headers });
      assert.equal(response.status, status, `${method} ${JSON.stringify(headers)}`);
      assert.equal(response.headers.get("etag"), tag);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), "");
    }
    const idle = await progress();
    assert.equal(`"${idle.revision}"`, tag, "Progress names the snapshot revision it belongs to");
    assert.deepEqual(idle.settings, body.settings, "Progress carries the settings");
    assert.deepEqual(idle.scanProgress, { active: null, queued: [] });
    assert.equal(idle.notificationSummary, null);
    assert.equal(idle.notificationNextAt, null);

    let current = tag;
    const changed = async () => {
      const response = await call("/api/monitoring", { headers: { "If-None-Match": current } });
      assert.equal(response.status, 200, "A durable change is a new revision");
      assert.notEqual(response.headers.get("etag"), current);
      current = response.headers.get("etag");
      return response.json();
    };
    const patch = { method: "PATCH", body: { projectIntervalMinutes: 30 } };
    assert.equal((await call("/api/settings", patch)).status, 200);
    assert.equal((await changed()).settings.projectIntervalMinutes, 30);
    assert.equal((await progress()).settings.projectIntervalMinutes, 30);
    const add = { method: "POST", body: { path: projectDir, mode: "maintained" } };
    const project = await (await call("/api/projects", add)).json();
    assert.equal((await changed()).projects[0].id, project.id);
    const rename = { method: "PATCH", body: { name: "Renamed" } };
    assert.equal((await call(`/api/projects/${project.id}`, rename)).status, 200);
    assert.equal((await changed()).projects[0].name, "Renamed");

    const scan = { method: "POST", body: { target: "projects", projectId: project.id } };
    assert.equal((await call("/api/scans", scan)).status, 202);
    await until(() => gates.length === 1);
    assert.equal((await changed()).projects[0].evidence.status, "scanning");
    const started = await progress();
    assert.equal(`"${started.revision}"`, current);
    assert.equal(started.scanProgress.active.completed, 0);
    gates.shift()();
    await until(() => gates.length === 1);
    const advanced = await progress();
    assert.equal(advanced.revision, started.revision, "Live progress is not a durable change");
    assert.equal(advanced.scanProgress.active.completed, 1);
    const unchanged = { headers: { "If-None-Match": current } };
    assert.equal((await call("/api/monitoring", unchanged)).status, 304);
    gates.shift()();
    await until(async () => (await progress()).scanProgress.active === null);
    assert.equal((await changed()).projects[0].evidence.status, "complete");

    const closing = first;
    first = undefined;
    await closing.server.close();
    await closing.coordinator.close();
    second = await open();
    const reopened = await call("/api/monitoring", unchanged, second);
    assert.equal(reopened.status, 200, "Another instance on the same database never matches");
    assert.notEqual(reopened.headers.get("etag"), current);
    assert.notEqual(reopened.headers.get("etag"), tag);
  } finally {
    for (const release of gates) release();
    for (const instance of [first, second].filter(Boolean)) {
      await instance.server.close();
      await instance.coordinator.close();
    }
    assert.ok(dataDir.startsWith(join(tmpdir(), "versionstead-revision-http-")));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runtime descriptor protects the token and an OS database lock prevents duplicate writers", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-runtime-"));
  const release = acquireCoordinatorLock(dataDir);
  try {
    assert.throws(() => acquireCoordinatorLock(dataDir), /already owns/);
    const runtime = {
      origin: "http://127.0.0.1:4318",
      pid: process.pid,
      token: randomBytes(32).toString("base64url"),
      mode: "interactive",
      host: "session",
    };
    await writeRuntime(dataDir, runtime);
    const descriptor = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(dataDir, "runtime.json"), "utf8"),
    );
    assert.equal(descriptor.includes(runtime.token), false);
    assert.deepEqual(await readRuntime(dataDir), runtime);
    const cached = await readRuntime(dataDir);
    cached.token = "changed";
    assert.deepEqual(await readRuntime(dataDir), runtime);
    const rotated = { ...runtime, token: randomBytes(32).toString("base64url") };
    await writeRuntime(dataDir, rotated);
    assert.deepEqual(await readRuntime(dataDir), rotated);
    await removeRuntime(dataDir);
    assert.equal(await readRuntime(dataDir), null);
  } finally {
    release();
    const reacquired = acquireCoordinatorLock(dataDir);
    reacquired();
    assert.ok(dataDir.startsWith(join(tmpdir(), "versionstead-runtime-")));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a boot-task host that finds its data directory in use exits 0, so launchd and systemd keep it stopped", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-lock-"));
  const release = acquireCoordinatorLock(dataDir);
  try {
    const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    const run = (host, mode) =>
      spawnSync(
        process.execPath,
        [bin, "--data-dir", dataDir, "--port", "0", "--mode", mode, "--host", host],
        { encoding: "utf8", timeout: 30_000 },
      );
    const boot = run("boot-task", "background");
    assert.equal(boot.status, 0);
    assert.match(
      boot.stderr,
      /Another Versionstead coordinator already serves this data directory/,
    );
    const session = run("session", "interactive");
    assert.equal(session.status, 1, "A session host still reports the conflict as a failure");
    assert.match(session.stderr, /A coordinator already owns this data directory/);
  } finally {
    release();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a lock file that is not a database fails every host with exit 1, never as another coordinator", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-lock-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, "coordinator-lock.sqlite"), "not a database, whatever wrote it");
  assert.throws(
    () => acquireCoordinatorLock(dataDir),
    (error) => /^The coordinator lock file could not be locked/.test(error.message),
  );
  const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
  for (const [host, mode] of [
    ["boot-task", "background"],
    ["session", "interactive"],
  ]) {
    const run = spawnSync(
      process.execPath,
      [bin, "--data-dir", dataDir, "--port", "0", "--mode", mode, "--host", host],
      { encoding: "utf8", timeout: 30_000 },
    );
    // A boot-task host that exited 0 here would stay stopped under launchd and systemd.
    assert.equal(run.status, 1, `${host}: ${run.stderr}`);
    assert.match(run.stderr, /^The coordinator lock file could not be locked/m);
    assert(!/already/.test(run.stderr), "A broken lock file is not another coordinator");
    assert(!run.stderr.includes(dataDir), "The data directory's path stays out of the output");
  }
});

test("a coordinator that cannot open its monitoring database says why, without local paths", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-runtime-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const start = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
        "--data-dir",
        dataDir,
        "--port",
        "0",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
  for (const [setup, message] of [
    ["PRAGMA user_version=9", "The monitoring database needs a newer Versionstead version."],
    [
      `PRAGMA user_version=1;
       CREATE TABLE monitoring_state (id INTEGER PRIMARY KEY, snapshot TEXT, due TEXT, notified TEXT);
       INSERT INTO monitoring_state VALUES (1, '{}', '{}', '[]');`,
      "The monitoring database contains an invalid monitoring snapshot.",
    ],
  ]) {
    const database = new DatabaseSync(join(dataDir, DATABASE_FILE));
    database.exec(setup);
    database.close();
    const started = start();
    assert.equal(started.status, 1, started.stderr);
    assert.match(started.stderr, new RegExp(`^${message.replaceAll(".", "\\.")}$`, "m"));
    assert(
      !started.stderr.includes("could not start"),
      "The specific reason replaces the generic one",
    );
    assert(!started.stderr.includes(dataDir), "The data directory's path stays out of the output");
  }
});

test("runtime descriptor round-trips the optional development origin that browser access prints", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-runtime-"));
  const runtime = {
    origin: "http://127.0.0.1:4318",
    pid: process.pid,
    token: randomBytes(32).toString("base64url"),
    mode: "interactive",
    host: "session",
  };
  const access = () =>
    execFileSync(process.execPath, [fileURLToPath(new URL("../dist/access.js", import.meta.url))], {
      encoding: "utf8",
      env: { ...process.env, VERSIONSTEAD_DATA_DIR: dataDir },
    });
  try {
    await writeRuntime(dataDir, runtime);
    assert.deepEqual(await readRuntime(dataDir), runtime, "Descriptors without it stay valid");
    assert.equal(
      access(),
      `Open ${runtime.origin} and enter this session access code:\n${runtime.token}\n`,
    );
    const development = { ...runtime, devOrigin: "http://127.0.0.1:4317" };
    await writeRuntime(dataDir, development);
    assert.deepEqual(await readRuntime(dataDir), development);
    assert.equal(
      access(),
      `Open ${development.devOrigin} and enter this session access code:\n${runtime.token}\n`,
    );
    await assert.rejects(
      writeRuntime(dataDir, { ...runtime, devOrigin: "http://127.0.0.1:9999" }),
      /Invalid coordinator descriptor/,
    );
    const file = join(dataDir, "runtime.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...stored, devOrigin: "https://attacker.invalid" }));
    assert.equal(await readRuntime(dataDir), null, "Only the development origin is accepted");
  } finally {
    assert.ok(dataDir.startsWith(join(tmpdir(), "versionstead-runtime-")));
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function temporaryHome(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "versionstead-home-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("data directory follows each platform's convention", async (t) => {
  const home = await temporaryHome(t);
  const share = join(home, ".local", "share", "Versionstead");
  const explicit = join(home, "explicit");
  assert.equal(resolveDataDir({ VERSIONSTEAD_DATA_DIR: explicit }, "linux", home), explicit);
  assert.equal(resolveDataDir({ VERSIONSTEAD_DATA_DIR: explicit }, "darwin", home), explicit);
  assert.throws(
    () => resolveDataDir({ VERSIONSTEAD_DATA_DIR: "relative" }, "linux", home),
    /must be absolute/,
  );
  // Windows is unchanged.
  const local = join(home, "Local");
  assert.equal(resolveDataDir({ LOCALAPPDATA: local }, "win32", home), join(local, "Versionstead"));
  assert.equal(resolveDataDir({}, "win32", home), share);
  // Linux honors an absolute XDG_DATA_HOME and ignores a relative one and LOCALAPPDATA.
  assert.equal(
    resolveDataDir({ XDG_DATA_HOME: join(home, "xdg") }, "linux", home),
    join(home, "xdg", "Versionstead"),
  );
  assert.equal(resolveDataDir({ XDG_DATA_HOME: "relative" }, "linux", home), share);
  assert.equal(resolveDataDir({ LOCALAPPDATA: local }, "linux", home), share);
  assert.equal(resolveDataDir({}, "linux", home), share);
  // macOS uses Application Support and ignores both of those variables.
  const support = join(home, "Library", "Application Support", "Versionstead");
  assert.equal(resolveDataDir({ LOCALAPPDATA: local }, "darwin", home), support);
  assert.equal(resolveDataDir({ XDG_DATA_HOME: join(home, "xdg") }, "darwin", home), support);
});

test("data of an earlier build stays in use until the new folder holds a database, whatever else is in it", async (t) => {
  const home = await temporaryHome(t);
  const legacy = join(home, ".local", "share", "Versionstead");
  const support = join(home, "Library", "Application Support", "Versionstead");
  const xdg = join(home, "xdg");
  const custom = join(xdg, "Versionstead");
  const hold = async (directory, file = "monitoring.sqlite") => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, file), "");
  };
  const mac = () => resolveDataDir({}, "darwin", home);
  const linux = () => resolveDataDir({ XDG_DATA_HOME: xdg }, "linux", home);
  // A fresh install, or an earlier folder without a database, starts in the platform's own folder.
  await mkdir(legacy, { recursive: true });
  assert.equal(mac(), support);
  assert.equal(linux(), custom);
  // A database in the earlier folder is the owner's data and is kept.
  await hold(legacy);
  assert.equal(mac(), legacy);
  assert.equal(linux(), legacy);
  // Electron creates its own profile in the macOS folder on every launch, which must not strand that data.
  await hold(support, "Preferences");
  await hold(custom, "settings.json");
  assert.equal(mac(), legacy);
  assert.equal(linux(), legacy);
  // Once the new folder has a database it wins.
  await hold(support);
  await hold(custom);
  assert.equal(mac(), support);
  assert.equal(linux(), custom);
  // Without a custom XDG_DATA_HOME the Linux folder is the earlier folder itself; Windows ignores all of this.
  assert.equal(resolveDataDir({}, "linux", home), legacy);
  assert.equal(
    resolveDataDir({ LOCALAPPDATA: join(home, "Local") }, "win32", home),
    join(home, "Local", "Versionstead"),
  );
});

test("credential storage names what is missing and never reads a reference with the wrong backend", async () => {
  await assert.rejects(
    protectSecret("value", { platform: "freebsd" }),
    (error) => error instanceof InputError && /not supported on this platform/.test(error.message),
  );
  assert.match(
    await credentialStorageIssue({ platform: "freebsd" }),
    /not supported on this platform/,
  );
  assert.equal(await credentialStorageIssue({ platform: "win32" }), null);
  await assert.rejects(
    unprotectSecret("AQAAANCMnd8BFdERjHoAwE/Cl+s=", { platform: "linux" }),
    /protected by Windows on another host/,
  );
  await assert.rejects(
    unprotectSecret(`keychain:v1:device.${"A".repeat(22)}`, { platform: "win32" }),
    /macOS or Linux keychain/,
  );
  await discardSecret("AQAAANCMnd8BFdERjHoAwE/Cl+s=", {
    platform: "linux",
    run: () => assert.fail("A DPAPI blob is never sent to a keychain"),
  });
  await discardSecret(`keychain:v1:device.${"A".repeat(22)}`, {
    platform: "win32",
    run: () => assert.fail("Another host's keychain item cannot be reached from Windows"),
  });
});

test("a locked Linux keyring never reads as a missing credential or a completed deletion", async () => {
  const keyring = fakeKeyring();
  const reference = `keychain:v1:device.${"A".repeat(22)}`;
  const locked = (error) =>
    error instanceof CredentialStorageUnavailable &&
    /^Unlock your login keyring/.test(error.message);
  await assert.rejects(unprotectSecret(reference, keyring.options), /missing from the OS keychain/);
  await discardSecret(reference, keyring.options); // Already gone counts as deleted.
  const stored = await protectSecret("value", { ...keyring.options, namespace: "device" });
  keyring.lock();
  // secret-tool answers a locked keyring's lookup and clear exactly as it answers a missing item.
  await assert.rejects(unprotectSecret(stored, keyring.options), locked);
  await assert.rejects(discardSecret(stored, keyring.options), locked);
  await assert.rejects(protectSecret("value", { ...keyring.options, namespace: "device" }), locked);
  assert.equal(keyring.items.size, 1, "Nothing was deleted while the keyring was locked");
  keyring.unlock();
  assert.equal(await unprotectSecret(stored, keyring.options), "value");
  await discardSecret(stored, keyring.options);
  assert.equal(keyring.items.size, 0);
});

test("Windows Constrained Language Mode is named instead of a startup timeout", async () => {
  assert.equal(
    windowsPolicyBlocked,
    "Windows policy blocks the PowerShell features Versionstead needs (Constrained Language Mode).",
  );
  assert.equal(
    await windowsPolicyIssue(async () => ({ code: 0, stdout: "versionstead-full-language\r\n" })),
    null,
  );
  assert.equal(
    await windowsPolicyIssue(async () => ({
      code: 3,
      stdout: "versionstead-constrained-language\r\n",
    })),
    windowsPolicyBlocked,
  );
  assert.match(dpapiScript("Protect").split("\n")[0], /LanguageMode -ne 'FullLanguage'/);
});

test("DPAPI names the constrained marker before it reads the exit code, and fails generically otherwise", async () => {
  const generic = (error) =>
    !(error instanceof InputError) &&
    error.message === "Windows could not protect the local coordinator capability";
  // The language guard exits 3 after printing its marker: the policy is named, not the exit code.
  await assert.rejects(
    dpapi("AA==", "Protect", async () => ({
      code: 3,
      stdout: "versionstead-constrained-language\r\n",
    })),
    (error) => error instanceof InputError && error.message === windowsPolicyBlocked,
  );
  for (const result of [
    { code: 1, stdout: "" }, // A blob this PC cannot decrypt: an unreadable credential.
    { code: 3, stdout: "QUJD" }, // Base64 text does not excuse a failed exit code.
    { code: 0, stdout: "not base64!" },
  ])
    await assert.rejects(
      dpapi("AA==", "Protect", async () => result),
      generic,
    );
  // What runs is the guarded script for that operation, with the value on standard input.
  const calls = [];
  const text = await dpapi("AA==", "Unprotect", async (script, input) => {
    calls.push([script, input]);
    return { code: 0, stdout: "QUJD\r\n" };
  });
  assert.equal(text, "QUJD");
  assert.deepEqual(calls, [[dpapiScript("Unprotect"), "AA=="]]);
});

test("a DPAPI run that never finished is a storage failure to try again, not a credential that cannot be read", async () => {
  // No exit code at all: PowerShell timed out or could not start.
  for (const [operation, message] of [
    ["Unprotect", "Windows did not finish reading the protected credential. Try again."],
    ["Protect", "Windows did not finish protecting the credential. Try again."],
  ])
    await assert.rejects(
      dpapi("AA==", operation, async () => ({ code: null, stdout: "" })),
      (error) => error instanceof CredentialStorageUnavailable && error.message === message,
      operation,
    );
  // The policy marker still wins over a missing exit code, and a failed exit stays generic.
  await assert.rejects(
    dpapi("AA==", "Unprotect", async () => ({
      code: null,
      stdout: "versionstead-constrained-language\r\n",
    })),
    (error) =>
      error instanceof InputError &&
      !(error instanceof CredentialStorageUnavailable) &&
      error.message === windowsPolicyBlocked,
  );
  await assert.rejects(
    dpapi("AA==", "Unprotect", async () => ({ code: 1, stdout: "" })),
    (error) => !(error instanceof InputError),
  );
});

test(
  "a real PowerShell session switched to Constrained Language Mode is named, and DPAPI never runs",
  { skip: process.platform !== "win32" },
  async () => {
    assert.equal(await windowsPolicyIssue(), null);
    // The language mode is switched inside the child session only; no machine policy is touched.
    const constrained = (script, input) =>
      runPowerShell(
        `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n${script}`,
        input,
      );
    assert.equal(await windowsPolicyIssue(constrained), windowsPolicyBlocked);
    const { code, stdout } = await constrained(dpapiScript("Protect"), "AA==");
    assert.equal(code, 3);
    assert.match(stdout, /versionstead-constrained-language/);
  },
);

test(
  "a new data directory outside the profile gets an owner, SYSTEM and Administrators ACL on Windows",
  { skip: process.platform !== "win32" },
  async (t) => {
    // Only directories this test creates under its own temporary root are ever given an ACL.
    const base = await mkdtemp(join(tmpdir(), "versionstead-acl-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const profile = join(base, "profile");
    const outside = join(base, "data");
    createDataDirectory(outside, "win32", profile);
    const system32 = join(process.env.SystemRoot, "System32");
    const owner = /"(S-1-[0-9-]+)"\s*$/.exec(
      execFileSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
      }).trim(),
    )[1];
    const entries = (path) =>
      execFileSync(
        join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // sid:inherited:rights:inheritance flags:propagation flags:allow or deny
          "(Get-Acl -LiteralPath $env:VERSIONSTEAD_ACL_PATH).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + ':' + $_.IsInherited + ':' + $_.FileSystemRights + ':' + $_.InheritanceFlags + ':' + $_.PropagationFlags + ':' + $_.AccessControlType }",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, VERSIONSTEAD_ACL_PATH: path },
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
        .trim()
        .split(/\r?\n/)
        .sort();
    // Exactly three explicit entries, each a full-control allow for this folder, its subfolders and its files.
    assert.deepEqual(
      entries(outside),
      [owner, "S-1-5-18", "S-1-5-32-544"]
        .map((sid) => `${sid}:False:FullControl:ContainerInherit, ObjectInherit:None:Allow`)
        .sort(),
    );
    const inside = join(profile, "data");
    createDataDirectory(inside, "win32", profile);
    assert(
      entries(inside).every((entry) => entry.split(":")[1] === "True"),
      "Inside the profile: inherited",
    );
    createDataDirectory(outside, "win32", profile); // An existing directory is left alone.
  },
);

test("a data directory that cannot be restricted is removed, and the owner's message survives a failed rollback", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "versionstead-acl-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const profile = join(base, "profile");
  // whoami.exe and icacls.exe are replaced for one synchronous call, so no access list can change. The
  // replacement fails with a message that holds the path, as a real tool's error would.
  const restrictFails = (name, beforeFailing) => {
    const dataDir = join(base, name);
    const tools = t.mock.method(childProcess, "execFileSync", () => {
      beforeFailing(dataDir);
      throw new Error(`The tools failed for ${dataDir}`);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => createDataDirectory(dataDir, "win32", profile),
        (error) => error.message === dataDirectoryNotRestricted,
      );
    } finally {
      tools.mock.restore();
      syncBuiltinESMExports();
    }
    return dataDir;
  };
  assert(
    !existsSync(restrictFails("tools-fail", () => {})),
    "No unrestricted folder is left behind",
  );
  // A rollback that fails as well (here a file arrived in the new folder) must not replace the message
  // with a raw file-system error that holds the path.
  const kept = restrictFails("rollback-fails", (dataDir) =>
    writeFileSync(join(dataDir, "arrived"), ""),
  );
  assert(existsSync(join(kept, "arrived")));
});

test(
  "the coordinator program shows the data-folder message, with no path, when a new folder cannot be restricted",
  { skip: process.platform !== "win32" },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "versionstead-acl-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const dataDir = join(base, "data");
    // Node cannot start without a real SystemRoot, so a preload moves it (and the profile) once Node has
    // started: the folder then lies outside the profile and no Windows tool can run.
    const preload = `data:text/javascript,${encodeURIComponent(
      `process.env.SystemRoot = ${JSON.stringify(join(base, "no-windows"))}; process.env.USERPROFILE = ${JSON.stringify(join(base, "profile"))};`,
    )}`;
    const started = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
        "--data-dir",
        dataDir,
        "--port",
        "0",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(started.status, 1, started.stderr);
    assert.equal(started.stderr.trim(), dataDirectoryNotRestricted);
    assert(!started.stderr.includes(base), "The path stays out of the output");
    assert(!existsSync(dataDir), "The folder that could not be restricted is not left behind");
  },
);

test(
  "a new data directory is owner-only on macOS and Linux",
  { skip: process.platform === "win32" },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "versionstead-mode-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const dataDir = join(base, "data");
    createDataDirectory(dataDir);
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  },
);

test("static serving exposes built routes/assets, never arbitrary workspace paths", async () => {
  const webRoot = await mkdtemp(join(tmpdir(), "versionstead-test-"));
  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "index.html"), "<main>Versionstead</main>");
  await writeFile(join(webRoot, "assets", "app.js"), "export {};");
  await writeFile(join(webRoot, "secret.txt"), "not public");
  const server = await startServer({ port: 0, webRoot });
  try {
    assert.equal(
      await (await fetch(`${server.origin}/coverage`)).text(),
      "<main>Versionstead</main>",
    );
    assert.equal((await fetch(`${server.origin}/assets/app.js`)).status, 200);
    assert.equal(
      await (await fetch(`${server.origin}/settings/project`)).text(),
      "<main>Versionstead</main>",
    );
    for (const path of [
      "/secret.txt",
      "/api/unknown",
      "/assets/%2e%2e%2fsecret.txt",
      "/assets/missing.js",
    ]) {
      assert.equal((await fetch(`${server.origin}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${server.origin}/%zz`)).status, 400);
    assert.match(
      (await fetch(server.origin)).headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
  } finally {
    await server.close();
    assert.ok(webRoot.startsWith(join(tmpdir(), "versionstead-test-")));
    await rm(webRoot, { recursive: true, force: true });
  }
});

test("POST /api/scans/cancel validates its request and refuses a scan that is not running", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-cancel-"));
  const coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  const token = randomBytes(32).toString("base64url");
  const server = await startServer({ port: 0, monitoring: coordinator, authToken: token });
  t.after(async () => {
    await server.close();
    await coordinator.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const post = (path, body) =>
    fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post("/api/scans/cancel", {})).status, 400);
  assert.equal((await post("/api/scans/cancel", { scanId: "x".repeat(101) })).status, 400);
  const late = await post("/api/scans/cancel", { scanId: "finished-scan" });
  assert.equal(late.status, 400);
  assert.match((await late.json()).error, /already finished/);
  assert.equal((await post("/api/scans", { target: "failed" })).status, 202);
  assert.equal((await post("/api/scans", { target: "failed", projectId: "any" })).status, 400);
});

test("POST /api/scans/cancel answers 200 accepted for the running scan and rejects an id over 100 characters", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-cancel-run-"));
  const projectDir = join(dataDir, "selected");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "fixture" }));
  await writeFile(
    join(projectDir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture" } } }),
  );
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const coordinator = new MonitoringCoordinator({
    dataDir,
    // Held, and deaf to its signal: the Cancel takes effect when the scan reaches its commit.
    dependencyLookup: async (dependencies) => {
      await gate;
      return { dependencies, advisories: new Map(), coverage: [], errors: [] };
    },
  });
  coordinator.changeSettings({ paused: true });
  const token = randomBytes(32).toString("base64url");
  const server = await startServer({ port: 0, monitoring: coordinator, authToken: token });
  t.after(async () => {
    release();
    await server.close();
    await coordinator.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const post = async (path, body) => {
    const response = await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return [response.status, await response.json()];
  };
  const project = await coordinator.addProject({ path: projectDir, mode: "maintained" });
  coordinator.requestScan({ target: "projects", projectId: project.id });
  const { scanId } = coordinator.snapshot().scanProgress.active;
  assert.deepEqual(await post("/api/scans/cancel", { scanId }), [200, { accepted: true }]);
  assert.deepEqual(await post("/api/scans/cancel", { scanId: "x".repeat(101) }), [
    400,
    { error: "Invalid request fields" },
  ]);
  release();
  const deadline = Date.now() + 6000;
  while (coordinator.snapshot().scanProgress.active && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(coordinator.snapshot().history[0].cancelled, true);
});
