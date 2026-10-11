import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpCircle, Copy, Download, LoaderCircle } from "lucide-react";
import type { Installation } from "@versionstead/contracts/monitoring";
import {
  decodeGlobalToolUpdateBatch,
  decodeGlobalToolUpdateBatchStatus,
  decodeGlobalToolUpdateCommand,
  decodeGlobalToolUpdateRun,
  decodeGlobalToolUpdateRuns,
  globalToolUpdateActive,
  globalToolUpdateBatchActive,
  type GlobalToolUpdateBatch,
  type GlobalToolUpdateRun,
} from "@versionstead/contracts/global-tool-updates";
import { useMonitoring } from "./monitoring";
import { installationUpdate, pcUpdateHold, plural } from "./monitoring-view";
import { updateWarnings } from "./release-signals";
import {
  batchSummary,
  initialSelection,
  ipcMessage,
  updatableInstallations,
  updateAllEntries,
  updateAllGroups,
  type UpdateAllEntry,
} from "./update-all";
import { globalUpgradeCommand } from "./upgrade-commands";
import { updateBadge } from "./versions";
import {
  Button,
  CommandBlock,
  ConfirmDialog,
  Dialog,
  UpdateKindBadge,
  copyText,
  useFailure,
} from "./ui";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./components/ui/tooltip";

