import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { validateProjectChanges } from "@versionstead/contracts/project-settings";
import {
  decodeMonitoringProgress,
  decodeMonitoringSnapshot,
  type ActiveScan,
  type Finding,
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
import { MonitoringStorage } from "./storage.ts";
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
  lookupDependencies,
  type DependencyLookup,
  type LookupResult,
} from "./adapters/lookups.ts";
export { InputError } from "./adapters/projects.ts";

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const timestamp = () => new Date().toISOString();
const features = "settings-repositories-connections-v7" as const;
const evidenceNotSaved = "Evidence could not be saved; the previous saved evidence is retained.";
const emptyEvidence = (): Mutable<ScanEvidence> => ({
  status: "not-scanned",
  lastAttempt: null,
  lastSuccess: null,
  coverage: [],
  errors: [],
});

export type MonitoringOptions = {
  dataDir: string;
  mode?: "interactive" | "background";
  host?: "session" | "boot-task" | "unconfigured";
  platform?: NodeJS.Platform;
  lookup?: boolean;
  dependencyLookup?: DependencyLookup;
  inventoryLookup?: typeof inspectInventory;
  nativeVersionLookup?: typeof checkNativeVersions | false;
};

export class MonitoringCoordinator {
  private projectInspection = (project: Project, _signal?: AbortSignal) =>
    inspectProject(project.path);
  private automaticProjectAllowed = (_project: Project) => true;
  private readonly storage: MonitoringStorage;
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
  private readonly shutdown = new AbortController();
  private progress: Mutable<ActiveScan> | null = null;
  // A random boot id keeps revisions of different instances on one database distinct.
  private readonly bootId = randomUUID();
  private changes = 0;
  private stable: { revision: string; json: string } | null = null;
  private settledAt = Date.now();
  private readonly summaries: {
    summary: NotificationSummary;
    notificationIds: string[];
    acknowledged: boolean;
  }[] = [];

