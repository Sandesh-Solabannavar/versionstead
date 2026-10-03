import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { defaultBindings, readBindings, type Bindings } from "./keybindings";
import {
  appearanceVariables,
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
} | null>(null);
function readLocal(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
  } catch {
    return null;
  }
}
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return readTheme(localStorage.getItem(storageKey));
    } catch {
      return "system";
    }
  });
  const [compact, setCompact] = useState(() => readLocal("versionstead.compact") === true);
  const [reducedMotion, setReducedMotion] = useState(
    () => readLocal("versionstead.reducedMotion") === true,
  );
  const [bindings, setBindings] = useState(() =>
    readBindings(readLocal("versionstead.keybindings") ?? defaultBindings),
  );
  const [appearance, setAppearance] = useState(() =>
    readAppearance(readLocal("versionstead.appearance")),
  );
  const [customThemes, setCustomThemes] = useState(() =>
    readCustomThemes(readLocal("versionstead.themes")),
  );
  const themes = useMemo(() => [...builtInThemes, ...customThemes], [customThemes]);
  const [themeHalves, setThemeHalves] = useState(() =>
    readThemeHalves(readLocal("versionstead.theme-halves"), themes),
  );
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
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
    document.documentElement.dataset.density = compact ? "compact" : "comfortable";
    document.documentElement.dataset.reducedMotion = String(reducedMotion);
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
