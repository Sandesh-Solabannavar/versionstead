import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COORDINATOR_LABEL,
  HostError,
  SYSTEMD_UNIT,
  agentDataDir,
  coordinatorAgent,
  coordinatorArguments,
  hostFile,
  launchAgentPlist,
  runBackgroundHost,
  runCommand,
  systemdUnit,
  unitDataDir,
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
    "/data/trailing ",
    "relative",
  ])
    assert.throws(() => systemdUnit({ ...paths, dataDir }), HostError, dataDir);
  // WorkingDirectory= is the one unquoted value, and systemd strips trailing whitespace from assignments.
  assert.throws(() => systemdUnit({ ...paths, workspace: `${paths.workspace} ` }), HostError);
  assert.throws(() => systemdUnit({ ...paths, node: "/usr/local/bin/node " }), HostError);
});

test("a definition names its data directory again, whatever the path holds", () => {
  for (const dataDir of [
    "/home/owner/.local/share/Versionstead",
    "/data/with space/a;b#c=d",
    "/data/{x}[y](z)!~@:,",
    "/data/café/日本語",
  ]) {
    assert.equal(unitDataDir(systemdUnit({ ...paths, dataDir })), dataDir, dataDir);
    assert.equal(agentDataDir(coordinatorAgent({ ...paths, dataDir })), dataDir, dataDir);
  }
  // Only the entities the plist writes are undone, in the right order: text that already looks like
  // an entity comes back as it was.
  for (const dataDir of [
    "/data/A & B <c> d",
    "/data/&amp;lt;",
    "/data/&lt;&gt;&amp;",
    "/data/x&y;z",
  ])
    assert.equal(agentDataDir(coordinatorAgent({ ...paths, dataDir })), dataDir, dataDir);
  // Another path that holds text shaped like the flag is not mistaken for it.
  assert.equal(
    unitDataDir(systemdUnit({ ...paths, workspace: "/w/ --data-dir /elsewhere" })),
    paths.dataDir,
  );
  assert.equal(
    agentDataDir(coordinatorAgent({ ...paths, workspace: "/w/<string>--data-dir</string>" })),
    paths.dataDir,
  );
  // A definition in another shape names nothing.
  assert.equal(unitDataDir("[Service]\nExecStart=/bin/true\n"), null);
  assert.equal(agentDataDir("<plist><dict></dict></plist>"), null);
});

