import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquireCoordinatorLock, readRuntime, resolveDataDir } from "@versionstead/server/runtime";
import {
  decodeAcceptedResponse,
  decodeMonitoringProgress,
  decodeMonitoringSnapshot,
  type MonitoringProgress,
  type MonitoringSettings,
  type NotificationSummary,
  type Project,
} from "@versionstead/contracts/monitoring";
import { decodeStatus } from "@versionstead/contracts/status";
import { discoverGlobalToolSources } from "../../server/dist/adapters/inventory.js";
import { inspectNode, toolDirectories } from "../../server/dist/adapters/tool-paths.js";

export const dataDir = resolveDataDir();
/** The built web app, which a session coordinator serves and the desktop window loads. */
export const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
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

/** Forwards a renderer request with its own signal and a 120 s cap. A slow or abandoned request keeps
 * the coordinator attached and answers 504; null means the connection itself failed. */
export async function forwardRequest(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs = 120_000,
): Promise<Response | null> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    return await fetcher(url, { ...init, signal: bounded });
  } catch {
    return bounded.aborted
      ? new Response("The coordinator took too long to respond.", { status: 504 })
      : null;
  }
}

/** Replace an unreachable coordinator only while its descriptor names an interactive session host (a
 * crash or kill leaves it; graceful stops remove it), never after the owner chose Stop monitoring,
 * and at most once a minute. Boot/background hosts are never replaced. */
export function shouldRecoverCoordinator(
  descriptor: Pick<CoordinatorRuntime, "host" | "mode"> | null,
  ownerStopped: boolean,
  lastAttempt: number,
  now: number,
) {
  return (
    !ownerStopped &&
    descriptor?.host === "session" &&
    descriptor.mode === "interactive" &&
    now - lastAttempt >= 60_000
  );
}

/** How the owner restarts a boot/background host, which the desktop never replaces. */
export function backgroundRestartMessage(platform: NodeJS.Platform = process.platform) {
  return platform === "win32"
    ? "Restart this coordinator through its Windows background host."
    : "Restart this coordinator with node scripts/background-host.mjs restart.";
}

