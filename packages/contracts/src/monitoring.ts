import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ProjectIcon, ProjectActions, ProjectChanges } from "./project-settings.ts";

export const EvidenceStatus = Schema.Literals([
  "not-scanned",
  "scanning",
  "complete",
  "partial",
  "failed",
  "unsupported",
]);
const NullableString = Schema.NullOr(Schema.String);
export const ScanEvidence = Schema.Struct({
  status: EvidenceStatus,
  lastAttempt: NullableString,
  lastSuccess: NullableString,
  /** The success before `lastSuccess`; null when that was the first; absent in evidence saved before Wave 4. */
  previousSuccess: Schema.optional(NullableString),
  coverage: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
});
export type ScanEvidence = typeof ScanEvidence.Type;

export const GlobalToolSource = Schema.Struct({
  manager: Schema.Literals(["npm", "bun"]),
  status: Schema.Literals(["detected", "not-installed", "unavailable"]),
  version: NullableString,
  root: NullableString,
  registry: Schema.Literals(["public", "unsupported", "unknown"]),
  blockedScopes: Schema.Array(Schema.String),
  checkedAt: NullableString,
  error: NullableString,
  /** npm source only: the version of the Node.js first on the owner's PATH when sources were discovered. */
  nodeVersion: Schema.optional(NullableString),
});
export type GlobalToolSource = typeof GlobalToolSource.Type;

export const Installation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  source: Schema.String,
  scope: Schema.Literals(["machine", "user", "unknown"]),
  channel: Schema.String,
  packageId: Schema.optional(Schema.String),
  manager: Schema.optional(Schema.Literals(["npm", "bun"])),
  rootId: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.Literals(["registry", "local", "unknown"])),
  updateCheckedAt: Schema.optional(NullableString),
  availableVersion: NullableString,
  updateStatus: Schema.Literals(["unknown", "current", "available"]),
});
export type Installation = typeof Installation.Type;

export const Dependency = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  packageName: Schema.String,
  requested: NullableString,
  requestedRange: Schema.optional(NullableString),
  resolved: NullableString,
  origin: Schema.Literals(["registry", "workspace", "git", "local", "unknown"]),
  role: Schema.Literals(["production", "development", "optional", "transitive"]),
  importer: Schema.String,
  availableVersion: NullableString,
  latestVersion: NullableString,
  versionSource: Schema.optional(Schema.String),
  versionStatus: Schema.optional(
    Schema.Literals(["not-checked", "checked", "failed", "unsupported"]),
  ),
  advisoryStatus: Schema.Literals(["not-checked", "checked", "failed", "unsupported"]),
  advisoryIds: Schema.Array(Schema.String),
});
export type Dependency = typeof Dependency.Type;

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.optional(Schema.NullOr(ProjectIcon)),
  actions: Schema.optional(ProjectActions),
  path: Schema.String,
  mode: Schema.Literals(["maintained", "watch"]),
  packageManager: Schema.Literals(["npm", "pnpm", "bun", "unknown"]),
  manifestPath: NullableString,
  lockfilePath: NullableString,
  inputFingerprint: Schema.optional(NullableString),
  repository: Schema.optional(
    Schema.Struct({
      provider: Schema.Literals(["github", "gitlab"]),
      repositoryId: Schema.String,
      name: Schema.String,
      ref: Schema.String,
      commit: NullableString,
      url: Schema.String,
    }),
  ),
  git: Schema.optional(
    Schema.Struct({ branch: NullableString, commit: NullableString, dirty: Schema.Boolean }),
  ),
  evidence: ScanEvidence,
  dependencies: Schema.Array(Dependency),
  createdAt: Schema.String,
});
export type Project = typeof Project.Type;

const knownFindingKinds = ["update", "advisory", "coverage", "lifecycle"] as const;
const isKnownFindingKind = (kind: string): kind is (typeof knownFindingKinds)[number] =>
  (knownFindingKinds as readonly string[]).includes(kind);
/**
 * A finding's kind. A kind a newer Versionstead adds decodes as "other" and renders generically, so
 * newer evidence never fails a whole snapshot; a non-string or oversized kind is still invalid, and
 * every other field keeps its strict validation.
 */
