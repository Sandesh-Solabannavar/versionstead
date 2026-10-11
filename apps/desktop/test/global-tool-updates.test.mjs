import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalToolUpdateRunner, currentUpdateItems } from "../dist/global-tool-updates.js";
import { InputError } from "../../server/dist/adapters/projects.js";
import {
  decodeGlobalToolUpdateBatch,
  decodeGlobalToolUpdateBatchRequest,
  decodeGlobalToolUpdateBatchStatus,
  decodeGlobalToolUpdateRuns,
  globalToolUpdateBatchActive,
} from "@versionstead/contracts/global-tool-updates";

const item = {
  id: "a".repeat(32),
  rootId: "b".repeat(32),
  manager: "npm",
  name: "tool",
  packageId: "tool",
  version: "1.0.0",
  availableVersion: "2.0.0",
  origin: "registry",
  updateStatus: "available",
};
async function settle(runner) {
  for (let i = 0; runner.active && i < 100; i++) await delay(10);
  assert(!runner.active);
}
test("desktop updater locks a global root, verifies before success and refreshes afterward", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = new GlobalToolUpdateRunner({
    resolve: async () => {
      calls.push("resolve");
      return { command: "fixture" };
    },
    execute: async () => {
      calls.push("execute");
      await gate;
    },
    verify: async () => {
      assert.equal(runner.read()[0].status, "verifying");
      calls.push("verify");
    },
    refresh: async () => {
      calls.push("refresh");
    },
  });
  assert.equal(runner.start(item).status, "preparing");
  assert.throws(() => runner.start({ ...item, name: "another" }), /already running/);
  await delay(0);
  assert.equal(runner.read()[0].status, "updating");
  release();
  await settle(runner);
  assert.equal(runner.read()[0].status, "succeeded");
  assert.deepEqual(calls, ["resolve", "execute", "verify", "refresh"]);
  decodeGlobalToolUpdateRuns(runner.read());
});
test("failed verification remains failed, triggers a rescan and permits a manual retry", async () => {
  let refreshes = 0;
  const runner = new GlobalToolUpdateRunner({
    resolve: async () => ({ command: "fixture" }),
    execute: async () => {},
    verify: async () => {
      throw new InputError("The installed version could not be verified.");
    },
    refresh: async () => {
      refreshes++;
    },
  });
  runner.start(item);
  await settle(runner);
  assert.equal(runner.read()[0].status, "failed");
  assert.match(runner.read()[0].message, /verified/);
  runner.start(item);
  await settle(runner);
  assert.equal(refreshes, 2);
  assert.equal(runner.read().length, 1);
});
test("desktop quit cancels manual work while keeping raw process errors out of UI results", async () => {
  let refreshed = false;
  const runner = new GlobalToolUpdateRunner({
    resolve: async () => ({ command: "fixture" }),
    execute: async (_plan, signal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("credential-bearing raw stderr");
    },
    verify: async () => {
      throw new Error("must not verify");
    },
    refresh: async () => {
      refreshed = true;
    },
  });
  runner.start(item);
  await delay(0);
  await runner.close();
  assert.equal(runner.read()[0].status, "failed");
  assert(!runner.read()[0].message.includes("credential"));
  assert(refreshed);
  assert.throws(() => runner.start(item), /shutting down/);
});

const tool = (name, manager = "npm", changes = {}) => ({
  id: createHash("md5").update(`${manager}:${name}`).digest("hex"),
  rootId: (manager === "npm" ? "b" : "c").repeat(32),
  manager,
  name,
  packageId: name,
  version: "1.0.0",
  availableVersion: "2.0.0",
  origin: "registry",
  updateStatus: "available",
  ...changes,
});

