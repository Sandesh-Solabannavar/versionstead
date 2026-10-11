import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Schema from "effect/Schema";
import { InputError } from "./adapters/projects.ts";
import {
  CredentialStorageUnavailable,
  deleteFromKeychain,
  isKeychainReference,
  keychainIssue,
  readFromKeychain,
  storeInKeychain,
  type CredentialOptions,
} from "./adapters/keychain.ts";

export { CredentialStorageUnavailable };

// The only frontend origin a development coordinator accepts besides its own.
export const DEV_ORIGIN = "http://127.0.0.1:4317";
const RuntimeFile = Schema.Struct({
  origin: Schema.String,
  pid: Schema.Number,
  mode: Schema.Literals(["interactive", "background"]),
  host: Schema.Literals(["session", "boot-task", "unconfigured"]),
  // Absent in descriptors written by older coordinators.
  devOrigin: Schema.optional(Schema.String),
  protection: Schema.Literals(["dpapi-machine", "private-file"]),
  protectedToken: Schema.String,
});
type RuntimeFile = typeof RuntimeFile.Type;
export type CoordinatorRuntime = Omit<RuntimeFile, "protection" | "protectedToken"> & {
  token: string;
};
const decodeRuntime = Schema.decodeUnknownSync(RuntimeFile);
let cachedRuntime: { dataDir: string; contents: string; runtime: CoordinatorRuntime } | undefined;

export const DATABASE_FILE = "monitoring.sqlite";

export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const override = env.VERSIONSTEAD_DATA_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("VERSIONSTEAD_DATA_DIR must be absolute");
    return resolve(override);
  }
  const share = join(home, ".local", "share");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? share, "Versionstead");
  const xdg = env.XDG_DATA_HOME;
  const current =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Versionstead")
      : join(xdg && isAbsolute(xdg) ? xdg : share, "Versionstead");
  // Earlier builds kept their macOS and Linux data in ~/.local/share/Versionstead (Windows used
  // %LOCALAPPDATA%\Versionstead and still does). Only a database counts as data: Electron creates its own
  // profile in the macOS folder on every launch, which must not strand it.
  const legacy = join(share, "Versionstead");
  const holdsDatabase = (directory: string) => existsSync(join(directory, DATABASE_FILE));
  return !holdsDatabase(current) && holdsDatabase(legacy) ? legacy : current;
}

// SQLITE_BUSY: another connection holds the lock.
const SQLITE_BUSY = 5;

// The database lock is released by the OS on a crash; stale PID files cannot split the writer.
export function acquireCoordinatorLock(dataDir: string): () => void {
  createDataDirectory(dataDir);
  const lock = new DatabaseSync(join(dataDir, "coordinator-lock.sqlite"), { timeout: 100 });
  try {
    lock.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    // Only a held lock means another coordinator. A lock file that is not a database, or cannot be used
    // for another reason, must not read as one: a boot-task host would then exit 0 and stay stopped.
    // The low byte drops an extended result code. The cause is SQLite's own error, which names no path.
    const code = (error as { errcode?: unknown }).errcode;
    if (typeof code === "number" && (code & 0xff) === SQLITE_BUSY)
      throw new Error("A coordinator already owns this data directory", { cause: error });
    throw new Error(
      "The coordinator lock file could not be locked. Check the data directory's permissions, or remove coordinator-lock.sqlite while Versionstead is stopped.",
      { cause: error },
    );
  }
  return () => {
    lock.exec("ROLLBACK");
    lock.close();
  };
}

export const windowsPolicyBlocked =
  "Windows policy blocks the PowerShell features Versionstead needs (Constrained Language Mode).";
// Checked first: Add-Type and the .NET calls below fail under Constrained Language Mode.
const languageGuard =
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Write-Output 'versionstead-constrained-language'; exit 3 }";

export type PowerShellRunner = (
  script: string,
  input: string,
) => Promise<{ code: number | null; stdout: string }>;

