import assert from "node:assert/strict";
import test from "node:test";
import type { Project } from "@versionstead/contracts/monitoring";
import {
  groupSettingsProjects,
  actionForChord,
  actionShortcutConflict,
  actionShortcutProblem,
} from "./project-settings.logic.ts";
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

test("a new action shortcut needs a command modifier, named as the platform names it", () => {
  const actions = [
    { id: "one", name: "Test", icon: "test", command: "pnpm test", shortcut: "mod+alt+t" },
  ] as const;
  for (const chord of ["tab", "shift+tab", "escape", "enter", "t", "shift+t", "f5"]) {
    // No Command on Windows or Linux, and no Ctrl-or-Alt riddle on a Mac.
    const pc = actionShortcutProblem(actions, "two", chord, defaultBindings, false)!;
    assert.match(pc, /Ctrl or Alt/);
    assert.doesNotMatch(pc, /Command/);
    assert.match(
      actionShortcutProblem(actions, "two", chord, defaultBindings, true)!,
      /Control, Option, or Command/,
    );
  }
  // With a modifier it is judged on conflicts alone.
  assert.match(
    actionShortcutProblem(actions, "two", "mod+alt+t", defaultBindings, false)!,
    /Another action/,
  );
  assert.match(
    actionShortcutProblem(actions, "two", "mod+1", defaultBindings, false)!,
    /application command/,
  );
  assert.equal(actionShortcutProblem(actions, "two", "mod+alt+u", defaultBindings, false), null);
  assert.equal(actionShortcutProblem(actions, "one", "mod+alt+t", defaultBindings, false), null);
  // A shortcut saved before this rule keeps working and keeps saving.
  const legacy = [{ ...actions[0], shortcut: "shift+t" }] as const;
  assert.equal(actionShortcutConflict(legacy, "one", "shift+t", defaultBindings), null);
});

test("a saved action shortcut runs on the chord it is now typed as, unless something else owns that chord", () => {
  const action = (id: string, shortcut: string | null) =>
    ({ id, name: id, icon: "test", command: "pnpm test", shortcut }) as const;
  const actions = [
    action("one", "mod+alt+t"),
    // Saved while Shift counted on a bare digit or symbol: now pressed as "1" and "/".
    action("azerty", "shift+1"),
    action("slash", "shift+/"),
    action("none", null),
  ];
  assert.equal(actionForChord(actions, "mod+alt+t", defaultBindings)?.id, "one");
  assert.equal(actionForChord(actions, "1", defaultBindings)?.id, "azerty");
  // "/" is Focus page search, so the action that saved shift+/ yields to it.
  assert.equal(actionForChord(actions, "/", defaultBindings), undefined);
  assert.match(
    actionShortcutConflict(actions, "slash", "shift+/", defaultBindings)!,
    /application command/,
  );
  // Two actions on one chord: neither runs, and the editor says so.
  const twins = [...actions, action("twin", "mod+alt+t")];
  assert.equal(actionForChord(twins, "mod+alt+t", defaultBindings), undefined);
  assert.match(
    actionShortcutConflict(twins, "new", "mod+alt+t", defaultBindings)!,
    /Another action/,
  );
  assert.match(
    actionShortcutConflict(actions, "new", "shift+1", defaultBindings)!,
    /Another action/,
  );
  // Nothing pressed, or nothing saved for it.
  assert.equal(actionForChord(actions, null, defaultBindings), undefined);
  assert.equal(actionForChord(actions, "mod+alt+x", defaultBindings), undefined);
});
