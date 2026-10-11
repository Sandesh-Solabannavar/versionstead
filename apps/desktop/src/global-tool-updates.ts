import { randomUUID } from "node:crypto";
import type { Installation, MonitoringSnapshot } from "@versionstead/contracts/monitoring";
import {
  globalToolUpdateActive,
  type GlobalToolUpdateBatch,
  type GlobalToolUpdateRequest,
  type GlobalToolUpdateRun,
} from "@versionstead/contracts/global-tool-updates";
import {
  resolveGlobalToolUpdate,
  executeGlobalToolUpdate,
  verifyGlobalToolUpdate,
} from "../../server/dist/adapters/global-tool-updates.js";
import { InputError } from "../../server/dist/adapters/projects.js";

type Dependencies = {
  resolve: typeof resolveGlobalToolUpdate;
  execute: typeof executeGlobalToolUpdate;
  verify: typeof verifyGlobalToolUpdate;
  /**
   * Must settle in bounded time: Update all and close() wait for it. Production: two rounds of
   * coordinator requests (read, then scan), each limited to 10 s, so about 20 s.
   */
  refresh: () => Promise<void>;
};
type Stage = Pick<GlobalToolUpdateRun, "status" | "message"> & { command?: string };
type BatchItem = {
  installationId: string;
  rootId: string;
  manager: "npm" | "bun";
  name: string;
  packageId: string;
  previousVersion: string;
  targetVersion: string;
  status: GlobalToolUpdateBatch["items"][number]["status"];
  message: string;
};
type BatchState = {
  id: string;
  status: GlobalToolUpdateBatch["status"];
  stopped: boolean;
  startedAt: string;
  finishedAt: string | null;
  note: string | null;
  items: BatchItem[];
};

/** Whether an installation carries a verified public-registry update the runner may start. */
const updatable = (item: Installation) =>
  Boolean(item.rootId && item.packageId && item.manager && item.availableVersion) &&
  item.updateStatus === "available" &&
  item.origin === "registry";

/** npm updating npm (or Bun updating Bun) replaces the installer itself, so Update all runs it last. */
const selfUpdate = (item: Installation) => (item.packageId ?? item.name) === item.manager;

/**
 * The installations update requests name, checked against the coordinator's current snapshot as
 * Update now always was: each must still show its expected installed and target versions, no PC
 * scan may be running or queued, and the last PC scan and update check must not have failed. One
 * stale item refuses the whole request.
 */
export function currentUpdateItems(
  snapshot: Pick<MonitoringSnapshot, "inventory" | "scanProgress"> | null,
  requests: readonly GlobalToolUpdateRequest[],
): Installation[] {
  const inventory = snapshot?.inventory;
  const items = requests.map((request) => {
    const item = inventory?.installations.find(
      (candidate) => candidate.id === request.installationId,
    );
    if (
      !item ||
      item.version !== request.expectedVersion ||
      item.availableVersion !== request.targetVersion ||
      item.updateStatus !== "available"
    )
      throw new Error("This update changed. Scan this PC and review the current version.");
    return item;
  });
  if (
    inventory?.evidence.status === "scanning" ||
    snapshot?.scanProgress?.active?.kind === "pc" ||
    snapshot?.scanProgress?.queued.some((target) => target.kind === "pc")
  )
    throw new Error("Wait for the PC scan to finish before updating.");
  if (inventory?.evidence.status === "failed" || inventory?.updateEvidence?.status === "failed")
    throw new Error("Scan this PC successfully before updating a previous result.");
  return items;
}

