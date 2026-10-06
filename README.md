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

## Project documents

- [Project context](CONTEXT.md): scope, terminology, and decisions.
- [Architecture](docs/architecture.md): present structure and planned data flows.
- [Roadmap](docs/roadmap.md): ordered milestones with acceptance criteria.
- [Development](docs/development.md): setup and contribution workflow.
- [Design](docs/design.md): themes, interaction, and information presentation.
- [Security](docs/security.md): trust boundaries, limitations, and implementation requirements.
- [Agent instructions](AGENTS.md): repository working conventions.
