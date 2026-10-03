import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import semver from "semver";
import type { GlobalToolSource, Installation } from "@versionstead/contracts/monitoring";
import {
  discoverGlobalToolSources,
  npmGlobalCommand,
  readGlobalInstallation,
} from "./inventory.ts";
import { object, readSelectedFile, string, InputError, packageName } from "./projects.ts";
import { toolDirectories, toolExecutable } from "./tool-paths.ts";

export type GlobalToolUpdatePlan = {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  command: string;
  source: GlobalToolSource;
};

async function readTarget(source: GlobalToolSource, name: string) {
  let requested: string | null = null;
  if (source.manager === "bun" && source.root) {
    const text = await readSelectedFile(dirname(source.root), "package.json", 1024 * 1024);
    if (text === null)
      throw new InputError("The Bun global dependency manifest is missing. Scan this PC again.");
    const manifest = object(JSON.parse(text));
    requested = string(object(manifest.dependencies ?? {})[name]);
    if (requested === null)
      throw new InputError("This package is no longer declared in the Bun global manifest.");
  }
  return readGlobalInstallation(source, name, requested);
}

function updateSpec(item: Installation) {
  if (
    !packageName(item.name) ||
    !item.packageId ||
    !packageName(item.packageId) ||
    !item.availableVersion ||
    !semver.valid(item.availableVersion) ||
    semver.prerelease(item.availableVersion) ||
    !semver.valid(item.version) ||
    semver.prerelease(item.version) ||
    !semver.gt(item.availableVersion, item.version) ||
    item.origin !== "registry" ||
    item.updateStatus !== "available"
  )
    throw new InputError("This package has no supported stable update. Scan this PC again.");
  return item.name === item.packageId
    ? `${item.packageId}@${item.availableVersion}`
    : `${item.name}@npm:${item.packageId}@${item.availableVersion}`;
}

/** These functions are imported only by the owner-session desktop runner, never by scans/HTTP. */
export async function resolveGlobalToolUpdate(
  item: Installation,
  signal?: AbortSignal,
  options: {
    discover?: typeof discoverGlobalToolSources;
    npm?: typeof npmGlobalCommand;
    executable?: typeof toolExecutable;
  } = {},
): Promise<GlobalToolUpdatePlan> {
  const spec = updateSpec(item);
  const sources = await (options.discover ?? discoverGlobalToolSources)(signal);
  const source = sources.find((s) => s.manager === item.manager);
  if (!source || source.status !== "detected" || !source.root || source.registry !== "public")
    throw new InputError("The owning package manager is unavailable. Scan this PC again.");
  const fresh = await readTarget(source, item.name);
  if (
    fresh.id !== item.id ||
    fresh.rootId !== item.rootId ||
    fresh.version !== item.version ||
    fresh.packageId !== item.packageId ||
    fresh.origin !== "registry"
  )
    throw new InputError("This installation or its source changed. Scan this PC before updating.");
  const cwd = await realpath(source.manager === "bun" ? dirname(source.root) : tmpdir());
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"].includes(key.toUpperCase()),
    ),
  );
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = toolDirectories().join(delimiter);
  let executable: string;
  let args: string[];
  if (source.manager === "npm") {
    const npm = await (options.npm ?? npmGlobalCommand)();
    if (!npm || npm.version !== source.version)
      throw new InputError("npm changed during update preparation. Retry after scanning.");
    const prefix =
      process.platform === "win32" ? dirname(source.root) : dirname(dirname(source.root));
    if (process.platform !== "win32" && dirname(source.root) !== join(prefix, "lib"))
      throw new InputError("This npm global prefix cannot be verified.");
    args = [
      npm.cli,
      "install",
      "--global",
      "--prefix",
      prefix,
      "--registry=https://registry.npmjs.org/",
      "--no-audit",
      "--no-fund",
      "--fetch-retries=0",
      "--fetch-timeout=20000",
    ];
    // Preserve package-manager lifecycle behavior, including npm 12's per-package approval.
    if (semver.major(npm.version) >= 12) args.push(`--allow-scripts=${item.packageId}`);
    args.push(spec);
    executable = npm.executable;
  } else {
    const bun = await (options.executable ?? toolExecutable)(
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    if (!bun) throw new InputError("Bun is no longer available. Scan this PC again.");
    executable = bun;
    args = ["add", "--global", "--exact", "--no-progress", spec];
    env.BUN_INSTALL_GLOBAL_DIR = dirname(source.root);
  }
  const quote = (word: string) =>
    process.platform === "win32"
      ? `'${word.replace(/['\u2018\u2019]/g, "$&$&")}'`
      : `'${word.replaceAll("'", "'\\''")}'`;
  const environment =
    source.manager === "bun"
      ? process.platform === "win32"
        ? `$env:BUN_INSTALL_GLOBAL_DIR=${quote(dirname(source.root))}; `
        : `BUN_INSTALL_GLOBAL_DIR=${quote(dirname(source.root))} `
      : "";
  const command = `${environment}${process.platform === "win32" ? "& " : ""}${[executable, ...args].map(quote).join(" ")}`;
  return { executable, args, cwd, env, command, source };
}

export async function verifyGlobalToolUpdate(plan: GlobalToolUpdatePlan, item: Installation) {
  const fresh = await readTarget(plan.source, item.name);
  if (
    fresh.packageId !== item.packageId ||
    fresh.rootId !== item.rootId ||
    fresh.origin !== "registry" ||
    fresh.version !== item.availableVersion
  )
    throw new InputError(
      "The command finished, but the requested installed version could not be verified. Scan this PC and retry.",
    );
}

/** Bounded, cancellable process tree; raw package-manager output is never logged or persisted. */
export async function executeGlobalToolUpdate(
  plan: GlobalToolUpdatePlan,
  signal: AbortSignal,
  timeoutMs = 5 * 60_000,
) {
  if (signal.aborted) throw new InputError("The update was stopped. Scan this PC before retrying.");
  if (!isAbsolute(plan.executable) || !(await stat(plan.executable)).isFile())
    throw new InputError("The package manager is unavailable.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: string | null = null;
    let bytes = 0;
    let permission = false;
    let stopping = false;
    const stop = (message: string) => {
      if (stopping) return;
      stopping = true;
      failure = message;
      if (
        process.platform === "win32" &&
        child.pid &&
        process.env.SystemRoot &&
        isAbsolute(process.env.SystemRoot)
      ) {
        const killer = spawn(
          join(process.env.SystemRoot, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore", shell: false, timeout: 5000 },
        );
        killer.once("error", () => child.kill());
        killer.once("close", () => child.kill());
      } else {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill();
        } catch {
          child.kill();
        }
      }
    };
    const abort = () => stop("The update was stopped. Scan this PC before retrying.");
    const timer = setTimeout(
      () => stop("The update exceeded five minutes. Scan this PC before retrying."),
      timeoutMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const output = (chunk: Buffer) => {
      bytes += chunk.length;
      if (/\b(?:EACCES|EPERM|permission denied|access is denied)\b/i.test(chunk.toString()))
        permission = true;
      if (bytes > 1024 * 1024)
        stop("The update exceeded its output limit. Scan this PC before retrying.");
    };
    child.stdout!.on("data", output);
    child.stderr!.on("data", output);
    child.once("error", () => {
      failure = "The package manager could not start.";
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure || code !== 0)
        reject(
          new InputError(
            failure ??
              (permission
                ? "The global location is not writable. Update this package in an authorized terminal, then scan this PC."
                : `The package manager exited with code ${code ?? "unknown"}. Check network access and scan this PC before retrying.`),
          ),
        );
      else resolve();
    });
  });
}
