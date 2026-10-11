import type { GlobalToolUpdateBatch } from "@versionstead/contracts/global-tool-updates";
import type { Installation, MonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { installationUpdate, ruleLabel } from "./monitoring-view.ts";
import { releaseAge, updateWarnings, type UpdateWarning } from "./release-signals.ts";
import { updateKind, type UpdateKind } from "./versions.ts";

export type UpdateAllEntry = {
  item: Installation;
  /** How far the update moves; Major is called out in the confirmation. */
  kind: UpdateKind | null;
  /** Update now's reasons to ask first: an added install script, a release younger than the cooldown, a deprecated candidate. */
  warnings: UpdateWarning[];
  /** Younger than the release cooldown: left out unless the owner ticks it. */
  tooNew: boolean;
  /** No known release time while the cooldown is on: listed on its own and still included (ruling 4). */
  ageUnknown: boolean;
  /** The owner snoozed or ignored this update: how that rule reads. Listed, but left out unless the owner ticks it. */
  held: string | null;
};

/**
 * The global tools Update all can run: the verified public-registry updates Update now offers. It is
 * the desktop runner's own test, so the confirmation never lists a package the runner would refuse.
 */
export function updatableInstallations(installations: readonly Installation[]): Installation[] {
  return installations.filter(
    (item) =>
      item.updateStatus === "available" &&
      item.origin === "registry" &&
      Boolean(item.rootId && item.packageId && item.manager && item.availableVersion),
  );
}

/** Every global tool Update all can run, by name, with what to ask the owner about each. */
export function updateAllEntries(
  snapshot: Pick<
    MonitoringSnapshot,
    "device" | "findings" | "findingRules" | "inventory" | "settings"
  >,
  now: number,
): UpdateAllEntry[] {
  const cooldownDays = snapshot.settings.releaseCooldownDays ?? 3;
  return updatableInstallations(snapshot.inventory.installations)
    .map((item) => {
      const update = installationUpdate(snapshot.findings, snapshot.device.id, item);
      const warnings = updateWarnings(update, cooldownDays, now);
      const rule = snapshot.findingRules?.find((candidate) => candidate.id === update?.ruleId);
      return {
        item,
        kind: updateKind(item.version, item.availableVersion),
        warnings,
        tooNew: warnings.some((warning) => warning.kind === "too-new"),
        ageUnknown: releaseAge(update?.publishedAt, cooldownDays, now)?.kind === "unknown",
        held: update?.ruleId === undefined ? null : rule ? ruleLabel(rule) : "Snoozed or ignored",
      };
    })
    .sort(
      (a, b) =>
        a.item.name.localeCompare(b.item.name) ||
        (a.item.manager ?? "").localeCompare(b.item.manager ?? ""),
    );
}

const groupHeadings = [
  { title: "Updates", hint: null },
  {
    title: "Release age unknown",
    hint: "No release time is known for these versions. They are included; untick any you want to wait for.",
  },
  { title: "Released within the cooldown", hint: "Left out unless you tick them." },
  {
    title: "Snoozed or ignored",
    hint: "You snoozed or ignored these updates. They are left out unless you tick them.",
  },
] as const;

/**
 * The confirmation's headings, each with the packages listed under it. A package appears once, under
 * the first reason that applies: held by the owner, then younger than the cooldown, then of unknown
 * age. Headings with nothing under them are left out.
 */
export function updateAllGroups(entries: readonly UpdateAllEntry[]) {
  const heading = (entry: UpdateAllEntry) =>
    entry.held !== null ? 3 : entry.tooNew ? 2 : entry.ageUnknown ? 1 : 0;
  return groupHeadings
    .map((group, index) => ({
      ...group,
      items: entries.filter((entry) => heading(entry) === index),
    }))
    .filter((group) => group.items.length > 0);
}

/** The packages ticked when the confirmation opens: everything but releases younger than the cooldown and updates the owner holds. */
export function initialSelection(entries: readonly UpdateAllEntry[]): Set<string> {
  return new Set(
    entries.filter((entry) => !entry.tooNew && entry.held === null).map((entry) => entry.item.id),
  );
}

const settled = new Set(["succeeded", "failed", "skipped"]);

/** One line for the progress panel: how far Update all is, or how it ended. Counts come from the items, never from `stopped`. */
export function batchSummary(
  batch: Pick<GlobalToolUpdateBatch, "status" | "stopped" | "items">,
): string {
  const count = (status: string) => batch.items.filter((item) => item.status === status).length;
  if (batch.status !== "finished") {
    const done = batch.items.filter((item) => settled.has(item.status)).length;
    return `${batch.status === "stopping" ? "Stopping after the current package" : "Updating"}: ${done} of ${batch.items.length} done`;
  }
  return `Update all ${batch.stopped ? "stopped" : "finished"}: ${count("succeeded")} updated, ${count("failed")} failed, ${count("skipped")} not started.`;
}

/**
 * Why a desktop request failed. Electron wraps what a main-process handler throws as "Error invoking
 * remote method '<channel>': Error: <message>"; the owner is shown the message alone.
 */
export function ipcMessage(failure: unknown, fallback: string): string {
  const message =
    failure instanceof Error
      ? failure.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "")
      : "";
  return message || fallback;
}
