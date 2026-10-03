# Versionstead

A personal, local-first home for software versions, dependency updates, and known vulnerability findings across your computers and projects.

The name combines **version** with **stead**: a home for the software you look after. The initial scope is one person’s machines and repositories.

## Current state

The sidebar Settings and Update controls follow T3 Code’s routed settings and status patterns. General controls scan schedules and summary notifications; Appearance provides T3 Code theme previews and palettes, custom themes, interface controls, typography, density, and motion preferences; Keybindings supports editable shortcuts with conflict checks. Source Control uses T3 Code’s compact discovery rows, branded icons, and expanders, detects Git, and connects GitHub/GitLab with Windows-protected credentials. Authenticated accounts start blurred with click-to-reveal; refresh rechecks tools and saved provider authentication. Add Project offers local folders, GitHub, GitLab, and repository URLs. You confirm selected repositories and refs before automatic read-only npm/pnpm/Bun scans begin. Jujutsu and the remaining providers are marked Coming soon.

Connections follows T3 Code's machine settings, saved environments, menus, and Remote link/SSH dialog. One-time pairing links fill the host and code automatically; pinned HTTPS and revocable credentials protect access. Each PC keeps its own coordinator and scans its own selected sources. Environment switches pause/resume remote refreshes without discarding evidence. LAN/Tailscale IPv4 links work with the background host; optional owner-session OpenSSH tunnels connect to an already-running monitor using configured keys or an agent. Physical second-PC networking, real SSH authentication, firewall setup, and sign-out operation still need acceptance checks. See [Settings and connections](docs/settings-and-connections.md).

The Update control checks GitHub stable releases and shows release notes. This source checkout has no installer update mechanism; download-and-install updates await packaged releases.

The Electron app has four monitoring views: Needs attention, This PC, Projects, and Background monitoring. This PC detects npm and Bun separately, reads their global tool manifests, and checks eligible stable packages against the public npm registry. Selected npm/pnpm/Bun projects retain their lockfile, version, and OSV advisory scans. Evidence, history, settings, and notification receipts are stored in SQLite. This PC starts with a Scan this PC prompt and defaults to confirmed updates; filters expose all global tools, checked-current results, unverified observations, and either package manager.

Public version checks attempt every eligible unique direct package name in selected projects and npm/Bun global tools. Advisory details have no record-count cutoff. Requests run at most four at a time, with time budgets scaled to each stage's workload; individual failures remain explicit while unrelated checks continue. Private or unsupported sources remain outside verified coverage.

This PC's **Update now** button uses T3 Code's compact update controls and pending/failure behavior. In Windows Electron, a manual click updates the exact selected package in its observed npm/Bun global location, verifies the installed version, and rescans. The evidence drawer offers the exact command and Copy. Discovery searches PATH first, then T3's known Windows CLI locations and configured manager directories. Background scans remain read-only. See [behavior, paths, and verification](docs/global-tool-updates.md).

Local owner-session project scans now try the installed npm 11, pnpm 10, or Bun 1.4 `outdated` command first. Checks run per workspace, normalize compatible/latest candidates, and label the manager/version that supplied the result. Unreported, ambiguous, failed, or unavailable CLI records retain the public-registry fallback. Remote repository scans and signed-out background hosts continue using file/registry evidence. Internal workspace/local links are coverage information rather than incomplete-check warnings. During a scan, no install, upgrade, repository hook, or lifecycle script runs. See [package-manager checks](docs/package-manager-checks.md).

Closing the window keeps Versionstead in the system tray. Quitting the UI leaves its independent coordinator running. A Windows boot-task installer is provided for monitoring after sign-out; installing and verifying that host requires elevated PowerShell and a real boot/sign-out check.

Desktop startup gracefully replaces older session coordinators missing scan-progress, global-tool, or settings/connection support. The one-time migration resets active Windows-app evidence for the new first PC scan while preserving projects, settings, and scan history. The tray also provides Restart monitoring for session hosts; Windows boot hosts use the background setup script's Restart action.

PC coverage is top-level npm/Bun global packages from the managers available in the owner's PATH or supported Windows CLI fallback directories. It preserves separate manager/location identities and reads installed versions without running package scripts. Missing managers are skipped; unavailable sources retain previous evidence. Private/custom registries, copied local/Git tools, linked tools outside the selected global root, prerelease upgrade channels, other Node-manager prefixes, standalone binaries, and Node/Bun runtime upgrades remain unverified or unsupported. Windows registry and WinGet scanning have been removed. The boot host uses captured owner roots rather than its own PATH/profile; refresh source configuration in the owner session after changing managers or registry routing. Project support covers npm package-lock v2/v3, pnpm lockfile v9, and Bun text bun.lock v0/v1, including workspaces and Bun catalogs. Binary bun.lockb and newer Bun lockfile versions remain unsupported.

