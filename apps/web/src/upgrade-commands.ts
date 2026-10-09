import type { Dependency, Installation, Project } from "@versionstead/contracts/monitoring";
import { parseSemver } from "./versions.ts";

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

const roleFlags = {
  npm: { production: "", development: "--save-dev", optional: "--save-optional" },
  pnpm: { production: "", development: "-D", optional: "-O" },
  bun: { production: "", development: "--dev", optional: "--optional" },
} as const;

/**
 * The command that adds a registry dependency at an exact version, or null when none is safe:
 * aliases, workspace/git/local/unknown sources, transitive dependencies, an unknown package
 * manager, an invalid name or version, and workspace paths that cannot be quoted.
 */
export function dependencyUpgradeCommand(
  project: {
    packageManager: Project["packageManager"];
    dependencies: readonly Pick<Dependency, "role" | "importer">[];
  },
  dependency: Pick<
    Dependency,
    "name" | "packageName" | "requested" | "origin" | "role" | "importer"
  >,
  version: string | null,
): string | null {
  const manager = project.packageManager;
  if (
    manager === "unknown" ||
    dependency.origin !== "registry" ||
    dependency.role === "transitive" ||
    dependency.name !== dependency.packageName ||
    dependency.requested?.startsWith("npm:") ||
    !validName(dependency.packageName) ||
    version === null ||
    !parseSemver(version)
  )
    return null;
  const spec = `${dependency.packageName}@${version}`;
  const flag = roleFlags[manager][dependency.role];
  const root = dependency.importer === ".";
  const path = root ? "" : shellPath(dependency.importer, manager === "pnpm" ? "./" : "");
  if (path === null) return null;
  const words =
    manager === "npm"
      ? ["npm install", spec, flag, root ? "" : `--workspace ${path}`]
      : manager === "bun"
        ? ["bun add", spec, flag, root ? "" : `--cwd ${path}`]
        : root
          ? [
              "pnpm add",
              spec,
              flag,
              // pnpm refuses to add to a workspace root without -w.
              project.dependencies.some((d) => d.role !== "transitive" && d.importer !== ".")
                ? "-w"
                : "",
            ]
          : ["pnpm --filter", path, "add", spec, flag];
  return words.filter(Boolean).join(" ");
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
