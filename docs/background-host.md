# macOS and Linux background host

Electron is a tray client, and the coordinator it starts belongs to the app session. On macOS and Linux a background host can own the coordinator instead: a LaunchAgent on macOS, a `systemd --user` service on Linux. Both run as you, from this checkout's built files and the Node.js 24 that ran the script, and identify as `boot-task`, so the desktop attaches to them, gives them your npm/Bun locations, and never replaces them. For Windows see [Windows background monitoring](windows-background.md).

## Install

Build once with `pnpm build`. Then, from the repository root, as your own user (not with `sudo`) and with Node.js 24:

    node scripts/background-host.mjs install            # macOS, or Linux while you are logged in
    node scripts/background-host.mjs install --linger   # Linux, also before login and after logout

Install stops a running coordinator gracefully, writes the service definition, starts it, waits until it answers as the background host, and saves your npm and Bun global locations through the same validated route the desktop uses. It pins the data directory it resolves now; `--data-dir ABSOLUTE` overrides it. Every other action works on the data directory the host was installed with, whatever `VERSIONSTEAD_DATA_DIR` says at that moment, and refuses a different `--data-dir`; to change the directory, run install again. If you set `VERSIONSTEAD_DATA_DIR` or `XDG_DATA_HOME` only in a shell profile, give the desktop app the same value or pass `--data-dir`, or the two will use different data. Install installs no packages, runs no repository scripts, and changes no firewall, keychain or Tailscale setting.

- macOS: `~/Library/LaunchAgents/dev.versionstead.coordinator.plist`, with `RunAtLoad` and `KeepAlive` → `SuccessfulExit` = false, loaded with `launchctl bootstrap gui/<uid>`. Run install from Terminal in your logged-in desktop session; an SSH session has no `gui/<uid>` domain. The host runs from login to logout; monitoring before login or after logout would need a LaunchDaemon, which Versionstead does not install. Protected connection credentials use your login keychain.
- Linux: `~/.config/systemd/user/versionstead.service` (or the folder under the systemd manager's `XDG_CONFIG_HOME`), with `Restart=on-failure` and `WantedBy=default.target`, enabled with `systemctl --user enable --now`. Without lingering it runs while you are logged in. `--linger` runs `loginctl enable-linger <you>` so it also runs before login and after logout. GNOME Keyring and KWallet stay locked until you log in: until then provider scans and paired PCs that need a saved credential report "Unlock your login keyring…" and keep their last evidence; the coordinator checks the keyring again at most once a minute while something needs it.

Paths that systemd would expand or trim (`%`, `$`, quotes, backslashes, control characters, a trailing space) are refused with a message; move the checkout or choose another data directory. If the systemd user manager's own `XDG_CONFIG_HOME` holds spaces or shell characters, every action stops before changing anything, because systemd prints such a value in a quoted form this script does not read; use a configuration folder without them.

## Operate and remove

    node scripts/background-host.mjs status
    node scripts/background-host.mjs restart
    node scripts/background-host.mjs stop
    node scripts/background-host.mjs start
    node scripts/background-host.mjs uninstall

Stop, like the tray's Stop monitoring, ends the coordinator with a clean exit, which neither launchd nor systemd restarts; it starts again at your next login, or at boot with lingering. On macOS, stop then asks launchd whether the job has ended and tells you if it has not. A crash restarts the host: systemd waits ten seconds (`RestartSec=10`); launchd restarts a crashed host at once, at most once every ten seconds. After rebuilding Versionstead, run `restart` so the host loads the new build. After upgrading or moving Node.js 24, run install again; the host keeps the Node.js path it was installed with. Uninstall removes the service definition and keeps the data directory; with nothing installed it only asks launchd or systemd to drop any leftover job, says so, and succeeds.

When the desktop app started its own coordinator first (for example when both open at login), the background host finds the data directory in use and exits cleanly without retrying; run `restart` to hand monitoring back to it. Install, start and restart report this at once instead of waiting for a host that will not come up, and status names the desktop's coordinator as the owner.

## Verification

Automated checks cover the generated LaunchAgent and unit files (paths with spaces, XML escaping, refused characters, `systemd-analyze verify`, and `plutil` on the macOS CI runner), the command sequence of every action against stand-in `launchctl`, `systemctl` and `loginctl`, and the clean exit when another coordinator owns the data directory. Loading a real LaunchAgent, login and logout, sleep and wake, and lingering across a reboot are unverified on macOS and Linux hardware.
