import assert from "node:assert/strict";
import test from "node:test";
import { keyChord, defaultBindings, readBindings, bindingConflict } from "./keybindings.ts";
test("shortcuts normalize platform modifiers, persist validated overrides, and detect conflicts", () => {
  const key = { key: "S", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
  assert.equal(keyChord(key, false), "mod+shift+s");
  assert.equal(keyChord({ ...key, ctrlKey: false, metaKey: true }, true), "mod+shift+s");
  assert.equal(keyChord({ ...key, key: "Shift" }, false), null);
  assert.equal(bindingConflict(defaultBindings, "settings", "mod+2"), "This PC");
  assert.equal(bindingConflict(defaultBindings, "settings", ""), null);
  const read = readBindings({ settings: "mod+shift+s", pc: "garbage", projects: "" });
  assert.equal(read.settings, "mod+shift+s");
  assert.equal(read.scan, "");
  assert.equal(read.pc, "mod+2");
  assert.equal(read.projects, "");
  assert.deepEqual(readBindings(null), defaultBindings);
});
