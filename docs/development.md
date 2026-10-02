# Development

## Setup

The intended checkout is `D:\production_code\versionstead`. Commands below run from the repository root and use cross-platform package scripts.

1. Install Node.js 24.13.1 or newer within the Node 24 release line; the root `engines` field is authoritative.
2. Install the pnpm version pinned by the root `packageManager` field (`10.14.0` at foundation creation).
3. Run `pnpm install`.
4. Run `pnpm dev` and open `http://127.0.0.1:4317`.

No GitHub/GitLab token, Tailscale setup, database service, or external scanner installation is needed. SQLite is built into Node 24. Public npm/OSV checks need internet access; offline failures retain evidence and remain explicit. Do not add credentials to the repository.

## Commands

| Command              | Purpose                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm dev`           | Run the local coordinator and web development server.                                       |
| `pnpm build`         | Build workspace packages and applications.                                                  |
| `pnpm start`         | Serve the built application locally after `pnpm build`.                                     |
| `pnpm desktop`       | Build and launch the local Electron application.                                            |
| `pnpm run access`    | Deliberately display the running coordinator’s private browser session code.                |
| `pnpm desktop:smoke` | Check tray/reconnection, real scans, and independent coordinator lifetime in isolated data. |
| `pnpm typecheck`     | Check TypeScript across the workspace.                                                      |
| `pnpm lint`          | Run the configured linter.                                                                  |
| `pnpm fmt`           | Apply the repository formatter.                                                             |
| `pnpm fmt:check`     | Verify formatting without rewriting files.                                                  |
| `pnpm test`          | Run the repository’s automated checks.                                                      |
| `pnpm check`         | Run the combined validation commands.                                                       |

The package scripts and lockfile are authoritative for exact tool versions and command details. Commit lockfile changes with dependency changes. For a repeatable installation in CI, use `pnpm install --frozen-lockfile`.

Desktop start and smoke commands invoke `install-electron`, which downloads the pinned runtime if needed. A network connection is required for that first download. `pnpm desktop` runs from the source checkout; it does not create an installer.

Both commands use a shared launcher that clears `ELECTRON_RUN_AS_NODE` before invoking Electron's CLI. The smoke runner deliberately supplies that variable to catch regressions, then waits for the rendered interface to connect to the coordinator.

After changing desktop code, choose **Quit Versionstead UI** from the tray and run `pnpm desktop` again; closing the window or launching a second instance keeps the resident UI. On startup, the rebuilt desktop automatically replaces a legacy interactive session coordinator missing live scan progress or the `npm-bun-global-v1` collector marker. It first checks Node 24 and the built files, then requests authenticated graceful shutdown and starts the current coordinator against the same saved database. Compatible coordinators are reused. For other server changes, rebuild and choose **Restart monitoring** from the tray. Restart interrupts any active scan; last successful evidence remains saved. Boot/background hosts are never replaced with a session process: rebuild and use elevated `scripts/windows-background.ps1 -Action Restart` before reconnecting. The interface identifies an older host and disables PC scans until it supports global tools.

## Processes and boundaries

In web development, the frontend listens at `http://127.0.0.1:4317` and proxies `/api` to the coordinator at `http://127.0.0.1:4318`. After `pnpm build`, `pnpm start` serves the built web application and API together at `http://127.0.0.1:4318`.

The desktop shell uses a stable `versionstead://app/` renderer origin and forwards its requests to a private coordinator on an available loopback port. Browser development, browser production, and Electron have separate local theme preferences because they have different origins/storage contexts.

Electron discovers an existing coordinator through a private runtime descriptor or starts a detached Node 24 coordinator. Closing its window hides to the tray; quitting the UI leaves the coordinator running. Restart monitoring and Stop monitoring are explicit tray actions; restart is available for interactive session hosts. Web terminal SIGINT/SIGTERM stops its owned coordinator gracefully. A dedicated SQLite OS lock prevents two coordinators using the same data directory.

Browser access requires `pnpm run access` in a separate terminal, then the displayed code in the connection form. Electron’s native protocol forwards authenticated requests without exposing the capability to renderer JavaScript. Development permits only the explicit `http://127.0.0.1:4317` origin; use that URL. Only one host should own a data directory. Stop an existing desktop/boot coordinator before using `pnpm dev`, or set a separate absolute `VERSIONSTEAD_DATA_DIR` for development. Desktop coordinator startup requires an installed Node 24 executable; set `VERSIONSTEAD_NODE_EXECUTABLE` to its absolute path when necessary.

Data defaults to `%LOCALAPPDATA%\\Versionstead` (non-Windows: `~/.local/share/Versionstead`). It contains `monitoring.sqlite`, its WAL files, a dedicated coordinator lock database, and the private runtime descriptor. Stop monitoring before copying the complete directory as a backup; keep backups private. Removing a selected project removes its current dependency evidence and findings; bounded attempt history may retain its display label. No project files are deleted. See [Windows background setup](windows-background.md) for boot/sign-out hosting and ACLs.

