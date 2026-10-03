import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultWindowPreferences,
  initialWindowBounds,
  loadWindowPreferences,
  saveWindowPreferences,
  titleBarOptions,
} from "../dist/window.js";
import { decodeWindowTheme } from "@versionstead/contracts/desktop";

test("native caption controls follow the theme and leave macOS traffic lights native", () => {
  assert.equal(titleBarOptions(true, "win32").titleBarStyle, "hidden");
  assert.equal(titleBarOptions(true, "win32").titleBarOverlay.height, 40);
  assert.equal(titleBarOptions(true, "win32").titleBarOverlay.symbolColor, "#f8fafc");
  assert.equal(titleBarOptions(false, "win32").titleBarOverlay.symbolColor, "#1f2937");
  assert.equal(titleBarOptions(false, "darwin").titleBarStyle, "hiddenInset");
  assert.equal(titleBarOptions(false, "darwin").titleBarOverlay, undefined);
  assert.equal(decodeWindowTheme("system"), "system");
  for (const invalid of [null, {}, "Dark", "javascript:alert(1)"])
    assert.throws(() => decodeWindowTheme(invalid));
});

test("restore saved windows only when the entire normal bounds fit a connected display", () => {
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: -1920, y: 0, width: 1920, height: 1040 },
  ];
  const bounds = { x: -1600, y: 80, width: 1280, height: 860 };
  const saved = { ...defaultWindowPreferences, bounds, maximized: true };
  assert.deepEqual(initialWindowBounds(saved, displays), bounds);
  assert.deepEqual(initialWindowBounds(saved, [displays[0]]), { width: 1280, height: 860 });
  assert.deepEqual(initialWindowBounds({ ...saved, bounds: { ...bounds, y: 300 } }, displays), {
    width: 1280,
    height: 860,
  });
});

test("native device settings survive restart and safely ignore malformed or oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "versionstead-window-test-"));
  try {
    assert.deepEqual(await loadWindowPreferences(directory), defaultWindowPreferences);
    const saved = {
      theme: "dark",
      bounds: { x: 40, y: 40, width: 1000, height: 700 },
      maximized: true,
    };
    await saveWindowPreferences(directory, saved);
    assert.deepEqual(await loadWindowPreferences(directory), saved);
    await saveWindowPreferences(directory, { ...saved, theme: "light" });
    assert.equal((await loadWindowPreferences(directory)).theme, "light");
    for (const contents of [
      "{",
      JSON.stringify({ ...saved, bounds: { ...saved.bounds, width: 400 } }),
      " ".repeat(4097),
    ]) {
      await writeFile(join(directory, "window-settings.json"), contents);
      assert.deepEqual(await loadWindowPreferences(directory), defaultWindowPreferences);
    }
    await assert.rejects(saveWindowPreferences(directory, { ...saved, theme: "invalid" }));
  } finally {
    assert.equal(directory.startsWith(join(tmpdir(), "versionstead-window-test-")), true);
    await rm(directory, { recursive: true, force: true });
  }
});
