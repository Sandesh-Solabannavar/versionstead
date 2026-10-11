import * as Schema from "effect/Schema";

export const projectIconNames = [
  "folder",
  "code",
  "terminal",
  "package",
  "box",
  "database",
  "globe",
  "server",
  "app-window",
  "rocket",
  "cpu",
  "layers",
  "book",
  "bot",
  "git-branch",
  "heart",
  "shield",
  "zap",
  "flask-conical",
  "wrench",
  "coffee",
  "cloud",
  "smartphone",
  "gamepad-2",
] as const;
export const projectIconColors = [
  "slate",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
] as const;
const text = (length: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(length));
const Color = Schema.Literals(projectIconColors);
export const ProjectIcon = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("lucide"),
    name: Schema.Literals(projectIconNames),
    color: Color,
  }),
  Schema.Struct({ kind: Schema.Literal("monogram"), text: text(8), color: Color }),
  Schema.Struct({ kind: Schema.Literal("emoji"), emoji: text(32) }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    data: text(20000).check(Schema.isPattern(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)),
  }),
]);
export type ProjectIcon = typeof ProjectIcon.Type;
export const ProjectAction = Schema.Struct({
  id: text(100).check(Schema.isPattern(/^[a-zA-Z0-9-]+$/)),
  name: text(80),
  command: text(4096),
  icon: Schema.Literals(["play", "terminal", "test", "build", "server", "package"]),
  shortcut: Schema.NullOr(text(80)),
});
export type ProjectAction = typeof ProjectAction.Type;
export const ProjectActions = Schema.Array(ProjectAction).check(Schema.isMaxLength(20));
export const ProjectChanges = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["maintained", "watch"])),
  name: Schema.optional(text(160)),
  icon: Schema.optional(Schema.NullOr(ProjectIcon)),
  actions: Schema.optional(ProjectActions),
});
export type ProjectChanges = typeof ProjectChanges.Type;
export const decodeProjectChanges = Schema.decodeUnknownSync(ProjectChanges);
export const ActionRequest = Schema.Struct({ projectId: text(100), actionId: text(100) });
export const decodeActionRequest = Schema.decodeUnknownSync(ActionRequest);
export const RunActionRequest = Schema.Struct({
  projectId: text(100),
  actionId: text(100),
  expectedCommand: text(4096),
});
export const decodeRunActionRequest = Schema.decodeUnknownSync(RunActionRequest);
export const ActionRun = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  actionId: Schema.String,
  command: text(4096),
  status: Schema.Literals(["running", "completed", "failed", "stopped"]),
  output: Schema.String.check(Schema.isMaxLength(65536)),
  exitCode: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
});
export type ActionRun = typeof ActionRun.Type;
export const decodeActionRun = Schema.decodeUnknownSync(ActionRun);
/** What runs owner commands, shown in the command dialog: "Windows PowerShell" or a shell path. */
export const ActionShell = text(4096);
export const decodeActionShell = Schema.decodeUnknownSync(ActionShell);

export function validActionShortcut(value: string) {
  return /^(?:(?:mod|ctrl|meta|alt|shift)\+)+(?:[a-z0-9,/.-]|f(?:[1-9]|1[0-2]))$/.test(value);
}

/** Shared validation also applies to direct service callers. No action runs here. */
export function validateProjectChanges(input: unknown): ProjectChanges {
  const value = decodeProjectChanges(input);
  if (!Object.keys(value).length) throw new Error("Choose a project setting to change.");
  const clean = (s: string) =>
    s.trim().length > 0 && ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  if (value.name !== undefined && !clean(value.name))
    throw new Error("Enter a non-empty project name without control characters.");
  if (
    value.icon?.kind === "monogram" &&
    (!clean(value.icon.text) || [...value.icon.text].length > 3)
  )
    throw new Error("A monogram needs one to three characters.");
  if (
    value.icon?.kind === "emoji" &&
    (!clean(value.icon.emoji) || !/\p{Extended_Pictographic}/u.test(value.icon.emoji))
  )
    throw new Error("Choose a valid emoji.");
  const ids = new Set<string>();
  if (value.icon?.kind === "image") {
    const bytes = atob(value.icon.data.slice("data:image/png;base64,".length));
    const dimension = (offset: number) =>
      [...bytes.slice(offset, offset + 4)].reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
    if (
      bytes.slice(0, 8) !== "\x89PNG\r\n\x1a\n" ||
      bytes.slice(12, 16) !== "IHDR" ||
      bytes.length < 24 ||
      dimension(16) < 1 ||
      dimension(20) < 1 ||
      dimension(16) > 128 ||
      dimension(20) > 128
    )
      throw new Error("Choose a small, valid PNG icon.");
  }
  const names = new Set<string>();
  const shortcuts = new Set<string>();
  for (const action of value.actions ?? []) {
    const name = action.name.trim().toLocaleLowerCase("en-US");
    if (
      !clean(action.name) ||
      !action.command.trim() ||
      action.command.includes("\0") ||
      ids.has(action.id) ||
      names.has(name)
    )
      throw new Error("Actions need unique names/IDs and a non-empty command.");
    if (
      action.shortcut &&
      (!validActionShortcut(action.shortcut) || shortcuts.has(action.shortcut))
    )
      throw new Error("Choose a valid, unique action shortcut.");
    ids.add(action.id);
    names.add(name);
    if (action.shortcut) shortcuts.add(action.shortcut);
  }
  return value;
}
