import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  decodeAcceptedResponse,
  decodeMonitoringProgress,
  decodeMonitoringSnapshot,
  type MonitoringProgress,
  type MonitoringSnapshot,
} from "@versionstead/contracts/monitoring";
import { actionKeys, settled, type ActionOptions } from "./monitoring-actions";
import { etagRevision, snapshotRequest, withProgress } from "./monitoring-poll";
import { reportError } from "./ui";

type Connection = "connecting" | "connected" | "disconnected" | "unauthorized";
type Decoder<T> = (value: unknown) => T;

class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Sends a coordinator request, throwing its error message; `304 Not Modified` returns null. */
export async function send(path: string, init: RequestInit = {}): Promise<Response | null> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  if (response.status === 304) return null;
  if (!response.ok) {
    let message = `Coordinator returned HTTP ${response.status}.`;
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
      )
        message = body.error;
    } catch {
      // An HTTP error can have no JSON body.
    }
    throw new RequestError(message, response.status);
  }
  return response;
}

/** Decodes a coordinator JSON body; a malformed body means a mismatched coordinator version. */
export function decodeBody<T>(text: string, decoder: Decoder<T>): T {
  try {
    return decoder(JSON.parse(text));
  } catch {
    throw new Error(
      "The coordinator returned an unexpected response. Reconnect to a matching Versionstead version.",
    );
  }
}

export async function request<T>(
  path: string,
  decoder: Decoder<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await send(path, init);
  // Only conditional requests receive 304; an empty body fails decoding.
  return decodeBody((await response?.text()) ?? "", decoder);
}

function subscribeVisibility(change: () => void) {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
}

/** Whether the page is visible; coordinator polling pauses while it is hidden. */
export function usePageVisible() {
  return useSyncExternalStore(subscribeVisibility, () => !document.hidden);
}

type MonitoringContext = {
  snapshot: MonitoringSnapshot | null;
  connection: Connection;
  refreshing: boolean;
  /** Whether any action is running. A control that belongs to one action checks `pending`. */
  busy: boolean;
  /** The keys of the actions running; an action without a key is pending under its path. */
  pending: ReadonlySet<string>;
  /** Why the coordinator cannot be read; a failed action is reported by `mutate` itself. */
  connectionError: string | null;
  notice: string | null;
  refresh: () => Promise<void>;
  /**
   * Sends a change and reads the result back. A failure raises a toast and returns null, unless the
   * caller passes `onError` to show the message itself, in its own dialog.
   */
  mutate: <T>(
    path: string,
    body: unknown,
    decoder: Decoder<T>,
    message: string,
    method?: string,
    options?: ActionOptions,
  ) => Promise<T | null>;
  authenticate: (token: string, onError?: (message: string) => void) => Promise<boolean>;
};

const Context = createContext<MonitoringContext | null>(null);

