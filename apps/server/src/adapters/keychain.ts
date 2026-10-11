import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { InputError } from "./projects.ts";
import { firstExecutable } from "./tool-paths.ts";

export const KEYCHAIN_SERVICE = "dev.versionstead";
export const unsupportedCredentialStorage =
  "Protected credential storage is not supported on this platform.";
const SECURITY = "/usr/bin/security";
// Fixed locations, as for systemctl and loginctl in background-host.ts: the tool holds every credential, so
// a PATH entry must not be able to stand in for it.
// ponytail: a distro that installs libsecret-tools elsewhere reads as having no tool; list its location
// here when one is reported.
const SECRET_TOOLS = ["/usr/bin/secret-tool", "/bin/secret-tool"];
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
// A tool that never finished says nothing about the item: it may be waiting on an access or unlock prompt
// nobody answered, or it could not start. A later try can succeed, so it is neither a missing credential
// nor an unreadable one.
const keychainSilent =
  "The OS keychain did not answer in time. If it is showing a prompt, answer it, then try again.";
const linuxNoService =
  "No Secret Service is running for this session. Log in to a desktop session with GNOME Keyring (or another Secret Service) to store connection credentials.";
// What secret-tool prints when nothing answers on the session bus, for example "The name
// org.freedesktop.secrets was not provided by any .service files", "Cannot autolaunch D-Bus without X11
// $DISPLAY" and "Could not connect: No such file or directory". A locked keyring prints none of these.
const noSecretService =
  /org\.freedesktop\.secrets was not provided|Cannot autolaunch D-Bus|Could not connect:/;

/** A credential store that is missing, locked, unsupported or not answering; the message says what to do about it. */
export class CredentialStorageUnavailable extends InputError {}

export type KeychainResult = { code: number; stdout: string; stderr: string };
/**
 * Runs a keychain tool with an argument array and optional stdin; a non-zero exit is a result. The
 * time limit in milliseconds defaults to ten seconds. A tool that times out or cannot start rejects
 * with CredentialStorageUnavailable.
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
          reject(new CredentialStorageUnavailable(keychainSilent));
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
/** A failed command means an unusable store: no Secret Service at all on Linux, otherwise a locked one. */
const unavailable = (options: CredentialOptions, result: KeychainResult) =>
  new CredentialStorageUnavailable(
    platformOf(options) === "linux" && noSecretService.test(result.stderr)
      ? linuxNoService
      : lockedMessage(options),
  );

const keychainTool = async (options: CredentialOptions): Promise<string | null> =>
  options.tool !== undefined
    ? options.tool
    : firstExecutable(platformOf(options) === "darwin" ? [SECURITY] : SECRET_TOOLS);

/** The tool and the runner for one keychain command; a missing tool says what to install. */
async function keychainCommand(options: CredentialOptions) {
  const file = await keychainTool(options);
  if (!file) throw new CredentialStorageUnavailable(missingMessage(options));
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
  throw unavailable(options, result);
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
  if (result.code !== 0 && !notFound(options, result)) throw unavailable(options, result);
  return result.code === 0;
}

async function storeHandle(handle: string, value: string, options: CredentialOptions) {
  const platform = platformOf(options);
  if (platform !== "darwin" && platform !== "linux")
    throw new CredentialStorageUnavailable(unsupportedCredentialStorage);
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
    if (result.code !== 0) throw unavailable(options, result);
  }
  // `security -i` carries on after a failed command, so a store counts only once it reads back.
  if ((await readHandle(handle, options)) !== value)
    throw new CredentialStorageUnavailable(lockedMessage(options));
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

/**
 * After finding nothing: secret-tool answers a locked keyring's lookup and clear exactly as it answers
 * a missing item, so on Linux only a probe tells them apart. On macOS exit 44 means "not found".
 */
async function lockedRatherThanMissing(options: CredentialOptions) {
  if (platformOf(options) !== "linux") return;
  const issue = await keychainIssue(options);
  if (issue) throw new CredentialStorageUnavailable(issue);
}

export async function readFromKeychain(reference: string, options: CredentialOptions = {}) {
  const value = await readHandle(handleOf(reference), options);
  if (value !== null) return value;
  await lockedRatherThanMissing(options);
  throw new InputError(
    "The saved credential is missing from the OS keychain. Reconnect this source.",
  );
}

/** Deletes the item; one already gone counts as deleted, but a locked or missing store throws. */
export async function deleteFromKeychain(reference: string, options: CredentialOptions = {}) {
  if (!(await deleteHandle(handleOf(reference), options))) await lockedRatherThanMissing(options);
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
  } catch (error) {
    // A store that failed left nothing to delete, and the keyring that just failed (a hung unlock prompt)
    // would only make the delete wait as long again.
    // ponytail: a store that wrote but could not read back leaves its probe item; delete it as well if that is ever seen.
    return error instanceof CredentialStorageUnavailable ? error.message : lockedMessage(options);
  }
  await deleteHandle(handle, probe).catch(() => {});
  return null;
}
