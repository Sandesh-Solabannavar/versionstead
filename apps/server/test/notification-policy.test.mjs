import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  ChangeSettings,
  isHourMinute,
  MonitoringSettings,
  NotificationSummary,
  notificationScopes,
} from "@versionstead/contracts/monitoring";
import * as Schema from "effect/Schema";
import { sharedEvidence } from "../dist/adapters/paired-computers.js";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import {
  inQuietHours,
  latestDailyTime,
  notificationEligible,
} from "../dist/notification-policy.js";
import { selectDirectory } from "../dist/adapters/projects.js";
import { MonitoringStorage } from "../dist/storage.js";

// Windows cannot delete a SQLite database that is still open. The directories are removed once,
// after every test has run its own `t.after` hooks and closed its coordinators.
const directories = [];
after(() =>
  Promise.all(
    directories.map((path) =>
      rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  ),
);
async function temporary() {
  const path = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-notify-")));
  directories.push(path);
  return path;
}
async function waitFor(predicate) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function finishScan(coordinator, projectId) {
  const previous = coordinator.snapshot().history[0]?.id;
  coordinator.requestScan({ target: "projects", projectId });
  await waitFor(() => {
    const latest = coordinator.snapshot().history[0];
    return latest?.id !== previous && latest?.status !== "scanning";
  });
}
async function aliasFixture(root) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { alias: "npm:public-example@^1.0.0" } }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", dependencies: { alias: "npm:public-example@^1.0.0" } },
        "node_modules/alias": {
          name: "public-example",
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/public-example/-/public-example-1.0.0.tgz",
        },
      },
    }),
  );
  return root;
}
const withUpdate =
  (version, advisory = null) =>
  async (dependencies) => {
    const alias = dependencies.find((d) => d.name === "alias");
    return {
      dependencies: dependencies.map((d) => ({
        ...d,
        availableVersion: d.id === alias.id ? version : null,
        versionStatus: "checked",
        advisoryStatus: "checked",
        advisoryIds: d.id === alias.id && advisory ? [advisory.id] : [],
      })),
      versionChecked: new Set(dependencies.map((d) => d.id)),
      advisories: new Map(advisory ? [[alias.id, [advisory]]] : []),
      coverage: [],
      errors: [],
    };
  };

test("only updates and advisories notify, never a hidden one, a watch-only project's only on request, within Notify about", () => {
  const update = { kind: "update", severity: "info" };
  const high = { kind: "advisory", severity: "high" };
  const moderate = { kind: "advisory", severity: "moderate" };
  assert.equal(notificationEligible(update, {}, null, false), true);
  assert.equal(
    notificationEligible({ kind: "coverage", severity: "unknown" }, {}, null, false),
    false,
  );
  assert.equal(
    notificationEligible({ kind: "lifecycle", severity: "high" }, {}, null, false),
    false,
  );
  assert.equal(
    notificationEligible({ kind: "other", severity: "critical" }, {}, null, false),
    false,
    "A kind this build does not know never notifies",
  );
  assert.equal(
    notificationEligible(update, {}, null, true),
    false,
    "Snoozed and ignored findings never notify",
  );
  assert.equal(notificationEligible(update, {}, "watch", false), false);
  assert.equal(notificationEligible(update, { notifyWatchOnly: true }, "watch", false), true);
  assert.equal(notificationEligible(update, { notifyWatchOnly: false }, "watch", false), false);
  assert.equal(notificationEligible(update, {}, "maintained", false), true);
  assert.equal(
    notificationEligible(update, { notificationScope: "advisories" }, "maintained", false),
    false,
  );
  assert.equal(
    notificationEligible(moderate, { notificationScope: "advisories" }, null, false),
    true,
  );
  assert.equal(
    notificationEligible(moderate, { notificationScope: "high-advisories" }, null, false),
    false,
  );
  assert.equal(
    notificationEligible(high, { notificationScope: "high-advisories" }, null, false),
    true,
  );
  assert.equal(
    notificationEligible(
      { kind: "advisory", severity: "critical" },
      { notificationScope: "high-advisories" },
      null,
      false,
    ),
    true,
  );
  assert.equal(
    notificationEligible(
      { kind: "advisory", severity: "low" },
      { notificationScope: "high-advisories" },
      null,
      false,
    ),
    false,
  );
  assert.equal(
    notificationEligible(
      { kind: "advisory", severity: "unknown" },
      { notificationScope: "high-advisories" },
      null,
      false,
    ),
    true,
    "An advisory without a rating is not known to be safe, so it still notifies",
  );
  assert.equal(
    notificationEligible(
      { kind: "update", severity: "unknown" },
      { notificationScope: "high-advisories" },
      null,
      false,
    ),
    false,
    "Only advisories carry a rating that can make them notify here",
  );
  assert.equal(
    notificationEligible(high, { notificationScope: "advisories" }, "watch", false),
    false,
    "Notify about does not lift the watch-only rule",
  );
});

test("watch-only projects and Notify about decide which new findings create notification events", async (t) => {
  const root = await temporary();
  let candidate = "1.5.0";
  let advisory = null;
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => withUpdate(candidate, advisory)(dependencies),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  assert.deepEqual(
    [
      coordinator.snapshot().settings.notificationScope,
      coordinator.snapshot().settings.notifyWatchOnly,
    ],
    ["all", false],
  );
  const maintained = await coordinator.addProject({
    path: await aliasFixture(join(root, "maintained")),
    mode: "maintained",
  });
  const watched = await coordinator.addProject({
    path: await aliasFixture(join(root, "watched")),
    mode: "watch",
  });
  const latest = (projectId, kind) =>
    coordinator.snapshot().findings.find((f) => f.subjectId === projectId && f.kind === kind);
  const notifies = (finding) =>
    coordinator.snapshot().notifications.some((n) => n.findingId === finding.id);
  await finishScan(coordinator, maintained.id);
  await finishScan(coordinator, watched.id);
  assert.equal(notifies(latest(maintained.id, "update")), true);
  assert.equal(
    notifies(latest(watched.id, "update")),
    false,
    "Watch-only projects stay quiet by default",
  );
  coordinator.changeSettings({ notifyWatchOnly: true });
  assert.equal(
    notifies(latest(watched.id, "update")),
    false,
    "Opting in does not announce what was already seen",
  );
  candidate = "1.6.0";
  await finishScan(coordinator, watched.id);
  assert.equal(
    notifies(latest(watched.id, "update")),
    true,
    "A newer watch-only finding notifies after opting in",
  );
  coordinator.changeSettings({ notificationScope: "advisories" });
  candidate = "1.7.0";
  await finishScan(coordinator, maintained.id);
  assert.equal(
    notifies(latest(maintained.id, "update")),
    false,
    "Advisories only: a new update creates no event",
  );
  coordinator.changeSettings({ notificationScope: "high-advisories" });
  advisory = {
    id: "GHSA-moderate",
    summary: "Moderate fixture",
    severity: "moderate",
    url: "https://osv.dev/vulnerability/GHSA-moderate",
    fixed: "1.7.0",
  };
  await finishScan(coordinator, maintained.id);
  assert.equal(notifies(latest(maintained.id, "advisory")), false);
  advisory = {
    ...advisory,
    id: "GHSA-high",
    severity: "high",
    url: "https://osv.dev/vulnerability/GHSA-high",
  };
  await finishScan(coordinator, maintained.id);
  assert.equal(notifies(latest(maintained.id, "advisory")), true);
  // The tray reads the settings from progress, and a rejected change leaves them as they were.
  assert.deepEqual(
    [
      coordinator.progressSnapshot().settings.notificationScope,
      coordinator.progressSnapshot().settings.notifyWatchOnly,
    ],
    ["high-advisories", true],
  );
  for (const invalid of [
    { notificationScope: "everything" },
    { notificationScope: null },
    { notificationScope: 1 },
    { notifyWatchOnly: "yes" },
    { notifyWatchOnly: 1 },
    { notifyWatchOnly: null },
  ])
    assert.throws(
      () => coordinator.changeSettings(invalid),
      /Invalid monitoring settings/,
      JSON.stringify(invalid),
    );
  assert.deepEqual(
    [
      coordinator.snapshot().settings.notificationScope,
      coordinator.snapshot().settings.notifyWatchOnly,
    ],
    ["high-advisories", true],
  );
});

