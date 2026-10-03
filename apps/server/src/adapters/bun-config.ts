import type { GlobalToolSource } from "@versionstead/contracts/monitoring";
const publicRegistry = "https://registry.npmjs.org";
function publicUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return (
      url.origin === publicRegistry &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function decodeBunConfiguration(text: string) {
  let globalDir: string | null = null;
  let registry: GlobalToolSource["registry"] | null = null;
  let unsupported = false;
  let globalDirUnsupported = false;
  const blocked = new Set<string>();
  // ponytail: literal single-line Bun settings are supported; add TOML parsing when real configs need other forms.
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    // Valid dotted/quoted TOML settings need a parser before their registry can be trusted.
    if (/^\s*["']?install(?:["']?\s*\.|["']?\s*=)/.test(line)) unsupported = true;
    if (
      !line.trim().startsWith("#") &&
      /globalDir|\\[uUx]/.test(line) &&
      (section !== "install" || !/^\s*globalDir\s*=/.test(line))
    )
      globalDirUnsupported = true;
    const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (heading) {
      section = heading[1]!;
      if (/install/.test(section) && !["install", "install.scopes"].includes(section))
        unsupported = true;
      continue;
    }
    if (section === "install.scopes") {
      const scoped = /^\s*["']?(@[a-z0-9._-]+)["']?\s*=/i.exec(line);
      if (scoped) blocked.add(scoped[1]!);
      else if (line.trim() && !line.trim().startsWith("#")) unsupported = true;
    }
    if (section !== "install") continue;
    if (/^\s*["'](?:registry|globalDir|scopes)["']\s*=/.test(line)) unsupported = true;
    if (/^\s*(?:(?:registry|globalDir)\s*\.|scopes\s*[.=])/.test(line)) unsupported = true;
    const setting = /^\s*(globalDir|registry)\s*=\s*(.*)$/.exec(line);
    if (!setting) continue;
    const literal = /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(setting[2]!);
    if (!literal) {
      if (setting[1] === "globalDir") throw new Error();
      unsupported = true;
      continue;
    }
    const value = literal[1]!.startsWith('"')
      ? (JSON.parse(literal[1]!) as string)
      : literal[1]!.slice(1, -1);
    if (setting[1] === "registry") registry = publicUrl(value) ? "public" : "unsupported";
    else globalDir = value;
  }
  return {
    globalDir,
    registry: unsupported ? ("unknown" as const) : registry,
    blockedScopes: [...blocked],
    globalDirUnsupported,
  };
}
