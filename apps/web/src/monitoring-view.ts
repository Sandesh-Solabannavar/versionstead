import type {
  ActiveScan,
  Dependency,
  Finding,
  GlobalToolSource,
  Installation,
  MonitoringSnapshot,
  Project,
  ScanEvidence,
  ScanProgress,
} from "@versionstead/contracts/monitoring";

export type InventoryFilter = "updates" | "all" | "current" | "unverified";
export type AttentionFilter = "all" | "updates" | "advisories" | "coverage";

export function findingCounts(findings: readonly Finding[], deviceId: string) {
  const updates = new Set<string>();
  const advisories = new Set<string>();
  const packages = new Set<string>();
  const incomplete = new Set<string>();
  for (const finding of findings) {
    if (finding.kind === "coverage") {
      incomplete.add(finding.id);
      continue;
    }
    // Global findings retain installation/root identity in their IDs. Project
    // summary counts combine repeated importers; dependency rows retain them.
    const packageKey =
      finding.subjectId === deviceId
        ? finding.id
        : JSON.stringify([
            finding.subjectId,
            finding.packageName ?? finding.name,
            finding.installedVersion,
          ]);
    packages.add(packageKey);
    const findingKey =
      finding.subjectId === deviceId
        ? finding.id
        : JSON.stringify([
            packageKey,
            finding.source,
            finding.availableVersion,
            finding.kind === "advisory" ? (finding.advisoryUrl ?? finding.id) : "update",
          ]);
    (finding.kind === "update" ? updates : advisories).add(findingKey);
  }
  return {
    packages: packages.size,
    updates: updates.size,
    advisories: advisories.size,
    incomplete: incomplete.size,
  };
}

export function dependencyFindings(
  dependency: Dependency,
  findings: readonly Finding[],
): Finding[] {
  return findings.filter(
    (finding) =>
      dependency.origin === "registry" &&
      finding.kind !== "coverage" &&
      finding.packageName === dependency.packageName &&
      finding.name === dependency.name &&
      finding.installedVersion === dependency.resolved &&
      (finding.kind === "advisory" ||
        finding.availableVersion === (dependency.availableVersion ?? dependency.latestVersion)),
  );
}

export function dependencyNeedsAttention(
  dependency: Dependency,
  findings: readonly Finding[] = [],
): boolean {
  return (
    dependencyFindings(dependency, findings).length > 0 ||
    dependency.availableVersion !== null ||
    dependency.latestVersion !== null ||
    dependency.advisoryIds.length > 0 ||
    dependency.versionStatus === "failed" ||
    dependency.advisoryStatus === "failed" ||
    (dependency.origin === "registry" &&
      (dependency.advisoryStatus === "not-checked" ||
        (dependency.role !== "transitive" && dependency.versionStatus === "not-checked")))
  );
}

function incompleteEvidence(evidence: ScanEvidence): boolean {
  return evidence.status !== "complete" && evidence.status !== "scanning";
}

export function projectNeedsAttention(
  project: Project,
  findings: readonly Finding[],
  scanProgress?: ScanProgress,
): boolean {
  return (
    incompleteEvidence(project.evidence) ||
    project.evidence.status === "scanning" ||
    findings.some((finding) => finding.subjectId === project.id) ||
    project.dependencies.some((dependency) => dependencyNeedsAttention(dependency)) ||
    scanProgress?.active?.targetId === project.id ||
    (scanProgress?.queued.some((target) => target.targetId === project.id) ?? false)
  );
}

export type AttentionGroup = {
  id: string;
  label: string;
  kind: "pc" | "project";
  project: Project | null;
  evidence: ScanEvidence;
  findings: Finding[];
  counts: ReturnType<typeof findingCounts>;
  active: boolean;
  queued: boolean;
};

