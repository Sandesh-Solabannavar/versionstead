import {
  memo,
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  ChevronDown,
  Clock3,
  Folder,
  Laptop,
  Package as PackageIcon,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  decodeProject,
  decodeMonitoringSettings,
  decodeAcceptedResponse,
  type Dependency,
  type Finding,
  type Project,
} from "@versionstead/contracts/monitoring";
import { useMonitoring } from "./monitoring";
import { actionKeys } from "./monitoring-actions";
import { useApplication } from "./application";
import { latestEvidence } from "./computer-evidence";
import { AddProjectDialog } from "./add-project";
import { ProjectBadge } from "./project-icons";
import { ProjectCommands } from "./project-settings";
import { Switch } from "./components/ui/switch";
import {
  GlobalToolUpdateButton,
  GlobalToolUpdateDetails,
  useGlobalToolUpdates,
} from "./global-tool-updates";
import { versionCandidate } from "./versions";
import { npmPackageUrl } from "./upgrade-commands";
import {
  advisoryTone,
  compareFindings,
  dependencyUpgradeOption,
  filterInstallations,
  findingSummary,
  findingsRetained,
  findingUpgradeCommands,
  globalToolSourceState,
  installationCandidate,
  lifecycleNote,
  lifecycleRows,
  noun,
  pcUpdateState,
  plural,
  attentionGroups,
  findingCounts,
  projectNeedsAttention,
  dependencyNeedsAttention,
  dependencyFindings,
  restartAdvice,
  workspaceLabel,
  uniqueRowLabels,
  type InventoryFilter,
  type UpgradeOption,
} from "./monitoring-view";
import {
  Badge,
  Button,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  CommandBlock,
  CopyMenuItem,
  Dialog,
  EmptyState,
  Evidence,
  EvidenceBadge,
  FindingBadge,
  LinkMenuItem,
  PageHeading,
  RowActions,
  safeExternalUrl,
  ScanProgress,
  StaleBadge,
  Input,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Table,
  timestamp,
  UpdateKindBadge,
  useFailure,
} from "./ui";

const maintenanceItems = [
  { value: "maintained", label: "Maintained by me" },
  { value: "watch", label: "Watch only" },
];

function intervalOptions(values: number[]) {
  return [...new Set(values)]
    .sort((a, b) => a - b)
    .map((value) => ({
      value: String(value),
      label:
        value === 60
          ? "Every hour"
          : "Every " + (value >= 60 ? value / 60 + " hours" : value + " min"),
    }));
}

function SelectControl({
  label,
  value,
  items,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string" && items.some((item) => item.value === next)) onChange(next);
      }}
    >
      <SelectTrigger aria-label={label} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function useGroupExpansion() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return {
    isOpen: (id: string) => expanded[id] ?? false,
    setOpen: (id: string, open: boolean) =>
      setExpanded((previous) => ({ ...previous, [id]: open })),
    setAll: (ids: readonly string[], open: boolean) =>
      setExpanded((previous) => ({
        ...previous,
        ...Object.fromEntries(ids.map((id) => [id, open])),
      })),
  };
}

function ExpandCollapseAll({
  ids,
  expansion,
}: {
  ids: readonly string[];
  expansion: ReturnType<typeof useGroupExpansion>;
}) {
  return (
    <div className="action-row">
      <Button variant="ghost" size="compact" onClick={() => expansion.setAll(ids, true)}>
        Expand all
      </Button>
      <Button variant="ghost" size="compact" onClick={() => expansion.setAll(ids, false)}>
        Collapse all
      </Button>
    </div>
  );
}

const pageSize = 200;

/** Shows rows 200 at a time; give it a new `key` when its filters or search change. */
function PagedTable<T>({
  label,
  head,
  rows,
  renderRow,
}: {
  label: string;
  head: ReactNode;
  rows: readonly T[];
  renderRow: (item: T) => ReactNode;
}) {
  const [limit, setLimit] = useState(pageSize);
  const body = useRef<HTMLTableSectionElement>(null);
  const remaining = rows.length - limit;
  return (
    <>
      <Table label={label}>
        <thead>{head}</thead>
        <tbody ref={body}>{rows.slice(0, limit).map(renderRow)}</tbody>
      </Table>
      {remaining > 0 && (
        <Button
          size="sm"
          className="mt-3"
          onClick={() => {
            flushSync(() => setLimit(limit + pageSize));
            // Continue at the first revealed row instead of after the table.
            body.current?.rows[limit]?.querySelector("button")?.focus();
          }}
        >
          Show {Math.min(pageSize, remaining)} more ({remaining} remaining)
        </Button>
      )}
    </>
  );
}

// How a version or advisory lookup ended, in words rather than enum values.
const lookupLabels = {
  checked: "Checked",
  "not-checked": "Not checked",
  failed: "Lookup failed",
  unsupported: "Not covered",
} as const;

const matchesProject = (project: Project, search: string) =>
  `${project.name} ${project.path} ${project.packageManager}`.toLowerCase().includes(search);
const matchesDependency = (item: Dependency, search: string) =>
  `${item.name} ${item.packageName} ${item.importer} ${item.origin}`.toLowerCase().includes(search);
const noFindings: readonly Finding[] = [];

function FindingCounts({ counts }: { counts: ReturnType<typeof findingCounts> }) {
  return (
    <div className="monitoring-stats" aria-label="Findings summary">
      <div>
        <PackageIcon size={16} aria-hidden="true" />
        <strong>{counts.packages}</strong>
        <span>{noun(counts.packages, "package with findings", "packages with findings")}</span>
      </div>
      <div>
        <RefreshCw size={15} aria-hidden="true" />
        <strong>{counts.updates}</strong>
        <span>{noun(counts.updates, "update available", "updates available")}</span>
      </div>
      <div>
        <ShieldAlert size={16} aria-hidden="true" />
        <strong>{counts.advisories}</strong>
        <span>{noun(counts.advisories, "advisory finding", "advisory findings")}</span>
      </div>
      <div>
        <Clock3 size={15} aria-hidden="true" />
        <strong>{counts.incomplete}</strong>
        <span>{noun(counts.incomplete, "incomplete check", "incomplete checks")}</span>
      </div>
    </div>
  );
}

/** Where a package can be copied or opened from; items mount only while the menu is open. */
function PackageMenuItems({
  packageName,
  upgrades,
  advisoryUrl = null,
  project,
}: {
  packageName: string | null;
  upgrades: readonly UpgradeOption[];
  advisoryUrl?: string | null;
  project: Project | null;
}) {
  const npm = packageName ? npmPackageUrl(packageName) : null;
  const advisory = safeExternalUrl(advisoryUrl);
  const repository = safeExternalUrl(project?.repository?.url ?? null);
  return (
    <>
      {upgrades.map(({ where, command }) => (
        <CopyMenuItem
          key={command}
          label={upgrades.length > 1 ? `Copy upgrade command (${where})` : "Copy upgrade command"}
          text={command}
          done="Upgrade command copied."
        />
      ))}
      {/* Without a command to copy (an alias, a source that is not the registry, no candidate), the name is still useful. */}
      {upgrades.length === 0 && npm && packageName && (
        <CopyMenuItem label="Copy package name" text={packageName} done="Package name copied." />
      )}
      {npm && <LinkMenuItem label="Open on npm" href={npm} />}
      {advisory && <LinkMenuItem label="Open advisory" href={advisory} />}
      {repository && <LinkMenuItem label="Open repository" href={repository} />}
      {project && !project.repository && (
        <CopyMenuItem label="Copy path" text={project.path} done="Path copied." />
      )}
    </>
  );
}

function FindingMenuItems({ finding, project }: { finding: Finding; project: Project | null }) {
  const { snapshot } = useMonitoring();
  return (
    <PackageMenuItems
      packageName={finding.packageName ?? finding.name}
      upgrades={snapshot ? findingUpgradeCommands(finding, project, snapshot) : []}
      advisoryUrl={finding.advisoryUrl}
      project={project}
    />
  );
}

function DependencyMenuItems({
  dependency,
  project,
}: {
  dependency: Dependency;
  project: Project;
}) {
  const upgrade = dependencyUpgradeOption(project, dependency);
  return (
    <PackageMenuItems
      packageName={dependency.origin === "registry" ? dependency.packageName : null}
      upgrades={upgrade ? [upgrade] : []}
      project={project}
    />
  );
}

