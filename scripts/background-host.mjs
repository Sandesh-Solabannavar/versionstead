#!/usr/bin/env node
// Installs and operates the macOS LaunchAgent or Linux systemd user service that hosts the Versionstead
// coordinator. From the repository root, with Node.js 24, after `pnpm build`:
//   node scripts/background-host.mjs <install|start|stop|restart|status|uninstall> [--linger] [--data-dir ABSOLUTE]
// On Windows use scripts/windows-background.ps1.
import { homedir, userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const workspace = resolve(fileURLToPath(new URL("..", import.meta.url)));
const actions = ["install", "start", "stop", "restart", "status", "uninstall"];
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { linger: { type: "boolean", default: false }, "data-dir": { type: "string" } },
  });
} catch {
  parsed = { positionals: [], values: {} };
}
const [action] = parsed.positionals;
if (parsed.positionals.length !== 1 || !actions.includes(action)) {
  console.error(
    `Usage: node scripts/background-host.mjs <${actions.join("|")}> [--linger] [--data-dir ABSOLUTE]`,
  );
  process.exit(2);
}
const explicit = parsed.values["data-dir"];
if (explicit !== undefined && !isAbsolute(explicit)) {
  console.error("--data-dir must be an absolute path.");
  process.exit(2);
}
// The service runs this same Node executable, so it must be the Node 24 the coordinator requires.
if (process.versions.node.split(".")[0] !== "24") {
  console.error(
    "Run this script with Node.js 24; the background host uses the same Node executable.",
  );
  process.exit(1);
}
let host;
let runtime;
try {
  await import("node:sqlite");
  host = await import(
    pathToFileURL(resolve(workspace, "apps/server/dist/adapters/background-host.js")).href
  );
  runtime = await import(pathToFileURL(resolve(workspace, "apps/server/dist/runtime.js")).href);
} catch {
  console.error(
    "Build Versionstead first with pnpm build, and use a Node.js 24 with SQLite support.",
  );
  process.exit(1);
}
// Install pins a data directory: --data-dir, else the one this environment resolves. Every other action
// works on the installed one, ignoring VERSIONSTEAD_DATA_DIR and the default, and is given a data
// directory only when --data-dir names one to check against it.
let dataDir = explicit === undefined ? undefined : resolve(explicit);
if (action === "install" && dataDir === undefined) {
  try {
    dataDir = runtime.resolveDataDir();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "The data directory could not be resolved.",
    );
    process.exit(1);
  }
}
try {
  await host.runBackgroundHost(action, {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    user: userInfo().username,
    node: process.execPath,
    workspace,
    dataDir,
    linger: parsed.values.linger === true,
    run: host.runCommand,
    out: (line) => console.log(line),
  });
} catch (error) {
  console.error(
    error instanceof host.HostError
      ? error.message
      : "The background host action failed. Run status for details.",
  );
  process.exitCode = 1;
}
