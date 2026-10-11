import semver from "semver";
import type { Dependency, GlobalToolSource } from "@versionstead/contracts/monitoring";
import type { DeclaredRuntime, LifecycleProduct } from "./lifecycle.ts";

const versionLine = /^v?(\d{1,4})(?:\.\d{1,6}){0,2}$/;
// A version-manager alias that is safe to repeat in a note; anything else is not echoed.
const safeAlias = /^[A-Za-z0-9/*._-]{1,40}$/;
const pnpmManager = /^pnpm@(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

type Found = Map<string, DeclaredRuntime>;

function add(
  found: Found,
  product: LifecycleProduct,
  cycle: string,
  version: string,
  source: string,
) {
  const key = `${product}@${cycle}`;
  const existing = found.get(key);
  if (!existing) found.set(key, { product, cycle, version, sources: [source] });
  else if (!existing.sources.includes(source)) existing.sources.push(source);
}

function versionFile(
  name: ".nvmrc" | ".node-version",
  text: string | null,
  found: Found,
  notes: string[],
) {
  const line = text
    ?.split(/\r?\n/)
    .map((entry) => entry.replace(/#.*$/, "").trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) return;
  const match = versionLine.exec(line);
  if (match) add(found, "nodejs", String(Number(match[1])), line.replace(/^v/, ""), name);
  else
    notes.push(
      safeAlias.test(line)
        ? `${name} names "${line}"; only numeric Node.js versions are checked for end of life.`
        : `${name} has an unsupported value; its Node.js end of life was not checked.`,
    );
}

/**
 * The runtime lines a project declares: the lowest major `engines.node` allows, numeric `.nvmrc` and
 * `.node-version` versions, a pnpm `packageManager`, and each locked public `electron` version. One
 * entry per product and major lists every place that declared it; what cannot be read is a note.
 */
export function declaredRuntimes(
  manifest: Record<string, unknown>,
  files: { nvmrc: string | null; nodeVersion: string | null },
  dependencies: readonly Dependency[],
): { runtimes: DeclaredRuntime[]; notes: string[] } {
  const found: Found = new Map();
  const notes: string[] = [];
  const engines = manifest.engines;
  const range =
    engines && typeof engines === "object" && !Array.isArray(engines)
      ? (engines as Record<string, unknown>).node
      : undefined;
  if (typeof range === "string" && range.trim()) {
    const minimum =
      range.length <= 200 && semver.validRange(range) !== null ? semver.minVersion(range) : null;
    if (!minimum)
      notes.push(
        "engines.node is not a valid SemVer range; its Node.js end of life was not checked.",
      );
    else if (minimum.major === 0)
      notes.push(
        "engines.node does not set a minimum Node.js major version; its end of life was not checked.",
      );
    else add(found, "nodejs", String(minimum.major), range.trim(), "engines.node");
  }
  versionFile(".nvmrc", files.nvmrc, found, notes);
  versionFile(".node-version", files.nodeVersion, found, notes);
  const manager = manifest.packageManager;
  if (typeof manager === "string" && manager.length <= 300) {
    const pnpm = pnpmManager.exec(manager);
    if (pnpm)
      add(
        found,
        "pnpm",
        String(Number(pnpm[1])),
        manager.split("+")[0]!.slice(5),
        "packageManager",
      );
    else {
      const other = /^(npm|yarn|bun)@/.exec(manager)?.[1];
      if (other) notes.push(`packageManager names ${other}; only pnpm's end of life is checked.`);
    }
  }
  for (const dependency of dependencies)
    if (
      dependency.packageName === "electron" &&
      dependency.origin === "registry" &&
      dependency.resolved &&
      semver.valid(dependency.resolved)
    )
      add(
        found,
        "electron",
        String(semver.major(dependency.resolved)),
        dependency.resolved,
        "electron in the lockfile",
      );
  return { runtimes: [...found.values()], notes };
}

/**
 * This PC's runtime lines: the Node.js on the owner's PATH and Bun, as captured with the global tool
 * sources. A runtime that is there but could not be read adds a note and makes the check incomplete,
 * so its previous findings are kept; one that is not installed is simply absent.
 */
export function pcRuntimes(managers: readonly GlobalToolSource[]): {
  runtimes: DeclaredRuntime[];
  notes: string[];
  complete: boolean;
} {
  const found: Found = new Map();
  const notes: string[] = [];
  const node = managers.find((source) => source.manager === "npm")?.nodeVersion;
  if (node && semver.valid(node))
    add(found, "nodejs", String(semver.major(node)), node, "Node.js on the owner's PATH");
  else
    notes.push(
      "The Node.js version on the owner's PATH was not captured; its end of life was not checked.",
    );
  const bun = managers.find((source) => source.manager === "bun");
  if (bun && bun.status !== "not-installed") {
    if (bun.version && semver.valid(bun.version))
      add(found, "bun", String(semver.major(bun.version)), bun.version, "Bun on this PC");
    else notes.push("Bun's version could not be read; its end of life was not checked.");
  }
  return { runtimes: [...found.values()], notes, complete: notes.length === 0 };
}
