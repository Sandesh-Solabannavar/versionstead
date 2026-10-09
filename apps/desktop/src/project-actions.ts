import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { Project } from "@versionstead/contracts/monitoring";
import { validateProjectChanges, type ActionRun } from "@versionstead/contracts/project-settings";
import { toolDirectories } from "../../server/dist/adapters/tool-paths.js";

type Running = {
  state: { -readonly [K in keyof ActionRun]: ActionRun[K] };
  child: ChildProcess;
  done: Promise<void>;
  stop: (reason: string) => Promise<void>;
};

/** The owner's login shell: $SHELL when it is an absolute path listed in /etc/shells, else /bin/sh. */
export async function loginShell(env: NodeJS.ProcessEnv = process.env, shells = "/etc/shells") {
  const shell = env.SHELL;
  // csh and tcsh accept -l only as their sole option, so they cannot run `-l -c <command>`.
  if (shell && isAbsolute(shell) && !/^t?csh$/.test(basename(shell))) {
    try {
      const listed = (await readFile(shells, "utf8")).split("\n").map((line) => line.trim());
      if (listed.includes(shell)) {
        await access(shell, constants.X_OK);
        return shell;
      }
    } catch {
      // An unreadable list or a missing shell falls back to /bin/sh.
    }
  }
  return "/bin/sh";
}

/** What the command dialog names as the program that runs owner commands. */
export async function projectActionShell(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? "Windows PowerShell" : loginShell();
}

/**
 * The inherited environment without Node/Electron overrides. On macOS and Linux PATH also gains the
 * tool directories that a Finder, Dock or desktop-menu launch lacks; the login shell starts from that
 * PATH, and the owner's profile has the last word on it.
 */
// ponytail: a login profile that resets PATH (Debian /etc/profile) drops these directories; resolve
// the owner's shell environment ($SHELL -ilc env) if owners report missing tools.
export function actionEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const result = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].includes(key.toUpperCase()),
    ),
  );
  if (platform !== "win32") result.PATH = toolDirectories(result, platform).join(":");
  return result;
}

/** Owner-triggered desktop commands. Never imported by the monitoring coordinator. */
export class ProjectActionRunner {
  private runs = new Map<string, Running>();
  private starting = new Set<string>();
  private closing = false;
  private readonly timeoutMs: number;
  private readonly graceMs: number;
  constructor(timeoutMs = 10 * 60 * 1000, graceMs = 5_000) {
    this.timeoutMs = timeoutMs;
    this.graceMs = graceMs;
  }
  get active() {
    return (
      this.starting.size > 0 ||
      [...this.runs.values()].some((run) => run.state.status === "running")
    );
  }

