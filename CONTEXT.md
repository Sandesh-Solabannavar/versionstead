# Project context

## Purpose and scope

Versionstead gives its owner a trustworthy view of installed software and project dependencies across personal computers and selected repositories. It should answer: what is installed, what can be updated, what has a known vulnerability, how fresh is the evidence, and what can the owner do next?

The first user is the project owner. Start locally, add explicitly paired computers over LAN or Tailscale, and then broaden platform coverage. Do not introduce accounts, organizations, billing, cloud infrastructure, or enterprise policy management without a concrete requirement.

The local implementation detects npm/Bun and checks their top-level global tools, scans selected npm/pnpm projects, performs public npm/OSV lookups, and provides SQLite evidence, live scan stages, grouped notification summaries, and an Electron tray client. Windows registry and WinGet scanning have been removed. Windows boot-task setup captures owner global roots and grants scoped metadata access; actual LocalService access and boot/sign-out behavior still require elevated installation and lifecycle verification. Wider coverage remains on the [roadmap](docs/roadmap.md).

## Domain language

| Term         | Meaning                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Coordinator  | Stores evidence, schedules work, correlates findings, and owns notification decisions.          |
| Collector    | Inspects an enrolled machine and selected local project directories.                            |
| Device       | A deliberately enrolled computer, with an identity independent of its hostname or IP address.   |
| Project      | A selected local directory or remote repository; marked **maintained by me** or **watch only**. |
| Installation | A package or executable at a particular location, from a particular source and channel.         |
| Dependency   | A requested or resolved project package, including its ecosystem and origin.                    |
| Scan         | A recorded attempt with start/end times, adapter version, coverage, outcome, and errors.        |
| Finding      | An actionable conclusion linked to evidence: update, advisory, lifecycle, or version drift.     |
| Coverage     | What a particular adapter actually inspected, including unsupported or missing inputs.          |
| Freshness    | When evidence was last successfully collected, separate from the latest attempted scan.         |

## Decisions

- Use TypeScript and pnpm workspaces; React, TanStack Router, Tailwind, and Electron reflect the T3 Code reference. Shared Effect schemas validate process boundaries.
- Keep transport thin and external commands, registries, and Git hosts behind focused adapters. Introduce abstractions when there are real callers and implementations.
- A single independent Node 24 coordinator and SQLite provide personal-scale persistence. A dedicated SQLite OS lock prevents duplicate writers. No message broker, distributed database, or event-sourced core is needed.
- On Windows, monitoring must start at boot and continue after the app closes and the owner signs out. An independent background host owns the coordinator; the desktop attaches to it. Capture npm/Bun roots in the owner session; never discover the service account's global tools as the owner's. Manager availability/version is last captured in that session; signed-out scans refresh configured package metadata. Verify actual account access and lifecycle before claiming sign-out support.
- Begin with read-only monitoring. Installation, dependency restore, scripts, upgrades, commits, and pull requests require separate explicit user actions when implemented.
- Tailscale provides a network route. It does not replace Versionstead pairing, authentication, or revocation.
- Use package-manager identities and ecosystem version rules. Never compare all package versions lexicographically or as generic SemVer.
- Keep requested dependency ranges and resolved versions separately. A manifest alone does not establish the complete installed dependency graph.
- A failed or unsupported check must never produce a reassuring “clean” result. Preserve last-known evidence and label its age.
- Repository ownership does not establish maintenance intent; the owner chooses the project mode.

## Deferred decisions

Decide packaging and update distribution after the desktop workflow works. Windows protects the local coordinator capability with machine-scope DPAPI and filesystem ACLs; external credentials remain unimplemented. Other ecosystem adapters require their own fixtures and verification. Choose a distribution license before publishing releases or inviting external contributions.

Keep decisions here short. Implementation detail belongs in code or the relevant document; completed roadmap milestones should link to their implementation rather than duplicate it.