test("a finding snoozed while its notification is pending leaves the summary", async (t) => {
  const root = await temporary();
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate("1.5.0"),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({
    path: await aliasFixture(join(root, "project")),
    mode: "maintained",
  });
  await finishScan(coordinator, project.id);
  const update = coordinator.snapshot().findings.find((f) => f.kind === "update");
  assert.equal(
    coordinator.snapshot().notifications.filter((n) => n.deliveredAt === null).length,
    1,
  );
  const rule = coordinator.addFindingRule({ findingId: update.id, mode: "snooze", days: 7 });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(
    coordinator.snapshot().notificationSummary,
    null,
    "A hidden finding is not summarized",
  );
  coordinator.removeFindingRule(rule.id);
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
});

test("a new finding that arrives while its package is snoozed creates no event, not even once the snooze ends", async (t) => {
  const root = await temporary();
  let candidate = "1.5.0";
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => withUpdate(candidate)(dependencies),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({
    path: await aliasFixture(join(root, "project")),
    mode: "maintained",
  });
  await finishScan(coordinator, project.id);
  const rule = coordinator.addFindingRule({
    findingId: coordinator.snapshot().findings.find((f) => f.kind === "update").id,
    mode: "snooze",
    days: 7,
  });
  candidate = "1.6.0";
  await finishScan(coordinator, project.id);
  const second = coordinator.snapshot().findings.find((f) => f.kind === "update");
  assert.equal(second.availableVersion, "1.6.0");
  assert.equal(second.ruleId, rule.id, "The snooze follows its package to the new candidate");
  const announced = () =>
    coordinator.snapshot().notifications.some((n) => n.findingId === second.id);
  assert.equal(announced(), false, "A snoozed package's new candidate creates no event");
  coordinator.removeFindingRule(rule.id);
  assert.equal(announced(), false, "Seen while snoozed, it counts as already announced");
  candidate = "1.7.0";
  await finishScan(coordinator, project.id);
  const third = coordinator.snapshot().findings.find((f) => f.kind === "update");
  assert.equal(
    coordinator.snapshot().notifications.some((n) => n.findingId === third.id),
    true,
    "A later candidate notifies again",
  );
});

test("the summary counts only what may notify", async (t) => {
  const root = await temporary();
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate("1.5.0"),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const maintained = await coordinator.addProject({
    path: await aliasFixture(join(root, "maintained")),
    mode: "maintained",
  });
  const watched = await coordinator.addProject({
    path: await aliasFixture(join(root, "watched")),
    mode: "watch",
  });
  await finishScan(coordinator, maintained.id);
  await finishScan(coordinator, watched.id);
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  const counts = ({ notificationSummary: s }) => [
    s.id,
    s.updateCount,
    s.newUpdateCount,
    s.projectCount,
  ];
  const [id, ...quiet] = counts(coordinator.snapshot());
  assert.deepEqual(quiet, [1, 1, 1], "The watch-only project's update is not counted");
  coordinator.changeSettings({ notifyWatchOnly: true });
  assert.deepEqual(
    counts(coordinator.snapshot()),
    [id, 2, 1, 2],
    "Opting in counts it, but it is not new",
  );
});

test("the Notify about settings survive a restart, and a database from before them gets the defaults", async (t) => {
  const dataDir = join(await temporary(), "state");
  const notify = (coordinator) => {
    const { notificationScope, notifyWatchOnly } = coordinator.snapshot().settings;
    return [notificationScope, notifyWatchOnly];
  };
  let coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  try {
    coordinator.changeSettings({ notificationScope: "advisories", notifyWatchOnly: true });
  } finally {
    await coordinator.close();
  }
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  try {
    assert.deepEqual(
      notify(coordinator),
      ["advisories", true],
      "A saved choice is not reset to the defaults",
    );
  } finally {
    await coordinator.close();
  }
  // Settings saved by a build without these two fields.
  const storage = new MonitoringStorage(dataDir);
  try {
    const stored = storage.read();
    delete stored.snapshot.settings.notificationScope;
    delete stored.snapshot.settings.notifyWatchOnly;
    storage.write(stored);
  } finally {
    storage.close();
  }
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  t.after(() => coordinator.close());
  assert.deepEqual(notify(coordinator), ["all", false]);
  const { settings } = JSON.parse(coordinator.snapshotJson());
  assert.deepEqual([settings.notificationScope, settings.notifyWatchOnly], ["all", false]);
});

// Zones are process-wide, so each test names its own, and the host's is put back afterwards however
// many zones the test visits. The host's is assigned back by name: deleting TZ would leave the last
// zone in effect. Only canonical IANA names work (Asia/Kolkata resolves as Asia/Calcutta).
const hostZone = process.env.TZ ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
function inZone(t, zone) {
  process.env.TZ = zone;
  assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, zone, `${zone} is in effect`);
  t.after(() => {
    process.env.TZ = hostZone;
  });
}
const NEW_YORK = "America/New_York";
const LONDON = "Europe/London";
const SYDNEY = "Australia/Sydney";
const SAO_PAULO = "America/Sao_Paulo";
const APIA = "Pacific/Apia";
const KIRITIMATI = "Pacific/Kiritimati";
const PAGO_PAGO = "Pacific/Pago_Pago";
const quietIn = (t, zone, [start, end], instant) => {
  inZone(t, zone);
  return inQuietHours({ start, end }, new Date(instant));
};
const latestIn = (t, zone, time, now) => {
  inZone(t, zone);
  return latestDailyTime(time, new Date(now)).toISOString();
};

test("quiet hours use local wall-clock time across midnight and daylight-saving changes", (t) => {
  inZone(t, NEW_YORK);
  const night = { start: "22:00", end: "07:00" };
  assert.equal(inQuietHours(night, new Date("2026-10-09T02:30:00Z")), true, "22:30 EDT");
  assert.equal(inQuietHours(night, new Date("2026-10-09T10:59:00Z")), true, "06:59 EDT");
  assert.equal(inQuietHours(night, new Date("2026-10-09T11:00:00Z")), false, "07:00 EDT ends it");
  assert.equal(
    inQuietHours({ start: "09:00", end: "17:00" }, new Date("2026-10-09T16:59:00Z")),
    true,
    "12:59 EDT",
  );
  assert.equal(
    inQuietHours({ start: "09:00", end: "09:00" }, new Date("2026-10-09T13:00:00Z")),
    false,
  );
  assert.equal(inQuietHours(null, new Date("2026-10-09T02:30:00Z")), false);
  // Spring forward, 2026-03-08: 02:00-02:59 does not exist that night.
  assert.equal(
    inQuietHours({ start: "02:00", end: "02:30" }, new Date("2026-03-08T07:15:00Z")),
    false,
    "03:15 EDT",
  );
  assert.equal(
    inQuietHours({ start: "01:00", end: "04:00" }, new Date("2026-03-08T07:15:00Z")),
    true,
    "03:15 EDT",
  );
  // Fall back, 2026-11-01: 01:30 happens twice and is quiet both times.
  const repeated = { start: "01:00", end: "02:00" };
  assert.equal(inQuietHours(repeated, new Date("2026-11-01T05:30:00Z")), true, "01:30 EDT");
  assert.equal(inQuietHours(repeated, new Date("2026-11-01T06:30:00Z")), true, "01:30 EST");
});

