import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Project } from "@versionstead/contracts/monitoring";
import { InputError } from "./projects.ts";
import {
  firstExecutable,
  localPath,
  noAutoInstall,
  runBounded,
  toolDirectories,
  type ToolRunner,
} from "./tool-paths.ts";

const exec = promisify(execFile);
export type Tool = "git" | "gh" | "glab" | "tailscale" | "ssh";

const appleGit = "/usr/bin/git";
const appleTailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const developerTools = new WeakMap<ToolRunner, Promise<boolean>>();

/**
 * macOS ships /usr/bin/git as a stub that opens an "install the developer tools" dialog when it runs
 * without them, so that one path waits for xcode-select to report a developer directory.
 */
export async function usableTool(
  name: Tool,
  path: string,
  platform: NodeJS.Platform = process.platform,
  run: ToolRunner = runBounded,
) {
  if (platform !== "darwin" || name !== "git" || path !== appleGit) return true;
  // ponytail: asked once per process, so installing the tools needs a monitoring restart; expire the answer if that matters.
  let installed = developerTools.get(run);
  if (!installed) {
    installed = run("/usr/bin/xcode-select", ["-p"]).then(
      () => true,
      () => false,
    );
    developerTools.set(run, installed);
  }
  return installed;
}

type ToolOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  directories?: readonly string[];
  run?: ToolRunner;
};

/** Full paths to try in order: PATH and the shared fallbacks, then the locations only this tool uses. */
export function toolCandidates(name: Tool, options: ToolOptions = {}) {
  const { platform = process.platform, env = process.env } = options;
  const { directories = toolDirectories(env, platform) } = options;
  const windows = platform === "win32";
  const search = [...directories];
  if (windows) {
    const programs = env.ProgramFiles ?? "C:\\Program Files";
    search.push(
      join(programs, "Git", "cmd"),
      join(programs, "GitHub CLI"),
      join(programs, "Tailscale"),
      join(env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH"),
    );
  }
  // Directories are looked up on this host's file system, so this host decides what a local path is.
  const candidates = search
    .filter((directory) => localPath(directory))
    .map((directory) => join(directory, name + (windows ? ".exe" : "")));
  // The Tailscale app bundle ships its command-line client without adding it to PATH.
  if (platform === "darwin" && name === "tailscale") candidates.push(appleTailscale);
  return candidates;
}

export function toolExecutable(name: Tool, options: ToolOptions = {}) {
  const platform = options.platform ?? process.platform;
  return firstExecutable(toolCandidates(name, options), (path) =>
    usableTool(name, path, platform, options.run),
  );
}

// `truncate` lets a caller that only needs to know whether anything was printed accept output cut at the bound.
export async function runTool(
  name: Tool,
  args: string[],
  signal?: AbortSignal,
  cwd?: string,
  truncate = false,
) {
  const executable = await toolExecutable(name);
  if (!executable) throw new InputError(`${name} is not installed on this monitoring host.`);
  try {
    const result = await exec(executable, args, {
      cwd,
      signal,
      timeout: 8000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        ...noAutoInstall,
        NODE_OPTIONS: "",
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
        GIT_NAMESPACE: undefined,
        GIT_OPTIONAL_LOCKS: "0",
        GH_PROMPT_DISABLED: "1",
        GLAB_PROMPT_DISABLED: "1",
      },
    });
    return (name === "ssh" ? result.stderr : result.stdout).trim();
  } catch (error) {
    const { code, stdout } = error as { code?: unknown; stdout?: unknown };
    if (
      truncate &&
      code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
      typeof stdout === "string" &&
      stdout
    )
      return stdout.trim();
    throw new InputError(`${name} could not complete the read-only check.`);
  }
}

export async function discoverTools(gitEnabled = true, run: typeof runTool = runTool) {
  const statuses = await Promise.all(
    (["git", "gh", "glab", "tailscale", "ssh"] as const).map(async (name) => {
      // Located, not run: Git can open a macOS dialog, and the Git context switch needs to see it installed.
      if (name === "git" && !gitEnabled)
        return { available: (await toolExecutable("git")) !== null, version: null };
      try {
        const version =
          (
            await run(
              name,
              name === "tailscale" ? ["version"] : name === "ssh" ? ["-V"] : ["--version"],
            )
          )
            .split(/\r?\n/)[0]
            ?.slice(0, 200) ?? null;
        return { available: true, version };
      } catch {
        return { available: false, version: null };
      }
    }),
  );
  return {
    git: statuses[0]!,
    github: statuses[1]!,
    gitlab: statuses[2]!,
    tailscale: statuses[3]!,
    ssh: statuses[4]!,
  };
}

export async function inspectGit(path: string, signal?: AbortSignal): Promise<Project["git"]> {
  const args = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "--no-optional-locks",
    "-C",
    path,
  ];
  try {
    const commit = await runTool("git", [...args, "rev-parse", "--verify", "HEAD"], signal);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return undefined;
    const branch = await runTool(
      "git",
      [...args, "symbolic-ref", "--quiet", "--short", "HEAD"],
      signal,
    ).catch(() => null);
    // Status can otherwise invoke clean/process filters from repository attributes.
    const filters = await runTool("git", [...args, "config", "--null", "--list"], signal);
    const disabledFilters = filters
      .split("\0")
      .filter((record) => record.startsWith("filter."))
      .flatMap((record) => {
        const key = record.split("\n")[0]!;
        if (/^filter\..+\.smudge$/.test(key)) return [];
        if (
          !/^filter\..+\.(clean|process|required)$/.test(key) ||
          Array.from(key).some((char) => char.charCodeAt(0) < 32)
        )
          throw new InputError("Unsupported Git filter configuration.");
        return ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`];
      });
    // More status lines than the output bound can only mean a dirty tree, so a truncated prefix suffices.
    const dirty =
      (await runTool(
        "git",
        [
          ...args,
          ...disabledFilters,
          "status",
          "--porcelain",
          "--untracked-files=no",
          "--ignore-submodules=all",
        ],
        signal,
        undefined,
        true,
      )) !== "";
    return { commit, branch: branch?.slice(0, 200) ?? null, dirty };
  } catch {
    return undefined;
  }
}
