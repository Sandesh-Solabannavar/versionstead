import assert from "node:assert/strict";
import test from "node:test";
import { actionKeys, failureRouter, settled } from "./monitoring-actions.ts";

test("a key stays pending until every overlapping action with that key has finished", () => {
  const started = ["scan:all", "setting:paused", "scan:all"];
  const afterOne = settled(started, "scan:all");
  assert.deepEqual(afterOne, ["setting:paused", "scan:all"]);
  assert(new Set(afterOne).has("scan:all"), "the second scan request is still running");
  assert.deepEqual(settled(afterOne, "scan:all"), ["setting:paused"]);
  assert.deepEqual(settled(["setting:paused"], "scan:all"), ["setting:paused"]);
  assert.deepEqual(started, ["scan:all", "setting:paused", "scan:all"], "the input is not changed");
});

test("keys name what an action changes, so an unrelated control stays available", () => {
  const keys = [
    actionKeys.session,
    actionKeys.addProject,
    actionKeys.scan("pc"),
    actionKeys.scan("projects"),
    actionKeys.scan("projects", "one"),
    actionKeys.scan("projects", "two"),
    actionKeys.scan("all"),
    actionKeys.removeProject("one"),
    actionKeys.removeProject("two"),
    actionKeys.projectMode("one"),
    actionKeys.setting("paused"),
    actionKeys.setting("pcIntervalMinutes"),
    actionKeys.preference("paused"),
    actionKeys.provider("github"),
    actionKeys.provider("gitlab"),
    actionKeys.client("one"),
    actionKeys.environment("one"),
    actionKeys.environment("two"),
    actionKeys.sharing,
    actionKeys.invitation,
    actionKeys.update,
  ];
  assert.equal(new Set(keys).size, keys.length, "every action has its own key");
  // The same action is the same key wherever it is started from.
  assert.equal(actionKeys.scan("projects", "one"), actionKeys.scan("projects", "one"));
  assert.equal(actionKeys.setting("paused"), actionKeys.setting("paused"));
});

test("a failure goes to the form that asked while it is open, and to the fallback once it is not", () => {
  const shown: string[] = [];
  const fallback: string[] = [];
  const router = failureRouter(
    (message) => shown.push(message),
    (message) => fallback.push(message),
  );
  // Open by default: the form shows it.
  router.deliver("refused");
  // The form closed (or its owner went away) before the request settled: nothing is lost.
  router.setOpen(false);
  router.deliver("late");
  // Reopened, it shows messages again.
  router.setOpen(true);
  router.deliver("again");
  assert.deepEqual(shown, ["refused", "again"]);
  assert.deepEqual(fallback, ["late"]);
  // The delivery function can be handed around on its own, as an `onError` callback.
  const { deliver } = router;
  deliver("detached");
  assert.deepEqual(shown, ["refused", "again", "detached"]);
});
