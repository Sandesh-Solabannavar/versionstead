import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import semver from "semver";
import { parseTree, getNodeValue, type ParseError } from "jsonc-parser";
import { decodeBunConfiguration } from "./bun-config.ts";
import type { Dependency, Project } from "@versionstead/contracts/monitoring";

export const identity = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid structured input.");
  }
  return value as Record<string, unknown>;
}
export const string = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 4096 ? value : null;
export const packageName = (name: string) =>
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) && name.length <= 214;

export class InputError extends Error {
  readonly status: "failed" | "unsupported";
  constructor(message: string, status: "failed" | "unsupported" = "failed") {
    super(message);
    this.status = status;
  }
}

export async function selectDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || path.length > 4096 || path.includes("\0")) {
    throw new InputError("Select an absolute local directory.");
  }
  // Network shares require an explicit access/credential design before they are selected.
  if (path.startsWith("\\\\") || path.startsWith("//")) {
    throw new InputError("Network shares are not supported yet.");
  }
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error();
    return canonical;
  } catch {
    throw new InputError("The selected directory is missing or cannot be accessed.");
  }
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function readSelectedFile(root: string, name: string, limit = 10 * 1024 * 1024) {
  if (
    isAbsolute(name) ||
    name.includes("\\") ||
    name.split("/").includes("..") ||
    name.includes("\0")
  ) {
    throw new InputError("An input path escapes the selected project.");
  }
  let file;
  try {
    const selected = await realpath(resolve(root, name));
    if (!inside(root, selected))
      throw new InputError("An input symlink escapes the selected project.");
    const initial = await stat(selected);
    if (!initial.isFile()) throw new InputError("An input is not a regular file.");
    file = await open(
      selected,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new InputError("An input file exceeds its supported size or is not a regular file.");
    const verifiedRoot = await realpath(root);
    const verified = await realpath(resolve(root, name));
    const current = await stat(verified);
    if (
      verifiedRoot !== root ||
      !inside(root, verified) ||
      verified !== selected ||
      initial.dev !== info.dev ||
      initial.ino !== info.ino ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    ) {
      throw new InputError("A project input changed identity while opening; retry the scan.");
    }
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > limit) throw new InputError("An input file exceeds its supported size.");
    return buffer
      .subarray(0, used)
      .toString("utf8")
      .replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof InputError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new InputError("A project input cannot be read.");
  } finally {
    await file?.close();
  }
}

type Declaration = { name: string; requested: string; role: Dependency["role"]; importer: string };
const sections = [
  ["dependencies", "production"],
  ["devDependencies", "development"],
  ["optionalDependencies", "optional"],
] as const;

function declarations(manifest: Record<string, unknown>, importer: string): Declaration[] {
  const found = new Map<string, Declaration>();
  for (const [section, role] of sections) {
    if (manifest[section] === undefined) continue;
    for (const [name, requested] of Object.entries(object(manifest[section]))) {
      if (!packageName(name) || !string(requested))
        throw new InputError("A manifest dependency is malformed.");
      found.set(name, { name, requested: requested as string, role, importer });
    }
  }
  return [...found.values()];
}

function alias(requested: string | null, name: string) {
  const match = requested?.match(/^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/);
  return { packageName: match?.[1] ?? name, range: match?.[2] ?? requested };
}

function origin(
  version: string | null,
  resolved: string | null,
  requested: string | null,
  link = false,
): Dependency["origin"] {
  if (link || requested?.startsWith("workspace:") || version?.startsWith("link:"))
    return "workspace";
  if (
    [resolved, requested, version].some(
      (v) => v && /^(git\+|git:|github:|gitlab:|bitbucket:)/.test(v),
    )
  )
    return "git";
  if ([resolved, requested, version].some((v) => v && /^(file:|link:|\.\.?\/)/.test(v)))
    return "local";
  if (resolved) {
    try {
      if (new URL(resolved).origin !== "https://registry.npmjs.org") return "unknown";
    } catch {
      return "unknown";
    }
  }
  return version && semver.valid(version) ? "registry" : "unknown";
}

