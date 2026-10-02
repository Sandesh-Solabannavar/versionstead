# Development

## Setup

The intended checkout is `D:\production_code\versionstead`. Commands below run from the repository root and use cross-platform package scripts.

1. Install Node.js 24.13.1 or newer within the Node 24 release line; the root `engines` field is authoritative.
2. Install the pnpm version pinned by the root `packageManager` field (`10.14.0` at foundation creation).
3. Run `pnpm install`.
4. Run `pnpm dev` and open `http://127.0.0.1:4317`.

No GitHub/GitLab token, Tailscale setup, database service, or scanner installation is needed for the foundation. Do not add credentials to the repository.

## Commands

| Command              | Purpose                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm dev`           | Run the local coordinator and web development server.                                              |
| `pnpm build`         | Build workspace packages and applications.                                                         |
| `pnpm start`         | Serve the built application locally after `pnpm build`.                                            |
| `pnpm desktop`       | Build and launch the local Electron application.                                                   |
| `pnpm desktop:smoke` | Check Electron startup and its rendered coordinator connection, then exit; run `pnpm build` first. |
| `pnpm typecheck`     | Check TypeScript across the workspace.                                                             |
| `pnpm lint`          | Run the configured linter.                                                                         |
| `pnpm fmt`           | Apply the repository formatter.                                                                    |
| `pnpm fmt:check`     | Verify formatting without rewriting files.                                                         |
| `pnpm test`          | Run the repository’s automated checks.                                                             |
| `pnpm check`         | Run the combined validation commands.                                                              |

The package scripts and lockfile are authoritative for exact tool versions and command details. Commit lockfile changes with dependency changes. For a repeatable installation in CI, use `pnpm install --frozen-lockfile`.

Desktop start and smoke commands invoke `install-electron`, which downloads the pinned runtime if needed. A network connection is required for that first download. `pnpm desktop` runs from the source checkout; it does not create an installer.

Both commands use a shared launcher that clears `ELECTRON_RUN_AS_NODE` before invoking Electron's CLI. The smoke runner deliberately supplies that variable to catch regressions, then waits for the rendered interface to connect to the coordinator.

## Processes and boundaries

In web development, the frontend listens at `http://127.0.0.1:4317` and proxies `/api` to the coordinator at `http://127.0.0.1:4318`. After `pnpm build`, `pnpm start` serves the built web application and API together at `http://127.0.0.1:4318`.

The desktop shell uses a stable `versionstead://app/` renderer origin and forwards its requests to a private coordinator on an available loopback port. Browser development, browser production, and Electron have separate local theme preferences because they have different origins/storage contexts.

The coordinator is not an enrolled-device service yet. Stop the terminal command to end a web session. Closing the final desktop window exits on Windows/Linux; on macOS use Quit to stop the app and its coordinator.

Keep browser code independent of Node APIs. Share schemas and types through `packages/contracts`, not imports into another app’s internals. Keep filesystem access, subprocesses, and future credentials in the server side of the boundary.

## Making a change

Read `CONTEXT.md`, inspect existing patterns, and trace the affected flow. Change the narrowest responsible layer. Update contracts when wire behavior changes and verify both callers and handlers. Use semantic theme tokens for interface changes.

For non-trivial behavior add the smallest meaningful runnable check. Useful future cases include ecosystem version ordering, partial scan preservation, advisory deduplication, notification replay after restart, and unauthorized collector uploads. Avoid tests that merely restate object literals or implementation details.

Run the relevant check while developing, then `pnpm check`. Run `pnpm build` after compilation or startup changes. For UI or desktop changes, also exercise the actual application and report any platform behavior not tested. A successful build does not prove installed-software or vulnerability coverage.

On Windows, the development server, `/api/status` proxy, `pnpm check`, and `pnpm desktop:smoke` were verified on October 2, 2026. The smoke check verifies native Electron startup and the rendered coordinator connection despite inherited `ELECTRON_RUN_AS_NODE`. GitHub Actions defines workspace checks for Windows, Linux, and macOS; it does not run native desktop smoke checks. Native desktop behavior on macOS/Linux, installers, and signing remain unverified. No release has been published.

## Dependency and tool policy

Reuse the pinned stack before introducing a dependency. Registry clients, package-manager commands, and scanner integrations must follow current official documentation for the pinned version. Capture their external behavior with a small realistic fixture or integration check.

Future scanner tools must have an explicit installation/version policy; do not silently download and execute an arbitrary latest binary during a scan. Treat package metadata and repository files as untrusted input.

## Troubleshooting

- A workspace resolution error usually means install or build prerequisites have not completed; use the root scripts rather than running an arbitrary compiled file directly.
- If a port is busy, inspect the terminal error and stop only the known conflicting development process. Do not kill unrelated Node processes.
- If status cannot be reached, inspect the coordinator terminal first. The UI should show a connection problem rather than empty successful data.
- Native desktop behavior must be checked on each target OS before release. Keep an unverified platform claim out of the README.

Packaging, signing, automatic application updates, distribution licensing, and release publishing are deferred until the core workflow is useful.