export const FindingKind = Schema.String.check(Schema.isMaxLength(50)).pipe(
  Schema.decodeTo(
    Schema.Literals(["update", "advisory", "coverage", "lifecycle", "other"]),
    SchemaTransformation.transform({
      decode: (kind: string) => (isKnownFindingKind(kind) ? kind : "other"),
      encode: (kind: string) => kind,
    }),
  ),
);
export const Finding = Schema.Struct({
  id: Schema.String,
  kind: FindingKind,
  subjectId: Schema.String,
  subjectLabel: Schema.String,
  name: Schema.String,
  packageName: NullableString,
  installedVersion: NullableString,
  availableVersion: NullableString,
  severity: Schema.Literals(["info", "low", "moderate", "high", "critical", "unknown"]),
  source: Schema.String,
  description: Schema.String,
  advisoryUrl: NullableString,
  detectedAt: Schema.String,
  lastSeenAt: Schema.String,
  /** Lifecycle findings: the YYYY-MM-DD day the support change takes effect, when announced. */
  effectiveDate: Schema.optional(Schema.String),
  /** Update findings: true when the candidate adds an install script the installed version lacks; absent when never checked. */
  installScript: Schema.optional(Schema.Boolean),
  /** Update findings: the publisher's message when the candidate version is deprecated; null when it is not; absent when never checked. */
  candidateDeprecated: Schema.optional(NullableString),
  /** Update findings: when the candidate was published, from deps.dev; absent when unknown. */
  publishedAt: Schema.optional(Schema.String),
  /** Update findings: the candidate's declared licenses (SPDX), from deps.dev; absent when unknown. */
  license: Schema.optional(Schema.String),
  /** Update findings: present when deps.dev reports verified provenance for the candidate; absent is unknown, not unattested. */
  provenance: Schema.optional(Schema.Literal(true)),
  /** Set in snapshots while a snooze or ignore rule hides this finding; never stored. */
  ruleId: Schema.optional(Schema.String),
});
export type Finding = typeof Finding.Type;

/** A snooze or ignore rule: the finding's subject, package (or name), and kind, plus the identity that must not change. */
export const FindingRule = Schema.Struct({
  id: Schema.String,
  scope: Schema.Struct({
    subjectId: Schema.String,
    kind: Finding.fields.kind,
    packageName: Schema.String,
    /** An advisory's identity, a digest of an incomplete check's text, a lifecycle severity, or an unknown kind's finding id. */
    detail: Schema.optional(Schema.String),
    /** An advisory's severity when the rule was made; the advisory shows again once it is rated higher. */
    severity: Schema.optional(Finding.fields.severity),
  }),
  mode: Schema.Literals(["snooze", "ignore"]),
  until: Schema.optional(Schema.String),
  untilVersion: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  createdAt: Schema.String,
});
export type FindingRule = typeof FindingRule.Type;
export const decodeFindingRule = Schema.decodeUnknownSync(FindingRule);

/** A finding a later successful check stopped reporting; kept 30 days, at most 500. */
export const ResolvedFinding = Schema.Struct({ ...Finding.fields, resolvedAt: Schema.String });
export type ResolvedFinding = typeof ResolvedFinding.Type;

export const ScanRecord = Schema.Struct({
  id: Schema.String,
  targetId: Schema.String,
  targetLabel: Schema.String,
  inputFingerprint: Schema.optional(NullableString),
  kind: Schema.Literals(["pc", "project"]),
  startedAt: Schema.String,
  finishedAt: NullableString,
  status: EvidenceStatus,
  coverage: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
  /** True when the owner cancelled this attempt; its errors then read "Cancelled by you". */
  cancelled: Schema.optional(Schema.Boolean),
});
export type ScanRecord = typeof ScanRecord.Type;

export const PendingNotification = Schema.Struct({
  id: Schema.String,
  findingId: Schema.String,
  title: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  deliveredAt: NullableString,
});
export type PendingNotification = typeof PendingNotification.Type;

