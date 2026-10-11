import assert from "node:assert/strict";
import test from "node:test";
import type {
  Installation,
  Dependency,
  Finding,
  GlobalToolSource,
  MonitoringSnapshot,
  NotificationSummary,
  Project,
  ScanEvidence,
  ScanProgress,
} from "@versionstead/contracts/monitoring";
import {
  advisoryTone,
  type AttentionFilter,
  attentionSearch,
  attentionGroups,
  backgroundSetup,
  backgroundSummary,
  bootHostBadge,
  canIgnore,
  compareFindings,
  deliveryStatus,
  dependencyFindings,
  dependencyNeedsAttention,
  dependencyUpgradeOption,
  evidenceStale,
  failedTargetCount,
  filterInstallations,
  findingCounts,
  findingSummary,
  findingTotal,
  findingsRetained,
  findingUpgradeCommands,
  firewallName,
  globalToolSourceState,
  heldDependencies,
  hostLabel,
  installationCandidate,
  latestScanNotice,
  installationFindings,
  installationUpdate,
  isNewFinding,
  isEffectiveDay,
  lifecycleNote,
  lifecycleRows,
  localOnlyFilter,
  noun,
  pcUpdateState,
  pcUpdateHold,
  pcUpdatesUnverified,
  plural,
  platformLabel,
  projectNeedsAttention,
  relativeTime,
  restartAdvice,
  ruleLabel,
  runtimeNotices,
  scanDuration,
  scanStage,
  severityPresentation,
  snoozeChoices,
  supportStateLabel,
  suppressedCount,
  uniqueRowLabels,
  workspaceLabel,
} from "./monitoring-view.ts";

test("attention groups retain incomplete targets, source/version identities, and notification filter semantics", () => {
  const evidence: ScanEvidence = {
    status: "complete",
    lastAttempt: "2026-10-03T01:02:00Z",
    lastSuccess: "2026-10-02T01:00:00Z",
    coverage: ["Public registry inputs inspected"],
    errors: [],
  };
  const dependency: Dependency = {
    id: "dependency-one",
    name: "tool",
    packageName: "tool",
    requested: "^1.0.0",
    resolved: "1.0.0",
    origin: "registry",
    role: "production",
    importer: ".",
    availableVersion: "1.1.0",
    latestVersion: "2.0.0",
    versionStatus: "checked",
    advisoryStatus: "checked",
    advisoryIds: ["GHSA-one"],
  };
  const project: Project = {
    id: "affected",
    name: "Same name",
    path: "C:\\one",
    mode: "maintained",
    packageManager: "pnpm",
    manifestPath: null,
    lockfilePath: null,
    evidence,
    dependencies: [dependency],
    createdAt: evidence.lastSuccess!,
  };
  const update: Finding = {
    id: "update-one",
    kind: "update",
    subjectId: project.id,
    subjectLabel: project.name,
    name: dependency.name,
    packageName: dependency.packageName,
    installedVersion: dependency.resolved,
    availableVersion: dependency.availableVersion,
    severity: "info",
    source: "npm registry",
    description: "A newer compatible release is available.",
    advisoryUrl: null,
    detectedAt: evidence.lastSuccess!,
    lastSeenAt: evidence.lastSuccess!,
  };
  const advisory: Finding = {
    ...update,
    id: "advisory-one",
    kind: "advisory",
    source: "OSV",
    advisoryUrl: "https://osv.dev/vulnerability/GHSA-one",
  };
  const coverage: Finding = {
    ...update,
    id: "coverage-one",
    kind: "coverage",
    packageName: null,
  };
  const otherImporter = { ...update, id: "update-two" };
  assert.deepEqual(findingCounts([update, advisory, coverage, otherImporter], "pc"), {
    packages: 1,
    updates: 1,
    advisories: 1,
    lifecycle: 0,
    other: 0,
    incomplete: 1,
  });
  assert.equal(
    findingCounts([update, { ...update, id: "old-version", installedVersion: "0.9.0" }], "pc")
      .packages,
    2,
  );
  assert.equal(
    findingCounts([update, { ...update, id: "other-source", source: "Other registry" }], "pc")
      .updates,
    2,
  );
  assert.deepEqual(
    findingCounts(
      [
        { ...update, subjectId: "pc", id: "npm-root" },
        { ...update, subjectId: "pc", id: "bun-root", source: "bun global" },
      ],
      "pc",
    ),
    { packages: 2, updates: 2, advisories: 0, lifecycle: 0, other: 0, incomplete: 0 },
  );

  const current: Dependency = {
    ...dependency,
    id: "transitive",
    role: "transitive",
    availableVersion: null,
    latestVersion: null,
    versionStatus: "unsupported",
    advisoryIds: [],
  };
  const clean = { ...project, id: "clean", dependencies: [current] };
  const unscanned: Project = {
    ...clean,
    id: "unscanned",
    path: "C:\\two",
    evidence: { ...evidence, status: "not-scanned", lastAttempt: null, lastSuccess: null },
  };
  const failed: Project = {
    ...clean,
    id: "failed",
    evidence: { ...evidence, status: "failed", errors: ["Access failed"] },
  };
  let snapshot: MonitoringSnapshot = {
    protocolVersion: 1,
    runtime: {
      startedAt: evidence.lastAttempt!,
      mode: "interactive",
      host: "session",
      platform: "win32",
      nextScanAt: null,
    },
    device: { id: "pc", label: "My PC", platform: "win32" },
    settings: {
      paused: false,
      pcIntervalMinutes: 60,
      projectIntervalMinutes: 60,
      notifyNewFindings: true,
    },
    inventory: { evidence, updateEvidence: evidence, installations: [] },
    projects: [project, clean, unscanned, failed],
    findings: [update, advisory, otherImporter],
    history: [],
    notifications: [],
  };
  const ids = (filter: "all" | "updates" | "advisories" | "coverage", query = "") =>
    attentionGroups(snapshot, filter, query).map((group) => group.id);
  assert.deepEqual(ids("all"), ["affected", "unscanned", "failed"]);
  assert.deepEqual(ids("updates"), ["affected"]);
  assert.deepEqual(ids("advisories"), ["affected"]);
  assert.deepEqual(ids("coverage"), ["unscanned", "failed"]);
  assert.deepEqual(ids("all", "  SAME NAME "), ["affected", "unscanned", "failed"]);
  assert.deepEqual(ids("all", "C:\\two"), ["unscanned"]);
  assert.deepEqual(ids("all", "access failed"), ["failed"]);
  assert.deepEqual(ids("updates", "missing"), []);
  assert.equal(attentionGroups(snapshot)[0]!.evidence, evidence);
  assert.equal(attentionGroups(snapshot)[2]!.evidence.lastSuccess, evidence.lastSuccess);
  assert.equal(attentionGroups(snapshot)[1]!.counts.packages, 0);
  assert.equal(attentionGroups(snapshot)[1]!.counts.incomplete, 1);
  assert.equal(projectNeedsAttention(clean, snapshot.findings), false);
  for (const status of ["not-scanned", "partial", "failed", "unsupported", "scanning"] as const)
    assert.equal(projectNeedsAttention({ ...clean, evidence: { ...evidence, status } }, []), true);
  snapshot = {
    ...snapshot,
    scanProgress: {
      active: null,
      queued: [{ targetId: clean.id, targetLabel: clean.name, kind: "project" }],
    },
  };
  assert.equal(projectNeedsAttention(clean, [], snapshot.scanProgress), true);
  assert.deepEqual(ids("all"), ["affected", "clean", "unscanned", "failed"]);
  assert.equal(attentionGroups(snapshot)[1]!.queued, true);
  assert.deepEqual(ids("advisories"), ["affected"]);
  snapshot = {
    ...snapshot,
    scanProgress: {
      active: {
        targetId: clean.id,
        targetLabel: clean.name,
        kind: "project",
        scanId: "active-scan",
        stage: "versions",
        completed: 0,
        total: 10,
        startedAt: evidence.lastAttempt!,
        updatedAt: evidence.lastAttempt!,
      },
      queued: [],
    },
    inventory: {
      ...snapshot.inventory,
      updateEvidence: { ...evidence, status: "failed", errors: ["Registry failed"] },
    },
  };
  assert.equal(attentionGroups(snapshot).find((group) => group.id === clean.id)!.active, true);
  assert.equal(
    attentionGroups(snapshot).find((group) => group.id === clean.id)!.evidence,
    evidence,
  );
  assert.deepEqual(ids("coverage"), ["pc", "unscanned", "failed"]);
  assert.deepEqual(ids("coverage", "registry failed"), ["pc"]);
  assert.equal(attentionGroups(snapshot)[0]!.evidence.status, "failed");
  assert.equal(attentionGroups(snapshot)[0]!.counts.packages, 0);

  assert.equal(dependencyNeedsAttention(current), false);
  assert.equal(dependencyNeedsAttention({ ...current, advisoryStatus: "failed" }), true);
  assert.equal(
    dependencyNeedsAttention({ ...current, role: "production", versionStatus: "failed" }),
    true,
  );
  assert.equal(
    dependencyNeedsAttention({ ...current, origin: "workspace", advisoryStatus: "unsupported" }),
    false,
  );
  assert.deepEqual(
    dependencyFindings(dependency, snapshot.findings).map((finding) => finding.id),
    ["update-one", "advisory-one", "update-two"],
  );
  assert.equal(
    dependencyFindings({ ...dependency, resolved: "2.0.0" }, snapshot.findings).length,
    0,
  );
  assert.equal(
    dependencyFindings({ ...dependency, name: "different-alias" }, snapshot.findings).length,
    0,
  );
  assert.equal(dependencyFindings({ ...dependency, origin: "local" }, snapshot.findings).length, 0);
  assert.equal(
    dependencyFindings(
      { ...dependency, id: "workspace-row", importer: "packages/other" },
      snapshot.findings,
    ).length,
    3,
  );
});

