export const commands = [
  { id: "settings", label: "Open settings", binding: "mod+," },
  { id: "attention", label: "Needs attention", binding: "mod+1" },
  { id: "pc", label: "This PC", binding: "mod+2" },
  { id: "projects", label: "Projects", binding: "mod+3" },
  { id: "service", label: "Background service", binding: "mod+4" },
  { id: "scan", label: "Scan selected sources", binding: "mod+shift+s" },
  { id: "refresh", label: "Refresh evidence", binding: "mod+shift+r" },
  { id: "pause", label: "Pause or resume scheduled scans", binding: "mod+shift+p" },
  { id: "search", label: "Focus page search", binding: "/" },
] as const;
export type Command = (typeof commands)[number]["id"];
export type Bindings = Record<Command, string>;
export const defaultBindings = Object.fromEntries(
  commands.map((c) => [c.id, c.binding]),
) as Bindings;
type Key = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};
// Where the platform is read from: the desktop bridge, then the browser's own data.
type PlatformHost = {
  versionstead?: { platform?: unknown };
  navigator?: { userAgentData?: unknown; platform?: unknown };
};
const hasPlatform = (value: unknown): value is { platform: string } =>
  typeof value === "object" &&
  value !== null &&
  "platform" in value &&
  typeof value.platform === "string" &&
  value.platform !== "";
/**
 * The platform's name: the desktop app's own (darwin, win32, linux), else what the browser reports
 * (userAgentData names it "macOS" or "Windows"). Empty when nothing says.
 */
export function platformName(host: PlatformHost = globalThis) {
  const desktop = host.versionstead?.platform;
  if (typeof desktop === "string") return desktop;
  const browser = host.navigator;
  // ponytail: navigator.platform is deprecated but the only source in Firefox and Safari; drop it
  // once they ship userAgentData.
  const reported = hasPlatform(browser?.userAgentData)
    ? browser.userAgentData.platform
    : browser?.platform;
  return typeof reported === "string" ? reported : "";
}
/** Whether shortcuts use Command rather than Ctrl. */
export const isMac = (host?: PlatformHost) => /mac|darwin|iphone|ipad/i.test(platformName(host));

// With a command modifier held, a key that types something other than an ASCII letter or digit is
// named by its position (the event code), so Option+S ("ß" on a Mac), a dead key, AltGr+S ("ś"),
// Ctrl+Ф on a Cyrillic layout, and AZERTY's unshifted 1 key ("&") still reach the S, E, S, A and 1
// shortcuts. A key that does type an ASCII letter or digit is what it types: Colemak's R key sits
// where QWERTY has S, and Ctrl+Shift+R must stay Refresh there.
const physicalKey = /^(?:Key([A-Z])|Digit(\d))$/;
export function keyChord(event: Key, mac: boolean) {
  const command = event.ctrlKey || event.metaKey || event.altKey;
  const physical =
    command && !/^[a-z0-9]$/i.test(event.key) ? physicalKey.exec(event.code ?? "") : null;
  const typed = event.key.toLowerCase();
  if (!physical && ["control", "meta", "alt", "shift", "dead", "unidentified"].includes(typed))
    return null;
  const key = physical ? (physical[1] ?? physical[2] ?? "").toLowerCase() : typed;
  // Shift only types a bare digit or symbol on some layouts ("/" is Shift+7 on a German one).
  const shifted = event.shiftKey && (command || key.length > 1 || /^[a-z]$/.test(key));
  return [
    mac ? event.metaKey && "mod" : event.ctrlKey && "mod",
    mac ? event.ctrlKey && "ctrl" : event.metaKey && "meta",
    event.altKey && "alt",
    shifted && "shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
// Shift does not count on a bare digit or symbol (see keyChord), so a chord saved before that, such
// as shift+/ on a German keyboard or shift+1 on AZERTY, is read as the key it types.
export function canonicalChord(chord: string) {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const bare = !parts.some((part) => ["mod", "ctrl", "meta", "alt"].includes(part));
  return parts.includes("shift") && bare && key.length === 1 && !/[a-z]/.test(key)
    ? [...parts.filter((part) => part !== "shift"), key].join("+")
    : chord;
}

type Modifier = "ctrl" | "alt" | "shift" | "meta";
// Apple's order is Control, Option, Shift, Command, so mod+shift+s reads ⇧⌘S. Elsewhere Meta (the
// Windows key) sits before Shift, as it always has.
const modifierOrder: readonly Modifier[] = ["ctrl", "alt", "shift", "meta"];
const pcModifierOrder: readonly Modifier[] = ["ctrl", "alt", "meta", "shift"];
const macSymbols: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const names: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" };
const keyNames: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};
/** A chord as people read it: ⇧⌘S on a Mac, Ctrl+Shift+S elsewhere. A disabled (empty) chord is empty. */
export function formatShortcut(chord: string, mac = isMac()) {
  if (!chord) return "";
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  // "mod" is Command on a Mac and Ctrl elsewhere.
  const held = new Set(parts.map((part) => (part === "mod" ? (mac ? "meta" : "ctrl") : part)));
  const modifiers = (mac ? modifierOrder : pcModifierOrder).filter((modifier) =>
    held.has(modifier),
  );
  const label = keyNames[key] ?? key.toUpperCase();
  return mac
    ? modifiers.map((modifier) => macSymbols[modifier]).join("") + label
    : [...modifiers.map((modifier) => names[modifier]), label].join("+");
}
/** Whether a chord holds Ctrl, Alt, or Command, so it cannot be mistaken for typing or navigating. */
export const hasCommandModifier = (chord: string) => /(?:^|\+)(?:mod|ctrl|alt)\+/.test(chord);
/** The modifiers an action shortcut can use, as this platform names its keys. */
export const commandModifiers = (mac: boolean) =>
  mac ? "Control, Option, or Command" : "Ctrl or Alt";
export function readBindings(value: unknown): Bindings {
  const result = { ...defaultBindings };
  if (!value || typeof value !== "object") return result;
  for (const command of commands) {
    const binding = (value as Record<string, unknown>)[command.id];
    if (
      typeof binding === "string" &&
      (binding === "" ||
        /^(?:(?:mod|ctrl|meta|alt|shift)\+)*(?:[a-z0-9,/.-]|f(?:[1-9]|1[0-2])|escape|enter|arrow(?:up|down|left|right))$/.test(
          binding,
        ))
    )
      result[command.id] = canonicalChord(binding);
  }
  const used = new Set<string>();
  for (const command of commands) {
    const chord = result[command.id];
    if (chord && used.has(chord)) result[command.id] = "";
    else if (chord) used.add(chord);
  }
  return result;
}
export function bindingConflict(bindings: Bindings, id: Command, chord: string) {
  return chord ? commands.find((c) => c.id !== id && bindings[c.id] === chord)?.label : null;
}
