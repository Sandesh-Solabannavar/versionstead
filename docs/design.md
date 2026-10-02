# Design and interaction

Versionstead should make evidence easy to understand and follow up. Use a compact, calm interface inspired by T3 Code’s layout and semantic theme conventions. Avoid a marketing dashboard, decorative charts, or invented scan results.

## Present monitoring interface

The interface has four real workflows: Needs attention, This PC, Projects, and Background service. It separates connection health, scan freshness, coverage, update checks, and known-advisory results. Project selection, maintenance mode, manual scans, pause, schedules, and notification preferences invoke validated coordinator APIs. Windows host installation remains an explicit elevated command with lifecycle verification. A planned feature belongs in documentation or clearly labeled explanatory text, not a button that appears functional.

The shared web/desktop interface offers System, Light, and Dark appearance. System follows `prefers-color-scheme`; explicit choices use local storage and survive restart within the same origin. The Electron renderer uses a stable `versionstead://app/` origin. Browser and desktop choices remain independent, and unavailable browser storage limits a choice to the current session. Native window chrome and OS integration still require platform-specific visual verification.

The approved design is implemented with source-owned shadcn Base UI components, matching T3 Code's `base-mira` configuration. A 44 px brand bar, 205 px sidebar, and 52 px page header frame the workspace. Shared buttons, badges, selectors, collapsibles, tables, and evidence sheets use semantic tokens. Theme buttons are 36 px with an 8 px gap, expanding to 44 px for coarse pointers. The T3 MIT notice ships with the built assets.

## Information hierarchy

Use the four current destinations until additional devices or findings need separate workflows. Scan history stays in Background service; update/advisory filters stay in Needs attention. Introduce further destinations only when they have useful content and a real workflow.

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
