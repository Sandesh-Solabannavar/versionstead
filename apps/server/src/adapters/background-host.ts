import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decodeMonitoringProgress } from "@versionstead/contracts/monitoring";
import { readRuntime } from "../runtime.ts";
import { discoverGlobalToolSources } from "./inventory.ts";

export const COORDINATOR_LABEL = "dev.versionstead.coordinator";
export const SYSTEMD_UNIT = "versionstead.service";
export const hostActions = ["install", "start", "stop", "restart", "status", "uninstall"] as const;
export type HostAction = (typeof hostActions)[number];
const LAUNCHCTL = "/bin/launchctl";

/** A message for the owner's terminal; anything else is reported generically. */
export class HostError extends Error {}

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

/** Argument array, 30 s deadline, 256 KiB output; a non-zero exit is a result, not an error. */
export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 30_000, maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (error && typeof code !== "number") reject(new HostError(`${file} did not finish.`));
        else resolve({ code: typeof code === "number" ? code : 0, stdout, stderr });
      },
    );
  });

export type HostPaths = { node: string; workspace: string; dataDir: string };

/** The coordinator command both service managers run: the boot-task host with a pinned data directory. */
export function coordinatorArguments(paths: HostPaths) {
  return [
    paths.node,
    posix.join(paths.workspace, "apps", "server", "dist", "bin.js"),
    "--data-dir",
    paths.dataDir,
    "--port",
    "0",
    "--mode",
    "background",
    "--host",
    "boot-task",
    "--web-root",
    posix.join(paths.workspace, "apps", "web", "dist"),
  ];
}

/** True for C0 control characters and DEL, which no value in a service definition may hold. */
export const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

const xml = (value: string) => {
  if (hasControlCharacter(value))
    throw new HostError("LaunchAgent values cannot contain control characters.");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
};

/** A launchd property list (launchd.plist(5)): RunAtLoad, optional restart-on-failure, optional Aqua-only. */
export function launchAgentPlist(agent: {
  label: string;
  programArguments: readonly string[];
  workingDirectory?: string;
  keepAliveOnFailure?: boolean;
  aquaOnly?: boolean;
}) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${xml(agent.label)}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...agent.programArguments.map((argument) => `\t\t<string>${xml(argument)}</string>`),
    "\t</array>",
    ...(agent.workingDirectory
      ? ["\t<key>WorkingDirectory</key>", `\t<string>${xml(agent.workingDirectory)}</string>`]
      : []),
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    // A clean exit (Stop monitoring) stays stopped; a crash restarts.
    ...(agent.keepAliveOnFailure
      ? [
          "\t<key>KeepAlive</key>",
          "\t<dict>",
          "\t\t<key>SuccessfulExit</key>",
          "\t\t<false/>",
          "\t</dict>",
        ]
      : []),
    ...(agent.aquaOnly ? ["\t<key>LimitLoadToSessionType</key>", "\t<string>Aqua</string>"] : []),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function absolute(paths: HostPaths) {
  for (const value of [paths.node, paths.workspace, paths.dataDir])
    if (!posix.isAbsolute(value)) throw new HostError("Background host paths must be absolute.");
  return paths;
}

export const coordinatorAgent = (paths: HostPaths) =>
  launchAgentPlist({
    label: COORDINATOR_LABEL,
    programArguments: coordinatorArguments(absolute(paths)),
    workingDirectory: paths.workspace,
    keepAliveOnFailure: true,
  });