test("Update all runs one package at a time, verifies each, rescans once, and updates npm itself last", async () => {
  const calls = [];
  let installing = 0;
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: candidate.name }),
    execute: async (plan) => {
      installing++;
      assert.equal(installing, 1, "Never two installers at once");
      calls.push(`execute ${plan.command}`);
      await delay(5);
      installing--;
    },
    verify: async (_plan, candidate) => {
      calls.push(`verify ${candidate.name}`);
    },
    refresh: async () => {
      calls.push("refresh");
    },
  });
  const started = runner.startAll([tool("npm"), tool("tsx"), tool("typescript", "bun")]);
  // The returned batch is the state at return: the first package has already begun preparing.
  assert.deepEqual(
    started.items.map((entry) => [entry.name, entry.status]),
    [
      ["tsx", "preparing"],
      ["typescript", "waiting"],
      ["npm", "waiting"],
    ],
  );
  decodeGlobalToolUpdateBatch(started);
  assert(globalToolUpdateBatchActive(started));
  assert.throws(() => runner.start(tool("other")), /Update all is running/);
  assert.throws(() => runner.startAll([tool("other")]), /Another update is running/);
  await settle(runner);
  const finished = runner.readBatch();
  assert.equal(finished.status, "finished");
  assert.equal(finished.stopped, false);
  assert.equal(finished.note, null);
  assert.deepEqual(
    finished.items.map((entry) => entry.status),
    ["succeeded", "succeeded", "succeeded"],
  );
  assert.deepEqual(calls, [
    "execute tsx",
    "verify tsx",
    "execute typescript",
    "verify typescript",
    "execute npm",
    "verify npm",
    "refresh",
  ]);
  assert.deepEqual(runner.read(), [], "Update all keeps its items out of the single-update list");
  decodeGlobalToolUpdateBatch(finished);
  assert.equal(globalToolUpdateBatchActive(finished), false);
  assert.equal(decodeGlobalToolUpdateBatchStatus(null), null);
  assert.deepEqual(decodeGlobalToolUpdateBatchStatus(finished), finished);
});

test("a global location that becomes unwritable midway skips the rest of it, keeps going elsewhere, and still rescans", async () => {
  const executed = [];
  let refreshes = 0;
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: candidate.name }),
    execute: async (plan) => {
      executed.push(plan.command);
      if (plan.command === "second")
        throw new InputError(
          "The global location is not writable. Update this package in an authorized terminal, then scan this PC.",
        );
    },
    verify: async () => {},
    refresh: async () => {
      refreshes++;
    },
  });
  runner.startAll([tool("first"), tool("second"), tool("third"), tool("bun-tool", "bun")]);
  await settle(runner);
  const batch = runner.readBatch();
  assert.deepEqual(
    batch.items.map((entry) => [entry.name, entry.status]),
    [
      ["first", "succeeded"],
      ["second", "failed"],
      ["third", "skipped"],
      ["bun-tool", "succeeded"],
    ],
  );
  assert.match(batch.items[1].message, /not writable/);
  assert.match(batch.items[2].message, /earlier update in this global location failed/);
  assert.deepEqual(executed, ["first", "second", "bun-tool"]);
  assert.equal(refreshes, 1);
});

test("Stop lets the package being installed finish and starts nothing after it", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: candidate.name }),
    execute: async (plan, signal) => {
      if (plan.command === "first") await gate;
      assert.equal(signal.aborted, false, "Stop never interrupts an installer");
    },
    verify: async () => {},
    refresh: async () => {},
  });
  runner.startAll([tool("first"), tool("second"), tool("third", "bun")]);
  await delay(0);
  const stopping = runner.stopAll();
  assert.equal(stopping.status, "stopping");
  decodeGlobalToolUpdateBatch(stopping);
  assert(globalToolUpdateBatchActive(stopping), "A stopping batch still blocks other updates");
  assert.throws(() => runner.start(tool("other")), /Update all is running/);
  release();
  await settle(runner);
  const batch = runner.readBatch();
  assert.equal(batch.stopped, true);
  assert.deepEqual(
    batch.items.map((entry) => entry.status),
    ["succeeded", "skipped", "skipped"],
  );
  assert.match(batch.items[1].message, /you stopped Update all/);
});

test("quitting during Update all stops the running installer, starts nothing else, and still rescans", async () => {
  let refreshed = false;
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: candidate.name }),
    execute: async (_plan, signal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new InputError("The update was stopped. Scan this PC before retrying.");
    },
    verify: async () => {
      throw new Error("must not verify");
    },
    refresh: async () => {
      refreshed = true;
    },
  });
  runner.startAll([tool("first"), tool("second")]);
  await delay(0);
  await runner.close();
  const batch = runner.readBatch();
  assert.equal(batch.status, "finished");
  assert.deepEqual(
    batch.items.map((entry) => entry.status),
    ["failed", "skipped"],
  );
  assert.match(batch.items[1].message, /quit/);
  assert(refreshed);
  assert.throws(() => runner.startAll([tool("third")]), /shutting down/);
});

