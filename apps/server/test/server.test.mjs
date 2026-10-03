import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { startServer } from "../dist/server.js";
import { decodeStatus } from "@versionstead/contracts/status";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import {
  acquireCoordinatorLock,
  readRuntime,
  writeRuntime,
  removeRuntime,
} from "../dist/runtime.js";
import { randomBytes } from "node:crypto";

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
