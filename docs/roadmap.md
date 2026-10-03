# Roadmap

Milestones are sequential evidence gates, not dates or promises of existing features. Track implementation status here as capabilities land.

## 0 — Runnable foundation

Status: implemented; superseded by the local monitoring views below.

Scope: monorepo, contracts, local status endpoint, web UI, Electron shell, checks, and project documents.

Acceptance:

- A clean install can run the web application and build the desktop application.
- The UI reads actual coordinator status and communicates that scanning is not implemented.
- Shared contracts validate the status response; automated checks cover the behavior they claim.
- The coordinator is restricted to loopback, and application startup/shutdown is documented.

## 1 — One PC and one project

Status: npm/Bun detection and top-level global-tool checks, selected npm/pnpm/Bun scans, public npm/OSV lookups, durable evidence, live progress, grouped notifications, and tray/client separation are implemented. Windows registry/WinGet scanning has been removed. The boot-task installer captures owner global roots; elevated installation, actual LocalService metadata/project access, reboot, and sign-out verification remain open. Private registries, prerelease channels, standalone binary discovery and self-updates, and inventory of additional inactive Node prefixes remain deferred. Explicit npm/Bun global-package updates and T3-style Windows CLI discovery fallbacks are implemented; see [Global tool updates](global-tool-updates.md).

Scope: an independent Windows background host, owner npm/Bun global tools, selected local npm/pnpm/Bun projects, update availability, known project dependency vulnerabilities, SQLite history, and a local notification path. See the [monitoring implementation plan](monitoring-implementation.md) and the implemented four-view interface.

Acceptance:

- Monitoring starts at Windows boot and continues after closing Electron and signing out; the UI reconnects to the existing coordinator instead of starting a duplicate.
- Verify selected-project and captured global-root access under the actual background identity. Inaccessible sources remain unknown; notifications collected while signed out are delivered when the user returns.
- Collect installed package versions using a verified structured source; unsupported/unmatched installations remain visible as unknown.
- Read manifests and a supported lockfile without installing, restoring, or running project scripts.
- Distinguish installed/resolved versions, compatible upgrades, major upgrades, and advisory findings.
- Record coverage, evidence source, input identity, timestamps, errors, and available fixed versions.
- Restart without losing the last successful scan or notification state.
- Notify once for a newly detected finding; an unchanged rescan does not notify again.
- Simulated offline, malformed-input, and interrupted-scan cases preserve evidence and show failure or stale status honestly.

This is the first useful end-to-end release. Validate it on the owner’s real machine before broadening the adapter list.

## 2 — The owner’s project ecosystems

Bun text lockfile v0/v1 scans, workspace resolution, and catalogs are implemented for local and selected provider projects.

Scope: broader npm/pnpm/Bun workspace coverage, Yarn, newer/binary Bun lockfiles, .NET/NuGet, Rust/Cargo, and selected CLI tools including Codex and Claude Code.

Acceptance:

- Each supported lockfile format has a representative checked fixture, including workspace and transitive-dependency cases.
- Binary Bun lockfiles, missing NuGet restore data, and Git/local dependencies produce explicit coverage limitations when unsupported.
- Version rules, prereleases, release channels, and installation source are respected per ecosystem.
- CLI installations are attributed to their actual location/source; duplicate installations and PATH precedence can be explained from evidence.
- Background scans still execute no repository scripts, install no dependencies, and trigger no implicit restore.

## 3 — Other computers and repositories

Project display names/icons, confirmed removal, and manually launched owner commands for local checkouts are implemented; see [Project settings](project-settings.md). Background scanning remains read-only. Remote project administration/command execution, worktree workflows, and automatic project scripts remain outside the current scope.

Status: selected GitHub.com/GitLab.com repository scans, Windows-protected credentials, routed settings, release checks, and pinned HTTPS pairing/evidence/scan/revocation are implemented. Connections follows T3 Code's grouped settings and Remote link/SSH dialog, with pairing-link autofill, saved-environment switches, and action menus. Optional owner-session OpenSSH forwarding targets an already-running monitor. Regression checks exercise two isolated HTTPS coordinators and pinned TLS through a controlled TCP forward. Physical second-PC networking, actual SSH authentication, firewall configuration, sign-out operation, central cross-device notifications, certificate rotation, and managed Tailscale MagicDNS/Serve remain open.

Scope: independently running coordinators with explicit LAN/Tailscale pairing, and selected GitHub/GitLab repositories.

Acceptance:

- A second PC enrolls through a one-time pairing flow and receives a unique revocable credential over authenticated TLS.
- Revocation prevents future evidence reads and scan requests; malformed, oversized, replayed, and unauthorized requests are rejected.
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
