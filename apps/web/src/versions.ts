import type { Dependency } from "@versionstead/contracts/monitoring";

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
