# Versionstead

A personal, local-first home for software versions, dependency updates, and known vulnerability findings across your computers and projects.

The name combines **version** with **stead**: a home for the software you look after. The initial scope is one person’s machines and repositories.

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

Electron authenticates automatically. For browser access, run `pnpm run access` in another terminal. It prints the address to open and the session code to enter there: under `pnpm dev`, the development UI at `http://127.0.0.1:4317`; otherwise the coordinator’s own address. The code is a local capability; keep it private. Select a project folder in Projects and run a scan. Scans read metadata and never install dependencies or execute project scripts.

Useful checks (`pnpm check` includes the build required by the desktop smoke check):

```sh
pnpm check
pnpm desktop:smoke
```

See [development](docs/development.md) for the individual commands and process boundaries.

See [Windows background setup and verification](docs/windows-background.md) for the boot host. The [implementation plan](docs/monitoring-implementation.md) records the accepted workflow and remaining acceptance gates. The mockup design has been absorbed into the real React application.

Verification results and limitations are recorded in [development](docs/development.md). Installers and signing are not ready, and no release has been published.

## Platform support

Windows is the only platform with hardware verification. Each cell says how far a capability has been checked on that platform:

- **Verified on Windows hardware**: exercised on the owner’s Windows 11 PC.
- **Verified in a Linux container (automated)**: automated tests pass in a Linux container, not on Linux hardware.
- **Implemented, unverified on hardware**: the code and platform-injected tests exist, but that platform’s hardware has not run it.
- **Windows only**: not available on this platform. The app turns it off and says so.

| Capability                           | Windows                                                                            | macOS                               | Linux                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Desktop app launch                   | Verified on Windows hardware                                                       | Implemented, unverified on hardware | Implemented, unverified on hardware                    |
| This PC npm/Bun inventory            | Verified on Windows hardware                                                       | Implemented, unverified on hardware | Verified in a Linux container (automated; no real Bun) |
| Local projects (npm, pnpm, Bun)      | Verified on Windows hardware                                                       | Implemented, unverified on hardware | Verified in a Linux container (automated; no real Bun) |
| GitHub/GitLab repositories           | Verified on Windows hardware (GitHub live October 3; GitLab: controlled responses) | Windows only                        | Windows only                                           |
| Paired PCs (LAN, Tailscale, SSH)     | Verified on Windows hardware, isolated coordinators only                           | Windows only                        | Windows only                                           |
| Custom project commands              | Verified on Windows hardware                                                       | Windows only                        | Windows only                                           |
| Global tool updates                  | Verified before Wave 1 (Oct 3); not re-run                                         | Implemented, unverified on hardware | Implemented, unverified on hardware                    |
| Background monitoring after sign-out | Windows boot task: manual elevated setup, lifecycle unverified                     | Windows only                        | Windows only                                           |

- The desktop app runs from source with `pnpm desktop`; there are no installers and nothing is signed. On Ubuntu 24.04 and newer, Electron also needs its sandbox helper set up, as [development](docs/development.md) describes. The native desktop check (`pnpm desktop:smoke`) is recorded as passing on Windows only.
- macOS and Linux tool discovery (PATH plus the usual install and version-manager locations), data folders, and shim-safe Node and Bun detection are covered by platform-injected tests, and on Linux by automated tests in a container. The container has no Bun, and version-manager shims are simulated, so Bun and shim detection there ran against stand-ins. The container runs the coordinator, desktop-module, and web tests, not a running desktop window. GitHub Actions defines `pnpm check` for Windows, Linux, and macOS on pull requests and pushes to `main`, without the desktop smoke check. Nothing has been verified on macOS hardware.
- GitHub/GitLab repositories, paired PCs, and custom project commands need Windows credential protection or Windows PowerShell. Elsewhere the app says so (“Protected connections require Windows.”, “Custom commands run in the Windows desktop app.”).
- GitHub scans also ran against a live repository on October 3, before [Wave 1](docs/development.md#wave-1-verification-october-8-2026), and that run was not repeated; GitLab was exercised only against controlled responses. Paired PCs were exercised between isolated coordinators on the same PC; physical LAN, Tailscale, firewall, and real SSH authentication are unverified.
- Global tool updates have been run only on Windows, last in a live run on October 3, before Wave 1 changed the Update now button and how the Windows desktop finds Node and npm for it, and changed Bun discovery on every platform which Update now rediscovers through; that run was not repeated, so the Windows cell says verified before Wave 1. Any desktop build offers Update now, and the macOS and Linux paths are covered by tests with stand-in package managers.
- Background monitoring after sign-out exists only as the Windows boot task, installed from an elevated PowerShell with `scripts/windows-background.ps1` ([setup](docs/windows-background.md)). Its install, boot, and sign-out lifecycle is unverified. On macOS and Linux the app says it is not available yet.

## Intended coverage

The table below is the intended scope, not shipped support. The platform table above says what exists today and how far it has been verified.

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

## Project documents

- [Project context](CONTEXT.md): scope, terminology, and decisions.
- [Architecture](docs/architecture.md): present structure and planned data flows.
- [Roadmap](docs/roadmap.md): ordered milestones with acceptance criteria.
- [Development](docs/development.md): setup and contribution workflow.
- [Design](docs/design.md): themes, interaction, and information presentation.
- [Security](docs/security.md): trust boundaries, limitations, and implementation requirements.
- [Agent instructions](AGENTS.md): repository working conventions.
