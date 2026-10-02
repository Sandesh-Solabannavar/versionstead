import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Schema from "effect/Schema";

const RuntimeFile = Schema.Struct({
  origin: Schema.String,
  pid: Schema.Number,
  mode: Schema.Literals(["interactive", "background"]),
  host: Schema.Literals(["session", "boot-task", "unconfigured"]),
  protection: Schema.Literals(["dpapi-machine", "private-file"]),
  protectedToken: Schema.String,
});
type RuntimeFile = typeof RuntimeFile.Type;
export type CoordinatorRuntime = Omit<RuntimeFile, "protection" | "protectedToken"> & {
  token: string;
};
const decodeRuntime = Schema.decodeUnknownSync(RuntimeFile);
let cachedRuntime: { dataDir: string; contents: string; runtime: CoordinatorRuntime } | undefined;

export function resolveDataDir(): string {
  const override = process.env.VERSIONSTEAD_DATA_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("VERSIONSTEAD_DATA_DIR must be absolute");
    return resolve(override);
  }
  return join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "Versionstead");
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