export function MonitoringProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [progress, setProgress] = useState<MonitoringProgress | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [refreshing, setRefreshing] = useState(false);
  // One entry per running action, so overlapping actions with the same key stay pending together.
  const [pendingKeys, setPendingKeys] = useState<readonly string[]>([]);
  const pending = useMemo(() => new Set(pendingKeys), [pendingKeys]);
  const busy = pendingKeys.length > 0;
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const readController = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const latest = useRef<{
    snapshot: MonitoringSnapshot | null;
    etag: string | null;
    progress: MonitoringProgress | null;
    progressText: string | null;
  }>({ snapshot: null, etag: null, progress: null, progressText: null });
  // Set when an older coordinator has no progress endpoint; an explicit refresh probes again.
  const legacy = useRef(false);
  const visible = usePageVisible();
  const display = useMemo(() => withProgress(snapshot, progress), [snapshot, progress]);
  const pollInterval =
    display?.scanProgress?.active ||
    display?.scanProgress?.queued.length ||
    display?.inventory.evidence.status === "scanning" ||
    display?.projects.some((project) => project.evidence.status === "scanning")
      ? 1_000
      : 5_000;

  // Polls read live progress and fetch the large snapshot only when its revision changes.
  const reload = useCallback(async (force: boolean) => {
    if (!force && readController.current) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const current = ++sequence.current;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    const { signal } = controller;
    const previous = latest.current;
    if (force) {
      legacy.current = false;
      setRefreshing(true);
    }
    try {
      let progressText: string | null = null;
      if (!legacy.current)
        try {
          const response = await send("/api/monitoring/progress", { signal });
          progressText = (await response?.text()) ?? null;
        } catch (failure) {
          if (!(failure instanceof RequestError && failure.status === 404)) throw failure;
          legacy.current = true;
        }
      const nextProgress =
        progressText === null
          ? null
          : progressText === previous.progressText
            ? previous.progress
            : decodeBody(progressText, decodeMonitoringProgress);
      let { snapshot: nextSnapshot, etag } = previous;
      const headers = snapshotRequest(previous, nextProgress, force);
      if (headers) {
        const response = await send("/api/monitoring", { signal, headers });
        if (response) {
          nextSnapshot = decodeBody(await response.text(), decodeMonitoringSnapshot);
          etag = etagRevision(response.headers.get("ETag"));
        }
      }
      if (current !== sequence.current) return;
      latest.current = { snapshot: nextSnapshot, etag, progress: nextProgress, progressText };
      // Unchanged progress text and revision leave state, and every consumer, untouched.
      if (nextSnapshot !== previous.snapshot) setSnapshot(nextSnapshot);
      if (nextProgress !== previous.progress) setProgress(nextProgress);
      setConnection("connected");
      setConnectionError(null);
    } catch (failure) {
      if (current !== sequence.current) return;
      setConnection(
        failure instanceof RequestError && failure.status === 401 ? "unauthorized" : "disconnected",
      );
      setConnectionError(
        controller.signal.aborted
          ? "The coordinator took too long to respond."
          : failure instanceof Error
            ? failure.message
            : "The coordinator could not be reached.",
      );
    } finally {
      window.clearTimeout(timeout);
      if (current === sequence.current) {
        readController.current = null;
        if (force) setRefreshing(false);
      }
    }
  }, []);
  const refresh = useCallback(() => reload(true), [reload]);
  const cancelRead = useCallback(() => {
    sequence.current++;
    readController.current?.abort();
    readController.current = null;
  }, []);

  useEffect(() => cancelRead, [cancelRead]);

  // Polling pauses while the page is hidden; it reads at once on load and when visible again.
  useEffect(() => {
    if (!visible) return;
    const initial = window.setTimeout(() => {
      void reload(false);
    }, 0);
    return () => window.clearTimeout(initial);
  }, [reload, visible]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => {
      void reload(false);
    }, pollInterval);
    return () => window.clearInterval(timer);
  }, [reload, pollInterval, visible]);

  const mutate = useCallback(
    async <T,>(
      path: string,
      body: unknown,
      decoder: Decoder<T>,
      message: string,
      method = "POST",
      { key = path, onError }: ActionOptions = {},
    ) => {
      // The key stays pending through the read-back, so its control waits for the fresh state.
      setPendingKeys((keys) => [...keys, key]);
      setNotice(null);
      try {
        const result = await request(path, decoder, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        setNotice(message);
        await refresh();
        return result;
      } catch (failure) {
        const unauthorized = failure instanceof RequestError && failure.status === 401;
        if (unauthorized) setConnection("unauthorized");
        const text =
          failure instanceof Error ? failure.message : "The action could not be completed.";
        // Shown once: in the caller's own dialog when it asks, else as a toast. The access-code
        // prompt that follows a 401 needs no toast.
        if (onError) onError(text);
        else if (!unauthorized) reportError(text);
        return null;
      } finally {
        setPendingKeys((keys) => settled(keys, key));
      }
    },
    [refresh],
  );

  const authenticate = useCallback(
    async (token: string, onError?: (message: string) => void) => {
      const result = await mutate(
        "/api/session",
        { token },
        decodeAcceptedResponse,
        "Connected to your local coordinator.",
        "POST",
        { key: actionKeys.session, onError },
      );
      return result !== null;
    },
    [mutate],
  );

  const value = useMemo(
    () => ({
      snapshot: display,
      connection,
      refreshing,
      busy,
      pending,
      connectionError,
      notice,
      refresh,
      mutate,
      authenticate,
    }),
    [
      display,
      connection,
      refreshing,
      busy,
      pending,
      connectionError,
      notice,
      refresh,
      mutate,
      authenticate,
    ],
  );
  return <Context value={value}>{children}</Context>;
}

export function useMonitoring() {
  const context = useContext(Context);
  if (!context) throw new Error("Monitoring provider is missing.");
  return context;
}
