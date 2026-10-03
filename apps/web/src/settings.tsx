import { useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Download,
  RefreshCw,
  Settings2,
  Palette,
  Keyboard,
  GitBranch,
  Link2,
  ExternalLink,
  FolderCog,
  Search,
  RotateCcw,
} from "lucide-react";
import { type ProviderKind } from "@versionstead/contracts/application";
import { decodeMonitoringSettings } from "@versionstead/contracts/monitoring";
import { useApplication } from "./application";
import { useMonitoring } from "./monitoring";
import { useAppearance } from "./theme";
import { ConnectionsSettings } from "./connections-settings";
import { ProjectSettings } from "./project-settings";
import { AppearanceSettings } from "./appearance-settings";
import { SettingRow, SettingGroup, Choice } from "./components/settings-controls";
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
import { commands, defaultBindings, bindingConflict, keyChord, type Command } from "./keybindings";
import { Switch } from "./components/ui/switch";
import {
  Button,
  Badge,
  Dialog,
  Input,
  PageHeading,
  EmptyState,
  Evidence,
  ScanProgress,
  timestamp,
} from "./ui";
import { attentionGroups } from "./monitoring-view";
import { settingsSections, searchSettings } from "./settings-navigation";
import { useWorkspaceChrome } from "./workspace-chrome";
import { SettingsSearchTargets } from "./components/settings-controls";
import { defaultAppearance, readThemeHalves } from "./appearance";
import { AppLogo } from "./components/app-logo";
import { toast } from "./components/ui/toast";

const sectionIcons = {
  General: Settings2,
  Project: FolderCog,
  Appearance: Palette,
  Keybindings: Keyboard,
  "Source Control": GitBranch,
  Connections: Link2,
};
const sections = settingsSections.map((section) => ({
  ...section,
  icon: sectionIcons[section.label],
}));
function scanIntervals(current: number) {
  return [...new Set([15, 60, 360, 720, 1440, current])]
    .sort((a, b) => a - b)
    .map((value) => ({
      value: String(value),
      label: value < 60 ? `${value} minutes` : `${value / 60} ${value === 60 ? "hour" : "hours"}`,
    }));
}