test("refuses to run as root, before it touches anything", async () => {
  for (const platform of ["darwin", "linux"])
    for (const action of ["install", "start", "stop", "restart", "status", "uninstall"])
      await assert.rejects(
        runBackgroundHost(action, { platform, uid: 0 }),
        /own user, not with sudo/,
        `${platform} ${action}`,
      );
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

const macService = `gui/501/${COORDINATOR_LABEL}`;
/** How a `systemctl --user` call appears in a fixture's recorded calls. */
const user = (...args) => ["systemctl --user", ...args].join(" ");

/**
 * A temporary home and built checkout, a recording command runner, and a recording coordinator.
 * `dataDirs` collects every data directory the coordinator was asked about; `ready` answers "host"
 * until `notReady()` ("none") or `occupied()` ("other": another coordinator serves the directory).
 */
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
  const dataDirs = new Set();
  let serving = "host";
  const context = {
    platform,
    home,
    uid: 501,
    user: "owner",
    node: process.execPath,
    workspace,
    dataDir: join(home, "data"),
    linger: false,
    settleMs: 0,
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
      stop: async (dataDir) => (dataDirs.add(dataDir), void calls.push("coordinator stop")),
      ready: async (dataDir) => (dataDirs.add(dataDir), calls.push("coordinator ready"), serving),
      captureSources: async (dataDir) => (
        dataDirs.add(dataDir),
        calls.push("coordinator sources"),
        true
      ),
    },
  };
  return {
    context,
    calls,
    lines,
    dataDirs,
    notReady: () => {
      serving = "none";
    },
    occupied: () => {
      serving = "other";
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
      `systemctl --user restart ${SYSTEMD_UNIT}`,
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

test(
  "Linux actions after install use the data directory pinned in the unit, and refuse a different one",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await hostFixture(t, "linux");
    const pinned = fixture.context.dataDir;
    await runBackgroundHost("install", fixture.context);
    // The script gives later actions a data directory only when --data-dir was passed.
    const later = { ...fixture.context, dataDir: undefined };
    fixture.dataDirs.clear();
    fixture.calls.length = 0;
    await runBackgroundHost("start", later);
    await runBackgroundHost("status", later);
    await runBackgroundHost("stop", later);
    assert.deepEqual(fixture.calls, [
      user("show-environment"),
      user("start", SYSTEMD_UNIT),
      "coordinator ready",
      user("show-environment"),
      user("is-enabled", SYSTEMD_UNIT),
      user("is-active", SYSTEMD_UNIT),
      "loginctl show-user owner --property=Linger",
      "coordinator ready",
      user("show-environment"),
      "coordinator stop",
      user("stop", SYSTEMD_UNIT),
    ]);
    await runBackgroundHost("restart", later);
    await runBackgroundHost("uninstall", later);
    assert.deepEqual([...fixture.dataDirs], [pinned]);
    assert.equal(existsSync(hostFile("linux", fixture.context.home)), false);
    // A different --data-dir is refused before anything changes, and the message names no path.
    await runBackgroundHost("install", fixture.context);
    fixture.calls.length = 0;
    const elsewhere = { ...fixture.context, dataDir: join(fixture.context.home, "elsewhere") };
    for (const action of ["start", "stop", "restart", "status", "uninstall"])
      await assert.rejects(
        runBackgroundHost(action, elsewhere),
        (error) =>
          error instanceof HostError &&
          /installed for a different data directory/.test(error.message) &&
          !error.message.includes(fixture.context.home),
        action,
      );
    assert.deepEqual(fixture.calls, Array(5).fill(user("show-environment")));
  },
);

test(
  "macOS actions after install use the data directory pinned in the plist, and refuse a different one",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await hostFixture(t, "darwin");
    const pinned = fixture.context.dataDir;
    await runBackgroundHost("install", fixture.context);
    const later = { ...fixture.context, dataDir: undefined };
    fixture.dataDirs.clear();
    for (const action of ["start", "status", "stop", "restart", "uninstall"])
      await runBackgroundHost(action, later);
    assert.deepEqual([...fixture.dataDirs], [pinned]);
    assert.equal(existsSync(hostFile("darwin", fixture.context.home)), false);
    await runBackgroundHost("install", fixture.context);
    fixture.calls.length = 0;
    const elsewhere = { ...fixture.context, dataDir: join(fixture.context.home, "elsewhere") };
    for (const action of ["start", "stop", "restart", "status", "uninstall"])
      await assert.rejects(
        runBackgroundHost(action, elsewhere),
        (error) =>
          error instanceof HostError &&
          /installed for a different data directory/.test(error.message) &&
          !error.message.includes(fixture.context.home),
        action,
      );
    assert.deepEqual(fixture.calls, []);
  },
);

test(
  "Linux status reports the unit, its enabled and active state, lingering, and who serves the data directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const results = {};
    const fixture = await hostFixture(t, "linux", results);
    await runBackgroundHost("install", fixture.context);
    const status = async (context = fixture.context) => {
      fixture.lines.length = 0;
      await runBackgroundHost("status", context);
      return [...fixture.lines];
    };
    results[user("is-enabled", SYSTEMD_UNIT)] = { code: 0, stdout: "enabled\n", stderr: "" };
    results[user("is-active", SYSTEMD_UNIT)] = { code: 0, stdout: "active\n", stderr: "" };
    results["loginctl show-user owner --property=Linger"] = {
      code: 0,
      stdout: "Linger=yes\n",
      stderr: "",
    };
    assert.deepEqual(await status(), [
      "Unit file: installed",
      "Enabled: enabled",
      "Active: active",
      "Lingering: on (runs before login and after logout). Keyring-backed connection credentials stay locked until you log in.",
      "Coordinator: ready (background host)",
    ]);
    // A stopped unit exits non-zero but still names its state; no answer at all is "unknown".
    results[user("is-enabled", SYSTEMD_UNIT)] = { code: 1, stdout: "", stderr: "" };
    results[user("is-active", SYSTEMD_UNIT)] = { code: 3, stdout: "inactive\n", stderr: "" };
    results["loginctl show-user owner --property=Linger"] = {
      code: 0,
      stdout: "Linger=no\n",
      stderr: "",
    };
    fixture.notReady();
    const stopped = await status();
    assert.deepEqual(stopped.slice(0, 3), [
      "Unit file: installed",
      "Enabled: unknown",
      "Active: inactive",
    ]);
    assert.match(stopped[3], /^Lingering: off\. Monitoring stops when you log out/);
    assert.equal(stopped[4], "Coordinator: not running as the background host");
    fixture.occupied();
    assert.match(
      (await status())[4],
      /^Coordinator: served by the desktop's own coordinator.*Run restart/,
    );
    // With nothing installed and no --data-dir there is no coordinator to ask about.
    await runBackgroundHost("uninstall", fixture.context);
    const gone = await status({ ...fixture.context, dataDir: undefined });
    assert.equal(gone[0], "Unit file: not installed");
    assert.equal(gone.length, 4);
  },
);

