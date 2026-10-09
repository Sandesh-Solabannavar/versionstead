import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRuntime } from "@versionstead/server/runtime";
import { MonitoringCoordinator } from "../../server/dist/monitoring.js";
import { startServer } from "../../server/dist/server.js";

// The coordinator module resolves its data directory on import; never touch the owner's monitoring.
const temporary = await mkdtemp(join(tmpdir(), "versionstead-tray-poll-"));
const dataDir = join(temporary, "desktop");
process.env.VERSIONSTEAD_DATA_DIR = dataDir;
const { pollCoordinator, snapshotHeaders } = await import("../dist/coordinator.js");
after(() => rm(temporary, { recursive: true, force: true }));

const status = "/api/status";
const progress = "/api/monitoring/progress";
const snapshot = "/api/monitoring";
const summary = (id) => ({
  id,
  updateCount: 2,
  newUpdateCount: 1,
  projectCount: 1,
  pcCount: 0,
  advisoryCount: 0,
  newAdvisoryCount: 0,
  title: "2 updates available",
  body: "1 newly detected update. Across 1 project. Click to review.",
  filter: "updates",
});

/**
 * A real coordinator and server behind the desktop's runtime descriptor. `reads()` returns, and
 * forgets, the requests the poll made of it; `replies[path]` replaces one answer, given the real one.
 */
async function coordinator(t) {
  const core = new MonitoringCoordinator({
    dataDir: await mkdtemp(join(temporary, "state-")),
    lookup: false,
  });
  const token = randomBytes(32).toString("base64url");
  const server = await startServer({ port: 0, monitoring: core, authToken: token });
  await mkdir(dataDir, { recursive: true });
  await writeRuntime(dataDir, {
    origin: server.origin,
    pid: process.pid,
    token,
    mode: "interactive",
    host: "session",
  });
  const realFetch = globalThis.fetch;
  const log = [];
  const replies = {};
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith(server.origin)) return realFetch(url, init);
    const { pathname } = new URL(url);
    const conditional = init.headers?.["If-None-Match"];
    log.push(conditional ? `${pathname} if-none-match ${conditional}` : pathname);
    const real = () => realFetch(url, init);
    return replies[pathname] ? replies[pathname](real) : real();
  };
  t.after(async () => {
    globalThis.fetch = realFetch;
    await server.close();
    await core.close();
  });
  return { core, replies, reads: () => log.splice(0) };
}
const withField = (name, value) => async (real) =>
  Response.json({ ...(await (await real()).json()), [name]: value });

test("a snapshot is read only when the cached copy is not the revision progress reports", () => {
  const cached = '"boot-1"';
  assert.deepEqual(snapshotHeaders(null, { revision: "boot-1" }), {}, "nothing is cached yet");
  assert.deepEqual(
    snapshotHeaders(cached, null),
    {},
    "an older coordinator is never asked a condition",
  );
  assert.equal(snapshotHeaders(cached, { revision: "boot-1" }), null, "the cached copy is current");
  assert.deepEqual(snapshotHeaders(cached, { revision: "boot-2" }), { "If-None-Match": cached });
  assert.deepEqual(
    snapshotHeaders('W/"boot-1"', { revision: "boot-1" }),
    { "If-None-Match": 'W/"boot-1"' },
    "a tag that is not exactly the revision is revalidated, never trusted",
  );
});

test("a poll reads its settings from progress, never the snapshot, however the revision moves", async (t) => {
  const { core, reads } = await coordinator(t);
  const first = await pollCoordinator(null);
  assert.deepEqual(reads(), [status, progress]);
  assert.equal(first.runtime.pid, process.pid);
  assert.deepEqual(first.settings, core.snapshot().settings);
  assert.equal(first.projects, null, "nothing needed the project actions yet");
  assert.equal(first.tag, null);
  assert.equal(first.notificationSummary, null);

  core.changeSettings({ paused: true });
  const paused = await pollCoordinator(first);
  assert.deepEqual(reads(), [status, progress], "a durable change needs no snapshot either");
  assert.equal(paused.settings.paused, true);
  core.changeSettings({ notifyNewFindings: false });
  assert.equal((await pollCoordinator(paused)).settings.notifyNewFindings, false);
  assert.deepEqual(reads(), [status, progress]);
});

test("while a project command runs, the snapshot is read for its actions when the revision changes", async (t) => {
  const { core, reads } = await coordinator(t);
  const idle = await pollCoordinator(null);
  reads();
  const first = await pollCoordinator(idle, true);
  assert.deepEqual(reads(), [status, progress, snapshot]);
  assert.equal(first.tag, `"${core.revision}"`);
  assert.deepEqual(first.projects, []);

  const unchanged = await pollCoordinator(first, true);
  assert.deepEqual(reads(), [status, progress], "an unchanged revision needs no snapshot");
  assert.deepEqual(unchanged, first);

  core.changeSettings({ paused: true });
  const changed = await pollCoordinator(unchanged, true);
  assert.deepEqual(reads(), [status, progress, `${snapshot} if-none-match ${first.tag}`]);
  assert.equal(changed.settings.paused, true);
  assert.equal(changed.tag, `"${core.revision}"`);
  assert.notEqual(changed.tag, first.tag);

  await pollCoordinator(changed, true);
  assert.deepEqual(reads(), [status, progress], "the new revision is cached");
  // Once no command runs, the held actions are kept but not refreshed.
  core.changeSettings({ paused: false });
  const finished = await pollCoordinator(changed);
  assert.deepEqual(reads(), [status, progress]);
  assert.equal(finished.settings.paused, false);
  assert.equal(
    finished.tag,
    changed.tag,
    "the held actions still name the revision they came from",
  );
});

