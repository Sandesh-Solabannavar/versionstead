import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  session,
  shell,
  Tray,
} from "electron";
import { fileURLToPath } from "node:url";
import { stat, realpath, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  coordinatorRequest,
  ensureCoordinator,
  readyCoordinator,
  restartCoordinator,
  type CoordinatorRuntime,
} from "./coordinator.js";
import { externalAdvisoryUrl } from "./navigation.js";
import { decodeAcceptedResponse } from "@versionstead/contracts/monitoring";

const smoke = process.argv.includes("--smoke-test");
let runtime: CoordinatorRuntime | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let polling = false;
let notificationTimer: ReturnType<typeof setInterval> | undefined;
const presented = new Set<string>();
const pendingReceipts = new Set<string>();
const notifications = new Map<string, Notification>();
let notificationRuntimePid: number | null = null;

app.setName("Versionstead");
app.setAppUserModelId("Versionstead.Desktop");
if (process.env.VERSIONSTEAD_USER_DATA) app.setPath("userData", process.env.VERSIONSTEAD_USER_DATA);
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  { scheme: "versionstead", privileges: { standard: true, secure: true, supportFetchAPI: true } },
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
  if (!window || window.isDestroyed()) await createWindow();
  if (!window) return;
  if (path !== "/") await window.loadURL(`versionstead://app${path}`);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 680,
    minHeight: 520,
    title: "Versionstead",
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    const destination = externalAdvisoryUrl(url);
    if (destination && window && trustedLocation(window.webContents.getURL())) {
      void shell.openExternal(destination).catch(() => {
        dialog.showErrorBox(
          "Versionstead",
          "The advisory could not open. Check your default browser and retry.",
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
      pixels[index] = letter ? 255 : 70;
      pixels[index + 1] = letter ? 255 : 140;
      pixels[index + 2] = letter ? 255 : 42;
      pixels[index + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: 32, height: 32 });
}

async function updateTray() {
  const connected = await readyCoordinator();
  runtime = connected?.runtime ?? null;
  const paused = connected?.snapshot.settings.paused ?? false;
  tray?.setToolTip(
    `Versionstead — ${connected ? (paused ? "scans paused" : "monitoring") : "coordinator disconnected"}`,
  );
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Versionstead",
        click: () => {
          void showWindow().catch(fail);
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
          void ensureCoordinator()
            .then(() => updateTray())
            .catch(fail);
        },
      },
      {
        label: "Restart monitoring",
        enabled: runtime?.host === "session" && runtime.mode === "interactive",
        click: () => {
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
  if (result.response === 1) await action("/api/shutdown", "POST");
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
    if (!connected.snapshot.settings.notifyNewFindings) return;
    const summary = connected.snapshot.notificationSummary;
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
      presented.add(summary.id);
      pendingReceipts.add(summary.id);
      if (presented.size > 200) presented.delete(presented.values().next().value!);
      void acknowledgeSummary(connected.runtime, summary.id).catch(() => {});
    });
    notification.once("failed", () => notifications.delete(summary.id));
    notification.once("close", () => notifications.delete(summary.id));
    notification.once("click", () => {
      void showWindow(`/?filter=${summary.filter}`).catch(fail);
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
  const clickButton = async (label: string, click = true) => {
    if (!window) throw new Error("Smoke window unavailable");
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const check = () => {
        const button = [...document.querySelectorAll('button')].find(button => button.textContent?.includes(${JSON.stringify(label)}) && !button.disabled);
        if (button) { ${click ? "button.focus(); button.click();" : ""} resolve(true); }
        else if (Date.now() > deadline) reject(new Error('Expected native smoke action did not become available'));
        else setTimeout(check, 100);
      }; check();
    })`);
  };
  const initialPc = (await readyCoordinator())?.snapshot.inventory;
  const selectOption = async (label: string, option: string) => {
    if (!window) throw new Error("Smoke window unavailable");
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const trigger = document.querySelector('button[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
      if (!trigger) return reject(new Error('Native select unavailable'));
      trigger.click();
      const deadline = Date.now() + 5000;
      const choose = () => {
        const item = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent.trim() === ${JSON.stringify(option)});
        if (item) { item.click(); setTimeout(resolve, 100); }
        else if (Date.now() > deadline) reject(new Error('Native select option unavailable'));
        else setTimeout(choose, 50);
      }; choose();
    })`);
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
        initialPc?.installations.filter((item) => item.updateStatus === "available").length
    )
      throw new Error("This PC must default to confirmed update rows");
    await selectOption("Global tool update filter", "All global tools");
    const allRows: unknown = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('tbody tr')].map(row => ({ available: row.cells[2].textContent.trim(), check: row.cells[4].textContent.trim() }))
    `);
    const observations = allRows as { available: string; check: string }[];
    if (observations.length !== initialPc?.installations.length)
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
    const managerView = managerState as { managerCards: number; rows: number; text: string };
    if (
      managerView.managerCards !== initialPc.managers?.length ||
      managerView.rows !== initialPc.installations.filter((item) => item.manager === "bun").length
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
  const meter = progress as { label: string; value: string | null; max: string | null };
  if (
    !meter.label ||
    (meter.value !== null && (!meter.max || Number(meter.value) > Number(meter.max)))
  )
    throw new Error("Scan progress must be labeled and use bounded real counts");
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
  const themeSpacing: unknown = await window.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('.theme-button')];
    const rects = buttons.map(button => button.getBoundingClientRect());
    return buttons.length === 3 && rects.every(rect => rect.width >= 36 && rect.height >= 36) && rects.slice(1).every((rect, index) => rect.x - rects[index].right >= 8);
  })()`);
  if (themeSpacing !== true) throw new Error("Theme buttons must have separated hit targets");
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
      if (rows !== firstProject.dependencies.length)
        throw new Error("All dependencies must expose retained dependency records");
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
          const sizes = dimensions as { pageWidth: number; viewport: number; columns: number[] };
          if (sizes.pageWidth > sizes.viewport || (sizes.columns[0] ?? 0) > 320)
            throw new Error("Project table escapes its horizontal scroll container");
          console.log(JSON.stringify({ nativeProjectTable: dimensions }));
          if (width === 390)
            await writeFile(
              join(screenshotDirectory, "projects-narrow.png"),
              (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
            );
        }
        window.setContentSize(1440, 900);
        await window.webContents.executeJavaScript(`new Promise(resolve => {
          const button = document.querySelector('button[aria-label="Dark theme"]');
          if (!button) throw new Error('Appearance control unavailable');
          button.click();
          setTimeout(resolve, 250);
        })`);
        await writeFile(
          join(screenshotDirectory, "projects-dark.png"),
          (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(),
        );
        await window.webContents.executeJavaScript(`new Promise(resolve => {
          document.querySelector('button[aria-label="Light theme"]').click();
          setTimeout(resolve, 250);
        })`);
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
    }),
  );
  app.quit();
}

