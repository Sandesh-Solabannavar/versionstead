# Roadmap

Milestones are sequential evidence gates, not dates or promises of existing features. Track implementation status here as capabilities land.

## 0 — Runnable foundation

Scope: monorepo, contracts, local status endpoint, web UI, Electron shell, checks, and project documents.

Acceptance:

- A clean install can run the web application and build the desktop application.
- The UI reads actual coordinator status and communicates that scanning is not implemented.
- Shared contracts validate the status response; automated checks cover the behavior they claim.
- The coordinator is restricted to loopback, and application startup/shutdown is documented.

## 1 — One PC and one project

Scope: Windows inventory, one selected local npm project, update availability, known dependency vulnerabilities, SQLite history, and a local notification path.

Acceptance:

- Collect installed package versions using a verified structured source; unsupported/unmatched installations remain visible as unknown.
- Read manifests and a supported lockfile without installing, restoring, or running project scripts.
- Distinguish installed/resolved versions, compatible upgrades, major upgrades, and advisory findings.
- Record coverage, evidence source, input identity, timestamps, errors, and available fixed versions.
- Restart without losing the last successful scan or notification state.
- Notify once for a newly detected finding; an unchanged rescan does not notify again.
- Simulated offline, malformed-input, and interrupted-scan cases preserve evidence and show failure or stale status honestly.

This is the first useful end-to-end release. Validate it on the owner’s real machine before broadening the adapter list.

## 2 — The owner’s project ecosystems

Scope: pnpm/Yarn/Bun workspaces, .NET/NuGet, Rust/Cargo, and selected CLI tools including Codex and Claude Code.

Acceptance:

- Each supported lockfile format has a representative checked fixture, including workspace and transitive-dependency cases.
- Binary Bun lockfiles, missing NuGet restore data, and Git/local dependencies produce explicit coverage limitations when unsupported.
- Version rules, prereleases, release channels, and installation source are respected per ecosystem.
- CLI installations are attributed to their actual location/source; duplicate installations and PATH precedence can be explained from evidence.
- Background scans still execute no repository scripts, install no dependencies, and trigger no implicit restore.

## 3 — Other computers and repositories

Scope: collector mode, explicit LAN/Tailscale pairing, and selected GitHub/GitLab repositories.

Acceptance:

- A second PC enrolls through a one-time pairing flow and receives a unique revocable credential over authenticated TLS.
- Revocation prevents future uploads; malformed, oversized, replayed, and unauthorized requests are rejected.
- Temporary disconnection and coordinator restart recover without losing acknowledged data or duplicating findings.
- Repository access is read-only, tokens use OS-backed storage, and every scan records a commit and file path.
- Projects can be marked maintained by me or watch only, independent of repository ownership.
- One advisory can show every affected device/project, while preserving each source’s evidence and freshness.

## 4 — Cross-platform daily use

Scope: macOS/Homebrew and Linux package-manager adapters, tested desktop packaging, digests, snoozes, and lifecycle signals.

Acceptance:

- Build and smoke-test each claimed OS/architecture; unsupported targets remain documented.
- Linux findings account for distribution/vendor backports rather than comparing upstream versions alone.
- Theme selection, keyboard navigation, screen-reader labels, and contrast work throughout core workflows.
- Daily digests, quiet hours, expiring snoozes, and reconnect behavior have deterministic tests.
- Backup/restore and database migrations are verified on an existing data file.
- Runtime support timelines identify their authoritative source and last verification date.

## Later, only when needed

- Renovate-assisted upgrade PRs with explicit authorization and reviewable changes.
- Source analysis and secret scanning as separate capabilities with independent coverage.
- Archived/deprecated package signals, version drift, and release notes.
- Always-on coordinator deployment and optional export/SBOM formats.

Automatic software upgrades, arbitrary remote commands, and executing untrusted project builds are outside the initial scope.