/** Windows PowerShell 5.1 with an encoded script, stdin input, a deadline and an output bound. */
export const runPowerShell: PowerShellRunner = (script, input) =>
  new Promise((resolveResult) => {
    const child = execFile(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolveResult({ code: error ? (typeof code === "number" ? code : null) : 0, stdout });
      },
    );
    // A script that exits before reading its input (the language guard) must not crash this process.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

export const dpapiScript = (operation: "Protect" | "Unprotect") => `${languageGuard}
Add-Type -AssemblyName System.Security
$ErrorActionPreference = 'Stop'
$value = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($value)
$entropy = [Text.Encoding]::UTF8.GetBytes('Versionstead coordinator v1')
$result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
[Console]::Out.Write([Convert]::ToBase64String($result))`;

/**
 * Runs one DPAPI operation through PowerShell. Exported with its runner so a test can feed it results;
 * callers use protectSecret and unprotectSecret.
 */
export async function dpapi(
  value: string,
  operation: "Protect" | "Unprotect",
  run: PowerShellRunner = runPowerShell,
): Promise<string> {
  const { code, stdout } = await run(dpapiScript(operation), value);
  // The marker is read before the exit code: the language guard exits 3, which would otherwise read as
  // a generic failure.
  if (stdout.includes("versionstead-constrained-language"))
    throw new InputError(windowsPolicyBlocked);
  // No exit code at all: the run timed out or PowerShell could not start. That says nothing about the
  // credential, and a later try can succeed, so it is a storage failure and never an unreadable credential.
  if (code === null)
    throw new CredentialStorageUnavailable(
      operation === "Protect"
        ? "Windows did not finish protecting the credential. Try again."
        : "Windows did not finish reading the protected credential. Try again.",
    );
  if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(stdout.trim()))
    throw new Error("Windows could not protect the local coordinator capability");
  return stdout.trim();
}

/**
 * Null when Windows PowerShell runs in full language mode; otherwise the policy message.
 *
 * ponytail: null also covers a PowerShell that was blocked, missing or too slow (no marker came back),
 * which then surfaces as the generic start-up failure; name those cases if owners report them.
 */
export async function windowsPolicyIssue(
  run: PowerShellRunner = runPowerShell,
): Promise<string | null> {
  const { stdout } = await run(`${languageGuard}\nWrite-Output 'versionstead-full-language'`, "");
  return stdout.includes("versionstead-constrained-language") ? windowsPolicyBlocked : null;
}

/** Shown when a new data directory cannot be restricted: the cause and the way out, with no path. */
export const dataDirectoryNotRestricted =
  "Windows could not restrict the new data folder to your account. Create the folder yourself on an NTFS drive, or choose a folder inside your user profile.";

/**
 * Creates the data directory owner-only. On Windows a directory created outside the profile would
 * inherit its parent's access list, so it gets the owner, SYSTEM and Administrators only. An existing
 * directory is left alone (the Windows boot-task installer sets its own list). If the list cannot be
 * applied, the new empty directory is removed again and dataDirectoryNotRestricted is thrown.
 *
 * ponytail: the new directory has its parent's access list until icacls finishes, parents that
 * `recursive` created stay after a rollback, and a rollback that fails leaves the directory, which the
 * next start then uses as it is; create it under a temporary name, restrict it and rename it into place
 * if two hosts ever race on a new directory or those leftovers matter.
 * ponytail: "inside the profile" compares path text, so a junction in the profile that leads elsewhere
 * counts as inside and keeps the inherited list; compare real paths if owners start using such junctions.
 */
export function createDataDirectory(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  profile = homedir(),
) {
  const created = !existsSync(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!created || platform !== "win32") return;
  const relative = win32.relative(profile.toLowerCase(), dataDir.toLowerCase());
  if (!relative.startsWith("..") && !win32.isAbsolute(relative)) return;
  try {
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const user = execFileSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    const sid = /"(S-1-[0-9-]+)"\s*$/.exec(user.trim())?.[1];
    if (!sid) throw new Error("No owner SID");
    execFileSync(
      join(system32, "icacls.exe"),
      [
        dataDir,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
      ],
      { timeout: 10_000, windowsHide: true, stdio: "ignore" },
    );
  } catch {
    try {
      rmdirSync(dataDir);
    } catch {
      // The owner's message below matters more than a leftover directory (see the note above).
    }
    throw new Error(dataDirectoryNotRestricted);
  }
}

const keychainPlatform = (options: CredentialOptions) => {
  const platform = options.platform ?? process.platform;
  return platform === "darwin" || platform === "linux";
};

/**
 * Windows protects a secret with machine-scope DPAPI and returns the blob. macOS and Linux keep it in
 * the OS keychain under a random handle namespaced by the monitoring database and return a
 * `keychain:v1:` reference; the keychain adapter refuses any other platform. Either result is what
 * SQLite stores.
 */
