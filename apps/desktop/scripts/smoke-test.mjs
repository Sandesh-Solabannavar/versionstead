import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readRuntime, acquireCoordinatorLock } from "@versionstead/server/runtime";
import { decodeMonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { externalAdvisoryUrl, externalApplicationUrl } from "../dist/navigation.js";
import {
  npmGlobalCommand,
  discoverGlobalToolSources,
  inspectGlobalSources,
} from "../../server/dist/adapters/inventory.js";
import { toolExecutable } from "../../server/dist/adapters/tool-paths.js";

assert.equal(
  externalAdvisoryUrl("https://osv.dev/vulnerability/GHSA-abcd-1234-wxyz"),
  "https://osv.dev/vulnerability/GHSA-abcd-1234-wxyz",
);
for (const url of [
  "http://osv.dev/vulnerability/CVE-2026-1",
  "https://osv.dev.evil.example/vulnerability/CVE-2026-1",
  "https://owner@osv.dev/vulnerability/CVE-2026-1",
  "https://osv.dev:444/vulnerability/CVE-2026-1",
  "https://osv.dev/vulnerability/CVE-2026-1?next=elsewhere",
  "https://osv.dev/vulnerability/CVE-2026-1#details",
  "https://osv.dev/vulnerability/CVE-2026-1?",
  "https://osv.dev/vulnerability/CVE-2026-1#",
  `https://osv.dev/vulnerability/${"a".repeat(151)}`,
  "https://osv.dev/vulnerability/../settings",
  "file:///C:/Windows/notepad.exe",
  "invalid",
])
  assert.equal(externalAdvisoryUrl(url), null);

const temporary = await mkdtemp(join(tmpdir(), "versionstead-desktop-smoke-"));
assert.equal(
  externalApplicationUrl(
    "https://github.com/Sandesh-Solabannavar/versionstead/releases/tag/v0.2.0",
  ),
  "https://github.com/Sandesh-Solabannavar/versionstead/releases/tag/v0.2.0",
);
for (const value of [
  "https://github.com.evil.example/Sandesh-Solabannavar/versionstead/releases/tag/v0.2.0",
  "https://github.com/other/app/releases/tag/v0.2.0",
  "https://github.com/Sandesh-Solabannavar/versionstead/releases/tag/v0.2.0?token=secret",
  "file:///C:/Windows/notepad.exe",
])
  assert.equal(externalApplicationUrl(value), null);
const dataDir = join(temporary, "coordinator");
const userDir = join(temporary, "desktop");
const appPath = fileURLToPath(new URL("../", import.meta.url));
const projectPath = fileURLToPath(new URL("../../../", import.meta.url));
let coordinator;
let fixtureGuard;

async function launch(capture = false) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./start-electron.mjs", import.meta.url)), appPath, "--smoke-test"],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          VERSIONSTEAD_DATA_DIR: dataDir,
          VERSIONSTEAD_USER_DATA: userDir,
          VERSIONSTEAD_SMOKE_SCREENSHOT_DIR: capture
            ? (process.env.VERSIONSTEAD_SMOKE_SCREENSHOT_DIR ?? "")
            : "",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Desktop smoke timed out: ${stderr || stdout || "no child output"}`));
    }, 90_000);
    child.stdout.on("data", (data) => {
      stdout = `${stdout}${data}`.slice(-64 * 1024);
    });
    child.stderr.on("data", (data) => {
      stderr = `${stderr}${data}`.slice(-64 * 1024);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      if (code !== 0) reject(new Error(`Desktop smoke exited ${code}: ${stderr}\n${stdout}`));
      else resolve(stdout);
    });
  });
  const result = output
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((item) => item?.independentCoordinator);
  assert(
    result?.connected &&
      result.nativeFolderBridge &&
      result.trayClose &&
      result.trayReopen &&
      result.nativePauseResume &&
      result.nativeDialogEscape &&
      result.nativeDialogFocusReturn &&
      result.nativePcFilters &&
      result.nativeGlobalToolManagers &&
      result.nativeScanProgress &&
      result.nativeSummaryDestination &&
      result.nativeThemeSpacing &&
      result.nativeSettings &&
      result.nativeSourceControl &&
      result.nativeProjectSources &&
      result.nativeAppearanceSync &&
      result.nativeConnectionsFlow &&
      result.nativeProjectSettings &&
      result.nativeProjectActions &&
      result.nativeKeybindings &&
      result.nativeUpdatePanel &&
      (!capture || (result.nativeGroupedProjects && result.nativeEvidenceSheet)),
    "Real renderer, native bridge, and tray lifecycle must pass",
  );
  for (const line of output.split(/\r?\n/)) {
    if (/^Desktop smoke: native (npm|bun) Update now/.test(line)) console.log(line);
    try {
      if (JSON.parse(line)?.nativeProjectTable) console.log(line);
    } catch {}
  }
}

async function request(path, init = {}) {
  assert(coordinator, "Independent coordinator descriptor must exist");
  const response = await fetch(`${coordinator.origin}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${coordinator.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `Coordinator request failed (${response.status})`);
  return response.json();
}

