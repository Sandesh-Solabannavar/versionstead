import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { acquireCoordinatorLock, readRuntime, writeRuntime } from "@versionstead/server/runtime";

// The coordinator module resolves its data directory on import; never touch the owner's monitoring.
const temporary = await mkdtemp(join(tmpdir(), "versionstead-reliability-"));
const dataDir = join(temporary, "coordinator");
process.env.VERSIONSTEAD_DATA_DIR = dataDir;
const { forwardRequest, recoverCoordinator, shouldRecoverCoordinator } =
  await import("../dist/coordinator.js");
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
  ];
  for (const platform of ["win32", "darwin", "linux"]) {
    const api = bridge(platform);
    assert.equal(api.platform, platform);
    assert.equal(typeof api.selectProjectDirectory, "function");
    for (const name of actions)
      assert.equal(typeof api[name], "function", `${platform} exposes ${name}`);
  }
});
