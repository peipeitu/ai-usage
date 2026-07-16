# Changelog

## 0.1.6 - 2026-07-16

- Add tray usage status with background refresh, provider-aware quota display, and synchronized language and settings behavior.
- Add a Windows tray popup with remaining usage, refresh and stale-data states, theme and accent support, and an action to open the main window.
- Improve Windows taskbar and tray icon rendering across common DPI scales, and keep the Windows release free of an extra console window.
- Serialize usage scans and reject stale refresh results so concurrent updates cannot overwrite newer data or compete for history writes.

## 0.1.5 - 2026-07-09

- Preserve Codex daily usage history in an AI Usage snapshot so deleted local Codex sessions no longer shrink previously observed trend totals.
- Add quota pace indicators with theoretical usage markers, headroom or overrun status, and projected exhaustion timing for usage windows.
- Update dependency versions for the Tauri app and fix Codex token count conversion with newer rusqlite releases.
- Add an in-app updater experience and reduce temporary release artifact retention to one day.

## 0.1.4 - 2026-07-04

- Improve usage accuracy for Claude Code, GitHub Copilot, Cursor, and ChatGPT with provider-specific local account metadata, local estimate labels, usage windows, and bounded scan limits.
- Add configurable auto refresh, provider visibility controls, richer usage summaries, safer chart tooltip rendering, and improved provider keyboard navigation.
- Harden settings persistence with invalid-settings quarantine, temporary-file writes, file syncing, and safer replacement behavior.
- Prepare release automation with scoped GitHub Actions permissions, CI checks, Dependabot updates, generated updater manifests, and release artifact upload support.
- Document estimate limitations, release signing flow, formatting and lint commands, and updater manifest dry runs.