export function attentionGroups(
  snapshot: MonitoringSnapshot,
  filter: AttentionFilter = "all",
  query = "",
): AttentionGroup[] {
  const search = query.trim().toLowerCase();
  const kind = filter === "updates" ? "update" : filter === "advisories" ? "advisory" : filter;
  const pcEvidence = snapshot.inventory.evidence;
  const updateEvidence = snapshot.inventory.updateEvidence;
  const targets = [
    {
      id: snapshot.device.id,
      label: snapshot.device.label,
      kind: "pc" as const,
      project: null,
      evidence:
        updateEvidence &&
        (filter === "updates" ||
          (!incompleteEvidence(pcEvidence) && incompleteEvidence(updateEvidence)))
          ? updateEvidence
          : pcEvidence,
      incomplete:
        incompleteEvidence(pcEvidence) || (!!updateEvidence && incompleteEvidence(updateEvidence)),
    },
    ...snapshot.projects.map((project) => ({
      id: project.id,
      label: project.name,
      kind: "project" as const,
      project,
      evidence: project.evidence,
      incomplete:
        incompleteEvidence(project.evidence) ||
        project.dependencies.some(
          (dependency) =>
            dependency.versionStatus === "failed" || dependency.advisoryStatus === "failed",
        ),
    })),
  ];
  return targets.flatMap((target) => {
    const matchesTarget = `${target.label} ${target.project?.path ?? ""}`
      .toLowerCase()
      .includes(search);
    const findings = snapshot.findings.filter(
      (finding) =>
        finding.subjectId === target.id &&
        (kind === "all" || finding.kind === kind) &&
        (matchesTarget ||
          `${finding.name} ${finding.packageName ?? ""} ${finding.source} ${finding.description}`
            .toLowerCase()
            .includes(search)),
    );
    const active =
      snapshot.scanProgress?.active?.targetId === target.id ||
      target.evidence.status === "scanning";
    const queued =
      snapshot.scanProgress?.queued.some((item) => item.targetId === target.id) ?? false;
    const diagnosticMatch =
      matchesTarget ||
      [...target.evidence.errors, ...target.evidence.coverage].some((text) =>
        text.toLowerCase().includes(search),
      );
    if (
      findings.length === 0 &&
      !(
        diagnosticMatch &&
        ((filter === "all" && (target.incomplete || active || queued)) ||
          (filter === "coverage" && target.incomplete))
      )
    )
      return [];
    const counts = findingCounts(findings, snapshot.device.id);
    return [
      {
        id: target.id,
        label: target.label,
        kind: target.kind,
        project: target.project,
        evidence: target.evidence,
        findings,
        counts: {
          ...counts,
          incomplete: Math.max(counts.incomplete, target.incomplete ? 1 : 0),
        },
        active,
        queued,
      },
    ];
  });
}

export function attentionSearch(search: Record<string, unknown>): { filter?: AttentionFilter } {
  const filter = search.filter;
  return filter === "updates" ||
    filter === "advisories" ||
    filter === "coverage" ||
    filter === "all"
    ? { filter }
    : {};
}

export function filterInstallations(
  installations: readonly Installation[],
  filter: InventoryFilter,
  source: string,
  query: string,
): Installation[] {
  const search = query.trim().toLowerCase();
  return installations.filter(
    (item) =>
      (filter === "all" ||
        item.updateStatus ===
          (filter === "updates" ? "available" : filter === "current" ? "current" : "unknown")) &&
      (source === "all" || item.manager === source) &&
      `${item.name} ${item.manager ?? item.source} ${item.version}`.toLowerCase().includes(search),
  );
}

export function installationCandidate(
  installation: Pick<Installation, "availableVersion" | "updateStatus">,
  failed = false,
): string {
  return installation.availableVersion
    ? `${installation.availableVersion}${failed || installation.updateStatus === "unknown" ? " · previous, unverified" : ""}`
    : "";
}

