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
type Key = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };
export function keyChord(event: Key, mac: boolean) {
  const key = event.key.toLowerCase();
  if (["control", "meta", "alt", "shift", "dead", "unidentified"].includes(key)) return null;
  return [
    mac ? event.metaKey && "mod" : event.ctrlKey && "mod",
    mac ? event.ctrlKey && "ctrl" : event.metaKey && "meta",
    event.altKey && "alt",
    event.shiftKey && "shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
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
      result[command.id] = binding;
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
