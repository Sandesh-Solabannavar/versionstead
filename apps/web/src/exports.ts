import type {
  Finding,
  FindingRule,
  MonitoringSnapshot,
  ScanEvidence,
} from "@versionstead/contracts/monitoring";
import {
  compareFindings,
  findingSummary,
  findingsRetained,
  ruleLabel,
  uniqueRowLabels,
} from "./monitoring-view.ts";

// Exports are built in the window from the snapshot it already holds; nothing is sent anywhere.

export type ExportScope = { kind: "all" } | { kind: "pc" } | { kind: "project"; projectId: string };
export type ExportFormat = "markdown" | "csv" | "json";
export type ExportFile = { filename: string; mime: string; text: string };

/** The export dialog's scope menu values: "all", "pc", or "project:<id>". */
export const scopeChoice = (scope: ExportScope): string =>
  scope.kind === "project" ? `project:${scope.projectId}` : scope.kind;
export const choiceScope = (choice: string): ExportScope =>
  choice.startsWith("project:")
    ? { kind: "project", projectId: choice.slice("project:".length) }
    : choice === "pc"
      ? { kind: "pc" }
      : { kind: "all" };

const byteOrderMark = String.fromCodePoint(0xfeff);
/** What a copy puts on the clipboard: only a saved CSV file needs its byte order mark; pasted, it is a stray character. */
export const copyableText = (file: ExportFile): string =>
  file.text.startsWith(byteOrderMark) ? file.text.slice(byteOrderMark.length) : file.text;
type ExportSnapshot = Pick<
  MonitoringSnapshot,
  "device" | "inventory" | "projects" | "findings" | "findingRules"
>;
type Target = {
  kind: "pc" | "project";
  label: string;
  /** A repository project's provider address; local folder paths and global locations never leave. */
  repository: string | null;
  packageManager: string;
  evidence: ScanEvidence;
  /** This PC's global tool update checks. */
  updateEvidence: ScanEvidence | null;
  findings: Finding[];
};

const statusLabels: Record<ScanEvidence["status"], string> = {
  "not-scanned": "Not scanned",
  scanning: "Scanning",
  complete: "Collected",
  partial: "Partial",
  failed: "Failed",
  unsupported: "Unsupported",
};

/** At the top of every export, so an incomplete scan can never read as "all clear". */
export const exportNotice =
  "Each target lists its last successful scan, latest attempt, coverage, and incomplete checks. A target that is Partial, Failed, Unsupported, Scanning, or Not scanned was not fully checked, so a missing finding there is not evidence of safety. Snoozed and ignored findings are included and marked.";

// Control and format characters (bidirectional overrides, zero-width marks, joiners, tag characters,
// the byte order mark) become spaces, so exported text can neither hide nor reorder anything, nor
// break a line.
const invisible = /[\p{Cc}\p{Cf}]/gu;

/** Untrusted text as one plain line: invisible characters become spaces and whitespace collapses. */
export function plainText(value: string | null | undefined): string {
  return (value ?? "").replace(invisible, " ").replace(/\s+/g, " ").trim();
}

/**
 * Untrusted text as one line of Markdown with its syntax escaped: no emphasis, strikethrough, code,
 * links, images, HTML, character references, or table breaks. It is not fully inert: GitHub still
 * links bare web addresses, `www.` names, email addresses, `@handles`, and `#123` references in it.
 */