test("global tool views combine update, manager, and search filters without treating unknown checks as current", () => {
  const installations: Installation[] = (["available", "current", "unknown"] as const).map(
    (updateStatus, index) => ({
      id: String(index),
      name: `Tool ${index}`,
      version: "1.0",
      source: index === 0 ? "npm" : "bun",
      manager: index === 0 ? "npm" : "bun",
      scope: "user",
      channel: "stable",
      availableVersion: index === 0 ? "2.0" : null,
      updateStatus,
    }),
  );
  assert.deepEqual(
    filterInstallations(installations, "updates", "all", "").map((item) => item.id),
    ["0"],
  );
  assert.deepEqual(
    filterInstallations(installations, "current", "all", "").map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(
    filterInstallations(installations, "unverified", "all", "").map((item) => item.id),
    ["2"],
  );
  assert.equal(filterInstallations(installations, "all", "bun", " tool ").length, 2);
  assert.equal(filterInstallations(installations, "updates", "bun", "").length, 0);
  assert.equal(filterInstallations(installations, "all", "all", "NPM").length, 1);
  const candidate = { availableVersion: "2.0", updateStatus: "available" as const };
  assert.equal(installationCandidate(candidate), "2.0");
  assert.equal(installationCandidate(candidate, true), "2.0 · previous, unverified");
  assert.equal(
    installationCandidate({ ...candidate, updateStatus: "unknown" }),
    "2.0 · previous, unverified",
  );
  assert.equal(installationCandidate({ availableVersion: null, updateStatus: "unknown" }), "");
  const evidence: ScanEvidence = {
    status: "complete",
    lastAttempt: "2026-10-02T01:00:00Z",
    lastSuccess: "2026-10-02T01:00:00Z",
    coverage: [],
    errors: [],
  };
  const inventory: MonitoringSnapshot["inventory"] = { installations, evidence };
  assert.match(pcUpdateState(inventory).title, /unavailable/);
  assert.match(
    pcUpdateState({ ...inventory, updateEvidence: { ...evidence, status: "failed" } }).title,
    /could not finish/,
  );
  assert.match(
    pcUpdateState({ ...inventory, updateEvidence: { ...evidence, status: "not-scanned" } }).title,
    /Scan this PC/,
  );
  assert.match(
    pcUpdateState({ ...inventory, updateEvidence: evidence }).description,
    /checked public registry/,
  );
  assert.match(
    pcUpdateState({ ...inventory, updateEvidence: { ...evidence, status: "partial" } }).description,
    /could not complete/,
  );

  const manager: GlobalToolSource = {
    manager: "npm",
    status: "detected",
    version: "11.14.0",
    root: "C:\\global\\node_modules",
    registry: "public",
    blockedScopes: [],
    checkedAt: evidence.lastAttempt,
    error: null,
  };
  assert.match(globalToolSourceState(manager).label, /Detected.*11\.14\.0/);
  assert.equal(
    globalToolSourceState({ ...manager, status: "not-installed" }).label,
    "Not installed",
  );
  assert.equal(
    globalToolSourceState({ ...manager, status: "unavailable", error: "Access failed" })
      .description,
    "Access failed",
  );
  assert.equal(globalToolSourceState({ ...manager, registry: "unsupported" }).tone, "warning");
  assert.match(
    globalToolSourceState({ ...manager, registry: "unknown" }).description,
    /unverified/,
  );
  const empty = { ...inventory, installations: [], updateEvidence: evidence, managers: [manager] };
  assert.equal(pcUpdateState(empty).title, "No global tools found");
  assert.equal(
    pcUpdateState({ ...empty, managers: [{ ...manager, status: "not-installed" }] }).title,
    "No npm or Bun installation detected",
  );
  assert.notEqual(
    pcUpdateState({ ...empty, managers: [{ ...manager, status: "unavailable" }] }).title,
    "No global tools found",
  );
});

test("scan progress has real stage counts or indeterminate state, and notification links validate filters", () => {
  assert.deepEqual(scanStage({ stage: "advisories", completed: 100, total: 240 }), {
    label: "Checking advisories",
    value: 100,
    max: 240,
    count: "100/240 packages",
  });
  assert.deepEqual(scanStage({ stage: "native-versions", completed: 40, total: 42 }), {
    label: "Checking updates with the package manager",
    value: 40,
    max: 42,
    count: "40/42 packages",
  });
  assert.deepEqual(scanStage({ stage: "release-facts", completed: 2, total: 5 }), {
    label: "Checking release age, license, and provenance",
    value: 2,
    max: 5,
    count: "2/5 packages",
  });
  for (const [completed, total] of [
    [null, null],
    [0, 0],
    [10, null],
    [11, 10],
    [-1, 10],
    [1, Number.NaN],
  ] as const) {
    const stage = scanStage({ stage: "inventory", completed, total });
    assert.equal(stage.value, undefined);
    assert.equal(stage.max, undefined);
    assert.equal(stage.count, "");
  }
  assert.equal(scanDuration("2026-10-02T01:00:00Z", "2026-10-02T01:01:14Z"), "1m 14s elapsed");
  assert.equal(scanDuration("invalid", "invalid"), "Elapsed time unavailable");
  assert.deepEqual(attentionSearch({ filter: "updates" }), { filter: "updates" });
  assert.deepEqual(attentionSearch({ filter: "advisories" }), { filter: "advisories" });
  assert.deepEqual(attentionSearch({ filter: ["updates"] }), {});
  assert.deepEqual(attentionSearch({ filter: "unknown" }), {});
});

test("relative times round down, say just now under 45 seconds, and describe future schedules", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const second = 1000;
  const minute = 60 * second;
  const hour = 60 * minute;
  const day = 24 * hour;
  const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), now);
  assert.equal(ago(0), "just now");
  assert.equal(ago(44 * second), "just now");
  assert.equal(ago(45 * second), "1 minute ago");
  assert.equal(ago(59 * second), "1 minute ago");
  assert.equal(ago(2 * minute + 5 * second), "2 minutes ago");
  assert.equal(ago(59 * minute + 59 * second), "59 minutes ago");
  assert.equal(ago(hour), "1 hour ago");
  assert.equal(ago(23 * hour + 59 * minute), "23 hours ago");
  // Whole elapsed units, never calendar words: 47 hours ago is not "yesterday".
  assert.equal(ago(day), "1 day ago");
  assert.equal(ago(36 * hour), "1 day ago");
  assert.equal(ago(47 * hour), "1 day ago");
  assert.equal(ago(3 * day), "3 days ago");
  assert.equal(ago(29 * day), "29 days ago");
  assert.equal(ago(30 * day), "1 month ago");
  assert.equal(ago(59 * day), "1 month ago");
  assert.equal(ago(75 * day), "2 months ago");
  assert.equal(ago(400 * day), "13 months ago");
  assert.equal(ago(-30 * second), "in under a minute");
  assert.equal(ago(-5 * minute), "in 5 minutes");
  assert.equal(ago(-2 * hour), "in 2 hours");
  assert.equal(ago(-day), "in 1 day");
  assert.equal(ago(-36 * hour), "in 1 day");
  assert.equal(ago(-30 * day), "in 1 month");
  assert.equal(relativeTime("not a date", now), "Unknown time");
  assert.equal(relativeTime("", now), "Unknown time");
});

test("evidence is stale once older than twice its interval, never before a first success", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const old = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  assert.equal(evidenceStale(old(119), 60, now), false);
  assert.equal(evidenceStale(old(120), 60, now), false);
  assert.equal(evidenceStale(old(121), 60, now), true);
  assert.equal(evidenceStale(old(30), 15, now), false);
  assert.equal(evidenceStale(old(31), 15, now), true);
  assert.equal(evidenceStale(old(2 * 24 * 60), 1440, now), false);
  assert.equal(evidenceStale(old(2 * 24 * 60 + 1), 1440, now), true);
  assert.equal(evidenceStale(old(3 * 24 * 60), 1440, now), true);
  assert.equal(evidenceStale(null, 60, now), false);
  assert.equal(evidenceStale("not a date", 60, now), false);
  assert.equal(evidenceStale(old(-10), 60, now), false);
});

test("advisory severity sets the tone, rows sort by severity then name, and unknown is never buried", () => {
  assert.deepEqual(severityPresentation("critical"), { label: "Critical advisory", tone: "error" });
  assert.deepEqual(severityPresentation("high"), { label: "High advisory", tone: "error" });
  assert.deepEqual(severityPresentation("moderate"), {
    label: "Moderate advisory",
    tone: "warning",
  });
  assert.deepEqual(severityPresentation("low"), { label: "Low advisory", tone: "neutral" });
  assert.deepEqual(severityPresentation("info"), { label: "Info advisory", tone: "neutral" });
  assert.deepEqual(severityPresentation("unknown"), { label: "Unknown severity", tone: "neutral" });

  const finding = (
    name: string,
    severity: Finding["severity"],
    kind: Finding["kind"] = "advisory",
  ) =>
    ({
      id: `${name}-${severity}`,
      kind,
      subjectId: "project",
      subjectLabel: "Project",
      name,
      packageName: name,
      installedVersion: "1.0.0",
      availableVersion: null,
      severity,
      source: "OSV",
      description: "",
      advisoryUrl: null,
      detectedAt: "2026-10-08T00:00:00Z",
      lastSeenAt: "2026-10-08T00:00:00Z",
    }) satisfies Finding;
  const unsorted = [
    finding("alpha", "low"),
    finding("zeta", "critical"),
    finding("tool", "info", "update"),
    finding("mid", "moderate"),
    finding("unspecified", "unknown"),
    finding("beta", "critical"),
    finding("hi", "high"),
  ];
  assert.deepEqual(
    [...unsorted].sort(compareFindings).map((item) => item.name),
    ["beta", "zeta", "hi", "mid", "unspecified", "alpha", "tool"],
  );
  assert.equal(advisoryTone([finding("a", "low"), finding("b", "unknown")]), "neutral");
  assert.equal(advisoryTone([finding("a", "low"), finding("b", "moderate")]), "warning");
  assert.equal(advisoryTone([finding("a", "moderate"), finding("b", "high")]), "error");
  assert.equal(advisoryTone([finding("a", "critical")]), "error");
  assert.equal(advisoryTone([]), "neutral");
});

test("labels name workspaces, platforms and counts the way people say them", () => {
  assert.equal(workspaceLabel("."), "root");
  assert.equal(workspaceLabel("packages/app"), "packages/app");
  assert.equal(platformLabel("win32"), "Windows");
  assert.equal(platformLabel("darwin"), "macOS");
  assert.equal(platformLabel("linux"), "Linux");
  assert.equal(platformLabel("freebsd"), "freebsd");
  assert.equal(noun(1, "package with findings", "packages with findings"), "package with findings");
  assert.equal(noun(0, "update"), "updates");
  assert.equal(noun(2, "advisory", "advisories"), "advisories");
  assert.equal(plural(0, "target"), "0 targets");
  assert.equal(plural(1, "target"), "1 target");
  assert.equal(plural(2, "target"), "2 targets");
  assert.equal(plural(1, "advisory", "advisories"), "1 advisory");
  assert.equal(plural(3, "advisory", "advisories"), "3 advisories");
});

test("findings that a failed or unsupported scan kept from earlier scans read as previous", () => {
  const retained: Record<ScanEvidence["status"], boolean> = {
    "not-scanned": false,
    scanning: false,
    complete: false,
    partial: false,
    failed: true,
    // An unsupported lockfile keeps the project's earlier findings too.
    unsupported: true,
  };
  for (const [status, expected] of Object.entries(retained))
    assert.equal(findingsRetained(status as ScanEvidence["status"]), expected, status);
});

