import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  decodeAcceptedResponse,
  decodeMonitoringSnapshot,
  type MonitoringSnapshot,
} from "@versionstead/contracts/monitoring";

type Connection = "connecting" | "connected" | "disconnected" | "unauthorized";
type Decoder<T> = (value: unknown) => T;

class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, decoder: Decoder<T>, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
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
  try {
    return decoder(await response.json());
  } catch {
    throw new Error(
      "The coordinator returned an unexpected response. Reconnect to a matching Versionstead version.",
    );
  }
}

type MonitoringContext = {
  snapshot: MonitoringSnapshot | null;
  connection: Connection;
  refreshing: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  refresh: () => Promise<void>;
  mutate: <T>(
    path: string,
    body: unknown,
    decoder: Decoder<T>,
    message: string,
    method?: string,
  ) => Promise<T | null>;
  authenticate: (token: string) => Promise<boolean>;
};

const Context = createContext<MonitoringContext | null>(null);

export function MonitoringProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const readController = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const pollInterval =
    snapshot?.scanProgress?.active ||
    snapshot?.scanProgress?.queued.length ||
    snapshot?.inventory.evidence.status === "scanning" ||
    snapshot?.projects.some((project) => project.evidence.status === "scanning")
      ? 1_000
      : 5_000;

  const reload = useCallback(async (force: boolean) => {
    if (!force && readController.current) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const current = ++sequence.current;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setRefreshing(true);
    try {
      const next = await request("/api/monitoring", decodeMonitoringSnapshot, {
        signal: controller.signal,
      });
      if (current !== sequence.current) return;
      setSnapshot(next);
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
        setRefreshing(false);
      }
    }
  }, []);
  const refresh = useCallback(() => reload(true), [reload]);
  const cancelRead = useCallback(() => {
    sequence.current++;
    readController.current?.abort();
    readController.current = null;
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(initial);
      cancelRead();
    };
  }, [refresh, cancelRead]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void reload(false);
    }, pollInterval);
    return () => window.clearInterval(timer);
  }, [reload, pollInterval]);

  const mutate = useCallback(
    async <T,>(
      path: string,
      body: unknown,
      decoder: Decoder<T>,
      message: string,
      method = "POST",
    ) => {
      setBusy(true);
      setError(null);
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
        if (failure instanceof RequestError && failure.status === 401)
          setConnection("unauthorized");
        setError(failure instanceof Error ? failure.message : "The action could not be completed.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const authenticate = useCallback(
    async (token: string) => {
      const result = await mutate(
        "/api/session",
        { token },
        decodeAcceptedResponse,
        "Connected to your local coordinator.",
      );
      return result !== null;
    },
    [mutate],
  );

  return (
    <Context
      value={{
        snapshot,
        connection,
        refreshing,
        busy,
        error: error ?? connectionError,
        notice,
        refresh,
        mutate,
        authenticate,
      }}
    >
      {children}
    </Context>
  );
}

export function useMonitoring() {
  const context = useContext(Context);
  if (!context) throw new Error("Monitoring provider is missing.");
  return context;
}
