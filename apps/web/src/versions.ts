import type { Dependency } from "@versionstead/contracts/monitoring";

// Strict SemVer 2.0.0. Anything else is not classified or compared.
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type Semver = { core: number[]; pre: string[] };

export function parseSemver(value: string | null | undefined): Semver | null {
  const match = value ? semverPattern.exec(value) : null;
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  return core.every(Number.isSafeInteger) ? { core, pre: match[4]?.split(".") ?? [] } : null;
}

// SemVer precedence: build metadata is ignored and a release outranks its own prereleases.
function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    const difference = a.core[i]! - b.core[i]!;
    if (difference) return Math.sign(difference);
  }
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numeric[0] && numeric[1]) return Math.sign(Number(x) - Number(y));
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether `version` is at least `minimum`; false when either is not SemVer. */
export function versionAtLeast(
  version: string | null | undefined,
  minimum: string | null | undefined,
): boolean {
  const a = parseSemver(version);
  const b = parseSemver(minimum);
  return !!a && !!b && compareSemver(a, b) >= 0;
}

export type UpdateKind = "major" | "minor" | "patch" | "prerelease";

/**
 * How far an update moves, or null when either version is not SemVer or the candidate is not
 * newer. The numeric change decides, with caret semantics for 0.x (^0.2.3 stops at 0.3.0 and
 * ^0.0.3 at 0.0.4, so those bumps are "major"); whether the target is a prerelease is a separate
 * fact that updateBadge marks. When only the prerelease tag differs, the target is either another
 * prerelease ("prerelease") or the stable release of the same version, which is inside the
 * prerelease's own caret range and so a "patch".
 */
export function updateKind(
  installed: string | null | undefined,
  candidate: string | null | undefined,
): UpdateKind | null {
  const from = parseSemver(installed);
  const to = parseSemver(candidate);
  if (!from || !to || compareSemver(to, from) <= 0) return null;
  if (to.core.every((part, index) => part === from.core[index]))
    return to.pre.length ? "prerelease" : "patch";
  if (to.core[0] !== from.core[0]) return "major";
  if (from.core[0] === 0 && (to.core[1] !== from.core[1] || from.core[1] === 0)) return "major";
  return to.core[1] !== from.core[1] ? "minor" : "patch";
}

const updateBadges = {
  major: { label: "Major", tone: "warning" },
  minor: { label: "Minor", tone: "neutral" },
  patch: { label: "Patch", tone: "neutral" },
  prerelease: { label: "Prerelease", tone: "neutral" },
} as const;

/**
 * The badge for an update's kind. A "major" that only caret rules made major says why, and an
 * unstable target carries a prerelease marker (the "prerelease" kind already says so).
 */
export function updateBadge(
  installed: string | null | undefined,
  candidate: string | null | undefined,
): { label: string; tone: "warning" | "neutral"; title?: string; prerelease?: true } | null {
  const kind = updateKind(installed, candidate);
  if (!kind) return null;
  return {
    ...updateBadges[kind],
    ...(kind === "major" && installed?.startsWith("0.") && candidate?.startsWith("0.")
      ? { title: "0.x releases can include breaking changes" }
      : {}),
    ...(kind !== "prerelease" && parseSemver(candidate)?.pre.length
      ? { prerelease: true as const }
      : {}),
  };
}

export function versionCandidate(
  dependency: Pick<Dependency, "availableVersion" | "latestVersion" | "versionStatus">,
  kind: "any" | "compatible" | "latest" = "any",
): string {
  const { availableVersion, latestVersion, versionStatus } = dependency;
  const version =
    kind === "compatible"
      ? availableVersion
      : kind === "latest"
        ? latestVersion
        : (availableVersion ?? latestVersion);
  if (version) {
    const prefix = kind === "any" && !availableVersion ? "Latest " : "";
    return `${prefix}${version}${versionStatus === "checked" ? "" : versionStatus === "failed" ? " · previous, unverified" : " · unverified"}`;
  }
  if (versionStatus === "checked")
    return kind === "compatible" ? "No compatible update found" : "No newer release found";
  if (versionStatus === "failed") return "Lookup failed";
  if (versionStatus === "unsupported") return "Not covered";
  return "Not checked";
}