test("a dialog built from earlier evidence says when the latest scan failed or is unsupported", () => {
  assert.equal(latestScanNotice("failed"), "The latest scan failed.");
  assert.equal(latestScanNotice("unsupported"), "The latest scan is unsupported.");
  for (const status of ["not-scanned", "scanning", "complete", "partial"] as const)
    assert.equal(latestScanNotice(status), null, status);
});

test("attention groups list findings most severe first", () => {
  const evidence: ScanEvidence = {
    status: "complete",
    lastAttempt: "2026-10-08T00:00:00Z",
    lastSuccess: "2026-10-08T00:00:00Z",
    coverage: [],
    errors: [],
  };
  const base = {
    kind: "advisory",
    subjectId: "pc",
    subjectLabel: "PC",
    packageName: null,
    installedVersion: "1.0.0",
    availableVersion: null,
    source: "OSV",
    description: "",
    advisoryUrl: null,
    detectedAt: evidence.lastSuccess!,
    lastSeenAt: evidence.lastSuccess!,
  } as const;
  const snapshot: MonitoringSnapshot = {
    protocolVersion: 1,
    runtime: {
      startedAt: evidence.lastAttempt!,
      mode: "interactive",
      host: "session",
      platform: "win32",
      nextScanAt: null,
    },
    device: { id: "pc", label: "PC", platform: "win32" },
    settings: {
      paused: false,
      pcIntervalMinutes: 60,
      projectIntervalMinutes: 60,
      notifyNewFindings: true,
    },
    inventory: { evidence, installations: [] },
    projects: [],
    findings: [
      { ...base, id: "1", name: "b-low", severity: "low" },
      { ...base, id: "2", name: "z-critical", severity: "critical" },
      { ...base, id: "3", name: "a-critical", severity: "critical" },
    ],
    history: [],
    notifications: [],
  };
  assert.deepEqual(
    attentionGroups(snapshot)[0]!.findings.map((item) => item.name),
    ["a-critical", "z-critical", "b-low"],
  );
  // The coordinator's own order is not rewritten.
  assert.deepEqual(
    snapshot.findings.map((item) => item.name),
    ["b-low", "z-critical", "a-critical"],
  );
});

function upgradeFixture() {
  const dependency = (changes: Partial<Dependency> = {}): Dependency => ({
    id: "dependency",
    name: "tool",
    packageName: "tool",
    requested: "^1.0.0",
    resolved: "1.0.0",
    origin: "registry",
    role: "production",
    importer: ".",
    availableVersion: "1.1.0",
    latestVersion: "2.0.0",
    versionStatus: "checked",
    advisoryStatus: "checked",
    advisoryIds: [],
    ...changes,
  });
  const evidence: ScanEvidence = {
    status: "complete",
    lastAttempt: "2026-10-08T00:00:00Z",
    lastSuccess: "2026-10-08T00:00:00Z",
    coverage: [],
    errors: [],
  };
  const project = (
    dependencies: Dependency[],
    packageManager: Project["packageManager"] = "pnpm",
  ): Project => ({
    id: "project",
    name: "Project",
    path: "C:\\project",
    mode: "maintained",
    packageManager,
    manifestPath: null,
    lockfilePath: null,
    evidence,
    dependencies,
    createdAt: evidence.lastSuccess!,
  });
  const update: Finding = {
    id: "update",
    kind: "update",
    subjectId: "project",
    subjectLabel: "Project",
    name: "tool",
    packageName: "tool",
    installedVersion: "1.0.0",
    availableVersion: "1.1.0",
    severity: "info",
    source: "npm registry",
    description: "",
    advisoryUrl: null,
    detectedAt: evidence.lastSuccess!,
    lastSeenAt: evidence.lastSuccess!,
  };
  // An advisory's availableVersion is the provider-listed fixed boundary, not a target.
  const advisory = (fixed: string | null): Finding => ({
    ...update,
    id: "advisory",
    kind: "advisory",
    severity: "high",
    availableVersion: fixed,
  });
  const tool = (changes: Partial<Installation> = {}): Installation => ({
    id: "tool-npm",
    name: "tool",
    packageId: "tool",
    version: "1.0.0",
    source: "npm",
    manager: "npm",
    origin: "registry",
    scope: "user",
    channel: "Stable",
    availableVersion: "1.1.0",
    updateStatus: "available",
    ...changes,
  });
  const pc = (
    installations: Installation[] = [],
    updateEvidence: Partial<ScanEvidence> = {},
    scanProgress: ScanProgress = { active: null, queued: [] },
    inventoryEvidence: Partial<ScanEvidence> = {},
  ) => ({
    inventory: {
      evidence: { ...evidence, ...inventoryEvidence },
      updateEvidence: { ...evidence, ...updateEvidence },
      installations,
    },
    scanProgress,
  });
  const pcUpdate: Finding = { ...update, subjectId: "pc", subjectLabel: "PC" };
  return { dependency, evidence, project, update, advisory, tool, pc, pcUpdate };
}

test("upgrade commands follow the dependency record behind a finding, one per place it applies", () => {
  const { dependency, project, update, advisory, pc } = upgradeFixture();

  // The compatible candidate wins over the latest release, as it does for the finding itself.
  assert.deepEqual(dependencyUpgradeOption(project([dependency()]), dependency()), {
    where: "root",
    command: "pnpm add tool@1.1.0",
    version: "1.1.0",
  });
  assert.deepEqual(
    dependencyUpgradeOption(project([dependency()]), dependency({ availableVersion: null })),
    { where: "root", command: "pnpm add tool@2.0.0", version: "2.0.0" },
  );
  // An unverified or missing candidate never becomes a command.
  assert.equal(
    dependencyUpgradeOption(project([dependency()]), dependency({ versionStatus: "failed" })),
    null,
  );
  assert.equal(
    dependencyUpgradeOption(
      project([dependency()]),
      dependency({ availableVersion: null, latestVersion: null }),
    ),
    null,
  );

  assert.deepEqual(findingUpgradeCommands(update, project([dependency()]), pc()), [
    { where: "root", command: "pnpm add tool@1.1.0", version: "1.1.0" },
  ]);
  // An advisory that lists no fixed version is not known to be fixed by any update: no command.
  assert.deepEqual(findingUpgradeCommands(advisory(null), project([dependency()]), pc()), []);
  assert.deepEqual(
    findingUpgradeCommands(
      advisory(null),
      project([dependency({ availableVersion: null, latestVersion: null })]),
      pc(),
    ),
    [],
  );
  // Findings do not name their workspace, so each workspace holding the package gets its command.
  const workspaces = project([
    dependency({ id: "root" }),
    dependency({ id: "app", importer: "packages/app" }),
    dependency({ id: "lib", importer: "packages/lib", role: "development" }),
    dependency({ id: "twin", importer: "packages/lib", role: "development" }),
  ]);
  assert.deepEqual(findingUpgradeCommands(update, workspaces, pc()), [
    { where: "root", command: "pnpm add tool@1.1.0 -w", version: "1.1.0" },
    {
      where: "packages/app",
      command: "pnpm --filter ./packages/app add tool@1.1.0",
      version: "1.1.0",
    },
    {
      where: "packages/lib",
      command: "pnpm --filter ./packages/lib add tool@1.1.0 -D",
      version: "1.1.0",
    },
  ]);
  // Other versions, aliases and non-registry sources are different records.
  assert.deepEqual(
    findingUpgradeCommands(
      update,
      project([
        dependency({ resolved: "0.9.0" }),
        dependency({ id: "alias", name: "tool-alias", packageName: "tool" }),
        dependency({ id: "git", origin: "git" }),
      ]),
      pc(),
    ),
    [],
  );
  assert.deepEqual(
    findingUpgradeCommands({ ...update, kind: "coverage" }, project([dependency()]), pc()),
    [],
  );
});

test("an advisory is offered an update only when it reaches the provider-listed fixed boundary", () => {
  const { dependency, project, update, advisory, pc } = upgradeFixture();
  const commands = (fixed: string | null, changes: Partial<Dependency> = {}) =>
    findingUpgradeCommands(advisory(fixed), project([dependency(changes)]), pc()).map(
      (option) => option.command,
    );
  // The compatible candidate, 1.1.0, stops short of a fix at 99.0.0 or 1.1.1: no command.
  assert.deepEqual(commands("99.0.0"), []);
  assert.deepEqual(commands("1.1.1"), []);
  // At or past the boundary it is the dependency's update; with no boundary listed there is none.
  assert.deepEqual(commands("1.1.0"), ["pnpm add tool@1.1.0"]);
  assert.deepEqual(commands("1.0.5"), ["pnpm add tool@1.1.0"]);
  assert.deepEqual(commands(null), []);
  // The latest release is the candidate when nothing is compatible, and is held to the same rule.
  assert.deepEqual(commands("2.0.0", { availableVersion: null }), ["pnpm add tool@2.0.0"]);
  assert.deepEqual(commands("2.0.1", { availableVersion: null }), []);
  // A boundary that is not SemVer cannot be compared, so no command is offered.
  assert.deepEqual(commands("not-a-version"), []);
  assert.deepEqual(commands("2.x"), []);
  // An update finding's own version is its candidate: the rule does not apply.
  assert.deepEqual(
    findingUpgradeCommands(update, project([dependency()]), pc()).map((option) => option.command),
    ["pnpm add tool@1.1.0"],
  );
});

test("This PC commands are withheld while its update results are unverified or in flux", () => {
  const { dependency, project, update, tool, pc, pcUpdate } = upgradeFixture();
  const target = { targetId: "pc", targetLabel: "PC", kind: "pc" } as const;
  const projectTarget = { targetId: "project", targetLabel: "Project", kind: "project" } as const;
  const active = (kind: typeof target | typeof projectTarget): ScanProgress => ({
    active: {
      ...kind,
      scanId: "scan",
      stage: "pc-updates",
      completed: null,
      total: null,
      startedAt: "2026-10-08T00:00:00Z",
      updatedAt: "2026-10-08T00:00:00Z",
    },
    queued: [],
  });
  const states: [string, ReturnType<typeof pc>, boolean][] = [
    ["complete", pc(), false],
    ["partial update checks", pc([], { status: "partial" }), false],
    ["not scanned", pc([], { status: "not-scanned" }), false],
    ["failed update checks", pc([], { status: "failed" }), true],
    ["failed inventory", pc([], {}, undefined, { status: "failed" }), true],
    ["inventory scanning", pc([], {}, undefined, { status: "scanning" }), true],
    ["PC scan running", pc([], {}, active(target)), true],
    ["PC scan queued", pc([], {}, { active: null, queued: [target] }), true],
    ["only a project scanning", pc([], {}, active(projectTarget)), false],
    ["only a project queued", pc([], {}, { active: null, queued: [projectTarget] }), false],
  ];
  for (const [label, state, unverified] of states) {
    assert.equal(pcUpdatesUnverified(state), unverified, label);
    // Update now says which hold applies: a lost connection outranks the PC's own results.
    assert.equal(
      pcUpdateHold(true, state),
      unverified ? "Finish a successful PC scan" : null,
      label,
    );
    assert.equal(pcUpdateHold(false, state), "Reconnect to the coordinator", label);
    const installed = { ...state, inventory: { ...state.inventory, installations: [tool()] } };
    assert.deepEqual(
      findingUpgradeCommands(pcUpdate, null, installed).map((option) => option.command),
      unverified ? [] : ["npm install --global tool@1.1.0"],
      label,
    );
    // Project results carry their own verification: a failed PC check does not withhold them.
    assert.deepEqual(
      findingUpgradeCommands(update, project([dependency()]), installed).map(
        (option) => option.command,
      ),
      ["pnpm add tool@1.1.0"],
      label,
    );
  }
});

