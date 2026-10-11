import type {
  Dependency,
  Installation,
  MonitoringSnapshot,
  Project,
} from "@versionstead/contracts/monitoring";
import { workspaceLabel } from "./monitoring-view.ts";
import { dependencyUpgradeCommand, globalUpgradeCommand } from "./upgrade-commands.ts";
import { parseSemver, versionAtLeast } from "./versions.ts";

export type DriftUsage = {
  subjectId: string;
  subjectLabel: string;
  /** Where the copy lives: a workspace ("root", "packages/app"), or the global manager ("npm", "Bun"). */
  where: string;
  /** The name it is installed under; an alias differs from its package. */
  name: string;
  version: string;
  /** Older than the row's target. A copy at or newer than the target (a prerelease can be) is not behind. */
  behind: boolean;
  /** Moves this copy to the row's target; null unless it is behind and a safe command exists. */
  command: string | null;
};
export type DriftRow = {
  key: string;
  packageName: string;
  /**
   * "global" rows hold only This PC's tool installations (`subjectId` is the device id), so their
   * commands are built from PC results; "projects" rows hold only project dependencies.
   */
  scope: "projects" | "global";
  /**
   * The version the copies align to: the newest stable version in use, or the newest prerelease only
   * when no stable version is in use. A prerelease newer than a stable target is left as it is.
   */
  target: string;
  /** Distinct versions in use, newest first; a prerelease counts. */
  versions: string[];
  usages: DriftUsage[];
};

// One fixed collation, so the order is the same on every machine whatever its language
// (Estonian, for one, sorts "zod" before "tsx").
const compareText = new Intl.Collator("en").compare;
// Newest first by SemVer precedence. Versions of equal precedence (build metadata only) are told
// apart by their text, so the order never depends on which copy came first in the snapshot.
// ponytail: such copies still count as separate versions; strip build metadata if that ever shows
// up in real evidence.
const newestFirst = (a: string, b: string) =>
  versionAtLeast(a, b) ? (versionAtLeast(b, a) ? compareText(a, b) : -1) : 1;
// Projects can share a display name, so ties fall back to the project id and then the version. The
// project root and a workspace folder named "root" also read alike; their commands tell them apart.
const byPlace = (a: DriftUsage, b: DriftUsage) =>
  compareText(a.subjectLabel, b.subjectLabel) ||
  compareText(a.where, b.where) ||
  compareText(a.name, b.name) ||
  compareText(a.subjectId, b.subjectId) ||
  newestFirst(a.version, b.version) ||
  compareText(a.command ?? "", b.command ?? "");

/** The copies that need a change first, each group in place order, so the sheet opens on what there is to do. */
export const behindFirst = (usages: readonly DriftUsage[]): DriftUsage[] =>
  usages.toSorted((a, b) => Number(b.behind) - Number(a.behind));

/**
 * What the sheet offers for one copy: nothing when it needs no change, the reason when it has no
 * command, or its command. This PC's commands come from its update results, so they wait while
 * those are unverified or in flux or the coordinator is out of reach (`hold` says why).
 */
export function usageAction(
  row: Pick<DriftRow, "scope">,
  usage: Pick<DriftUsage, "behind" | "command">,
  hold: string | null,
): "unchanged" | "none" | "held" | "copy" {
  if (!usage.behind) return "unchanged";
  if (!usage.command) return "none";
  return row.scope === "global" && hold !== null ? "held" : "copy";
}

/** The distinct versions, newest first, and the one the copies align to. */
function alignment(found: readonly string[]) {
  const versions = [...new Set(found)].sort(newestFirst);
  // Stable first, so no copy is ever moved onto a prerelease while a stable version is in use.
  const target = versions.find((version) => parseSemver(version)?.pre.length === 0) ?? versions[0]!;
  return { versions, target };
}

function grouped<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

/**
 * Packages in use at more than one version: direct registry dependencies across the selected
 * projects and their workspaces, and npm and Bun copies of the same global tool. Only SemVer
 * versions from collected evidence are compared; this is a view, never a notification.
 */
export function versionDrift(
  snapshot: Pick<MonitoringSnapshot, "device" | "projects" | "inventory">,
): DriftRow[] {
  const rows: DriftRow[] = [];
  const uses = grouped(
    snapshot.projects.flatMap((project) =>
      project.dependencies
        .filter(
          (dependency) =>
            dependency.origin === "registry" &&
            dependency.role !== "transitive" &&
            parseSemver(dependency.resolved) !== null,
        )
        .map((dependency): { project: Project; dependency: Dependency } => ({
          project,
          dependency,
        })),
    ),
    ({ dependency }) => dependency.packageName,
  );
  for (const [packageName, copies] of uses) {
    const { versions, target } = alignment(copies.map(({ dependency }) => dependency.resolved!));
    if (versions.length < 2) continue;
    rows.push({
      key: `projects:${packageName}`,
      packageName,
      scope: "projects",
      target,
      versions,
      usages: copies
        .map(({ project, dependency }) => {
          const behind = !versionAtLeast(dependency.resolved, target);
          return {
            subjectId: project.id,
            subjectLabel: project.name,
            where: workspaceLabel(dependency.importer),
            name: dependency.name,
            version: dependency.resolved!,
            behind,
            command: behind ? dependencyUpgradeCommand(project, dependency, target) : null,
          };
        })
        .sort(byPlace),
    });
  }
  const tools = grouped(
    snapshot.inventory.installations.filter(
      (installation: Installation) =>
        installation.origin === "registry" &&
        installation.manager !== undefined &&
        parseSemver(installation.version) !== null,
    ),
    (installation) => installation.packageId ?? installation.name,
  );
  for (const [packageName, copies] of tools) {
    const { versions, target } = alignment(copies.map((copy) => copy.version));
    if (versions.length < 2) continue;
    rows.push({
      key: `global:${packageName}`,
      packageName,
      scope: "global",
      target,
      versions,
      usages: copies
        .map((copy) => {
          const behind = !versionAtLeast(copy.version, target);
          return {
            subjectId: snapshot.device.id,
            subjectLabel: "This PC",
            // ponytail: two global locations of one manager read alike here and share one generic
            // command, which installs where that manager installs; name the locations if that misleads.
            where: copy.manager === "bun" ? "Bun" : "npm",
            name: copy.name,
            version: copy.version,
            behind,
            command: behind ? globalUpgradeCommand(copy, target) : null,
          };
        })
        .sort(byPlace),
    });
  }
  return rows.sort(
    (a, b) => compareText(a.packageName, b.packageName) || compareText(a.scope, b.scope),
  );
}