/** Provider updater: re-resolve ownership, lock the installer, execute, verify, refresh. */
export class GlobalToolUpdateRunner {
  private runs = new Map<string, GlobalToolUpdateRun>();
  private work = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private batch: { state: BatchState; controller: AbortController; done: Promise<void> } | null =
    null;
  private closing = false;
  private readonly dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }
  private get batchRunning() {
    return this.batch !== null && this.batch.state.status !== "finished";
  }
  get active() {
    return this.work.size > 0 || this.batchRunning;
  }
  read() {
    return [...this.runs.values()];
  }
  /** The latest Update all, kept until the next one starts; null before the first. */
  readBatch(): GlobalToolUpdateBatch | null {
    return this.batch ? structuredClone(this.batch.state) : null;
  }
  start(item: Installation) {
    if (this.closing) throw new Error("The desktop is shutting down.");
    if (this.batchRunning)
      throw new Error("Update all is running. Wait for it to finish or stop it.");
    if (!updatable(item))
      throw new Error("This package has no verified update. Scan this PC again.");
    const rootId = item.rootId!;
    if (this.work.has(rootId))
      throw new Error("An update is already running in this global location.");
    const key = `${rootId}:${item.name}`;
    const state: GlobalToolUpdateRun = {
      installationId: item.id,
      rootId,
      manager: item.manager!,
      name: item.name,
      packageId: item.packageId!,
      previousVersion: item.version,
      targetVersion: item.availableVersion!,
      status: "preparing",
      command: null,
      message: "Checking the owning installation…",
    };
    for (const [oldKey, run] of this.runs)
      if (this.runs.size >= 20 && !globalToolUpdateActive(run)) this.runs.delete(oldKey);
    this.runs.set(key, state);
    const change = (patch: Partial<GlobalToolUpdateRun>) =>
      this.runs.set(key, { ...this.runs.get(key)!, ...patch });
    const controller = new AbortController();
    const done = (async () => {
      try {
        await this.perform(item, controller.signal, change);
        // Also rescan after failure: an interrupted installation may have changed files.
        try {
          await this.dependencies.refresh();
        } catch {
          change({ message: `${this.runs.get(key)!.message} Scan this PC to refresh monitoring.` });
        }
      } finally {
        this.work.delete(rootId);
      }
    })();
    this.work.set(rootId, { controller, done });
    return state;
  }
  /**
   * Update all: one package at a time through the same resolve, install, and verify steps, then one
   * PC rescan. A failure skips the rest of that global location; Stop finishes the package being
   * installed and starts nothing after it; quitting stops the running installer.
   */
  startAll(items: readonly Installation[]): GlobalToolUpdateBatch {
    if (this.closing) throw new Error("The desktop is shutting down.");
    if (this.batchRunning || this.work.size > 0)
      throw new Error("Another update is running. Wait for it to finish.");
    if (!items.length || !items.every(updatable))
      throw new Error("A package has no verified update. Scan this PC again.");
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error("Each package can be updated once.");
    const ordered = items.toSorted((a, b) => Number(selfUpdate(a)) - Number(selfUpdate(b)));
    const state: BatchState = {
      id: randomUUID(),
      status: "running",
      stopped: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      note: null,
      items: ordered.map((item) => ({
        installationId: item.id,
        rootId: item.rootId!,
        manager: item.manager!,
        name: item.name,
        packageId: item.packageId!,
        previousVersion: item.version,
        targetVersion: item.availableVersion!,
        status: "waiting",
        message: "Waiting to start.",
      })),
    };
    const controller = new AbortController();
    const done = (async () => {
      const failedRoots = new Set<string>();
      for (const [index, item] of ordered.entries()) {
        const entry = state.items[index]!;
        const skip = this.closing
          ? "Not started: Versionstead quit first."
          : state.stopped
            ? "Not started: you stopped Update all."
            : failedRoots.has(entry.rootId)
              ? "Not started: an earlier update in this global location failed. Scan this PC, then retry."
              : null;
        if (skip) {
          entry.status = "skipped";
          entry.message = skip;
          continue;
        }
        entry.status = "preparing";
        entry.message = "Checking the owning installation…";
        const performed = this.perform(item, controller.signal, (stage) => {
          entry.status = stage.status;
          entry.message = stage.message;
        });
        // The current item holds its root's lock, as a single update does. close() does not depend
        // on this entry: it aborts the batch controller itself.
        this.work.set(entry.rootId, { controller, done: performed.then(() => undefined) });
        if (!(await performed)) failedRoots.add(entry.rootId);
        this.work.delete(entry.rootId);
      }
      // One rescan for the whole run, as each Update now requests one.
      try {
        await this.dependencies.refresh();
      } catch {
        state.note = "The PC rescan could not start. Scan this PC to refresh monitoring.";
      }
      state.status = "finished";
      state.finishedAt = new Date().toISOString();
    })();
    this.batch = { state, controller, done };
    return structuredClone(state);
  }
  /** Finishes the package being installed, then starts nothing more; an installer is never interrupted. */
  stopAll(): GlobalToolUpdateBatch | null {
    if (this.batch?.state.status === "running") {
      this.batch.state.status = "stopping";
      this.batch.state.stopped = true;
    }
    return this.readBatch();
  }
  async close() {
    this.closing = true;
    const work = [...this.work.values()];
    for (const run of work) run.controller.abort();
    this.batch?.controller.abort();
    await Promise.all([...work.map((run) => run.done), this.batch?.done]);
  }
  /** Resolves, installs, and verifies one update, reporting each stage; never throws. True once verified. */
  private async perform(
    item: Installation,
    signal: AbortSignal,
    report: (stage: Stage) => void,
  ): Promise<boolean> {
    try {
      const plan = await this.dependencies.resolve(item, signal);
      if (signal.aborted) throw new Error("The update was stopped. Scan this PC before retrying.");
      report({
        status: "updating",
        command: plan.command,
        message: `Installing ${item.name} ${item.availableVersion}…`,
      });
      await this.dependencies.execute(plan, signal);
      report({ status: "verifying", message: "Verifying the installed version…" });
      await this.dependencies.verify(plan, item);
      report({ status: "succeeded", message: `${item.name} updated to ${item.availableVersion}.` });
      return true;
    } catch (error) {
      report({
        status: "failed",
        message:
          error instanceof InputError
            ? error.message.slice(0, 500)
            : "The update failed. Check the owning package manager, then scan this PC before retrying.",
      });
      return false;
    }
  }
}

export const globalToolUpdateDependencies = {
  resolve: resolveGlobalToolUpdate,
  execute: executeGlobalToolUpdate,
  verify: verifyGlobalToolUpdate,
};
