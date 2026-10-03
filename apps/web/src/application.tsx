import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useState,
  useRef,
  type ReactNode,
} from "react";
import {
  decodeApplicationSnapshot,
  type ApplicationSnapshot,
  type SshTarget,
} from "@versionstead/contracts/application";
import { request, useMonitoring } from "./monitoring";
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
  ) => Promise<ApplicationSnapshot | null>;
} | null>(null);

export function ApplicationProvider({ children }: { children: ReactNode }) {
  const { connection, mutate } = useMonitoring();
  const [snapshot, setSnapshot] = useState<ApplicationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const discovery = useRef<Promise<void> | null>(null);
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
      const value = await request("/api/application", decodeApplicationSnapshot, {
        signal: AbortSignal.timeout(15000),
      });
      setSnapshot(value);
      setError(null);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Application settings could not be read.",
      );
    }
  }, []);
  useEffect(() => {
    if (connection !== "connected") return;
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
  }, [connection, refresh]);
  const change = useCallback(
    async (path: string, body: unknown, message: string, method = "POST") => {
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
    setSnapshot(result);
    setError(null);
    toast.add({ id: "action-feedback", title: "Remote environment connected.", type: "success" });
  }, []);
  return (
    <Context value={{ snapshot, error, refresh, change, discover, discovering, connectComputer }}>
      {children}
    </Context>
  );
}
export function useApplication() {
  const value = useContext(Context);
  if (!value) throw new Error("Application provider is missing.");
  return value;
}
