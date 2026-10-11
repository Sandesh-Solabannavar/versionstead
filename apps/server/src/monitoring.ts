import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { validateProjectChanges } from "@versionstead/contracts/project-settings";
import {
  decodeMonitoringProgress,
  decodeMonitoringSnapshot,
  isHourMinute,
  notificationScopes,
  type ActiveScan,
  type CreateFindingRule,
  type Finding,
  type FindingRule,
  type GlobalToolSource,
  type MonitoringProgress,
  type MonitoringSettings,
  type MonitoringSnapshot,
  type NotificationSummary,
  type Project,
  type ScanEvidence,
  type ScanProgress,
  type ScanRecord,
  type ScanTarget,
} from "@versionstead/contracts/monitoring";
import { MonitoringStorage, type StoredMonitoring } from "./storage.ts";
import { createRule, expiredRuleIds, matchingRule, ruleIndex, scopeKey } from "./finding-rules.ts";
import { inQuietHours, latestDailyTime, notificationEligible } from "./notification-policy.ts";
import { keepResolved, newlyResolved, resolvedDays } from "./resolved-findings.ts";
import {
  identity,
  InputError,
  inspectProject,
  projectLabel,
  selectDirectory,
  type ProjectInputs,
} from "./adapters/projects.ts";
import { inspectInventory, validateGlobalToolSources } from "./adapters/inventory.ts";
import { checkNativeVersions } from "./adapters/outdated.ts";
import {
  createSourceCache,
  lookupDependencies,
  type DependencyLookup,
  type LookupResult,
  type PackageSignals,
} from "./adapters/lookups.ts";
import {
  lifecycleLabels,
  lifecycleVerdict,
  loadLifecycle,
  type DeclaredRuntime,
  type LifecycleProduct,
} from "./adapters/lifecycle.ts";
import { lookupReleaseFacts } from "./adapters/release-facts.ts";
import { pcRuntimes } from "./adapters/runtimes.ts";
export { InputError } from "./adapters/projects.ts";

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const timestamp = () => new Date().toISOString();
export const features = "settings-repositories-connections-v10" as const;
const evidenceNotSaved = "Evidence could not be saved; the previous saved evidence is retained.";
const cancelledByOwner = "Cancelled by you";
// What Retry failed checks rescans: a target whose last attempt failed or left gaps.
const retryable = (evidence: ScanEvidence | undefined) =>
  evidence?.status === "failed" || evidence?.status === "partial";
const emptyEvidence = (): Mutable<ScanEvidence> => ({
  status: "not-scanned",
  lastAttempt: null,
  lastSuccess: null,
  coverage: [],
  errors: [],
});

/**
 * The update finding with the install-script and deprecated-candidate answers read in this scan. An
 * answer this scan did not read (no metadata, or one the metadata could not give: null for the
 * install script, undefined for the candidate) keeps the previous finding's, and one neither has is
 * left out (shown as "Not checked"), never written as "none" or "not deprecated".
 * ponytail: a kept answer has no age of its own, and only the incomplete-check error says that the
 * read failed; record when each answer was read if the app should show how old it is.
 */
function withSignals(
  update: Finding,
  signals: PackageSignals | undefined,
  previous: Finding | undefined,
): Finding {
  const installScript = signals?.installScript ?? previous?.installScript;
  const candidateDeprecated =
    signals?.candidateDeprecated === undefined
      ? previous?.candidateDeprecated
      : signals.candidateDeprecated;
  return {
    ...update,
    ...(typeof installScript === "boolean" ? { installScript } : {}),
    ...(candidateDeprecated !== undefined ? { candidateDeprecated } : {}),
  };
}

export type MonitoringOptions = {
  dataDir: string;
  mode?: "interactive" | "background";
  host?: "session" | "boot-task" | "unconfigured";
  platform?: NodeJS.Platform;
  lookup?: boolean;
  dependencyLookup?: DependencyLookup;
  inventoryLookup?: typeof inspectInventory;
  nativeVersionLookup?: typeof checkNativeVersions | false;
  /** Fetch for endoflife.date and deps.dev; absent disables both (tests), and bin.ts passes fetch. */
  sourceFetch?: typeof fetch;
  /** The coordinator clock for rules and notification timing; tests pass a controllable one. */
  now?: () => number;
};

export class MonitoringCoordinator {
  private projectInspection = (project: Project, signal?: AbortSignal) =>
    inspectProject(project.path, signal);
  private automaticProjectAllowed = (_project: Project) => true;
  private readonly storage: MonitoringStorage;
  private readonly now: () => number;
  private state: Mutable<MonitoringSnapshot>;
  private due: Record<string, number>;
  private notified: Set<string>;
  private readonly queue = new Map<string, boolean>();
  private active: string | null = null;
  private activeScan: AbortController | null = null;
  private worker: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly lookup: DependencyLookup | null;
  private readonly inventoryLookup: typeof inspectInventory;
  private readonly sourceFetch: typeof fetch | null;
  // When each endoflife.date product last failed; a failed product waits an hour.
  private readonly lifecycleAttempts = new Map<LifecycleProduct, number>();
  private readonly shutdown = new AbortController();
  private progress: Mutable<ActiveScan> | null = null;
  // A random boot id keeps revisions of different instances on one database distinct.
  private readonly bootId = randomUUID();
  private changes = 0;
  private stable: { revision: string; json: string } | null = null;
  private settledAt: number;
  private readonly summaries: {
    summary: NotificationSummary;
    notificationIds: string[];
    acknowledged: boolean;
  }[] = [];
  // Summaries read outside quiet hours (id to the events each covered), so a receipt that arrives after
  // a quiet-hours read has replaced the id still consumes exactly what was shown. The newest 20.
  private readonly offered = new Map<string, string[]>();

