import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { type Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import * as Schema from "effect/Schema";
import semver from "semver";
import {
  GlobalToolSource as SourceSchema,
  type GlobalToolSource,
  type Installation,
} from "@versionstead/contracts/monitoring";
import { identity, InputError, object, packageName, readSelectedFile, string } from "./projects.ts";
import { publicPackageVersions } from "./lookups.ts";

import { decodeBunConfiguration } from "./bun-config.ts";
import { toolExecutable as executable } from "./tool-paths.ts";
export { decodeBunConfiguration } from "./bun-config.ts";

const execute = promisify(execFile);
const publicRegistry = "https://registry.npmjs.org";
const decodeSource = Schema.decodeUnknownSync(SourceSchema);
const now = () => new Date().toISOString();
type Writable<T> = { -readonly [K in keyof T]: T[K] };
const rootId = (source: GlobalToolSource) =>
  identity("global-root", source.manager, source.root ?? "");
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

export type InventoryProgress = {
  stage: "inventory" | "pc-updates";
  completed: number | null;
  total: number | null;
};
export type InventoryResult = {
  installations: Writable<Installation>[];
  managers: GlobalToolSource[];
  coverage: string[];
  errors: string[];
  inventoryChecks: "complete" | "partial" | "failed";
  updateChecks: "complete" | "partial" | "failed" | "unsupported";
  checkedRoots: string[];
};

async function canonicalRoot(value: string) {
  if (
    !isAbsolute(value) ||
    value.length > 4096 ||
    /^[\\/]{2}/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character === '"') ||
    basename(value).toLowerCase() !== "node_modules"
  )
    throw new InputError("Select an absolute local global node_modules directory.");
  const path = resolve(value);
  try {
    const canonical = await realpath(path);
    if (
      !(await stat(canonical)).isDirectory() ||
      /^[\\/]{2}/.test(canonical) ||
      basename(canonical).toLowerCase() !== "node_modules"
    )
      throw new InputError("The global package root is not a supported directory.");
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new InputError("The global package root cannot be read.");
    // Detected managers with no global packages may not have created their directory yet.
    return path;
  }
}

export async function validateGlobalToolSources(
  values: readonly GlobalToolSource[],
  previous: readonly GlobalToolSource[] = [],
) {
  if (!Array.isArray(values) || values.length !== 2)
    throw new InputError("Supply one npm source and one Bun source.");
  const sources: GlobalToolSource[] = [];
  for (const value of values) {
    let source: GlobalToolSource;
    try {
      source = decodeSource(value);
    } catch {
      throw new InputError("Invalid global tool source fields.");
    }
    if (
      sources.some((s) => s.manager === source.manager) ||
      (source.version !== null && (!semver.valid(source.version) || source.version.length > 100)) ||
      (source.checkedAt !== null && !Number.isFinite(Date.parse(source.checkedAt))) ||
      (source.error !== null && source.error.length > 300) ||
      source.blockedScopes.length > 100 ||
      source.blockedScopes.some((scope) => !/^@[a-z0-9][a-z0-9._-]*$/i.test(scope)) ||
      (source.status === "detected" && (!source.version || !source.root)) ||
      (source.status === "not-installed" && (source.root !== null || source.version !== null))
    )
      throw new InputError("Invalid global tool source identity or availability.");
    const prior = previous.find((item) => item.manager === source.manager);
    if (source.status === "not-installed" && prior?.root && prior.version) {
      try {
        await stat(prior.root);
        source = {
          ...source,
          status: "unavailable",
          root: prior.root,
          version: prior.version,
          error: `${source.manager} was not found in the owner's PATH; previous global metadata is retained.`,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          source = {
            ...source,
            status: "unavailable",
            root: prior.root,
            version: prior.version,
            error: `${source.manager} availability and its previous global location could not be verified.`,
          };
      }
    }
    if (source.status === "unavailable" && prior?.root)
      source = {
        ...source,
        root: source.root ?? prior.root,
        version: source.version ?? prior.version,
      };
    sources.push({
      ...source,
      root: source.root === null ? null : await canonicalRoot(source.root),
    });
  }
  return sources;
}

async function metadataFile(path: string) {
  try {
    const parent = await realpath(dirname(path));
    return await readSelectedFile(parent, basename(path), 256 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new InputError("Package-manager configuration cannot be read safely.");
  }
}

function publicUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return (
      url.origin === publicRegistry &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function blockedNpmScopes(text: string, blocked: Set<string>) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(@[a-z0-9._-]+):registry\s*=\s*(.*?)\s*$/i.exec(line);
    if (match && !publicUrl(match[2]!)) blocked.add(match[1]!);
  }
}

async function run(executablePath: string, args: string[], signal?: AbortSignal) {
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true",
    npm_config_loglevel: "error",
  };
  const { stdout } = await execute(executablePath, args, {
    cwd: tmpdir(),
    env,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
    ...(signal ? { signal } : {}),
  });
  return stripVTControlCharacters(stdout)
    .replace(/^\uFEFF/, "")
    .trim();
}

