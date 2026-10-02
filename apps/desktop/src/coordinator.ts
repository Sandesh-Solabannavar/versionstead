import { execFile, spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { acquireCoordinatorLock, readRuntime, resolveDataDir } from "@versionstead/server/runtime";
import {
  decodeAcceptedResponse,
  decodeMonitoringSnapshot,
} from "@versionstead/contracts/monitoring";
import { decodeStatus } from "@versionstead/contracts/status";
import { discoverGlobalToolSources } from "../../server/dist/adapters/inventory.js";

const run = promisify(execFile);
export const dataDir = resolveDataDir();
export type CoordinatorRuntime = NonNullable<Awaited<ReturnType<typeof readRuntime>>>;
let connecting: ReturnType<typeof connectCoordinator> | undefined;

export async function coordinatorRequest(
  runtime: CoordinatorRuntime,
  path: string,
  init: RequestInit = {},
) {
  return fetch(`${runtime.origin}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
      Authorization: `Bearer ${runtime.token}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

export async function readyCoordinator() {
  const runtime = await readRuntime(dataDir);
  if (!runtime) return null;
  try {
    const [status, response] = await Promise.all([
      coordinatorRequest(runtime, "/api/status"),
      coordinatorRequest(runtime, "/api/monitoring"),
    ]);
    if (!status.ok || !response.ok) return null;
    decodeStatus(await status.json());
    const snapshot = decodeMonitoringSnapshot(await response.json());
    return { runtime, snapshot };
  } catch {
    return null;
  }
}

async function nodeExecutable() {
  const configured = process.env.VERSIONSTEAD_NODE_EXECUTABLE;
  if (configured && !isAbsolute(configured))
    throw new Error("VERSIONSTEAD_NODE_EXECUTABLE must be absolute");
  const candidates = configured
    ? [configured]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, process.platform === "win32" ? "node.exe" : "node"));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const executable = await realpath(candidate);
      const { stdout } = await run(
        executable,
        ["-e", "require('node:sqlite'); process.stdout.write(String(process.versions.node))"],
        {
          timeout: 5_000,
          maxBuffer: 1_024,
          windowsHide: true,
        },
      );
      if (stdout.trim().split(".")[0] === "24") return executable;
    } catch {
      // Try the next PATH entry. Never execute a shell to resolve an executable.
    }
  }
  throw new Error(
    "Node.js 24 with SQLite support is required. Set VERSIONSTEAD_NODE_EXECUTABLE to its absolute executable path.",
  );
}

export function ensureCoordinator() {
  return connectOnce(false);
}

export function restartCoordinator() {
  return connectOnce(true);
}

function connectOnce(restart: boolean) {
  connecting ??= connectCoordinator(restart)
    .then(syncOwnerSources)
    .finally(() => {
      connecting = undefined;
    });
  return connecting;
}

async function syncOwnerSources(
  connected: NonNullable<Awaited<ReturnType<typeof readyCoordinator>>>,
) {
  if (
    connected.runtime.host !== "boot-task" ||
    connected.snapshot.inventory.collector !== "npm-bun-global-v1"
  )
    return connected;
  try {
    const sources = await discoverGlobalToolSources();
    const response = await coordinatorRequest(connected.runtime, "/api/global-tools/sources", {
      method: "POST",
      body: JSON.stringify({ sources }),
    });
    if (response.ok)
      return {
        runtime: connected.runtime,
        snapshot: decodeMonitoringSnapshot(await response.json()),
      };
  } catch {
    // Retain the boot host's saved owner locations when discovery or access is unavailable.
  }
  return connected;
}

async function connectCoordinator(restart: boolean) {
  const existing = await readyCoordinator();
  if (!existing) {
    const descriptor = await readRuntime(dataDir);
    if (descriptor && (descriptor.host !== "session" || descriptor.mode !== "interactive"))
      throw new Error("Restart this coordinator through its Windows background host.");
  }
  if (existing) {
    const session = existing.runtime.host === "session" && existing.runtime.mode === "interactive";
    const current =
      existing.snapshot.scanProgress &&
      existing.snapshot.inventory.collector === "npm-bun-global-v1";
    if (!restart && (current || !session)) return existing;
    if (!session) throw new Error("Restart this coordinator through its Windows background host.");
  }
  const executable = await nodeExecutable();
  const entry = fileURLToPath(new URL("../../server/dist/bin.js", import.meta.url));
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  await Promise.all([
    access(entry, constants.R_OK),
    access(join(webRoot, "index.html"), constants.R_OK),
  ]);
  if (existing) {
    const response = await coordinatorRequest(existing.runtime, "/api/shutdown", {
      method: "POST",
      body: "{}",
    });
    if (!response.ok) throw new Error("The coordinator rejected the restart.");
    decodeAcceptedResponse(await response.json());
    const deadline = Date.now() + 30_000;
    while (true) {
      if ((await readRuntime(dataDir))?.pid !== existing.runtime.pid) {
        const replacement = await readyCoordinator();
        if (replacement) return replacement;
        try {
          const release = acquireCoordinatorLock(dataDir);
          release();
          break;
        } catch {
          // Descriptor removal can precede the old writer releasing its SQLite lock.
        }
      }
      if (Date.now() >= deadline) throw new Error("The coordinator did not finish stopping.");
      await delay(200);
    }
  }
  const child = spawn(
    executable,
    [
      entry,
      "--data-dir",
      dataDir,
      "--port",
      "0",
      "--mode",
      "interactive",
      "--host",
      "session",
      "--web-root",
      webRoot,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  let spawnFailed = false;
  child.on("error", () => {
    spawnFailed = true;
  });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (spawnFailed) break;
    const connected = await readyCoordinator();
    if (connected) return connected;
    await delay(200);
  }
  throw new Error(
    "The independent coordinator did not become ready. Check Node.js, data-directory access, and the background host status.",
  );
}