test("the latest daily digest time is today's once it has passed, once per day across daylight-saving changes", (t) => {
  inZone(t, NEW_YORK);
  assert.equal(
    latestDailyTime("18:00", new Date("2026-10-08T21:59:00Z")).toISOString(),
    "2026-10-07T22:00:00.000Z",
  );
  assert.equal(
    latestDailyTime("18:00", new Date("2026-10-08T22:00:00Z")).toISOString(),
    "2026-10-08T22:00:00.000Z",
  );
  // Spring forward: 02:30 does not exist on 2026-03-08 and falls at 03:30 EDT.
  assert.equal(
    latestDailyTime("02:30", new Date("2026-03-08T07:40:00Z")).toISOString(),
    "2026-03-08T07:30:00.000Z",
  );
  assert.equal(
    latestDailyTime("02:30", new Date("2026-03-08T07:20:00Z")).toISOString(),
    "2026-03-07T07:30:00.000Z",
  );
  // Fall back: 01:30 occurs twice on 2026-11-01; the first counts, so there is one digest that day.
  assert.equal(
    latestDailyTime("01:30", new Date("2026-11-01T06:45:00Z")).toISOString(),
    "2026-11-01T05:30:00.000Z",
  );
  inZone(t, LONDON);
  // 2026-10-25 08:30 GMT, before 09:00: the latest digest was 09:00 BST the day before.
  assert.equal(
    latestDailyTime("09:00", new Date("2026-10-25T08:30:00Z")).toISOString(),
    "2026-10-24T08:00:00.000Z",
  );
});

test("quiet hours include their start, exclude their end, cross midnight, and equal ends are no window", (t) => {
  inZone(t, "Asia/Kabul"); // UTC+04:30, so neither the hour nor the minute matches UTC.
  const at = (time) => new Date(`2026-10-09T${time}+04:30`);
  for (const [start, end, time, expected] of [
    // Across midnight.
    ["22:00", "07:00", "21:59:59", false],
    ["22:00", "07:00", "22:00:00", true],
    ["22:00", "07:00", "23:59:59", true],
    ["22:00", "07:00", "00:00:00", true],
    ["22:00", "07:00", "06:59:59", true],
    ["22:00", "07:00", "07:00:00", false],
    ["22:00", "07:00", "12:00:00", false],
    // Within one day, to the minute.
    ["09:30", "17:45", "09:29:59", false],
    ["09:30", "17:45", "09:30:00", true],
    ["09:30", "17:45", "17:44:59", true],
    ["09:30", "17:45", "17:45:00", false],
    ["09:30", "17:45", "00:00:00", false],
    // Ending or starting at midnight.
    ["18:00", "00:00", "23:59:59", true],
    ["18:00", "00:00", "00:00:00", false],
    ["00:00", "06:00", "00:00:00", true],
    ["00:00", "06:00", "05:59:59", true],
    ["00:00", "06:00", "06:00:00", false],
    // Equal ends are no window at all, at any time of day.
    ["00:00", "00:00", "00:00:00", false],
    ["09:00", "09:00", "09:00:00", false],
    ["09:00", "09:00", "12:00:00", false],
    ["23:59", "23:59", "23:59:30", false],
  ])
    assert.equal(inQuietHours({ start, end }, at(time)), expected, `${start}-${end} at ${time}`);
  assert.equal(inQuietHours(null, at("23:00:00")), false);
  assert.equal(inQuietHours(undefined, at("23:00:00")), false);
});

test("quiet hours follow the wall clock through skipped and repeated hours in London and Sydney", (t) => {
  for (const [zone, quiet, instant, expected, reading] of [
    // London, 2026-03-29: 01:00 GMT jumps to 02:00 BST, so 01:00-01:59 never happens.
    [LONDON, ["23:00", "03:00"], "2026-03-29T00:59:00Z", true, "00:59 GMT"],
    [LONDON, ["23:00", "03:00"], "2026-03-29T01:00:00Z", true, "02:00 BST"],
    [LONDON, ["23:00", "03:00"], "2026-03-29T01:59:00Z", true, "02:59 BST"],
    [LONDON, ["23:00", "03:00"], "2026-03-29T02:00:00Z", false, "03:00 BST ends it"],
    // A window inside the skipped hour never holds; one starting in it starts as the clock resumes.
    [LONDON, ["01:00", "01:30"], "2026-03-29T01:00:00Z", false, "02:00 BST"],
    [LONDON, ["01:30", "03:00"], "2026-03-29T00:59:00Z", false, "00:59 GMT"],
    [LONDON, ["01:30", "03:00"], "2026-03-29T01:00:00Z", true, "02:00 BST"],
    // London, 2026-10-25: 02:00 BST falls back to 01:00 GMT, so 01:00-01:59 happens twice.
    [LONDON, ["01:00", "02:00"], "2026-10-24T23:59:00Z", false, "00:59 BST"],
    [LONDON, ["01:00", "02:00"], "2026-10-25T00:30:00Z", true, "01:30 BST"],
    [LONDON, ["01:00", "02:00"], "2026-10-25T01:30:00Z", true, "01:30 GMT"],
    [LONDON, ["01:00", "02:00"], "2026-10-25T02:00:00Z", false, "02:00 GMT"],
    // Sydney, 2026-10-04: 02:00 AEST jumps to 03:00 AEDT.
    [SYDNEY, ["01:00", "04:00"], "2026-10-03T16:10:00Z", true, "03:10 AEDT"],
    [SYDNEY, ["02:00", "02:30"], "2026-10-03T16:10:00Z", false, "03:10 AEDT"],
    [SYDNEY, ["02:30", "03:30"], "2026-10-03T15:59:00Z", false, "01:59 AEST"],
    [SYDNEY, ["02:30", "03:30"], "2026-10-03T16:00:00Z", true, "03:00 AEDT"],
    [SYDNEY, ["02:30", "03:30"], "2026-10-03T16:30:00Z", false, "03:30 AEDT"],
    // Sydney, 2026-04-05: 03:00 AEDT falls back to 02:00 AEST, so 02:00-02:59 happens twice.
    [SYDNEY, ["02:00", "03:00"], "2026-04-04T14:59:00Z", false, "01:59 AEDT"],
    [SYDNEY, ["02:00", "03:00"], "2026-04-04T15:30:00Z", true, "02:30 AEDT"],
    [SYDNEY, ["02:00", "03:00"], "2026-04-04T16:30:00Z", true, "02:30 AEST"],
    [SYDNEY, ["02:00", "03:00"], "2026-04-04T17:00:00Z", false, "03:00 AEST"],
  ])
    assert.equal(quietIn(t, zone, quiet, instant), expected, `${zone} ${quiet} at ${reading}`);
});

