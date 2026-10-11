import assert from "node:assert/strict";
import test from "node:test";
import type { MonitoringSnapshot, Project, ScanEvidence } from "@versionstead/contracts/monitoring";
import { bindingConflict, defaultBindings } from "./keybindings.ts";
import {
  activeIndex,
  paletteItems,
  paletteKey,
  paletteLimit,
  resultsNotice,
} from "./palette-items.ts";
import { searchSettings } from "./settings-navigation.ts";

const evidence = (status: ScanEvidence["status"]): ScanEvidence => ({
  status,
  lastAttempt: null,
  lastSuccess: null,
  coverage: [],
  errors: [],
});
const dependency = (projectId: string, name: string, role: "production" | "transitive") => ({
  id: `${projectId}-${name}`,
  name,
  packageName: name,
  requested: role === "transitive" ? null : "^4.17.0",
  resolved: "4.17.21",
  origin: "registry" as const,
  role,
  importer: ".",
  availableVersion: null,
  latestVersion: null,
  advisoryStatus: "checked" as const,
  advisoryIds: [],
});
const project = (
  id: string,
  name: string,
  status: ScanEvidence["status"] = "complete",
): Project => ({
  id,
  name,
  path: `C:\\${id}`,
  mode: "maintained",
  packageManager: "pnpm",
  manifestPath: null,
  lockfilePath: null,
  evidence: evidence(status),
  dependencies: [
    dependency(id, "lodash", "production"),
    dependency(id, "inner-helper", "transitive"),
  ],
  createdAt: "2026-10-01T00:00:00Z",
});
const active = {
  targetId: "app",
  targetLabel: "App",
  kind: "project" as const,
  scanId: "scan-1",
  stage: "versions" as const,
  completed: 1,
  total: 4,
  startedAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:01Z",
};
const snapshot: MonitoringSnapshot = {
  protocolVersion: 1,
  runtime: {
    startedAt: "2026-10-08T00:00:00Z",
    mode: "interactive",
    host: "session",
    platform: "win32",
    nextScanAt: null,
  },
  device: { id: "pc", label: "My PC", platform: "win32" },
  settings: {
    paused: false,
    pcIntervalMinutes: 360,
    projectIntervalMinutes: 60,
    notifyNewFindings: true,
  },
  inventory: {
    collector: "npm-bun-global-v1",
    evidence: evidence("complete"),
    installations: [
      {
        id: "npm-typescript",
        name: "typescript",
        version: "5.9.3",
        source: "npm global",
        scope: "user",
        channel: "stable",
        availableVersion: null,
        updateStatus: "current",
      },
    ],
  },
  projects: [project("app", "App"), project("broken", "Broken site", "failed")],
  findings: [],
  history: [],
  notifications: [],
  scanProgress: { active, queued: [] },
};
const labels = (query: string, connected = true, from: MonitoringSnapshot | null = snapshot) =>
  paletteItems(from, query, connected).map((item) => item.label);
const pages = ["Needs attention", "This PC", "Projects", "Background service"];

test("an empty palette lists pages and actions; without the coordinator, only pages", () => {
  assert.deepEqual(labels(""), [
    ...pages,
    "Scan this PC",
    "Scan all sources",
    "Retry failed checks (1)",
    "Cancel scan: App",
    "Pause scheduled scans",
    "Add project",
    "Export findings",
  ]);
  assert.deepEqual(labels("", false), pages);
  assert.deepEqual(labels("", true, null), pages);
  const later = {
    ...snapshot,
    settings: { ...snapshot.settings, paused: true },
    scanProgress: { active: { ...active, writing: true }, queued: [] },
  };
  assert.ok(labels("", true, later).includes("Resume scheduled scans"));
  assert.ok(
    !labels("", true, later).some((label) => label.startsWith("Cancel scan")),
    "a writing scan cannot be cancelled",
  );
});

