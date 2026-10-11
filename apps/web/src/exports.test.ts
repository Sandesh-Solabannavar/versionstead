import assert from "node:assert/strict";
import test from "node:test";
import {
  Finding,
  type FindingRule,
  type MonitoringSnapshot,
  type Project,
  type ScanEvidence,
} from "@versionstead/contracts/monitoring";
import {
  choiceScope,
  copyableText,
  csvCell,
  exportFilename,
  exportFindings,
  exportNotice,
  markdownText,
  plainText,
  scopeChoice,
  type ExportFormat,
  type ExportScope,
} from "./exports.ts";

// Invisible and look-alike characters are built from their code points, so none sits in this file.
const char = (code: number) => String.fromCodePoint(code);
const bom = char(0xfeff);
const rightToLeftOverride = char(0x202e);
const fullWidthFormulaStarts = [0xff1d, 0xff0b, 0xff0d, 0xff20].map(char);
const formulaStart = new RegExp(`^[-=+@${fullWidthFormulaStarts.join("")}]`);

const generatedAt = "2026-10-08T12:00:00.000Z";
const complete: ScanEvidence = {
  status: "complete",
  lastAttempt: "2026-10-08T11:00:00.000Z",
  lastSuccess: "2026-10-08T11:00:00.000Z",
  coverage: ["npm global packages: 12 checked"],
  errors: [],
};
const failed: ScanEvidence = {
  status: "failed",
  lastAttempt: "2026-10-08T11:30:00.000Z",
  lastSuccess: null,
  coverage: [],
  errors: ["Known-advisory lookup failed."],
};
const project = (id: string, changes: Partial<Project> = {}): Project => ({
  id,
  name: id,
  path: `C:\\Users\\owner\\code\\${id}`,
  mode: "maintained",
  packageManager: "pnpm",
  manifestPath: `C:\\Users\\owner\\code\\${id}\\package.json`,
  lockfilePath: `C:\\Users\\owner\\code\\${id}\\pnpm-lock.yaml`,
  evidence: complete,
  dependencies: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  ...changes,
});
const finding = (changes: Partial<Finding>): Finding => ({
  id: "update",
  kind: "update",
  subjectId: "pc",
  subjectLabel: "OWNER-LAPTOP",
  name: "typescript",
  packageName: "typescript",
  installedVersion: "5.4.0",
  availableVersion: "5.9.2",
  severity: "info",
  source: "npm global",
  description: "A newer stable release is available from the public npm registry.",
  advisoryUrl: null,
  detectedAt: "2026-10-08T10:00:00.000Z",
  lastSeenAt: "2026-10-08T11:00:00.000Z",
  ...changes,
});
const snapshot: Pick<
  MonitoringSnapshot,
  "device" | "inventory" | "projects" | "findings" | "findingRules"
> = {
  device: { id: "pc", label: "OWNER-LAPTOP", platform: "win32" },
  inventory: {
    managers: [
      {
        manager: "npm",
        status: "detected",
        version: "11.7.0",
        root: "C:\\Users\\owner\\AppData\\Roaming\\npm\\node_modules",
        registry: "public",
        blockedScopes: [],
        checkedAt: generatedAt,
        error: null,
      },
    ],
    evidence: complete,
    updateEvidence: {
      ...complete,
      status: "partial",
      errors: ["Bun global metadata is unavailable."],
    },
    installations: [],
  },
  projects: [
    project("storefront"),
    project("billing", { evidence: failed }),
    project("remote", {
      path: "https://github.com/owner/remote",
      repository: {
        provider: "github",
        repositoryId: "1",
        name: "owner/remote",
        ref: "main",
        commit: "abc123",
        url: "https://github.com/owner/remote",
      },
    }),
  ],
  findings: [
    finding({}),
    finding({
      id: "hostile",
      kind: "advisory",
      subjectId: "storefront",
      subjectLabel: "storefront",
      severity: "high",
      name: '=HYPERLINK("https://evil.example","x")',
      packageName: '=HYPERLINK("https://evil.example","x")',
      description: `+cmd|' /C calc'!A0\nsecond line | with <script>alert(1)</script> [link](javascript:alert(1)) *bold* ${rightToLeftOverride}evil`,
      advisoryUrl: "https://osv.dev/vulnerability/GHSA-xxxx-yyyy",
      source: "OSV",
      ruleId: "ignore-1",
    }),
  ],
  findingRules: [
    {
      id: "ignore-1",
      scope: {
        subjectId: "storefront",
        kind: "advisory",
        packageName: '=HYPERLINK("https://evil.example","x")',
        detail: "https://osv.dev/vulnerability/GHSA-xxxx-yyyy",
      },
      mode: "ignore",
      reason: "Not reachable in our build",
      createdAt: generatedAt,
    },
  ],
};

/** RFC 4180 rows as the export writes them: every cell quoted, one physical line per row. */
function parseCsv(text: string): string[][] {
  return (text.startsWith(bom) ? text.slice(bom.length) : text)
    .split("\r\n")
    .filter(Boolean)
    .map((line) =>
      [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) =>
        match[1]!.replaceAll('""', '"'),
      ),
    );
}

/** The cells of a Markdown table row; an escaped pipe stays inside its cell. */
const cellsOf = (row: string) =>
  row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.slice(1, -1));