declare global {
  interface Window {
    versionstead?: {
      platform: string;
      onNotificationSummary: (listener: (summary: unknown) => void) => () => void;
      setWindowTheme: (theme: unknown) => Promise<void>;
      selectProjectDirectory: () => Promise<string | null>;
      // Windows PowerShell or the owner's login shell runs project commands; a browser has no bridge.
      runProjectAction?: (
        projectId: string,
        actionId: string,
        expectedCommand: string,
      ) => Promise<unknown>;
      projectActionStatus?: (
        input: string | { projectId: string; actionId: string },
      ) => Promise<unknown>;
      stopProjectAction?: (id: string) => Promise<unknown>;
      projectActionShell?: () => Promise<unknown>;
      updateGlobalTool: (input: unknown) => Promise<unknown>;
      globalToolUpdateCommand: (input: unknown) => Promise<unknown>;
      globalToolUpdateStatus: () => Promise<unknown>;
    };
  }
}

function ScanButton({
  target,
  projectId,
  label = "Scan now",
  compact = false,
  subject,
}: {
  target: "pc" | "projects" | "all";
  projectId?: string;
  label?: string;
  compact?: boolean;
  /** What a repeated button scans, so each one has its own accessible name. */
  subject?: string;
}) {
  const { snapshot, connection, pending, mutate } = useMonitoring();
  // Requesting a scan holds back only this scan button, not every other control.
  const key = actionKeys.scan(target, projectId);
  const unsupportedPc =
    !!snapshot && target !== "projects" && snapshot.inventory.collector !== "npm-bun-global-v1";
  const matches = (item: { kind: "pc" | "project"; targetId: string }) =>
    target === "all" ||
    (target === "pc"
      ? item.kind === "pc"
      : item.kind === "project" && (!projectId || projectId === item.targetId));
  const queued = snapshot?.scanProgress?.queued.some(matches);
  const scanning =
    target === "pc"
      ? snapshot?.inventory.evidence.status === "scanning"
      : target === "all"
        ? snapshot?.inventory.evidence.status === "scanning" ||
          snapshot?.projects.some((project) => project.evidence.status === "scanning")
        : snapshot?.projects.some(
            (project) =>
              (!projectId || project.id === projectId) && project.evidence.status === "scanning",
          );
  const text = scanning ? "Scanning…" : queued ? "Queued…" : label;
  return (
    <Button
      variant={compact ? "outline" : "primary"}
      size={compact ? "compact" : "sm"}
      // The name starts with the visible text, as speech-control users say what they see.
      aria-label={subject ? `${text.replace("…", "")}: ${subject}` : undefined}
      disabled={
        connection !== "connected" || pending.has(key) || scanning || queued || unsupportedPc
      }
      onClick={() => {
        void mutate(
          "/api/scans",
          { target, ...(projectId ? { projectId } : {}) },
          decodeAcceptedResponse,
          "Scan requested. Results will appear as collection finishes.",
          "POST",
          { key },
        );
      }}
    >
      <RefreshCw size={13} aria-hidden="true" />
      {text}
    </Button>
  );
}

function FindingDetails({ finding, close }: { finding: Finding; close: () => void }) {
  const { snapshot } = useMonitoring();
  const project = snapshot?.projects.find((item) => item.id === finding.subjectId);
  const evidence =
    project?.evidence ??
    (finding.kind === "update"
      ? (snapshot?.inventory.updateEvidence ?? snapshot?.inventory.evidence)
      : snapshot?.inventory.evidence);
  const url = safeExternalUrl(finding.advisoryUrl);
  return (
    <Dialog title="Finding evidence" onClose={close} drawer>
      <FindingBadge finding={finding} />
      <h3 className="detail-title">{finding.name}</h3>
      <p>{finding.description}</p>
      <dl className="details-list">
        <dt>Affected target</dt>
        <dd>{finding.subjectLabel}</dd>
        <dt>Observed version</dt>
        <dd className="mono">{finding.installedVersion ?? "Unknown"}</dd>
        <dt>
          {finding.kind === "advisory" ? "Provider-listed fixed boundary" : "Candidate version"}
        </dt>
        <dd className="mono">{finding.availableVersion ?? "Not established"}</dd>
        <dt>Source</dt>
        <dd>{finding.source}</dd>
        <dt>First detected</dt>
        <dd>{timestamp(finding.detectedAt)}</dd>
        <dt>Last seen</dt>
        <dd>{timestamp(finding.lastSeenAt)}</dd>
      </dl>
      {evidence && (
        <Evidence
          level={3}
          evidence={evidence}
          {...(project ? { inputFingerprint: project.inputFingerprint ?? null } : {})}
        />
      )}
      {finding.kind === "advisory" && (
        <p className="notice warning">
          A provider-listed fixed boundary does not establish that a candidate release resolves
          every advisory. Review affected ranges, release branches, and all findings before
          updating.
        </p>
      )}
      <section className="detail-section">
        <h3>What you can do next</h3>
        <p className="muted">
          {finding.kind === "coverage"
            ? "Review the missing input or access limitation, then request a new read-only scan. Previous evidence remains visible."
            : "Review the source evidence before choosing an update. Versionstead does not install software or change project files during monitoring."}
        </p>
        {url && (
          <a className="text-link" href={url} target="_blank" rel="noreferrer">
            Open advisory source ↗
          </a>
        )}
      </section>
    </Dialog>
  );
}

const sameFindings = (a: readonly Finding[], b: readonly Finding[]) =>
  a.length === b.length && a.every((finding, index) => finding === b[index]);

// Collapsed groups stay mounted so browser find can reach their rows, and scan progress reaches
// the page every second. Skipping a re-render unless this table's own findings change keeps both
// cheap, and rows page 200 at a time so entering the page has a ceiling. Give it a new `key` when
// the filter or search changes.
const FindingsTable = memo(
  function FindingsTable({
    label,
    findings,
    project,
    retained,
    select,
  }: {
    label: string;
    findings: readonly Finding[];
    project: Project | null;
    retained: boolean;
    select: (findingId: string) => void;
  }) {
    const names = useMemo(
      () =>
        uniqueRowLabels(
          findings,
          (finding) => `${finding.name}, ${findingSummary(finding)}`,
          (finding) => finding.id,
        ),
      [findings],
    );
    return (
      <PagedTable
        label={label}
        head={
          <tr>
            <th scope="col">Affected package</th>
            <th scope="col">Version evidence</th>
            <th scope="col">Finding</th>
            <th scope="col">Source</th>
            <th scope="col">Last seen</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        }
        rows={findings}
        renderRow={(finding) => (
          <tr key={finding.id}>
            <td>
              <div className="package-label">
                <PackageIcon size={14} aria-hidden="true" />
                <button className="item-label" onClick={() => select(finding.id)}>
                  {finding.name}
                </button>
              </div>
              {finding.packageName && finding.packageName !== finding.name && (
                <span className="table-subtext mono">{finding.packageName}</span>
              )}
            </td>
            <td className="mono">
              {finding.installedVersion ?? "Unknown"}
              {finding.availableVersion &&
                (finding.kind === "advisory" ? (
                  <span className="table-subtext">
                    Provider boundary: {finding.availableVersion}
                  </span>
                ) : (
                  <> → {finding.availableVersion}</>
                ))}
              {retained && <span className="table-subtext">Previous, unverified</span>}
            </td>
            <td>
              <FindingBadge finding={finding} />
            </td>
            <td className="muted">{finding.source}</td>
            <td className="muted">{timestamp(finding.lastSeenAt)}</td>
            <td>
              <RowActions label={`Actions for ${names.get(finding.id)}`}>
                <FindingMenuItems finding={finding} project={project} />
              </RowActions>
            </td>
          </tr>
        )}
      />
    );
  },
  (previous, next) =>
    previous.label === next.label &&
    previous.project === next.project &&
    previous.retained === next.retained &&
    previous.select === next.select &&
    sameFindings(previous.findings, next.findings),
);

