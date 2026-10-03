import assert from "node:assert/strict";
import test from "node:test";
import type { Project } from "@versionstead/contracts/monitoring";
import { groupSettingsProjects, actionShortcutConflict } from "./project-settings.logic.ts";
import { defaultBindings } from "./keybindings.ts";
test("project grouping preserves source/environment identity and shortcut conflicts stay scoped", () => {
  const local = { id: "one", name: "Same name" } as Project;
  const other = { id: "two", name: "Same name" } as Project;
  assert.equal(
    groupSettingsProjects([
      { environment: "local", label: "PC", project: local },
      { environment: "local", label: "PC", project: other },
    ]).length,
    2,
  );
  const repo = {
    ...local,
    repository: {
      provider: "github",
      repositoryId: "123",
      name: "repo",
      ref: "main",
      commit: null,
      url: "https://github.com/owner/repo",
    },
  } as Project;
  const groups = groupSettingsProjects([
    { environment: "local", label: "PC", project: repo },
    { environment: "peer", label: "Other PC", project: { ...repo, id: "remote" } },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]!.members.map((m) => m.environment),
    ["local", "peer"],
  );
  const actions = [
    { id: "one", name: "Test", icon: "test", command: "pnpm test", shortcut: "mod+alt+t" },
  ] as const;
  assert.match(
    actionShortcutConflict(actions, "two", "mod+alt+t", defaultBindings)!,
    /Another action/,
  );
  assert.match(
    actionShortcutConflict(actions, "one", "mod+shift+s", defaultBindings)!,
    /application command/,
  );
  assert.equal(actionShortcutConflict(actions, "one", "mod+alt+t", defaultBindings), null);
});
