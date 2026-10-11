import type { Dependency, Installation, Project } from "@versionstead/contracts/monitoring";
import { parseSemver, updateKind, versionAtLeast } from "./versions.ts";

// Commands for the owner to copy and run themselves; nothing in Versionstead runs them.
// Every value that reaches one is validated here, because it came from a lockfile.

// Mirrors the coordinator's package-name check (apps/server/src/adapters/projects.ts).
const validName = (name: string) =>
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) && name.length <= 214;

export const npmPackageUrl = (name: string) =>
  validName(name) ? `https://www.npmjs.com/package/${name}` : null;

const plainPath = /^[A-Za-z0-9._/-]+$/;
// Anything else a workspace name may hold is double-quoted, and only from this alphabet: letters
// and digits of any script, space, and @ + ~. Every other character yields no command, among them
// & | ; < > ^ % ! $ ` \ " ' ( ) # , = and wildcards, control or look-alike characters. Quoting
// is no defense for those: cmd.exe re-parses the arguments of a .cmd shim (npm, pnpm), and
// PowerShell passes a quoted word without its quotes, so an & ran the rest as another command.
const quotablePath = /^[\p{L}\p{N} ._/@+~-]+$/u;

/** A workspace path as one shell word: bare when plain, double-quoted when it needs it. */
function shellPath(importer: string, prefix = ""): string | null {
  // Not a workspace: an option, or a path with a blank segment (an absolute path has one) or a
  // segment ending in a dot (that covers ".."). pnpm also reads a trailing "..." in a filter as
  // "and its dependencies".
  if (
    !importer ||
    importer.startsWith("-") ||
    importer.split("/").some((segment) => !segment.trim() || segment.endsWith("."))
  )
    return null;
  const path = prefix + importer;
  return plainPath.test(path) ? path : quotablePath.test(path) ? `"${path}"` : null;
}

type Role = Exclude<Dependency["role"], "transitive">;

const roleFlags = {
  npm: { production: "", development: "--save-dev", optional: "--save-optional" },
  pnpm: { production: "", development: "-D", optional: "-O" },
  bun: { production: "", development: "--dev", optional: "--optional" },
} as const;

/**
 * `name@version` for a registry dependency at an exact version, or null when no command is safe:
 * aliases, workspace/git/local/unknown sources, transitive dependencies, an invalid name or version.
 */
function upgradeSpec(
  dependency: Pick<Dependency, "name" | "packageName" | "requested" | "origin" | "role">,
  version: string | null,
): string | null {
  return dependency.origin !== "registry" ||
    dependency.role === "transitive" ||
    dependency.name !== dependency.packageName ||
    dependency.requested?.startsWith("npm:") ||
    !validName(dependency.packageName) ||
    version === null ||
    !parseSemver(version)
    ? null
    : `${dependency.packageName}@${version}`;
}

/** One command adding exact specs to one workspace with one dependency role, or null when it cannot be built safely. */
function addCommand(
  project: {
    packageManager: Project["packageManager"];
    pnpmWorkspace?: boolean | undefined;
    dependencies: readonly Pick<Dependency, "role" | "importer">[];
  },
  importer: string,
  role: Role,
  specs: readonly string[],
): string | null {
  const manager = project.packageManager;
  if (manager === "unknown" || specs.length === 0) return null;
  const flag = roleFlags[manager][role];
  const root = importer === ".";
  const path = root ? "" : shellPath(importer, manager === "pnpm" ? "./" : "");
  if (path === null) return null;
  const words =
    manager === "npm"
      ? ["npm install", ...specs, flag, root ? "" : `--workspace ${path}`]
      : manager === "bun"
        ? ["bun add", ...specs, flag, root ? "" : `--cwd ${path}`]
        : root
          ? [
              "pnpm add",
              ...specs,
              flag,
              // pnpm refuses to add to a workspace root without -w. Evidence from a coordinator before
              // pnpmWorkspace knows a workspace only from its packages' dependency records.
              project.pnpmWorkspace === true ||
              project.dependencies.some((d) => d.role !== "transitive" && d.importer !== ".")
                ? "-w"
                : "",
            ]
          : ["pnpm --filter", path, "add", ...specs, flag];
  return words.filter(Boolean).join(" ");
}

/**
 * The command that adds a registry dependency at an exact version, or null when none is safe:
 * aliases, workspace/git/local/unknown sources, transitive dependencies, an unknown package
 * manager, an invalid name or version, and workspace paths that cannot be quoted.
 */
export function dependencyUpgradeCommand(
  project: {
    packageManager: Project["packageManager"];
    pnpmWorkspace?: boolean | undefined;
    dependencies: readonly Pick<Dependency, "role" | "importer">[];
  },
  dependency: Pick<
    Dependency,
    "name" | "packageName" | "requested" | "origin" | "role" | "importer"
  >,
  version: string | null,
): string | null {
  const spec = upgradeSpec(dependency, version);
  return spec === null || dependency.role === "transitive"
    ? null
    : addCommand(project, dependency.importer, dependency.role, [spec]);
}

