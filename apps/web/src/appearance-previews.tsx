// Adapted from T3 Code (MIT); see public/THIRD_PARTY_NOTICES.txt.
import { useState, type CSSProperties } from "react";
import { cn } from "./lib/utils";
import type { ThemeColors, ThemeMode } from "./theme-palettes";
export type ThemeCardPreviewColors = ThemeColors & {
  messageSurface: string;
  messageAction: string;
};
export function previewColors(colors: ThemeColors): ThemeCardPreviewColors {
  return { ...colors, messageSurface: colors.surfaceRaised, messageAction: colors.accent };
}

export type ThemePreviewRenderSpec = Readonly<{
  baseTarget: string;
  baseWeight: number;
  accent: Readonly<{
    center: readonly [x: number, y: number];
    middleOffset: number;
    middleOpacity: number;
    endOffset: number;
  }>;
  action: Readonly<{
    center: readonly [x: number, y: number];
    startOpacity: number;
    endOffset: number;
  }>;
  scale: number;
  blurAt56Px: number;
}>;

/** Shared geometry and falloff for the web and native theme preview orbs. */
export const THEME_PREVIEW_RENDER_SPECS: Readonly<Record<ThemeMode, ThemePreviewRenderSpec>> = {
  light: {
    baseTarget: "#ffffff",
    baseWeight: 0.8,
    accent: {
      center: [0.72, 0.22],
      middleOffset: 0.28,
      middleOpacity: 0.72,
      endOffset: 0.58,
    },
    action: {
      center: [0.18, 0.82],
      startOpacity: 0.45,
      endOffset: 0.55,
    },
    scale: 1.1,
    blurAt56Px: 3,
  },
  dark: {
    baseTarget: "#09090b",
    baseWeight: 0.8,
    accent: {
      center: [0.28, 0.78],
      middleOffset: 0.28,
      middleOpacity: 0.62,
      endOffset: 0.58,
    },
    action: {
      center: [0.82, 0.18],
      startOpacity: 0.45,
      endOffset: 0.55,
    },
    scale: 1.1,
    blurAt56Px: 3,
  },
};

// Interpolating in oklab keeps the glow falloff perceptually even (no gray
// mid-tones or banding rings), and premultiplied alpha keeps the fade to
// transparent clean.
function getThemePreviewStyle(colors: ThemeCardPreviewColors, mode: ThemeMode): CSSProperties {
  const spec = THEME_PREVIEW_RENDER_SPECS[mode];
  // The canvas carries the ball's light/dark identity, so it stays dominant:
  // a near-true base with a contained accent glow, instead of an accent wash
  // that makes both modes read alike.
  const modeBase = `color-mix(in oklab, ${colors.canvas} ${spec.baseWeight * 100}%, ${spec.baseTarget})`;
  const accentPosition = `${spec.accent.center[0] * 100}% ${spec.accent.center[1] * 100}%`;
  const actionPosition = `${spec.action.center[0] * 100}% ${spec.action.center[1] * 100}%`;
  return {
    backgroundColor: modeBase,
    backgroundImage: [
      `radial-gradient(circle at ${accentPosition} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} ${spec.accent.middleOpacity * 100}%, transparent) ${spec.accent.middleOffset * 100}%, transparent ${spec.accent.endOffset * 100}%)`,
      // The action color is a soft tint from the opposite corner, not a second
      // light source — two bright hotspots read as headlights.
      `radial-gradient(circle at ${actionPosition} in oklab, color-mix(in oklab, ${colors.messageAction} ${spec.action.startOpacity * 100}%, transparent) 0%, transparent ${spec.action.endOffset * 100}%)`,
    ].join(", "),
  };
}

// The gradient halves of each ball can match the card surface, so every ball
// carries a faint mode-appropriate inner ring to keep its silhouette legible.
function themePreviewEdgeShadow(mode: ThemeMode): string {
  return mode === "dark"
    ? "inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.18)"
    : "inset 0 0 0 1px rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.08)";
}

export function ThemePreviewCircle({
  colors,
  mode,
  className,
}: {
  colors: ThemeCardPreviewColors;
  mode: ThemeMode;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block size-14 shrink-0 overflow-hidden rounded-full border-2 border-background",
        className,
      )}
      style={{ boxShadow: themePreviewEdgeShadow(mode) }}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{
          ...getThemePreviewStyle(colors, mode),
          filter: `blur(${THEME_PREVIEW_RENDER_SPECS[mode].blurAt56Px}px)`,
          transform: `scale(${THEME_PREVIEW_RENDER_SPECS[mode].scale})`,
        }}
      />
    </span>
  );
}