const markdownLines = (from: typeof snapshot, scope: ExportScope) =>
  exportFindings(from, scope, "markdown", generatedAt).text.split("\n");
/** The finding rows of a Markdown export: the table lines after each header and separator. */
const findingRows = (lines: readonly string[]) =>
  lines.filter(
    (line) =>
      line.startsWith("| ") && !line.startsWith("| Package |") && !line.startsWith("| --- |"),
  );
/** A CSV export read back: the value in a column on the first row of a target. */
const csvReader = (from: typeof snapshot, scope: ExportScope = { kind: "all" }) => {
  const [header = [], ...rows] = parseCsv(exportFindings(from, scope, "csv", generatedAt).text);
  return (target: string, column: string) =>
    rows.find((row) => row[0] === target)?.[header.indexOf(column)];
};
const jsonOf = (from: typeof snapshot, scope: ExportScope = { kind: "all" }) =>
  JSON.parse(exportFindings(from, scope, "json", generatedAt).text);

test("every format names each target's status, scan times, coverage, and incomplete checks", () => {
  const markdown = exportFindings(snapshot, { kind: "all" }, "markdown", generatedAt).text;
  for (const text of [
    "## This PC — Collected",
    "- Last successful scan: 2026-10-08T11:00:00.000Z",
    "npm global packages: 12 checked",
    "- Global tool update checks: Partial",
    "Bun global metadata is unavailable.",
    "## billing — Failed",
    "- Last successful scan: Never",
    "Known-advisory lookup failed.",
    "No findings recorded for this target.",
    "not evidence of safety",
  ])
    assert.ok(markdown.includes(text), text);
  const rows = parseCsv(exportFindings(snapshot, { kind: "all" }, "csv", generatedAt).text);
  const [header] = rows;
  const cell = (target: string, column: string) =>
    rows.find((row) => row[0] === target)![header!.indexOf(column)];
  assert.equal(cell("billing", "evidence_status"), "Failed");
  assert.equal(cell("billing", "last_successful_scan"), "Never");
  assert.equal(cell("billing", "incomplete_checks"), "Known-advisory lookup failed.");
  assert.equal(cell("This PC", "update_checks_status"), "Partial");
  assert.equal(cell("This PC", "generated_at"), generatedAt);
  const json = JSON.parse(exportFindings(snapshot, { kind: "all" }, "json", generatedAt).text);
  assert.deepEqual(
    json.targets.map(
      (target: { label: string; evidence: { status: string }; findings: unknown[] }) => [
        target.label,
        target.evidence.status,
        target.findings.length,
      ],
    ),
    [
      ["This PC", "complete", 1],
      ["storefront", "complete", 1],
      ["billing", "failed", 0],
      ["remote", "complete", 0],
    ],
  );
  assert.equal(json.targets[0].updateChecks.status, "partial");
  assert.match(json.notice, /not evidence of safety/);
});

test("CSV cells neutralize formula starts and keep every value in its own cell", () => {
  for (const [value, expected] of [
    ["=1+1", `"'=1+1"`],
    ["+cmd", `"'+cmd"`],
    ["-2", `"'-2"`],
    ["@SUM(A1)", `"'@SUM(A1)"`],
    ["\t=1", `"'=1"`],
    ["\r\n@x", `"'@x"`],
    ['say "hi", ok', `"say ""hi"", ok"`],
    ["plain", `"plain"`],
    [null, `""`],
  ] as const)
    assert.equal(csvCell(value), expected, JSON.stringify(value));
  for (const start of fullWidthFormulaStarts)
    assert.equal(csvCell(`${start}1`), `"'${start}1"`, `full-width ${start}`);
  const text = exportFindings(
    snapshot,
    { kind: "project", projectId: "storefront" },
    "csv",
    generatedAt,
  ).text;
  assert.ok(text.startsWith(bom), "Spreadsheets read the file as UTF-8");
  const rows = parseCsv(text);
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((row) => row.length === rows[0]!.length),
    "Every row has every column",
  );
  assert.ok(
    rows.flat().every((cell) => !formulaStart.test(cell)),
    "No cell starts a formula",
  );
});

test("Markdown escapes untrusted text and keeps each finding on one table row", () => {
  const markdown = exportFindings(
    snapshot,
    { kind: "project", projectId: "storefront" },
    "markdown",
    generatedAt,
  ).text;
  const row = markdown.split("\n").find((line) => line.includes("HYPERLINK"))!;
  assert.ok(row.startsWith("| ") && row.endsWith(" |"));
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 8, "Escaped pipes never add a column");
  assert.ok(!markdown.includes("<script>"), "No raw HTML");
  assert.doesNotMatch(markdown, /(?<!\\)\]\(/, "No unescaped link syntax");
  assert.ok(!markdown.includes(rightToLeftOverride), "No bidirectional override");
  assert.ok(markdown.includes("Ignored: Not reachable in our build"));
  assert.ok(
    markdown.includes("<https://osv.dev/vulnerability/GHSA-xxxx-yyyy>"),
    "Only a validated https advisory address is written as a link; a renderer may still link bare addresses, www names, emails, @handles, and #123 in text",
  );
  assert.equal(
    markdownText("a | b\n*c* _u_ ~s~ [d](e) `f` <g> &amp; back\\slash"),
    "a \\| b \\*c\\* \\_u\\_ \\~s\\~ \\[d\\](e) \\`f\\` \\<g\\> \\&amp; back\\\\slash",
  );
  assert.equal(markdownText("&#x202E; &lt;"), "\\&#x202E; \\&lt;", "No character references");
});

