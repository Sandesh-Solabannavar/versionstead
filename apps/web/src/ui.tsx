import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, Copy, Ellipsis, ExternalLink, X } from "lucide-react";
import type { Finding, MonitoringSnapshot, ScanEvidence } from "@versionstead/contracts/monitoring";
import {
  evidenceStale,
  relativeTime,
  scanDuration,
  scanStage,
  severityPresentation,
  supportStateLabel,
} from "./monitoring-view";
import { failureRouter } from "./monitoring-actions";
import {
  candidateDeprecationText,
  installScriptText,
  licenseText,
  provenanceText,
  releaseAge,
} from "./release-signals";
import { updateBadge } from "./versions";
import {
  Button as ShadcnButton,
  type ButtonProps,
  type ButtonVariant,
} from "./components/ui/button";
import { Badge as ShadcnBadge, type BadgeProps } from "./components/ui/badge";
import { Table as ShadcnTable } from "./components/ui/table";
import { Sheet, SheetPopup, SheetHeader, SheetTitle } from "./components/ui/sheet";
import { cn } from "./lib/utils";
import { DialogPortalContainer } from "./components/ui/dialog-portal";
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuTrigger } from "./components/ui/menu";
import { toast } from "./components/ui/toast";

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
  CollapsibleContent,
} from "./components/ui/collapsible";
export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
} from "./components/ui/select";
export { Input } from "./components/ui/input";
export { TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/ui/table";

// Toasts are accessible non-modal dialogs and must not block workspace shortcuts.
export function hasOpenModal() {
  return (
    document.querySelector(
      'dialog[open], [role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]:not([aria-modal="false"])',
    ) !== null
  );
}

const buttonAliases = {
  default: "outline",
  primary: "default",
  ghost: "ghost",
  danger: "destructive",
  outline: "outline",
  secondary: "secondary",
  destructive: "destructive",
} as const;

const badgeTones = {
  default: "neutral",
  secondary: "neutral",
  outline: "neutral",
  success: "success",
  warning: "warning",
  error: "error",
  info: "info",
} as const;

export function Button({
  variant = "default",
  className,
  ...props
}: Omit<ButtonProps, "variant"> & {
  variant?: "primary" | "danger" | ButtonVariant;
}) {
  return (
    <ShadcnButton
      className={cn("button", variant, className)}
      variant={buttonAliases[variant]}
      {...props}
    />
  );
}

export function Badge({
  tone,
  variant,
  className,
  ...props
}: BadgeProps & {
  tone?: "neutral" | "success" | "warning" | "error" | "info";
}) {
  const resolvedTone = tone ?? (variant ? badgeTones[variant] : "neutral");
  return (
    <ShadcnBadge
      className={cn("badge", resolvedTone, className)}
      variant={variant ?? (resolvedTone === "neutral" ? "secondary" : resolvedTone)}
      {...props}
    />
  );
}

export function EvidenceBadge({ status }: { status: ScanEvidence["status"] }) {
  const labels = {
    "not-scanned": "Not scanned",
    scanning: "Scanning",
    complete: "Collected",
    partial: "Partial",
    failed: "Failed",
    unsupported: "Unsupported",
  };
  const tone =
    status === "complete"
      ? "success"
      : status === "failed"
        ? "error"
        : status === "partial" || status === "unsupported"
          ? "warning"
          : status === "scanning"
            ? "info"
            : "neutral";
  return <Badge tone={tone}>{labels[status]}</Badge>;
}

// One shared clock re-renders every relative time together, instead of a timer for each.
// Its time is at most 30 seconds old, which is finer than the minutes labels count in.
const clock = { now: Date.now(), listeners: new Set<() => void>(), started: false };
function tick() {
  clock.now = Date.now();
  clock.listeners.forEach((notify) => notify());
}
function subscribeToClock(listener: () => void) {
  clock.listeners.add(listener);
  if (!clock.started) {
    clock.started = true;
    window.setInterval(tick, 30_000);
    // Background tabs throttle timers, so catch up as soon as the page is shown again.
    document.addEventListener("visibilitychange", tick);
    tick();
  }
  return () => {
    clock.listeners.delete(listener);
  };
}
export function useNow() {
  return useSyncExternalStore(subscribeToClock, () => clock.now);
}

function RelativeTime({ value }: { value: string }) {
  const now = useNow();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {relativeTime(value, now)}
    </time>
  );
}

