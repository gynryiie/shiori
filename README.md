# Shiori 栞

A Chrome extension (Manifest V3) that automatically caches gallery images locally in your browser so you can read them offline.

---

## Features

- **Auto-cache while browsing** — images are intercepted and stored in IndexedDB as you browse normally. No extra steps required.
- **Library** — a full-page grid view of every cached gallery with cover thumbnails, page counts, tags, and search.
- **Reader** — a built-in reader with scroll (strip) and page view modes, single/double page toggle, and keyboard navigation.
- **Offline reading** — once cached, galleries load entirely from local storage with no network requests.
- **Download All** — fetch and cache every page of a gallery in one click (requires a site API key where applicable).
- **CBZ / ZIP import** — import local comic archives directly into the library. Supports batch import of multiple files at once.
- **Source linking** — attach a source site to any gallery to open it in the original reader or download missing pages.
- **Tag search** — search by ID, title, or tags. Multi-term AND search (space-separated). Click any tag to append it to the search bar.
- **Export** — export any cached gallery as a CBZ file.

---

## Installation

Shiori is not on the Chrome Web Store. Install it as an unpacked extension:

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the extension folder.
5. The Shiori icon will appear in your toolbar.

---

## Setup

### API Key (optional)

Some sites require an API key to use **Download All**. Without it, auto-caching while browsing still works fully.

1. Get your API key from your account settings on the source site.
2. Click the Shiori toolbar icon → the gear icon → **Settings**.
3. Paste the key and click **Save Key**.

The key is stored locally in your browser and is only ever sent to the site it belongs to.

---

## Usage

### Auto-caching

With the extension active, simply browse a supported site as normal. Every image you view is automatically saved to local storage. The popup shows live stats (images cached, galleries, total size).

### Library

Click **View All** in the popup, or open `library.html` directly. The library shows all cached galleries as cards with:

- Cover thumbnail
- Title, page count, and storage size
- Tags (hover a card to see all tags in a dropdown; click any tag to search)
- Buttons: Read, Download All, Set Source, Export, Delete

**Search** supports partial matches on ID, title, and tags. Type multiple words to AND-filter across all terms.

### Reader

Click **Read** on any card. The reader loads all cached pages directly from IndexedDB with no network requests.

| Control | Action |
|---|---|
| `←` `↑` `W` `A` | Previous page |
| `→` `↓` `S` `D` `Space` | Next page |
| Click left/right half of image | Previous / next page |
| Layout toggle (toolbar) | Switch between scroll strip and page view |
| Single/double toggle (toolbar) | Toggle double-page spread |
| `T` | Toggle thumbnail strip |
| `?` | Keyboard shortcuts reference |
| Thumbnail strip | Jump to any page |

### Importing CBZ / ZIP files

1. Open the Library.
2. Click **Upload** (or use the popup's **Import** button).
3. Select one or more `.cbz` / `.zip` files.

Files are processed sequentially. Each card appears as soon as its file starts importing, with a live progress bar. The cover thumbnail appears as soon as the first page is stored.

After import, you can attach a source site to a gallery (shift-click the link button on its card) to enable **Download All** for missing pages.

### Download All

**Download All** fetches every page that isn't already cached. Existing pages are preserved — only missing ones are downloaded. Requires an API key for sites that need one.

### Export

The folder-down button on each card exports the gallery as a `.cbz` archive you can open in any comic reader.

---

## Storage

Images are stored in the browser's **IndexedDB** (not as files on disk). The popup's **Location** button shows the path to the IndexedDB folder on your system. Data persists across browser restarts but is tied to the browser profile.

To clear everything: Settings → **Clear All Cache**.

---

## Supported Sites

| Site | Auto-cache | Download All |
|---|---|---|
| nhentai.net | ✓ | ✓ (API key required) |

---

## Privacy

- No data is sent to any third party.
- API keys are stored locally in `chrome.storage.local` and only transmitted to their respective sites in requests you initiate.
- No analytics, no telemetry.

---

## Tech

- Manifest V3 service worker (`background.js`)
- IndexedDB for image storage (via `unlimitedStorage` permission)
- Content script (`content.js`) injected at `document_start` for zero-flash image replacement
- Prefetch window (±5 pages) keeps the reader cache warm ahead of navigation
- Pure HTML/CSS/JS — no build step, no dependencies
