import assert from "node:assert/strict";
import test from "node:test";
import type { MonitoringProgress, MonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { etagRevision, snapshotRequest, withProgress } from "./monitoring-poll.ts";

const snapshot: MonitoringSnapshot = {
  protocolVersion: 1,
  runtime: {
    startedAt: "2026-10-08T00:00:00Z",
    mode: "interactive",
    host: "session",
    platform: "win32",
    nextScanAt: null,
  },
  device: { id: "device", label: "PC", platform: "win32" },
  settings: {
    paused: false,
    pcIntervalMinutes: 360,
    projectIntervalMinutes: 60,
    notifyNewFindings: true,
  },
  inventory: {
    evidence: {
      status: "complete",
      lastAttempt: null,
      lastSuccess: null,
      coverage: [],
      errors: [],
    },
    installations: [],
  },
  projects: [],
  findings: [],
  history: [],
  notifications: [],
  notificationSummary: null,
  notificationNextAt: null,
  scanProgress: { active: null, queued: [] },
};
const progress: MonitoringProgress = {
  revision: "boot-2",
  scanProgress: {
    active: null,
    queued: [{ targetId: "project", targetLabel: "Project", kind: "project" }],
  },
  notificationSummary: null,
  notificationNextAt: "2026-10-08T00:05:00Z",
};

test("ETag headers yield the bare snapshot revision", () => {
  assert.equal(etagRevision('"boot-2"'), "boot-2");
  assert.equal(etagRevision('W/"boot-2"'), "boot-2");
  assert.equal(etagRevision("boot-2"), null);
  assert.equal(etagRevision(null), null);
});

test("polls read the snapshot only when missing, stale, unknown, or explicitly refreshed", () => {
  const current = { snapshot, etag: "boot-2" };
  const conditional = { "If-None-Match": '"boot-2"' };
  assert.equal(snapshotRequest(current, progress, false), null);
  assert.deepEqual(
    snapshotRequest(current, { ...progress, revision: "boot-3" }, false),
    conditional,
  );
  assert.deepEqual(snapshotRequest(current, progress, true), conditional);
  assert.deepEqual(snapshotRequest({ snapshot: null, etag: null }, progress, false), {});
  assert.deepEqual(snapshotRequest({ snapshot, etag: null }, progress, false), {});
  // Older coordinators without the progress endpoint keep unconditional full-snapshot polling.
  assert.deepEqual(snapshotRequest(current, null, false), {});
  assert.deepEqual(snapshotRequest(current, null, true), {});
});

test("progress replaces only the live fields of the displayed snapshot", () => {
  const merged = withProgress(snapshot, progress);
  assert.deepEqual(merged?.scanProgress, progress.scanProgress);
  assert.equal(merged?.notificationSummary, null);
  assert.equal(merged?.notificationNextAt, "2026-10-08T00:05:00Z");
  assert.equal(merged?.projects, snapshot.projects);
  assert.equal(merged?.findings, snapshot.findings);
  assert.equal(withProgress(snapshot, null), snapshot);
  assert.equal(withProgress(null, progress), null);
});