/** How long ago (or until) a time is, with the exact local time as its tooltip. */
export function timestamp(value: string | null): ReactNode {
  return value ? <RelativeTime value={value} /> : "Not yet";
}

/** Marks evidence whose last success is older than twice its scan interval. */
export function StaleBadge({
  lastSuccess,
  intervalMinutes,
}: {
  lastSuccess: string | null;
  intervalMinutes: number;
}) {
  const now = useNow();
  return evidenceStale(lastSuccess, intervalMinutes, now) ? (
    <Badge tone="warning" title="The last successful scan is older than twice the scan interval.">
      Stale
    </Badge>
  ) : null;
}

export function UpdateKindBadge({
  installed,
  candidate,
}: {
  installed: string | null;
  candidate: string | null;
}) {
  const badge = updateBadge(installed, candidate);
  return badge ? (
    <>
      <Badge tone={badge.tone} title={badge.title}>
        {badge.label}
        {badge.title && <span className="sr-only">. {badge.title}</span>}
      </Badge>
      {badge.prerelease && <Badge>Prerelease</Badge>}
    </>
  ) : null;
}

/** An update is one state with one name, marked when it adds an install script or is younger than the release cooldown; an advisory is toned by its severity; a lifecycle finding is named by its support state and toned by its severity; a kind from a newer Versionstead is named generically and toned by its severity. */
export function FindingBadge({
  finding,
  cooldownDays,
}: {
  finding: Pick<
    Finding,
    | "kind"
    | "severity"
    | "installedVersion"
    | "availableVersion"
    | "packageName"
    | "lastSeenAt"
    | "effectiveDate"
    | "installScript"
    | "publishedAt"
  >;
  cooldownDays: number;
}) {
  const advisory = severityPresentation(finding.severity);
  return (
    <div className="package-checks">
      {finding.kind === "coverage" ? (
        <Badge tone="warning">Incomplete check</Badge>
      ) : finding.kind === "advisory" ? (
        <Badge tone={advisory.tone}>{advisory.label}</Badge>
      ) : finding.kind === "lifecycle" ? (
        <Badge tone={advisory.tone}>{supportStateLabel(finding)}</Badge>
      ) : finding.kind === "other" ? (
        <Badge tone={advisory.tone}>Other finding</Badge>
      ) : (
        <>
          <Badge tone="info">Update available</Badge>
          <UpdateKindBadge
            installed={finding.installedVersion}
            candidate={finding.availableVersion}
          />
          {finding.installScript === true && <Badge tone="warning">Adds an install script</Badge>}
          <ReleaseAgeBadge publishedAt={finding.publishedAt} cooldownDays={cooldownDays} />
        </>
      )}
    </div>
  );
}

/** "Released 6 hours ago — wait until Oct 11", or "Release age unknown", while the cooldown is on. */
export function ReleaseAgeBadge({
  publishedAt,
  cooldownDays,
}: {
  publishedAt: string | undefined;
  cooldownDays: number;
}) {
  const now = useNow();
  const age = releaseAge(publishedAt, cooldownDays, now);
  return age ? (
    <Badge tone={age.kind === "too-new" ? "warning" : "neutral"}>{age.label}</Badge>
  ) : null;
}

/** An update's release evidence as rows of a details list; missing facts read unknown, never as a negative. */
export function ReleaseFacts({
  finding,
  cooldownDays,
}: {
  finding: Pick<
    Finding,
    "installScript" | "candidateDeprecated" | "publishedAt" | "license" | "provenance"
  >;
  cooldownDays: number;
}) {
  const now = useNow();
  const age = releaseAge(finding.publishedAt, cooldownDays, now);
  return (
    <>
      <dt>Install script</dt>
      <dd>{installScriptText(finding.installScript)}</dd>
      <dt>Candidate deprecation</dt>
      <dd>{candidateDeprecationText(finding.candidateDeprecated)}</dd>
      <dt>Released</dt>
      <dd>
        {finding.publishedAt ? (
          <>
            {timestamp(finding.publishedAt)}
            {age?.kind === "too-new" ? ` · wait until ${age.untilLabel}` : ""}
          </>
        ) : (
          "Release age unknown"
        )}
      </dd>
      <dt>License</dt>
      <dd>{licenseText(finding.license)}</dd>
      <dt>Provenance</dt>
      <dd>{provenanceText(finding.provenance)}</dd>
    </>
  );
}

