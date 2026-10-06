import type { Installation } from "@versionstead/contracts/monitoring";
import {
  globalToolUpdateActive,
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
  refresh: () => Promise<void>;
};

/** Provider updater: re-resolve ownership, lock the installer, execute, verify, refresh. */
export class GlobalToolUpdateRunner {
  private runs = new Map<string, GlobalToolUpdateRun>();
  private work = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;
  private readonly dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }
  get active() {
    return this.work.size > 0;
  }
  read() {
    return [...this.runs.values()];
  }
  start(item: Installation) {
    if (this.closing) throw new Error("The desktop is shutting down.");
    if (
      !item.rootId ||
      !item.packageId ||
      !item.manager ||
      !item.availableVersion ||
      item.updateStatus !== "available" ||
      item.origin !== "registry"
    )
      throw new Error("This package has no verified update. Scan this PC again.");
    if (this.work.has(item.rootId))
      throw new Error("An update is already running in this global location.");
    const key = `${item.rootId}:${item.name}`;
    const state: GlobalToolUpdateRun = {
      installationId: item.id,
      rootId: item.rootId,
      manager: item.manager,
      name: item.name,
      packageId: item.packageId,
      previousVersion: item.version,
      targetVersion: item.availableVersion,
      status: "preparing",
      command: null,
      message: "Checking the owning installation…",
    };
    for (const [oldKey, run] of this.runs)
      if (this.runs.size >= 20 && !globalToolUpdateActive(run)) this.runs.delete(oldKey);
    this.runs.set(key, state);
    const controller = new AbortController();
    const change = (patch: Partial<GlobalToolUpdateRun>) =>
      this.runs.set(key, { ...this.runs.get(key)!, ...patch });
    const done = (async () => {
      try {
        const plan = await this.dependencies.resolve(item, controller.signal);
        if (controller.signal.aborted)
          throw new Error("The update was stopped. Scan this PC before retrying.");
        change({
          status: "updating",
          command: plan.command,
          message: `Installing ${item.name} ${item.availableVersion}…`,
        });
        await this.dependencies.execute(plan, controller.signal);
        change({
          status: "verifying",
          message: "Verifying the installed version…",
        });
        await this.dependencies.verify(plan, item);
        change({
          status: "succeeded",
          message: `${item.name} updated to ${item.availableVersion}.`,
        });
      } catch (error) {
        change({
          status: "failed",
          message:
            error instanceof InputError
              ? error.message.slice(0, 500)
              : "The update failed. Check the owning package manager, then scan this PC before retrying.",
        });
      } finally {
        // Also rescan after failure: an interrupted installation may have changed files.
        try {
          await this.dependencies.refresh();
        } catch {
          change({
            message: `${this.runs.get(key)!.message} Scan this PC to refresh monitoring.`,
          });
        }
        this.work.delete(item.rootId!);
      }
    })();
    this.work.set(item.rootId, { controller, done });
    return state;
  }
  async close() {
    this.closing = true;
    const work = [...this.work.values()];
    for (const run of work) run.controller.abort();
    await Promise.all(work.map((run) => run.done));
  }
}

export const globalToolUpdateDependencies = {
  resolve: resolveGlobalToolUpdate,
  execute: executeGlobalToolUpdate,
  verify: verifyGlobalToolUpdate,
};
