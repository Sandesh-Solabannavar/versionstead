import assert from "node:assert/strict";
import test from "node:test";
import { NotificationHistory } from "./notification-history.ts";
import { decodeNotificationSummary } from "@versionstead/contracts/monitoring";

test("in-app summary identities deduplicate snapshot, native, reconnect, and reload delivery", () => {
  const history = new NotificationHistory();
  assert.equal(history.remember("batch-1"), true);
  assert.equal(history.remember("batch-1"), false);
  const reloaded = new NotificationHistory(history.read());
  assert.equal(reloaded.remember("batch-1"), false);
  assert.equal(reloaded.remember("batch-2"), true);
  assert.equal(new NotificationHistory(null).remember("batch-1"), true);
  assert.deepEqual(new NotificationHistory([{}, null, 4, "", "x".repeat(201), "valid"]).read(), [
    "valid",
  ]);
});

test("notification history stays bounded and incoming native summaries validate the full contract", () => {
  const history = new NotificationHistory();
  for (let i = 0; i < 250; i++) history.remember(`batch-${i}`);
  assert.equal(history.read().length, 200);
  assert.equal(history.read()[0], "batch-50");
  const summary = {
    id: "fixture",
    updateCount: 3,
    newUpdateCount: 3,
    projectCount: 1,
    pcCount: 0,
    advisoryCount: 0,
    newAdvisoryCount: 0,
    title: "3 updates available",
    body: "3 newly detected updates.",
    filter: "updates",
  };
  assert.deepEqual(decodeNotificationSummary(summary), summary);
  for (const invalid of [
    {},
    { ...summary, filter: "https://example.com" },
    { ...summary, title: { html: "unsafe" } },
  ])
    assert.throws(() => decodeNotificationSummary(invalid));
});
