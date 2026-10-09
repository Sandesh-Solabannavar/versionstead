import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  acquireCoordinatorLock,
  dataDirectoryNotRestricted,
  readRuntime,
  windowsPolicyBlocked,
  writeRuntime,
} from "@versionstead/server/runtime";

// The coordinator module resolves its data directory on import; never touch the owner's monitoring.
const temporary = await mkdtemp(join(tmpdir(), "versionstead-reliability-"));
const dataDir = join(temporary, "coordinator");
process.env.VERSIONSTEAD_DATA_DIR = dataDir;
const {
  backgroundRestartMessage,
  checkWindowsStartup,
  ensureCoordinator,
  forwardRequest,
  recoverCoordinator,
  shouldRecoverCoordinator,
  StartupError,
  startupFailureMessage,
  stopMonitoringDetail,
} = await import("../dist/coordinator.js");
after(() => rm(temporary, { recursive: true, force: true }));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("the tray restarts only a dead interactive session coordinator, at most once a minute", () => {
  const session = { host: "session", mode: "interactive" };
  assert.equal(shouldRecoverCoordinator(session, false, -Infinity, 0), true);
  assert.equal(shouldRecoverCoordinator(session, false, 0, 59_999), false);
  assert.equal(shouldRecoverCoordinator(session, false, 0, 60_000), true);
  assert.equal(shouldRecoverCoordinator(session, true, -Infinity, 0), false, "Stop monitoring");
  // A graceful stop removes the descriptor; only a crash or kill leaves it behind.
  assert.equal(shouldRecoverCoordinator(null, false, -Infinity, 0), false);
  for (const descriptor of [
    { host: "boot-task", mode: "background" },
    { host: "session", mode: "background" },
    { host: "unconfigured", mode: "interactive" },
  ])
    assert.equal(
      shouldRecoverCoordinator(descriptor, false, -Infinity, 0),
      false,
      "Boot/background hosts are never replaced",
    );
});

test("background-host advice names the platform's own tool and never Windows elsewhere", () => {
  assert.match(backgroundRestartMessage("win32"), /Windows background host/);
  for (const platform of ["darwin", "linux"])
    assert.equal(
      backgroundRestartMessage(platform),
      "Restart this coordinator with node scripts/background-host.mjs restart.",
    );
  assert.match(stopMonitoringDetail("boot-task", "win32"), /Windows startup registration/);
  assert.match(stopMonitoringDetail("boot-task", "darwin"), /LaunchAgent stays installed/);
  assert.match(stopMonitoringDetail("boot-task", "linux"), /systemd user service stays enabled/);
  for (const platform of ["win32", "darwin", "linux", "freebsd"])
    assert.equal(stopMonitoringDetail("session", platform), "Use Start monitoring to resume.");
  // A platform with no background host of its own is told neither Windows nor another tool.
  assert.match(backgroundRestartMessage("freebsd"), /background host/);
  assert.doesNotMatch(backgroundRestartMessage("freebsd"), /Windows|background-host\.mjs/);
  assert.doesNotMatch(stopMonitoringDetail("boot-task", "freebsd"), /Windows|LaunchAgent|systemd/);
});

test("recovery replaces only a crashed session coordinator, never a live or stopping owner", async () => {
  const closed = createServer();
  const origin = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  const token = randomBytes(32).toString("base64url");
  const dead = { origin, pid: 999_999, token, mode: "interactive", host: "session" };
  // Starting a real coordinator is covered by coordinator.test.mjs; here only the decision is checked.
  const starts = [];
  const replacement = { replaced: true };
  const ensure = async () => {
    starts.push((await readRuntime(dataDir))?.pid);
    return replacement;
  };
  await mkdir(dataDir, { recursive: true });
  await writeRuntime(dataDir, dead);
  // A hung or gracefully stopping coordinator is unreachable but still holds the writer lock.
  const release = acquireCoordinatorLock(dataDir);
  try {
    assert.equal(await recoverCoordinator(false, 1e9, ensure), null);
  } finally {
    release();
  }
  assert.deepEqual(starts, [], "A live owner is never replaced");
  assert.equal((await readRuntime(dataDir))?.pid, dead.pid, "A live owner must keep its data");
  // Lock free with the descriptor left behind: the session coordinator crashed or was killed.
  assert.equal(await recoverCoordinator(false, 1e9 + 60_000, ensure), replacement);
  assert.deepEqual(starts, [dead.pid], "A crashed coordinator is replaced once");
  // A graceful stop removes the descriptor before releasing the lock: nothing to recover.
  await rm(join(dataDir, "runtime.json"));
  assert.equal(await recoverCoordinator(false, 1e9 + 120_000, ensure), null);
  assert.deepEqual(starts, [dead.pid], "A graceful stop is kept");
});