test("an advisory address leaves only when it is https, in every format, and never adds a column", () => {
  const withAddress = (advisoryUrl: string) => ({
    ...snapshot,
    findings: [finding({ advisoryUrl })],
  });
  const rowFor = (advisoryUrl: string) =>
    markdownLines(withAddress(advisoryUrl), { kind: "pc" }).find((line) =>
      line.includes("typescript"),
    )!;
  const csvAddress = (advisoryUrl: string) =>
    csvReader(withAddress(advisoryUrl), { kind: "pc" })("This PC", "advisory_url");
  const jsonAddress = (advisoryUrl: string) =>
    jsonOf(withAddress(advisoryUrl), { kind: "pc" }).targets[0].findings[0].advisoryUrl;
  const piped = rowFor("https://osv.dev/vulnerability/a|b");
  assert.ok(piped.includes("<https://osv.dev/vulnerability/a%7Cb>"));
  assert.equal(piped.split(/(?<!\\)\|/).length - 2, 8, "A pipe in an address never adds a column");
  assert.ok(
    rowFor("https://osv.dev/vulnerability/a_b~c").includes(
      " <https://osv.dev/vulnerability/a_b~c>",
    ),
    "A link target is never escaped",
  );
  for (const unsafe of ["javascript:alert(1)", "http://osv.dev/plain", "data:text/html,x", "osv"]) {
    assert.ok(!rowFor(unsafe).includes("<"), `Markdown: ${unsafe}`);
    assert.equal(csvAddress(unsafe), "", `CSV: ${unsafe}`);
    assert.equal(jsonAddress(unsafe), null, `JSON: ${unsafe}`);
  }
  const safe = "https://osv.dev/vulnerability/GHSA-1";
  assert.equal(csvAddress(safe), safe);
  assert.equal(jsonAddress(safe), safe);
});

test("plainText turns every control and format character into a space", () => {
  for (const code of [
    ...[0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x85, 0x9f, 0xad, 0x61c],
    ...[0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029],
    ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069],
    ...[0xfeff, 0xe0041],
  ])
    assert.equal(plainText(`a${char(code)}b`), "a b", code.toString(16));
  assert.equal(plainText(`a${rightToLeftOverride}b${char(0)}c\n d${char(0x200b)}`), "a b c d");
  assert.equal(plainText("  a   日本  b "), "a 日本 b");
  assert.equal(plainText(null), "");
  assert.equal(plainText(undefined), "");
});

test("exports never carry local folder paths, global locations, or the PC's name", () => {
  for (const format of ["markdown", "csv", "json"] as const) {
    const text = exportFindings(snapshot, { kind: "all" }, format, generatedAt).text;
    for (const hidden of [
      "C:\\Users\\owner",
      "C:\\\\Users\\\\owner",
      "AppData",
      "OWNER-LAPTOP",
      "pnpm-lock.yaml",
    ])
      assert.ok(!text.includes(hidden), `${format}: ${hidden}`);
    assert.ok(
      text.includes("https://github.com/owner/remote"),
      `${format}: a repository project keeps its provider address`,
    );
  }
});

test("JSON keeps the recorded finding fields, marks rules, and leaves out internal identities", () => {
  const json = JSON.parse(exportFindings(snapshot, { kind: "all" }, "json", generatedAt).text);
  const [hostile] = json.targets[1].findings;
  assert.equal(hostile.summary, "High advisory");
  assert.equal(hostile.snoozedOrIgnored, "Ignored: Not reachable in our build");
  assert.equal(hostile.advisoryUrl, "https://osv.dev/vulnerability/GHSA-xxxx-yyyy");
  assert.equal(hostile.lastSeenAt, "2026-10-08T11:00:00.000Z");
  for (const internal of ["id", "subjectId", "subjectLabel", "ruleId"])
    assert.ok(!(internal in hostile), internal);
  assert.equal(json.targets[0].findings[0].snoozedOrIgnored, null);
  const lost = exportFindings(
    { ...snapshot, findingRules: [] },
    { kind: "project", projectId: "storefront" },
    "markdown",
    generatedAt,
  ).text;
  assert.ok(
    lost
      .split("\n")
      .find((line) => line.includes("HYPERLINK"))!
      .endsWith(" | Snoozed or ignored |"),
    "A rule that cannot be read is still marked",
  );
});

test("the candidate column does not call a provider boundary a fix", () => {
  const markdown = exportFindings(snapshot, { kind: "all" }, "markdown", generatedAt).text;
  assert.ok(markdown.includes("| Candidate or provider boundary |"));
  assert.ok(!markdown.includes("Candidate or fixed"));
  const rows = parseCsv(exportFindings(snapshot, { kind: "all" }, "csv", generatedAt).text);
  const [header] = rows;
  assert.ok(!header!.includes("candidate_or_fixed_version"));
  const boundary = header!.indexOf("candidate_or_provider_boundary");
  assert.ok(boundary > 0);
  assert.equal(rows.find((row) => row[0] === "This PC")![boundary], "5.9.2");
});

