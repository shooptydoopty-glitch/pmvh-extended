<div align="center">

<img src="docs/screenshots/00-hero.png" alt="PMVH Extended — playlists, filters and a fullscreen HUD for PMVHaven" width="100%">

<br>

<a href="https://raw.githubusercontent.com/shooptydoopty-glitch/pmvh-extended/main/pmvh-extended.user.js"><img alt="Install PMVH Extended" src="https://img.shields.io/badge/Install-userscript-f97316?style=for-the-badge"></a>
&nbsp;
<a href="#a-quick-tour"><img alt="Take the tour" src="https://img.shields.io/badge/Take_the_tour-1f1f1f?style=for-the-badge"></a>

<sub>Works with Tampermonkey and Violentmonkey · MIT licensed · Unofficial, not affiliated with PMVHaven</sub>

</div>

<br>

> **New in 1.2.87:** a playlist score from your own filters · a playlist check on video pages · *More about this video* on playlist pages · Up next from the header on any page · separate model filters · the tag menu on every card's tags.

**PMVH Extended** turns [PMVHaven](https://pmvhaven.com) into a proper playlist tool. See at a glance what you have already saved, add videos in one click, line up what plays next, and filter videos and playlists by their tags — all inside the site you already use, styled to fit right in.

<table>
<tr>
<td width="33%" valign="top"><b>Playlists everywhere</b><br>Badges on every card, one-click playlist buttons under the player, favourites and your playlists in the sidebar.</td>
<td width="33%" valign="top"><b>Fullscreen HUD</b><br>Title, tags, playlists and timeline at the bottom of the screen — without leaving fullscreen.</td>
<td width="33%" valign="top"><b>Up next queue</b><br>Your own queue next to Recommended, auto-refilled with videos that match your taste.</td>
</tr>
<tr>
<td valign="top"><b>Filter by tags</b><br>Hide videos and even whole playlists by tags, models, rating, length or watch status — and see what was hidden, and why. Playlists get a score for how well they fit.</td>
<td valign="top"><b>Better playlist pages</b><br>Search tags and performers in the queue, sort it, skip filtered videos while playing, and open the video's models and playlists in place.</td>
<td valign="top"><b>Tags and models in one click</b><br>Vote on a video's tags and models, or add new ones, from a compact menu. Remappable hotkeys and <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> too.</td>
</tr>
</table>

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open **[pmvh-extended.user.js](https://raw.githubusercontent.com/shooptydoopty-glitch/pmvh-extended/main/pmvh-extended.user.js)** — your userscript manager offers to install it.
3. Reload PMVHaven and log in. Your playlists load in the background on the first visit.

Updates arrive automatically through your userscript manager.

## A quick tour

### Your playlists, everywhere

Every video shows whether it is already in one of your playlists, and adding or removing it takes one click — under the player or on any card.

![Playlist buttons under the player](docs/screenshots/03-playlist-buttons.png)
*① Reject, Tags and Models, right in the site's own button row. ② Your playlists: one click adds or removes the video; a playlist with a hotkey shows its key. ③ The site's own Add to playlist button lights up when the video is saved.*

<table>
<tr>
<td width="50%" valign="top"><img src="docs/screenshots/04-recommended.png" alt="Recommended with playlist badges"><br><sub>① All / In playlist / Not in playlist. ② Playlist badge on saved videos. ③ Play next, add to a playlist, add to favourites. ④ Reject, in the corner of the thumbnail.</sub></td>
<td width="50%" valign="top"><img src="docs/screenshots/20-tag-menu.png" alt="Compact tag menu"><br><sub>① The tag menu: the video's tags with their votes (click to upvote, again to take it back), recent tags, and autocomplete for new ones. Tags your filter excludes show in red. The same menu exists for models.</sub><br><br><img src="docs/screenshots/19-sidebar.png" alt="Saved content in the sidebar" width="220"><br><sub>① <i>Saved content</i> in the site's sidebar: your favourites and every playlist, with its size.</sub></td>
</tr>
</table>

<details>
<summary>More</summary>

- Badges on the home, browse, search and profile grids, *Recommended*, *More from* and notifications.
- **Notifications**: an Up next button on every video notification; *✓ In playlist* selects the ones you already saved, *✓ Mark read* marks the selected unread ones as read.
- **Favourites from any card**: the heart on a card adds or removes the video from your site favourites without opening it, and is filled when the video is already a favourite.
- **Add to several playlists at once**: the playlist menu on a card stays open after each pick; click next to it to close it.
- **Reject list**: pick one playlist as your reject list. Adding a video there removes it from every other playlist; rejected videos show in red. Cards get a ⊘ in the corner of the thumbnail, and the player a ⊘ in its button row. While a filter is on, a card asks for a second click first.
- **Tag after reject**: after a reject, a small menu asks why — add a tag to the video on the site in a few keystrokes (can be turned off).
- **Tags and models**: the site's *Vote on Tags* opens the compact menu instead (<kbd>Shift</kbd>+click for the original); a second menu does the same for models.
- On playlist pages the button row also gets *open in a new tab* for the video that is playing.
- Saving, removing or rejecting never makes a card vanish under your cursor: filters pick the change up the next time you apply them.
- **Watch history**: a video counts as watched at 85 % or when it ends — usable in the filters.
- Playlists are cached locally and kept in sync across tabs; refresh any time with <kbd>R</kbd>.
- Players that come back empty after Back/Forward are repaired automatically.

</details>

### A HUD for fullscreen

Move the mouse to the bottom of the screen — or press <kbd>I</kbd> — and everything about the video is there: title, rating, tags and performers, your playlist buttons, the timeline and what plays next. Click a tag to require it in your filter, click again to exclude it.

![Fullscreen HUD](docs/screenshots/07-fullscreen-hud.png)
*① The button row, including reject, tags and models. ② Click a tag to require, exclude or clear it in the filter. ③ Playlist buttons, with their hotkeys. ④ Timeline thumbnails. With an Up next queue, how many videos are left sits on the right.*

A frame preview follows the mouse along the seek bar, in normal and fullscreen mode.

![Seekbar preview](docs/screenshots/06-seekbar-preview.png)
*① Frame preview while you hover the seek bar.*

<details>
<summary>More</summary>

- Up next keeps playing in fullscreen instead of dropping you back to the page.
- On playlist pages, move the mouse to the right edge to slide in the queue.
- The seekbar preview uses the site's timeline thumbnails; an optional live mode builds a denser frame cache in the background.

</details>

### Up next, your way

Line up videos from any card or with a hotkey. The queue lives next to *Recommended* and in the header, survives reloads, and <kbd>N</kbd> follows it.

<table>
<tr>
<td width="50%" valign="top"><img src="docs/screenshots/05-up-next.png" alt="Up next queue next to the player"><br><sub>① The Up next queue sits above Recommended; rows show your playlists, and why your filter would hide a video. ② Clear the videos you already played (a second click confirms, then an Undo toast). ③ Bring back an earlier queue — cleared or replaced queues are kept for 14 days.</sub></td>
<td width="50%" valign="top"><img src="docs/screenshots/26-up-next-popout.png" alt="Up next from the header"><br><sub>① Up next in the header, with the number of queued videos. ② The same queue on any page; play a video from it and Up next docks next to the player.</sub></td>
</tr>
</table>

<details>
<summary>More</summary>

- **Auto-refill** from Recommended, ranked by how well the tags match your own playlists, optionally through your filter.
- **Fill from your playlists** by count, minimum rating, maximum length, unwatched only and tag.
- Drag to reorder; played items stay as history (*Show more* for older ones), and the filter never removes anything from the queue.
- **Saved queues**: save Up next under a name and load or append it later, even after a restart.
- A fresh page load every 20 videos (10 in fullscreen, adjustable or off) keeps long sessions light; fullscreen resumes with one click or key.

</details>

### Filter what you see

One filter for the whole site, from the funnel in the header: exclude or require terms in titles, uploaders, tags and performers, hide or keep only videos with a content flag (nudity, gay, trans, extreme and more), and narrow by rating, length, watch status, playlists or one of your saved searches.

<img src="docs/screenshots/01-header.png" alt="Header buttons" width="620">

*① How many videos the filter hides on this page — click for the list. ② Site-wide video filter. ③ Up next, with the number of queued videos.*

<img src="docs/screenshots/21-hidden-list.png" alt="Videos hidden by the filter, grouped by reason" width="448">

*Everything the filter hid on this page, grouped by reason; open a group to see the videos.*

![Video grid with playlist badges and filter buttons](docs/screenshots/16-browse-grid.png)
*① Right in the site's own filter menu: only videos in, or not in, your playlists — and which playlists count. It applies with the site's* Apply *and is stored with your saved filters. ② Playlist badge on saved videos. ③ Open in a new tab, play next, add to a playlist, add to favourites. ④ Reject.*

Your saved searches sit right next to *More Filters*, and on the homepage the site's filters, page and scroll position come back when you return with Back.

<details>
<summary>The filter panel</summary>

![Site-wide filter panel](docs/screenshots/02-filter-panel.png)
*① The funnel in the header opens the filter. ② On/off switch. ③ Content flags: click to hide, again for only these, again to clear. ④ Copy the filter from the playlist pages.*

- Terms, content flags, rating, length, playlists, watched status and one of your saved searches; an on/off switch keeps your settings.
- Models have their own *Exclude models* / *Require models* lists; plain terms match titles, uploaders, tags and music.
- Content flags are the site's own (Nudity, Gay, Trans, Extreme, Voice-over, Remix, Promo, Seizure warning) plus Funscript, Vertical and Music. Flags a list does not include are looked up in batches of 100 and remembered; a video whose flag is still unknown is never hidden.
- Put a term in quotes, or click it, to match only the whole word: `"ch"` no longer hits *challenge*.
- Click a tag, star or song under the player to require or exclude it in the filter (the quick menu).
- In / not in playlist is ignored on a playlist's own page and on your favourites, where it would hide everything.
- Pagination helpers: larger pages, one continuous grid, paged mode while filtering, keep loading until enough results remain, skip near-empty pages.

</details>

### Search with more control

The site's search box in the header gets a panel right below it. Choose where to search — everything, titles only, tags, stars, creators or music — and pick from the site's own suggestions as you type. Every pick becomes a chip: click it to exclude instead of require. Sort, length, rating, quality, aspect ratio and upload date sit in a fold-out *Filters* row, and your recent searches are one click away.

- <kbd>Tab</kbd> switches where to search, <kbd>↑</kbd>/<kbd>↓</kbd> and <kbd>Enter</kbd> pick a suggestion, <kbd>Backspace</kbd> in an empty box removes the last chip.
- Shortcuts while typing: `#tag`, `*star`, `@creator`; a leading `-` excludes (`-#tag`).
- Results open on the site's own search page, so its own filters keep working on top.

**Quick menu.** Clicking a tag, star or song under the player — or a tag or song chip on any video card — opens a small menu instead of leaving the page: require or exclude it in the filter, go on to the search results (or the star's profile) as usual, and browse its videos right there — in the site's own card style, with playlist badges, watched marks, an Up next button on each and more as you scroll. <kbd>Ctrl</kbd>/<kbd>⌘</kbd>-click still follows the link.

<table>
<tr>
<td width="60%" valign="top"><img src="docs/screenshots/22-header-search.png" alt="Search panel under the site's search box"><br><sub>① Where to search. ② Picks become chips: amber is required, red is excluded; click to switch. ③ Suggestions from the site, with how often they are used; ⊘ excludes. ④ Filters, summed up next to the button.</sub></td>
<td width="40%" valign="top"><img src="docs/screenshots/23-quick-menu.png" alt="Quick menu for a tag under the player"><br><sub>① A tag, star or song under the player. ② Require or exclude it in the filter. ③ Where the chip normally leads. ④ Sort its videos (and for a song: this song or the whole artist). ⑤ Its videos, with Up next on hover.</sub></td>
</tr>
</table>

### Playlist pages that keep up

The queue search finally looks at **tags, performers and descriptions**, not just titles. A filter drawer slides over the queue, playback skips whatever you filtered out, and the queue can be sorted by rating or upload date.

<table>
<tr>
<td width="50%" valign="top"><img src="docs/screenshots/12-playlist-queue.png" alt="Playlist queue with search, filters and sort"><br><sub>① Sort the queue. ② Search titles, tags and performers. ③ Apply the filters; the badge counts the active ones.</sub></td>
<td width="50%" valign="top"><img src="docs/screenshots/13-playlist-filters.png" alt="Filter drawer over the queue"><br><sub>① The filter drawer over the queue. ② Content flags, as in the site-wide filter. <i>Sync from site filter</i> copies the site-wide filter into it.</sub></td>
</tr>
</table>

**More about this video.** Under the playing video, one click opens what the video page would show: its models, the playlists it is in (with the playlist check below) and more from the uploader — without leaving the playlist.

<img src="docs/screenshots/25-more-info.png" alt="More about this video on a playlist page" width="620">

*① More about this video, under the player. ② Models. ③ Playlists with this video, with overlap and score. ④ More from the uploader, with playlist badges and card buttons.*

<details>
<summary>More</summary>

- Drawer: excluded and required tags, default terms that apply in every playlist, in / not in playlist (the playlist you are viewing does not count), watched/unwatched, content flags, rating and duration sliders, saved search. Changes apply on <kbd>Enter</kbd> or *Filters*.
- Search syntax: `-term`, `"two words"`, `=word` (whole word), `!in`, `!out`, `!in:name`, `!out:name`, `!seen`, `!unseen`.
- **Filter-aware playback**: next and auto-advance skip hidden videos, and the *Up Next* preview shows the real next video. <kbd>N</kbd> follows the sort order.
- *Fetch all* loads the complete playlist; deep links (`?index=N`) open at the right video even beyond the first page.

</details>

### Find playlists worth your time

On `/playlists`, filter playlists **by what is inside them**: hide a playlist when more than, say, 10 % of its videos carry a tag you don't like. Every card shows how many of its videos you already have — so *0 % overlap* means nothing but new videos.

Each scanned playlist also gets a **score**: the share of its videos that pass your filters (green 70+, yellow 40+, red below), so you can see how well it fits before you open it.

![Playlist browser with overlap badges](docs/screenshots/14-playlists-browser.png)
*① Filters button with on/off and a summary. ② Overlap with your own playlists on every card. ③ Score from your filters. Hover a card to follow the playlist straight from it.*

![Playlist filter panel](docs/screenshots/15-playlists-filter-panel.png)
*① Exclude a tag above a share of the videos; the count shows how many playlists on the page it removes. ② Scan page / Auto-scan. ③ Result. ④ Your playlist counted for the overlap badge. ⑤ Sort by score, best first. ⑥ Filter by playlist size, and by how many videos you don't have yet.*

**On video pages too.** *Playlists with this video* gets a Scan button: it shows how much of each playlist you already have, its score, and which ones fail your filters — handy for finding the next playlist to follow.

<img src="docs/screenshots/24-mini-checker.png" alt="Playlist check on a video page" width="620">

*① Scan, with the result next to it. ② Overlap with your playlists. ③ The site's video count turns purple: in your playlists / total. ④ Score; ⊘ marks a playlist that fails your filters (⑤, dimmed).*

<details>
<summary>More</summary>

- Hide filtered playlists or move them to the bottom; optionally match playlist descriptions too.
- Tag data is fetched **only when you press *Scan page*** — or automatically with *Auto-scan*. Playlists with more than 300 videos are sampled (first, last and a few pages in between, about 300 videos) so even huge playlists scan quickly; a ≈ on the card marks a sample, and clicking it scans that playlist in full.
- Results are cached and refreshed once a playlist's video count changes by more than 10 %.
- Every filter shows how many playlists it removes, so it is easy to see which one hides too much.

</details>

### Keyboard first

Every hotkey is remappable in a visual editor — bind a key to an action or straight to one of your playlists. The editor shows the defaults and the site's own shortcuts, so nothing gets overwritten by accident. <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> searches your playlists, cached videos and actions from anywhere.

<table>
<tr>
<td width="50%" valign="top"><img src="docs/screenshots/10-hotkey-editor.png" alt="Visual hotkey editor"><br><sub>① Click a key to bind it. ② The action or playlist for that key. ③ Defaults for reference.</sub></td>
<td width="50%" valign="top"><img src="docs/screenshots/08-command-palette.png" alt="Command palette"><br><sub>① <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> anywhere. ② Actions. ③ Your playlists. ④ Cached videos.</sub><br><br><img src="docs/screenshots/11-hotkey-overview.png" alt="Hotkey overview"><br><sub>① Press <kbd>?</kbd> for every hotkey.</sub></td>
</tr>
</table>

| Default key | Action |
|-----|--------|
| <kbd>I</kbd> | Show the HUD |
| <kbd>N</kbd> | Next video (Up next, or the playlist on playlist pages) |
| <kbd>M</kbd> | Toggle mute |
| <kbd>Z</kbd> | Volume to 100 % |
| <kbd>R</kbd> | Refresh playlists |
| <kbd>?</kbd> | Show all hotkeys |

Player keys (<kbd>Space</kbd>/<kbd>K</kbd>, <kbd>F</kbd>, <kbd>J</kbd>, arrows, <kbd>0</kbd>–<kbd>9</kbd>) keep working after in-site navigation and respect the site's *disable keyboard shortcuts* setting.

### Make it yours

Quick options live in a **PMVH Extended** section inside the site's own *Settings* dialog (the gear in the header); the bigger ones sit on the site's full **Settings** page.

<table>
<tr>
<td width="50%" valign="top"><img src="docs/screenshots/09-settings.png" alt="PMVH Extended section in the site's Settings dialog"><br><sub>① Performance mode. ② Seekbar preview source. ③ Volume lock. ④ Reject list. ⑤ Tag after reject. ⑥ A shortcut to the full settings page.</sub></td>
<td width="50%" valign="top"><img src="docs/screenshots/18-full-settings.png" alt="PMVH Extended on the site's full Settings page"><br><sub>① Hotkey editor. ② Short names and colours for your playlists. ③ Hide sidebar items you never use. ④ Settings backup.</sub></td>
</tr>
</table>

<details>
<summary>Performance modes</summary>

| Mode | Page updates | Visual effects | Background requests | Live seekbar preview |
|------|--------------|----------------|---------------------|----------------------|
| Smooth | every frame | on | 3 at a time | available |
| Balanced (default) | batched (≈8/s) | on | 3 at a time | available |
| Light | ≈2–3/s | off — also the site's blur and animations | 1 at a time | off |

</details>

- **Volume lock** keeps the player unmuted at 100 % (off by default).
- **Playlist names & colours**: give long playlist names a short label for the buttons, badges and sidebar, and pick their colour.
- **Sidebar**: hide any item or group of the site's sidebar.
- **Export / import** all settings as JSON — copy, download or load a file.

## Privacy and fair use

Everything runs in your browser. Settings, caches and watch history stay in `localStorage`; the script only talks to `pmvhaven.com`, with the session you are already logged in with. No accounts, servers or trackers.

PMVH Extended is built to be light on PMVHaven's servers: requests follow your own actions where possible, results are cached, duplicate requests are shared and rate limits (HTTP 429) are respected. Heavier background work — the live seekbar preview and automatic tag scanning on `/playlists` — is opt-in.

## Development

The userscript is built from `src/` with no dependencies:

```sh
node build.js   # writes pmvh-extended.user.js
```

| File | Contents |
|------|----------|
| `src/header.js` | Userscript metadata |
| `src/core.js` | Shared namespace, startup and performance helpers |
| `src/filter/` | Playlist-page filter (`01`–`05`), the `/playlists` filter (`06`) and the playlist check on video pages (`07`) |
| `src/hud/` | Playlist cache and API (`01`–`02`), settings, hotkey editor and palette (`03`–`05`), Up next (`06`–`07`), player, HUD and playlist buttons (`08`–`10`), site-wide filter (`11`), homepage and pagination (`12`), badges and *More about this video* (`13`), notifications and menus (`14`–`15`), seekbar preview (`16`), hotkeys, reject and tag popup (`17`), startup (`18`) |
| `src/browse.js` | In / not-in-playlist filter in the site's filter menu, stored with saved filters |
| `src/search.js` | Search panel under the site's search box |
| `src/tagmenu.js` | Menu for tag, star and music chips |

The files in `src/filter/` and `src/hud/` are joined in file-name order inside one function each, so they share their top-level names. The script runs as one file because userscript managers install one file.

Bug reports and pull requests are welcome. How the screenshots were made is described in [docs/screenshots](docs/screenshots/README.md).

## Disclaimer

PMVH Extended is an independent, unofficial project. It is not affiliated with, endorsed by or supported by PMVHaven; "PMVHaven" is a trademark of its owners. Use it at your own risk and respect the site's [terms](https://pmvhaven.com/terms).

## License

[MIT](LICENSE)