export async function protectSecret(
  value: string,
  options: CredentialOptions & { namespace?: string } = {},
): Promise<string> {
  if ((options.platform ?? process.platform) === "win32")
    return dpapi(Buffer.from(value, "utf8").toString("base64"), "Protect");
  return storeInKeychain(value, options.namespace ?? "versionstead", options);
}

export async function unprotectSecret(
  reference: string,
  options: CredentialOptions = {},
): Promise<string> {
  if (isKeychainReference(reference)) {
    if (!keychainPlatform(options))
      throw new InputError(
        "This credential is in a macOS or Linux keychain. Reconnect it on this host.",
      );
    return readFromKeychain(reference, options);
  }
  if ((options.platform ?? process.platform) !== "win32")
    throw new InputError(
      "This credential was protected by Windows on another host. Reconnect it here.",
    );
  return Buffer.from(await dpapi(reference, "Unprotect"), "base64").toString("utf8");
}

/**
 * Deletes a keychain item; a DPAPI blob lives only in SQLite and leaves with its record, and another
 * host's keychain is out of reach. A locked or missing store throws rather than passing for deleted.
 */
export async function discardSecret(reference: string, options: CredentialOptions = {}) {
  if (isKeychainReference(reference) && keychainPlatform(options))
    await deleteFromKeychain(reference, options);
}

/** Null when this host can keep protected credentials; otherwise what is missing and how to get it. */
export async function credentialStorageIssue(options: CredentialOptions = {}) {
  return (options.platform ?? process.platform) === "win32" ? null : keychainIssue(options);
}

function validateDescriptor(runtime: RuntimeFile): void {
  const url = new URL(runtime.origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (runtime.devOrigin !== undefined && runtime.devOrigin !== DEV_ORIGIN) ||
    !Number.isSafeInteger(runtime.pid) ||
    runtime.pid < 1 ||
    runtime.protectedToken.length > 8192
  ) {
    throw new Error("Invalid coordinator descriptor");
  }
}

export async function readRuntime(dataDir: string): Promise<CoordinatorRuntime | null> {
  try {
    const file = join(dataDir, "runtime.json");
    if ((await stat(file)).size > 64 * 1024) return null;
    const contents = await readFile(file, "utf8");
    if (cachedRuntime?.dataDir === dataDir && cachedRuntime.contents === contents) {
      return { ...cachedRuntime.runtime };
    }
    const runtime = decodeRuntime(JSON.parse(contents));
    validateDescriptor(runtime);
    if (runtime.protection === "dpapi-machine" && process.platform !== "win32") return null;
    const protectedValue =
      runtime.protection === "dpapi-machine"
        ? await dpapi(runtime.protectedToken, "Unprotect")
        : runtime.protectedToken;
    const token = Buffer.from(protectedValue, "base64").toString("utf8");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result: CoordinatorRuntime = {
      origin: runtime.origin,
      pid: runtime.pid,
      mode: runtime.mode,
      host: runtime.host,
      ...(runtime.devOrigin ? { devOrigin: runtime.devOrigin } : {}),
      token,
    };
    cachedRuntime = { dataDir, contents, runtime: result };
    return { ...result };
  } catch {
    return null;
  }
}

export async function writeRuntime(dataDir: string, runtime: CoordinatorRuntime): Promise<void> {
  const encoded = Buffer.from(runtime.token, "utf8").toString("base64");
  const descriptor = decodeRuntime({
    origin: runtime.origin,
    pid: runtime.pid,
    mode: runtime.mode,
    host: runtime.host,
    ...(runtime.devOrigin ? { devOrigin: runtime.devOrigin } : {}),
    protection: process.platform === "win32" ? "dpapi-machine" : "private-file",
    protectedToken: process.platform === "win32" ? await dpapi(encoded, "Protect") : encoded,
  });
  validateDescriptor(descriptor);
  const temporary = join(dataDir, `runtime.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 });
  await rename(temporary, join(dataDir, "runtime.json"));
  if (process.platform !== "win32") await chmod(join(dataDir, "runtime.json"), 0o600);
}

export async function removeRuntime(dataDir: string): Promise<void> {
  try {
    const file = join(dataDir, "runtime.json");
    const runtime = decodeRuntime(JSON.parse(await readFile(file, "utf8")));
    if (runtime.pid === process.pid) await unlink(file);
  } catch {
    // A failed startup may never have published a descriptor.
  }
}
