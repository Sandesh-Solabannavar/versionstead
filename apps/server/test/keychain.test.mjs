import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { InputError } from "../dist/adapters/projects.js";
import {
  KEYCHAIN_SERVICE,
  deleteFromKeychain,
  keychainIssue,
  readFromKeychain,
  storeInKeychain,
} from "../dist/adapters/keychain.js";
import { fakeKeyring, testCredentials } from "./credentials.mjs";

const exec = promisify(execFile);

/** An in-memory stand-in for /usr/bin/security that parses the `-i` line like the real tool. */
function fakeSecurity() {
  const items = new Map();
  const calls = [];
  const run = async (file, args, input = "") => {
    calls.push({ file, args, input });
    if (args[0] === "-i") {
      const words = input.trim().split(" ");
      assert.equal(words[0], "add-generic-password");
      items.set(words[words.indexOf("-a") + 1], words[words.indexOf("-w") + 1]);
      return { code: 0, stdout: "", stderr: "" };
    }
    const account = args[args.indexOf("-a") + 1];
    if (args[0] === "find-generic-password")
      return items.has(account)
        ? { code: 0, stdout: `${items.get(account)}\n`, stderr: "" }
        : { code: 44, stdout: "", stderr: "The specified item could not be found.\n" };
    if (args[0] === "delete-generic-password")
      return { code: items.delete(account) ? 0 : 44, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unknown command" };
  };
  return { items, calls, options: { platform: "darwin", tool: "/usr/bin/security", run } };
}

/** Wraps a runner to note each command and the time limit the module gave it. */
function watched(options) {
  const seen = [];
  const run = (file, args, input, timeout) => {
    seen.push({ command: args[0], timeout });
    return options.run(file, args, input);
  };
  return { seen, options: { ...options, run } };
}

test("macOS keeps the secret off the command line, stores it base64 on stdin and verifies it", async () => {
  const security = fakeSecurity();
  const secret = `tök"en' with \\ spaces ${randomBytes(4).toString("hex")}`;
  const reference = await storeInKeychain(secret, "device-1", security.options);
  assert.match(reference, /^keychain:v1:device-1\.[A-Za-z0-9_-]{22}$/);
  const [add] = security.calls;
  assert.equal(add.file, "/usr/bin/security");
  assert.deepEqual(add.args, ["-i"]);
  assert.match(
    add.input,
    /^add-generic-password -U -s dev\.versionstead -a device-1\.[A-Za-z0-9_-]{22} -w [A-Za-z0-9+/=]+\n$/,
  );
  const encoded = Buffer.from(secret).toString("base64");
  for (const call of security.calls)
    for (const value of call.args) assert(!value.includes(secret) && !value.includes(encoded));
  assert.equal(await readFromKeychain(reference, security.options), secret);
  await deleteFromKeychain(reference, security.options);
  await deleteFromKeychain(reference, security.options);
  await assert.rejects(
    readFromKeychain(reference, security.options),
    /missing from the OS keychain/,
  );
});

test("a credential too long for one `security -i` line is refused before anything runs", async () => {
  const security = fakeSecurity();
  await assert.rejects(
    storeInKeychain("x".repeat(3000), "device-1", security.options),
    (error) => error instanceof InputError && /too long for the macOS keychain/.test(error.message),
  );
  assert.equal(security.calls.length, 0);
  const reference = await storeInKeychain("y".repeat(2000), "device-1", security.options);
  assert.equal(await readFromKeychain(reference, security.options), "y".repeat(2000));
  // The message promises 2,700 characters under a real (UUID) namespace; the line stays below the tool's 4096-byte buffer.
  const fits = await storeInKeychain("z".repeat(2700), randomUUID(), security.options);
  assert.equal(await readFromKeychain(fits, security.options), "z".repeat(2700));
  for (const call of security.calls.filter((c) => c.args[0] === "-i"))
    assert(Buffer.byteLength(call.input) < 4096, "A longer line would be cut by the tool");
});

test("a test keychain file is the trailing argument and must be a plain absolute path", async () => {
  const security = fakeSecurity();
  const keychain = "/private/var/folders/ab/c_d/T/vs-keychain-x1/versionstead-test.keychain-db";
  const options = { ...security.options, keychain };
  const reference = await storeInKeychain("secret", "device-1", options);
  assert(security.calls[0].input.endsWith(` ${keychain}\n`));
  assert.equal(security.calls[1].args.at(-1), keychain);
  await deleteFromKeychain(reference, options);
  assert.equal(security.calls.at(-1).args.at(-1), keychain);
  await assert.rejects(
    storeInKeychain("secret", "device-1", { ...options, keychain: "/tmp/with space.keychain-db" }),
    /plain absolute path/,
  );
});

test("Linux passes the secret to secret-tool on stdin and the attributes as arguments", async () => {
  const keyring = fakeKeyring();
  const reference = await storeInKeychain('tök"en', "device-2", keyring.options);
  const handle = reference.slice("keychain:v1:".length);
  assert.deepEqual(keyring.calls[0].args, [
    "store",
    "--label=Versionstead credential",
    "service",
    "dev.versionstead",
    "account",
    handle,
  ]);
  assert.equal(keyring.calls[0].input, Buffer.from('tök"en').toString("base64"));
  assert.deepEqual(keyring.calls[1].args, [
    "lookup",
    "service",
    "dev.versionstead",
    "account",
    handle,
  ]);
  assert.equal(await readFromKeychain(reference, keyring.options), 'tök"en');
  await deleteFromKeychain(reference, keyring.options);
  assert.deepEqual(keyring.calls.at(-1).args, [
    "clear",
    "service",
    "dev.versionstead",
    "account",
    handle,
  ]);
  await deleteFromKeychain(reference, keyring.options);
  await assert.rejects(
    readFromKeychain(reference, keyring.options),
    /missing from the OS keychain/,
  );
  const broken = {
    ...keyring.options,
    run: async () => ({
      code: 1,
      stdout: "",
      stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY\n",
    }),
  };
  await assert.rejects(readFromKeychain(reference, broken), /Unlock your login keyring/);
  await assert.rejects(deleteFromKeychain(reference, broken), /Unlock your login keyring/);
});

test("the probe says what is missing, removes its item, and nothing runs for a foreign reference", async () => {
  const keyring = fakeKeyring({ locked: true });
  assert.match(await keychainIssue({ platform: "linux", tool: null }), /Install libsecret-tools/);
  assert.match(await keychainIssue(keyring.options), /Unlock your login keyring/);
  keyring.unlock();
  assert.equal(await keychainIssue(keyring.options), null);
  assert.equal(keyring.items.size, 0, "The probe item is deleted");
  assert.match(await keychainIssue({ platform: "darwin", tool: null }), /\/usr\/bin\/security/);
  const locked = {
    ...fakeSecurity().options,
    run: async () => ({ code: 36, stdout: "", stderr: "User interaction is not allowed.\n" }),
  };
  assert.match(await keychainIssue(locked), /Unlock your macOS login keychain/);
  assert.match(await keychainIssue({ platform: "freebsd" }), /not supported on this platform/);
  const calls = keyring.calls.length;
  for (const reference of ["keychain:v1:../../x", "keychain:v1:device.short", "secret"])
    await assert.rejects(
      readFromKeychain(reference, keyring.options),
      /Invalid keychain reference/,
    );
  assert.equal(keyring.calls.length, calls);
  await assert.rejects(storeInKeychain("x", "../bad", keyring.options), /namespace/);
});

test("a probe caps each command at five seconds and stops after a store that failed", async () => {
  // `security -i` exits 0 whatever happened, so on a locked Mac the read-back is what notices.
  const mac = watched({
    ...fakeSecurity().options,
    run: async () => ({ code: 36, stdout: "", stderr: "User interaction is not allowed.\n" }),
  });
  assert.match(await keychainIssue(mac.options), /Unlock your macOS login keychain/);
  assert.deepEqual(
    mac.seen.map((call) => call.command),
    ["-i", "find-generic-password"],
    "No delete follows a store that failed",
  );
  const keyring = fakeKeyring({ locked: true });
  const closed = watched(keyring.options);
  assert.match(await keychainIssue(closed.options), /Unlock your login keyring/);
  assert.deepEqual(
    closed.seen.map((call) => call.command),
    ["store"],
  );
  keyring.unlock();
  const open = watched(keyring.options);
  assert.equal(await keychainIssue(open.options), null);
  assert.deepEqual(
    open.seen.map((call) => call.command),
    ["store", "lookup", "clear"],
  );
  for (const call of [...mac.seen, ...closed.seen, ...open.seen])
    assert(call.timeout > 0 && call.timeout <= 5_000, `${call.command} is capped at five seconds`);
});

test("every operation names the missing tool before running anything", async () => {
  const reference = `keychain:v1:device-3.${randomBytes(16).toString("base64url")}`;
  const linux = { platform: "linux", tool: null };
  const mac = { platform: "darwin", tool: null };
  await assert.rejects(readFromKeychain(reference, linux), /Install libsecret-tools/);
  await assert.rejects(deleteFromKeychain(reference, linux), /Install libsecret-tools/);
  await assert.rejects(storeInKeychain("secret", "device-3", linux), /Install libsecret-tools/);
  await assert.rejects(readFromKeychain(reference, mac), /\/usr\/bin\/security/);
  await assert.rejects(deleteFromKeychain(reference, mac), /\/usr\/bin\/security/);
  await assert.rejects(storeInKeychain("secret", "device-3", mac), /\/usr\/bin\/security/);
  await assert.rejects(
    storeInKeychain("secret", "device-3", { platform: "freebsd" }),
    /not supported on this platform/,
  );
});

test(
  "macOS: a throwaway keychain stores, reads and deletes a credential",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { credentials } = await testCredentials(t);
    assert.equal(await keychainIssue(credentials), null);
    const secret = `token-${randomBytes(24).toString("base64url")}`;
    const reference = await storeInKeychain(secret, "test-device", credentials);
    assert.equal(await readFromKeychain(reference, credentials), secret);
    const handle = reference.slice("keychain:v1:".length);
    const { stdout } = await exec("/usr/bin/security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      handle,
      "-w",
      credentials.keychain,
    ]);
    assert.equal(Buffer.from(stdout.trim(), "base64").toString("utf8"), secret);
    await deleteFromKeychain(reference, credentials);
    await assert.rejects(readFromKeychain(reference, credentials), /missing from the OS keychain/);
  },
);

test(
  "Linux: the session's Secret Service stores, reads and deletes a credential",
  { skip: process.platform !== "linux" || process.env.VERSIONSTEAD_KEYRING_TESTS !== "1" },
  async () => {
    assert.equal(await keychainIssue({}), null);
    const secret = `token-${randomBytes(24).toString("base64url")}`;
    const reference = await storeInKeychain(secret, "test-device");
    assert.equal(await readFromKeychain(reference), secret);
    const handle = reference.slice("keychain:v1:".length);
    const { stdout } = await exec("secret-tool", [
      "lookup",
      "service",
      KEYCHAIN_SERVICE,
      "account",
      handle,
    ]);
    assert.equal(Buffer.from(stdout, "base64").toString("utf8"), secret);
    await deleteFromKeychain(reference);
    await assert.rejects(readFromKeychain(reference), /missing from the OS keychain/);
  },
);