/** The data directory a LaunchAgent from coordinatorAgent pins, undoing exactly the entities xml() wrote. */
export function agentDataDir(plist: string) {
  const written = /<string>--data-dir<\/string>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  // &amp; last, so text that merely looks like an entity comes back as it was.
  return written === undefined
    ? null
    : written.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

// systemd expands % specifiers and $ variables in ExecStart, treats quotes and backslashes as syntax, and
// strips trailing whitespace from assignment values such as WorkingDirectory.
function unitPath(value: string) {
  if (!posix.isAbsolute(value) || /["'\\%$]|\s$/.test(value) || hasControlCharacter(value))
    throw new HostError(
      "systemd paths must be absolute, must not end in a space, and contain no quotes, backslashes, %, $ or control characters. Move the checkout or choose another data directory with --data-dir.",
    );
  return value;
}

/** A systemd user unit (systemd.service(5)); paths are quoted and characters systemd would expand are refused. */
export function systemdUnit(paths: HostPaths) {
  for (const value of [paths.node, paths.workspace, paths.dataDir]) unitPath(value);
  const command = coordinatorArguments(paths).map((part) =>
    part.startsWith("/") ? `"${part}"` : part,
  );
  return [
    "[Unit]",
    "Description=Versionstead monitoring coordinator",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${paths.workspace}`,
    `ExecStart=${command.join(" ")}`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The data directory a unit from systemdUnit pins. Paths hold no quotes, so it is the plain quoted word after --data-dir. */
export const unitDataDir = (unit: string) =>
  /^ExecStart="[^"]*" "[^"]*" --data-dir "([^"]*)" /m.exec(unit)?.[1] ?? null;

/** The service definition: the LaunchAgents folder, or the user-unit folder of the systemd manager. */
export function hostFile(platform: NodeJS.Platform, home: string, configHome?: string) {
  if (platform === "darwin")
    return posix.join(home, "Library", "LaunchAgents", `${COORDINATOR_LABEL}.plist`);
  const config =
    configHome && posix.isAbsolute(configHome) ? configHome : posix.join(home, ".config");
  return posix.join(config, "systemd", "user", SYSTEMD_UNIT);
}

/**
 * Who answers on a data directory: the background host, another coordinator (a desktop session that
 * started first, so the host lost the lock and stayed stopped), or nobody.
 */
export type Serving = "host" | "other" | "none";

/** The running coordinator, reached through its authenticated loopback API. */
export type CoordinatorControl = {
  stop(dataDir: string): Promise<void>;
  /** Waits up to `timeoutMs` for a coordinator to answer; another coordinator is reported at once. */
  ready(dataDir: string, timeoutMs: number): Promise<Serving>;
  captureSources(dataDir: string): Promise<boolean>;
};

const authorized = (
  runtime: { origin: string; token: string },
  path: string,
  init: RequestInit = {},
) =>
  fetch(`${runtime.origin}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

export const coordinatorControl: CoordinatorControl = {
  async stop(dataDir) {
    const runtime = await readRuntime(dataDir);
    if (!runtime) return;
    try {
      if (!(await authorized(runtime, "/api/status")).ok) return;
    } catch {
      return; // Nothing answers this descriptor, so nothing is running to stop.
    }
    const response = await authorized(runtime, "/api/shutdown", { method: "POST", body: "{}" });
    if (!response.ok) throw new HostError("The running coordinator refused to stop.");
    for (let attempt = 0; attempt < 150; attempt++) {
      await delay(200);
      if (!(await readRuntime(dataDir))) return;
    }
    throw new HostError("The running coordinator did not stop within 30 seconds.");
  },
  async ready(dataDir, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const runtime = await readRuntime(dataDir);
      if (runtime) {
        try {
          // Whichever coordinator answers owns the directory; only a boot-task host in background mode is ours.
          if ((await authorized(runtime, "/api/status")).ok)
            return runtime.host === "boot-task" && runtime.mode === "background" ? "host" : "other";
        } catch {
          // Not answering yet.
        }
      }
      if (Date.now() >= deadline) return "none";
      await delay(500);
    }
  },
  // The host runs as the owner, but in background mode it reads only saved npm/Bun locations; save the
  // owner's now, through the same validated route the desktop uses when it attaches.
  async captureSources(dataDir) {
    const runtime = await readRuntime(dataDir);
    if (!runtime) return false;
    try {
      // The coordinator rejects new sources while a PC scan runs or is queued. Wait it out, for about a
      // minute counting the requests, through the small progress read instead of the full snapshot.
      const deadline = Date.now() + 60_000;
      for (;;) {
        const { scanProgress } = decodeMonitoringProgress(
          await (await authorized(runtime, "/api/monitoring/progress")).json(),
        );
        if (
          scanProgress.active?.kind !== "pc" &&
          !scanProgress.queued.some((target) => target.kind === "pc")
        )
          break;
        if (Date.now() >= deadline) return false;
        await delay(500);
      }
      const sources = await discoverGlobalToolSources(AbortSignal.timeout(35_000));
      const response = await authorized(runtime, "/api/global-tools/sources", {
        method: "POST",
        body: JSON.stringify({ sources }),
      });
      return response.ok;
    } catch {
      return false;
    }
  },
};

export type HostContext = Omit<HostPaths, "dataDir"> & {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  user: string;
  linger: boolean;
  /**
   * What install pins. Every other action takes its data directory from the installed definition, and
   * is given this only when the owner passed --data-dir, which must then agree with the installed one.
   */
  dataDir?: string;
  run: CommandRunner;
  out: (line: string) => void;
  coordinator?: CoordinatorControl;
  /** Fixed tool locations; tests name them, real runs look in /usr/bin and /bin. */
  tools?: { launchctl?: string; systemctl?: string; loginctl?: string };
  /** How long macOS stop waits for launchd to report the job gone (default 5000); tests shorten it. */
  settleMs?: number;
};

async function firstExisting(candidates: readonly string[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed location; PATH is never searched.
    }
  }
  return null;
}

async function requireBuild(context: HostContext) {
  try {
    await access(context.node, constants.X_OK);
    await access(posix.join(context.workspace, "apps", "server", "dist", "bin.js"), constants.R_OK);
    await access(
      posix.join(context.workspace, "apps", "web", "dist", "index.html"),
      constants.R_OK,
    );
  } catch {
    throw new HostError(
      "Build Versionstead first with pnpm build, and run this script with Node.js 24.",
    );
  }
}

function installPaths(context: HostContext): HostPaths {
  if (context.dataDir === undefined) throw new HostError("Install needs a data directory.");
  return { node: context.node, workspace: context.workspace, dataDir: context.dataDir };
}

/** The installed definition: null when there is none, else the data directory it pins (null if it names none). */
async function installedHost(file: string, dataDirOf: (definition: string) => string | null) {
  let definition: string;
  try {
    definition = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new HostError("The background host definition could not be read. Run install again.");
  }
  const dataDir = dataDirOf(definition);
  return { dataDir: dataDir && posix.isAbsolute(dataDir) ? dataDir : null };
}
type Installed = NonNullable<Awaited<ReturnType<typeof installedHost>>>;

/** Every action but install works on the data directory the host was installed with; an explicit --data-dir must agree. */
function pinnedDataDir(installed: Installed, explicit: string | undefined) {
  if (!installed.dataDir)
    throw new HostError(
      "The installed background host does not name its data directory. Run install again.",
    );
  if (explicit !== undefined && posix.resolve(explicit) !== posix.resolve(installed.dataDir))
    throw new HostError(
      "The background host is installed for a different data directory. Run install with the data directory you want.",
    );
  return installed.dataDir;
}

/** Install stops the coordinator on the data directory it pins, and on the one it replaces. */
async function stopForInstall(
  control: CoordinatorControl,
  dataDir: string,
  replaced: Installed | null,
) {
  await control.stop(dataDir);
  if (replaced?.dataDir && replaced.dataDir !== dataDir) await control.stop(replaced.dataDir);
}

/** Asks the coordinator to stop. A failure is returned, not thrown: the service manager still gets its turn and decides whether it matters. */
const tryStop = (control: CoordinatorControl, dataDir: string): Promise<Error | null> =>
  control.stop(dataDir).then(
    () => null,
    (error: unknown) =>
      error instanceof Error
        ? error
        : new HostError("The running coordinator could not be stopped."),
  );

const handBack = "Run restart to hand monitoring to the background host.";

async function afterStart(
  context: HostContext,
  control: CoordinatorControl,
  dataDir: string,
  capture: boolean,
) {
  const serving = await control.ready(dataDir, 45_000);
  if (serving === "other")
    throw new HostError(
      `The desktop's own coordinator serves this data directory, so the background host stayed stopped. ${handBack}`,
    );
  if (serving !== "host")
    throw new HostError(
      "The background host did not become ready. Run status, and check that Node.js 24 and the built files are still in place.",
    );
  if (capture && !(await control.captureSources(dataDir)))
    context.out(
      "Owner npm/Bun locations were not saved yet. Open the Versionstead desktop app once, or run install again after the current PC scan.",
    );
}

async function readiness(context: HostContext, control: CoordinatorControl, dataDir: string) {
  const serving = await control.ready(dataDir, 0);
  context.out(
    `Coordinator: ${
      serving === "host"
        ? "ready (background host)"
        : serving === "other"
          ? `served by the desktop's own coordinator, so the background host stayed stopped. ${handBack}`
          : "not running as the background host"
    }`,
  );
}

async function launchd(action: HostAction, context: HostContext, control: CoordinatorControl) {
  const file = hostFile("darwin", context.home);
  const launchctlPath = context.tools?.launchctl ?? LAUNCHCTL;
  const domain = `gui/${context.uid}`;
  const service = `${domain}/${COORDINATOR_LABEL}`;
  const launchctl = (...args: string[]) => context.run(launchctlPath, args);
  const bootstrap = async () => {
    if ((await launchctl("bootstrap", domain, file)).code !== 0)
      throw new HostError(
        "launchctl could not load the LaunchAgent. Run this from Terminal in your logged-in Mac desktop session; an SSH session has no gui domain.",
      );
  };
  const state = async () => {
    const printed = await launchctl("print", service);
    return printed.code !== 0
      ? "not loaded"
      : /\bstate = running\b/.test(printed.stdout)
        ? "running"
        : "loaded, not running";
  };
  const status = async (isInstalled: boolean, dataDir: string | undefined) => {
    context.out(`LaunchAgent: ${isInstalled ? "installed" : "not installed"}`);
    context.out(`launchd: ${await state()}`);
    if (dataDir) await readiness(context, control, dataDir);
  };
  if (action === "install") {
    const paths = installPaths(context);
    await requireBuild(context);
    const contents = coordinatorAgent(paths);
    await stopForInstall(
      control,
      paths.dataDir,
      await installedHost(file, agentDataDir).catch(() => null),
    );
    await mkdir(posix.dirname(file), { recursive: true });
    await writeFile(file, contents, { mode: 0o644 });
    await launchctl("bootout", service); // Not loaded yet is fine.
    await bootstrap();
    await afterStart(context, control, paths.dataDir, true);
    context.out(
      "Versionstead LaunchAgent installed. It starts when you log in and stops when you log out.",
    );
    return;
  }
  const installed = await installedHost(file, agentDataDir);
  if (!installed) {
    if (action === "status") return status(false, context.dataDir);
    if (action !== "uninstall")
      throw new HostError("The LaunchAgent is not installed. Run install first.");
    // Best effort: a job can stay loaded after its file is gone.
    await launchctl("bootout", service).catch(() => null);
    context.out("The background host is not installed.");
    return;
  }
  const dataDir = pinnedDataDir(installed, context.dataDir);
  switch (action) {
    case "start":
    case "restart": {
      // kickstart -k below replaces a host that is hung and would not stop.
      if (action === "restart") await tryStop(control, dataDir);
      if ((await state()) === "not loaded") await bootstrap();
      else await launchctl("kickstart", ...(action === "restart" ? ["-k"] : []), service);
      await afterStart(context, control, dataDir, false);
      context.out("The LaunchAgent is running.");
      return;
    }
    case "stop": {
      const failure = await tryStop(control, dataDir);
      // The descriptor going away is not proof the job ended; ask launchd, giving it a moment to reap.
      const deadline = Date.now() + (context.settleMs ?? 5_000);
      let current = await state();
      while (current === "running" && Date.now() < deadline) {
        await delay(250);
        current = await state();
      }
      if (current === "running")
        throw new HostError(
          `${failure instanceof HostError ? `${failure.message} ` : ""}The LaunchAgent is still running. Run restart to replace it, or uninstall to remove it.`,
        );
      context.out("Stopped. The LaunchAgent stays installed and starts again at your next login.");
      return;
    }
    case "status":
      return status(true, dataDir);
    case "uninstall": {
      const failure = await tryStop(control, dataDir);
      await launchctl("bootout", service);
      if (failure && (await state()) === "running") throw failure;
      await rm(file, { force: true });
      context.out("LaunchAgent removed. Evidence in the data directory is kept.");
      return;
    }
  }
}

async function systemd(action: HostAction, context: HostContext, control: CoordinatorControl) {
  const systemctl =
    context.tools?.systemctl ?? (await firstExisting(["/usr/bin/systemctl", "/bin/systemctl"]));
  if (!systemctl)
    throw new HostError("systemctl is not installed; this system does not run systemd.");
  const user = (...args: string[]) => context.run(systemctl, ["--user", ...args]);
  const environment = await user("show-environment").catch(() => null);
  if (!environment || environment.code !== 0)
    throw new HostError(
      "systemd --user is unavailable in this session. Log in to a systemd-based desktop or SSH session (XDG_RUNTIME_DIR must be set), then retry.",
    );
  // The manager, not this shell, decides where user units live.
  const configHome = /^XDG_CONFIG_HOME=(.+)$/m.exec(environment.stdout)?.[1];
  // ponytail: an XDG_CONFIG_HOME that systemd prints in its $'...' quoting (it holds spaces or shell
  // characters) is refused; decode that quoting if owners hit this.
  if (configHome?.startsWith("$'"))
    throw new HostError(
      "The systemd user manager's XDG_CONFIG_HOME contains spaces or shell characters, which this script cannot read. Use a configuration folder without them, then retry.",
    );
  const file = hostFile("linux", context.home, configHome);
  const required = async (result: Promise<CommandResult>, message: string) => {
    if ((await result).code !== 0) throw new HostError(message);
  };
  const status = async (isInstalled: boolean, dataDir: string | undefined) => {
    context.out(`Unit file: ${isInstalled ? "installed" : "not installed"}`);
    context.out(`Enabled: ${(await user("is-enabled", SYSTEMD_UNIT)).stdout.trim() || "unknown"}`);
    context.out(`Active: ${(await user("is-active", SYSTEMD_UNIT)).stdout.trim() || "unknown"}`);
    await linger(context, false);
    if (dataDir) await readiness(context, control, dataDir);
  };
  if (action === "install") {
    const paths = installPaths(context);
    await requireBuild(context);
    const contents = systemdUnit(paths);
    await stopForInstall(
      control,
      paths.dataDir,
      await installedHost(file, unitDataDir).catch(() => null),
    );
    await mkdir(posix.dirname(file), { recursive: true });
    await writeFile(file, contents, { mode: 0o644 });
    await required(user("daemon-reload"), "systemd could not reload its user units.");
    await required(
      user("enable", "--now", SYSTEMD_UNIT),
      "systemd could not enable versionstead.service. Run: systemctl --user status versionstead.service",
    );
    await afterStart(context, control, paths.dataDir, true);
    await linger(context, true);
    context.out("Versionstead systemd user service installed.");
    return;
  }
  const installed = await installedHost(file, unitDataDir);
  if (!installed) {
    if (action === "status") return status(false, context.dataDir);
    if (action !== "uninstall")
      throw new HostError("The systemd user service is not installed. Run install first.");
    // Best effort: a unit can stay enabled after its file is gone.
    await user("disable", "--now", SYSTEMD_UNIT).catch(() => null);
    context.out("The background host is not installed.");
    return;
  }
  const dataDir = pinnedDataDir(installed, context.dataDir);
  switch (action) {
    case "start":
    case "restart": {
      // systemd restart replaces a host that is hung and would not stop, so a refusal to stop only matters if it fails too.
      const failure = action === "restart" ? await tryStop(control, dataDir) : null;
      if ((await user(action, SYSTEMD_UNIT)).code !== 0)
        throw (
          failure ??
          new HostError(
            `systemd could not ${action} versionstead.service. Run: systemctl --user status versionstead.service`,
          )
        );
      await afterStart(context, control, dataDir, false);
      context.out("The systemd user service is running.");
      return;
    }
    case "stop": {
      const failure = await tryStop(control, dataDir);
      if ((await user("stop", SYSTEMD_UNIT)).code !== 0 && failure) throw failure;
      context.out(
        "Stopped. The service stays enabled and starts again at your next login, or at boot with lingering.",
      );
      return;
    }
    case "status":
      return status(true, dataDir);
    case "uninstall": {
      const failure = await tryStop(control, dataDir);
      if ((await user("disable", "--now", SYSTEMD_UNIT)).code !== 0 && failure) throw failure;
      await rm(file, { force: true });
      await user("daemon-reload");
      await user("reset-failed", SYSTEMD_UNIT);
      context.out("systemd user service removed. Evidence in the data directory is kept.");
      return;
    }
  }
}

const keyringNote = "Keyring-backed connection credentials stay locked until you log in.";

async function linger(context: HostContext, install: boolean) {
  const loginctl =
    context.tools?.loginctl ?? (await firstExisting(["/usr/bin/loginctl", "/bin/loginctl"]));
  if (!loginctl) return;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/.test(context.user)) {
    context.out("Lingering was not checked: loginctl cannot be given this account name.");
    return;
  }
  if (install && context.linger) {
    const enabled = (await context.run(loginctl, ["enable-linger", context.user])).code === 0;
    context.out(
      enabled
        ? `Lingering enabled: monitoring runs before login and after logout. ${keyringNote}`
        : `loginctl could not enable lingering. Ask an administrator to run: loginctl enable-linger ${context.user}`,
    );
    return;
  }
  const shown = await context.run(loginctl, ["show-user", context.user, "--property=Linger"]);
  context.out(
    /^Linger=yes$/m.test(shown.stdout)
      ? `Lingering: on (runs before login and after logout). ${keyringNote}`
      : "Lingering: off. Monitoring stops when you log out. Run install again with --linger to monitor before login and after logout.",
  );
}

/** Installs or operates the macOS LaunchAgent or Linux systemd user service that hosts the coordinator. */
export async function runBackgroundHost(action: HostAction, context: HostContext) {
  if (context.platform !== "darwin" && context.platform !== "linux")
    throw new HostError(
      "This script manages macOS LaunchAgents and Linux systemd user services. On Windows use scripts/windows-background.ps1.",
    );
  if (context.uid === 0) throw new HostError("Run this script as your own user, not with sudo.");
  const control = context.coordinator ?? coordinatorControl;
  return context.platform === "darwin"
    ? launchd(action, context, control)
    : systemd(action, context, control);
}
