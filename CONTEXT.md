# Project context

## Purpose and scope

Versionstead gives its owner a trustworthy view of installed software and project dependencies across personal computers and selected repositories. It should answer: what is installed, what can be updated, what has a known vulnerability, how fresh is the evidence, and what can the owner do next?

The first user is the project owner. Start locally, add explicitly paired computers over LAN or Tailscale, and then broaden platform coverage. Do not introduce accounts, organizations, billing, cloud infrastructure, or enterprise policy management without a concrete requirement.

The runnable foundation contains a local coordinator, web UI, desktop shell, and shared contracts. Monitoring features remain on the [roadmap](docs/roadmap.md).

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
- A single coordinator process and SQLite are the planned personal-scale persistence model. No message broker, distributed database, or event-sourced core is needed.
- Begin with read-only monitoring. Installation, dependency restore, scripts, upgrades, commits, and pull requests require separate explicit user actions when implemented.
- Tailscale provides a network route. It does not replace Versionstead pairing, authentication, or revocation.
- Use package-manager identities and ecosystem version rules. Never compare all package versions lexicographically or as generic SemVer.
- Keep requested dependency ranges and resolved versions separately. A manifest alone does not establish the complete installed dependency graph.
- A failed or unsupported check must never produce a reassuring “clean” result. Preserve last-known evidence and label its age.
- Repository ownership does not establish maintenance intent; the owner chooses the project mode.

## Deferred decisions

Decide packaging and update distribution after the desktop workflow works. Decide credential storage before adding credentials. Select vulnerability tooling against real fixtures before claiming ecosystem coverage. Choose a distribution license before publishing releases or inviting external contributions.

Keep decisions here short. Implementation detail belongs in code or the relevant document; completed roadmap milestones should link to their implementation rather than duplicate it.
