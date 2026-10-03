import type { Project } from "@versionstead/contracts/monitoring";
import type { ProjectAction } from "@versionstead/contracts/project-settings";
import type { Bindings } from "./keybindings";
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
  if (Object.values(bindings).includes(chord))
    return "This shortcut is already used by an application command.";
  if (actions.some((a) => a.id !== id && a.shortcut === chord))
    return "Another action in this project uses this shortcut.";
  return null;
}
