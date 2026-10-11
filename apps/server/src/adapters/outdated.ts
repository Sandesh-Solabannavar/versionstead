import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import semver from "semver";
import type { Dependency, Project } from "@versionstead/contracts/monitoring";
import { object, packageName, readSelectedFile, selectDirectory, string } from "./projects.ts";
import { inspectBun, localPath, noAutoInstall, ownNode, toolDirectories } from "./tool-paths.ts";

type Manager = Exclude<Project["packageManager"], "unknown">;
export type NativeVersions = {
  checked: Map<string, { compatible: string | null; latest: string; source: string }>;
  coverage: string[];
};
export type OutdatedCommand = {
  executable: string;
  prefix: string[];
  version: string;
};
export type CommandResult = { code: number; stdout: string; stderr: string };
export type OutdatedRunner = (
  command: OutdatedCommand,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<CommandResult>;

const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};

// Resolve installed managers directly. Shell wrappers, Corepack downloads, and repository binaries
// must not become an implicit code-execution/install path during a scheduled scan. Nor may a
// version-manager shim (mise, asdf, Volta), which reads the directory it runs in and may install what
// that pins: npm and pnpm run as `<node> <script>`, and Bun only as the real executable it reports.
export async function outdatedExecutable(
  manager: Manager,
  root: string,
  directories: readonly string[] = toolDirectories(),
  node: string | null = ownNode(),
): Promise<OutdatedCommand | null> {
  for (const directory of directories) {
    // Never the current directory or a network share, whoever built the list.
    if (!localPath(directory)) continue;
    try {
      const canonical = await realpath(directory);
      if (inside(root, canonical) || canonical.split(/[\\/]/).includes("node_modules")) continue;
      if (manager === "bun") {
        const file = join(canonical, process.platform === "win32" ? "bun.exe" : "bun");
        // The real file decides whether it belongs to the project, but a POSIX version-manager shim
        // dispatches on the name it is run by, so only Windows asks the resolved file.
        const real = await realpath(file);
        await access(real, constants.X_OK);
        if (inside(root, real) || !(await stat(real)).isFile()) continue;
        // Shims read the directory they run in, honor what it pins, and may install it. Ask the candidate
        // once, from an empty directory, which Bun it resolves to; only that executable runs in a project.
        const bun = await inspectBun(process.platform === "win32" ? real : file);
        if (!bun || !semver.valid(bun.version)) continue;
        const resolved = await realpath(bun.execPath);
        await access(resolved, constants.X_OK);
        if (inside(root, resolved) || !(await stat(resolved)).isFile()) continue;
        return { executable: bun.execPath, prefix: [], version: bun.version };
      }
      // npm's and pnpm's scripts run under Node; Electron's own binary cannot.
      if (!node) return null;
      const launcher = await realpath(
        join(canonical, manager + (process.platform === "win32" ? ".cmd" : "")),
      );
      const script = manager === "npm" ? "npm-cli.js" : "pnpm.cjs";
      // Beside the launcher, or beside the Node that runs it when the launcher is a version-manager shim.
      const candidates = [
        join(dirname(launcher), "node_modules", manager, "bin", script),
        launcher,
        join(dirname(launcher), "..", "lib", "node_modules", manager, "bin", script),
        join(dirname(node), "node_modules", manager, "bin", script),
        join(dirname(node), "..", "lib", "node_modules", manager, "bin", script),
      ];
      for (const candidate of candidates) {
        try {
          const cli = await realpath(candidate);
          if (inside(root, cli) || basename(cli) !== script) continue;
          const parent = await realpath(join(dirname(cli), ".."));
          const pkg = object(
            JSON.parse((await readSelectedFile(parent, "package.json", 256 * 1024)) ?? "null"),
          );
          if (pkg.name !== manager || typeof pkg.version !== "string" || !semver.valid(pkg.version))
            continue;
          // Only versions whose output and no-install switches are verified are enabled.
          if (
            (manager === "npm" && semver.major(pkg.version) !== 11) ||
            (manager === "pnpm" && semver.major(pkg.version) !== 10)
          )
            continue;
          return { executable: node, prefix: [cli], version: pkg.version };
        } catch {
          /* Try another installed layout. */
        }
      }
    } catch {
      /* Try the next owner PATH entry. */
    }
  }
  return null;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(npm_config_|pnpm_|corepack_|node_options$|node_path$|bun_options$)/i.test(key))
      delete env[key];
  return {
    ...env,
    ...noAutoInstall,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
  };
}

