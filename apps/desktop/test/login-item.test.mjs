import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeLoginItemChange, decodeLoginItemState } from "@versionstead/contracts/desktop";
import {
  AUTOSTART_FILE,
  UI_AGENT_LABEL,
  autostartEntry,
  changeLoginItem,
  readLoginItem,
} from "../dist/login-item.js";

async function context(t, platform, env = {}) {
  const home = await mkdtemp(join(tmpdir(), "vs-login-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  // Electron keeps one Run value, named by the app user model ID, so a later entry replaces an earlier one.
  let entry = null;
  const app = {
    getLoginItemSettings: (options) => {
      calls.push(["get", options]);
      const sameExecutable = entry?.path === options.path;
      return {
        openAtLogin: sameExecutable && JSON.stringify(entry.args) === JSON.stringify(options.args),
        // Documented to ignore the arguments: true for this executable launched with any of them.
        executableWillLaunchAtLogin: sameExecutable,
      };
    },
    setLoginItemSettings: (settings) => {
      calls.push(["set", settings]);
      entry = settings.openAtLogin ? { path: settings.path, args: settings.args } : null;
    },
  };
  return {
    calls,
    value: {
      platform,
      home,
      env,
      executable: "/opt/electron/Electron.app/Contents/MacOS/Electron",
      appPath: "/Users/me/versionstead/apps/desktop",
      app,
    },
  };
}

test("Windows registers Electron with the app path and --hidden, and reads that entry back", async (t) => {
  const { value, calls } = await context(t, "win32");
  assert.deepEqual(await readLoginItem(value), { openAtLogin: false });
  assert.deepEqual(await changeLoginItem(value, true), { openAtLogin: true });
  assert.deepEqual(calls.find(([kind]) => kind === "set")[1], {
    openAtLogin: true,
    path: value.executable,
    // Electron 44 quotes the executable and every argument itself; a pre-quoted path would reach
    // the app wrapped in literal quote characters.
    args: [value.appPath, "--hidden"],
  });
  assert.deepEqual(await changeLoginItem(value, false), { openAtLogin: false });
});

test("Windows reads Off for an entry that starts another checkout or another Electron", async (t) => {
  const { value } = await context(t, "win32");
  for (const entry of [
    // The same executable with other arguments: executableWillLaunchAtLogin would call this on.
    { path: value.executable, args: ["/other/checkout/apps/desktop", "--hidden"] },
    // This checkout under an Electron that a reinstall has since replaced.
    { path: "/opt/electron-45/electron", args: [value.appPath, "--hidden"] },
  ]) {
    value.app.setLoginItemSettings({ openAtLogin: true, ...entry });
    assert.deepEqual(await readLoginItem(value), { openAtLogin: false });
  }
  assert.deepEqual(await changeLoginItem(value, true), { openAtLogin: true });
});

test("macOS writes an Aqua-only LaunchAgent and Linux an XDG autostart entry, each read back exactly", async (t) => {
  for (const [platform, relative] of [
    ["darwin", join("Library", "LaunchAgents", `${UI_AGENT_LABEL}.plist`)],
    ["linux", join(".config", "autostart", AUTOSTART_FILE)],
  ]) {
    const { value } = await context(t, platform);
    const file = join(value.home, relative);
    assert.deepEqual(await readLoginItem(value), { openAtLogin: false });
    assert.deepEqual(await changeLoginItem(value, true), { openAtLogin: true });
    const contents = await readFile(file, "utf8");
    assert(contents.includes(value.executable) && contents.includes("--hidden"), platform);
    if (platform === "darwin")
      assert.match(contents, /<key>LimitLoadToSessionType<\/key>\n\t<string>Aqua<\/string>/);
    else
      assert.match(
        contents,
        /^Exec="\/opt\/electron\/Electron\.app\/Contents\/MacOS\/Electron" "\/Users\/me\/versionstead\/apps\/desktop" --hidden$/m,
      );
    assert.deepEqual(await changeLoginItem(value, false), { openAtLogin: false });
    await assert.rejects(readFile(file), { code: "ENOENT" });
  }
});

test("an entry left by another Electron or checkout reads as off until it is enabled again", async (t) => {
  const { value } = await context(t, "linux");
  await changeLoginItem(value, true);
  const moved = { ...value, executable: "/opt/electron-45/electron" };
  assert.deepEqual(await readLoginItem(moved), { openAtLogin: false });
  assert.deepEqual(await changeLoginItem(moved, true), { openAtLogin: true });
  const file = join(value.home, ".config", "autostart", AUTOSTART_FILE);
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      "X-GNOME-Autostart-enabled=true",
      "X-GNOME-Autostart-enabled=false",
    ),
  );
  assert.deepEqual(await readLoginItem(moved), { openAtLogin: false }, "A disabled entry is off");
});