test("This PC commands follow the installation behind a finding, one per manager", () => {
  const { tool, pc, pcUpdate } = upgradeFixture();
  const both = pc([tool(), tool({ id: "tool-bun", manager: "bun", source: "bun" })]);
  assert.deepEqual(findingUpgradeCommands(pcUpdate, null, both), [
    { where: "npm", command: "npm install --global tool@1.1.0", version: "1.1.0" },
    { where: "Bun", command: "bun add --global tool@1.1.0", version: "1.1.0" },
  ]);
  assert.deepEqual(
    findingUpgradeCommands(
      pcUpdate,
      null,
      pc([
        tool({ updateStatus: "unknown" }),
        tool({ version: "0.9.0" }),
        tool({ name: "other" }),
        tool({ origin: "local" }),
      ]),
    ),
    [],
  );
  assert.deepEqual(
    findingUpgradeCommands({ ...pcUpdate, packageName: "different" }, null, pc([tool()])),
    [],
  );
  assert.deepEqual(
    findingUpgradeCommands({ ...pcUpdate, kind: "coverage" }, null, pc([tool()])),
    [],
  );
});

test("row action names say what the row is and stay unique within a table", () => {
  const finding = (
    id: string,
    name: string,
    kind: Finding["kind"],
    severity: Finding["severity"] = "info",
  ): Finding => ({
    id,
    kind,
    subjectId: "project",
    subjectLabel: "Project",
    name,
    packageName: name,
    installedVersion: "1.0.0",
    availableVersion: null,
    severity,
    source: "OSV",
    description: "",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00Z",
    lastSeenAt: "2026-10-08T00:00:00Z",
  });
  assert.equal(findingSummary(finding("a", "x", "update")), "Update available");
  assert.equal(findingSummary(finding("a", "x", "advisory", "low")), "Low advisory");
  assert.equal(findingSummary(finding("a", "x", "advisory", "unknown")), "Unknown severity");
  assert.equal(findingSummary(finding("a", "x", "coverage")), "Incomplete check");

  // The same package can have an update and an advisory, and the same finding once per workspace.
  const rows = [
    finding("1", "effect", "update"),
    finding("2", "effect", "update"),
    finding("3", "@types/node", "update"),
    finding("4", "@types/node", "advisory", "low"),
    finding("5", "effect", "update"),
  ];
  const labels = uniqueRowLabels(
    rows,
    (row) => `${row.name}, ${findingSummary(row)}`,
    (row) => row.id,
  );
  assert.deepEqual(
    rows.map((row) => labels.get(row.id)),
    [
      "effect, Update available (1 of 3)",
      "effect, Update available (2 of 3)",
      "@types/node, Update available",
      "@types/node, Low advisory",
      "effect, Update available (3 of 3)",
    ],
  );
  assert.equal(new Set(labels.values()).size, rows.length);
  // A list with no repeats is left alone, and an empty list is empty.
  assert.deepEqual(
    [
      ...uniqueRowLabels(
        ["a", "b"],
        (item) => item,
        (item) => item,
      ).values(),
    ],
    ["a", "b"],
  );
  assert.equal(
    uniqueRowLabels(
      [],
      (item: string) => item,
      (item) => item,
    ).size,
    0,
  );
});

const lifecycleHosts = ["session", "boot-task", "unconfigured"] as const;

test("Background service describes startup and sign-out for the host's own platform", () => {
  const titles = (platform: string, host: (typeof lifecycleHosts)[number], desktop: boolean) =>
    lifecycleRows(platform, host, desktop).map((row) => row.title);
  assert.deepEqual(titles("win32", "session", true), [
    "Windows boot",
    "When the window closes",
    "After Windows sign-out",
    "Account and folder coverage",
  ]);
  // A browser has no tray, so the sentence about it goes.
  assert.deepEqual(titles("win32", "boot-task", false), [
    "Windows boot",
    "After Windows sign-out",
    "Account and folder coverage",
  ]);
  const boot = lifecycleRows("win32", "boot-task", false);
  assert.deepEqual(boot[0]?.badge, { label: "Boot host", tone: "info" });
  assert.deepEqual(boot[1]?.badge, { label: "Verify access", tone: "info" });
  const session = lifecycleRows("win32", "session", false);
  assert.deepEqual(session[0]?.badge, { label: "Setup required", tone: "warning" });
  assert.deepEqual(session[1]?.badge, { label: "Not configured", tone: "warning" });
  for (const host of lifecycleHosts) {
    assert.deepEqual(titles("darwin", host, true), [
      "macOS login",
      "When the window closes",
      "After logout",
    ]);
    assert.deepEqual(titles("linux", host, false), ["Linux startup", "After logout"]);
    assert.deepEqual(titles("freebsd", host, false), ["After sign-out"]);
  }
  assert.deepEqual(lifecycleRows("darwin", "boot-task", false)[0]?.badge, {
    label: "LaunchAgent",
    tone: "info",
  });
  assert.deepEqual(lifecycleRows("linux", "boot-task", false)[0]?.badge, {
    label: "User service",
    tone: "info",
  });
  assert.deepEqual(lifecycleRows("linux", "session", false)[0]?.badge, {
    label: "Setup required",
    tone: "warning",
  });
  // Only the LaunchAgent starts again at login: a session coordinator on a Mac ends at logout.
  const macLogout = (host: (typeof lifecycleHosts)[number]) =>
    lifecycleRows("darwin", host, false).at(-1);
  assert.match(macLogout("boot-task")?.text ?? "", /stops LaunchAgents when you log out/);
  assert.deepEqual(macLogout("boot-task")?.badge, { label: "Login session only", tone: "neutral" });
  for (const host of ["session", "unconfigured"] as const) {
    assert.match(
      macLogout(host)?.text ?? "",
      /Monitoring ends at logout\. Install the LaunchAgent host to start it again at your next login\./,
      host,
    );
    assert.doesNotMatch(macLogout(host)?.text ?? "", /pauses until you log in again/, host);
    assert.deepEqual(macLogout(host)?.badge, { label: "Not configured", tone: "warning" }, host);
  }
});

test("macOS and Linux name their own background host and never Windows or PowerShell", () => {
  for (const platform of ["darwin", "linux"])
    for (const host of lifecycleHosts)
      for (const desktop of [true, false]) {
        const text = [
          ...lifecycleRows(platform, host, desktop).flatMap((row) => [
            row.title,
            row.text,
            row.badge?.label ?? "",
          ]),
          lifecycleNote(platform),
          backgroundSummary({
            host,
            mode: host === "boot-task" ? "background" : "interactive",
            platform,
          }),
          restartAdvice(host, desktop, platform),
          ...Object.values(backgroundSetup(platform) ?? {}),
          hostLabel(host, platform),
          bootHostBadge(platform),
        ].join("\n");
        const where = `${platform} ${host} ${desktop}`;
        assert.doesNotMatch(text, /Windows|PowerShell/, where);
        assert.match(text, /sleeping or powered-off PC cannot scan/, where);
        assert.match(lifecycleNote(platform), /node scripts\/background-host\.mjs/, where);
        // A Mac host starts at login, so nothing on a Mac may call it a boot host.
        if (platform === "darwin") assert.doesNotMatch(text, /boot/i, where);
      }
  assert.match(
    lifecycleRows("darwin", "boot-task", false).at(-1)?.text ?? "",
    /stops LaunchAgents when you log out/,
  );
  // The "Verify lingering" row says how to verify it.
  assert.match(
    lifecycleRows("linux", "boot-task", false).at(-1)?.text ?? "",
    /lingering.*node scripts\/background-host\.mjs status.*keyring until you log in/s,
  );
  for (const host of lifecycleHosts)
    assert.match(
      lifecycleRows("freebsd", host, false)
        .map((row) => row.text)
        .join("\n"),
      /not available yet on this platform/,
    );
  assert.match(lifecycleNote("win32"), /Windows setup command/);
  for (const platform of ["win32", "freebsd"])
    assert.match(lifecycleNote(platform), /sleeping or powered-off PC cannot scan/, platform);
});

test("the Connections summary names each platform's own background host", () => {
  const session = { host: "session", mode: "interactive" } as const;
  assert.match(
    backgroundSummary({ ...session, platform: "win32" }),
    /Install the Windows boot host/,
  );
  assert.match(
    backgroundSummary({ host: "boot-task", mode: "background", platform: "win32" }),
    /Windows boot host is configured/,
  );
  assert.match(
    backgroundSummary({ ...session, platform: "darwin" }),
    /Install the LaunchAgent host/,
  );
  assert.match(
    backgroundSummary({ host: "boot-task", mode: "background", platform: "darwin" }),
    /LaunchAgent host is configured/,
  );
  assert.match(backgroundSummary({ ...session, platform: "linux" }), /systemd user service/);
  assert.match(
    backgroundSummary({ host: "boot-task", mode: "background", platform: "linux" }),
    /systemd user service is configured.*lingering/,
  );
  assert.match(
    backgroundSummary({ host: "session", mode: "background", platform: "darwin" }),
    /Background host/,
  );
  assert.match(
    backgroundSummary({ ...session, platform: "freebsd" }),
    /not available yet on this platform/,
  );
});

test("the startup setup command and host label follow the coordinator's platform", () => {
  assert.equal(
    backgroundSetup("win32")?.command,
    ".\\scripts\\windows-background.ps1 -Action Install",
  );
  assert.equal(backgroundSetup("darwin")?.command, "node scripts/background-host.mjs install");
  assert.equal(
    backgroundSetup("linux")?.command,
    "node scripts/background-host.mjs install --linger",
  );
  assert.equal(backgroundSetup("freebsd"), null);
  assert.equal(hostLabel("boot-task", "win32"), "Windows boot task");
  assert.equal(hostLabel("boot-task", "darwin"), "macOS LaunchAgent");
  assert.equal(hostLabel("boot-task", "linux"), "systemd user service");
  assert.equal(hostLabel("boot-task", "freebsd"), "Background host");
  for (const platform of ["win32", "darwin", "linux", "freebsd"])
    assert.equal(hostLabel("session", platform), "Signed-in session");
});

