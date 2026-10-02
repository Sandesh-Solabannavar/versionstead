# Working in Versionstead

Read `CONTEXT.md` and the relevant document under `docs/` before changing behavior. `README.md` describes the shipped state; `docs/roadmap.md` describes planned work. Keep this distinction accurate.

## Discovery and changes

- Prefer codebase-memory-mcp tools for code discovery. Run `index_repository` if the repository is not indexed, then use `search_graph`, `trace_path`, `get_code_snippet`, `query_graph`, or `search_code` as appropriate. Fall back to `rg` for literals/configuration/non-code or when graph tools are unavailable or insufficient.
- Trace callers and the full affected flow before changing a shared function. Fix the common cause rather than adding guards to individual callers.
- Reuse existing code, standard-library features, native platform features, and installed dependencies before adding another dependency or abstraction.
- Make the smallest complete change. Avoid empty packages, speculative interfaces, service scaffolding, and configuration without a real use.
- Use official documentation to verify third-party APIs and version-specific behavior. Follow the versions pinned in this repository.

## Architecture and style

- `packages/contracts` owns wire schemas and shared domain types; validate incoming data at every process or network boundary.
- HTTP handlers validate input, invoke focused services, and translate errors. Keep package-manager and registry details in adapters as those features arrive.
- Use Effect for the existing typed service/schema boundaries; do not convert simple pure calculations into unnecessary service layers.
- Preserve source identity, version/channel, coverage, timestamps, and errors. A missing result is not evidence of safety.
- Keep UI components accessible and style them using semantic theme tokens and component variants. Avoid incidental page-specific colors or inline interaction logic that belongs in a component.
- Follow the formatter, linter, and TypeScript configuration. Do not weaken checks to make a change pass.
- Annotate a deliberate limitation only when it cuts a real corner: `ponytail: <current ceiling>; <upgrade condition>`.

## Safety and validation

- Background scans must not install packages, restore dependencies, execute repository scripts, or upgrade software.
- Do not expose the coordinator beyond loopback until device authentication, TLS, enrollment, and revocation exist.
- Use argument arrays for subprocesses, constrained executables, timeouts, bounded output, and validated paths. Never interpolate project metadata into shell commands.
- Keep credentials, source content, lockfile contents, and full local paths out of routine logs. Introduce OS-backed secret storage before credential features ship.
- Non-trivial logic needs a small runnable regression check that would fail if the behavior breaks. Prefer the current test tooling; avoid framework additions for simple checks.
- Run the checks relevant to the change and `pnpm check` before reporting completion. Build after changing compilation, bundling, or process startup. State checks that could not run.
- Update the shipped-state documentation when adding or removing capabilities. Never claim a scan, integration, or platform is supported without a verified implementation.

## Session conventions

<!-- BEGIN @agent-native/skills -->

When writing final response status indicators, use the /quick-recap skill always.
When long-running or parallel work needs usage-limit checks, use the /stay-within-limits skill always.
<!-- END @agent-native/skills -->

Use those skills when available in the agent environment; if unavailable, say so and avoid inventing their instructions. Follow explicit user authorization and higher-priority environment rules.