export function pcUpdateState(inventory: MonitoringSnapshot["inventory"]): {
  title: string;
  description: string;
} {
  const evidence = inventory.updateEvidence;
  if (inventory.evidence.status === "scanning" || evidence?.status === "scanning")
    return {
      title: "Checking global tools for updates",
      description: "Previous evidence remains readable while this scan collects new results.",
    };
  if (evidence?.status === "failed" || inventory.evidence.status === "failed")
    return {
      title: "Update checking could not finish",
      description:
        "Review the failed checks below and scan again. Previous results remain unverified.",
    };
  const managers = inventory.managers ?? [];
  if (managers.length > 0 && managers.every((item) => item.status === "not-installed"))
    return {
      title: "No npm or Bun installation detected",
      description:
        "There are no detected package managers to inspect. Scan again after npm or Bun is available on this PC.",
    };
  if (
    inventory.installations.length === 0 &&
    managers.some((item) => item.status === "detected") &&
    managers.every((item) => item.status !== "unavailable") &&
    inventory.evidence.status === "complete"
  )
    return {
      title: "No global tools found",
      description:
        "The detected package managers have no global packages in their checked installation locations.",
    };
  if (!evidence || evidence.status === "unsupported")
    return {
      title: "Global tool update checking unavailable",
      description:
        "Global tools have been collected, but this source has no verified update result. Choose All global tools to inspect them and review coverage below.",
    };
  if (evidence.status === "not-scanned")
    return {
      title: "Scan this PC to check for updates",
      description:
        "No update check has completed yet. Choose All global tools to inspect retained inventory.",
    };
  return {
    title: "No confirmed updates found",
    description:
      evidence.status === "complete"
        ? "No updates were found at the checked public registry. Private, linked, and unsupported packages remain unverified; review source coverage below."
        : "Some checks could not complete. No update candidates are confirmed in the collected results; review coverage below.",
  };
}

export function globalToolSourceState(source: GlobalToolSource): {
  label: string;
  tone: "neutral" | "warning";
  description: string;
} {
  if (source.status === "not-installed")
    return {
      label: "Not installed",
      tone: "neutral",
      description: "No installation was detected for this owner.",
    };
  if (source.status === "unavailable")
    return {
      label: "Unavailable",
      tone: "warning",
      description:
        source.error ?? "Detection or access could not finish. Previous evidence remains visible.",
    };
  return {
    label: `Detected${source.version ? ` · ${source.version}` : ""}`,
    tone: source.registry === "public" && source.blockedScopes.length === 0 ? "neutral" : "warning",
    description:
      source.registry === "public"
        ? "Public npm registry checks are available. Linked packages and excluded scopes remain unverified."
        : "Registry configuration could not be verified as public. Installed versions remain readable; upgrade checks are unverified.",
  };
}

export function scanStage(scan: Pick<ActiveScan, "stage" | "completed" | "total">): {
  label: string;
  value?: number;
  max?: number;
  count: string;
} {
  const labels: Record<ActiveScan["stage"], string> = {
    inventory: "Reading npm and Bun global tools",
    "pc-updates": "Checking global tool updates",
    "project-inputs": "Reading project inputs",
    advisories: "Checking advisories",
    "advisory-details": "Reading advisory details",
    "native-versions": "Checking updates with the package manager",
    versions: "Checking available versions",
    saving: "Saving scan evidence",
  };
  const known =
    scan.total !== null &&
    scan.completed !== null &&
    Number.isFinite(scan.total) &&
    Number.isFinite(scan.completed) &&
    scan.total > 0 &&
    scan.completed >= 0 &&
    scan.completed <= scan.total;
  return {
    label: labels[scan.stage],
    ...(known ? { value: scan.completed!, max: scan.total! } : {}),
    count: known
      ? `${scan.completed}/${scan.total}${scan.stage === "advisories" || scan.stage === "versions" || scan.stage === "native-versions" ? " packages" : scan.stage === "advisory-details" ? " advisories" : ""}`
      : "",
  };
}

export function scanDuration(startedAt: string, endedAt: string): string {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(duration) || duration < 0) return "Elapsed time unavailable";
  const seconds = Math.floor(duration / 1_000);
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`
    : `${seconds}s elapsed`;
}
