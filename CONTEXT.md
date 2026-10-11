# Project context

## Purpose and scope

Versionstead gives its owner a trustworthy view of installed software and project dependencies across personal computers and selected repositories. It should answer: what is installed, what can be updated, what has a known vulnerability, how fresh is the evidence, and what can the owner do next?

The first user is the project owner. Start locally, add explicitly paired computers over LAN or Tailscale, and then broaden platform coverage. Do not introduce accounts, organizations, billing, cloud infrastructure, or enterprise policy management without a concrete requirement.

The local implementation detects npm/Bun and checks their top-level global tools, scans selected npm/pnpm/Bun projects, performs public npm/OSV lookups, and provides SQLite evidence, live scan stages, grouped notification summaries, and an Electron tray client. Lifecycle findings report runtime end of life (endoflife.date) for This PC's Node.js and Bun and each project's declared runtimes, and deprecated packages (npm metadata); update findings carry install-script changes, deprecated candidates and, from deps.dev, release age, license, and provenance, with a release cooldown before Update now. Windows registry and WinGet scanning have been removed. Windows boot-task setup captures owner global roots and grants scoped metadata access; actual LocalService access and boot/sign-out behavior still require elevated installation and lifecycle verification. Routed settings, selected GitHub/GitLab repository scans, connection credentials protected by Windows DPAPI or the macOS/Linux OS keychain, release checks, and pinned HTTPS PC pairing are implemented. Connections groups machine settings and offers a Remote link/SSH dialog, with pairing-link autofill, retained evidence, and per-environment pause/resume. SSH forwards an already-running monitor in an owner session; LAN/Tailscale links support background hosts. Pairing has been exercised between isolated coordinators; physical LAN/Tailscale/firewall and real SSH authentication acceptance remain open. Wider coverage remains on the [roadmap](docs/roadmap.md).

## Domain language

This PC offers explicit desktop updates of verified stable public npm/Bun global packages in any desktop build; Windows hardware (last on October 11) and a Linux container (the npm adapter) have run them; macOS and Linux hardware are unverified. Updates use the observed manager/root and exact selected version, verify installed metadata afterward, and request a fresh PC scan. Update all runs a confirmed list of them one at a time, with one rescan at the end. Installer commands run only in the owner-session Electron process; background scans and paired environments cannot invoke them. PATH discovery includes common Windows CLI install locations, and the usual macOS/Linux install and version-manager directories, as fallbacks. See [Global tool updates](docs/global-tool-updates.md).

Local owner-session update scans prefer bounded installed-manager `outdated` checks, with per-record public-registry fallback. Boot hosts and provider-only repository scans retain file-based checks. Exact lockfile versions continue driving OSV direct/transitive queries independently of update detection. Internal workspace/local links are coverage information; unresolved or unsupported external sources remain unverified. See [Package-manager checks](docs/package-manager-checks.md).

