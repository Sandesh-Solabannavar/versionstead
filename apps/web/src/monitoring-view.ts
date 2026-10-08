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
import { dependencyUpgradeCommand, globalUpgradeCommand } from "./upgrade-commands.ts";
import { versionAtLeast } from "./versions.ts";

export type InventoryFilter = "updates" | "all" | "current" | "unverified";
export type AttentionFilter = "all" | "updates" | "advisories" | "coverage";

const minute = 60_000;
// Always numeric: "auto" would say "yesterday" or "last month", wrong by a calendar unit for spans
// that are floored to whole units (47 hours ago is not yesterday).
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "always" });
const relativeUnits = [
  ["month", 30 * 24 * 60 * minute],
  ["day", 24 * 60 * minute],
  ["hour", 60 * minute],
  ["minute", minute],
] as const;

/** "5 minutes ago" or "in 2 hours": whole units rounded down, "just now" under 45 seconds. */
export function relativeTime(value: string, now: number): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "Unknown time";
  const elapsed = now - time;
  const age = Math.abs(elapsed);
  if (age < 45_000) return elapsed < 0 ? "in under a minute" : "just now";
  const [unit, size] = relativeUnits.find(([, span]) => age >= span) ?? relativeUnits[3];
  return relativeFormat.format(-Math.sign(elapsed) * Math.max(1, Math.floor(age / size)), unit);
}

/**
 * Whether evidence is older than twice its scan interval. A pause does not make it fresher, and
 * a target that never succeeded has no age to call stale.
 */
export function evidenceStale(
  lastSuccess: string | null,
  intervalMinutes: number,
  now: number,
): boolean {
  return now - (lastSuccess ? Date.parse(lastSuccess) : Number.NaN) > 2 * intervalMinutes * minute;
}

const severities = {
  critical: { rank: 0, label: "Critical advisory", tone: "error" },
  high: { rank: 1, label: "High advisory", tone: "error" },
  moderate: { rank: 2, label: "Moderate advisory", tone: "warning" },
  // Unassessed risk ranks above low, so an unknown severity is never buried under it.
  unknown: { rank: 3, label: "Unknown severity", tone: "neutral" },
  low: { rank: 4, label: "Low advisory", tone: "neutral" },
  info: { rank: 5, label: "Info advisory", tone: "neutral" },
} as const satisfies Record<
  Finding["severity"],
  { rank: number; label: string; tone: "error" | "warning" | "neutral" }
>;

export function severityPresentation(severity: Finding["severity"]) {
  const { label, tone } = severities[severity];
  return { label, tone };
}

/** Most severe first, then by name. */
export const compareFindings = (
  a: Pick<Finding, "severity" | "name">,
  b: Pick<Finding, "severity" | "name">,
) => severities[a.severity].rank - severities[b.severity].rank || a.name.localeCompare(b.name);

/** What a finding says in a few words: its severity for an advisory, else its kind. */
export function findingSummary(finding: Pick<Finding, "kind" | "severity">): string {
  return finding.kind === "advisory"
    ? severities[finding.severity].label
    : finding.kind === "coverage"
      ? "Incomplete check"
      : "Update available";
}

/**
 * A name for each item that is unique within the list, for a control that repeats on every row:
 * the base name, numbered ("(2 of 3)") only where it repeats. Keyed by the item's id.
 */