Scans show their real stage, known work counts, and queued targets. Notifications combine new findings into one count summary after the scan queue settles, with a persisted five-minute cooldown; unchanged scans stay quiet. Security advisories remain separate from update counts. In-app shadcn toasts show action results, errors, and these summaries with a Review button opening the matching Needs attention filter. Summary identities stay dismissed across polling and UI reloads; native desktop notifications continue when the window is closed.

The interface uses source-owned shadcn/Base UI components inspired by T3 Code. Needs attention groups findings by PC or project, and Projects defaults to folders with updates or incomplete checks. Groups start closed; manually opened groups retain their state while results refresh. All projects and All dependencies expose the full retained inventory. Evidence opens in a keyboard-accessible side sheet. The Versionstead V mark appears in the title bar, favicon, update panel, tray, and native desktop notifications. Appearance settings contains System/Light/Dark preview cards and independently selected light/dark palettes; the sidebar footer keeps only Settings and Update controls.

The integrated title bar uses T3 Code's native Windows controls, drag regions, and theme behavior. Settings adds compact breadcrumbs, searchable rows, sidebar collapse, and Back/Escape returning to the last workspace. General can restore this device's UI defaults with confirmation. Window position, size, and maximized state survive UI restarts. See [settings behavior](docs/settings-and-connections.md).

Settings → Project provides display names, automatic/custom icons, and confirmed removal. Local checkouts support saved custom commands launched manually in Windows Electron, with shortcuts, output, and Stop. Scans remain read-only. Provider-only repositories need a local checkout to run commands; paired project settings are read-only. See [Project settings](docs/project-settings.md).

## Run locally

Install Node.js 24.13.1 or newer within the Node 24 release line and the pnpm version pinned in `package.json`. Run these commands from the repository root:

```sh
pnpm install
pnpm dev
```

Open `http://127.0.0.1:4317`. The development coordinator listens on port `4318`. To build and launch the desktop application:

```sh
pnpm desktop
```

The first desktop launch downloads the pinned Electron runtime through `install-electron` if it is not cached. This launches from source; native installers and signing are not ready.

Electron authenticates automatically. For browser access, run `pnpm run access` in another terminal and enter the displayed session code. It is a local capability; keep it private. Select a project folder in Projects and run a scan. Scans read metadata and never install dependencies or execute project scripts.

Useful checks (`pnpm check` includes the build required by the desktop smoke check):

```sh
pnpm check
pnpm desktop:smoke
```

See [development](docs/development.md) for the individual commands and process boundaries.

See [Windows background setup and verification](docs/windows-background.md) for the boot host. The [implementation plan](docs/monitoring-implementation.md) records the accepted workflow and remaining acceptance gates. The mockup design has been absorbed into the real React application.

Verification results and limitations are recorded in [development](docs/development.md). Native desktop behavior on macOS/Linux, boot/sign-out hosting, installers, and signing remain unverified. GitHub Actions defines workspace checks for Windows, Linux, and macOS; these do not include native desktop smoke checks. No release has been published.

## Intended coverage

| Area                | Planned support                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Computers           | Local PC, explicitly enrolled LAN devices, devices reachable through Tailscale                          |
| Installed software  | Package-manager inventory and updates; source-aware CLI tool detection, including Codex and Claude Code |
| JavaScript projects | npm, pnpm, Yarn, and Bun manifests, lockfiles, and workspaces                                           |
| Other projects      | .NET/NuGet and Rust/Cargo                                                                               |
| Source control      | Selected GitHub and GitLab repositories with read-only access                                           |
| Findings            | Available updates, known dependency vulnerabilities, stale or incomplete checks                         |
| Follow-up           | Deduplicated notifications, history, runtime lifecycle, and later optional upgrade PRs                  |

An update is evaluated against the actual installation source and release channel. “Outdated,” “vulnerable,” “unsupported,” and “could not check” remain distinct.

## Structure

```text
apps/
  desktop/       Electron shell
  server/        Local coordinator and HTTP boundary
  web/           React interface
packages/
  contracts/     Shared validated wire contracts
docs/            Architecture, delivery plan, design, and security decisions
```

The stack and service boundaries are inspired by the local [T3 Code](https://github.com/pingdotgg/t3code) reference at `D:\production_code\t3code`, revision `54084ae1e6`. This is an independent foundation; it does not adopt T3 Code’s full event-sourced orchestration.

## Project documents

- [Project context](CONTEXT.md): scope, terminology, and decisions.
- [Architecture](docs/architecture.md): present structure and planned data flows.
- [Roadmap](docs/roadmap.md): ordered milestones with acceptance criteria.
- [Development](docs/development.md): setup and contribution workflow.
- [Design](docs/design.md): themes, interaction, and information presentation.
- [Security](docs/security.md): trust boundaries, limitations, and implementation requirements.
- [Agent instructions](AGENTS.md): repository working conventions.

No distribution license has been selected yet. Adapted T3 Code UI components retain their [MIT notice](apps/web/public/THIRD_PARTY_NOTICES.txt), also included in built assets. Naming here is a project choice, not a claim of trademark or package-name availability.