test(
  "macOS status reports the file, what launchd says about the job, and who serves the data directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const results = {};
    const fixture = await hostFixture(t, "darwin", results);
    await runBackgroundHost("install", fixture.context);
    const print = `launchctl print ${macService}`;
    const status = async (context = fixture.context) => {
      fixture.lines.length = 0;
      fixture.calls.length = 0;
      await runBackgroundHost("status", context);
      return [...fixture.lines];
    };
    results[print] = {
      code: 0,
      stdout: `${macService} = {\n\tstate = running\n\tpid = 42\n}\n`,
      stderr: "",
    };
    assert.deepEqual(await status(), [
      "LaunchAgent: installed",
      "launchd: running",
      "Coordinator: ready (background host)",
    ]);
    assert.deepEqual(fixture.calls, [print, "coordinator ready"]);
    // "state = not running" must not read as running.
    results[print] = {
      code: 0,
      stdout: `${macService} = {\n\tstate = not running\n}\n`,
      stderr: "",
    };
    assert.equal((await status())[1], "launchd: loaded, not running");
    results[print] = { code: 113, stdout: "", stderr: "Could not find service" };
    fixture.notReady();
    assert.deepEqual(await status(), [
      "LaunchAgent: installed",
      "launchd: not loaded",
      "Coordinator: not running as the background host",
    ]);
    fixture.occupied();
    assert.match(
      (await status())[2],
      /^Coordinator: served by the desktop's own coordinator.*Run restart/,
    );
    // With nothing installed and no --data-dir there is no coordinator to ask about.
    await runBackgroundHost("uninstall", fixture.context);
    assert.deepEqual(await status({ ...fixture.context, dataDir: undefined }), [
      "LaunchAgent: not installed",
      "launchd: not loaded",
    ]);
  },
);

test(
  "macOS stop, restart and uninstall drive launchctl and the coordinator",
  { skip: process.platform === "win32" },
  async (t) => {
    const print = `launchctl print ${macService}`;
    const results = { [print]: { code: 0, stdout: "\tstate = not running\n", stderr: "" } };
    const fixture = await hostFixture(t, "darwin", results);
    const plist = hostFile("darwin", fixture.context.home);
    await runBackgroundHost("install", fixture.context);
    fixture.calls.length = 0;
    await runBackgroundHost("stop", fixture.context);
    await runBackgroundHost("restart", fixture.context);
    await runBackgroundHost("uninstall", fixture.context);
    assert.deepEqual(fixture.calls, [
      "coordinator stop",
      print,
      "coordinator stop",
      print,
      `launchctl kickstart -k ${macService}`,
      "coordinator ready",
      "coordinator stop",
      `launchctl bootout ${macService}`,
    ]);
    assert.equal(existsSync(plist), false);
    // A job that is not loaded is bootstrapped, not kickstarted.
    results[print] = { code: 113, stdout: "", stderr: "Could not find service" };
    await runBackgroundHost("install", fixture.context);
    fixture.calls.length = 0;
    await runBackgroundHost("restart", fixture.context);
    assert.deepEqual(fixture.calls, [
      "coordinator stop",
      print,
      `launchctl bootstrap gui/501 ${plist}`,
      "coordinator ready",
    ]);
  },
);

