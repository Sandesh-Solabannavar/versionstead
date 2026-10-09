import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  discoverTools,
  runTool,
  toolCandidates,
  toolExecutable as developmentTool,
  usableTool,
} from "../dist/adapters/development-tools.js";
import { discoverGlobalToolSources, npmGlobalCommand } from "../dist/adapters/inventory.js";
import { outdatedExecutable } from "../dist/adapters/outdated.js";
import {
  firstExecutable,
  inspectBun,
  inspectNode,
  localPath,
  ownNode,
  runBounded,
  toolDirectories,
  toolExecutable,
} from "../dist/adapters/tool-paths.js";

const windows = process.platform === "win32";
const launcher = windows ? "npm.cmd" : "npm";
async function temporary(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "versionstead-discovery-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function executableFile(path, contents = "") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
// One executable that behaves as whatever name it is invoked by, like Volta, mise and snap shims. Its Bun
// answers the identity probe with the real Bun beside it.
async function multiCall(base) {
  const shims = join(base, "shims");
  await mkdir(shims);
  const realBun = join(base, "real-bun");
  await executableFile(realBun, "#!/bin/sh\necho 1.4.0\n");
  const program = join(base, "multi-call");
  await executableFile(
    program,
    `#!/bin/sh
case "$(basename "$0")" in
  node) exec "${process.execPath}" "$@" ;;
  bun) printf '%s' '{"version":"1.4.0","execPath":"${realBun}"}' ;;
  *) echo "dispatched on $0" >&2; exit 1 ;;
esac
`,
  );
  for (const name of ["node", "bun"]) await symlink(program, join(shims, name));
  return { shims, realBun };
}
// A package manager's package at <prefix>/<layout>/<name>, as Windows (node_modules/npm) or POSIX
// (lib/node_modules/npm) lay it out.
async function installManager(prefix, layout, name, version) {
  const directory = join(prefix, ...layout, name);
  const script = join(directory, "bin", name === "npm" ? "npm-cli.js" : "pnpm.cjs");
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(script, "");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version }));
  return realpath(script);
}
const installNpm = (prefix, layout, version = "11.7.0") =>
  installManager(prefix, layout, "npm", version);

