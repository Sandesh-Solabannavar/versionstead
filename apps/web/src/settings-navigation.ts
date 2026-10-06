export const settingsSections = [
  { path: "/settings/general", label: "General" },
  { path: "/settings/appearance", label: "Appearance" },
  { path: "/settings/project", label: "Project" },
  { path: "/settings/keybindings", label: "Keybindings" },
  { path: "/settings/source-control", label: "Source Control" },
  { path: "/settings/connections", label: "Connections" },
] as const;
export type SettingsPath = (typeof settingsSections)[number]["path"];
export const settingTargetId = (label: string) =>
  `setting-${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
const entries: readonly [SettingsPath, readonly string[]][] = [
  [
    "/settings/general",
    [
      "Scheduled scans",
      "PC scan interval",
      "Project scan interval",
      "Scan selected repositories automatically",
      "Notify about new findings",
      "Check for Versionstead releases",
    ],
  ],
  [
    "/settings/appearance",
    [
      "Contrast",
      "Glass opacity",
      "Content width",
      "Compact rows",
      "Panel animations",
      "Reduce motion",
      "Interface font",
      "Monospace font",
      "Word wrap",
    ],
  ],
  ["/settings/project", ["Name", "Project icon", "Actions"]],
  ["/settings/source-control", ["Automatically scan", "Scan interval"]],
  [
    "/settings/connections",
    ["Local environment", "Version", "Network access", "Tailscale HTTPS", "Background monitoring"],
  ],
];
export const searchableSettings = [
  ...settingsSections.map((s) => ({
    ...s,
    id: s.path,
    target: null as string | null,
  })),
  ...entries.flatMap(([path, labels]) =>
    labels.map((label) => ({
      path,
      label,
      id: `${path}:${label}`,
      target: settingTargetId(label),
    })),
  ),
];
const pageKeywords: Partial<Record<SettingsPath, string>> = {
  "/settings/general": "restore device defaults monitoring notifications schedules",
  "/settings/appearance": "themes palettes system light dark",
  "/settings/project": "remove custom commands checkout",
  "/settings/keybindings": "keyboard shortcuts hotkeys",
  "/settings/source-control": "git github gitlab providers repositories",
  "/settings/connections": "pc device pairing ssh tailscale network",
};
export function searchSettings(query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return searchableSettings
    .filter((item) => {
      const section = settingsSections.find((s) => s.path === item.path)!.label;
      const keywords = item.target === null ? (pageKeywords[item.path] ?? "") : "";
      return words.every((word) =>
        `${item.label} ${section} ${keywords}`.toLowerCase().includes(word),
      );
    })
    .sort(
      (a, b) =>
        Number(!a.label.toLowerCase().startsWith(query.toLowerCase().trim())) -
        Number(!b.label.toLowerCase().startsWith(query.toLowerCase().trim())),
    );
}
export function workspaceHref(href: string) {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  try {
    const u = new URL(href, "https://versionstead.invalid");
    if (u.origin !== "https://versionstead.invalid") return null;
    return ["/", "/pc", "/projects", "/service"].includes(u.pathname) ||
      /^\/computers\/[a-zA-Z0-9-]{1,100}$/.test(u.pathname)
      ? `${u.pathname}${u.search}${u.hash}`
      : null;
  } catch {
    return null;
  }
}