test(
  "macOS stop waits for launchd to report the job gone, and says what to do when it keeps running",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await hostFixture(t, "darwin");
    await runBackgroundHost("install", fixture.context);
    const record = fixture.context.run;
    // The job is still shutting down for the first two checks.
    let prints = 0;
    fixture.context.settleMs = 5_000;
    fixture.context.run = async (file, args) =>
      args[0] === "print"
        ? {
            code: 0,
            stdout: `\tstate = ${++prints < 3 ? "running" : "not running"}\n`,
            stderr: "",
          }
        : record(file, args);
    fixture.lines.length = 0;
    await runBackgroundHost("stop", fixture.context);
    assert.equal(prints, 3);
    assert(fixture.lines.some((line) => /^Stopped\./.test(line)));
    // Still running when the wait ends: no "Stopped.", and the next step is named.
    fixture.context.settleMs = 0;
    fixture.context.run = async (file, args) =>
      args[0] === "print"
        ? { code: 0, stdout: "\tstate = running\n", stderr: "" }
        : record(file, args);
    fixture.lines.length = 0;
    await assert.rejects(
      runBackgroundHost("stop", fixture.context),
      (error) =>
        error instanceof HostError &&
        /still running/.test(error.message) &&
        /restart/.test(error.message) &&
        /uninstall/.test(error.message),
    );
    assert.deepEqual(fixture.lines, []);
  },
);

test(
  "a manager XDG_CONFIG_HOME that systemd prints in its $'...' form is refused before anything changes",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await hostFixture(t, "linux", {
      [user("show-environment")]: {
        code: 0,
        stdout: "HOME=/home/owner\nXDG_CONFIG_HOME=$'/home/owner/my config'\n",
        stderr: "",
      },
    });
    for (const action of ["install", "start", "stop", "restart", "status", "uninstall"])
      await assert.rejects(runBackgroundHost(action, fixture.context), /XDG_CONFIG_HOME/, action);
    // Only the read-only look at the manager ran: nothing stopped, nothing written.
    assert.deepEqual(fixture.calls, Array(6).fill(user("show-environment")));
    assert.equal(existsSync(hostFile("linux", fixture.context.home)), false);
  },
);

test(
  "stop, restart and uninstall let the service manager finish when the coordinator will not stop",
  { skip: process.platform === "win32" },
  async (t) => {
    const refusing = (fixture) => {
      fixture.context.coordinator.stop = async () => {
        fixture.calls.push("coordinator stop");
        throw new HostError("The running coordinator refused to stop.");
      };
    };
    const linux = await hostFixture(t, "linux");
    await runBackgroundHost("install", linux.context);
    refusing(linux);
    linux.calls.length = 0;
    await runBackgroundHost("stop", linux.context);
    await runBackgroundHost("restart", linux.context);
    assert.deepEqual(linux.calls, [
      user("show-environment"),
      "coordinator stop",
      user("stop", SYSTEMD_UNIT),
      user("show-environment"),
      "coordinator stop",
      user("restart", SYSTEMD_UNIT),
      "coordinator ready",
    ]);
    await runBackgroundHost("uninstall", linux.context);
    assert.equal(existsSync(hostFile("linux", linux.context.home)), false);
    // When systemd cannot do it either, the owner sees why the coordinator would not stop, and the
    // unit stays so the action can be retried.
    const failed = { code: 1, stdout: "", stderr: "" };
    const stuck = await hostFixture(t, "linux", {
      [user("stop", SYSTEMD_UNIT)]: failed,
      [user("restart", SYSTEMD_UNIT)]: failed,
      [user("disable", "--now", SYSTEMD_UNIT)]: failed,
    });
    await runBackgroundHost("install", stuck.context);
    refusing(stuck);
    for (const action of ["stop", "restart", "uninstall"])
      await assert.rejects(runBackgroundHost(action, stuck.context), /refused to stop/, action);
    assert.equal(existsSync(hostFile("linux", stuck.context.home)), true);

    const print = `launchctl print ${macService}`;
    const idle = { code: 0, stdout: "\tstate = not running\n", stderr: "" };
    const mac = await hostFixture(t, "darwin", { [print]: idle });
    await runBackgroundHost("install", mac.context);
    refusing(mac);
    mac.calls.length = 0;
    await runBackgroundHost("restart", mac.context);
    await runBackgroundHost("stop", mac.context);
    await runBackgroundHost("uninstall", mac.context);
    assert.deepEqual(mac.calls, [
      "coordinator stop",
      print,
      `launchctl kickstart -k ${macService}`,
      "coordinator ready",
      "coordinator stop",
      print,
      "coordinator stop",
      `launchctl bootout ${macService}`,
      print,
    ]);
    assert.equal(existsSync(hostFile("darwin", mac.context.home)), false);
    // A job that is still running is reported with the coordinator's failure, and its plist stays.
    const running = { code: 0, stdout: "\tstate = running\n", stderr: "" };
    const hung = await hostFixture(t, "darwin", { [print]: running });
    await runBackgroundHost("install", hung.context);
    refusing(hung);
    await assert.rejects(
      runBackgroundHost("stop", hung.context),
      /refused to stop\. The LaunchAgent is still running\. Run restart/,
    );
    await assert.rejects(runBackgroundHost("uninstall", hung.context), /refused to stop/);
    assert.equal(existsSync(hostFile("darwin", hung.context.home)), true);
  },
);