test("a query reaches settings through the settings search, projects, direct packages, and project scans", () => {
  const settings = paletteItems(snapshot, "scan interval", true).filter((item) =>
    item.detail.startsWith("Settings"),
  );
  const catalog = searchSettings("scan interval");
  assert.deepEqual(
    settings.map((item) => item.label),
    catalog.map((item) => item.label),
  );
  assert.deepEqual(settings[0]!.action, {
    kind: "go",
    to: catalog[0]!.path,
    hash: catalog[0]!.target!,
  });
  const lodash = paletteItems(snapshot, "lodash app", true);
  assert.deepEqual(
    lodash.map((item) => [item.label, item.detail]),
    [["lodash", "4.17.21 · App (root)"]],
  );
  assert.deepEqual(lodash[0]!.action, {
    kind: "project",
    projectId: "app",
    dependencyId: "app-lodash",
  });
  assert.deepEqual(labels("inner-helper"), [], "transitive packages are left out");
  assert.deepEqual(
    paletteItems(snapshot, "typescript", true).map((item) => item.action),
    [{ kind: "installation", installationId: "npm-typescript" }],
  );
  assert.deepEqual(
    labels("broken"),
    ["Broken site", "Scan Broken site"],
    "a project's name lists the project, not its packages",
  );
  assert.deepEqual(paletteItems(snapshot, "scan broken", true)[0]!.action, {
    kind: "scan",
    target: "projects",
    projectId: "broken",
  });
  const many = {
    ...snapshot,
    projects: Array.from({ length: 80 }, (_, index) => project(`p${index}`, `Project ${index}`)),
  };
  assert.equal(paletteItems(many, "project", true).length, paletteLimit);
  // The page "This PC" is found first in the list, yet a label that starts with the query leads.
  assert.ok(
    labels("pc")[0]!.toLowerCase().startsWith("pc"),
    "labels that start with the query come first",
  );
  // Every tool's detail says "This PC", so a tool is found by its own name, not by that.
  assert.ok(!labels("pc").includes("typescript"));
});

test("palette keys move and choose, wrap at the ends, and leave IME composition alone", () => {
  assert.deepEqual(paletteKey("ArrowDown", false, 2, 3), { active: 0 });
  assert.deepEqual(paletteKey("ArrowUp", false, 0, 3), { active: 2 });
  assert.deepEqual(paletteKey("Enter", false, 1, 3), { choose: 1 });
  assert.deepEqual(
    paletteKey("Enter", false, 5, 3),
    { choose: 2 },
    "fewer results than before choose the last one",
  );
  assert.equal(
    paletteKey("Enter", true, 1, 3),
    null,
    "Enter confirms the composition, not an option",
  );
  assert.equal(paletteKey("ArrowDown", true, 1, 3), null);
  assert.equal(paletteKey("Enter", false, 0, 0), null);
  assert.equal(paletteKey("a", false, 0, 3), null);
  assert.equal(defaultBindings.palette, "mod+k");
  assert.equal(
    bindingConflict(defaultBindings, "palette", "mod+k"),
    undefined,
    "no other command uses it",
  );
});

test("each action carries the request it makes", () => {
  const actionsOf = (from: MonitoringSnapshot, query = "") =>
    Object.fromEntries(
      paletteItems(from, query, true)
        .filter((item) => item.detail === "Action")
        .map((item) => [item.label, item.action]),
    );
  assert.deepEqual(actionsOf(snapshot), {
    "Scan this PC": { kind: "scan", target: "pc" },
    "Scan all sources": { kind: "scan", target: "all" },
    "Retry failed checks (1)": { kind: "scan", target: "failed" },
    "Cancel scan: App": { kind: "cancel", scanId: "scan-1" },
    "Pause scheduled scans": { kind: "pause", paused: true },
    "Add project": { kind: "add-project" },
    "Export findings": { kind: "export" },
  });
  const paused = { ...snapshot, settings: { ...snapshot.settings, paused: true } };
  assert.deepEqual(actionsOf(paused, "resume"), {
    "Resume scheduled scans": { kind: "pause", paused: false },
  });
});