export const ScanTarget = Schema.Struct({
  targetId: Schema.String,
  targetLabel: Schema.String,
  kind: Schema.Literals(["pc", "project"]),
});
export type ScanTarget = typeof ScanTarget.Type;
export const ScanStage = Schema.Literals([
  "inventory",
  "pc-updates",
  "project-inputs",
  "advisories",
  "advisory-details",
  "native-versions",
  "versions",
  "release-facts",
  "saving",
]);
export const ActiveScan = Schema.Struct({
  ...ScanTarget.fields,
  scanId: Schema.String,
  stage: ScanStage,
  completed: Schema.NullOr(Schema.Number),
  total: Schema.NullOr(Schema.Number),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  /** True once the scan has started writing evidence; from then on it cannot be cancelled. */
  writing: Schema.optional(Schema.Boolean),
});
export type ActiveScan = typeof ActiveScan.Type;
export const ScanProgress = Schema.Struct({
  active: Schema.NullOr(ActiveScan),
  queued: Schema.Array(ScanTarget),
});
export type ScanProgress = typeof ScanProgress.Type;

export const NotificationSummary = Schema.Struct({
  id: Schema.String,
  updateCount: Schema.Number,
  newUpdateCount: Schema.Number,
  projectCount: Schema.Number,
  pcCount: Schema.Number,
  advisoryCount: Schema.Number,
  newAdvisoryCount: Schema.Number,
  title: Schema.String,
  body: Schema.String,
  filter: Schema.Literals(["updates", "advisories", "all"]),
  /** True while quiet hours hold the native notification; in-app summaries ignore it. */
  quiet: Schema.optional(Schema.Boolean),
});
export type NotificationSummary = typeof NotificationSummary.Type;

const ReleaseCooldownDays = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 }));
export const notificationScopes = ["all", "advisories", "high-advisories"] as const;
const NotificationScope = Schema.Literals(notificationScopes);
const hourMinute = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Whether `value` is a local `HH:MM` time, as the settings schema reads it; the coordinator and the settings page share this check. */
export const isHourMinute = (value: unknown): value is string =>
  typeof value === "string" && hourMinute.test(value);
const HourMinute = Schema.String.check(Schema.isPattern(hourMinute));
/** A local time window in which native notifications wait; it may cross midnight. */
export const QuietHours = Schema.Struct({ start: HourMinute, end: HourMinute });
export const MonitoringSettings = Schema.Struct({
  paused: Schema.Boolean,
  pcIntervalMinutes: Schema.Number,
  projectIntervalMinutes: Schema.Number,
  notifyNewFindings: Schema.Boolean,
  /** Days before a new release is old enough to install without a question; 0 turns the cooldown off. */
  releaseCooldownDays: Schema.optional(ReleaseCooldownDays),
  /** Whether update candidates are looked up on deps.dev. */
  useDepsDev: Schema.optional(Schema.Boolean),
  /**
   * Which new findings notify: every update and advisory, advisories only, or high and critical
   * advisories, which also takes advisories without a rating.
   */
  notificationScope: Schema.optional(NotificationScope),
  /** Whether new findings in watch-only projects notify; off by default. */
  notifyWatchOnly: Schema.optional(Schema.Boolean),
  /** Local quiet hours for native notifications; null when unset. */
  quietHours: Schema.optional(Schema.NullOr(QuietHours)),
  /** Local HH:MM of the daily digest; null delivers after each scan cycle. */
  digestAt: Schema.optional(Schema.NullOr(HourMinute)),
});
export type MonitoringSettings = typeof MonitoringSettings.Type;