test("macOS and Linux keep PATH first, then add install, version-manager and system fallbacks", () => {
  // A Finder or Dock launch inherits only the system PATH, so the fallbacks must supply Homebrew and the managers.
  assert.deepEqual(
    toolDirectories({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, "darwin", "/Users/owner"),
    [
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/owner/.bun/bin",
      "/Users/owner/.volta/bin",
      "/Users/owner/Library/pnpm",
      "/Users/owner/.local/bin",
      "/Users/owner/.local/share/mise/shims",
      "/Users/owner/.asdf/shims",
    ],
  );
  assert.deepEqual(
    toolDirectories({ PATH: "/usr/local/bin:/home/owner/bin" }, "linux", "/home/owner"),
    [
      "/usr/local/bin",
      "/home/owner/bin",
      "/home/owner/.bun/bin",
      "/home/owner/.volta/bin",
      "/home/owner/.local/share/pnpm",
      "/home/owner/.local/bin",
      "/home/owner/.local/share/mise/shims",
      "/home/owner/.asdf/shims",
      "/usr/bin",
      "/bin",
      "/snap/bin",
    ],
  );
  const configured = {
    PATH: "/first",
    BUN_INSTALL: "/opt/bun",
    VOLTA_HOME: "/opt/volta",
    PNPM_HOME: "/opt/pnpm",
  };
  assert.deepEqual(toolDirectories(configured, "darwin", "/Users/owner"), [
    "/first",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/bun/bin",
    "/opt/volta/bin",
    "/opt/pnpm",
    "/Users/owner/.local/bin",
    "/Users/owner/.local/share/mise/shims",
    "/Users/owner/.asdf/shims",
    "/usr/bin",
    "/bin",
  ]);
  assert.deepEqual(toolDirectories(configured, "linux", "/home/owner"), [
    "/first",
    "/usr/local/bin",
    "/opt/bun/bin",
    "/opt/volta/bin",
    "/opt/pnpm",
    "/home/owner/.local/bin",
    "/home/owner/.local/share/mise/shims",
    "/home/owner/.asdf/shims",
    "/usr/bin",
    "/bin",
    "/snap/bin",
  ]);
});

test("fallback directories are absolute and unique: relative values, UNC-style entries and an empty home add nothing", () => {
  assert.deepEqual(
    toolDirectories(
      {
        PATH: "relative:./bin::~/bin:/dup:/dup:\\\\server\\share",
        BUN_INSTALL: "relative-bun",
        PNPM_HOME: "",
      },
      "linux",
      "",
    ),
    ["/dup", "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"],
  );
  // Windows keeps its own list; macOS/Linux variables and directories never leak into it.
  assert.deepEqual(toolDirectories({ PATH: "C:\\first", PNPM_HOME: "/opt/pnpm" }, "win32", "/h"), [
    "C:\\first",
  ]);
});

test(
  "POSIX executables keep the name they were found under so version-manager shims still dispatch",
  { skip: windows },
  async (t) => {
    const base = await temporary(t);
    const { shims, realBun } = await multiCall(base);
    assert.equal(await toolExecutable("node", [shims]), join(shims, "node"));
    assert.equal(await toolExecutable("missing", [shims]), null);
    const node = await inspectNode(join(shims, "node"));
    assert.deepEqual(node, { version: process.versions.node, execPath: process.execPath });
    assert.deepEqual(await inspectBun(join(shims, "bun")), { version: "1.4.0", execPath: realBun });
    // The shim is asked who it is; what a project run gets is the real Bun behind it.
    const root = await temporary(t);
    assert.deepEqual(await outdatedExecutable("bun", root, [shims]), {
      executable: realBun,
      prefix: [],
      version: "1.4.0",
    });
  },
);

test("Bun is asked for its own version and real path the same way", async () => {
  const shim = join(tmpdir(), "shims", "bun");
  const real = join(tmpdir(), "real", "bun");
  const seen = [];
  const run = async (file, args) => {
    seen.push([file, args]);
    return JSON.stringify({ version: "1.4.0", execPath: real });
  };
  assert.deepEqual(await inspectBun(shim, { run }), { version: "1.4.0", execPath: real });
  assert.equal(seen[0][0], shim);
  assert.equal(seen[0][1][0], "-e");
  assert.match(seen[0][1][1], /process\.versions\.bun.*process\.execPath/s);
  for (const candidate of ["relative/bun", "\\\\server\\share\\bun.exe", "//server/share/bun"])
    assert.equal(await inspectBun(candidate, { run }), null, candidate);
  assert.equal(seen.length, 1, "a relative or network candidate is never executed");
  assert.equal(
    await inspectBun(shim, {
      run: async () => JSON.stringify({ version: "1.4.0", execPath: "bun" }),
    }),
    null,
  );
});

test("a real Bun answers the probe with the version and path that it reports itself", async (t) => {
  const bun = await toolExecutable(windows ? "bun.exe" : "bun");
  if (!bun) return t.skip("Bun is unavailable on this host.");
  const reported = await inspectBun(bun);
  assert.ok(reported, "Bun must accept the probe");
  assert.equal(reported.version, execFileSync(bun, ["--version"], { encoding: "utf8" }).trim());
  assert.ok((await stat(reported.execPath)).isFile());
});

test("a rejected candidate does not end the search", async (t) => {
  const base = await temporary(t);
  const name = windows ? "tool.exe" : "tool";
  for (const directory of ["first", "second"]) await executableFile(join(base, directory, name));
  const candidates = [join(base, "first", name), join(base, "second", name)];
  const notFirst = async (candidate) => !candidate.startsWith(join(base, "first"));
  assert.equal(await firstExecutable(candidates, notFirst), join(base, "second", name));
  assert.equal(await firstExecutable(candidates, async () => false), null);
  assert.equal(await firstExecutable([join(base, "absent", name), ...candidates]), candidates[0]);
  assert.equal(
    await toolExecutable(name, [join(base, "absent"), join(base, "second")]),
    candidates[1],
  );
});

test("lookups consider only absolute local candidates, never the current directory or a network share", async (t) => {
  const base = await temporary(t);
  const name = windows ? "tool.exe" : "tool";
  await executableFile(join(base, name));
  const bin = join(base, "bin");
  await executableFile(join(bin, launcher));
  await installNpm(bin, ["node_modules"]);
  const root = await temporary(t);
  const previous = process.cwd();
  process.chdir(base);
  try {
    // Both exist and are executable relative to the current directory.
    assert.equal(await firstExecutable([name, `.${windows ? "\\" : "/"}${name}`]), null);
    assert.equal(await toolExecutable(name, ["."]), null);
    // A relative manager directory is not searched either, though a complete npm sits there.
    assert.equal(await outdatedExecutable("npm", root, ["bin"], join(base, "node-24")), null);
  } finally {
    process.chdir(previous);
  }
  assert.ok(await outdatedExecutable("npm", root, [bin], join(base, "node-24")));
  assert.equal(
    await firstExecutable([`\\\\server\\share\\${name}`, `//server/share/${name}`]),
    null,
  );
  assert.equal(await firstExecutable([join(base, name)]), join(base, name));
});

test("a local path is absolute with a drive letter on Windows and never a network share", () => {
  for (const [path, platform, expected] of [
    ["/usr/bin", "linux", true],
    ["/Applications/Tailscale.app", "darwin", true],
    ["bin", "linux", false],
    ["", "linux", false],
    ["//server/share/bin", "linux", false],
    ["C:\\Tools", "win32", true],
    ["c:/tools", "win32", true],
    ["C:tools", "win32", false],
    ["\\rooted", "win32", false],
    ["relative\\tools", "win32", false],
    ["\\\\server\\share\\tools", "win32", false],
    ["//server/share/tools", "win32", false],
  ])
    assert.equal(localPath(path, platform), expected, `${platform}: ${path}`);
});

test("Node is verified by running it and trusting its own report of version and real path", async () => {
  assert.deepEqual(await inspectNode(process.execPath), {
    version: process.versions.node,
    execPath: process.execPath,
  });
  assert.deepEqual(await inspectNode(process.execPath, { sqlite: true }), {
    version: process.versions.node,
    execPath: process.execPath,
  });
  const shim = join(tmpdir(), "shims", "node");
  const real = join(tmpdir(), "real", "bin", "node-24");
  const seen = [];
  const report = (value) => async (file, args) => {
    seen.push([file, args]);
    return value;
  };
  assert.deepEqual(
    await inspectNode(shim, {
      run: report(JSON.stringify({ version: "24.5.0", execPath: real })),
    }),
    { version: "24.5.0", execPath: real },
  );
  assert.equal(seen[0][0], shim, "the candidate itself is run, not a resolved copy");
  assert.equal(seen[0][1][0], "-e");
  assert.match(seen[0][1][1], /process\.versions\.node.*process\.execPath/s);
  assert.doesNotMatch(seen[0][1][1], /node:sqlite/);
  await inspectNode(shim, { sqlite: true, run: report("{}") });
  assert.match(seen[1][1][1], /require\('node:sqlite'\)/);
  for (const bad of [
    "",
    "not json",
    "null",
    "[]",
    JSON.stringify({ version: 24, execPath: real }),
    JSON.stringify({ version: "v24", execPath: real }),
    JSON.stringify({ version: "24.5.0", execPath: "relative/node" }),
    JSON.stringify({ version: "24.5.0", execPath: "\\\\server\\share\\node.exe" }),
  ])
    assert.equal(await inspectNode(shim, { run: report(bad) }), null, bad);
  const calls = seen.length;
  for (const candidate of ["relative/node", "\\\\server\\share\\node.exe", "//server/share/node"])
    assert.equal(await inspectNode(candidate, { run: report("unused") }), null, candidate);
  assert.equal(seen.length, calls, "a relative or network candidate is never executed");
  assert.equal(
    await inspectNode(shim, {
      run: async () => {
        throw new Error("exit 1");
      },
    }),
    null,
  );
});

// The owner's own settings switch mise's auto-install on; every runner must switch it off again.
const autoInstallOn = {
  MISE_AUTO_INSTALL: "true",
  MISE_EXEC_AUTO_INSTALL: "true",
  MISE_NOT_FOUND_AUTO_INSTALL: "true",
};
const autoInstallOff = Object.fromEntries(Object.keys(autoInstallOn).map((key) => [key, "false"]));
const autoInstallScript = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(autoInstallOn))}.map((key) => [key, process.env[key]]))))`;
async function withEnvironment(changes, action) {
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("probes run in a fresh empty directory, with runtime options cleared, and leave nothing behind", async () => {
  const environment = {
    NODE_OPTIONS: "--no-warnings",
    BUN_OPTIONS: "--preload=./evil.js",
    ...autoInstallOn,
  };
  await withEnvironment(environment, async () => {
    const report = await runBounded(process.execPath, [
      "-e",
      `process.stdout.write(JSON.stringify([process.cwd(), require('node:fs').readdirSync('.'), process.env.NODE_OPTIONS, process.env.BUN_OPTIONS, ${JSON.stringify(Object.keys(autoInstallOn))}.map((key) => process.env[key])]))`,
    ]);
    const [cwd, entries, nodeOptions, bunOptions, autoInstall] = JSON.parse(report);
    assert.match(basename(cwd), /^versionstead-probe-/);
    assert.equal(await realpath(dirname(cwd)), await realpath(tmpdir()));
    assert.deepEqual(entries, []);
    assert.equal(nodeOptions, "");
    assert.equal(bunOptions, "");
    assert.deepEqual(autoInstall, ["false", "false", "false"], "mise must not install for a probe");
    await assert.rejects(access(cwd), { code: "ENOENT" });
  });
});

test("development tools run with mise's auto-install off", async (t) => {
  const base = await temporary(t);
  // Node under a tool's name prints the environment that the tool would have been given.
  const gh = join(base, windows ? "gh.exe" : "gh");
  await link(process.execPath, gh).catch(() => copyFile(process.execPath, gh));
  const report = await withEnvironment({ PATH: base, ...autoInstallOn }, () =>
    runTool("gh", ["-e", autoInstallScript]),
  );
  assert.deepEqual(JSON.parse(report), autoInstallOff);
});

test("global npm and Bun discovery runs with mise's auto-install off, and asks Bun from an empty folder", async (t) => {
  const base = await temporary(t);
  const root = join(base, "global", "lib", "node_modules");
  const cli = await installNpm(base, ["node_modules"]);
  // npm's script answers only when mise's auto-install is off; otherwise its root is not a path.
  await writeFile(
    cli,
    `const off = ${JSON.stringify(Object.keys(autoInstallOn))}.every((key) => process.env[key] === "false");
