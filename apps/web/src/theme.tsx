import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const storageKey = "versionstead.theme";

export function readTheme(value: unknown): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

export function ThemeSelect() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return readTheme(localStorage.getItem(storageKey));
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      // Restricted browser storage still allows a theme for this session.
    }
  }, [theme]);

  return (
    <label className="theme-control">
      <span>Appearance</span>
      <select value={theme} onChange={(event) => setTheme(readTheme(event.target.value))}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
