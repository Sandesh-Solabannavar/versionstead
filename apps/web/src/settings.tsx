import { useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { type ProviderKind } from "@versionstead/contracts/application";
import { decodeMonitoringSettings } from "@versionstead/contracts/monitoring";
import { useApplication } from "./application";
import { useMonitoring } from "./monitoring";
import { actionKeys } from "./monitoring-actions";
import { useAppearance } from "./theme";
import { ConnectionsSettings } from "./connections-settings";
import { ProjectSettings } from "./project-settings";
import { AppearanceSettings } from "./appearance-settings";
import {
  SettingRow,
  SettingGroup,
  Choice,
  credentialStorageNote,
} from "./components/settings-controls";
import { SourceControlRow } from "./components/source-control-row";
import {
  GitIcon,
  GitHubIcon,
  GitLabIcon,
  JujutsuIcon,
  AzureDevOpsIcon,
  BitbucketIcon,
  ForgejoIcon,
} from "./components/source-control-icons";
import { providerPresentation } from "./source-control-status";
import { AddProjectDialog } from "./add-project";
import { RedactedSensitiveText } from "./components/redacted-sensitive-text";
import { RefreshIcon } from "./components/ui/refresh-icon";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./components/ui/tooltip";
import {
  commands,
  defaultBindings,
  bindingConflict,
  formatShortcut,
  isMac,
  keyChord,
  type Command,
} from "./keybindings";
import { Switch } from "./components/ui/switch";
import {
  Button,
  Badge,
  ConfirmDialog,
  Dialog,
  Input,
  useFailure,
  PageHeading,
  EmptyState,
  Evidence,
  EvidenceBadge,
  FindingBadge,
  ScanProgress,
  timestamp,
} from "./ui";
import { attentionGroups, installationCandidate, plural, workspaceLabel } from "./monitoring-view";
import { latestEvidence } from "./computer-evidence";
import { settingsSections } from "./settings-navigation";
import { SettingsSearchTargets } from "./components/settings-controls";

// These route pages load on demand; the always-visible settings chrome lives in router.tsx.

const providerName = (kind: ProviderKind) => (kind === "github" ? "GitHub" : "GitLab");

function scanIntervals(current: number) {
  return [...new Set([15, 60, 360, 720, 1440, current])]
    .sort((a, b) => a - b)
    .map((value) => ({
      value: String(value),
      label: value < 60 ? `${value} minutes` : `${value / 60} ${value === 60 ? "hour" : "hours"}`,
    }));
}

function GeneralSettings() {
  const { snapshot, connection, pending, mutate } = useMonitoring();
  const { snapshot: app, change } = useApplication();
  if (!snapshot || !app) return null;
  // Each control waits only for its own save, so changing one never holds back another.
  const unavailable = (key: string) => connection !== "connected" || pending.has(key);
  const update = (field: string, value: boolean | number) => {
    void mutate(
      "/api/settings",
      { [field]: value },
      decodeMonitoringSettings,
      "Monitoring preferences saved.",
      "PATCH",
      { key: actionKeys.setting(field) },
    );
  };
  const preference = (field: string, value: boolean, message: string) => {
    void change("preferences", { [field]: value }, message, "PATCH", {
      key: actionKeys.preference(field),
    });
  };

  return (
    <>
      <SettingGroup title="Monitoring">
        <SettingRow
          label="Scheduled scans"
          description="Keep checking selected projects and npm/Bun global tools when the window is closed."
        >
          <Switch
            aria-label="Scheduled scans"
            checked={!snapshot.settings.paused}
            disabled={unavailable(actionKeys.setting("paused"))}
            onCheckedChange={(value) => update("paused", !value)}
          />
        </SettingRow>
        <SettingRow
          label="PC scan interval"
          description="Check installed npm and Bun global tools at this interval."
        >
          <Choice
            label="PC scan interval"
            value={String(snapshot.settings.pcIntervalMinutes)}
            items={scanIntervals(snapshot.settings.pcIntervalMinutes)}
            disabled={unavailable(actionKeys.setting("pcIntervalMinutes"))}
            onChange={(value) => update("pcIntervalMinutes", Number(value))}
          />
        </SettingRow>
        <SettingRow
          label="Project scan interval"
          description="Check selected folders and connected repositories at this interval."
        >
          <Choice
            label="Project scan interval"
            value={String(snapshot.settings.projectIntervalMinutes)}
            items={scanIntervals(snapshot.settings.projectIntervalMinutes)}
            disabled={unavailable(actionKeys.setting("projectIntervalMinutes"))}
            onChange={(value) => update("projectIntervalMinutes", Number(value))}
          />
        </SettingRow>
        <SettingRow
          label="Scan selected repositories automatically"
          description="Start a scan after selection, then follow the project schedule. Account access alone never selects a repository."
        >
          <Switch
            aria-label="Scan selected repositories automatically"
            checked={app.preferences.automaticRepositoryScans}
            disabled={unavailable(actionKeys.preference("automaticRepositoryScans"))}
            onCheckedChange={(value) =>
              preference("automaticRepositoryScans", value, "Repository scan preference saved.")
            }
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Notifications & updates">
        <SettingRow
          label="Notify about new findings"
          description="One count summary after scans settle. Unchanged findings stay quiet; updates and advisories remain separate."
        >
          <Switch
            aria-label="Notify about new findings"
            checked={snapshot.settings.notifyNewFindings}
            disabled={unavailable(actionKeys.setting("notifyNewFindings"))}
            onCheckedChange={(value) => update("notifyNewFindings", value)}
          />
        </SettingRow>
        <SettingRow
          label="Check for Versionstead releases"
          description="Check GitHub for a stable application release once a day. Release checking does not install software."
        >
          <Switch
            aria-label="Check for Versionstead releases"
            checked={app.preferences.automaticAppUpdateChecks}
            disabled={unavailable(actionKeys.preference("automaticAppUpdateChecks"))}
            onCheckedChange={(value) =>
              preference("automaticAppUpdateChecks", value, "Release check preference saved.")
            }
          />
        </SettingRow>
      </SettingGroup>
      <p className="muted">
        Host: {snapshot.runtime.host === "boot-task" ? "Windows boot task" : "Signed-in session"}.{" "}
        <Link to="/service" className="text-link">
          View background setup, scan history, and service health
        </Link>
        .
      </p>
    </>
  );
}
function KeybindingsSettings() {
  const { bindings, setBindings } = useAppearance();
  const [capture, setCapture] = useState<Command | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const mac = isMac();
  return (
    <>
      <SettingGroup title="Workspace shortcuts">
        {commands.map((command) => {
          const shown = bindings[command.id]
            ? formatShortcut(bindings[command.id], mac)
            : "Disabled";
          return (
            <SettingRow
              key={command.id}
              label={command.label}
              description={`Default: ${formatShortcut(command.binding, mac)}`}
            >
              <div className="row-actions">
                <Button
                  // The name holds the text the button shows, so it is also said by speech control.
                  aria-label={`Change shortcut for ${command.label}, currently ${shown}`}
                  onClick={() => {
                    setError(null);
                    setCapture(command.id);
                  }}
                >
                  <kbd>{shown}</kbd>
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Disable shortcut for ${command.label}`}
                  disabled={!bindings[command.id]}
                  onClick={() => setBindings({ ...bindings, [command.id]: "" })}
                >
                  Disable
                </Button>
              </div>
            </SettingRow>
          );
        })}
      </SettingGroup>
      <Button onClick={() => setResetting(true)}>Reset all shortcuts</Button>
      <p className="muted">
        Shortcuts are saved on this device and ignored while typing in a field or using a dialog.
      </p>
      {resetting && (
        <ConfirmDialog
          title="Reset all shortcuts?"
          description="Every workspace shortcut returns to its default on this device, including any you disabled. Shortcuts saved on project commands are not changed."
          confirmLabel="Reset shortcuts"
          onConfirm={() => {
            setBindings({ ...defaultBindings });
            setResetting(false);
          }}
          onClose={() => setResetting(false)}
        />
      )}
      {capture && (
        <Dialog
          title={`Shortcut: ${commands.find((c) => c.id === capture)!.label}`}
          onClose={() => setCapture(null)}
        >
          <p>Focus the field and press the new shortcut. Escape cancels; Tab leaves the field.</p>
          <Input
            autoFocus
            readOnly
            aria-label="Press a shortcut"
            value="Press keys…"
            onKeyDown={(event) => {
              // Tab and Escape keep their usual job, so the field never traps keyboard focus.
              if (event.key === "Tab" || event.key === "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              const chord = keyChord(event, mac);
              if (!chord) return;
              const conflict = bindingConflict(bindings, capture, chord);
              if (conflict) {
                setError(`Already used by ${conflict}. Disable or change that shortcut first.`);
                return;
              }
              if (
                !/^(?:(?:mod|ctrl|meta|alt|shift)\+)*(?:[a-z0-9,/.-]|f(?:[1-9]|1[0-2]))$/.test(
                  chord,
                )
              ) {
                setError(
                  "This key is not supported. Use a letter, number, punctuation key, or function key.",
                );
                return;
              }
              setBindings({ ...bindings, [capture]: chord });
              setCapture(null);
            }}
          />
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}

function ConnectProviderDialog({ kind, onClose }: { kind: ProviderKind; onClose: () => void }) {
  const { snapshot, change } = useApplication();
  const { snapshot: monitoring, pending } = useMonitoring();
  const [token, setToken] = useState("");
  // Why the last attempt failed. It belongs to this dialog, so it never outlives it or leaks elsewhere.
  const [error, fail, clearError] = useFailure();
  const name = kind === "github" ? "GitHub" : "GitLab";
  const key = actionKeys.provider(kind);
  const connecting = pending.has(key);
  return (
    // Closing mid-request would lose the message, so the dialog stays until the request settles.
    <Dialog title={`Connect ${name}`} onClose={onClose} dismissible={!connecting}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          clearError();
          void change(
            "providers/connect",
            { kind, token },
            `${name} connected. Select repositories to start monitoring.`,
            "POST",
            { key, onError: fail },
          ).then((result) => {
            if (result) {
              setToken("");
              onClose();
            }
          });
        }}
      >
        <p>
          {kind === "github"
            ? "Use a fine-grained token with read access to Contents and Metadata for the repositories you want to scan. For private repository listing, use a token with access to those repositories."
            : "Use a GitLab token with read_api access for your selected projects. Versionstead reads repository files and never pushes changes."}
        </p>
        <label className="field-label">
          Read-only access token
          <Input
            autoFocus
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <p className="muted small">
          Stored with Windows DPAPI on this monitoring host. Tokens never appear in saved browser
          preferences.
        </p>
        <div className="dialog-actions">
          <Button
            variant="primary"
            type="submit"
            disabled={connecting || !snapshot?.credentialStorageAvailable || !token.trim()}
          >
            Connect
          </Button>
          <Button
            type="button"
            disabled={
              connecting ||
              !snapshot?.credentialStorageAvailable ||
              !snapshot.tools[kind].available ||
              monitoring?.runtime.mode !== "interactive"
            }
            onClick={() => {
              clearError();
              void change(
                "providers/connect",
                { kind, useCli: true },
                `${name} connected from your signed-in CLI.`,
                "POST",
                { key, onError: fail },
              ).then((result) => {
                if (result) onClose();
              });
            }}
          >
            Use signed-in {kind === "github" ? "gh" : "glab"} CLI
          </Button>
        </div>
        {!snapshot?.credentialStorageAvailable && <p role="alert">{credentialStorageNote}</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
function SourceControlSettings() {
  const { snapshot: app, change, discover, discovering } = useApplication();
  const { snapshot, pending, connection, mutate } = useMonitoring();
  const [connect, setConnect] = useState<ProviderKind | null>(null);
  const [picker, setPicker] = useState<ProviderKind | null>(null);
  const [disconnecting, setDisconnecting] = useState<ProviderKind | null>(null);
  const [disconnectError, failDisconnect, clearDisconnectError] = useFailure(
    disconnecting !== null,
  );
  if (!app || !snapshot) return null;
  const disabled = connection !== "connected";
  // Each control waits only for its own save, so changing one never holds back another.
  const unavailable = (key: string) => disabled || pending.has(key);
  const interval = snapshot.settings.projectIntervalMinutes;
  return (
    <div className="source-control-settings">
      <SettingGroup title="Repositories">
        <SettingRow
          label="Automatically scan"
          description="Keep selected repositories checked on the project schedule. Connecting an account does not select repositories."
        >
          <Switch
            aria-label="Automatically scan repositories"
            checked={app.preferences.automaticRepositoryScans}
            disabled={unavailable(actionKeys.preference("automaticRepositoryScans"))}
            onCheckedChange={(value) => {
              void change(
                "preferences",
                { automaticRepositoryScans: value },
                "Automatic repository scans saved.",
                "PATCH",
                { key: actionKeys.preference("automaticRepositoryScans") },
              );
            }}
          />
        </SettingRow>
        <SettingRow
          label="Scan interval"
          description="Check selected repositories and local projects at this interval. Manual scans remain available."
        >
          <Choice
            label="Repository scan interval"
            value={String(interval)}
            items={scanIntervals(interval)}
            disabled={unavailable(actionKeys.setting("projectIntervalMinutes"))}
            onChange={(value) => {
              void mutate(
                "/api/settings",
                { projectIntervalMinutes: Number(value) },
                decodeMonitoringSettings,
                "Project and repository scan interval saved.",
                "PATCH",
                { key: actionKeys.setting("projectIntervalMinutes") },
              );
            }}
          />
        </SettingRow>
      </SettingGroup>
      {snapshot.settings.paused && (
        <p className="source-control-note" role="status">
          Scheduled scans are paused in General. Manual scans remain available.
        </p>
      )}
      <SettingGroup
        title="Version Control"
        action={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Refresh source control tools"
                  aria-busy={discovering}
                  disabled={connection !== "connected" || discovering}
                  onClick={() => {
                    void discover();
                  }}
                >
                  <RefreshIcon refreshing={discovering} size="sm" />
                </Button>
              }
            />
            <TooltipPopup side="top">Rescan Git and hosting integrations</TooltipPopup>
          </Tooltip>
        }
      >
        <SourceControlRow
          name="Git"
          icon={<GitIcon />}
          status={app.tools.git.available ? "available" : "attention"}
          version={app.tools.git.version}
          badge={
            app.tools.git.available
              ? app.preferences.gitEnabled
                ? null
                : "Disabled"
              : "Not installed"
          }
          description={
            app.tools.git.available
              ? "Available"
              : "Not available on this PC. Install Git to include local repository context."
          }
          control={
            <Switch
              aria-label="Enable Git context"
              checked={app.tools.git.available && app.preferences.gitEnabled}
              disabled={
                unavailable(actionKeys.preference("gitEnabled")) || !app.tools.git.available
              }
              onCheckedChange={(value) => {
                void change(
                  "preferences",
                  { gitEnabled: value },
                  "Git context preference saved.",
                  "PATCH",
                  { key: actionKeys.preference("gitEnabled") },
                );
              }}
            />
          }
        >
          <h4>Local repository context</h4>
          <p>
            Include the branch, commit, and tracked working-tree status when scanning selected
            folders. Versionstead reads Git metadata without pulling, merging, or changing your
            files.
          </p>
          <Link to="/projects" className="text-link">
            View selected projects
          </Link>
        </SourceControlRow>
        <SourceControlRow
          name="Jujutsu"
          icon={<JujutsuIcon />}
          status="inactive"
          badge="Coming soon"
          description="Support for Jujutsu repository context is coming soon."
        />
      </SettingGroup>
      <SettingGroup title="Source Control Providers">
        {app.providers.map((provider) => {
          const name = provider.kind === "github" ? "GitHub" : "GitLab";
          const Icon = provider.kind === "github" ? GitHubIcon : GitLabIcon;
          const presentation = providerPresentation(provider, app.tools[provider.kind]);
          const selected = snapshot.projects.filter(
            (p) => p.repository?.provider === provider.kind,
          );
          return (
            <SourceControlRow
              key={provider.kind}
              name={name}
              icon={<Icon />}
              version={app.tools[provider.kind].version}
              {...presentation}
              description={
                provider.account && !provider.error ? (
                  <>
                    Authenticated as{" "}
                    <RedactedSensitiveText
                      key={`${provider.kind}:${provider.account}`}
                      value={provider.account}
                      ariaLabel={`Toggle ${name} account visibility`}
                      revealTooltip="Click to reveal account"
                      hideTooltip="Click to hide account"
                    />
                    {!provider.enabled && " · Repository scans paused"}
                  </>
                ) : (
                  <span role={provider.error ? "alert" : undefined}>
                    {presentation.description}
                  </span>
                )
              }
              control={
                <Switch
                  aria-label={`Enable ${name} repository scans`}
                  checked={!!provider.account && provider.enabled}
                  disabled={
                    unavailable(actionKeys.provider(provider.kind)) ||
                    (!provider.account && !app.credentialStorageAvailable)
                  }
                  onCheckedChange={(enabled) => {
                    if (!provider.account) {
                      setConnect(provider.kind);
                      return;
                    }
                    void change(
                      "providers",
                      { kind: provider.kind, enabled },
                      `${name} scans ${enabled ? "enabled" : "paused"}.`,
                      "PATCH",
                      { key: actionKeys.provider(provider.kind) },
                    );
                  }}
                />
              }
            >
              <div className="provider-detail-heading">
                <h4>Selected repositories</h4>
                <span className="muted small">{selected.length} selected</span>
              </div>
              <p>
                {provider.account
                  ? "Choose the repositories and branches to monitor. Automatic scans follow your repository and General scheduling preferences."
                  : "Connect your account, then choose the repositories to monitor. Account access alone never starts a scan."}
              </p>
              {selected.length > 0 && (
                <ul className="provider-selected-repositories">
                  {selected.map((project) => (
                    <li key={project.id}>
                      <Link to="/projects" className="text-link">
                        {project.name}
                      </Link>
                      <code>{project.repository?.ref}</code>
                      <EvidenceBadge status={project.evidence.status} />
                    </li>
                  ))}
                </ul>
              )}
              {!app.credentialStorageAvailable && <p role="status">{credentialStorageNote}</p>}
              <div className="provider-actions">
                <Button
                  size="sm"
                  disabled={
                    unavailable(actionKeys.provider(provider.kind)) ||
                    !app.credentialStorageAvailable
                  }
                  onClick={() => setConnect(provider.kind)}
                >
                  {provider.account ? "Reconnect" : `Connect ${name}`}
                </Button>
                {provider.account && (
                  <>
                    <Button
                      size="sm"
                      disabled={disabled || !provider.enabled}
                      onClick={() => setPicker(provider.kind)}
                    >
                      Select repositories
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={unavailable(actionKeys.provider(provider.kind))}
                      onClick={() => {
                        clearDisconnectError();
                        setDisconnecting(provider.kind);
                      }}
                    >
                      Disconnect
                    </Button>
                  </>
                )}
              </div>
            </SourceControlRow>
          );
        })}
        <SourceControlRow
          name="Azure DevOps"
          icon={<AzureDevOpsIcon />}
          status="inactive"
          badge="Coming soon"
          description="Repository scanning for Azure DevOps is coming soon."
        />
        <SourceControlRow
          name="Bitbucket"
          icon={<BitbucketIcon />}
          status="inactive"
          badge="Coming soon"
          description="Repository scanning for Bitbucket is coming soon."
        />
        <SourceControlRow
          name="Forgejo / Gitea"
          icon={<ForgejoIcon />}
          status="inactive"
          badge="Coming soon"
          description="Repository scanning for Forgejo and Gitea is coming soon."
        />
      </SettingGroup>
      <p className="source-control-note">
        Supports github.com and gitlab.com. Selected repositories appear in{" "}
        <Link to="/projects" className="text-link">
          Projects
        </Link>{" "}
        with dependency evidence, the scanned ref, and commit.
      </p>
      {connect && <ConnectProviderDialog kind={connect} onClose={() => setConnect(null)} />}
      {picker && (
        <AddProjectDialog initialSource={picker} close={() => setPicker(null)} added={() => {}} />
      )}
      {disconnecting && (
        <ConfirmDialog
          danger
          title={`Disconnect ${providerName(disconnecting)}?`}
          description="Versionstead forgets the saved credential. Selected repositories keep their evidence but are not scanned until you reconnect. Revoke the token with the provider to fully end access."
          confirmLabel="Disconnect"
          pending={pending.has(actionKeys.provider(disconnecting))}
          error={disconnectError}
          onClose={() => setDisconnecting(null)}
          onConfirm={() => {
            clearDisconnectError();
            void change(
              "providers",
              { kind: disconnecting, enabled: false, disconnect: true },
              `${providerName(disconnecting)} disconnected. Previous repository evidence is retained.`,
              "PATCH",
              { key: actionKeys.provider(disconnecting), onError: failDisconnect },
            ).then((result) => {
              if (result) setDisconnecting(null);
            });
          }}
        />
      )}
    </div>
  );
}

export function SettingsPage() {
  const path = useLocation({ select: (l) => l.pathname });
  const { snapshot, error, refresh } = useApplication();
  const section = settingsSections.find((s) => s.path === path) ?? settingsSections[0];
  // Appearance and Keybindings live in this device's storage, so they need no coordinator.
  const deviceOnly = path.endsWith("appearance") || path.endsWith("keybindings");
  return (
    <SettingsSearchTargets>
      <div className="settings-page">
        <h1 className="sr-only">{section.label}</h1>
        {error && !deviceOnly && (
          <div className="connection-banner warning" role="alert">
            {error}
            <Button
              onClick={() => {
                void refresh();
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {path.endsWith("appearance") ? (
          <AppearanceSettings />
        ) : path.endsWith("keybindings") ? (
          <KeybindingsSettings />
        ) : !snapshot ? (
          <EmptyState title="Loading settings">
            Connect to your local coordinator to read its preferences.
          </EmptyState>
        ) : path.endsWith("source-control") ? (
          <SourceControlSettings />
        ) : path.endsWith("connections") ? (
          <ConnectionsSettings />
        ) : path.endsWith("project") ? (
          <ProjectSettings />
        ) : (
          <GeneralSettings />
        )}
      </div>
    </SettingsSearchTargets>
  );
}

export function ComputerPage() {
  const path = useLocation({ select: (l) => l.pathname });
  const id = path.split("/").at(-1);
  const {
    snapshot: app,
    computerEvidence,
    unreadableEvidence,
    retryEvidence,
    error,
    refresh,
    change,
  } = useApplication();
  const { pending, connection } = useMonitoring();
  const computer = app?.computers.find((c) => c.id === id);
  // The provider reads a PC's evidence when its digest changes, which includes this page's Refresh.
  const snapshot = computer && computerEvidence.get(computer.id)?.snapshot;
  // Until the coordinator's settings arrive, no PC is known to be missing.
  if (!app)
    return error ? (
      <EmptyState
        title="Paired PCs could not be read"
        action={
          <Button
            onClick={() => {
              void refresh();
            }}
          >
            Retry
          </Button>
        }
      >
        {error}
      </EmptyState>
    ) : connection === "connected" ? (
      <EmptyState title="Loading…">Reading this PC from your local coordinator.</EmptyState>
    ) : (
      <EmptyState title="Waiting for your coordinator">
        Connect to your local coordinator to read paired PCs.
      </EmptyState>
    );
  if (!computer)
    return (
      <EmptyState title="PC is not connected">
        <Link to="/settings/connections" className="text-link">
          Open Connections to pair a PC
        </Link>
        .
      </EmptyState>
    );
  // The page's actions and Connections' environment menu share one key, so they wait for each other.
  const key = actionKeys.environment(computer.id);
  const unavailable = pending.has(key) || connection !== "connected" || computer.enabled === false;
  // Held evidence of an earlier digest is not what this PC last sent, so it says so.
  const latest = latestEvidence(computer, computerEvidence, unreadableEvidence);
  const retry = (
    <Button disabled={connection !== "connected"} onClick={() => retryEvidence(computer.id)}>
      Retry
    </Button>
  );
  return (
    <>
      <PageHeading
        title={computer.label}
        description={
          <>
            Paired PC · {computer.origin} · Last received {timestamp(computer.checkedAt)}
          </>
        }
        actions={
          <>
            <Button
              disabled={unavailable}
              onClick={() => {
                void change(
                  "computers/refresh",
                  { id: computer.id },
                  "Paired evidence refreshed.",
                  "POST",
                  { key },
                );
              }}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              disabled={unavailable}
              onClick={() => {
                void change(
                  "computers/scan",
                  { id: computer.id },
                  "Paired scan requested.",
                  "POST",
                  { key },
                );
              }}
            >
              Scan selected sources
            </Button>
          </>
        }
      />
      {computer.enabled === false && (
        <p className="connection-banner">
          This environment is disabled. Enable it in Connections to resume refreshing and scanning.
          Saved evidence is retained.
        </p>
      )}
      {computer.error && (
        <div className="connection-banner warning" role="status">
          {computer.error}
        </div>
      )}
      {!snapshot ? (
        latest === "none" ? (
          <EmptyState title="No evidence received">
            Check that the other PC is running and reachable on your LAN or tailnet.
          </EmptyState>
        ) : latest === "failed" ? (
          <EmptyState title="Evidence could not be read" action={retry}>
            Your coordinator holds what this PC last sent, but reading it failed.
          </EmptyState>
        ) : (
          <EmptyState title="Loading evidence">Reading what this PC last sent.</EmptyState>
        )
      ) : (
        <>
          {latest !== "current" && (
            <div
              className={`connection-banner${latest === "failed" ? " warning" : ""}`}
              role="status"
            >
              <p>
                {latest === "failed"
                  ? "The latest evidence this PC sent could not be read. Earlier evidence is shown."
                  : "Earlier evidence is shown while the latest this PC sent is read."}
              </p>
              {latest === "failed" && retry}
            </div>
          )}
          <ScanProgress
            snapshot={snapshot}
            connected={!computer.error && connection === "connected"}
          />
          <section className="setting-section">
            <h2>Needs attention</h2>
            {attentionGroups(snapshot).length === 0 ? (
              <p className="muted">
                No findings in the received evidence. Review timestamps and coverage below.
              </p>
            ) : (
              attentionGroups(snapshot).map((group) => (
                <details key={group.id} className="remote-group">
                  <summary>
                    <span>{group.label}</span>
                    <span className="muted">
                      {plural(group.counts.updates, "update available", "updates available")} ·{" "}
                      {plural(group.counts.advisories, "advisory", "advisories")} ·{" "}
                      <EvidenceBadge status={group.evidence.status} />
                    </span>
                  </summary>
                  <Evidence level={3} evidence={group.evidence} />
                  {group.findings.map((finding) => (
                    <div className="preference-row" key={finding.id}>
                      <div>
                        <strong>{finding.name}</strong>
                        <p className="muted">{finding.description}</p>
                      </div>
                      <FindingBadge finding={finding} />
                    </div>
                  ))}
                </details>
              ))
            )}
          </section>
          <section className="setting-section">
            <h2>Global tools · {snapshot.inventory.installations.length}</h2>
            <Evidence level={3} evidence={snapshot.inventory.evidence} />
            {snapshot.inventory.updateEvidence && (
              <Evidence level={3} evidence={snapshot.inventory.updateEvidence} />
            )}
            <div className="setting-group">
              {snapshot.inventory.installations.map((installation) => (
                <SettingRow
                  key={installation.id}
                  label={installation.name}
                  description={`${installation.manager} · ${installation.version ?? "Unknown version"}`}
                >
                  {/* Retained evidence from an unreachable PC, or a failed check, is not current:
                      it reads "previous, unverified" as This PC's own rows do. */}
                  <Badge>
                    {installation.availableVersion
                      ? `Update available: ${installationCandidate(
                          installation,
                          Boolean(computer.error) ||
                            snapshot.inventory.updateEvidence?.status === "failed",
                        )}`
                      : "No verified update"}
                  </Badge>
                </SettingRow>
              ))}
            </div>
          </section>
          <section className="setting-section">
            <h2>Selected projects · {snapshot.projects.length}</h2>
            {snapshot.projects.map((project) => (
              <details className="remote-group" key={project.id}>
                <summary>
                  <strong>{project.name}</strong>
                  <span className="muted">
                    <EvidenceBadge status={project.evidence.status} /> ·{" "}
                    {plural(project.dependencies.length, "dependency", "dependencies")}
                  </span>
                </summary>
                {project.repository && (
                  <p className="muted">
                    {project.repository.provider} · {project.repository.ref} ·{" "}
                    {project.repository.commit ?? "Commit not checked"}
                  </p>
                )}
                <Evidence level={3} evidence={project.evidence} />
                {project.dependencies
                  .filter(
                    (d) =>
                      d.availableVersion ||
                      d.latestVersion ||
                      d.advisoryIds.length ||
                      d.versionStatus === "failed" ||
                      d.advisoryStatus === "failed",
                  )
                  .map((dependency, index) => (
                    <SettingRow
                      key={`${dependency.name}:${dependency.importer}:${index}`}
                      label={dependency.name}
                      description={`${workspaceLabel(dependency.importer)} · ${dependency.resolved ?? dependency.requested}`}
                    >
                      <span className="muted">
                        {dependency.availableVersion ??
                          dependency.latestVersion ??
                          "Attention needed"}
                        {dependency.advisoryIds.length
                          ? ` · ${plural(dependency.advisoryIds.length, "advisory", "advisories")}`
                          : ""}
                      </span>
                    </SettingRow>
                  ))}
              </details>
            ))}
          </section>
        </>
      )}
    </>
  );
}
