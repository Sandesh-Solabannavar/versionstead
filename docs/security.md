# Security model and limits

## Current capability

The local coordinator detects npm/Bun, reads configured global-tool manifests and explicitly selected npm/pnpm project manifests/lockfiles, and queries eligible public npm versions. OSV known advisory checks remain limited to supported project dependencies. Windows registry/WinGet scanning has been removed. Private/custom registries, local/Git tools, unsupported release channels, other ecosystems, remote enrollment, and repository credentials remain outside coverage. Empty, partial, failed, and unsupported checks are distinct outcomes.

Keep the coordinator on loopback until the remote-access controls below are implemented. Loopback limits network reachability; it does not make hostile local processes or browser-origin requests trustworthy.

## Trust boundaries

| Boundary                        | Required controls before the feature ships                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser/Electron → coordinator  | Validated request/response schemas, strict routes and methods, body limits, origin/host policy for browser requests, and authentication for sensitive operations. |
| Collector → coordinator         | Explicit pairing, authenticated TLS, per-device credentials, revocation, bounded payloads, replay/idempotency handling, and rate limits.                          |
| Repository/filesystem → scanner | Explicitly selected roots, validated paths, symlink/traversal handling, bounded file sizes, format validation, and no script execution.                           |
| Coordinator → executable        | Allowlisted tool identity, argument arrays without shell interpolation, timeouts, bounded output, cancellation, and a controlled environment.                     |
| Coordinator → remote source     | Fixed/validated destinations, HTTPS, redirect policy, response limits, timeouts/backoff, and careful token scoping.                                               |
| Electron renderer → host        | Sandboxing, context isolation, Node integration disabled, narrow IPC if needed, navigation restrictions, and controlled external-link opening.                    |

LAN membership and Tailscale reachability are transport facts, not authorization. Hostnames and IP addresses are not device identities. Repository metadata, scanner output, and registry responses remain untrusted even when fetched over HTTPS.

## Read-only background monitoring

Background work may inspect selected files and query documented metadata interfaces. It must not install dependencies, restore a project, execute lifecycle/build scripts, upgrade applications, modify lockfiles, or run arbitrary commands from repository configuration.

Some ecosystem commands have side effects. For example, `.NET package list` behavior depends on SDK version and may restore by default. Prefer existing resolved data; explicitly suppress restore only where that behavior is supported and verified. Missing data is an incomplete scan.

Updates, commits, and pull requests are separate future user actions. Present the concrete proposed changes and required access before performing them.

PC discovery selects installed npm/Bun executables from explicit absolute PATH entries. npm's validated CLI runs through Node with fixed global root/config commands; `.cmd` shell wrappers are never executed. Bun runs only `--version`; its exact global directory is resolved from supported configuration/environment defaults without executing `bun pm ls`. That listing command can create its global directory and climb to an unrelated parent manifest when the expected manifest is absent. Commands run outside selected projects with argument arrays, timeouts, bounded output, and `NODE_OPTIONS` cleared. Package versions come from bounded installed manifests; package executables and lifecycle scripts never run. Canonical local roots and selected-file validation reject network shares, traversal, and escaping symlinks. The boot host reads owner-captured roots and Bun's single direct-dependency manifest; it grants no broad owner-profile or registry-credential access. Availability/version remains an owner-session observation after sign-out, separate from metadata access freshness.

Global lookup destinations are fixed to the public npm registry with HTTPS, rejected redirects, response limits, cancellation, and a scan budget. Public registry classification, excluded configured scopes, private manifest flags, and local/Git/URL dependency requests prevent known private/local names from public queries. Unknown registry/configuration evidence is not public permission. Source configuration is authenticated, schema/path validated, and cannot change during PC work. Refresh it after changing routing; background scans cannot observe new owner settings while signed out. Credentialed registries and complex unsupported Bun configuration need explicit support before checks can become verified.

## Data and secrets

Collect the minimum metadata needed to explain findings: package identities/versions, selected project/device identity, source/channel, scan provenance, and advisory references. Source code does not need to leave a device for ordinary dependency scanning. Advisory queries can reveal package names and versions to the selected provider; describe that egress when the integration is introduced.

Do not log tokens, credential-bearing URLs, raw lockfiles, source files, or full local paths by default. Sanitize errors and external process output. The transient coordinator capability is encrypted using Windows DPAPI LocalMachine in a private runtime descriptor so the owner and LocalService can reconnect. Scoped filesystem ACLs are essential: any account able to read that encrypted file on the same machine can potentially decrypt it. It is not an external registry credential and is not stored in SQLite or process arguments. Non-Windows descriptors rely on owner-only file permissions; native desktop behavior there is unverified.

`pnpm run access` deliberately prints that capability only on explicit owner request. The browser exchanges it for an HttpOnly, SameSite=Strict session cookie; Electron attaches a bearer capability in its native protocol handler. Host/origin checks, body/header limits, fixed API routes, and request/response schemas protect the loopback boundary. Restart rotates the capability and invalidates prior browser sessions. This does not protect against malicious processes already running as the owner or LocalService.

Public checks send eligible npm package identities and resolved versions to `api.osv.dev`; direct package names are queried from `registry.npmjs.org`. Source code, full local paths, lockfile contents, and registry credentials are not sent. Workspace/Git/local identities and private origins identified by selected-root `.npmrc` or lockfile URLs are excluded. User/global/ancestor/environment npm routing is not inspected; configure selected-root registry identity before scanning dependencies whose privacy depends on those settings. This ceiling is also reported in scan coverage.

Local database files and backups require appropriate filesystem permissions. Document retention, deletion, export, and credential revocation when persistence and enrollment ship. A remote collector must not receive the coordinator’s repository credentials.

## Meaning of vulnerability coverage

The initial intended scope is known dependency advisories, not a source-code audit, malware scan, or guarantee of safety. An absent advisory can mean no known match, unsupported identity, incomplete graph, stale data, or a failed lookup. Keep these outcomes distinct.

Use ecosystem/package identities and affected-version ranges. Installed desktop application names alone are insufficient for reliable CVE matching. Linux vendors backport fixes, so an old-looking upstream version is not by itself evidence of a vulnerable distribution package. Deduplicate advisory aliases while retaining each source’s evidence.

Use an explicit scanner version and report format coverage. Validate npm, Bun, NuGet, and Cargo behavior independently; support in an upstream tool does not mean support in Versionstead until the integration has been checked.

## Implementation gates

Before claiming a new boundary is supported, add focused checks for unauthorized or malformed input and the applicable failure cases. High-value cases include traversal/symlink escape, oversized inputs, subprocess timeout, offline lookup, revoked collector credentials, duplicate uploads, and interruption before a scan commits.

Before a public release, establish a license, a private vulnerability-reporting channel, dependency update policy, release signing, and a supported-platform matrix. This document is an implementation guide and capability limit, not a claim that a security audit has been completed.
