import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { defaultBindings, readBindings, type Bindings } from "./keybindings";
import {
  appearanceVariables,
  defaultAppearance,
  readAppearance,
  readCustomThemes,
  readTheme,
  readThemeHalves,
  resolvePalette,
  type Appearance,
  type Theme,
  type ThemeHalves,
} from "./appearance";
import { builtInThemes, type ThemeDefinition, type ThemeMode } from "./theme-palettes";

const storageKey = "versionstead.theme";

const Preferences = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
  compact: boolean;
  setCompact: (value: boolean) => void;
  reducedMotion: boolean;
  setReducedMotion: (value: boolean) => void;
  bindings: Bindings;
  setBindings: (value: Bindings) => void;
  appearance: Appearance;
  updateAppearance: (value: Partial<Appearance>) => void;
  resolvedTheme: ThemeMode;
  themes: readonly ThemeDefinition[];
  customThemes: ThemeDefinition[];
  setCustomThemes: (value: ThemeDefinition[]) => void;
  themeHalves: ThemeHalves;
  setThemeHalf: (mode: ThemeMode, id: string) => void;
  restoreDeviceDefaults: () => void;
} | null>(null);
function readLocal(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
  } catch {
    return null;
  }
}
/** What this device saved, validated. A missing or restricted store gives the defaults. */
function readSaved() {
  let theme: Theme = "system";
  try {
    theme = readTheme(localStorage.getItem(storageKey));
  } catch {
    // Restricted browser storage keeps the system theme for this session.
  }
  const customThemes = readCustomThemes(readLocal("versionstead.themes"));
  return {
    theme,
    compact: readLocal("versionstead.compact") === true,
    reducedMotion: readLocal("versionstead.reducedMotion") === true,
    bindings: readBindings(readLocal("versionstead.keybindings") ?? defaultBindings),
    appearance: readAppearance(readLocal("versionstead.appearance")),
    customThemes,
    themeHalves: readThemeHalves(readLocal("versionstead.theme-halves"), [
      ...builtInThemes,
      ...customThemes,
    ]),
  };
}
const systemIsDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

/** Puts a theme on the page and returns the palette halves it used, once validated. */
function applyTheme(
  theme: Theme,
  resolvedTheme: ThemeMode,
  appearance: Appearance,
  themes: readonly ThemeDefinition[],
  themeHalves: ThemeHalves,
) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.resolvedTheme = resolvedTheme;
  root.dataset.wordWrap = String(appearance.wordWrap);
  root.dataset.tableFontCustom = String(appearance.tableFontSize !== 0);
  root.style.colorScheme = resolvedTheme;
  root.style.fontSize = `${appearance.interfaceFontSize}px`;
  const validHalves = readThemeHalves(themeHalves, themes);
  const variables = appearanceVariables(
    resolvePalette(validHalves, themes, resolvedTheme),
    appearance,
    resolvedTheme,
  );
  for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
  return validHalves;
}
function applyPreferences(compact: boolean, reducedMotion: boolean) {
  document.documentElement.dataset.density = compact ? "compact" : "comfortable";
  document.documentElement.dataset.reducedMotion = String(reducedMotion);
}
/**
 * Applies the saved theme before React renders, so a reload shows it from the first frame instead of
 * the defaults followed by a jump. A script in the page would break the CSP, so main.tsx calls this.
 */
export function applySavedAppearance() {
  const saved = readSaved();
  applyTheme(
    saved.theme,
    saved.theme === "system" ? (systemIsDark() ? "dark" : "light") : saved.theme,
    saved.appearance,
    [...builtInThemes, ...saved.customThemes],
    saved.themeHalves,
  );
  applyPreferences(saved.compact, saved.reducedMotion);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [saved] = useState(readSaved);
  const [theme, setTheme] = useState<Theme>(saved.theme);
  const [compact, setCompact] = useState(saved.compact);
  const [reducedMotion, setReducedMotion] = useState(saved.reducedMotion);
  const [bindings, setBindings] = useState(saved.bindings);
  const [appearance, setAppearance] = useState(saved.appearance);
  const [customThemes, setCustomThemes] = useState(saved.customThemes);
  const themes = useMemo(() => [...builtInThemes, ...customThemes], [customThemes]);
  const [themeHalves, setThemeHalves] = useState(saved.themeHalves);
  const [systemDark, setSystemDark] = useState(systemIsDark);
  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    void window.versionstead?.setWindowTheme(theme).catch(() => {
      console.error("Native window appearance could not be saved.");
    });
  }, [theme]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    const validHalves = applyTheme(theme, resolvedTheme, appearance, themes, themeHalves);
    try {
      localStorage.setItem(storageKey, theme);
      localStorage.setItem("versionstead.appearance", JSON.stringify(appearance));
      localStorage.setItem(
        "versionstead.themes",
        JSON.stringify(customThemes.map((value) => ({ version: 1, ...value }))),
      );
      localStorage.setItem("versionstead.theme-halves", JSON.stringify(validHalves));
    } catch {
      // Restricted browser storage still allows a theme for this session.
    }
  }, [theme, resolvedTheme, appearance, customThemes, themeHalves, themes]);
  useEffect(() => {
    applyPreferences(compact, reducedMotion);
    try {
      localStorage.setItem("versionstead.compact", JSON.stringify(compact));
      localStorage.setItem("versionstead.reducedMotion", JSON.stringify(reducedMotion));
      localStorage.setItem("versionstead.keybindings", JSON.stringify(bindings));
    } catch {
      /* Preferences remain active for this session. */
    }
  }, [compact, reducedMotion, bindings]);
  return (
    <Preferences
      value={{
        theme,
        setTheme,
        compact,
        setCompact,
        reducedMotion,
        setReducedMotion,
        bindings,
        setBindings,
        appearance,
        updateAppearance: (value) =>
          setAppearance((previous) => readAppearance({ ...previous, ...value })),
        resolvedTheme,
        themes,
        customThemes,
        setCustomThemes,
        themeHalves: readThemeHalves(themeHalves, themes),
        setThemeHalf: (mode, id) => setThemeHalves((previous) => ({ ...previous, [mode]: id })),
        restoreDeviceDefaults: () => {
          setTheme("system");
          setCompact(false);
          setReducedMotion(false);
          setBindings(defaultBindings);
          setAppearance(defaultAppearance);
          setThemeHalves(readThemeHalves(null, themes));
        },
      }}
    >
      {children}
    </Preferences>
  );
}
export function useAppearance() {
  const context = useContext(Preferences);
  if (!context) throw new Error("Appearance provider is missing.");
  return context;
}