test("a digest time the clock skips falls after the change, and a repeated one counts once", (t) => {
  for (const [zone, time, now, expected, reading] of [
    // London, 2026-03-29: 01:30 does not exist and falls at 02:30 BST.
    [LONDON, "01:30", "2026-03-29T01:40:00Z", "2026-03-29T01:30:00.000Z", "02:40 BST"],
    [LONDON, "01:30", "2026-03-29T01:20:00Z", "2026-03-28T01:30:00.000Z", "02:20 BST, not yet"],
    // London, 2026-10-25: 01:30 happens as 01:30 BST and again as 01:30 GMT; the first counts.
    [LONDON, "01:30", "2026-10-25T00:15:00Z", "2026-10-24T00:30:00.000Z", "01:15 BST, not yet"],
    [LONDON, "01:30", "2026-10-25T00:45:00Z", "2026-10-25T00:30:00.000Z", "01:45 BST"],
    [LONDON, "01:30", "2026-10-25T01:15:00Z", "2026-10-25T00:30:00.000Z", "01:15 GMT"],
    [LONDON, "01:30", "2026-10-25T01:45:00Z", "2026-10-25T00:30:00.000Z", "01:45 GMT"],
    [LONDON, "01:30", "2026-10-26T01:30:00Z", "2026-10-26T01:30:00.000Z", "the next day"],
    // Sydney, 2026-10-04: 02:30 does not exist and falls at 03:30 AEDT.
    [SYDNEY, "02:30", "2026-10-03T16:40:00Z", "2026-10-03T16:30:00.000Z", "03:40 AEDT"],
    [SYDNEY, "02:30", "2026-10-03T16:20:00Z", "2026-10-02T16:30:00.000Z", "03:20 AEDT, not yet"],
    // Sydney, 2026-04-05: 02:30 happens as 02:30 AEDT and again as 02:30 AEST; the first counts.
    [SYDNEY, "02:30", "2026-04-04T15:20:00Z", "2026-04-03T15:30:00.000Z", "02:20 AEDT, not yet"],
    [SYDNEY, "02:30", "2026-04-04T16:45:00Z", "2026-04-04T15:30:00.000Z", "02:45 AEST"],
    // Sao Paulo, 2018-11-04: 00:00 jumped to 01:00, so 00:30 does not exist and falls at 01:30.
    [SAO_PAULO, "00:30", "2018-11-04T03:40:00Z", "2018-11-04T03:30:00.000Z", "01:40 -02"],
    [SAO_PAULO, "00:30", "2018-11-04T03:10:00Z", "2018-11-03T03:30:00.000Z", "01:10 -02, not yet"],
    // Sao Paulo, 2019-02-17: 00:00 fell back to 23:00 on the 16th, so 23:30 happens twice that day.
    [SAO_PAULO, "23:30", "2019-02-17T01:00:00Z", "2019-02-16T01:30:00.000Z", "23:00 -02, not yet"],
    [SAO_PAULO, "23:30", "2019-02-17T02:45:00Z", "2019-02-17T01:30:00.000Z", "23:45 -03"],
    // Samoa skipped 2011-12-30 altogether, so on the 31st the latest 09:00 is the 29th's.
    [APIA, "09:00", "2011-12-30T10:30:00Z", "2011-12-29T19:00:00.000Z", "00:30 on the 31st"],
  ])
    assert.equal(latestIn(t, zone, time, now), expected, `${zone} ${time} at ${now}: ${reading}`);
});

test("a digest keeps its wall-clock time across daylight-saving changes and uses the local date", (t) => {
  for (const [zone, time, now, expected, reading] of [
    // New York: yesterday's 18:00 was EST (23:00Z) before a 23-hour day, and EDT after it.
    [NEW_YORK, "18:00", "2026-03-08T21:59:00Z", "2026-03-07T23:00:00.000Z", "17:59 EDT"],
    [NEW_YORK, "18:00", "2026-03-09T21:59:00Z", "2026-03-08T22:00:00.000Z", "17:59 EDT"],
    // New York: yesterday's 18:00 was EDT (22:00Z) before a 25-hour day, and EST after it.
    [NEW_YORK, "18:00", "2026-11-01T22:59:00Z", "2026-10-31T22:00:00.000Z", "17:59 EST"],
    [NEW_YORK, "18:00", "2026-11-02T22:59:00Z", "2026-11-01T23:00:00.000Z", "17:59 EST"],
    // The local date is not UTC's: a day ahead in Kiritimati, a day behind in Pago Pago.
    [KIRITIMATI, "09:00", "2026-10-08T20:00:00Z", "2026-10-08T19:00:00.000Z", "10:00 on the 9th"],
    [KIRITIMATI, "09:00", "2026-10-08T18:59:00Z", "2026-10-07T19:00:00.000Z", "08:59 on the 9th"],
    [PAGO_PAGO, "20:00", "2026-10-09T05:00:00Z", "2026-10-08T07:00:00.000Z", "18:00 on the 8th"],
    [PAGO_PAGO, "20:00", "2026-10-09T07:00:00Z", "2026-10-09T07:00:00.000Z", "20:00 on the 8th"],
  ])
    assert.equal(latestIn(t, zone, time, now), expected, `${zone} ${time} at ${now}: ${reading}`);
});

test("a digest time on a leap day, in a century year that is not one, and over a year end", (t) => {
  for (const [zone, time, now, expected, reading] of [
    ["UTC", "09:00", "2028-03-01T08:59:00Z", "2028-02-29T09:00:00.000Z", "after the leap day"],
    ["UTC", "09:00", "2028-02-29T08:59:00Z", "2028-02-28T09:00:00.000Z", "on the leap day"],
    ["UTC", "09:00", "2028-02-29T09:00:00Z", "2028-02-29T09:00:00.000Z", "exactly at 09:00"],
    ["UTC", "23:59", "2028-03-01T00:00:00Z", "2028-02-29T23:59:00.000Z", "its last minute"],
    ["UTC", "09:00", "2026-03-01T08:59:00Z", "2026-02-28T09:00:00.000Z", "2026: no leap day"],
    ["UTC", "09:00", "2100-03-01T08:59:00Z", "2100-02-28T09:00:00.000Z", "2100: not a leap year"],
    ["UTC", "09:00", "2000-03-01T08:59:00Z", "2000-02-29T09:00:00.000Z", "2000: a leap year"],
    ["UTC", "23:00", "2027-01-01T00:30:00Z", "2026-12-31T23:00:00.000Z", "over the year end"],
    [NEW_YORK, "09:00", "2028-03-01T13:59:00Z", "2028-02-29T14:00:00.000Z", "08:59 EST on 1 March"],
  ])
    assert.equal(latestIn(t, zone, time, now), expected, `${zone} ${time} at ${now}: ${reading}`);
  // A quiet window that spans the leap midnight holds on both sides of it.
  const night = ["22:00", "07:00"];
  assert.equal(quietIn(t, NEW_YORK, night, "2028-03-01T04:30:00Z"), true, "23:30 EST on the 29th");
  assert.equal(quietIn(t, NEW_YORK, night, "2028-03-01T11:59:00Z"), true, "06:59 EST on 1 March");
  assert.equal(quietIn(t, NEW_YORK, night, "2028-03-01T12:00:00Z"), false, "07:00 EST on 1 March");
});

