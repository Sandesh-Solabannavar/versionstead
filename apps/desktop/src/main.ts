import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  session,
  screen,
  shell,
  Tray,
} from "electron";
import { fileURLToPath } from "node:url";
import { stat, realpath, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  coordinatorRequest,
  ensureCoordinator,
  forwardRequest,
  pollCoordinator,
  readyCoordinator,
  recoverCoordinator,
  restartCoordinator,
  webRoot,
  type CoordinatorPoll,
  type CoordinatorRuntime,
} from "./coordinator.js";
import { readWebFile, responseHeaders } from "../../server/dist/web-files.js";
import { externalApplicationUrl } from "./navigation.js";
import { decodeAcceptedResponse } from "@versionstead/contracts/monitoring";
import {
  decodeActionRequest,
  decodeRunActionRequest,
  decodeActionRun,
  decodeActionShell,
} from "@versionstead/contracts/project-settings";
import { ProjectActionRunner, projectActionShell } from "./project-actions.js";
import {
  decodeGlobalToolUpdateRequest,
  decodeGlobalToolUpdateRun,
  decodeGlobalToolUpdateRuns,
} from "@versionstead/contracts/global-tool-updates";
import { GlobalToolUpdateRunner, globalToolUpdateDependencies } from "./global-tool-updates.js";
import {
  decodeWindowTheme,
  decodeWindowPreferences,
  type WindowPreferences,
} from "@versionstead/contracts/desktop";
import {
  applicationMenu,
  defaultWindowPreferences,
  initialWindowBounds,
  loadWindowPreferences,
  saveWindowPreferences,
  titleBarOptions,
} from "./window.js";

const smoke = process.argv.includes("--smoke-test");
let runtime: CoordinatorRuntime | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
// Set once the protocol handler and first window exist.
let started = false;
let monitoringStopped = false;
let quitting = false;
let polling = false;
// The last good tray poll; the full snapshot is read again only when its revision changes.
let lastPoll: CoordinatorPoll | null = null;
let notificationTimer: ReturnType<typeof setInterval> | undefined;
const presented = new Set<string>();
const pendingReceipts = new Set<string>();
// Pages and assets the window asked for, kept only for the smoke check.
const requestedFiles = new Set<string>();
const notifications = new Map<string, Notification>();
const projectActionRunner = new ProjectActionRunner();
const globalToolUpdateRunner = new GlobalToolUpdateRunner({
  ...globalToolUpdateDependencies,
  refresh: async () => {
    const connected = await readyCoordinator();
    if (!connected) throw new Error("Monitoring is unavailable.");
    const response = await coordinatorRequest(connected.runtime, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ target: "pc" }),
    });
    if (!response.ok) throw new Error("The PC rescan could not start.");
    decodeAcceptedResponse(await response.json());
  },
});
let closingActions = false;
let notificationRuntimePid: number | null = null;
let windowPreferences: WindowPreferences = defaultWindowPreferences;
let preferencesWrite: Promise<void> = Promise.resolve();
let preferencesTimer: ReturnType<typeof setTimeout> | undefined;

function captureWindowPreferences() {
  if (!window || window.isDestroyed()) return;
  try {
    windowPreferences = decodeWindowPreferences({
      ...windowPreferences,
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    });
  } catch {
    /* Ignore transient/undersized geometry, including the narrow smoke viewport. */
  }
}
function persistWindowPreferences() {
  const value = windowPreferences;
  preferencesWrite = preferencesWrite
    .catch(() => {})
    .then(() => saveWindowPreferences(app.getPath("userData"), value));
  return preferencesWrite;
}
function scheduleWindowPreferences() {
  if (preferencesTimer) clearTimeout(preferencesTimer);
  preferencesTimer = setTimeout(() => {
    captureWindowPreferences();
    void persistWindowPreferences().catch(() =>
      console.error("Window preferences could not be saved."),
    );
  }, 250);
}
function syncWindowAppearance() {
  if (!window || window.isDestroyed()) return;
  window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#0c0c0c" : "#f8f8fa");
  const overlay = titleBarOptions(nativeTheme.shouldUseDarkColors).titleBarOverlay;
  if (overlay && typeof overlay === "object") window.setTitleBarOverlay(overlay);
}

app.setName("Versionstead");
app.setAppUserModelId("Versionstead.Desktop");
if (process.env.VERSIONSTEAD_USER_DATA) app.setPath("userData", process.env.VERSIONSTEAD_USER_DATA);
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "versionstead",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

function trustedLocation(value: string) {
  try {
    const target = new URL(value);
    return target.protocol === "versionstead:" && target.host === "app";
  } catch {
    return false;
  }
}

async function showWindow(path = "/") {
  // During startup the first window is about to appear; never load early or create a second one.
  if (!started) return;
  if (!window || window.isDestroyed()) await createWindow();
  if (!window) return;
  if (path !== "/") await window.loadURL(`versionstead://app${path}`);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function createWindow() {
  window = new BrowserWindow({
    ...initialWindowBounds(
      windowPreferences,
      screen.getAllDisplays().map((display) => display.workArea),
    ),
    ...titleBarOptions(nativeTheme.shouldUseDarkColors),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c0c0c" : "#f8f8fa",
    minWidth: 680,
    minHeight: 520,
    title: "Versionstead",
    icon: trayIcon(),
    show: !smoke,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: !smoke,
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
    },
  });
  if (windowPreferences.maximized) window.maximize();
  window.on("move", scheduleWindowPreferences);
  window.on("resize", scheduleWindowPreferences);
  window.on("maximize", scheduleWindowPreferences);
  window.on("unmaximize", scheduleWindowPreferences);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const destination = externalApplicationUrl(url);
    if (destination && window && trustedLocation(window.webContents.getURL())) {
      void shell.openExternal(destination).catch(() => {
        dialog.showErrorBox(
          "Versionstead",
          "The link could not open. Check your default browser and retry.",
        );
      });
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!trustedLocation(url)) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on("closed", () => {
    window = null;
  });
  await window.loadURL("versionstead://app/");
}

function trayIcon() {
  // A small native bitmap avoids an asset pipeline while keeping the tray icon visible on Windows.
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 3; y < 29; y++) {
    for (let x = 3; x < 29; x++) {
      const index = (y * 32 + x) * 4;
      const letter =
        y >= 9 &&
        y <= 23 &&
        (Math.abs(x - (9 + (y - 9) * 0.5)) < 2 || Math.abs(x - (23 - (y - 9) * 0.5)) < 2);
      const cornerX = x < 9 ? 9 - x : x > 22 ? x - 22 : 0;
      const cornerY = y < 9 ? 9 - y : y > 22 ? y - 22 : 0;
      if (cornerX * cornerX + cornerY * cornerY > 36) continue;
      // Electron's native Windows bitmap uses BGRA byte order.
      pixels[index] = letter ? 255 : 245;
      pixels[index + 1] = letter ? 255 : 104;
      pixels[index + 2] = letter ? 255 : 48;
      pixels[index + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, {
    width: 32,
    height: 32,
    // macOS shows the 32 px bitmap at 2x: the 16 pt menu-bar size.
    scaleFactor: process.platform === "darwin" ? 2 : 1,
  });
}

// A failed page load (for example one superseded by another navigation) never quits the tray UI.
function reopenFailed() {
  console.error("The Versionstead window could not finish loading.");
  void showWindow().catch(() => console.error("The Versionstead window could not be shown."));
}

async function updateTray() {
  // Only a running project command needs the project actions, which take a snapshot read.
  const reconcile = projectActionRunner.active;
  const connected = await pollCoordinator(lastPoll, reconcile);
  if (connected) {
    lastPoll = connected;
    if (reconcile && connected.projects) await projectActionRunner.reconcile(connected.projects);
  } else
    void recoverCoordinator(monitoringStopped)
      .then((recovered) => recovered && updateTray())
      .catch(() => console.error("Monitoring stopped unexpectedly and could not restart."));
  runtime = connected?.runtime ?? null;
  const paused = connected?.settings.paused ?? false;
  tray?.setToolTip(
    `Versionstead — ${connected ? (paused ? "scans paused" : "monitoring") : "coordinator disconnected"}`,
  );
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Versionstead",
        click: () => {
          void showWindow().catch(reopenFailed);
        },
      },
      {
        label: "Scan now",
        enabled: Boolean(runtime),
        click: () => {
          void action("/api/scans", "POST", { target: "all" });
        },
      },
      {
        label: paused ? "Resume scans" : "Pause scans",
        enabled: Boolean(runtime),
        click: () => {
          void action("/api/settings", "PATCH", { paused: !paused });
        },
      },
      { type: "separator" },
      {
        label: "Start monitoring",
        enabled: !runtime,
        click: () => {
          monitoringStopped = false;
          void ensureCoordinator()
            .then(() => updateTray())
            .catch(() => {
              dialog.showErrorBox(
                "Versionstead",
                "Monitoring could not start. Check Node.js 24 and the background host status, then retry. Saved evidence is retained.",
              );
            });
        },
      },
      {
        label: "Restart monitoring",
        enabled: runtime?.host === "session" && runtime.mode === "interactive",
        click: () => {
          monitoringStopped = false;
          void restartCoordinator()
            .then(() => updateTray())
            .catch(() => {
              dialog.showErrorBox(
                "Versionstead",
                "Monitoring could not restart. Check Node.js 24 and the background host status, then retry. Saved evidence is retained.",
              );
            });
        },
      },
      {
        label: "Stop monitoring",
        enabled: Boolean(runtime),
        click: () => {
          void stopMonitoring();
        },
      },
      { label: "Quit Versionstead UI", click: () => app.quit() },
    ]),
  );
  return connected;
}

