import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
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

// systemd expands % specifiers and $ variables in ExecStart and treats quotes and backslashes as syntax.
function unitPath(value: string) {
  if (!posix.isAbsolute(value) || /["'\\%$]/.test(value) || hasControlCharacter(value))
    throw new HostError(
      "systemd paths must be absolute and contain no quotes, backslashes, %, $ or control characters. Move the checkout or choose another data directory with --data-dir.",
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

/** The service definition: the LaunchAgents folder, or the user-unit folder of the systemd manager. */
export function hostFile(platform: NodeJS.Platform, home: string, configHome?: string) {
  if (platform === "darwin")
    return posix.join(home, "Library", "LaunchAgents", `${COORDINATOR_LABEL}.plist`);
  const config =
    configHome && posix.isAbsolute(configHome) ? configHome : posix.join(home, ".config");
  return posix.join(config, "systemd", "user", SYSTEMD_UNIT);
}

/** The running coordinator, reached through its authenticated loopback API. */
export type CoordinatorControl = {
  stop(dataDir: string): Promise<void>;
  ready(dataDir: string, timeoutMs: number): Promise<boolean>;
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
      if (runtime?.host === "boot-task" && runtime.mode === "background") {
        try {
          if ((await authorized(runtime, "/api/status")).ok) return true;
        } catch {
          // Not answering yet.
        }
      }
      if (Date.now() >= deadline) return false;
      await delay(500);
    }
  },
  // The host runs as the owner, but in background mode it reads only saved npm/Bun locations; save the
  // owner's now, through the same validated route the desktop uses when it attaches.
  async captureSources(dataDir) {
    const runtime = await readRuntime(dataDir);
    if (!runtime) return false;
    try {
      // The coordinator rejects new sources while a PC scan runs or is queued; wait it out through the
      // small progress read instead of the full snapshot.
      for (let attempt = 0; attempt < 120; attempt++) {
        const { scanProgress } = decodeMonitoringProgress(
          await (await authorized(runtime, "/api/monitoring/progress")).json(),
        );
        if (
          scanProgress.active?.kind !== "pc" &&
          !scanProgress.queued.some((target) => target.kind === "pc")
        )
          break;
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

export type HostContext = HostPaths & {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  user: string;
  linger: boolean;
  run: CommandRunner;
  out: (line: string) => void;
  coordinator?: CoordinatorControl;
  /** Fixed tool locations; tests name them, real runs look in /usr/bin and /bin. */
  tools?: { launchctl?: string; systemctl?: string; loginctl?: string };
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

async function afterStart(context: HostContext, control: CoordinatorControl, capture: boolean) {
  if (!(await control.ready(context.dataDir, 45_000)))
    throw new HostError(
      "The background host did not become ready. Run status, and check that Node.js 24 and the built files are still in place.",
    );
  if (capture && !(await control.captureSources(context.dataDir)))
    context.out(
      "Owner npm/Bun locations were not saved yet. Open the Versionstead desktop app once, or run install again after the current PC scan.",
    );
}

async function readiness(context: HostContext, control: CoordinatorControl) {
  context.out(
    `Coordinator: ${(await control.ready(context.dataDir, 0)) ? "ready (background host)" : "not running as the background host"}`,
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
  if (action !== "install" && action !== "status" && !existsSync(file))
    throw new HostError("The LaunchAgent is not installed. Run install first.");
  switch (action) {
    case "install": {
      await requireBuild(context);
      const contents = coordinatorAgent(context);
      await control.stop(context.dataDir);
      await mkdir(posix.dirname(file), { recursive: true });
      await writeFile(file, contents, { mode: 0o644 });
      await launchctl("bootout", service); // Not loaded yet is fine.
      await bootstrap();
      await afterStart(context, control, true);
      context.out(
        "Versionstead LaunchAgent installed. It starts when you log in and stops when you log out.",
      );
      return;
    }
    case "start":
    case "restart": {
      if (action === "restart") await control.stop(context.dataDir);
      if ((await launchctl("print", service)).code === 0) await launchctl("kickstart", service);
      else await bootstrap();
      await afterStart(context, control, false);
      context.out("The LaunchAgent is running.");
      return;
    }
    case "stop":
      await control.stop(context.dataDir);
      context.out("Stopped. The LaunchAgent stays installed and starts again at your next login.");
      return;
    case "status": {
      context.out(`LaunchAgent: ${existsSync(file) ? "installed" : "not installed"}`);
      const printed = await launchctl("print", service);
      context.out(
        `launchd: ${printed.code !== 0 ? "not loaded" : /\bstate = running\b/.test(printed.stdout) ? "running" : "loaded, not running"}`,
      );
      await readiness(context, control);
      return;
    }
    case "uninstall":
      await control.stop(context.dataDir);
      await launchctl("bootout", service);
      await rm(file, { force: true });
      context.out("LaunchAgent removed. Evidence in the data directory is kept.");
      return;
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
  const file = hostFile(
    "linux",
    context.home,
    /^XDG_CONFIG_HOME=(.+)$/m.exec(environment.stdout)?.[1],
  );
  const required = async (result: Promise<CommandResult>, message: string) => {
    if ((await result).code !== 0) throw new HostError(message);
  };
  if (action !== "install" && action !== "status" && !existsSync(file))
    throw new HostError("The systemd user service is not installed. Run install first.");
  switch (action) {
    case "install": {
      await requireBuild(context);
      const contents = systemdUnit(context);
      await control.stop(context.dataDir);
      await mkdir(posix.dirname(file), { recursive: true });
      await writeFile(file, contents, { mode: 0o644 });
      await required(user("daemon-reload"), "systemd could not reload its user units.");
      await required(
        user("enable", "--now", SYSTEMD_UNIT),
        "systemd could not enable versionstead.service. Run: systemctl --user status versionstead.service",
      );
      await afterStart(context, control, true);
      await linger(context, true);
      context.out("Versionstead systemd user service installed.");
      return;
    }
    case "start":
    case "restart": {
      if (action === "restart") await control.stop(context.dataDir);
      await required(
        user("start", SYSTEMD_UNIT),
        "systemd could not start versionstead.service. Run: systemctl --user status versionstead.service",
      );
      await afterStart(context, control, false);
      context.out("The systemd user service is running.");
      return;
    }
    case "stop":
      await control.stop(context.dataDir);
      await user("stop", SYSTEMD_UNIT);
      context.out(
        "Stopped. The service stays enabled and starts again at your next login, or at boot with lingering.",
      );
      return;
    case "status": {
      context.out(`Unit file: ${existsSync(file) ? "installed" : "not installed"}`);
      context.out(
        `Enabled: ${(await user("is-enabled", SYSTEMD_UNIT)).stdout.trim() || "unknown"}`,
      );
      context.out(`Active: ${(await user("is-active", SYSTEMD_UNIT)).stdout.trim() || "unknown"}`);
      await linger(context, false);
      await readiness(context, control);
      return;
    }
    case "uninstall":
      await control.stop(context.dataDir);
      await user("disable", "--now", SYSTEMD_UNIT);
      await rm(file, { force: true });
      await user("daemon-reload");
      await user("reset-failed", SYSTEMD_UNIT);
      context.out("systemd user service removed. Evidence in the data directory is kept.");
      return;
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
  const control = context.coordinator ?? coordinatorControl;
  if (context.platform === "darwin") return launchd(action, context, control);
  if (context.platform === "linux") return systemd(action, context, control);
  throw new HostError(
    "This script manages macOS LaunchAgents and Linux systemd user services. On Windows use scripts/windows-background.ps1.",
  );
}