function dependency(
  location: string,
  name: string,
  version: string | null,
  resolved: string | null,
  declaration?: Declaration,
  actualName = name,
  link = false,
): Dependency {
  const requested = declaration?.requested ?? null;
  const parsed = alias(requested, actualName);
  const resolvedName = actualName === name ? parsed.packageName : actualName;
  if (!packageName(resolvedName)) throw new InputError("A resolved package identity is malformed.");
  const source = origin(version, resolved, parsed.range, link);
  return {
    id: identity(location, name, actualName, version ?? "unresolved"),
    name,
    packageName: resolvedName,
    requested,
    resolved: version,
    origin: source,
    role: declaration?.role ?? "transitive",
    importer: declaration?.importer ?? location,
    availableVersion: null,
    latestVersion: null,
    versionStatus:
      source === "registry" && declaration && version && semver.valid(version)
        ? "not-checked"
        : "unsupported",
    advisoryStatus: source === "registry" ? "not-checked" : "unsupported",
    advisoryIds: [],
  };
}

export type ProjectInputs = {
  repositoryCommit?: string;
  git?: Project["git"];
  packageManager: Project["packageManager"];
  manifestPath: string;
  lockfilePath: string;
  dependencies: Dependency[];
  coverage: string[];
  errors: string[];
  inputFingerprint: string;
};

function parseJson(text: string) {
  try {
    return object(JSON.parse(text));
  } catch {
    throw new InputError("A project JSON input is malformed.");
  }
}

export type ProjectReader = (name: string, limit?: number) => Promise<string | null>;

async function npmInputs(
  read: ProjectReader,
  manifest: Record<string, unknown>,
  text: string,
): Promise<ProjectInputs> {
  const lock = parseJson(text);
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    throw new InputError("Only npm package-lock versions 2 and 3 are supported.", "unsupported");
  }
  const packages = object(lock.packages);
  const entries = Object.entries(packages);
  if (entries.length > 10000)
    throw new InputError("The lockfile exceeds 10,000 packages.", "unsupported");
  const errors: string[] = [];
  const importers = new Map<string, Declaration[]>([[".", declarations(manifest, ".")]]);
  for (const [path, value] of entries) {
    if (!path || path.includes("node_modules")) continue;
    object(value);
    if (importers.size >= 100)
      throw new InputError("The project exceeds 100 workspace importers.", "unsupported");
    const input = await read(`${path}/package.json`, 1024 * 1024);
    if (input === null) errors.push("A workspace importer has no readable package.json.");
    else importers.set(path, declarations(parseJson(input), path));
  }
  const dependencies: Dependency[] = [];
  const directlyResolved = new Set<string>();
  for (const [importer, declared] of importers) {
    const importerMetadata = packages[importer === "." ? "" : importer];
    const lockedDeclarations = importerMetadata
      ? declarations(object(importerMetadata), importer)
      : [];
    for (const declaration of declared) {
      if (dependencies.length >= 10000)
        throw new InputError("The project exceeds 10,000 dependency records.", "unsupported");
      const local = `${importer === "." ? "" : `${importer}/`}node_modules/${declaration.name}`;
      const location = packages[local] ? local : `node_modules/${declaration.name}`;
      const entry = packages[location] ? object(packages[location]) : null;
      if (!entry) errors.push("A requested dependency is missing from the lockfile.");
      const version = string(entry?.version);
      const expected = alias(declaration.requested, declaration.name);
      const actualName = string(entry?.name) ?? declaration.name;
      if (
        lockedDeclarations.find((d) => d.name === declaration.name)?.requested !==
        declaration.requested
      )
        errors.push("A manifest dependency differs from the npm importer declaration.");
      if (
        entry?.link !== true &&
        expected.range &&
        semver.validRange(expected.range) &&
        version &&
        semver.valid(version) &&
        !semver.satisfies(version, expected.range)
      )
        errors.push("A resolved npm version does not satisfy the current manifest range.");
      if (entry?.name && expected.packageName !== actualName)
        errors.push("An npm alias target differs between manifest and lockfile.");
      dependencies.push(
        dependency(
          location,
          declaration.name,
          version,
          string(entry?.resolved),
          declaration,
          actualName,
          entry?.link === true,
        ),
      );
      directlyResolved.add(location);
    }
  }
  for (const [location, value] of entries) {
    if (!location.includes("node_modules/") || directlyResolved.has(location)) continue;
    if (location.includes("\\") || location.split("/").includes("..") || isAbsolute(location))
      throw new InputError("An npm package location escapes the selected project.");
    const entry = object(value);
    if (dependencies.length >= 10000)
      throw new InputError("The project exceeds 10,000 dependency records.", "unsupported");
    const name = location.split("node_modules/").at(-1) ?? "";
    if (!packageName(name)) throw new InputError("An npm package identity is malformed.");
    dependencies.push(
      dependency(
        location,
        name,
        string(entry.version),
        string(entry.resolved),
        undefined,
        string(entry.name) ?? name,
        entry.link === true,
      ),
    );
  }
  return {
    packageManager: "npm",
    manifestPath: "package.json",
    lockfilePath: "package-lock.json",
    dependencies,
    errors,
    inputFingerprint: "",
    coverage: [
      `npm lockfile v${lock.lockfileVersion}: requested and resolved dependencies`,
      `${importers.size} selected workspace importer(s)`,
      "Lockfile evidence only; node_modules is not inspected",
    ],
  };
}

