import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * mise's switches for installing a missing tool, all off (https://mise.jdx.dev/configuration/settings.html):
 * not_found_auto_install "also runs in shims", and auto_install and exec_auto_install cover `mise x` and
 * the not-found handler. Every command that Versionstead runs by the name it found gets them, so a mise
 * shim whose configured version is missing falls back or fails instead of installing it.
 */
export const noAutoInstall = {
  MISE_AUTO_INSTALL: "false",
  MISE_EXEC_AUTO_INSTALL: "false",
  MISE_NOT_FOUND_AUTO_INSTALL: "false",
} as const;

/** Runs a file with arguments and resolves its stdout. Any failure, including a non-zero exit, rejects. */
export type ToolRunner = (file: string, args: string[]) => Promise<string>;
// Shell-free, bounded probes (`node -e`, `bun -e`, xcode-select). Each runs in a fresh empty directory: outside
// any selected project, and with no bunfig.toml or .env for Bun to load from a directory shared in tmpdir().
export const runBounded: ToolRunner = async (file, args) => {
  const cwd = await mkdtemp(join(tmpdir(), "versionstead-probe-"));
  try {
    const { stdout } = await exec(file, args, {
      cwd,
      env: { ...process.env, ...noAutoInstall, NODE_OPTIONS: "", BUN_OPTIONS: "" },
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true,
      encoding: "utf8",
    });
    return stdout;
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
};

/** An absolute local path: a drive letter on Windows, never a network share or a rooted path without a drive. */
export const localPath = (path: string, platform: NodeJS.Platform = process.platform) =>
  (platform === "win32" ? win32 : posix).isAbsolute(path) &&
  !/^[\\/]{2}/.test(path) &&
  (platform !== "win32" || /^[a-z]:[\\/]/i.test(path));

/**
 * Absolute directories to search for tools: the inherited PATH first, then the usual install and
 * version-manager locations. A Finder or Dock launch on macOS inherits only /usr/bin:/bin:/usr/sbin:/sbin.
 */
export function toolDirectories(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
) {
  const paths = platform === "win32" ? win32 : posix;
  const inherited = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const directories = inherited.split(paths.delimiter);
  const add = (base: string | undefined, ...parts: string[]) => {
    if (base && paths.isAbsolute(base)) directories.push(paths.join(base, ...parts));
  };
  if (platform === "win32") {
    add(env.APPDATA, "npm");
    add(env.LOCALAPPDATA, "Programs", "nodejs");
    add(env.LOCALAPPDATA, "Volta", "bin");
    add(env.LOCALAPPDATA, "pnpm");
    add(env.USERPROFILE, ".local", "bin");
    add(env.USERPROFILE, ".bun", "bin");
    add(env.USERPROFILE, "scoop", "shims");
    add(env.BUN_INSTALL, "bin");
    add(env.VOLTA_HOME, "bin");
    add(env.PNPM_HOME);
    add(env.ProgramFiles, "nodejs");
  } else {
    const mac = platform === "darwin";
    if (mac) directories.push("/opt/homebrew/bin");
    directories.push("/usr/local/bin");
    add(env.BUN_INSTALL || paths.join(home, ".bun"), "bin");
    add(env.VOLTA_HOME || paths.join(home, ".volta"), "bin");
    add(
      env.PNPM_HOME ||
        paths.join(home, ...(mac ? ["Library", "pnpm"] : [".local", "share", "pnpm"])),
    );
    add(home, ".local", "bin");
    add(home, ".local", "share", "mise", "shims");
    add(home, ".asdf", "shims");
    directories.push("/usr/bin", "/bin");
    if (!mac) directories.push("/snap/bin");
  }
  const seen = new Set<string>();
  return directories
    .map((p) => p.trim().replace(/^"(.*)"$/, "$1"))
    .filter((p) => {
      const key = platform === "win32" ? p.toLowerCase() : p;
      if (!localPath(p, platform) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The first executable file among absolute local candidates that `accept` allows. */
export async function firstExecutable(
  candidates: readonly string[],
  accept: (candidate: string) => Promise<boolean> = async () => true,
) {
  for (const candidate of candidates) {
    // Never the current directory or a network share, whoever built the list.
    if (!localPath(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile() || !(await accept(candidate))) continue;
      // Volta, mise and snap shims are multi-call binaries that dispatch on the name they are run by, so
      // POSIX keeps the discovered name. Windows keeps its canonical file.
      return process.platform === "win32" ? await realpath(candidate) : candidate;
    } catch {
      // Only explicit local directories; never resolve through a shell or the current directory.
    }
  }
  return null;
}

export const toolExecutable = (name: string, directories: readonly string[] = toolDirectories()) =>
  firstExecutable(directories.map((directory) => join(directory, name)));

/** This process as a Node runtime, unless it is Electron, whose binary cannot run a package manager's script. */
export const ownNode = () => (process.versions.electron ? null : process.execPath);

/**
 * Runs a candidate runtime and returns what the running process reports about itself. Shims and symlinks
 * dispatch on their own name, so the real path comes from the process, never from resolving the candidate.
 */
async function inspect(
  candidate: string,
  runtime: "node" | "bun",
  before: string,
  run: ToolRunner,
) {
  if (!localPath(candidate)) return null;
  try {
    const script = `${before}process.stdout.write(JSON.stringify({version:process.versions.${runtime},execPath:process.execPath}))`;
    const report: { version?: unknown; execPath?: unknown } = JSON.parse(
      await run(candidate, ["-e", script]),
    );
    const { version, execPath } = report;
    return typeof version === "string" &&
      /^\d+\.\d+\.\d+/.test(version) &&
      typeof execPath === "string" &&
      localPath(execPath)
      ? { version, execPath }
      : null;
  } catch {
    return null;
  }
}

export const inspectNode = (
  candidate: string,
  { sqlite = false, run = runBounded }: { sqlite?: boolean; run?: ToolRunner } = {},
) => inspect(candidate, "node", sqlite ? "require('node:sqlite');" : "", run);

/**
 * mise and asdf shims pick a Bun from the directory they run in, so it is asked once, from an empty one
 * where no project pins apply, with mise's auto-install switched off (runBounded passes noAutoInstall).
 * inspectNode runs the same way.
 */
// ponytail: mise still installs a tool that its owner declared `lazy = true` the first time the tool runs,
// whatever noAutoInstall says, and other version managers get no switch; resolve the real binary without
// running the shim if those matter.
export const inspectBun = (candidate: string, { run = runBounded }: { run?: ToolRunner } = {}) =>
  inspect(candidate, "bun", "", run);
