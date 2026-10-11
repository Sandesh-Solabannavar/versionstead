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
- **Verified in macOS CI (automated, commit 0c12bc3)**: the GitHub Actions `macos-latest` job passed the automated tests at that commit, with Waves 1 to 4 complete, using a temporary keychain; not on Mac hardware.
- **Implemented, unverified on hardware**: the code and platform-injected tests exist, but that platform’s hardware has not run it.

| Capability                                                        | Windows                                                                                                                                                                                                                       | macOS                                                                                                                                                          | Linux                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop app launch                                                | Verified on Windows hardware                                                                                                                                                                                                  | Implemented, unverified on hardware                                                                                                                            | Implemented, unverified on hardware                                                                                                                                                           |
| This PC npm/Bun inventory                                         | Verified on Windows hardware                                                                                                                                                                                                  | Verified in macOS CI (automated, commit 0c12bc3; no real Bun)                                                                                                  | Verified in a Linux container (automated; no real Bun)                                                                                                                                        |
| Local projects (npm, pnpm, Bun)                                   | Verified on Windows hardware                                                                                                                                                                                                  | Verified in macOS CI (automated, commit 0c12bc3; no real Bun)                                                                                                  | Verified in a Linux container (automated; no real Bun)                                                                                                                                        |
| Lifecycle and supply-chain signals                                | Verified on Windows hardware (isolated live scan October 10)                                                                                                                                                                  | Verified in macOS CI (automated, commit 0c12bc3; controlled responses)                                                                                         | Verified in a Linux container (automated; controlled responses)                                                                                                                               |
| Snooze, notification rules, quiet hours, daily digest             | Verified on Windows hardware for quiet hours, the daily digest and a 7-day snooze (isolated live check October 11); Notify about, watch-only routing, Ignore, Snooze until a newer version and rule expiry by automated tests | Verified in macOS CI (automated, commit 0c12bc3)                                                                                                               | Verified in a Linux container (automated)                                                                                                                                                     |
| GitHub/GitLab repositories                                        | Verified on Windows hardware (GitHub live October 3; GitLab: controlled responses)                                                                                                                                            | Verified in macOS CI (automated, commit 0c12bc3; controlled responses, temporary keychain)                                                                     | Verified in a Linux container (automated; controlled responses, GNOME Keyring)                                                                                                                |
| Paired PCs (LAN, Tailscale, SSH)                                  | Verified on Windows hardware, isolated coordinators only                                                                                                                                                                      | Verified in macOS CI (automated, commit 0c12bc3; isolated coordinators)                                                                                        | Verified in a Linux container (automated; isolated coordinators, GNOME Keyring)                                                                                                               |
| Custom project commands                                           | Verified on Windows hardware                                                                                                                                                                                                  | Verified in macOS CI (automated runner tests, commit 0c12bc3)                                                                                                  | Verified in a Linux container (automated runner tests)                                                                                                                                        |
| Global tool updates                                               | Verified on Windows hardware (live smoke October 11, one disposable package each: npm through Update now, Bun through Update all)                                                                                             | Verified in macOS CI (automated runner tests, commit 0c12bc3)                                                                                                  | Verified in a Linux container (automated; npm update adapter, disposable prefix)                                                                                                              |
| Commands, exports, version drift                                  | Verified on Windows hardware (isolated live check October 11; the CSV was parsed by a script, not opened in a spreadsheet)                                                                                                    | Verified in macOS CI (automated, commit 0c12bc3; unit tests, no rendered UI)                                                                                   | Verified in a Linux container (automated; unit tests, no rendered UI)                                                                                                                         |
| Command palette, scan cancel and retry, new and resolved findings | Verified on Windows hardware (isolated live check October 11; keys and clicks were sent to the window by script, and typing with an IME was not tried)                                                                        | Verified in macOS CI (automated, commit 0c12bc3; unit tests, no rendered UI)                                                                                   | Verified in a Linux container (automated; unit tests, no rendered UI)                                                                                                                         |
| Background monitoring                                             | Windows boot task (after sign-out): manual elevated setup, lifecycle unverified                                                                                                                                               | LaunchAgent, login to logout: generated file and stand-in `launchctl` flows verified in macOS CI (automated, commit 0c12bc3); loading it in launchd unverified | systemd user service: verified in a Linux container with a real systemd user manager (automated; Debian 12, systemd 252 as PID 1, privileged); lingering across reboot unverified on hardware |
| Open at login                                                     | Implemented, unverified on hardware                                                                                                                                                                                           | Implemented, unverified on hardware                                                                                                                            | Implemented, unverified on hardware                                                                                                                                                           |

