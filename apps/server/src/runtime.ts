import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Schema from "effect/Schema";
import { InputError } from "./adapters/projects.ts";
import {
  deleteFromKeychain,
  isKeychainReference,
  keychainIssue,
  readFromKeychain,
  storeInKeychain,
  unsupportedCredentialStorage,
  type CredentialOptions,
} from "./adapters/keychain.ts";

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

// The database lock is released by the OS on a crash; stale PID files cannot split the writer.
export function acquireCoordinatorLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(dataDir, "coordinator-lock.sqlite"), { timeout: 100 });
  try {
    lock.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw new Error("A coordinator already owns this data directory");
  }
  return () => {
    lock.exec("ROLLBACK");
    lock.close();
  };
}

async function dpapi(value: string, operation: "Protect" | "Unprotect"): Promise<string> {
  const script = `Add-Type -AssemblyName System.Security
$ErrorActionPreference = 'Stop'
$value = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($value)
$entropy = [Text.Encoding]::UTF8.GetBytes('Versionstead coordinator v1')
$result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
[Console]::Out.Write([Convert]::ToBase64String($result))`;
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error || !/^[A-Za-z0-9+/=]+$/.test(stdout.trim())) {
          reject(new Error("Windows could not protect the local coordinator capability"));
        } else resolveResult(stdout.trim());
      },
    );
    child.stdin?.end(value);
  });
}

/** A credential store that is missing, locked or unsupported; the message says what to do about it. */
export class CredentialStorageUnavailable extends InputError {}

const keychainPlatform = (options: CredentialOptions) => {
  const platform = options.platform ?? process.platform;
  return platform === "darwin" || platform === "linux";
};

/**
 * Asked after a keychain call failed or found nothing. secret-tool answers a locked keyring's lookup
 * and clear exactly as it answers a missing item, so only a fresh probe tells the two apart.
 */
async function unavailable(options: CredentialOptions) {
  const issue = await keychainIssue(options).catch(() => null);
  return issue === null ? null : new CredentialStorageUnavailable(issue);
}

/** A failed keychain call reports a missing or locked store as that, before its own error. */
async function keychainCall<T>(call: Promise<T>, options: CredentialOptions): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw (await unavailable(options)) ?? error;
  }
}

/**
 * Windows protects a secret with machine-scope DPAPI and returns the blob. macOS and Linux keep it in
 * the OS keychain under a random handle namespaced by the monitoring database and return a
 * `keychain:v1:` reference. Either result is what SQLite stores.
 */
export async function protectSecret(
  value: string,
  options: CredentialOptions & { namespace?: string } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return dpapi(Buffer.from(value, "utf8").toString("base64"), "Protect");
  if (!keychainPlatform(options))
    throw new CredentialStorageUnavailable(unsupportedCredentialStorage);
  return keychainCall(
    storeInKeychain(value, options.namespace ?? "versionstead", options),
    options,
  );
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
    return keychainCall(readFromKeychain(reference, options), options);
  }
  if ((options.platform ?? process.platform) !== "win32")
    throw new InputError(
      "This credential was protected by Windows on another host. Reconnect it here.",
    );
  return Buffer.from(await dpapi(reference, "Unprotect"), "base64").toString("utf8");
}

/**
 * Deletes a keychain item; a DPAPI blob lives only in SQLite and leaves with its record, and another
 * host's keychain is out of reach. A delete that a locked keyring could not run is an error, never a
 * silent success.
 */
export async function discardSecret(reference: string, options: CredentialOptions = {}) {
  if (!isKeychainReference(reference) || !keychainPlatform(options)) return;
  if (await keychainCall(deleteFromKeychain(reference, options), options)) return;
  // Nothing was deleted: the item was gone already, or a locked Linux keyring says the same.
  const issue = await unavailable(options);
  if (issue) throw issue;
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