test("findings kept by a failed or unsupported scan read as previous and unverified", () => {
  const kept = {
    ...snapshot,
    projects: [
      project("failed-scan", { evidence: failed }),
      project("old-lockfile", { evidence: { ...failed, status: "unsupported" } }),
      project("partial-scan", { evidence: { ...complete, status: "partial" } }),
      project("fresh-scan"),
    ],
    findings: ["failed-scan", "old-lockfile", "partial-scan", "fresh-scan"].map((id) =>
      finding({ id, subjectId: id, subjectLabel: id }),
    ),
  };
  const line = "- Findings below are from an earlier scan (previous, unverified).";
  /** Each target with whether its Markdown section and its JSON evidence mark the findings. */
  const marks = (from: typeof kept) => {
    const sections = exportFindings(from, { kind: "all" }, "markdown", generatedAt)
      .text.split("\n## ")
      .slice(1);
    const json = JSON.parse(exportFindings(from, { kind: "all" }, "json", generatedAt).text);
    return sections.map((section, index) => [
      section.split(" — ")[0],
      section.includes(line),
      json.targets[index].evidence.findingsPrevious,
    ]);
  };
  assert.deepEqual(marks(kept), [
    ["This PC", false, false],
    ["failed-scan", true, true],
    ["old-lockfile", true, true],
    ["partial-scan", false, false],
    ["fresh-scan", false, false],
  ]);
  // This PC keeps findings from earlier scans when its inventory or its update checks failed.
  const scanLost = { ...kept, inventory: { ...kept.inventory, evidence: failed } };
  assert.deepEqual(marks(scanLost)[0], ["This PC", true, true]);
  for (const status of ["failed", "unsupported"] as const) {
    const updatesLost = {
      ...kept,
      inventory: { ...kept.inventory, updateEvidence: { ...failed, status } },
    };
    assert.deepEqual(marks(updatesLost)[0], ["This PC", true, true], status);
  }
});

test("scope selects This PC, one project, or all of them, and filenames are safe", () => {
  assert.deepEqual(
    JSON.parse(exportFindings(snapshot, { kind: "pc" }, "json", generatedAt).text).targets.map(
      (target: { label: string }) => target.label,
    ),
    ["This PC"],
  );
  assert.deepEqual(
    JSON.parse(
      exportFindings(snapshot, { kind: "project", projectId: "billing" }, "json", generatedAt).text,
    ).scope,
    { kind: "project", project: "billing" },
  );
  assert.equal(
    exportFilename(snapshot, { kind: "all" }, "markdown", generatedAt),
    "versionstead-this-pc-and-projects-2026-10-08.md",
  );
  assert.equal(
    exportFilename(snapshot, { kind: "pc" }, "csv", generatedAt),
    "versionstead-this-pc-2026-10-08.csv",
  );
  assert.equal(
    exportFilename(
      { projects: [project("p", { name: "My App / ../v2 ✓" })] },
      { kind: "project", projectId: "p" },
      "json",
      generatedAt,
    ),
    "versionstead-my-app-v2-2026-10-08.json",
  );
  assert.equal(
    exportFilename(
      { projects: [project("p", { name: "日本" })] },
      { kind: "project", projectId: "p" },
      "json",
      generatedAt,
    ),
    "versionstead-project-2026-10-08.json",
  );
  assert.equal(
    exportFilename(
      { projects: [project("p", { name: `${"a".repeat(39)} tail` })] },
      { kind: "project", projectId: "p" },
      "json",
      generatedAt,
    ),
    `versionstead-${"a".repeat(39)}-2026-10-08.json`,
    "A cut name never leaves a dangling dash",
  );
});

// One project for each status, with scan times, coverage, and checks of its own and one finding under a
// rule, so a field that is swapped, blanked, or dropped in any format changes one of these values.
type StatusCase = {
  label: string;
  evidence: ScanEvidence;
  rule: Pick<FindingRule, "mode" | "reason" | "untilVersion">;
  ruleLabel: string;
};
const ignoreRule = { mode: "ignore", reason: "Accepted for now" } as const;
const snoozeRule = { mode: "snooze", untilVersion: "5.9.2" } as const;
const statusCases: StatusCase[] = [
  {
    label: "Collected",
    evidence: {
      status: "complete",
      lastSuccess: "2026-10-01T01:00:00.000Z",
      lastAttempt: "2026-10-01T02:00:00.000Z",
      coverage: ["npm registry: 3 packages checked", "OSV: 3 packages checked"],
      errors: [],
    },
    rule: ignoreRule,
    ruleLabel: "Ignored: Accepted for now",
  },
  {
    label: "Partial",
    evidence: {
      status: "partial",
      lastSuccess: "2026-10-02T01:00:00.000Z",
      lastAttempt: "2026-10-02T02:00:00.000Z",
      coverage: ["npm registry: 2 packages checked"],
      errors: ["OSV lookup failed.", "OSV rate limit reached."],
    },
    rule: snoozeRule,
    ruleLabel: "Snoozed until a version newer than 5.9.2",
  },
  {
    label: "Failed",
    evidence: {
      status: "failed",
      lastSuccess: "2026-10-03T01:00:00.000Z",
      lastAttempt: "2026-10-03T02:00:00.000Z",
      coverage: [],
      errors: ["The scan stopped before it finished."],
    },
    rule: ignoreRule,
    ruleLabel: "Ignored: Accepted for now",
  },
  {
    label: "Unsupported",
    evidence: {
      status: "unsupported",
      lastSuccess: null,
      lastAttempt: "2026-10-04T02:00:00.000Z",
      coverage: ["Lockfile format 9"],
      errors: ["This lockfile format is not supported.", "No packages were read."],
    },
    rule: snoozeRule,
    ruleLabel: "Snoozed until a version newer than 5.9.2",
  },
  {
    label: "Not scanned",
    evidence: {
      status: "not-scanned",
      lastSuccess: null,
      lastAttempt: null,
      coverage: [],
      errors: [],
    },
    rule: ignoreRule,
    ruleLabel: "Ignored: Accepted for now",
  },
  {
    label: "Scanning",
    evidence: {
      status: "scanning",
      lastSuccess: "2026-10-06T01:00:00.000Z",
      lastAttempt: "2026-10-06T02:00:00.000Z",
      coverage: ["npm registry: 1 package checked"],
      errors: ["OSV lookup pending."],
    },
    rule: snoozeRule,
    ruleLabel: "Snoozed until a version newer than 5.9.2",
  },
];
/** This PC (scan and update checks) and one project, all in this case's status, each with one ruled finding. */
const statusSnapshot = (index: number, { evidence, rule }: StatusCase): typeof snapshot => {
  const tool = (subjectId: string, name: string, seenMinute: string) =>
    finding({
      id: name,
      subjectId,
      name,
      packageName: name,
      detectedAt: `2026-09-0${index + 1}T10:00:00.000Z`,
      lastSeenAt: `2026-10-0${index + 1}T09:${seenMinute}:00.000Z`,
      ruleId: "rule",
    });
  return {
    ...snapshot,
    inventory: { ...snapshot.inventory, evidence, updateEvidence: evidence },
    projects: [project("project", { evidence })],
    findings: [tool("pc", "tool-pc", "00"), tool("project", "tool-project", "30")],
    findingRules: [
      {
        id: "rule",
        scope: { subjectId: "pc", kind: "update", packageName: "tool-pc" },
        ...rule,
        createdAt: generatedAt,
      },
    ],
  };
};