// What the wall clock reads in a zone, taken from Intl for that zone and not from the Date methods
// under test.
function wallClock(zone) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (instant) => {
    const part = Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, p.value]));
    return {
      date: `${part.year}-${part.month}-${part.day}`,
      minute: Number(part.hour) * 60 + Number(part.minute),
    };
  };
}
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// A skipped hour and a repeated hour in three zones, a skipped midnight, and a repeated 23:00.
const changes = [
  [NEW_YORK, "2026-03-08T07:00:00Z"],
  [NEW_YORK, "2026-11-01T06:00:00Z"],
  [LONDON, "2026-03-29T01:00:00Z"],
  [LONDON, "2026-10-25T01:00:00Z"],
  [SYDNEY, "2026-10-03T16:00:00Z"],
  [SYDNEY, "2026-04-04T16:00:00Z"],
  [SAO_PAULO, "2018-11-04T03:00:00Z"],
  [SAO_PAULO, "2019-02-17T02:00:00Z"],
].map(([zone, instant]) => [zone, Date.parse(instant)]);

test("around every daylight-saving change there is one digest per local day, none ahead of the clock", (t) => {
  for (const [zone, change] of changes) {
    inZone(t, zone);
    const clock = wallClock(zone);
    const date = (instant) => clock(new Date(instant)).date;
    for (const time of ["00:30", "01:30", "02:30", "09:00", "23:30"]) {
      const digests = [];
      for (let now = change - 3 * DAY; now <= change + 3 * DAY; now += 10 * MINUTE) {
        const digest = latestDailyTime(time, new Date(now)).getTime();
        assert.ok(
          digest <= now,
          `${zone} ${time} at ${new Date(now).toISOString()}: the digest is not ahead of the clock`,
        );
        if (digest !== digests.at(-1)) digests.push(digest);
      }
      assert.ok(digests.length >= 6, `${zone} ${time}: a week of digests`);
      digests.slice(1).forEach((digest, i) => {
        const before = digests[i];
        assert.equal(
          (Date.parse(date(digest)) - Date.parse(date(before))) / DAY,
          1,
          `${zone} ${time}: ${new Date(before).toISOString()} then ${new Date(digest).toISOString()} are on consecutive local days`,
        );
      });
    }
  }
});

test("around every daylight-saving change quiet hours follow the wall clock", (t) => {
  for (const [zone, change] of changes) {
    inZone(t, zone);
    const clock = wallClock(zone);
    for (const [start, end] of [
      ["22:00", "07:00"],
      ["00:00", "06:00"],
      ["00:30", "01:30"],
      ["01:30", "02:30"],
      ["02:30", "03:30"],
      ["23:00", "03:00"],
    ]) {
      const [from, to] = [start, end].map(
        (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3)),
      );
      for (let now = change - DAY; now <= change + DAY; now += 5 * MINUTE) {
        const { minute } = clock(new Date(now));
        assert.equal(
          inQuietHours({ start, end }, new Date(now)),
          from < to ? minute >= from && minute < to : minute >= from || minute < to,
          `${zone} ${start}-${end} at ${new Date(now).toISOString()}`,
        );
      }
    }
  }
});

test("a daily digest waits for its local time, quiet hours mark only native delivery, and both use the injected clock", async (t) => {
  inZone(t, "UTC");
  const root = await temporary();
  let candidate = "1.5.0";
  let clock = Date.parse("2026-10-08T17:00:00.000Z");
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => withUpdate(candidate)(dependencies),
    now: () => clock,
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true, digestAt: "18:00" });
  const project = await coordinator.addProject({
    path: await aliasFixture(join(root, "project")),
    mode: "maintained",
  });
  await finishScan(coordinator, project.id);
  clock += 2_000;
  assert.equal(coordinator.snapshot().notificationSummary, null, "Before 18:00 the digest waits");
  clock = Date.parse("2026-10-08T18:00:00.000Z");
  const digest = coordinator.snapshot().notificationSummary;
  assert.equal(digest.newUpdateCount, 1);
  assert.equal(digest.quiet, false);
  coordinator.acknowledgeNotificationSummary(digest.id);
  assert.equal(
    coordinator.snapshot().notificationNextAt,
    "2026-10-08T18:05:00.000Z",
    "The cooldown follows the injected clock",
  );
  clock = Date.parse("2026-10-08T19:00:00.000Z");
  candidate = "1.6.0";
  await finishScan(coordinator, project.id);
  clock = Date.parse("2026-10-08T23:00:00.000Z");
  assert.equal(
    coordinator.snapshot().notificationSummary,
    null,
    "Found after today's digest, it waits for tomorrow's",
  );
  clock = Date.parse("2026-10-09T18:00:00.000Z");
  assert.equal(
    coordinator.snapshot().notificationSummary.newUpdateCount,
    1,
    "A missed digest time is delivered later",
  );
  coordinator.changeSettings({ digestAt: null, quietHours: { start: "22:00", end: "07:00" } });
  clock = Date.parse("2026-10-09T23:30:00.000Z");
  assert.equal(
    coordinator.snapshot().notificationSummary.quiet,
    true,
    "Quiet hours hold native delivery",
  );
  clock = Date.parse("2026-10-10T07:00:00.000Z");
  assert.equal(coordinator.snapshot().notificationSummary.quiet, false);
  assert.throws(
    () => coordinator.changeSettings({ quietHours: { start: "09:00", end: "09:00" } }),
    /different start and end/,
  );
  assert.throws(() => coordinator.changeSettings({ digestAt: "25:00" }), /HH:MM/);
});

test("a digest combines everything new since the previous one by the local clock, and quiet hours follow it too", async (t) => {
  inZone(t, "Asia/Kabul"); // UTC+04:30, so 18:00 here is 13:30 UTC and a UTC reading would differ.
  const root = await temporary();
  let candidate = "1.5.0";
  let clock = Date.parse("2026-10-08T04:30:00.000Z"); // 09:00
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => withUpdate(candidate)(dependencies),
    now: () => clock,
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true, digestAt: "18:00" });
  const projects = [];
  for (const name of ["first", "second", "third"])
    projects.push(
      await coordinator.addProject({
        path: await aliasFixture(join(root, name)),
        mode: "maintained",
      }),
    );
  const [first, second, third] = projects;
  await finishScan(coordinator, first.id); // 09:00
  clock = Date.parse("2026-10-08T13:29:59.999Z"); // 17:59:59.999
  assert.equal(coordinator.snapshot().notificationSummary, null, "Nothing before 18:00 local");
  clock += 1; // 18:00:00.000, the digest time itself
  // The scan starts before anything reads the summary: the first finding's digest is due now, and a
  // read would freeze a summary of that one alone.
  coordinator.requestScan({ target: "projects", projectId: second.id });
  await waitFor(() => {
    const latest = coordinator.snapshot().history[0];
    return latest.targetId === second.id && latest.status !== "scanning";
  });
  clock += 2_000;
  const digest = coordinator.snapshot().notificationSummary;
  assert.deepEqual(
    [digest.newUpdateCount, digest.projectCount, digest.updateCount],
    [2, 2, 2],
    "One summary combines both, the finding made at 18:00:00.000 included",
  );
  coordinator.acknowledgeNotificationSummary(digest.id);
  assert.deepEqual(
    [...new Set(coordinator.snapshot().notifications.map((n) => n.deliveredAt))],
    [new Date(clock).toISOString()],
    "Delivery is stamped by the injected clock",
  );
  clock = Date.parse("2026-10-08T14:00:00.000Z"); // 18:30, after the digest
  await finishScan(coordinator, third.id);
  clock = Date.parse("2026-10-09T13:29:59.999Z"); // 17:59:59.999 the next day
  assert.equal(coordinator.snapshot().notificationSummary, null, "It waits for the next digest");
  // The next digest falls inside quiet hours: it is presented, but native delivery waits.
  coordinator.changeSettings({ quietHours: { start: "18:00", end: "19:00" } });
  assert.equal(coordinator.snapshot().notificationSummary, null, "Still before the digest");
  clock += 1; // 18:00:00.000
  const next = coordinator.snapshot().notificationSummary;
  assert.deepEqual([next.newUpdateCount, next.updateCount, next.projectCount], [1, 3, 3]);
  assert.equal(next.quiet, true, "Quiet hours start at 18:00 local, not 18:00 UTC");
  const held = () => {
    const { quiet, id } = coordinator.snapshot().notificationSummary;
    return [quiet, id];
  };
  clock = Date.parse("2026-10-09T14:29:59.999Z"); // 18:59:59.999
  assert.deepEqual(held(), [true, next.id], "The same summary stays held until the window ends");
  clock += 1; // 19:00:00.000
  assert.deepEqual(held(), [false, next.id]);
  // Back to "after each scan cycle": a new finding then waits only for the five-minute cooldown.
  coordinator.acknowledgeNotificationSummary(next.id); // the cooldown ends at 19:05
  candidate = "1.6.0";
  clock = Date.parse("2026-10-09T14:31:00.000Z"); // 19:01
  await finishScan(coordinator, third.id);
  coordinator.changeSettings({ digestAt: null });
  clock = Date.parse("2026-10-09T14:34:59.999Z"); // 19:04:59.999
  assert.equal(coordinator.snapshot().notificationSummary, null, "The cooldown holds it");
  clock += 1; // 19:05:00.000
  const cycle = coordinator.snapshot().notificationSummary;
  assert.deepEqual([cycle.newUpdateCount, cycle.quiet], [1, false]);
});

