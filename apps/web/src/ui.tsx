import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { MonitoringSnapshot, ScanEvidence } from "@versionstead/contracts/monitoring";
import { scanDuration, scanStage } from "./monitoring-view";
import {
  Button as ShadcnButton,
  type ButtonProps,
  type ButtonVariant,
} from "./components/ui/button";
import { Badge as ShadcnBadge, type BadgeProps } from "./components/ui/badge";
import { Table as ShadcnTable } from "./components/ui/table";
import { Sheet, SheetPopup, SheetHeader, SheetTitle } from "./components/ui/sheet";
import { cn } from "./lib/utils";

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

export function timestamp(value: string | null) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

export function Evidence({
  evidence,
  inputFingerprint,
  title = "Evidence & coverage",
}: {
  evidence: ScanEvidence;
  inputFingerprint?: string | null;
  title?: string;
}) {
  return (
    <section className="evidence">
      <div className="section-head">
        <h2>{title}</h2>
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
          <h3>Incomplete checks</h3>
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

export function ScanProgress({
  snapshot,
  connected,
  kind,
  targetId,
}: {
  snapshot: MonitoringSnapshot | null;
  connected: boolean;
  kind?: "pc" | "project";
  targetId?: string;
}) {
  if (!snapshot) return null;
  const matches = (target: { kind: "pc" | "project"; targetId: string }) =>
    (!kind || target.kind === kind) && (!targetId || target.targetId === targetId);
  const active = snapshot.scanProgress?.active;
  const scan = active && matches(active) ? active : null;
  const queued = snapshot.scanProgress?.queued.filter(matches) ?? [];
  const last = snapshot.history.find(matches);
  if (!scan && queued.length === 0 && !last) return null;
  const stage = scan ? scanStage(scan) : null;
  return (
    <section
      className={`scan-status ${connected ? "" : "stale"}`}
      aria-label="Scan progress"
      data-testid="scan-progress"
    >
      {scan && stage ? (
        <>
          <div className="scan-status-head">
            <p role="status">
              <strong>{scan.targetLabel}</strong> · {stage.label}
            </p>
            <span className="muted small">{stage.count}</span>
          </div>
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
      ) : queued.length > 0 ? (
        <p role="status">
          <strong>Scan queued</strong> ·{" "}
          {connected
            ? active
              ? "Waiting for the current scan to finish"
              : "Waiting for the coordinator"
            : "Last observed queue; current state unknown"}
        </p>
      ) : last ? (
        <div className="scan-status-head">
          <p role="status">
            <strong>{last.targetLabel}</strong> ·{" "}
            {last.status === "scanning"
              ? "Last observed scan"
              : last.status === "complete"
                ? "Complete"
                : last.status === "partial"
                  ? "Completed with gaps"
                  : last.status === "failed"
                    ? "Failed"
                    : "Unavailable"}
            {!connected ? " · Last received evidence" : ""}
          </p>
          <span className="muted small">
            {last.finishedAt
              ? scanDuration(last.startedAt, last.finishedAt)
              : "Current progress unavailable"}
          </span>
        </div>
      ) : null}
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
  description: string;
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
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        ◎
      </span>
      <h2>{title}</h2>
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [trigger] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const titleId = useId();
  useEffect(() => {
    if (!drawer) ref.current?.showModal();
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
          finalFocus={() => (trigger?.isConnected ? trigger : document.getElementById("content"))}
        >
          <SheetHeader className="dialog-head">
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          <div className="dialog-body min-h-0 overflow-y-auto">{children}</div>
        </SheetPopup>
      </Sheet>
    );
  }
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="form-dialog"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close dialog">
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
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