  async start(project: Project, actionId: string): Promise<ActionRun> {
    if (this.closing) throw new Error("The desktop is shutting down.");
    if (project.repository) throw new Error("Actions require a local project checkout.");
    const action = validateProjectChanges({ actions: project.actions ?? [] }).actions!.find(
      (a) => a.id === actionId,
    );
    if (!action) throw new Error("This action no longer exists. Refresh the project.");
    if (
      this.starting.has(project.id) ||
      [...this.runs.values()].some(
        (run) => run.state.projectId === project.id && run.state.status === "running",
      )
    )
      throw new Error("Stop the running action before starting another in this project.");
    if (
      this.active &&
      [...this.runs.values()].filter((run) => run.state.status === "running").length +
        this.starting.size >=
        4
    )
      throw new Error("At most four project commands can run at once.");
    this.starting.add(project.id);
    try {
      if (
        !isAbsolute(project.path) ||
        project.path.startsWith("\\\\") ||
        project.path.startsWith("//")
      )
        throw new Error("Actions require a local directory.");
      const path = await realpath(project.path);
      if (
        path.startsWith("\\\\") ||
        path.startsWith("//") ||
        normalize(path).toLowerCase() !== normalize(project.path).toLowerCase() ||
        !(await stat(path)).isDirectory()
      )
        throw new Error(
          "The selected project directory changed. Select it again before running commands.",
        );
      const windows = process.platform === "win32";
      const systemRoot = process.env.SystemRoot;
      if (windows && (!systemRoot || !isAbsolute(systemRoot)))
        throw new Error("Windows command execution is unavailable.");
      const shell = windows ? null : await loginShell();
      if (this.closing) throw new Error("The desktop is shutting down.");
      const id = randomUUID();
      const state: Running["state"] = {
        id,
        projectId: project.id,
        actionId,
        command: action.command,
        status: "running",
        output: "",
        exitCode: null,
        error: null,
      };
      // The command is explicitly authored by the owner, not derived from repository metadata.
      const child =
        shell === null
          ? spawn(
              join(systemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
              [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(
                  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [Console]::OutputEncoding\n" +
                    action.command +
                    "\nif (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
                  "utf16le",
                ).toString("base64"),
              ],
              {
                cwd: path,
                windowsHide: true,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                env: actionEnvironment(),
              },
            )
          : // A process group of its own, so Stop reaches everything the shell starts.
            spawn(shell, ["-l", "-c", action.command], {
              cwd: path,
              detached: true,
              shell: false,
              stdio: ["ignore", "pipe", "pipe"],
              env: actionEnvironment(),
            });
      const pid = child.pid;
      let stopped: Promise<void> | undefined;
      let finished = false;
      let bytes = 0;
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const signalGroup = (signal: NodeJS.Signals) => {
        try {
          process.kill(-pid!, signal);
        } catch {
          // The group has already exited.
        }
      };
      const stop = (reason: string): Promise<void> => {
        if (stopped) return stopped;
        if (finished) return Promise.resolve();
        state.error = reason;
        stopped = (async () => {
          if (!pid) child.kill();
          else if (shell === null)
            await new Promise<void>((resolve) => {
              const killer = spawn(
                join(systemRoot!, "System32", "taskkill.exe"),
                ["/PID", String(pid), "/T", "/F"],
                { windowsHide: true, stdio: "ignore", shell: false, timeout: 5000 },
              );
              killer.once("error", () => {
                child.kill();
                resolve();
              });
              killer.once("close", () => {
                child.kill();
                resolve();
              });
            });
          else {
            // SIGTERM first, SIGKILL after the grace period, like taskkill /T. A detached grandchild
            // can keep the output pipes open after the group is gone, so stop waiting for them too.
            signalGroup("SIGTERM");
            const kill = setTimeout(() => signalGroup("SIGKILL"), this.graceMs);
            const release = setTimeout(() => {
              child.stdout?.destroy();
              child.stderr?.destroy();
            }, this.graceMs * 2);
            await done;
            clearTimeout(kill);
            clearTimeout(release);
            return;
          }
          await done;
        })();
        return stopped;
      };
      const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
      const output = (chunk: Buffer, decoder: StringDecoder) => {
        bytes += chunk.length;
        if (bytes > 65536) {
          void stop("Output exceeded 64 KiB; the command was stopped.");
          return;
        }
        state.output += decoder.write(chunk);
      };
      child.stdout!.on("data", (chunk: Buffer) => output(chunk, decoders[0]!));
      child.stderr!.on("data", (chunk: Buffer) => output(chunk, decoders[1]!));
      const timer = setTimeout(() => {
        void stop("The command exceeded its ten-minute runtime limit.");
      }, this.timeoutMs);
      child.once("error", () => {
        state.status = "failed";
        state.error = "The command shell could not start.";
      });
      child.once("close", (code) => {
        finished = true;
        clearTimeout(timer);
        state.output += decoders.map((d) => d.end()).join("");
        state.exitCode = code;
        if (state.status === "running")
          state.status = stopped ? "stopped" : code === 0 ? "completed" : "failed";
        resolveDone();
      });
      for (const [oldId, run] of this.runs)
        if (run.state.status !== "running" && this.runs.size >= 20) this.runs.delete(oldId);
      this.runs.set(id, { state, child, done, stop });
      return { ...state };
    } catch {
      throw new Error("The action could not start. Verify the local directory and saved command.");
    } finally {
      this.starting.delete(project.id);
    }
  }
  read(id: string): ActionRun {
    const run = this.runs.get(id);
    if (!run) throw new Error("This command result is no longer available.");
    return { ...run.state };
  }
  latest(projectId: string, actionId: string): ActionRun | null {
    const run = [...this.runs.values()].findLast(
      (r) => r.state.projectId === projectId && r.state.actionId === actionId,
    );
    return run ? { ...run.state } : null;
  }
  async stop(id: string): Promise<ActionRun> {
    const run = this.runs.get(id);
    if (!run) throw new Error("This command result is no longer available.");
    await run.stop("Stopped by the owner.");
    return this.read(id);
  }
  async close() {
    this.closing = true;
    while (this.starting.size) await delay(20);
    await Promise.all(
      [...this.runs.values()]
        .filter((run) => run.state.status === "running")
        .map((run) => run.stop("Versionstead UI is quitting.")),
    );
  }
  async stopProject(projectId: string) {
    await Promise.all(
      [...this.runs.values()]
        .filter((run) => run.state.projectId === projectId && run.state.status === "running")
        .map((run) => run.stop("The project is being removed.")),
    );
  }
  async reconcile(projects: readonly Pick<Project, "id" | "actions">[]) {
    const actions = new Map(
      projects.map((project) => [
        project.id,
        new Set((project.actions ?? []).map((action) => action.id)),
      ]),
    );
    await Promise.all(
      [...this.runs.values()]
        .filter(
          (run) =>
            !actions.get(run.state.projectId)?.has(run.state.actionId) &&
            run.state.status === "running",
        )
        .map((run) => run.stop("This project or saved action was removed from monitoring.")),
    );
  }
}
