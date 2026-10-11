import assert from "node:assert/strict";
import test from "node:test";
import type { GlobalToolUpdateBatch } from "@versionstead/contracts/global-tool-updates";
import type {
  Finding,
  FindingRule,
  Installation,
  MonitoringSnapshot,
} from "@versionstead/contracts/monitoring";
import {
  batchSummary,
  initialSelection,
  ipcMessage,
  updatableInstallations,
  updateAllEntries,
  updateAllGroups,
} from "./update-all.ts";

const now = Date.parse("2026-10-08T18:00:00.000Z");
// A snooze date is written in the viewer's time zone, so the expected label is too: the test holds in any zone.
const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const tool = (name: string, changes: Partial<Installation> = {}): Installation => ({
  id: `${name}-npm`,
  name,
  version: "1.0.0",
  source: "npm global",
  scope: "user",
  channel: "stable",
  packageId: name,
  manager: "npm",
  rootId: "b".repeat(32),
  origin: "registry",
  updateCheckedAt: "2026-10-08T17:00:00.000Z",
  availableVersion: "1.1.0",
  updateStatus: "available",
  ...changes,
});
const update = (installation: Installation, changes: Partial<Finding> = {}): Finding => ({
  id: `update-${installation.id}`,
  kind: "update",
  subjectId: "pc",
  subjectLabel: "PC",
  name: installation.name,
  packageName: installation.packageId ?? null,
  installedVersion: installation.version,
  availableVersion: installation.availableVersion,
  severity: "info",
  source: installation.source,
  description: "A newer stable release is available from the public npm registry.",
  advisoryUrl: null,
  detectedAt: "2026-10-08T17:00:00.000Z",
  lastSeenAt: "2026-10-08T17:00:00.000Z",
  publishedAt: "2026-09-01T00:00:00.000Z",
  ...changes,
});
const rule = (id: string, changes: Partial<FindingRule>): FindingRule => ({
  id,
  scope: { subjectId: "pc", kind: "update", packageName: "any" },
  mode: "ignore",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...changes,
});
const evidence = {
  status: "complete" as const,
  lastAttempt: "2026-10-08T17:00:00.000Z",
  lastSuccess: "2026-10-08T17:00:00.000Z",
  coverage: [],
  errors: [],
};
function snapshot(
  installations: Installation[],
  findings: Finding[],
  releaseCooldownDays?: number,
): Pick<MonitoringSnapshot, "device" | "findings" | "findingRules" | "inventory" | "settings"> {
  return {
    device: { id: "pc", label: "PC", platform: "win32" },
    settings: {
      paused: false,
      pcIntervalMinutes: 60,
      projectIntervalMinutes: 60,
      notifyNewFindings: true,
      ...(releaseCooldownDays === undefined ? {} : { releaseCooldownDays }),
    },
    inventory: { evidence, installations },
    findings,
  };
}

test("Update all lists every verified update, flags majors and warnings, and leaves too-new releases unticked", () => {
  const typescript = tool("typescript", { version: "5.9.2", availableVersion: "6.0.0" });
  const fresh = tool("fresh-cli");
  const quiet = tool("quiet-cli");
  const bare = tool("no-finding");
  const scripted = tool("scripted", {
    id: "scripted-bun",
    manager: "bun",
    source: "bun global",
    rootId: "c".repeat(32),
  });
  const installations = [
    typescript,
    fresh,
    quiet,
    bare,
    scripted,
    tool("current", { updateStatus: "current", availableVersion: null }),
    tool("linked", { origin: "local" }),
    tool("unverified", { updateStatus: "unknown" }),
    tool("rootless", { rootId: undefined }),
  ];
  const findings = [
    update(typescript),
    update(fresh, { publishedAt: "2026-10-08T12:00:00.000Z" }),
    update(quiet, { publishedAt: undefined }),
    update(scripted, { installScript: true, candidateDeprecated: "Use 2.0.0." }),
  ];
  const entries = updateAllEntries(snapshot(installations, findings), now);
  const entry = (name: string) => entries.find((candidate) => candidate.item.name === name)!;
  assert.deepEqual(
    entries.map((candidate) => candidate.item.name),
    ["fresh-cli", "no-finding", "quiet-cli", "scripted", "typescript"],
  );
  assert.equal(entry("typescript").kind, "major");
  assert.equal(entry("fresh-cli").kind, "minor");
  assert.deepEqual(
    entry("fresh-cli").warnings.map((warning) => warning.kind),
    ["too-new"],
  );
  assert.equal(entry("fresh-cli").tooNew, true);
  assert.equal(entry("quiet-cli").ageUnknown, true);
  assert.deepEqual(entry("quiet-cli").warnings, [], "An unknown age is listed, never a warning");
  assert.equal(entry("no-finding").ageUnknown, true, "No finding means no known release time");
  assert.deepEqual(
    entry("scripted").warnings.map((warning) => warning.kind),
    ["install-script", "deprecated-candidate"],
  );
  assert.equal(entry("scripted").tooNew, false);
  assert.deepEqual(
    entries.map((candidate) => candidate.held),
    [null, null, null, null, null],
    "Nothing the owner never held is labelled",
  );
  assert.deepEqual(
    [...initialSelection(entries)].sort(),
    ["no-finding-npm", "quiet-cli-npm", "scripted-bun", "typescript-npm"],
    "Every entry but the too-new release starts ticked",
  );
});

