# Versionstead

A personal, local-first home for software versions, dependency updates, and known vulnerability findings across your computers and projects.

The name combines **version** with **stead**: a home for the software you look after. The initial scope is one person’s machines and repositories.

## Current state

This repository contains the runnable application foundation: a React web interface, a local Node coordinator with a status endpoint, shared validated contracts, and an Electron desktop shell. The interface reports the coordinator’s real status and explicitly shows that no scans have run.

**Inventory scanning, update checks, vulnerability scanning, SQLite persistence, remote collectors, repository connections, and notifications are planned—not implemented.** An empty dashboard is not a security assessment.

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

Useful checks (`pnpm check` includes the build required by the desktop smoke check):

```sh
pnpm check
pnpm desktop:smoke
```

See [development](docs/development.md) for the individual commands and process boundaries.

On Windows, the development server, status proxy, `pnpm check`, and native desktop smoke check were verified on October 2, 2026. The smoke check confirms Electron startup and the rendered coordinator connection, including when `ELECTRON_RUN_AS_NODE` is inherited. Native desktop behavior on macOS/Linux, installers, and signing remain unverified. GitHub Actions defines workspace checks for Windows, Linux, and macOS; these do not include native desktop smoke checks. No release has been published.

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

No distribution license has been selected yet. Naming here is a project choice, not a claim of trademark or package-name availability.