async function action(path: string, method: string, body?: unknown) {
  try {
    if (!runtime) throw new Error("Coordinator disconnected");
    const response = await coordinatorRequest(runtime, path, {
      method,
      ...(body === undefined
        ? method === "POST"
          ? { body: "{}" }
          : {}
        : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error("Coordinator rejected the action");
    await updateTray();
  } catch {
    dialog.showErrorBox(
      "Versionstead",
      "The action could not be completed. Open Background monitoring to inspect the current connection and retry.",
    );
  }
}

async function stopMonitoring() {
  if (!runtime) return;
  const result = await dialog.showMessageBox({
    type: "question",
    buttons: ["Keep monitoring", "Stop monitoring"],
    defaultId: 0,
    cancelId: 0,
    title: "Stop background monitoring?",
    message:
      "This stops the coordinator. Closing or quitting the interface normally keeps monitoring running.",
    detail:
      runtime.host === "boot-task"
        ? "Windows startup registration stays installed; the task can start again at the next boot."
        : "Use Start monitoring to resume.",
  });
  if (result.response === 1) {
    monitoringStopped = true;
    await action("/api/shutdown", "POST");
  }
}

async function pollNotifications() {
  if (polling || quitting) return;
  polling = true;
  try {
    const connected = await updateTray();
    if (!connected || smoke || !Notification.isSupported()) return;
    if (notificationRuntimePid !== connected.runtime.pid) {
      presented.clear();
      pendingReceipts.clear();
      notifications.clear();
      notificationRuntimePid = connected.runtime.pid;
    }
    for (const id of pendingReceipts) await acknowledgeSummary(connected.runtime, id);
    if (!connected.settings.notifyNewFindings) return;
    const summary = connected.notificationSummary;
    if (!summary || presented.has(summary.id) || notifications.has(summary.id)) return;
    notifications.clear();
    const notification = new Notification({
      id: "versionstead-summary",
      groupId: "monitoring",
      title: summary.title,
      body: summary.body,
      icon: trayIcon(),
      silent: true,
    });
    notifications.set(summary.id, notification);
    notification.once("show", () => {
      if (window && !window.isDestroyed() && trustedLocation(window.webContents.getURL()))
        window.webContents.send("versionstead:notification-summary", summary);
      presented.add(summary.id);
      pendingReceipts.add(summary.id);
      if (presented.size > 200) presented.delete(presented.values().next().value!);
      void acknowledgeSummary(connected.runtime, summary.id).catch(() => {});
    });
    notification.once("failed", () => notifications.delete(summary.id));
    notification.once("close", () => notifications.delete(summary.id));
    notification.once("click", () => {
      void showWindow(`/?filter=${summary.filter}`).catch(reopenFailed);
    });
    notification.show();
  } catch {
    // Retain pending notifications and cached renderer evidence through disconnections.
  } finally {
    polling = false;
  }
}

async function acknowledgeSummary(coordinator: CoordinatorRuntime, id: string) {
  const response = await coordinatorRequest(coordinator, "/api/notifications/summary/ack", {
    method: "POST",
    body: JSON.stringify({ summaryId: id }),
  });
  if (!response.ok) {
    // A resolved summary or restarted coordinator no longer needs a retry.
    if (response.status === 400) pendingReceipts.delete(id);
    else throw new Error("Notification receipt could not be saved");
    return;
  }
  decodeAcceptedResponse(await response.json());
  pendingReceipts.delete(id);
}

async function runSmoke() {
  if (!window || !runtime || !tray || tray.isDestroyed())
    throw new Error("Desktop initialization incomplete");
  const menuRoles = (Menu.getApplicationMenu()?.items ?? []).flatMap((item) => [
    item.role?.toLowerCase(),
    ...(item.submenu?.items ?? []).map((child) => child.role?.toLowerCase()),
  ]);
  if (
    !["copy", "paste", "resetzoom", "zoomin", "zoomout", "close"].every((role) =>
      menuRoles.includes(role),
    ) ||
    (process.env.VERSIONSTEAD_DEVTOOLS !== "1" &&
      menuRoles.some((role) => ["reload", "forcereload", "toggledevtools"].includes(role ?? "")))
  )
    throw new Error(
      "The application menu must keep editing, zoom and close, not reload or devtools",
    );
  const result: unknown = await window.webContents
    .executeJavaScript(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Monitoring UI did not connect')); }, 20000);
    const check = () => {
      const status = document.querySelector('[data-testid="connection-state"]');
      if (status?.getAttribute('data-state') === 'online') {
        clearTimeout(timer); observer.disconnect(); resolve({ title: document.title, connected: true, nativeFolderBridge: typeof window.versionstead?.selectProjectDirectory === 'function' });
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, attributes: true, childList: true }); check();
  })`);
  const rendererWrite: unknown = await window.webContents
    .executeJavaScript(`fetch('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifyNewFindings: false })
  }).then(response => response.ok)`);
  if (rendererWrite !== true) throw new Error("Authenticated renderer mutation failed");
  // The native protocol passes the renderer's revision tag through and the coordinator's 304 back.
  const revalidated: unknown = await window.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const fresh = await fetch('/api/monitoring');
      const tag = fresh.headers.get('ETag');
      if (fresh.status !== 200 || !tag) return 'GET answered ' + fresh.status;
      const cached = await fetch('/api/monitoring', { headers: { 'If-None-Match': tag } });
      if (cached.status === 304) return true;
      if (cached.status !== 200) return 'the conditional GET answered ' + cached.status;
      await new Promise(resolve => setTimeout(resolve, 200)); // The revision moved on; ask again.
    }
    return 'the revision kept changing';
  })()`);
  if (revalidated !== true)
    throw new Error(
      `A conditional request must return 304 through the protocol: ${String(revalidated)}`,
    );
  // Settings and paired-PC pages are fetched once the shell has rendered, before any visit to them.
  // (Custom-scheme requests make no resource timing entries, so the protocol handler's log is read.)
  const settingsDeadline = Date.now() + 10_000;
  while (![...requestedFiles].some((path) => /^\/assets\/settings-[\w-]+\.js$/.test(path))) {
    if (Date.now() > settingsDeadline)
      throw new Error(
        `The settings chunk must load once the shell has rendered: ${[...requestedFiles].join(", ")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const currentBuild: unknown = await window.webContents.executeJavaScript(
    "!document.body.textContent.includes('Monitoring is running an older build')",
  );
  if (currentBuild !== true)
    throw new Error("The current coordinator must not display a legacy-build warning");
  const clickButton = async (label: string, click = true) => {
    if (!window) throw new Error("Smoke window unavailable");
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const check = () => {
        const button = [...document.querySelectorAll('button')].find(button => (button.textContent?.includes(${JSON.stringify(label)}) || button.getAttribute('aria-label')===${JSON.stringify(label)}) && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
        if (button) { ${click ? "button.focus(); button.click();" : ""} resolve(true); }
        else if (Date.now() > deadline) reject(new Error('Native smoke action unavailable: ' + ${JSON.stringify(label)}));
        else setTimeout(check, 100);
      }; check();
    })`);
  };
  const initialPc = (await readyCoordinator())?.snapshot.inventory;
  // Large tables render 200 rows at a time.
  const firstPage = (count = 0) => Math.min(count, 200);
  const selectOption = async (label: string, option: string) => {
    if (!window) throw new Error("Smoke window unavailable");
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const trigger = document.querySelector('button[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
      if (!trigger) return reject(new Error('Native select unavailable'));
      trigger.click();
      const deadline = Date.now() + 5000;
      const choose = () => {
        const popups = [...document.querySelectorAll('[data-slot="select-popup"]')].filter(popup => !popup.hasAttribute('data-ending-style') && !popup.hasAttribute('data-closed') && popup.getClientRects().length && getComputedStyle(popup).visibility !== 'hidden');
        const item = popups.flatMap(popup => [...popup.querySelectorAll('[role="option"]')]).find(item => item.textContent.trim() === ${JSON.stringify(option)});
        if (item) { item.click(); setTimeout(resolve, 100); }
        else if (Date.now() > deadline) reject(new Error('Native select option unavailable'));
        else setTimeout(choose, 50);
      }; choose();
    })`);
  };
  // Headings read as an outline: the page starts at h1 and no level is skipped, sheets included.
  const expectOutline = async (where: string) => {
    if (!window) throw new Error("Smoke window unavailable");
    const problems = (await window.webContents.executeJavaScript(`(() => {
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h => !h.closest('[data-slot="toast-viewport"]'));
      const levels = headings.map(h => Number(h.tagName[1]));
      return levels.flatMap((level, i) => i === 0
        ? (level === 1 ? [] : ['the first heading is h' + level])
        : (level > levels[i - 1] + 1 ? ['h' + levels[i - 1] + ' jumps to h' + level + ' at "' + headings[i].textContent.trim().slice(0, 40) + '"'] : []));
    })()`)) as string[];
    if (problems.length > 0) throw new Error(`Heading levels on ${where}: ${problems.join("; ")}`);
  };
  await window.loadURL("versionstead://app/pc");
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const check = () => {
      if (document.querySelector('[data-testid="connection-state"]')?.getAttribute('data-state') === 'online') resolve(true);
      else if (Date.now() > deadline) reject(new Error('PC view did not connect'));
      else setTimeout(check, 100);
    }; check();
  })`);
  // A page load is not a route change: it names the page but leaves focus where it is.
  const loaded: unknown = await window.webContents.executeJavaScript(
    "document.title==='This PC · Versionstead' && document.activeElement?.id!=='content'",
  );
  if (loaded !== true) throw new Error("A page load must set the title and leave focus alone");
  // The scan status is in the page before any scan, so its first message is announced as a change.
  const statusRegions: unknown = await window.webContents.executeJavaScript(
    'document.querySelectorAll(\'[data-testid="scan-progress"] [role="status"]\').length',
  );
  if (statusRegions !== 1)
    throw new Error("Scan progress must keep exactly one status region, even before a scan");
  if (initialPc?.evidence.lastAttempt === null) {
    const empty: unknown = await window.webContents.executeJavaScript(`(() => {
      return document.body.textContent.includes('Scan this PC to check your global tools') && !document.querySelector('tbody tr') && !document.body.textContent.includes('Not checked');
    })()`);
    if (empty !== true) throw new Error("First PC view must invite an explicit scan");
    await clickButton("Scan this PC");
  } else {
    const defaultFilter: unknown = await window.webContents.executeJavaScript(`(() => {
      const filter = document.querySelector('button[aria-label="Global tool update filter"]');
      return { filter: filter?.textContent.trim(), rows: document.querySelectorAll('tbody tr').length };
    })()`);
    const defaults = defaultFilter as { filter?: string; rows: number };
    if (
      defaults.filter !== "Updates available" ||
      defaults.rows !==
        firstPage(
          initialPc?.installations.filter((item) => item.updateStatus === "available").length,
        )
    )
      throw new Error("This PC must default to confirmed update rows");
    await selectOption("Global tool update filter", "All global tools");
    const allRows: unknown = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('tbody tr')].map(row => ({ available: row.cells[2].textContent.trim(), check: row.cells[4].textContent.trim() }))
    `);
    const observations = allRows as { available: string; check: string }[];
    if (!initialPc || observations.length !== firstPage(initialPc.installations.length))
      throw new Error("All global tools filter must retain every installation");
    initialPc.installations.forEach((item, index) => {
      if (item.updateStatus === "unknown" && !item.availableVersion) {
        if (observations[index]?.available || observations[index]?.check)
          throw new Error("Unverified update cells must remain blank");
      }
    });
    await selectOption("Global package manager", "Bun");
    const managerState: unknown = await window.webContents.executeJavaScript(`(() => {
      const managers = document.querySelector('section[aria-label="Global package managers"]');
      return { managerCards: managers?.querySelectorAll('h2').length, rows: document.querySelectorAll('tbody tr').length, text: managers?.textContent };
    })()`);
    const managerView = managerState as {
      managerCards: number;
      rows: number;
      text: string;
    };
    if (
      managerView.managerCards !== initialPc.managers?.length ||
      managerView.rows !==
        firstPage(initialPc.installations.filter((item) => item.manager === "bun").length)
    )
      throw new Error("Native manager status and Bun filter must reflect actual inventory");
    for (const manager of initialPc.managers ?? []) {
      const label =
        manager.status === "detected"
          ? "Detected"
          : manager.status === "not-installed"
            ? "Not installed"
            : "Unavailable";
      if (!managerView.text.includes(label))
        throw new Error("Native package manager detection must show its actual state");
    }
    await selectOption("Global package manager", "npm and Bun");
    await selectOption("Global tool update filter", "Updates available");
    await clickButton("Scan now");
  }
  const progress: unknown = await window.webContents
    .executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const check = () => {
      const meter = document.querySelector('[data-testid="scan-progress"] progress');
      if (meter) resolve({ label: meter.getAttribute('aria-label'), value: meter.getAttribute('value'), max: meter.getAttribute('max') });
      else if (Date.now() > deadline) reject(new Error('Real PC scan did not render progress'));
      else setTimeout(check, 50);
    }; check();
  })`);
  const meter = progress as {
    label: string;
    value: string | null;
    max: string | null;
  };
  if (
    !meter.label ||
    (meter.value !== null && (!meter.max || Number(meter.value) > Number(meter.max)))
  )
    throw new Error("Scan progress must be labeled and use bounded real counts");
  await expectOutline("This PC");
  if (process.env.VERSIONSTEAD_SMOKE_GLOBAL_ROOT) {
    // Only the smoke harness's two disposable roots may be updated by this test.
    const base = await realpath(process.env.VERSIONSTEAD_SMOKE_GLOBAL_ROOT);
    const waitForPc = async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const connected = await readyCoordinator();
        if (
          connected &&
          connected.snapshot.inventory.evidence.status !== "scanning" &&
          !connected.snapshot.scanProgress?.queued.some((target) => target.kind === "pc")
        )
          return connected;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Fixture PC scan did not finish");
    };
    await waitForPc();
    for (const manager of ["npm", "bun"] as const) {
      const connected = await readyCoordinator();
      const source = connected?.snapshot.inventory.managers?.find((s) => s.manager === manager);
      const path = source?.root ? relative(base, source.root) : "..";
      if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
        throw new Error(
          `Live ${manager} update fixture is outside its disposable directory or unavailable (${source?.status}, root present: ${Boolean(source?.root)}): ${source?.error ?? "no source error"}`,
        );
      const item = connected?.snapshot.inventory.installations.find(
        (i) => i.name === "semver" && i.manager === manager,
      );
      if (!item) throw new Error("Live update fixture was not collected");
      if (item.version !== "7.0.0") {
        if (item.updateStatus === "current") continue;
        throw new Error("Unexpected live update fixture version");
      }
      await window.loadURL("versionstead://app/pc");
      await clickButton("Update now semver", false);
      await selectOption("Global package manager", manager === "npm" ? "npm" : "Bun");
      await clickButton("Update now semver");
      const deadline = Date.now() + 30000;
      let succeeded = false;
      while (Date.now() < deadline) {
        const run = globalToolUpdateRunner
          .read()
          .find((r) => r.rootId === item.rootId && r.name === item.name);
        if (run?.status === "failed")
          throw new Error(`Live ${manager} fixture update failed: ${run.message}`);
        if (run?.status === "succeeded" && !globalToolUpdateRunner.active) {
          succeeded = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!succeeded) throw new Error("Native Update now did not finish");
      const refreshed = await waitForPc();
      const updated = refreshed.snapshot.inventory.installations.find(
        (i) => i.name === "semver" && i.manager === manager,
      );
      if (updated?.version !== item.availableVersion || updated.updateStatus !== "current")
        throw new Error("The update did not refresh installed PC evidence");
      const staleRejected: unknown = await window.webContents.executeJavaScript(
        `window.versionstead.updateGlobalTool(${JSON.stringify({ installationId: item.id, expectedVersion: item.version, targetVersion: item.availableVersion })}).then(() => false, () => true)`,
      );
      if (staleRejected !== true) throw new Error("A stale native update request was accepted");
      console.log(
        `Desktop smoke: native ${manager} Update now installed and verified ${item.availableVersion} in a disposable root`,
      );
    }
  }
  await window.loadURL("versionstead://app/?filter=updates");
  const notificationFilter: unknown = await window.webContents
    .executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const check = () => {
      const tab = [...document.querySelectorAll('button[aria-pressed="true"]')].find(button => button.textContent?.includes('Updates'));
      if (tab) resolve(true);
      else if (Date.now() > deadline) reject(new Error('Notification destination did not select Updates: ' + JSON.stringify({ heading: document.querySelector('h1')?.textContent, connection: document.querySelector('[data-testid="connection-state"]')?.getAttribute('data-state'), filters: [...document.querySelectorAll('.tabs button')].map(button => ({ label: button.textContent, pressed: button.getAttribute('aria-pressed') })) })));
      else setTimeout(check, 100);
    }; check();
  })`);
  if (notificationFilter !== true) throw new Error("Summary click route must filter updates");
  await window.loadURL("versionstead://app/service");
  await clickButton("Pause schedules", false);
  await expectOutline("Background service");
  for (const [label, paused] of [
    ["Pause schedules", true],
    ["Resume schedules", false],
  ] as const) {
    await clickButton(label);
    const deadline = Date.now() + 15_000;
    let changed = false;
    while (Date.now() < deadline) {
      const connected = await readyCoordinator();
      if (connected?.snapshot.settings.paused === paused) {
        changed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!changed) throw new Error("Native schedule action did not update coordinator state");
    await clickButton(paused ? "Resume schedules" : "Pause schedules", false);
  }
  await window.loadURL("versionstead://app/projects");
  await showWindow();
  await clickButton("Add project");
  const centered: unknown = await window.webContents
    .executeJavaScript(`new Promise(resolve => setTimeout(() => {
    const dialog = document.querySelector('.form-dialog[open]');
    const rect = dialog?.getBoundingClientRect();
    resolve(Boolean(rect && Math.abs(rect.x + rect.width / 2 - innerWidth / 2) <= 1 && Math.abs(rect.y + rect.height / 2 - innerHeight / 2) <= 1));
  }, 100))`);
  if (centered !== true) throw new Error("Native Add Project dialog is not centered");
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  const focusReturned: unknown = await window.webContents
    .executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (!document.querySelector('.form-dialog[open]')) resolve(document.activeElement?.textContent?.includes('Add project') === true);
      else if (Date.now() > deadline) reject(new Error('Native Escape did not close the dialog'));
      else setTimeout(check, 100);
    }; check();
  })`);
  if (focusReturned !== true)
    throw new Error("Closing Add Project did not restore focus to its trigger");
  const waitSettings = async (expression: string) => {
    if (!window) throw new Error("Smoke window unavailable");
    await window.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const deadline=Date.now()+20000;const check=()=>{if(${expression})resolve(true);else if(Date.now()>deadline)reject(new Error('Native settings did not become available: ' + ${JSON.stringify(expression)} + ' ' + JSON.stringify({alerts:[...document.querySelectorAll('[role="alert"]')].map(e=>e.textContent),projectName:document.querySelector('[aria-label="Project name"]')?.value,disabled:document.querySelector('[aria-label="Project name"]')?.disabled,active:document.activeElement?.id,collapsed:document.querySelector('.app-shell')?.dataset.sidebarCollapsed,key:window.__smokeKey})));else setTimeout(check,100);};check();})`,
    );
  };
  await clickButton("Add project");
  await waitSettings(
    "document.querySelector('dialog[open] input[aria-label=\"Search project sources\"]') && [...document.querySelectorAll('.project-source-option')].some(row=>row.textContent.includes('GitHub repository')) && [...document.querySelectorAll('.project-source-option')].some(row=>row.textContent.includes('GitLab repository'))",
  );
  await window.webContents.executeJavaScript(`(() => {
    const row=[...document.querySelectorAll('.project-source-option')].find(row=>row.textContent.includes('Local folder'));
    row.querySelector('button').click();
  })()`);
  await waitSettings(
    "document.querySelector('input[aria-label=\"Local folder path\"]')===document.activeElement",
  );
  const missingProject = join(app.getPath("temp"), `versionstead-missing-project-${Date.now()}`);
  await window.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('input[aria-label="Local folder path"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(missingProject)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await window.webContents.executeJavaScript(
    "document.querySelector('.local-project-form form').requestSubmit()",
  );
  await waitSettings("document.querySelector('.local-project-form [role=\"alert\"]')");
  // A failed action is reported once: in the dialog that owns it, with no toast or banner repeating it.
  const reportedOnce: unknown = await window.webContents.executeJavaScript(
    "![...document.querySelectorAll('[data-slot=\"toast\"]:not([data-ending-style])')].some(item=>item.textContent.includes('Versionstead needs attention')) && !document.querySelector('.connection-banner')",
  );
  if (reportedOnce !== true)
    throw new Error("A failed Add project must be reported once, inside its own dialog");
  await window.webContents.executeJavaScript(
    `document.querySelector('.local-project-form > button').click()`,
  );
  await waitSettings("document.querySelector('.project-source-picker')");
  await window.webContents.executeJavaScript(
    `[...document.querySelectorAll('.project-source-option')].find(row=>row.textContent.includes('Git URL')).querySelector('button').click()`,
  );
  await waitSettings(
    "document.querySelector('input[aria-label=\"Repository URL\"]')===document.activeElement",
  );
  await window.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('input[aria-label="Repository URL"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'https://github.com.evil.example/owner/repo');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await window.webContents.executeJavaScript(
    `document.querySelector('.project-url-form button[type="submit"]').click()`,
  );
  await waitSettings(
    "document.querySelector('.project-url-form [role=\"alert\"]')?.textContent.includes('GitHub.com or GitLab.com')",
  );
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitSettings("document.querySelector('dialog[open] .project-source-picker')");
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Setup required for GitHub"]').click()`,
  );
  await waitSettings(
    "document.querySelector('h1')?.textContent==='Source Control' && !document.querySelector('dialog[open]')",
  );
  const setAppearanceMode = async (mode: "light" | "dark", destination: string) => {
    if (!window) throw new Error("Smoke window unavailable");
    await window.loadURL("versionstead://app/settings/appearance");
    await waitSettings(
      `document.querySelector('button[aria-label="${mode === "dark" ? "Dark" : "Light"} theme"]')`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="${mode === "dark" ? "Dark" : "Light"} theme"]').click()`,
    );
    await waitSettings(`document.documentElement.dataset.theme==='${mode}'`);
    await window.loadURL(`versionstead://app/${destination}`);
    await waitSettings(
      "document.querySelector('[data-testid=\"connection-state\"]')?.getAttribute('data-state')==='online'",
    );
  };
  const sidebarAppearanceAbsent: unknown = await window.webContents.executeJavaScript(
    "!document.querySelector('.sidebar-footer .theme-control') && !document.querySelector('.sidebar-footer [aria-label=\"Appearance\"]') && !document.querySelector('.sidebar-footer .theme-button')",
  );
  if (sidebarAppearanceAbsent !== true)
    throw new Error("Appearance controls must live in Settings only");
  await window.loadURL("versionstead://app/settings/appearance");
  await waitSettings("document.querySelectorAll('.appearance-mode-card').length===3");
  const themeSpacing: unknown = await window.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('.appearance-mode-card')];
    const rects = buttons.map(button => button.getBoundingClientRect());
    return buttons.length === 3 && rects.every(rect => rect.width >= 36 && rect.height >= 36) && rects.slice(1).every((rect, index) => rect.x - rects[index].right >= 8);
  })()`);
  if (themeSpacing !== true)
    throw new Error("Appearance preview cards must have separated hit targets");
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    document.querySelector('button[aria-label="Dark theme"]').click();
    setTimeout(resolve, 100);
  })`);
  const darkTheme: unknown = await window.webContents.executeJavaScript(
    "document.documentElement.dataset.theme === 'dark' && document.querySelector('button[aria-label=\"Dark theme\"]').getAttribute('aria-pressed') === 'true'",
  );
  if (darkTheme !== true)
    throw new Error("Theme selection must update appearance and pressed state");
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    document.querySelector('button[aria-label="Light theme"]').click();
    setTimeout(resolve, 100);
  })`);
  await window.loadURL("versionstead://app/projects");
  await waitSettings(
    "document.querySelector('[data-testid=\"connection-state\"]')?.getAttribute('data-state')==='online'",
  );
  const projects = (await readyCoordinator())?.snapshot.projects ?? [];
  let nativeGroupedProjects = false;
  let nativeEvidenceSheet = false;
  if (projects.length > 0) {
    await clickButton("All projects");
    const projectGroups: unknown = await window.webContents
      .executeJavaScript(`new Promise(resolve => setTimeout(() => {
      resolve(document.querySelectorAll('[data-testid="project-group"]').length);
    }, 100))`);
    if (projectGroups !== projects.length)
      throw new Error("All projects must retain selected folders");
    await expectOutline("Projects");
    // A button's accessible name starts with the text it shows, as speech control needs.
    const scanNames: unknown = await window.webContents.executeJavaScript(`(() => {
      const buttons = [...document.querySelectorAll('[data-testid="project-group"] .target-group-actions button')];
      return buttons.length > 0 && buttons.every(button => {
        const name = (button.getAttribute('aria-label') ?? '').toLowerCase();
        const shown = (button.textContent ?? '').trim().replace(/…$/, '').toLowerCase();
        return shown !== '' && name.startsWith(shown) && name.length > shown.length;
      });
    })()`);
    if (scanNames !== true)
      throw new Error("A scan button's accessible name must start with its visible text");
    const initiallyClosed = await window.webContents.executeJavaScript(
      "[...document.querySelectorAll('[data-testid=\"project-disclosure\"]')].every(trigger=>trigger.getAttribute('aria-expanded')==='false')",
    );
    if (!initiallyClosed) throw new Error("Project accordions must start closed");
    const wasOpen: unknown = await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('[data-testid="project-disclosure"]');
      trigger.focus(); return trigger.getAttribute('aria-expanded') === 'true';
    })()`);
    window.focus();
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    const toggled: unknown = await window.webContents
      .executeJavaScript(`new Promise(resolve => setTimeout(() => {
      resolve(document.querySelector('[data-testid="project-disclosure"]').getAttribute('aria-expanded') === 'true');
    }, 250))`);
    if (toggled === wasOpen) {
      const focus: unknown = await window.webContents.executeJavaScript(
        "({ documentFocused: document.hasFocus(), disclosureFocused: document.activeElement?.getAttribute('data-testid') === 'project-disclosure' })",
      );
      throw new Error(`Enter must toggle project disclosure (${JSON.stringify(focus)})`);
    }
    if (!toggled) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      window.webContents.sendInputEvent({ type: "char", keyCode: "Enter" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    }
    const firstProject = projects[0];
    if (firstProject?.dependencies.length) {
      await clickButton("All dependencies");
      const rows: unknown = await window.webContents
        .executeJavaScript(`new Promise(resolve => setTimeout(() => {
        resolve(document.querySelector('[data-testid="project-group"]').querySelectorAll('tbody tr').length);
      }, 250))`);
      if (rows !== firstPage(firstProject.dependencies.length))
        throw new Error("All dependencies must expose retained dependency records");
      const remaining = firstProject.dependencies.length - 200;
      if (remaining > 0) {
        const label = `Show ${firstPage(remaining)} more (${remaining} remaining)`;
        const nextPage: unknown = await window.webContents
          .executeJavaScript(`new Promise(resolve => {
          const group = document.querySelector('[data-testid="project-group"]');
          [...group.querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(label)})?.click();
          setTimeout(() => {
            const rows = group.querySelectorAll('tbody tr');
            resolve({ rows: rows.length, focused: document.activeElement === rows[200]?.querySelector('button') });
          }, 250);
        })`);
        const page = nextPage as { rows: number; focused: boolean };
        if (page.rows !== Math.min(firstProject.dependencies.length, 400) || !page.focused)
          throw new Error("Show more must reveal the next rows and focus the first revealed row");
      }
      await window.webContents.executeJavaScript(`(() => {
        const trigger = document.querySelector('.project-detail .item-label');
        trigger.focus(); trigger.click();
      })()`);
      const sheetFocus: unknown = await window.webContents
        .executeJavaScript(`new Promise(resolve => setTimeout(() => {
        const popup = document.querySelector('[data-slot="sheet-popup"][role="dialog"]');
        resolve(Boolean(popup?.contains(document.activeElement)));
      }, 250))`);
      if (sheetFocus !== true) throw new Error("Evidence Sheet must receive focus");
      await expectOutline("the evidence sheet");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
      const focusTrapped: unknown = await window.webContents.executeJavaScript(
        "document.querySelector('[data-slot=\"sheet-popup\"]').contains(document.activeElement)",
      );
      if (focusTrapped !== true) throw new Error("Evidence Sheet must contain keyboard focus");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      const sheetClosed: unknown = await window.webContents
        .executeJavaScript(`new Promise(resolve => setTimeout(() => {
        resolve(!document.querySelector('[data-slot="sheet-popup"]') && document.activeElement?.classList.contains('item-label'));
      }, 300))`);
      if (sheetClosed !== true) throw new Error("Evidence Sheet Escape must restore package focus");
      nativeEvidenceSheet = true;
    }
    nativeGroupedProjects = true;
  }
  window.close();
  if (window.isDestroyed() || window.isVisible())
    throw new Error("Closing the window did not hide it to the tray");
  await showWindow();
  if (!window.isVisible()) throw new Error("Tray reopen failed");
  window.hide();
  if (!(await readyCoordinator())) throw new Error("Coordinator stopped when the UI hid");
  const screenshotDirectory = process.env.VERSIONSTEAD_SMOKE_SCREENSHOT_DIR;
  if (screenshotDirectory) {
    if (!isAbsolute(screenshotDirectory))
      throw new Error("Smoke screenshot directory must be absolute");
    await mkdir(screenshotDirectory, { recursive: true });
    await writeFile(join(screenshotDirectory, "app-icon.png"), trayIcon().toPNG());
    window.setContentSize(1440, 900);
    window.showInactive();
    for (const [name, path] of [
      ["attention", "/"],
      ["pc", "/pc"],
      ["projects", "/projects"],
      ["service", "/service"],
    ]) {
      await window.loadURL(`versionstead://app${path}`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const check = () => {
          if (document.querySelector('[data-testid="connection-state"]')?.getAttribute('data-state') === 'online') {
            document.fonts.ready.then(() => setTimeout(resolve, 250));
          } else if (Date.now() > deadline) reject(new Error('Screenshot route did not connect'));
          else setTimeout(check, 100);
        }; check();
      })`);
      if (name === "projects" && projects.length > 0) {
        await clickButton("All projects");
        await window.webContents.executeJavaScript(
          "document.querySelector('[data-testid=\"project-disclosure\"]').click()",
        );
        await waitSettings(
          "document.querySelector('[data-testid=\"project-disclosure\"]')?.getAttribute('aria-expanded')==='true'",
        );
        if (projects[0]?.dependencies.length) await clickButton("All dependencies");
        await window.webContents.executeJavaScript(
          "new Promise(resolve => setTimeout(resolve, 250))",
        );
      }
      await writeFile(
        join(screenshotDirectory, `${name}.png`),
        (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
      );
      if (name === "projects") {
        for (const width of [1440, 390]) {
          window.setMinimumSize(320, 500);
          window.setContentSize(width, 900);
          await window.webContents.executeJavaScript(
            "new Promise(resolve => setTimeout(resolve, 250))",
          );
          const dimensions: unknown = await window.webContents.executeJavaScript(`(() => {
            const wrapper = document.querySelector('.project-detail .table-wrap');
            const row = wrapper?.querySelector('tbody tr');
            return { wrapperWidth: wrapper?.clientWidth ?? null, tableWidth: wrapper?.querySelector('table')?.getBoundingClientRect().width ?? null, columns: row ? [...row.cells].map(cell => cell.getBoundingClientRect().width) : [], pageWidth: document.documentElement.scrollWidth, viewport: innerWidth };
          })()`);
          const sizes = dimensions as {
            pageWidth: number;
            viewport: number;
            columns: number[];
          };
          if (sizes.pageWidth > sizes.viewport || (sizes.columns[0] ?? 0) > 320)
            throw new Error("Project table escapes its horizontal scroll container");
          console.log(JSON.stringify({ nativeProjectTable: dimensions }));
          if (width === 390)
            await writeFile(
              join(screenshotDirectory, "projects-narrow.png"),
              (
                await window.webContents.capturePage(undefined, {
                  stayHidden: true,
                })
              ).toPNG(),
            );
        }
        window.setContentSize(1440, 900);
        await setAppearanceMode("dark", "projects");
        await writeFile(
          join(screenshotDirectory, "projects-dark.png"),
          (
            await window.webContents.capturePage(undefined, {
              stayHidden: true,
            })
          ).toPNG(),
        );
        await setAppearanceMode("light", "projects");
      }
    }
    await window.loadURL("versionstead://app/projects");
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const check = () => {
        const button = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Add project') && !button.disabled);
        if (button) { button.click(); setTimeout(resolve, 250); }
        else if (Date.now() > deadline) reject(new Error('Add project dialog did not become available'));
        else setTimeout(check, 100);
      }; check();
    })`);
    await writeFile(
      join(screenshotDirectory, "add-project.png"),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    );
  }
  for (const [path, title] of [
    ["general", "General"],
    ["appearance", "Appearance"],
    ["keybindings", "Keybindings"],
    ["source-control", "Source Control"],
    ["connections", "Connections"],
  ]) {
    await window.loadURL(`versionstead://app/settings/${path}`);
    await waitSettings(
      `document.querySelector('h1')?.textContent === ${JSON.stringify(title)} && document.querySelector('.setting-group') && document.querySelector('[data-testid="connection-state"]')?.getAttribute('data-state')==='online'`,
    );
    await expectOutline(`${title} settings`);
    if (path === "source-control") {
      await waitSettings(
        "document.querySelectorAll('.source-control-row').length===7 && document.querySelectorAll('.source-control-mark svg').length===7",
      );
      for (const label of ["Automatically scan repositories", "Enable Git context"]) {
        const original = await window.webContents.executeJavaScript(`(() => {
          const control=document.querySelector('[aria-label="${label}"]');
          if(control.disabled)return null;
          const value=control.getAttribute('aria-checked');control.click();return value;
        })()`);
        if (original === null) continue;
        const changed = original === "true" ? "false" : "true";
        await waitSettings(
          `document.querySelector('[aria-label="${label}"]')?.getAttribute('aria-checked')==='${changed}' && !document.querySelector('[aria-label="${label}"]').disabled`,
        );
        await window.loadURL("versionstead://app/settings/source-control");
        await waitSettings(
          `document.querySelector('[aria-label="${label}"]')?.getAttribute('aria-checked')==='${changed}' && !document.querySelector('[aria-label="${label}"]').disabled`,
        );
        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label="${label}"]').click()`,
        );
        await waitSettings(
          `document.querySelector('[aria-label="${label}"]')?.getAttribute('aria-checked')==='${original}' && !document.querySelector('[aria-label="${label}"]').disabled`,
        );
      }
      await window.webContents.executeJavaScript(`(() => {
        const toggle=document.querySelector('[aria-label="Toggle GitHub details"]');
        if(toggle.getAttribute('aria-expanded')!=='false')throw new Error('Provider details must start collapsed');
        toggle.click();
      })()`);
      await waitSettings(
        "document.querySelector('[aria-label=\"Toggle GitHub details\"]').getAttribute('aria-expanded')==='true' && [...document.querySelectorAll('.source-control-details button')].some(button=>button.textContent==='Connect GitHub')",
      );
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Enable GitHub repository scans"]').click()`,
      );
      await waitSettings(
        "document.querySelector('dialog[open] h2')?.textContent==='Connect GitHub' && document.activeElement?.type==='password'",
      );
      await window.webContents.executeJavaScript(`(() => {
        if(document.querySelector('[aria-label="Enable GitHub repository scans"]').getAttribute('aria-checked')!=='false')throw new Error('Opening a connection dialog must not authenticate or enable a provider');
        document.querySelector('dialog[open] button[aria-label="Close dialog"]').click();
      })()`);
      await waitSettings("!document.querySelector('dialog[open]')");
      const originalInterval = await window.webContents.executeJavaScript(
        `document.querySelector('button[aria-label="Repository scan interval"]')?.textContent?.trim()`,
      );
      await selectOption("Repository scan interval", "15 minutes");
      await waitSettings(
        "document.querySelector('button[aria-label=\"Repository scan interval\"]')?.textContent?.trim()==='15 minutes' && !document.querySelector('button[aria-label=\"Repository scan interval\"]').disabled",
      );
      await window.loadURL("versionstead://app/settings/general");
      await waitSettings(
        "document.querySelector('button[aria-label=\"Project scan interval\"]')?.textContent?.trim()==='15 minutes'",
      );
      await window.loadURL("versionstead://app/settings/source-control");
      await waitSettings(
        "document.querySelector('button[aria-label=\"Repository scan interval\"]')?.textContent?.trim()==='15 minutes'",
      );
      await selectOption("Repository scan interval", originalInterval);
      await waitSettings(
        `document.querySelector('button[aria-label="Repository scan interval"]')?.textContent?.trim()===${JSON.stringify(originalInterval)} && !document.querySelector('button[aria-label="Repository scan interval"]').disabled`,
      );
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Refresh source control tools"]').click()`,
      );
      await waitSettings(
        "!document.querySelector('[aria-label=\"Refresh source control tools\"]').disabled",
      );
      if (screenshotDirectory) {
        await setAppearanceMode("dark", "settings/source-control");
        await waitSettings("document.querySelectorAll('.source-control-row').length===7");
        window.setContentSize(1280, 1040);
        await window.webContents.executeJavaScript("new Promise(resolve=>setTimeout(resolve,150))");
        await writeFile(
          join(screenshotDirectory, "source-control-dark.png"),
          (
            await window.webContents.capturePage(undefined, {
              stayHidden: true,
            })
          ).toPNG(),
        );
      }
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Toggle Git details"]').click();document.querySelector('[aria-label="Toggle GitHub details"]').click();document.querySelector('[aria-label="Toggle GitLab details"]').click()`,
      );
      await waitSettings(
        "document.querySelectorAll('.source-control-controls [aria-expanded=\"true\"]').length===3",
      );
      window.setMinimumSize(320, 500);
      window.setContentSize(390, 900);
      await window.webContents.executeJavaScript("new Promise(resolve=>setTimeout(resolve,150))");
      const contained = await window.webContents.executeJavaScript(
        `document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.source-control-summary')].every(row=>row.scrollWidth<=row.clientWidth)`,
      );
      if (!contained) {
        const dimensions = await window.webContents.executeJavaScript(
          `({viewport:innerWidth,page:document.documentElement.scrollWidth,rows:[...document.querySelectorAll('.source-control-summary')].map(row=>({name:row.querySelector('h3')?.textContent,width:row.clientWidth,scroll:row.scrollWidth})),wide:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,class:e.className,width:e.getBoundingClientRect().width}))})`,
        );
        throw new Error(
          "Source Control details escape the narrow window: " + JSON.stringify(dimensions),
        );
      }
      if (screenshotDirectory)
        await writeFile(
          join(screenshotDirectory, "source-control-narrow.png"),
          (
            await window.webContents.capturePage(undefined, {
              stayHidden: true,
            })
          ).toPNG(),
        );
      window.setContentSize(1440, 900);
      if (screenshotDirectory) {
        await window.webContents.executeJavaScript("new Promise(resolve=>setTimeout(resolve,150))");
        await writeFile(
          join(screenshotDirectory, "source-control-details.png"),
          (
            await window.webContents.capturePage(undefined, {
              stayHidden: true,
            })
          ).toPNG(),
        );
        await setAppearanceMode("light", "settings/source-control");
        await waitSettings("document.querySelectorAll('.source-control-row').length===7");
      }
    }
    if (path === "connections") {
      if (screenshotDirectory) await setAppearanceMode("dark", "settings/connections");
      await window.webContents.executeJavaScript(
        "document.querySelector('[aria-label=\"Enable network access\"]').click()",
      );
      await waitSettings(
        "document.querySelector('dialog[open] [aria-label=\"Sharing network address\"]')",
      );
      await window.webContents.executeJavaScript(
        "document.querySelector('[aria-label=\"Sharing network address\"]').click()",
      );
      await waitSettings(
        'document.querySelector(\'dialog[open] [data-slot="select-popup"] [role="option"]\')',
      );
      const networkOption = await window.webContents.executeJavaScript(`(() => {
        const item = document.querySelector('dialog[open] [role="option"]');
        const bounds = item.getBoundingClientRect();
        const visible = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('[role="option"]') === item;
        if (visible) item.click(); return visible;
      })()`);
      if (!networkOption)
        throw new Error("Network address options must be clickable above the native dialog");
      await clickButton("Cancel");
      await waitSettings("!document.querySelector('dialog[open]')");
      await waitSettings(
        "document.querySelector('.empty-environments') && document.querySelector('[aria-label=\"Enable network access\"]')",
      );
      const original = await window.webContents.executeJavaScript(`(() => {
        const control = document.querySelector('[aria-label="Local environment"]');
        const value = control.getAttribute('aria-checked'); control.click(); return value;
      })()`);
      await waitSettings(
        `document.querySelector('[aria-label="Local environment"]').getAttribute('aria-checked')!==${JSON.stringify(original)} && !document.querySelector('[aria-label="Local environment"]').disabled`,
      );
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Local environment"]').click()`,
      );
      await waitSettings(
        `document.querySelector('[aria-label="Local environment"]').getAttribute('aria-checked')===${JSON.stringify(original)} && !document.querySelector('[aria-label="Local environment"]').disabled`,
      );
      await clickButton("Add environment");
      await waitSettings(
        "document.querySelector('dialog[open] h2')?.textContent==='Add Environment' && document.querySelector('input[placeholder=\"PAIRCODE\"]')",
      );
      const identity = {
        version: 1,
        origin: "https://100.64.1.2:4389",
        fingerprint: "a".repeat(64),
        deviceId: "00000000-0000-4000-8000-000000000099",
        label: "Smoke peer",
        code: "a".repeat(43),
      };
      const code = Buffer.from(JSON.stringify(identity)).toString("base64url");
      await window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('input[placeholder="100.100.10.20:4389"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(identity.origin + "/#pair=" + code)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitSettings(
        `document.querySelector('input[placeholder="100.100.10.20:4389"]').value===${JSON.stringify(identity.origin)} && document.querySelector('input[placeholder="PAIRCODE"]').value===${JSON.stringify(code)}`,
      );
      if (screenshotDirectory)
        await writeFile(
          join(screenshotDirectory, "connections-remote-link.png"),
          (
            await window.webContents.capturePage(undefined, {
              stayHidden: true,
            })
          ).toPNG(),
        );
      await window.webContents.executeJavaScript(
        "document.querySelector('dialog[open] .connection-mode-card:last-child').click()",
      );
      await waitSettings(
        "document.querySelector('#environment-ssh-host') && document.querySelector('input[placeholder=\"root\"]') && document.querySelector('input[placeholder=\"22\"]')",
      );
      if (screenshotDirectory)
        await writeFile(
          join(screenshotDirectory, "connections-ssh.png"),
          (
            await window.webContents.capturePage(undefined, {
              stayHidden: true,
            })
          ).toPNG(),
        );
      await clickButton("Close dialog");
      await waitSettings("!document.querySelector('dialog[open]')");
      window.setContentSize(560, 720);
      await clickButton("Add environment");
      await waitSettings("document.querySelector('dialog[open] .connection-mode-grid')");
      const contained = await window.webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector('dialog[open]');
        const bounds = dialog.getBoundingClientRect();
        return dialog.scrollWidth <= dialog.clientWidth + 2 && bounds.left >= 0 && bounds.right <= innerWidth;
      })()`);
      if (contained !== true) throw new Error("Connections dialog escapes a narrow window");
      await clickButton("Close dialog");
      window.setContentSize(1280, 800);
    }
    if (screenshotDirectory && (path === "source-control" || path === "connections"))
      await writeFile(
        join(screenshotDirectory, `settings-${path}.png`),
        (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
      );
  }
  await window.loadURL("versionstead://app/settings/project");
  await waitSettings(
    "document.querySelector('h1')?.textContent==='Project' && document.querySelector('[data-testid=\"connection-state\"]')?.getAttribute('data-state')==='online'",
  );
  if (projects.length > 0) {
    const project = projects.find((p) => !p.repository);
    if (!project) throw new Error("Project settings smoke needs the selected local checkout");
    const selectedProject = async () =>
      (await readyCoordinator())?.snapshot.projects.find((p) => p.id === project.id);
    const fillProjectField = async (selector: string, value: string) => {
      if (!window) throw new Error("Smoke window unavailable");
      await window.webContents.executeJavaScript(`(() => {
        const input=document.querySelector(${JSON.stringify(selector)});
        if(!input)throw new Error('Project field unavailable');
        const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        input.focus();Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)});
        input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
    };
    // Hidden smoke windows need an explicit focusout; native blur may not dispatch it.
    const captureProject = async (name: string) => {
      if (screenshotDirectory && window) {
        await window.webContents.executeJavaScript("new Promise(resolve=>setTimeout(resolve,150))");
        await writeFile(
          join(screenshotDirectory, name),
          (
            await window.webContents.capturePage(undefined, {
              stayHidden: true,
            })
          ).toPNG(),
        );
      }
    };
    await waitSettings(
      "document.querySelector('[aria-label=\"Project name\"]') && !document.querySelector('[aria-label=\"Project name\"]').disabled",
    );
    await expectOutline("Project settings");
    await fillProjectField('[aria-label="Project name"]', "  Native project settings  ");
    await window.webContents.executeJavaScript(
      "document.querySelector('[aria-label=\"Project name\"]').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))",
    );
    await waitSettings(
      "document.querySelector('[aria-label=\"Project name\"]').value==='Native project settings' && !document.querySelector('[aria-label=\"Project name\"]').disabled",
    );
    if ((await selectedProject())?.name !== "Native project settings")
      throw new Error("Project name must save on blur and trim whitespace");
    await clickButton("Choose icon");
    await waitSettings(
      "document.querySelector('dialog[open] [aria-label=\"Search project icons\"]')",
    );
    await captureProject("project-icon-picker.png");
    await clickButton("Monogram");
    await fillProjectField('dialog[open] [aria-label="Monogram"]', "VS");
    await clickButton("Use icon");
    await waitSettings(
      "!document.querySelector('dialog[open]') && document.querySelector('.project-overview .project-badge')?.textContent==='VS'",
    );
    if ((await selectedProject())?.icon?.kind !== "monogram")
      throw new Error("Project icon must persist");
    await clickButton("Reset project icon");
    await waitSettings(
      "!document.querySelector('[aria-label=\"Reset project icon\"]') && !document.querySelector('[aria-label=\"Project name\"]').disabled",
    );
    await window.webContents.executeJavaScript(`(async () => {
      const canvas=document.createElement('canvas');canvas.width=48;canvas.height=48;
      const context=canvas.getContext('2d');context.fillStyle='#3978d4';context.fillRect(0,0,48,48);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const transfer=new DataTransfer();transfer.items.add(new File([blob],'project.png',{type:'image/png'}));
      const input=document.querySelector('.project-overview input[type="file"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitSettings(
      "document.querySelector('.project-overview .project-badge img') && !document.querySelector('[aria-label=\"Project name\"]').disabled",
    );
    if ((await selectedProject())?.icon?.kind !== "image")
      throw new Error("Uploaded project icon must normalize and persist");
    await clickButton("Reset project icon");
    await waitSettings(
      "!document.querySelector('[aria-label=\"Reset project icon\"]') && !document.querySelector('[aria-label=\"Project name\"]').disabled",
    );
    await clickButton("Add action");
    await waitSettings("document.querySelector('dialog[open] h2')?.textContent==='Add Action'");
    await fillProjectField('dialog[open] input[placeholder="Test"]', "Native action");
    await fillProjectField(
      "dialog[open] textarea",
      process.platform === "win32" ? "Write-Output 'native-action-ok'" : "printf native-action-ok",
    );
    // The keybinding field never traps focus, and Tab is not recorded as a shortcut.
    await window.webContents.executeJavaScript(
      "document.querySelector('[aria-label=\"Action keybinding\"]').focus()",
    );
    window.focus();
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["shift"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: ["shift"] });
    await waitSettings(
      "document.activeElement?.getAttribute('aria-label')!=='Action keybinding' && document.querySelector('[aria-label=\"Action keybinding\"]').value==='' && !document.querySelector('dialog [role=\"alert\"]')",
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('[aria-label=\"Action keybinding\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,altKey:true,bubbles:true}))",
    );
    await captureProject("project-action-editor.png");
    await clickButton("Save action");
    await waitSettings(
      "!document.querySelector('dialog[open]') && document.querySelector('[aria-label=\"Run Native action\"]') && !document.querySelector('[aria-label=\"Run Native action\"]').disabled",
    );
    const selectedAction = (await selectedProject())?.actions?.[0];
    if (
      !selectedAction ||
      selectedAction.shortcut !== "mod+alt+t" ||
      projectActionRunner.latest(project.id, selectedAction.id)
    )
      throw new Error("Saving an action must persist its shortcut without running it");
    await window.webContents.executeJavaScript(
      "document.querySelector('[aria-label=\"Project name\"]').blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,altKey:true,bubbles:true}))",
    );
    await waitSettings(
      "document.querySelector('dialog[open] h2')?.textContent==='Native action' && document.querySelector('dialog[open] [role=\"status\"]')?.textContent==='Ready to run'",
    );
    await clickButton("Run command");
    await waitSettings(
      "document.querySelector('dialog[open] [role=\"status\"]')?.textContent==='completed · Exit 0' && document.querySelector('[aria-label=\"Command output\"]')?.textContent.includes('native-action-ok')",
    );
    await captureProject("project-action-output.png");
    await clickButton("Close dialog");
    await waitSettings("!document.querySelector('dialog[open]')");
    await clickButton("Run Native action");
    await waitSettings(
      "document.querySelector('dialog[open] [role=\"status\"]')?.textContent==='completed · Exit 0'",
    );
    await clickButton("Close dialog");
    await waitSettings("!document.querySelector('dialog[open]')");
    await clickButton("Edit Native action");
    await fillProjectField(
      "dialog[open] textarea",
      process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30",
    );
    await clickButton("Save changes");
    await waitSettings(
      "!document.querySelector('dialog[open]') && !document.querySelector('[aria-label=\"Run Native action\"]').disabled",
    );
    await clickButton("Run Native action");
    await waitSettings("document.querySelector('dialog[open] h2')?.textContent==='Native action'");
    await clickButton("Run again");
    await waitSettings(
      "document.querySelector('dialog[open] [role=\"status\"]')?.textContent==='running'",
    );
    await clickButton("Stop command");
    await waitSettings(
      "document.querySelector('dialog[open] [role=\"status\"]')?.textContent.startsWith('stopped')",
    );
    await clickButton("Close dialog");
    await waitSettings("!document.querySelector('dialog[open]')");
    await clickButton("Run Native action");
    await waitSettings("document.querySelector('dialog[open] h2')?.textContent==='Native action'");
    await clickButton("Run again");
    await waitSettings(
      "document.querySelector('dialog[open] [role=\"status\"]')?.textContent==='running'",
    );
    await clickButton("Close dialog");
    await waitSettings("!document.querySelector('dialog[open]')");
    await clickButton("Edit Native action");
    await clickButton("Delete");
    await waitSettings(
      "document.querySelector('dialog[open] [role=\"alert\"]')?.textContent.includes('Delete this saved action')",
    );
    await clickButton("Confirm delete action");
    await waitSettings(
      "!document.querySelector('dialog[open]') && document.querySelector('.project-actions-empty')?.textContent==='No actions configured.'",
    );
    if ((await selectedProject())?.actions?.length !== 0)
      throw new Error("Confirmed action deletion must persist");
    if (projectActionRunner.latest(project.id, selectedAction.id)?.status !== "stopped")
      throw new Error("Deleting an active action must stop its command");
    await clickButton("Remove project");
    await waitSettings(
      "document.querySelector('dialog[open] h2')?.textContent==='Remove project?'",
    );
    await clickButton("Cancel");
    await waitSettings("!document.querySelector('dialog[open]')");
    if (!(await selectedProject())) throw new Error("Cancel must retain the selected project");
    await fillProjectField('[aria-label="Project name"]', project.name);
    await window.webContents.executeJavaScript(
      "document.querySelector('[aria-label=\"Project name\"]').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))",
    );
    await waitSettings(
      `document.querySelector('[aria-label="Project name"]').value===${JSON.stringify(project.name)} && !document.querySelector('[aria-label="Project name"]').disabled`,
    );
    await window.webContents.executeJavaScript("document.querySelector('main').scrollTop=0");
    await captureProject("settings-project.png");
    window.setMinimumSize(320, 500);
    window.setContentSize(390, 900);
    await window.webContents.executeJavaScript("new Promise(resolve=>setTimeout(resolve,150))");
    await window.webContents.executeJavaScript("document.querySelector('main').scrollTop=0");
    if (
      !(await window.webContents.executeJavaScript(
        "document.documentElement.scrollWidth<=innerWidth",
      ))
    )
      throw new Error("Project settings escape the narrow window");
    await captureProject("settings-project-narrow.png");
    window.setContentSize(1280, 800);
  }
  if (screenshotDirectory) await setAppearanceMode("light", "settings/appearance");
  await window.loadURL("versionstead://app/settings/appearance");
  await waitSettings("document.querySelector('[aria-label=\"Compact rows\"]')");
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Compact rows"]').click()`,
  );
  await waitSettings("document.documentElement.dataset.density==='compact'");
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Compact rows"]').click();document.querySelector('[aria-label="Dark theme"]').click()`,
  );
  await waitSettings(
    "document.querySelectorAll('[aria-label=\"Dark theme\"]').length===1 && document.querySelector('[aria-label=\"Dark theme\"]').getAttribute('aria-pressed')==='true' && !document.querySelector('.sidebar-footer .theme-control')",
  );
  await window.webContents.executeJavaScript(`
    document.querySelector('[aria-label="Use Grove light mode"]').click();
    document.querySelector('[aria-label="Use T3 Chat dark mode"]').click();
  `);
  await waitSettings(
    `JSON.parse(localStorage.getItem('versionstead.theme-halves')).light==='grove' && JSON.parse(localStorage.getItem('versionstead.theme-halves')).dark==='t3-chat'`,
  );
  await window.webContents.executeJavaScript(`(() => {
    for (const [label, value] of [['Contrast',150],['Glass opacity',50],['Panel animation duration',250]]) {
      const input=document.querySelector('input[aria-label="'+label+'"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
  })()`);
  await waitSettings(
    `document.documentElement.style.getPropertyValue('--glass-opacity')==='50%' && document.documentElement.style.getPropertyValue('--panel-duration')==='250ms' && document.documentElement.style.getPropertyValue('--foreground').includes('white 50%')`,
  );
  await selectOption("Interface font", "Segoe UI");
  await selectOption("Interface font size", "18 px");
  await selectOption("Monospace font", "Consolas");
  await selectOption("Monospace font size", "16 px");
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Word wrap"]').click();document.querySelector('[aria-label="Advanced typography"]').click()`,
  );
  await waitSettings(
    `document.documentElement.dataset.wordWrap==='false' && document.querySelector('[aria-label="Package table font size"]')`,
  );
  await selectOption("Package table font size", "16 px");
  await selectOption("Evidence panel font size", "18 px");
  await waitSettings(
    `document.documentElement.style.fontSize==='18px' && document.documentElement.style.getPropertyValue('--interface-font').includes('Segoe UI') && document.documentElement.style.getPropertyValue('--monospace-font').includes('Consolas') && document.documentElement.style.getPropertyValue('--table-font-size')==='16px' && JSON.parse(localStorage.getItem('versionstead.appearance')).monospaceFontSize===16 && JSON.parse(localStorage.getItem('versionstead.appearance')).evidenceFontSize===18`,
  );
  await clickButton("Create theme");
  await waitSettings(`document.querySelector('dialog[open] [aria-label="Theme name"]')`);
  await window.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('[aria-label="Theme name"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Native smoke theme');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await clickButton("Save theme");
  await waitSettings(
    `!document.querySelector('dialog[open]') && [...document.querySelectorAll('.theme-card-name')].some(button=>button.textContent==='Native smoke theme') && JSON.parse(localStorage.getItem('versionstead.theme-halves')).light===JSON.parse(localStorage.getItem('versionstead.theme-halves')).dark`,
  );
  await window.loadURL("versionstead://app/settings/appearance");
  await waitSettings(
    `document.documentElement.style.getPropertyValue('--glass-opacity')==='50%' && [...document.querySelectorAll('.theme-card-name')].some(button=>button.textContent==='Native smoke theme') && document.querySelector('[aria-label="Package table font size"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Remove Native smoke theme"]').click()`,
  );
  await waitSettings(`document.querySelector('dialog[open]')`);
  await clickButton("Remove theme");
  await waitSettings(
    `!document.querySelector('dialog[open]') && JSON.parse(localStorage.getItem('versionstead.theme-halves')).light==='default' && JSON.parse(localStorage.getItem('versionstead.theme-halves')).dark==='default'`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Reset contrast"]').click();document.querySelector('[aria-label="Reset glass opacity"]').click();document.querySelector('[aria-label="Reset panel animations"]').click()`,
  );
  await clickButton("Reset typography");
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Advanced typography"]').click();document.querySelector('[aria-label="Word wrap"]').click()`,
  );
  await waitSettings(
    `document.documentElement.style.fontSize==='16px' && document.documentElement.style.getPropertyValue('--glass-opacity')==='80%' && document.documentElement.dataset.wordWrap==='true'`,
  );
  if (screenshotDirectory) {
    window.setContentSize(1440, 900);
    await window.webContents.executeJavaScript(
      `document.querySelector('.content').scrollTop=0;new Promise(resolve=>setTimeout(resolve,150))`,
    );
    await writeFile(
      join(screenshotDirectory, "appearance-dark.png"),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.typography-font-group').scrollIntoView();new Promise(resolve=>setTimeout(resolve,150))`,
    );
    await writeFile(
      join(screenshotDirectory, "appearance-typography.png"),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    );
    window.setMinimumSize(320, 500);
    window.setContentSize(390, 900);
    await window.webContents.executeJavaScript(
      `document.querySelector('.content').scrollTop=0;new Promise(resolve=>setTimeout(resolve,150))`,
    );
    const contained: unknown = await window.webContents.executeJavaScript(
      "document.documentElement.scrollWidth<=innerWidth",
    );
    if (contained !== true) throw new Error("Appearance page escapes a narrow window");
    await writeFile(
      join(screenshotDirectory, "appearance-narrow.png"),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    );
    window.setContentSize(1440, 900);
  }
  await window.loadURL("versionstead://app/settings/keybindings");
  await waitSettings(
    "document.querySelector('[aria-label^=\"Change shortcut for Open settings\"]')",
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label^="Change shortcut for Open settings"]').click()`,
  );
  await waitSettings("document.querySelector('dialog[open] input')");
  window.focus();
  window.webContents.focus();
  // The capture field never traps focus: Shift+Tab leaves it and Escape closes the dialog.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["shift"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: ["shift"] });
  await waitSettings(
    "document.activeElement?.getAttribute('aria-label')==='Close dialog' && !document.querySelector('dialog [role=\"alert\"]')",
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('dialog[open] input').focus()",
  );
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitSettings(
    "!document.querySelector('dialog[open]') && JSON.parse(localStorage.getItem('versionstead.keybindings')).settings==='mod+,'",
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label^="Change shortcut for Open settings"]').click()`,
  );
  await waitSettings("document.querySelector('dialog[open] input')");
  window.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: "S",
    modifiers: ["control", "shift"],
  });
  window.webContents.sendInputEvent({
    type: "keyUp",
    keyCode: "S",
    modifiers: ["control", "shift"],
  });
  await waitSettings(
    "document.querySelector('dialog [role=\"alert\"]')?.textContent.includes('Already used')",
  );
  window.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: "K",
    modifiers: ["control", "alt"],
  });
  window.webContents.sendInputEvent({
    type: "keyUp",
    keyCode: "K",
    modifiers: ["control", "alt"],
  });
  await waitSettings(
    "!document.querySelector('dialog[open]') && JSON.parse(localStorage.getItem('versionstead.keybindings')).settings==='mod+alt+k'",
  );
  // Resetting every shortcut asks first; declining keeps the custom binding.
  await clickButton("Reset all shortcuts");
  await waitSettings("document.querySelector('dialog[open]')");
  await clickButton("Cancel");
  await waitSettings(
    "!document.querySelector('dialog[open]') && JSON.parse(localStorage.getItem('versionstead.keybindings')).settings==='mod+alt+k'",
  );
  await clickButton("Reset all shortcuts");
  await waitSettings("document.querySelector('dialog[open]')");
  await clickButton("Reset shortcuts");
  await waitSettings(
    "!document.querySelector('dialog[open]') && JSON.parse(localStorage.getItem('versionstead.keybindings')).settings==='mod+,'",
  );
  await window.webContents.executeJavaScript("document.getElementById('content').focus()");
  window.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: ",",
    modifiers: ["control"],
  });
  window.webContents.sendInputEvent({
    type: "keyUp",
    keyCode: ",",
    modifiers: ["control"],
  });
  await waitSettings(
    "location.pathname==='/settings/general' && document.querySelector('[aria-label=\"Scheduled scans\"]')",
  );
  const scheduled = (await readyCoordinator())?.snapshot.settings.paused;
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Scheduled scans"]').click()`,
  );
  await waitSettings(
    `document.querySelector('[aria-label="Scheduled scans"]').getAttribute('aria-checked') === ${JSON.stringify(String(scheduled))}`,
  );
  if ((await readyCoordinator())?.snapshot.settings.paused === scheduled)
    throw new Error("Native monitoring switch did not persist");
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Scheduled scans"]').click();document.querySelector('[aria-label="Versionstead updates"]').click()`,
  );
  await waitSettings(
    "document.querySelector('[data-slot=\"sheet-popup\"]')?.textContent.includes('Versionstead updates') && document.querySelector('[data-slot=\"sheet-popup\"]')?.textContent.includes('Check for updates')",
  );
  await waitSettings(
    'document.querySelector(\'[data-slot="sheet-popup"] [data-slot="app-logo"]\')',
  );
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitSettings("!document.querySelector('[data-slot=\"sheet-popup\"]')");
  // Exercise the shared title bar/settings shell in the real sandboxed renderer.
  await window.loadURL("versionstead://app/pc");
  await waitSettings(
    "document.querySelector('[aria-label=\"Settings\"]') && document.querySelector('[data-testid=\"connection-state\"]')?.dataset.state==='online'",
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('[aria-label=\"Settings\"]').click()",
  );
  // A route change names the new page and moves focus to its content.
  await waitSettings(
    "location.pathname==='/settings/general' && document.getElementById('settings-search') && document.title==='General · Versionstead' && document.activeElement?.id==='content'",
  );
  if (process.platform === "win32" || process.platform === "linux") {
    const chrome = await window.webContents.executeJavaScript(`(() => {
      const bar=document.querySelector('.app-titlebar');
      const last=document.querySelector('.titlebar-trailing').getBoundingClientRect();
      const area=navigator.windowControlsOverlay?.getTitlebarAreaRect();
      return navigator.windowControlsOverlay?.visible && Math.round(bar.getBoundingClientRect().height)===40 && area && last.right<=area.x+area.width && getComputedStyle(bar).getPropertyValue('app-region')==='drag' && getComputedStyle(bar.querySelector('button')).getPropertyValue('app-region')==='no-drag';
    })()`);
    if (chrome !== true)
      throw new Error("Native title bar geometry or draggable controls are incorrect");
  }
  const key = (keyCode: string) => {
    window?.webContents.focus();
    window?.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window?.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  await clickButton("Hide sidebar");
  key("/");
  await waitSettings(
    "document.activeElement?.id==='settings-search' && document.querySelector('.app-shell').dataset.sidebarCollapsed==='false'",
  );
  await window.webContents.executeJavaScript(`(() => {
    const input=document.getElementById('settings-search');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'appearance font');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await waitSettings(
    "document.querySelectorAll('#settings-search-results [role=\"option\"]').length===2",
  );
  if (screenshotDirectory)
    await writeFile(
      join(screenshotDirectory, "settings-search.png"),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    );
  key("Down");
  key("Enter");
  await waitSettings(
    "location.pathname==='/settings/appearance' && document.activeElement?.id==='setting-monospace-font'",
  );
  key("Escape");
  await waitSettings("location.pathname==='/pc'");
  await window.webContents.executeJavaScript(
    "document.querySelector('[aria-label=\"Settings\"]').click()",
  );
  await waitSettings(
    "location.pathname==='/settings/general' && document.getElementById('settings-search')",
  );
  await window.webContents.executeJavaScript(`(() => {
    const input=document.getElementById('settings-search');input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'contrast');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await waitSettings("document.querySelector('#settings-search-results [role=\"option\"]')");
  key("Escape");
  await waitSettings(
    "document.getElementById('settings-search').value==='' && location.pathname==='/settings/general'",
  );
  await window.webContents.executeJavaScript(
    "document.getElementById('content').focus();document.querySelector('a[href=\"/settings/appearance\"]').click()",
  );
  await waitSettings("document.querySelector('[aria-label=\"Dark theme\"]')");
  await clickButton("Dark theme");
  await waitSettings("document.documentElement.dataset.theme==='dark'");
  for (let i = 0; i < 50 && nativeTheme.themeSource !== "dark"; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (nativeTheme.themeSource !== "dark")
    throw new Error("Appearance did not update the native theme");
  await window.webContents.executeJavaScript(
    "document.querySelector('a[href=\"/settings/general\"]').click()",
  );
  await clickButton("Restore device defaults");
  await waitSettings(
    "document.querySelector('dialog[open]')?.textContent.includes('Restore device defaults?')",
  );
  key("Escape");
  await waitSettings(
    "!document.querySelector('dialog[open]') && location.pathname==='/settings/general' && document.documentElement.dataset.theme==='dark'",
  );
  const settingsBeforeReset = (await readyCoordinator())?.snapshot.settings;
  await clickButton("Restore device defaults");
  if (screenshotDirectory)
    await writeFile(
      join(screenshotDirectory, "restore-device-defaults.png"),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    );
  await clickButton("Restore defaults");
  await waitSettings(
    "!document.querySelector('dialog[open]') && document.documentElement.dataset.theme==='system' && document.querySelector('[aria-label=\"Restore device defaults\"]').disabled",
  );
  if (screenshotDirectory)
    await writeFile(
      join(screenshotDirectory, "settings-general.png"),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    );
  if (
    JSON.stringify((await readyCoordinator())?.snapshot.settings) !==
    JSON.stringify(settingsBeforeReset)
  )
    throw new Error("Device reset changed monitoring settings");
  const invalidTheme = await window.webContents.executeJavaScript(
    "window.versionstead.setWindowTheme({theme:'dark'}).then(()=>false,()=>true)",
  );
  if (invalidTheme !== true) throw new Error("Window appearance IPC accepted invalid input");
  captureWindowPreferences();
  await persistWindowPreferences();
  const persistedWindow = await loadWindowPreferences(app.getPath("userData"));
  if (!persistedWindow.bounds || persistedWindow.theme !== "system")
    throw new Error("Window preferences were not persisted");
  console.log("Desktop smoke: checking notification logo and dismissal");
  await waitSettings(
    "[...document.querySelectorAll('[data-slot=\"toast\"]:not([data-ending-style])')].some(item=>item.textContent.includes('Device defaults restored.'))",
  );
  const logo = await window.webContents.executeJavaScript(
    "document.querySelector('.app-titlebar [data-slot=\"app-logo\"]') && fetch(document.querySelector('link[rel=\"icon\"]').href).then(response=>response.ok && response.headers.get('content-type')==='image/svg+xml' && response.text()).then(source=>typeof source==='string' && source.includes('viewBox=\"0 0 32 32\"'))",
  );
  if (logo !== true) throw new Error("App header logo or favicon is unavailable");
  const nativeIconColor = await window.webContents.executeJavaScript(`new Promise(resolve => {
    const icon=new Image();icon.onload=()=>{
      const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
      const context=canvas.getContext('2d');context.drawImage(icon,0,0);
      const rgba=context.getImageData(16,6,1,1).data;
      resolve(rgba[0]===48 && rgba[1]===104 && rgba[2]===245 && rgba[3]===255);
    };icon.onerror=()=>resolve(false);icon.src=${JSON.stringify(trayIcon().toDataURL())};
  })`);
  if (nativeIconColor !== true) throw new Error("Native app icon does not match the blue V mark");
  await window.webContents.executeJavaScript(
    "[...document.querySelectorAll('[data-slot=\"toast\"]:not([data-ending-style])')].find(item=>item.textContent.includes('Device defaults restored.')).querySelector('[data-slot=\"toast-close\"]').focus()",
  );
  window.webContents.focus();
  key("Escape");
  await waitSettings(
    "location.pathname==='/settings/general' && ![...document.querySelectorAll('[data-slot=\"toast\"]:not([data-ending-style])')].some(item=>item.textContent.includes('Device defaults restored.'))",
  );
  await window.webContents.executeJavaScript(
    "document.querySelectorAll('[data-slot=\"toast-close\"]').forEach(button=>button.click())",
  );
  const summary = {
    id: `smoke-toast-${Date.now()}`,
    updateCount: 3,
    newUpdateCount: 3,
    projectCount: 1,
    pcCount: 0,
    advisoryCount: 0,
    newAdvisoryCount: 0,
    title: "3 updates available",
    body: "Verification summary: 3 new updates across 1 project.",
    filter: "updates",
  };
  console.log("Desktop smoke: checking validated notification summary");
  window.webContents.send("versionstead:notification-summary", {
    ...summary,
    filter: "invalid",
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const invalidSummaryShown = await window.webContents.executeJavaScript(
    `document.querySelector('[data-slot="toast-viewport"]')?.textContent.includes(${JSON.stringify(summary.body)})`,
  );
  if (invalidSummaryShown) throw new Error("An invalid native notification was displayed");
  window.webContents.send("versionstead:notification-summary", summary);
  const summarySelector = `[...document.querySelectorAll('[data-slot="toast"]:not([data-ending-style])')].filter(item=>item.textContent.includes(${JSON.stringify(summary.body)}))`;
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (await window.webContents.executeJavaScript(`${summarySelector}.length>0`))
    throw new Error("Disabled finding notifications still displayed a summary");
  await window.webContents.executeJavaScript(
    "document.querySelector('[aria-label=\"Notify about new findings\"]').click()",
  );
  await waitSettings(
    "document.querySelector('[aria-label=\"Notify about new findings\"]')?.getAttribute('aria-checked')==='true' && !document.querySelector('[aria-label=\"Notify about new findings\"]').disabled",
  );
  window.webContents.send("versionstead:notification-summary", summary);
  await waitSettings(`${summarySelector}.length===1`);
  console.log("Desktop smoke: checking notification keyboard focus");
  window.webContents.send("versionstead:notification-summary", summary);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await waitSettings(`${summarySelector}.length===1`);
  await window.webContents.executeJavaScript("document.getElementById('content').focus()");
  window.webContents.focus();
  key("F6");
  await waitSettings(
    "document.querySelector('[data-slot=\"toast-viewport\"]')?.contains(document.activeElement)",
  );
  key("Escape");
  await waitSettings(`location.pathname==='/settings/general' && ${summarySelector}.length===1`);
  if (screenshotDirectory) {
    window.setMinimumSize(320, 500);
    window.setContentSize(390, 900);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const contained = await window.webContents.executeJavaScript(`(() => {
      const rect=${summarySelector}[0].getBoundingClientRect();
      return rect.left>=0 && rect.right<=innerWidth && document.documentElement.scrollWidth<=innerWidth;
    })()`);
    if (!contained) throw new Error("Toast escapes a narrow window");
    await writeFile(
      join(screenshotDirectory, "notification-narrow.png"),
      (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
    );
    window.setContentSize(1440, 900);
  }
  await window.webContents.executeJavaScript(
    `${summarySelector}[0].querySelector('[data-slot="toast-action"]').click()`,
  );
  console.log("Desktop smoke: checking notification Review destination");
  await waitSettings(
    "location.pathname==='/' && location.search==='?filter=updates' && [...document.querySelectorAll('.tabs button')].some(button=>button.textContent.includes('Updates') && button.getAttribute('aria-pressed')==='true')",
  );
  await clickButton("All findings");
  const attentionClosed = await window.webContents.executeJavaScript(
    "[...document.querySelectorAll('.target-group-trigger')].every(trigger=>trigger.getAttribute('aria-expanded')==='false')",
  );
  if (!attentionClosed) throw new Error("Needs attention accordions must start closed");
  await expectOutline("Needs attention");
  await window.loadURL("versionstead://app/settings/general");
  await waitSettings(
    "document.querySelector('[data-testid=\"connection-state\"]')?.dataset.state==='online'",
  );
  window.webContents.send("versionstead:notification-summary", summary);
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (await window.webContents.executeJavaScript(`${summarySelector}.length>0`))
    throw new Error("Reload replayed an already-reviewed notification");
  await window.webContents.executeJavaScript(
    "document.querySelector('[aria-label=\"Notify about new findings\"]').click()",
  );
  await waitSettings(
    "document.querySelector('[aria-label=\"Notify about new findings\"]')?.getAttribute('aria-checked')==='false' && !document.querySelector('[aria-label=\"Notify about new findings\"]').disabled",
  );
  console.log(
    JSON.stringify({
      ...(result as Record<string, unknown>),
      trayClose: true,
      trayReopen: true,
      independentCoordinator: true,
      nativePauseResume: true,
      nativeDialogEscape: true,
      nativeDialogFocusReturn: true,
      nativePcFilters: true,
      nativeGlobalToolManagers: true,
      nativeScanProgress: true,
      nativeSummaryDestination: true,
      nativeThemeSpacing: true,
      nativeGroupedProjects,
      nativeEvidenceSheet,
      nativeSettings: true,
      nativeSourceControl: true,
      nativeProjectSources: true,
      nativeAppearanceSync: true,
      nativeConnectionsFlow: true,
      nativeProjectSettings: true,
      nativeProjectActions: true,
      nativeKeybindings: true,
      nativeUpdatePanel: true,
      nativeTitleBar: true,
      nativeSettingsSearch: true,
      nativeSettingsBack: true,
      nativeDeviceDefaults: true,
      nativeWindowPreferences: true,
      nativeToasts: true,
      nativeClosedAccordions: true,
      nativeLogo: true,
    }),
  );
  app.quit();
}

function fail(error: unknown) {
  // Routine logs must not print private discovery tokens or selected filesystem paths.
  const message =
    "Versionstead desktop initialization failed. Check Node.js 24, data-directory access, and background host status.";
  console.error(message);
  // A launch from Explorer, Finder or the Dock has no visible console, so startup failures are shown.
  if (smoke)
    console.error(
      `Desktop smoke diagnostic: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  else if (!started) dialog.showErrorBox("Versionstead", message);
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void showWindow().catch(reopenFailed);
  });
  app.on("activate", () => {
    void showWindow().catch(reopenFailed);
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (!closingActions) {
      event.preventDefault();
      closingActions = true;
      if (preferencesTimer) clearTimeout(preferencesTimer);
      captureWindowPreferences();
      void Promise.all([
        projectActionRunner.close(),
        globalToolUpdateRunner.close(),
        persistWindowPreferences().catch(() =>
          console.error("Window preferences could not be saved."),
        ),
      ])
        .then(() => app.quit())
        .catch(fail);
      return;
    }
    quitting = true;
    if (notificationTimer) clearInterval(notificationTimer);
    tray?.destroy();
    // The independent coordinator intentionally outlives the user-session client.
  });
  void app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu()));
      windowPreferences = await loadWindowPreferences(app.getPath("userData"));
      nativeTheme.themeSource = windowPreferences.theme;
      nativeTheme.on("updated", syncWindowAppearance);
      if (smoke) console.log("Desktop smoke: native ready");
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      ipcMain.handle("versionstead:select-project-directory", async (event) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !trustedLocation(event.senderFrame.url)
        )
          throw new Error("Unauthorized directory request");
        const selected = await dialog.showOpenDialog(window, {
          title: "Select a project to monitor",
          properties: ["openDirectory"],
        });
        const path = selected.filePaths[0];
        if (selected.canceled || !path) return null;
        if (!isAbsolute(path) || !(await stat(path)).isDirectory())
          throw new Error("Select an existing directory");
        return realpath(path);
      });
      const assertActionSender = (event: Electron.IpcMainInvokeEvent) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !trustedLocation(event.senderFrame.url)
        )
          throw new Error("Unauthorized desktop request");
      };
      ipcMain.handle("versionstead:window-theme", async (event, input: unknown) => {
        assertActionSender(event);
        const theme = decodeWindowTheme(input);
        nativeTheme.themeSource = theme;
        windowPreferences = { ...windowPreferences, theme };
        syncWindowAppearance();
        await persistWindowPreferences();
      });
      for (const operation of ["start", "command"] as const)
        ipcMain.handle(
          `versionstead:global-tool-update-${operation}`,
          async (event, input: unknown) => {
            assertActionSender(event);
            const request = decodeGlobalToolUpdateRequest(input);
            const connected = await readyCoordinator();
            const inventory = connected?.snapshot.inventory;
            const item = inventory?.installations.find(
              (candidate) => candidate.id === request.installationId,
            );
            if (
              !connected ||
              !item ||
              item.version !== request.expectedVersion ||
              item.availableVersion !== request.targetVersion ||
              item.updateStatus !== "available"
            )
              throw new Error("This update changed. Scan this PC and review the current version.");
            if (
              inventory?.evidence.status === "scanning" ||
              connected.snapshot.scanProgress?.active?.kind === "pc" ||
              connected.snapshot.scanProgress?.queued.some((target) => target.kind === "pc")
            )
              throw new Error("Wait for the PC scan to finish before updating.");
            if (
              inventory?.evidence.status === "failed" ||
              inventory?.updateEvidence?.status === "failed"
            )
              throw new Error("Scan this PC successfully before updating a previous result.");
            return operation === "command"
              ? (await globalToolUpdateDependencies.resolve(item)).command
              : decodeGlobalToolUpdateRun(globalToolUpdateRunner.start(item));
          },
        );
      ipcMain.handle("versionstead:global-tool-update-status", (event) => {
        assertActionSender(event);
        return decodeGlobalToolUpdateRuns(globalToolUpdateRunner.read());
      });
      ipcMain.handle("versionstead:run-project-action", async (event, input: unknown) => {
        assertActionSender(event);
        let request;
        try {
          request = decodeRunActionRequest(input);
        } catch {
          throw new Error("Invalid project action request.");
        }
        const { projectId, actionId, expectedCommand } = request;
        const connected = await readyCoordinator();
        const project = connected?.snapshot.projects.find((p) => p.id === projectId);
        if (!project) throw new Error("This selected project is unavailable. Refresh and retry.");
        if (project.actions?.find((a) => a.id === actionId)?.command !== expectedCommand)
          throw new Error("This command changed. Refresh and review it before running.");
        return decodeActionRun(await projectActionRunner.start(project, actionId));
      });
      ipcMain.handle("versionstead:project-action-shell", async (event) => {
        assertActionSender(event);
        return decodeActionShell(await projectActionShell());
      });
      for (const operation of ["status", "stop"] as const)
        ipcMain.handle(`versionstead:project-action-${operation}`, async (event, id: unknown) => {
          assertActionSender(event);
          if (operation === "status" && typeof id === "object" && id !== null) {
            let request;
            try {
              request = decodeActionRequest(id);
            } catch {
              throw new Error("Invalid project action status request.");
            }
            const latest = projectActionRunner.latest(request.projectId, request.actionId);
            return latest ? decodeActionRun(latest) : null;
          }
          if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
            throw new Error("Invalid command identifier.");
          return decodeActionRun(
            operation === "stop"
              ? await projectActionRunner.stop(id)
              : projectActionRunner.read(id),
          );
        });
      runtime = (await ensureCoordinator()).runtime;
      if (smoke) console.log("Desktop smoke: coordinator ready");
      protocol.handle("versionstead", async (request) => {
        const url = new URL(request.url);
        const api = url.pathname.startsWith("/api/");
        if (
          !trustedLocation(request.url) ||
          !(api ? ["GET", "HEAD", "POST", "PATCH", "DELETE"] : ["GET", "HEAD"]).includes(
            request.method,
          )
        )
          return new Response("Forbidden", { status: 403 });
        // Pages and assets are this app's own build, read with the coordinator's allowlist and headers,
        // so a stopped coordinator never strands the window on an error page; only API calls go to it.
        if (!api) {
          if (smoke) requestedFiles.add(url.pathname);
          const found = await readWebFile(webRoot, url.pathname).catch(() => null);
          return new Response(found && request.method === "GET" ? found.content : null, {
            status: found ? 200 : 404,
            headers: {
              ...responseHeaders,
              ...(found ? { "Content-Type": found.contentType } : {}),
            },
          });
        }
        if (!runtime) runtime = (await readyCoordinator())?.runtime ?? null;
        if (!runtime) return new Response("Coordinator disconnected", { status: 503 });
        const removingProject =
          request.method === "DELETE"
            ? /^\/api\/projects\/([a-zA-Z0-9-]{1,100})$/.exec(url.pathname)?.[1]
            : undefined;
        if (removingProject) await projectActionRunner.stopProject(removingProject);
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer();
        if (body && body.byteLength > 64 * 1024)
          return new Response("Request too large", { status: 413 });
        // Only the renderer's revision tag is forwarded; 304 and ETag pass back unchanged.
        const ifNoneMatch = request.headers.get("If-None-Match");
        const response = await forwardRequest(
          (target, init) => net.fetch(target, init),
          `${runtime.origin}${url.pathname}${url.search}`,
          {
            method: request.method,
            headers: {
              Authorization: `Bearer ${runtime.token}`,
              ...(body ? { "Content-Type": "application/json" } : {}),
              ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}),
            },
            ...(body ? { body } : {}),
          },
          request.signal,
        );
        if (!response) {
          runtime = null;
          return new Response("Coordinator disconnected", { status: 503 });
        }
        if (
          response.ok &&
          request.method === "PATCH" &&
          /^\/api\/projects\/[a-zA-Z0-9-]{1,100}$/.test(url.pathname)
        )
          await updateTray();
        return response;
      });
      tray = new Tray(trayIcon());
      tray.on("click", () => {
        void showWindow().catch(reopenFailed);
      });
      tray.on("double-click", () => {
        void showWindow().catch(reopenFailed);
      });
      await updateTray();
      await createWindow();
      started = true;
      if (smoke) console.log("Desktop smoke: renderer loaded");
      if (smoke) await runSmoke();
      else {
        await pollNotifications();
        notificationTimer = setInterval(() => {
          void pollNotifications();
        }, 30_000);
      }
    })
    .catch(fail);
}
