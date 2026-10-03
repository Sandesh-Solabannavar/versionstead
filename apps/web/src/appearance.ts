import {
  builtInThemes,
  colorRoles,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeMode,
} from "./theme-palettes.ts";

export type Theme = ThemeMode | "system";
export type ThemeHalves = Record<ThemeMode, string>;
export const interfaceFonts = [
  "System default",
  "Segoe UI",
  "Arial",
  "Verdana",
  "Tahoma",
  "Georgia",
] as const;
export const monospaceFonts = [
  "System default",
  "Consolas",
  "Cascadia Code",
  "Courier New",
  "Menlo",
  "Monaco",
] as const;
export const defaultAppearance = {
  contrast: 100,
  glassOpacity: 80,
  panelAnimationMs: 0,
  contentWidth: "comfortable" as "comfortable" | "wide" | "full",
  interfaceFont: "System default",
  interfaceFontSize: 16,
  monospaceFont: "System default",
  monospaceFontSize: 13,
  tableFontSize: 0,
  evidenceFontSize: 0,
  wordWrap: true,
  advancedTypography: false,
};
export type Appearance = typeof defaultAppearance;
export const maxThemeBytes = 64 * 1024;
export const maxCustomThemes = 50;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bounded(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}
export function readTheme(value: unknown): Theme {
  return value === "light" || value === "dark" ? value : "system";
}
export function readAppearance(value: unknown): Appearance {
  const v = record(value) ? value : {};
  return {
    contrast: bounded(v.contrast, 50, 200, 100),
    glassOpacity: bounded(v.glassOpacity, 40, 100, 80),
    panelAnimationMs: bounded(v.panelAnimationMs, 0, 400, 0),
    contentWidth:
      v.contentWidth === "wide" || v.contentWidth === "full" ? v.contentWidth : "comfortable",
    interfaceFont: interfaceFonts.find((font) => font === v.interfaceFont) ?? "System default",
    interfaceFontSize: bounded(v.interfaceFontSize, 12, 20, 16),
    monospaceFont: monospaceFonts.find((font) => font === v.monospaceFont) ?? "System default",
    monospaceFontSize: bounded(v.monospaceFontSize, 10, 18, 13),
    tableFontSize: v.tableFontSize === 0 ? 0 : bounded(v.tableFontSize, 10, 18, 0),
    evidenceFontSize: v.evidenceFontSize === 0 ? 0 : bounded(v.evidenceFontSize, 12, 20, 0),
    wordWrap: typeof v.wordWrap === "boolean" ? v.wordWrap : true,
    advancedTypography: v.advancedTypography === true,
  };
}
// Imported files contain literal colors only, never CSS variables, URLs, or declarations.
// ponytail: hex/OKLCH theme imports; add other literal formats when a real theme needs them.
export function isThemeColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  if (/^#[\da-f]{6}$/i.test(value)) return true;
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(value);
  return (
    !!oklch &&
    Number(oklch[1]) >= 0 &&
    Number(oklch[1]) <= 1 &&
    Number(oklch[2]) >= 0 &&
    Number(oklch[2]) <= 0.5 &&
    Number.isFinite(Number(oklch[3]))
  );
}
function colors(value: unknown, mode: ThemeMode): ThemeColors {
  if (!record(value)) throw new Error(`Missing ${mode} colors.`);
  const result = { ...builtInThemes[0]![mode] };
  for (const role of colorRoles) {
    if (value[role] === undefined) continue;
    if (!isThemeColor(value[role]))
      throw new Error(`Invalid ${mode} ${role} color. Use #rrggbb or literal oklch(l c h).`);
    result[role] = value[role];
  }
  return result;
}
export function parseTheme(value: unknown): ThemeDefinition {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,47}$/.test(value.id) ||
    builtInThemes.some((theme) => theme.id === value.id)
  )
    throw new Error(
      "Use theme format version 1 and a unique ID of up to 48 lowercase letters, numbers, or hyphens.",
    );
  const label = value.name ?? value.label;
  if (typeof label !== "string" || !label.trim() || label.trim().length > 48)
    throw new Error("Theme name must contain 1–48 characters.");
  // Accept Versionstead pairs and T3 Code's appearance/colors/variants file format.
  const paired = record(value.light) && record(value.dark);
  const appearance = readTheme(value.appearance);
  if (!paired && appearance === "system")
    throw new Error("A theme needs light/dark colors or an explicit appearance.");
  const variants = record(value.variants) ? value.variants : {};
  const light = paired
    ? value.light
    : appearance === "light"
      ? value.colors
      : (variants.light ?? {});
  const dark = paired ? value.dark : appearance === "dark" ? value.colors : (variants.dark ?? {});
  return {
    id: value.id,
    label: label.trim(),
    light: colors(light, "light"),
    dark: colors(dark, "dark"),
  };
}
export function importTheme(text: string): ThemeDefinition {
  if (new TextEncoder().encode(text).length > maxThemeBytes)
    throw new Error("Theme files must be at most 64 KiB.");
  return parseTheme(JSON.parse(text) as unknown);
}
export function serializeTheme(theme: ThemeDefinition) {
  return JSON.stringify(
    { version: 1, id: theme.id, name: theme.label, light: theme.light, dark: theme.dark },
    null,
    2,
  );
}
export function readCustomThemes(value: unknown): ThemeDefinition[] {
  const result: ThemeDefinition[] = [];
  if (!Array.isArray(value)) return result;
  for (const candidate of value.slice(0, maxCustomThemes)) {
    try {
      const theme = parseTheme(candidate);
      if (!result.some((existing) => existing.id === theme.id)) result.push(theme);
    } catch {
      /* Keep other valid saved themes when one entry is malformed. */
    }
  }
  return result;
}
export function readThemeHalves(value: unknown, themes: readonly ThemeDefinition[]): ThemeHalves {
  const v = record(value) ? value : {};
  const resolve = (mode: ThemeMode) =>
    themes.find((theme) => theme.id === v[mode])?.id ?? "default";
  return { light: resolve("light"), dark: resolve("dark") };
}
export function resolvePalette(
  halves: ThemeHalves,
  themes: readonly ThemeDefinition[],
  mode: ThemeMode,
): ThemeColors {
  return (themes.find((theme) => theme.id === halves[mode]) ?? builtInThemes[0]!)[mode];
}
export function appearanceVariables(
  palette: ThemeColors,
  appearance: Appearance,
  mode: ThemeMode,
): Record<string, string> {
  const contrast = appearance.contrast;
  const target = mode === "dark" ? "white" : "black";
  const text = (color: string) =>
    contrast === 100
      ? color
      : `color-mix(in oklab, color-mix(in oklab, ${color} ${Math.min(contrast, 100)}%, ${palette.canvas}), ${target} ${Math.max(contrast - 100, 0)}%)`;
  const border =
    contrast === 100
      ? palette.border
      : `color-mix(in srgb, color-mix(in srgb, ${palette.border} ${Math.min(contrast, 100)}%, transparent), ${palette.text} ${Math.max(contrast - 100, 0) / 4}%)`;
  return {
    "--background": palette.canvas,
    "--surface": palette.surface,
    "--surface-raised": palette.surfaceRaised,
    "--overlay": palette.surfaceOverlay,
    "--sidebar": palette.sidebar,
    "--foreground": text(palette.text),
    "--muted": text(palette.textMuted),
    "--border": border,
    "--input": palette.input,
    "--hover": palette.sidebarRowHover,
    "--accent": palette.accent,
    "--accent-text": palette.accentForeground,
    "--accent-soft": palette.accentSurface,
    "--warning": palette.warningForeground,
    "--warning-soft": palette.warningSurface,
    "--error": palette.errorForeground,
    "--error-soft": palette.errorSurface,
    "--info": palette.updateForeground,
    "--info-soft": palette.updateSurface,
    "--code-background": palette.codeBackground,
    "--code-foreground": palette.codeForeground,
    "--glass-opacity": `${appearance.glassOpacity}%`,
    "--panel-duration": `${appearance.panelAnimationMs}ms`,
    "--content-width":
      appearance.contentWidth === "comfortable"
        ? "1200px"
        : appearance.contentWidth === "wide"
          ? "1600px"
          : "none",
    "--interface-font":
      appearance.interfaceFont === "System default"
        ? '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
        : `"${appearance.interfaceFont}", system-ui, sans-serif`,
    "--interface-scale": String(appearance.interfaceFontSize / 16),
    "--monospace-font":
      appearance.monospaceFont === "System default"
        ? "ui-monospace, Consolas, monospace"
        : `"${appearance.monospaceFont}", monospace`,
    "--monospace-scale": String(appearance.monospaceFontSize / 13),
    "--table-font-size": appearance.tableFontSize ? `${appearance.tableFontSize}px` : "inherit",
    "--evidence-font-scale": String(
      appearance.evidenceFontSize
        ? appearance.evidenceFontSize / 16
        : appearance.interfaceFontSize / 16,
    ),
  };
}