test("Update all refuses empty, repeated, and unverified packages before anything runs", () => {
  const runner = new GlobalToolUpdateRunner({
    resolve: async () => assert.fail("nothing may resolve"),
    execute: async () => {},
    verify: async () => {},
    refresh: async () => {},
  });
  assert.throws(() => runner.startAll([]), /no verified update/);
  assert.throws(() => runner.startAll([tool("tsx"), tool("tsx")]), /updated once/);
  assert.throws(
    () => runner.startAll([tool("tsx", "npm", { origin: "local" })]),
    /no verified update/,
  );
  assert.equal(runner.readBatch(), null);
  assert.throws(() => decodeGlobalToolUpdateBatchRequest({ items: [] }));
  assert.throws(() =>
    decodeGlobalToolUpdateBatchRequest({
      items: [{ installationId: "x", expectedVersion: "1.0.0", targetVersion: "2.0.0" }],
    }),
  );
});

test("Update all requests are checked against the coordinator's current evidence, exactly like Update now", () => {
  const installation = tool("tsx");
  const snapshot = (changes = {}) => ({
    inventory: {
      evidence: { status: "complete" },
      updateEvidence: { status: "complete" },
      installations: [installation],
    },
    scanProgress: { active: null, queued: [] },
    ...changes,
  });
  const request = {
    installationId: installation.id,
    expectedVersion: "1.0.0",
    targetVersion: "2.0.0",
  };
  assert.deepEqual(currentUpdateItems(snapshot(), [request]), [installation]);
  assert.throws(() => currentUpdateItems(null, [request]), /This update changed/);
  assert.throws(
    () => currentUpdateItems(snapshot(), [{ ...request, expectedVersion: "0.9.0" }]),
    /This update changed/,
  );
  assert.throws(
    () => currentUpdateItems(snapshot(), [request, { ...request, installationId: "f".repeat(32) }]),
    /This update changed/,
    "One stale item refuses the whole request",
  );
  assert.throws(
    () =>
      currentUpdateItems(
        snapshot({
          scanProgress: {
            active: null,
            queued: [{ kind: "pc", targetId: "pc", targetLabel: "PC" }],
          },
        }),
        [request],
      ),
    /Wait for the PC scan/,
  );
  assert.throws(
    () =>
      currentUpdateItems(
        snapshot({ inventory: { ...snapshot().inventory, updateEvidence: { status: "failed" } } }),
        [request],
      ),
    /Scan this PC successfully/,
  );
});

test("Update all is refused while a single update is installing", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: candidate.name }),
    execute: async () => {
      await gate;
    },
    verify: async () => {},
    refresh: async () => {},
  });
  runner.start(tool("single"));
  await delay(0);
  // A bun tool lives in another global location, so only the running update can refuse it.
  assert.throws(() => runner.startAll([tool("other", "bun")]), /Another update is running/);
  assert.equal(runner.readBatch(), null);
  release();
  await settle(runner);
});

test("Update all stays running and blocks other updates until its closing rescan settles", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: candidate.name }),
    execute: async () => {},
    verify: async () => {},
    refresh: async () => {
      await gate;
    },
  });
  runner.startAll([tool("first")]);
  await delay(0);
  const rescanning = runner.readBatch();
  assert.equal(rescanning.items[0].status, "succeeded");
  assert.equal(rescanning.status, "running", "The rescan is still pending");
  assert.equal(runner.active, true);
  assert.throws(() => runner.start(tool("other")), /Update all is running/);
  assert.throws(() => runner.startAll([tool("other")]), /Another update is running/);
  release();
  await settle(runner);
  assert.equal(runner.readBatch().status, "finished");
});

test("a rescan that cannot start still finishes Update all, leaves a note, and frees the runner", async () => {
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: candidate.name }),
    execute: async () => {},
    verify: async () => {},
    refresh: async () => {
      throw new Error("Monitoring is unavailable.");
    },
  });
  runner.startAll([tool("first")]);
  await settle(runner);
  const batch = runner.readBatch();
  assert.equal(batch.status, "finished");
  assert.match(batch.note, /rescan could not start/);
  assert(
    Date.parse(batch.finishedAt) >= Date.parse(batch.startedAt),
    "A finished batch records when it finished",
  );
  decodeGlobalToolUpdateBatch(batch);
  runner.start(tool("again"));
  await settle(runner);
});

test("Stop after Update all finished changes nothing and never blocks later updates", async () => {
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: candidate.name }),
    execute: async () => {},
    verify: async () => {},
    refresh: async () => {},
  });
  assert.equal(runner.stopAll(), null, "Nothing to stop before the first Update all");
  runner.startAll([tool("first")]);
  await settle(runner);
  const finished = runner.readBatch();
  const stopped = runner.stopAll();
  assert.equal(stopped.status, "finished");
  assert.equal(stopped.stopped, false);
  assert.deepEqual(stopped, finished);
  assert.equal(runner.active, false);
  runner.start(tool("again"));
  await settle(runner);
});