  constructor(options: MonitoringOptions) {
    this.storage = new MonitoringStorage(options.dataDir);
    const stored = this.storage.read();
    const platform = options.platform ?? process.platform;
    const nativeVersionLookup =
      options.nativeVersionLookup === false
        ? null
        : (options.nativeVersionLookup ?? checkNativeVersions);
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
            )));
    this.inventoryLookup = options.inventoryLookup ?? inspectInventory;
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
        json: JSON.stringify(decodeMonitoringSnapshot({ ...this.state, features })),
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
    this.state.notifications = this.state.notifications.filter((n) => !removed.has(n.findingId));
    this.queue.delete(id);
    delete this.due[id];
    if (this.active === id) this.activeScan?.abort();
    this.persist();
  }

  requestScan(input: { target: "pc" | "projects" | "all"; projectId?: string }): void {
    this.assertOpen();
    if (!["pc", "projects", "all"].includes(input.target))
      throw new InputError("Invalid scan target.");
    if (input.projectId) {
      this.project(input.projectId);
      this.enqueue(input.projectId, true);
    } else {
      if (input.target !== "projects") this.enqueue("pc", true);
      if (input.target !== "pc")
        for (const project of this.state.projects) this.enqueue(project.id, true);
    }
    this.runQueue();
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
      (input.paused !== undefined && typeof input.paused !== "boolean") ||
      (input.notifyNewFindings !== undefined && typeof input.notifyNewFindings !== "boolean")
    )
      throw new InputError("Invalid monitoring settings.");
    this.state.settings = { ...this.state.settings, ...input };
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
    if (!frozen) throw new InputError("The notification summary is no longer available.");
    if (frozen.acknowledged) return;
    const ids = new Set(frozen.notificationIds);
    const deliveredAt = timestamp();
    let presented = 0;
    for (const event of this.state.notifications)
      if (event.deliveredAt === null && ids.has(event.id)) {
        event.deliveredAt = deliveredAt;
        presented += 1;
      }
    if (presented) this.state.notificationNextAt = new Date(Date.now() + 5 * 60000).toISOString();
    this.pruneNotifications();
    this.persist();
    frozen.acknowledged = true;
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
    if (this.closed || this.state.settings.paused) return;
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
        this.settledAt = Date.now();
        // A request made while this worker was finishing would otherwise stay queued until
        // something else starts a worker.
        this.runQueue();
      });
  }

  private async scan(id: string) {
    const project = id === "pc" ? null : this.state.projects.find((p) => p.id === id);
    if (id !== "pc" && !project) return;
    const evidence = project?.evidence ?? this.state.inventory.evidence;
    // Removing a project aborts its own scan, leaving shutdown and other scans untouched.
    this.activeScan = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, this.activeScan.signal]);
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
    let freshUpdates = false;
    let freshAdvisories = false;
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
        if (this.shutdown.signal.aborted)
          throw new InputError(
            "The scan stopped before it finished; previous successful evidence is retained.",
          );
        if (!this.state.projects.some((p) => p.id === id)) return;
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
                finding.kind === "coverage"
              )
                continue;
              const keys =
                finding.kind === "update"
                  ? [d.id]
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
        for (const dep of lookedUp.dependencies) {
          const available = dep.availableVersion ?? dep.latestVersion;
          if (available)
            findings.push(
              this.finding(
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
      } else {
        const inventory = await this.inventoryLookup(
          this.state.runtime.platform as NodeJS.Platform,
          this.state.runtime.mode,
          signal,
          (progress) => this.reportProgress(progress),
          this.state.inventory.managers,
        );
        if (this.shutdown.signal.aborted)
          throw new InputError(
            "The scan stopped before it finished; previous successful evidence is retained.",
          );
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
          if (!installation.packageId || !installation.availableVersion) continue;
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
          if (installation.updateStatus === "available") findings.push(finding);
          else if (old) findings.push({ ...finding, lastSeenAt: old.lastSeenAt });
        }
        attempt.coverage = inventory.coverage;
        attempt.errors = inventory.errors;
      }
      attempt.status = inventoryStatus ?? (attempt.errors.length ? "partial" : "complete");
      if (attempt.status === "complete" && attempt.errors.length) attempt.status = "partial";
      if (attempt.status === "complete" || attempt.status === "partial") {
        evidence.lastSuccess = timestamp();
        evidence.coverage = [...attempt.coverage];
      }
    } catch (error) {
      retainedFindingIds = null;
      freshUpdates = false;
      freshAdvisories = false;
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
      // However the scan ended (early return, adapter abort error), a removal is its outcome.
      if (project && !this.state.projects.some((p) => p.id === id)) {
        attempt.status = "failed";
        attempt.errors = ["The project was removed during this scan."];
      }
      attempt.finishedAt = timestamp();
      evidence.status = attempt.status;
      evidence.errors = [...attempt.errors];
      // Failed attempts never erase previous successful inventory, dependencies, or actionable findings.
      const subjectId = project?.id ?? this.state.device.id;
      if (!project || this.state.projects.some((p) => p.id === id)) {
        const retained = this.state.findings.filter(
          (f) =>
            f.subjectId === subjectId &&
            (retainedFindingIds !== null
              ? retainedFindingIds.has(f.id)
              : (f.kind === "update" && !freshUpdates) ||
                (f.kind === "advisory" && !freshAdvisories)),
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
        this.mergeFindings(subjectId, [...retained, ...findings]);
      }
      try {
        this.persist();
      } catch {
        // Memory stays current, but a restart reloads the last successful write.
        if (!attempt.errors.includes(evidenceNotSaved))
          attempt.errors = [...attempt.errors, evidenceNotSaved];
        if (attempt.status === "complete") attempt.status = "partial";
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
  private mergeFindings(subjectId: string, findings: Finding[]) {
    const previous = new Map(this.state.findings.map((f) => [f.id, f]));
    const deduped = [...new Map(findings.map((f) => [f.id, f])).values()];
    this.state.findings = [
      ...this.state.findings.filter((f) => f.subjectId !== subjectId),
      ...deduped.map((f) => ({ ...f, detectedAt: previous.get(f.id)?.detectedAt ?? f.detectedAt })),
    ];
    for (const finding of deduped) {
      // Coverage failures are visible in the app; only new actionable package findings produce notifications.
      if (finding.kind === "coverage" || this.notified.has(finding.id)) continue;
      // Recorded even while notifications are off, so enabling them later announces only newer findings.
      this.notified.add(finding.id);
      if (!this.state.settings.notifyNewFindings) continue;
      this.state.notifications.push({
        id: randomUUID(),
        findingId: finding.id,
        title: `${finding.subjectLabel}: ${finding.name}`,
        body: finding.description,
        createdAt: timestamp(),
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
    if (
      !this.state.settings.notifyNewFindings ||
      this.worker ||
      this.queue.size ||
      Date.now() - this.settledAt < 2000 ||
      (this.state.notificationNextAt !== null &&
        Date.parse(this.state.notificationNextAt!) > Date.now())
    )
      return null;
    const findings = new Map(this.state.findings.map((f) => [f.id, f]));
    let pending = this.state.notifications.filter(
      (n) =>
        n.deliveredAt === null &&
        findings.get(n.findingId)?.kind !== "coverage" &&
        findings.has(n.findingId),
    );
    if (!pending.length) return null;
    const pendingIds = new Set(pending.map((n) => n.id));
    const frozen = this.summaries.find(
      (s) => !s.acknowledged && s.notificationIds.some((id) => pendingIds.has(id)),
    );
    if (frozen) {
      const ids = new Set(frozen.notificationIds);
      pending = pending.filter((n) => ids.has(n.id));
    }
    const notificationIds = frozen?.notificationIds ?? pending.map((n) => n.id).sort();
    const id =
      frozen?.summary.id ?? identity("notification-summary", JSON.stringify(notificationIds));
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
    const updates = unique(this.state.findings, "update");
    const advisories = unique(this.state.findings, "advisory");
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
    };
    if (frozen) frozen.summary = summary;
    else {
      this.summaries.push({ summary, notificationIds, acknowledged: false });
      if (this.summaries.length > 2) this.summaries.shift();
    }
    return summary;
  }
}