test("with the release cooldown off, nothing is too new or of unknown age", () => {
  const fresh = tool("fresh-cli");
  const [entry] = updateAllEntries(
    snapshot([fresh], [update(fresh, { publishedAt: undefined })], 0),
    now,
  );
  assert.deepEqual([entry!.tooNew, entry!.ageUnknown], [false, false]);
});

test("a snoozed or ignored update is listed with its rule and does not start ticked", () => {
  const pinned = tool("pinned-cli");
  const waiting = tool("waiting-cli");
  const napping = tool("napping-cli");
  const lost = tool("lost-cli");
  const open = tool("open-cli");
  const napUntil = "2026-10-20T12:00:00.000Z";
  const findingRules = [
    rule("rule-pinned", { mode: "ignore", reason: "Pinned on purpose" }),
    rule("rule-waiting", { mode: "snooze", untilVersion: "1.1.0" }),
    rule("rule-napping", { mode: "snooze", until: napUntil }),
  ];
  const findings = [
    update(pinned, { ruleId: "rule-pinned" }),
    update(waiting, { ruleId: "rule-waiting" }),
    update(napping, { ruleId: "rule-napping" }),
    update(lost, { ruleId: "rule-gone" }),
    update(open),
  ];
  const entries = updateAllEntries(
    { ...snapshot([pinned, waiting, napping, lost, open], findings), findingRules },
    now,
  );
  assert.deepEqual(
    entries.map((candidate) => [candidate.item.name, candidate.held]),
    [
      ["lost-cli", "Snoozed or ignored"],
      ["napping-cli", `Snoozed until ${shortDate.format(Date.parse(napUntil))}`],
      ["open-cli", null],
      ["pinned-cli", "Ignored: Pinned on purpose"],
      ["waiting-cli", "Snoozed until a version newer than 1.1.0"],
    ],
    "Held updates stay in the list, labelled by their rule; a rule that cannot be found still says so",
  );
  assert.deepEqual(
    [...initialSelection(entries)],
    ["open-cli-npm"],
    "Only the update the owner never held starts ticked",
  );
  assert.equal(
    updateAllEntries(snapshot([lost], [update(lost, { ruleId: "rule-gone" })]), now)[0]!.held,
    "Snoozed or ignored",
    "A snapshot without rules (an older coordinator) still marks the update as held",
  );
});

