import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalToolUpdateRunner } from "../dist/global-tool-updates.js";
import { InputError } from "../../server/dist/adapters/projects.js";
import { decodeGlobalToolUpdateRuns } from "@versionstead/contracts/global-tool-updates";

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
