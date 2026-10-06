import { useState, type CSSProperties, type ReactNode } from "react";
import { Copy, Moon, Paintbrush, Pencil, Plus, RotateCcw, Sun, Trash2 } from "lucide-react";
import { useAppearance } from "./theme";
import { builtInThemes, colorRoles, type ThemeDefinition, type ThemeMode } from "./theme-palettes";
import {
  defaultAppearance,
  importTheme,
  interfaceFonts,
  maxCustomThemes,
  maxThemeBytes,
  monospaceFonts,
  resolvePalette,
  serializeTheme,
} from "./appearance";
import {
  ThemeWireframe,
  ThemePreviewCircle,
  PanelAnimationsPreview,
  previewColors,
} from "./appearance-previews";
import { Choice, SettingGroup, SettingRow } from "./components/settings-controls";
import { Switch } from "./components/ui/switch";
import { Button, Dialog, Input } from "./ui";

function Range({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="appearance-range">
      <output
        htmlFor={`appearance-${label.toLowerCase().replaceAll(" ", "-")}`}
        className="appearance-value"
      >
        {value}
        {unit}
      </output>
      <input
        id={`appearance-${label.toLowerCase().replaceAll(" ", "-")}`}
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={
          {
            "--settings-slider-progress": `${((value - min) / (max - min)) * 100}%`,
          } as CSSProperties
        }
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </div>
  );
}
function Reset({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      className="appearance-reset"
      aria-label={`Reset ${label}`}
      title={`Reset ${label}`}
      onClick={onClick}
    >
      <RotateCcw size={12} aria-hidden />
    </Button>
  );
}
function hexColor(color: string): string {
  if (color.startsWith("#")) return color;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return "#808080";
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return `#${[...context.getImageData(0, 0, 1, 1).data]
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}
const roleLabel = (role: string) =>
  role.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());

function ThemeEditor({
  initial,
  onSave,
  onClose,
}: {
  initial: ThemeDefinition;
  onSave: (theme: ThemeDefinition) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [mode, setMode] = useState<ThemeMode>("light");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const roles = advanced
    ? colorRoles
    : ([
        "canvas",
        "sidebar",
        "surface",
        "text",
        "textMuted",
        "border",
        "accent",
        "accentForeground",
      ] as const);
  return (
    <Dialog title="Edit theme" onClose={onClose}>
      <form
        className="theme-editor"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            onSave(importTheme(serializeTheme(draft)));
            onClose();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Theme could not be saved.");
          }
        }}
      >
        <label className="field-label">
          Theme name
          <Input
            aria-label="Theme name"
            required
            maxLength={48}
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          />
        </label>
        <div className="theme-editor-tools">
          <Choice
            label="Edit appearance"
            value={mode}
            items={[
              { value: "light", label: "Light colors" },
              { value: "dark", label: "Dark colors" },
            ]}
            onChange={(value) => setMode(value === "dark" ? "dark" : "light")}
          />
          <Choice
            label="Start from palette"
            value=""
            items={[
              { value: "", label: "Start from palette" },
              ...builtInThemes.map((theme) => ({ value: theme.id, label: theme.label })),
            ]}
            onChange={(id) => {
              const base = builtInThemes.find((theme) => theme.id === id);
              if (base) setDraft({ ...draft, light: { ...base.light }, dark: { ...base.dark } });
            }}
          />
        </div>
        <ThemeWireframe
          className="theme-editor-preview"
          panes={[{ colors: previewColors(draft[mode]) }]}
        />
        <div className="theme-color-fields">
          {roles.map((role) => (
            <label key={role}>
              <span>{roleLabel(role)}</span>
              <input
                type="color"
                aria-label={`${mode} ${roleLabel(role)}`}
                value={hexColor(draft[mode][role])}
                onChange={(event) =>
                  setDraft({ ...draft, [mode]: { ...draft[mode], [role]: event.target.value } })
                }
              />
            </label>
          ))}
        </div>
        <label className="appearance-inline-switch">
          All palette colors
          <Switch
            checked={advanced}
            onCheckedChange={setAdvanced}
            aria-label="All palette colors"
          />
        </label>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="row-actions">
          <Button variant="primary" type="submit">
            Save theme
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(serializeTheme(draft)).then(
                () => setCopied(true),
                () => setError("Clipboard is unavailable."),
              );
            }}
          >
            Copy theme JSON
          </Button>
          {copied && <span role="status">Copied.</span>}
        </div>
      </form>
    </Dialog>
  );
}
function ThemeImport({
  onSave,
  onClose,
}: {
  onSave: (theme: ThemeDefinition) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Add theme" onClose={onClose}>
      <form
        className="theme-import"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            onSave(importTheme(text));
            onClose();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Theme could not be imported.");
          }
        }}
      >
        <p className="muted">Import a Versionstead theme JSON file. Colors stay on this device.</p>
        <label className="field-label">
          Choose theme file
          <Input
            type="file"
            aria-label="Choose theme file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > maxThemeBytes) {
                setError("Theme files must be at most 64 KiB.");
                return;
              }
              void file.text().then(
                (value) => {
                  setText(value);
                  setError(null);
                },
                () => setError("Could not read the theme file."),
              );
            }}
          />
        </label>
        <label className="field-label">
          Or paste theme JSON
          <textarea
            aria-label="Theme JSON"
            rows={10}
            maxLength={maxThemeBytes}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="row-actions">
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            Add theme
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dialog>
  );
}
export function AppearanceSettings() {
  const {
    theme,
    setTheme,
    resolvedTheme,
    themes,
    customThemes,
    setCustomThemes,
    themeHalves,
    setThemeHalf,
    appearance,
    updateAppearance,
    compact,
    setCompact,
    reducedMotion,
    setReducedMotion,
  } = useAppearance();
  const [editor, setEditor] = useState<ThemeDefinition | null>(null);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<ThemeDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const light = resolvePalette(themeHalves, themes, "light");
  const dark = resolvePalette(themeHalves, themes, "dark");
  const newDraft = (source?: ThemeDefinition) => {
    if (customThemes.length >= maxCustomThemes) {
      setError("Remove a custom theme before adding another. The limit is 50.");
      return;
    }
    setEditor({
      id: `custom-${crypto.randomUUID()}`,
      label: source ? `${source.label.slice(0, 40)} copy` : "My theme",
      light: { ...(source?.light ?? light) },
      dark: { ...(source?.dark ?? dark) },
    });
  };
  const save = (value: ThemeDefinition, fromImport = false) => {
    const existing = customThemes.findIndex((candidate) => candidate.id === value.id);
    if (fromImport && existing !== -1)
      throw new Error("This theme ID already exists. Edit it or change the imported ID.");
    if (existing === -1 && customThemes.length >= maxCustomThemes)
      throw new Error("The custom theme limit is 50.");
    setCustomThemes(
      existing === -1
        ? [...customThemes, value]
        : customThemes.map((candidate) => (candidate.id === value.id ? value : candidate)),
    );
    setThemeHalf("light", value.id);
    setThemeHalf("dark", value.id);
    setError(null);
  };
  const fontItems = (values: readonly string[]) => values.map((value) => ({ value, label: value }));
  const sizes = (min: number, max: number) =>
    Array.from({ length: max - min + 1 }, (_, index) => ({
      value: String(min + index),
      label: `${min + index} px`,
    }));
  const control = (label: string, changed: boolean, reset: () => void, element: ReactNode) => (
    <div className="appearance-control">
      {changed && <Reset label={label} onClick={reset} />}
      {element}
    </div>
  );
  const previewInterface: CSSProperties = {
    fontFamily:
      appearance.interfaceFont === "System default" ? undefined : appearance.interfaceFont,
    fontSize: `${appearance.interfaceFontSize}px`,
  };
  const previewCode: CSSProperties = {
    fontFamily:
      appearance.monospaceFont === "System default" ? undefined : appearance.monospaceFont,
    fontSize: `${appearance.monospaceFontSize}px`,
  };
  return (
    <div className="appearance-settings">
      <section aria-label="Appearance modes" className="appearance-mode-grid">
        {(["system", "light", "dark"] as const).map((mode) => (
          <button
            className="appearance-mode-card"
            key={mode}
            type="button"
            aria-label={`${mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"} theme`}
            aria-pressed={theme === mode}
            onClick={() => setTheme(mode)}
          >
            <ThemeWireframe
              className="h-28"
              panes={
                mode === "system"
                  ? [
                      { colors: previewColors(light), clip: "left" },
                      { colors: previewColors(dark), clip: "right" },
                    ]
                  : [{ colors: previewColors(mode === "light" ? light : dark) }]
              }
            />
            <span>{mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}</span>
          </button>
        ))}
      </section>
      <section className="setting-section" aria-label="Themes">
        <div className="section-title-row">
          <h2>Themes</h2>
          <div className="row-actions">
            <Button onClick={() => newDraft()}>
              <Paintbrush size={12} aria-hidden />
              Create theme
            </Button>
            <Button onClick={() => setImporting(true)}>
              <Plus size={12} aria-hidden />
              Add theme
            </Button>
          </div>
        </div>
        <div className="theme-library-grid">
          {themes.map((palette) => (
            <div
              className="theme-library-card"
              data-theme-library-card={palette.id}
              key={palette.id}
            >
              <div className="theme-pair">
                {(["light", "dark"] as const).map((mode) => {
                  const selected = themeHalves[mode] === palette.id;
                  const colors = previewColors(palette[mode]);
                  if (palette.id === "default") {
                    colors.accent = mode === "light" ? "#f4f4f5" : "#1c1c1f";
                    colors.messageAction = mode === "light" ? "#4f46e5" : "#8b9cff";
                  }
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-label={`Use ${palette.label} ${mode} mode`}
                      title={`Use for ${mode} mode only`}
                      aria-pressed={selected}
                      className="theme-orb-button"
                      onClick={() => setThemeHalf(mode, palette.id)}
                    >
                      <ThemePreviewCircle colors={colors} mode={mode} />
                      {selected && (
                        <span className="theme-orb-badge" aria-hidden>
                          {mode === "light" ? <Sun size={12} /> : <Moon size={12} />}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="theme-card-footer">
                <button
                  type="button"
                  className="theme-card-name"
                  aria-label={`Use ${palette.label} theme`}
                  onClick={() => {
                    setThemeHalf("light", palette.id);
                    setThemeHalf("dark", palette.id);
                  }}
                >
                  {palette.label}
                </button>
                <div className="theme-card-actions">
                  {customThemes.some((value) => value.id === palette.id) && (
                    <>
                      <Button
                        variant="ghost"
                        aria-label={`Edit ${palette.label}`}
                        title="Edit theme"
                        onClick={() => setEditor(palette)}
                      >
                        <Pencil size={13} aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        aria-label={`Remove ${palette.label}`}
                        title="Remove theme"
                        onClick={() => setRemoving(palette)}
                      >
                        <Trash2 size={13} aria-hidden />
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    aria-label={`Duplicate ${palette.label}`}
                    title="Duplicate theme"
                    onClick={() => newDraft(palette)}
                  >
                    <Copy size={13} aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </section>
      <SettingGroup title="Interface">
        <SettingRow
          label="Contrast"
          description="Adjust the contrast of colors and borders across the interface."
        >
          {control(
            "contrast",
            appearance.contrast !== 100,
            () => updateAppearance({ contrast: 100 }),
            <Range
              label="Contrast"
              value={appearance.contrast}
              min={50}
              max={200}
              step={5}
              unit="%"
              onChange={(contrast) => updateAppearance({ contrast })}
            />,
          )}
        </SettingRow>
        <SettingRow
          label="Glass opacity"
          description="Higher values make menus, dialogs, and evidence panels more solid."
        >
          {control(
            "glass opacity",
            appearance.glassOpacity !== 80,
            () => updateAppearance({ glassOpacity: 80 }),
            <Range
              label="Glass opacity"
              value={appearance.glassOpacity}
              min={40}
              max={100}
              step={5}
              unit="%"
              onChange={(glassOpacity) => updateAppearance({ glassOpacity })}
            />,
          )}
        </SettingRow>
        <SettingRow
          label="Content width"
          description="Set how wide monitoring pages can grow on large screens."
        >
          {control(
            "content width",
            appearance.contentWidth !== "comfortable",
            () => updateAppearance({ contentWidth: "comfortable" }),
            <Choice
              label="Content width"
              value={appearance.contentWidth}
              items={[
                { value: "comfortable", label: "Comfortable" },
                { value: "wide", label: "Wide" },
                { value: "full", label: "Full" },
              ]}
              onChange={(value) =>
                updateAppearance({
                  contentWidth: value === "wide" || value === "full" ? value : "comfortable",
                })
              }
            />,
          )}
        </SettingRow>
        <SettingRow
          label="Compact rows"
          description="Reduce package table spacing to show more evidence at once."
        >
          <Switch aria-label="Compact rows" checked={compact} onCheckedChange={setCompact} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Motion">
        <SettingRow
          label="Panel animations"
          description="Set how fast evidence panels open and close."
        >
          <div className="appearance-motion-control">
            <PanelAnimationsPreview durationMs={reducedMotion ? 0 : appearance.panelAnimationMs} />
            {control(
              "panel animations",
              appearance.panelAnimationMs !== 0,
              () => updateAppearance({ panelAnimationMs: 0 }),
              <Range
                label="Panel animation duration"
                value={appearance.panelAnimationMs}
                min={0}
                max={400}
                step={25}
                unit=" ms"
                onChange={(panelAnimationMs) => updateAppearance({ panelAnimationMs })}
              />,
            )}
          </div>
        </SettingRow>
        <SettingRow
          label="Reduce motion"
          description="Keep transitions still. Your system reduced-motion preference is also respected."
        >
          <Switch
            aria-label="Reduce motion"
            checked={reducedMotion}
            onCheckedChange={setReducedMotion}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup
        title="Typography"
        action={
          <label className="appearance-inline-switch">
            Advanced
            <Switch
              aria-label="Advanced typography"
              checked={appearance.advancedTypography}
              onCheckedChange={(advancedTypography) => updateAppearance({ advancedTypography })}
            />
          </label>
        }
      >
        <div className="typography-font-group">
          <SettingRow
            label="Interface font"
            description="Navigation, settings, package labels, and evidence summaries."
          >
            <div className="font-controls">
              <Choice
                label="Interface font"
                value={appearance.interfaceFont}
                items={fontItems(interfaceFonts)}
                onChange={(interfaceFont) => updateAppearance({ interfaceFont })}
              />
              <Choice
                label="Interface font size"
                value={String(appearance.interfaceFontSize)}
                items={sizes(12, 20)}
                onChange={(value) => updateAppearance({ interfaceFontSize: Number(value) })}
              />
            </div>
          </SettingRow>
          <div className="typography-interface-preview" style={previewInterface}>
            Review <span className="preview-package">react</span> in{" "}
            <span className="preview-package">package.json</span>: a newer version is available.{" "}
            <span className="preview-status">Read-only scan</span>
          </div>
        </div>
        <div className="typography-font-group">
          <SettingRow
            label="Monospace font"
            description="Versions, package paths, commands, and collected input fingerprints."
          >
            <div className="font-controls">
              <Choice
                label="Monospace font"
                value={appearance.monospaceFont}
                items={fontItems(monospaceFonts)}
                onChange={(monospaceFont) => updateAppearance({ monospaceFont })}
              />
              <Choice
                label="Monospace font size"
                value={String(appearance.monospaceFontSize)}
                items={sizes(10, 18)}
                onChange={(value) => updateAppearance({ monospaceFontSize: Number(value) })}
              />
            </div>
          </SettingRow>
          <div className="typography-code-preview" style={previewCode}>
            <div className="preview-file">
              package.json <span>Version evidence</span>
            </div>
            <pre>
              <code>{`{\n  "dependencies": {\n    "react": "^19.3.0",\n    "@tanstack/react-router": "^1.170.41"\n  }\n}`}</code>
            </pre>
            <div className="preview-command">
              <span>›</span> pnpm outdated
              <br />
              <span>✓</span> Scan finished · package files were not changed.
            </div>
          </div>
        </div>
        {appearance.advancedTypography && (
          <>
            <SettingRow
              label="Package table font size"
              description="Override the interface size for installed tools and dependency tables."
            >
              <Choice
                label="Package table font size"
                value={String(appearance.tableFontSize)}
                items={[{ value: "0", label: "Follow interface" }, ...sizes(10, 18)]}
                onChange={(value) => updateAppearance({ tableFontSize: Number(value) })}
              />
            </SettingRow>
            <SettingRow
              label="Evidence panel font size"
              description="Override the interface size inside package and release detail panels."
            >
              <Choice
                label="Evidence panel font size"
                value={String(appearance.evidenceFontSize)}
                items={[{ value: "0", label: "Follow interface" }, ...sizes(12, 20)]}
                onChange={(value) => updateAppearance({ evidenceFontSize: Number(value) })}
              />
            </SettingRow>
            <SettingRow
              label="Reset typography"
              description="Restore default font families, sizes, and surface overrides."
            >
              <Button
                onClick={() =>
                  updateAppearance({
                    interfaceFont: defaultAppearance.interfaceFont,
                    interfaceFontSize: 16,
                    monospaceFont: defaultAppearance.monospaceFont,
                    monospaceFontSize: 13,
                    tableFontSize: 0,
                    evidenceFontSize: 0,
                  })
                }
              >
                Reset typography
              </Button>
            </SettingRow>
          </>
        )}
        <SettingRow
          label="Word wrap"
          description="Wrap long package names, paths, version details, and code previews."
        >
          <Switch
            aria-label="Word wrap"
            checked={appearance.wordWrap}
            onCheckedChange={(wordWrap) => updateAppearance({ wordWrap })}
          />
        </SettingRow>
      </SettingGroup>
      <p className="appearance-note muted small">
        Preferences stay on this device. System mode currently uses the {resolvedTheme} palette.
        Typography previews are examples.
      </p>
      {editor && (
        <ThemeEditor
          initial={editor}
          onClose={() => setEditor(null)}
          onSave={(value) => save(value)}
        />
      )}
      {importing && (
        <ThemeImport onClose={() => setImporting(false)} onSave={(value) => save(value, true)} />
      )}
      {removing && (
        <Dialog title={`Remove ${removing.label}?`} onClose={() => setRemoving(null)}>
          <p>Selected light or dark modes will be removed. Saved scan evidence stays available.</p>
          <div className="row-actions">
            <Button
              variant="danger"
              onClick={() => {
                setCustomThemes(customThemes.filter((value) => value.id !== removing.id));
                for (const mode of ["light", "dark"] as const)
                  if (themeHalves[mode] === removing.id) setThemeHalf(mode, "default");
                setRemoving(null);
              }}
            >
              Remove theme
            </Button>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