test("the cancel option names its scan, so a highlight cannot move to another scan's Cancel", () => {
  const cancelId = (scanId: string) =>
    paletteItems(
      { ...snapshot, scanProgress: { active: { ...active, scanId }, queued: [] } },
      "cancel",
      true,
    ).find((item) => item.action?.kind === "cancel")?.id;
  assert.equal(cancelId("scan-1"), "action:cancel:scan-1");
  assert.notEqual(cancelId("scan-1"), cancelId("scan-2"));
});

test("an action is listed only while it can apply to the snapshot", () => {
  const actions = (from: MonitoringSnapshot) => labels("", true, from).slice(pages.length);
  // An older background host cannot scan the PC; the Scan now buttons for the PC and for all sources
  // say so, and so does this.
  const { collector: _older, ...olderInventory } = snapshot.inventory;
  const older = actions({ ...snapshot, inventory: olderInventory });
  assert.ok(!older.includes("Scan this PC"));
  assert.ok(!older.includes("Scan all sources"));
  // Retry counts the same targets the Needs attention button does, including This PC's update checks.
  const pcGaps = { ...snapshot.inventory, updateEvidence: evidence("partial") };
  assert.ok(actions({ ...snapshot, inventory: pcGaps }).includes("Retry failed checks (2)"));
  const recovered = { ...snapshot, projects: [project("app", "App")] };
  assert.ok(!actions(recovered).some((label) => label.startsWith("Retry failed checks")));
  // With no scan running there is nothing to cancel.
  const idle = { ...snapshot, scanProgress: { active: null, queued: [] } };
  assert.ok(!actions(idle).some((label) => label.startsWith("Cancel scan")));
});

test("Enter does nothing while the list still shows an earlier query", () => {
  assert.deepEqual(paletteKey("Enter", false, 0, 3, false), { choose: 0 });
  assert.equal(paletteKey("Enter", false, 0, 3, true), null, "the owner cannot see that option");
  assert.deepEqual(paletteKey("ArrowDown", false, 0, 3, true), { active: 1 });
});

test("the highlight follows its option when a refresh adds options before it", () => {
  const idle = { ...snapshot, scanProgress: { active: null, queued: [] } };
  const before = paletteItems(idle, "", true);
  const pause = before.findIndex((item) => item.id === "action:pause");
  assert.equal(activeIndex(before, "action:pause"), pause);
  // A scan starts: "Cancel scan: App" now sits ahead of Pause, so Pause moves down one row.
  const after = paletteItems(snapshot, "", true);
  assert.equal(after[activeIndex(after, "action:pause")]!.id, "action:pause");
  assert.equal(activeIndex(after, "action:pause"), pause + 1);
  assert.equal(activeIndex(after, null), 0, "nothing moved to yet: the first option");
  assert.equal(activeIndex(after, "action:gone"), 0, "an option that left: the first option");
});

test("the results line says how many options there are, or that none match", () => {
  assert.equal(resultsNotice(0), "No matching pages, settings, projects, packages, or actions");
  assert.equal(resultsNotice(1), "1 result");
  assert.equal(resultsNotice(12), "12 results");
});

test("projects with the same name are numbered, in the project, its packages, and its scan", () => {
  const twins = {
    ...snapshot,
    projects: [project("a", "twin"), project("b", "twin"), project("c", "solo")],
  };
  assert.deepEqual(labels("twin", true, twins), [
    "twin (1 of 2)",
    "twin (2 of 2)",
    "Scan twin (1 of 2)",
    "Scan twin (2 of 2)",
  ]);
  assert.deepEqual(
    paletteItems(twins, "twin (2", true).map((item) => item.action),
    [
      { kind: "project", projectId: "b" },
      { kind: "scan", target: "projects", projectId: "b" },
    ],
  );
  assert.deepEqual(
    paletteItems(twins, "lodash twin", true).map((item) => item.detail),
    ["4.17.21 · twin (1 of 2) (root)", "4.17.21 · twin (2 of 2) (root)"],
  );
  assert.deepEqual(
    labels("solo", true, twins),
    ["solo", "Scan solo"],
    "a name that is not repeated stays plain",
  );
});
