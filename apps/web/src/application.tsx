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
  decodeComputerSnapshot,
  type ApplicationSnapshot,
  type SshTarget,
} from "@versionstead/contracts/application";
import type { MonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { staleEvidence } from "./computer-evidence";
import { decodeBody, request, send, useMonitoring, usePageVisible } from "./monitoring";
import type { ActionOptions } from "./monitoring-actions";
import { toast } from "./components/ui/toast";

/** What each paired PC last sent, with the digest it was read under. */
type ComputerEvidence = ReadonlyMap<string, { digest: string; snapshot: MonitoringSnapshot }>;

const Context = createContext<{
  snapshot: ApplicationSnapshot | null;
  /**
   * Looked up by the id of a connected PC. A PC missing here has sent nothing, or its evidence is
   * still being read or could not be read; an entry of a PC since removed is never looked up.
   */
  computerEvidence: ComputerEvidence;
  /** The digest of each PC's evidence that could not be read; see latestEvidence(). */
  unreadableEvidence: ReadonlyMap<string, string>;
  /** Reads a PC's evidence again after its read failed. */
  retryEvidence: (id: string) => void;
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
  const [computerEvidence, setComputerEvidence] = useState<ComputerEvidence>(new Map());
  const [unreadableEvidence, setUnreadableEvidence] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  // The digest last asked for each PC. A digest is asked for once (a failed or empty answer marks it
  // unreadable instead), and only the newest request of a PC may store what it receives.
  const reading = useRef(new Map<string, string>());
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
  // The polled read carries each PC's evidence digest, not the evidence. The evidence is read when its
  // digest is new: on load, after the PC's own refresh, and when the coordinator's 30-second refresh
  // found changes. A read that fails is shown with a Retry and is not repeated by itself.
  // ponytail: a failed read runs again only on Retry or when newer evidence arrives, even once a
  // lost coordinator connection returns; retry on a bounded timer if transient failures linger.
  useEffect(() => {
    if (!snapshot || connection !== "connected") return;
    for (const { id, snapshotDigest } of staleEvidence(
      snapshot.computers,
      computerEvidence,
      unreadableEvidence,
    )) {
      if (reading.current.get(id) === snapshotDigest) continue;
      reading.current.set(id, snapshotDigest);
      const failed = () => {
        if (reading.current.get(id) !== snapshotDigest) return;
        reading.current.delete(id);
        setUnreadableEvidence((unreadable) => new Map(unreadable).set(id, snapshotDigest));
      };
      void request(
        `/api/application/computers/${encodeURIComponent(id)}/snapshot`,
        decodeComputerSnapshot,
        { signal: AbortSignal.timeout(30000) },
      )
        .then(({ snapshotDigest: digest, snapshot: evidence }) => {
          if (reading.current.get(id) !== snapshotDigest) return;
          if (digest && evidence)
            setComputerEvidence((held) => new Map(held).set(id, { digest, snapshot: evidence }));
          else failed();
        })
        .catch(failed);
    }
  }, [snapshot, computerEvidence, unreadableEvidence, connection]);
  const retryEvidence = useCallback((id: string) => {
    setUnreadableEvidence((unreadable) => {
      const next = new Map(unreadable);
      next.delete(id);
      return next;
    });
  }, []);
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
    () => ({
      snapshot,
      computerEvidence,
      unreadableEvidence,
      retryEvidence,
      error,
      refresh,
      change,
      discover,
      discovering,
      connectComputer,
    }),
    [
      snapshot,
      computerEvidence,
      unreadableEvidence,
      retryEvidence,
      error,
      refresh,
      change,
      discover,
      discovering,
      connectComputer,
    ],
  );
  return <Context value={value}>{children}</Context>;
}
export function useApplication() {
  const value = useContext(Context);
  if (!value) throw new Error("Application provider is missing.");
  return value;
}
