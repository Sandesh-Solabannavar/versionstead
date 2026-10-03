import { useEffect, useState } from "react";
import { CircleAlert, Folder, Monitor, RefreshCw, ShieldCheck, Timer } from "lucide-react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Attention, Projects, Service, ThisPc } from "./pages";
import { MonitoringProvider, useMonitoring } from "./monitoring";
import { AppearanceProvider, useAppearance } from "./theme";
import { ApplicationProvider, useApplication } from "./application";
import { SettingsNavigation, SettingsPage, UtilityControls, ComputerPage } from "./settings";
import { commands, keyChord } from "./keybindings";
import {
  decodeAcceptedResponse,
  decodeMonitoringSettings,
} from "@versionstead/contracts/monitoring";
import { Button } from "./ui";
import { Input } from "./components/ui/input";
import { attentionGroups, attentionSearch } from "./monitoring-view";

function ConnectionNotice() {
  const { connection, snapshot, busy, error, notice, refreshing, refresh, authenticate } =
    useMonitoring();
  const [token, setToken] = useState("");
  if (connection === "unauthorized")
    return (
      <section className="connection-banner warning" aria-labelledby="access-title">
        <h2 id="access-title">Connect to your local coordinator</h2>
        <p>
          Open Versionstead desktop to connect automatically; browser connection requires the owner
          access code. Run <code>pnpm run access</code> in the project folder to read it.
        </p>
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            void authenticate(token.trim()).then((connected) => {
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
          <Button variant="primary" type="submit" disabled={busy || !token.trim()}>
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
  if (connection === "disconnected")
    return (
      <section className="connection-banner warning" role="status">
        <div>
          <strong>UI disconnected · background health unknown</strong>
          <p>
            {error}{" "}
            {snapshot
              ? "Last received evidence remains readable with its original scan times."
              : "No saved evidence is available in this session."}
          </p>
        </div>
        <Button
          disabled={refreshing}
          onClick={() => {
            void refresh();
          }}
        >
          {refreshing ? "Reconnecting…" : "Retry connection"}
        </Button>
      </section>
    );
  if (error)
    return (
      <div className="connection-banner error" role="alert">
        {error}
      </div>
    );
  if (
    connection === "connected" &&
    snapshot &&
    (!snapshot.scanProgress ||
      snapshot.inventory.collector !== "npm-bun-global-v1" ||
      snapshot.features !== "settings-repositories-connections-v6")
  )
    return (
      <div className="connection-banner warning" role="status">
        <div>
          <strong>Monitoring is running an older build</strong>
          <p>
            Restart monitoring to load the current settings and connection features.{" "}
            {snapshot.runtime.host === "boot-task"
              ? "Run the Windows background setup command with -Action Restart in administrator PowerShell."
              : "Quit Versionstead UI from the tray and launch the rebuilt desktop app. It replaces an older session coordinator automatically."}
          </p>
        </div>
      </div>
    );
  if (notice)
    return (
      <div className="connection-banner" role="status">
        {notice}
      </div>
    );
  return null;
}

function ShellContent() {
  const { snapshot, connection, refreshing, refresh } = useMonitoring();
  const path = useLocation({ select: (location) => location.pathname });
  const settings = path.startsWith("/settings/");
  const { snapshot: application } = useApplication();
  const attentionCount =
    (snapshot ? attentionGroups(snapshot).length : 0) +
    (application?.computers.reduce(
      (total, computer) =>
        total +
        Math.max(
          computer.snapshot ? attentionGroups(computer.snapshot).length : 0,
          computer.error || !computer.snapshot ? 1 : 0,
        ),
      0,
    ) ?? 0);
  const title = settings
    ? "Settings"
    : path.startsWith("/computers/")
      ? "Connected PC"
      : path === "/pc"
        ? "This PC"
        : path === "/projects"
          ? "Projects"
          : path === "/service"
            ? "Background service"
            : "Needs attention";
  const serviceText =
    connection !== "connected"
      ? "Service health unknown"
      : snapshot?.settings.paused
        ? "Coordinator running · scans paused"
        : snapshot?.runtime.host === "boot-task"
          ? "Boot host connected"
          : "Session coordinator running";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <div className="app-titlebar">
        <Link to="/" className="brand" aria-label="Versionstead home">
          <span className="brand-mark" aria-hidden="true">
            v.
          </span>
          <span>Versionstead</span>
        </Link>
        <span className="titlebar-context">
          <ShieldCheck size={13} aria-hidden="true" />
          Read-only monitoring
        </span>
      </div>
      <aside className="sidebar">
        <div className="sidebar-inner">
          <div className="device-summary">
            <Monitor size={18} aria-hidden="true" />
            <div>
              <h2>{snapshot?.device.label ?? "This PC"}</h2>
              <p className="muted small">{snapshot?.device.platform ?? "Local computer"}</p>
            </div>
          </div>
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
                      aria-label={`${attentionCount} targets need attention`}
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
        <header className="topbar">
          <div className="breadcrumb">
            <span className="muted">Personal workspace</span>
            <span className="muted" aria-hidden="true">
              /
            </span>
            <span>{title}</span>
          </div>
          <div
            className="topbar-status"
            data-testid="connection-state"
            data-state={connection === "connected" ? "online" : connection}
          >
            <span
              className={`status-dot ${connection === "connected" ? "" : "unknown"}`}
              aria-hidden="true"
            />
            {connection === "connected"
              ? "UI connected"
              : connection === "connecting"
                ? "Connecting"
                : connection === "unauthorized"
                  ? "Access code required"
                  : "UI disconnected"}
            <Button
              variant="ghost"
              disabled={refreshing}
              aria-label="Refresh coordinator state"
              onClick={() => {
                void refresh();
              }}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </Button>
          </div>
        </header>
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
  return (
    <MonitoringProvider>
      <ApplicationProvider>
        <AppearanceProvider>
          <Shortcuts />
          <ShellContent />
        </AppearanceProvider>
      </ApplicationProvider>
    </MonitoringProvider>
  );
}

function Shortcuts() {
  const { bindings } = useAppearance();
  const { snapshot, connection, busy, refresh, mutate } = useMonitoring();
  const { refresh: refreshApplication } = useApplication();
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        document.querySelector('dialog[open], [role="dialog"]')
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]',
        )
      )
        return;
      const chord = keyChord(event, /Mac|iPhone|iPad/.test(navigator.platform));
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
        document.querySelector<HTMLInputElement>('#content input[type="search"]')?.focus();
        return;
      }
      if (command === "refresh") {
        void refresh();
        void refreshApplication();
        return;
      }
      if (busy || connection !== "connected") return;
      if (command === "scan")
        void mutate(
          "/api/scans",
          { target: "all" },
          decodeAcceptedResponse,
          "Read-only scans requested.",
        );
      if (command === "pause" && snapshot)
        void mutate(
          "/api/settings",
          { paused: !snapshot.settings.paused },
          decodeMonitoringSettings,
          snapshot.settings.paused ? "Scheduled scans resumed." : "Scheduled scans paused.",
          "PATCH",
        );
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindings, snapshot, connection, busy, refresh, refreshApplication, mutate, navigate]);
  return null;
}

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
