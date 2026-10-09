# Project settings

Settings → Project follows T3 Code's project selector, environment scope, grouped Name/icon rows, Actions editor, and confirmed removal. The New threads section is omitted. Project settings links in Projects open the matching entry; its Actions menu opens a command panel.

## Identity and scope

Local folders remain separate entries even when their names match. Selected provider repositories share a display group by provider/repository identity across refs and environments. Choose This PC or an individual environment to narrow the group. Paired-PC entries are read-only under the current evidence/scan grants; edit them on their own PC. Global settings pages continue to control global preferences.

Name saves on blur or Enter, trims surrounding whitespace, and rejects empty/control-character names. Renaming preserves the project ID, selected path/repository/ref, dependencies, coverage, timestamps, and history. Current findings use the new display name; historical scan records retain the name observed at scan time.

Project icon supports Automatic, 24 searchable Lucide glyphs and 18 colors, emoji, one-to-three-character monograms, and uploaded PNG/JPEG/WebP images. Uploads are limited to 2 MiB and 4096 pixels per dimension, then normalized to a 48-pixel PNG before storage. Reset restores the deterministic name-based monogram/color. The icon appears in project and attention groups. No project files are written.

## Manual commands

For a selected local checkout, Add action opens Name, icon, optional keybinding, and Command. Edit preserves the action's ID/order; Delete requires confirmation. A project can hold 20 actions, with 80-character names and commands up to 4096 characters. The HTTP request limit remains 32 KiB. Shortcuts require Ctrl or Alt (Control, Option, or Command on a Mac), reject conflicts with global bindings or another action in that project, and can be cleared with Backspace; Tab, Shift+Tab, and Escape leave the keybinding field as usual instead of being recorded. They read ⌥⌘T on macOS and Ctrl+Alt+T elsewhere. On the selected Project settings page, a shortcut opens its command panel. In Projects, focus within the matching project group is required. Typing fields, dialogs, repeats, and composition retain their own behavior.

Saving, scanning, connecting a provider, and background scheduling never run actions. Run or a shortcut opens the panel to review the command; Run command explicitly launches it. The desktop app runs it as the signed-in owner in that selected local directory: Windows PowerShell 5.1 on Windows; on macOS and Linux the owner's login shell (`$SHELL` when it is an absolute path listed in `/etc/shells`, otherwise `/bin/sh`; csh and tcsh use `/bin/sh`) with `-l -c`, in a process group of its own. The dialog names the shell. PATH gains the tool directories that a Finder, Dock or desktop-menu launch lacks, although a login profile that resets PATH (Debian's `/etc/profile` does) takes precedence. A browser has no command bridge: Run stays focusable but inactive and the page says "Custom commands run in the Versionstead desktop app." Provider-only repositories and paired-PC projects cannot launch commands here; add a local checkout first.

The panel shows output, terminal status, and exit code; Stop command terminates the tracked process tree: `taskkill /T` on Windows; on macOS and Linux SIGTERM to the process group, then SIGKILL after five seconds. A process that left the group (for example a daemon started with `setsid`) keeps running, and Versionstead stops waiting for its output. Commands are noninteractive: there is no terminal input or TTY. Only one command per project and four overall can run concurrently. A ten-minute deadline and 64 KiB output limit terminate tracked commands. The last 20 runs are retained in desktop memory only. Closing the panel lets a command continue; reopening shows its latest output. Quit UI stops tracked commands while the independent monitoring coordinator continues. Removing a project through Electron stops its command before deleting the entry; deleting a saved action also stops its tracked command. Changes made by another client are reconciled on the next desktop poll.

Commands are owner-authored instructions with the owner's privileges. They may modify files when explicitly launched. On Windows enter PowerShell syntax, such as `pnpm.cmd test` when a PowerShell execution policy prevents `.ps1` wrappers; elsewhere use your login shell's syntax. The runner never derives a command from package scripts or remote repository content. Saved commands are local SQLite settings, excluded from paired evidence; output is neither persisted nor sent to peers. Avoid embedding credentials in commands or output.

## Removal

Remove project opens a confirmation describing the selected entries. Confirm removes those monitoring entries, current evidence/findings, icons, actions, and related pending notifications. Historical scan records remain. Files on disk and provider repositories are untouched. Cancel leaves the entry intact.

## Reference and validation

The implementation adapts the behavior of T3 Code's `ProjectSettingsPanel.tsx`, `ProjectActionsSettings.tsx`, `useProjectScriptSettings.ts`, `ProjectIconPickerDialog.tsx`, `projectScriptEditor.tsx`, `ProjectScriptsControl.tsx`, and project identity/color helpers from the local reference clone. Thread, worktree, bootstrap, and agent-preview controls have no corresponding Versionstead workflow and are omitted. The current paired-PC permission model does not grant remote project administration.

Regression checks cover metadata persistence/identity, read-only scans, invalid inputs, authenticated partial updates, command privacy, grouping and shortcut conflicts, and actual Windows and POSIX execution/exit/stop/deadline/output bounds (POSIX in a Linux container and on the macOS CI runner). Electron smoke exercises name/icon changes, file normalization, action creation/edit/deletion, keyboard opening, real IPC execution/output/reopen/Stop, removal cancellation, and narrow-window containment in isolated monitoring state. See [development verification](development.md).
