# PMVHaven Extended

A userscript for [PMVHaven](https://pmvhaven.com) that adds playlist tools, filters for videos and playlists, a fullscreen HUD, an "Up next" queue, remappable hotkeys and a seekbar preview.

Everything runs in your browser and uses PMVHaven's own API with your existing session. No accounts, servers or trackers are involved.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open **[pmvh-extended.user.js](https://raw.githubusercontent.com/shooptydoopty-glitch/pmvh-extended/main/pmvh-extended.user.js)**; your userscript manager offers to install it.
3. Reload PMVHaven and log in. Your playlists load in the background on first visit.

Updates are picked up automatically by the userscript manager.

## Features

### Playlists everywhere
- **Playlist badges** on video cards across the site, with the playlist names in the tooltip.
- **Playlist buttons** under the player on video pages: one click adds or removes the video. The site's own "Add to playlist" button lights up when the video is already saved.
- **Right-click menu** on any video card: toggle the video in each of your playlists, add it to Up next, open it in a new tab.
- **Reject list**: choose one playlist as your reject list. Adding a video there removes it from every other playlist, and rejected videos show in red. Cards get a one-click reject button.
- Playlists are cached locally and kept in sync across tabs; refresh any time with <kbd>R</kbd>.

### Video page
- **Recommended** sidebar with playlist badges, an *All / In playlist / Not in playlist* filter and "+ Up next" buttons. The *More from* grid gets badges too.
- **Watch history**: a video counts as watched at 85 % or when it ends. Used by the *Watched / Unwatched* filters.
- Players that come back empty after Back/Forward are repaired automatically.

### Fullscreen HUD
- Move the mouse to the bottom of the screen (or press <kbd>I</kbd>) for a panel with like/dislike/favourite, title, creator, rating, date, tags and performers, your playlist buttons, timeline thumbnails and the next item in Up next.
- **Click a tag** to require it in the filter; click again to exclude it, a third time to clear it.
- Up next keeps playing in fullscreen instead of dropping out to the page.
- On playlist pages, move the mouse to the right edge to slide in the queue.

### Seekbar preview
- A frame preview above the seek bar, in normal and fullscreen mode. Choose between a live frame cache, the site's timeline thumbnails only, or off.

### Up next queue
- Your own queue next to *Recommended*, also available from a header button.
- Add videos from cards, the right-click menu or a hotkey; drag to reorder; played items stay as history.
- **Auto-refill** from Recommended, ranked by how well the tags match your own playlists, optionally through your filter.
- **Fill from your playlists** by count, minimum rating, maximum length, unwatched only and tag.
- Survives reloads and navigation within the tab. <kbd>N</kbd> follows Up next while it has items.

### Site-wide video filter
Available from the funnel button in the header; applies to the home, browse, search and profile grids, Recommended and *More from*.
- Exclude or require terms in title, uploader, tags and performers (quoted phrases supported).
- Rating range, maximum length, watched/unwatched, in / not in selected playlists, and any of your saved searches.
- On/off switch with a count of hidden videos.
- Pagination helpers: larger pages, one continuous grid, paged mode while filtering, keep loading until enough results remain, skip near-empty pages.
- Quick *In playlist / Not in playlist* buttons on browse grids.

### Playlist pages (`/playlists/<id>`)
- The queue search searches **title, tags, performers and optionally the description**.
- A filter drawer over the queue: excluded and required tags, default terms that apply in every playlist, in / not in playlist, watched/unwatched, rating and duration sliders, saved search. Changes apply on <kbd>Enter</kbd> or *Filters*; an on/off switch keeps the settings.
- Search syntax: `-term`, `"two words"`, `!in`, `!out`, `!in:name`, `!out:name`, `!seen`, `!unseen`.
- **Filter-aware playback**: next and auto-advance skip hidden videos, and the *Up Next* preview shows the real next video.
- Sort the queue by site order, rating or upload date (ascending or descending); <kbd>N</kbd> follows the sort order.
- *Fetch all* loads the complete playlist and reports metadata coverage. Deep links (`?index=N`) open at the right video even beyond the first page.

### Playlist browser (`/playlists`)
- A *Filters* button in the page's tab row, with an on/off switch and a summary, opens an inline panel.
- Filter playlists **by the tags and performers of the videos inside them**, with optional share thresholds (for example: hide a playlist when more than 10 % of its videos have a tag).
- **Overlap badge** on every card: how many of its videos are already in your selected playlists, plus a range filter on that share — e.g. *0 % overlap* to find playlists with nothing you have saved yet.
- Hide filtered playlists or move them to the bottom. Tag data is cached per playlist and refreshed when its video count changes.

### Notifications
- Playlist badges per notification, a tag preview, and a button to select all notifications whose video you already saved.

### Hotkeys and command palette
- **Every hotkey is remappable** in a visual keyboard editor (*Settings → Assign hotkeys*): bind a key to a built-in action or to one of your playlists. Playlist keys toggle the video; pressing again within 3 seconds confirms a removal.
- <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> opens a **command palette** that searches cached videos and your playlists.
- Player keys (<kbd>Space</kbd>/<kbd>K</kbd>, <kbd>F</kbd>, <kbd>J</kbd>, arrows, <kbd>0</kbd>–<kbd>9</kbd>) keep working after in-site navigation and respect the site's *disable keyboard shortcuts* setting.

Default hotkeys:

| Key | Action |
|-----|--------|
| <kbd>I</kbd> | Show the HUD panel |
| <kbd>N</kbd> | Next video (Up next, or the playlist on playlist pages) |
| <kbd>M</kbd> | Toggle mute |
| <kbd>Z</kbd> | Set volume to 100 % |
| <kbd>R</kbd> | Refresh playlists |
| <kbd>?</kbd> | Show all hotkeys |

### Settings and backup
- A **PMVHaven Extended** section inside the site's own *Settings* dialog (gear icon in the header): seekbar preview, reject list, volume lock, hotkey editor.
- **Export / import** all settings as JSON (copy, download, or load a file).

## Privacy

All settings, caches and the watch history are stored in your browser's `localStorage`. The script only talks to `pmvhaven.com`, using the session you are already logged in with.

## Development

The userscript is built from the files in `src/`:

```sh
node build.js   # writes pmvh-extended.user.js
```

| File | Contents |
|------|----------|
| `src/header.js` | Userscript metadata |
| `src/core.js` | Shared namespace and startup helpers |
| `src/filter.js` | Playlist-page filter and the `/playlists` browser filter |
| `src/hud.js` | Playlist cache, badges, HUD, Up next, site-wide filter, settings, hotkeys, seekbar preview |
| `src/browse.js` | In / not-in-playlist buttons on browse grids |

Bug reports and pull requests are welcome.

## License

[MIT](LICENSE)
