# Design and interaction

Versionstead should make evidence easy to understand and follow up. Use a compact, calm interface inspired by T3 Code’s layout and semantic theme conventions. Avoid a marketing dashboard, decorative charts, or invented scan results.

## Present monitoring interface

The shared header follows T3 Code's native caption geometry, theme synchronization, and settings breadcrumbs. Settings uses compact icon navigation and searchable, focusable rows; it returns to the previous workspace rather than always opening Needs attention. Sidebar visibility is persistent. Device-default restoration is confirmed and limited to UI preferences and shortcuts.

The interface has four real workflows: Needs attention, This PC, Projects, and Background service. It separates connection health, scan freshness, coverage, update checks, and known-advisory results. Project selection, maintenance mode, manual scans, pause, schedules, and notification preferences invoke validated coordinator APIs. Windows host installation remains an explicit elevated command with lifecycle verification. A planned feature belongs in documentation or clearly labeled explanatory text, not a button that appears functional.

The shared web/desktop interface offers System, Light, and Dark appearance. System follows `prefers-color-scheme`; explicit choices use local storage and survive restart within the same origin. The Electron renderer uses a stable `versionstead://app/` origin. Browser and desktop choices remain independent, and unavailable browser storage limits a choice to the current session. Native window chrome and OS integration still require platform-specific visual verification.

The approved design is implemented with source-owned shadcn Base UI components, matching T3 Code's `base-mira` configuration. An integrated 40 px Windows caption (52 px browser header) and 205 px collapsible sidebar frame the workspace. Shared buttons, badges, selectors, collapsibles, tables, evidence sheets, and toasts use semantic tokens. The existing Versionstead V mark is shared by the title bar and update panel, with corresponding favicon, native window, tray, and notification icons. Appearance preview cards, paired palette orbs, interface sliders, motion preview, and typography previews adapt the T3 Code implementation. T3 and shadcn MIT notices ship with the built assets.

## Information hierarchy

The four monitoring destinations now share a sidebar utility area with Settings and Update controls. Settings has General, Appearance, Keybindings, Source Control, and Connections routes. Paired computers appear as separate evidence destinations. Scan history stays in Background service; update/advisory filters stay in Needs attention. Introduce further destinations only when they have useful content and a real workflow.

A finding should answer, in order:

1. What is affected?
2. What changed or was detected?
3. How recent and complete is the evidence?
4. What source supports the conclusion?
5. What action is available?

Use tables for comparable package data, a focused details panel for evidence, and short readable empty/error states. Group a shared advisory across affected subjects without hiding their different scan times or versions.

Needs attention groups findings by stable PC/project identity; URL filters for update and advisory summaries remain effective. Failed, partial, unsupported, and unscanned targets appear in All findings and Incomplete checks, even without a package finding. Counts distinguish package observations, updates, advisories, and incomplete checks. Summary counts combine repeated project importers; dependency rows preserve their own requested ranges and resolved versions, and PC manager/location observations remain distinct.

Projects initially shows selected folders with findings, incomplete evidence, failed checks, or active/queued scans. All projects restores the complete selected-folder list. Each expandable group initially shows dependencies needing attention; All dependencies exposes retained inventory and source exclusions. Intentional transitive version exclusions alone do not classify a complete project as needing attention. Search filters targets and package rows. Expansion choices survive snapshot refreshes, and header scan actions sit outside the disclosure button. Add, remove, maintenance mode, and scan actions use the existing validated APIs.

## Status semantics

Needs attention and Projects start with every accordion closed on entry. Expanding one group does not close another; manual choices survive snapshot refreshes and filter changes while that page remains mounted. Evidence panels and scan buttons keep their separate interactions.

| State               | Presentation rule                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Update available    | Show installed/resolved version, candidate version, source, and compatibility/channel.     |
| Known vulnerability | Show advisory identifier, severity source, affected version, and fixed version when known. |
| No known findings   | Qualify with completed coverage and scan time. Never imply universal safety.               |
| Partial/unsupported | Identify the missing format, source, or inputs and the resulting limitation.               |
| Failed/offline      | Explain the failure while preserving last successful evidence with an age label.           |
| Not scanned         | State that no evidence has been collected; do not render zeroes as a successful scan.      |

Color supplements text and icons; it never carries meaning alone. Update availability is not automatically a security warning. Severity and confidence/coverage are separate concepts.

## Theme and component rules

- Use semantic CSS variables for canvas, surfaces, text, muted text, borders, focus, and status colors.
- Support light, dark, and system preferences when theme selection is exposed; persist the explicit preference locally.
- Centralize component variants rather than adding slightly different buttons and badges on each page.
- Use readable typography, aligned tabular version data, restrained borders, and enough space for long package names and paths.
- Keep dense tables horizontally usable and provide a sensible narrow-window layout. Desktop does not imply a fixed viewport.
- Use the shared shadcn/Base UI primitives for the approved interactions. Native form dialogs remain accessible; avoid another component dependency when the existing control meets the need.

## Accessibility and behavior

