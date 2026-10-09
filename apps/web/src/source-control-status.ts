import type { ApplicationSnapshot, ProviderConnection } from "@versionstead/contracts/application";

// CLI discovery and a validated provider account are separate capabilities.
export function providerPresentation(
  provider: ProviderConnection,
  tool: ApplicationSnapshot["tools"]["github"],
) {
  if (provider.error)
    return { status: "attention" as const, badge: "Needs attention", description: provider.error };
  if (provider.account)
    return {
      status: provider.enabled ? ("available" as const) : ("inactive" as const),
      badge: provider.enabled ? null : "Paused",
      description: `Authenticated as ${provider.account}${provider.enabled ? "" : " · Repository scans paused"}`,
    };
  const executable = provider.kind === "github" ? "gh" : "glab";
  return {
    status: "attention" as const,
    badge: "Not authenticated",
    description: tool.available
      ? `Available. Connect with a read-only token or your signed-in ${executable} CLI.`
      : `${executable} CLI is not installed on this PC. Connect with a read-only token to scan selected repositories.`,
  };
}

/** Why protected connections are off on this monitoring host, or null when they are available. An
 * older coordinator sends no reason, so it gets a generic one rather than a Windows-only one. */
export function credentialStorageMessage(
  app: Pick<ApplicationSnapshot, "credentialStorageAvailable" | "credentialStorageIssue">,
) {
  if (app.credentialStorageAvailable) return null;
  return (
    app.credentialStorageIssue ??
    "This monitoring host cannot store protected connection credentials. Restart monitoring to load the current build."
  );
}

const credentialLocations: Record<string, string> = {
  win32: "Stored with Windows DPAPI on this monitoring host.",
  darwin: "Stored in the macOS login keychain of this monitoring host.",
  linux: "Stored in the login keyring (Secret Service) of this monitoring host.",
};
/** Where a connection token is kept, for the coordinator's platform. */
export const credentialStorageLocation = (platform: string) =>
  credentialLocations[platform] ?? "Stored in this monitoring host's protected credential storage.";
