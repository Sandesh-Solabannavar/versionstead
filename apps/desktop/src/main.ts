import { app, BrowserWindow, net, protocol, session } from "electron";
import { fileURLToPath } from "node:url";
import { startServer } from "@versionstead/server";

const smoke = process.argv.includes("--smoke-test");
let coordinator: Awaited<ReturnType<typeof startServer>> | undefined;
let window: BrowserWindow | null = null;

app.setName("Versionstead");
if (process.env.VERSIONSTEAD_USER_DATA) app.setPath("userData", process.env.VERSIONSTEAD_USER_DATA);
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  { scheme: "versionstead", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

async function createWindow() {
  if (!coordinator) throw new Error("Coordinator is not running");
  window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 680,
    minHeight: 520,
    title: "Versionstead",
    show: !smoke,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    if (target.protocol !== "versionstead:" || target.host !== "app") event.preventDefault();
  });
  window.on("closed", () => {
    window = null;
  });
  await window.loadURL("versionstead://app/");
  if (smoke) {
    const result: unknown = await window.webContents
      .executeJavaScript(`new Promise((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Status UI did not connect')); }, 15000);
      const check = () => {
        const status = document.querySelector('[data-testid="connection-state"]');
        if (status?.getAttribute('data-state') === 'online') {
          clearTimeout(timer); observer.disconnect(); resolve({ title: document.title, connected: true });
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, attributes: true, childList: true });
      check();
    })`);
    console.log(JSON.stringify(result));
    app.quit();
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || smoke) app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(fail);
});
app.on("before-quit", () => {
  void coordinator?.close().catch(console.error);
});

function fail(error: unknown) {
  console.error(error);
  app.exit(1);
}

void app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    coordinator = await startServer({
      port: 0,
      webRoot: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
    });
    const origin = coordinator.origin;
    // A stable renderer origin preserves preferences even when the private server port changes.
    protocol.handle("versionstead", (request) => {
      const url = new URL(request.url);
      if (url.host !== "app" || (request.method !== "GET" && request.method !== "HEAD")) {
        return new Response("Forbidden", { status: 403 });
      }
      return net.fetch(`${origin}${url.pathname}${url.search}`, { method: request.method });
    });
    await createWindow();
  })
  .catch(fail);