try {
  if (process.env.VERSIONSTEAD_SMOKE_VERIFY_GLOBAL_UPDATES === "1") {
    const npm = await npmGlobalCommand();
    const bun = await toolExecutable(process.platform === "win32" ? "bun.exe" : "bun");
    assert(npm && bun, "The optional live update check requires installed npm and Bun");
    const globalsPath = join(temporary, "globals");
    await mkdir(globalsPath);
    const globals = await realpath(globalsPath);
    // Contain Bun's ancestor lookup even if its exact global-manifest setup regresses.
    fixtureGuard = {
      path: join(globals, "package.json"),
      contents: JSON.stringify({ private: true, dependencies: {} }),
    };
    await writeFile(fixtureGuard.path, fixtureGuard.contents);
    process.env.npm_config_prefix = join(globals, "npm");
    process.env.BUN_INSTALL_GLOBAL_DIR = join(globals, "bun");
    process.env.BUN_INSTALL_BIN = join(globals, "bun-bin");
    await mkdir(process.env.BUN_INSTALL_GLOBAL_DIR);
    await writeFile(
      join(process.env.BUN_INSTALL_GLOBAL_DIR, "package.json"),
      JSON.stringify({ dependencies: {} }),
    );
    process.env.VERSIONSTEAD_SMOKE_GLOBAL_ROOT = globals;
    const run = promisify(execFile);
    const options = {
      cwd: globals,
      env: { ...process.env, NODE_OPTIONS: "" },
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    };
    await run(
      npm.executable,
      [
        npm.cli,
        "install",
        "--global",
        "--prefix",
        process.env.npm_config_prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "semver@7.0.0",
      ],
      options,
    );
    await run(bun, ["add", "--global", "--exact", "--ignore-scripts", "semver@7.0.0"], {
      ...options,
      cwd: process.env.BUN_INSTALL_GLOBAL_DIR,
    });
    assert.equal(await readFile(fixtureGuard.path, "utf8"), fixtureGuard.contents);
    const sources = await discoverGlobalToolSources();
    for (const source of sources) {
      const path = source.root ? relative(globals, source.root) : "..";
      assert(
        path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path),
        `The ${source.manager} fixture discovery must target its disposable root`,
      );
    }
    const inventory = await inspectGlobalSources(sources, undefined, undefined, async (url) =>
      Response.json({
        name: decodeURIComponent(new URL(url).pathname.slice(1)),
        versions: { "7.0.0": {} },
        "dist-tags": { latest: "7.0.0" },
      }),
    );
    assert.deepEqual(inventory.errors, []);
    assert.equal(
      inventory.installations.filter((i) => i.name === "semver").length,
      2,
      "Both global fixtures must be collected before UI launch",
    );
    console.log("Desktop smoke: isolated npm/Bun update fixtures installed");
  }
  await launch();
  console.log("Desktop smoke: first launch and close-to-tray passed");
  coordinator = await readRuntime(dataDir);
  assert(coordinator, "Coordinator must remain running after Electron quits");
  const initial = decodeMonitoringSnapshot(await request("/api/monitoring"));
  assert.equal(initial.runtime.host, "session");
  const project = await request("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: projectPath, mode: "maintained" }),
  });
  assert(project, "Native-selected project API must accept the real Versionstead directory");
  await request("/api/scans", { method: "POST", body: JSON.stringify({ target: "all" }) });
  console.log("Desktop smoke: reading actual PC and selected-project evidence");
  const deadline = Date.now() + 120_000;
  let evidence;
  while (Date.now() < deadline) {
    evidence = decodeMonitoringSnapshot(await request("/api/monitoring"));
    if (
      evidence.inventory.evidence.lastAttempt &&
      evidence.projects[0]?.evidence.lastAttempt &&
      !evidence.history.some((scan) => scan.status === "scanning")
    )
      break;
    await delay(500);
  }
  assert(evidence?.inventory.evidence.lastAttempt, "PC scan must record a real attempt");
  assert.equal(evidence.inventory.collector, "npm-bun-global-v1");
  assert.deepEqual(evidence.inventory.managers.map((item) => item.manager).sort(), ["bun", "npm"]);
  assert(
    evidence.inventory.installations.every(
      (item) => item.manager === "npm" || item.manager === "bun",
    ),
    "PC scan must contain only npm and Bun global tools",
  );
  assert(
    evidence?.projects[0]?.evidence.lastAttempt,
    "Selected project scan must record a real attempt",
  );
  assert(
    !evidence.history.some((scan) => scan.status === "scanning"),
    "Real scan attempts must finish before the smoke deadline",
  );
  console.log("Desktop smoke: real scan attempts completed; checking existing coordinator attach");
  await launch(true);
  const attached = await readRuntime(dataDir);
  assert.equal(
    attached?.pid,
    coordinator.pid,
    "Repeated desktop launch must attach to the same coordinator",
  );
  const retained = decodeMonitoringSnapshot(await request("/api/monitoring"));
  assert.equal(retained.projects.length, 1, "Selected project must survive UI restart");
  console.log(
    JSON.stringify({
      desktopSmoke: "passed",
      trayClose: true,
      trayReopen: true,
      inheritedEnvironment: true,
      independentCoordinator: true,
      existingCoordinatorAttach: true,
      realPcScan: true,
      realProjectScan: true,
      nativePauseResume: true,
      nativeDialogEscape: true,
      nativeDialogFocusReturn: true,
      advisoryLinkValidation: true,
      nativePcFilters: true,
      nativeGlobalToolManagers: true,
      nativeScanProgress: true,
      nativeSummaryDestination: true,
      nativeThemeSpacing: true,
      nativeGroupedProjects: true,
      nativeEvidenceSheet: true,
      nativeSettings: true,
      nativeSourceControl: true,
      nativeProjectSources: true,
      nativeAppearanceSync: true,
      nativeConnectionsFlow: true,
      nativeProjectSettings: true,
      nativeProjectActions: true,
      nativeKeybindings: true,
      nativeUpdatePanel: true,
    }),
  );
} finally {
  // This capability belongs only to the new temporary profile; never stop the owner's coordinator.
  coordinator ??= await readRuntime(dataDir);
  if (coordinator) {
    await request("/api/shutdown", { method: "POST", body: "{}" }).catch(() => {});
    for (let attempt = 0; attempt < 50 && (await readRuntime(dataDir)); attempt++) await delay(200);
  }
  if (await readRuntime(dataDir)) {
    console.error("Temporary coordinator cleanup failed; its isolated data was retained");
    process.exitCode = 1;
  } else {
    let unlocked = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const release = acquireCoordinatorLock(dataDir);
        release();
        unlocked = true;
        break;
      } catch {
        await delay(100);
      }
    }
    assert(temporary.startsWith(join(tmpdir(), "versionstead-desktop-smoke-")));
    if (unlocked) {
      if (fixtureGuard)
        assert.equal(await readFile(fixtureGuard.path, "utf8"), fixtureGuard.contents);
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
      console.error("Temporary coordinator still owns its database; isolated data retained");
      process.exitCode = 1;
    }
  }
}
