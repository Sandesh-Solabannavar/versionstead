import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COORDINATOR_LABEL,
  HostError,
  SYSTEMD_UNIT,
  coordinatorAgent,
  coordinatorArguments,
  hostFile,
  launchAgentPlist,
  runBackgroundHost,
  runCommand,
  systemdUnit,
} from "../dist/adapters/background-host.js";
import { readRuntime } from "../dist/runtime.js";

const paths = {
  node: "/usr/local/bin/node",
  workspace: "/home/owner/My Projects/versionstead",
  dataDir: "/home/owner/.local/share/Versionstead",
};

test("the systemd unit pins the data directory, quotes paths with spaces, and refuses what systemd would expand", () => {
  assert.equal(
    systemdUnit(paths),
    [
      "[Unit]",
      "Description=Versionstead monitoring coordinator",
      "",
      "[Service]",
      "Type=simple",
      "WorkingDirectory=/home/owner/My Projects/versionstead",
      'ExecStart="/usr/local/bin/node" "/home/owner/My Projects/versionstead/apps/server/dist/bin.js" --data-dir "/home/owner/.local/share/Versionstead" --port 0 --mode background --host boot-task --web-root "/home/owner/My Projects/versionstead/apps/web/dist"',
      "Restart=on-failure",
      "RestartSec=10",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
  for (const dataDir of [
    "/data/100%",
    "/data/$HOME",
    '/data/"q"',
    "/data/it's",
    "/data/a\\b",
    "/data/a\nb",
    "relative",
  ])
    assert.throws(() => systemdUnit({ ...paths, dataDir }), HostError, dataDir);
});

test("the LaunchAgent runs the same command, restarts only after a failure, and escapes XML", () => {
  const agent = coordinatorAgent({ ...paths, workspace: "/Users/me/A & B <c>" });
  assert.match(
    agent,
    /<string>\/Users\/me\/A &amp; B &lt;c&gt;\/apps\/server\/dist\/bin\.js<\/string>/,
  );
  assert.match(
    agent,
    /<key>KeepAlive<\/key>\n\t<dict>\n\t\t<key>SuccessfulExit<\/key>\n\t\t<false\/>/,
  );
  assert.match(agent, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.doesNotMatch(agent, /LimitLoadToSessionType/);
  assert.deepEqual(
    [...agent.matchAll(/\t\t<string>(.*)<\/string>/g)].map((match) => match[1]),
    coordinatorArguments({ ...paths, workspace: "/Users/me/A &amp; B &lt;c&gt;" }),
  );
  assert.match(
    launchAgentPlist({ label: "dev.versionstead.ui", programArguments: ["/x"], aquaOnly: true }),
    /<key>LimitLoadToSessionType<\/key>\n\t<string>Aqua<\/string>/,
  );
  assert.throws(() => coordinatorAgent({ ...paths, dataDir: "/a\u0007b" }), HostError);
  assert.throws(() => coordinatorAgent({ ...paths, dataDir: "relative" }), HostError);
});

test("service files live where launchd and the systemd manager look", () => {
  assert.equal(
    hostFile("darwin", "/Users/me"),
    `/Users/me/Library/LaunchAgents/${COORDINATOR_LABEL}.plist`,
  );
  assert.equal(hostFile("linux", "/home/me"), `/home/me/.config/systemd/user/${SYSTEMD_UNIT}`);
  assert.equal(hostFile("linux", "/home/me", "/cfg"), `/cfg/systemd/user/${SYSTEMD_UNIT}`);
  assert.equal(
    hostFile("linux", "/home/me", "relative"),
    `/home/me/.config/systemd/user/${SYSTEMD_UNIT}`,
  );
});

test(
  "macOS plutil accepts the generated LaunchAgent",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "vs-plist-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "agent.plist");
    const agentPaths = { ...paths, workspace: "/Users/me/A & B <c>/versionstead" };
    await writeFile(file, coordinatorAgent(agentPaths));
    execFileSync("/usr/bin/plutil", ["-lint", file]);
    const parsed = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }),
    );
    assert.equal(parsed.Label, COORDINATOR_LABEL);
    assert.deepEqual(parsed.ProgramArguments, coordinatorArguments(agentPaths));
    assert.deepEqual(parsed.KeepAlive, { SuccessfulExit: false });
    assert.equal(parsed.RunAtLoad, true);
  },
);

