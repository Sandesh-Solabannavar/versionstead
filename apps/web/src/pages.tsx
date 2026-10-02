import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { decodeStatus, type Status } from "@versionstead/contracts/status";

type Connection =
  | { state: "loading" }
  | { state: "ready"; status: Status }
  | { state: "error"; message: string };

export function Overview() {
  const [connection, setConnection] = useState<Connection>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("timeout"), 10_000);
    let active = true;

    async function connect() {
      try {
        const response = await fetch("/api/status", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Coordinator returned HTTP ${response.status}.`);
        const status = decodeStatus(await response.json());
        if (active) setConnection({ state: "ready", status });
      } catch (error) {
        if (active) {
          setConnection({
            state: "error",
            message: controller.signal.aborted
              ? "The coordinator took too long to respond."
              : error instanceof Error
                ? error.message
                : "The coordinator could not be reached.",
          });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void connect();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The retry counter intentionally triggers a new request.
  }, [attempt]);

  return (
    <>
      <div className="page-heading">
        <h1>Overview</h1>
        <p>Keep your computers and projects in view.</p>
      </div>
      <section
        className="panel"
        aria-labelledby="coordinator-title"
        aria-busy={connection.state === "loading"}
      >
        <div className="panel-heading">
          <h2 id="coordinator-title">Local coordinator</h2>
          <button
            type="button"
            disabled={connection.state === "loading"}
            onClick={() => {
              setConnection({ state: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            {connection.state === "error" ? "Retry connection" : "Refresh status"}
          </button>
        </div>
        <div
          role="status"
          aria-live="polite"
          data-testid="connection-state"
          data-state={connection.state === "ready" ? "online" : connection.state}
        >
          {connection.state === "loading" && (
            <p className="status-message muted">Connecting to your coordinator…</p>
          )}
          {connection.state === "error" && (
            <div className="status-message">
              <p className="error-text">Coordinator unavailable</p>
              <p className="muted">{connection.message}</p>
              <p className="muted">
                Start Versionstead and try again. Software health has not been checked.
              </p>
            </div>
          )}
          {connection.state === "ready" && (
            <>
              <p className="connection-status">
                <span className="status-dot" aria-hidden="true" />
                Connected to this computer
              </p>
              <dl className="details-grid">
                <div>
                  <dt>Computer</dt>
                  <dd>{connection.status.environment.hostname}</dd>
                </div>
                <div>
                  <dt>Platform</dt>
                  <dd>
                    {connection.status.environment.platform} / {connection.status.environment.arch}
                  </dd>
                </div>
                <div>
                  <dt>Versionstead</dt>
                  <dd>{connection.status.appVersion}</dd>
                </div>
                <div>
                  <dt>Coordinator started</dt>
                  <dd>{new Date(connection.status.startedAt).toLocaleString()}</dd>
                </div>
              </dl>
            </>
          )}
        </div>
      </section>
      <section className="empty-state" aria-labelledby="findings-title">
        <span className="tag">Not scanned</span>
        <h2 id="findings-title">Your monitoring starts here</h2>
        <p>
          Inventory, update checks, and vulnerability scanning are not implemented yet. This
          foundation connects the interface to your local coordinator.
        </p>
        <Link to="/coverage" className="text-link">
          View planned coverage <span aria-hidden="true">→</span>
        </Link>
      </section>
    </>
  );
}

const coverage = [
  [
    "Installed software",
    "Windows / macOS / Linux",
    "Package-manager inventory and available updates.",
  ],
  [
    "JavaScript projects",
    "npm / pnpm / Yarn / Bun",
    "Resolved dependencies, upgrades, and known vulnerabilities.",
  ],
  [".NET and Rust projects", "NuGet / Cargo", "Dependency versions and ecosystem advisories."],
  [
    "Other computers",
    "Local network / Tailscale",
    "Explicitly paired collectors and last-seen status.",
  ],
  ["Source control", "GitHub / GitLab", "Selected repositories with read-only access."],
] as const;

export function Coverage() {
  return (
    <>
      <div className="page-heading">
        <h1>Coverage</h1>
        <p>What Versionstead is being built to watch.</p>
      </div>
      <p className="notice">
        All integrations below are planned. No software or dependency scans run in this foundation.
      </p>
      <div className="table-scroll" role="region" aria-label="Planned coverage" tabIndex={0}>
        <table>
          <caption className="sr-only">Planned integrations and their scope</caption>
          <thead>
            <tr>
              <th scope="col">Integration</th>
              <th scope="col">Scope</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {coverage.map(([name, targets, description]) => (
              <tr key={name}>
                <th scope="row">
                  {name}
                  <span className="table-subtext">{targets}</span>
                </th>
                <td>{description}</td>
                <td>
                  <span className="tag">Planned</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="prose-section">
        <h2>Coverage you can trust</h2>
        <p>
          Outdated, vulnerable, and unable to check will be separate results. Missing data and
          failed scans will stay visible, with the source and time of the last successful check.
        </p>
      </section>
    </>
  );
}

export function About() {
  return (
    <>
      <div className="page-heading">
        <h1>About Versionstead</h1>
        <p>A home for your software’s health.</p>
      </div>
      <section className="prose-section">
        <h2>Built around your own machines</h2>
        <p>
          Versionstead will bring installed applications, CLI tools, and project dependencies into
          one personal workspace, with upgrade notices and known vulnerability findings.
        </p>
        <h2>A working foundation</h2>
        <p>
          This version includes the local coordinator connection, navigation, and appearance
          settings. Scanners, remote enrollment, repository connections, and notifications are
          next-stage work.
        </p>
        <h2>Familiar structure, independent project</h2>
        <p>
          The desktop, web, server, and shared-contract structure follows patterns studied in
          T3Code, along with its compact interface and semantic theme tokens. Versionstead is an
          independent project.
        </p>
        <Link to="/coverage" className="text-link">
          Explore the planned integrations <span aria-hidden="true">→</span>
        </Link>
      </section>
    </>
  );
}