/** Reports a failure in the app's one error toast; a newer one of the same kind replaces it. */
export function reportError(description: string, id = "action-error") {
  toast.add({
    id,
    title: "Versionstead needs attention",
    description,
    type: "error",
    timeout: 8000,
  });
}

/**
 * Why an action started from a form failed, for the form to show in place: a toast sits outside a
 * modal dialog, where it is inert and unannounced. Pass `fail` as the action's `onError`. If the
 * form has gone (or `open` is false) by the time the message arrives, a toast reports it instead.
 */
export function useFailure(open = true) {
  const [error, setError] = useState<string | null>(null);
  const [router] = useState(() => failureRouter(setError, reportError));
  useEffect(() => {
    router.setOpen(open);
    return () => router.setOpen(false);
  }, [router, open]);
  const clear = useCallback(() => setError(null), []);
  return [error, router.deliver, clear] as const;
}

/**
 * A status line a modal dialog keeps mounted, to say what its own actions did. A toast sits outside
 * the dialog, where it is inert and unannounced, and a live region announces a change in its text,
 * not a region that arrives with it. `say` replaces the text, and says it again if it is the same.
 */
export function useStatusLine() {
  const [status, setStatus] = useState({ text: "", count: 0 });
  const say = useCallback(
    (text: string) => setStatus((previous) => ({ text, count: previous.count + 1 })),
    [],
  );
  const line = (
    <p role="status" className="muted small min-h-5">
      <span key={status.count}>{status.text}</span>
    </p>
  );
  return [line, say] as const;
}

/**
 * Copies text and says so; a blocked clipboard is reported rather than ignored. Inside a modal
 * dialog pass its `say` (from `useStatusLine`), which replaces the toast.
 */
export async function copyText(
  text: string,
  done: string,
  say?: (message: string) => void,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    if (say) say(done);
    else toast.add({ id: "action-feedback", title: done, type: "success" });
    return true;
  } catch {
    const failed = "The clipboard is not available, so nothing was copied.";
    if (say) say(failed);
    else reportError(failed);
    return false;
  }
}

/** A command for the owner to run elsewhere, with its copy button. Versionstead never runs it. */
export function CommandBlock({
  command,
  label,
  className,
  say,
}: {
  command: string;
  label: string;
  className?: string;
  /** The enclosing modal dialog's status line, which replaces the copy toast. */
  say?: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 p-2",
        className,
      )}
    >
      <code className="min-w-0 flex-1 break-all text-xs">{command}</code>
      <Button
        size="icon"
        variant="ghost"
        aria-label={label}
        onClick={() => {
          void copyText(command, "Command copied.", say).then(setCopied);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

/**
 * A control that is removed while it has focus (an action removes its row; a scan ends) hands focus to
 * the page, not to the document.
 * ponytail: the content region, not the neighbouring row; focus that row's menu if keyboard triage needs it.
 */
export function useFocusPageOnUnmount(control: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = control.current;
    return () => {
      if (element && element === document.activeElement)
        queueMicrotask(() => document.getElementById("content")?.focus({ preventScroll: true }));
    };
  }, [control]);
}

