import assert from "node:assert/strict";
import test from "node:test";
import type {
  Installation,
  Dependency,
  Finding,
  GlobalToolSource,
  MonitoringSnapshot,
  Project,
  ScanEvidence,
  ScanProgress,
} from "@versionstead/contracts/monitoring";
import {
  advisoryTone,
  attentionSearch,
  attentionGroups,
  backgroundSummary,
  compareFindings,
  dependencyFindings,
  dependencyNeedsAttention,
  dependencyUpgradeOption,
  evidenceStale,
  filterInstallations,
  findingCounts,
  findingSummary,
  findingUpgradeCommands,
  globalToolSourceState,
  installationCandidate,
  lifecycleNote,
  lifecycleRows,
  noun,
  pcUpdateState,
  pcUpdateHold,
  pcUpdatesUnverified,
  plural,
  platformLabel,
  projectNeedsAttention,
  relativeTime,
  restartAdvice,
  scanDuration,
  scanStage,
  severityPresentation,
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
    { packages: 2, updates: 2, advisories: 0, incomplete: 0 },
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
  for (const platform of ["darwin", "linux"])
    for (const host of lifecycleHosts) {
      assert.deepEqual(titles(platform, host, true), ["When the window closes", "After sign-out"]);
      assert.deepEqual(titles(platform, host, false), ["After sign-out"]);
    }
});

test("elsewhere there is no boot or Windows wording and sign-out monitoring is not available yet", () => {
  for (const platform of ["darwin", "linux", "freebsd"])
    for (const host of lifecycleHosts)
      for (const desktop of [true, false]) {
        const text = [
          ...lifecycleRows(platform, host, desktop).flatMap((row) => [
            row.title,
            row.text,
            row.badge?.label ?? "",
          ]),
          lifecycleNote(platform),
        ].join("\n");
        const where = `${platform} ${host} ${desktop}`;
        assert.doesNotMatch(text, /Windows|boot|PowerShell/i, where);
        assert.match(
          text,
          /Background monitoring after sign-out is not available yet on this platform\./,
        );
        assert.match(text, /sleeping or powered-off PC cannot scan/, where);
      }
  assert.match(lifecycleNote("win32"), /Windows setup command/);
  assert.match(lifecycleNote("win32"), /sleeping or powered-off PC cannot scan/);
});

test("the Connections summary gives sign-out advice only where it can be followed", () => {
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
    backgroundSummary({ host: "session", mode: "background", platform: "darwin" }),
    /Background host/,
  );
  for (const platform of ["darwin", "linux"]) {
    const text = backgroundSummary({ ...session, platform });
    assert.doesNotMatch(text, /Windows|boot/i, platform);
    assert.match(text, /not available yet on this platform/, platform);
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
  }
  // A browser still gets a step it can follow.
  assert.match(restartAdvice("session", false, "win32"), /Restart the coordinator/);
});