  constructor(options: MonitoringOptions) {
    this.now = options.now ?? Date.now;
    this.settledAt = this.now();
    this.storage = new MonitoringStorage(options.dataDir);
    let stored: StoredMonitoring | null;
    try {
      stored = this.storage.read();
    } catch (error) {
      // Nothing is left to close the database once the constructor throws, and Windows cannot delete
      // an open one. ponytail: only a failed read() is covered, not the cooldown check or persist()
      // below (bin.ts exits on those); wrap the whole constructor if a caller outlives one.
      this.storage.close();
      throw error;
    }
    const platform = options.platform ?? process.platform;
    const nativeVersionLookup =
      options.nativeVersionLookup === false
        ? null
        : (options.nativeVersionLookup ?? checkNativeVersions);
    // Every project and This PC scan of this coordinator shares one cache of public metadata.
    const sources = createSourceCache();
    this.lookup =
      options.lookup === false
        ? null
        : (options.dependencyLookup ??
          ((dependencies, signal, onProgress, localProject) =>
            lookupDependencies(
              dependencies,
              fetch,
              signal,
              onProgress,
              localProject && nativeVersionLookup
                ? () =>
                    nativeVersionLookup(
                      localProject.root,
                      localProject.packageManager,
                      dependencies,
                      signal,
                      (completed, total) =>
                        onProgress?.({ stage: "native-versions", completed, total }),
                    )
                : undefined,
              sources,
            )));
    this.inventoryLookup =
      options.inventoryLookup ??
      ((scanPlatform, mode, signal, progress, previous) =>
        inspectInventory(scanPlatform, mode, signal, progress, previous, sources));
    this.sourceFetch = options.sourceFetch ?? null;
    this.state = stored
      ? (structuredClone(stored.snapshot) as Mutable<MonitoringSnapshot>)
      : {
          protocolVersion: 1,
          runtime: {
            startedAt: timestamp(),
            mode: options.mode ?? "interactive",
            host: options.host ?? "session",
            platform,
            nextScanAt: null,
          },
          device: { id: randomUUID(), label: hostname(), platform },
          settings: {
            paused: false,
            pcIntervalMinutes: 360,
            projectIntervalMinutes: 60,
            notifyNewFindings: true,
          },
          inventory: {
            collector: "npm-bun-global-v1",
            managers: [],
            evidence: emptyEvidence(),
            updateEvidence: emptyEvidence(),
            installations: [],
          },
          projects: [],
          findings: [],
          history: [],
          notifications: [],
        };
    this.state.runtime = {
      startedAt: timestamp(),
      mode: options.mode ?? "interactive",
      host: options.host ?? "session",
      platform,
      nextScanAt: null,
    };
    this.state.device.platform = platform;
    const legacyPc = stored && this.state.inventory.collector !== "npm-bun-global-v1";
    const oldPcFindingIds = new Set(
      legacyPc
        ? this.state.findings.filter((f) => f.subjectId === this.state.device.id).map((f) => f.id)
        : [],
    );
    if (legacyPc) {
      this.state.inventory = {
        collector: "npm-bun-global-v1",
        managers: [],
        evidence: emptyEvidence(),
        updateEvidence: emptyEvidence(),
        installations: [],
      };
      this.state.findings = this.state.findings.filter((f) => f.subjectId !== this.state.device.id);
      this.state.notifications = this.state.notifications.filter(
        (n) => n.deliveredAt !== null || !oldPcFindingIds.has(n.findingId),
      );
    }
    this.state.inventory.managers ??= [];
    this.state.inventory.updateEvidence ??= emptyEvidence();
    this.state.notificationNextAt ??= null;
    // ponytail: resolved history shares the meta row (500 findings: about 325 KiB typically, over
    // 2 MiB at worst, as an advisory summary can run to 4,096 characters); give it its own rows if
    // saves measurably slow
    this.state.resolvedFindings = keepResolved(
      this.state.resolvedFindings ?? [],
      this.state.findings,
      this.now(),
    );
    this.state.findingRules ??= [];
    this.state.settings.notificationScope ??= "all";
    this.state.settings.notifyWatchOnly ??= false;
    this.state.settings.quietHours ??= null;
    this.state.settings.digestAt ??= null;
    this.state.settings.releaseCooldownDays ??= 3;
    this.state.settings.useDepsDev ??= true;
    if (
      this.state.notificationNextAt !== null &&
      !Number.isFinite(Date.parse(this.state.notificationNextAt))
    )
      throw new Error("The monitoring database contains an invalid notification cooldown.");
    delete this.state.scanProgress;
    delete this.state.notificationSummary;
    this.due = stored?.due ?? {};
    // Keep the first PC view empty until the owner explicitly requests its first scan.
    if (!this.state.inventory.evidence.lastAttempt) delete this.due.pc;
    this.notified = new Set((stored?.notified ?? []).filter((id) => !oldPcFindingIds.has(id)));
    for (const attempt of this.state.history.filter((a) => a.status === "scanning")) {
      attempt.status = "failed";
      attempt.finishedAt = timestamp();
      attempt.errors = ["The coordinator stopped before this scan finished."];
    }
    for (const evidence of [
      this.state.inventory.evidence,
      this.state.inventory.updateEvidence,
      ...this.state.projects.map((p) => p.evidence),
    ]) {
      if (evidence.status === "scanning") {
        evidence.status = "failed";
        evidence.errors = [
          "The coordinator stopped before this scan finished; previous evidence is retained.",
        ];
      }
    }
    this.pruneNotifications();
    this.persist();
    this.timer = setInterval(() => this.schedule(), 1000);
    this.timer.unref();
  }

  snapshot(): MonitoringSnapshot {
    this.updateNextDue();
    return structuredClone({
      ...this.state,
      features,
      findings: this.annotatedFindings(),
      notificationsWaiting: this.waitingNotifications(),
      scanProgress: this.scanProgress(),
      notificationSummary: this.prepareNotificationSummary(),
    });
  }

  /** Changes with every durable change; live progress and notification summaries are excluded. */
  get revision() {
    return `${this.bootId}-${this.changes}`;
  }
  get mode() {
    return this.state.runtime.mode;
  }
  get device(): MonitoringSnapshot["device"] {
    return { ...this.state.device };
  }

  /** Validated live fields; computed per request because summaries freeze when presented. */
  progressSnapshot(): MonitoringProgress {
    return decodeMonitoringProgress({
      revision: this.revision,
      settings: this.state.settings,
      scanProgress: this.scanProgress(),
      notificationSummary: this.prepareNotificationSummary(),
      notificationNextAt: this.state.notificationNextAt ?? null,
    });
  }

  /** The validated snapshot as JSON; its stable part is validated and serialized once per revision. */
  snapshotJson(): string {
    const revision = this.revision;
    if (this.stable?.revision !== revision)
      this.stable = {
        revision,
        json: JSON.stringify(
          decodeMonitoringSnapshot({
            ...this.state,
            features,
            findings: this.annotatedFindings(),
            notificationsWaiting: this.waitingNotifications(),
          }),
        ),
      };
    const { scanProgress, notificationSummary } = this.progressSnapshot();
    return `${this.stable.json.slice(0, -1)},"scanProgress":${JSON.stringify(scanProgress)},"notificationSummary":${JSON.stringify(notificationSummary)}}`;
  }

  configureProjectInspection(
    inspect: (project: Project, signal?: AbortSignal) => Promise<ProjectInputs>,
    automatic: (project: Project) => boolean,
  ) {
    this.projectInspection = inspect;
    this.automaticProjectAllowed = automatic;
    this.updateNextDue();
  }

  readApplication(): unknown {
    return this.storage.readApplication();
  }
  writeApplication(value: unknown) {
    // Application preferences decide which repositories scan automatically, so a change to them
    // can move nextScanAt.
    this.updateNextDue();
    this.storage.writeApplication(value);
  }

  addRepository(
    repository: NonNullable<Project["repository"]>,
    mode: "maintained" | "watch",
    automatic: boolean,
  ): Project {
    this.assertOpen();
    const existing = this.state.projects.find(
      (p) =>
        p.repository?.provider === repository.provider &&
        p.repository.repositoryId === repository.repositoryId &&
        p.repository.ref === repository.ref,
    );
    if (existing) return structuredClone(existing);
    if (this.state.projects.length >= 50)
      throw new InputError("A maximum of 50 selected projects is supported.");
    const project: Mutable<Project> = {
      id: randomUUID(),
      name: repository.name,
      path: repository.url,
      mode,
      packageManager: "unknown",
      manifestPath: null,
      lockfilePath: null,
      evidence: emptyEvidence(),
      dependencies: [],
      createdAt: timestamp(),
      repository: { ...repository },
    };
    this.state.projects.push(project);
    this.due[project.id] = Date.now();
    this.persist();
    if (automatic) {
      this.enqueue(project.id, false);
      this.runQueue();
    }
    return structuredClone(project);
  }

  async addProject(input: { path: string; mode: "maintained" | "watch" }): Promise<Project> {
    this.assertOpen();
    if (input.mode !== "maintained" && input.mode !== "watch")
      throw new InputError("Invalid project mode.");
    const path = await selectDirectory(input.path);
    const existing = this.state.projects.find((p) =>
      process.platform === "win32" ? p.path.toLowerCase() === path.toLowerCase() : p.path === path,
    );
    if (existing) return structuredClone(existing);
    if (this.state.projects.length >= 50)
      throw new InputError("A maximum of 50 selected projects is supported.");
    const project: Mutable<Project> = {
      id: randomUUID(),
      name: projectLabel(path),
      path,
      mode: input.mode,
      packageManager: "unknown",
      manifestPath: null,
      lockfilePath: null,
      evidence: emptyEvidence(),
      dependencies: [],
      createdAt: timestamp(),
    };
    this.state.projects.push(project);
    this.due[project.id] = Date.now();
    this.persist();
    return structuredClone(project);
  }