export const MonitoringSnapshot = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  features: Schema.optional(
    Schema.Literals([
      "settings-repositories-connections-v1",
      "settings-repositories-connections-v2",
      "settings-repositories-connections-v3",
      "settings-repositories-connections-v4",
      "settings-repositories-connections-v5",
      "settings-repositories-connections-v6",
      "settings-repositories-connections-v7",
      "settings-repositories-connections-v8",
      "settings-repositories-connections-v9",
      "settings-repositories-connections-v10",
    ]),
  ),
  runtime: Schema.Struct({
    startedAt: Schema.String,
    mode: Schema.Literals(["interactive", "background"]),
    host: Schema.Literals(["session", "boot-task", "unconfigured"]),
    platform: Schema.String,
    nextScanAt: NullableString,
  }),
  device: Schema.Struct({ id: Schema.String, label: Schema.String, platform: Schema.String }),
  settings: MonitoringSettings,
  inventory: Schema.Struct({
    collector: Schema.optional(Schema.Literal("npm-bun-global-v1")),
    managers: Schema.optional(Schema.Array(GlobalToolSource)),
    evidence: ScanEvidence,
    updateEvidence: Schema.optional(ScanEvidence),
    installations: Schema.Array(Installation),
  }),
  projects: Schema.Array(Project),
  findings: Schema.Array(Finding),
  findingRules: Schema.optional(Schema.Array(FindingRule).check(Schema.isMaxLength(500))),
  resolvedFindings: Schema.optional(Schema.Array(ResolvedFinding).check(Schema.isMaxLength(500))),
  history: Schema.Array(ScanRecord),
  notifications: Schema.Array(PendingNotification),
  /** Pending events whose findings may notify now, whatever the timing; others wait outside any summary. Older coordinators omit it. */
  notificationsWaiting: Schema.optional(Schema.Number),
  notificationSummary: Schema.optional(Schema.NullOr(NotificationSummary)),
  notificationNextAt: Schema.optional(NullableString),
  scanProgress: Schema.optional(ScanProgress),
});
export type MonitoringSnapshot = typeof MonitoringSnapshot.Type;
export const decodeMonitoringSnapshot = Schema.decodeUnknownSync(MonitoringSnapshot);
// Live fields read without the snapshot; `revision` is the snapshot's ETag value. The settings are
// durable, but carried here so the tray needs no snapshot for them; builds before v8 omit them.
export const MonitoringProgress = Schema.Struct({
  revision: Schema.String,
  settings: Schema.optional(MonitoringSettings),
  scanProgress: ScanProgress,
  notificationSummary: Schema.NullOr(NotificationSummary),
  notificationNextAt: NullableString,
});
export type MonitoringProgress = typeof MonitoringProgress.Type;
export const decodeMonitoringProgress = Schema.decodeUnknownSync(MonitoringProgress);
export const decodeProject = Schema.decodeUnknownSync(Project);
export const decodeMonitoringSettings = Schema.decodeUnknownSync(MonitoringSettings);
export const AcceptedResponse = Schema.Struct({ accepted: Schema.Literal(true) });
export const decodeAcceptedResponse = Schema.decodeUnknownSync(AcceptedResponse);

export const AddProject = Schema.Struct({
  path: Schema.String,
  mode: Schema.Literals(["maintained", "watch"]),
});
export const ChangeProject = ProjectChanges;
export const RequestScan = Schema.Struct({
  target: Schema.Literals(["pc", "projects", "all", "failed"]),
  projectId: Schema.optional(Schema.String),
});
export const CancelScan = Schema.Struct({ scanId: Schema.String.check(Schema.isMaxLength(100)) });
export const ChangeSettings = Schema.Struct({
  paused: Schema.optional(Schema.Boolean),
  pcIntervalMinutes: Schema.optional(Schema.Number),
  projectIntervalMinutes: Schema.optional(Schema.Number),
  notifyNewFindings: Schema.optional(Schema.Boolean),
  releaseCooldownDays: Schema.optional(ReleaseCooldownDays),
  useDepsDev: Schema.optional(Schema.Boolean),
  notificationScope: Schema.optional(NotificationScope),
  notifyWatchOnly: Schema.optional(Schema.Boolean),
  quietHours: Schema.optional(Schema.NullOr(QuietHours)),
  digestAt: Schema.optional(Schema.NullOr(HourMinute)),
});
/** A snooze (7, 30, or 90 days, or until a newer version) or an ignore with a reason, for one finding. */
export const CreateFindingRule = Schema.Struct({
  findingId: Schema.String.check(Schema.isMaxLength(100)),
  mode: Schema.Literals(["snooze", "ignore"]),
  days: Schema.optional(Schema.Literals([7, 30, 90])),
  untilNewerVersion: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type CreateFindingRule = typeof CreateFindingRule.Type;
export const ChangeGlobalToolSources = Schema.Struct({ sources: Schema.Array(GlobalToolSource) });
export const AcknowledgeNotificationSummary = Schema.Struct({
  summaryId: Schema.String,
});
export const decodeNotificationSummary = Schema.decodeUnknownSync(NotificationSummary);
