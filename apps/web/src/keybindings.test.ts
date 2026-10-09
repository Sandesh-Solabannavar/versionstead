import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingConflict,
  canonicalChord,
  commandModifiers,
  commands,
  defaultBindings,
  formatShortcut,
  hasCommandModifier,
  isMac,
  keyChord,
  platformName,
  readBindings,
} from "./keybindings.ts";

const none = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

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

test("under a command modifier, a key that types something else than an ASCII letter or digit is named by its position", () => {
  // Option+S types "ß" and Option+E is a dead key on a Mac, yet both are still the S and E keys.
  assert.equal(keyChord({ ...none, key: "ß", code: "KeyS", altKey: true }, true), "alt+s");
  assert.equal(
    keyChord({ ...none, key: "Dead", code: "KeyE", altKey: true, metaKey: true }, true),
    "mod+alt+e",
  );
  // AltGr is Ctrl+Alt on Windows: the Polish AltGr+S types "ś".
  assert.equal(
    keyChord({ ...none, key: "ś", code: "KeyS", ctrlKey: true, altKey: true }, false),
    "mod+alt+s",
  );
  // On a Cyrillic layout Ctrl+Ф is still Ctrl+A; on AZERTY the unshifted 1 key types "&".
  assert.equal(keyChord({ ...none, key: "ф", code: "KeyA", ctrlKey: true }, false), "mod+a");
  assert.equal(keyChord({ ...none, key: "&", code: "Digit1", ctrlKey: true }, false), "mod+1");
  // Shift stays part of the chord when a command modifier is held.
  assert.equal(
    keyChord({ ...none, key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }, false),
    "mod+shift+1",
  );
  // Without one, what the key types decides: Shift+S is "S".
  assert.equal(keyChord({ ...none, key: "S", code: "KeyS", shiftKey: true }, false), "shift+s");
  assert.equal(keyChord({ ...none, key: "q", code: "KeyA" }, false), "q");
  // An event with no usable code, like the desktop smoke's synthetic one, falls back to the key.
  assert.equal(keyChord({ ...none, key: "t", ctrlKey: true, altKey: true }, false), "mod+alt+t");
  assert.equal(
    keyChord({ ...none, key: "t", code: "", ctrlKey: true, altKey: true }, false),
    "mod+alt+t",
  );
  // A modifier on its own, or a bare dead key, is not a chord yet.
  assert.equal(keyChord({ ...none, key: "Shift", code: "ShiftLeft", shiftKey: true }, false), null);
  assert.equal(keyChord({ ...none, key: "Dead", code: "KeyE" }, true), null);
  assert.equal(
    keyChord({ ...none, key: "Control", code: "ControlLeft", ctrlKey: true }, false),
    null,
  );
});

test("a key that types an ASCII letter or digit is that letter, so Colemak, Dvorak, and AZERTY keep their printed keys", () => {
  // Colemak's R key is where QWERTY has S, and its P key where QWERTY has R: Ctrl+Shift+R must
  // still be Refresh and Ctrl+Shift+P must still be Pause, not Scan and Refresh.
  assert.equal(
    keyChord({ ...none, key: "R", code: "KeyS", ctrlKey: true, shiftKey: true }, false),
    "mod+shift+r",
  );
  assert.equal(
    keyChord({ ...none, key: "P", code: "KeyR", ctrlKey: true, shiftKey: true }, false),
    "mod+shift+p",
  );
  // Dvorak's P key is where QWERTY has R, and its S key is where QWERTY has the semicolon.
  assert.equal(
    keyChord({ ...none, key: "p", code: "KeyR", metaKey: true, shiftKey: true }, true),
    "mod+shift+p",
  );
  assert.equal(
    keyChord({ ...none, key: "s", code: "Semicolon", ctrlKey: true, shiftKey: true }, false),
    "mod+shift+s",
  );
  // AZERTY puts A where QWERTY has Q.
  assert.equal(keyChord({ ...none, key: "a", code: "KeyQ", ctrlKey: true }, false), "mod+a");
  // Every default letter chord stays itself on each of them, on both platforms.
  const positions: Record<string, Record<string, string>> = {
    colemak: { s: "KeyD", r: "KeyS", p: "KeyR" },
    dvorak: { s: "Semicolon", r: "KeyK", p: "KeyR" },
  };
  for (const [layout, codes] of Object.entries(positions))
    for (const mac of [false, true])
      for (const command of commands.filter((c) => /^mod\+shift\+[srp]$/.test(c.binding))) {
        const letter = command.binding.at(-1)!;
        const event = {
          ...none,
          key: letter.toUpperCase(),
          code: codes[letter]!,
          ctrlKey: !mac,
          metaKey: mac,
          shiftKey: true,
        };
        assert.equal(
          keyChord(event, mac),
          command.binding,
          `${layout} ${letter} on ${mac ? "mac" : "pc"}`,
        );
      }
});