test("every status keeps its scan times, coverage, and incomplete checks in every format", () => {
  for (const [index, statusCase] of statusCases.entries()) {
    const { label, evidence, ruleLabel } = statusCase;
    const from = statusSnapshot(index, statusCase);
    const markdown = exportFindings(from, { kind: "all" }, "markdown", generatedAt).text;
    const sections = markdown.split("\n## ").slice(1);
    const csv = csvReader(from);
    const json = jsonOf(from);
    const never = (value: string | null) => value ?? "Never";
    const coverage = evidence.coverage.join("; ");
    const checks = evidence.errors.join(" ");
    const recorded = {
      status: evidence.status,
      lastSuccess: evidence.lastSuccess,
      lastAttempt: evidence.lastAttempt,
      coverage: evidence.coverage,
      incompleteChecks: evidence.errors,
    };
    assert.equal(
      markdown.split("\n")[2],
      `Generated ${generatedAt}. ${exportNotice}`,
      `${label}: the generation time and the notice open the export`,
    );
    assert.equal(json.generatedAt, generatedAt, label);
    assert.equal(json.notice, exportNotice, label);

    for (const [target, tool] of [
      ["This PC", "tool-pc"],
      ["project", "tool-project"],
    ] as const) {
      const name = `${label}, ${target}`;
      const found = from.findings.find((item) => item.name === tool)!;
      const lines = sections.find((section) => section.startsWith(`${target} — `))!.split("\n");
      assert.equal(lines[0], `${target} — ${label}`, name);
      for (const line of [
        `- Last successful scan: ${never(evidence.lastSuccess)}`,
        `- Latest attempt: ${never(evidence.lastAttempt)}`,
        `- Coverage: ${coverage || "None recorded"}`,
        `- Incomplete checks: ${checks || "None reported"}`,
      ])
        assert.ok(lines.includes(line), `${name}: ${line}`);
      assert.ok(
        lines
          .find((line) => line.startsWith(`| ${tool} |`))!
          .endsWith(` | ${found.lastSeenAt} | ${ruleLabel} |`),
        `${name}: the row ends with when it was last seen and its rule`,
      );

      assert.deepEqual(
        [
          "evidence_status",
          "last_successful_scan",
          "latest_attempt",
          "coverage_notes",
          "incomplete_checks",
          "first_detected",
          "last_seen",
          "snoozed_or_ignored",
          "generated_at",
        ].map((column) => csv(target, column)),
        [
          label,
          never(evidence.lastSuccess),
          never(evidence.lastAttempt),
          coverage,
          checks,
          found.detectedAt,
          found.lastSeenAt,
          ruleLabel,
          generatedAt,
        ],
        name,
      );

      const exported = json.targets.find((item: { label: string }) => item.label === target);
      const { findingsPrevious, ...evidenceFields } = exported.evidence;
      assert.deepEqual(evidenceFields, recorded, name);
      assert.equal(typeof findingsPrevious, "boolean", name);
      assert.equal(exported.findings[0].lastSeenAt, found.lastSeenAt, name);
      assert.equal(exported.findings[0].snoozedOrIgnored, ruleLabel, name);
    }

    // This PC's global tool update checks report the same fields.
    assert.ok(
      markdown
        .split("\n")
        .includes(
          `- Global tool update checks: ${label}, last successful ${never(evidence.lastSuccess)}; incomplete checks: ${checks || "None reported"}`,
        ),
      `${label}: update checks`,
    );
    assert.deepEqual(
      ["update_checks_status", "update_checks_last_success"].map((column) =>
        csv("This PC", column),
      ),
      [label, never(evidence.lastSuccess)],
      `${label}: update checks`,
    );
    assert.deepEqual(json.targets[0].updateChecks, recorded, `${label}: update checks`);
  }
});