function parseYaml(text: string) {
  try {
    const document = parseDocument(text, { uniqueKeys: true, schema: "core" });
    if (document.errors.length) throw new Error();
    return object(document.toJS({ maxAliasCount: 10 }));
  } catch {
    throw new InputError("The pnpm lockfile is malformed.");
  }
}

function pnpmIdentity(key: string) {
  const base = key.replace(/\(.*/, "");
  const match = base.match(/^((?:@[^/]+\/)?[^@]+)@(.+)$/);
  if (!match?.[1] || !match[2] || !packageName(match[1])) return null;
  return { name: match[1], version: match[2], reference: key.slice(match[1].length + 1) };
}

async function pnpmInputs(read: ProjectReader, text: string): Promise<ProjectInputs> {
  const lock = parseYaml(text);
  if (String(lock.lockfileVersion) !== "9.0" && lock.lockfileVersion !== 9) {
    throw new InputError("Only pnpm lockfile version 9 is supported.", "unsupported");
  }
  const importers = object(lock.importers);
  const packages = object(lock.packages ?? {});
  const snapshots = object(lock.snapshots ?? {});
  if (
    Object.keys(importers).length > 100 ||
    Object.keys(snapshots).length > 10000 ||
    Object.keys(packages).length > 10000
  ) {
    throw new InputError("The lockfile exceeds 100 importers or 10,000 packages.", "unsupported");
  }
  const dependencies: Dependency[] = [];
  const errors: string[] = [];
  if (Object.keys(packages).length && !Object.keys(snapshots).length)
    errors.push("The pnpm lockfile has no resolved snapshots.");
  const direct = new Set<string>();
  for (const [importer, value] of Object.entries(importers)) {
    const importerPath = importer === "." ? "package.json" : `${importer}/package.json`;
    const manifest = await read(importerPath, 1024 * 1024);
    if (manifest === null) errors.push("A workspace importer has no readable package.json.");
    const declared = manifest === null ? [] : declarations(parseJson(manifest), importer);
    const importerEntry = object(value);
    for (const [section, role] of sections) {
      if (importerEntry[section] === undefined) continue;
      for (const [name, raw] of Object.entries(object(importerEntry[section]))) {
        if (dependencies.length >= 10000)
          throw new InputError("The project exceeds 10,000 dependency records.", "unsupported");
        if (!packageName(name)) throw new InputError("A pnpm dependency identity is malformed.");
        const entry = object(raw);
        const specifier = string(entry.specifier);
        const ref = string(entry.version);
        if (!specifier || !ref) throw new InputError("A pnpm importer dependency is malformed.");
        const actual = alias(specifier, name);
        const refIdentity = pnpmIdentity(ref);
        const actualName = refIdentity?.name ?? actual.packageName;
        const version = (refIdentity?.version ?? ref).replace(/\(.*/, "");
        const key = `${actualName}@${version}`;
        const snapshotKey = `${actualName}@${refIdentity?.reference ?? ref}`;
        const locked = packages[key] ? object(packages[key]) : null;
        const resolution = locked?.resolution === undefined ? null : object(locked.resolution);
        const declaration = declared.find((d) => d.name === name) ?? {
          name,
          requested: specifier,
          role,
          importer,
        };
        if (declaration.requested !== specifier)
          errors.push("A manifest dependency differs from the pnpm importer specifier.");
        if (!locked && !/^(workspace:|link:|file:)/.test(ref))
          errors.push("A pnpm importer resolution is missing from packages.");
        if (locked && !snapshots[snapshotKey])
          errors.push("A pnpm importer resolution is missing from snapshots.");
        dependencies.push(
          dependency(
            `${importer}/${name}/${ref}`,
            name,
            version,
            string(resolution?.tarball),
            declaration,
            actualName,
            ref.startsWith("link:"),
          ),
        );
        direct.add(snapshotKey);
      }
    }
    for (const declaration of declared) {
      if (!dependencies.some((d) => d.importer === importer && d.name === declaration.name)) {
        if (dependencies.length >= 10000)
          throw new InputError("The project exceeds 10,000 dependency records.", "unsupported");
        errors.push("A requested dependency is missing from the pnpm lockfile.");
        dependencies.push(
          dependency(`${importer}/${declaration.name}`, declaration.name, null, null, declaration),
        );
      }
    }
  }
  // Snapshot keys retain peer-context identity; package metadata alone does not describe the installed resolution.
  for (const [key, value] of Object.entries(snapshots)) {
    object(value);
    const parsed = pnpmIdentity(key);
    if (!parsed) {
      errors.push("A pnpm snapshot identity is unsupported.");
      continue;
    }
    if (direct.has(key)) continue;
    if (dependencies.length >= 10000)
      throw new InputError("The project exceeds 10,000 dependency records.", "unsupported");
    const entry = packages[`${parsed.name}@${parsed.version}`]
      ? object(packages[`${parsed.name}@${parsed.version}`])
      : null;
    if (!entry) errors.push("A pnpm snapshot has no package resolution metadata.");
    const resolution = entry?.resolution === undefined ? null : object(entry.resolution);
    dependencies.push(dependency(key, parsed.name, parsed.version, string(resolution?.tarball)));
  }
  return {
    packageManager: "pnpm",
    manifestPath: "package.json",
    lockfilePath: "pnpm-lock.yaml",
    dependencies,
    errors,
    inputFingerprint: "",
    coverage: [
      "pnpm lockfile v9: workspace importers and resolved snapshots",
      `${Object.keys(importers).length} selected workspace importer(s)`,
      "Lockfile evidence only; node_modules is not inspected",
    ],
  };
}

async function bunInputs(
  read: ProjectReader,
  manifest: Record<string, unknown>,
  text: string,
): Promise<ProjectInputs> {
  let lock: Record<string, unknown>;
  try {
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, { allowTrailingComma: true });
    if (!tree || errors.length) throw new Error();
    // getNodeValue uses null-prototype objects; repository keys cannot set prototypes.
    lock = object(getNodeValue(tree));
  } catch {
    throw new InputError("The Bun text lockfile is malformed.");
  }
  if (lock.lockfileVersion !== 0 && lock.lockfileVersion !== 1)
    throw new InputError("Only Bun text lockfile versions 0 and 1 are supported.", "unsupported");
  const workspaces = object(lock.workspaces);
  const packages = object(lock.packages);
  const workspaceEntries = Object.entries(workspaces);
  if (workspaceEntries.length > 100 || Object.keys(packages).length > 10000)
    throw new InputError("The lockfile exceeds 100 importers or 10,000 packages.", "unsupported");
  if (!Object.hasOwn(workspaces, ""))
    throw new InputError("The Bun lockfile has no root workspace.");
  // Check all workspace paths before asking either the filesystem or provider to read them.
  for (const [path] of workspaceEntries)
    if (
      path &&
      (isAbsolute(path) ||
        path.includes("\\") ||
        path.split("/").some((p) => !p || p === "." || p === ".."))
    )
      throw new InputError("A Bun workspace path escapes the selected project.");

  const resolved = new Map<
    string,
    { name: string; version: string; registry: string | null; alias: string }
  >();
  for (const [location, raw] of Object.entries(packages)) {
    const parts = location.split("/");
    const names: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const name = part.startsWith("@") ? `${part}/${parts[++index] ?? ""}` : part;
      if (!packageName(name) || name === "." || name === "..")
        throw new InputError("A Bun package location is malformed.");
      names.push(name);
    }
    if (!Array.isArray(raw) || !raw.length || raw.length > 4)
      throw new InputError("A Bun package resolution is malformed.");
    const resolution = string(raw[0])?.match(/^((?:@[^/]+\/)?[^@]+)@(.+)$/);
    if (!resolution || !packageName(resolution[1]!))
      throw new InputError("A Bun resolved package identity is malformed.");
    const version = resolution[2]!;
    const registry = semver.valid(version) ? string(raw[1]) : null;
    if (semver.valid(version)) {
      if (raw.length !== 4 || registry === null || string(raw[3]) === null)
        throw new InputError("A Bun registry resolution is malformed.");
      object(raw[2]);
    } else if (raw.length > 1) object(raw[1]);
    resolved.set(location, {
      name: resolution[1]!,
      version,
      registry: registry || null,
      alias: names.at(-1)!,
    });
  }
  const workspaceConfig =
    manifest.workspaces && !Array.isArray(manifest.workspaces) ? object(manifest.workspaces) : {};
  const currentCatalogs = {
    catalog: manifest.catalog ?? workspaceConfig.catalog,
    catalogs: manifest.catalogs ?? workspaceConfig.catalogs,
  };
  const catalogRange = (source: Record<string, unknown>, requested: string, name: string) => {
    const group = requested.slice("catalog:".length).trim();
    const catalogs = object(source.catalogs ?? {});
    const selected =
      !group || group === "default" ? (source.catalog ?? catalogs.default) : catalogs[group];
    return selected === undefined ? null : string(object(selected)[name]);
  };
  const dependencies: Dependency[] = [];
  const errors: string[] = [];
  const direct = new Set<string>();
  const add = (record: Dependency) => {
    if (dependencies.length >= 10000)
      throw new InputError("The project exceeds 10,000 dependency records.", "unsupported");
    dependencies.push(record);
  };
  for (const [path, value] of workspaceEntries) {
    const importer = path || ".";
    const metadata = object(value);
    const workspaceName = string(metadata.name);
    if (path && (!workspaceName || !packageName(workspaceName)))
      throw new InputError("A Bun workspace identity is malformed.");
    const input = path ? await read(`${path}/package.json`, 1024 * 1024) : null;
    if (path && input === null) errors.push("A workspace importer has no readable package.json.");
    const actual = path ? (input === null ? null : parseJson(input)) : manifest;
    const locked = declarations(metadata, importer);
    const declared = actual ? declarations(actual, importer) : locked;
    if (
      actual &&
      (declared.length !== locked.length ||
        declared.some((d) => locked.find((l) => l.name === d.name)?.requested !== d.requested))
    )
      errors.push("A manifest dependency differs from the Bun workspace declaration.");
    for (const declaration of declared) {
      const location =
        path && resolved.has(`${workspaceName}/${declaration.name}`)
          ? `${workspaceName}/${declaration.name}`
          : declaration.name;
      const entry = resolved.get(location);
      if (!entry) errors.push("A requested dependency is missing from the Bun lockfile.");
      const catalog = declaration.requested.startsWith("catalog:");
      const effective = catalog
        ? catalogRange(currentCatalogs, declaration.requested, declaration.name)
        : declaration.requested;
      if (
        catalog &&
        (!effective || effective !== catalogRange(lock, declaration.requested, declaration.name))
      )
        errors.push(
          "A Bun catalog dependency is missing or differs from the root manifest catalog.",
        );
      const expected = alias(effective, declaration.name);
      if (entry && expected.packageName !== entry.name)
        errors.push("A Bun alias target differs between manifest and lockfile.");
      if (
        entry &&
        expected.range &&
        semver.validRange(expected.range) &&
        semver.valid(entry.version) &&
        !semver.satisfies(entry.version, expected.range)
      )
        errors.push("A resolved Bun version does not satisfy the current manifest range.");
      const record = dependency(
        `bun:${importer}/${location}`,
        declaration.name,
        entry?.version ?? null,
        entry?.registry ?? null,
        { ...declaration, requested: effective ?? declaration.requested },
        entry?.name ?? expected.packageName,
        entry?.version.startsWith("workspace:") ?? false,
      );
      add({
        ...record,
        requested: declaration.requested,
        ...(catalog
          ? {
              requestedRange:
                expected.range && semver.validRange(expected.range) ? expected.range : null,
            }
          : {}),
      });
      if (entry) direct.add(location);
    }
  }
  for (const [location, entry] of resolved)
    if (!direct.has(location))
      add(
        dependency(
          `bun:${location}`,
          entry.alias,
          entry.version,
          entry.registry,
          undefined,
          entry.name,
          entry.version.startsWith("workspace:"),
        ),
      );

  const bunfig = await read("bunfig.toml", 100 * 1024);
  if (bunfig !== null) {
    let configuration;
    try {
      configuration = decodeBunConfiguration(bunfig);
    } catch {
      throw new InputError("Bun project registry configuration cannot be read safely.");
    }
    const privateRegistry = configuration.registry !== null && configuration.registry !== "public";
    const blocked = new Set(configuration.blockedScopes);
    for (let index = 0; index < dependencies.length; index++) {
      const dep = dependencies[index]!;
      if (
        dep.origin === "registry" &&
        (privateRegistry || blocked.has(dep.packageName.split("/")[0]!))
      )
        dependencies[index] = {
          ...dep,
          origin: "unknown",
          advisoryStatus: "unsupported",
          versionStatus: "unsupported",
        };
    }
  }
  return {
    packageManager: "bun",
    manifestPath: "package.json",
    lockfilePath: "bun.lock",
    dependencies,
    errors,
    // Configuration content stays out of persisted evidence; its digest affects freshness.
    inputFingerprint: createHash("sha256")
      .update(bunfig ?? "")
      .digest("hex"),
    coverage: [
      `Bun text lockfile v${lock.lockfileVersion}: workspace, catalog, and resolved package evidence`,
      `${workspaceEntries.length} selected workspace importer(s)`,
      "Lockfile evidence only; node_modules is not inspected",
      "Bun registry classification uses lockfile resolutions and selected-root bunfig.toml; user/global/environment configuration is not inspected",
    ],
  };
}