export function markdownText(value: string | null | undefined): string {
  return plainText(value).replace(/[\\`*_[\]<>|~&]/g, "\\$&");
}

// A spreadsheet runs a cell that starts with one of these as a formula, full-width forms included
// (OWASP CSV injection).
const formulaStart = new RegExp(
  `^[-=+@${[0xff1d, 0xff0b, 0xff0d, 0xff20].map((code) => String.fromCodePoint(code)).join("")}]`,
);

/** One CSV cell: plain text, a formula start neutralized with a leading apostrophe, always quoted. */
export function csvCell(value: string | null | undefined): string {
  const text = plainText(value);
  return `"${(formulaStart.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}

// ponytail: the same check as safeExternalUrl in ui.tsx, which a plain Node test cannot import;
// share one copy when a non-React module can hold it.
const httpsUrl = (value: string | null) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};
/**
 * A validated https address as a Markdown autolink, which no escaping reaches. A pipe is the one
 * character such an address can carry that would split a table row, so it is percent-encoded.
 */
const markdownLink = (value: string | null) => {
  const href = httpsUrl(value);
  return href ? `<${href.replaceAll("|", "%7C")}>` : null;
};
const shorten = (value: string, limit: number) => {
  const characters = Array.from(plainText(value));
  return characters.length > limit
    ? `${characters.slice(0, limit - 1).join("")}…`
    : characters.join("");
};
const packageLabel = (finding: Finding) =>
  finding.packageName && finding.packageName !== finding.name
    ? `${finding.name} (${finding.packageName})`
    : finding.name;

function exportTargets(snapshot: ExportSnapshot, scope: ExportScope): Target[] {
  const findings = (subjectId: string) =>
    snapshot.findings
      .filter((finding) => finding.subjectId === subjectId)
      .toSorted(compareFindings);
  const pc: Target = {
    kind: "pc",
    label: "This PC",
    repository: null,
    packageManager: "npm and Bun globals",
    evidence: snapshot.inventory.evidence,
    updateEvidence: snapshot.inventory.updateEvidence ?? null,
    findings: findings(snapshot.device.id),
  };
  const projects = snapshot.projects
    .filter(
      (project) =>
        scope.kind === "all" || (scope.kind === "project" && project.id === scope.projectId),
    )
    .map((project): Target => ({
      kind: "project",
      label: project.name,
      repository: project.repository?.url ?? null,
      packageManager: project.packageManager,
      evidence: project.evidence,
      updateEvidence: null,
      findings: findings(project.id),
    }));
  return scope.kind === "pc" ? [pc] : scope.kind === "all" ? [pc, ...projects] : projects;
}

/**
 * Whether the findings listed for a target include ones kept from earlier scans: a failed or
 * unsupported scan keeps them, and so do failed or unsupported update checks on This PC.
 */
const findingsPrevious = (target: Target) =>
  findingsRetained(target.evidence.status) ||
  (target.updateEvidence !== null && findingsRetained(target.updateEvidence.status));

function ruleText(rules: ReadonlyMap<string, FindingRule>, finding: Finding): string {
  if (finding.ruleId === undefined) return "";
  const rule = rules.get(finding.ruleId);
  return rule ? ruleLabel(rule) : "Snoozed or ignored";
}

// A paired computer's evidence is not in the snapshot, so "all" never claims to be everything.
const scopeTitle = (snapshot: Pick<MonitoringSnapshot, "projects">, scope: ExportScope) =>
  scope.kind === "all"
    ? "This PC and all projects"
    : scope.kind === "pc"
      ? "This PC"
      : (uniqueRowLabels(
          snapshot.projects,
          (project) => project.name,
          (project) => project.id,
        ).get(scope.projectId) ?? "Project");

function markdown(
  title: string,
  targets: readonly Target[],
  rules: ReadonlyMap<string, FindingRule>,
  generatedAt: string,
): string {
  const lines = [
    `# Versionstead findings: ${markdownText(title)}`,
    "",
    `Generated ${markdownText(generatedAt)}. ${exportNotice}`,
  ];
  // Coverage notes are phrases and incomplete checks are sentences, so each joins the way it reads.
  const listed = (items: readonly string[], separator: string, empty: string) =>
    items.length ? markdownText(items.join(separator)) : empty;
  for (const target of targets) {
    lines.push(
      "",
      `## ${markdownText(target.label)} — ${statusLabels[target.evidence.status]}`,
      "",
    );
    // Anything that is not an https address stays escaped text, never a link.
    if (target.repository)
      lines.push(
        `- Repository: ${markdownLink(target.repository) ?? markdownText(target.repository)}`,
      );
    lines.push(
      `- Package manager: ${markdownText(target.packageManager)}`,
      `- Last successful scan: ${markdownText(target.evidence.lastSuccess ?? "Never")}`,
      `- Latest attempt: ${markdownText(target.evidence.lastAttempt ?? "Never")}`,
      `- Coverage: ${listed(target.evidence.coverage, "; ", "None recorded")}`,
      `- Incomplete checks: ${listed(target.evidence.errors, " ", "None reported")}`,
    );
    if (target.updateEvidence)
      lines.push(
        `- Global tool update checks: ${statusLabels[target.updateEvidence.status]}, last successful ${markdownText(target.updateEvidence.lastSuccess ?? "Never")}; incomplete checks: ${listed(target.updateEvidence.errors, " ", "None reported")}`,
      );
    if (findingsPrevious(target))
      lines.push("- Findings below are from an earlier scan (previous, unverified).");
    lines.push("");
    if (!target.findings.length) {
      lines.push("No findings recorded for this target.");
      continue;
    }
    lines.push(
      "| Package | Installed | Candidate or provider boundary | Finding | Source | Details | Last seen | Snoozed or ignored |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const finding of target.findings) {
      const advisory = markdownLink(finding.advisoryUrl);
      lines.push(
        `| ${[
          markdownText(packageLabel(finding)),
          // An incomplete check names no package version, so its Installed cell stays blank.
          markdownText(finding.kind === "coverage" ? "" : (finding.installedVersion ?? "Unknown")),
          markdownText(finding.availableVersion ?? ""),
          markdownText(findingSummary(finding)),
          markdownText(finding.source),
          `${markdownText(shorten(finding.description, 300))}${advisory ? ` ${advisory}` : ""}`,
          markdownText(finding.lastSeenAt),
          markdownText(ruleText(rules, finding)),
        ].join(" | ")} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

// Each row repeats its target's columns, so a filter never separates a finding from its scan state.
const targetColumns = [
  "target",
  "target_kind",
  "package_manager",
  "repository",
  "evidence_status",
  "last_successful_scan",
  "latest_attempt",
  "coverage_notes",
  "incomplete_checks",
  "update_checks_status",
  "update_checks_last_success",
] as const;
const findingColumns = [
  "finding",
  "kind",
  "severity",
  "package",
  "name",
  "installed_version",
  "candidate_or_provider_boundary",
  "source",
  "description",
  "advisory_url",
  "first_detected",
  "last_seen",
  "snoozed_or_ignored",
] as const;

function csv(
  targets: readonly Target[],
  rules: ReadonlyMap<string, FindingRule>,
  generatedAt: string,
): string {
  const rows: (string | null)[][] = [];
  for (const target of targets) {
    const base = [
      target.label,
      target.kind === "pc" ? "This PC" : "Project",
      target.packageManager,
      target.repository,
      statusLabels[target.evidence.status],
      target.evidence.lastSuccess ?? "Never",
      target.evidence.lastAttempt ?? "Never",
      target.evidence.coverage.join("; "),
      target.evidence.errors.join(" "),
      target.updateEvidence ? statusLabels[target.updateEvidence.status] : null,
      target.updateEvidence ? (target.updateEvidence.lastSuccess ?? "Never") : null,
    ];
    // A target without findings still gets a row, so its scan times and coverage are never lost.
    if (!target.findings.length)
      rows.push([...base, ...findingColumns.map(() => null), generatedAt]);
    for (const finding of target.findings)
      rows.push([
        ...base,
        findingSummary(finding),
        finding.kind,
        finding.severity,
        finding.packageName ?? finding.name,
        finding.name,
        finding.installedVersion,
        finding.availableVersion,
        finding.source,
        finding.description,
        httpsUrl(finding.advisoryUrl),
        finding.detectedAt,
        finding.lastSeenAt,
        ruleText(rules, finding) || null,
        generatedAt,
      ]);
  }
  const header = [...targetColumns, ...findingColumns, "generated_at"];
  // The byte order mark makes a spreadsheet read the file as UTF-8.
  return `${byteOrderMark}${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// The Finding fields JSON carries. A field added to the contract stays out of the export until it is
// listed here. id, subjectId, subjectLabel, and ruleId are left out on purpose: they name this PC or
// join findings internally.
const findingFields = [
  "kind",
  "name",
  "packageName",
  "installedVersion",
  "availableVersion",
  "severity",
  "source",
  "description",
  "advisoryUrl",
  "detectedAt",
  "lastSeenAt",
  "effectiveDate",
  "installScript",
  "candidateDeprecated",
  "publishedAt",
  "license",
  "provenance",
] as const satisfies readonly (keyof Finding)[];

// JSON.stringify writes C1 controls, bidirectional overrides, zero-width marks, tag characters, and the
// line and paragraph separators as they are. As Unicode escapes they parse back to the same text but
// cannot hide or reorder anything in a viewer, or break a line. The raw newlines left alone are the
// indentation, since JSON.stringify already escapes every other C0 control.
const hiddenInJson = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const unicodeEscape = (characters: string) =>
  characters
    .split("")
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");

function json(
  title: string,
  scope: ExportScope,
  targets: readonly Target[],
  rules: ReadonlyMap<string, FindingRule>,
  generatedAt: string,
): string {
  const evidence = (value: ScanEvidence) => ({
    status: value.status,
    lastSuccess: value.lastSuccess,
    lastAttempt: value.lastAttempt,
    coverage: value.coverage,
    incompleteChecks: value.errors,
  });
  return `${JSON.stringify(
    {
      format: "versionstead-findings",
      version: 1,
      generatedAt,
      notice: exportNotice,
      scope: scope.kind === "project" ? { kind: "project", project: title } : { kind: scope.kind },
      targets: targets.map((target) => ({
        kind: target.kind,
        label: target.label,
        repository: target.repository,
        packageManager: target.packageManager,
        evidence: { ...evidence(target.evidence), findingsPrevious: findingsPrevious(target) },
        ...(target.updateEvidence ? { updateChecks: evidence(target.updateEvidence) } : {}),
        findings: target.findings.map((finding) => {
          // Only an https address leaves, as in the other formats.
          const recorded = { ...finding, advisoryUrl: httpsUrl(finding.advisoryUrl) };
          return {
            ...Object.fromEntries(findingFields.map((key) => [key, recorded[key]])),
            summary: findingSummary(finding),
            snoozedOrIgnored: ruleText(rules, finding) || null,
          };
        }),
      })),
    },
    null,
    2,
  ).replace(hiddenInJson, unicodeEscape)}\n`;
}

/** `versionstead-<scope>-<day>.<extension>`, with the scope reduced to letters, digits, and dashes. */
export function exportFilename(
  snapshot: Pick<MonitoringSnapshot, "projects">,
  scope: ExportScope,
  format: ExportFormat,
  generatedAt: string,
): string {
  const slug =
    scope.kind === "all"
      ? "this-pc-and-projects"
      : scope.kind === "pc"
        ? "this-pc"
        : scopeTitle(snapshot, scope)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 40)
            .replace(/^-+|-+$/g, "") || "project";
  return `versionstead-${slug}-${generatedAt.slice(0, 10)}.${format === "markdown" ? "md" : format}`;
}

/** Findings for This PC, a project, or everything, with each target's scan times and coverage notes. */
export function exportFindings(
  snapshot: ExportSnapshot,
  scope: ExportScope,
  format: ExportFormat,
  generatedAt: string,
): ExportFile {
  const targets = exportTargets(snapshot, scope);
  const rules = new Map((snapshot.findingRules ?? []).map((rule) => [rule.id, rule]));
  const title = scopeTitle(snapshot, scope);
  return {
    filename: exportFilename(snapshot, scope, format, generatedAt),
    mime:
      format === "markdown"
        ? "text/markdown;charset=utf-8"
        : format === "csv"
          ? "text/csv;charset=utf-8"
          : "application/json;charset=utf-8",
    text:
      format === "markdown"
        ? markdown(title, targets, rules, generatedAt)
        : format === "csv"
          ? csv(targets, rules, generatedAt)
          : json(title, scope, targets, rules, generatedAt),
  };
}