const [command, , key] = process.argv.slice(2);
const answers = { root: ${JSON.stringify(root)}, registry: "https://registry.npmjs.org/", userconfig: ${JSON.stringify(join(base, "user.npmrc"))}, globalconfig: ${JSON.stringify(join(base, "global.npmrc"))} };
process.stdout.write(off ? answers[command === "root" ? "root" : key] : "auto-install is on");
`,
  );
  await executableFile(join(base, launcher));
  if (!windows) {
    // Bun answers only its identity probe, from an empty directory, with auto-install off.
    const reply = JSON.stringify({ version: "1.4.0", execPath: join(base, "real-bun") });
    await executableFile(
      join(base, "bun"),
      `#!/bin/sh\n[ "$1" = "-e" ] && [ -z "$(ls -A)" ] && [ "$MISE_NOT_FOUND_AUTO_INSTALL" = false ] || exit 1\nprintf '%s' '${reply}'\n`,
    );
  }
  const sources = await withEnvironment(
    { ...autoInstallOn, BUN_INSTALL_GLOBAL_DIR: join(base, "bun-global") },
    () => discoverGlobalToolSources(undefined, [], [base]),
  );
  const npm = sources.find((source) => source.manager === "npm");
  assert.equal(npm.status, "detected", npm.error ?? "");
  assert.equal(npm.root, root);
  if (!windows) assert.equal(sources.find((source) => source.manager === "bun").version, "1.4.0");
});