const updateRequest = (item: Installation) => ({
  installationId: item.id,
  expectedVersion: item.version,
  targetVersion: item.availableVersion,
});
export function useGlobalToolUpdates() {
  const { snapshot, connection, refresh } = useMonitoring();
  const [runs, setRuns] = useState<GlobalToolUpdateRun[]>([]);
  const [batch, setBatch] = useState<GlobalToolUpdateBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pendingItem, setPendingItem] = useState<Installation | null>(null);
  const pending = useRef(new Set<string>());
  const api = window.versionstead;
  // Quick while an update runs; the effect restarts when that changes, so a timer set while idle
  // does not keep the first progress of a run waiting.
  const polling = runs.some(globalToolUpdateActive) || globalToolUpdateBatchActive(batch);
  useEffect(() => {
    if (!api?.globalToolUpdateStatus) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [next, nextBatch] = await Promise.all([
          api.globalToolUpdateStatus().then(decodeGlobalToolUpdateRuns),
          api.globalToolUpdateBatch().then(decodeGlobalToolUpdateBatchStatus),
        ]);
        if (mounted) {
          setRuns([...next]);
          setBatch(nextBatch);
          setStatusError(null);
          timer = setTimeout(() => void poll(), polling ? 500 : 3000);
        }
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
  }, [api, polling]);
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
        setError(ipcMessage(failure, "The update could not start. Scan this PC and retry."));
      } finally {
        pending.current.delete(item.rootId);
        setPendingItem(null);
      }
    },
    [api, refresh],
  );
  // The confirmation shows why Update all could not start, so the dialog passes its own onError.
  const startAll = useCallback(
    async (items: readonly Installation[], onError: (message: string) => void) => {
      if (!api?.updateAllGlobalTools) return false;
      try {
        setBatch(
          decodeGlobalToolUpdateBatch(
            await api.updateAllGlobalTools({ items: items.map(updateRequest) }),
          ),
        );
        // The batch has started: the confirmation need not wait for the page to refresh.
        void refresh();
        return true;
      } catch (failure) {
        onError(ipcMessage(failure, "Update all could not start. Scan this PC and retry."));
        return false;
      }
    },
    [api, refresh],
  );
  const stopAll = useCallback(async () => {
    if (!api?.stopGlobalToolUpdates) return;
    try {
      setBatch(decodeGlobalToolUpdateBatchStatus(await api.stopGlobalToolUpdates()));
    } catch {
      setError("Update all could not be stopped. Quit Versionstead UI from the tray to stop it.");
    }
  }, [api]);
  // Reasons to ask before an update runs; empty runs it at once. Only the finding for the release
  // that would be installed counts (rows and sheets mark the same one), so a warning never
  // describes another version.
  const warnings = useCallback(
    (item: Installation) =>
      snapshot
        ? updateWarnings(
            installationUpdate(snapshot.findings, snapshot.device.id, item),
            snapshot.settings.releaseCooldownDays ?? 3,
            Date.now(),
          )
        : [],
    [snapshot],
  );
  // Unverified or in-flux PC results, or a lost connection, hold back updates and the commands
  // built from those results alike; the reason says which.
  const blocked = pcUpdateHold(connection === "connected", snapshot);
  return {
    runs,
    batch,
    start,
    startAll,
    stopAll,
    warnings,
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
  const batched = updater.batch?.items.find((entry) => entry.installationId === item.id);
  const active =
    Boolean(run && globalToolUpdateActive(run)) ||
    (batched !== undefined && ["preparing", "updating", "verifying"].includes(batched.status));
  const reasonId = useId();
  // The question put to the owner before an update with a warning, and the update it was about.
  const [asked, setAsked] = useState<{ update: string; warnings: string } | null>(null);
  const update = `${item.version} to ${item.availableVersion}`;
  const available =
    item.updateStatus === "available" &&
    item.origin === "registry" &&
    item.availableVersion !== null;
  // The question is about one update. If a scan changes the pair or takes the update away, the
  // question is dropped for good (it must not return if the pair does), and nothing is started.
  if (asked && (asked.update !== update || !available)) setAsked(null);
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
  const updatingAll = globalToolUpdateBatchActive(updater.batch);
  const locked =
    updater.pendingItem?.rootId === item.rootId ||
    updater.runs.some((r) => r.rootId === item.rootId && globalToolUpdateActive(r)) ||
    updatingAll;
  const busy = active || updater.pendingItem?.id === item.id;
  const label = busy ? "Updating…" : run?.status === "failed" ? "Retry update" : "Update now";
  const inactive = updater.blocked !== null || locked;
  // A disabled button never shows its tooltip, so an inactive one stays focusable and says why.
  const reason = updater.blocked
    ? `${updater.blocked} before updating.`
    : locked && !busy
      ? updatingAll
        ? "Update all is running."
        : "Another update in this global location is running."
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
                if (inactive) return;
                const warnings = updater.warnings(item);
                if (warnings.length)
                  setAsked({ update, warnings: warnings.map((warning) => warning.text).join(" ") });
                else void updater.start(item);
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
      {asked && (
        // Escape declines the question only; it must not also close the evidence sheet this button sits in.
        // ponytail: inside that sheet, focus lands on the sheet afterwards (Base UI restores its popup a
        // frame after this dialog closes), not on this button; return it here if that proves disorienting.
        <div
          className="contents"
          onKeyDown={(event) => {
            if (event.key === "Escape") event.stopPropagation();
          }}
        >
          <ConfirmDialog
            title={`Update ${item.name} to ${item.availableVersion}?`}
            description={asked.warnings}
            confirmLabel="Update anyway"
            onConfirm={() => {
              setAsked(null);
              void updater.start(item);
            }}
            onClose={() => setAsked(null)}
          />
        </div>
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

const itemStatus: Record<GlobalToolUpdateBatch["items"][number]["status"], string> = {
  waiting: "Waiting",
  preparing: "Checking",
  updating: "Installing",
  verifying: "Verifying",
  succeeded: "Updated",
  failed: "Failed",
  skipped: "Not started",
};

/** "Update all (N)": opens the confirmation for every verified update the desktop can run. */
export function UpdateAllButton({ updater }: { updater: Updater }) {
  const { snapshot } = useMonitoring();
  const [entries, setEntries] = useState<UpdateAllEntry[] | null>(null);
  const reasonId = useId();
  if (!updater.desktop || !snapshot) return null;
  // The label only counts the tools; the clock is read when the owner opens the confirmation.
  const count = updatableInstallations(snapshot.inventory.installations).length;
  if (count === 0) return null;
  const running =
    globalToolUpdateBatchActive(updater.batch) ||
    updater.pendingItem !== null ||
    updater.runs.some(globalToolUpdateActive);
  // A disabled button never shows its tooltip, so an inactive one stays focusable and says why.
  const reason = updater.blocked
    ? `${updater.blocked} before updating.`
    : running
      ? "Wait for the running update to finish."
      : null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              aria-disabled={reason ? true : undefined}
              aria-describedby={reason ? reasonId : undefined}
              onClick={() => {
                if (!reason) setEntries(updateAllEntries(snapshot, Date.now()));
              }}
            >
              <Download className="size-3.5" />
              Update all ({count})
            </Button>
          }
        />
        <TooltipPopup>
          {reason ?? "Review every verified update, then install them one at a time."}
        </TooltipPopup>
      </Tooltip>
      {reason && (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
      {entries && (
        <UpdateAllDialog entries={entries} updater={updater} close={() => setEntries(null)} />
      )}
    </>
  );
}

/** Lists every package before anything runs. Releases younger than the cooldown and updates the owner snoozed or ignored start unticked. */
function UpdateAllDialog({
  entries,
  updater,
  close,
}: {
  entries: UpdateAllEntry[];
  updater: Updater;
  close: () => void;
}) {
  const [selected, setSelected] = useState(() => initialSelection(entries));
  const [error, fail, clearError] = useFailure();
  const [starting, setStarting] = useState(false);
  const notesId = useId();
  const chosen = entries.filter((entry) => selected.has(entry.item.id));
  const majors = chosen.filter((entry) => entry.kind === "major").length;
  return (
    <Dialog
      title={`Review ${plural(entries.length, "global tool update")}`}
      description="Updates run one at a time in each tool's observed global location. Each is verified, and this PC is rescanned at the end."
      onClose={close}
      dismissible={!starting}
    >
      {updateAllGroups(entries).map((group) => (
        <section key={group.title} className="repository-selection">
          <h3>
            {group.title} ({group.items.length})
          </h3>
          {group.hint && <p className="muted small">{group.hint}</p>}
          <div className="repository-list">
            {group.items.map((entry) => {
              const { item } = entry;
              const manager = item.manager === "bun" ? "Bun" : "npm";
              const notes = `${notesId}-${item.id}`;
              const kind = updateBadge(item.version, item.availableVersion)?.label;
              const unknownAge = entry.ageUnknown && entry.held === null && !entry.tooNew;
              const noted = entry.held !== null || entry.warnings.length > 0 || kind || unknownAge;
              return (
                <label className="repository-choice" key={item.id}>
                  <input
                    type="checkbox"
                    // The name starts with the visible one; the rule and the warnings read as its description.
                    aria-label={`${item.name} ${item.version} to ${item.availableVersion} (${manager})`}
                    aria-describedby={noted ? notes : undefined}
                    checked={selected.has(item.id)}
                    disabled={starting}
                    onChange={(event) =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                  />
                  <span className="repository-choice-name">
                    <strong>{item.name}</strong>{" "}
                    <span className="mono">
                      {item.version} → {item.availableVersion}
                    </span>
                    <span className="table-subtext">{manager} global</span>
                    {noted && (
                      <span id={notes}>
                        {kind && <span className="sr-only">{kind} update. </span>}
                        {unknownAge && <span className="sr-only">Release age unknown. </span>}
                        {entry.held && <span className="table-subtext">{entry.held}</span>}
                        {entry.warnings.map((warning) => (
                          <span key={warning.kind} className="table-subtext">
                            {warning.text}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <UpdateKindBadge installed={item.version} candidate={item.availableVersion} />
                </label>
              );
            })}
          </div>
        </section>
      ))}
      {majors > 0 && (
        <p className="muted small">
          {plural(majors, "major update")} can include breaking changes.
        </p>
      )}
      <p className="muted small">
        A failed update skips the rest of its global location. Stop takes effect after the current
        package finishes and starts nothing after it; it does not cancel an install already running.
        The package managers use their normal installation and lifecycle-script settings.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button disabled={starting} onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={starting || chosen.length === 0}
          onClick={() => {
            clearError();
            setStarting(true);
            void updater
              .startAll(
                chosen.map((entry) => entry.item),
                fail,
              )
              .then((started) => {
                setStarting(false);
                if (started) close();
              });
          }}
        >
          {`Update ${plural(chosen.length, "package")}`}
        </Button>
      </div>
    </Dialog>
  );
}

/** Each package's state while Update all runs, Stop, and the final summary. */
export function UpdateAllProgress({ updater }: { updater: Updater }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const batch = updater.batch?.id === dismissed ? null : updater.batch;
  const running = batch !== null && batch.status !== "finished";
  const stopping = batch?.status === "stopping";
  const settledCount =
    batch?.items.filter(
      (item) =>
        item.status === "succeeded" || item.status === "failed" || item.status === "skipped",
    ).length ?? 0;
  const current = batch?.items.find(
    (item) =>
      item.status === "preparing" || item.status === "updating" || item.status === "verifying",
  );
  const summary = batch
    ? `${batchSummary(batch)}${current ? ` · ${current.name} ${current.previousVersion} → ${current.targetVersion}` : ""}`
    : "";
  return (
    <>
      {/* Always in the page, so the first message is announced as a change to a live region instead of arriving with it. */}
      <p role="status" className="sr-only" data-testid="update-all-status">
        {summary}
      </p>
      {batch && (
        <section className="panel panel-body mb-4" aria-label="Update all">
          <div className="coverage-row">
            <h2>Update all</h2>
            {running ? (
              <Button
                size="compact"
                variant="outline"
                // Once pressed, the name is the visible "Stopping…"; before, it says what Stop does. It
                // stays focusable, so keyboard focus is not dropped when it is pressed.
                aria-label={stopping ? undefined : "Stop Update all after the current package"}
                aria-disabled={stopping || undefined}
                onClick={() => {
                  if (!stopping) void updater.stopAll();
                }}
              >
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              <Button
                size="compact"
                variant="ghost"
                onClick={() => {
                  setDismissed(batch.id);
                  // The button goes with the panel, so keyboard focus moves into the page.
                  document.getElementById("content")?.focus({ preventScroll: true });
                }}
              >
                Dismiss
              </Button>
            )}
          </div>
          {/* The live copy is the sr-only line above. */}
          <p className="small" aria-hidden="true">
            {summary}
          </p>
          {running && !stopping && (
            <p className="muted small">
              Stop takes effect after the current package finishes; it does not cancel an install
              already running.
            </p>
          )}
          {running && (
            <progress
              className="scan-meter"
              aria-label="Update all progress"
              value={settledCount}
              max={batch.items.length}
            />
          )}
          <ul className="coverage-list flex-col">
            {batch.items.map((item) => (
              <li
                key={item.installationId}
                className={item.status === "failed" ? "error-text" : undefined}
              >
                <strong>{item.name}</strong> {item.previousVersion} → {item.targetVersion} (
                {item.manager === "bun" ? "Bun" : "npm"}): {itemStatus[item.status]}
                {/* The runner words a skip "Not started: why"; the status already says so. */}
                {item.status === "failed" || item.status === "skipped"
                  ? ` — ${item.message.replace(/^Not started: /, "")}`
                  : ""}
              </li>
            ))}
          </ul>
          {batch.note && <p className="small error-text">{batch.note}</p>}
        </section>
      )}
    </>
  );
}