Use semantic landmarks, properly labeled controls, logical heading levels, visible keyboard focus, and sufficient contrast in both themes. Do not remove browser keyboard behavior without a clear replacement. Honor reduced motion and avoid unnecessary animation.

Async actions show progress and a meaningful failure state. Keep prior content while refreshing it. Cancellation, retry, and destructive actions need accurate labels. Never show “updated” or “secure” solely because a request was submitted.

This PC begins with an empty Scan this PC prompt. npm and Bun have independent detection/version cards with expandable configured global locations and owner-source timestamps. After scanning, Updates available is the default filter; All global tools, Up to date, and Unverified expose other observations. A package-manager filter selects npm, Bun, or both. Unknown available-version/update cells remain blank with a single coverage explanation. No candidates, unavailable checks, failed checks, and an empty search each have distinct messages.

One shared scan progress control shows the active target/stage, measured stage-local counts when known, queued targets, and terminal outcome/elapsed time. Unknown totals remain indeterminate; disconnected information freezes with a last-observed label. A completed stage does not imply complete coverage.

Notifications show one count summary after a scan cycle settles, combine the signed-out backlog, and use a persisted five-minute cooldown. Unchanged findings stay quiet. Update and security-advisory counts remain distinct, and a summary click opens the appropriate Needs attention filter. Snooze and daily-digest preferences remain deferred.

One app-wide shadcn/Base UI toaster presents these summaries, successful actions, and action/connection errors. A summary offers Review and Close; its opaque identity is saved in a bounded 200-entry device-local history so polling, native delivery, and reloads do not replay it. Routine status polling produces no success toast. At most three toasts remain visible in the stack. Toasts support keyboard dismissal, F6 focus, hover/focus pause, swipe dismissal, reduced motion, and narrow windows. Persistent connection and compatibility banners remain visible for conditions requiring ongoing attention. Native OS notifications retain their existing receipt behavior when the UI is hidden.

## T3-inspired settings

Project adapts T3 Code's project/environment selector, Name/icon group, icon picker, Actions editor/list, and Danger confirmation. Name commits on blur/Enter, icons reset to an automatic monogram, action edits preserve identity/order, and removal leaves files untouched. The scope hint describes actual local/paired permissions; other settings pages remain global. Custom commands launch manually from a review/output dialog or project-scoped shortcut; New threads, bootstrap, and worktree options are omitted. Glyph selection uses a curated 24-icon catalog alongside emoji, monogram, and uploaded images. See [Project settings](project-settings.md).

Settings uses T3’s narrow icon navigation, grouped bordered rows, muted section labels, inline tool versions/status indicators, compact switches, and a sidebar utility area. Source Control copies T3 Code’s provider/VCS SVGs and discovery-row layout: status dots overlap the icon, CLI versions sit beside the name, and chevrons reveal Git context and provider connection/selection details. The repository switch and interval control use existing scan preferences; unsupported VCS/providers say Coming soon. The release sheet distinguishes checking, available, current, unpublished, and failed; an unpublished release is never presented as a verified current build.

Appearance controls live only in Settings. Three mode previews and six built-in palette pairs copy T3 Code's wireframe/orb components and palette values. Light/dark palettes can be selected independently; custom-theme create, duplicate, edit, import, and remove actions are functional. Contrast, glass opacity, content width, panel duration, fonts, font sizes, word wrap, density, and reduced motion update real interface tokens. Advanced typography supports table and evidence-panel size overrides. Shortcut capture rejects conflicts, supports disable/reset, and does not intercept typing or dialogs. The PC evidence view keeps remote timestamps, coverage, failure state, and received data separate from local editing controls.

Source Control ports T3 Code's deterministic redacted account placeholder, click-to-reveal tooltip, refresh icon, and visibility/reduced-motion handling. Refresh has its own pending state and revalidates stored provider authentication without scanning repositories or emitting the general mutation notice. Existing connection evidence survives a failed check.

Add Project adapts T3 Code's searchable source chooser, setup-required route, repository list, back navigation, and confirmation flow. Local folders use the native picker; GitHub/GitLab and their HTTPS/SSH URLs identify accessible repositories for read-only API monitoring. Confirmation exposes the branch/ref and maintenance intent. No repository becomes a selected project before confirmation. The same picker serves Source Control and Projects.

Connections adapts T3 Code's grouped machine rows, overflow menu, compact Environments heading, saved rows, and centered empty state. Add Environment uses the same Remote link/SSH cards, highlighted selection, host/code and username/port layout, and blurred backdrop. Full pairing links populate both remote fields; codes remain concealed. Inline errors and a pending action keep the dialog open until pairing succeeds. SSH adds an explicit monitor-invitation verification step because Versionstead connects an existing monitor instead of bootstrapping an agent.

Machine/environment actions use shared Base UI menus. Environment switches pause polling without removing retained evidence; removal confirms its revocation effect. Network access and pairing dialogs reuse the native Dialog wrapper, with Select popups portaled into its top layer. Accent/error tokens, keyboard focus, Escape, restored trigger focus, and stacked narrow-window fields follow the shared theme and control behavior. Local rows expose real scan, release, sharing, Tailscale-address, and host-mode state; unrelated T3 agent controls are omitted.
