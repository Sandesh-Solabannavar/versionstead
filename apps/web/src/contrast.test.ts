import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appearanceVariables, defaultAppearance } from "./appearance.ts";
import { builtInThemes } from "./theme-palettes.ts";

// Evaluates the stylesheet's colors the way a browser does: the palette's inline variables sit on
// top of the :root defaults. Only the few color forms the stylesheet uses are understood, and
// anything else fails loudly, so a new form has to be taught here rather than skipped.
const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const css = read("./index.css").replace(/\/\*[\s\S]*?\*\//g, "");
const projectCss = read("./project-settings.css").replace(/\/\*[\s\S]*?\*\//g, "");
type Rgb = [number, number, number];
type Mode = "light" | "dark";
const modes: Mode[] = ["light", "dark"];

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`Missing ${what}`);
  return value;
};
const hex = (value: string): Rgb => {
  const digits = must(/^#([\da-f]{6})$/i.exec(value), `hex color ${value}`)[1]!;
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
};
// color-mix(in srgb): component-wise in gamma-encoded sRGB.
const mix = (a: Rgb, share: number, b: Rgb) =>
  a.map((v, i) => v * share + b[i]! * (1 - share)) as Rgb;
const toHex = (rgb: Rgb) =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const channel = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a: Rgb, b: Rgb) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
};
// A comma outside any parentheses splits a function's arguments.
const args = (text: string) => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  return [...parts, current.trim()];
};

const rootBlock = must(/:root \{([\s\S]*?)\n\}/.exec(css), ":root block")[1]!;
const declared: Record<string, string> = {};
for (const [, name, value] of rootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g))
  declared[name!] = value!.trim();

