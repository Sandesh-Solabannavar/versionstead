import type { Finding, Project } from "@versionstead/contracts/monitoring";
import { dependencyFindings, relativeTime } from "./monitoring-view.ts";

const day = 86_400_000;

/** How an update's install-script evidence reads: it adds one, it does not, or it was not checked. */
export function installScriptText(value: boolean | undefined): string {
  return value === true
    ? "Adds an install script"
    : value === false
      ? "No new install script"
      : "Not checked";
}

/** How the candidate version's own deprecation reads: its message, not deprecated, or not checked. */
export function candidateDeprecationText(value: string | null | undefined): string {
  return value === undefined
    ? "Not checked"
    : value === null
      ? "Not deprecated"
      : `Deprecated: ${value}`;
}

/** How the candidate's declared license reads. A missing one is unknown, not a negative signal. */
export function licenseText(value: string | undefined): string {
  return value || "Unknown";
}

/** How provenance reads: attested when deps.dev verified it. Absence is unknown, not "unattested". */
export function provenanceText(value: boolean | undefined): string {
  return value ? "Provenance attested" : "Unknown";
}

export type ReleaseAge =
  | { kind: "too-new"; label: string; untilLabel: string }
  | { kind: "unknown"; label: "Release age unknown" };

/**
 * Where a candidate stands against the cooldown: too new (and the day it is old enough), or unknown when
 * deps.dev gave no release time. Null when the cooldown is off or the release is old enough. An unknown
 * age is never treated as too new.
 */
export function releaseAge(
  publishedAt: string | undefined,
  cooldownDays: number,
  now: number,
): ReleaseAge | null {
  if (cooldownDays <= 0) return null;
  const published = publishedAt === undefined ? Number.NaN : Date.parse(publishedAt);
  if (!Number.isFinite(published)) return { kind: "unknown", label: "Release age unknown" };
  // A publisher clock ahead of ours is not a release in the future: it was released just now.
  const released = Math.min(published, now);
  const until = released + cooldownDays * day;
  if (until <= now) return null;
  // Built for each label, not once: a window left open follows the viewer's time zone as it is now.
  const untilLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(
    until,
  );
  const age = relativeTime(new Date(released).toISOString(), now);
  return { kind: "too-new", label: `Released ${age} — wait until ${untilLabel}`, untilLabel };
}

export type UpdateWarning = {
  kind: "install-script" | "too-new" | "deprecated-candidate";
  text: string;
};

/** Why an update deserves a question before it runs; empty when none applies. An unknown release age is not a warning. */
export function updateWarnings(
  finding:
    | Pick<Finding, "installScript" | "candidateDeprecated" | "availableVersion" | "publishedAt">
    | undefined,
  cooldownDays: number,
  now: number,
): UpdateWarning[] {
  if (!finding) return [];
  const age = releaseAge(finding.publishedAt, cooldownDays, now);
  return [
    ...(finding.installScript === true
      ? [
          {
            kind: "install-script" as const,
            text: "This update adds an install script, which runs during installation.",
          },
        ]
      : []),
    ...(age?.kind === "too-new" ? [{ kind: "too-new" as const, text: `${age.label}.` }] : []),
    ...(typeof finding.candidateDeprecated === "string"
      ? [
          {
            kind: "deprecated-candidate" as const,
            text: `Version ${finding.availableVersion} is deprecated by its publisher: ${finding.candidateDeprecated}`,
          },
        ]
      : []),
  ];
}

// ponytail: only the release an update finding describes has a known age, so a newer latest release
// under "Include major updates" is not held back; carry each candidate's publish time if that matters.
/**
 * Direct dependencies whose update candidate was released inside the cooldown, by dependency id with
 * that candidate, so a bulk command leaves out exactly that release. An unknown age is never held
 * back (ruling 4).
 */
export function youngDependencies(
  project: Pick<Project, "dependencies">,
  findings: readonly Finding[],
  cooldownDays: number,
  now: number,
): Map<string, string> {
  // Few releases are this young, so only those findings are matched against each dependency.
  const fresh = findings.filter(
    (finding) =>
      finding.kind === "update" &&
      releaseAge(finding.publishedAt, cooldownDays, now)?.kind === "too-new",
  );
  const young = new Map<string, string>();
  for (const dependency of project.dependencies) {
    const candidate = dependencyFindings(dependency, fresh)[0]?.availableVersion;
    if (candidate) young.set(dependency.id, candidate);
  }
  return young;
}