test(
  "systemd-analyze accepts the generated unit",
  { skip: !existsSync("/usr/bin/systemd-analyze") },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "vs-unit-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const workspace = join(directory, "My Projects", "versionstead");
    await mkdir(join(workspace, "apps", "server", "dist"), { recursive: true });
    await writeFile(join(workspace, "apps", "server", "dist", "bin.js"), "");
    const unit = join(directory, SYSTEMD_UNIT);
    await writeFile(
      unit,
      systemdUnit({ node: process.execPath, workspace, dataDir: join(directory, "data dir") }),
    );
    execFileSync("/usr/bin/systemd-analyze", ["verify", unit], { stdio: "pipe" });
  },
);

/** A temporary home and built checkout, a recording command runner, and a recording coordinator. */
async function hostFixture(t, platform, results = {}) {
  const home = await mkdtemp(join(tmpdir(), "vs-host-home-"));
  const workspace = join(home, "checkout");
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(workspace, "apps", "server", "dist"), { recursive: true });
  await mkdir(join(workspace, "apps", "web", "dist"), { recursive: true });
  await writeFile(join(workspace, "apps", "server", "dist", "bin.js"), "");
  await writeFile(join(workspace, "apps", "web", "dist", "index.html"), "");
  const calls = [];
  const lines = [];
  let ready = true;
  const context = {
    platform,
    home,
    uid: 501,
    user: "owner",
    node: process.execPath,
    workspace,
    dataDir: join(home, "data"),
    linger: false,
    tools: {
      launchctl: "/bin/launchctl",
      systemctl: "/usr/bin/systemctl",
      loginctl: "/usr/bin/loginctl",
    },
    out: (line) => void lines.push(line),
    run: async (file, args) => {
      const key = [file.split("/").at(-1), ...args].join(" ");
      calls.push(key);
      return results[key] ?? { code: 0, stdout: "", stderr: "" };
    },
    coordinator: {
      stop: async () => void calls.push("coordinator stop"),
      ready: async () => (calls.push("coordinator ready"), ready),
      captureSources: async () => (calls.push("coordinator sources"), true),
    },
  };
  return {
    context,
    calls,
    lines,
    notReady: () => {
      ready = false;
    },
  };
}

test(
  "Linux install writes the unit where the systemd manager looks, enables it, waits, and saves owner sources",
  { skip: process.platform === "win32" },
  async (t) => {
    const results = {};
    const fixture = await hostFixture(t, "linux", results);
    // The manager's XDG_CONFIG_HOME, not this shell's, decides where user units live.
    const config = join(fixture.context.home, "manager-config");
    results["systemctl --user show-environment"] = {
      code: 0,
      stdout: `HOME=/home/owner\nXDG_CONFIG_HOME=${config}\n`,
      stderr: "",
    };
    results["loginctl show-user owner --property=Linger"] = {
      code: 0,
      stdout: "Linger=no\n",
      stderr: "",
    };
    await runBackgroundHost("install", fixture.context);
    const unit = join(config, "systemd", "user", SYSTEMD_UNIT);
    assert.equal(await readFile(unit, "utf8"), systemdUnit(fixture.context));
    assert.deepEqual(fixture.calls, [
      "systemctl --user show-environment",
      "coordinator stop",
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
      "coordinator ready",
      "coordinator sources",
      "loginctl show-user owner --property=Linger",
    ]);
    assert(fixture.lines.some((line) => /Lingering: off/.test(line)));
  },
);

test(
  "Linux install with --linger enables lingering and names the keyring limit; without a user manager nothing changes",
  { skip: process.platform === "win32" },
  async (t) => {
    const lingering = await hostFixture(t, "linux");
    lingering.context.linger = true;
    await runBackgroundHost("install", lingering.context);
    assert(lingering.calls.includes("loginctl enable-linger owner"));
    assert(
      lingering.lines.some((line) => /Lingering enabled.*stay locked until you log in/.test(line)),
    );
    const missing = await hostFixture(t, "linux", {
      "systemctl --user show-environment": {
        code: 1,
        stdout: "",
        stderr: "Failed to connect to bus",
      },
    });
    await assert.rejects(
      runBackgroundHost("install", missing.context),
      /systemd --user is unavailable/,
    );
    assert.deepEqual(missing.calls, ["systemctl --user show-environment"]);
    assert.equal(existsSync(hostFile("linux", missing.context.home)), false);
  },
);