test("Shift is not a modifier on a bare symbol, so / still works where it is typed with Shift", () => {
  // "/" is Shift+7 on a German keyboard; on a US one it is its own key.
  assert.equal(keyChord({ ...none, key: "/", code: "Digit7", shiftKey: true }, false), "/");
  assert.equal(keyChord({ ...none, key: "/", code: "Slash" }, false), "/");
  // Named keys keep it.
  assert.equal(keyChord({ ...none, key: "Tab", code: "Tab", shiftKey: true }, false), "shift+tab");
  assert.equal(keyChord({ ...none, key: "F5", code: "F5", shiftKey: true }, false), "shift+f5");
});

test("every default and previously saved chord is still what its physical keys produce", () => {
  // Build the event a user would produce for a stored chord, on each platform.
  const press = (chord: string, mac: boolean) => {
    const parts = chord.split("+");
    const key = parts.pop()!;
    const has = (name: string) => parts.includes(name);
    return {
      key,
      ...(/^[a-z]$/.test(key)
        ? { code: `Key${key.toUpperCase()}` }
        : /^\d$/.test(key)
          ? { code: `Digit${key}` }
          : {}),
      ctrlKey: has("ctrl") || (!mac && has("mod")),
      metaKey: has("meta") || (mac && has("mod")),
      altKey: has("alt"),
      shiftKey: has("shift"),
    };
  };
  for (const mac of [false, true])
    for (const chord of [
      ...commands.map((command) => command.binding),
      "mod+shift+s",
      "mod+alt+t",
      "mod+alt+k",
      "alt+1",
      "shift+f5",
    ])
      assert.equal(keyChord(press(chord, mac), mac), chord, `${chord} on ${mac ? "mac" : "pc"}`);
});

test("formatShortcut shows modifier symbols on a Mac and names elsewhere, never a raw chord", () => {
  assert.equal(formatShortcut("mod+shift+s", true), "⇧⌘S");
  assert.equal(formatShortcut("mod+shift+s", false), "Ctrl+Shift+S");
  // Symbols run Control, Option, Shift, Command (Apple's order) with no separator, whatever order
  // was stored.
  assert.equal(formatShortcut("mod+alt+shift+ctrl+k", true), "⌃⌥⇧⌘K");
  assert.equal(formatShortcut("mod+alt+t", true), "⌥⌘T");
  assert.equal(formatShortcut("shift+mod+alt+t", false), "Ctrl+Alt+Shift+T");
  // Elsewhere the Windows key keeps its place before Shift.
  assert.equal(formatShortcut("meta+shift+x", false), "Meta+Shift+X");
  assert.equal(formatShortcut("meta+shift+x", true), "⇧⌘X");
  assert.equal(formatShortcut("mod+,", true), "⌘,");
  assert.equal(formatShortcut("mod+1", false), "Ctrl+1");
  assert.equal(formatShortcut("/", true), "/");
  assert.equal(formatShortcut("/", false), "/");
  assert.equal(formatShortcut("shift+f5", false), "Shift+F5");
  assert.equal(formatShortcut("mod+escape", false), "Ctrl+Esc");
  assert.equal(formatShortcut("alt+arrowup", true), "⌥↑");
  assert.equal(formatShortcut("mod+ctrl+x", false), "Ctrl+X");
  assert.equal(formatShortcut("", false), "");
  for (const command of commands)
    for (const mac of [false, true])
      assert.doesNotMatch(formatShortcut(command.binding, mac), /mod|shift\+|alt\+/);
});