test("a connected background host has one badge per platform, shared by every place that labels it", () => {
  assert.equal(bootHostBadge("win32"), "Boot host");
  assert.equal(bootHostBadge("darwin"), "LaunchAgent");
  assert.equal(bootHostBadge("linux"), "User service");
  assert.equal(bootHostBadge("freebsd"), "Background host");
  // The first row of Background service wears the same badge as the Connections chip and the
  // sidebar (`${badge} connected`), so none of the three can name a host differently.
  for (const platform of ["win32", "darwin", "linux"])
    assert.deepEqual(lifecycleRows(platform, "boot-task", false)[0]?.badge, {
      label: bootHostBadge(platform),
      tone: "info",
    });
});

test("the sharing dialog names the firewall of the coordinator's platform", () => {
  assert.equal(firewallName("win32"), "Windows Firewall");
  for (const platform of ["darwin", "linux", "freebsd"])
    assert.equal(firewallName(platform), "your firewall");
});

test("a platform with no background host of its own gets no other platform's wording", () => {
  for (const host of lifecycleHosts)
    for (const desktop of [true, false]) {
      const text = [
        ...lifecycleRows("freebsd", host, desktop).flatMap((row) => [
          row.title,
          row.text,
          row.badge?.label ?? "",
        ]),
        lifecycleNote("freebsd"),
        backgroundSummary({
          host,
          mode: host === "boot-task" ? "background" : "interactive",
          platform: "freebsd",
        }),
        restartAdvice(host, desktop, "freebsd"),
        hostLabel(host, "freebsd"),
        bootHostBadge("freebsd"),
      ].join("\n");
      assert.doesNotMatch(
        text,
        /Windows|PowerShell|boot|LaunchAgent|systemd|background-host\.mjs/i,
        `freebsd ${host} ${desktop}`,
      );
    }
});

test("the tray is mentioned only in the desktop app, on every platform and host, as the menu bar on macOS", () => {
  for (const platform of ["win32", "darwin", "linux"])
    for (const host of lifecycleHosts) {
      const words = (desktop: boolean) =>
        lifecycleRows(platform, host, desktop)
          .map((row) => `${row.title} ${row.text} ${row.badge?.label ?? ""}`)
          .join("\n");
      const where = `${platform} ${host}`;
      assert.doesNotMatch(words(false), /tray|menu bar/i, `${where} in a browser`);
      if (platform === "darwin") {
        assert.match(words(true), /menu bar/i, `${where} in the desktop app`);
        assert.doesNotMatch(words(true), /tray/i, `${where}: a Mac has no system tray`);
      } else assert.match(words(true), /tray/i, `${where} in the desktop app`);
    }
  // A Windows session without a boot host still says that sign-out ends monitoring.
  assert.match(
    lifecycleRows("win32", "session", false)[1]?.text ?? "",
    /Monitoring ends at sign-out/,
  );
  assert.match(
    lifecycleRows("win32", "session", true)[2]?.text ?? "",
    /A tray process cannot survive/,
  );
});

test("the older-build advice names the tray only in the desktop app, and the menu bar on macOS", () => {
  for (const platform of ["win32", "darwin", "linux"])
    for (const host of lifecycleHosts)
      assert.doesNotMatch(
        restartAdvice(host, false, platform),
        /tray|menu bar/i,
        `${platform} ${host} in a browser`,
      );
  for (const host of ["session", "unconfigured"] as const) {
    assert.match(restartAdvice(host, true, "win32"), /Quit Versionstead UI from the tray/);
    assert.match(restartAdvice(host, true, "linux"), /Quit Versionstead UI from the tray/);
    assert.match(
      restartAdvice(host, true, "darwin"),
      /Quit Versionstead UI from the menu bar icon/,
    );
  }
  // A boot host is restarted with its own script, whoever is looking.
  for (const desktop of [true, false]) {
    assert.match(restartAdvice("boot-task", desktop, "win32"), /-Action Restart/);
    assert.doesNotMatch(restartAdvice("boot-task", desktop, "win32"), /tray/i);
    for (const platform of ["darwin", "linux"])
      assert.equal(
        restartAdvice("boot-task", desktop, platform),
        "Run node scripts/background-host.mjs restart from the Versionstead project folder.",
      );
  }
  // A browser still gets a step it can follow.
  assert.match(restartAdvice("session", false, "win32"), /Restart the coordinator/);
});

test("lifecycle findings have their own count, filter, and support-state wording", () => {
  const base: Finding = {
    id: "node",
    kind: "lifecycle",
    subjectId: "project",
    subjectLabel: "Project",
    name: "Node.js 20",
    packageName: null,
    installedVersion: ">=20",
    availableVersion: null,
    severity: "high",
    source: "endoflife.date",
    description: "Node.js 20 reached end of life on 2026-04-30.",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00Z",
    lastSeenAt: "2026-10-08T12:00:00Z",
    effectiveDate: "2026-04-30",
  };
  const soon: Finding = {
    ...base,
    id: "electron",
    name: "Electron 42",
    severity: "moderate",
    effectiveDate: "2026-10-20",
  };
  const leaving: Finding = {
    ...base,
    id: "node-24",
    name: "Node.js 24",
    severity: "low",
    effectiveDate: "2026-10-20",
  };
  const left: Finding = {
    ...base,
    id: "node-22",
    name: "Node.js 22",
    severity: "low",
    effectiveDate: "2025-10-21",
  };
  const deprecated: Finding = {
    ...base,
    id: "request",
    name: "request",
    packageName: "request",
    installedVersion: "2.88.2",
    severity: "low",
    source: "npm registry",
    description: "Deprecated by its publisher: request has been deprecated.",
  };
  assert.deepEqual([base, soon, leaving, left, deprecated].map(findingSummary), [
    "End of life",
    "End of life soon",
    "Leaving active support",
    "Out of active support",
    "Deprecated",
  ]);
  assert.equal(supportStateLabel(deprecated), "Deprecated");
  assert.deepEqual(findingCounts([base, soon, deprecated], "pc"), {
    packages: 1,
    updates: 0,
    advisories: 0,
    lifecycle: 3,
    other: 0,
    incomplete: 0,
  });
  assert.deepEqual(attentionSearch({ filter: "lifecycle" }), { filter: "lifecycle" });
  const dependency: Dependency = {
    id: "dep",
    name: "request",
    packageName: "request",
    requested: "^2.88.0",
    resolved: "2.88.2",
    origin: "registry",
    role: "production",
    importer: ".",
    availableVersion: null,
    latestVersion: null,
    versionStatus: "checked",
    advisoryStatus: "checked",
    advisoryIds: [],
  };
  assert.deepEqual(
    dependencyFindings(dependency, [base, deprecated]).map((f) => f.id),
    ["request"],
    "A runtime notice is not a dependency's finding",
  );
  assert.deepEqual(
    dependencyFindings({ ...dependency, availableVersion: "2.88.3" }, [base, deprecated]).map(
      (f) => f.id,
    ),
    ["request"],
    "A pending update does not hide a deprecation",
  );
  const evidence: ScanEvidence = {
    status: "complete",
    lastAttempt: "2026-10-08T12:00:00Z",
    lastSuccess: "2026-10-08T12:00:00Z",
    coverage: [],
    errors: [],
  };
  const project: Project = {
    id: "project",
    name: "Project",
    path: "C:\\project",
    mode: "maintained",
    packageManager: "npm",
    manifestPath: null,
    lockfilePath: null,
    evidence,
    dependencies: [dependency],
    createdAt: "2026-10-08T12:00:00Z",
  };
  const snapshot: MonitoringSnapshot = {
    protocolVersion: 1,
    runtime: {
      startedAt: "2026-10-08T12:00:00Z",
      mode: "interactive",
      host: "session",
      platform: "win32",
      nextScanAt: null,
    },
    device: { id: "pc", label: "PC", platform: "win32" },
    settings: {
      paused: false,
      pcIntervalMinutes: 60,
      projectIntervalMinutes: 60,
      notifyNewFindings: true,
    },
    inventory: { evidence, updateEvidence: evidence, installations: [] },
    projects: [project],
    findings: [deprecated, base],
    history: [],
    notifications: [],
  };
  assert.deepEqual(
    attentionGroups(snapshot, "lifecycle").map((group) => group.findings.map((f) => f.id)),
    [["node", "request"]],
  );
  assert.deepEqual(attentionGroups(snapshot, "updates"), []);
});

test("a deprecation belongs to its dependency but is never offered an upgrade command", () => {
  const { dependency, project, update, pc } = upgradeFixture();
  const deprecated: Finding = {
    ...update,
    id: "deprecated",
    kind: "lifecycle",
    availableVersion: null,
    severity: "low",
  };
  // The dependency has a checked candidate, which would be its update finding's command.
  assert.deepEqual(
    dependencyFindings(dependency(), [update, deprecated]).map((finding) => finding.id),
    ["update", "deprecated"],
  );
  assert.deepEqual(findingUpgradeCommands(deprecated, project([dependency()]), pc()), []);
  assert.deepEqual(findingUpgradeCommands(update, project([dependency()]), pc()), [
    { where: "root", command: "pnpm add tool@1.1.0", version: "1.1.0" },
  ]);
});

test("a malformed effective date from a paired PC reads as undated instead of misleading or throwing", () => {
  for (const day of ["2026-10-20", "2024-02-29", "0001-01-01", "9999-12-31"])
    assert.equal(isEffectiveDay(day), true, day);
  const malformed = [
    "",
    "soon",
    "20261020",
    "2026-1-5",
    " 2026-10-20",
    "2026-10-20\n",
    "2026-10-20T00:00:00Z",
    "2026-13-45",
    "2026-00-10",
    "2026-10-00",
    // A real parser would roll these over into the next month; they are not days.
    "2026-02-31",
    "2026-02-29",
    "2026-04-31",
    "9".repeat(100_000),
  ];
  assert.equal(isEffectiveDay(undefined), false);
  for (const value of malformed) assert.equal(isEffectiveDay(value), false, value.slice(0, 24));

  const low = { severity: "low", packageName: null, lastSeenAt: "2026-10-08T12:00:00Z" } as const;
  assert.equal(supportStateLabel(low), "Out of active support");
  assert.equal(
    supportStateLabel({ ...low, effectiveDate: "2026-10-20" }),
    "Leaving active support",
  );
  assert.equal(supportStateLabel({ ...low, effectiveDate: "2026-10-08" }), "Out of active support");
  // A day that cannot be read never makes a runtime look as if it is leaving support later.
  for (const effectiveDate of [...malformed, "9999-99-99", "zzzz"])
    assert.equal(
      supportStateLabel({ ...low, effectiveDate }),
      "Out of active support",
      effectiveDate.slice(0, 24),
    );
  assert.equal(
    supportStateLabel({ ...low, lastSeenAt: "not a time", effectiveDate: "2026-10-20" }),
    "Out of active support",
  );
  // Severity, not the date, decides the end-of-life states, so a bad date cannot change them.
  for (const effectiveDate of ["2026-10-20", "soon"]) {
    assert.equal(supportStateLabel({ ...low, severity: "high", effectiveDate }), "End of life");
    assert.equal(
      supportStateLabel({ ...low, severity: "moderate", effectiveDate }),
      "End of life soon",
    );
  }
});