const commandTimeout = 30000;
// A healthy batch answers in seconds; commandTimeout only bounds a hung one.
const batchAllowance = 10000;
export const runOutdatedCommand: OutdatedRunner = (command, args, cwd, env, signal) =>
  new Promise((resolveResult, reject) => {
    execFile(
      command.executable,
      [...command.prefix, ...args],
      {
        cwd,
        env,
        signal,
        timeout: commandTimeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        // Exit 1 is a successful outdated report for npm/pnpm. A signal/timeout/output overflow is not.
        if (error && (error.killed || typeof error.code !== "number" || error.signal))
          reject(new Error("Native update check unavailable."));
        else
          resolveResult({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
  });

type Row = {
  name: string;
  current: string | null;
  wanted: string | null;
  latest: string | null;
  location?: string | null;
};
export function parseOutdated(manager: Manager, output: string): Row[] {
  const text = stripVTControlCharacters(output)
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return [];
  if (manager !== "bun") {
    const data = object(JSON.parse(text));
    if (Object.hasOwn(data, "error") || Object.keys(data).length > 10000)
      throw new Error("Invalid outdated report.");
    return Object.entries(data).flatMap(([name, value]) => {
      if (!packageName(name)) throw new Error("Invalid package identity.");
      return (Array.isArray(value) ? value : [value]).map((item) => {
        const row = object(item);
        return {
          name,
          current: string(row.current),
          wanted: string(row.wanted),
          latest: string(row.latest),
          location: string(row.location),
        };
      });
    });
  }
  // Bun 1.4 renders an ASCII or box-drawing table. Never interpret unrecognized output as clean.
  const rows: Row[] = [];
  let header = false;
  for (const line of text.split(/\r?\n/)) {
    if (!header && /^bun outdated v1\.4\.\d+ \([a-f0-9]+\)$/.test(line)) continue;
    if (/^[\s┌┐└┘├┤┬┴┼─+|:-]+$/.test(line)) continue;
    if (!line.trim().startsWith("|") && !line.trim().startsWith("│"))
      throw new Error("Unknown Bun outdated output.");
    const cells = line
      .trim()
      .split(/[|│]/)
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (!header) {
      if (cells.join("|") !== "Package|Current|Update|Latest")
        throw new Error("Unknown Bun table columns.");
      header = true;
      continue;
    }
    if (cells.length !== 4) throw new Error("Incomplete Bun table row.");
    const name = cells[0]!.replace(/\s+\((dev|optional|peer)\)$/, "");
    if (!packageName(name) || rows.length >= 10000)
      throw new Error("Invalid Bun package identity.");
    rows.push({ name, current: cells[1]!, wanted: cells[2]!, latest: cells[3]! });
  }
  if (!header) throw new Error("Missing Bun table header.");
  return rows;
}

async function safePnpmConfiguration(root: string) {
  // Config dependencies are installed at CLI initialization even with --ignore-pnpmfile.
  // Inspect ancestor workspace/manifests as data and fall back rather than loading those plugins.
  let directory = root;
  for (let count = 0; count < 100; count++) {
    for (const name of ["package.json", "pnpm-workspace.yaml", ".npmrc"])
      if (
        /config[-_]?dependencies/i.test(
          (await readSelectedFile(directory, name, 1024 * 1024)) ?? "",
        )
      )
        return false;
    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = await realpath(parent);
  }
  return false;
}

export async function checkNativeVersions(
  root: string,
  manager: Project["packageManager"],
  dependencies: readonly Dependency[],
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
  options: { executable?: typeof outdatedExecutable; run?: OutdatedRunner } = {},
): Promise<NativeVersions> {
  const result: NativeVersions = { checked: new Map(), coverage: [] };
  const fallback = (reason: string) => {
    result.coverage.push(
      `Native update checks: ${reason}; public-registry fallback used for eligible records.`,
    );
    return result;
  };
  if (manager === "unknown") return fallback("package manager is unknown");
  if ((await selectDirectory(root)) !== root) return fallback("selected folder identity changed");
  const eligible = dependencies.filter(
    (dep) =>
      dep.role !== "transitive" &&
      dep.origin === "registry" &&
      dep.resolved &&
      semver.valid(dep.resolved),
  );
  if (!eligible.length) return result;
  let configuration: string | null = null;
  try {
    if (manager === "pnpm" && !(await safePnpmConfiguration(root)))
      return fallback("pnpm configuration plugins require execution");
    const command = await (options.executable ?? outdatedExecutable)(manager, root);
    if (!command || (manager === "bun" && !semver.satisfies(command.version, ">=1.4.0 <1.5.0")))
      return fallback(`${manager} is missing or its CLI version is unverified`);
    configuration = await mkdtemp(join(tmpdir(), "versionstead-outdated-"));
    const userConfig = join(configuration, "user.npmrc");
    const globalConfig = join(configuration, "global.npmrc");
    await writeFile(userConfig, "");
    await writeFile(globalConfig, "");
    const env = {
      ...safeEnvironment(),
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
    };
    const groups = new Map<string, Dependency[]>();
    for (const dep of eligible) {
      const group = groups.get(dep.importer) ?? [];
      group.push(dep);
      groups.set(dep.importer, group);
    }
    // Like the registry and OSV stages, the whole stage gets a budget scaled by its work: one command
    // per batch (two for pnpm), each allowed batchAllowance. That is far below commandTimeout so that
    // the budget can end a registry outage that would run every command to its own limit.
    // ponytail: checked between batches, so one command in flight can overrun the budget by its own
    // timeout; pass the remaining time to the runner as a signal if that matters.
    const batches = [...groups.values()].reduce(
      (sum, records) => sum + Math.ceil(new Set(records.map((dep) => dep.name)).size / 40),
      0,
    );
    const deadline =
      Date.now() +
      Math.max(90000, batches * (manager === "pnpm" ? 2 : 1) * batchAllowance + commandTimeout);
    let completed = 0;
    onProgress?.(0, eligible.length);
    for (const [importer, records] of groups) {
      if (signal?.aborted) throw new Error("Scan cancelled.");
      if (Date.now() > deadline) break;
      const cwd = await selectDirectory(resolve(root, importer));
      if (!inside(root, cwd)) throw new Error("Workspace escapes selected folder.");
      const npmrc = (await readSelectedFile(cwd, ".npmrc", 100 * 1024)) ?? "";
      if (
        npmrc.split(/\r?\n/).some((line) => {
          const match = line.match(/^\s*(?:@[^:]+:)?registry\s*=\s*(\S+)/);
          return match && match[1]!.replace(/\/$/, "") !== "https://registry.npmjs.org";
        })
      ) {
        completed += records.length;
        onProgress?.(completed, eligible.length);
        continue;
      }
      // Batches keep Windows command lines bounded. Per-importer calls avoid pnpm recursive JSON
      // collapsing the same canonical package at different workspace versions/ranges.
      const names = [...new Set(records.map((dep) => dep.name))];
      for (let offset = 0; offset < names.length; offset += 40) {
        if (Date.now() > deadline) break;
        const selected = names.slice(offset, offset + 40);
        const batch = records.filter((dep) => selected.includes(dep.name));
        try {
          const args =
            manager === "npm"
              ? [
                  "outdated",
                  ...selected,
                  "--json",
                  "--prefix",
                  cwd,
                  "--ignore-scripts",
                  "--fetch-retries=0",
                  "--fetch-timeout=12000",
                ]
              : manager === "pnpm"
                ? [
                    "outdated",
                    ...selected,
                    "--format",
                    "json",
                    "--dir",
                    cwd,
                    "--config.ignore-scripts=true",
                    "--config.ignore-pnpmfile=true",
                    "--config.manage-package-manager-versions=false",
                    "--config.package-manager-strict-version=false",
                    "--config.fetch-retries=0",
                    "--config.fetch-timeout=12000",
                  ]
                : ["outdated", ...selected, "--ignore-scripts", "--no-progress"];
          const run = options.run ?? runOutdatedCommand;
          const report = await run(command, args, cwd, env, signal);
          if (![0, 1].includes(report.code) || report.stderr.trim())
            throw new Error("CLI reported incomplete coverage.");
          const rows = parseOutdated(manager, report.stdout);
          let compatible: Row[] = [];
          if (manager === "pnpm") {
            const compatibleReport = await run(
              command,
              [...args, "--compatible"],
              cwd,
              env,
              signal,
            );
            if (![0, 1].includes(compatibleReport.code) || compatibleReport.stderr.trim())
              throw new Error("Compatible check failed.");
            compatible = parseOutdated(manager, compatibleReport.stdout);
          }
          for (const dep of batch) {
            const key = manager === "pnpm" ? dep.packageName : dep.name;
            if (
              manager === "pnpm" &&
              records.filter((other) => other.packageName === key).length !== 1
            )
              continue;
            const matches = rows.filter((row) => {
              if (row.name !== key) return false;
              if (manager !== "npm") return true;
              if (!row.location || !isAbsolute(row.location)) return false;
              const location = resolve(row.location);
              const expected = join(cwd, "node_modules", dep.name);
              return process.platform === "win32"
                ? location.toLowerCase() === expected.toLowerCase()
                : location === expected;
            });
            if (matches.length !== 1) continue;
            const row = matches[0]!;
            const latest = row.latest && semver.valid(row.latest);
            if (!latest) continue;
            let wanted = row.wanted;
            if (manager === "pnpm") {
              // pnpm wanted is the lockfile target, not the newest compatible version.
              if (row.wanted !== dep.resolved) continue;
              const compatibleMatches = compatible.filter((candidate) => candidate.name === key);
              if (compatibleMatches.length !== 1 || compatibleMatches[0]!.wanted !== dep.resolved)
                continue;
              wanted = compatibleMatches[0]!.latest;
            }
            if (!wanted || !semver.valid(wanted)) continue;
            result.checked.set(dep.id, {
              compatible: wanted,
              latest,
              source: `${manager} outdated ${command.version}`,
            });
          }
        } catch {
          // Do not persist command output; it may contain credentials or local paths.
          result.coverage.push(
            `${manager} outdated could not verify a workspace batch; eligible records use the public-registry fallback.`,
          );
        } finally {
          completed += batch.length;
          onProgress?.(completed, eligible.length);
        }
      }
    }
    // Records the deadline skipped stay unreported, so they use the registry fallback like any other.
    if (completed < eligible.length) {
      result.coverage.push(
        `${manager} outdated exceeded its scan time budget; remaining eligible records use the public-registry fallback.`,
      );
      onProgress?.(eligible.length, eligible.length);
    }
    result.coverage.push(
      `${manager} outdated ${command.version}: ${result.checked.size}/${eligible.length} direct records verified; unreported or unavailable records use the public-registry fallback`,
    );
    return result;
  } catch {
    return fallback(`${manager} could not complete the read-only check`);
  } finally {
    if (configuration) await rm(configuration, { recursive: true, force: true });
  }
}