  changeProject(id: string, input: unknown): Project {
    this.assertOpen();
    const project = this.project(id);
    let changes;
    try {
      changes = validateProjectChanges(input);
    } catch {
      throw new InputError(
        "Invalid project settings. Check the name, icon, commands, and shortcuts.",
      );
    }
    if (project.repository && changes.actions?.length)
      throw new InputError("Custom commands require a local project checkout.");
    if (changes.mode !== undefined) project.mode = changes.mode;
    if (changes.name !== undefined) {
      project.name = changes.name.trim();
      for (const finding of this.state.findings)
        if (finding.subjectId === id) finding.subjectLabel = project.name;
    }
    if (changes.icon !== undefined)
      project.icon = structuredClone(changes.icon) as Mutable<Project>["icon"];
    if (changes.actions !== undefined)
      project.actions = structuredClone(changes.actions) as Mutable<Project>["actions"];
    this.persist();
    return structuredClone(project);
  }

  removeProject(id: string): void {
    this.assertOpen();
    this.project(id);
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    const removed = new Set(this.state.findings.filter((f) => f.subjectId === id).map((f) => f.id));
    this.state.findings = this.state.findings.filter((f) => f.subjectId !== id);
    this.state.resolvedFindings = (this.state.resolvedFindings ?? []).filter(
      (f) => f.subjectId !== id,
    );
    this.state.notifications = this.state.notifications.filter((n) => !removed.has(n.findingId));
    this.queue.delete(id);
    delete this.due[id];
    if (this.active === id) this.activeScan?.abort();
    this.persist();
  }

  requestScan(input: { target: "pc" | "projects" | "all" | "failed"; projectId?: string }): void {
    this.assertOpen();
    if (
      !["pc", "projects", "all", "failed"].includes(input.target) ||
      (input.target === "failed" && input.projectId !== undefined)
    )
      throw new InputError("Invalid scan target.");
    if (input.target === "failed") {
      // Decided now, not when the page counted: a removed or recovered target is not rescanned. Nor
      // is This PC while its scan finishes: its update checks already read final then. A project
      // reads "scanning" for its whole scan, so it is never retryable meanwhile.
      if (
        this.active !== "pc" &&
        (retryable(this.state.inventory.evidence) || retryable(this.state.inventory.updateEvidence))
      )
        this.enqueue("pc", true);
      for (const project of this.state.projects)
        if (retryable(project.evidence)) this.enqueue(project.id, true);
    } else if (input.projectId) {
      this.project(input.projectId);
      this.enqueue(input.projectId, true);
    } else {
      if (input.target !== "projects") this.enqueue("pc", true);
      if (input.target !== "pc")
        for (const project of this.state.projects) this.enqueue(project.id, true);
    }
    this.runQueue();
  }

  /** Stops the running scan `scanId` before it writes evidence; its attempt records "Cancelled by you". */
  cancelScan(scanId: string): void {
    this.assertOpen();
    if (this.progress?.scanId !== scanId)
      throw new InputError("This scan already finished; its results are kept.");
    if (this.progress.writing)
      throw new InputError("This scan is saving its results and can no longer be cancelled.");
    this.activeScan?.abort(cancelledByOwner);
  }

  changeSettings(input: Partial<MonitoringSettings>): MonitoringSettings {
    this.assertOpen();
    for (const key of ["pcIntervalMinutes", "projectIntervalMinutes"] as const) {
      if (
        input[key] !== undefined &&
        (!Number.isInteger(input[key]) || input[key]! < 5 || input[key]! > 10080)
      ) {
        throw new InputError("Scan intervals must be whole minutes between 5 and 10,080.");
      }
    }
    if (
      input.releaseCooldownDays !== undefined &&
      (!Number.isInteger(input.releaseCooldownDays) ||
        input.releaseCooldownDays < 0 ||
        input.releaseCooldownDays > 30)
    )
      throw new InputError("The release cooldown must be a whole number of days from 0 to 30.");
    if (
      (input.paused !== undefined && typeof input.paused !== "boolean") ||
      (input.notifyNewFindings !== undefined && typeof input.notifyNewFindings !== "boolean") ||
      (input.useDepsDev !== undefined && typeof input.useDepsDev !== "boolean")
    )
      throw new InputError("Invalid monitoring settings.");
    if (
      (input.notificationScope !== undefined &&
        !notificationScopes.includes(input.notificationScope)) ||
      (input.notifyWatchOnly !== undefined && typeof input.notifyWatchOnly !== "boolean")
    )
      throw new InputError("Invalid monitoring settings.");
    // The type is checked here too: a direct call must not store a value the next start refuses to read.
    if (
      input.quietHours !== undefined &&
      input.quietHours !== null &&
      (!isHourMinute(input.quietHours.start) ||
        !isHourMinute(input.quietHours.end) ||
        input.quietHours.start === input.quietHours.end)
    )
      throw new InputError("Quiet hours need different start and end times (HH:MM).");
    if (input.digestAt !== undefined && input.digestAt !== null && !isHourMinute(input.digestAt))
      throw new InputError("The digest time must be HH:MM.");
    this.state.settings = { ...this.state.settings, ...input };
    // Keep a copy of the window, not the caller's object, and only its two times.
    if (input.quietHours)
      this.state.settings.quietHours = { start: input.quietHours.start, end: input.quietHours.end };
    if (input.paused === true)
      for (const [id, manual] of this.queue) if (!manual) this.queue.delete(id);
    // A changed interval applies from the last attempt; overdue work is coalesced once on resume.
    if (input.pcIntervalMinutes !== undefined && this.state.inventory.evidence.lastAttempt)
      this.due.pc = this.nextDue(this.state.inventory.evidence, input.pcIntervalMinutes);
    if (input.projectIntervalMinutes !== undefined)
      for (const project of this.state.projects)
        this.due[project.id] = this.nextDue(project.evidence, input.projectIntervalMinutes);
    this.persist();
    if (input.paused === false) this.schedule();
    return structuredClone(this.state.settings);
  }

  async changeGlobalToolSources(sources: readonly GlobalToolSource[]): Promise<MonitoringSnapshot> {
    this.assertOpen();
    const validated = await validateGlobalToolSources(sources, this.state.inventory.managers ?? []);
    this.assertOpen();
    if (this.active === "pc" || this.queue.has("pc"))
      throw new InputError("Wait for the PC scan to finish before changing global tool sources.");
    this.state.inventory.managers = validated.map((source) => {
      const previous = this.state.inventory.managers!.find((old) => old.manager === source.manager);
      return {
        ...source,
        root:
          source.status === "unavailable" ? (source.root ?? previous?.root ?? null) : source.root,
        version:
          source.status === "unavailable"
            ? (source.version ?? previous?.version ?? null)
            : source.version,
        blockedScopes: [...source.blockedScopes],
      };
    });
    this.persist();
    return this.snapshot();
  }

  acknowledgeNotification(id: string): void {
    this.assertOpen();
    const notification = this.state.notifications.find((n) => n.id === id);
    if (!notification) throw new InputError("The notification no longer exists.");
    notification.deliveredAt ??= timestamp();
    this.persist();
  }

  acknowledgeNotificationSummary(id: string): void {
    this.assertOpen();
    const frozen = this.summaries.find((s) => s.summary.id === id);
    // A summary read outside quiet hours and since replaced by a quiet-hours read is receipted by the
    // events it covered, which is all the desktop showed.
    const covered = frozen?.notificationIds ?? this.offered.get(id);
    if (!covered) throw new InputError("The notification summary is no longer available.");
    if (frozen?.acknowledged) return;
    this.offered.delete(id);
    const ids = new Set(covered);
    const deliveredAt = new Date(this.now()).toISOString();
    let presented = 0;
    for (const event of this.state.notifications)
      if (event.deliveredAt === null && ids.has(event.id)) {
        event.deliveredAt = deliveredAt;
        presented += 1;
      }
    if (presented) this.state.notificationNextAt = new Date(this.now() + 5 * 60000).toISOString();
    this.pruneNotifications();
    this.persist();
    if (frozen) frozen.acknowledged = true;
  }