test("a finding kind from a newer Versionstead is counted and named generically", () => {
  const other: Finding = {
    id: "drift",
    kind: "other",
    subjectId: "project",
    subjectLabel: "Project",
    name: "typescript",
    packageName: "typescript",
    installedVersion: "5.4.0",
    availableVersion: null,
    severity: "info",
    source: "Version drift",
    description: "Resolved at different versions across projects.",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00Z",
    lastSeenAt: "2026-10-08T00:00:00Z",
  };
  assert.equal(findingSummary(other), "Other finding");
  assert.deepEqual(findingCounts([other], "pc"), {
    packages: 1,
    updates: 0,
    advisories: 0,
    lifecycle: 0,
    other: 1,
    incomplete: 0,
  });
  // Only a finding that names a package is a package observation.
  assert.equal(findingCounts([{ ...other, packageName: null }], "pc").packages, 0);
  assert.equal(findingCounts([{ ...other, packageName: null }], "pc").other, 1);

  // It belongs to All findings and to no other filter.
  const evidence: ScanEvidence = {
    status: "complete",
    lastAttempt: "2026-10-08T00:00:00Z",
    lastSuccess: "2026-10-08T00:00:00Z",
    coverage: [],
    errors: [],
  };
  const snapshot: MonitoringSnapshot = {
    protocolVersion: 1,
    runtime: {
      startedAt: evidence.lastAttempt!,
      mode: "interactive",
      host: "session",
      platform: "win32",
      nextScanAt: null,
    },
    device: { id: "pc", label: "PC", platform: "win32" },
    settings: {
      paused: false,
      pcIntervalMinutes: 60,
      projectIntervalMinutes: 60,
      notifyNewFindings: true,
    },
    inventory: { evidence, installations: [] },
    projects: [],
    findings: [{ ...other, subjectId: "pc", subjectLabel: "PC" }],
    history: [],
    notifications: [],
  };
  assert.deepEqual(
    attentionGroups(snapshot).map((group) => [group.id, group.counts.other]),
    [["pc", 1]],
  );
  for (const filter of ["updates", "advisories", "lifecycle", "coverage"] as const)
    assert.deepEqual(attentionGroups(snapshot, filter), [], filter);
});

test("a project's runtime notices are its lifecycle findings that name no package, most severe first", () => {
  const finding = (
    id: string,
    kind: Finding["kind"],
    name: string,
    severity: Finding["severity"],
    packageName: string | null = null,
  ): Finding => ({
    id,
    kind,
    subjectId: "project",
    subjectLabel: "Project",
    name,
    packageName,
    installedVersion: ">=20",
    availableVersion: null,
    severity,
    source: "endoflife.date",
    description: "",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00Z",
    lastSeenAt: "2026-10-08T00:00:00Z",
  });
  const findings = [
    finding("node-24", "lifecycle", "Node.js 24", "low"),
    finding("request", "lifecycle", "request", "low", "request"),
    finding("update", "update", "tool", "info", "tool"),
    finding("drift", "other", "Registry policy", "high"),
    finding("electron", "lifecycle", "Electron 42", "moderate"),
    finding("node-20", "lifecycle", "Node.js 20", "high"),
    finding("bun", "lifecycle", "Bun 1", "low"),
    finding("gaps", "coverage", "Incomplete checks", "unknown"),
  ];
  // A deprecation belongs to its dependency, and a package-less finding of an unknown kind is no runtime line.
  assert.deepEqual(
    runtimeNotices(findings).map((notice) => notice.name),
    ["Node.js 20", "Electron 42", "Bun 1", "Node.js 24"],
  );
  assert.deepEqual(runtimeNotices([]), []);
  assert.deepEqual(
    runtimeNotices(findings.filter((item) => item.id !== "node-20" && item.id !== "electron"))
      .map((notice) => findingSummary(notice))
      .sort(),
    ["Out of active support", "Out of active support"],
  );
  assert.equal(findings[0]!.id, "node-24", "The project's own list is not reordered");
});

test("a global tool's findings match its name, package, installed version and manager source", () => {
  const update: Finding = {
    id: "update",
    kind: "update",
    subjectId: "pc",
    subjectLabel: "PC",
    name: "tsx",
    packageName: "tsx",
    installedVersion: "4.0.0",
    availableVersion: "4.1.0",
    severity: "info",
    source: "npm global",
    description: "",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00Z",
    lastSeenAt: "2026-10-08T00:00:00Z",
  };
  const findings: Finding[] = [
    update,
    { ...update, id: "deprecated", kind: "lifecycle", availableVersion: null, severity: "low" },
    { ...update, id: "bun", source: "bun global" },
    { ...update, id: "older", installedVersion: "3.0.0" },
    { ...update, id: "project", subjectId: "project" },
  ];
  const tool = {
    name: "tsx",
    packageId: "tsx",
    version: "4.0.0",
    source: "npm global",
    availableVersion: "4.1.0",
  };
  assert.deepEqual(
    installationFindings(findings, "pc", tool).map((finding) => finding.id),
    ["update", "deprecated"],
  );
  // The other kinds and the other identities of the same tool are not this installation's.
  const others: Finding[] = [
    { ...update, id: "advisory", kind: "advisory" },
    { ...update, id: "coverage", kind: "coverage" },
    { ...update, id: "other", kind: "other" },
    { ...update, id: "renamed", name: "tsx-alias" },
    { ...update, id: "aliased", packageName: "@scope/tsx" },
  ];
  assert.deepEqual(installationFindings(others, "pc", tool), []);
  // A tool with no package identity claims none of a package's findings.
  assert.deepEqual(installationFindings(findings, "pc", { ...tool, packageId: undefined }), []);
  assert.deepEqual(installationFindings([], "pc", tool), []);
});

test("a global tool's update is the finding for its current candidate, never a stale one", () => {
  const update: Finding = {
    id: "update",
    kind: "update",
    subjectId: "pc",
    subjectLabel: "PC",
    name: "tsx",
    packageName: "tsx",
    installedVersion: "4.0.0",
    availableVersion: "4.1.0",
    severity: "info",
    source: "npm global",
    description: "",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00Z",
    lastSeenAt: "2026-10-08T00:00:00Z",
    installScript: true,
  };
  const stale: Finding = {
    ...update,
    id: "stale",
    availableVersion: "4.0.5",
    installScript: false,
  };
  const deprecated: Finding = {
    ...update,
    id: "deprecated",
    kind: "lifecycle",
    availableVersion: null,
    severity: "low",
  };
  const tool = {
    name: "tsx",
    packageId: "tsx",
    version: "4.0.0",
    source: "npm global",
    availableVersion: "4.1.0" as string | null,
  };
  const ids = (list: readonly Finding[]) => list.map((finding) => finding.id);
  // Whichever order they come in, the finding for the release that would be installed is its update.
  assert.equal(installationUpdate([update, stale, deprecated], "pc", tool)?.id, "update");
  assert.equal(installationUpdate([stale, deprecated, update], "pc", tool)?.id, "update");
  // The candidate moved on or went away: the old finding is no one's update, so the row marks
  // nothing and Update now has nothing to ask about.
  const moved = { ...tool, availableVersion: "4.2.0" };
  assert.equal(installationUpdate([update, stale], "pc", moved), undefined);
  assert.equal(
    installationUpdate([update, stale], "pc", { ...tool, availableVersion: null }),
    undefined,
  );
  assert.equal(
    installationUpdate([{ ...update, availableVersion: null }], "pc", {
      ...tool,
      availableVersion: null,
    }),
    undefined,
    "No candidate on either side is not a match",
  );
  // Everything that lists the tool's findings applies the same match; its deprecation is its own,
  // whatever the candidate.
  assert.deepEqual(ids(installationFindings([update, stale, deprecated], "pc", tool)), [
    "update",
    "deprecated",
  ]);
  assert.deepEqual(ids(installationFindings([update, stale, deprecated], "pc", moved)), [
    "deprecated",
  ]);
  // Another PC, manager, version, name or package is another tool's update.
  for (const other of [
    { subjectId: "project" },
    { source: "bun global" },
    { installedVersion: "3.0.0" },
    { name: "tsx-alias" },
    { packageName: "@scope/tsx" },
    { kind: "advisory" as const },
  ])
    assert.equal(
      installationUpdate([{ ...update, ...other }], "pc", tool),
      undefined,
      JSON.stringify(other),
    );
  assert.equal(installationUpdate([], "pc", tool), undefined);
});

test("a global tool that is both outdated and deprecated is one package, as in a project", () => {
  const update: Finding = {
    id: "tsx-update",
    kind: "update",
    subjectId: "pc",
    subjectLabel: "PC",
    name: "tsx",
    packageName: "tsx",
    installedVersion: "4.0.0",
    availableVersion: "4.1.0",
    severity: "info",
    source: "npm global",
    description: "",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00Z",
    lastSeenAt: "2026-10-08T00:00:00Z",
  };
  const deprecated: Finding = {
    ...update,
    id: "tsx-deprecated",
    kind: "lifecycle",
    availableVersion: null,
    severity: "low",
    description: "Deprecated by its publisher: Use tsx 5.",
  };
  assert.deepEqual(findingCounts([update, deprecated], "pc"), {
    packages: 1,
    updates: 1,
    advisories: 0,
    lifecycle: 1,
    other: 0,
    incomplete: 0,
  });
  // A project's two findings on one package were already one package.
  assert.equal(
    findingCounts(
      [
        { ...update, subjectId: "project" },
        { ...deprecated, subjectId: "project" },
      ],
      "pc",
    ).packages,
    1,
  );
  // Another version, manager, package or name is another tool.
  for (const other of [
    { installedVersion: "3.0.0" },
    { source: "bun global" },
    { name: "eslint", packageName: "eslint" },
    { name: "tsx-old" },
    { packageName: "@scope/tsx" },
  ])
    assert.equal(
      findingCounts([update, deprecated, { ...update, id: "other", ...other }], "pc").packages,
      2,
      JSON.stringify(other),
    );
  // A runtime line's lifecycle notice names no package, so it is not one.
  assert.equal(
    findingCounts([update, { ...deprecated, id: "node", packageName: null }], "pc").packages,
    1,
  );
});