export async function inspectProject(root: string): Promise<ProjectInputs> {
  const canonical = await selectDirectory(root);
  if (canonical !== root)
    throw new InputError("The selected directory identity changed; select it again.");
  return inspectProjectFiles((name, limit) => readSelectedFile(root, name, limit));
}

export async function inspectProjectFiles(read: ProjectReader): Promise<ProjectInputs> {
  const manifestText = await read("package.json", 1024 * 1024);
  if (manifestText === null)
    throw new InputError(
      "No package.json was found. Other ecosystems are not supported yet.",
      "unsupported",
    );
  const manifest = parseJson(manifestText);
  const npm = await read("package-lock.json");
  const pnpm = await read("pnpm-lock.yaml");
  const bun = await read("bun.lock");
  if ([npm, pnpm, bun].filter((text) => text !== null).length > 1)
    throw new InputError(
      "Multiple package-manager lockfiles exist; select one package manager.",
      "unsupported",
    );
  if (npm === null && pnpm === null && bun === null)
    throw new InputError(
      "No supported lockfile (package-lock.json, pnpm-lock.yaml, or bun.lock) was found. Binary bun.lockb is not supported. A manifest alone cannot establish resolved dependencies.",
      "unsupported",
    );
  const inputs =
    npm !== null
      ? await npmInputs(read, manifest, npm)
      : pnpm !== null
        ? await pnpmInputs(read, pnpm)
        : await bunInputs(read, manifest, bun!);
  const npmrc = await read(".npmrc", 100 * 1024);
  const blockedScopes = new Set<string>();
  let privateRegistry = false;
  if (npmrc) {
    for (const line of npmrc.split(/\r?\n/)) {
      const match = line.match(/^\s*(@[^:]+:)?registry\s*=\s*(\S+)/);
      if (match && match[2]?.replace(/\/$/, "") !== "https://registry.npmjs.org") {
        if (match[1]) blockedScopes.add(match[1].slice(0, -1));
        else privateRegistry = true;
      }
    }
  }
  inputs.dependencies = inputs.dependencies.map((dep) => {
    if (
      dep.origin === "registry" &&
      (privateRegistry || blockedScopes.has(dep.packageName.split("/")[0] ?? ""))
    ) {
      return {
        ...dep,
        origin: "unknown",
        advisoryStatus: "unsupported",
        versionStatus: "unsupported",
      };
    }
    return dep;
  });
  const internal = inputs.dependencies.filter(
    (d) => d.origin === "workspace" || d.origin === "local",
  );
  if (internal.length)
    inputs.coverage.push(
      `${internal.length} internal workspace/local dependency records: public-registry updates and OSV npm queries are not applicable`,
    );
  const excluded = inputs.dependencies.filter(
    (d) =>
      d.origin !== "workspace" &&
      d.origin !== "local" &&
      (d.origin !== "registry" || !d.resolved || !semver.valid(d.resolved)),
  );
  if (excluded.length)
    inputs.errors.push(
      `${excluded.length} Git, private, unknown, or unresolved dependencies cannot use public-registry checks.`,
    );
  inputs.errors = [...new Set(inputs.errors)];
  inputs.coverage.push(
    "Registry-origin classification uses the selected root .npmrc and lockfile URLs; user/global/ancestor/environment npm configuration is not inspected",
  );
  inputs.inputFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        manifestText,
        npm ?? pnpm ?? bun,
        npmrc,
        inputs.inputFingerprint,
        inputs.dependencies.map((dep) => [
          dep.id,
          dep.name,
          dep.packageName,
          dep.requested,
          dep.resolved,
          dep.origin,
          dep.role,
          dep.importer,
        ]),
      ]),
    )
    .digest("hex");
  return inputs;
}

export const projectLabel = (path: string) => basename(path) || "Selected project";
export const requestedRange = (dep: Dependency) =>
  dep.requestedRange !== undefined
    ? dep.requestedRange
    : alias(dep.requested, dep.packageName).range;
