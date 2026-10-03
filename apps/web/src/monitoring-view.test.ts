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
} from "@versionstead/contracts/monitoring";
import {
  attentionSearch,
  attentionGroups,
  dependencyFindings,
  dependencyNeedsAttention,
  filterInstallations,
  findingCounts,
  globalToolSourceState,
  installationCandidate,
  pcUpdateState,
  projectNeedsAttention,
  scanDuration,
  scanStage,
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