export function Attention() {
  const { snapshot, connection, pending } = useMonitoring();
  const { snapshot: application, computerEvidence, unreadableEvidence } = useApplication();
  const { filter = "all" } = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const findings = snapshot?.findings ?? [];
  const allGroups = useMemo(() => (snapshot ? attentionGroups(snapshot) : []), [snapshot]);
  const groups = useMemo(
    () => (snapshot ? attentionGroups(snapshot, filter, search) : []),
    [snapshot, filter, search],
  );
  const remoteGroups = useMemo(
    () =>
      new Map(
        application?.computers.map((computer) => {
          const evidence = computerEvidence.get(computer.id);
          return [
            computer.id,
            evidence ? attentionGroups(evidence.snapshot, filter, search) : [],
          ] as const;
        }),
      ),
    [application, computerEvidence, filter, search],
  );
  const expansion = useGroupExpansion();
  const selected = findings.find((finding) => finding.id === selectedId);
  const counts = allGroups.reduce(
    (total, group) => ({
      packages: total.packages + group.counts.packages,
      updates: total.updates + group.counts.updates,
      advisories: total.advisories + group.counts.advisories,
      incomplete: total.incomplete + group.counts.incomplete,
    }),
    { packages: 0, updates: 0, advisories: 0, incomplete: 0 },
  );
  const collected =
    !!snapshot &&
    (snapshot.inventory.evidence.lastAttempt !== null ||
      snapshot.projects.some((project) => project.evidence.lastAttempt !== null));
  return (
    <>
      <PageHeading
        title="Needs attention"
        description="Review updates, advisories, and incomplete checks, grouped by your PC and selected projects."
        actions={<ScanButton target="all" />}
      />
      <ScanProgress snapshot={snapshot} connected={connection === "connected"} />
      {application &&
        application.computers.some(
          (computer) =>
            computer.error ||
            !computerEvidence.has(computer.id) ||
            latestEvidence(computer, computerEvidence, unreadableEvidence) === "failed" ||
            remoteGroups.get(computer.id)?.length,
        ) && (
          <section className="setting-section" aria-label="Connected PC attention">
            <h2>Connected PCs</h2>
            <div className="setting-group">
              {application.computers.flatMap((computer) => {
                const remote = remoteGroups.get(computer.id) ?? [];
                const received = computerEvidence.has(computer.id);
                const latest = latestEvidence(computer, computerEvidence, unreadableEvidence);
                if (!remote.length && !computer.error && received && latest !== "failed") return [];
                return (
                  <div className="preference-row" key={computer.id}>
                    <div>
                      <h3>{computer.label}</h3>
                      <p className="muted small">
                        {received
                          ? `${plural(remote.length, "target")} ${remote.length === 1 ? "needs" : "need"} attention${
                              latest === "current"
                                ? ""
                                : ` in earlier evidence; the latest ${latest === "failed" ? "could not be read" : "is being read"}`
                            }`
                          : latest === "none"
                            ? "No evidence received"
                            : latest === "failed"
                              ? "Evidence could not be read"
                              : "Loading evidence…"}{" "}
                        · Last received {timestamp(computer.checkedAt)}
                        {computer.error ? " · Unreachable, evidence retained" : ""}
                      </p>
                    </div>
                    <Link
                      className="button outline"
                      to="/computers/$computerId"
                      params={{ computerId: computer.id }}
                    >
                      View evidence
                    </Link>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      {!snapshot ? (
        <EmptyState title="Waiting for your coordinator">
          <p>
            Connect to read saved evidence. Software health cannot be established until a scan
            completes.
          </p>
        </EmptyState>
      ) : !collected && findings.length === 0 && snapshot.projects.length === 0 ? (
        <EmptyState
          title="Your monitoring starts here"
          action={
            <>
              <ScanButton target="pc" label="Scan this PC" />
              <Button
                disabled={connection !== "connected" || pending.has(actionKeys.addProject)}
                onClick={() => setAdding(true)}
              >
                Select project folders
              </Button>
            </>
          }
        >
          <p>
            Collect a read-only inventory of this PC and select the projects you want to monitor. No
            evidence has been collected yet.
          </p>
        </EmptyState>
      ) : (
        <>
          <FindingCounts counts={counts} />
          <div className="monitoring-toolbar">
            <div className="tabs" role="group" aria-label="Filter findings">
              {(["all", "updates", "advisories", "coverage"] as const).map((item) => (
                <Button
                  key={item}
                  variant={filter === item ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={filter === item}
                  onClick={() => {
                    void navigate({ search: item === "all" ? {} : { filter: item } });
                  }}
                >
                  {
                    {
                      all: "All findings",
                      updates: "Updates",
                      advisories: "Advisories",
                      coverage: "Incomplete checks",
                    }[item]
                  }
                  <Badge>
                    {item === "all"
                      ? counts.updates + counts.advisories + counts.incomplete
                      : item === "updates"
                        ? counts.updates
                        : item === "advisories"
                          ? counts.advisories
                          : counts.incomplete}
                  </Badge>
                </Button>
              ))}
            </div>
            <label className="monitoring-search">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search findings and targets</span>
              <Input
                type="search"
                placeholder="Search packages or projects…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="monitoring-summary">
            <span>{plural(groups.length, "target")} shown</span>
            <ExpandCollapseAll ids={groups.map((group) => group.id)} expansion={expansion} />
          </div>
          {groups.length === 0 ? (
            <EmptyState
              title={
                filter === "all" && !search.trim()
                  ? "No recorded findings"
                  : "No findings match this view"
              }
            >
              <p>
                Change your filters to inspect other evidence. Missing or unsupported checks cannot
                establish safety.
              </p>
            </EmptyState>
          ) : (
            <div className="target-groups">
              {groups.map((group) => {
                const packageFindings = group.findings.filter(
                  (finding) => finding.kind !== "coverage",
                );
                const coverageFindings = group.findings.filter(
                  (finding) => finding.kind === "coverage",
                );
                return (
                  <Collapsible
                    key={group.id}
                    className="target-group"
                    open={expansion.isOpen(group.id)}
                    onOpenChange={(open) => expansion.setOpen(group.id, open)}
                  >
                    <div className="target-group-header">
                      <h2 className="target-group-heading">
                        <CollapsibleTrigger className="target-group-trigger">
                          <ChevronDown className="target-chevron" size={15} aria-hidden="true" />
                          <span className="target-group-icon">
                            {group.kind === "pc" ? (
                              <Laptop size={19} aria-hidden="true" />
                            ) : group.project ? (
                              <ProjectBadge project={group.project} />
                            ) : (
                              <Folder size={19} aria-hidden="true" />
                            )}
                          </span>
                          <span className="target-group-title">
                            <strong>{group.kind === "pc" ? "This PC" : group.label}</strong>
                            <span>
                              {group.project
                                ? group.project.packageManager +
                                  " · " +
                                  (group.project.mode === "maintained"
                                    ? "Maintained by me"
                                    : "Watch only")
                                : "npm and Bun globals · " + group.label}
                            </span>
                          </span>
                          <span className="target-group-badges">
                            {group.counts.updates > 0 && (
                              <Badge tone="info">
                                {plural(
                                  group.counts.updates,
                                  "update available",
                                  "updates available",
                                )}
                              </Badge>
                            )}
                            {group.counts.advisories > 0 && (
                              <Badge
                                tone={advisoryTone(
                                  packageFindings.filter((finding) => finding.kind === "advisory"),
                                )}
                              >
                                {plural(group.counts.advisories, "advisory", "advisories")}
                              </Badge>
                            )}
                            <EvidenceBadge status={group.evidence.status} />
                            <StaleBadge
                              lastSuccess={group.evidence.lastSuccess}
                              intervalMinutes={
                                group.kind === "pc"
                                  ? snapshot.settings.pcIntervalMinutes
                                  : snapshot.settings.projectIntervalMinutes
                              }
                            />
                            {group.queued && <Badge tone="info">Queued</Badge>}
                          </span>
                          <span className="target-group-time">
                            <Clock3 size={12} aria-hidden="true" />
                            <span>
                              Last success
                              <br />
                              {timestamp(group.evidence.lastSuccess)}
                            </span>
                          </span>
                        </CollapsibleTrigger>
                      </h2>
                      <div className="target-group-actions">
                        <ScanButton
                          compact
                          target={group.kind === "pc" ? "pc" : "projects"}
                          {...(group.project ? { projectId: group.id } : {})}
                          subject={group.kind === "pc" ? "this PC" : group.label}
                        />
                      </div>
                    </div>
                    <CollapsiblePanel className="target-group-panel" hiddenUntilFound>
                      <div className="target-group-body">
                        {group.project && (
                          <div className="group-context">
                            <span className="mono path">{group.project.path}</span>
                            <Link className="text-link" to="/projects">
                              Manage selected projects →
                            </Link>
                          </div>
                        )}
                        {coverageFindings.length > 0 ? (
                          <section className="notice warning group-coverage">
                            <h3>Incomplete checks</h3>
                            {coverageFindings.map((finding) => (
                              <div key={finding.id}>
                                <p>{finding.description}</p>
                                <Button
                                  variant="ghost"
                                  size="compact"
                                  onClick={() => setSelectedId(finding.id)}
                                >
                                  View scan details
                                </Button>
                              </div>
                            ))}
                          </section>
                        ) : group.evidence.errors.length > 0 ? (
                          <section className="notice warning group-coverage">
                            <h3>Incomplete checks</h3>
                            <ul>
                              {group.evidence.errors.map((error) => (
                                <li key={error}>{error}</li>
                              ))}
                            </ul>
                          </section>
                        ) : null}
                        {packageFindings.length > 0 ? (
                          <FindingsTable
                            key={`${filter}:${search}`}
                            label={group.label + " findings"}
                            findings={packageFindings}
                            project={group.project}
                            retained={findingsRetained(group.evidence.status)}
                            select={setSelectedId}
                          />
                        ) : coverageFindings.length === 0 && group.evidence.errors.length === 0 ? (
                          <EmptyState
                            level={3}
                            title={
                              group.evidence.status === "not-scanned"
                                ? "No evidence collected for this target"
                                : group.active || group.queued
                                  ? "Collection is in progress"
                                  : "No package findings in this view"
                            }
                          >
                            <p>
                              {group.evidence.status === "not-scanned"
                                ? "Request a read-only scan to inspect supported inputs. No findings have been established yet."
                                : "Review scan coverage and timestamps before drawing a conclusion."}
                            </p>
                          </EmptyState>
                        ) : null}
                        <details className="group-evidence">
                          <summary>Scan evidence & coverage</summary>
                          <Evidence
                            level={3}
                            evidence={group.evidence}
                            {...(group.project
                              ? { inputFingerprint: group.project.inputFingerprint ?? null }
                              : {})}
                          />
                          {group.kind === "pc" && snapshot.inventory.updateEvidence && (
                            <Evidence
                              level={3}
                              evidence={snapshot.inventory.updateEvidence}
                              title="Global tool upgrade checks"
                            />
                          )}
                        </details>
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                );
              })}
            </div>
          )}
        </>
      )}
      {selected && <FindingDetails finding={selected} close={() => setSelectedId(null)} />}
      {adding && <AddProjectDialog close={() => setAdding(false)} added={() => {}} />}
    </>
  );
}
export function ThisPc() {
  const { snapshot, connection } = useMonitoring();
  const updater = useGlobalToolUpdates();
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [source, setSource] = useState("all");
  const [filter, setFilter] = useState<InventoryFilter>("updates");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const installations = snapshot?.inventory.installations ?? [];
  const selected = installations.find((item) => item.id === selectedId);
  const managers = snapshot?.inventory.managers ?? [];
  const visible = filterInstallations(installations, filter, source, search);
  const unscanned = snapshot?.inventory.evidence.lastAttempt === null && installations.length === 0;
  const updates = installations.filter((item) => item.updateStatus === "available").length;
  const unverified = installations.filter((item) => item.updateStatus === "unknown").length;
  const emptyUpdateState = snapshot ? pcUpdateState(snapshot.inventory) : null;
  const previous = snapshot?.inventory.updateEvidence?.status === "failed";
  const lastChecked =
    (snapshot?.inventory.updateEvidence ?? snapshot?.inventory.evidence)?.lastSuccess ?? null;
  return (
    <>
      <PageHeading
        title="This PC"
        description="Globally installed npm and Bun tools, their installed versions, and available upgrades."
        actions={<ScanButton target="pc" />}
      />
      <ScanProgress snapshot={snapshot} connected={connection === "connected"} kind="pc" />
      {updater.error && (
        <p role="alert" className="error-text small mb-4">
          {updater.error}
        </p>
      )}
      {updater.runs.length > 0 && (
        <div className="panel panel-body mb-4" aria-label="Global tool updates" aria-live="polite">
          {updater.runs.map((run) => (
            <p
              key={`${run.rootId}:${run.name}`}
              className={run.status === "failed" ? "small error-text" : "small"}
            >
              {run.message}
            </p>
          ))}
        </div>
      )}
      {snapshot && snapshot.inventory.collector !== "npm-bun-global-v1" ? (
        <EmptyState title="Global tool scanner update required">
          <p>
            Restart monitoring to detect npm and Bun global tools.{" "}
            {restartAdvice(
              snapshot.runtime.host,
              Boolean(window.versionstead),
              snapshot.runtime.platform,
            )}
          </p>
        </EmptyState>
      ) : snapshot && unscanned ? (
        <EmptyState
          title="Scan this PC to check your global tools"
          action={<ScanButton target="pc" label="Scan this PC" />}
        >
          <p>
            Detect npm and Bun, read their global packages, and check public registry versions.
            Scans do not install or upgrade anything.
          </p>
        </EmptyState>
      ) : snapshot ? (
        <>
          <section className="manager-statuses" aria-label="Global package managers">
            {managers.map((manager) => {
              const state = globalToolSourceState(manager);
              return (
                <div className="panel panel-body" key={manager.manager}>
                  <div className="coverage-row">
                    <h2>{manager.manager === "npm" ? "npm" : "Bun"}</h2>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </div>
                  <p className="muted small">{state.description}</p>
                  {manager.status === "detected" && (
                    <p className="small">
                      {plural(
                        installations.filter((item) => item.manager === manager.manager).length,
                        "global tool",
                      )}{" "}
                      collected
                    </p>
                  )}
                  {manager.error && manager.status !== "unavailable" && (
                    <p className="small error-text">{manager.error}</p>
                  )}
                  {manager.root && (
                    <details className="inventory-coverage">
                      <summary>Configured global location</summary>
                      <p className="mono small">{manager.root}</p>
                      <p className="muted small">Source evidence: {timestamp(manager.checkedAt)}</p>
                    </details>
                  )}
                </div>
              );
            })}
          </section>
          <div className="inventory-summary">
            <p>
              <strong>
                {snapshot.inventory.updateEvidence?.status === "complete" ||
                snapshot.inventory.updateEvidence?.status === "partial"
                  ? `${plural(updates, "global tool update")} available`
                  : previous
                    ? plural(updates, "previously recorded global tool update")
                    : snapshot.inventory.evidence.status === "scanning"
                      ? "Checking global tool updates"
                      : snapshot.inventory.updateEvidence?.status === "not-scanned"
                        ? "Ready to check for updates"
                        : "Update checks unavailable"}
              </strong>{" "}
              · {plural(installations.length, "global installation")}
              {unverified > 0 ? ` · ${unverified} unverified` : ""}
              {lastChecked && (
                <>
                  {" "}
                  · Last successful check {timestamp(lastChecked)}{" "}
                  <StaleBadge
                    lastSuccess={lastChecked}
                    intervalMinutes={snapshot.settings.pcIntervalMinutes}
                  />
                </>
              )}
            </p>
            <p className="muted small">
              Blank update cells mean no verified result. Review source coverage below before
              treating a check as complete.
            </p>
            {!updater.desktop && updates > 0 && (
              <p className="muted small">Updates run in the Versionstead desktop app.</p>
            )}
          </div>
          <div className="table-toolbar">
            <div className="inventory-filters">
              <label className="filter-control">
                <span>Show</span>
                <SelectControl
                  label="Global tool update filter"
                  value={filter}
                  onChange={(value) => setFilter(value as InventoryFilter)}
                  items={[
                    { value: "updates", label: "Updates available" },
                    { value: "all", label: "All global tools" },
                    { value: "current", label: "Up to date at checked source" },
                    { value: "unverified", label: "Unverified" },
                  ]}
                />
              </label>
              <label className="filter-control">
                <span>Package manager</span>
                <SelectControl
                  label="Global package manager"
                  value={source}
                  onChange={setSource}
                  items={[
                    { value: "all", label: "npm and Bun" },
                    { value: "npm", label: "npm" },
                    { value: "bun", label: "Bun" },
                  ]}
                />
              </label>
            </div>
            <label className="search-control">
              <span className="sr-only">Search global tools</span>
              <Input
                type="search"
                placeholder="Search global tools…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {visible.length === 0 ? (
            <EmptyState
              title={
                source !== "all" || search.trim() || filter !== "updates"
                  ? "No global tools match this filter"
                  : (emptyUpdateState?.title ?? "Global tool checking unavailable")
              }
              action={<ScanButton target="pc" />}
            >
              <p>
                {source !== "all" || search.trim() || filter !== "updates"
                  ? "Change the update filter, package manager, or search to see other collected global tools."
                  : emptyUpdateState?.description}
              </p>
            </EmptyState>
          ) : (
            <>
              <PagedTable
                key={`${filter}:${source}:${search}`}
                label="Globally installed tools"
                head={
                  <tr>
                    <th scope="col">Global tool</th>
                    <th scope="col">Installed</th>
                    <th scope="col">Available</th>
                    <th scope="col">Manager / channel</th>
                    <th scope="col">Update check</th>
                    <th scope="col">
                      <span className="sr-only">Update package</span>
                    </th>
                  </tr>
                }
                rows={visible}
                renderRow={(item) => (
                  <tr key={item.id}>
                    <td>
                      <button className="item-label" onClick={() => setSelectedId(item.id)}>
                        {item.name}
                      </button>
                      <span className="table-subtext">
                        {item.manager ?? item.source} global installation
                      </span>
                    </td>
                    <td className="mono">{item.version}</td>
                    <td className="mono">{installationCandidate(item, previous)}</td>
                    <td>
                      {item.source}
                      <span className="table-subtext">{item.channel}</span>
                    </td>
                    <td>
                      {item.updateStatus !== "unknown" && (
                        <div className="package-checks">
                          <Badge tone={item.updateStatus === "available" ? "info" : "neutral"}>
                            {previous
                              ? "Previous result"
                              : item.updateStatus === "available"
                                ? "Update available"
                                : "Current at source"}
                          </Badge>
                          {item.updateStatus === "available" && !previous && (
                            <UpdateKindBadge
                              installed={item.version}
                              candidate={item.availableVersion}
                            />
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <GlobalToolUpdateButton item={item} updater={updater} />
                    </td>
                  </tr>
                )}
              />
              <p className="table-note">
                A tool installed through both npm and Bun appears separately. Installed versions
                come from each global location; private, linked, and unsupported packages remain
                unverified.
              </p>
            </>
          )}
          <details className="inventory-coverage">
            <summary>Source coverage & scan evidence</summary>
            <Evidence evidence={snapshot.inventory.evidence} title="Inventory collection" />
            {snapshot.inventory.updateEvidence && (
              <Evidence
                evidence={snapshot.inventory.updateEvidence}
                title="Global tool upgrade checks"
              />
            )}
          </details>
        </>
      ) : (
        <EmptyState title="Global tool inventory unavailable">
          <p>Connect to the local coordinator to read collected global tools.</p>
        </EmptyState>
      )}
      {selected && (
        <Dialog title="Installation evidence" onClose={() => setSelectedId(null)} drawer>
          <h3>{selected.name}</h3>
          <GlobalToolUpdateDetails key={selected.id} item={selected} updater={updater} />
          <dl className="details-list">
            <dt>Installation identity</dt>
            <dd className="mono">{selected.id}</dd>
            <dt>Installed version</dt>
            <dd className="mono">{selected.version}</dd>
            <dt>Available version</dt>
            <dd className="mono">{installationCandidate(selected, previous)}</dd>
            <dt>Package manager</dt>
            <dd>{selected.source}</dd>
            {selected.rootId && (
              <>
                <dt>Observed installation root identity</dt>
                <dd className="mono">{selected.rootId}</dd>
              </>
            )}
            {selected.origin && (
              <>
                <dt>Package origin</dt>
                <dd>{selected.origin}</dd>
              </>
            )}
            {selected.packageId && (
              <>
                <dt>Package identity</dt>
                <dd className="mono">{selected.packageId}</dd>
              </>
            )}
            {selected.updateCheckedAt && (
              <>
                <dt>Update check time</dt>
                <dd>{timestamp(selected.updateCheckedAt)}</dd>
              </>
            )}
            <dt>Scope</dt>
            <dd>{selected.scope}</dd>
            <dt>Channel</dt>
            <dd>{selected.channel}</dd>
          </dl>
          {snapshot && <Evidence level={3} evidence={snapshot.inventory.evidence} />}
          {snapshot?.inventory.updateEvidence && (
            <Evidence
              level={3}
              evidence={snapshot.inventory.updateEvidence}
              title="Global tool upgrade checks"
            />
          )}
          <p className="notice warning">
            Background monitoring reads the owner's saved global locations. Inaccessible folders and
            unverified package origins retain previous evidence without claiming a fresh check.
          </p>
        </Dialog>
      )}
    </>
  );
}

function DependencyDetails({
  dependency,
  project,
  close,
}: {
  dependency: Dependency;
  project: Project;
  close: () => void;
}) {
  const { snapshot } = useMonitoring();
  const related = dependencyFindings(
    dependency,
    snapshot?.findings.filter((finding) => finding.subjectId === project.id) ?? [],
  );
  const findings = [
    ...new Map(
      related.map((finding) => [
        JSON.stringify([
          finding.kind,
          finding.installedVersion,
          finding.availableVersion,
          finding.source,
          finding.advisoryUrl,
          finding.severity,
          finding.description,
          finding.lastSeenAt,
        ]),
        finding,
      ]),
    ).values(),
  ].sort(compareFindings);
  return (
    <Dialog title="Dependency evidence" onClose={close} drawer>
      <h3>{dependency.name}</h3>
      <dl className="details-list">
        <dt>Package identity</dt>
        <dd className="mono">{dependency.packageName}</dd>
        <dt>Requested range</dt>
        <dd className="mono">{dependency.requested ?? "Transitive dependency"}</dd>
        <dt>Resolved version</dt>
        <dd className="mono">{dependency.resolved ?? "Unknown"}</dd>
        <dt>Compatible candidate</dt>
        <dd className="mono">{versionCandidate(dependency, "compatible")}</dd>
        <dt>Latest at source</dt>
        <dd className="mono">{versionCandidate(dependency, "latest")}</dd>
        <dt>Version lookup</dt>
        <dd>
          {dependency.versionStatus === "checked"
            ? "Checked at scan time"
            : dependency.versionStatus === "failed"
              ? "Failed · previous candidates unverified"
              : dependency.versionStatus === "unsupported"
                ? "No registry version coverage"
                : "Not checked"}
        </dd>
        <dt>Origin</dt>
        <dd>{dependency.origin}</dd>
        <dt>Role</dt>
        <dd>{dependency.role}</dd>
        <dt>Workspace</dt>
        <dd className="mono">{workspaceLabel(dependency.importer)}</dd>
        <dt>Advisory lookup</dt>
        <dd>{lookupLabels[dependency.advisoryStatus]}</dd>
        <dt>Advisory identifiers</dt>
        <dd>
          {dependency.advisoryIds.length
            ? dependency.advisoryIds.join(", ")
            : dependency.advisoryStatus === "checked"
              ? "No known matches at scan time"
              : "Not established"}
        </dd>
        <dt>Lockfile input</dt>
        <dd className="mono">{project.lockfilePath ?? "Missing"}</dd>
      </dl>
      {findings.length > 0 && (
        <section className="detail-section">
          <h3>Package findings</h3>
          {findings.map((finding) => {
            const url = safeExternalUrl(finding.advisoryUrl);
            return (
              <article className="dependency-finding" key={finding.id}>
                <FindingBadge finding={finding} />
                <p>{finding.description}</p>
                <dl className="details-list">
                  <dt>Source</dt>
                  <dd>{finding.source}</dd>
                  <dt>Last seen</dt>
                  <dd>{timestamp(finding.lastSeenAt)}</dd>
                  {finding.kind === "advisory" && (
                    <>
                      <dt>Provider-listed fixed boundary</dt>
                      <dd className="mono">{finding.availableVersion ?? "Not established"}</dd>
                    </>
                  )}
                </dl>
                {url && (
                  <a className="text-link" href={url} target="_blank" rel="noreferrer">
                    Open advisory source ↗
                  </a>
                )}
              </article>
            );
          })}
        </section>
      )}
      <Evidence
        level={3}
        evidence={project.evidence}
        inputFingerprint={project.inputFingerprint ?? null}
      />
      <p className="notice">
        Requested ranges and resolved versions are separate evidence. Git, workspace, local, and
        unsupported sources do not inherit registry update or advisory coverage.
      </p>
    </Dialog>
  );
}

// Collapsed projects stay mounted so browser find can reach their rows, and scan progress reaches
// the page every second. Stable props let memo skip re-rendering a table nothing changed in.
const ProjectDependencies = memo(function ProjectDependencies({
  project,
  findings,
  search,
  showAll,
  setShowAll,
  clearSearch,
  select,
}: {
  project: Project;
  findings: readonly Finding[];
  search: string;
  showAll: boolean;
  setShowAll: (projectId: string, showAll: boolean) => void;
  clearSearch: () => void;
  select: (projectId: string, dependencyId: string) => void;
}) {
  const rows = useMemo(() => {
    const projectMatches = matchesProject(project, search);
    return project.dependencies.filter(
      (item) =>
        (showAll || dependencyNeedsAttention(item, findings)) &&
        (projectMatches || matchesDependency(item, search)),
    );
  }, [project, findings, search, showAll]);
  // The same package can appear in several workspaces, so each row's menu is named by both.
  const names = useMemo(
    () =>
      uniqueRowLabels(
        rows,
        (item) =>
          `${item.name}${item.resolved ? ` ${item.resolved}` : ""} in ${workspaceLabel(item.importer)}`,
        (item) => item.id,
      ),
    [rows],
  );
  return (
    <>
      <div className="group-toolbar">
        <span>
          {rows.length} of {plural(project.dependencies.length, "dependency record")}
        </span>
        <div className="tabs" role="group" aria-label={project.name + " dependency visibility"}>
          <Button
            variant={!showAll ? "secondary" : "ghost"}
            size="compact"
            aria-pressed={!showAll}
            onClick={() => setShowAll(project.id, false)}
          >
            Needs attention
          </Button>
          <Button
            variant={showAll ? "secondary" : "ghost"}
            size="compact"
            aria-pressed={showAll}
            data-testid="dependency-filter-all"
            onClick={() => setShowAll(project.id, true)}
          >
            All dependencies
          </Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          level={3}
          title={
            search ? "No dependencies match this view" : "No package findings in collected evidence"
          }
          action={
            <Button
              onClick={() => {
                setShowAll(project.id, true);
                clearSearch();
              }}
            >
              Show all dependencies
            </Button>
          }
        >
          <p>
            Coverage gaps apply to the project independently of package findings. Review the scan
            evidence below.
          </p>
        </EmptyState>
      ) : (
        <PagedTable
          key={`${showAll}:${search}`}
          label={project.name + " dependencies"}
          head={
            <tr>
              <th scope="col">Dependency / workspace</th>
              <th scope="col">Requested</th>
              <th scope="col">Resolved</th>
              <th scope="col">Candidate</th>
              <th scope="col">Origin / role</th>
              <th scope="col">Checks & findings</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          }
          rows={rows}
          renderRow={(item) => (
            <tr key={item.id}>
              <td>
                <div className="package-label">
                  <PackageIcon size={14} aria-hidden="true" />
                  <button className="item-label" onClick={() => select(project.id, item.id)}>
                    {item.name}
                  </button>
                </div>
                <span className="table-subtext mono">{workspaceLabel(item.importer)}</span>
                {item.packageName !== item.name && (
                  <span className="table-subtext mono">Alias: {item.packageName}</span>
                )}
              </td>
              <td className="mono">{item.requested ?? "Transitive"}</td>
              <td className="mono">{item.resolved ?? "Unknown"}</td>
              <td className="mono">{versionCandidate(item)}</td>
              <td>
                {item.origin}
                <span className="table-subtext">{item.role}</span>
              </td>
              <td>
                <div className="package-checks">
                  {(item.availableVersion || item.latestVersion) && (
                    <>
                      <Badge tone="info">
                        {item.versionStatus === "checked" ? "Update available" : "Previous update"}
                      </Badge>
                      {item.versionStatus === "checked" && (
                        <UpdateKindBadge
                          installed={item.resolved}
                          candidate={item.availableVersion ?? item.latestVersion}
                        />
                      )}
                    </>
                  )}
                  <Badge
                    tone={
                      item.advisoryIds.length
                        ? advisoryTone(
                            dependencyFindings(item, findings).filter(
                              (finding) => finding.kind === "advisory",
                            ),
                          )
                        : item.advisoryStatus === "checked"
                          ? "neutral"
                          : "warning"
                    }
                  >
                    {item.advisoryIds.length
                      ? item.advisoryStatus === "checked"
                        ? plural(item.advisoryIds.length, "known advisory", "known advisories")
                        : plural(item.advisoryIds.length, "advisory", "advisories") +
                          " (previous, unverified)"
                      : item.advisoryStatus === "checked"
                        ? "No known matches"
                        : lookupLabels[item.advisoryStatus]}
                  </Badge>
                </div>
              </td>
              <td>
                <RowActions label={`Actions for ${names.get(item.id)}`}>
                  <DependencyMenuItems dependency={item} project={project} />
                </RowActions>
              </td>
            </tr>
          )}
        />
      )}
    </>
  );
});

/** Confirms removing a project. A failure shows here, and the dialog stays until the request ends. */
function RemoveProjectDialog({
  project,
  close,
  removed,
}: {
  project: Project;
  close: () => void;
  removed: () => void;
}) {
  const { connection, pending, mutate } = useMonitoring();
  // The dialog owns its error, so each opening starts clean and a failure never reaches another dialog.
  const [error, fail, clearError] = useFailure();
  const key = actionKeys.removeProject(project.id);
  const removing = pending.has(key);
  return (
    <Dialog title={"Remove " + project.name + "?"} onClose={close} dismissible={!removing}>
      <p>
        Remove this folder from monitoring. Its source files and installed dependencies will remain
        untouched.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button disabled={removing} onClick={close}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={connection !== "connected" || removing}
          onClick={() => {
            clearError();
            void mutate(
              "/api/projects/" + encodeURIComponent(project.id),
              {},
              decodeAcceptedResponse,
              "Project removed from monitoring.",
              "DELETE",
              { key, onError: fail },
            ).then((result) => {
              if (result) removed();
            });
          }}
        >
          Remove from monitoring
        </Button>
      </div>
    </Dialog>
  );
}

export function Projects() {
  const { snapshot, connection, pending, mutate } = useMonitoring();
  const [filter, setFilter] = useState<"attention" | "all">("attention");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const canAdd = connection === "connected" && !pending.has(actionKeys.addProject);
  const [selectedDependency, setSelectedDependency] = useState<{
    projectId: string;
    dependencyId: string;
  } | null>(null);
  const [allDependencies, setAllDependencies] = useState<Record<string, boolean>>({});
  const projects = snapshot?.projects ?? [];
  const findings = snapshot?.findings ?? noFindings;
  const attentionProjects = projects.filter((project) =>
    projectNeedsAttention(project, findings, snapshot?.scanProgress),
  );
  const search = deferredQuery.trim().toLowerCase();
  const visibleProjects = (filter === "all" ? projects : attentionProjects).filter(
    (project) =>
      matchesProject(project, search) ||
      project.dependencies.some((item) => matchesDependency(item, search)),
  );
  // Stable per-project lists let each open table keep its memoized rows across polls.
  const findingsByProject = useMemo(() => {
    const groups = new Map<string, Finding[]>();
    for (const finding of findings) {
      const group = groups.get(finding.subjectId);
      if (group) group.push(finding);
      else groups.set(finding.subjectId, [finding]);
    }
    return groups;
  }, [findings]);
  const projectGroups = useMemo(
    () => (snapshot ? attentionGroups(snapshot).filter((group) => group.kind === "project") : []),
    [snapshot],
  );
  const expansion = useGroupExpansion();
  const setShowAll = useCallback(
    (projectId: string, showAll: boolean) =>
      setAllDependencies((previous) => ({ ...previous, [projectId]: showAll })),
    [],
  );
  const clearSearch = useCallback(() => setQuery(""), []);
  const selectDependency = useCallback(
    (projectId: string, dependencyId: string) => setSelectedDependency({ projectId, dependencyId }),
    [],
  );
  const removing = projects.find((project) => project.id === removingId);
  const selectedProject = projects.find((project) => project.id === selectedDependency?.projectId);
  const dependency = selectedProject?.dependencies.find(
    (item) => item.id === selectedDependency?.dependencyId,
  );
  const projectIds = new Set(projects.map((project) => project.id));
  const counts = {
    ...findingCounts(
      findings.filter((finding) => projectIds.has(finding.subjectId)),
      snapshot?.device.id ?? "",
    ),
    incomplete: projectGroups.reduce((total, group) => total + group.counts.incomplete, 0),
  };
  return (
    <>
      <PageHeading
        title="Projects"
        description="Selected folders and repositories, dependencies needing review, and the evidence behind every check."
        actions={
          <div className="action-row">
            <ScanButton target="projects" label="Scan projects" />
            <Button variant="primary" size="sm" disabled={!canAdd} onClick={() => setAdding(true)}>
              <Plus size={14} aria-hidden="true" />
              Add project
            </Button>
          </div>
        }
      />
      <ScanProgress snapshot={snapshot} connected={connection === "connected"} kind="project" />
      {!snapshot ? (
        <EmptyState title="Waiting for your coordinator">
          <p>Connect to read your selected folders and saved project evidence.</p>
        </EmptyState>
      ) : projects.length === 0 ? (
        <EmptyState
          title="Select your first project"
          action={
            <Button variant="primary" disabled={!canAdd} onClick={() => setAdding(true)}>
              Add project
            </Button>
          }
        >
          <p>
            Start with an npm, pnpm, or Bun project. Supported manifests and lockfiles provide
            requested ranges, resolved versions, and source identities. No folder is scanned until
            you select it.
          </p>
        </EmptyState>
      ) : (
        <>
          <FindingCounts counts={counts} />
          <div className="monitoring-toolbar">
            <div className="tabs" role="group" aria-label="Project visibility">
              <Button
                variant={filter === "attention" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={filter === "attention"}
                onClick={() => setFilter("attention")}
              >
                Needs attention<Badge>{attentionProjects.length}</Badge>
              </Button>
              <Button
                variant={filter === "all" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                All projects<Badge>{projects.length}</Badge>
              </Button>
            </div>
            <label className="monitoring-search">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Search projects and dependencies</span>
              <Input
                type="search"
                placeholder="Search projects or packages…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="monitoring-summary">
            <span>
              {visibleProjects.length} of {plural(projects.length, "selected project")} shown ·
              Complete projects with no recorded findings remain available in All projects.
            </span>
            <ExpandCollapseAll ids={visibleProjects.map((item) => item.id)} expansion={expansion} />
          </div>
          {visibleProjects.length === 0 ? (
            <EmptyState
              title={
                query.trim()
                  ? "No projects match this search"
                  : "No projects need review in recorded evidence"
              }
              action={
                <Button
                  onClick={() => {
                    setFilter("all");
                    setQuery("");
                  }}
                >
                  Show all projects
                </Button>
              }
            >
              <p>
                Review all selected folders to inspect coverage, change maintenance intent, scan, or
                remove a project. Collected results do not establish universal safety.
              </p>
            </EmptyState>
          ) : (
            <div className="target-groups">
              {visibleProjects.map((project) => {
                const projectFindings = findingsByProject.get(project.id) ?? noFindings;
                const projectCounts = findingCounts(projectFindings, snapshot.device.id);
                const queued = snapshot.scanProgress?.queued.some(
                  (target) => target.targetId === project.id,
                );
                const scanning =
                  project.evidence.status === "scanning" ||
                  snapshot.scanProgress?.active?.targetId === project.id;
                return (
                  <Collapsible
                    key={project.id}
                    className="target-group project-group"
                    data-testid="project-group"
                    data-project-id={project.id}
                    open={expansion.isOpen(project.id)}
                    onOpenChange={(open) => expansion.setOpen(project.id, open)}
                  >
                    <div className="target-group-header">
                      <h2 className="target-group-heading">
                        <CollapsibleTrigger
                          className="target-group-trigger"
                          data-testid="project-disclosure"
                        >
                          <ChevronDown className="target-chevron" size={15} aria-hidden="true" />
                          <span className="target-group-icon">
                            <ProjectBadge project={project} />
                          </span>
                          <span className="target-group-title">
                            <strong>{project.name}</strong>
                            <span>
                              {project.packageManager} ·{" "}
                              {project.mode === "maintained" ? "Maintained by me" : "Watch only"}
                            </span>
                          </span>
                          <span className="target-group-badges">
                            {projectCounts.updates > 0 && (
                              <Badge tone="info">
                                {plural(
                                  projectCounts.updates,
                                  "update available",
                                  "updates available",
                                )}
                              </Badge>
                            )}
                            {projectCounts.advisories > 0 && (
                              <Badge
                                tone={advisoryTone(
                                  projectFindings.filter((finding) => finding.kind === "advisory"),
                                )}
                              >
                                {plural(projectCounts.advisories, "advisory", "advisories")}
                              </Badge>
                            )}
                            <EvidenceBadge status={project.evidence.status} />
                            <StaleBadge
                              lastSuccess={project.evidence.lastSuccess}
                              intervalMinutes={snapshot.settings.projectIntervalMinutes}
                            />
                            {queued && <Badge tone="info">Queued</Badge>}
                            {!projectNeedsAttention(project, findings, snapshot.scanProgress) && (
                              <Badge>No recorded findings</Badge>
                            )}
                          </span>
                          <span className="target-group-time">
                            <Clock3 size={12} aria-hidden="true" />
                            <span>
                              Last success
                              <br />
                              {timestamp(project.evidence.lastSuccess)}
                            </span>
                          </span>
                        </CollapsibleTrigger>
                      </h2>
                      <div className="target-group-actions">
                        <ScanButton
                          compact
                          target="projects"
                          projectId={project.id}
                          subject={project.name}
                        />
                      </div>
                    </div>
                    <CollapsiblePanel className="target-group-panel" hiddenUntilFound>
                      <section
                        className="target-group-body project-detail"
                        aria-label={project.name + " project details"}
                      >
                        <div className="group-context">
                          <p className="muted mono path">{project.path}</p>
                          <div className="action-row">
                            <SelectControl
                              label={"Maintenance intent for " + project.name}
                              value={project.mode}
                              items={maintenanceItems}
                              disabled={
                                connection !== "connected" ||
                                pending.has(actionKeys.projectMode(project.id))
                              }
                              onChange={(mode) => {
                                void mutate(
                                  "/api/projects/" + encodeURIComponent(project.id),
                                  { mode },
                                  decodeProject,
                                  "Maintenance intent saved.",
                                  "PATCH",
                                  { key: actionKeys.projectMode(project.id) },
                                );
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="compact"
                              disabled={
                                connection !== "connected" ||
                                pending.has(actionKeys.removeProject(project.id))
                              }
                              onClick={() => setRemovingId(project.id)}
                            >
                              Remove
                            </Button>
                            <ProjectCommands project={project} />
                          </div>
                        </div>
                        {project.evidence.errors.length > 0 && (
                          <section className="notice warning group-coverage">
                            <h3>Incomplete checks</h3>
                            <ul>
                              {project.evidence.errors.map((message) => (
                                <li key={message}>{message}</li>
                              ))}
                            </ul>
                          </section>
                        )}
                        {project.dependencies.length === 0 ? (
                          scanning ? (
                            <p className="muted" role="status">
                              Scanning… dependency records appear when this scan finishes.
                            </p>
                          ) : (
                            <EmptyState
                              level={3}
                              title={
                                project.evidence.status === "not-scanned"
                                  ? "This project has not been scanned"
                                  : "No dependency records collected"
                              }
                              action={<ScanButton target="projects" projectId={project.id} />}
                            >
                              <p>
                                {project.evidence.status === "not-scanned"
                                  ? "Run a read-only scan to verify access and inspect supported project inputs."
                                  : "Review coverage and errors. Missing or unsupported inputs leave resolved dependency coverage incomplete."}
                              </p>
                            </EmptyState>
                          )
                        ) : (
                          <ProjectDependencies
                            project={project}
                            findings={projectFindings}
                            search={search}
                            showAll={allDependencies[project.id] === true}
                            setShowAll={setShowAll}
                            clearSearch={clearSearch}
                            select={selectDependency}
                          />
                        )}
                        <details className="group-evidence">
                          <summary>Project inputs, scan evidence & coverage</summary>
                          {project.repository && (
                            <p className="muted">
                              {project.repository.provider === "github" ? "GitHub" : "GitLab"} ·{" "}
                              {project.repository.ref} · Commit{" "}
                              {project.repository.commit ?? "not yet checked"}
                            </p>
                          )}
                          {project.git && (
                            <p className="muted">
                              Git · {project.git.branch ?? "Detached HEAD"} ·{" "}
                              {project.git.commit ?? "No commit"} ·{" "}
                              {project.git.dirty
                                ? "Working tree has tracked changes"
                                : "No tracked changes"}
                            </p>
                          )}
                          <div className="input-summary">
                            <span>
                              Package manager: <strong>{project.packageManager}</strong>
                            </span>
                            <span>
                              Manifest:{" "}
                              <strong className="mono">
                                {project.manifestPath ?? "Not inspected"}
                              </strong>
                            </span>
                            <span>
                              Lockfile:{" "}
                              <strong className="mono">
                                {project.lockfilePath ?? "Not inspected"}
                              </strong>
                            </span>
                          </div>
                          <Evidence
                            level={3}
                            evidence={project.evidence}
                            inputFingerprint={project.inputFingerprint ?? null}
                          />
                        </details>
                      </section>
                    </CollapsiblePanel>
                  </Collapsible>
                );
              })}
            </div>
          )}
        </>
      )}
      {adding && (
        <AddProjectDialog
          close={() => setAdding(false)}
          added={(id) => {
            setFilter("all");
            setQuery("");
            expansion.setOpen(id, true);
          }}
        />
      )}
      {removing && (
        <RemoveProjectDialog
          project={removing}
          close={() => setRemovingId(null)}
          removed={() => {
            setRemovingId(null);
            if (selectedDependency?.projectId === removing.id) setSelectedDependency(null);
          }}
        />
      )}
      {dependency && selectedProject && (
        <DependencyDetails
          dependency={dependency}
          project={selectedProject}
          close={() => setSelectedDependency(null)}
        />
      )}
    </>
  );
}
export function Service() {
  const { snapshot, connection, pending, refreshing, refresh, mutate } = useMonitoring();
  if (!snapshot)
    return (
      <>
        <PageHeading
          title="Background service"
          description="Process health, schedules, startup configuration, and pending notifications."
          actions={
            <Button
              disabled={refreshing}
              onClick={() => {
                void refresh();
              }}
            >
              Retry connection
            </Button>
          }
        />
        <EmptyState title="Coordinator health unknown">
          <p>
            Connect before changing monitoring schedules. A disconnected UI cannot establish whether
            background work is running.
          </p>
        </EmptyState>
      </>
    );
  const settings = snapshot.settings;
  const connected = connection === "connected";
  const undelivered = snapshot.notifications.filter((item) => !item.deliveredAt);
  const summary = snapshot.notificationSummary;
  // Each setting waits only for its own save, so changing one never holds back another.
  const changeSetting = (field: string, value: boolean | number, message: string) => {
    void mutate("/api/settings", { [field]: value }, decodeMonitoringSettings, message, "PATCH", {
      key: actionKeys.setting(field),
    });
  };
  const unavailable = (field: string) => !connected || pending.has(actionKeys.setting(field));
  // The host's platform decides what startup and sign-out can mean; only the desktop has a tray.
  const platform = snapshot.runtime.platform;
  return (
    <>
      <PageHeading
        title="Background service"
        description="Monitoring continues independently of the main window; scan freshness remains visible."
        actions={
          <>
            <Button
              disabled={unavailable("paused")}
              onClick={() =>
                changeSetting(
                  "paused",
                  !settings.paused,
                  settings.paused
                    ? "Scheduled scans resumed."
                    : "Scheduled scans paused. The coordinator remains running.",
                )
              }
            >
              {settings.paused ? "Resume schedules" : "Pause schedules"}
            </Button>
            <ScanButton target="all" />
          </>
        }
      />
      <ScanProgress snapshot={snapshot} connected={connected} />
      <section className="service-status">
        <span className={`status-dot ${connected ? "" : "unknown"}`} aria-hidden="true" />
        <div>
          <h2>{connected ? "Coordinator running" : "Coordinator health unknown"}</h2>
          <p className="muted">
            {connected
              ? settings.paused
                ? "Schedules paused; scan-now remains available."
                : "Scheduled read-only monitoring enabled."
              : "Showing the last received settings and evidence. Current process state is unverified."}
          </p>
        </div>
        <Badge tone={connected ? "success" : "warning"}>
          {connected ? "Connected" : "Disconnected"}
        </Badge>
      </section>
      <div className="settings-grid">
        <section className="settings-section">
          <h2>Lifecycle & access</h2>
          {lifecycleRows(platform, snapshot.runtime.host, Boolean(window.versionstead)).map(
            (row) => (
              <div className="setting-row" key={row.title}>
                <div>
                  <h3>{row.title}</h3>
                  <p>{row.text}</p>
                </div>
                {row.badge && <Badge tone={row.badge.tone}>{row.badge.label}</Badge>}
              </div>
            ),
          )}
          <p className="settings-note">{lifecycleNote(platform)}</p>
          {platform === "win32" && (
            <details className="startup-help">
              <summary>Windows startup setup</summary>
              <p>From the Versionstead project folder, run this in an administrator PowerShell:</p>
              <CommandBlock
                className="mt-2.5"
                command=".\scripts\windows-background.ps1 -Action Install"
                label="Copy Windows startup setup command"
              />
              <p>
                Use the documented ProjectRoots option to grant read access to selected folders.
                Verify boot, sign-out, and source coverage after setup.
              </p>
            </details>
          )}
        </section>
        <div>
          <section className="settings-section">
            <h2>Scan schedule</h2>
            <div className="setting-row">
              <div>
                <h3>Global tools on this PC</h3>
                <p>Read-only npm and Bun global collection and upgrade checks.</p>
              </div>
              <SelectControl
                label="PC scan interval"
                value={String(settings.pcIntervalMinutes)}
                disabled={unavailable("pcIntervalMinutes")}
                items={intervalOptions([15, 60, 360, 720, 1440, settings.pcIntervalMinutes])}
                onChange={(value) =>
                  changeSetting("pcIntervalMinutes", Number(value), "PC scan interval saved.")
                }
              />
            </div>
            <div className="setting-row">
              <div>
                <h3>Selected projects</h3>
                <p>Manifest, supported lockfile, and verified lookups.</p>
              </div>
              <SelectControl
                label="Project scan interval"
                value={String(settings.projectIntervalMinutes)}
                disabled={unavailable("projectIntervalMinutes")}
                items={intervalOptions([15, 60, 360, 1440, settings.projectIntervalMinutes])}
                onChange={(value) =>
                  changeSetting(
                    "projectIntervalMinutes",
                    Number(value),
                    "Project scan interval saved.",
                  )
                }
              />
            </div>
            <div className="setting-row">
              <div>
                <h3>Next scheduled work</h3>
                <p>
                  {connected
                    ? "Schedules reconcile overdue work after restart."
                    : "Last-known schedule; current state is unverified."}
                </p>
              </div>
              <span className="small muted">
                {settings.paused ? "Paused" : timestamp(snapshot.runtime.nextScanAt)}
              </span>
            </div>
          </section>
          <section className="settings-section">
            <h2>Notifications</h2>
            <div className="setting-row">
              <div>
                <h3>Notify with a summary</h3>
                <p>
                  New updates and advisories are grouped into one count-based notification after
                  scanning. Unchanged rescans stay quiet; closely spaced discoveries are combined
                  during a five-minute cooldown.
                </p>
              </div>
              <Switch
                aria-label="Notify on new findings"
                checked={settings.notifyNewFindings}
                disabled={unavailable("notifyNewFindings")}
                onCheckedChange={(value) =>
                  changeSetting("notifyNewFindings", value, "Notification preference saved.")
                }
              />
            </div>
            <div className="setting-row">
              <div>
                <h3>Waiting for delivery</h3>
                <p>
                  {summary
                    ? `${plural(summary.updateCount, "update")} and ${plural(summary.advisoryCount, "advisory finding")} are ready to review.`
                    : undelivered.length
                      ? "New findings are being combined into the next summary."
                      : "No new findings are waiting."}
                </p>
                {snapshot.notificationNextAt && (
                  <p>Next eligible summary: {timestamp(snapshot.notificationNextAt)}</p>
                )}
              </div>
              <Badge tone={undelivered.length ? "info" : "neutral"}>
                {undelivered.length ? "1 summary pending" : "None pending"}
              </Badge>
            </div>
            <p className="settings-note">
              Findings collected while the desktop is closed stay saved. Reopening delivers one
              summary of the backlog; it does not replay an alert for each package.
            </p>
          </section>
        </div>
      </div>
      <section className="history">
        <div className="section-head">
          <h2>Scan history</h2>
          <span className="small muted">{plural(snapshot.history.length, "recorded attempt")}</span>
        </div>
        {snapshot.history.length === 0 ? (
          <p className="muted">No scans have been attempted yet.</p>
        ) : (
          <Table label="Scan history">
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Started / finished</th>
                <th scope="col">Outcome</th>
                <th scope="col">Coverage & errors</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.history.map((scan) => (
                <tr key={scan.id}>
                  <td>
                    {scan.targetLabel}
                    <span className="table-subtext">
                      {scan.kind === "pc" ? "This PC" : "Project"}
                    </span>
                  </td>
                  <td>
                    {timestamp(scan.startedAt)}
                    <span className="table-subtext">
                      {scan.finishedAt ? timestamp(scan.finishedAt) : "Not finished"}
                    </span>
                  </td>
                  <td>
                    <EvidenceBadge status={scan.status} />
                  </td>
                  <td className="wrap-cell">
                    {scan.coverage.join(" · ") || "No coverage recorded"}
                    {scan.errors.map((error) => (
                      <span className="table-subtext error-text" key={error}>
                        {error}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
