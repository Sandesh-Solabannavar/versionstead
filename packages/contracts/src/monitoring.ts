import * as Schema from "effect/Schema";
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

export const Finding = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["update", "advisory", "coverage"]),
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
});
export type Finding = typeof Finding.Type;

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
});
export type NotificationSummary = typeof NotificationSummary.Type;

export const MonitoringSettings = Schema.Struct({
  paused: Schema.Boolean,
  pcIntervalMinutes: Schema.Number,
  projectIntervalMinutes: Schema.Number,
  notifyNewFindings: Schema.Boolean,
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
  history: Schema.Array(ScanRecord),
  notifications: Schema.Array(PendingNotification),
  notificationSummary: Schema.optional(Schema.NullOr(NotificationSummary)),
  notificationNextAt: Schema.optional(NullableString),
  scanProgress: Schema.optional(ScanProgress),
});
export type MonitoringSnapshot = typeof MonitoringSnapshot.Type;
export const decodeMonitoringSnapshot = Schema.decodeUnknownSync(MonitoringSnapshot);
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
  target: Schema.Literals(["pc", "projects", "all"]),
  projectId: Schema.optional(Schema.String),
});
export const ChangeSettings = Schema.Struct({
  paused: Schema.optional(Schema.Boolean),
  pcIntervalMinutes: Schema.optional(Schema.Number),
  projectIntervalMinutes: Schema.optional(Schema.Number),
  notifyNewFindings: Schema.optional(Schema.Boolean),
});
export const ChangeGlobalToolSources = Schema.Struct({ sources: Schema.Array(GlobalToolSource) });
export const AcknowledgeNotificationSummary = Schema.Struct({
  summaryId: Schema.String,
});