test("a plain Node process is its own runtime but Electron's binary never runs a package manager's script", () => {
  assert.equal(ownNode(), process.execPath);
  Object.defineProperty(process.versions, "electron", { value: "44.0.0", configurable: true });
  try {
    assert.equal(ownNode(), null);
  } finally {
    delete process.versions.electron;
  }
});

test("npm's script is found beside its launcher or beside the verified Node, whatever the Node is called", async (t) => {
  const base = await temporary(t);
  const beside = join(base, "beside");
  await executableFile(join(beside, launcher));
  const cli = await installNpm(beside, ["node_modules"]);
  // Fedora's nodejs24 binary is /usr/bin/node-24: the name says nothing, the verified path does.
  const renamed = join(base, "node-24");
  assert.deepEqual(await npmGlobalCommand([beside], renamed), {
    executable: renamed,
    cli,
    version: "11.7.0",
  });
  // A version-manager launcher has no npm beside it; the Node it dispatches to owns the script.
  const shims = join(base, "shims");
  await executableFile(join(shims, launcher));
  const real = join(base, "real");
  const realCli = await installNpm(real, ["lib", "node_modules"]);
  const realNode = join(real, "bin", "node-24");
  assert.deepEqual(await npmGlobalCommand([shims], realNode), {
    executable: realNode,
    cli: realCli,
    version: "11.7.0",
  });
  await writeFile(
    join(real, "lib", "node_modules", "npm", "package.json"),
    JSON.stringify({ name: "not-npm", version: "11.7.0" }),
  );
  await assert.rejects(npmGlobalCommand([shims], realNode), /could not be verified/);
  assert.equal(await npmGlobalCommand([], realNode), null);
});