test("snoozed and ignored findings leave counts and badges, and a snoozed gap keeps its status", () => {
  const evidence: ScanEvidence = {
    status: "complete",
    lastAttempt: "2026-10-08T12:00:00Z",
    lastSuccess: "2026-10-08T12:00:00Z",
    coverage: [],
    errors: [],
  };
  const partial: ScanEvidence = {
    ...evidence,
    status: "partial",
    errors: ["Known-advisory lookup failed."],
  };
  const project = (id: string, projectEvidence: ScanEvidence): Project => ({
    id,
    name: id,
    path: `C:\\${id}`,
    mode: "maintained",
    packageManager: "npm",
    manifestPath: null,
    lockfilePath: null,
    evidence: projectEvidence,
    dependencies: [],
    createdAt: "2026-10-08T12:00:00Z",
  });
  const base: Finding = {
    id: "update",
    kind: "update",
    subjectId: "app",
    subjectLabel: "app",
    name: "left-pad",
    packageName: "left-pad",
    installedVersion: "1.0.0",
    availableVersion: "1.3.0",
    severity: "info",
    source: "npm registry",
    description: "A newer version satisfies the requested range.",
    advisoryUrl: null,
    detectedAt: "2026-10-08T12:00:00Z",
    lastSeenAt: "2026-10-08T12:00:00Z",
  };
  const update: Finding = { ...base, ruleId: "snooze" };
  const advisory: Finding = {
    ...base,
    id: "advisory",
    kind: "advisory",
    severity: "high",
    advisoryUrl: "https://osv.dev/vulnerability/GHSA-1",
  };
  const gap: Finding = {
    ...base,
    id: "gap",
    kind: "coverage",
    subjectId: "partial",
    subjectLabel: "partial",
    name: "Incomplete checks",
    packageName: null,
    installedVersion: null,
    availableVersion: null,
    severity: "unknown",
    source: "Project collector",
    description: "Known-advisory lookup failed.",
    ruleId: "gap-snooze",
  };
  const snapshot: MonitoringSnapshot = {
    protocolVersion: 1,
    runtime: {
      startedAt: "2026-10-08T12:00:00Z",
      mode: "interactive",
      host: "session",
      platform: "win32",
      nextScanAt: null,
    },
    device: { id: "pc", label: "PC", platform: "win32" },
    settings: {
      paused: false,
      pcIntervalMinutes: 60,
      projectIntervalMinutes: 60,
      notifyNewFindings: true,
    },
    inventory: { evidence, updateEvidence: evidence, installations: [] },
    projects: [project("app", evidence), project("partial", partial)],
    findings: [update, advisory, gap],
    history: [],
    notifications: [],
    findingRules: [
      {
        id: "snooze",
        scope: { subjectId: "app", kind: "update", packageName: "left-pad" },
        mode: "snooze",
        until: "2026-11-07T12:00:00.000Z",
        createdAt: "2026-10-08T12:00:00.000Z",
      },
      {
        id: "gap-snooze",
        scope: {
          subjectId: "partial",
          kind: "coverage",
          packageName: "Incomplete checks",
          detail: "digest",
        },
        mode: "snooze",
        until: "2026-10-15T12:00:00.000Z",
        createdAt: "2026-10-08T12:00:00.000Z",
      },
    ],
  };
  const groups = attentionGroups(snapshot);
  assert.deepEqual(
    groups.map((group) => [group.id, group.findings.map((f) => f.id)]),
    [["app", ["advisory"]]],
  );
  assert.deepEqual(groups[0]!.counts, {
    packages: 1,
    updates: 0,
    advisories: 1,
    lifecycle: 0,
    other: 0,
    incomplete: 0,
  });
  assert.deepEqual(attentionGroups(snapshot, "updates"), [], "A hidden update leaves Updates");
  assert.deepEqual(
    attentionGroups(snapshot, "coverage"),
    [],
    "A snoozed gap leaves Incomplete checks",
  );
  const hidden = attentionGroups(snapshot, "suppressed");
  assert.deepEqual(
    hidden.map((group) => [group.id, group.findings.map((f) => f.id)]),
    [
      ["app", ["update"]],
      ["partial", ["gap"]],
    ],
  );
  assert.equal(hidden[1]!.evidence.status, "partial", "Snoozing never turns a gap into clean");
  assert.deepEqual(
    attentionGroups(snapshot, "suppressed", "LEFT-PAD").map((group) => group.id),
    ["app"],
    "Search narrows the hidden view like the others",
  );
  assert.equal(suppressedCount(snapshot), 2);
  assert.equal(suppressedCount({ findings: [advisory] }), 0);
  assert.deepEqual(attentionSearch({ filter: "suppressed" }), { filter: "suppressed" });

  // The date reads in local time, so the expected label comes from the same formatter.
  const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
  assert.equal(
    ruleLabel(snapshot.findingRules![0]!),
    `Snoozed until ${day.format(new Date("2026-11-07T12:00:00.000Z"))}`,
  );
  // It is the owner's local day even when UTC is already on another one, in any zone.
  for (const hour of [0, 23])
    assert.equal(
      ruleLabel({ mode: "snooze", until: new Date(2026, 10, 7, hour, 30).toISOString() }),
      "Snoozed until Nov 7",
    );
  assert.equal(
    ruleLabel({ mode: "snooze", untilVersion: "1.3.0" }),
    "Snoozed until a version newer than 1.3.0",
  );
  assert.equal(
    ruleLabel({ mode: "ignore", reason: "Pinned for compatibility" }),
    "Ignored: Pinned for compatibility",
  );
  assert.equal(ruleLabel({ mode: "ignore" }), "Ignored");
  // A rule without a readable end never throws while the page renders.
  assert.equal(ruleLabel({ mode: "snooze" }), "Snoozed");
  assert.equal(ruleLabel({ mode: "snooze", until: "not a date" }), "Snoozed");
});

test("a snoozed gap on This PC leaves the incomplete count and keeps its failed status", () => {
  const complete: ScanEvidence = {
    status: "complete",
    lastAttempt: "2026-10-08T12:00:00Z",
    lastSuccess: "2026-10-08T12:00:00Z",
    coverage: [],
    errors: [],
  };
  const gap: Finding = {
    id: "pc-gap",
    kind: "coverage",
    subjectId: "pc",
    subjectLabel: "PC",
    name: "Incomplete checks",
    packageName: null,
    installedVersion: null,
    availableVersion: null,
    severity: "unknown",
    source: "Global tool collector",
    description: "npm could not be run.",
    advisoryUrl: null,
    detectedAt: "2026-10-08T12:00:00Z",
    lastSeenAt: "2026-10-08T12:00:00Z",
  };
  const snapshot = (findings: Finding[]): MonitoringSnapshot => ({
    protocolVersion: 1,
    runtime: {
      startedAt: "2026-10-08T12:00:00Z",
      mode: "interactive",
      host: "session",
      platform: "win32",
      nextScanAt: null,
    },
    device: { id: "pc", label: "PC", platform: "win32" },
    settings: {
      paused: false,
      pcIntervalMinutes: 60,
      projectIntervalMinutes: 60,
      notifyNewFindings: true,
    },
    inventory: {
      evidence: { ...complete, status: "failed", errors: ["npm could not be run."] },
      updateEvidence: complete,
      installations: [],
    },
    projects: [],
    findings,
    history: [],
    notifications: [],
  });
  assert.equal(attentionGroups(snapshot([gap]), "coverage")[0]!.counts.incomplete, 1);
  // Only a snoozed gap lifts the count: a snoozed update never hides that the target is incomplete.
  const update: Finding = {
    ...gap,
    id: "pc-update",
    kind: "update",
    name: "tsx",
    packageName: "tsx",
    installedVersion: "4.0.0",
    availableVersion: "4.1.0",
    severity: "info",
    source: "npm global",
    description: "A newer version is available.",
    ruleId: "update-snooze",
  };
  assert.equal(attentionGroups(snapshot([update]), "coverage")[0]!.counts.incomplete, 1);
  const hidden = snapshot([{ ...gap, ruleId: "gap-snooze" }]);
  assert.deepEqual(attentionGroups(hidden), []);
  assert.deepEqual(attentionGroups(hidden, "coverage"), []);
  const view = attentionGroups(hidden, "suppressed");
  assert.deepEqual(
    view.map((group) => [group.id, group.findings.map((f) => f.id)]),
    [["pc", ["pc-gap"]]],
  );
  assert.equal(view[0]!.evidence.status, "failed", "Snoozing never turns a gap into clean");
});

test("snooze choices offer 7, 30 and 90 days, a newer version only for a SemVer update, and incomplete checks cannot be ignored", () => {
  const update = { kind: "update", availableVersion: "1.3.0" } as const;
  assert.deepEqual(
    snoozeChoices(update).map((choice) => choice.label),
    [
      "Snooze 7 days",
      "Snooze 30 days",
      "Snooze 90 days",
      "Snooze until a version newer than 1.3.0",
    ],
  );
  assert.deepEqual(snoozeChoices(update)[0]!.body, { mode: "snooze", days: 7 });
  assert.deepEqual(snoozeChoices(update)[3]!.body, { mode: "snooze", untilNewerVersion: true });
  assert.deepEqual(
    snoozeChoices(update)
      .slice(0, 3)
      .map((choice) => choice.body),
    [
      { mode: "snooze", days: 7 },
      { mode: "snooze", days: 30 },
      { mode: "snooze", days: 90 },
    ],
  );
  // A prerelease is still SemVer, so the snooze can wait for something newer than it.
  assert.equal(snoozeChoices({ kind: "update", availableVersion: "2.0.0-rc.1" }).length, 4);
  // Without a SemVer candidate there is nothing to wait past.
  assert.equal(snoozeChoices({ kind: "update", availableVersion: "latest" }).length, 3);
  assert.equal(snoozeChoices({ kind: "update", availableVersion: "v1.3.0" }).length, 3);
  assert.equal(snoozeChoices({ kind: "update", availableVersion: null }).length, 3);
  // Only an update has a candidate to wait past; every other kind snoozes by days alone.
  for (const kind of ["advisory", "lifecycle", "coverage", "other"] as const)
    assert.equal(snoozeChoices({ kind, availableVersion: "1.2.0" }).length, 3, kind);
  assert.equal(canIgnore({ kind: "coverage" }), false);
  for (const kind of ["update", "advisory", "lifecycle", "other"] as const)
    assert.equal(canIgnore({ kind }), true, kind);
});

