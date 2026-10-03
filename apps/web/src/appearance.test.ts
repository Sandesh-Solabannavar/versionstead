import assert from "node:assert/strict";
import test from "node:test";
import {
  appearanceVariables,
  defaultAppearance,
  importTheme,
  isThemeColor,
  readAppearance,
  readCustomThemes,
  readTheme,
  readThemeHalves,
  resolvePalette,
  serializeTheme,
} from "./appearance.ts";
import { builtInThemes, colorRoles } from "./theme-palettes.ts";

test("appearance validates saved/imported settings and keeps independently selected palette halves", () => {
  assert.equal(readTheme("dark"), "dark");
  assert.equal(readTheme("unknown"), "system");
  assert.deepEqual(readAppearance(null), defaultAppearance);
  const bad = readAppearance({
    contrast: 999,
    glassOpacity: -1,
    panelAnimationMs: Infinity,
    interfaceFont: "url(evil)",
    monospaceFontSize: 30,
    tableFontSize: 9,
    evidenceFontSize: 50,
  });
  assert.deepEqual(bad, defaultAppearance);
  assert.equal(
    readAppearance({
      interfaceFont: "Segoe UI",
      interfaceFontSize: 20,
      monospaceFont: "Consolas",
      contentWidth: "full",
      wordWrap: false,
    }).interfaceFont,
    "Segoe UI",
  );
  for (const theme of builtInThemes)
    for (const mode of ["light", "dark"] as const)
      for (const role of colorRoles)
        assert(isThemeColor(theme[mode][role]), `${theme.label} ${mode} ${role}`);
  for (const value of [
    "var(--token)",
    "url(https://example.com)",
    "#ffffff; background: red",
    "oklch(2 0 1)",
    "oklch(0.5 1 30)",
    "oklch(NaN 0 1)",
  ])
    assert.equal(isThemeColor(value), false);
  const fixture = {
    version: 1,
    id: "my-theme",
    name: "My theme",
    appearance: "dark",
    colors: { canvas: "#121314", text: "#eeeeee" },
    variants: { light: { accent: "#224466" } },
  };
  const imported = importTheme(JSON.stringify(fixture));
  assert.equal(imported.dark.canvas, "#121314");
  assert.equal(imported.light.accent, "#224466");
  assert.equal(imported.light.canvas, builtInThemes[0]!.light.canvas);
  assert.deepEqual(importTheme(serializeTheme(imported)), imported);
  const themes = [...builtInThemes, imported];
  const halves = readThemeHalves({ light: "grove", dark: imported.id }, themes);
  assert.equal(
    resolvePalette(halves, themes, "light"),
    builtInThemes.find((value) => value.id === "grove")!.light,
  );
  assert.equal(resolvePalette(halves, themes, "dark"), imported.dark);
  assert.deepEqual(readThemeHalves(halves, builtInThemes), { light: "grove", dark: "default" });
  assert.deepEqual(readCustomThemes([{}, fixture, fixture]), [imported]);
  assert.throws(() => importTheme(JSON.stringify({ ...fixture, id: "default" })));
  assert.throws(() =>
    importTheme(JSON.stringify({ ...fixture, colors: { accent: "var(--untrusted)" } })),
  );
  assert.throws(() => importTheme(" ".repeat(65537)), /64 KiB/);
  const profile = readAppearance({
    contrast: 150,
    glassOpacity: 50,
    panelAnimationMs: 250,
    interfaceFont: "Segoe UI",
    monospaceFontSize: 16,
    contentWidth: "wide",
  });
  const variables = appearanceVariables(imported.dark, profile, "dark");
  assert.match(variables["--foreground"]!, /white 50%/);
  assert.equal(variables["--glass-opacity"], "50%");
  assert.equal(variables["--panel-duration"], "250ms");
  assert.equal(variables["--content-width"], "1600px");
  assert.match(variables["--interface-font"]!, /Segoe UI/);
});