  /** Snoozes or ignores a finding's scope; a rule for the same scope is replaced. */
  addFindingRule(request: CreateFindingRule): FindingRule {
    this.assertOpen();
    const finding = this.state.findings.find((item) => item.id === request.findingId);
    if (!finding) throw new InputError("The finding no longer exists. Refresh and try again.");
    const rule = createRule(request, finding, this.now(), randomUUID());
    const key = scopeKey(rule.scope);
    const others = (this.state.findingRules ?? []).filter((item) => scopeKey(item.scope) !== key);
    if (others.length >= 500)
      throw new InputError("At most 500 snooze and ignore rules are supported. Remove one first.");
    this.state.findingRules = [...others, rule];
    this.persist();
    return structuredClone(rule);
  }

  removeFindingRule(id: string): void {
    this.assertOpen();
    const rules = this.state.findingRules ?? [];
    if (!rules.some((rule) => rule.id === id))
      throw new InputError("The snooze or ignore rule no longer exists.");
    this.state.findingRules = rules.filter((rule) => rule.id !== id);
    this.persist();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdown.abort();
    clearInterval(this.timer);
    this.queue.clear();
    await this.worker;
    this.persist();
    this.storage.close();
  }

  private assertOpen() {
    if (this.closed) throw new InputError("The coordinator is stopping.");
  }
  private project(id: string) {
    const project = this.state.projects.find((p) => p.id === id);
    if (!project) throw new InputError("The selected project no longer exists.");
    return project;
  }
  /**
   * The scan starts writing evidence here: an abort that came first (removal, Cancel, shutdown)
   * stops it, and from now on Cancel is refused, so a scan never ends half-written.
   */
  private commit(signal: AbortSignal) {
    if (signal.aborted)
      throw new InputError(
        "The scan stopped before it finished; previous successful evidence is retained.",
      );
    if (this.progress) this.progress = { ...this.progress, writing: true };
  }
  private nextDue(evidence: ScanEvidence, interval: number) {
    return evidence.lastAttempt ? Date.parse(evidence.lastAttempt) + interval * 60000 : Date.now();
  }
  // Due entries of removed projects or projects without automatic scans are stale.
  private scansAutomatically(id: string) {
    const project = this.state.projects.find((p) => p.id === id);
    return id === "pc" || (project !== undefined && this.automaticProjectAllowed(project));
  }
  private updateNextDue() {
    const values = Object.entries(this.due)
      .filter(([id]) => this.scansAutomatically(id))
      .map(([, due]) => due);
    const next =
      this.state.settings.paused || !values.length
        ? null
        : new Date(Math.min(...values)).toISOString();
    // nextScanAt is in the cached snapshot; eligibility can change it outside persist().
    if (next !== this.state.runtime.nextScanAt) this.changes += 1;
    this.state.runtime.nextScanAt = next;
  }
  private persist() {
    // Advance before writing: memory already holds the change even if the write fails.
    this.changes += 1;
    this.updateNextDue();
    this.storage.write({ snapshot: this.state, due: this.due, notified: [...this.notified] });
  }
  /** Findings with the id of the snooze or ignore rule that hides each one now. */
  private annotatedFindings(): Finding[] {
    // ponytail: a date that passes is shown hidden in the cached JSON for up to one tick, until
    // pruneRules advances the revision; compute the annotation per request if that ever matters.
    const rules = this.state.findingRules ?? [];
    if (!rules.length) return this.state.findings;
    const index = ruleIndex(rules);
    const now = this.now();
    return this.state.findings.map((finding) => {
      const rule = matchingRule(index, finding, now);
      return rule ? { ...finding, ruleId: rule.id } : finding;
    });
  }
  /** Removes rules that no longer apply; runs every tick, paused or not. */
  private pruneRules() {
    const rules = this.state.findingRules ?? [];
    if (!rules.length) return;
    const subjects = new Set([this.state.device.id, ...this.state.projects.map((p) => p.id)]);
    const expired = expiredRuleIds(rules, this.state.findings, subjects, this.now());
    if (!expired.size) return;
    this.state.findingRules = rules.filter((rule) => !expired.has(rule.id));
    try {
      this.persist();
    } catch {
      // Matching already ignores these rules; a later durable write saves the removal.
    }
  }
  /** Drops resolved findings older than 30 days; runs every tick, paused or not. */
  private pruneResolved() {
    const oldest = this.state.resolvedFindings?.at(-1);
    if (!oldest || Date.parse(oldest.resolvedAt) >= this.now() - resolvedDays * 86_400_000) return;
    this.state.resolvedFindings = keepResolved(
      this.state.resolvedFindings!,
      this.state.findings,
      this.now(),
    );
    try {
      this.persist();
    } catch {
      // Memory already dropped them; a later durable write saves the removal.
    }
  }
  /** Whether a finding may notify now: its kind, its project's maintenance mode, "Notify about", and rules. */
  private notificationFilter(): (finding: Finding) => boolean {
    const index = ruleIndex(this.state.findingRules ?? []);
    const now = this.now();
    const modes = new Map(this.state.projects.map((project) => [project.id, project.mode]));
    return (finding) =>
      notificationEligible(
        finding,
        this.state.settings,
        modes.get(finding.subjectId) ?? null,
        matchingRule(index, finding, now) !== undefined,
      );
  }
  /** Pending events whose findings may notify now, whatever the timing; the rest wait outside any summary. */
  private waitingNotifications(): number {
    // With "Notify about new findings" off nothing is summarized, so nothing waits.
    if (!this.state.settings.notifyNewFindings) return 0;
    const findings = new Map(this.state.findings.map((f) => [f.id, f]));
    const eligible = this.notificationFilter();
    return this.state.notifications.filter((n) => {
      const finding = findings.get(n.findingId);
      return n.deliveredAt === null && finding !== undefined && eligible(finding);
    }).length;
  }
  private scanProgress(): ScanProgress {
    return {
      active: this.progress,
      queued: [...this.queue.keys()].flatMap<ScanTarget>((id) => {
        const project = this.state.projects.find((p) => p.id === id);
        return id === "pc"
          ? [{ targetId: this.state.device.id, targetLabel: this.state.device.label, kind: "pc" }]
          : project
            ? [{ targetId: project.id, targetLabel: project.name, kind: "project" }]
            : [];
      }),
    };
  }
  private enqueue(id: string, manual = false) {
    // An owner's request for the target now scanning runs again afterwards; scheduled ones do not.
    if (id !== this.active || manual) this.queue.set(id, manual || this.queue.get(id) === true);
  }
  private schedule() {
    if (this.closed) return;
    this.pruneRules();
    this.pruneResolved();
    if (this.state.settings.paused) return;
    for (const [id, due] of Object.entries(this.due))
      if (due <= Date.now() && this.scansAutomatically(id)) this.enqueue(id);
    this.runQueue();
  }
  private runQueue() {
    if (this.worker || this.closed || !this.queue.size) return;
    this.worker = (async () => {
      while (this.queue.size && !this.closed) {
        const id = this.queue.keys().next().value!;
        const manual = this.queue.get(id);
        this.queue.delete(id);
        const project = this.state.projects.find((p) => p.id === id);
        if (
          !manual &&
          (this.state.settings.paused || (project && !this.automaticProjectAllowed(project)))
        )
          continue;
        this.active = id;
        await this.scan(id);
        this.active = null;
      }
    })()
      // scan() records its own failures on the attempt; nothing may reject the unobserved worker.
      .catch(() => {})
      .finally(() => {
        this.worker = null;
        this.active = null;
        this.progress = null;
        this.settledAt = this.now();
        // A request made while this worker was finishing would otherwise stay queued until
        // something else starts a worker.
        this.runQueue();
      });
  }