test("a dependency whose update a snooze or ignore rule hides is held out of bulk commands", () => {
  const zod: Dependency = {
    id: "zod",
    name: "zod",
    packageName: "zod",
    requested: "^3.22.0",
    resolved: "3.22.0",
    origin: "registry",
    role: "production",
    importer: ".",
    availableVersion: "3.25.0",
    latestVersion: null,
    versionStatus: "checked",
    advisoryStatus: "checked",
    advisoryIds: [],
  };
  const lodash: Dependency = {
    ...zod,
    id: "lodash",
    name: "lodash",
    packageName: "lodash",
    resolved: "4.17.20",
    availableVersion: "4.17.21",
  };
  // Nothing was found for it, so nothing holds it.
  const quiet: Dependency = { ...zod, id: "quiet", name: "quiet", packageName: "quiet" };
  const update = (dependency: Dependency, ruleId?: string): Finding => ({
    id: `update-${dependency.id}`,
    kind: "update",
    subjectId: "project",
    subjectLabel: "Project",
    name: dependency.name,
    packageName: dependency.packageName,
    installedVersion: dependency.resolved,
    availableVersion: dependency.availableVersion,
    severity: "info",
    source: "npm registry",
    description: "A newer version satisfies the requested range.",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00Z",
    lastSeenAt: "2026-10-08T00:00:00Z",
    ...(ruleId === undefined ? {} : { ruleId }),
  });
  const project = { dependencies: [zod, lodash, quiet] };
  assert.deepEqual(
    [...heldDependencies(project, [update(zod, "snooze-1"), update(lodash)])],
    ["zod"],
  );
  assert.deepEqual([...heldDependencies(project, [update(zod), update(lodash)])], []);
  // Only a hidden update for the candidate the package has now holds it: a hidden advisory or
  // deprecation notice leaves the update available, and so does a rule for another version.
  assert.deepEqual(
    [
      ...heldDependencies(project, [
        { ...update(zod, "ignore-1"), kind: "advisory" },
        { ...update(lodash, "ignore-2"), kind: "lifecycle" },
        { ...update(zod, "snooze-3"), availableVersion: "3.26.0" },
      ]),
    ],
    [],
  );
});

test("New since last scan compares detection with each target's previous success; Resolved lists resolved findings", () => {
  const evidence = (previousSuccess?: string | null): ScanEvidence => ({
    status: "complete",
    lastAttempt: "2026-10-08T10:00:00Z",
    lastSuccess: "2026-10-08T10:05:00Z",
    ...(previousSuccess === undefined ? {} : { previousSuccess }),
    coverage: [],
    errors: [],
  });
  const project = (id: string, previousSuccess?: string | null): Project => ({
    id,
    name: id,
    path: `C:\\${id}`,
    mode: "maintained",
    packageManager: "npm",
    manifestPath: null,
    lockfilePath: null,
    evidence: evidence(previousSuccess),
    dependencies: [],
    createdAt: "2026-10-01T00:00:00Z",
  });
  const finding = (
    subjectId: string,
    id: string,
    detectedAt: string,
    extra: Partial<Finding> = {},
  ): Finding => ({
    id,
    kind: "update",
    subjectId,
    subjectLabel: subjectId,
    name: id,
    packageName: id,
    installedVersion: "1.0.0",
    availableVersion: "1.1.0",
    severity: "info",
    source: "npm registry",
    description: "A newer version satisfies the requested range.",
    advisoryUrl: null,
    detectedAt,
    lastSeenAt: detectedAt,
    ...extra,
  });
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
      pcIntervalMinutes: 60,
      projectIntervalMinutes: 60,
      notifyNewFindings: true,
    },
    inventory: { evidence: evidence("2026-10-07T10:05:00Z"), installations: [] },
    projects: [
      project("compared", "2026-10-07T10:05:00Z"),
      project("first", null),
      project("older"),
    ],
    findings: [
      finding("pc", "pc-new", "2026-10-08T10:01:00Z"),
      finding("pc", "pc-old", "2026-10-01T09:00:00Z"),
      finding("compared", "compared-new", "2026-10-08T10:02:00Z"),
      finding("compared", "compared-snoozed", "2026-10-08T10:02:00Z", { ruleId: "rule-1" }),
      finding("first", "first-any", "2026-10-01T09:00:00Z"),
      finding("older", "older-unknown", "2026-10-08T10:03:00Z"),
    ],
    resolvedFindings: [
      {
        ...finding("compared", "compared-fixed", "2026-10-01T09:00:00Z", {
          kind: "advisory",
          severity: "high",
        }),
        resolvedAt: "2026-10-08T10:05:00Z",
      },
      {
        ...finding("removed", "removed-fixed", "2026-10-01T09:00:00Z"),
        resolvedAt: "2026-10-08T10:05:00Z",
      },
    ],
    history: [],
    notifications: [],
  };
  const ids = (filter: AttentionFilter, query = "") =>
    attentionGroups(snapshot, filter, query).flatMap((group) => group.findings.map((f) => f.id));
  // Null: the latest success was the first, so all is new. Absent: unknown, so nothing is claimed.
  assert.deepEqual(ids("new"), ["pc-new", "compared-new", "first-any"]);
  assert.deepEqual(ids("resolved"), ["compared-fixed"], "a removed target's history is not shown");
  assert.deepEqual(ids("resolved", "nothing like this"), []);
  assert.ok(!ids("all").includes("compared-fixed"), "resolved findings are not current findings");
  assert.equal(isNewFinding({ detectedAt: "2026-10-08T10:02:00Z" }, undefined), false);
  assert.equal(isNewFinding({ detectedAt: "2026-10-01T00:00:00Z" }, null), true);
  // Detected at the previous success is not after it; a time that cannot be read claims nothing.
  assert.equal(isNewFinding({ detectedAt: "2026-10-07T10:05:00Z" }, "2026-10-07T10:05:00Z"), false);
  assert.equal(isNewFinding({ detectedAt: "2026-10-07T10:05:01Z" }, "2026-10-07T10:05:00Z"), true);
  assert.equal(isNewFinding({ detectedAt: "not a time" }, "2026-10-07T10:05:00Z"), false);
  assert.equal(isNewFinding({ detectedAt: "2026-10-08T10:02:00Z" }, "not a time"), false);
  assert.equal(
    findingTotal(
      attentionGroups(snapshot, "new").flatMap((g) => g.findings),
      "pc",
    ),
    3,
  );
  // A tab badge counts every kind: updates, advisories, lifecycle, unknown kinds and incomplete checks.
  assert.equal(
    findingTotal(
      (["update", "advisory", "lifecycle", "other", "coverage"] as const).map((kind) =>
        finding("compared", kind, "2026-10-08T10:02:00Z", { kind }),
      ),
      "pc",
    ),
    5,
  );
  assert.deepEqual(attentionSearch({ filter: "new" }), { filter: "new" });
  assert.deepEqual(attentionSearch({ filter: "resolved" }), { filter: "resolved" });
  assert.deepEqual(attentionSearch({ filter: "recent" }), {});
  // This PC compares against its inventory's previous success even while its update checks are
  // incomplete, and a target with nothing new or resolved stays out of both views however incomplete
  // it is.
  const incomplete = (status: ScanEvidence["status"]): ScanEvidence => ({
    ...evidence(),
    status,
    errors: ["A check did not finish."],
  });
  const gaps: MonitoringSnapshot = {
    ...snapshot,
    inventory: { ...snapshot.inventory, updateEvidence: incomplete("partial") },
    projects: [...snapshot.projects, { ...project("failing"), evidence: incomplete("failed") }],
  };
  const gapGroups = (filter: AttentionFilter) =>
    attentionGroups(gaps, filter).map((group) => group.id);
  assert.deepEqual(gapGroups("new"), ["pc", "compared", "first"]);
  assert.deepEqual(gapGroups("resolved"), ["compared"]);
});

test("a connected PC's evidence fills neither Snoozed & ignored nor Resolved", () => {
  assert.equal(localOnlyFilter("suppressed"), true);
  assert.equal(localOnlyFilter("resolved"), true);
  for (const filter of ["all", "new", "updates", "advisories", "lifecycle", "coverage"] as const)
    assert.equal(localOnlyFilter(filter), false, filter);
});

test("Retry failed checks counts targets whose last attempt failed or left gaps, never unscanned ones", () => {
  const evidence = (status: ScanEvidence["status"]): ScanEvidence => ({
    status,
    lastAttempt: null,
    lastSuccess: null,
    coverage: [],
    errors: [],
  });
  const projects = (
    ["failed", "partial", "complete", "not-scanned", "scanning", "unsupported"] as const
  ).map((status) => ({ evidence: evidence(status) }));
  assert.equal(failedTargetCount({ inventory: { evidence: evidence("complete") }, projects }), 2);
  assert.equal(
    failedTargetCount({
      inventory: { evidence: evidence("complete"), updateEvidence: evidence("partial") },
      projects: [],
    }),
    1,
  );
  assert.equal(
    failedTargetCount({
      inventory: { evidence: evidence("failed"), updateEvidence: evidence("failed") },
      projects: [],
    }),
    1,
    "This PC is one target",
  );
  assert.equal(
    failedTargetCount({ inventory: { evidence: evidence("partial") }, projects }),
    3,
    "This PC and its projects add up",
  );
  assert.equal(
    failedTargetCount({ inventory: { evidence: evidence("not-scanned") }, projects: [] }),
    0,
  );
});

test("the Background service page says what waits for delivery and why, counting only what can still notify", () => {
  const base: Pick<MonitoringSnapshot, "notifications" | "settings"> = {
    notifications: [
      {
        id: "event",
        findingId: "finding",
        title: "App: left-pad",
        body: "A newer version satisfies the requested range.",
        createdAt: "2026-10-08T12:00:00Z",
        deliveredAt: null,
      },
    ],
    settings: {
      paused: false,
      pcIntervalMinutes: 60,
      projectIntervalMinutes: 60,
      notifyNewFindings: true,
    },
  };
  const summary: NotificationSummary = {
    id: "summary",
    updateCount: 2,
    newUpdateCount: 1,
    projectCount: 1,
    pcCount: 0,
    advisoryCount: 0,
    newAdvisoryCount: 0,
    title: "2 updates available",
    body: "1 newly detected update.",
    filter: "updates",
  };
  // A coordinator that reports no count: every undelivered event waits.
  assert.deepEqual(deliveryStatus(base), {
    text: "New findings are being combined into the next summary.",
    pending: true,
  });
  // The coordinator's count leaves out events whose findings are hidden or outside Notify about.
  assert.deepEqual(deliveryStatus({ ...base, notificationsWaiting: 0 }), {
    text: "No new findings are waiting.",
    pending: false,
  });
  assert.equal(
    deliveryStatus({
      ...base,
      notificationsWaiting: 1,
      settings: { ...base.settings, digestAt: "18:00" },
    }).text,
    "New findings are waiting for the daily digest at 18:00.",
  );
  assert.deepEqual(
    deliveryStatus({ ...base, notificationsWaiting: 1, notificationSummary: summary }),
    {
      text: "2 updates and 0 advisory findings are ready to review.",
      pending: true,
    },
  );
  assert.equal(
    deliveryStatus({
      ...base,
      notificationsWaiting: 1,
      notificationSummary: { ...summary, quiet: true },
    }).text,
    "2 updates and 0 advisory findings are ready to review. The desktop notification waits until quiet hours end.",
  );
});
