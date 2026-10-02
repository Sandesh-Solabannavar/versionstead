# Security model and limits

## Current capability

The foundation exposes local runtime status and hosts the interface. It does **not** inspect installed applications, scan dependencies, assess vulnerabilities, enroll remote devices, or manage repository credentials. No security outcome should be inferred from its empty state.

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

## Data and secrets

Collect the minimum metadata needed to explain findings: package identities/versions, selected project/device identity, source/channel, scan provenance, and advisory references. Source code does not need to leave a device for ordinary dependency scanning. Advisory queries can reveal package names and versions to the selected provider; describe that egress when the integration is introduced.

Do not log tokens, credential-bearing URLs, raw lockfiles, source files, or full local paths by default. Sanitize errors and external process output. Before implementing token features, choose OS-backed credential storage; do not put secrets in SQLite, frontend state, repository files, or command-line arguments visible to other processes.

Local database files and backups require appropriate filesystem permissions. Document retention, deletion, export, and credential revocation when persistence and enrollment ship. A remote collector must not receive the coordinator’s repository credentials.

## Meaning of vulnerability coverage

The initial intended scope is known dependency advisories, not a source-code audit, malware scan, or guarantee of safety. An absent advisory can mean no known match, unsupported identity, incomplete graph, stale data, or a failed lookup. Keep these outcomes distinct.

Use ecosystem/package identities and affected-version ranges. Installed desktop application names alone are insufficient for reliable CVE matching. Linux vendors backport fixes, so an old-looking upstream version is not by itself evidence of a vulnerable distribution package. Deduplicate advisory aliases while retaining each source’s evidence.

Use an explicit scanner version and report format coverage. Validate npm, Bun, NuGet, and Cargo behavior independently; support in an upstream tool does not mean support in Versionstead until the integration has been checked.

## Implementation gates

Before claiming a new boundary is supported, add focused checks for unauthorized or malformed input and the applicable failure cases. High-value cases include traversal/symlink escape, oversized inputs, subprocess timeout, offline lookup, revoked collector credentials, duplicate uploads, and interruption before a scan commits.

Before a public release, establish a license, a private vulnerability-reporting channel, dependency update policy, release signing, and a supported-platform matrix. This document is an implementation guide and capability limit, not a claim that a security audit has been completed.
