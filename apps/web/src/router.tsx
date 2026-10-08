import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CircleAlert,
  Download,
  ExternalLink,
  Folder,
  FolderCog,
  GitBranch,
  Keyboard,
  Link2,
  Monitor,
  Palette,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Timer,
} from "lucide-react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Attention, Projects, Service, ThisPc } from "./pages";
import { MonitoringProvider, useMonitoring } from "./monitoring";
import { AppearanceProvider, useAppearance } from "./theme";
import { ApplicationProvider, useApplication } from "./application";
import { searchSettings, settingsSections } from "./settings-navigation";
import { WorkspaceChromeProvider, useWorkspaceChrome } from "./workspace-chrome";
import { commands, defaultBindings, isMac, keyChord } from "./keybindings";
import { defaultAppearance, readThemeHalves } from "./appearance";
import {
  decodeAcceptedResponse,
  decodeMonitoringSettings,
} from "@versionstead/contracts/monitoring";
import { CommandBlock, Button, Dialog, hasOpenModal, timestamp } from "./ui";
import { actionKeys } from "./monitoring-actions";
import { Input } from "./components/ui/input";
import {
  attentionGroups,
  attentionSearch,
  platformLabel,
  plural,
  restartAdvice,
} from "./monitoring-view";
import { Toaster, toast } from "./components/ui/toast";
import { InAppNotifications } from "./in-app-notifications";
import { AppLogo } from "./components/app-logo";

/** Hides its banner. The focused button is about to go, so keyboard focus moves into the page. */
function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Button
      variant="ghost"
      onClick={() => {
        onDismiss();
        document.getElementById("content")?.focus({ preventScroll: true });
      }}
    >
      Dismiss
    </Button>
  );
}

/** The connection-lost banner. Dismissing lasts until the connection is next lost. */
function DisconnectedBanner() {
  const { snapshot, connectionError, refreshing, refresh } = useMonitoring();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <section className="connection-banner warning" role="status">
      <div>
        <strong>Disconnected · background health unknown</strong>
        <p>
          {connectionError}{" "}
          {snapshot
            ? "Last received evidence remains readable with its original scan times."
            : "No saved evidence is available in this session."}
        </p>
      </div>
      <div className="row-actions">
        <Button
          disabled={refreshing}
          onClick={() => {
            void refresh();
          }}
        >
          {refreshing ? "Reconnecting…" : "Retry connection"}
        </Button>
        <DismissButton onDismiss={() => setDismissed(true)} />
      </div>
    </section>
  );
}

// Banners are for the connection. A failed action is reported once, by the action itself.
function ConnectionNotice() {
  const { connection, snapshot, pending, authenticate } = useMonitoring();
  const [token, setToken] = useState("");
  // The coordinator process whose older-build banner was dismissed; a restarted one is a new case.
  const [dismissedBuild, setDismissedBuild] = useState<string | null>(null);
  // Why the last submitted code was refused; the first visit has no code to be wrong about.
  const [error, setError] = useState<string | null>(null);
  if (connection === "unauthorized")
    return (
      <section className="connection-banner warning" aria-labelledby="access-title">
        <h2 id="access-title">Connect to your local coordinator</h2>
        <p>
          Open Versionstead desktop to connect automatically; browser connection requires the owner
          access code. Run this command in the project folder to read it.
        </p>
        <CommandBlock
          command="pnpm run access"
          label="Copy command that shows the access code"
          className="w-full max-w-md"
        />
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            void authenticate(token.trim(), setError).then((connected) => {
              if (connected) setToken("");
            });
          }}
        >
          <label>
            <span className="sr-only">Local access code</span>
            <Input
              type="password"
              autoComplete="off"
              placeholder="Local access code"
              required
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <Button
            variant="primary"
            type="submit"
            disabled={pending.has(actionKeys.session) || !token.trim()}
          >
            Connect
          </Button>
        </form>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  if (connection === "connecting")
    return (
      <div className="connection-banner" role="status">
        Connecting to the local coordinator…
      </div>
    );
  if (connection === "disconnected") return <DisconnectedBanner />;
  if (
    connection === "connected" &&
    snapshot &&
    (!snapshot.scanProgress ||
      snapshot.inventory.collector !== "npm-bun-global-v1" ||
      snapshot.features !== "settings-repositories-connections-v7") &&
    snapshot.runtime.startedAt !== dismissedBuild
  )
    // Nothing is held back by this banner (the PC scan controls say so themselves), so it can be
    // dismissed like the connection one.
    return (
      <div className="connection-banner warning" role="status">
        <div>
          <strong>Monitoring is running an older build</strong>
          <p>
            Restart monitoring to load the current settings and connection features.{" "}
            {restartAdvice(
              snapshot.runtime.host,
              Boolean(window.versionstead),
              snapshot.runtime.platform,
            )}
          </p>
        </div>
        <DismissButton onDismiss={() => setDismissedBuild(snapshot.runtime.startedAt)} />
      </div>
    );
  return null;
}