This PC detects npm and Bun independently and reads their top-level global package manifests. Detection commands are bounded, read-only, and run outside selected projects; scans do not execute installed global tools or lifecycle scripts, install packages, or perform upgrades. Only verified public-registry identities with supported stable versions receive public npm upgrade checks. Private, linked, unknown-source, prerelease, malformed, or inaccessible packages remain unverified. npm and Bun installations of the same tool retain separate source/root identities. A missing PATH launcher does not establish removal of an existing global location.

Bun detection invokes only its version command. The scanner derives the exact global directory from supported configuration/environment settings, with `BUN_INSTALL_GLOBAL_DIR` taking precedence over explicit `globalDir`, followed by `BUN_INSTALL` and the cache/home default. It reads that location's manifest and installed packages directly. It does not use `bun pm ls --global`, create the global directory, or fall back to an ancestor project's manifest when the global directory is empty.

Interactive PC scans rediscover the owner's manager versions, global locations, and registry configuration. When Electron attaches to a compatible boot host, it discovers those sources in the owner session and submits them through the authenticated, validated `/api/global-tools/sources` boundary. The boot host reads saved owner locations rather than treating LocalService's PATH/profile as the owner's installation. The Windows setup script captures the same source metadata during Install. After changing a prefix/location, repeat Install as documented to grant access to the new global root; Start and Restart reuse saved owner sources. Elevation as another Windows account reuses the original owner's validated saved configuration instead of discovering the administrator's tools. Discovery or access failures retain earlier evidence. Source changes are rejected while a PC scan is active or queued; reopen the desktop after that work finishes if source synchronization could not complete.

Each manager's `checkedAt` describes the owner-session capture of its version and registry configuration. A background read of installed manifests does not refresh that timestamp or prove the manager executable is still installed. Inventory and upgrade evidence have their own attempt/success times, which describe those scans separately.

Keep browser code independent of Node APIs and share its schemas/types through `packages/contracts`. The native desktop reuses the server's bounded runtime discovery and global-source adapter; executable discovery and filesystem reads never run in the renderer. Keep subprocesses and future credentials on the native/server side of the boundary.

## Making a change

Read `CONTEXT.md`, inspect existing patterns, and trace the affected flow. Change the narrowest responsible layer. Update contracts when wire behavior changes and verify both callers and handlers. Use semantic theme tokens for interface changes.

For non-trivial behavior add the smallest meaningful runnable check. Useful future cases include ecosystem version ordering, partial scan preservation, advisory deduplication, notification replay after restart, and unauthorized collector uploads. Avoid tests that merely restate object literals or implementation details.

Run the relevant check while developing, then `pnpm check`. Run `pnpm build` after compilation or startup changes. For UI or desktop changes, also exercise the actual application and report any platform behavior not tested. A successful build does not prove installed-software or vulnerability coverage.

Verification on October 3, 2026 includes global inventory/parser coverage, lookup, persistence, grouped notification/receipt, scheduling, live progress, HTTP authentication, and Windows DPAPI/single-writer checks. The corrected read-only owner probe captured npm 11.7.0 and Bun 1.4.0 with public registry configuration. It collected 30 npm global tools with 23 available upgrades and seven current stable versions. No Bun tools were collected: its actual global location lacks the required direct-dependency manifest, so Bun inventory is unavailable rather than verified empty. Two coverage errors remain explicit: one npm observation has malformed, inaccessible, or outside-root metadata, and Bun's global package metadata cannot be established. The result is partial and makes no completeness guarantee. Windows registry and WinGet collection have been removed from This PC.

The October 2, 2026 project probe of the Versionstead pnpm workspace yielded 288 dependency records across five importers. Public checks queried all 284 eligible records through OSV, excluded four workspace identities, checked 19 direct dependency records for versions, and returned one update candidate with zero advisory matches and no lookup errors. This historical project observation is unchanged by the global-tool replacement; it is not a completeness or safety guarantee.

The October 3 `pnpm check` passes formatting, linting, strict type checking, workspace builds, and 43 regressions: 38 server, one desktop, and four web checks. Lookup regressions verify all 105 unique eligible direct project names and 125 global-tool names, all 55 advisory details, at most four parallel requests, isolated failures, continued OSV batches after a failed batch, actual full-count progress, cancellation, and a simulated scan beyond the former 90-second ceiling. Failed HTTP response bodies are canceled before subsequent checks. Global-tool regressions also cover installed versions, direct Bun packages, exact global directories, private/local exclusions, unsupported metadata, absent managers, root changes, and saved-evidence migration. The desktop regression exercises authenticated legacy-session replacement against real HTTP and SQLite, retained settings/projects/evidence, failed startup preflight, delayed writer-lock release, compatible-session reuse, simultaneous restart requests, and background-host protection. It also verifies that a previous PC collector with live progress is replaced and that owner-source synchronization retains the boot host's PID/mode and selected projects. An October 2 current-owner legacy-session replacement preserved its project, settings, evidence, and history.

