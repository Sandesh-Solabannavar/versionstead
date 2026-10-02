# Design and interaction

Versionstead should make evidence easy to understand and follow up. Use a compact, calm interface inspired by T3 Code’s layout and semantic theme conventions. Avoid a marketing dashboard, decorative charts, or invented scan results.

## Present foundation

The initial interface reports coordinator connectivity and the absence of scans. It should expose working actions only. A planned feature belongs in documentation or clearly labeled explanatory text, not a button that appears functional.

The shared web/desktop interface offers System, Light, and Dark appearance. System follows `prefers-color-scheme`; explicit choices use local storage and survive restart within the same origin. The Electron renderer uses a stable `versionstead://app/` origin. Browser and desktop choices remain independent, and unavailable browser storage limits a choice to the current session. Native window chrome and OS integration still require platform-specific visual verification.

## Information hierarchy

As monitoring is implemented, organize navigation around **Needs attention**, **Devices**, **Projects**, **Updates**, **Security**, and **History**. Introduce each destination when it has useful content and a real workflow.

A finding should answer, in order:

1. What is affected?
2. What changed or was detected?
3. How recent and complete is the evidence?
4. What source supports the conclusion?
5. What action is available?

Use tables for comparable package data, a focused details panel for evidence, and short readable empty/error states. Group a shared advisory across affected subjects without hiding their different scan times or versions.

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
- Use native HTML controls where they meet the need. Add a component dependency only when an actual interaction requires it.

## Accessibility and behavior

Use semantic landmarks, properly labeled controls, logical heading levels, visible keyboard focus, and sufficient contrast in both themes. Do not remove browser keyboard behavior without a clear replacement. Honor reduced motion and avoid unnecessary animation.

Async actions show progress and a meaningful failure state. Keep prior content while refreshing it. Cancellation, retry, and destructive actions need accurate labels. Never show “updated” or “secure” solely because a request was submitted.

Notifications should be quiet by default for unchanged findings. A notification links to its supporting evidence and honors snooze/digest preferences once those capabilities exist.
