import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
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
  CredentialStorageUnavailable,
  credentialStorageIssue,
  DATABASE_FILE,
  discardSecret,
  protectSecret,
  readRuntime,
  removeRuntime,
  resolveDataDir,
  unprotectSecret,
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
    assert.equal(body.features, "settings-repositories-connections-v8");
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

test("a keychain call that fails or finds nothing checks the store again, so a locked Linux keyring never reads as a missing item", async () => {
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