// T3 Code miniature adapted to Versionstead: sidebar, package rows, scan progress, and evidence.
function ThemeWireframePane({
  colors,
  clip,
}: {
  colors: ThemeCardPreviewColors;
  clip?: "left" | "right" | undefined;
}) {
  const line = "rgb(127 127 127 / 0.25)";
  return (
    <span
      className="absolute inset-0"
      style={
        clip === undefined
          ? undefined
          : {
              clipPath:
                clip === "left"
                  ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
                  : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)",
            }
      }
    >
      <span className="absolute inset-0" style={{ backgroundColor: colors.canvas }} />
      <span
        className="absolute inset-y-0 left-0 w-[22%]"
        style={{ backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${line}` }}
      />

      {/* Sidebar: search, then thread rows */}
      <span
        className="absolute left-[3%] top-[8%] h-[8%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
      />
      <span
        className="absolute left-[3%] top-[22%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.accentSurface }}
      />
      <span
        className="absolute left-[3%] top-[32%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.messageSurface, opacity: 0.7 }}
      />
      <span
        className="absolute left-[3%] top-[42%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.messageSurface, opacity: 0.5 }}
      />

      {/* Package rows */}
      <span
        className="absolute right-[28%] top-[11%] h-[9%] w-[24%] rounded-lg"
        style={{ backgroundColor: colors.messageSurface }}
      />
      <span
        className="absolute left-[27%] top-[28%] h-[5%] w-[34%] rounded-sm"
        style={{ backgroundColor: line }}
      />
      <span
        className="absolute left-[27%] top-[38%] h-[5%] w-[26%] rounded-sm"
        style={{ backgroundColor: line }}
      />

      {/* Scan progress */}
      <span
        className="absolute bottom-[8%] left-[26%] right-[6%] flex h-[15%] items-center justify-between rounded-md px-1"
        style={{
          backgroundColor: colors.surface,
          boxShadow: `inset 0 0 0 1px ${line}`,
        }}
      >
        <span
          className="block h-[26%] w-[34%] rounded-full"
          style={{ backgroundColor: line, opacity: 0.7 }}
        />
        <span
          className="block aspect-square h-[58%] rounded-full"
          style={{ backgroundColor: colors.messageAction }}
        />
      </span>

      {/* Evidence panel */}
      <span
        className="absolute right-[5%] top-[8%] h-[46%] w-[20%] rounded-lg"
        style={{
          backgroundColor: colors.surface,
          boxShadow: `inset 0 0 0 1px ${line}, 0 2px 5px rgb(0 0 0 / 0.14)`,
        }}
      >
        {[0, 1, 2].map((row) => (
          <span
            className="absolute left-[11%] right-[11%] flex items-center gap-1"
            key={row}
            style={{ top: `${10 + row * 30}%`, height: "20%" }}
          >
            <span
              className="block aspect-square h-[26%] rounded-full"
              style={{
                backgroundColor:
                  row === 0 ? "#34d399" : row === 1 ? colors.messageAction : "#fbbf24",
                opacity: 0.55,
              }}
            />
            <span className="block h-[30%] w-[52%] rounded-sm" style={{ backgroundColor: line }} />
          </span>
        ))}
      </span>
    </span>
  );
}

export function ThemeWireframe({
  className,
  panes,
}: {
  /** Sizing (height) for the frame; the pane geometry is percentage based. */
  className?: string;
  panes: ReadonlyArray<{ colors: ThemeCardPreviewColors; clip?: "left" | "right" }>;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block w-full overflow-hidden rounded-lg border border-border/60",
        className,
      )}
    >
      {panes.map((pane) => (
        <ThemeWireframePane clip={pane.clip} colors={pane.colors} key={pane.clip ?? "pane"} />
      ))}
    </span>
  );
}
export function PanelAnimationsPreview({ durationMs }: { durationMs: number }) {
  const [panelsOpen, setPanelsOpen] = useState(true);
  const transitionClass =
    "transition-[width,height,border-width] duration-(--preview-duration) ease-out motion-reduce:transition-none";

  return (
    <button
      type="button"
      aria-label="Replay panel animation preview"
      className="flex h-10 w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-background p-1 shadow-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      onClick={() => setPanelsOpen((open) => !open)}
      style={{ "--preview-duration": `${durationMs}ms` } as CSSProperties}
    >
      <span
        aria-hidden
        className={cn(
          "h-full shrink-0 overflow-hidden rounded-md bg-sidebar",
          transitionClass,
          panelsOpen ? "w-4" : "w-0",
        )}
      />
      <span aria-hidden className="flex min-w-0 flex-1 flex-col px-1">
        <span className="flex min-h-0 flex-1 flex-col gap-1 pt-1">
          <span className="h-0.5 w-full rounded-full bg-muted-foreground/25" />
          <span className="h-0.5 w-4/5 rounded-full bg-muted-foreground/20" />
          <span className="h-0.5 w-3/5 rounded-full bg-muted-foreground/15" />
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center overflow-hidden bg-foreground/5 px-2",
            transitionClass,
            panelsOpen ? "h-2 border-t border-border/70" : "h-0 border-t-0",
          )}
        >
          <span className="h-px w-2/3 rounded-full bg-muted-foreground/25" />
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          "h-full shrink-0 overflow-hidden rounded-md bg-muted",
          transitionClass,
          panelsOpen ? "w-5" : "w-0",
        )}
      />
    </button>
  );
}