  private async scan(id: string) {
    const project = id === "pc" ? null : this.state.projects.find((p) => p.id === id);
    if (id !== "pc" && !project) return;
    const evidence = project?.evidence ?? this.state.inventory.evidence;
    // Removing a project or the owner's Cancel aborts this scan only, leaving shutdown and other
    // scans untouched. Cancel lands only before commit, so the evidence the scan started from is
    // everything it changed.
    const controller = new AbortController();
    this.activeScan = controller;
    const signal = AbortSignal.any([this.shutdown.signal, controller.signal]);
    const evidenceBefore = structuredClone(evidence);
    const updatesBefore = project ? null : structuredClone(this.state.inventory.updateEvidence!);
    const attempt: Mutable<ScanRecord> = {
      id: randomUUID(),
      targetId: project?.id ?? this.state.device.id,
      targetLabel: project?.name ?? this.state.device.label,
      kind: project ? "project" : "pc",
      startedAt: timestamp(),
      finishedAt: null,
      status: "scanning",
      coverage: [],
      errors: [],
    };
    this.progress = {
      scanId: attempt.id,
      targetId: attempt.targetId,
      targetLabel: attempt.targetLabel,
      kind: attempt.kind,
      startedAt: attempt.startedAt,
      updatedAt: attempt.startedAt,
      stage: project ? "project-inputs" : "inventory",
      completed: null,
      total: null,
    };
    evidence.status = "scanning";
    evidence.lastAttempt = attempt.startedAt;
    if (!project) {
      this.state.inventory.updateEvidence!.status = "scanning";
      this.state.inventory.updateEvidence!.lastAttempt = attempt.startedAt;
    }
    this.state.history.unshift(attempt);
    this.state.history.length = Math.min(this.state.history.length, 200);
    // Advance on start to prevent a schedule tick from queuing the same active scan.
    this.due[id] =
      Date.now() +
      (project
        ? this.state.settings.projectIntervalMinutes
        : this.state.settings.pcIntervalMinutes) *
        60000;
    // A storage failure fails this attempt instead of throwing out of the worker.
    // ponytail: due is advanced before this write, so a transient failure costs one automatic
    // cycle; restore the previous due on start failure if that matters.
    let saved = true;
    try {
      this.persist();
    } catch {
      saved = false;
    }
    let findings: Finding[] = [];
    // The update findings of public npm registry packages: the only ones deps.dev is asked about.
    const publicUpdates = new Set<string>();
    let freshUpdates = false;
    let freshAdvisories = false;
    let freshLifecycle = false;
    let retainedFindingIds: Set<string> | null = null;
    let inventoryStatus: "complete" | "partial" | "failed" | null = null;
    try {
      if (!saved) throw new InputError(evidenceNotSaved);
      if (project) {
        const inputs = await this.projectInspection(project, signal);
        attempt.inputFingerprint = inputs.inputFingerprint;
        let lookedUp: LookupResult = {
          dependencies: inputs.dependencies,
          advisories: new Map(),
          coverage: [],
          errors: [],
        };
        if (this.lookup)
          lookedUp = await this.lookup(
            inputs.dependencies,
            signal,
            (progress) => this.reportProgress(progress),
            !project.repository && this.state.runtime.mode === "interactive"
              ? { root: project.path, packageManager: inputs.packageManager }
              : undefined,
          );
        else
          inputs.errors.push(
            "Public-registry and advisory lookups are disabled; update and security status are unknown.",
          );
        this.commit(signal);
        project.packageManager = inputs.packageManager;
        project.manifestPath = inputs.manifestPath;
        project.lockfilePath = inputs.lockfilePath;
        project.inputFingerprint = inputs.inputFingerprint;
        if (inputs.git) project.git = inputs.git;
        else delete project.git;
        if (project.repository && inputs.repositoryCommit)
          project.repository.commit = inputs.repositoryCommit;
        const previous = new Map(project.dependencies.map((d) => [d.id, d]));
        freshUpdates =
          this.lookup !== null &&
          !lookedUp.errors.some((e) => /version lookup|registry|Version lookup/.test(e));
        retainedFindingIds = new Set();
        const previousFindings = new Map<string, Finding[]>();
        for (const finding of this.state.findings.filter((f) => f.subjectId === project.id)) {
          const key = identity(finding.packageName ?? "", finding.installedVersion ?? "");
          const group = previousFindings.get(key) ?? [];
          group.push(finding);
          previousFindings.set(key, group);
        }
        project.dependencies = lookedUp.dependencies.map((d) => {
          const old = previous.get(d.id);
          const checkedVersion = lookedUp.versionChecked?.has(d.id) ?? freshUpdates;
          const versionSource = old && !checkedVersion ? old.versionSource : d.versionSource;
          if (old) {
            for (const finding of previousFindings.get(identity(d.packageName, d.resolved ?? "")) ??
              []) {
              if (
                (finding.kind === "update" && checkedVersion) ||
                (finding.kind === "advisory" && d.advisoryStatus === "checked") ||
                (finding.kind === "lifecycle" &&
                  lookedUp.signals?.get(d.id)?.deprecated !== undefined) ||
                finding.kind === "coverage"
              )
                continue;
              const keys =
                finding.kind === "update"
                  ? [d.id]
                  : finding.kind === "lifecycle"
                    ? [`${d.id}/deprecated`]
                    : old.advisoryIds.map((advisoryId) => `${d.id}/${advisoryId}`);
              if (
                keys.some(
                  (key) =>
                    finding.id ===
                    identity(
                      project.id,
                      finding.kind,
                      key,
                      finding.installedVersion ?? "",
                      finding.availableVersion ?? "",
                      finding.severity,
                    ),
                )
              )
                retainedFindingIds!.add(finding.id);
            }
          }
          return {
            ...d,
            advisoryIds:
              old && (d.advisoryStatus === "failed" || d.advisoryStatus === "not-checked")
                ? [...old.advisoryIds]
                : [...d.advisoryIds],
            availableVersion: old && !checkedVersion ? old.availableVersion : d.availableVersion,
            latestVersion: old && !checkedVersion ? old.latestVersion : d.latestVersion,
            ...(versionSource ? { versionSource } : {}),
          };
        });
        attempt.coverage = [...inputs.coverage, ...lookedUp.coverage];
        attempt.errors = [...new Set([...inputs.errors, ...lookedUp.errors])];
        freshAdvisories =
          this.lookup !== null &&
          lookedUp.dependencies
            .filter((d) => d.origin === "registry")
            .every((d) => d.advisoryStatus === "checked");
        // Answers that could not be read this scan stay as the previous scan found them.
        const priorUpdates = new Map(
          this.state.findings
            .filter((f) => f.subjectId === project.id && f.kind === "update")
            .map((f) => [f.id, f]),
        );
        for (const dep of lookedUp.dependencies) {
          const signals = lookedUp.signals?.get(dep.id);
          const available = dep.availableVersion ?? dep.latestVersion;
          if (available) {
            const update = this.finding(
              project.id,
              project.name,
              "update",
              dep.id,
              dep.name,
              dep.packageName,
              dep.resolved,
              available,
              "info",
              dep.versionSource ?? "npm registry",
              dep.availableVersion
                ? dep.versionSource?.includes(" outdated ")
                  ? "A newer version is compatible with the package manager's configuration."
                  : "A newer version satisfies the requested range."
                : "A newer latest release requires reviewing the requested range.",
              null,
            );
            findings.push(withSignals(update, signals, priorUpdates.get(update.id)));
            if (dep.origin === "registry") publicUpdates.add(update.id);
          }
          if (signals?.deprecated)
            findings.push(
              this.finding(
                project.id,
                project.name,
                "lifecycle",
                `${dep.id}/deprecated`,
                dep.name,
                dep.packageName,
                dep.resolved,
                null,
                "low",
                "npm registry",
                `Deprecated by its publisher: ${signals.deprecated}`,
                null,
              ),
            );
          for (const advisory of lookedUp.advisories.get(dep.id) ?? []) {
            const previousDetails = advisory.detailsUnavailable
              ? this.state.findings.find(
                  (f) =>
                    f.kind === "advisory" &&
                    f.subjectId === project.id &&
                    f.advisoryUrl === advisory.url &&
                    f.installedVersion === dep.resolved &&
                    f.packageName === dep.packageName,
                )
              : undefined;
            findings.push(
              this.finding(
                project.id,
                project.name,
                "advisory",
                `${dep.id}/${advisory.id}`,
                dep.name,
                dep.packageName,
                dep.resolved,
                previousDetails?.availableVersion ?? advisory.fixed,
                previousDetails?.severity ?? advisory.severity,
                "OSV",
                previousDetails?.description ?? advisory.summary,
                advisory.url,
              ),
            );
          }
        }
        findings = await this.withReleaseFacts(findings, publicUpdates, attempt, signal);
        const lifecycle = await this.lifecycleFindings(
          project.id,
          project.name,
          inputs.runtimes ?? [],
          signal,
        );
        findings.push(...lifecycle.findings);
        attempt.coverage.push(...lifecycle.notes);
        freshLifecycle = true;
        // A check that could not finish (no data, or a runtime file unread) is unknown, not clean.
        // ponytail: keeps all of the project's previous runtime findings until a complete check, even
        // one for a line since removed; narrow it to the lines not checked if that proves noisy.
        if (!lifecycle.complete || inputs.runtimeFileUnreadable)
          for (const old of this.state.findings)
            if (
              old.subjectId === project.id &&
              old.kind === "lifecycle" &&
              old.packageName === null
            )
              retainedFindingIds.add(old.id);
      } else {
        const inventory = await this.inventoryLookup(
          this.state.runtime.platform as NodeJS.Platform,
          this.state.runtime.mode,
          signal,
          (progress) => this.reportProgress(progress),
          this.state.inventory.managers,
        );
        this.commit(signal);
        const previous = this.state.inventory.installations;
        inventoryStatus = inventory.inventoryChecks;
        const previousById = new Map(previous.map((i) => [i.id, i]));
        const observed = new Set(
          inventory.installations.map((i) => identity(i.manager ?? "", i.rootId ?? "", i.name)),
        );
        const checkedRoots = new Set(inventory.checkedRoots);
        for (const installation of previous) {
          const source = inventory.managers.find((s) => s.manager === installation.manager);
          if (
            installation.rootId &&
            source &&
            (source.status === "not-installed" ||
              (source.root &&
                checkedRoots.has(identity("global-root", source.manager, source.root))))
          )
            checkedRoots.add(installation.rootId);
        }
        this.state.inventory.managers = structuredClone(
          inventory.managers,
        ) as Mutable<GlobalToolSource>[];
        this.state.inventory.installations = [
          ...inventory.installations.map((installation) => {
            const old = previousById.get(installation.id);
            return old &&
              installation.packageId &&
              old.packageId === installation.packageId &&
              installation.updateStatus === "unknown"
              ? {
                  ...installation,
                  availableVersion: old.availableVersion,
                  updateCheckedAt: old.updateCheckedAt ?? null,
                }
              : { ...installation };
          }),
          ...previous
            .filter(
              (i) =>
                i.manager &&
                i.rootId &&
                !observed.has(identity(i.manager, i.rootId, i.name)) &&
                !checkedRoots.has(i.rootId),
            )
            .map((i) => ({ ...i, updateStatus: "unknown" as const })),
        ];
        const updateEvidence = this.state.inventory.updateEvidence!;
        updateEvidence.status = inventory.updateChecks;
        updateEvidence.coverage = [...inventory.coverage];
        updateEvidence.errors = [...inventory.errors];
        if (updateEvidence.status === "complete" || updateEvidence.status === "partial")
          updateEvidence.lastSuccess = timestamp();
        // Keep failed roots; remove missing tools only after their actual global root was inspected.
        freshUpdates = true;
        const previousFindings = new Map(this.state.findings.map((f) => [f.id, f]));
        for (const installation of this.state.inventory.installations) {
          if (!installation.packageId) continue;
          const signals = inventory.signals?.get(installation.id);
          const deprecation = this.finding(
            this.state.device.id,
            this.state.device.label,
            "lifecycle",
            `${installation.id}/deprecated`,
            installation.name,
            installation.packageId,
            installation.version,
            null,
            "low",
            installation.source,
            `Deprecated by its publisher: ${signals?.deprecated ?? ""}`,
            null,
          );
          // A tool whose deprecation was not read (no metadata, or its version unlisted) keeps its
          // previous notice; one that was read decides. A tool that is gone is no longer in this
          // loop, so its notice goes with it.
          const previousDeprecation = previousFindings.get(deprecation.id);
          if (signals?.deprecated) findings.push(deprecation);
          else if (signals?.deprecated === undefined && previousDeprecation)
            findings.push(previousDeprecation);
          if (!installation.availableVersion) continue;
          const finding = this.finding(
            this.state.device.id,
            this.state.device.label,
            "update",
            installation.id,
            installation.name,
            installation.packageId,
            installation.version,
            installation.availableVersion,
            "info",
            installation.source,
            installation.updateStatus === "available"
              ? "A newer stable release is available from the public npm registry."
              : "A previously reported global tool update is retained; current coverage is unverified.",
            null,
          );
          const old = previousFindings.get(finding.id);
          const update = withSignals(finding, signals, old);
          // Only a public npm package is asked about, an update kept from an earlier scan included:
          // a tool since linked from a checkout, or moved to a private scope, is not.
          if (installation.origin === "registry") publicUpdates.add(update.id);
          if (installation.updateStatus === "available") findings.push(update);
          else if (old) findings.push({ ...update, lastSeenAt: old.lastSeenAt });
        }
        attempt.coverage = inventory.coverage;
        attempt.errors = inventory.errors;
        findings = await this.withReleaseFacts(findings, publicUpdates, attempt, signal);
        const runtimes = pcRuntimes(this.state.inventory.managers ?? []);
        const lifecycle = await this.lifecycleFindings(
          this.state.device.id,
          this.state.device.label,
          runtimes.runtimes,
          signal,
        );
        findings.push(...lifecycle.findings);
        attempt.coverage = [...attempt.coverage, ...runtimes.notes, ...lifecycle.notes];
        // The previous runtime findings stay unless Node.js was captured, an installed Bun's version
        // was read, and every product had data.
        freshLifecycle = lifecycle.complete && runtimes.complete;
      }
      attempt.status = inventoryStatus ?? (attempt.errors.length ? "partial" : "complete");
      if (attempt.status === "complete" && attempt.errors.length) attempt.status = "partial";
      if (attempt.status === "complete" || attempt.status === "partial") {
        evidence.coverage = [...attempt.coverage];
      }
    } catch (error) {
      // A stopped scan can leave findings built so far; a failed one keeps only the previous ones.
      findings = [];
      retainedFindingIds = null;
      freshUpdates = false;
      freshAdvisories = false;
      freshLifecycle = false;
      attempt.status = error instanceof InputError ? error.status : "failed";
      attempt.errors = [
        error instanceof InputError
          ? error.message
          : "The scan failed; previous successful evidence is retained.",
      ];
      if (!project) {
        this.state.inventory.updateEvidence!.status = attempt.status;
        this.state.inventory.updateEvidence!.errors = [...attempt.errors];
      }
    } finally {
      this.reportProgress({ stage: "saving", completed: null, total: null });
      // A removal is the outcome however the scan ended (its abort, an adapter's abort error).
      const removed = !!project && !this.state.projects.some((p) => p.id === id);
      const cancelled = !removed && controller.signal.reason === cancelledByOwner;
      if (removed) {
        attempt.status = "failed";
        attempt.errors = ["The project was removed during this scan."];
      } else if (cancelled) {
        attempt.status = "failed";
        attempt.cancelled = true;
        attempt.coverage = [];
        attempt.errors = [cancelledByOwner];
      }
      attempt.finishedAt = timestamp();
      if (cancelled) {
        Object.assign(evidence, evidenceBefore);
        if (updatesBefore) Object.assign(this.state.inventory.updateEvidence!, updatesBefore);
      } else {
        evidence.status = attempt.status;
        evidence.errors = [...attempt.errors];
      }
      // Failed attempts never erase previous successful inventory, dependencies, or actionable findings.
      const subjectId = project?.id ?? this.state.device.id;
      if (!removed && !cancelled) {
        // A runtime line checked again replaces its previous finding; a kept one would repeat it
        // with the other severity or version it had. A deprecation notice is not matched by name:
        // two versions of one package share it, and each notice stands for its own version.
        const rechecked = new Set(
          findings.filter((f) => f.kind === "lifecycle").map((f) => f.name),
        );
        const retained = this.state.findings.filter(
          (f) =>
            f.subjectId === subjectId &&
            !(f.kind === "lifecycle" && f.packageName === null && rechecked.has(f.name)) &&
            (retainedFindingIds !== null
              ? retainedFindingIds.has(f.id)
              : (f.kind === "update" && !freshUpdates) ||
                (f.kind === "advisory" && !freshAdvisories) ||
                // A runtime line follows the lifecycle check. A deprecation notice follows the
                // update checks that read it: This PC's loop rebuilds it, so only a failed scan
                // keeps it whole, and a tool that is gone never lingers.
                (f.kind === "lifecycle" &&
                  !(f.packageName === null ? freshLifecycle : freshUpdates))),
        );
        if (attempt.errors.length)
          findings.push(
            this.finding(
              subjectId,
              project?.name ?? attempt.targetLabel,
              "coverage",
              "coverage",
              "Incomplete checks",
              null,
              null,
              null,
              "unknown",
              project ? "Project collector" : "Global tool collector",
              attempt.errors.join(" "),
              null,
            ),
          );
        // A package whose check did not run is unknown, never resolved: the lockfile does not
        // resolve it, OSV or the registry failed for it, or (This PC) its update status is unknown.
        // Findings carry over only under an unchanged id, so a changed one looks like a resolution.
        // ponytail: an nvm root switch reads as the old root's tools gone, resolved though not
        // updated; name the root in the entry if that misleads
        const unresolved = new Set(
          project
            ? project.dependencies
                .filter(
                  (d) =>
                    d.resolved === null ||
                    d.advisoryStatus === "failed" ||
                    d.versionStatus === "failed",
                )
                .map((d) => d.packageName)
            : this.state.inventory.installations
                .filter((i) => i.updateStatus === "unknown")
                .map((i) => i.packageId ?? i.name),
        );
        this.mergeFindings(subjectId, [...retained, ...findings], unresolved);
        // New since last scan compares detection times with the success before this one. Stamped after
        // the incomplete-checks finding above, so nothing this scan found is detected later than it.
        if (attempt.status === "complete" || attempt.status === "partial") {
          evidence.previousSuccess = evidence.lastSuccess;
          evidence.lastSuccess = timestamp();
        }
      }
      try {
        this.persist();
      } catch {
        // Memory stays current, but a restart reloads the last successful write.
        if (!attempt.errors.includes(evidenceNotSaved))
          attempt.errors = [...attempt.errors, evidenceNotSaved];
        if (attempt.status === "complete") attempt.status = "partial";
        // A cancelled scan changed no evidence: what it restored stays, not Failed, and out of Retry.
        if (!cancelled) {
          evidence.status = attempt.status;
          evidence.errors = [...attempt.errors];
          if (!project) {
            // PC update checks are unsaved too; a failed check stays failed.
            const updates = this.state.inventory.updateEvidence!;
            if (updates.status === "complete") updates.status = "partial";
            if (!updates.errors.includes(evidenceNotSaved))
              updates.errors = [...updates.errors, evidenceNotSaved];
          }
        }
      }
    }
  }