test(
  "install, start and restart say so at once when the desktop's own coordinator serves the data directory",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const platform of ["linux", "darwin"]) {
      const fixture = await hostFixture(t, platform);
      await runBackgroundHost("install", fixture.context);
      fixture.occupied();
      for (const action of ["start", "restart", "install"])
        await assert.rejects(
          runBackgroundHost(action, fixture.context),
          /desktop's own coordinator serves this data directory.*Run restart/,
          `${platform} ${action}`,
        );
      // Only the first, successful install saved owner sources; the failed one did not go on to.
      assert.equal(fixture.calls.filter((call) => call === "coordinator sources").length, 1);
    }
  },
);

test(
  "uninstall with nothing installed is a best-effort no-op that succeeds",
  { skip: process.platform === "win32" },
  async (t) => {
    const failed = { code: 113, stdout: "", stderr: "Could not find service" };
    const linux = await hostFixture(t, "linux", {
      [user("disable", "--now", SYSTEMD_UNIT)]: failed,
    });
    await runBackgroundHost("uninstall", linux.context);
    assert.deepEqual(linux.calls, [
      user("show-environment"),
      user("disable", "--now", SYSTEMD_UNIT),
    ]);
    assert.deepEqual(linux.lines, ["The background host is not installed."]);
    const mac = await hostFixture(t, "darwin", { [`launchctl bootout ${macService}`]: failed });
    await runBackgroundHost("uninstall", mac.context);
    assert.deepEqual(mac.calls, [`launchctl bootout ${macService}`]);
    assert.deepEqual(mac.lines, ["The background host is not installed."]);
    // A second uninstall after a real one behaves the same; other actions still point at install.
    await runBackgroundHost("install", mac.context);
    await runBackgroundHost("uninstall", mac.context);
    mac.lines.length = 0;
    await runBackgroundHost("uninstall", mac.context);
    assert.deepEqual(mac.lines, ["The background host is not installed."]);
    await assert.rejects(runBackgroundHost("stop", mac.context), /Run install first/);
  },
);

test(
  "install for a different data directory also stops the host of the one it replaces",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const platform of ["linux", "darwin"]) {
      const fixture = await hostFixture(t, platform);
      const first = fixture.context.dataDir;
      const second = join(fixture.context.home, "second data");
      const stops = () => fixture.calls.filter((call) => call === "coordinator stop").length;
      await runBackgroundHost("install", fixture.context);
      fixture.calls.length = 0;
      await runBackgroundHost("install", fixture.context);
      assert.equal(stops(), 1, `${platform}: the same directory is stopped once`);
      fixture.calls.length = 0;
      fixture.dataDirs.clear();
      await runBackgroundHost("install", { ...fixture.context, dataDir: second });
      assert.equal(stops(), 2, `${platform}: the replaced directory is stopped too`);
      assert.deepEqual([...fixture.dataDirs].sort(), [first, second].sort());
      // The definition now pins the new directory.
      fixture.dataDirs.clear();
      await runBackgroundHost("stop", { ...fixture.context, dataDir: undefined });
      assert.deepEqual([...fixture.dataDirs], [second]);
    }
  },
);

test(
  "a definition that names no data directory sends later actions back to install",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await hostFixture(t, "linux");
    const file = hostFile("linux", fixture.context.home);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "[Service]\nExecStart=/usr/bin/true\n");
    for (const action of ["start", "stop", "restart", "status", "uninstall"])
      await assert.rejects(runBackgroundHost(action, fixture.context), /Run install again/, action);
    assert(!fixture.calls.some((call) => call.startsWith("coordinator")));
    await runBackgroundHost("install", fixture.context);
    assert.equal(unitDataDir(await readFile(file, "utf8")), fixture.context.dataDir);
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