function fail(error: unknown) {
  // Routine logs must not print private discovery tokens or selected filesystem paths.
  console.error(
    "Versionstead desktop initialization failed. Check Node.js 24, data-directory access, and background host status.",
  );
  if (smoke)
    console.error(
      `Desktop smoke diagnostic: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) void showWindow().catch(fail);
  });
  app.on("activate", () => {
    void showWindow().catch(fail);
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
    if (notificationTimer) clearInterval(notificationTimer);
    tray?.destroy();
    // The independent coordinator intentionally outlives the user-session client.
  });
  void app
    .whenReady()
    .then(async () => {
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
        if (!runtime) runtime = (await readyCoordinator())?.runtime ?? null;
        if (!runtime) return new Response("Coordinator disconnected", { status: 503 });
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer();
        if (body && body.byteLength > 64 * 1024)
          return new Response("Request too large", { status: 413 });
        try {
          return await net.fetch(`${runtime.origin}${url.pathname}${url.search}`, {
            method: request.method,
            headers: {
              Authorization: `Bearer ${runtime.token}`,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body } : {}),
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          runtime = null;
          return new Response("Coordinator disconnected", { status: 503 });
        }
      });
      tray = new Tray(trayIcon());
      tray.on("click", () => {
        void showWindow().catch(fail);
      });
      tray.on("double-click", () => {
        void showWindow().catch(fail);
      });
      await updateTray();
      await createWindow();
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
