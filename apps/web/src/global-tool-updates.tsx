import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpCircle, Copy, Download, LoaderCircle } from "lucide-react";
import type { Installation } from "@versionstead/contracts/monitoring";
import {
  decodeGlobalToolUpdateCommand,
  decodeGlobalToolUpdateRun,
  decodeGlobalToolUpdateRuns,
  globalToolUpdateActive,
  type GlobalToolUpdateRun,
} from "@versionstead/contracts/global-tool-updates";
import { useMonitoring } from "./monitoring";
import { pcUpdateHold } from "./monitoring-view";
import { globalUpgradeCommand } from "./upgrade-commands";
import { Button, CommandBlock, copyText } from "./ui";
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
  // Unverified or in-flux PC results, or a lost connection, hold back updates and the commands
  // built from those results alike; the reason says which.
  const blocked = pcUpdateHold(connection === "connected", snapshot);
  return {
    runs,
    start,
    blocked,
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
  const reasonId = useId();
  const available =
    item.updateStatus === "available" &&
    item.origin === "registry" &&
    item.availableVersion !== null;
  if (!available && !active) return null;
  // Only the desktop app can run an installer; a browser is handed the command to run itself,
  // unless the PC's results are unverified. Then the button stays, inactive, and says why.
  if (!updater.desktop) {
    const command = globalUpgradeCommand(item, item.availableVersion);
    if (!command) return null;
    const copyReason = updater.blocked ? `${updater.blocked} before copying a command.` : null;
    const copyButton = (
      <Button
        size="compact"
        variant="outline"
        aria-label={`Copy command for ${item.name}`}
        aria-disabled={copyReason ? true : undefined}
        aria-describedby={copyReason ? reasonId : undefined}
        onClick={() => {
          if (!copyReason) void copyText(command, "Command copied.");
        }}
      >
        <Copy className="size-3.5" />
        Copy command
      </Button>
    );
    return copyReason ? (
      <>
        <Tooltip>
          <TooltipTrigger render={copyButton} />
          <TooltipPopup>{copyReason}</TooltipPopup>
        </Tooltip>
        <span id={reasonId} className="sr-only">
          {copyReason}
        </span>
      </>
    ) : (
      copyButton
    );
  }
  const locked =
    updater.pendingItem?.rootId === item.rootId ||
    updater.runs.some((r) => r.rootId === item.rootId && globalToolUpdateActive(r));
  const busy = active || updater.pendingItem?.id === item.id;
  const label = busy ? "Updating…" : run?.status === "failed" ? "Retry update" : "Update now";
  const inactive = updater.blocked !== null || locked;
  // A disabled button never shows its tooltip, so an inactive one stays focusable and says why.
  const reason = updater.blocked
    ? `${updater.blocked} before updating.`
    : locked && !busy
      ? "Another update in this global location is running."
      : null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="compact"
              variant="outline"
              aria-label={`${label} ${item.name}`}
              aria-busy={Boolean(busy)}
              aria-disabled={inactive || undefined}
              aria-describedby={reason ? reasonId : undefined}
              onClick={() => {
                if (!inactive) void updater.start(item);
              }}
            >
              {busy ? (
                <LoaderCircle className="size-3.5 motion-safe:animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {label}
            </Button>
          }
        />
        <TooltipPopup>
          {reason ??
            `Update ${item.name} to ${item.availableVersion} using ${item.manager === "bun" ? "Bun" : "npm"} in its observed global location.`}
        </TooltipPopup>
      </Tooltip>
      {reason && (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </>
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
  const { id, version, availableVersion, updateStatus, origin } = item;
  const commandKey = `${id}:${version}:${availableVersion}`;
  // The desktop prepares the exact command for the observed location; a browser shows the generic
  // one. Neither is shown while the PC's results are unverified.
  const command = updater.blocked
    ? null
    : updater.desktop
      ? prepared?.key === commandKey
        ? prepared.value
        : null
      : globalUpgradeCommand(item, availableVersion);
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
      {/* A browser has the command block below to copy from, so it gets no second button. */}
      {updater.desktop && <GlobalToolUpdateButton item={item} updater={updater} />}
      <p className="muted small">
        {updater.desktop
          ? "Updates run only when you launch them. The package manager uses its normal installation and lifecycle-script settings."
          : "Updates run in the Versionstead desktop app."}
      </p>
      {!updater.desktop && updater.blocked && (
        <p className="muted small">{updater.blocked} before copying a command.</p>
      )}
      {/* Keyed by the command, so a different one starts uncopied. */}
      {command && <CommandBlock key={command} command={command} label="Copy update command" />}
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