test(
  "without a Node of its own, npm runs under the real path that the discovered Node reports",
  { skip: windows },
  async (t) => {
    const base = await temporary(t);
    const shims = join(base, "shims");
    const real = join(base, "real");
    const realCli = await installNpm(real, ["lib", "node_modules"]);
    const realNode = join(real, "bin", "node-24");
    await executableFile(join(shims, "npm"));
    // Stands in for a shim whose real Node lives elsewhere.
    const reply = JSON.stringify({ version: "24.5.0", execPath: realNode });
    await executableFile(join(shims, "node"), `#!/bin/sh\nprintf '%s' '${reply}'\n`);
    const previous = process.env.VERSIONSTEAD_NODE_EXECUTABLE;
    try {
      delete process.env.VERSIONSTEAD_NODE_EXECUTABLE;
      const found = await npmGlobalCommand([shims], null);
      assert.deepEqual(found, { executable: realNode, cli: realCli, version: "11.7.0" });
      process.env.VERSIONSTEAD_NODE_EXECUTABLE = join(shims, "node");
      assert.equal(await npmGlobalCommand([], null), null);
      assert.equal((await npmGlobalCommand([shims], null)).executable, realNode);
      process.env.VERSIONSTEAD_NODE_EXECUTABLE = "relative/node";
      await assert.rejects(npmGlobalCommand([shims], null), /could not be verified/);
    } finally {
      if (previous === undefined) delete process.env.VERSIONSTEAD_NODE_EXECUTABLE;
      else process.env.VERSIONSTEAD_NODE_EXECUTABLE = previous;
    }
  },
);

