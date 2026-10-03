import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { Project } from "@versionstead/contracts/monitoring";
import { validateProjectChanges, type ActionRun } from "@versionstead/contracts/project-settings";

type Running = {
  state: { -readonly [K in keyof ActionRun]: ActionRun[K] };
  child: ChildProcess;
  done: Promise<void>;
  stop: (reason: string) => Promise<void>;
};

/** Owner-triggered desktop commands. Never imported by the monitoring coordinator. */
export class ProjectActionRunner {
  private runs = new Map<string, Running>();
  private starting = new Set<string>();
  private closing = false;
  private readonly timeoutMs: number;
  constructor(timeoutMs = 10 * 60 * 1000) {
    this.timeoutMs = timeoutMs;
  }
  get active() {
    return (
      this.starting.size > 0 ||
      [...this.runs.values()].some((run) => run.state.status === "running")
    );
  }

  async start(project: Project, actionId: string): Promise<ActionRun> {
    if (this.closing) throw new Error("The desktop is shutting down.");
    if (process.platform !== "win32")
      throw new Error("Custom command execution currently requires Windows desktop.");
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
      const systemRoot = process.env.SystemRoot;
      if (this.closing) throw new Error("The desktop is shutting down.");
      if (!systemRoot || !isAbsolute(systemRoot))
        throw new Error("Windows command execution is unavailable.");
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
      const script =
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [Console]::OutputEncoding\n" +
        action.command +
        "\nif (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";
      const child = spawn(
        join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          cwd: path,
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].includes(key.toUpperCase()),
            ),
          ),
        },
      );
      let stopped: Promise<void> | undefined;
      let finished = false;
      let bytes = 0;
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const stop = (reason: string): Promise<void> => {
        if (stopped) return stopped;
        if (finished) return Promise.resolve();
        state.error = reason;
        stopped = (async () => {
          if (child.pid)
            await new Promise<void>((resolve) => {
              const killer = spawn(
                join(systemRoot, "System32", "taskkill.exe"),
                ["/PID", String(child.pid), "/T", "/F"],
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
          else child.kill();
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
  async reconcile(projects: readonly Project[]) {
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
