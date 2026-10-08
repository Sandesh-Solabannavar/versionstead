import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import {
  decodeApplicationSnapshot,
  type ApplicationSnapshot,
  type SshTarget,
} from "@versionstead/contracts/application";
import { decodeBody, request, send, useMonitoring, usePageVisible } from "./monitoring";
import type { ActionOptions } from "./monitoring-actions";
import { toast } from "./components/ui/toast";

const Context = createContext<{
  snapshot: ApplicationSnapshot | null;
  error: string | null;
  refresh: () => Promise<void>;
  discovering: boolean;
  discover: () => Promise<void>;
  connectComputer: (invitation: string, ssh?: SshTarget) => Promise<void>;
  change: (
    path: string,
    body: unknown,
    message: string,
    method?: string,
    options?: ActionOptions,
  ) => Promise<ApplicationSnapshot | null>;
} | null>(null);

export function ApplicationProvider({ children }: { children: ReactNode }) {
  const { connection, mutate } = useMonitoring();
  const visible = usePageVisible();
  const [snapshot, setSnapshot] = useState<ApplicationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const discovery = useRef<Promise<void> | null>(null);
  // The last polled body; other snapshot updates clear it so the next poll applies.
  const polled = useRef<string | null>(null);
  const discover = useCallback(() => {
    if (discovery.current) return discovery.current;
    setDiscovering(true);
    discovery.current = (async () => {
      try {
        const value = await request("/api/application/discover", decodeApplicationSnapshot, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(30000),
        });
        polled.current = null;
        setSnapshot(value);
        setError(null);
        toast.add({
          id: "action-feedback",
          title: "Source control status refreshed.",
          type: "success",
        });
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : "Source control could not be refreshed.",
        );
      } finally {
        setDiscovering(false);
        discovery.current = null;
      }
    })();
    return discovery.current;
  }, []);
  const refresh = useCallback(async () => {
    try {
      const response = await send("/api/application", { signal: AbortSignal.timeout(15000) });
      const text = (await response?.text()) ?? "";
      // An unchanged body keeps the current snapshot and its consumers untouched.
      if (text !== polled.current) {
        setSnapshot(decodeBody(text, decodeApplicationSnapshot));
        polled.current = text;
      }
      setError(null);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Application settings could not be read.",
      );
    }
  }, []);
  // Polling pauses while the page is hidden and reads at once when it becomes visible again.
  useEffect(() => {
    if (connection !== "connected" || !visible) return;
    const initial = window.setTimeout(() => {
      void refresh();
    }, 0);
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [connection, refresh, visible]);
  const change = useCallback(
    async (
      path: string,
      body: unknown,
      message: string,
      method = "POST",
      options?: ActionOptions,
    ) => {
      polled.current = null;
      if (path === "update")
        setSnapshot((previous) =>
          previous
            ? { ...previous, update: { ...previous.update, status: "checking", error: null } }
            : previous,
        );
      const result = await mutate(
        `/api/application/${path}`,
        body,
        decodeApplicationSnapshot,
        message,
        method,
        options,
      );
      if (result) setSnapshot(result);
      else await refresh();
      return result;
    },
    [mutate, refresh],
  );
  const connectComputer = useCallback(async (invitation: string, ssh?: SshTarget) => {
    const result = await request("/api/application/computers", decodeApplicationSnapshot, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitation, ...(ssh ? { ssh } : {}) }),
      signal: AbortSignal.timeout(45000),
    });
    polled.current = null;
    setSnapshot(result);
    setError(null);
    toast.add({ id: "action-feedback", title: "Remote environment connected.", type: "success" });
  }, []);
  const value = useMemo(
    () => ({ snapshot, error, refresh, change, discover, discovering, connectComputer }),
    [snapshot, error, refresh, change, discover, discovering, connectComputer],
  );
  return <Context value={value}>{children}</Context>;
}
export function useApplication() {
  const value = useContext(Context);
  if (!value) throw new Error("Application provider is missing.");
  return value;
}
