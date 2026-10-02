import { useState } from "react";
import { CircleAlert, Folder, Monitor, RefreshCw, ShieldCheck, Timer } from "lucide-react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { Attention, Projects, Service, ThisPc } from "./pages";
import { MonitoringProvider, useMonitoring } from "./monitoring";
import { ThemeSelect } from "./theme";
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
    (!snapshot.scanProgress || snapshot.inventory.collector !== "npm-bun-global-v1")
  )
    return (
      <div className="connection-banner warning" role="status">
        <div>
          <strong>Monitoring is running an older build</strong>
          <p>
            Restart monitoring to load npm and Bun global tool checks.{" "}
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
  const title =
    path === "/pc"
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
          <p className="nav-heading eyebrow">Workspace</p>
          <nav aria-label="Main navigation">
            <Link to="/" activeOptions={{ exact: true }}>
              <CircleAlert size={16} aria-hidden="true" />
              Needs attention
              {snapshot && (
                <span
                  className="nav-count"
                  aria-label={`${attentionGroups(snapshot).length} targets need attention`}
                >
                  {attentionGroups(snapshot).length}
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
          <p className="sidebar-note muted">
            Scans collect evidence. You decide when to update your software.
          </p>
        </div>
        <div className="sidebar-footer">
          <Link to="/service" className="service-link">
            <span
              className={`status-dot ${connection === "connected" ? "" : "unknown"}`}
              aria-hidden="true"
            />
            {serviceText}
          </Link>
          <ThemeSelect />
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
      <ShellContent />
    </MonitoringProvider>
  );
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
export const router = createRouter({
  routeTree: rootRoute.addChildren([attentionRoute, pcRoute, projectsRoute, serviceRoute]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
