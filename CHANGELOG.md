# Changelog

## v1.1.0 — 2026-05-14

### Fixed
- Eliminated major RAM spike on library load — gallery stats now read from a dedicated `galleries` IDB store instead of loading every cached image dataUrl into memory via `getAll()`
- Strip/scroll mode no longer loads images out of order — switched from parallel fetch to a sequential async loop with a generation guard to prevent layout shifts
- Batch CBZ upload now updates each card's page count and size as each file finishes, instead of waiting for the entire batch
- Last uploaded card no longer stays stuck with the progress overlay visible after import completes
- Fixed DB version mismatch (bumped to 6) across all three IDB openers that caused uploads and the reader to silently fail after the store refactor

### Added
- Reader remembers the last view mode (scroll strip / single page / double page) across sessions
- Scroll-to-top button in strip/scroll mode (bottom-right corner, appears after scrolling down)
- `Shift` + any navigation key jumps to first/last page in both the reader and library
- Gallery ID color now distinguishes locally imported (yellow) from online-cached (peach) galleries

### Changed
- `_patchCovers` now updates both thumbnail elements per card (main and hover overlay)
- Updated README keyboard shortcut table to document all navigation keys

## v1.0.0 — 2026-05-14

Initial release.
