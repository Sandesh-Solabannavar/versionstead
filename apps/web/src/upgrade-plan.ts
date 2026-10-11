import type { Finding, Project } from "@versionstead/contracts/monitoring";
import { heldDependencies } from "./monitoring-view.ts";
import { youngDependencies } from "./release-signals.ts";
import { projectUpgradeCommands, type ProjectUpgradePlan } from "./upgrade-commands.ts";

/**
 * What the Upgrade commands dialog offers: compatible updates, or every checked one when majors are
 * included, without what the owner snoozed or ignored and without releases inside the cooldown.
 */
export function projectUpgradePlan(
  project: Pick<Project, "packageManager" | "pnpmWorkspace" | "dependencies">,
  findings: readonly Finding[],
  major: boolean,
  cooldownDays: number,
  now: number,
): ProjectUpgradePlan {
  return projectUpgradeCommands(
    project,
    major ? "major" : "compatible",
    heldDependencies(project, findings),
    youngDependencies(project, findings, cooldownDays, now),
  );
}

/** What Copy all puts on the clipboard: one command per line, in the order shown. */
export const copyAllText = (plan: Pick<ProjectUpgradePlan, "commands">): string =>
  plan.commands.map((item) => item.command).join("\n");