test("the digest and quiet hours survive a restart, and a digest missed while the coordinator was off arrives when it runs again", async (t) => {
  inZone(t, "UTC");
  const root = await temporary();
  const dataDir = join(root, "state");
  let clock = Date.parse("2026-10-08T17:00:00.000Z");
  const options = { dataDir, dependencyLookup: withUpdate("1.5.0"), now: () => clock };
  const timing = (coordinator) => {
    const { quietHours, digestAt } = coordinator.snapshot().settings;
    return [quietHours, digestAt];
  };
  let coordinator = new MonitoringCoordinator(options);
  try {
    assert.deepEqual(timing(coordinator), [null, null], "Neither is set until the owner sets it");
    coordinator.changeSettings({
      paused: true,
      digestAt: "18:00",
      quietHours: { start: "22:00", end: "07:00" },
    });
    const project = await coordinator.addProject({
      path: await aliasFixture(join(root, "project")),
      mode: "maintained",
    });
    await finishScan(coordinator, project.id);
  } finally {
    await coordinator.close();
  }
  // Off through the 18:00 digest, back at 20:00 the next day.
  clock = Date.parse("2026-10-09T20:00:00.000Z");
  coordinator = new MonitoringCoordinator(options);
  try {
    assert.deepEqual(
      timing(coordinator),
      [{ start: "22:00", end: "07:00" }, "18:00"],
      "A saved choice is not reset to the defaults",
    );
    assert.equal(coordinator.snapshot().notificationSummary, null, "Not within the settle window");
    clock += 2_000;
    const wire = () => JSON.parse(coordinator.snapshotJson()).notificationSummary;
    assert.equal(coordinator.snapshot().notificationSummary.newUpdateCount, 1);
    assert.equal(wire().quiet, false);
    clock = Date.parse("2026-10-09T22:00:00.000Z");
    // The tray reads the validated progress and the owner's app the validated snapshot.
    assert.equal(coordinator.progressSnapshot().notificationSummary.quiet, true);
    assert.equal(wire().quiet, true);
  } finally {
    await coordinator.close();
  }
  // Settings saved by a build without these two fields.
  const storage = new MonitoringStorage(dataDir);
  try {
    const stored = storage.read();
    delete stored.snapshot.settings.quietHours;
    delete stored.snapshot.settings.digestAt;
    storage.write(stored);
  } finally {
    storage.close();
  }
  coordinator = new MonitoringCoordinator(options);
  t.after(() => coordinator.close());
  assert.deepEqual(timing(coordinator), [null, null]);
  const { settings } = JSON.parse(coordinator.snapshotJson());
  assert.deepEqual([settings.quietHours, settings.digestAt], [null, null]);
});

test("quiet hours and the digest time must be HH:MM, and a rejected change changes nothing", async (t) => {
  const root = await temporary();
  const coordinator = new MonitoringCoordinator({ dataDir: join(root, "state"), lookup: false });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ quietHours: { start: "22:00", end: "07:00" }, digestAt: "18:00" });
  const settings = () => JSON.stringify(coordinator.snapshot().settings);
  const before = settings();
  for (const quietHours of [
    { start: "09:00", end: "09:00" },
    { start: "7:00", end: "22:00" },
    { start: "22:00", end: "24:00" },
    { start: "22:00", end: "07:60" },
    { start: "22:00", end: "07:00:00" },
    { start: " 22:00", end: "07:00" },
    { start: "22:00", end: "07:00\n" },
    { start: "22:00" },
    { start: 2200, end: 700 },
    { start: ["22:00"], end: "07:00" },
    {},
    [],
    "22:00-07:00",
    7,
    true,
  ])
    assert.throws(
      () => coordinator.changeSettings({ paused: true, quietHours }),
      /Quiet hours need different start and end times \(HH:MM\)/,
      JSON.stringify(quietHours),
    );
  for (const digestAt of [
    "24:00",
    "18:60",
    "6pm",
    "18:00:00",
    "",
    " 18:00",
    "18:00\n",
    1800,
    ["18:00"],
    true,
    {},
  ])
    assert.throws(
      () => coordinator.changeSettings({ paused: true, digestAt }),
      /The digest time must be HH:MM/,
      JSON.stringify(digestAt),
    );
  assert.equal(settings(), before, "A rejected change is not partly applied");
  coordinator.changeSettings({ quietHours: { start: "00:00", end: "23:59" } });
  coordinator.changeSettings({ digestAt: "00:00" });
  assert.deepEqual(
    [coordinator.snapshot().settings.quietHours, coordinator.snapshot().settings.digestAt],
    [{ start: "00:00", end: "23:59" }, "00:00"],
    "Each change names only what it changes",
  );
  // The coordinator keeps its own copy of the window, and only its two times.
  const given = { start: "01:00", end: "02:00", extra: true };
  coordinator.changeSettings({ quietHours: given });
  given.start = "23:00";
  given.end = "23:30";
  assert.deepEqual(coordinator.snapshot().settings.quietHours, { start: "01:00", end: "02:00" });
  coordinator.changeSettings({ quietHours: null });
  coordinator.changeSettings({ digestAt: null });
  assert.deepEqual(
    [coordinator.snapshot().settings.quietHours, coordinator.snapshot().settings.digestAt],
    [null, null],
  );
});

