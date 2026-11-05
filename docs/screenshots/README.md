# Screenshots

The images in this folder were taken in headless Chromium (Playwright) at 1440×900 with a device scale factor of 2, downscaled to at most 1600 px wide.

## How they were made

- The built `pmvh-extended.user.js` was injected at document start, like a userscript manager does, with the default Balanced performance mode.
- All requests that would change account data were blocked; only GET requests reached the site. Up next is stored in the browser only.
- Only videos tagged *Non-nude* are shown; other cards were hidden. A few saved videos were kept so playlist badges are visible, with their thumbnails blurred heavily. Other thumbnails are blurred lightly with injected CSS.
- The player shots use a safe video on a checked frame, left unblurred, as are its own timeline thumbnails in the HUD.
- Video titles, tags, performers, song titles, playlist names and a few uploader names were replaced with neutral demo text in the page before each screenshot (display only).
- Ads were hidden and every image was checked by hand before committing.

## Annotation style

Annotations are drawn in the page itself right before each screenshot, positioned from the target elements' bounding boxes, and removed afterwards.

- Highlight boxes: 2.5 px solid cyan `#22d3ee`, 8 px rounded corners, outer glow `0 0 0 4px rgba(34,211,238,.25)`.
- Numbered callouts: a filled cyan circle (24 px, black bold number) at the top-left corner of each box; the numbers match the legend in the README captions.
- Labels: a pill with a dark `#0b1220` background, cyan border and white 13.5 px text, next to the box or connected to it by a dashed leader line.
- Where the script's UI is small in the shot, the rest of the page is dimmed by 25–35 %.

`00-hero.png` is an HTML composition of three annotated screenshots, rendered at 2× and downscaled to 1600×800.
