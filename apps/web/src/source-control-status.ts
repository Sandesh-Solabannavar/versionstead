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
