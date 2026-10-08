import type { Project } from "@versionstead/contracts/monitoring";
import type { ProjectAction } from "@versionstead/contracts/project-settings";
import {
  canonicalChord,
  commandModifiers,
  hasCommandModifier,
  isMac,
  type Bindings,
} from "./keybindings.ts";
export type ProjectSettingsMember = { environment: string; label: string; project: Project };
export function groupSettingsProjects(members: readonly ProjectSettingsMember[]) {
  const groups = new Map<string, { key: string; name: string; members: ProjectSettingsMember[] }>();
  for (const member of members) {
    const repo = member.project.repository;
    const key = repo
      ? `${repo.provider}:${repo.repositoryId}`
      : `${member.environment}:${member.project.id}`;
    const group = groups.get(key) ?? { key, name: member.project.name, members: [] };
    group.members.push(member);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function actionShortcutConflict(
  actions: readonly ProjectAction[],
  id: string,
  chord: string,
  bindings: Bindings,
) {
  if (!chord) return null;
  // Saved shortcuts are read as keyChord now writes them (see canonicalChord).
  const wanted = canonicalChord(chord);
  if (Object.values(bindings).includes(wanted))
    return "This shortcut is already used by an application command.";
  if (actions.some((a) => a.id !== id && a.shortcut && canonicalChord(a.shortcut) === wanted))
    return "Another action in this project uses this shortcut.";
  return null;
}
/** Why a pressed chord cannot become an action's shortcut, or null. Actions run commands, so a bare key never qualifies. */
export function actionShortcutProblem(
  actions: readonly ProjectAction[],
  id: string,
  chord: string,
  bindings: Bindings,
  mac = isMac(),
) {
  return hasCommandModifier(chord)
    ? actionShortcutConflict(actions, id, chord, bindings)
    : `Press ${commandModifiers(mac)} together with a key.`;
}
/** The action a pressed chord runs, if any: one whose saved shortcut it is, unless an application command or another action has the same chord. */
export function actionForChord(
  actions: readonly ProjectAction[],
  chord: string | null,
  bindings: Bindings,
) {
  if (!chord) return undefined;
  return actions.find(
    (a) =>
      a.shortcut !== null &&
      canonicalChord(a.shortcut) === chord &&
      !actionShortcutConflict(actions, a.id, chord, bindings),
  );
}