export async function npmGlobalCommand() {
  const launcher = await executable(process.platform === "win32" ? "npm.cmd" : "npm");
  if (!launcher) return null;
  const candidates = [
    join(dirname(launcher), "node_modules", "npm", "bin", "npm-cli.js"),
    launcher.endsWith("npm-cli.js")
      ? launcher
      : join(dirname(launcher), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    try {
      const cli = await realpath(candidate);
      const pkg = object(
        JSON.parse((await metadataFile(join(dirname(cli), "..", "package.json"))) ?? "null"),
      );
      if (pkg.name !== "npm" || typeof pkg.version !== "string" || !semver.valid(pkg.version))
        continue;
      const node = /^node(?:\.exe)?$/i.test(basename(process.execPath))
        ? process.execPath
        : (process.env.VERSIONSTEAD_NODE_EXECUTABLE ??
          (await executable(process.platform === "win32" ? "node.exe" : "node")));
      if (!node || !isAbsolute(node) || !/^node(?:\.exe)?$/i.test(basename(node)))
        throw new Error();
      return { executable: await realpath(node), cli, version: pkg.version };
    } catch {
      // Validate npm's actual JS entry point; never execute a shell wrapper.
    }
  }
  throw new InputError("npm's executable could not be verified.");
}

async function npmSource(signal?: AbortSignal): Promise<GlobalToolSource> {
  const source: Writable<GlobalToolSource> = {
    manager: "npm",
    status: "not-installed",
    version: null,
    root: null,
    registry: "unknown",
    blockedScopes: [],
    checkedAt: now(),
    error: null,
  };
  try {
    const npm = await npmGlobalCommand();
    if (!npm) return source;
    source.status = "unavailable";
    source.version = npm.version;
    const command = (args: string[]) => run(npm.executable, [npm.cli, ...args, "--global"], signal);
    source.root = await canonicalRoot(await command(["root"]));
    const [registry, userconfig, globalconfig] = await Promise.all([
      command(["config", "get", "registry"]),
      command(["config", "get", "userconfig"]),
      command(["config", "get", "globalconfig"]),
    ]);
    source.registry = publicUrl(registry) ? "public" : "unsupported";
    const blocked = new Set<string>();
    for (const path of [userconfig, globalconfig]) {
      if (!isAbsolute(path)) throw new Error();
      blockedNpmScopes((await metadataFile(path)) ?? "", blocked);
    }
    for (const [key, value] of Object.entries(process.env)) {
      const match = /^npm_config_(@[a-z0-9._-]+):registry$/i.exec(key);
      if (match && value && !publicUrl(value)) blocked.add(match[1]!);
    }
    source.blockedScopes = [...blocked];
    source.status = "detected";
  } catch {
    source.status = "unavailable";
    source.registry = "unknown";
    source.error = "npm global location or registry configuration could not be checked.";
  }
  return source;
}

export function bunGlobalDirectory(
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  const directory =
    env.BUN_INSTALL_GLOBAL_DIR ??
    configured ??
    (env.BUN_INSTALL
      ? join(env.BUN_INSTALL, "install", "global")
      : join(env.XDG_CACHE_HOME ?? env.HOME ?? home, ".bun", "install", "global"));
  return /^~[\\/]/.test(directory) ? join(home, directory.slice(2)) : directory;
}

async function bunSource(signal?: AbortSignal): Promise<GlobalToolSource> {
  const source: Writable<GlobalToolSource> = {
    manager: "bun",
    status: "not-installed",
    version: null,
    root: null,
    registry: "public",
    blockedScopes: [],
    checkedAt: now(),
    error: null,
  };
  const binary = await executable(process.platform === "win32" ? "bun.exe" : "bun");
  if (!binary) {
    source.registry = "unknown";
    return source;
  }
  source.status = "unavailable";
  try {
    source.version = await run(binary, ["--version"], signal);
    if (!semver.valid(source.version)) throw new Error();
    let globalDir: string | null = null;
    const blocked = new Set<string>();
    const configs = [
      join(homedir(), ".bunfig.toml"),
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), ".bunfig.toml"),
    ];
    let unsupportedConfig = false;
    const applyConfig = (text: string) => {
      const config = decodeBunConfiguration(text);
      if (config.globalDirUnsupported)
        throw new InputError("Unsupported Bun global directory configuration.");
      if (config.registry === "unknown") unsupportedConfig = true;
      if (config.registry !== null) source.registry = config.registry;
      for (const scope of config.blockedScopes) blocked.add(scope);
      if (config.globalDir !== null) globalDir = config.globalDir;
    };
    for (const path of configs) applyConfig((await metadataFile(path)) ?? "");
    const directory = bunGlobalDirectory(globalDir);
    if (!isAbsolute(directory)) throw new Error();
    // bun pm ls --global creates directories and can climb to an unrelated parent manifest.
    // Read only the exact configured/default global directory; never trust a listing header.
    source.root = await canonicalRoot(join(directory, "node_modules"));
    applyConfig((await metadataFile(join(dirname(source.root), "bunfig.toml"))) ?? "");
    if (unsupportedConfig) source.registry = "unknown";
    for (const path of [join(homedir(), ".npmrc"), join(dirname(source.root), ".npmrc")]) {
      const contents = (await metadataFile(path)) ?? "";
      blockedNpmScopes(contents, blocked);
      const registry = /^\s*registry\s*=\s*(.*?)\s*$/im.exec(contents);
      if (registry && !publicUrl(registry[1]!)) source.registry = "unsupported";
    }
    if (process.env.npm_config_registry && !publicUrl(process.env.npm_config_registry))
      source.registry = "unsupported";
    source.blockedScopes = [...blocked];
    source.status = "detected";
  } catch {
    source.registry = "unknown";
    source.error = "Bun global location or registry configuration could not be checked.";
  }
  return source;
}

