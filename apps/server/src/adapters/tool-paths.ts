import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";

export function toolDirectories(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
) {
  const paths = platform === "win32" ? win32 : { isAbsolute, join };
  const inherited =
    Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ??
    "";
  const directories = inherited.split(platform === "win32" ? ";" : delimiter);
  if (platform === "win32") {
    const add = (base: string | undefined, ...parts: string[]) => {
      if (base && paths.isAbsolute(base))
        directories.push(paths.join(base, ...parts));
    };
    add(env.APPDATA, "npm");
    add(env.LOCALAPPDATA, "Programs", "nodejs");
    add(env.LOCALAPPDATA, "Volta", "bin");
    add(env.LOCALAPPDATA, "pnpm");
    add(env.USERPROFILE, ".local", "bin");
    add(env.USERPROFILE, ".bun", "bin");
    add(env.USERPROFILE, "scoop", "shims");
    add(env.BUN_INSTALL, "bin");
    add(env.VOLTA_HOME, "bin");
    add(env.PNPM_HOME);
    add(env.ProgramFiles, "nodejs");
  }
  const seen = new Set<string>();
  return directories
    .map((p) => p.trim().replace(/^"(.*)"$/, "$1"))
    .filter((p) => {
      const key = platform === "win32" ? p.toLowerCase() : p;
      if (
        !paths.isAbsolute(p) ||
        (platform === "win32" && !/^[a-z]:[\\/]/i.test(p)) ||
        /^[\\/]{2}/.test(p) ||
        seen.has(key)
      )
        return false;
      seen.add(key);
      return true;
    });
}

export async function toolExecutable(name: string) {
  for (const directory of toolDirectories()) {
    try {
      const candidate = join(directory, name);
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch {
      // Only explicit local directories; never resolve through a shell or the current directory.
    }
  }
  return null;
}
