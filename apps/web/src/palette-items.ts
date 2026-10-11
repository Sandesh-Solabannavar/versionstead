import type { MonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { failedTargetCount, uniqueRowLabels, workspaceLabel } from "./monitoring-view.ts";
import { searchSettings, settingsSections, type SettingsPath } from "./settings-navigation.ts";

/** At most this many options, so a large workspace stays quick to search and to read. */
export const paletteLimit = 50;

export type PaletteAction =
  | { kind: "go"; to: "/" | "/pc" | "/projects" | "/service" | SettingsPath; hash?: string }
  | { kind: "project"; projectId: string; dependencyId?: string }
  | { kind: "installation"; installationId: string }
  | { kind: "scan"; target: "pc" | "projects" | "all" | "failed"; projectId?: string }
  | { kind: "cancel"; scanId: string }
  | { kind: "pause"; paused: boolean }
  | { kind: "add-project" }
  | { kind: "export" };
export type PaletteItem = { id: string; label: string; detail: string; action: PaletteAction };

const pages = [
  ["/", "Needs attention"],
  ["/pc", "This PC"],
  ["/projects", "Projects"],
  ["/service", "Background service"],
] as const;

/**
 * The palette's options: pages, settings rows (the settings search), projects, direct dependencies
 * and global tools (each opens its evidence sheet), and actions while connected. An empty query lists
 * pages and actions. Labels that start with the query come first; at most `paletteLimit`.
 */
export function paletteItems(
  snapshot: MonitoringSnapshot | null,
  query: string,
  connected: boolean,
): PaletteItem[] {
  const text = query.trim().toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  // Folders can share a name (two checkouts of one repository); the options number the ones that do.
  const names = uniqueRowLabels(
    snapshot?.projects ?? [],
    (project) => project.name,
    (project) => project.id,
  );
  const matches = (item: PaletteItem) =>
    words.every((word) => `${item.label} ${item.detail}`.toLowerCase().includes(word));
  // A package matches by its own name too, so a project's name does not list every package in it.
  const packageMatches = (item: PaletteItem) =>
    matches(item) && words.some((word) => item.label.toLowerCase().includes(word));
  const items: PaletteItem[] = pages
    .map(([to, label]) => ({
      id: `page:${to}`,
      label,
      detail: "Page",
      action: { kind: "go" as const, to },
    }))
    .filter(matches);
  if (words.length) {
    for (const setting of searchSettings(query))
      items.push({
        id: `setting:${setting.id}`,
        label: setting.label,
        detail:
          setting.target === null
            ? "Settings"
            : `Settings › ${settingsSections.find((section) => section.path === setting.path)!.label}`,
        action: {
          kind: "go",
          to: setting.path,
          ...(setting.target ? { hash: setting.target } : {}),
        },
      });
    for (const project of snapshot?.projects ?? []) {
      const item: PaletteItem = {
        id: `project:${project.id}`,
        label: names.get(project.id) ?? project.name,
        detail: "Project",
        action: { kind: "project", projectId: project.id },
      };
      if (matches(item)) items.push(item);
    }
    for (const installation of snapshot?.inventory.installations ?? []) {
      const item: PaletteItem = {
        id: `installation:${installation.id}`,
        label: installation.name,
        detail: `${installation.version} · This PC · ${installation.source}`,
        action: { kind: "installation", installationId: installation.id },
      };
      if (packageMatches(item)) items.push(item);
    }
    // ponytail: one linear pass over every direct dependency per keystroke; index names if it lags.
    for (const project of snapshot?.projects ?? [])
      for (const dependency of project.dependencies) {
        if (dependency.role === "transitive") continue;
        const item: PaletteItem = {
          id: `dependency:${project.id}:${dependency.id}`,
          label: dependency.name,
          detail: `${dependency.resolved ?? dependency.requested ?? "Unresolved"} · ${names.get(project.id) ?? project.name} (${workspaceLabel(dependency.importer)})`,
          action: { kind: "project", projectId: project.id, dependencyId: dependency.id },
        };
        if (packageMatches(item)) items.push(item);
      }
  }
  if (connected && snapshot) {
    const action = (id: string, label: string, run: PaletteAction): PaletteItem => ({
      id: `action:${id}`,
      label,
      detail: "Action",
      action: run,
    });
    const failed = failedTargetCount(snapshot);
    const active = snapshot.scanProgress?.active;
    const actions = [
      // The Scan now buttons for the PC and for all sources are off on an older background host.
      ...(snapshot.inventory.collector === "npm-bun-global-v1"
        ? [
            action("scan-pc", "Scan this PC", { kind: "scan", target: "pc" }),
            action("scan-all", "Scan all sources", { kind: "scan", target: "all" }),
          ]
        : []),
      ...(failed
        ? [action("retry", `Retry failed checks (${failed})`, { kind: "scan", target: "failed" })]
        : []),
      ...(active && !active.writing
        ? [
            action(`cancel:${active.scanId}`, `Cancel scan: ${active.targetLabel}`, {
              kind: "cancel",
              scanId: active.scanId,
            }),
          ]
        : []),
      action(
        "pause",
        snapshot.settings.paused ? "Resume scheduled scans" : "Pause scheduled scans",
        { kind: "pause", paused: !snapshot.settings.paused },
      ),
      action("add-project", "Add project", { kind: "add-project" }),
      action("export", "Export findings", { kind: "export" }),
      // One scan per project only for a query, so the empty palette stays short.
      ...(words.length
        ? snapshot.projects.map((project) =>
            action(`scan:${project.id}`, `Scan ${names.get(project.id) ?? project.name}`, {
              kind: "scan",
              target: "projects",
              projectId: project.id,
            }),
          )
        : []),
    ];
    items.push(...actions.filter(matches));
  }
  const later = (item: PaletteItem) => Number(!item.label.toLowerCase().startsWith(text));
  return items.sort((a, b) => later(a) - later(b)).slice(0, paletteLimit);
}

/**
 * What a key does in the palette input; keys during IME composition belong to the composition, and
 * Enter waits while `stale` (the list still shows an earlier query), so it never runs an option the
 * owner cannot see.
 */
export function paletteKey(
  key: string,
  composing: boolean,
  active: number,
  count: number,
  stale = false,
): { active: number } | { choose: number } | null {
  if (composing || count === 0) return null;
  if (key === "ArrowDown") return { active: (active + 1) % count };
  if (key === "ArrowUp") return { active: (active + count - 1) % count };
  if (key === "Enter" && !stale) return { choose: Math.min(active, count - 1) };
  return null;
}

/** The row of the option the owner moved to, found by identity so a refreshed list never moves the highlight onto another option. */
export const activeIndex = (items: readonly { id: string }[], id: string | null) =>
  Math.max(
    0,
    items.findIndex((item) => item.id === id),
  );

/** The line under the options: how many there are, or that none match (read aloud as the list changes). */
export const resultsNotice = (count: number) =>
  count === 0
    ? "No matching pages, settings, projects, packages, or actions"
    : `${count} ${count === 1 ? "result" : "results"}`;