test("quitting waits for the closing rescan before it resolves", async () => {
  let rescanned = false;
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: candidate.name }),
    execute: async (_plan, signal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new InputError("The update was stopped. Scan this PC before retrying.");
    },
    verify: async () => {},
    refresh: async () => {
      await delay(30);
      rescanned = true;
    },
  });
  runner.startAll([tool("first"), tool("second")]);
  await delay(0);
  await runner.close();
  assert(rescanned, "close() resolved before the rescan request settled");
  assert.equal(runner.readBatch().status, "finished");
});

test("Update all verifies each package against its confirmed installation and resolved plan", async () => {
  const verified = [];
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => ({ command: `resolved ${candidate.name}` }),
    execute: async () => {},
    verify: async (plan, candidate) => {
      verified.push([plan.command, candidate.name, candidate.availableVersion]);
    },
    refresh: async () => {},
  });
  runner.startAll([tool("first"), tool("second", "bun")]);
  await settle(runner);
  assert.deepEqual(verified, [
    ["resolved first", "first", "2.0.0"],
    ["resolved second", "second", "2.0.0"],
  ]);
});

test("Update all refuses a moved target, a stale update, and a PC scan that is running or failed", () => {
  const installation = tool("tsx");
  const request = {
    installationId: installation.id,
    expectedVersion: "1.0.0",
    targetVersion: "2.0.0",
  };
  const snapshot = (inventory = {}, scanProgress = { active: null, queued: [] }) => ({
    inventory: {
      evidence: { status: "complete" },
      updateEvidence: { status: "complete" },
      installations: [installation],
      ...inventory,
    },
    scanProgress,
  });
  // Each case differs from the confirmed request in one way, so only its own check can refuse it.
  const changed = (installationChanges) =>
    snapshot({ installations: [{ ...installation, ...installationChanges }] });
  assert.deepEqual(currentUpdateItems(snapshot(), [request]), [installation]);
  assert.throws(
    () => currentUpdateItems(changed({ availableVersion: "2.1.0" }), [request]),
    /This update changed/,
    "A rescan moved the target after the owner confirmed 2.0.0",
  );
  assert.throws(
    () => currentUpdateItems(snapshot(), [{ ...request, targetVersion: "2.1.0" }]),
    /This update changed/,
    "The request names a target that is not available",
  );
  assert.throws(
    () => currentUpdateItems(changed({ updateStatus: "current" }), [request]),
    /This update changed/,
    "The update is no longer available",
  );
  assert.throws(
    () => currentUpdateItems(snapshot({ evidence: { status: "scanning" } }), [request]),
    /Wait for the PC scan/,
    "The PC inventory is being scanned",
  );
  assert.throws(
    () =>
      currentUpdateItems(
        snapshot({}, { active: { kind: "pc", targetId: "pc", targetLabel: "PC" }, queued: [] }),
        [request],
      ),
    /Wait for the PC scan/,
    "A PC scan is running",
  );
  assert.throws(
    () => currentUpdateItems(snapshot({ evidence: { status: "failed" } }), [request]),
    /Scan this PC successfully/,
    "The last PC scan failed",
  );
  assert.deepEqual(
    currentUpdateItems(
      snapshot({}, { active: { kind: "project", targetId: "p", targetLabel: "P" }, queued: [] }),
      [request],
    ),
    [installation],
    "A project scan does not block updating global tools",
  );
});

test("quitting while a package is still being checked never starts its installer", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = new GlobalToolUpdateRunner({
    resolve: async (candidate) => {
      calls.push(`resolve ${candidate.name}`);
      await gate;
      return { command: candidate.name };
    },
    execute: async () => {
      calls.push("execute");
    },
    verify: async () => {
      calls.push("verify");
    },
    refresh: async () => {
      calls.push("refresh");
    },
  });
  runner.startAll([tool("first"), tool("second")]);
  await delay(0);
  const closing = runner.close();
  release();
  await closing;
  assert.deepEqual(calls, ["resolve first", "refresh"], "No installer ran after quit");
  assert.deepEqual(
    runner.readBatch().items.map((entry) => entry.status),
    ["failed", "skipped"],
  );
});
