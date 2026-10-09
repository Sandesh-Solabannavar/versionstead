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

See [Windows background setup and verification](docs/windows-background.md) and the [macOS and Linux background host](docs/background-host.md). The [implementation plan](docs/monitoring-implementation.md) records the accepted workflow and remaining acceptance gates. The mockup design has been absorbed into the real React application.

Verification results and limitations are recorded in [development](docs/development.md). Installers and signing are not ready, and no release has been published.

## Platform support

Windows is the only platform with hardware verification. Each cell says how far a capability has been checked on that platform:

- **Verified on Windows hardware**: exercised on the owner’s Windows 11 PC.
- **Verified in a Linux container (automated)**: automated tests pass in a `node:24-bookworm` container, not on Linux hardware.
- **Verified in macOS CI (automated, commit e4e3a53)**: the GitHub Actions `macos-latest` job passed the automated tests at that commit, using a temporary keychain; not on Mac hardware, and not repeated on the final commit.
- **Implemented, unverified on hardware**: the code and platform-injected tests exist, but that platform’s hardware has not run it.

| Capability                       | Windows                                                                            | macOS                                                                                                                                                          | Linux                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop app launch               | Verified on Windows hardware                                                       | Implemented, unverified on hardware                                                                                                                            | Implemented, unverified on hardware                                                                                                                                                           |
| This PC npm/Bun inventory        | Verified on Windows hardware                                                       | Verified in macOS CI (automated, commit e4e3a53; no real Bun)                                                                                                  | Verified in a Linux container (automated; no real Bun)                                                                                                                                        |
| Local projects (npm, pnpm, Bun)  | Verified on Windows hardware                                                       | Verified in macOS CI (automated, commit e4e3a53; no real Bun)                                                                                                  | Verified in a Linux container (automated; no real Bun)                                                                                                                                        |
| GitHub/GitLab repositories       | Verified on Windows hardware (GitHub live October 3; GitLab: controlled responses) | Verified in macOS CI (automated, commit e4e3a53; controlled responses, temporary keychain); later fixes not yet run on macOS                                   | Verified in a Linux container (automated; controlled responses, GNOME Keyring)                                                                                                                |
| Paired PCs (LAN, Tailscale, SSH) | Verified on Windows hardware, isolated coordinators only                           | Verified in macOS CI (automated, commit e4e3a53; isolated coordinators); later fixes not yet run on macOS                                                      | Verified in a Linux container (automated; isolated coordinators, GNOME Keyring)                                                                                                               |
| Custom project commands          | Verified on Windows hardware                                                       | Verified in macOS CI (automated runner tests, commit e4e3a53); later fixes not yet run on macOS                                                                | Verified in a Linux container (automated runner tests)                                                                                                                                        |
| Global tool updates              | Verified before Wave 1 (Oct 3); not re-run                                         | Implemented, unverified on hardware                                                                                                                            | Verified in a Linux container (automated; npm update adapter, disposable prefix)                                                                                                              |
| Background monitoring            | Windows boot task (after sign-out): manual elevated setup, lifecycle unverified    | LaunchAgent, login to logout: generated file and stand-in `launchctl` flows verified in macOS CI (automated, commit e4e3a53); loading it in launchd unverified | systemd user service: verified in a Linux container with a real systemd user manager (automated; Debian 12, systemd 252 as PID 1, privileged); lingering across reboot unverified on hardware |
| Open at login                    | Implemented, unverified on hardware                                                | Implemented, unverified on hardware                                                                                                                            | Implemented, unverified on hardware                                                                                                                                                           |

- The desktop app runs from source with `pnpm desktop`; there are no installers and nothing is signed. On Ubuntu 24.04 and newer, Electron also needs its sandbox helper set up, as [development](docs/development.md) describes. The native desktop check (`pnpm desktop:smoke`) is recorded as passing on Windows only.
- Connection credentials use Windows DPAPI, the macOS login keychain, or the Linux Secret Service through `secret-tool` (tested with GNOME Keyring; KWallet’s Secret Service is untested). Where the keychain is missing or locked the app says what to install or unlock; nothing falls back to weaker storage.
- Paired PCs were exercised between isolated coordinators on one machine; physical LAN, Tailscale, firewall, and real SSH authentication are unverified on every platform.
- Background monitoring: Windows uses the boot task from an elevated `scripts/windows-background.ps1`; macOS a LaunchAgent and Linux a systemd user service from `scripts/background-host.mjs` ([background host](docs/background-host.md)). The macOS host runs from login to logout; the Linux host runs before login and after logout only with lingering, and keyring credentials stay locked until you log in.
- Still Windows-only tests, and why: the Windows tool-candidate test (it needs Windows drive-letter path semantics), the PowerShell project-runner tests (POSIX equivalents run instead), the legacy PFX host test (only Windows PowerShell can create that certificate), the data-directory ACL, data-folder message, and real Constrained Language Mode tests (Windows security features), and the native desktop smoke (not run on macOS or Linux).
- Limits of these checks: the Linux container runs the coordinator, desktop-module, and web tests, not a running desktop window, and it has no real Bun, so Bun and version-manager shim detection there ran against stand-ins. GitHub Actions defines `pnpm check` for Windows, Linux, and macOS on pull requests and pushes to `main`, plus Linux keyring and systemd user-service steps, and never runs the native desktop smoke check; its one run on this branch, on commit e4e3a53, passed on all three systems before those Linux steps existed, and the final commit has no CI result yet ([Wave 2 verification](docs/development.md#wave-2-verification-october-9-2026)). The live GitHub scan and the live global-tool update ran on Windows on October 3, before [Wave 1](docs/development.md#wave-1-verification-october-8-2026) changed the Update now button, how the Windows desktop finds Node and npm for it, and Bun discovery on every platform; neither was repeated, and GitLab was exercised only against controlled responses.

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
