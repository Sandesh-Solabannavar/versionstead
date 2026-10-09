# Windows background monitoring

Electron is a tray client. Closing its window hides it; **Quit Versionstead UI** leaves the independent coordinator running. **Stop monitoring** stops the coordinator explicitly. Session hosting ends at Windows sign-out. A boot task is required to monitor after sign-out. For macOS and Linux, see [macOS and Linux background host](background-host.md).

Paired-PC access over Tailscale after sign-out also requires **Preferences → Run unattended** in each Windows PC's Tailscale tray menu. Tailscale normally disconnects after Windows sign-out; see its [unattended-mode guide](https://tailscale.com/docs/how-to/run-unattended). Installing Versionstead's boot host does not change Tailscale configuration or Windows Firewall. Verify both separately using the [connection setup](settings-and-connections.md).

## Install the boot host

Build once in the source checkout with `pnpm build`. Then open PowerShell **as administrator**, using the same Windows account, and run:

```powershell
Set-Location D:\production_code\versionstead
.\scripts\windows-background.ps1 -Action Install -ProjectRoots 'D:\production_code\versionstead'
.\scripts\windows-background.ps1 -Action Status
```

Install detects the original owner's npm and Bun independently before stopping the running coordinator. It saves their actual global `node_modules` locations, package-manager detection results, and public-registry eligibility in the monitoring database. Managers that are not installed remain explicitly recorded; an empty global package directory is valid. The service reads these saved locations rather than discover tools from LocalService's `PATH` or home directory. It never installs packages, runs package scripts, or upgrades tools.

List only project folders you deliberately want the background identity to read and monitor. Install registers new `ProjectRoots` as watch-only projects and preserves existing maintenance modes. It validates authenticated background readiness, a fresh global-tool scan, and fresh selected-project scans under LocalService within a bounded three-minute probe. Repeat Install when a global location changes or when adding a folder that LocalService cannot read. The script preserves evidence and stops the old coordinator gracefully before registering the new host. Failed probes keep the task registered for diagnostics and do not certify lifecycle behavior.

The task runs at boot under credentialless **LocalService**, independently of the signed-in desktop, with a single-instance policy, no execution-time limit, and bounded failure restarts. It uses the pinned checkout’s built server/web files and an installed Node 24 executable. Keep that checkout and Node location available; moving either requires reinstalling the task. This is a native Scheduled Task, not a Windows SCM service.

Data defaults to `%LOCALAPPDATA%\Versionstead`. The installer scopes data access to the owner, LocalService, SYSTEM, and administrators. It grants LocalService read/execute access to the runtime checkout, Node directory, specified project roots, and existing global `node_modules` directories. For Bun it also grants read access to the single sibling `package.json` file used to distinguish direct tools from hoisted dependencies. Global roots must be real local directories; root junctions and symbolic links are rejected. These grants do not include the owner's whole profile, `.npmrc`, Bun configuration, lockfiles, or credential files. No project write access or stored Windows password is requested.

If elevating as another account, first launch the updated desktop and scan **This PC** as the original owner. Then explicitly pass that owner's `-OwnerSid` and `-DataDir` to Install. The installer reuses validated saved source configuration from the authenticated coordinator or existing database; it refuses to substitute the administrator's npm/Bun installations. Missing owner configuration stops setup before changing registration or stopping monitoring.

## Operate and remove

```powershell
.\scripts\windows-background.ps1 -Action Status
.\scripts\windows-background.ps1 -Action Restart
.\scripts\windows-background.ps1 -Action Stop
.\scripts\windows-background.ps1 -Action Start
.\scripts\windows-background.ps1 -Action Uninstall
```

Status does not need elevation; configuration actions do. Start and Restart use the persisted owner sources and repeat the fresh global-tool access probe. They never rediscover sources under the service identity. Uninstall removes startup registration and preserves evidence and explicit folder grants. It does not delete project files. The tray notifier starts when Electron is opened; automatic tray startup at login is not configured. Pending findings are delivered when the UI next runs.

## Required lifecycle verification

The implementation session was not elevated. The read-only regression check covers script/embedded-Node syntax, duplicate Node `PATH` entries, npm/Bun grant scopes, status, and the nonadmin guard without changing ACLs or tasks:

```powershell
.\scripts\windows-background.test.ps1
```

Run it with Node 24 and the workspace dependencies installed. Installation, LocalService access, reboot, and sign-out are separate acceptance gates:

1. Install and check that Background monitoring reports `boot-task` / `background` and an authenticated connected coordinator.
2. Check npm and Bun detection against the owner's interactive scan, then verify the same saved global-tool identities and versions under LocalService. Exercise npm only, Bun only, both, neither, and an empty global directory where applicable. Scan every selected project folder. Unreadable global roots or project files must produce explicit errors and preserve previous evidence rather than appear clean.
3. Close the window, reopen from the tray, and confirm the same coordinator and saved projects. Quit the UI and verify the coordinator still responds.
4. Restart Windows. Confirm the task runs before login and reconnects after login without a duplicate coordinator.
5. Set a short scan interval, sign out across a due scan, and confirm history timestamps show the attempt while signed out. Check pending notifications on the next app launch.
6. Stop/restart and verify captured global roots, interrupted work, saved projects, and notification receipts survive. Repeat an unchanged scan and confirm no repeated notification. Change a global prefix/location as the owner, repeat Install, and verify that monitoring follows the newly captured root.

This PC monitors owner npm/Bun global tools. Windows registry and WinGet inventory are no longer collected. LocalService reads only captured package locations and permitted package metadata; it does not run the owner's package-manager executables or use owner registry credentials. Private/custom registries and linked or unsupported packages remain unverified. Unavailable roots retain previous candidates as unverified rather than announce new updates. New installations or changed locations require owner-session discovery and another Install to grant the new location. Monitoring pauses while Windows sleeps or is off.

References: [Task Scheduler security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks), [LocalService account](https://learn.microsoft.com/en-us/windows/win32/services/localservice-account), [filesystem access rules](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemaccessrule), [machine-scope DPAPI](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope?view=netframework-4.8.1).
