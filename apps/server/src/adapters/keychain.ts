import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { InputError } from "./projects.ts";
import { toolExecutable } from "./tool-paths.ts";

export const KEYCHAIN_SERVICE = "dev.versionstead";
export const unsupportedCredentialStorage =
  "Protected credential storage is not supported on this platform.";
const SECURITY = "/usr/bin/security";
// `security -i` reads each command line into a 4096-byte buffer (MAX_LINE_LEN in Apple's
// SecurityTool/macOS/security.c); a longer line would be cut and its rest run as another command.
const MAX_SECURITY_LINE = 4000;
// A locked keyring can wait on an unlock prompt; the probe gives up sooner than a real read or write.
const PROBE_TIMEOUT = 5_000;
// A handle reaches the tools as an argument, so its namespace never starts with "-".
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REFERENCE = /^keychain:v1:([A-Za-z0-9][A-Za-z0-9-]{0,63}\.[A-Za-z0-9_-]{22})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const macMissing =
  "The macOS keychain tool (/usr/bin/security) is unavailable on this monitoring host.";
const macLocked =
  "Unlock your macOS login keychain by signing in at this Mac, then refresh. A session without a desktop login, such as SSH, cannot use it.";
const linuxMissing =
  "Install libsecret-tools (secret-tool) and unlock your login keyring to store connection credentials.";
const linuxLocked =
  "Unlock your login keyring (GNOME Keyring or KWallet's Secret Service) in a desktop session, then refresh. A background host cannot use it before you log in.";

export type KeychainResult = { code: number; stdout: string; stderr: string };
/**
 * Runs a keychain tool with an argument array and optional stdin; a non-zero exit is a result. The
 * time limit in milliseconds defaults to ten seconds.
 */
export type KeychainRunner = (
  file: string,
  args: string[],
  input?: string,
  timeout?: number,
) => Promise<KeychainResult>;
/** Test seams: the platform, the runner, the tool path, and a macOS keychain file instead of the default. */
export type CredentialOptions = {
  platform?: NodeJS.Platform;
  run?: KeychainRunner;
  tool?: string | null;
  keychain?: string;
};

export const runKeychain: KeychainRunner = (file, args, input = "", timeout = 10_000) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout, maxBuffer: 64 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (error && typeof code !== "number")
          reject(new InputError("The OS keychain tool did not finish."));
        else resolve({ code: typeof code === "number" ? code : 0, stdout, stderr });
      },
    );
    // A tool that exits before reading stdin reports through its exit code, not an EPIPE crash.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

const platformOf = (options: CredentialOptions) => options.platform ?? process.platform;
const lockedMessage = (options: CredentialOptions) =>
  platformOf(options) === "darwin" ? macLocked : linuxLocked;
const missingMessage = (options: CredentialOptions) =>
  platformOf(options) === "darwin" ? macMissing : linuxMissing;

async function keychainTool(options: CredentialOptions): Promise<string | null> {
  if (options.tool !== undefined) return options.tool;
  if (platformOf(options) !== "darwin") return toolExecutable("secret-tool");
  try {
    await access(SECURITY, constants.X_OK);
    return SECURITY;
  } catch {
    return null;
  }
}

/** The tool and the runner for one keychain command; a missing tool says what to install. */
async function keychainCommand(options: CredentialOptions) {
  const file = await keychainTool(options);
  if (!file) throw new InputError(missingMessage(options));
  return { file, run: options.run ?? runKeychain };
}

function keychainArgument(options: CredentialOptions): string[] {
  if (options.keychain === undefined) return [];
  if (!/^\/[A-Za-z0-9._/-]+$/.test(options.keychain))
    throw new InputError("The keychain path must be a plain absolute path.");
  return [options.keychain];
}

function decode(text: string) {
  const value = text.trim();
  if (!BASE64.test(value)) throw new InputError("The OS keychain returned an unexpected value.");
  return Buffer.from(value, "base64").toString("utf8");
}

// Not found: `security` exits 44 (errSecItemNotFound); secret-tool exits 1 without a message.
const notFound = (options: CredentialOptions, result: KeychainResult) =>
  platformOf(options) === "darwin"
    ? result.code === 44
    : result.code === 1 && result.stderr.trim() === "";

async function readHandle(handle: string, options: CredentialOptions): Promise<string | null> {
  const { file, run } = await keychainCommand(options);
  const result =
    platformOf(options) === "darwin"
      ? await run(file, [
          "find-generic-password",
          "-s",
          KEYCHAIN_SERVICE,
          "-a",
          handle,
          "-w",
          ...keychainArgument(options),
        ])
      : await run(file, ["lookup", "service", KEYCHAIN_SERVICE, "account", handle]);
  if (result.code === 0) return decode(result.stdout);
  if (notFound(options, result)) return null;
  throw new InputError(lockedMessage(options));
}