  private finding(
    subjectId: string,
    subjectLabel: string,
    kind: Finding["kind"],
    key: string,
    name: string,
    pkg: string | null,
    installed: string | null,
    available: string | null,
    severity: Finding["severity"],
    source: string,
    description: string,
    advisoryUrl: string | null,
  ): Finding {
    return {
      id: identity(subjectId, kind, key, installed ?? "", available ?? "", severity),
      kind,
      subjectId,
      subjectLabel,
      name,
      packageName: pkg,
      installedVersion: installed,
      availableVersion: available,
      severity,
      source,
      description,
      advisoryUrl,
      detectedAt: timestamp(),
      lastSeenAt: timestamp(),
    };
  }

  /**
   * Lifecycle findings for runtime lines, and the notes that say what could not be checked, or, when
   * every product had data, how many were. `complete` is false when a runtime's product has no data,
   * so its lifecycle is unknown.
   */
  private async lifecycleFindings(
    subjectId: string,
    subjectLabel: string,
    runtimes: readonly DeclaredRuntime[],
    signal: AbortSignal,
  ): Promise<{ findings: Finding[]; notes: string[]; complete: boolean }> {
    if (!runtimes.length) return { findings: [], notes: [], complete: true };
    const now = Date.now();
    const loaded = await loadLifecycle(
      runtimes.map((runtime) => runtime.product),
      this.storage,
      this.sourceFetch,
      this.lifecycleAttempts,
      now,
      signal,
    );
    const findings: Finding[] = [];
    const notes = [...loaded.notes];
    for (const runtime of runtimes) {
      const data = loaded.data.get(runtime.product);
      const verdict = data ? lifecycleVerdict(runtime, data, now) : null;
      if (verdict?.kind === "note") notes.push(verdict.text);
      else if (verdict) {
        const finding = this.finding(
          subjectId,
          subjectLabel,
          "lifecycle",
          `runtime/${runtime.product}/${runtime.cycle}`,
          `${lifecycleLabels[runtime.product]} ${runtime.cycle}`,
          null,
          runtime.version,
          null,
          verdict.severity,
          "endoflife.date",
          verdict.description,
          null,
        );
        findings.push(
          verdict.effectiveDate ? { ...finding, effectiveDate: verdict.effectiveDate } : finding,
        );
      }
    }
    const complete = runtimes.every((runtime) => loaded.data.has(runtime.product));
    if (complete) {
      const products = new Set(runtimes.map((runtime) => runtime.product)).size;
      notes.push(
        `Runtime end of life checked against endoflife.date (${products} product${products === 1 ? "" : "s"}).`,
      );
    }
    return { findings, notes, complete };
  }