// One string with every kind of Markdown syntax: emphasis, strikethrough, a code span, a link, an image,
// HTML, an entity, a pipe, heading markers across a line break, and a backslash.
const hostile = [
  "*a* _a_ ~~a~~ `code`",
  "[x](https://evil.example) ![i](https://evil.example/i.png)",
  "<b>b</b> &amp; a|b",
  "\n# heading\n## heading",
  "back\\slash",
].join(" ");
const hostileEscaped =
  "\\*a\\* \\_a\\_ \\~\\~a\\~\\~ \\`code\\` \\[x\\](https://evil.example) !\\[i\\](https://evil.example/i.png) \\<b\\>b\\</b\\> \\&amp; a\\|b # heading ## heading back\\\\slash";
const hostileEvidence: ScanEvidence = {
  status: "partial",
  lastSuccess: hostile,
  lastAttempt: hostile,
  coverage: [hostile, hostile],
  errors: [hostile, hostile],
};
const hostileFinding = (changes: Partial<Finding>) =>
  finding({
    subjectId: "hostile",
    name: hostile,
    packageName: `${hostile} pkg`,
    installedVersion: hostile,
    availableVersion: hostile,
    source: hostile,
    description: hostile,
    lastSeenAt: hostile,
    ...changes,
  });
const hostileSnapshot: typeof snapshot = {
  ...snapshot,
  inventory: { ...snapshot.inventory, evidence: hostileEvidence, updateEvidence: hostileEvidence },
  projects: [
    project("hostile", {
      name: hostile,
      evidence: hostileEvidence,
      repository: {
        provider: "github",
        repositoryId: "9",
        name: "owner/hostile",
        ref: "main",
        commit: null,
        url: hostile,
      },
    }),
  ],
  findings: [
    hostileFinding({ id: "hostile-update", ruleId: "hostile-rule" }),
    hostileFinding({
      id: "hostile-advisory",
      kind: "advisory",
      severity: "high",
      advisoryUrl: "https://osv.dev/vulnerability/GHSA_x~y|z[1]",
    }),
  ],
  findingRules: [
    {
      id: "hostile-rule",
      scope: { subjectId: "hostile", kind: "update", packageName: hostile },
      mode: "ignore",
      reason: hostile,
      createdAt: generatedAt,
    },
  ],
};

test("Markdown escapes every untrusted field, and each finding stays one row of eight cells", () => {
  assert.equal(markdownText(hostile), hostileEscaped);
  const projectLines = markdownLines(hostileSnapshot, { kind: "project", projectId: "hostile" });
  const pcLines = markdownLines(hostileSnapshot, { kind: "pc" });
  const evidenceLines = [
    `- Last successful scan: ${hostileEscaped}`,
    `- Latest attempt: ${hostileEscaped}`,
    `- Coverage: ${hostileEscaped}; ${hostileEscaped}`,
    `- Incomplete checks: ${hostileEscaped} ${hostileEscaped}`,
  ];
  for (const expected of [
    `# Versionstead findings: ${hostileEscaped}`,
    `## ${hostileEscaped} — Partial`,
    `- Repository: ${hostileEscaped}`,
    ...evidenceLines,
  ])
    assert.ok(projectLines.includes(expected), expected);
  for (const expected of [
    "## This PC — Partial",
    ...evidenceLines,
    `- Global tool update checks: Partial, last successful ${hostileEscaped}; incomplete checks: ${hostileEscaped} ${hostileEscaped}`,
  ])
    assert.ok(pcLines.includes(expected), expected);
  assert.deepEqual(
    projectLines.filter((line) => line.startsWith("#")),
    [`# Versionstead findings: ${hostileEscaped}`, `## ${hostileEscaped} — Partial`],
    "Heading markers in untrusted text never start a line",
  );

  const rows = findingRows(projectLines);
  assert.equal(rows.length, 2, "Each finding is one line");
  assert.ok(rows.every((row) => row.endsWith(" |")));
  // The advisory is more severe, so it comes first.
  const [advisory, update] = rows.map(cellsOf);
  const packageCell = `${hostileEscaped} (${hostileEscaped} pkg)`;
  assert.deepEqual(update, [
    packageCell,
    hostileEscaped,
    hostileEscaped,
    "Update available",
    hostileEscaped,
    hostileEscaped,
    hostileEscaped,
    `Ignored: ${hostileEscaped}`,
  ]);
  assert.deepEqual(advisory, [
    packageCell,
    hostileEscaped,
    hostileEscaped,
    "High advisory",
    hostileEscaped,
    `${hostileEscaped} <https://osv.dev/vulnerability/GHSA_x~y%7Cz[1]>`,
    hostileEscaped,
    "",
  ]);

  // Nothing is left unescaped but the table's own nine pipes and the https links.
  for (const line of [...projectLines, ...pcLines]) {
    const bare = line
      .replace(/\\[\\`*_[\]<>|~&]/g, "")
      .replace(/<https:\/\/[^\s<>]+>/g, "")
      .replace(/[^\\`*_[\]<>|~&]/g, "");
    assert.equal(bare, line.startsWith("| ") ? "|".repeat(9) : "", line);
  }
});