export async function discoverGlobalToolSources(
  signal?: AbortSignal,
  previous: readonly GlobalToolSource[] = [],
): Promise<GlobalToolSource[]> {
  const sources = await Promise.all([npmSource(signal), bunSource(signal)]);
  if (signal?.aborted) throw new InputError("The global tool scan was interrupted.");
  return validateGlobalToolSources(sources, previous);
}

async function emptyGlobalRoot(root: string) {
  try {
    return (await readdir(root)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function registrySpec(spec: string, alias: string, name: string): boolean {
  const requested = spec.startsWith(`${alias}@`) ? spec.slice(alias.length + 1) : spec;
  if (requested === alias || semver.validRange(requested) || /^[a-z][a-z0-9._-]*$/i.test(requested))
    return true;
  const match = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(requested);
  return (
    !!match &&
    match[1] === name &&
    packageName(match[1]) &&
    (semver.validRange(match[2]!) !== null || /^[a-z][a-z0-9._-]*$/i.test(match[2]!))
  );
}

/** Shared identity/origin verification for collection and explicit owner updates. */
export async function readGlobalInstallation(
  source: GlobalToolSource,
  alias: string,
  requested: string | null = null,
): Promise<Writable<Installation>> {
  if (!source.root || !packageName(alias)) throw new InputError("Invalid global package identity.");
  const root = await canonicalRoot(source.root);
  if (root !== source.root)
    throw new InputError("The global package location changed. Scan again.");
  const manifest = await readSelectedFile(root, `${alias}/package.json`, 1024 * 1024);
  if (manifest === null) throw new InputError("The global package is no longer installed.");
  const pkg = object(JSON.parse(manifest));
  const name = string(pkg.name);
  const version = string(pkg.version);
  if (!name || !packageName(name) || !version || !semver.valid(version))
    throw new InputError("Invalid installed package metadata.");
  const resolved = string(pkg["_resolved"]);
  const from = string(pkg["_from"]);
  const local = [from, requested].some((spec) =>
    /^(?:file:|link:|workspace:|git)/i.test(spec ?? ""),
  );
  const publicRequest =
    (from === null || registrySpec(from, alias, name)) &&
    (source.manager !== "bun" || (requested !== null && registrySpec(requested, alias, name)));
  const scope = name.startsWith("@") ? name.split("/")[0]! : null;
  const origin = local
    ? "local"
    : pkg.private !== true &&
        publicRequest &&
        source.registry === "public" &&
        (!scope || !source.blockedScopes.includes(scope)) &&
        (!resolved || resolved.startsWith(`${publicRegistry}/`))
      ? "registry"
      : "unknown";
  return {
    id: identity("global-tool", source.manager, root, alias, name, version),
    name: alias,
    packageId: name,
    manager: source.manager,
    rootId: rootId(source),
    origin,
    version,
    source: `${source.manager} global`,
    scope: inside(homedir(), root) ? "user" : "unknown",
    channel: semver.prerelease(version) ? "Prerelease" : "Stable",
    availableVersion: null,
    updateStatus: "unknown",
    updateCheckedAt: null,
  };
}

export async function inspectGlobalSources(
  configured: readonly GlobalToolSource[],
  signal?: AbortSignal,
  progress?: (value: InventoryProgress) => void,
  fetcher: typeof fetch = fetch,
): Promise<InventoryResult> {
  const result: InventoryResult = {
    installations: [],
    managers: [],
    checkedRoots: [],
    coverage: [
      "Top-level global npm/Bun packages only; installed manifests are read without executing tools or lifecycle scripts",
    ],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  };
  let readable = 0;
  for (const original of configured) {
    if (signal?.aborted) throw new InputError("The global tool scan was interrupted.");
    const source = { ...original, blockedScopes: [...original.blockedScopes] };
    result.managers.push(source);
    if (source.status === "not-installed") {
      result.coverage.push(`${source.manager}: not detected in the owner session`);
      progress?.({
        stage: "inventory",
        completed: result.managers.length,
        total: configured.length,
      });
      continue;
    }
    if (!source.root || !source.version) {
      result.errors.push(`${source.manager} global source is unavailable.`);
      progress?.({
        stage: "inventory",
        completed: result.managers.length,
        total: configured.length,
      });
      continue;
    }
    try {
      const root = await canonicalRoot(source.root);
      source.root = root;
      let names: string[];
      let requests: Record<string, unknown> = {};
      if (source.manager === "bun") {
        let manifest: string | null;
        try {
          const base = await realpath(dirname(root));
          manifest = await readSelectedFile(base, "package.json", 1024 * 1024);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") manifest = null;
          else throw error;
        }
        if (manifest === null) {
          // A missing direct-dependency manifest cannot establish removals in an existing install tree.
          if (!(await emptyGlobalRoot(root)))
            throw new InputError("The Bun global dependency manifest is missing.");
          names = [];
        } else {
          requests = object(object(JSON.parse(manifest)).dependencies ?? {});
          names = Object.keys(requests);
        }
      } else {
        let entries: Dirent[];
        try {
          entries = await readdir(root, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
          else throw error;
        }
        names = [];
        for (const entry of entries) {
          if (entry.name.startsWith("@")) {
            const scoped = await readdir(join(root, entry.name), { withFileTypes: true });
            names.push(...scoped.map((item) => `${entry.name}/${item.name}`));
          } else if (!entry.name.startsWith(".")) names.push(entry.name);
        }
      }
      if (names.length > 500)
        throw new InputError("A global source exceeded 500 top-level packages.");
      let complete = true;
      for (const alias of names) {
        try {
          const requested = source.manager === "bun" ? string(requests[alias]) : null;
          // Declared Bun packages can be intentionally absent on this OS.
          if (
            source.manager === "bun" &&
            packageName(alias) &&
            (await readSelectedFile(root, `${alias}/package.json`, 1024 * 1024)) === null
          )
            continue;
          result.installations.push(await readGlobalInstallation(source, alias, requested));
        } catch {
          complete = false;
          result.errors.push(
            `${source.manager}: an installed package was malformed, inaccessible, or outside the global root.`,
          );
        }
      }
      source.status = original.status === "unavailable" ? "unavailable" : "detected";
      source.error = original.status === "unavailable" ? original.error : null;
      if (source.error) result.errors.push(source.error);
      readable++;
      if (complete) result.checkedRoots.push(rootId(source));
      result.coverage.push(
        `${source.manager}: installed metadata from the owner's configured global location`,
      );
    } catch {
      source.status = "unavailable";
      source.error = `${source.manager} global package metadata could not be read.`;
      result.errors.push(source.error);
    }
    progress?.({ stage: "inventory", completed: result.managers.length, total: configured.length });
  }
  result.inventoryChecks = result.errors.length ? (readable ? "partial" : "failed") : "complete";
  const eligible = result.installations.filter(
    (item) => item.origin === "registry" && !semver.prerelease(item.version),
  );
  const names = [...new Set(eligible.map((item) => item.packageId!))];
  const concurrency = 4;
  const deadline =
    Date.now() + Math.max(90000, Math.ceil(names.length / concurrency) * 12000 + 12000);
  progress?.({ stage: "pc-updates", completed: 0, total: names.length });
  let finished = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, names.length) }, async () => {
      while (next < names.length) {
        if (signal?.aborted) throw new InputError("The global tool scan was interrupted.");
        const name = names[next++]!;
        try {
          const { latest, versions } = await publicPackageVersions(name, fetcher, deadline, signal);
          if (semver.prerelease(latest) || !versions.includes(latest)) throw new Error();
          for (const item of eligible.filter((candidate) => candidate.packageId === name)) {
            item.availableVersion = semver.gt(latest, item.version) ? latest : null;
            item.updateStatus = item.availableVersion ? "available" : "current";
            item.updateCheckedAt = now();
          }
        } catch {
          if (signal?.aborted) throw new InputError("The global tool scan was interrupted.");
          result.errors.push(
            "A global package version check failed or returned unsupported release metadata.",
          );
        }
        progress?.({ stage: "pc-updates", completed: ++finished, total: names.length });
      }
    }),
  );
  if (
    result.installations.some(
      (item) => item.origin !== "registry" || semver.prerelease(item.version),
    )
  )
    result.errors.push(
      "Private, linked, unknown-source and prerelease global tools have no verified stable upgrade check.",
    );
  result.updateChecks =
    eligible.length === 0 && result.installations.length > 0
      ? "unsupported"
      : result.errors.length
        ? result.installations.some((item) => item.updateStatus !== "unknown")
          ? "partial"
          : "failed"
        : "complete";
  return result;
}

export async function inspectInventory(
  _platform: NodeJS.Platform,
  mode: "interactive" | "background",
  signal?: AbortSignal,
  progress?: (value: InventoryProgress) => void,
  previous: readonly GlobalToolSource[] = [],
): Promise<InventoryResult> {
  progress?.({ stage: "inventory", completed: null, total: null });
  const sources =
    mode === "interactive" ? await discoverGlobalToolSources(signal, previous) : previous;
  if (!sources.length)
    throw new InputError(
      "Owner global locations are not configured. Open Versionstead in the owner session before background scanning.",
    );
  const result = await inspectGlobalSources(sources, signal, progress);
  for (const old of previous) {
    const current = result.managers.find((source) => source.manager === old.manager);
    if (
      old.root &&
      current &&
      (current.status === "not-installed" ||
        (current.root !== old.root && result.checkedRoots.includes(rootId(current))))
    )
      result.checkedRoots.push(rootId(old));
  }
  return result;
}