export function uniqueRowLabels<T>(
  items: readonly T[],
  label: (item: T) => string,
  id: (item: T) => string,
): Map<string, string> {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(label(item), (totals.get(label(item)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return new Map(
    items.map((item) => {
      const base = label(item);
      const total = totals.get(base) ?? 1;
      const position = (seen.get(base) ?? 0) + 1;
      seen.set(base, position);
      return [id(item), total > 1 ? `${base} (${position} of ${total})` : base];
    }),
  );
}

/** The tone of a group of advisories: its most severe member decides. */
export function advisoryTone(findings: readonly Pick<Finding, "severity">[]) {
  const tones = findings.map((finding) => severities[finding.severity].tone);
  return tones.includes("error") ? "error" : tones.includes("warning") ? "warning" : "neutral";
}

export const workspaceLabel = (importer: string) => (importer === "." ? "root" : importer);

const platforms: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
export const platformLabel = (platform: string) => platforms[platform] ?? platform;

type Runtime = MonitoringSnapshot["runtime"];
export type LifecycleRow = {
  title: string;
  text: string;
  badge: { label: string; tone: "info" | "warning" | "neutral" } | null;
};

const signOutUnavailable =
  "Background monitoring after sign-out is not available yet on this platform.";

/**
 * The startup and sign-out rows of Background service, for the coordinator host's platform. Only
 * Windows has a boot host; elsewhere monitoring after sign-out is not available yet. The tray
 * belongs to the desktop app, so a browser is not told about it; on macOS it is in the menu bar.
 */
export function lifecycleRows(
  platform: string,
  host: Runtime["host"],
  desktop: boolean,
): LifecycleRow[] {
  const mac = platform === "darwin";
  const tray: LifecycleRow[] = desktop
    ? [
        {
          title: "When the window closes",
          text: mac
            ? "Electron remains in the menu bar. Reopen the app or pause schedules from its menu bar icon."
            : "Electron remains in the system tray. Reopen the app or pause schedules from its tray menu.",
          badge: { label: mac ? "Menu bar" : "Tray", tone: "neutral" },
        },
      ]
    : [];
  if (platform !== "win32")
    return [
      ...tray,
      {
        title: "After sign-out",
        text: signOutUnavailable,
        badge: { label: "Not available", tone: "neutral" },
      },
    ];
  const boot = host === "boot-task";
  return [
    {
      title: "Windows boot",
      text: boot
        ? "Connected to the Windows boot-task host. Verify reboot and sign-out behavior before relying on unattended coverage."
        : "Startup registration has not been confirmed. This coordinator currently belongs to the signed-in session.",
      badge: boot
        ? { label: "Boot host", tone: "info" }
        : { label: "Setup required", tone: "warning" },
    },
    ...tray,
    {
      title: "After Windows sign-out",
      text: boot
        ? "The independent boot host is designed to continue collecting accessible sources after sign-out. Folder access and session-dependent sources still need verification."
        : `${desktop ? "A tray process cannot survive sign-out." : "Monitoring ends at sign-out."} Configure the Windows background host to enable monitoring outside your signed-in session.`,
      badge: boot
        ? { label: "Verify access", tone: "info" }
        : { label: "Not configured", tone: "warning" },
    },
    {
      title: "Account and folder coverage",
      text: "The desktop saves the owner's npm and Bun global locations for the boot host. Inaccessible folders and unverified package origins produce explicit coverage errors.",
      badge: null,
    },
  ];
}

/**
 * How to restart monitoring when the UI is newer than its coordinator. A boot host has its own
 * script; the tray belongs to the desktop app, so a browser is not sent to it. The desktop runs on
 * the coordinator's own platform, whose macOS menu bar holds the tray icon.
 */
export function restartAdvice(host: Runtime["host"], desktop: boolean, platform: string): string {
  if (host === "boot-task")
    return "Run the Windows background setup command with -Action Restart in administrator PowerShell.";
  return desktop
    ? `Quit Versionstead UI from the ${platform === "darwin" ? "menu bar icon" : "tray"} and launch the rebuilt desktop app. It replaces an older session coordinator automatically.`
    : "Restart the coordinator, or launch the rebuilt desktop app, which replaces an older session coordinator automatically.";
}

/** The closing note of Background service. Startup registration exists only on Windows. */
export function lifecycleNote(platform: string): string {
  const sleeping = "A sleeping or powered-off PC cannot scan.";
  return platform === "win32"
    ? `Startup registration requires the Windows setup command in the development documentation. Pausing schedules keeps the coordinator running; it does not remove startup registration. ${sleeping}`
    : `Pausing schedules keeps the coordinator running. ${sleeping}`;
}

/** What Connections says about background monitoring; the sign-out advice is for Windows only. */
export function backgroundSummary({
  host,
  mode,
  platform,
}: Pick<Runtime, "host" | "mode" | "platform">): string {
  if (host === "boot-task")
    return "Windows boot host is configured. Verify connectivity and scan history after sign-out.";
  if (mode === "background") return "Background host. The app window can stay closed.";
  return `Monitoring keeps running when the app window closes. ${
    platform === "win32"
      ? "Install the Windows boot host for access after sign-out."
      : signOutUnavailable
  }`;
}

/** The singular or plural of a noun for a count, without the count. */
export const noun = (count: number, one: string, many = `${one}s`) => (count === 1 ? one : many);

export const plural = (count: number, one: string, many?: string) =>
  `${count} ${noun(count, one, many)}`;

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

export type UpgradeOption = { where: string; command: string; version: string };

/** The command for a dependency's checked candidate: the compatible release, else the latest. */
export function dependencyUpgradeOption(
  project: Pick<Project, "packageManager" | "dependencies">,
  dependency: Dependency,
): UpgradeOption | null {
  const version =
    dependency.versionStatus === "checked"
      ? (dependency.availableVersion ?? dependency.latestVersion)
      : null;
  const command = dependencyUpgradeCommand(project, dependency, version);
  return command && version
    ? { where: workspaceLabel(dependency.importer), command, version }
    : null;
}

/**
 * Whether the PC's update results are unverified or in flux (a failed or running scan or check),
 * so that nothing built from them should be offered. The desktop's Update now is blocked by the
 * same condition, plus a lost connection.
 */
export function pcUpdatesUnverified(
  snapshot: Pick<MonitoringSnapshot, "inventory" | "scanProgress">,
): boolean {
  const { evidence, updateEvidence } = snapshot.inventory;
  return (
    evidence.status === "scanning" ||
    evidence.status === "failed" ||
    updateEvidence?.status === "failed" ||
    snapshot.scanProgress?.active?.kind === "pc" ||
    (snapshot.scanProgress?.queued.some((target) => target.kind === "pc") ?? false)
  );
}

/**
 * Why the desktop's Update now and the commands built from the PC's update results are held back,
 * as the start of a sentence: a lost connection, or unverified or in-flux results. Null otherwise.
 */
export function pcUpdateHold(
  connected: boolean,
  snapshot: Pick<MonitoringSnapshot, "inventory" | "scanProgress"> | null,
): string | null {
  if (!connected) return "Reconnect to the coordinator";
  return snapshot !== null && pcUpdatesUnverified(snapshot) ? "Finish a successful PC scan" : null;
}

/**
 * Upgrade commands for a finding, one per distinct place it applies. A finding does not name its
 * workspace or manager, so every dependency record or installation it matches contributes one.
 * An advisory offers its dependency's update only when that reaches the provider-listed fixed
 * boundary: none when no fixed version is listed or the boundary cannot be compared, since an
 * update is not known to fix it. The boundary is not a target itself. PC commands are withheld
 * while its update results are unverified.
 */
export function findingUpgradeCommands(
  finding: Finding,
  project: Project | null,
  pc: Pick<MonitoringSnapshot, "inventory" | "scanProgress">,
): UpgradeOption[] {
  const options = new Map<string, UpgradeOption>();
  if (project) {
    for (const dependency of project.dependencies) {
      const option = dependencyFindings(dependency, [finding]).length
        ? dependencyUpgradeOption(project, dependency)
        : null;
      // An update's own candidate always answers it; an advisory needs its provider-listed fixed
      // boundary, and with none listed no update is known to fix it.
      if (
        option &&
        (finding.kind === "update" ||
          (finding.availableVersion !== null &&
            versionAtLeast(option.version, finding.availableVersion)))
      )
        options.set(option.command, option);
    }
  } else if (finding.kind === "update" && !pcUpdatesUnverified(pc)) {
    for (const tool of pc.inventory.installations) {
      if (
        tool.updateStatus !== "available" ||
        tool.name !== finding.name ||
        (tool.packageId ?? tool.name) !== (finding.packageName ?? finding.name) ||
        tool.version !== finding.installedVersion ||
        tool.availableVersion !== finding.availableVersion
      )
        continue;
      const command = globalUpgradeCommand(tool, tool.availableVersion);
      if (command && tool.availableVersion)
        options.set(command, {
          where: tool.manager === "bun" ? "Bun" : "npm",
          command,
          version: tool.availableVersion,
        });
    }
  }
  return [...options.values()];
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

/**
 * Whether a target's findings were kept from earlier scans rather than confirmed by its last one:
 * a failed or unsupported scan keeps them, so they read "previous, unverified".
 */
export function findingsRetained(status: ScanEvidence["status"]): boolean {
  return status === "failed" || status === "unsupported";
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
    const findings = snapshot.findings
      .filter(
        (finding) =>
          finding.subjectId === target.id &&
          (kind === "all" || finding.kind === kind) &&
          (matchesTarget ||
            `${finding.name} ${finding.packageName ?? ""} ${finding.source} ${finding.description}`
              .toLowerCase()
              .includes(search)),
      )
      .sort(compareFindings);
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
