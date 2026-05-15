# Changelog

## v1.3.0 — 2026-05-15

### Added
- **Total disk writes** — new Stats section in Settings shows the total image data ever written to storage across all sessions, with a Reset button
- **Shift animations on all card buttons** — every button now animates its icon when Shift is held, giving a clear visual signal before clicking the alternate action; the export button flips to a document icon, the download button flips to upload, the delete button pulses
- **Upload button shown by default on non-downloadable galleries** — galleries that can only be imported (no supported download source) now show the upload/replace button directly without needing to hold Shift

### Changed
- **Progress bar moved above tags** in the expanded card hover; tags and page count remain visible while a download is in progress instead of being hidden
- **Database rebuilt with new ID scheme (v7)** — gallery IDs are now internal timestamps used as both the unique key and sort order; all cached data is cleared on first launch of this version

## v1.2.0 — 2026-05-15

### Added
- **Replace images**: hold Shift and hover the download button — it flips to upload mode; Shift+click picks a CBZ and replaces the cached images for that gallery without touching any metadata
- **Quick delete**: Shift+click the delete button removes a gallery instantly, skipping the confirmation prompt
- **Edit source**: Shift+click the source button to reassign the gallery's source URL; the button animates to a chain icon when Shift is held so the action is clear
- **Source auto-fill from clipboard**: when assigning a source URL for the first time, if the clipboard already contains a valid gallery URL it is applied automatically without a prompt
- **Re-download complete galleries**: the download button stays visible even after a gallery is fully cached; clicking it on a complete gallery asks for confirmation before overwriting
- **Metadata in exports**: exported CBZ files now bundle a `metadata.json` with title, tags, source, and page count — re-importing the file restores all of it automatically
- **Metadata-only export**: Shift+click the export button to save just the metadata as a small zip, without re-packaging all the images
- **Library backup import (.shi)**: the Upload button now accepts `.shi` files (a JSON backup of gallery metadata) to restore info for many galleries at once
- **Typed tag search**: use `artist:"name"` or `tag:"name"` in the search bar to filter by a specific tag type; plain text continues to match ID, title, or any tag as before
- **Tag chips append typed tokens**: clicking a tag on a card now adds `artist:"name"` or `tag:"name"` to the search bar instead of a bare name
- **Custom tooltips**: all button tooltips across the library, reader, and popup are now a styled dark tooltip that follows the cursor; tooltips that have a Shift action show what Shift+click will do while Shift is held

### Changed
- Reader image width increased from 900 px to 1280 px in single-page, double-page, and scroll-strip modes
- Setting or updating a source link now patches the card in-place (icon, tooltip, metadata line) instead of triggering a full library reload

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
