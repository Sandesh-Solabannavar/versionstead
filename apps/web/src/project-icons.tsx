import {
  Folder,
  Code,
  Terminal,
  Package,
  Box,
  Database,
  Globe,
  Server,
  AppWindow,
  Rocket,
  Cpu,
  Layers,
  Book,
  Bot,
  GitBranch,
  Heart,
  Shield,
  Zap,
  FlaskConical,
  Wrench,
  Coffee,
  Cloud,
  Smartphone,
  Gamepad2,
  type LucideIcon,
} from "lucide-react";
import { projectIconColors, type ProjectIcon } from "@versionstead/contracts/project-settings";

export const iconComponents: Record<Extract<ProjectIcon, { kind: "lucide" }>["name"], LucideIcon> =
  {
    folder: Folder,
    code: Code,
    terminal: Terminal,
    package: Package,
    box: Box,
    database: Database,
    globe: Globe,
    server: Server,
    "app-window": AppWindow,
    rocket: Rocket,
    cpu: Cpu,
    layers: Layers,
    book: Book,
    bot: Bot,
    "git-branch": GitBranch,
    heart: Heart,
    shield: Shield,
    zap: Zap,
    "flask-conical": FlaskConical,
    wrench: Wrench,
    coffee: Coffee,
    cloud: Cloud,
    smartphone: Smartphone,
    "gamepad-2": Gamepad2,
  };
export function projectIdentity(name: string) {
  const normalized = name.normalize("NFKC").trim();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = Array.from(words[0] ?? "PR");
  const second =
    first.slice(1).find((g) => /\p{N}/u.test(g)) ??
    (words.length > 1 ? Array.from(words.at(-1)!)[0] : first.at(-1)) ??
    first[0]!;
  const monogram = Array.from((first[0]! + second).toUpperCase())
    .slice(0, 2)
    .join("");
  let index = 0;
  for (const glyph of normalized.toLocaleLowerCase("en-US") || "project")
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % projectIconColors.length;
  return { monogram, color: projectIconColors[index]! };
}
export function ProjectBadge({
  project,
}: {
  project: { name: string; icon?: ProjectIcon | null | undefined };
}) {
  const generated = projectIdentity(project.name);
  const icon = project.icon ?? {
    kind: "monogram",
    text: generated.monogram,
    color: generated.color,
  };
  const Glyph = icon.kind === "lucide" ? iconComponents[icon.name] : null;
  return (
    <span
      className={`project-badge ${"color" in icon ? `project-color-${icon.color}` : ""}`}
      aria-hidden="true"
    >
      {icon.kind === "image" ? (
        <img src={icon.data} alt="" />
      ) : icon.kind === "emoji" ? (
        icon.emoji
      ) : icon.kind === "monogram" ? (
        icon.text
      ) : Glyph ? (
        <Glyph size={17} />
      ) : null}
    </span>
  );
}
export async function readProjectIcon(file: File): Promise<ProjectIcon> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024)
    throw new Error("Choose a PNG, JPEG, or WebP image up to 2 MiB.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096)
      throw new Error("Choose an image no larger than 4096 × 4096.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 48;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The image could not be read.");
    const scale = Math.min(48 / bitmap.width, 48 / bitmap.height);
    const width = bitmap.width * scale,
      height = bitmap.height * scale;
    context.drawImage(bitmap, (48 - width) / 2, (48 - height) / 2, width, height);
    const data = canvas.toDataURL("image/png");
    if (data.length > 20000) throw new Error("This image exceeds the stored icon size limit.");
    return { kind: "image", data };
  } finally {
    bitmap.close();
  }
}
