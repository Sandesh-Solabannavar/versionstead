import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const keyringSkip =
  "Needs OS credential storage: on Linux set VERSIONSTEAD_KEYRING_TESTS=1 inside dbus-run-session with an unlocked gnome-keyring (docs/development.md).";

/**
 * Credential options for one test. Windows keeps DPAPI. macOS gets a throwaway keychain that this
 * helper creates and deletes, never the login keychain. Linux uses the session's Secret Service only
 * when VERSIONSTEAD_KEYRING_TESTS=1, so an ordinary run never writes to a developer's keyring.
 */
export async function testCredentials(t) {
  if (process.platform === "win32") return { credentials: {}, available: true };
  if (process.platform === "darwin") {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "vs-keychain-")));
    const keychain = join(directory, "versionstead-test.keychain-db");
    const password = randomBytes(16).toString("hex");
    await exec("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    t.after(async () => {
      await exec("/usr/bin/security", ["delete-keychain", keychain]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    });
    await exec("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    // No settings: the keychain never locks itself during the test.
    await exec("/usr/bin/security", ["set-keychain-settings", keychain]);
    return { credentials: { keychain }, available: true };
  }
  const available = process.platform === "linux" && process.env.VERSIONSTEAD_KEYRING_TESTS === "1";
  // Without the opt-in the tool reads as missing, so even the probe never reaches a real keyring.
  return { credentials: available ? {} : { tool: null }, available };
}

/**
 * An in-memory stand-in for secret-tool. As with the real tool, a locked keyring refuses a store with
 * a message but answers lookup and clear with a silent exit 1, exactly as for a missing item.
 */
export function fakeKeyring({ locked = false } = {}) {
  const items = new Map();
  const calls = [];
  let unlocked = !locked;
  const run = async (file, args, input = "") => {
    calls.push({ file, args, input });
    const account = args[args.indexOf("account") + 1];
    if (args[0] === "store") {
      if (!unlocked)
        return {
          code: 1,
          stdout: "",
          stderr: "secret-tool: Cannot create an item in a locked collection\n",
        };
      items.set(account, input);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "lookup")
      return unlocked && items.has(account)
        ? { code: 0, stdout: items.get(account), stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    if (args[0] === "clear")
      return { code: unlocked && items.delete(account) ? 0 : 1, stdout: "", stderr: "" };
    return { code: 2, stdout: "", stderr: "usage" };
  };
  return {
    items,
    calls,
    lock: () => {
      unlocked = false;
    },
    unlock: () => {
      unlocked = true;
    },
    options: { platform: "linux", tool: "/usr/bin/secret-tool", run },
  };
}

/**
 * An in-memory stand-in for /usr/bin/security that parses the `-i` line like the real tool. Missing
 * items exit 44. A locked keychain refuses every command, though `security -i` itself still exits 0.
 */
export function fakeSecurity() {
  const items = new Map();
  const calls = [];
  let unlocked = true;
  const run = async (file, args, input = "") => {
    calls.push({ file, args, input });
    if (args[0] === "-i") {
      const words = input.trim().split(" ");
      assert.equal(words[0], "add-generic-password");
      if (unlocked) items.set(words[words.indexOf("-a") + 1], words[words.indexOf("-w") + 1]);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (!unlocked) return { code: 36, stdout: "", stderr: "User interaction is not allowed.\n" };
    const account = args[args.indexOf("-a") + 1];
    if (args[0] === "find-generic-password")
      return items.has(account)
        ? { code: 0, stdout: `${items.get(account)}\n`, stderr: "" }
        : { code: 44, stdout: "", stderr: "The specified item could not be found.\n" };
    if (args[0] === "delete-generic-password")
      return { code: items.delete(account) ? 0 : 44, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unknown command" };
  };
  return {
    items,
    calls,
    lock: () => {
      unlocked = false;
    },
    options: { platform: "darwin", tool: "/usr/bin/security", run },
  };
}