export type UpgradeScope = "compatible" | "major";
export type ProjectUpgradeCommand = {
  where: string;
  role: Role;
  command: string;
  packages: number;
};
export type ProjectUpgradePlan = {
  commands: ProjectUpgradeCommand[];
  /** Packages with a candidate but no safe command: aliases, other sources, unquotable workspaces. */
  unsupported: number;
  /** Packages a snooze or ignore rule hides. */
  held: number;
  /** Packages whose release is younger than the release cooldown: left out until it is old enough. */
  tooNew: number;
  /** Direct registry packages whose version lookup did not finish: no candidate is known, which is not "up to date". */
  unchecked: number;
};

/** The greater of two candidate versions, or whichever exists. */
const greater = (a: string | null, b: string | null) =>
  a === null || b === null ? (a ?? b) : versionAtLeast(a, b) ? a : b;

const roles: readonly Role[] = ["production", "development", "optional"];
const roleLabels: Record<Role, string> = {
  production: "dependencies",
  development: "devDependencies",
  optional: "optionalDependencies",
};

/**
 * One command per workspace and dependency type for every direct registry dependency with a checked
 * candidate: compatible updates only (never a major version), or the latest release when majors are
 * included. The save flag applies to a whole command, so each dependency type gets its own. Packages
 * a command cannot name safely, packages the owner snoozed or ignored, releases younger than the
 * release cooldown (`young`: dependency id to the release whose age is known), and packages whose
 * lookup did not finish are counted instead.
 */
export function projectUpgradeCommands(
  project: Pick<Project, "packageManager" | "pnpmWorkspace" | "dependencies">,
  scope: UpgradeScope,
  held: ReadonlySet<string> = new Set(),
  young: ReadonlyMap<string, string> = new Map(),
): ProjectUpgradePlan {
  const groups = new Map<string, { importer: string; role: Role; specs: Set<string> }>();
  let unsupported = 0;
  let heldCount = 0;
  let tooNew = 0;
  let unchecked = 0;
  for (const dependency of project.dependencies) {
    if (dependency.role === "transitive") continue;
    if (dependency.versionStatus !== "checked") {
      if (dependency.origin === "registry") unchecked += 1;
      continue;
    }
    const version =
      scope === "major"
        ? greater(dependency.latestVersion, dependency.availableVersion)
        : dependency.availableVersion !== null &&
            updateKind(dependency.resolved, dependency.availableVersion) !== "major"
          ? dependency.availableVersion
          : null;
    if (version === null) continue;
    if (held.has(dependency.id)) {
      heldCount += 1;
      continue;
    }
    if (young.get(dependency.id) === version) {
      tooNew += 1;
      continue;
    }
    const spec = upgradeSpec(dependency, version);
    if (spec === null) {
      unsupported += 1;
      continue;
    }
    const key = JSON.stringify([dependency.importer, dependency.role]);
    const group = groups.get(key) ?? {
      importer: dependency.importer,
      role: dependency.role,
      specs: new Set<string>(),
    };
    group.specs.add(spec);
    groups.set(key, group);
  }
  const commands: ProjectUpgradeCommand[] = [];
  const ordered = [...groups.values()].sort(
    (a, b) =>
      Number(b.importer === ".") - Number(a.importer === ".") ||
      a.importer.localeCompare(b.importer) ||
      roles.indexOf(a.role) - roles.indexOf(b.role),
  );
  for (const group of ordered) {
    const specs = [...group.specs].sort();
    const command = addCommand(project, group.importer, group.role, specs);
    if (command === null) unsupported += specs.length;
    else
      commands.push({
        where: `${group.importer === "." ? "root" : group.importer} · ${roleLabels[group.role]}`,
        role: group.role,
        command,
        packages: specs.length,
      });
  }
  return { commands, unsupported, held: heldCount, tooNew, unchecked };
}

/**
 * What the Upgrade commands dialog says when it has no command. It never reads as "no updates"
 * while a package could not be checked; the counts of what was left out are shown beside it.
 */
export function upgradeEmptyText(unchecked: number, major: boolean): string {
  return unchecked > 0
    ? "No checked package has a command to copy."
    : major
      ? "No update to copy."
      : "No compatible update to copy.";
}

/** The command that installs a global registry package at an exact version, or null. */
export function globalUpgradeCommand(
  installation: {
    manager?: Installation["manager"] | undefined;
    name: string;
    packageId?: string | undefined;
    origin?: Installation["origin"] | undefined;
  },
  version: string | null,
): string | null {
  const name = installation.packageId ?? installation.name;
  if (
    !installation.manager ||
    installation.origin !== "registry" ||
    // A package identity that differs from the installed name is an alias.
    name !== installation.name ||
    !validName(name) ||
    version === null ||
    !parseSemver(version)
  )
    return null;
  return installation.manager === "npm"
    ? `npm install --global ${name}@${version}`
    : `bun add --global ${name}@${version}`;
}
