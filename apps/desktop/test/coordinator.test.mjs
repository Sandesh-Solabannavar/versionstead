import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MonitoringCoordinator } from "../../server/dist/monitoring.js";
import { startServer } from "../../server/dist/server.js";
import {
  acquireCoordinatorLock,
  readRuntime,
  removeRuntime,
  writeRuntime,
} from "@versionstead/server/runtime";

test("desktop upgrades a legacy session without losing evidence and preserves background hosts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "versionstead-coordinator-upgrade-"));
  const dataDir = join(temporary, "coordinator");
  const projectDir = join(temporary, "selected");
  const previousDataDir = process.env.VERSIONSTEAD_DATA_DIR;
  const previousExecutable = process.env.VERSIONSTEAD_NODE_EXECUTABLE;
  process.env.VERSIONSTEAD_DATA_DIR = dataDir;
  const desktop = await import("../dist/coordinator.js");
  let fixture;

  async function legacy(mode, host, withProgress = false, withCollector = false, features) {
    const release = acquireCoordinatorLock(dataDir);
    const core = new MonitoringCoordinator({ dataDir, mode, host, lookup: false });
    core.changeSettings({
      paused: true,
      notifyNewFindings: false,
      pcIntervalMinutes: 17,
      projectIntervalMinutes: 23,
    });
    const snapshot = core.snapshot.bind(core);
    core.snapshot = () => {
      const value = snapshot();
      if (!withProgress) delete value.scanProgress;
      if (!withCollector) {
        delete value.inventory.collector;
        delete value.inventory.managers;
      }
      delete value.inventory.updateEvidence;
      delete value.notificationSummary;
      if (features) value.features = features;
      else delete value.features;
      return value;
    };
    // Legacy builds had no revision cache; serve the reduced snapshot through the same route.
    core.snapshotJson = () => JSON.stringify(core.snapshot());
    let closing;
    let shutdowns = 0;
    const close = () =>
      (closing ??= (async () => {
        try {
          await server.close();
          await core.close();
          await removeRuntime(dataDir);
          // Descriptor removal can precede the final SQLite lock release during shutdown.
          await delay(250);
        } finally {
          release();
        }
      })());
    const token = randomBytes(32).toString("base64url");
    const server = await startServer({
      port: 0,
      monitoring: core,
      authToken: token,
      onShutdown: () => {
        shutdowns++;
        void close();
      },
    });
    const runtime = { origin: server.origin, pid: process.pid, token, mode, host };
    await writeRuntime(dataDir, runtime);
    return { core, snapshot, runtime, close, shutdowns: () => shutdowns };
  }

  async function stopDetached() {
    const runtime = await readRuntime(dataDir);
    if (!runtime || runtime.pid === process.pid) return;
    const response = await desktop.coordinatorRequest(runtime, "/api/shutdown", {
      method: "POST",
      body: "{}",
    });
    assert(response.ok, "Only the isolated coordinator must be stopped cleanly");
    const deadline = Date.now() + 30_000;
    while (await readRuntime(dataDir)) {
      assert(Date.now() < deadline, "Temporary coordinator must release its descriptor");
      await delay(100);
    }
  }

  try {
    await mkdir(projectDir);
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "retained-project", dependencies: { example: "^1.0.0" } }),
    );
    await writeFile(
      join(projectDir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { example: "^1.0.0" } },
          "node_modules/example": {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
          },
        },
      }),
    );
    fixture = await legacy("interactive", "session");
    const project = await fixture.core.addProject({ path: projectDir, mode: "maintained" });
    fixture.core.requestScan({ target: "projects", projectId: project.id });
    const deadline = Date.now() + 5_000;
    while (
      fixture.snapshot().scanProgress.active ||
      fixture.snapshot().scanProgress.queued.length
    ) {
      assert(Date.now() < deadline, "Offline project evidence must finish before upgrading");
      await delay(10);
    }
    const before = fixture.snapshot();
    assert.equal(before.projects[0].dependencies.length, 1);
    assert(before.projects[0].evidence.lastAttempt);
    assert.equal((await desktop.readyCoordinator()).snapshot.scanProgress, undefined);

    process.env.VERSIONSTEAD_NODE_EXECUTABLE = join(temporary, "missing-node");
    await assert.rejects(desktop.ensureCoordinator(), /Node.js 24|executable/i);
    assert.equal((await desktop.readyCoordinator()).runtime.pid, fixture.runtime.pid);
    assert.equal(fixture.shutdowns(), 0, "Failed preflight must leave legacy monitoring running");
    if (previousExecutable === undefined) delete process.env.VERSIONSTEAD_NODE_EXECUTABLE;
    else process.env.VERSIONSTEAD_NODE_EXECUTABLE = previousExecutable;

    const upgraded = await desktop.ensureCoordinator();
    assert.notEqual(upgraded.runtime.pid, fixture.runtime.pid, "A legacy session must be replaced");
    assert(upgraded.snapshot.scanProgress, "Replacement must expose the current progress contract");
    assert.equal(upgraded.snapshot.inventory.collector, "npm-bun-global-v1");
    assert.equal(fixture.shutdowns(), 1, "Upgrade must authenticate one graceful shutdown");
    await fixture.close();
    fixture = undefined;
    for (const key of ["device", "settings", "projects", "history", "findings", "notifications"])
      assert.deepEqual(upgraded.snapshot[key], before[key], `${key} must survive the upgrade`);
    assert.equal((await desktop.ensureCoordinator()).runtime.pid, upgraded.runtime.pid);

    const [restarted, repeatedRestart] = await Promise.all([
      desktop.restartCoordinator(),
      desktop.restartCoordinator(),
    ]);
    assert.notEqual(restarted.runtime.pid, upgraded.runtime.pid);
    assert.equal(
      repeatedRestart.runtime.pid,
      restarted.runtime.pid,
      "Concurrent restart requests must coalesce",
    );
    assert(restarted.snapshot.scanProgress);
    assert.deepEqual(restarted.snapshot.projects, before.projects);
    assert.deepEqual(restarted.snapshot.settings, before.settings);
    await stopDetached();

    fixture = await legacy("interactive", "session", true);
    const windowsBuild = await desktop.readyCoordinator();
    assert(
      windowsBuild.snapshot.scanProgress,
      "The previous Windows scanner already exposed progress",
    );
    assert.equal(windowsBuild.snapshot.inventory.collector, undefined);
    const globalBuild = await desktop.ensureCoordinator();
    assert.notEqual(
      globalBuild.runtime.pid,
      fixture.runtime.pid,
      "Progress alone must not make a Windows scanner compatible",
    );
    assert.equal(globalBuild.snapshot.inventory.collector, "npm-bun-global-v1");
    assert.deepEqual(globalBuild.snapshot.projects, before.projects);
    assert.equal(fixture.shutdowns(), 1);
    await fixture.close();
    fixture = undefined;
    await stopDetached();

    for (const features of [
      "settings-repositories-connections-v1",
      "settings-repositories-connections-v2",
      "settings-repositories-connections-v3",
      "settings-repositories-connections-v4",
      "settings-repositories-connections-v5",
      "settings-repositories-connections-v6",
      "settings-repositories-connections-v7",
    ]) {
      fixture = await legacy("interactive", "session", true, true, features);
      assert.equal((await desktop.readyCoordinator()).snapshot.features, features);
      const refreshedBuild = await desktop.ensureCoordinator();
      assert.notEqual(
        refreshedBuild.runtime.pid,
        fixture.runtime.pid,
        "Previous settings builds must load the current connections flow",
      );
      assert.equal(refreshedBuild.snapshot.features, "settings-repositories-connections-v8");
      assert.deepEqual(refreshedBuild.snapshot.projects, before.projects);
      assert.deepEqual(refreshedBuild.snapshot.settings, before.settings);
      assert.equal(fixture.shutdowns(), 1);
      await fixture.close();
      fixture = undefined;
      await stopDetached();
    }

    for (const [mode, host] of [
      ["background", "boot-task"],
      ["background", "session"],
      ["interactive", "unconfigured"],
    ]) {
      fixture = await legacy(mode, host);
      const retained = await desktop.ensureCoordinator();
      assert.equal(retained.runtime.pid, fixture.runtime.pid);
      assert.equal(retained.runtime.host, host);
      assert.equal(retained.runtime.mode, mode);
      assert.equal(retained.snapshot.scanProgress, undefined);
      await assert.rejects(desktop.restartCoordinator(), /restart|session|background|boot/i);
      assert.equal(fixture.shutdowns(), 0, "A non-session host must never be stopped or replaced");
      assert(await desktop.readyCoordinator(), "The background host must remain responsive");
      await fixture.close();
      fixture = undefined;
      if (host === "boot-task") {
        await writeRuntime(dataDir, retained.runtime);
        await assert.rejects(desktop.ensureCoordinator(), /background|host|restart/i);
        await assert.rejects(desktop.restartCoordinator(), /background|host|restart/i);
        assert.equal(
          (await readRuntime(dataDir)).host,
          host,
          "A stale boot descriptor must retain its host",
        );
        await removeRuntime(dataDir);
      }
    }
    fixture = await legacy("background", "boot-task", true, true);
    const bootHost = await desktop.ensureCoordinator();
    assert.equal(
      bootHost.runtime.pid,
      fixture.runtime.pid,
      "Owner discovery must retain the boot host process",
    );
    assert.equal(bootHost.runtime.host, "boot-task");
    assert.equal(bootHost.runtime.mode, "background");
    assert.equal(fixture.shutdowns(), 0, "Owner source sync must not stop the boot host");
    assert.deepEqual(
      bootHost.snapshot.inventory.managers.map((source) => source.manager).sort(),
      ["bun", "npm"],
      "Desktop must synchronize both independently detected owner sources",
    );
    assert.deepEqual(bootHost.snapshot.projects, before.projects);
    await fixture.close();
    fixture = undefined;
  } finally {
    await fixture?.close();
    await stopDetached();
    if (previousDataDir === undefined) delete process.env.VERSIONSTEAD_DATA_DIR;
    else process.env.VERSIONSTEAD_DATA_DIR = previousDataDir;
    if (previousExecutable === undefined) delete process.env.VERSIONSTEAD_NODE_EXECUTABLE;
    else process.env.VERSIONSTEAD_NODE_EXECUTABLE = previousExecutable;
    assert(temporary.startsWith(join(tmpdir(), "versionstead-coordinator-upgrade-")));
    await rm(temporary, { recursive: true, force: true });
  }
});