test("the desktop proxy waits for slow work and only a failed connection detaches", async (t) => {
  const tag = '"revision-1"';
  const server = createServer((request, response) => {
    if (request.url === "/slow") return; // Never answers; the client abort ends the exchange.
    const cached = request.headers["if-none-match"] === tag;
    response.writeHead(cached ? 304 : 200, { ETag: tag });
    response.end(cached ? undefined : "fresh");
  });
  const origin = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const idle = new AbortController().signal;
  const fresh = await forwardRequest(fetch, `${origin}/api/monitoring`, {}, idle);
  assert.equal(fresh?.status, 200);
  assert.equal(fresh.headers.get("etag"), tag);
  assert.equal(await fresh.text(), "fresh");
  const cached = await forwardRequest(
    fetch,
    `${origin}/api/monitoring`,
    { headers: { "If-None-Match": tag } },
    idle,
  );
  assert.equal(cached?.status, 304, "304 must pass back unchanged");
  assert.equal(cached.headers.get("etag"), tag);
  const slow = await forwardRequest(fetch, `${origin}/slow`, {}, idle, 50);
  assert.equal(slow?.status, 504, "A slow coordinator must not be reported as disconnected");
  assert.equal(await slow.text(), "The coordinator took too long to respond.");
  const renderer = new AbortController();
  const abandoned = forwardRequest(fetch, `${origin}/slow`, {}, renderer.signal);
  renderer.abort();
  assert.equal((await abandoned)?.status, 504, "An abandoned request must keep the coordinator");
  const stopped = createServer();
  const stoppedOrigin = await listen(stopped);
  await new Promise((resolve) => stopped.close(resolve));
  assert.equal(await forwardRequest(fetch, `${stoppedOrigin}/api/status`, {}, idle), null);
});

test("the project command bridge is exposed on every desktop platform", async () => {
  const source = await readFile(new URL("../dist/preload.cjs", import.meta.url), "utf8");
  const bridge = (platform) => {
    let api;
    runInNewContext(source, {
      exports: {},
      process: { platform },
      require: () => ({
        contextBridge: { exposeInMainWorld: (_name, value) => (api = value) },
        ipcRenderer: {},
      }),
    });
    return api;
  };
  const actions = [
    "runProjectAction",
    "projectActionStatus",
    "stopProjectAction",
    "projectActionShell",
    "loginItem",
    "setLoginItem",
  ];
  for (const platform of ["win32", "darwin", "linux"]) {
    const api = bridge(platform);
    assert.equal(api.platform, platform);
    assert.equal(typeof api.selectProjectDirectory, "function");
    for (const name of actions)
      assert.equal(typeof api[name], "function", `${platform} exposes ${name}`);
  }
});

test("startup failures show only messages written for the owner", () => {
  const policy =
    "Windows policy blocks the PowerShell features Versionstead needs (Constrained Language Mode).";
  assert.equal(startupFailureMessage(new StartupError(policy)), policy);
  const generic = startupFailureMessage(new Error("EACCES C:\\Users\\owner\\secret\\runtime.json"));
  assert.doesNotMatch(generic, /owner|secret|EACCES/);
  assert.match(generic, /Versionstead desktop initialization failed/);
});

test("before a Windows start the language mode and the data folder are checked, and only the owner's messages are shown", async () => {
  const folder = "D:/versionstead-data";
  const prepared = [];
  const prepare = (path) => prepared.push(path);
  const clear = async () => null;
  await checkWindowsStartup(folder, clear, prepare);
  assert.deepEqual(prepared, [folder]);
  // Constrained Language Mode is named, and nothing is created while PowerShell cannot be used.
  prepared.length = 0;
  await assert.rejects(
    checkWindowsStartup(folder, async () => windowsPolicyBlocked, prepare),
    (error) => error instanceof StartupError && error.message === windowsPolicyBlocked,
  );
  assert.deepEqual(prepared, []);
  // The fixed message for an access list that could not be applied becomes the owner's message.
  await assert.rejects(
    checkWindowsStartup(folder, clear, () => {
      throw new Error(dataDirectoryNotRestricted);
    }),
    (error) => error instanceof StartupError && error.message === dataDirectoryNotRestricted,
  );
  // Any other failure holds a path, so it stays a plain error and only the generic message is shown.
  const raw = new Error(`EACCES: permission denied, mkdir '${folder}'`);
  await assert.rejects(
    checkWindowsStartup(folder, clear, () => {
      throw raw;
    }),
    (error) => error === raw && !(error instanceof StartupError),
  );
});

test(
  "a Windows start stops with the owner's message when the data folder cannot be restricted, before Node is looked for",
  { skip: process.platform !== "win32" },
  async (t) => {
    // This file's data folder must be new and lie outside the profile named below; no Windows tool can
    // run, so no access list is touched, and a missing Node would fail differently if it were checked first.
    const profile = await mkdtemp(join(tmpdir(), "versionstead-profile-"));
    t.after(() => rm(profile, { recursive: true, force: true }));
    await rm(dataDir, { recursive: true, force: true });
    const names = ["SystemRoot", "USERPROFILE", "VERSIONSTEAD_NODE_EXECUTABLE"];
    const saved = names.map((name) => process.env[name]);
    process.env.SystemRoot = join(profile, "no-windows");
    process.env.USERPROFILE = profile;
    process.env.VERSIONSTEAD_NODE_EXECUTABLE = join(profile, "missing-node.exe");
    try {
      await assert.rejects(
        ensureCoordinator(),
        (error) => error instanceof StartupError && error.message === dataDirectoryNotRestricted,
      );
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
    assert(!existsSync(dataDir), "The folder that could not be restricted is not left behind");
  },
);