test("the confirmation lists each package under one heading: held by the owner, then too new, then of unknown age", () => {
  const ready = tool("ready-cli");
  const unknown = tool("unknown-cli");
  const fresh = tool("fresh-cli");
  const held = tool("held-cli");
  const heldAndFresh = tool("held-fresh-cli");
  const findings = [
    update(ready),
    update(unknown, { publishedAt: undefined }),
    update(fresh, { publishedAt: "2026-10-08T12:00:00.000Z" }),
    update(held, { ruleId: "rule-held" }),
    update(heldAndFresh, { publishedAt: "2026-10-08T12:00:00.000Z", ruleId: "rule-held" }),
  ];
  const entries = updateAllEntries(
    {
      ...snapshot([ready, unknown, fresh, held, heldAndFresh], findings),
      findingRules: [rule("rule-held", { mode: "ignore", reason: "Pinned on purpose" })],
    },
    now,
  );
  const groups = updateAllGroups(entries);
  assert.deepEqual(
    groups.map((group) => [group.title, group.items.map((entry) => entry.item.name)]),
    [
      ["Updates", ["ready-cli"]],
      ["Release age unknown", ["unknown-cli"]],
      ["Released within the cooldown", ["fresh-cli"]],
      ["Snoozed or ignored", ["held-cli", "held-fresh-cli"]],
    ],
    "A held update that is also too new is listed once, as held; its warnings stay on the entry",
  );
  assert.deepEqual(
    groups.map((group) => group.hint === null),
    [true, false, false, false],
    "Every group that is not the plain list says what happens to its packages",
  );
  assert.deepEqual(
    groups.flatMap((group) => group.items.map((entry) => entry.item.name)).sort(),
    entries.map((entry) => entry.item.name).sort(),
    "Every package appears exactly once",
  );
  assert.deepEqual(
    updateAllGroups(entries.filter((entry) => entry.item.name === "ready-cli")).map(
      (group) => group.title,
    ),
    ["Updates"],
    "A group with nothing in it is not listed",
  );
  assert.deepEqual(updateAllGroups([]), []);
});

test("only a verified public-registry update in a rooted, packaged, managed location can run", () => {
  const ready = tool("ready");
  const installations = [
    ready,
    tool("current", { updateStatus: "current", availableVersion: null }),
    tool("unverified", { updateStatus: "unknown" }),
    tool("linked", { origin: "local" }),
    tool("unknown-origin", { origin: "unknown" }),
    tool("no-origin", { origin: undefined }),
    tool("no-candidate", { availableVersion: null }),
    tool("empty-candidate", { availableVersion: "" }),
    tool("rootless", { rootId: undefined }),
    tool("packageless", { packageId: undefined }),
    tool("unmanaged", { manager: undefined }),
  ];
  assert.deepEqual(updatableInstallations(installations), [ready]);
  assert.deepEqual(
    updateAllEntries(snapshot(installations, []), now).map((candidate) => candidate.item),
    [ready],
    "The Update all (N) count and the confirmation list the same tools",
  );
});

test("the progress line says how far Update all is, and how it ended", () => {
  type Status = GlobalToolUpdateBatch["items"][number]["status"];
  const item = (status: Status): GlobalToolUpdateBatch["items"][number] => ({
    installationId: "a".repeat(32),
    rootId: "b".repeat(32),
    manager: "npm",
    name: "tsx",
    packageId: "tsx",
    previousVersion: "1.0.0",
    targetVersion: "2.0.0",
    status,
    message: "",
  });
  assert.equal(
    batchSummary({
      status: "running",
      stopped: false,
      items: [item("succeeded"), item("updating"), item("waiting")],
    }),
    "Updating: 1 of 3 done",
  );
  assert.equal(
    batchSummary({
      status: "running",
      stopped: false,
      items: [item("failed"), item("skipped"), item("verifying"), item("waiting")],
    }),
    "Updating: 2 of 4 done",
    "A package skipped after a failure is settled too",
  );
  assert.equal(
    batchSummary({
      status: "stopping",
      stopped: true,
      items: [item("failed"), item("verifying"), item("waiting")],
    }),
    "Stopping after the current package: 1 of 3 done",
  );
  assert.equal(
    batchSummary({
      status: "finished",
      stopped: false,
      items: [item("succeeded"), item("failed"), item("skipped")],
    }),
    "Update all finished: 1 updated, 1 failed, 1 not started.",
  );
  assert.equal(
    batchSummary({
      status: "finished",
      stopped: true,
      items: [item("succeeded"), item("skipped"), item("skipped")],
    }),
    "Update all stopped: 1 updated, 0 failed, 2 not started.",
  );
  assert.equal(
    batchSummary({
      status: "finished",
      stopped: true,
      items: [item("succeeded"), item("succeeded"), item("failed")],
    }),
    "Update all stopped: 2 updated, 1 failed, 0 not started.",
    "Stop pressed during the last install leaves nothing unstarted, and the counts come from the items",
  );
});