test("a repository address is written as a link without escapes, and anything else as escaped text", () => {
  const repositoryLine = (url: string) =>
    markdownLines(
      {
        ...snapshot,
        projects: [
          project("r", {
            repository: {
              provider: "github",
              repositoryId: "2",
              name: "owner/r",
              ref: "main",
              commit: null,
              url,
            },
          }),
        ],
      },
      { kind: "project", projectId: "r" },
    ).find((line) => line.startsWith("- Repository: "));
  assert.equal(
    repositoryLine("https://github.com/owner/my_repo~x"),
    "- Repository: <https://github.com/owner/my_repo~x>",
    "A link target is never escaped",
  );
  assert.equal(
    repositoryLine("https://github.com/owner/a|b"),
    "- Repository: <https://github.com/owner/a%7Cb>",
  );
  for (const other of ["http://github.com/owner/my_repo", "javascript:alert(1)", "owner/my_repo"])
    assert.equal(repositoryLine(other), `- Repository: ${markdownText(other)}`, other);
});

test("an incomplete check leaves the Installed cell blank, and an update with no known version says Unknown", () => {
  const gap = finding({
    id: "gap",
    kind: "coverage",
    name: "Incomplete checks",
    packageName: null,
    installedVersion: null,
    availableVersion: null,
    severity: "unknown",
    source: "Global tool collector",
    description: "Known-advisory lookup failed.",
  });
  const unknownVersion = finding({ id: "no-version", installedVersion: null });
  const rows = findingRows(
    markdownLines({ ...snapshot, findings: [gap, unknownVersion] }, { kind: "pc" }),
  ).map(cellsOf);
  assert.deepEqual(rows, [
    [
      "Incomplete checks",
      "",
      "",
      "Incomplete check",
      "Global tool collector",
      "Known-advisory lookup failed.",
      gap.lastSeenAt,
      "",
    ],
    [
      "typescript",
      "Unknown",
      "5.9.2",
      "Update available",
      "npm global",
      unknownVersion.description,
      unknownVersion.lastSeenAt,
      "",
    ],
  ]);
});

test("Markdown shortens a long description to 300 characters without splitting one, and the other formats keep it whole", () => {
  const long = `${"a".repeat(298)}${char(0x1f600)}${"b".repeat(100)}`;
  const from = { ...snapshot, findings: [finding({ description: long })] };
  const [row] = findingRows(markdownLines(from, { kind: "pc" }));
  assert.equal(cellsOf(row!)[5], `${"a".repeat(298)}${char(0x1f600)}…`);
  assert.equal(csvReader(from, { kind: "pc" })("This PC", "description"), long);
  assert.equal(jsonOf(from, { kind: "pc" }).targets[0].findings[0].description, long);
});

// Every Finding field, so the export has a value to carry or to leave out for each.
const fullFinding: Finding = finding({
  id: "full",
  ruleId: "ignore-1",
  advisoryUrl: "https://osv.dev/vulnerability/GHSA-full",
  effectiveDate: "2026-12-31",
  installScript: true,
  candidateDeprecated: "Use 6.x instead.",
  publishedAt: "2026-10-01T08:00:00.000Z",
  license: "Apache-2.0",
  provenance: true,
});

test("JSON lists the finding fields it carries, and every contract field is carried or left out on purpose", () => {
  const carried = [
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
  ];
  // They name this PC or join findings internally.
  const leftOut = ["id", "subjectId", "subjectLabel", "ruleId"];
  assert.deepEqual(
    Object.keys(Finding.fields).filter((field) => ![...carried, ...leftOut].includes(field)),
    [],
    "A new Finding field needs a decision: carry it in the JSON export and in this list, or leave it out on purpose",
  );
  assert.deepEqual(
    Object.keys(fullFinding).toSorted(),
    Object.keys(Finding.fields).toSorted(),
    "The fixture sets every Finding field",
  );
  // A field the export does not list never reaches it, even when a finding holds one.
  const undecided = { ...fullFinding, undecided: "not listed" } as Finding;
  const [exported] = jsonOf({ ...snapshot, findings: [undecided] }, { kind: "pc" }).targets[0]
    .findings;
  assert.deepEqual(
    Object.keys(exported).toSorted(),
    [...carried, "summary", "snoozedOrIgnored"].toSorted(),
  );
  assert.deepEqual(exported, {
    kind: "update",
    name: "typescript",
    packageName: "typescript",
    installedVersion: "5.4.0",
    availableVersion: "5.9.2",
    severity: "info",
    source: "npm global",
    description: "A newer stable release is available from the public npm registry.",
    advisoryUrl: "https://osv.dev/vulnerability/GHSA-full",
    detectedAt: "2026-10-08T10:00:00.000Z",
    lastSeenAt: "2026-10-08T11:00:00.000Z",
    effectiveDate: "2026-12-31",
    installScript: true,
    candidateDeprecated: "Use 6.x instead.",
    publishedAt: "2026-10-01T08:00:00.000Z",
    license: "Apache-2.0",
    provenance: true,
    summary: "Update available",
    snoozedOrIgnored: "Ignored: Not reachable in our build",
  });
});