test("isMac trusts the desktop bridge, then the browser's platform data, then the legacy string", () => {
  assert.equal(isMac({ versionstead: { platform: "darwin" } }), true);
  assert.equal(
    isMac({ versionstead: { platform: "win32" }, navigator: { platform: "MacIntel" } }),
    false,
  );
  assert.equal(isMac({ versionstead: { platform: "linux" } }), false);
  // User-agent data beats the legacy string in either direction.
  assert.equal(
    isMac({ navigator: { userAgentData: { platform: "macOS" }, platform: "Win32" } }),
    true,
  );
  assert.equal(
    isMac({ navigator: { userAgentData: { platform: "Windows" }, platform: "MacIntel" } }),
    false,
  );
  // Data without a usable platform falls through to navigator.platform.
  assert.equal(
    isMac({ navigator: { userAgentData: { platform: "" }, platform: "MacIntel" } }),
    true,
  );
  assert.equal(isMac({ navigator: { userAgentData: {}, platform: "Win32" } }), false);
  assert.equal(isMac({ navigator: { userAgentData: null, platform: "iPad" } }), true);
  assert.equal(isMac({ navigator: { platform: "iPhone" } }), true);
  assert.equal(isMac({ navigator: { platform: "Linux x86_64" } }), false);
  assert.equal(isMac({ navigator: {} }), false);
  assert.equal(isMac({}), false);
  // The name itself, for the one other place that needs it (a folder path's style).
  assert.equal(platformName({ versionstead: { platform: "win32" } }), "win32");
  assert.equal(platformName({ navigator: { userAgentData: { platform: "Windows" } } }), "Windows");
  assert.equal(platformName({ navigator: { platform: "Win32" } }), "Win32");
  assert.equal(platformName({}), "");
});

test("only chords with Ctrl, Alt, or Command held count as having a command modifier", () => {
  for (const chord of ["mod+s", "alt+1", "ctrl+k", "mod+shift+s", "shift+alt+f5", "mod+-"])
    assert.equal(hasCommandModifier(chord), true, chord);
  for (const chord of ["s", "shift+s", "/", "tab", "shift+tab", "escape", "f5", "meta+s", ""])
    assert.equal(hasCommandModifier(chord), false, chord);
  // Copy names the keys the platform has: no Command on Windows or Linux.
  assert.equal(commandModifiers(false), "Ctrl or Alt");
  assert.equal(commandModifiers(true), "Control, Option, or Command");
});

test("a chord saved while Shift still counted on a bare digit or symbol keeps firing", () => {
  // shift+1 on AZERTY and shift+/ on a German keyboard are now pressed as "1" and "/".
  assert.equal(canonicalChord("shift+1"), "1");
  assert.equal(canonicalChord("shift+/"), "/");
  assert.equal(canonicalChord("shift+,"), ",");
  // Letters, named keys, and anything with a command modifier keep Shift.
  for (const chord of [
    "shift+s",
    "shift+tab",
    "shift+f5",
    "mod+shift+1",
    "alt+shift+/",
    "meta+shift+1",
    "ctrl+shift+,",
    "mod+s",
    "/",
    "",
  ])
    assert.equal(canonicalChord(chord), chord, chord);
  // And it is a keyChord fixed point: whatever a keyboard produces is already canonical.
  assert.equal(canonicalChord(keyChord({ ...none, key: "1", shiftKey: true }, false)!), "1");
  // readBindings applies it, then still catches the clash it can create.
  const read = readBindings({ pc: "shift+1", search: "shift+/", scan: "mod+shift+s" });
  assert.equal(read.pc, "1");
  assert.equal(read.search, "/");
  assert.equal(read.scan, "mod+shift+s");
  const clash = readBindings({ attention: "shift+1", pc: "1" });
  assert.equal(clash.attention, "1");
  assert.equal(clash.pc, "");
});