test("the contract takes the digest time and quiet hours only as HH:MM, and a summary may carry the quiet flag", () => {
  const change = Schema.decodeUnknownSync(ChangeSettings);
  // The saved settings follow the same format, and settings saved before these fields still read.
  const stored = Schema.decodeUnknownSync(MonitoringSettings);
  const settings = {
    paused: false,
    pcIntervalMinutes: 360,
    projectIntervalMinutes: 60,
    notifyNewFindings: true,
  };
  assert.equal(stored(settings).digestAt, undefined);
  for (const time of ["00:00", "09:05", "19:59", "23:59"]) {
    const quietHours = { start: time, end: "12:00" };
    assert.equal(change({ digestAt: time }).digestAt, time);
    assert.deepEqual(change({ quietHours }).quietHours, quietHours);
    assert.equal(stored({ ...settings, digestAt: time }).digestAt, time);
    assert.deepEqual(stored({ ...settings, quietHours }).quietHours, quietHours);
  }
  assert.equal(change({ digestAt: null }).digestAt, null);
  assert.equal(change({ quietHours: null }).quietHours, null);
  for (const time of [
    "24:00",
    "18:60",
    "7:00",
    "07:5",
    "1800",
    "18:00:00",
    " 18:00",
    "18:00\n",
    "",
    1800,
    true,
    ["18:00"],
    {},
  ])
    for (const input of [
      { digestAt: time },
      { quietHours: { start: time, end: "12:00" } },
      { quietHours: { start: "12:00", end: time } },
    ]) {
      assert.throws(() => change(input), undefined, JSON.stringify(input));
      assert.throws(() => stored({ ...settings, ...input }), undefined, JSON.stringify(input));
    }
  for (const quietHours of [{ start: "22:00" }, { end: "07:00" }, "22:00-07:00", 7, []])
    assert.throws(() => change({ quietHours }), undefined, JSON.stringify(quietHours));
  const summary = {
    id: "summary",
    updateCount: 1,
    newUpdateCount: 1,
    projectCount: 1,
    pcCount: 0,
    advisoryCount: 0,
    newAdvisoryCount: 0,
    title: "1 update available",
    body: "1 newly detected update.",
    filter: "updates",
  };
  const read = Schema.decodeUnknownSync(NotificationSummary);
  assert.equal(read(summary).quiet, undefined, "A summary from before the flag still reads");
  for (const quiet of [true, false]) assert.equal(read({ ...summary, quiet }).quiet, quiet);
  assert.throws(() => read({ ...summary, quiet: "yes" }));
});

test("findings made during quiet hours reach the in-app summary as they come, and the native summary carries them all", async (t) => {
  inZone(t, "UTC");
  const root = await temporary();
  let clock = Date.parse("2026-10-08T21:00:00.000Z");
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate("1.5.0"),
    now: () => clock,
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true, quietHours: { start: "22:00", end: "07:00" } });
  const projects = [];
  for (const name of ["a", "b", "c", "d", "e"])
    projects.push(
      await coordinator.addProject({
        path: await aliasFixture(join(root, name)),
        mode: "maintained",
      }),
    );
  const read = () => coordinator.progressSnapshot().notificationSummary;
  const found = async (index, at) => {
    clock = Date.parse(at);
    // Nothing reads the summary between the scan starting and the finding being made, so the first
    // read after a change of hours already sees the new finding.
    coordinator.requestScan({ target: "projects", projectId: projects[index].id });
    await waitFor(() => {
      const latest = coordinator.snapshot().history[0];
      return latest.targetId === projects[index].id && latest.status !== "scanning";
    });
    clock += 2_500; // past the settle window
    return read();
  };
  // The first one is read before the window starts, and nothing receives it: no desktop is running.
  const first = await found(0, "2026-10-08T21:30:00.000Z");
  const second = await found(1, "2026-10-08T22:30:00.000Z");
  const third = await found(2, "2026-10-09T01:00:00.000Z");
  assert.deepEqual([first.quiet, second.quiet, third.quiet], [false, true, true]);
  assert.deepEqual(
    [first.newUpdateCount, second.newUpdateCount, third.newUpdateCount],
    [1, 2, 3],
    "While quiet hours hold the native notification, each cycle shows what is new so far",
  );
  assert.equal(new Set([first.id, second.id, third.id]).size, 3, "The in-app toast sees each one");
  assert.equal(read().id, third.id, "A read with nothing new keeps the id");
  // Found in the last seconds of the window, with nothing reading before it ends.
  clock = Date.parse("2026-10-09T06:59:50.000Z");
  await finishScan(coordinator, projects[3].id);
  clock = Date.parse("2026-10-09T07:00:00.000Z");
  const morning = read();
  assert.deepEqual(
    [morning.quiet, morning.newUpdateCount],
    [false, 4],
    "One summary carries everything found overnight",
  );
  // From the first moment the native notification can be shown, the summary keeps its events.
  const later = await found(4, "2026-10-09T07:00:30.000Z");
  assert.deepEqual([later.id, later.newUpdateCount], [morning.id, 4], "A later finding waits");
  coordinator.acknowledgeNotificationSummary(morning.id);
  clock = Date.parse("2026-10-09T07:01:00.000Z");
  assert.equal(read(), null, "The shared five-minute cooldown");
  clock = Date.parse("2026-10-09T07:06:00.000Z");
  assert.deepEqual(
    [read().newUpdateCount, read().quiet],
    [1, false],
    "The receipt covered all four, so only the later one is left",
  );
});

test("an event whose creation time cannot be read is still presented", async (t) => {
  inZone(t, "UTC");
  const root = await temporary();
  const dataDir = join(root, "state");
  let clock = Date.parse("2026-10-08T17:00:00.000Z");
  const options = { dataDir, dependencyLookup: withUpdate("1.5.0"), now: () => clock };
  let coordinator = new MonitoringCoordinator(options);
  try {
    coordinator.changeSettings({ paused: true });
    const project = await coordinator.addProject({
      path: await aliasFixture(join(root, "project")),
      mode: "maintained",
    });
    await finishScan(coordinator, project.id);
  } finally {
    await coordinator.close();
  }
  const storage = new MonitoringStorage(dataDir);
  try {
    const stored = storage.read();
    for (const event of stored.snapshot.notifications) event.createdAt = "unreadable";
    storage.write(stored);
  } finally {
    storage.close();
  }
  coordinator = new MonitoringCoordinator(options);
  t.after(() => coordinator.close());
  clock += 2_000;
  assert.equal(
    coordinator.snapshot().notificationSummary?.newUpdateCount,
    1,
    "A damaged time does not keep a finding from ever being announced",
  );
  // A digest cannot place it before or after its time either, so it is not held for the next one.
  coordinator.changeSettings({ digestAt: "18:00" });
  assert.equal(coordinator.snapshot().notificationSummary?.newUpdateCount, 1);
});

test("an event hidden when its digest came is presented once it shows again, and a digest nobody received keeps its first set", async (t) => {
  inZone(t, "UTC");
  const root = await temporary();
  let clock = Date.parse("2026-10-08T17:00:00.000Z");
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate("1.5.0"),
    now: () => clock,
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true, digestAt: "18:00" });
  const projects = [];
  for (const name of ["a", "b"])
    projects.push(
      await coordinator.addProject({
        path: await aliasFixture(join(root, name)),
        mode: "maintained",
      }),
    );
  const [a, b] = projects;
  await finishScan(coordinator, a.id); // 17:00
  const rule = coordinator.addFindingRule({
    findingId: coordinator
      .snapshot()
      .findings.find((f) => f.subjectId === a.id && f.kind === "update").id,
    mode: "snooze",
    days: 7,
  });
  clock = Date.parse("2026-10-08T18:30:00.000Z");
  assert.equal(coordinator.snapshot().notificationSummary, null, "Hidden when its digest came");
  clock = Date.parse("2026-10-08T20:00:00.000Z");
  coordinator.removeFindingRule(rule.id);
  const shown = coordinator.snapshot().notificationSummary;
  assert.equal(
    shown.newUpdateCount,
    1,
    "Presented as soon as it shows again, not at the next digest",
  );
  // Nobody receives that summary. A finding made afterwards waits for the next digest.
  await finishScan(coordinator, b.id); // 20:00
  clock = Date.parse("2026-10-09T18:00:00.000Z");
  const next = coordinator.snapshot().notificationSummary;
  assert.deepEqual(
    [next.id, next.newUpdateCount],
    [shown.id, 1],
    "A digest nobody received keeps its first set",
  );
  coordinator.acknowledgeNotificationSummary(shown.id);
  clock += 6 * 60_000;
  assert.equal(coordinator.snapshot().notificationSummary.newUpdateCount, 1);
});

