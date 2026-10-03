// Adapts T3 Code's ProviderInstanceCard update controls and lifecycle (MIT).
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpCircle, Check, Copy, Download, LoaderCircle } from "lucide-react";
import type { Installation } from "@versionstead/contracts/monitoring";
import {
  decodeGlobalToolUpdateCommand,
  decodeGlobalToolUpdateRun,
  decodeGlobalToolUpdateRuns,
  globalToolUpdateActive,
  type GlobalToolUpdateRun,
} from "@versionstead/contracts/global-tool-updates";
import { useMonitoring } from "./monitoring";
import { Button } from "./ui";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./components/ui/tooltip";

const updateRequest = (item: Installation) => ({
  installationId: item.id,
  expectedVersion: item.version,
  targetVersion: item.availableVersion,
});
export function useGlobalToolUpdates() {
  const { snapshot, connection, refresh } = useMonitoring();
  const [runs, setRuns] = useState<GlobalToolUpdateRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pendingItem, setPendingItem] = useState<Installation | null>(null);
  const pending = useRef(new Set<string>());
  const api = window.versionstead;
  useEffect(() => {
    if (!api?.globalToolUpdateStatus) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = decodeGlobalToolUpdateRuns(await api.globalToolUpdateStatus());
        if (mounted) {
          setRuns([...next]);
          setStatusError(null);
        }
        if (mounted)
          timer = setTimeout(() => void poll(), next.some(globalToolUpdateActive) ? 500 : 3000);
      } catch {
        if (mounted) {
          setStatusError("Update status is unavailable. Reopen Versionstead and scan this PC.");
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    void poll();
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [api]);
  const start = useCallback(
    async (item: Installation) => {
      if (!api?.updateGlobalTool || !item.rootId || pending.current.has(item.rootId)) return;
      pending.current.add(item.rootId);
      setPendingItem(item);
      setError(null);
      try {
        const run = decodeGlobalToolUpdateRun(await api.updateGlobalTool(updateRequest(item)));
        setRuns((previous) => [
          ...previous.filter((r) => r.rootId !== run.rootId || r.name !== run.name),
          run,
        ]);
        await refresh();
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The update could not start. Scan this PC and retry.",
        );
      } finally {
        pending.current.delete(item.rootId);
        setPendingItem(null);
      }
    },
    [api, refresh],
  );
  const blocked =
    connection !== "connected" ||
    snapshot?.inventory.evidence.status === "scanning" ||
    snapshot?.inventory.evidence.status === "failed" ||
    snapshot?.inventory.updateEvidence?.status === "failed" ||
    snapshot?.scanProgress?.active?.kind === "pc" ||
    snapshot?.scanProgress?.queued.some((target) => target.kind === "pc");
  return {
    runs,
    start,
    blocked: Boolean(blocked),
    pendingItem,
    error: error ?? statusError,
    desktop: Boolean(api?.updateGlobalTool),
  };
}
type Updater = ReturnType<typeof useGlobalToolUpdates>;

export function GlobalToolUpdateButton({
  item,
  updater,
}: {
  item: Installation;
  updater: Updater;
}) {
  const run = updater.runs.find((r) => r.rootId === item.rootId && r.name === item.name);
  const active = run && globalToolUpdateActive(run);
  const available =
    item.updateStatus === "available" &&
    item.origin === "registry" &&
    item.availableVersion !== null;
  if (!available && !active) return null;
  const locked =
    updater.pendingItem?.rootId === item.rootId ||
    updater.runs.some((r) => r.rootId === item.rootId && globalToolUpdateActive(r));
  const busy = active || updater.pendingItem?.id === item.id;
  const label = busy ? "Updating…" : run?.status === "failed" ? "Retry update" : "Update now";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="compact"
            variant="outline"
            aria-label={`${label} ${item.name}`}
            aria-busy={Boolean(busy)}
            disabled={!updater.desktop || updater.blocked || locked}
            onClick={() => void updater.start(item)}
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            {label}
          </Button>
        }
      />
      <TooltipPopup>
        {!updater.desktop
          ? "Open Versionstead desktop to update local packages."
          : updater.blocked
            ? "Finish a successful PC scan before updating."
            : `Update ${item.name} to ${item.availableVersion} using ${item.manager === "bun" ? "Bun" : "npm"} in its observed global location.`}
      </TooltipPopup>
    </Tooltip>
  );
}

export function GlobalToolUpdateDetails({
  item,
  updater,
}: {
  item: Installation;
  updater: Updater;
}) {
  const [prepared, setPrepared] = useState<{ key: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { id, version, availableVersion, updateStatus, origin } = item;
  const commandKey = `${id}:${version}:${availableVersion}`;
  const command = prepared?.key === commandKey && !updater.blocked ? prepared.value : null;
  useEffect(() => {
    const api = window.versionstead;
    if (
      !api?.globalToolUpdateCommand ||
      !availableVersion ||
      updateStatus !== "available" ||
      origin !== "registry" ||
      updater.blocked
    )
      return;
    let mounted = true;
    void api
      .globalToolUpdateCommand({
        installationId: id,
        expectedVersion: version,
        targetVersion: availableVersion,
      })
      .then((value) => {
        if (mounted) {
          setPrepared({ key: commandKey, value: decodeGlobalToolUpdateCommand(value) });
          setError(null);
          setCopied(false);
        }
      })
      .catch((failure: unknown) => {
        if (mounted)
          setError(
            failure instanceof Error
              ? failure.message
              : "The update command could not be prepared.",
          );
      });
    return () => {
      mounted = false;
    };
  }, [id, version, availableVersion, updateStatus, origin, updater.blocked, commandKey]);
  if (item.updateStatus !== "available" || item.origin !== "registry") return null;
  return (
    <section className="my-4 grid gap-3" aria-label="Package update">
      <p className="flex items-center gap-2 small">
        <ArrowUpCircle className="size-4" />
        Version {item.availableVersion} is available.
      </p>
      <GlobalToolUpdateButton item={item} updater={updater} />
      <p className="muted small">
        Updates run only when you launch them. The package manager uses its normal installation and
        lifecycle-script settings.
      </p>
      {command && (
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 p-2">
          <code className="min-w-0 flex-1 break-all text-xs">{command}</code>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Copy update command"
            onClick={() => {
              void navigator.clipboard
                .writeText(command)
                .then(() => setCopied(true))
                .catch(() => setError("The command could not be copied."));
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
      )}
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