function ShellContent() {
  const { collapsed, setCollapsed } = useWorkspaceChrome();
  const { snapshot, connection, refreshing, refresh } = useMonitoring();
  const path = useLocation({ select: (location) => location.pathname });
  const hash = useLocation({ select: (location) => location.hash });
  const settings = path.startsWith("/settings/");
  const { snapshot: application } = useApplication();
  const attentionCount = useMemo(
    () =>
      (snapshot ? attentionGroups(snapshot).length : 0) +
      (application?.computers.reduce(
        (total, computer) =>
          total +
          Math.max(
            computer.snapshot ? attentionGroups(computer.snapshot).length : 0,
            computer.error || !computer.snapshot ? 1 : 0,
          ),
        0,
      ) ?? 0),
    [snapshot, application],
  );
  const title = settings
    ? (settingsSections.find((section) => section.path === path)?.label ?? "Settings")
    : path.startsWith("/computers/")
      ? "Connected PC"
      : path === "/pc"
        ? "This PC"
        : path === "/projects"
          ? "Projects"
          : path === "/service"
            ? "Background service"
            : "Needs attention";
  // A route change is announced by the page title and by moving focus to the new page's content. The
  // first load is not a change, and a link to one setting (a hash) focuses that setting itself.
  const previousPath = useRef(path);
  useEffect(() => {
    document.title = `${title} · Versionstead`;
  }, [title]);
  useEffect(() => {
    if (previousPath.current === path) return;
    previousPath.current = path;
    if (!hash) document.getElementById("content")?.focus({ preventScroll: true });
  }, [path, hash]);
  const serviceText =
    connection !== "connected"
      ? "Service health unknown"
      : snapshot?.settings.paused
        ? "Coordinator running · scans paused"
        : snapshot?.runtime.host === "boot-task"
          ? "Boot host connected"
          : "Session coordinator running";
  return (
    <div className="app-shell" data-sidebar-collapsed={collapsed}>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="app-titlebar">
        <div className="titlebar-leading">
          <AppLogo />
          <Button
            variant="ghost"
            size="icon"
            aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
            aria-expanded={!collapsed}
            aria-controls="workspace-sidebar"
            onClick={() => setCollapsed(!collapsed)}
          >
            <PanelLeft size={16} aria-hidden />
          </Button>
          <div className="breadcrumb">
            {settings ? (
              <span className="muted">Settings</span>
            ) : (
              <Link to="/" className="brand" aria-label="Versionstead home">
                Versionstead
              </Link>
            )}
            <span className="muted" aria-hidden>
              /
            </span>
            <span className="breadcrumb-current">{title}</span>
          </div>
        </div>
        <div className="titlebar-trailing">
          {path === "/settings/general" && <RestoreDeviceDefaults />}
          <div
            className="topbar-status"
            data-testid="connection-state"
            data-state={connection === "connected" ? "online" : connection}
          >
            <span
              className={`status-dot ${connection === "connected" ? "" : "unknown"}`}
              aria-hidden
            />
            <span className="connection-label">
              {connection === "connected"
                ? "Connected"
                : connection === "connecting"
                  ? "Connecting"
                  : connection === "unauthorized"
                    ? "Access code required"
                    : "Disconnected"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              disabled={refreshing}
              aria-label="Refresh coordinator state"
              onClick={() => {
                void refresh();
              }}
            >
              <RefreshCw size={14} aria-hidden />
            </Button>
          </div>
        </div>
      </header>
      <aside className="sidebar" id="workspace-sidebar">
        <div className="sidebar-inner">
          {!settings && (
            <div className="device-summary">
              <Monitor size={18} aria-hidden="true" />
              <div>
                <p className="device-name">{snapshot?.device.label ?? "This PC"}</p>
                <p className="muted small">
                  {snapshot ? platformLabel(snapshot.device.platform) : "Local computer"}
                </p>
              </div>
            </div>
          )}
          {settings ? (
            <SettingsNavigation />
          ) : (
            <>
              <p className="nav-heading eyebrow">Workspace</p>
              <nav aria-label="Main navigation">
                <Link to="/" activeOptions={{ exact: true }}>
                  <CircleAlert size={16} aria-hidden="true" />
                  Needs attention
                  {snapshot && (
                    <span
                      className="nav-count"
                      aria-label={`${plural(attentionCount, "target")} ${attentionCount === 1 ? "needs" : "need"} attention`}
                    >
                      {attentionCount}
                    </span>
                  )}
                </Link>
                <Link to="/pc">
                  <Monitor size={16} aria-hidden="true" />
                  This PC
                </Link>
                <Link to="/projects">
                  <Folder size={16} aria-hidden="true" />
                  Projects
                  {snapshot && <span className="nav-count">{snapshot.projects.length}</span>}
                </Link>
                <Link to="/service">
                  <Timer size={16} aria-hidden="true" />
                  Background service
                </Link>
              </nav>
              {application && application.computers.length > 0 && (
                <>
                  <p className="nav-heading eyebrow">Connected PCs</p>
                  <nav aria-label="Connected computers">
                    {application.computers.map((computer) => (
                      <Link
                        key={computer.id}
                        to="/computers/$computerId"
                        params={{ computerId: computer.id }}
                      >
                        <Monitor size={16} aria-hidden />
                        {computer.label}
                        {computer.error && <span className="status-dot unknown" />}
                      </Link>
                    ))}
                  </nav>
                </>
              )}
              <p className="sidebar-note muted">
                Scans collect evidence. You decide when to update your software.
              </p>
            </>
          )}
        </div>
        <div className="sidebar-footer">
          <Link to="/service" className="service-link">
            <span
              className={`status-dot ${connection === "connected" ? "" : "unknown"}`}
              aria-hidden="true"
            />
            {serviceText}
          </Link>
          <UtilityControls />
          <p className="sidebar-version">
            Versionstead <span>Local workspace</span>
          </p>
        </div>
      </aside>
      <div className="workspace">
        <main id="content" tabIndex={-1} className="content">
          <ConnectionNotice />
          <div className="page">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function Shell() {
  // Settings and paired-PC pages are a separate chunk. Fetch it once the shell is up, while whatever
  // served the shell still answers, so those pages open even after monitoring stops.
  useEffect(() => {
    void SettingsPage.preload?.();
    void ComputerPage.preload?.();
  }, []);
  return (
    <MonitoringProvider>
      <ApplicationProvider>
        <AppearanceProvider>
          <Toaster>
            <WorkspaceChromeProvider>
              <InAppNotifications />
              <Shortcuts />
              <ShellContent />
            </WorkspaceChromeProvider>
          </Toaster>
        </AppearanceProvider>
      </ApplicationProvider>
    </MonitoringProvider>
  );
}

function Shortcuts() {
  const { focusSettingsSearch } = useWorkspaceChrome();
  const { bindings } = useAppearance();
  const { snapshot, connection, pending, refresh, mutate } = useMonitoring();
  const { refresh: refreshApplication } = useApplication();
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || hasOpenModal()) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]',
        )
      )
        return;
      const chord = keyChord(event, isMac());
      const command = commands.find((c) => chord && bindings[c.id] === chord)?.id;
      if (!command) return;
      event.preventDefault();
      const destinations = {
        settings: "/settings/general",
        attention: "/",
        pc: "/pc",
        projects: "/projects",
        service: "/service",
      } as const;
      if (command in destinations) {
        void navigate({ to: destinations[command as keyof typeof destinations] });
        return;
      }
      if (command === "search") {
        const search = document.querySelector<HTMLInputElement>(
          '#settings-search, #content input[type="search"]',
        );
        if (search?.id === "settings-search") focusSettingsSearch();
        else search?.focus();
        return;
      }
      if (command === "refresh") {
        void refresh();
        void refreshApplication();
        return;
      }
      if (connection !== "connected") return;
      // Each shortcut waits only for its own action, the same one its button waits for.
      const scan = actionKeys.scan("all");
      const pause = actionKeys.setting("paused");
      if (command === "scan" && !pending.has(scan))
        void mutate(
          "/api/scans",
          { target: "all" },
          decodeAcceptedResponse,
          "Read-only scans requested.",
          "POST",
          { key: scan },
        );
      if (command === "pause" && snapshot && !pending.has(pause))
        void mutate(
          "/api/settings",
          { paused: !snapshot.settings.paused },
          decodeMonitoringSettings,
          snapshot.settings.paused ? "Scheduled scans resumed." : "Scheduled scans paused.",
          "PATCH",
          { key: pause },
        );
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    bindings,
    snapshot,
    connection,
    pending,
    refresh,
    refreshApplication,
    mutate,
    navigate,
    focusSettingsSearch,
  ]);
  return null;
}

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

