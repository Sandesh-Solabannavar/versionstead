import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { MonitoringCoordinator } from "./monitoring.ts";
import {
  acquireCoordinatorLock,
  DEV_ORIGIN,
  removeRuntime,
  resolveDataDir,
  writeRuntime,
} from "./runtime.ts";
import { startServer } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4318" },
    "data-dir": { type: "string" },
    "web-root": { type: "string" },
    mode: { type: "string", default: "interactive" },
    host: { type: "string", default: "session" },
    "dev-origin": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Versionstead coordinator\nUsage: node apps/server/dist/bin.js [--port 4318] [--data-dir ABSOLUTE] [--mode interactive|background] [--host session|boot-task|unconfigured] [--web-root ABSOLUTE]\nLoopback only. Use pnpm run access for browser access.",
  );
} else {
  let release: (() => void) | undefined;
  let coordinator: MonitoringCoordinator | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let dataDir: string | undefined;
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    try {
      try {
        await server?.close();
      } finally {
        try {
          await coordinator?.close();
        } finally {
          if (dataDir) await removeRuntime(dataDir);
        }
      }
    } finally {
      release?.();
    }
  };
  try {
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("Port must be an integer between 0 and 65535");
    }
    if (values.mode !== "interactive" && values.mode !== "background")
      throw new Error("Invalid coordinator mode");
    if (values.host !== "session" && values.host !== "boot-task" && values.host !== "unconfigured")
      throw new Error("Invalid coordinator host");
    if (values["data-dir"] && !isAbsolute(values["data-dir"]))
      throw new Error("Data directory must be absolute");
    if (values["web-root"] && !isAbsolute(values["web-root"]))
      throw new Error("Web root must be absolute");
    if (values["dev-origin"] && values["dev-origin"] !== DEV_ORIGIN)
      throw new Error("Invalid development origin");
    dataDir = values["data-dir"] ? resolve(values["data-dir"]) : resolveDataDir();
    release = acquireCoordinatorLock(dataDir);
    coordinator = new MonitoringCoordinator({ dataDir, mode: values.mode, host: values.host });
    const token = randomBytes(32).toString("base64url");
    server = await startServer({
      port,
      webRoot: values["web-root"] ?? fileURLToPath(new URL("../../web/dist/", import.meta.url)),
      monitoring: coordinator,
      authToken: token,
      ...(values["dev-origin"] ? { devOrigin: values["dev-origin"] } : {}),
      onShutdown: () => {
        void stop().catch(() => {
          process.exitCode = 1;
        });
      },
    });
    await writeRuntime(dataDir, {
      origin: server.origin,
      pid: process.pid,
      token,
      mode: values.mode,
      host: values.host,
      ...(values["dev-origin"] ? { devOrigin: values["dev-origin"] } : {}),
    });
    console.log(`Versionstead coordinator: ${server.origin}`);
    const signalStop = () => {
      void stop().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", signalStop);
    process.once("SIGTERM", signalStop);
  } catch (error) {
    console.error(
      error instanceof Error &&
        /^(A coordinator already|Port must|Invalid |Data directory must|Web root must)/.test(
          error.message,
        )
        ? error.message
        : "Versionstead could not start. Check the local data directory and Node 24 runtime.",
    );
    await stop();
    process.exitCode = 1;
  }
}
