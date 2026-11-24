# Screenshots

The images in this folder were taken in headless Chromium (Playwright) at 1440×900 with a device scale factor of 2, downscaled to at most 1600 px wide.

## How they were made

- The built `pmvh-extended.user.js` was injected at document start, like a userscript manager does, with the default Balanced performance mode.
- All requests that would change account data were blocked; only GET requests reached the site. Up next is stored in the browser only.
- Thumbnails, avatars and player frames are blurred heavily with injected CSS, and video streams were not loaded. Sponsored cards and content-warning labels were removed from the page.
- The player shots use a safe video on a checked frame, left unblurred, as are its own timeline thumbnails in the HUD; the fullscreen HUD shot shows that video filling the screen.
- Video titles, tags, song titles and uploader names were replaced with neutral demo text in the page before each screenshot, and the account's own playlist names in the API responses (display only).
- Search suggestions, chips and the cards in the quick menu got the same demo names and blurred thumbnails.
- Playlist hotkeys in the shots are letters (Q, W, E, S), not digits: digits seek within the video.
- Ads were hidden and every image was checked by hand before committing.

## HTML recreations

`00-hero.png`, `24-mini-checker.png`, `25-more-info.png` and `26-up-next-popout.png` are not screenshots: they are HTML recreations built from the script's own markup and CSS (the same Tailwind classes) with demo data and placeholder thumbnails, rendered in the same headless Chromium. The real pages show live titles, uploaders and playlist names that could not be neutralised reliably.

## Style

- Annotations are drawn in the page right before each screenshot, positioned from the target elements' bounding boxes: a 3.5 px orange `#f97316` box with a soft glow, a numbered orange badge at its top-left corner (the numbers match the README captions), and a spotlight that dims the rest of the shot. Where only a button is numbered, the panel it opens is kept out of the dimming.
- Each image is then placed on a dark backdrop with a colour glow per area (orange for playlists and Up next, red for filters, purple for `/playlists`, indigo for the player and HUD, green for settings and keys), with a short label and heading above it.
- Some older shots kept their original capture and had their annotations converted to this style.
