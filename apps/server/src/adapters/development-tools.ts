import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Project } from "@versionstead/contracts/monitoring";
import { InputError } from "./projects.ts";

const exec = promisify(execFile);
export type Tool = "git" | "gh" | "glab" | "tailscale" | "ssh";
export async function toolExecutable(name: Tool) {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  if (process.platform === "win32") {
    const programs = process.env.ProgramFiles ?? "C:\\Program Files";
    directories.push(
      join(programs, "Git", "cmd"),
      join(programs, "GitHub CLI"),
      join(programs, "Tailscale"),
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH"),
    );
  }
  for (const directory of directories) {
    try {
      const path = await realpath(
        join(directory, name + (process.platform === "win32" ? ".exe" : "")),
      );
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next explicit PATH directory. */
    }
  }
  return null;
}

export async function runTool(name: Tool, args: string[], signal?: AbortSignal, cwd?: string) {
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
  } catch {
    throw new InputError(`${name} could not complete the read-only check.`);
  }
}

export async function discoverTools() {
  const statuses = await Promise.all(
    (["git", "gh", "glab", "tailscale", "ssh"] as const).map(async (name) => {
      try {
        const version =
          (
            await runTool(
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
      )) !== "";
    return { commit, branch: branch?.slice(0, 200) ?? null, dirty };
  } catch {
    return undefined;
  }
}