test("only the update finding for the release that would be installed counts", () => {
  const scripted = tool("scripted");
  const older = update(scripted, {
    availableVersion: "1.0.5",
    installScript: true,
    publishedAt: "2026-10-08T12:00:00.000Z",
    ruleId: "rule-old",
  });
  const elsewhere = update(scripted, { installedVersion: "0.9.0", installScript: true });
  const otherPc = update(scripted, { subjectId: "another-pc", installScript: true });
  const [entry] = updateAllEntries(
    {
      ...snapshot([scripted], [older, elsewhere, otherPc]),
      findingRules: [rule("rule-old", { mode: "ignore", reason: "Pinned" })],
    },
    now,
  );
  assert.deepEqual(entry!.warnings, [], "Another release, version, or computer adds no warning");
  assert.equal(entry!.held, null, "Nor does a rule about another release");
  assert.deepEqual([entry!.tooNew, entry!.ageUnknown], [false, true], "No finding, no known age");
});

test("two installs of one name list in one order, by manager", () => {
  const npm = tool("tsx");
  const bun = tool("tsx", {
    id: "tsx-bun",
    manager: "bun",
    source: "bun global",
    rootId: "c".repeat(32),
  });
  const order = (installations: Installation[]) =>
    updateAllEntries(snapshot(installations, []), now).map((entry) => entry.item.manager);
  assert.deepEqual(order([npm, bun]), ["bun", "npm"]);
  assert.deepEqual(order([bun, npm]), ["bun", "npm"]);
});

test("a held update of unknown age sits under the held heading, and each heading says what happens to its packages", () => {
  const heldUnknown = tool("held-unknown-cli");
  const unknown = tool("unknown-cli");
  const fresh = tool("fresh-cli");
  const entries = updateAllEntries(
    {
      ...snapshot(
        [heldUnknown, unknown, fresh],
        [
          update(heldUnknown, { publishedAt: undefined, ruleId: "rule-held" }),
          update(unknown, { publishedAt: undefined }),
          update(fresh, { publishedAt: "2026-10-08T12:00:00.000Z" }),
        ],
      ),
      findingRules: [rule("rule-held", { mode: "ignore", reason: "Pinned" })],
    },
    now,
  );
  const groups = updateAllGroups(entries);
  assert.deepEqual(
    groups.map((group) => [group.title, group.items.map((entry) => entry.item.name)]),
    [
      ["Release age unknown", ["unknown-cli"]],
      ["Released within the cooldown", ["fresh-cli"]],
      ["Snoozed or ignored", ["held-unknown-cli"]],
    ],
  );
  assert.deepEqual(
    groups.map((group) => group.hint),
    [
      "No release time is known for these versions. They are included; untick any you want to wait for.",
      "Left out unless you tick them.",
      "You snoozed or ignored these updates. They are left out unless you tick them.",
    ],
  );
  assert.deepEqual([...initialSelection(entries)], ["unknown-cli-npm"]);
});

test("a refusal from the desktop reads as its own message, without Electron's channel wrapper", () => {
  const wrapped = (channel: string, message: string) =>
    new Error(`Error invoking remote method '${channel}': Error: ${message}`);
  assert.equal(
    ipcMessage(wrapped("versionstead:global-tool-update-all", "This update changed."), "x"),
    "This update changed.",
  );
  assert.equal(
    ipcMessage(new Error("Error invoking remote method 'c': TypeError: Cannot read it"), "x"),
    "Cannot read it",
  );
  assert.equal(ipcMessage(new Error("Wait for the PC scan."), "x"), "Wait for the PC scan.");
  assert.equal(
    ipcMessage(wrapped("c", "Error invoking remote method 'd': Error: inner"), "x"),
    "Error invoking remote method 'd': Error: inner",
    "Only the outer wrapper is removed, once",
  );
  assert.equal(
    ipcMessage("not an error", "Update all could not start."),
    "Update all could not start.",
  );
  assert.equal(
    ipcMessage(new Error(""), "Update all could not start."),
    "Update all could not start.",
  );
});