The October 3 full-lookup revision was loaded by gracefully restarting the idle owner session coordinator. Device identity, settings, selected projects, inventory, and all ten existing history records were retained. Its selected T3 Code project then checked all 185 unique eligible direct package names across 272 direct dependency records and queried all 2,173 eligible resolved records through OSV, with zero version failures or unattempted direct records. The scan took about 30 seconds and no package-count or advisory-detail cutoff warning remained. The project correctly retains a partial outcome because one manifest dependency differs from its pnpm importer specifier and 33 workspace/local/Git/private/unresolved records cannot receive public-registry checks. No project files were changed. The new coordinator remains running, with eleven history records. The native Electron smoke also passed against this build.

The final October 3 native Electron smoke passes authenticated rendered data, the narrow folder-picker bridge, first PC scan prompt, updates-only default and All global tools filtering, independent npm/Bun status cards and manager filtering, blank unverified cells, real scan progress, summary destination filtering, Pause/Resume controls, centered dialogs with Escape and restored focus, close-to-tray/reopen, UI exit with a still-live independent coordinator, real global-tool/project scan attempts, second-launch reuse of the same PID and saved project, and graceful cleanup of isolated state. It deliberately inherits `ELECTRON_RUN_AS_NODE` to exercise the shared launcher. Notifications are suppressed during smoke: coordinator tests verify summary counts/receipts/cooldown, while native smoke verifies the destination, not Windows toast presentation. Fresh native captures in `%TEMP%\versionstead-global-verification-20261003-final` cover the corrected global-tool interface, light/dark themes, and contained scrolling at 1440 px and 390 px widths.

The October 3 shadcn revision additionally passes grouped project expansion with native Enter input, All projects/All dependencies access, Base UI selectors, 36 px theme buttons with an 8 px gap, and evidence Sheet focus containment, Escape, and package-trigger focus restoration. The PC evidence sheet now resolves its selected installation ID against the latest snapshot, avoiding old details paired with refreshed evidence. Grouping regressions cover incomplete-only targets, failed update checks, stable same-name project IDs, importer/version/source identity, notification URL filters, and intentional transitive exclusions. Fresh native captures in `%TEMP%\versionstead-shadcn-verification-20261003` cover the production light/dark design and contained project-table scrolling at 1440 px and 390 px widths. These UI checks do not verify LocalService, boot/sign-out hosting, or Windows toast delivery.

An October 3 current-owner session coordinator was gracefully upgraded from the previous Windows collector to `npm-bun-global-v1`. The device identity, settings, selected project, and all five existing history records were retained; obsolete active Windows PC evidence was reset. A pre-acceptance probe using Bun's misleading global-list header was rejected during verification. With monitoring stopped and its exclusive writer lock held, only those five invalid Bun parent-project observations and their pending findings were removed; valid npm evidence, settings, the selected project, and all six then-existing history records were preserved. The corrected coordinator was restarted and its real scan recorded 30 tools and 23 upgrades with the two explicit metadata limitations. It remains running; history now includes seven attempts.

A background-mode probe under the owner account, with PATH deliberately empty, read the same captured roots and collected the same 30 verified tools without changing manager-capture timestamps. This checks independence from service-account discovery; it is not a LocalService or sign-out test.

Read-only Windows boot-script parsing and saved-source checks pass under Windows PowerShell 5.1 and PowerShell 7. Owner-source capture also passes without changing ACLs or registering/stopping a task. No boot host was installed during implementation.

GitHub Actions defines workspace checks for Windows, Linux, and macOS; it does not run native desktop smoke checks. LocalService installation/access, boot-before-login, sign-out monitoring, automatic tray startup at login, native macOS/Linux behavior, installers, and signing remain unverified or unimplemented. No release has been published.

## Dependency and tool policy

Reuse the pinned stack before introducing a dependency. Registry clients, package-manager commands, and scanner integrations must follow current official documentation for the pinned version. Capture their external behavior with a small realistic fixture or integration check.

Future scanner tools must have an explicit installation/version policy; do not silently download and execute an arbitrary latest binary during a scan. Treat package metadata and repository files as untrusted input.

## Troubleshooting

- A workspace resolution error usually means install or build prerequisites have not completed; use the root scripts rather than running an arbitrary compiled file directly.
- If a port is busy, inspect the terminal error and stop only the known conflicting development process. Do not kill unrelated Node processes.
- If status cannot be reached, inspect the coordinator terminal first. The UI should show a connection problem rather than empty successful data.
- Native desktop behavior must be checked on each target OS before release. Keep an unverified platform claim out of the README.

Packaging, signing, automatic application updates, distribution licensing, and release publishing are deferred until the core workflow is useful.