- The desktop app runs from source with `pnpm desktop`; there are no installers and nothing is signed. On Ubuntu 24.04 and newer, Electron also needs its sandbox helper set up, as [development](docs/development.md) describes. The native desktop check (`pnpm desktop:smoke`) is recorded as passing on Windows only.
- Connection credentials use Windows DPAPI, the macOS login keychain, or the Linux Secret Service through `secret-tool` (tested with GNOME Keyring; KWallet’s Secret Service is untested). Where the keychain is missing or locked the app says what to install or unlock; nothing falls back to weaker storage.
- Paired PCs were exercised between isolated coordinators on one machine; physical LAN, Tailscale, firewall, and real SSH authentication are unverified on every platform.
- Background monitoring: Windows uses the boot task from an elevated `scripts/windows-background.ps1`; macOS a LaunchAgent and Linux a systemd user service from `scripts/background-host.mjs` ([background host](docs/background-host.md)). The macOS host runs from login to logout; the Linux host runs before login and after logout only with lingering, and keyring credentials stay locked until you log in.
- Still Windows-only tests, and why: the Windows tool-candidate test (it needs Windows drive-letter path semantics), the PowerShell project-runner tests (POSIX equivalents run instead), the legacy PFX host test (only Windows PowerShell can create that certificate), the data-directory ACL, data-folder message, and real Constrained Language Mode tests (Windows security features), and the native desktop smoke (not run on macOS or Linux).
- Limits of these checks: the Linux container runs the coordinator, desktop-module, and web tests, not a running desktop window, and it has no real Bun, so Bun and version-manager shim detection there ran against stand-ins. GitHub Actions defines `pnpm check` for Windows, Linux, and macOS on pull requests and pushes to `main`, plus Linux keyring and systemd user-service steps, and never runs the native desktop smoke check; on commit 0c12bc3, with Waves 1 to 4 complete, all three systems and both Linux steps passed ([CI on the final commit](docs/development.md#ci-on-the-final-commit-october-11-2026)). The live GitHub scan and the live global-tool update ran on Windows on October 3, before [Wave 1](docs/development.md#wave-1-verification-october-8-2026) changed the Update now button, how the Windows desktop finds Node and npm for it, and Bun discovery on every platform; the scan was not repeated, the update was on October 11 (the Global tool updates row), and GitLab was exercised only against controlled responses.
- Lifecycle and supply-chain signals are lookups of public data: runtime end of life from endoflife.date, deprecation and install-script flags from npm metadata, and release age, license, and provenance from deps.dev (optional in Settings › General). Each finding names its source and check time; missing data is reported as unknown, never as safe. Update now asks first only when an update adds an install script, is younger than the release cooldown (three days by default), or its new version is deprecated; that question was exercised with a stand-in bridge, not by a live update. Paired PCs older than this build keep receiving evidence they can read, without these findings.
- Snoozed and ignored findings leave the Needs attention counts, the Projects summary, the sidebar badge and notifications (each project still lists them) but never change a target’s Partial or Failed status. Quiet hours delay only native desktop notifications: the in-app summary still appears, the summary keeps taking in new findings while it waits, and the first native notification after the window covers all of them. Linux and macOS desktop notification behavior has not been checked on hardware.
- Update all runs the same updates of verified stable public-registry packages as Update now, one at a time, only in the desktop app, from a list you confirm. Its live check is narrow: on October 11 it updated one Bun package in a disposable global root on Windows, and `pnpm desktop:smoke` opens it on this PC’s real tools and declines it when verified updates exist. Several packages in order, a failed package skipping the rest of its location, Stop, and quitting during a run have run only against stand-in installers, and macOS and Linux hardware are unverified.
- Upgrade commands and drift align commands are copy-only text, and Upgrade commands leave out, and count, packages the owner snoozed or ignored and releases with a known date still inside the release cooldown, and exports are built in the window from the evidence it holds, always with each target’s scan times, coverage, and incomplete checks; none of them runs anything in a project folder. Markdown is escaped, not inert: GitHub may still link bare web addresses and turn names that start with @, such as scoped packages, into mentions. CSV cells that start like a formula get a leading apostrophe, and tabs, carriage returns, and line breaks become spaces. JSON keeps only https advisory addresses and writes hidden characters as escapes. Local folder paths, global tool locations, and this PC’s name are left out of every format; project and package names are not. The Windows check covered commands for two projects, an export of This PC and all projects in the three formats, and drift between those two projects; it did not see npm and Bun copies of one global tool, and Copy, which uses the browser clipboard, has been checked on Windows only.
- The command palette (Ctrl+K, ⌘K on macOS) jumps to pages, settings, projects, and packages and runs scans, pause, Add project, Export, Cancel scan, and Retry failed checks. Cancel scan stops the running scan before it writes anything and keeps the evidence it had; Retry failed checks rescans every target whose last attempt failed or left gaps. Needs attention’s New since last scan compares each finding with its target’s previous successful scan, and Resolved lists what later successful checks stopped reporting during the last 30 days (at most 500). The Windows check used the palette to reach a page, a setting, a project, a project package, and a global tool, to pause and resume schedules, to open Add project and Export, and to scan and cancel a project; it cancelled a This PC scan from its progress card; it retried a Failed project together with This PC, which was Partial (a project whose lockfile is missing reads Unsupported, which Retry failed checks does not rescan); and it listed New since last scan and Resolved for a throwaway project. Typing with a Japanese or Chinese input method editor is implemented, because keys pressed during composition stay with the composition, but has not been tried on any platform, and no screen reader was run. The moment Cancel scan goes away when a scan starts saving, the 30-day and 500-entry limits of Resolved, and macOS and Linux desktop behavior were not observed.

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
