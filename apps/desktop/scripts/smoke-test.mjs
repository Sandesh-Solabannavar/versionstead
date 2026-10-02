import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readRuntime } from "@versionstead/server/runtime";
import { decodeMonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { externalAdvisoryUrl } from "../dist/navigation.js";

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
const dataDir = join(temporary, "coordinator");
const userDir = join(temporary, "desktop");
const appPath = fileURLToPath(new URL("../", import.meta.url));
const projectPath = fileURLToPath(new URL("../../../", import.meta.url));
let coordinator;

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
      (!capture || (result.nativeGroupedProjects && result.nativeEvidenceSheet)),
    "Real renderer, native bridge, and tray lifecycle must pass",
  );
  for (const line of output.split(/\r?\n/)) {
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
  } else await rm(temporary, { recursive: true, force: true });
}