test(
  "Linux stop, restart and uninstall drive the unit and the coordinator",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await hostFixture(t, "linux");
    await assert.rejects(runBackgroundHost("start", fixture.context), /Run install first/);
    await runBackgroundHost("install", fixture.context);
    fixture.calls.length = 0;
    await runBackgroundHost("stop", fixture.context);
    await runBackgroundHost("restart", fixture.context);
    await runBackgroundHost("uninstall", fixture.context);
    assert.deepEqual(fixture.calls, [
      "systemctl --user show-environment",
      "coordinator stop",
      `systemctl --user stop ${SYSTEMD_UNIT}`,
      "systemctl --user show-environment",
      "coordinator stop",
      `systemctl --user start ${SYSTEMD_UNIT}`,
      "coordinator ready",
      "systemctl --user show-environment",
      "coordinator stop",
      `systemctl --user disable --now ${SYSTEMD_UNIT}`,
      "systemctl --user daemon-reload",
      `systemctl --user reset-failed ${SYSTEMD_UNIT}`,
    ]);
    assert.equal(existsSync(hostFile("linux", fixture.context.home)), false);
    const slow = await hostFixture(t, "linux");
    slow.notReady();
    await assert.rejects(runBackgroundHost("install", slow.context), /did not become ready/);
  },
);

test(
  "macOS install bootstraps the LaunchAgent in the gui domain, and start kickstarts a loaded one",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await hostFixture(t, "darwin", {
      "launchctl print gui/501/dev.versionstead.coordinator": {
        code: 113,
        stdout: "",
        stderr: "Could not find service",
      },
    });
    await runBackgroundHost("install", fixture.context);
    const plist = hostFile("darwin", fixture.context.home);
    assert.equal(await readFile(plist, "utf8"), coordinatorAgent(fixture.context));
    assert.deepEqual(fixture.calls, [
      "coordinator stop",
      "launchctl bootout gui/501/dev.versionstead.coordinator",
      `launchctl bootstrap gui/501 ${plist}`,
      "coordinator ready",
      "coordinator sources",
    ]);
    fixture.calls.length = 0;
    await runBackgroundHost("start", fixture.context);
    assert.deepEqual(fixture.calls.slice(0, 2), [
      "launchctl print gui/501/dev.versionstead.coordinator",
      `launchctl bootstrap gui/501 ${plist}`,
    ]);
    const loaded = await hostFixture(t, "darwin");
    await runBackgroundHost("install", loaded.context);
    loaded.calls.length = 0;
    await runBackgroundHost("start", loaded.context);
    assert.deepEqual(loaded.calls.slice(0, 2), [
      "launchctl print gui/501/dev.versionstead.coordinator",
      "launchctl kickstart gui/501/dev.versionstead.coordinator",
    ]);
    const ssh = await hostFixture(t, "darwin");
    ssh.context.run = async (_file, args) =>
      args[0] === "bootstrap"
        ? { code: 125, stdout: "", stderr: "Bootstrap failed: 125" }
        : { code: 0, stdout: "", stderr: "" };
    await assert.rejects(
      runBackgroundHost("install", ssh.context),
      /logged-in Mac desktop session/,
    );
  },
);

test("Windows is pointed at its own boot-task script", async () => {
  await assert.rejects(
    runBackgroundHost("install", { platform: "win32" }),
    /scripts\/windows-background\.ps1/,
  );
});

test(
  "systemd: install, stop, start, status and uninstall manage a real user service",
  {
    skip:
      process.platform !== "linux" || process.env.VERSIONSTEAD_SYSTEMD_SMOKE !== "1"
        ? "Runs in CI with a user manager (VERSIONSTEAD_SYSTEMD_SMOKE=1); never on a machine with an installed host."
        : false,
    timeout: 240_000,
  },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "vs-systemd-"));
    const lines = [];
    const context = {
      platform: "linux",
      home: homedir(),
      uid: process.getuid(),
      user: userInfo().username,
      node: process.execPath,
      workspace: fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, ""),
      dataDir,
      linger: false,
      run: runCommand,
      out: (line) => void lines.push(line),
    };
    t.after(async () => {
      await runBackgroundHost("uninstall", context).catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    });
    const active = async () =>
      (await runCommand("/usr/bin/systemctl", ["--user", "is-active", SYSTEMD_UNIT])).stdout.trim();
    await runBackgroundHost("install", context);
    assert.equal(await active(), "active");
    const runtime = await readRuntime(dataDir);
    assert.equal(runtime?.host, "boot-task");
    assert.equal(runtime?.mode, "background");
    await runBackgroundHost("stop", context);
    assert.equal(await readRuntime(dataDir), null);
    assert.notEqual(await active(), "active");
    await runBackgroundHost("start", context);
    assert.equal((await readRuntime(dataDir))?.host, "boot-task");
    lines.length = 0;
    await runBackgroundHost("status", context);
    assert(lines.includes("Coordinator: ready (background host)"), lines.join("\n"));
    await runBackgroundHost("uninstall", context);
    assert.equal(existsSync(hostFile("linux", homedir())), false);
  },
);
