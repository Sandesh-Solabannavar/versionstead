import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import type { App } from "electron";
import {
  hasControlCharacter,
  launchAgentPlist,
} from "../../server/dist/adapters/background-host.js";

export const UI_AGENT_LABEL = "dev.versionstead.ui";
export const AUTOSTART_FILE = "dev.versionstead.desktop";

export type LoginItemContext = {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** The Electron binary (process.execPath) and the unpackaged app directory (app.getAppPath()). */
  executable: string;
  appPath: string;
  app: Pick<App, "getLoginItemSettings" | "setLoginItemSettings">;
};

/** An XDG autostart entry that starts the tray app hidden. Desktop Entry Exec quoting would need escapes
 * for ", `, $ and \ and treats % as a field code, so paths holding them are refused instead. */
export function autostartEntry(executable: string, appPath: string) {
  for (const value of [executable, appPath])
    if (!posix.isAbsolute(value) || /["`$\\%]/.test(value) || hasControlCharacter(value))
      throw new Error(
        "Opening at login needs absolute paths without quotes, backticks, $, backslashes, % or control characters.",
      );
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Versionstead",
    "Comment=Open Versionstead at login",
    `Exec="${executable}" "${appPath}" --hidden`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** The file that launches this exact app at login: a LaunchAgent on macOS (login items cannot pass
 * arguments to an unpackaged app), an XDG autostart entry on Linux. */
function loginEntry(context: LoginItemContext) {
  if (context.platform === "darwin")
    return {
      path: join(context.home, "Library", "LaunchAgents", `${UI_AGENT_LABEL}.plist`),
      contents: launchAgentPlist({
        label: UI_AGENT_LABEL,
        programArguments: [context.executable, context.appPath, "--hidden"],
        aquaOnly: true,
      }),
    };
  if (context.platform === "linux") {
    const config = context.env.XDG_CONFIG_HOME;
    return {
      path: join(
        config && isAbsolute(config) ? config : join(context.home, ".config"),
        "autostart",
        AUTOSTART_FILE,
      ),
      contents: autostartEntry(context.executable, context.appPath),
    };
  }
  return null;
}

// Electron 44 quotes the executable and every argument of the Run value itself (electron#50016), so a
// pre-quoted app path would reach the app wrapped in literal quote characters.
const windowsItem = (context: LoginItemContext) => ({
  path: context.executable,
  args: [context.appPath, "--hidden"],
});

/** Read back from the OS: on for an entry that starts this app and checkout, off otherwise (including
 * one left by a moved checkout or an older Electron). */
export async function readLoginItem(context: LoginItemContext) {
  // openAtLogin compares the whole Run command line. executableWillLaunchAtLogin ignores the arguments and,
  // in Electron 44, never matches an executable path containing spaces (fixed later, electron#54364).
  // ponytail: an entry switched off under Windows Startup apps still reads on; also require
  // executableWillLaunchAtLogin once the pinned Electron matches paths with spaces.
  if (context.platform === "win32")
    return { openAtLogin: context.app.getLoginItemSettings(windowsItem(context)).openAtLogin };
  let entry;
  try {
    entry = loginEntry(context);
  } catch {
    // A path the entry cannot carry has nothing registered; turning the switch on explains why.
    return { openAtLogin: false };
  }
  if (!entry) return { openAtLogin: false };
  const current = await readFile(entry.path, "utf8").catch(() => null);
  return { openAtLogin: current === entry.contents };
}

export async function changeLoginItem(context: LoginItemContext, openAtLogin: boolean) {
  if (context.platform === "win32")
    context.app.setLoginItemSettings({ openAtLogin, ...windowsItem(context) });
  else {
    const entry = loginEntry(context);
    if (!entry) throw new Error("Opening at login is not available on this platform.");
    // The file system errors carry the entry's full path under the owner's home, and the toast and
    // Electron's handler log would show it, so only a fixed message goes on.
    if (openAtLogin) {
      try {
        await mkdir(dirname(entry.path), { recursive: true });
        await writeFile(entry.path, entry.contents, { mode: 0o644 });
      } catch {
        throw new Error("Could not save the login entry.");
      }
    } else {
      try {
        await rm(entry.path, { force: true });
      } catch {
        throw new Error("Could not remove the login entry.");
      }
    }
  }
  return readLoginItem(context);
}