/** The Stop monitoring dialog's detail: what happens to startup registration afterwards. */
export function stopMonitoringDetail(
  host: CoordinatorRuntime["host"],
  platform: NodeJS.Platform = process.platform,
) {
  if (host !== "boot-task") return "Use Start monitoring to resume.";
  if (platform === "darwin")
    return "The LaunchAgent stays installed and starts again at your next login.";
  if (platform === "linux")
    return "The systemd user service stays enabled and starts again at your next login, or at boot with lingering.";
  return "Windows startup registration stays installed; the task can start again at the next boot.";
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

/** What the tray and notifier keep between polls. */
export type TrayCache = {
  /** The ETag of the snapshot `projects` came from; null when none was read or it sent none. */
  tag: string | null;
  settings: MonitoringSettings;
  /** Each project's id and actions as of `tag`; null until a poll needed them. */
  projects: readonly Pick<Project, "id" | "actions">[] | null;
};
export type CoordinatorPoll = TrayCache & {
  runtime: CoordinatorRuntime;
  notificationSummary: NotificationSummary | null;
};

/**
 * Headers for the snapshot read behind a poll, or null when the cached copy is still current.
 * Without a cached tag or progress (the first poll, or an older coordinator) the read is
 * unconditional.
 */
export function snapshotHeaders(
  cachedTag: string | null,
  progress: Pick<MonitoringProgress, "revision"> | null,
): Record<string, string> | null {
  if (!cachedTag || !progress) return {};
  return cachedTag === `"${progress.revision}"` ? null : { "If-None-Match": cachedTag };
}

/**
 * The tray and notification poll. Progress is tiny and carries the settings, so the snapshot
 * (megabytes at the 50-project cap) is read only while a project command needs the current project
 * actions (`needProjects`), and then only when its revision differs from `previous`. A coordinator
 * whose progress has no settings (before v8) is read when the revision changes, and one without the
 * progress endpoint (404) in full each time.
 *
 * ponytail: while a project command runs, each durable change, such as a scan starting or
 * finishing, costs the next poll one snapshot read; carry project actions in progress if that
 * matters at the 50-project cap.
 */
export async function pollCoordinator(
  previous: TrayCache | null,
  needProjects = false,
): Promise<CoordinatorPoll | null> {
  const runtime = await readRuntime(dataDir);
  if (!runtime) return null;
  try {
    const [status, live] = await Promise.all([
      coordinatorRequest(runtime, "/api/status"),
      coordinatorRequest(runtime, "/api/monitoring/progress"),
    ]);
    if (!status.ok || (!live.ok && live.status !== 404)) return null;
    decodeStatus(await status.json());
    const progress = live.ok ? decodeMonitoringProgress(await live.json()) : null;
    let cache = previous;
    let notificationSummary = progress?.notificationSummary ?? null;
    const headers =
      needProjects || !progress?.settings ? snapshotHeaders(previous?.tag ?? null, progress) : null;
    if (headers) {
      const response = await coordinatorRequest(runtime, "/api/monitoring", { headers });
      if (response.status === 200) {
        const snapshot = decodeMonitoringSnapshot(await response.json());
        cache = {
          tag: response.headers.get("ETag"),
          settings: snapshot.settings,
          projects: snapshot.projects.map(({ id, actions }) => ({
            id,
            ...(actions && { actions }),
          })),
        };
        if (!progress) notificationSummary = snapshot.notificationSummary ?? null;
      } else if (response.status !== 304) return null;
    }
    // Without settings in progress, the snapshot was read or the cached one is current.
    const settings = progress?.settings ?? cache?.settings;
    if (!settings) return null;
    return {
      tag: cache?.tag ?? null,
      settings,
      projects: cache?.projects ?? null,
      runtime,
      notificationSummary,
    };
  } catch {
    return null;
  }
}

export async function nodeExecutable() {
  const configured = process.env.VERSIONSTEAD_NODE_EXECUTABLE;
  if (configured && !isAbsolute(configured))
    throw new Error("VERSIONSTEAD_NODE_EXECUTABLE must be absolute");
  const candidates = configured
    ? [configured]
    : toolDirectories().map((directory) =>
        join(directory, process.platform === "win32" ? "node.exe" : "node"),
      );
  for (const candidate of candidates) {
    // Never a shell. A candidate may be a Volta, mise or snap shim, so start the Node that it reports.
    const node = await inspectNode(candidate, { sqlite: true });
    if (node?.version.split(".")[0] === "24") return node.execPath;
  }
  throw new Error(
    "Node.js 24 with SQLite support is required. Set VERSIONSTEAD_NODE_EXECUTABLE to its absolute executable path.",
  );
}

export function ensureCoordinator() {
  return connectOnce(false);
}

let lastRecovery = -Infinity;
/** Restarts a crashed or killed interactive session coordinator through ensureCoordinator(). */
export async function recoverCoordinator(
  ownerStopped: boolean,
  now = performance.now(),
  ensure: typeof ensureCoordinator = ensureCoordinator,
) {
  if (!shouldRecoverCoordinator(await readRuntime(dataDir), ownerStopped, lastRecovery, now))
    return null;
  lastRecovery = now;
  let release;
  try {
    release = acquireCoordinatorLock(dataDir);
  } catch {
    return null; // A live owner holds the lock, including a hung or gracefully stopping one.
  }
  // A graceful stop removes runtime.json before releasing the lock; a crash or kill leaves it.
  const crashed = existsSync(join(dataDir, "runtime.json"));
  release();
  return crashed ? ensure() : null;
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
      throw new Error(backgroundRestartMessage());
  }
  if (existing) {
    const session = existing.runtime.host === "session" && existing.runtime.mode === "interactive";
    const current =
      existing.snapshot.scanProgress &&
      existing.snapshot.features === "settings-repositories-connections-v9" &&
      existing.snapshot.inventory.collector === "npm-bun-global-v1";
    if (!restart && (current || !session)) return existing;
    if (!session) throw new Error(backgroundRestartMessage());
  }
  const executable = await nodeExecutable();
  const entry = fileURLToPath(new URL("../../server/dist/bin.js", import.meta.url));
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
