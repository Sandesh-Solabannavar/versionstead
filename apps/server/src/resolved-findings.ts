import type { Finding, ResolvedFinding } from "@versionstead/contracts/monitoring";

export const resolvedDays = 30;
export const resolvedLimit = 500;
const day = 86_400_000;

/**
 * The problem a finding reports. A newer release, a rescored advisory, or a patched runtime line is
 * the same problem; an update whose installed version moved, a fixed advisory, or a runtime line no
 * longer in use is not. Copies of one problem (two workspaces) resolve together.
 */
function problem(finding: Finding) {
  return JSON.stringify([
    finding.subjectId,
    finding.kind,
    finding.packageName ?? finding.name,
    finding.kind === "update" ? finding.installedVersion : null,
    finding.kind === "advisory" ? finding.advisoryUrl : null,
  ]);
}

// A coverage gap closes in the target's status; a kind this build does not know is never claimed.
const recorded = (finding: Finding) =>
  finding.kind === "update" || finding.kind === "advisory" || finding.kind === "lifecycle";

/**
 * A subject's findings whose problems its new findings no longer report, stamped `resolvedAt`.
 * `unread` names the packages the scan could not check (the lockfile does not resolve them, OSV or
 * the registry failed for them, or This PC could not read their update status): a check that did
 * not run is unknown, never a resolution, whatever id the package's findings now carry.
 */
export function newlyResolved(
  before: readonly Finding[],
  after: readonly Finding[],
  resolvedAt: string,
  unread: ReadonlySet<string> = new Set(),
): ResolvedFinding[] {
  const open = new Set(after.map(problem));
  return before
    .filter(
      (finding) =>
        recorded(finding) &&
        !open.has(problem(finding)) &&
        // ponytail: a dependency missing from a partly read lockfile still reads as removed
        // ponytail: a deprecation notice reads as resolved when registry metadata omits the newly
        // installed version, or could not be read after the package manager answered; add those
        // packages to `unread` if that misleads
        !(finding.packageName !== null && unread.has(finding.packageName)),
    )
    .map((finding) => ({ ...finding, resolvedAt }));
}

/** Newest first: the last 30 days, at most 500, without problems that are open again. */
export function keepResolved(
  entries: readonly ResolvedFinding[],
  open: readonly Finding[],
  now: number,
): ResolvedFinding[] {
  const reopened = new Set(open.map(problem));
  const cutoff = now - resolvedDays * day;
  return entries
    .filter((entry) => Date.parse(entry.resolvedAt) >= cutoff && !reopened.has(problem(entry)))
    .sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt))
    .slice(0, resolvedLimit);
}