  /**
   * deps.dev facts for the update findings in `publicUpdates` while the owner allows the lookup.
   * What deps.dev does not answer stays unknown: no fact is invented, and a gap, or a stop, is never
   * an error.
   */
  private async withReleaseFacts(
    findings: Finding[],
    publicUpdates: ReadonlySet<string>,
    attempt: Mutable<ScanRecord>,
    signal: AbortSignal,
  ): Promise<Finding[]> {
    const key = (finding: Finding) =>
      publicUpdates.has(finding.id) &&
      finding.packageName !== null &&
      finding.availableVersion !== null
        ? `${finding.packageName}@${finding.availableVersion}`
        : null;
    const candidates = findings.flatMap((finding) =>
      key(finding) ? [{ name: finding.packageName!, version: finding.availableVersion! }] : [],
    );
    if (!candidates.length) return findings;
    // The notes go on a new list: on This PC `attempt.coverage` is the inventory result's own array.
    if (this.state.settings.useDepsDev === false) {
      attempt.coverage = [
        ...attempt.coverage,
        "deps.dev lookups are off; release age, license and provenance are unknown.",
      ];
      return findings;
    }
    const { facts, checked, total } = await lookupReleaseFacts(
      candidates,
      this.storage,
      this.sourceFetch,
      signal,
      (completed, all) => this.reportProgress({ stage: "release-facts", completed, total: all }),
    );
    // A stop is not thrown from here: the scan's dependencies or inventory are already replaced, and a
    // failed attempt would leave its findings, coverage and status out of step with them. The facts
    // that arrived are used, the rest read unknown, and the count below says how many were checked.
    attempt.coverage = [
      ...attempt.coverage,
      `Release age, license and provenance (deps.dev): ${checked}/${total} update candidates`,
    ];
    return findings.map((finding) => {
      const name = key(finding);
      const fact = name === null ? undefined : facts.get(name);
      return fact
        ? {
            ...finding,
            ...(fact.publishedAt ? { publishedAt: fact.publishedAt } : {}),
            ...(fact.license ? { license: fact.license } : {}),
            ...(fact.provenance ? { provenance: true as const } : {}),
          }
        : finding;
    });
  }