function SettingsNavigation() {
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
function RestoreDeviceDefaults() {
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

function UtilityControls() {
  const { snapshot, change } = useApplication();
  const { pending, connection } = useMonitoring();
  const [open, setOpen] = useState(false);
  const checkForUpdate = () => {
    void change("update", {}, "Versionstead release check finished.", "POST", {
      key: actionKeys.update,
    });
  };
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
            if (update?.status === "idle") checkForUpdate();
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
              disabled={
                pending.has(actionKeys.update) ||
                connection !== "connected" ||
                update?.status === "checking"
              }
              onClick={checkForUpdate}
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

// Settings and paired-PC pages load outside the main bundle, fetched once the shell has rendered.
const SettingsPage = lazyRouteComponent(() => import("./settings"), "SettingsPage");
const ComputerPage = lazyRouteComponent(() => import("./settings"), "ComputerPage");

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <section>
      <h1>Page not found</h1>
      <p className="muted">This page does not exist in your workspace.</p>
      <Link to="/" className="text-link">
        Return to needs attention
      </Link>
    </section>
  ),
});
const attentionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: attentionSearch,
  component: Attention,
});
const pcRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pc", component: ThisPc });
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: Projects,
});
const serviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/service",
  component: Service,
});
const generalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/general",
  component: SettingsPage,
});
const appearanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/appearance",
  component: SettingsPage,
});
const keybindingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/keybindings",
  component: SettingsPage,
});
const sourceControlRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/source-control",
  component: SettingsPage,
});
const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/connections",
  component: SettingsPage,
});
const projectSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/project",
  validateSearch: (
    search: Record<string, unknown>,
  ): { project?: string; environment?: string } => ({
    ...(typeof search.project === "string" && search.project.length <= 250
      ? { project: search.project }
      : {}),
    ...(typeof search.environment === "string" && search.environment.length <= 100
      ? { environment: search.environment }
      : {}),
  }),
  component: SettingsPage,
});
const computerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/computers/$computerId",
  component: ComputerPage,
});
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    attentionRoute,
    pcRoute,
    projectsRoute,
    serviceRoute,
    generalRoute,
    appearanceRoute,
    keybindingsRoute,
    sourceControlRoute,
    connectionsRoute,
    projectSettingsRoute,
    computerRoute,
  ]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