Project settings now includes persistent display names/icons, confirmed removal, and owner-authored commands for local checkouts, launched explicitly through the desktop app (Windows PowerShell or the owner's login shell). The desktop supervises command output/cancellation; the coordinator only stores settings and continues read-only scans. Paired-PC grants do not allow remote settings edits or commands. See [Project settings](docs/project-settings.md).

The settings shell and native title bar provide a native caption overlay, native theme synchronization, searchable settings navigation, and return-to-workspace behavior. Sidebar visibility and normal window bounds/maximized state persist per device. Confirmed Restore device defaults resets UI preferences and shortcuts while retaining monitoring configuration and sources. See [Settings and connections](docs/settings-and-connections.md).

Shared shadcn/Base UI toasts show action feedback, errors, and one count summary for new findings. Review opens the relevant Needs attention filter; a bounded device-local identity history prevents replay across polls and reloads. Native notifications retain their existing delivery receipts. Snooze (7, 30, or 90 days, or until a newer version) and ignore (with a reason) rules hide findings from the attention counts, the sidebar badge, and notifications without hiding incomplete coverage; “Notify about”, watch-only projects, quiet hours, and a daily digest decide what notifies and when. Needs attention and Projects start with every group collapsed, offer Expand all and Collapse all, let browser find open a collapsed group, and retain manual expansion during refresh. The shared V mark appears in web and native app surfaces. Needs attention also offers New since last scan (first detected after the target's previous successful scan) and Resolved (findings a later successful check stopped reporting, kept 30 days, at most 500). Ctrl+K (⌘K) opens a command palette over pages, settings, projects, packages, and actions; Cancel scan stops a running scan before it writes evidence. See [Design and interaction](docs/design.md).

| Term             | Meaning                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Coordinator      | Stores evidence, schedules work, correlates findings, and owns notification decisions.                                         |
| Collector        | Inspects an enrolled machine and selected local project directories.                                                           |
| Device           | A deliberately enrolled computer, with an identity independent of its hostname or IP address.                                  |
| Project          | A selected local directory or remote repository; marked **maintained by me** or **watch only**.                                |
| Installation     | A package or executable at a particular location, from a particular source and channel.                                        |
| Dependency       | A requested or resolved project package, including its ecosystem and origin.                                                   |
| Scan             | A recorded attempt with start/end times, adapter version, coverage, outcome, and errors.                                       |
| Finding          | An actionable conclusion linked to evidence: update, advisory, or lifecycle; version drift is a computed view across projects. |
| Resolved finding | An update, advisory, or lifecycle finding that a later successful check stopped reporting; kept 30 days, at most 500.          |
| Coverage         | What a particular adapter actually inspected, including unsupported or missing inputs.                                         |
| Freshness        | When evidence was last successfully collected, separate from the latest attempted scan.                                        |

## Decisions

- Use TypeScript and pnpm workspaces with React, TanStack Router, Tailwind, and Electron. Shared Effect schemas validate process boundaries.
- Keep transport thin and external commands, registries, and Git hosts behind focused adapters. Introduce abstractions when there are real callers and implementations.
- A single independent Node 24 coordinator and SQLite provide personal-scale persistence. A dedicated SQLite OS lock prevents duplicate writers. No message broker, distributed database, or event-sourced core is needed.
- On Windows, monitoring must start at boot and continue after the app closes and the owner signs out. An independent background host owns the coordinator; the desktop attaches to it. Capture npm/Bun roots in the owner session; never discover the service account's global tools as the owner's. Manager availability/version is last captured in that session; signed-out scans refresh configured package metadata. Verify actual account access and lifecycle before claiming sign-out support. On macOS a LaunchAgent (login to logout) and on Linux a systemd user service (with lingering, also before login and after logout) host the coordinator as the owner; both identify as `boot-task`.
- Begin with read-only monitoring. Installation, dependency restore, scripts, upgrades, commits, and pull requests require separate explicit user actions when implemented.
- Tailscale provides a network route. It does not replace Versionstead pairing, authentication, or revocation.
- Use package-manager identities and ecosystem version rules. Never compare all package versions lexicographically or as generic SemVer.
- Keep requested dependency ranges and resolved versions separately. A manifest alone does not establish the complete installed dependency graph.
- A failed or unsupported check must never produce a reassuring “clean” result. Preserve last-known evidence and label its age.
- Repository ownership does not establish maintenance intent; the owner chooses the project mode.

## Deferred decisions

Decide packaging and update distribution after the desktop workflow works. Windows protects the local coordinator capability and connected-provider/PC credentials with machine-scope DPAPI and filesystem ACLs; macOS and Linux keep those credentials in the OS keychain and the capability in an owner-only file. Other ecosystem adapters require their own fixtures and verification. Choose a distribution license before publishing releases or inviting external contributions.

Keep decisions here short. Implementation detail belongs in code or the relevant document; completed roadmap milestones should link to their implementation rather than duplicate it.
