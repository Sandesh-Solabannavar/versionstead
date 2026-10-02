import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import semver from "semver";
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

async function npmInputs(
  root: string,
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
    const input = await readSelectedFile(root, `${path}/package.json`, 1024 * 1024);
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

async function pnpmInputs(root: string, text: string): Promise<ProjectInputs> {
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
    const manifest = await readSelectedFile(root, importerPath, 1024 * 1024);
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

export async function inspectProject(root: string): Promise<ProjectInputs> {
  const canonical = await selectDirectory(root);
  if (canonical !== root)
    throw new InputError("The selected directory identity changed; select it again.");
  const manifestText = await readSelectedFile(root, "package.json", 1024 * 1024);
  if (manifestText === null)
    throw new InputError(
      "No package.json was found. Other ecosystems are not supported yet.",
      "unsupported",
    );
  const manifest = parseJson(manifestText);
  const npm = await readSelectedFile(root, "package-lock.json");
  const pnpm = await readSelectedFile(root, "pnpm-lock.yaml");
  if (npm !== null && pnpm !== null)
    throw new InputError(
      "Both npm and pnpm lockfiles exist; select one package manager.",
      "unsupported",
    );
  if (npm === null && pnpm === null)
    throw new InputError(
      "No supported lockfile was found. A manifest alone cannot establish resolved dependencies.",
      "unsupported",
    );
  const inputs =
    npm !== null ? await npmInputs(root, manifest, npm) : await pnpmInputs(root, pnpm!);
  const npmrc = await readSelectedFile(root, ".npmrc", 100 * 1024);
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
  const excluded = inputs.dependencies.filter(
    (d) => d.origin !== "registry" || !d.resolved || !semver.valid(d.resolved),
  );
  if (excluded.length)
    inputs.errors.push(
      `${excluded.length} workspace, local, Git, private, or unresolved dependencies cannot use public-registry checks.`,
    );
  inputs.errors = [...new Set(inputs.errors)];
  inputs.coverage.push(
    "Registry-origin classification uses the selected root .npmrc and lockfile URLs; user/global/ancestor/environment npm configuration is not inspected",
  );
  inputs.inputFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        manifestText,
        npm ?? pnpm,
        npmrc,
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
export const requestedRange = (dep: Dependency) => alias(dep.requested, dep.packageName).range;