test("JSON writes characters that hide or reorder text as escapes, and reads back as the same text", () => {
  const codes = [
    ...[0x7f, 0x85, 0x9b, 0xad, 0x200b, 0x200e, 0x2028, 0x2029],
    ...[0x202e, 0x2066, 0xfeff, 0xe0041],
  ];
  const sneaky = `${codes.map((code) => `a${char(code)}b`).join(" ")} 日本`;
  const from = {
    ...snapshot,
    projects: [
      project("p", {
        name: `name${rightToLeftOverride}`,
        evidence: { ...complete, coverage: [`note${char(0x2028)}`] },
      }),
    ],
    findings: [finding({ name: sneaky, description: sneaky })],
  };
  const text = exportFindings(from, { kind: "all" }, "json", generatedAt).text;
  for (const code of codes) {
    const escape = char(code)
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    assert.ok(!text.includes(char(code)), `U+${code.toString(16)} is not written as it is`);
    assert.ok(text.includes(escape), `U+${code.toString(16)} is written as ${escape}`);
  }
  assert.ok(text.includes("日本"), "Readable text stays as it is");
  assert.ok(text.startsWith('{\n  "format"') && text.endsWith("}\n"), "Indentation is kept");
  const read = JSON.parse(text);
  assert.equal(read.targets[0].findings[0].name, sneaky);
  assert.equal(read.targets[0].findings[0].description, sneaky);
  assert.equal(read.targets[1].label, `name${rightToLeftOverride}`);
  assert.deepEqual(read.targets[1].evidence.coverage, [`note${char(0x2028)}`]);
  // Untrusted text round-trips unchanged: the escapes are only in the written form.
  const hostileRead = jsonOf(hostileSnapshot, { kind: "project", projectId: "hostile" });
  assert.equal(hostileRead.targets[0].label, hostile);
  assert.equal(hostileRead.targets[0].repository, hostile);
  assert.equal(hostileRead.targets[0].findings[1].description, hostile);
});

test("the dialog's scope menu values round-trip, and an unknown value falls back to everything", () => {
  const scopes: ExportScope[] = [
    { kind: "all" },
    { kind: "pc" },
    { kind: "project", projectId: "storefront" },
    { kind: "project", projectId: "a:b:c" },
  ];
  for (const scope of scopes) assert.deepEqual(choiceScope(scopeChoice(scope)), scope);
  assert.equal(scopeChoice({ kind: "pc" }), "pc");
  assert.equal(scopeChoice({ kind: "project", projectId: "storefront" }), "project:storefront");
  assert.deepEqual(choiceScope("nonsense"), { kind: "all" });
});

test("a copy leaves out the byte order mark that only a saved CSV file needs", () => {
  const csv = exportFindings(snapshot, { kind: "pc" }, "csv", generatedAt);
  assert.ok(csv.text.startsWith(bom), "The saved file keeps it, so a spreadsheet reads UTF-8");
  assert.equal(copyableText(csv), csv.text.slice(bom.length));
  assert.ok(copyableText(csv).startsWith('"target"'));
  for (const format of ["markdown", "json"] as const) {
    const file = exportFindings(snapshot, { kind: "pc" }, format, generatedAt);
    assert.equal(copyableText(file), file.text);
  }
});

test("each format has its MIME type and ends its last line", () => {
  const file = (format: ExportFormat) =>
    exportFindings(snapshot, { kind: "pc" }, format, generatedAt);
  assert.equal(file("markdown").mime, "text/markdown;charset=utf-8");
  assert.equal(file("csv").mime, "text/csv;charset=utf-8");
  assert.equal(file("json").mime, "application/json;charset=utf-8");
  assert.ok(file("markdown").text.endsWith("\n") && !file("markdown").text.endsWith("\n\n"));
  assert.ok(file("csv").text.endsWith("\r\n") && !file("csv").text.endsWith("\r\n\r\n"));
  assert.ok(file("json").text.endsWith("}\n"));
});

test("the export names what it holds: not everything, and twin projects stay apart", () => {
  const twins = {
    ...snapshot,
    projects: [project("t1", { name: "twin" }), project("t2", { name: "twin" }), project("solo")],
  };
  const exportOf = (scope: ExportScope, format: ExportFormat) =>
    exportFindings(twins, scope, format, generatedAt);
  const all = exportOf({ kind: "all" }, "markdown");
  assert.ok(all.text.startsWith("# Versionstead findings: This PC and all projects\n"));
  assert.equal(all.filename, "versionstead-this-pc-and-projects-2026-10-08.md");
  const first = exportOf({ kind: "project", projectId: "t1" }, "markdown");
  const second = exportOf({ kind: "project", projectId: "t2" }, "markdown");
  assert.ok(first.text.startsWith("# Versionstead findings: twin (1 of 2)\n"));
  assert.ok(second.text.startsWith("# Versionstead findings: twin (2 of 2)\n"));
  assert.equal(first.filename, "versionstead-twin-1-of-2-2026-10-08.md");
  assert.equal(second.filename, "versionstead-twin-2-of-2-2026-10-08.md");
  const solo = exportOf({ kind: "project", projectId: "solo" }, "json");
  assert.equal(solo.filename, "versionstead-solo-2026-10-08.json");
  assert.equal(JSON.parse(solo.text).scope.project, "solo");
  assert.equal(
    JSON.parse(exportOf({ kind: "project", projectId: "t1" }, "json").text).scope.project,
    "twin (1 of 2)",
  );
});
