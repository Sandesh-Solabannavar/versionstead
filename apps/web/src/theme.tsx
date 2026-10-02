import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "./ui";

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
    <div className="theme-control" role="group" aria-label="Appearance">
      <span>Appearance</span>
      <div className="theme-buttons">
        {(
          [
            ["system", Monitor],
            ["light", Sun],
            ["dark", Moon],
          ] as const
        ).map(([value, Icon]) => (
          <Button
            key={value}
            variant="ghost"
            className="theme-button"
            aria-label={`${value === "system" ? "System" : value === "light" ? "Light" : "Dark"} theme`}
            title={`${value === "system" ? "Follow system" : value === "light" ? "Light" : "Dark"} theme`}
            aria-pressed={theme === value}
            onClick={() => setTheme(value)}
          >
            <Icon aria-hidden="true" size={16} />
          </Button>
        ))}
      </div>
    </div>
  );
}