  private mergeFindings(subjectId: string, findings: Finding[], unresolved?: ReadonlySet<string>) {
    const previous = new Map(this.state.findings.map((f) => [f.id, f]));
    const deduped = [...new Map(findings.map((f) => [f.id, f])).values()];
    const resolved = newlyResolved(
      this.state.findings.filter((f) => f.subjectId === subjectId),
      deduped,
      new Date(this.now()).toISOString(),
      unresolved,
    );
    this.state.findings = [
      ...this.state.findings.filter((f) => f.subjectId !== subjectId),
      ...deduped.map((f) => ({ ...f, detectedAt: previous.get(f.id)?.detectedAt ?? f.detectedAt })),
    ];
    this.state.resolvedFindings = keepResolved(
      [...resolved, ...(this.state.resolvedFindings ?? [])],
      this.state.findings,
      this.now(),
    );
    const eligible = this.notificationFilter();
    for (const finding of deduped) {
      // Coverage gaps are visible in the app; `eligible` lets only new updates and advisories notify.
      if (finding.kind === "coverage" || this.notified.has(finding.id)) continue;
      // Recorded even when it does not notify (notifications off, a hidden, watch-only or
      // out-of-scope finding, any lifecycle finding), so a later change announces only newer findings.
      this.notified.add(finding.id);
      if (!this.state.settings.notifyNewFindings || !eligible(finding)) continue;
      this.state.notifications.push({
        id: randomUUID(),
        findingId: finding.id,
        title: `${finding.subjectLabel}: ${finding.name}`,
        body: finding.description,
        createdAt: new Date(this.now()).toISOString(),
        deliveredAt: null,
      });
    }
    this.pruneNotifications();
  }

  private reportProgress(progress: Pick<ActiveScan, "stage" | "completed" | "total">) {
    if (this.progress) this.progress = { ...this.progress, ...progress, updatedAt: timestamp() };
  }

  private pruneNotifications() {
    const current = new Set(this.state.findings.map((f) => f.id));
    // Only current findings need remembering as already announced.
    this.notified = new Set([...this.notified].filter((id) => current.has(id)));
    // Obsolete pending fingerprints must not produce a toast after a newer result resolves them.
    const pending = this.state.notifications.filter(
      (n) => n.deliveredAt === null && current.has(n.findingId),
    );
    this.state.notifications = [
      ...pending,
      ...this.state.notifications.filter((n) => n.deliveredAt !== null).slice(-200),
    ];
  }

  private prepareNotificationSummary(): NotificationSummary | null {
    const now = this.now();
    if (
      !this.state.settings.notifyNewFindings ||
      this.worker ||
      this.queue.size ||
      now - this.settledAt < 2000 ||
      (this.state.notificationNextAt !== null && Date.parse(this.state.notificationNextAt!) > now)
    )
      return null;
    const findings = new Map(this.state.findings.map((f) => [f.id, f]));
    const eligible = this.notificationFilter();
    const digestAt = this.state.settings.digestAt ?? null;
    // A daily digest presents what was new by its latest local time; later events wait for the next one.
    const cutoff =
      digestAt === null
        ? Number.POSITIVE_INFINITY
        : latestDailyTime(digestAt, new Date(now)).getTime();
    let pending = this.state.notifications.filter((n) => {
      const finding = findings.get(n.findingId);
      return (
        n.deliveredAt === null &&
        finding !== undefined &&
        // `!(a > b)`: an event whose time cannot be read is presented, not lost.
        !(Date.parse(n.createdAt) > cutoff) &&
        eligible(finding)
      );
    });
    if (!pending.length) return null;
    const pendingIds = new Set(pending.map((n) => n.id));
    const quiet = inQuietHours(this.state.settings.quietHours ?? null, new Date(now));
    const frozen = this.summaries.find(
      (s) => !s.acknowledged && s.notificationIds.some((id) => pendingIds.has(id)),
    );
    // A read outside quiet hours offers the summary for native delivery, and from then on it keeps its
    // events, so the receipt covers what was shown. While quiet hours hold the native notification
    // the summary has not been offered: it takes in the events found since, so the in-app toast
    // follows them, and the first read after the window offers it with all of them.
    const held = frozen !== undefined && !quiet && frozen.summary.quiet === false;
    if (held) {
      const ids = new Set(frozen.notificationIds);
      pending = pending.filter((n) => ids.has(n.id));
    }
    const notificationIds = held ? frozen.notificationIds : pending.map((n) => n.id).sort();
    const id = held
      ? frozen.summary.id
      : identity("notification-summary", JSON.stringify(notificationIds));
    const key = (f: Finding) =>
      f.subjectId === this.state.device.id
        ? f.id
        : identity(
            f.subjectId,
            f.packageName ?? f.name,
            f.installedVersion ?? "",
            f.availableVersion ?? "",
            f.kind === "advisory" ? (f.advisoryUrl ?? f.id) : "update",
          );
    const unique = (items: readonly Finding[], kind: "update" | "advisory") => [
      ...new Map(items.filter((f) => f.kind === kind).map((f) => [key(f), f])).values(),
    ];
    // Totals count what may notify: hidden, watch-only, and out-of-scope findings are left out.
    const current = this.state.findings.filter(eligible);
    const updates = unique(current, "update");
    const advisories = unique(current, "advisory");
    const newFindings = pending.map((n) => findings.get(n.findingId)!);
    const newUpdates = unique(newFindings, "update");
    const newAdvisories = unique(newFindings, "advisory");
    const subjects = new Set([...updates, ...advisories].map((f) => f.subjectId));
    const pcCount = subjects.has(this.state.device.id) ? 1 : 0;
    const projectCount = this.state.projects.filter((p) => subjects.has(p.id)).length;
    const updateTitle = `${updates.length} update${updates.length === 1 ? "" : "s"} available`;
    const advisoryTitle = `${advisories.length} security advisor${advisories.length === 1 ? "y" : "ies"}`;
    const summary: NotificationSummary = {
      id,
      updateCount: updates.length,
      newUpdateCount: newUpdates.length,
      projectCount,
      pcCount,
      advisoryCount: advisories.length,
      newAdvisoryCount: newAdvisories.length,
      title: newAdvisories.length ? advisoryTitle : updateTitle,
      body: [
        newUpdates.length
          ? `${newUpdates.length} newly detected update${newUpdates.length === 1 ? "" : "s"}.`
          : "",
        newAdvisories.length
          ? `${newAdvisories.length} newly detected security advisor${newAdvisories.length === 1 ? "y" : "ies"}.`
          : "",
        `Across ${[pcCount ? "this PC" : "", projectCount ? `${projectCount} project${projectCount === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}. Click to review.`,
      ]
        .filter(Boolean)
        .join(" "),
      filter:
        newUpdates.length && newAdvisories.length
          ? "all"
          : newUpdates.length
            ? "updates"
            : "advisories",
      // Native notifications wait for quiet hours to end; the in-app summary does not.
      quiet,
    };
    if (frozen) {
      frozen.summary = summary;
      frozen.notificationIds = notificationIds;
    } else {
      this.summaries.push({ summary, notificationIds, acknowledged: false });
      if (this.summaries.length > 2) this.summaries.shift();
    }
    if (!quiet) {
      this.offered.set(id, notificationIds);
      if (this.offered.size > 20) this.offered.delete(this.offered.keys().next().value!);
    }
    return summary;
  }
}