function colors(mode: Mode, local: Record<string, string> = {}) {
  const palette = appearanceVariables(builtInThemes[0]![mode], defaultAppearance, mode);
  const evaluate = (value: string): Rgb => {
    value = value.trim();
    if (value.startsWith("#")) return hex(value);
    const lightDark = /^light-dark\(([\s\S]*)\)$/.exec(value);
    if (lightDark) {
      const [light, dark] = args(lightDark[1]!);
      return evaluate(mode === "light" ? must(light, "light value") : must(dark, "dark value"));
    }
    const variable = /^var\((--[\w-]+)\)$/.exec(value);
    if (variable) {
      const name = variable[1]!;
      return evaluate(must(local[name] ?? palette[name] ?? declared[name], `variable ${name}`));
    }
    const colorMix = /^color-mix\(in srgb,\s*([\s\S]*)\)$/.exec(value);
    if (colorMix) {
      const [first, second] = args(colorMix[1]!);
      const part = must(/^([\s\S]+?)\s+([\d.]+)%$/.exec(must(first, "mix color")), "mix share");
      const share = Number(part[2]) / 100;
      const a = evaluate(part[1]!);
      const b = evaluate(must(second, "mix base"));
      return mix(a, share, b);
    }
    throw new Error(`Unsupported color: ${value}`);
  };
  return evaluate;
}
const declarations = (source: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A rule starts the file or follows the previous rule's closing brace, not a line of a selector list.
  const rule = new RegExp(`(?:^|\\})\\s*${escaped} \\{([^}]*)\\}`);
  const body = must(rule.exec(source), `rule ${selector}`)[1]!;
  return Object.fromEntries(
    [...body.matchAll(/([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]),
  );
};
const surfaces = ["--background", "--surface", "--surface-raised", "--sidebar", "--overlay"];
// Dialogs and drawers are glass: the overlay color at --glass-opacity over a page the scrim has
// darkened. The scrim is black at the alpha of a four-digit hex such as #0006.
const scrimDigit = must(
  /\[data-slot="sheet-backdrop"\] \{[^}]*?background:\s*#000([\da-f]);/.exec(css),
  "scrim",
)[1]!;
const scrimAlpha = parseInt(scrimDigit + scrimDigit, 16) / 255;
const glassOpacity = parseFloat(must(declared["--glass-opacity"], "--glass-opacity")) / 100;
const glassSurface = (mode: Mode) => {
  const evaluate = colors(mode);
  const dimmed = mix(hex("#000000"), scrimAlpha, evaluate("var(--background)"));
  return mix(evaluate("var(--overlay)"), glassOpacity, dimmed);
};

test("the CSS defaults are the default palette, so a first paint matches what React then applies", () => {
  for (const mode of modes) {
    const palette = appearanceVariables(builtInThemes[0]![mode], defaultAppearance, mode);
    const evaluate = colors(mode);
    for (const [name, value] of Object.entries(palette)) {
      if (!value.startsWith("#")) continue;
      assert.equal(
        toHex(evaluate(must(declared[name], `CSS default for ${name}`))),
        value.toLowerCase(),
        `${name} (${mode})`,
      );
    }
  }
});

test("control boundaries and the switch's off state are visible against every surface", () => {
  for (const mode of modes) {
    const evaluate = colors(mode);
    const boundaries = [
      declarations(css, "input")["border"]!.replace("1px solid ", ""),
      declarations(css, '[data-slot="select-trigger"]')["border-color"]!,
      declarations(css, ".settings-switch")["background"]!,
      declarations(css, ".settings-switch")["border"]!.replace("1px solid ", ""),
      declarations(css, ".theme-import textarea")["border"]!.replace("1px solid ", ""),
      declarations(css, '.theme-color-fields input[type="color"]')["border"]!.replace(
        "1px solid ",
        "",
      ),
      declarations(projectCss, ".project-action-form textarea")["border"]!.replace(
        "1px solid ",
        "",
      ),
    ];
    for (const boundary of boundaries) {
      for (const surface of [...surfaces, "--accent-soft"])
        assert.ok(
          ratio(evaluate(boundary), evaluate(`var(${surface})`)) >= 3,
          `${boundary} on ${surface} (${mode}) is ${ratio(evaluate(boundary), evaluate(`var(${surface})`)).toFixed(2)}:1`,
        );
      // Inside a dialog or drawer the field sits on glass, darker than a surface, with margin
      // because glass opacity is a setting.
      const onGlass = ratio(evaluate(boundary), glassSurface(mode));
      assert.ok(onGlass >= 3.2, `${boundary} on glass (${mode}) is ${onGlass.toFixed(2)}:1`);
    }
    // The on state and its thumb are distinguishable too.
    const on = evaluate(declarations(css, ".settings-switch[data-checked]")["background"]!);
    assert.ok(ratio(on, evaluate("var(--surface)")) >= 3, `switch on (${mode})`);
    assert.ok(ratio(evaluate("var(--surface)"), on) >= 3, `switch thumb on (${mode})`);
    assert.ok(
      ratio(evaluate("var(--surface)"), evaluate("var(--control-border)")) >= 3,
      `switch thumb off (${mode})`,
    );
  }
});

test("link and badge text reach 4.5:1 on their backgrounds in both themes", () => {
  for (const mode of modes) {
    const evaluate = colors(mode);
    const link = evaluate(declarations(css, ".text-link")["color"]!);
    for (const surface of [...surfaces, "--accent-soft"])
      assert.ok(ratio(link, evaluate(`var(${surface})`)) >= 4.5, `link on ${surface} (${mode})`);
    for (const tone of ["success", "warning", "error", "info"]) {
      const rule = declarations(css, `.badge.${tone}`);
      const text = evaluate(must(rule["color"], `${tone} color`));
      const background = evaluate(must(rule["background"], `${tone} background`));
      assert.ok(ratio(text, background) >= 4.5, `${tone} badge (${mode})`);
    }
    // Status dots are graphics, so 3:1 on the surface they sit on.
    assert.ok(ratio(evaluate("var(--success)"), evaluate("var(--surface)")) >= 3, `dot (${mode})`);
  }
});

test("a success badge is green and an update or info badge is blue, never the same color", () => {
  for (const mode of modes) {
    const evaluate = colors(mode);
    const [r, g, b] = evaluate(declarations(css, ".badge.success")["color"]!);
    const [infoR, infoG, infoB] = evaluate(declarations(css, ".badge.info")["color"]!);
    assert.ok(g > r && g > b, `success is green (${mode})`);
    assert.ok(infoB > infoR && infoB > infoG, `info is blue (${mode})`);
    assert.notEqual(
      toHex(evaluate(declarations(css, ".badge.success")["background"]!)),
      toHex(evaluate(declarations(css, ".badge.info")["background"]!)),
    );
  }
});

test("every project monogram color keeps 4.5:1 text on its tint", () => {
  const badge = declarations(projectCss, ".project-badge");
  const palette = [
    ...projectCss.matchAll(/\.project-color-([a-z]+) \{\s*--project-color:\s*(#[\da-f]{6});/g),
  ];
  assert.equal(palette.length, 18);
  for (const mode of modes)
    for (const [, name, color] of palette) {
      const evaluate = colors(mode, { "--project-color": color! });
      const ratioFor = ratio(
        evaluate(must(badge["color"], "badge color")),
        evaluate(must(badge["background"], "badge background")),
      );
      assert.ok(ratioFor >= 4.5, `${name} (${mode}) is ${ratioFor.toFixed(2)}:1`);
    }
});

test("muted text on dialogs and drawers keeps 4.5:1 over the dimmed page they sit on", () => {
  const glass = must(
    /\.form-dialog,[^{]*\{[^}]*?--muted:\s*([^;]+);/.exec(css),
    "glass rule's muted",
  )[1]!;
  for (const mode of modes) {
    const text = colors(mode)(glass);
    const surface = glassSurface(mode);
    assert.ok(
      ratio(text, surface) >= 4.5,
      `muted on glass (${mode}) is ${ratio(text, surface).toFixed(2)}:1`,
    );
  }
});

test("link text on the selected control tint reaches 4.5:1", () => {
  const selected = declarations(projectCss, '.project-icon-types [aria-pressed="true"]');
  for (const mode of modes) {
    const evaluate = colors(mode);
    const text = evaluate(must(selected["color"], "selected color"));
    const tint = evaluate(must(selected["background"], "selected background"));
    assert.ok(
      ratio(text, tint) >= 4.5,
      `selected control (${mode}) is ${ratio(text, tint).toFixed(2)}:1`,
    );
  }
});

test("a quiet button on a warning tint takes the notice's own color, which reaches 4.5:1", () => {
  // Muted text there is only 4.4:1 in the light default and 4.0:1 in the dark one.
  const ghost = declarations(
    css,
    ".notice.warning .button.ghost,\n.connection-banner.warning .button.ghost",
  );
  assert.equal(ghost["color"], "inherit");
  const notice = declarations(css, ".notice.warning,\n.connection-banner.warning");
  for (const mode of modes) {
    const evaluate = colors(mode);
    const text = evaluate(must(notice["color"], "notice color"));
    const tint = evaluate(must(notice["background"], "notice background"));
    assert.ok(
      ratio(text, tint) >= 4.5,
      `warning notice (${mode}) is ${ratio(text, tint).toFixed(2)}:1`,
    );
  }
});