async function deleteHandle(handle: string, options: CredentialOptions) {
  const { file, run } = await keychainCommand(options);
  const result =
    platformOf(options) === "darwin"
      ? await run(file, [
          "delete-generic-password",
          "-s",
          KEYCHAIN_SERVICE,
          "-a",
          handle,
          ...keychainArgument(options),
        ])
      : await run(file, ["clear", "service", KEYCHAIN_SERVICE, "account", handle]);
  if (result.code !== 0 && !notFound(options, result)) throw new InputError(lockedMessage(options));
  return result.code === 0;
}

async function storeHandle(handle: string, value: string, options: CredentialOptions) {
  const platform = platformOf(options);
  if (platform !== "darwin" && platform !== "linux")
    throw new InputError(unsupportedCredentialStorage);
  const { file, run } = await keychainCommand(options);
  // Base64 keeps quotes, spaces and backslashes away from the `security -i` line parser.
  const encoded = Buffer.from(value, "utf8").toString("base64");
  if (platform === "darwin") {
    const words = [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      handle,
      "-w",
      encoded,
    ];
    const line = `${[...words, ...keychainArgument(options)].join(" ")}\n`;
    if (Buffer.byteLength(line) > MAX_SECURITY_LINE)
      throw new InputError(
        "This credential is too long for the macOS keychain command. Use a token under 2,700 characters.",
      );
    // The secret travels on stdin: an argument would be visible to every process listing.
    await run(file, ["-i"], line);
  } else {
    const result = await run(
      file,
      ["store", "--label=Versionstead credential", "service", KEYCHAIN_SERVICE, "account", handle],
      encoded,
    );
    if (result.code !== 0) throw new InputError(lockedMessage(options));
  }
  // `security -i` carries on after a failed command, so a store counts only once it reads back.
  if ((await readHandle(handle, options)) !== value) throw new InputError(lockedMessage(options));
}

export const isKeychainReference = (value: string) => value.startsWith("keychain:v1:");

function handleOf(reference: string) {
  const handle = REFERENCE.exec(reference)?.[1];
  if (!handle) throw new InputError("Invalid keychain reference.");
  return handle;
}

/** Stores a secret under service dev.versionstead and a random account handle; returns the reference SQLite keeps. */
export async function storeInKeychain(
  value: string,
  namespace: string,
  options: CredentialOptions = {},
) {
  if (!NAMESPACE.test(namespace)) throw new InputError("Invalid credential namespace.");
  // An empty value would leave a bare `-w` that makes `security` prompt for a password.
  if (!value) throw new InputError("An empty credential cannot be stored.");
  const handle = `${namespace}.${randomBytes(16).toString("base64url")}`;
  await storeHandle(handle, value, options);
  return `keychain:v1:${handle}`;
}

export async function readFromKeychain(reference: string, options: CredentialOptions = {}) {
  const value = await readHandle(handleOf(reference), options);
  if (value === null)
    throw new InputError(
      "The saved credential is missing from the OS keychain. Reconnect this source.",
    );
  return value;
}

/**
 * Deletes the item: true when one was deleted, false when there was none to delete. On Linux a
 * locked keyring also answers false, so a caller that must know checks the store again.
 */
export async function deleteFromKeychain(reference: string, options: CredentialOptions = {}) {
  return deleteHandle(handleOf(reference), options);
}

/** Null when a probe item round-trips; otherwise what is missing and how to get it. */
export async function keychainIssue(options: CredentialOptions = {}): Promise<string | null> {
  const platform = platformOf(options);
  if (platform !== "darwin" && platform !== "linux") return unsupportedCredentialStorage;
  if (!(await keychainTool(options))) return missingMessage(options);
  const run = options.run ?? runKeychain;
  const probe: CredentialOptions = {
    ...options,
    run: (file, args, input) => run(file, args, input, PROBE_TIMEOUT),
  };
  const handle = `probe.${randomBytes(16).toString("base64url")}`;
  try {
    await storeHandle(handle, randomBytes(12).toString("base64url"), probe);
  } catch {
    // A store that failed left nothing to delete, and the keyring that just failed (a hung unlock prompt)
    // would only make the delete wait as long again.
    // ponytail: a store that wrote but could not read back leaves its probe item; delete it as well if that is ever seen.
    return lockedMessage(options);
  }
  await deleteHandle(handle, probe).catch(() => {});
  return null;
}