test("native manager discovery searches the given directories but never the project or node_modules", async (t) => {
  const root = await temporary(t);
  const base = await temporary(t);
  const node = join(base, "node-24");
  const inProject = join(root, "bin");
  await executableFile(join(inProject, launcher));
  await installNpm(inProject, ["node_modules"]);
  const inModules = join(base, "node_modules", ".bin");
  await executableFile(join(inModules, launcher));
  await installNpm(inModules, ["node_modules"]);
  const system = join(base, "system");
  await executableFile(join(system, launcher));
  const cli = await installNpm(system, ["node_modules"]);
  assert.deepEqual(await outdatedExecutable("npm", root, [inProject, inModules, system], node), {
    executable: node,
    prefix: [cli],
    version: "11.7.0",
  });
  assert.equal(await outdatedExecutable("npm", root, [inProject, inModules], node), null);
  // A shim has no npm beside it: the Node it was installed with owns the script.
  const shims = join(base, "shims");
  await executableFile(join(shims, launcher));
  const real = join(base, "real");
  const realCli = await installNpm(real, ["lib", "node_modules"]);
  assert.deepEqual(await outdatedExecutable("npm", root, [shims], join(real, "bin", "node-24")), {
    executable: join(real, "bin", "node-24"),
    prefix: [realCli],
    version: "11.7.0",
  });
  // Only npm 11 has verified output; Electron's own binary cannot run a package manager's script.
  await installNpm(real, ["lib", "node_modules"], "10.9.0");
  assert.equal(await outdatedExecutable("npm", root, [shims], join(real, "bin", "node-24")), null);
  assert.equal(await outdatedExecutable("npm", root, [system], null), null);
});

test(
  "npm and pnpm launchers are only located; their scripts run under Node, never the launcher",
  { skip: windows },
  async (t) => {
    const base = await temporary(t);
    const root = await temporary(t);
    const log = join(base, "launchers.log");
    const shims = join(base, "shims");
    // Volta reads a project's "volta" pins and may fetch what it names, so a launcher must never run.
    for (const manager of ["npm", "pnpm"])
      await executableFile(
        join(shims, manager),
        `#!/bin/sh\necho "${manager} launcher run in $(pwd -P)" >> "${log}"\nexit 1\n`,
      );
    const real = join(base, "real");
    const npmCli = await installManager(real, ["lib", "node_modules"], "npm", "11.7.0");
    const pnpmCli = await installManager(real, ["lib", "node_modules"], "pnpm", "10.14.0");
    const node = join(real, "bin", "node-24");
    assert.deepEqual(await outdatedExecutable("npm", root, [shims], node), {
      executable: node,
      prefix: [npmCli],
      version: "11.7.0",
    });
    assert.deepEqual(await outdatedExecutable("pnpm", root, [shims], node), {
      executable: node,
      prefix: [pnpmCli],
      version: "10.14.0",
    });
    await assert.rejects(access(log), { code: "ENOENT" });
  },
);

test("macOS git is not run until the developer tools exist, and that is asked only once", async () => {
  const calls = [];
  const missing = async (file, args) => {
    calls.push([file, ...args]);
    throw new Error("xcode-select: error: unable to get active developer directory");
  };
  assert.equal(await usableTool("git", "/usr/bin/git", "darwin", missing), false);
  assert.equal(await usableTool("git", "/usr/bin/git", "darwin", missing), false);
  assert.deepEqual(calls, [["/usr/bin/xcode-select", "-p"]]);
  // Only Apple's stub is gated: other Git builds, other tools and other platforms never ask.
  assert.equal(await usableTool("git", "/opt/homebrew/bin/git", "darwin", missing), true);
  assert.equal(await usableTool("ssh", "/usr/bin/ssh", "darwin", missing), true);
  assert.equal(await usableTool("git", "/usr/bin/git", "linux", missing), true);
  assert.equal(await usableTool("git", "/usr/bin/git", "win32", missing), true);
  assert.equal(calls.length, 1);
  const installed = async (file, args) => {
    calls.push([file, ...args]);
    return "/Library/Developer/CommandLineTools\n";
  };
  assert.equal(await usableTool("git", "/usr/bin/git", "darwin", installed), true);
  assert.equal(await usableTool("git", "/usr/bin/git", "darwin", installed), true);
  assert.equal(calls.length, 2);
});