export function SettingsNavigation() {
  const { back } = useWorkspaceChrome();
  const { bindings } = useAppearance();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = searchSettings(query);
  const selected = Math.min(active, Math.max(0, results.length - 1));
  const choose = (result: (typeof results)[number]) => {
    setQuery("");
    void navigate({ to: result.path, hash: result.target ?? "" });
  };
  return (
    <>
      <Button variant="ghost" className="settings-back" onClick={back}>
        <ArrowLeft size={15} aria-hidden />
        Back to workspace
      </Button>
      <div className="settings-search">
        <Search size={14} aria-hidden />
        <Input
          id="settings-search"
          type="search"
          aria-label="Search settings"
          placeholder="Search settings…"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={query.trim().length > 0}
          aria-controls="settings-search-results"
          aria-activedescendant={results.length ? `settings-result-${selected}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
              event.preventDefault();
              setActive(
                (selected + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length,
              );
            } else if (event.key === "Enter" && results[selected]) {
              event.preventDefault();
              choose(results[selected]);
            }
          }}
        />
        {!query && bindings.search === "/" && <kbd aria-hidden>/</kbd>}
      </div>
      {query.trim() ? (
        <div
          className="settings-search-results"
          id="settings-search-results"
          role="listbox"
          aria-label="Matching settings"
        >
          {results.map((result, index) => (
            <button
              type="button"
              key={result.id}
              id={`settings-result-${index}`}
              role="option"
              aria-selected={index === selected}
              onClick={() => choose(result)}
            >
              <span>{result.label}</span>
              <small>{sections.find((section) => section.path === result.path)!.label}</small>
            </button>
          ))}
          {!results.length && (
            <p className="muted small" role="status">
              No matching settings
            </p>
          )}
        </div>
      ) : (
        <nav aria-label="Settings navigation">
          {sections.map(({ path, label, icon: Icon }) => (
            <Link key={path} to={path}>
              <Icon size={16} aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
export function RestoreDeviceDefaults() {
  const [open, setOpen] = useState(false);
  const {
    theme,
    compact,
    reducedMotion,
    bindings,
    appearance,
    themeHalves,
    themes,
    restoreDeviceDefaults,
  } = useAppearance();
  const { collapsed, setCollapsed } = useWorkspaceChrome();
  const changed =
    collapsed ||
    theme !== "system" ||
    compact ||
    reducedMotion ||
    JSON.stringify(appearance) !== JSON.stringify(defaultAppearance) ||
    commands.some((command) => bindings[command.id] !== defaultBindings[command.id]) ||
    JSON.stringify(themeHalves) !== JSON.stringify(readThemeHalves(null, themes));
  return (
    <>
      <Button
        variant="ghost"
        size="compact"
        className="restore-device-defaults"
        aria-label="Restore device defaults"
        disabled={!changed}
        onClick={() => setOpen(true)}
      >
        <RotateCcw size={13} aria-hidden />
        <span>Restore device defaults</span>
      </Button>
      {open && (
        <Dialog
          title="Restore device defaults?"
          description="Reset appearance, keyboard shortcuts, and sidebar visibility on this device. Custom themes, monitoring schedules, projects, and connections are kept."
          onClose={() => setOpen(false)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                restoreDeviceDefaults();
                setCollapsed(false);
                setOpen(false);
                toast.add({
                  id: "action-feedback",
                  title: "Device defaults restored.",
                  type: "success",
                });
              }}
            >
              Restore defaults
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
function GeneralSettings() {
  const { snapshot, busy, connection, mutate } = useMonitoring();
  const { snapshot: app, change } = useApplication();
  if (!snapshot || !app) return null;
  const disabled = busy || connection !== "connected";
  const update = (body: unknown) => {
    void mutate(
      "/api/settings",
      body,
      decodeMonitoringSettings,
      "Monitoring preferences saved.",
      "PATCH",
    );
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
            disabled={disabled}
            onCheckedChange={(value) => update({ paused: !value })}
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
            disabled={disabled}
            onChange={(value) => update({ pcIntervalMinutes: Number(value) })}
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
            disabled={disabled}
            onChange={(value) => update({ projectIntervalMinutes: Number(value) })}
          />
        </SettingRow>
        <SettingRow
          label="Scan selected repositories automatically"
          description="Start a scan after selection, then follow the project schedule. Account access alone never selects a repository."
        >
          <Switch
            aria-label="Scan selected repositories automatically"
            checked={app.preferences.automaticRepositoryScans}
            disabled={disabled}
            onCheckedChange={(value) => {
              void change(
                "preferences",
                { automaticRepositoryScans: value },
                "Repository scan preference saved.",
                "PATCH",
              );
            }}
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
            disabled={disabled}
            onCheckedChange={(value) => update({ notifyNewFindings: value })}
          />
        </SettingRow>
        <SettingRow
          label="Check for Versionstead releases"
          description="Check GitHub for a stable application release once a day. Release checking does not install software."
        >
          <Switch
            aria-label="Check for Versionstead releases"
            checked={app.preferences.automaticAppUpdateChecks}
            disabled={disabled}
            onCheckedChange={(value) => {
              void change(
                "preferences",
                { automaticAppUpdateChecks: value },
                "Release check preference saved.",
                "PATCH",
              );
            }}
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
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <>
      <SettingGroup title="Workspace shortcuts">
        {commands.map((command) => (
          <SettingRow
            key={command.id}
            label={command.label}
            description={`Default: ${command.binding.replaceAll("mod", mac ? "⌘" : "Ctrl")}`}
          >
            <div className="row-actions">
              <Button
                aria-label={`Change shortcut for ${command.label}`}
                onClick={() => {
                  setError(null);
                  setCapture(command.id);
                }}
              >
                <kbd>
                  {bindings[command.id]
                    ? bindings[command.id].replaceAll("mod", mac ? "⌘" : "Ctrl")
                    : "Disabled"}
                </kbd>
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
        ))}
      </SettingGroup>
      <Button onClick={() => setBindings({ ...defaultBindings })}>Reset all shortcuts</Button>
      <p className="muted">
        Shortcuts are saved on this device and ignored while typing in a field or using a dialog.
      </p>
      {capture && (
        <Dialog
          title={`Shortcut: ${commands.find((c) => c.id === capture)!.label}`}
          onClose={() => setCapture(null)}
        >
          <p>Focus the field and press the new shortcut. Escape cancels.</p>
          <Input
            autoFocus
            readOnly
            aria-label="Press a shortcut"
            value="Press keys…"
            onKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                setCapture(null);
                return;
              }
              const chord = keyChord(event, mac);
              if (!chord) return;
              if (chord === "tab" || chord === "enter") {
                setError("Use a letter, number, punctuation key, or modified shortcut.");
                return;
              }
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
  const { snapshot: monitoring, busy, error } = useMonitoring();
  const [token, setToken] = useState("");
  const name = kind === "github" ? "GitHub" : "GitLab";
  return (
    <Dialog title={`Connect ${name}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void change(
            "providers/connect",
            { kind, token },
            `${name} connected. Select repositories to start monitoring.`,
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
            disabled={busy || !snapshot?.credentialStorageAvailable || !token.trim()}
          >
            Connect
          </Button>
          <Button
            type="button"
            disabled={
              busy ||
              !snapshot?.credentialStorageAvailable ||
              !snapshot.tools[kind].available ||
              monitoring?.runtime.mode !== "interactive"
            }
            onClick={() => {
              void change(
                "providers/connect",
                { kind, useCli: true },
                `${name} connected from your signed-in CLI.`,
              ).then((result) => {
                if (result) onClose();
              });
            }}
          >
            Use signed-in {kind === "github" ? "gh" : "glab"} CLI
          </Button>
        </div>
        {!snapshot?.credentialStorageAvailable && (
          <p role="alert">Protected provider credentials currently require Windows.</p>
        )}
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
  const { snapshot, busy, connection, mutate } = useMonitoring();
  const [connect, setConnect] = useState<ProviderKind | null>(null);
  const [picker, setPicker] = useState<ProviderKind | null>(null);
  if (!app || !snapshot) return null;
  const disabled = busy || connection !== "connected";
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
            disabled={disabled}
            onCheckedChange={(value) => {
              void change(
                "preferences",
                { automaticRepositoryScans: value },
                "Automatic repository scans saved.",
                "PATCH",
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
            disabled={disabled}
            onChange={(value) => {
              void mutate(
                "/api/settings",
                { projectIntervalMinutes: Number(value) },
                decodeMonitoringSettings,
                "Project and repository scan interval saved.",
                "PATCH",
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
              disabled={disabled || !app.tools.git.available}
              onCheckedChange={(value) => {
                void change(
                  "preferences",
                  { gitEnabled: value },
                  "Git context preference saved.",
                  "PATCH",
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
                  disabled={disabled || (!provider.account && !app.credentialStorageAvailable)}
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
                      <Badge>
                        {project.evidence.status === "not-scanned"
                          ? "Not scanned"
                          : project.evidence.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
              {!app.credentialStorageAvailable && (
                <p role="status">Protected provider connections require Windows.</p>
              )}
              <div className="provider-actions">
                <Button
                  size="sm"
                  disabled={disabled || !app.credentialStorageAvailable}
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
                      disabled={disabled}
                      onClick={() => {
                        void change(
                          "providers",
                          { kind: provider.kind, enabled: false, disconnect: true },
                          `${name} disconnected. Previous repository evidence is retained.`,
                          "PATCH",
                        );
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
    </div>
  );
}

export function SettingsPage() {
  const path = useLocation({ select: (l) => l.pathname });
  const { snapshot, error, refresh } = useApplication();
  const section = settingsSections.find((s) => s.path === path) ?? settingsSections[0];
  return (
    <SettingsSearchTargets>
      <div className="settings-page">
        <h1 className="sr-only">{section.label}</h1>
        {error && (
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
        {!snapshot ? (
          <EmptyState title="Loading settings">
            Connect to your local coordinator to read its preferences.
          </EmptyState>
        ) : path.endsWith("appearance") ? (
          <AppearanceSettings />
        ) : path.endsWith("keybindings") ? (
          <KeybindingsSettings />
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

export function UtilityControls() {
  const { snapshot, change } = useApplication();
  const { busy, connection } = useMonitoring();
  const [open, setOpen] = useState(false);
  const update = snapshot?.update;
  const available = update?.status === "available";
  return (
    <>
      <div className="sidebar-utilities">
        <Link
          to="/settings/general"
          className="utility-button"
          aria-label="Settings"
          title="Settings"
        >
          <Settings2 size={17} aria-hidden />
        </Link>
        <Button
          variant="ghost"
          className={`utility-button ${available ? "update-available" : ""}`}
          aria-label={available ? "Versionstead update available" : "Versionstead updates"}
          title={
            available ? `Versionstead ${update.latestVersion} available` : "Versionstead updates"
          }
          onClick={() => {
            setOpen(true);
            if (update?.status === "idle")
              void change("update", {}, "Versionstead release check finished.");
          }}
        >
          {update?.status === "checking" ? (
            <RefreshCw size={17} className="update-checking" aria-hidden />
          ) : (
            <Download size={17} aria-hidden />
          )}
          {available && <span className="update-indicator" />}
        </Button>
        <span className="muted small">v{update?.currentVersion ?? "0.1.0"}</span>
      </div>
      {open && (
        <Dialog drawer title="Versionstead updates" onClose={() => setOpen(false)}>
          <div className="app-identity">
            <AppLogo />
            <strong>Versionstead</strong>
          </div>
          <p className="muted">Installed source build: {update?.currentVersion ?? "Unknown"}</p>
          <h3>
            {update?.status === "checking"
              ? "Checking releases…"
              : available
                ? `Version ${update.latestVersion} available`
                : update?.status === "current"
                  ? "This build matches the latest stable release"
                  : update?.status === "unpublished"
                    ? "No stable release has been published"
                    : update?.status === "failed"
                      ? "Release check could not be verified"
                      : "Check for a Versionstead release"}
          </h3>
          {update?.error && (
            <p className="error-text" role="alert">
              {update.error}
            </p>
          )}
          <p className="muted small">Last checked {timestamp(update?.checkedAt ?? null)}</p>
          <div className="row-actions">
            <Button
              disabled={busy || connection !== "connected" || update?.status === "checking"}
              onClick={() => {
                void change("update", {}, "Versionstead release check finished.");
              }}
            >
              Check for updates
            </Button>
            {update?.releaseUrl && (
              <a
                className="button outline"
                href={update.releaseUrl}
                target="_blank"
                rel="noreferrer"
              >
                View release <ExternalLink size={14} />
              </a>
            )}
          </div>
          <p className="muted">
            This checkout runs from source. Installer download and restart-to-install will be
            enabled when packaged releases are available.
          </p>
          {update?.notes && (
            <section>
              <h3>Release notes</h3>
              <pre className="release-notes">{update.notes}</pre>
            </section>
          )}
        </Dialog>
      )}
    </>
  );
}

export function ComputerPage() {
  const path = useLocation({ select: (l) => l.pathname });
  const id = path.split("/").at(-1);
  const { snapshot: app, change } = useApplication();
  const { busy, connection } = useMonitoring();
  const computer = app?.computers.find((c) => c.id === id);
  const snapshot = computer?.snapshot;
  if (!computer)
    return (
      <EmptyState title="PC is not connected">
        <Link to="/settings/connections" className="text-link">
          Open Connections to pair a PC
        </Link>
        .
      </EmptyState>
    );
  return (
    <>
      <PageHeading
        title={computer.label}
        description={`Paired PC · ${computer.origin} · Last received ${timestamp(computer.checkedAt)}`}
        actions={
          <>
            <Button
              disabled={busy || connection !== "connected" || computer.enabled === false}
              onClick={() => {
                void change("computers/refresh", { id: computer.id }, "Paired evidence refreshed.");
              }}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              disabled={busy || connection !== "connected" || computer.enabled === false}
              onClick={() => {
                void change("computers/scan", { id: computer.id }, "Paired scan requested.");
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
        <EmptyState title="No evidence received">
          Check that the other PC is running and reachable on your LAN or tailnet.
        </EmptyState>
      ) : (
        <>
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
                      {group.counts.updates} updates · {group.counts.advisories} advisories ·{" "}
                      {group.evidence.status}
                    </span>
                  </summary>
                  <Evidence evidence={group.evidence} />
                  {group.findings.map((finding) => (
                    <div className="preference-row" key={finding.id}>
                      <div>
                        <strong>{finding.name}</strong>
                        <p className="muted">{finding.description}</p>
                      </div>
                      <Badge tone={finding.kind === "advisory" ? "warning" : "neutral"}>
                        {finding.kind}
                      </Badge>
                    </div>
                  ))}
                </details>
              ))
            )}
          </section>
          <section className="setting-section">
            <h2>Global tools · {snapshot.inventory.installations.length}</h2>
            <Evidence evidence={snapshot.inventory.evidence} />
            {snapshot.inventory.updateEvidence && (
              <Evidence evidence={snapshot.inventory.updateEvidence} />
            )}
            <div className="setting-group">
              {snapshot.inventory.installations.map((installation) => (
                <SettingRow
                  key={installation.id}
                  label={installation.name}
                  description={`${installation.manager} · ${installation.version ?? "Unknown version"}`}
                >
                  <Badge>
                    {installation.availableVersion
                      ? `Update: ${installation.availableVersion}`
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
                    {project.evidence.status} · {project.dependencies.length} dependency
                    observations
                  </span>
                </summary>
                {project.repository && (
                  <p className="muted">
                    {project.repository.provider} · {project.repository.ref} ·{" "}
                    {project.repository.commit ?? "Commit not checked"}
                  </p>
                )}
                <Evidence evidence={project.evidence} />
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
                      description={`${dependency.importer} · ${dependency.resolved ?? dependency.requested}`}
                    >
                      <span className="muted">
                        {dependency.availableVersion ??
                          dependency.latestVersion ??
                          "Attention needed"}
                        {dependency.advisoryIds.length
                          ? ` · ${dependency.advisoryIds.length} advisories`
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
