// Window geometry/appearance adapted from T3 Code's DesktopWindow (MIT).
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";
import {
  decodeWindowPreferences,
  type WindowBounds,
  type WindowPreferences,
} from "@versionstead/contracts/desktop";

export const defaultWindowPreferences: WindowPreferences = {
  theme: "system",
  bounds: null,
  maximized: false,
};
export const titleBarHeight = 40;
export function titleBarOptions(
  dark: boolean,
  platform = process.platform,
): BrowserWindowConstructorOptions {
  return platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 19 } }
    : {
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#01000000",
          height: titleBarHeight,
          symbolColor: dark ? "#f8fafc" : "#1f2937",
        },
      };
}
export function initialWindowBounds(
  preferences: WindowPreferences,
  displays: readonly WindowBounds[],
) {
  const b = preferences.bounds;
  return b &&
    displays.some(
      (d) =>
        b.x >= d.x &&
        b.y >= d.y &&
        b.x + b.width <= d.x + d.width &&
        b.y + b.height <= d.y + d.height,
    )
    ? b
    : { width: 1280, height: 860 };
}
export async function loadWindowPreferences(directory: string): Promise<WindowPreferences> {
  try {
    const file = join(directory, "window-settings.json");
    if ((await stat(file)).size > 4096) return defaultWindowPreferences;
    return decodeWindowPreferences(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return defaultWindowPreferences;
  }
}
export async function saveWindowPreferences(directory: string, preferences: WindowPreferences) {
  const value = decodeWindowPreferences(preferences);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, "window-settings.json.tmp");
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, join(directory, "window-settings.json"));
}