test("the poll keeps only each project's id and actions, and follows their changes", async (t) => {
  const { core } = await coordinator(t);
  core.changeSettings({ paused: true }); // No scan may move the revision under the test.
  const project = await core.addProject({
    path: await mkdtemp(join(temporary, "project-")),
    mode: "maintained",
  });
  const build = {
    id: "build",
    name: "Build",
    icon: "build",
    shortcut: null,
    command: "echo build",
  };
  const none = await pollCoordinator(null, true);
  assert.deepEqual(none.projects, [{ id: project.id }]);

  core.changeProject(project.id, { actions: [build] });
  const added = await pollCoordinator(none, true);
  assert.deepEqual(added.projects, [{ id: project.id, actions: [build] }]);

  core.changeProject(project.id, { actions: [] });
  const emptied = await pollCoordinator(added, true);
  assert.deepEqual(emptied.projects, [{ id: project.id, actions: [] }]);

  core.removeProject(project.id);
  assert.deepEqual((await pollCoordinator(emptied, true)).projects, []);
});

test("the notification summary is read from progress on every poll, even when the snapshot is cached", async (t) => {
  const { replies, reads } = await coordinator(t);
  let current = summary("summary-1");
  replies[progress] = async (real) => withField("notificationSummary", current)(real);
  const first = await pollCoordinator(null);
  assert.deepEqual(first.notificationSummary, summary("summary-1"));
  reads();

  current = summary("summary-2");
  const second = await pollCoordinator(first);
  assert.deepEqual(reads(), [status, progress]);
  assert.deepEqual(second.notificationSummary, summary("summary-2"));

  current = null;
  assert.equal((await pollCoordinator(second)).notificationSummary, null);
});

test("a revision that moved while the snapshot did not keeps the cached copy", async (t) => {
  const { replies, reads } = await coordinator(t);
  const first = await pollCoordinator(null, true);
  reads();
  replies[progress] = withField("revision", "elsewhere");
  const again = await pollCoordinator(first, true);
  assert.deepEqual(reads(), [status, progress, `${snapshot} if-none-match ${first.tag}`]);
  assert.deepEqual(again.projects, first.projects);
  assert.equal(again.tag, first.tag, "the coordinator answered 304; nothing was replaced");
});

test("a coordinator whose progress has no settings is read when its revision changes", async (t) => {
  const { core, replies, reads } = await coordinator(t);
  // Builds before v8 sent progress without the settings.
  replies[progress] = async (real) => {
    const { settings: _settings, ...older } = await (await real()).json();
    return Response.json(older);
  };
  const first = await pollCoordinator(null);
  assert.deepEqual(reads(), [status, progress, snapshot]);
  assert.equal(first.settings.paused, false);
  assert.deepEqual(await pollCoordinator(first), first);
  assert.deepEqual(reads(), [status, progress], "an unchanged revision needs no snapshot");
  core.changeSettings({ paused: true });
  const paused = await pollCoordinator(first);
  assert.deepEqual(reads(), [status, progress, `${snapshot} if-none-match ${first.tag}`]);
  assert.equal(paused.settings.paused, true);
});

test("a coordinator without the progress endpoint is read in full on every poll", async (t) => {
  const { replies, reads } = await coordinator(t);
  replies[progress] = async () => Response.json({ error: "API route not found" }, { status: 404 });
  // Builds that old sent no ETag and put the notification summary in the snapshot.
  replies[snapshot] = async (real) => withField("notificationSummary", summary("legacy"))(real);
  const first = await pollCoordinator(null);
  const second = await pollCoordinator(first);
  assert.deepEqual(reads(), [status, progress, snapshot, status, progress, snapshot]);
  for (const poll of [first, second]) {
    assert.equal(poll.tag, null);
    assert.equal(poll.settings.paused, false);
    assert.deepEqual(poll.notificationSummary, summary("legacy"));
  }
});

test("a poll that cannot read the coordinator is not connected", async (t) => {
  const { core, replies } = await coordinator(t);
  const first = await pollCoordinator(null);
  assert(first);
  const failing = (code) => async () => new Response("unavailable", { status: code });
  for (const [path, reply] of [
    [progress, failing(401)],
    [progress, failing(500)],
    [status, failing(500)],
    [progress, async () => Response.json({ revision: 7 })],
    [progress, withField("settings", { paused: "no" })],
  ]) {
    replies[path] = reply;
    assert.equal(await pollCoordinator(first), null, path);
    delete replies[path];
  }
  core.changeSettings({ paused: true });
  replies[snapshot] = failing(500);
  assert.equal(
    await pollCoordinator(first, true),
    null,
    "a snapshot that a running command needs and that cannot be read",
  );
  delete replies[snapshot];
  assert.equal((await pollCoordinator(first)).settings.paused, true);
});