test("the contract exports the one HH:MM check and the one list of Notify about choices", () => {
  assert.equal(typeof isHourMinute, "function");
  for (const time of ["00:00", "07:05", "19:59", "23:59"])
    assert.equal(isHourMinute(time), true, time);
  for (const time of [
    "24:00",
    "18:60",
    "7:00",
    "07:5",
    "1800",
    "18:00:00",
    " 18:00",
    "18:00\n",
    "",
    1800,
    null,
    undefined,
    true,
    ["18:00"],
    {},
  ])
    assert.equal(isHourMinute(time), false, JSON.stringify(time));
  assert.deepEqual([...notificationScopes], ["all", "advisories", "high-advisories"]);
});

test("a pending event that can never be summarized is not counted as waiting", async (t) => {
  const root = await temporary();
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate("1.5.0"),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true, notifyWatchOnly: true });
  const maintained = await coordinator.addProject({
    path: await aliasFixture(join(root, "maintained")),
    mode: "maintained",
  });
  const watched = await coordinator.addProject({
    path: await aliasFixture(join(root, "watched")),
    mode: "watch",
  });
  await finishScan(coordinator, maintained.id);
  await finishScan(coordinator, watched.id);
  const pending = () =>
    coordinator.snapshot().notifications.filter((n) => n.deliveredAt === null).length;
  // The wire form is what the Background service page reads.
  const waiting = () => JSON.parse(coordinator.snapshotJson()).notificationsWaiting;
  assert.deepEqual([pending(), waiting(), coordinator.snapshot().notificationsWaiting], [2, 2, 2]);
  coordinator.changeSettings({ notifyWatchOnly: false });
  assert.deepEqual(
    [pending(), waiting()],
    [2, 1],
    "a watch-only project's event waits outside any summary",
  );
  const update = coordinator
    .snapshot()
    .findings.find((f) => f.subjectId === maintained.id && f.kind === "update");
  const rule = coordinator.addFindingRule({ findingId: update.id, mode: "snooze", days: 7 });
  assert.deepEqual([pending(), waiting()], [2, 0], "so does a snoozed finding's");
  coordinator.removeFindingRule(rule.id);
  assert.equal(waiting(), 1);
  coordinator.changeSettings({ notifyWatchOnly: true });
  assert.equal(waiting(), 2);
  coordinator.changeSettings({ notifyNewFindings: false });
  assert.deepEqual(
    [pending(), waiting()],
    [2, 0],
    "with Notify about new findings off nothing waits",
  );
  coordinator.changeSettings({ notifyNewFindings: true });
  assert.equal(waiting(), 2);
  const shared = sharedEvidence(coordinator.snapshot(), "settings-repositories-connections-v10");
  assert.equal(
    "notificationsWaiting" in shared,
    false,
    "paired PCs get no waiting-notification count",
  );
});

// A summary that was read outside quiet hours and then replaced by a read inside them, before the
// desktop's receipt arrived. The desktop showed the first, so its receipt must still consume it.
async function quietWindow(t, names) {
  inZone(t, "UTC");
  const root = await temporary();
  const clock = { now: Date.parse("2026-10-08T21:00:00.000Z") };
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate("1.5.0"),
    now: () => clock.now,
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true, quietHours: { start: "22:00", end: "07:00" } });
  const projects = {};
  for (const name of names)
    projects[name] = await coordinator.addProject({
      path: await aliasFixture(join(root, name)),
      mode: "maintained",
    });
  return {
    coordinator,
    read: () => coordinator.progressSnapshot().notificationSummary,
    at: (time) => {
      clock.now = Date.parse(time);
    },
    scan: async (name, time) => {
      clock.now = Date.parse(time);
      await finishScan(coordinator, projects[name].id);
    },
    updateOf: (name) =>
      coordinator
        .snapshot()
        .findings.find((f) => f.subjectId === projects[name].id && f.kind === "update"),
  };
}

test("a receipt for a summary that quiet hours have since replaced still consumes what it covered", async (t) => {
  const { coordinator, read, scan, at } = await quietWindow(t, ["a", "b"]);
  await scan("a", "2026-10-08T21:59:00.000Z");
  at("2026-10-08T21:59:03.000Z");
  const offered = read();
  assert.deepEqual([offered.quiet, offered.newUpdateCount], [false, 1]);
  await scan("b", "2026-10-08T22:00:10.000Z");
  at("2026-10-08T22:00:13.000Z");
  const held = read();
  assert.deepEqual([held.quiet, held.newUpdateCount], [true, 2]);
  assert.notEqual(held.id, offered.id, "the id followed the larger set");
  coordinator.acknowledgeNotificationSummary(offered.id); // the desktop showed it; its receipt is late
  at("2026-10-09T07:00:00.000Z");
  const morning = read();
  assert.deepEqual(
    [morning.quiet, morning.newUpdateCount],
    [false, 1],
    "the shown event is delivered, so only the one found inside the window is left",
  );
  assert.throws(
    () => coordinator.acknowledgeNotificationSummary(offered.id),
    /no longer available/,
    "a second receipt for it is refused",
  );
});

test("after a late receipt, findings made later are still announced", async (t) => {
  const { coordinator, read, scan, at, updateOf } = await quietWindow(t, ["a", "b", "c"]);
  await scan("a", "2026-10-08T21:59:00.000Z");
  at("2026-10-08T21:59:03.000Z");
  const offered = read();
  await scan("b", "2026-10-08T22:00:10.000Z");
  at("2026-10-08T22:00:13.000Z");
  read();
  coordinator.acknowledgeNotificationSummary(offered.id);
  coordinator.addFindingRule({ findingId: updateOf("b").id, mode: "snooze", days: 7 });
  at("2026-10-09T07:00:00.000Z");
  assert.equal(read(), null, "nothing is left to announce");
  await scan("c", "2026-10-09T08:00:00.000Z");
  at("2026-10-09T08:00:03.000Z");
  const later = read();
  assert.ok(later, "a later finding is announced, not held behind a summary nothing can receipt");
  assert.equal(later.newUpdateCount, 1);
  assert.notEqual(later.id, offered.id);
});

test("narrowing Notify about leaves a pending event pending, outside the summary, and widening presents it", async (t) => {
  const { coordinator, read, scan, at } = await quietWindow(t, ["a"]);
  await scan("a", "2026-10-08T21:00:10.000Z");
  at("2026-10-08T21:00:15.000Z");
  coordinator.changeSettings({ notificationScope: "advisories" });
  assert.equal(read(), null, "an update is outside Notify about");
  assert.equal(
    coordinator.snapshot().notifications.filter((n) => n.deliveredAt === null).length,
    1,
  );
  coordinator.changeSettings({ notificationScope: "all" });
  assert.equal(read().newUpdateCount, 1, "widened, the same event is presented");
});
