# This PC package updates

This PC offers **Update now** beside verified stable public-registry updates in Windows Electron. The installation evidence drawer also shows the exact command and **Copy update command**. Closing the window keeps a manually launched update running in the tray; Quit UI stops its process tree. Browser clients and paired environments cannot launch package updates.

The control adapts T3 Code's `ProviderInstanceCard.tsx`, `providerMaintenance.ts`, `providerMaintenanceRunner.ts`, and `packages/shared/src/shell.ts` in the local reference clone. It uses the compact outline button, download/spinner icons, per-installation pending state, failure/retry feedback, fresh ownership resolution, installer locking, and post-command verification. T3's provider-specific native/Homebrew/pnpm updaters do not apply to Versionstead's npm/Bun global inventory.

## Discovery and ownership

Explicit absolute local PATH directories retain their order. On Windows, discovery appends T3's known CLI directories when absent:

- `%APPDATA%\npm`
- `%LOCALAPPDATA%\Programs\nodejs`, `%LOCALAPPDATA%\Volta\bin`, `%LOCALAPPDATA%\pnpm`
- `%USERPROFILE%\.local\bin`, `%USERPROFILE%\.bun\bin`, `%USERPROFILE%\scoop\shims`

Configured `BUN_INSTALL\bin`, `VOLTA_HOME\bin`, `PNPM_HOME`, and `ProgramFiles\nodejs` are also fallbacks. Relative paths, network shares, duplicates, shell-profile execution, and current-directory executable resolution are excluded. The same fallback list locates desktop Node and the managers used to capture global sources.

This discovers the active npm and Bun executables and their configured global roots; it does not recursively inventory every old Node installation or every directory in the list. T3 also derives ownership from the active provider executable rather than updating every installation. Versionstead already has package/root identities from installed manifests. npm's actual JS CLI is validated and invoked through absolute Node; Windows batch shims are not executed. Bun's supported configuration/environment precedence still determines its root. A successful owner-session discovery is required immediately before updating, including when monitoring uses a LocalService boot host.

## Manual execution

Trusted Electron main-frame IPC accepts only a collected installation ID, expected installed version, and selected stable target version. Main rechecks the current authenticated coordinator snapshot. The focused adapter rediscovers the manager and verifies its root, installed manifest, canonical package name, alias, version, and public origin. Changed, private, linked, unsupported, prerelease, unavailable, or stale targets are rejected. PC scans must finish before a new update starts.

npm installs the exact selected package version with an explicit observed global prefix. Bun requires the exact global manifest and its direct dependency declaration, then adds the exact selected version with `BUN_INSTALL_GLOBAL_DIR` fixed to the observed directory and that directory as its working directory. A missing manifest is rejected before execution, preventing Bun's ancestor-manifest fallback. npm aliases remain aliases. Bun's copied command includes its global-directory assignment as well. Updates preserve each manager's normal lifecycle-script/trusted-dependency settings; npm 12 receives the target package's script approval, following T3. These are explicit software installation actions, separate from read-only scanning.

The desktop permits one update per global root, so two packages cannot concurrently mutate the same installer state. It uses argument arrays, absolute executables, no shell, a five-minute deadline, a one-MiB output limit, and process-tree cancellation. Inherited Node/Electron execution overrides are removed. Raw output is discarded; status and permission failures are sanitized, transient, and not stored in SQLite or shared with peers. Versionstead does not elevate updates; unwritable prefixes require the owner's authorized terminal.

Exit zero alone does not establish success. The adapter rereads the original package/root identity and requires the selected version. Every terminal outcome requests a PC rescan, including failure because a partially completed install can change files. Results survive route changes while Electron remains running. Background scheduling never initiates an update; signed-out monitoring retains read-only access.

## Verification

Run `pnpm check` and `pnpm desktop:smoke`. The optional live Windows smoke installs only `semver@7.0.0` into two disposable global roots, clicks the actual npm/Bun **Update now** buttons, verifies the selected newer stable release and refreshed evidence, rejects stale requests, and removes its isolated state. Both Bun's exact global manifest and a separate parent guard manifest are initialized before installing the fixture; the parent must remain unchanged throughout setup and updates. It requires installed npm and Bun plus public-registry connectivity:

```powershell
$env:VERSIONSTEAD_SMOKE_VERIFY_GLOBAL_UPDATES = '1'
pnpm desktop:smoke
Remove-Item Env:VERSIONSTEAD_SMOKE_VERIFY_GLOBAL_UPDATES
```

The normal smoke never upgrades the owner's packages. Physical sign-out/boot and protected/system prefixes remain separate acceptance tasks. Automated checks cover aliases, PATH fallbacks, changed roots/versions, private sources, escaping symlinks, exact verification, duplicate starts, retry, cancellation, sanitized failures, and process bounds.

References: [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/), [Bun global add](https://bun.com/docs/pm/cli/add), and [Bun 1.4 global-directory/bin environment precedence](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/install/PackageManager/PackageManagerOptions.rs#L283).
