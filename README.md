# Versionstead

A personal, local-first home for software versions, dependency updates, and known vulnerability findings across your computers and projects.

The name combines **version** with **stead**: a home for the software you look after. The initial scope is one person’s machines and repositories.

## Current state

The Electron app has four monitoring views: Needs attention, This PC, Projects, and Background monitoring. This PC detects npm and Bun separately, reads their global tool manifests, and checks eligible stable packages against the public npm registry. Selected npm/pnpm projects retain their lockfile, version, and OSV advisory scans. Evidence, history, settings, and notification receipts are stored in SQLite. This PC starts with a Scan this PC prompt and defaults to confirmed updates; filters expose all global tools, checked-current results, unverified observations, and either package manager.

Public version checks attempt every eligible unique direct package name in selected projects and npm/Bun global tools. Advisory details have no record-count cutoff. Requests run at most four at a time, with time budgets scaled to each stage's workload; individual failures remain explicit while unrelated checks continue. Private or unsupported sources remain outside verified coverage.

Closing the window keeps Versionstead in the system tray. Quitting the UI leaves its independent coordinator running. A Windows boot-task installer is provided for monitoring after sign-out; installing and verifying that host requires elevated PowerShell and a real boot/sign-out check.

Desktop startup gracefully replaces older session coordinators missing scan-progress or global-tool support. The one-time migration resets active Windows-app evidence for the new first PC scan while preserving projects, settings, and scan history. The tray also provides Restart monitoring for session hosts; Windows boot hosts use the background setup script's Restart action.

PC coverage is top-level npm/Bun global packages from the managers available in the owner's PATH. It preserves separate manager/location identities and reads installed versions without running package scripts. Missing managers are skipped; unavailable sources retain previous evidence. Private/custom registries, copied local/Git tools, linked tools outside the selected global root, prerelease upgrade channels, other Node-manager prefixes, standalone binaries, and npm/Bun runtime self-updates remain unverified or unsupported. Windows registry and WinGet scanning have been removed. The boot host uses captured owner roots rather than its own PATH/profile; refresh source configuration in the owner session after changing managers or registry routing. Project support remains npm package-lock v2/v3 and pnpm lockfile v9; Bun global-tool support does not add Bun project-lockfile support.

Scans show their real stage, known work counts, and queued targets. Notifications combine new findings into one count summary after the scan queue settles, with a persisted five-minute cooldown; unchanged scans stay quiet. Security advisories remain separate from update counts. Summary clicks open the matching Needs attention filter.

The interface uses source-owned shadcn/Base UI components inspired by T3 Code. Needs attention groups findings by PC or project, and Projects defaults to folders with updates or incomplete checks. Multiple groups can stay expanded; All projects and All dependencies expose the full retained inventory. Evidence opens in a keyboard-accessible side sheet. System, Light, and Dark theme buttons have separated hit targets.

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
