import * as Schema from "effect/Schema";

export const WindowTheme = Schema.Literals(["system", "light", "dark"]);
export type WindowTheme = typeof WindowTheme.Type;
export const decodeWindowTheme = Schema.decodeUnknownSync(WindowTheme);
export const WindowBounds = Schema.Struct({
  x: Schema.Int.check(Schema.isBetween({ minimum: -100000, maximum: 100000 })),
  y: Schema.Int.check(Schema.isBetween({ minimum: -100000, maximum: 100000 })),
  width: Schema.Int.check(Schema.isBetween({ minimum: 680, maximum: 20000 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 520, maximum: 20000 })),
});
export type WindowBounds = typeof WindowBounds.Type;
export const WindowPreferences = Schema.Struct({
  theme: WindowTheme,
  bounds: Schema.NullOr(WindowBounds),
  maximized: Schema.Boolean,
});
export type WindowPreferences = typeof WindowPreferences.Type;
export const decodeWindowPreferences = Schema.decodeUnknownSync(WindowPreferences);
/** What the OS has registered to open this app at login, read back after every change. */
export const LoginItemState = Schema.Struct({ openAtLogin: Schema.Boolean });
export type LoginItemState = typeof LoginItemState.Type;
export const decodeLoginItemState = Schema.decodeUnknownSync(LoginItemState);
export const decodeLoginItemChange = Schema.decodeUnknownSync(Schema.Boolean);