test("a git found outside Apple's stub is used without asking about developer tools", async (t) => {
  const base = await temporary(t);
  await executableFile(join(base, "brew", "git"));
  const asked = [];
  const run = async (file) => {
    asked.push(file);
    throw new Error("must not be asked");
  };
  assert.equal(
    await developmentTool("git", { directories: [join(base, "brew")], platform: "darwin", run }),
    join(base, "brew", "git"),
  );
  assert.equal(await developmentTool("git", { directories: [], platform: "darwin", run }), null);
  assert.deepEqual(asked, []);
});

test("tool candidates keep PATH first and add only each tool's own locations after the shared fallbacks", () => {
  const directories = [join(tmpdir(), "first"), join(tmpdir(), "second")];
  assert.deepEqual(
    toolCandidates("git", { platform: "linux", directories }),
    directories.map((directory) => join(directory, "git")),
  );
  const tailscale = toolCandidates("tailscale", { platform: "darwin", directories });
  assert.deepEqual(
    tailscale.slice(0, 2),
    directories.map((d) => join(d, "tailscale")),
  );
  assert.equal(tailscale.at(-1), "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  assert.equal(tailscale.length, 3);
  assert.equal(toolCandidates("tailscale", { platform: "linux", directories }).length, 2);
  assert.equal(toolCandidates("git", { platform: "darwin", directories }).length, 2);
  // A relative or network directory is not a candidate, wherever it came from.
  const ok = join(tmpdir(), "ok");
  assert.deepEqual(
    toolCandidates("git", { platform: "linux", directories: ["bin", "//server/share", ok] }),
    [join(ok, "git")],
  );
});

test("Windows extra directories that are relative or network shares are dropped", () => {
  const env = { ProgramFiles: "\\\\server\\share", SystemRoot: "relative\\Windows" };
  assert.deepEqual(toolCandidates("git", { platform: "win32", directories: [], env }), []);
});

test(
  "Windows candidates keep the .exe names and the Git, GitHub CLI, Tailscale and OpenSSH directories",
  { skip: !windows },
  () => {
    const [first, ...rest] = toolCandidates("git", {
      platform: "win32",
      directories: ["C:\\first"],
    });
    assert.equal(first, "C:\\first\\git.exe");
    const programs = process.env.ProgramFiles ?? "C:\\Program Files";
    for (const suffix of [
      join(programs, "Git", "cmd", "git.exe"),
      join(programs, "GitHub CLI", "git.exe"),
      join(programs, "Tailscale", "git.exe"),
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "git.exe"),
    ])
      assert(rest.includes(suffix), suffix);
  },
);

test("Git discovery is skipped, not failed, while Git context is off, so the switch can be turned back on", async () => {
  const calls = [];
  const run = async (name) => {
    calls.push(name);
    return `${name} 1.2.3\nsecond line`;
  };
  const enabled = await discoverTools(true, run);
  assert.deepEqual(calls.sort(), ["gh", "git", "glab", "ssh", "tailscale"]);
  assert.deepEqual(enabled.git, { available: true, version: "git 1.2.3" });
  calls.length = 0;
  const disabled = await discoverTools(false, run);
  assert.deepEqual(calls.sort(), ["gh", "glab", "ssh", "tailscale"], "Git must not be executed");
  assert.equal(disabled.git.version, null);
  // Located, not executed: the interface keeps its enable switch whenever Git is installed.
  assert.equal(disabled.git.available, (await developmentTool("git")) !== null);
});
