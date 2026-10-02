import { useState } from "react";
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
import { versionCandidate } from "./versions";
import {
  filterInstallations,
  globalToolSourceState,
  installationCandidate,
  pcUpdateState,
  attentionGroups,
  findingCounts,
  projectNeedsAttention,
  dependencyNeedsAttention,
  dependencyFindings,
  type InventoryFilter,
} from "./monitoring-view";
import {
  Badge,
  Button,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  Dialog,
  EmptyState,
  Evidence,
  EvidenceBadge,
  PageHeading,
  safeExternalUrl,
  ScanProgress,
  Input,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Table,
  timestamp,
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

function useGroupExpansion(firstId?: string) {
  const [initialId, setInitialId] = useState<string | null>(firstId ?? null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (initialId === null && firstId) setInitialId(firstId);
  return {
    isOpen: (id: string) => expanded[id] ?? id === initialId,
    setOpen: (id: string, open: boolean) =>
      setExpanded((previous) => ({ ...previous, [id]: open })),
  };
}

function FindingCounts({ counts }: { counts: ReturnType<typeof findingCounts> }) {
  return (
    <div className="monitoring-stats" aria-label="Recorded evidence summary">
      <div>
        <PackageIcon size={16} aria-hidden="true" />
        <strong>{counts.packages}</strong>
        <span>packages with findings</span>
      </div>
      <div>
        <RefreshCw size={15} aria-hidden="true" />
        <strong>{counts.updates}</strong>
        <span>recorded updates</span>
      </div>
      <div>
        <ShieldAlert size={16} aria-hidden="true" />
        <strong>{counts.advisories}</strong>
        <span>advisory findings</span>
      </div>
      <div>
        <Clock3 size={15} aria-hidden="true" />
        <strong>{counts.incomplete}</strong>
        <span>incomplete checks</span>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    versionstead?: { selectProjectDirectory: () => Promise<string | null> };
  }
}

function ScanButton({
  target,
  projectId,
  label = "Scan now",
  compact = false,
  ariaLabel,
}: {
  target: "pc" | "projects" | "all";
  projectId?: string;
  label?: string;
  compact?: boolean;
  ariaLabel?: string;
}) {
  const { snapshot, connection, busy, mutate } = useMonitoring();
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
  return (
    <Button
      variant={compact ? "outline" : "primary"}
      size={compact ? "compact" : "sm"}
      aria-label={ariaLabel}
      disabled={connection !== "connected" || busy || scanning || queued || unsupportedPc}
      onClick={() => {
        void mutate(
          "/api/scans",
          { target, ...(projectId ? { projectId } : {}) },
          decodeAcceptedResponse,
          "Scan requested. Results will appear as collection finishes.",
        );
      }}
    >
      <RefreshCw size={13} aria-hidden="true" />
      {scanning ? "Scanning…" : queued ? "Queued…" : label}
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
      <Badge
        tone={
          finding.kind === "advisory" ? "error" : finding.kind === "coverage" ? "warning" : "info"
        }
      >
        {finding.kind === "advisory"
          ? `${finding.severity} advisory`
          : finding.kind === "coverage"
            ? "Incomplete check"
            : "Update available"}
      </Badge>
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

export function Attention() {
  const { snapshot, connection } = useMonitoring();
  const { filter = "all" } = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const findings = snapshot?.findings ?? [];
  const allGroups = snapshot ? attentionGroups(snapshot) : [];
  const groups = snapshot ? attentionGroups(snapshot, filter, query) : [];
  const expansion = useGroupExpansion(
    (groups.find((group) => group.findings.length > 0) ?? groups[0])?.id,
  );
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
              <Link to="/projects" className="button">
                Select project folders
              </Link>
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
                      ? findings.length
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
            <span>{groups.length} targets shown</span>
            <span>
              Package counts combine duplicate project importers; PC locations remain distinct.
            </span>
          </div>
          {groups.length === 0 ? (
            <EmptyState
              title={
                filter === "all" && !query.trim()
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
                              <Badge tone="info">{group.counts.updates} updates</Badge>
                            )}
                            {group.counts.advisories > 0 && (
                              <Badge tone="error">{group.counts.advisories} advisories</Badge>
                            )}
                            <EvidenceBadge status={group.evidence.status} />
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
                          ariaLabel={"Scan " + (group.kind === "pc" ? "this PC" : group.label)}
                        />
                      </div>
                    </div>
                    <CollapsiblePanel className="target-group-panel">
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
                                  Review collector evidence
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
                          <Table label={group.label + " findings"}>
                            <thead>
                              <tr>
                                <th scope="col">Affected package</th>
                                <th scope="col">Version evidence</th>
                                <th scope="col">Finding</th>
                                <th scope="col">Source</th>
                                <th scope="col">Last seen</th>
                              </tr>
                            </thead>
                            <tbody>
                              {packageFindings.map((finding) => (
                                <tr key={finding.id}>
                                  <td>
                                    <div className="package-label">
                                      <PackageIcon size={14} aria-hidden="true" />
                                      <button
                                        className="item-label"
                                        onClick={() => setSelectedId(finding.id)}
                                      >
                                        {finding.name}
                                      </button>
                                    </div>
                                    {finding.packageName &&
                                      finding.packageName !== finding.name && (
                                        <span className="table-subtext mono">
                                          {finding.packageName}
                                        </span>
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
                                    {group.evidence.status === "failed" && (
                                      <span className="table-subtext">Previous, unverified</span>
                                    )}
                                  </td>
                                  <td>
                                    <Badge tone={finding.kind === "advisory" ? "error" : "info"}>
                                      {finding.kind === "advisory"
                                        ? finding.severity + " advisory"
                                        : "Update recorded"}
                                    </Badge>
                                  </td>
                                  <td className="muted">{finding.source}</td>
                                  <td className="muted">{timestamp(finding.lastSeenAt)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        ) : coverageFindings.length === 0 && group.evidence.errors.length === 0 ? (
                          <EmptyState
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
                            evidence={group.evidence}
                            {...(group.project
                              ? { inputFingerprint: group.project.inputFingerprint ?? null }
                              : {})}
                          />
                          {group.kind === "pc" && snapshot.inventory.updateEvidence && (
                            <Evidence
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
          <p className="monitoring-footnote">
            Connection health, scan freshness, and coverage are separate.{" "}
            <Link to="/service" className="text-link">
              Review background monitoring →
            </Link>
          </p>
        </>
      )}
      {selected && <FindingDetails finding={selected} close={() => setSelectedId(null)} />}
    </>
  );
}
export function ThisPc() {
  const { snapshot, connection } = useMonitoring();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [filter, setFilter] = useState<InventoryFilter>("updates");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const installations = snapshot?.inventory.installations ?? [];
  const selected = installations.find((item) => item.id === selectedId);
  const managers = snapshot?.inventory.managers ?? [];
  const visible = filterInstallations(installations, filter, source, query);
  const unscanned = snapshot?.inventory.evidence.lastAttempt === null && installations.length === 0;
  const updates = installations.filter((item) => item.updateStatus === "available").length;
  const unverified = installations.filter((item) => item.updateStatus === "unknown").length;
  const emptyUpdateState = snapshot ? pcUpdateState(snapshot.inventory) : null;
  const previous = snapshot?.inventory.updateEvidence?.status === "failed";
  return (
    <>
      <PageHeading
        title="This PC"
        description="Globally installed npm and Bun tools, their installed versions, and available upgrades."
        actions={<ScanButton target="pc" />}
      />
      <ScanProgress snapshot={snapshot} connected={connection === "connected"} kind="pc" />
      {snapshot && snapshot.inventory.collector !== "npm-bun-global-v1" ? (
        <EmptyState title="Global tool scanner update required">
          <p>Restart monitoring using the instructions above to detect npm and Bun global tools.</p>
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
                      {installations.filter((item) => item.manager === manager.manager).length}{" "}
                      global tools collected
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
                  ? `${updates} global tool updates available`
                  : previous
                    ? `${updates} previously recorded global tool updates`
                    : snapshot.inventory.evidence.status === "scanning"
                      ? "Checking global tool updates"
                      : snapshot.inventory.updateEvidence?.status === "not-scanned"
                        ? "Ready to check for updates"
                        : "Update checks unavailable"}
              </strong>{" "}
              · {installations.length} global installations
              {unverified > 0 ? ` · ${unverified} unverified` : ""}
            </p>
            <p className="muted small">
              Blank update cells mean no verified result. Review source coverage below before
              treating a check as complete.
            </p>
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
                source !== "all" || query.trim() || filter !== "updates"
                  ? "No global tools match this filter"
                  : (emptyUpdateState?.title ?? "Global tool checking unavailable")
              }
              action={<ScanButton target="pc" />}
            >
              <p>
                {source !== "all" || query.trim() || filter !== "updates"
                  ? "Change the update filter, package manager, or search to see other collected global tools."
                  : emptyUpdateState?.description}
              </p>
            </EmptyState>
          ) : (
            <>
              <Table label="Globally installed tools">
                <thead>
                  <tr>
                    <th scope="col">Global tool</th>
                    <th scope="col">Installed</th>
                    <th scope="col">Available</th>
                    <th scope="col">Manager / channel</th>
                    <th scope="col">Update check</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
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
                          <Badge tone={item.updateStatus === "available" ? "info" : "neutral"}>
                            {previous
                              ? "Previous result"
                              : item.updateStatus === "available"
                                ? "Update available"
                                : "Current at source"}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
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
          {snapshot && <Evidence evidence={snapshot.inventory.evidence} />}
          {snapshot?.inventory.updateEvidence && (
            <Evidence
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

function AddProjectDialog({ close, added }: { close: () => void; added: (id: string) => void }) {
  const { busy, connection, error, mutate } = useMonitoring();
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<Project["mode"]>("maintained");
  const [pickerError, setPickerError] = useState<string | null>(null);
  return (
    <Dialog title="Select a project folder" onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(
            "/api/projects",
            { path: path.trim(), mode },
            decodeProject,
            "Project selected. A read-only scan is scheduled.",
          ).then((project) => {
            if (project) {
              added(project.id);
              close();
            }
          });
        }}
      >
        <label className="field">
          <span>Local folder path</span>
          <Input
            required
            value={path}
            placeholder={"D:\\projects\\my-app"}
            onChange={(event) => setPath(event.target.value)}
            autoComplete="off"
          />
        </label>
        {window.versionstead && (
          <Button
            disabled={busy}
            onClick={() => {
              setPickerError(null);
              void window.versionstead
                ?.selectProjectDirectory()
                .then((selected) => {
                  if (selected) setPath(selected);
                })
                .catch(() =>
                  setPickerError(
                    "The folder picker could not be opened. Enter a local path instead.",
                  ),
                );
            }}
          >
            Browse folders…
          </Button>
        )}
        <label className="field">
          <span>Maintenance intent</span>
          <SelectControl
            label="Maintenance intent"
            value={mode}
            items={maintenanceItems}
            onChange={(value) => setMode(value as Project["mode"])}
          />
        </label>
        <p className="muted small">
          Only explicitly selected folders are inspected. Scans read manifests and supported
          lockfiles; they do not restore dependencies or execute project scripts.
        </p>
        {pickerError && (
          <p className="error-text" role="alert">
            {pickerError}
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!path.trim() || busy || connection !== "connected"}
          >
            {busy ? "Adding…" : "Add project"}
          </Button>
        </div>
      </form>
    </Dialog>
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
  ];
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
        <dt>Workspace importer</dt>
        <dd className="mono">{dependency.importer}</dd>
        <dt>Advisory lookup</dt>
        <dd>{dependency.advisoryStatus}</dd>
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
          <h3>Recorded package findings</h3>
          {findings.map((finding) => {
            const url = safeExternalUrl(finding.advisoryUrl);
            return (
              <article className="dependency-finding" key={finding.id}>
                <Badge tone={finding.kind === "advisory" ? "error" : "info"}>
                  {finding.kind === "advisory" ? finding.severity + " advisory" : "Update recorded"}
                </Badge>
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
      <Evidence evidence={project.evidence} inputFingerprint={project.inputFingerprint ?? null} />
      <p className="notice">
        Requested ranges and resolved versions are separate evidence. Git, workspace, local, and
        unsupported sources do not inherit registry update or advisory coverage.
      </p>
    </Dialog>
  );
}

export function Projects() {
  const { snapshot, connection, busy, error, mutate } = useMonitoring();
  const [filter, setFilter] = useState<"attention" | "all">("attention");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [selectedDependency, setSelectedDependency] = useState<{
    projectId: string;
    dependencyId: string;
  } | null>(null);
  const [allDependencies, setAllDependencies] = useState<Record<string, boolean>>({});
  const projects = snapshot?.projects ?? [];
  const findings = snapshot?.findings ?? [];
  const attentionProjects = projects.filter((project) =>
    projectNeedsAttention(project, findings, snapshot?.scanProgress),
  );
  const search = query.trim().toLowerCase();
  const matchesProject = (project: Project) =>
    (project.name + " " + project.path + " " + project.packageManager)
      .toLowerCase()
      .includes(search);
  const matchesDependency = (item: Dependency) =>
    (item.name + " " + item.packageName + " " + item.importer + " " + item.origin)
      .toLowerCase()
      .includes(search);
  const visibleProjects = (filter === "all" ? projects : attentionProjects).filter(
    (project) => matchesProject(project) || project.dependencies.some(matchesDependency),
  );
  const expansion = useGroupExpansion(
    (
      visibleProjects.find((project) =>
        findings.some((finding) => finding.subjectId === project.id),
      ) ?? visibleProjects[0]
    )?.id,
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
    incomplete: snapshot
      ? attentionGroups(snapshot)
          .filter((group) => group.kind === "project")
          .reduce((total, group) => total + group.counts.incomplete, 0)
      : 0,
  };
  return (
    <>
      <PageHeading
        title="Projects"
        description="Selected folders, dependencies needing review, and the evidence behind every check."
        actions={
          <div className="action-row">
            <ScanButton target="projects" label="Scan projects" />
            <Button
              variant="primary"
              size="sm"
              disabled={connection !== "connected" || busy}
              onClick={() => setAdding(true)}
            >
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
            <Button
              variant="primary"
              disabled={connection !== "connected" || busy}
              onClick={() => setAdding(true)}
            >
              Add project folder
            </Button>
          }
        >
          <p>
            Start with an npm or pnpm project. Supported manifests and lockfiles provide requested
            ranges, resolved versions, and source identities. No folder is scanned until you select
            it.
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
              {visibleProjects.length} of {projects.length} selected projects shown
            </span>
            <span>
              Complete projects with no recorded findings remain available in All projects.
            </span>
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
                const projectFindings = findings.filter(
                  (finding) => finding.subjectId === project.id,
                );
                const projectCounts = findingCounts(projectFindings, snapshot.device.id);
                const showAll = allDependencies[project.id] === true;
                const rows = project.dependencies.filter(
                  (item) =>
                    (showAll || dependencyNeedsAttention(item, projectFindings)) &&
                    (matchesProject(project) || matchesDependency(item)),
                );
                const queued = snapshot.scanProgress?.queued.some(
                  (target) => target.targetId === project.id,
                );
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
                            <Folder size={19} aria-hidden="true" />
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
                              <Badge tone="info">{projectCounts.updates} updates</Badge>
                            )}
                            {projectCounts.advisories > 0 && (
                              <Badge tone="error">{projectCounts.advisories} advisories</Badge>
                            )}
                            <EvidenceBadge status={project.evidence.status} />
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
                          ariaLabel={"Scan " + project.name}
                        />
                      </div>
                    </div>
                    <CollapsiblePanel className="target-group-panel">
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
                              disabled={connection !== "connected" || busy}
                              onChange={(mode) => {
                                void mutate(
                                  "/api/projects/" + encodeURIComponent(project.id),
                                  { mode },
                                  decodeProject,
                                  "Maintenance intent saved.",
                                  "PATCH",
                                );
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="compact"
                              disabled={connection !== "connected" || busy}
                              onClick={() => setRemovingId(project.id)}
                            >
                              Remove
                            </Button>
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
                          <EmptyState
                            title={
                              project.evidence.status === "not-scanned"
                                ? "This folder has not been scanned"
                                : "No dependency records collected"
                            }
                            action={<ScanButton target="projects" projectId={project.id} />}
                          >
                            <p>
                              {project.evidence.status === "not-scanned"
                                ? "Run a read-only scan to verify folder access and inspect supported project inputs."
                                : "Review coverage and errors. Missing or unsupported inputs leave resolved dependency coverage incomplete."}
                            </p>
                          </EmptyState>
                        ) : (
                          <>
                            <div className="group-toolbar">
                              <span>
                                {rows.length} of {project.dependencies.length} dependency records ·
                                importer rows retain their own requested ranges
                              </span>
                              <div
                                className="tabs"
                                role="group"
                                aria-label={project.name + " dependency visibility"}
                              >
                                <Button
                                  variant={!showAll ? "secondary" : "ghost"}
                                  size="compact"
                                  aria-pressed={!showAll}
                                  onClick={() =>
                                    setAllDependencies((previous) => ({
                                      ...previous,
                                      [project.id]: false,
                                    }))
                                  }
                                >
                                  Needs attention
                                </Button>
                                <Button
                                  variant={showAll ? "secondary" : "ghost"}
                                  size="compact"
                                  aria-pressed={showAll}
                                  data-testid="dependency-filter-all"
                                  onClick={() =>
                                    setAllDependencies((previous) => ({
                                      ...previous,
                                      [project.id]: true,
                                    }))
                                  }
                                >
                                  All dependencies
                                </Button>
                              </div>
                            </div>
                            {rows.length === 0 ? (
                              <EmptyState
                                title={
                                  search
                                    ? "No dependencies match this view"
                                    : "No package findings in collected evidence"
                                }
                                action={
                                  <Button
                                    onClick={() => {
                                      setAllDependencies((previous) => ({
                                        ...previous,
                                        [project.id]: true,
                                      }));
                                      setQuery("");
                                    }}
                                  >
                                    Show all dependencies
                                  </Button>
                                }
                              >
                                <p>
                                  Coverage gaps apply to the project independently of package
                                  findings. Review the scan evidence below.
                                </p>
                              </EmptyState>
                            ) : (
                              <Table label={project.name + " dependencies"}>
                                <thead>
                                  <tr>
                                    <th scope="col">Dependency / importer</th>
                                    <th scope="col">Requested</th>
                                    <th scope="col">Resolved</th>
                                    <th scope="col">Candidate</th>
                                    <th scope="col">Origin / role</th>
                                    <th scope="col">Checks & findings</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rows.map((item) => (
                                    <tr key={item.id}>
                                      <td>
                                        <div className="package-label">
                                          <PackageIcon size={14} aria-hidden="true" />
                                          <button
                                            className="item-label"
                                            onClick={() =>
                                              setSelectedDependency({
                                                projectId: project.id,
                                                dependencyId: item.id,
                                              })
                                            }
                                          >
                                            {item.name}
                                          </button>
                                        </div>
                                        <span className="table-subtext mono">{item.importer}</span>
                                        {item.packageName !== item.name && (
                                          <span className="table-subtext mono">
                                            Alias: {item.packageName}
                                          </span>
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
                                            <Badge tone="info">
                                              {item.versionStatus === "checked"
                                                ? "Update"
                                                : "Previous update"}
                                            </Badge>
                                          )}
                                          <Badge
                                            tone={
                                              item.advisoryIds.length
                                                ? "error"
                                                : item.advisoryStatus === "checked"
                                                  ? "neutral"
                                                  : "warning"
                                            }
                                          >
                                            {item.advisoryIds.length
                                              ? item.advisoryIds.length +
                                                (item.advisoryStatus === "checked"
                                                  ? " known advisories"
                                                  : " previous, unverified")
                                              : item.advisoryStatus === "checked"
                                                ? "No known matches"
                                                : item.advisoryStatus === "not-checked"
                                                  ? "Not checked"
                                                  : item.advisoryStatus}
                                          </Badge>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </Table>
                            )}
                          </>
                        )}
                        <details className="group-evidence">
                          <summary>Project inputs, scan evidence & coverage</summary>
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
          <p className="monitoring-footnote">
            Update and advisory summaries combine duplicate importer observations. Dependency rows
            preserve requested ranges, origins, and resolved versions.
          </p>
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
        <Dialog title={"Remove " + removing.name + "?"} onClose={() => setRemovingId(null)}>
          <p>
            Remove this folder from monitoring. Its source files and installed dependencies will
            remain untouched.
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <Button onClick={() => setRemovingId(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={busy || connection !== "connected"}
              onClick={() => {
                void mutate(
                  "/api/projects/" + encodeURIComponent(removing.id),
                  {},
                  decodeAcceptedResponse,
                  "Project removed from monitoring.",
                  "DELETE",
                ).then((result) => {
                  if (result) {
                    setRemovingId(null);
                    if (selectedDependency?.projectId === removing.id) setSelectedDependency(null);
                  }
                });
              }}
            >
              Remove from monitoring
            </Button>
          </div>
        </Dialog>
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
  const { snapshot, connection, busy, refreshing, refresh, mutate } = useMonitoring();
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
  const boot = snapshot.runtime.host === "boot-task";
  const pending = snapshot.notifications.filter((item) => !item.deliveredAt);
  const summary = snapshot.notificationSummary;
  const changeSettings = (body: unknown, message: string) => {
    void mutate("/api/settings", body, decodeMonitoringSettings, message, "PATCH");
  };
  return (
    <>
      <PageHeading
        title="Background service"
        description="Monitoring continues independently of the main window; scan freshness remains visible."
        actions={
          <>
            <Button
              disabled={!connected || busy}
              onClick={() =>
                changeSettings(
                  { paused: !settings.paused },
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
          {connected ? "UI connected" : "UI disconnected"}
        </Badge>
      </section>
      <div className="settings-grid">
        <section className="settings-section">
          <h2>Lifecycle & access</h2>
          <div className="setting-row">
            <div>
              <h3>Windows boot</h3>
              <p>
                {boot
                  ? "Connected to the Windows boot-task host. Verify reboot and sign-out behavior before relying on unattended coverage."
                  : "Startup registration has not been confirmed. This coordinator currently belongs to the signed-in session."}
              </p>
            </div>
            <Badge tone={boot ? "info" : "warning"}>{boot ? "Boot host" : "Setup required"}</Badge>
          </div>
          <div className="setting-row">
            <div>
              <h3>When the window closes</h3>
              <p>
                Electron remains in the system tray. Reopen the app or pause schedules from its tray
                menu.
              </p>
            </div>
            <Badge tone="neutral">Tray</Badge>
          </div>
          <div className="setting-row">
            <div>
              <h3>After Windows sign-out</h3>
              <p>
                {boot
                  ? "The independent boot host is designed to continue collecting accessible sources after sign-out. Folder access and session-dependent sources still need verification."
                  : "A tray process cannot survive sign-out. Configure the Windows background host to enable monitoring outside your signed-in session."}
              </p>
            </div>
            <Badge tone={boot ? "info" : "warning"}>
              {boot ? "Verify access" : "Not configured"}
            </Badge>
          </div>
          <div className="setting-row">
            <div>
              <h3>Account and folder coverage</h3>
              <p>
                The desktop saves the owner's npm and Bun global locations for the boot host.
                Inaccessible folders and unverified package origins produce explicit coverage
                errors.
              </p>
            </div>
          </div>
          <p className="settings-note">
            Startup registration requires the Windows setup command in the development
            documentation. Pausing schedules keeps the coordinator running; it does not remove
            startup registration. A sleeping or powered-off PC cannot scan.
          </p>
          {snapshot.runtime.platform === "win32" && (
            <details className="startup-help">
              <summary>Windows startup setup</summary>
              <p>From the Versionstead project folder, run this in an administrator PowerShell:</p>
              <code>.\scripts\windows-background.ps1 -Action Install</code>
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
                disabled={!connected || busy}
                items={intervalOptions([15, 60, 360, 720, 1440, settings.pcIntervalMinutes])}
                onChange={(value) =>
                  changeSettings({ pcIntervalMinutes: Number(value) }, "PC scan interval saved.")
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
                disabled={!connected || busy}
                items={intervalOptions([15, 60, 360, 1440, settings.projectIntervalMinutes])}
                onChange={(value) =>
                  changeSettings(
                    { projectIntervalMinutes: Number(value) },
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
              <button
                className="switch"
                role="switch"
                aria-checked={settings.notifyNewFindings}
                aria-label="Notify on new findings"
                disabled={!connected || busy}
                onClick={() =>
                  changeSettings(
                    { notifyNewFindings: !settings.notifyNewFindings },
                    "Notification preference saved.",
                  )
                }
              />
            </div>
            <div className="setting-row">
              <div>
                <h3>Waiting for delivery</h3>
                <p>
                  {summary
                    ? `${summary.updateCount} updates and ${summary.advisoryCount} advisory findings are ready to review.`
                    : pending.length
                      ? "New findings are being combined into the next summary."
                      : "No new findings are waiting."}
                </p>
                {snapshot.notificationNextAt && (
                  <p>Next eligible summary: {timestamp(snapshot.notificationNextAt)}</p>
                )}
              </div>
              <Badge tone={pending.length ? "info" : "neutral"}>
                {pending.length ? "1 summary pending" : "None pending"}
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
          <span className="small muted">{snapshot.history.length} recorded attempts</span>
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
                    <span className="table-subtext">{scan.kind}</span>
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
