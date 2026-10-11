import semver from "semver";
import type { CreateFindingRule, Finding, FindingRule } from "@versionstead/contracts/monitoring";
import { plainMessage } from "./adapters/lookups.ts";
import { identity, InputError } from "./adapters/projects.ts";

const day = 86_400_000;

/**
 * What a rule covers: the finding's subject, package (or name), and kind, plus the identity that
 * must not change: an advisory's identity, an incomplete check's exact text (as a digest), a
 * lifecycle finding's severity, or the id of a finding of an unknown kind (so a rule never covers
 * two different unknown kinds of one package). An update rule follows its package across new
 * candidates. An advisory rule also records the severity it was made at, which is not part of the
 * key: a lower or equal rating stays hidden, a higher one does not (see `applies`).
 */
export function ruleScope(finding: Finding): FindingRule["scope"] {
  const detail =
    finding.kind === "advisory"
      ? (finding.advisoryUrl ?? finding.id)
      : finding.kind === "coverage"
        ? identity(finding.description)
        : finding.kind === "lifecycle"
          ? finding.severity
          : finding.kind === "other"
            ? finding.id
            : undefined;
  return {
    subjectId: finding.subjectId,
    kind: finding.kind,
    packageName: finding.packageName ?? finding.name,
    ...(detail === undefined ? {} : { detail }),
    ...(finding.kind === "advisory" ? { severity: finding.severity } : {}),
  };
}

export const scopeKey = (scope: FindingRule["scope"]) =>
  JSON.stringify([scope.subjectId, scope.kind, scope.packageName, scope.detail ?? null]);

/** Rules by scope, so matching every finding stays linear. */
export function ruleIndex(rules: readonly FindingRule[]): Map<string, FindingRule[]> {
  const index = new Map<string, FindingRule[]>();
  for (const rule of rules) {
    const key = scopeKey(rule.scope);
    index.set(key, [...(index.get(key) ?? []), rule]);
  }
  return index;
}

// Lowest to highest. An advisory whose details could not be read is "unknown" and ranks lowest, so
// a failed lookup never shows a hidden advisory again, while a rating that becomes known does.
const severities: readonly Finding["severity"][] = [
  "unknown",
  "info",
  "low",
  "moderate",
  "high",
  "critical",
];

function applies(rule: FindingRule, finding: Finding, now: number) {
  // A snooze has an end; one with neither a date nor a version (only from edited data) would hide for ever.
  if (rule.mode === "snooze" && rule.until === undefined && rule.untilVersion === undefined)
    return false;
  if (rule.until !== undefined && !(Date.parse(rule.until) > now)) return false;
  // Rated higher than when it was hidden, an advisory shows again.
  if (
    rule.scope.severity !== undefined &&
    severities.indexOf(finding.severity) > severities.indexOf(rule.scope.severity)
  )
    return false;
  if (rule.untilVersion === undefined) return true;
  // Hidden only while the candidate is not newer than the snoozed version; anything unparseable shows.
  return (
    finding.availableVersion !== null &&
    semver.valid(finding.availableVersion) !== null &&
    semver.valid(rule.untilVersion) !== null &&
    semver.lte(finding.availableVersion, rule.untilVersion)
  );
}

/** The rule that hides a finding now, if any. */
export function matchingRule(
  index: ReadonlyMap<string, readonly FindingRule[]>,
  finding: Finding,
  now: number,
): FindingRule | undefined {
  return index.get(scopeKey(ruleScope(finding)))?.find((rule) => applies(rule, finding, now));
}

/** A validated rule for a finding; anything the request does not allow is an InputError. */
export function createRule(
  request: CreateFindingRule,
  finding: Finding,
  now: number,
  id: string,
): FindingRule {
  const raw = request.reason ?? "";
  if (raw.length > 200) throw new InputError("Keep the reason to 200 characters.");
  // Control, zero-width and bidirectional characters are not text: a reason made of them is no reason.
  const reason = plainMessage(raw, 200);
  const createdAt = new Date(now).toISOString();
  if (request.mode === "ignore") {
    if (finding.kind === "coverage")
      throw new InputError("Incomplete checks can be snoozed but not ignored.");
    if (request.days !== undefined || request.untilNewerVersion !== undefined)
      throw new InputError("An ignore rule has no end date or version.");
    if (reason.length < 3)
      throw new InputError("Say why this finding is ignored, in at least 3 characters.");
    return { id, scope: ruleScope(finding), mode: "ignore", reason, createdAt };
  }
  const byVersion = request.untilNewerVersion === true;
  if ((request.days !== undefined) === byVersion)
    throw new InputError("Snooze for 7, 30, or 90 days, or until a newer version.");
  // A direct caller bypasses the request schema, which allows only these lengths.
  if (request.days !== undefined && ![7, 30, 90].includes(request.days))
    throw new InputError("Snooze for 7, 30, or 90 days, or until a newer version.");
  const candidate = finding.availableVersion;
  if (
    byVersion &&
    (finding.kind !== "update" || candidate === null || semver.valid(candidate) === null)
  )
    throw new InputError("Only an update with a known candidate version can wait for a newer one.");
  return {
    id,
    scope: ruleScope(finding),
    mode: "snooze",
    ...(request.days !== undefined
      ? { until: new Date(now + request.days * day).toISOString() }
      : { untilVersion: candidate! }),
    ...(reason ? { reason } : {}),
    createdAt,
  };
}

/**
 * Rules that hide nothing now: their target is gone, or no current finding matches them. That
 * covers a passed date, a newer candidate than the snoozed version, a resolved finding, and a
 * changed identity or severity, and it only ever errs toward showing a finding. A rule is judged
 * against every current finding, so one copy of a package cannot expire a snooze that still hides
 * another copy.
 */
export function expiredRuleIds(
  rules: readonly FindingRule[],
  findings: readonly Finding[],
  subjects: ReadonlySet<string>,
  now: number,
): Set<string> {
  const index = ruleIndex(rules);
  const hiding = new Set<string>();
  for (const finding of findings) {
    const rule = matchingRule(index, finding, now);
    if (rule) hiding.add(rule.id);
  }
  return new Set(
    rules
      .filter((rule) => !subjects.has(rule.scope.subjectId) || !hiding.has(rule.id))
      .map((rule) => rule.id),
  );
}