test("Linux honors XDG_CONFIG_HOME and refuses paths an Exec line cannot carry", async (t) => {
  const config = await mkdtemp(join(tmpdir(), "vs-login-config-"));
  t.after(() => rm(config, { recursive: true, force: true }));
  const { value } = await context(t, "linux", { XDG_CONFIG_HOME: config });
  await changeLoginItem(value, true);
  assert.match(await readFile(join(config, "autostart", AUTOSTART_FILE), "utf8"), /--hidden/);
  for (const appPath of ["/a/100%", "/a/$HOME", '/a/"q"', "/a/`x`", "/a\\b", "relative"])
    assert.throws(() => autostartEntry(value.executable, appPath), /absolute paths/, appPath);
  // Nothing can be registered for such a path, so it reads off and turning the switch on says why.
  const unsafe = { ...value, appPath: "/a/$HOME" };
  assert.deepEqual(await readLoginItem(unsafe), { openAtLogin: false });
  await assert.rejects(changeLoginItem(unsafe, true), /absolute paths/);
  assert.deepEqual(await readLoginItem({ ...value, platform: "freebsd" }), { openAtLogin: false });
  await assert.rejects(changeLoginItem({ ...value, platform: "freebsd" }, true), /not available/);
});

test("a failure to save or remove the entry says so without the path or the system error", async (t) => {
  for (const [platform, top, relative] of [
    ["darwin", "Library", join("Library", "LaunchAgents", `${UI_AGENT_LABEL}.plist`)],
    ["linux", ".config", join(".config", "autostart", AUTOSTART_FILE)],
  ]) {
    // A file where the entry's folder belongs stops it being created.
    const blocked = (await context(t, platform)).value;
    await writeFile(join(blocked.home, top), "not a folder");
    // A folder where the entry belongs stops it being removed.
    const occupied = (await context(t, platform)).value;
    await mkdir(join(occupied.home, relative), { recursive: true });
    for (const [value, enable, message] of [
      [blocked, true, "Could not save the login entry."],
      [occupied, false, "Could not remove the login entry."],
    ])
      await assert.rejects(changeLoginItem(value, enable), (error) => {
        assert.equal(error.message, message, platform);
        assert.equal(error.cause, undefined, "No system error rides along");
        assert(!error.stack.includes(value.home), "No path in the stack either");
        return true;
      });
  }
});

test("the login-item IPC accepts only booleans and the read-back state", () => {
  assert.equal(decodeLoginItemChange(true), true);
  assert.throws(() => decodeLoginItemChange("yes"));
  assert.deepEqual(decodeLoginItemState({ openAtLogin: false }), { openAtLogin: false });
  assert.throws(() => decodeLoginItemState({ openAtLogin: "on" }));
});

test(
  "macOS plutil accepts the UI LaunchAgent",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { value } = await context(t, "darwin");
    await changeLoginItem(value, true);
    const file = join(value.home, "Library", "LaunchAgents", `${UI_AGENT_LABEL}.plist`);
    execFileSync("/usr/bin/plutil", ["-lint", file]);
    const parsed = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }),
    );
    assert.deepEqual(parsed.ProgramArguments, [value.executable, value.appPath, "--hidden"]);
    assert.equal(parsed.LimitLoadToSessionType, "Aqua");
  },
);