/** A row's overflow menu; its items mount only while it is open, so closed rows stay cheap. */
export function RowActions({ label, children }: { label: string; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  // An action can remove its own row, as snoozing a finding does.
  useFocusPageOnUnmount(trigger);
  return (
    <Menu>
      <MenuTrigger ref={trigger} render={<Button size="icon" variant="ghost" aria-label={label} />}>
        <Ellipsis aria-hidden className="size-4" />
      </MenuTrigger>
      <MenuPopup className="max-h-[min(20rem,var(--available-height))] overflow-y-auto">
        {children}
      </MenuPopup>
    </Menu>
  );
}

export function CopyMenuItem({ label, text, done }: { label: string; text: string; done: string }) {
  return (
    <MenuItem onClick={() => void copyText(text, done)}>
      {label}
      <Copy aria-hidden className="size-3.5" />
    </MenuItem>
  );
}

export function LinkMenuItem({ label, href }: { label: string; href: string }) {
  return (
    <MenuLinkItem href={href} target="_blank" rel="noreferrer">
      {label}
      <ExternalLink aria-hidden className="size-3.5" />
    </MenuLinkItem>
  );
}

/** A heading at the level its place in the page calls for: 3 inside a panel, group, or drawer. */
function Heading({
  level,
  className,
  children,
}: {
  level: 2 | 3 | 4;
  className?: string;
  children: ReactNode;
}) {
  const Tag = `h${level}` as const;
  return <Tag className={className}>{children}</Tag>;
}

export function Evidence({
  evidence,
  inputFingerprint,
  title = "Evidence & coverage",
  level = 2,
}: {
  evidence: ScanEvidence;
  inputFingerprint?: string | null;
  title?: string;
  /** The heading level; its incomplete-checks note sits one level below. */
  level?: 2 | 3;
}) {
  return (
    <section className="evidence">
      <div className="section-head">
        <Heading level={level} className="evidence-title">
          {title}
        </Heading>
        <EvidenceBadge status={evidence.status} />
      </div>
      <dl className="details-list">
        <dt>Last successful evidence</dt>
        <dd>{timestamp(evidence.lastSuccess)}</dd>
        <dt>Latest attempt</dt>
        <dd>{timestamp(evidence.lastAttempt)}</dd>
      </dl>
      {inputFingerprint !== undefined &&
        (inputFingerprint ? (
          <details className="input-fingerprint">
            <summary>
              Collected input fingerprint <code>{inputFingerprint.slice(0, 12)}…</code>
            </summary>
            <p>SHA-256 identity of the inputs behind the retained project evidence.</p>
            <input
              aria-label="Full collected input fingerprint"
              readOnly
              value={inputFingerprint}
              spellCheck={false}
            />
          </details>
        ) : (
          <p className="muted small">Input fingerprint not collected yet.</p>
        ))}
      {evidence.coverage.length > 0 ? (
        <ul className="coverage-list">
          {evidence.coverage.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No evidence has been collected for this target.</p>
      )}
      {evidence.errors.length > 0 && (
        <div className="notice warning">
          <Heading level={level === 2 ? 3 : 4}>Incomplete checks</Heading>
          <ul>
            {evidence.errors.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const scanOutcomes: Record<string, string> = {
  scanning: "Last observed scan",
  complete: "Complete",
  partial: "Completed with gaps",
  failed: "Failed",
};

export function ScanProgress({
  snapshot,
  connected,
  kind,
  targetId,
  cancel,
}: {
  snapshot: MonitoringSnapshot | null;
  connected: boolean;
  kind?: "pc" | "project";
  targetId?: string;
  /** Stops the scan shown here; offered beside a running scan only. */
  cancel?: ReactNode;
}) {
  if (!snapshot) return null;
  const matches = (target: { kind: "pc" | "project"; targetId: string }) =>
    (!kind || target.kind === kind) && (!targetId || target.targetId === targetId);
  const active = snapshot.scanProgress?.active;
  const scan = active && matches(active) ? active : null;
  const queued = snapshot.scanProgress?.queued.filter(matches) ?? [];
  const last = snapshot.history.find(matches);
  const stage = scan ? scanStage(scan) : null;
  // Running, queued, and finished are one status line, so it stays one live region and a screen
  // reader hears each change. The counts and elapsed time beside it change every poll, so they stay out.
  let status: ReactNode = null;
  let trailing = "";
  if (scan && stage) {
    status = (
      <>
        <strong>{scan.targetLabel}</strong> · {stage.label}
      </>
    );
    trailing = stage.count;
  } else if (queued.length > 0) {
    status = (
      <>
        <strong>Scan queued</strong> ·{" "}
        {connected
          ? active
            ? "Waiting for the current scan to finish"
            : "Waiting for the coordinator"
          : "Last observed queue; current state unknown"}
      </>
    );
  } else if (last) {
    status = (
      <>
        <strong>{last.targetLabel}</strong> ·{" "}
        {last.cancelled ? "Cancelled by you" : (scanOutcomes[last.status] ?? "Unavailable")}
        {!connected ? " · Last received evidence" : ""}
      </>
    );
    trailing = last.finishedAt
      ? scanDuration(last.startedAt, last.finishedAt)
      : "Current progress unavailable";
  }
  // With nothing to show the card is empty and takes no room, but its status stays in the page, so
  // the first message is announced as a change to a live region instead of arriving with it.
  const idle = status === null;
  return (
    <section
      className={cn("scan-status", !connected && "stale", idle && "idle")}
      aria-label={idle ? undefined : "Scan progress"}
      data-testid="scan-progress"
    >
      <div className="scan-status-head">
        <p role="status">{status}</p>
        {trailing && <span className="muted small ms-auto">{trailing}</span>}
        {scan && stage && cancel}
      </div>
      {scan && stage && (
        <>
          <progress
            className="scan-meter"
            aria-label={`${scan.targetLabel}: ${stage.label}`}
            value={stage.value}
            max={stage.max}
          />
          <p className="muted small">
            {scanDuration(scan.startedAt, connected ? new Date().toISOString() : scan.updatedAt)} ·
            Stage progress{!connected ? " · Last observed, current scan state unknown" : ""}
          </p>
        </>
      )}
      {queued.length > 0 && (
        <p className="scan-queue muted small">
          Queued: {queued.map((item) => item.targetLabel).join(" · ")}
        </p>
      )}
    </section>
  );
}

export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <p className="eyebrow">Personal workspace</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  level = 2,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  /** The heading level: 2 for a whole page, 3 inside a group or panel. */
  level?: 2 | 3;
}) {
  return (
    <section className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        ◎
      </span>
      <Heading level={level} className="empty-state-title">
        {title}
      </Heading>
      <div className="muted">{children}</div>
      {action && <div className="empty-actions">{action}</div>}
    </section>
  );
}

export function Table({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      <ShadcnTable>
        <caption className="sr-only">{label}</caption>
        {children}
      </ShadcnTable>
    </div>
  );
}

export function Dialog({
  title,
  children,
  onClose,
  drawer = false,
  description,
  className,
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
  description?: string;
  className?: string;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [trigger] = useState(() => {
    const active = document.activeElement;
    // A menu item is gone once its menu closes, so a dialog it opens returns focus to the menu's button.
    const menuButton = active?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
    return (
      (menuButton ? document.getElementById(menuButton) : null) ??
      (active instanceof HTMLElement ? active : null)
    );
  });
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (!drawer) {
      ref.current?.showModal();
      ref.current
        ?.querySelector<HTMLElement>("input:not([disabled]),textarea:not([disabled])")
        ?.focus();
    }
    return () => {
      // Wait for the commit: a filter or successful removal can remove the original trigger.
      queueMicrotask(() => {
        const destination = trigger?.isConnected ? trigger : document.getElementById("content");
        destination?.focus({ preventScroll: true });
      });
    };
  }, [drawer, trigger]);
  if (drawer) {
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetPopup
          className="detail-dialog"
          // The sheet's scrolling body, not its first control, which can be Update now: a second Enter
          // after the one that opened the sheet (a palette option, a table row) must not start an update,
          // and PageDown, the arrows and Space must scroll the sheet.
          initialFocus={body}
          finalFocus={() => (trigger?.isConnected ? trigger : document.getElementById("content"))}
        >
          <SheetHeader className="dialog-head">
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          <div ref={body} tabIndex={-1} className="dialog-body min-h-0 overflow-y-auto">
            {children}
          </div>
        </SheetPopup>
      </Sheet>
    );
  }
  // A modal dialog is drawn on top of the page but inherits from where it sits in it: inside a table
  // cell it would otherwise never wrap its text.
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn("form-dialog whitespace-normal", className)}
      onCancel={(e) => {
        if (!dismissible) e.preventDefault();
        else onClose();
      }}
      onClose={onClose}
      onClick={(e) => {
        if (!dismissible || e.target !== e.currentTarget) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <DialogPortalContainer value={ref}>
        <div className="dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && (
              <p id={descriptionId} className="muted small wrap-anywhere">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            onClick={onClose}
            aria-label="Close dialog"
            disabled={!dismissible}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>
        <div className="dialog-body">{children}</div>
      </DialogPortalContainer>
    </dialog>
  );
}

/**
 * Asks before an action that is hard to undo. Cancel, Escape, and a click outside all decline,
 * except while the action runs. If it fails, `error` says why beside the buttons.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger = false,
  pending = false,
  error = null,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} description={description} dismissible={!pending} onClose={onClose}>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className={cn("row-actions", error && "mt-3")}>
        <Button disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} disabled={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
