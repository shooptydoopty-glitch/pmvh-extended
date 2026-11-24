    // --- Next-video mini-HUD ---
    // Mounts in document.fullscreenElement, not body: nothing outside it is visible in fullscreen.

    function getFullscreenRoot() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function ensureNextHudEl() {
        if (State.nextHudEl?.isConnected) return State.nextHudEl;
        const el = document.createElement('div');
        el.id = 'pmv-next-hud';
        el.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:2147483647;' +
            'display:flex;align-items:center;gap:12px;padding:10px 16px 10px 10px;' +
            'background:rgba(0,0,0,0.82);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);' +
            'border-radius:10px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 24px rgba(0,0,0,0.4);' +
            'pointer-events:none;opacity:0;transform:translateY(12px);' +
            'transition:opacity 220ms ease,transform 220ms ease;max-width:360px;';
        el.innerHTML =
            '<img style="width:72px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0;background:#1a1a1a;" alt="">' +
            '<div style="min-width:0;">' +
            '<div style="color:#fff;font-size:13px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;"></div>' +
            '<div style="color:rgba(255,255,255,0.6);font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;"></div>' +
            '</div>';
        State.nextHudEl = el;
        return el;
    }

    function showNextVideoHUD({ title, creator, thumbnail }, { duration = 4000 } = {}) {
        const root = getFullscreenRoot();
        if (!root) { return; }

        const el = ensureNextHudEl();
        if (el.parentElement !== root) root.appendChild(el);

        const [thumbEl, titleEl, creatorEl] = [el.querySelector('img'), el.querySelector('div > div:nth-child(1)'), el.querySelector('div > div:nth-child(2)')];
        thumbEl.src = thumbnail || '';
        titleEl.textContent = title || '';
        creatorEl.textContent = creator || '';
        creatorEl.style.display = creator ? '' : 'none';

        clearTimeout(State.nextHudHideTimer);
        el.style.opacity = '0';
        el.style.transform = 'translateY(12px)';
        void el.offsetWidth;  // reflow restarts the transition
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';

        State.nextHudHideTimer = setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(12px)';
        }, duration);
    }

    // Re-parent if the fullscreen element changes while visible.
    document.addEventListener('fullscreenchange', () => {
        if (!State.nextHudEl || State.nextHudEl.style.opacity === '0') return;
        const root = getFullscreenRoot() || document.body;
        if (State.nextHudEl.parentElement !== root) root.appendChild(State.nextHudEl);
    });

    // Playlist pages: the playlist's own Up Next; else the queue's next item (as N). A click dispatches N.
    function buildUpNextCard() {
        if (isPlaylistPage()) {
            const info = getUpNextVideoInfo();
            if (!info) return null;
            return upNextCardEl(info, () => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'n', code: 'KeyN', keyCode: 78, which: 78, bubbles: true
                }));
            });
        }
        syncQueueCursor();
        const next = smartQueueItems[queueCursor + 1];
        if (!next) return null;
        const meta = next.meta?.thumbnailUrl ? next.meta : resolveQueueMeta(next.id);
        if (!meta?.title && !meta?.thumbnailUrl) return null;
        return upNextCardEl(
            { title: meta.title || '', creator: meta.uploaderDisplay || '', thumbnail: meta.thumbnailUrl || '' },
            () => goToVideo(next.href, next.id),
        );
    }

    function upNextCardEl({ title, creator, thumbnail }, play) {

        const card = document.createElement('button');
        card.type = 'button';
        card.style.cssText = 'flex:0 0 180px;display:flex;flex-direction:column;align-items:stretch;' +
            'gap:6px;padding:8px;border-radius:10px;cursor:pointer;text-align:left;' +
            'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);';
        card.onmouseenter = () => { card.style.background = 'rgba(255,255,255,.09)'; card.style.borderColor = 'rgba(255,255,255,.2)'; };
        card.onmouseleave = () => { card.style.background = 'rgba(255,255,255,.05)'; card.style.borderColor = 'rgba(255,255,255,.1)'; };

        const label = document.createElement('div');
        label.dataset.pmvUnLabel = '1';
        label.textContent = 'UP NEXT';
        label.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:.06em;opacity:.45;';
        card.appendChild(label);

        const thumb = document.createElement('img');
        thumb.src = thumbnail;
        thumb.draggable = false;
        thumb.loading = 'eager';
        thumb.style.cssText = 'width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;display:block;background:#111;';
        card.appendChild(thumb);

        const titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.cssText = 'font-size:12px;font-weight:600;line-height:1.3;max-height:2.6em;overflow:hidden;color:rgba(255,255,255,.9);';
        card.appendChild(titleEl);

        if (creator) {
            const creatorEl = document.createElement('div');
            creatorEl.textContent = creator;
            creatorEl.style.cssText = 'font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            card.appendChild(creatorEl);
        }

        card.onclick = e => {
            e.stopPropagation();
            closeHud();
            play();
        };

        return card;
    }

    // "UP NEXT  8 left" label in the HUD's first row; only while the playing video is the queue's current item.
    function buildQueueProgressRow() {
        const left = queueRemaining();
        if (left === null) return null;
        const row = document.createElement('div');
        row.style.cssText = 'margin-left:auto;align-self:center;flex-shrink:0;display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:400;white-space:nowrap;';

        const label = document.createElement('span');
        label.textContent = 'UP NEXT';
        label.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:.06em;opacity:.45;';

        const count = document.createElement('span');
        count.textContent = left ? `${left} left` : 'last one';
        count.style.cssText = 'font-weight:700;color:rgb(253,186,116);font-variant-numeric:tabular-nums;';

        row.append(label, count);
        return row;
    }

    function showHud(opts = {}) {
        if (State.quietMode) return;
        closeHud();

        const videoId = getCurrentVideoId();
        ensureCurrentVideoData(videoId);
        const matches = getMatches(videoId);
        const meta = getMeta();

        const hud = document.createElement('div');
        hud.dataset.pmvHud = '1';
        State.hud = hud;
        hud.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);' +
            'width:98vw;max-width:1600px;background:rgba(0,0,0,0.82);backdrop-filter:blur(16px);' +
            'color:white;border-radius:14px;padding:14px;z-index:999999;' +
            'display:flex;flex-direction:column;' +
            'contain:layout style paint;pointer-events:auto;box-sizing:border-box;';

        // Separate from `hud` so the up-next card can sit beside it.
        const mainCol = document.createElement('div');
        mainCol.style.cssText = 'flex:1;min-width:0;';

        const actionBarClone = staleFullscreenHref ? buildApiActionBar(videoId) : buildNativeActionBarClone();
        if (actionBarClone) {
            actionBarClone.style.cssText = 'display:flex;flex-wrap:nowrap;gap:4px;flex-shrink:0;align-items:center;';
        } else if (!opts._retried) {
            // The auth-dependent action bar can still be hydrating on a fresh /video/ load: retry once.
            setTimeout(() => {
                if (State.hud === hud) showHud({ _retried: true });
            }, 700);
        }

        const metaBar = (() => {
            // Skipped while fullscreen is ahead of the page (previous video's numbers); rating/date come from data.
            if (staleFullscreenHref) return null;
            const spans = [...document.querySelectorAll('span')].filter(s =>
                /\d[.,]?\d*K?\s*views/i.test(s.textContent) ||
                /^\d{4}-\d{2}-\d{2}$/.test(s.textContent.trim())
            );
            if (!spans.length) return null;
            return spans[0].closest('.flex.flex-wrap.items-center') ||
                   spans[0].closest('.flex.items-center') || null;
        })();
        const cvd = State.currentVideoData;

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:16px;min-width:0;margin-bottom:4px;';
        const title = document.createElement('div');
        title.textContent = meta.title;
        title.style.cssText = 'flex:1;min-width:0;font-size:19px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        header.appendChild(title);
        if (actionBarClone) header.appendChild(actionBarClone);

        // Creator, rating, then the page's views/date/duration row; upload date from data only without that row.
        const sub = document.createElement('div');
        sub.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-bottom:10px;font-size:12px;color:rgba(255,255,255,.6);';
        const creator = document.createElement('span');
        creator.textContent = meta.creator ? 'by ' + meta.creator : '';
        creator.style.cssText = 'font-size:13px;color:rgba(255,255,255,.8);font-weight:500;';
        if (meta.creator) sub.appendChild(creator);
        if (cvd && cvd.bayesianRating !== null && cvd.bayesianRating !== undefined) {
            const ratingEl = document.createElement('span');
            ratingEl.textContent = '\u2605 ' + cvd.bayesianRating.toFixed(1) + '%';
            ratingEl.style.cssText = 'color:rgb(253,224,71);opacity:.85;';
            sub.appendChild(ratingEl);
        }
        if (metaBar) {
            const metaClone = metaBar.cloneNode(true);
            metaClone.removeAttribute('data-v-18f75d28');
            metaClone.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:12px;';
            sub.appendChild(metaClone);
        } else if (cvd?.uploadDate) {
            const dateEl = document.createElement('span');
            dateEl.textContent = cvd.uploadDate.slice(0, 10);
            sub.appendChild(dateEl);
        }

        // top5Tags if available, else tags; performers follow in the site's yellow.
        const activeTags = (cvd?.top5Tags?.length ? cvd.top5Tags : null) || meta.tags;
        const activeStars = meta.starsTags || [];

        // Each chip cycles the site-wide filter (cycleTagInFilter): orange = required, red ⊘ = excluded.
        const TAG_STYLE_BASE = 'font-size:12px;padding:4px 8px;border-radius:8px;cursor:pointer;user-select:none;';
        const TAG_STATE_STYLE = {
            include: 'background:rgba(249,115,22,.2);border:1px solid rgba(249,115,22,.55);color:rgb(253,186,116);',
            exclude: 'background:rgba(239,68,68,.2);border:1px solid rgba(239,68,68,.55);color:rgb(252,165,165);text-decoration:line-through;',
        };
        const TAG_STATE_TITLE = {
            null: 'Click: require in filter',
            include: 'Required in filter — click: exclude',
            exclude: 'Excluded in filter — click: remove from filter',
        };
        const makeTagSwitch = (el, tag, neutralStyle, render) => {
            el.dataset.pmvTagChip = tag;
            const paint = () => {
                const state = tagFilterState(tag);
                el.style.cssText = TAG_STYLE_BASE + neutralStyle + (TAG_STATE_STYLE[state] || '');
                el.title = TAG_STATE_TITLE[state];
                render(state);
            };
            paint();
            el.addEventListener('click', e => {
                e.stopPropagation();
                cycleTagInFilter(tag);
                paint();
            });
        };

        const tags = document.createElement('div');
        tags.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;';
        activeTags.forEach(tag => {
            const el = document.createElement('span');
            makeTagSwitch(el, tag, 'background:rgba(255,255,255,.08);border:1px solid transparent;',
                state => { el.textContent = (state === 'exclude' ? '⊘ ' : '') + tag; });
            tags.appendChild(el);
        });
        activeStars.forEach(star => {
            const el = document.createElement('span');
            el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/></svg>';
            const nameSpan = document.createElement('span');
            el.appendChild(nameSpan);
            makeTagSwitch(el, star, 'display:inline-flex;align-items:center;gap:4px;background:rgba(234,179,8,.14);border:1px solid rgba(234,179,8,.45);color:rgb(253,224,71);',
                state => { nameSpan.textContent = (state === 'exclude' ? '⊘ ' : '') + star; });
            tags.appendChild(el);
        });

        const playlistRow = document.createElement('div');
        playlistRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px;';

        if (!State.ready) {
            const loading = document.createElement('span');
            loading.textContent = 'Playlists loading...';
            loading.style.cssText = 'opacity:.55;font-size:12px;';
            playlistRow.appendChild(loading);
        } else {
            [...State.playlists.values()]
                .filter(pl => !(pl.id === rejectPlaylistId && actionBarClone))
                .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
                .forEach(playlist => {
                let active = matches.some(p => p.id === playlist.id);
                const btn = document.createElement('button');
                btn.type = 'button';

                const customStyle = getPlaylistStyle(playlist.name, playlist.id);
                const displayName = getPlaylistDisplayName(playlist.name, playlist.id);
                const colorHex = customStyle ? customStyle.color : FALLBACK_COLOR;
                const activeRgb = hexToRgbStr(colorHex);
                const inactiveRgb = mixToGrayStr(colorHex);

                const BTN_WIDTH = 'width:82px;box-sizing:border-box;text-align:center;overflow:hidden;text-overflow:ellipsis;display:inline-flex;align-items:center;justify-content:center;';
                // Inactive: near gray with a hint of the colour (mixToGrayStr).
                const STYLE_ACTIVE = `font-size:12px;font-weight:700;padding:5px 6px;border-radius:6px;cursor:pointer;background:rgba(${activeRgb},.24);border:2px solid rgba(${activeRgb},.9);color:rgb(${activeRgb});white-space:nowrap;${BTN_WIDTH}box-shadow:0 0 0 1px rgba(${activeRgb},.22) inset;`;
                const STYLE_INACTIVE = `font-size:12px;font-weight:400;padding:5px 6px;border-radius:6px;cursor:pointer;background:rgba(${inactiveRgb},.05);border:1px solid rgba(${inactiveRgb},.45);color:rgba(${inactiveRgb},.75);white-space:nowrap;${BTN_WIDTH}`;
                const STYLE_BUSY = `font-size:12px;font-weight:400;padding:5px 6px;border-radius:6px;cursor:default;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.3);white-space:nowrap;${BTN_WIDTH}`;

                // Label span plus hotkey cap, as under the player (syncPageBtnKey).
                const restyle = () => {
                    btn.textContent = '';
                    const lbl = document.createElement('span');
                    lbl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
                    lbl.textContent = displayName;
                    btn.appendChild(lbl);
                    btn.style.cssText = active ? STYLE_ACTIVE : STYLE_INACTIVE;
                    syncPageBtnKey(btn, playlist.id);
                };
                restyle();

                btn.onclick = async e => {
                    e.stopPropagation();
                    const vid = getCurrentVideoId();
                    if (!vid) return;
                    btn.disabled = true;
                    btn.style.cssText = STYLE_BUSY;
                    syncPageBtnKey(btn, playlist.id); // keeps the width
                    try {
                        if (active) { if (await removeFromPlaylist(vid, playlist.id)) active = false; }
                        else        { if (await addToPlaylist(vid, playlist.id))       active = true;  }
                    } finally {
                        restyle();
                        btn.disabled = false;
                    }
                    startHudTimer(5000);
                };

                playlistRow.appendChild(btn);
            });
        }

        mainCol.appendChild(header);
        mainCol.appendChild(sub);
        if (tags.children.length) mainCol.appendChild(tags);
        const descText = cvd?.description || meta.description;
        if (descText) {
            const desc = document.createElement('div');
            desc.textContent = String(descText).replace(/\s+/g, ' ').trim();
            desc.title = descText;
            desc.style.cssText = 'font-size:12px;color:rgba(255,255,255,.5);margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            mainCol.appendChild(desc);
        }
        mainCol.appendChild(playlistRow);


        const topRow = document.createElement('div');
        topRow.style.cssText = 'display:flex;gap:14px;align-items:flex-start;min-width:0;';
        topRow.appendChild(mainCol);
        const upNextCard = buildUpNextCard();
        if (upNextCard) topRow.appendChild(upNextCard);
        // Queue counter in the up-next card's label, else at the end of the subline.
        const queueRow = buildQueueProgressRow();
        const cardLabel = upNextCard?.querySelector('[data-pmv-un-label]');
        if (queueRow && cardLabel) {
            queueRow.style.marginLeft = '0';
            queueRow.firstElementChild?.remove();
            cardLabel.style.display = 'flex';
            cardLabel.style.justifyContent = 'space-between';
            cardLabel.style.alignItems = 'baseline';
            cardLabel.style.opacity = '1';
            cardLabel.innerHTML = '<span style="opacity:.45;">UP NEXT</span>';
            cardLabel.appendChild(queueRow);
        } else if (queueRow) sub.appendChild(queueRow);
        hud.appendChild(topRow);

        const thumbs = buildThumbs();
        if (thumbs) hud.appendChild(thumbs);

        (document.fullscreenElement || document.body).appendChild(hud);
        hud.addEventListener('mouseenter', () => clearTimeout(State.hudTimeout));
        hud.addEventListener('mouseleave', () => startHudTimer(1500));
        startHudTimer(3500);

        // Hard limit: hover only pauses the soft timeout, so this closes the HUD 5s after showing regardless.
        clearTimeout(State.hudHardTimeout);
        State.hudHardTimeout = setTimeout(closeHud, 5000);
    }

    // --- Progress bar ---

    function formatTime(sec) {
        return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    }

    function createProgressBar() {
        if (State.progressBar) return;

        const bar = document.createElement('div');
        State.progressBar = bar;
        bar.id = 'pmv-progress-bar';
        bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999999;pointer-events:none;';

        const track = document.createElement('div');
        track.style.cssText = 'position:relative;width:100%;height:2px;background:rgba(255,255,255,.08);';

        const played = document.createElement('div');
        played.style.cssText = 'height:100%;width:0%;background:rgba(255,255,255,.35);';

        const time = document.createElement('div');
        time.style.cssText = 'position:absolute;right:14px;bottom:5px;font-size:10px;color:rgba(255,255,255,.28);font-family:inherit;font-variant-numeric:tabular-nums;letter-spacing:.05em;';

        track.appendChild(played);
        bar.appendChild(track);
        bar.appendChild(time);

        // Own seek bar for when the site's controls stay hidden (e.g. after an in-place fullscreen hand-over);
        // no pointer events while the site's controls are visible.
        const zone = document.createElement('div');
        zone.id = 'pmv-scrub-zone';
        zone.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:' + SCRUB_ZONE_PX + 'px;pointer-events:none;cursor:pointer;';
        bar.appendChild(zone);
        let zoneHot = false;
        const setHot = on => {
            zoneHot = on;
            track.style.height = on ? '5px' : '2px';
            played.style.background = on ? 'rgba(249,115,22,.85)' : 'rgba(255,255,255,.35)';
        };
        zone.addEventListener('mouseenter', () => setHot(true));
        zone.addEventListener('mouseleave', () => setHot(false));
        const seekAt = clientX => {
            const v = getVideo();
            if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
            const r = zone.getBoundingClientRect();
            const pos = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
            try { v.currentTime = pos * v.duration; } catch {}
        };
        zone.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();  // site toggles play/pause on clicks reaching its player
            seekAt(e.clientX);
            Scrub.dragBar = zone;
            Scrub.dragSeek = true;
        });
        zone.addEventListener('click', e => e.stopPropagation());
        (document.fullscreenElement || document.body).appendChild(bar);

        let tick = 0;
        const sync = () => {
            const v = getVideo();
            if (v?.duration) {
                played.style.width = (v.currentTime / v.duration * 100) + '%';
                time.textContent = `${formatTime(v.currentTime)} / ${formatTime(v.duration)}`;
            }
            if ((tick++ & 7) === 0) {
                const site = document.querySelector('.controls-bar-wrapper');
                const siteGone = !site || site.classList.contains('controls-hidden');
                const want = siteGone ? 'auto' : 'none';
                if (zone.style.pointerEvents !== want) {
                    zone.style.pointerEvents = want;
                    if (!siteGone && zoneHot) setHot(false);
                }
            }
            State.progressRaf = requestAnimationFrame(sync);
        };
        sync();
    }

    function removeProgressBar() {
        if (State.progressRaf) cancelAnimationFrame(State.progressRaf);
        State.progressRaf = null;
        State.progressBar?.remove();
        State.progressBar = null;
    }

    // --- Fullscreen queue sidebar ---
    // Fullscreen on playlist pages hides the live right-hand column. Up Next and the queue scroller are
    // moved (never cloned: clones lose Vue handlers) into an overlay; the rest stays in place.

    const QUEUE_EDGE_ZONE_PX = 24;  // px from the right edge that reveals the sidebar
    const QUEUE_HIDE_DELAY_MS = 1000;  // grace period before hiding
    const QUEUE_SIDEBAR_WIDTH = 380;  // matches the normal grid column
    const QUEUE_SIDEBAR_MARGIN = 12;  // keeps rounded corners visible

    function isPlaylistPage() {
        return location.pathname.startsWith('/playlists/');
    }

    function findQueueParts() {
        // Wrapper via its inline height (clamp(...)), else the scrollable list's parent.
        const wrapper = [...document.querySelectorAll('div[style*="clamp("]')]
            .find(el => el.querySelector('.w-24.h-14')) ||
            [...document.querySelectorAll('.overflow-y-auto.custom-scrollbar')]
                .find(el => el.querySelector('[role="button"] .w-24.h-14'))?.parentElement ||
            null;
        if (!wrapper) return null;

        const scroller = wrapper.querySelector('.overflow-y-auto.custom-scrollbar');
        if (!scroller) return null;

        const upNext = [...wrapper.querySelectorAll('p')]
            .find(p => p.textContent.trim() === 'Up Next')?.parentElement || null;

        return { scroller, upNext };
    }

    function getActiveQueueRow() {
        // Active row (bg-[#272727] + border-orange-500): most stable hook without video IDs; shared with isCurrentPage.
        return document.querySelector('[role="button"].border-orange-500');
    }

    function getActiveQueueVideoId() {
        const row = getActiveQueueRow();
        return row ? resolveQueueItemVideoId(row) : null;
    }

    function scrollQueueSidebarToActive(overlayEl) {
        const scroller = overlayEl.querySelector('.overflow-y-auto.custom-scrollbar');
        const active = scroller?.querySelector('[role="button"].border-orange-500');
        if (!scroller || !active) return;
        // scrollTop directly: scrollIntoView follows the site's smooth scrolling and visibly flies into place.
        scroller.scrollTop = active.offsetTop - (scroller.clientHeight / 2) + (active.clientHeight / 2);
    }

    function showQueueSidebar() {
        if (State.queueSidebarVisible) { clearTimeout(State.queueHideTimer); return; }
        const fsEl = document.fullscreenElement;
        if (!fsEl || !isPlaylistPage()) return;

        const parts = findQueueParts();
        if (!parts) return;
        const { scroller, upNext } = parts;

        const overlay = document.createElement('div');
        overlay.dataset.pmvQueueOverlay = '1';
        overlay.style.cssText =
            `position:fixed;top:${QUEUE_SIDEBAR_MARGIN}px;right:${QUEUE_SIDEBAR_MARGIN}px;` +
            `bottom:${QUEUE_SIDEBAR_MARGIN}px;width:${QUEUE_SIDEBAR_WIDTH}px;max-width:90vw;` +
            'background:#141414;border-radius:14px;overflow:hidden;opacity:0.8;' +
            'box-shadow:-8px 0 24px rgba(0,0,0,0.5);z-index:999997;' +
            'display:flex;flex-direction:column;transition:transform 0.2s ease;transform:translateX(0);';
        State.queueOverlayEl = overlay;

        if (upNext) {
            State.queueUpNextEl = upNext;
            State.queueUpNextOrigParent = upNext.parentElement;
            State.queueUpNextOrigNext = upNext.nextSibling;
            overlay.appendChild(upNext);
        } else {
            State.queueUpNextEl = null;
        }

        State.queueScrollerEl = scroller;
        State.queueScrollerOrigParent = scroller.parentElement;
        State.queueScrollerOrigNext = scroller.nextSibling;
        overlay.appendChild(scroller);

        fsEl.appendChild(overlay);
        State.queueSidebarVisible = true;
        clearTimeout(State.queueHideTimer);

        // Direct, not via rAF: avoids a frame with the list at the top before it jumps.
        scrollQueueSidebarToActive(overlay);
    }

    function hideQueueSidebarNow() {
        clearTimeout(State.queueHideTimer);
        State.queueSidebarVisible = false;

        const restore = (el, parent, next) => {
            if (!el || !parent || !parent.isConnected) return;
            if (next && next.parentNode === parent) parent.insertBefore(el, next);
            else parent.appendChild(el);
        };
        restore(State.queueUpNextEl, State.queueUpNextOrigParent, State.queueUpNextOrigNext);
        restore(State.queueScrollerEl, State.queueScrollerOrigParent, State.queueScrollerOrigNext);

        State.queueOverlayEl?.remove();
        State.queueOverlayEl = null;
        State.queueUpNextEl = null;
        State.queueUpNextOrigParent = null;
        State.queueUpNextOrigNext = null;
        State.queueScrollerEl = null;
        State.queueScrollerOrigParent = null;
        State.queueScrollerOrigNext = null;
    }

    function scheduleHideQueueSidebar() {
        clearTimeout(State.queueHideTimer);
        State.queueHideTimer = setTimeout(hideQueueSidebarNow, QUEUE_HIDE_DELAY_MS);
    }

    document.addEventListener('mousemove', e => {
        if (!isPlaylistPage()) return;
        const inEdgeZone = document.fullscreenElement && e.clientX > window.innerWidth - QUEUE_EDGE_ZONE_PX;

        if (inEdgeZone) { showQueueSidebar(); return; }

        if (State.queueSidebarVisible) {
            const overEl = State.queueOverlayEl?.matches(':hover');
            if (!overEl) scheduleHideQueueSidebar();
            else clearTimeout(State.queueHideTimer);
        }
    });

    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            createProgressBar();
            // The playing video, not null: with null the next real change (e.g. N after entering fullscreen) is skipped.
            State.lastNextHudVideoId = getCurrentVideoId();
        } else {
            removeProgressBar(); closeHud(); hideQueueSidebarNow();
            State.lastNextHudVideoId = null;
        }
    });

    // --- Next-video notification ---
    function getQueueRowVisibleTitle(itemRoot) {
        const titleEl = itemRoot.querySelector('.flex-1.min-w-0 p, .flex-1.min-w-0 span, .flex-1.min-w-0');
        return titleEl?.firstChild?.nodeValue?.trim() ||
               titleEl?.childNodes?.[0]?.textContent?.trim() ||
               titleEl?.textContent?.trim() || '';
    }

    function resolveQueueItemVideoId(itemRoot) {
        // Visible title, not img.alt: Vue recycles nodes on virtual scroll, so alt lags.
        const visibleTitle = getQueueRowVisibleTitle(itemRoot);
        if (visibleTitle) return State.titleIndex.get(visibleTitle.toLowerCase()) || null;
        return null;
    }

    // N key: read the visible Up next preview synchronously, before Vue re-renders it.
    // The filter overlay (#pmvnf-upnext-overlay) wins: the native button still shows the filtered-out video.
    function getUpNextVideoInfo() {
        if (!isPlaylistPage()) return null;
        const upNextRoot = State.queueUpNextEl || findQueueParts()?.upNext;
        if (!upNextRoot) return null;

        const overlay = upNextRoot.querySelector('#pmvnf-upnext-overlay');
        if (overlay) {
            const title = overlay.querySelector('span')?.textContent?.trim() || '';
            if (!title) return null;
            const thumbnail = overlay.querySelector('img')?.src || '';
            const videoId = getVideoIdFromThumbUrl(thumbnail) || State.titleIndex.get(title.toLowerCase()) || null;
            return { key: videoId || thumbnail || title, title, creator: State.videoMeta.get(videoId)?.uploaderDisplay || '', thumbnail };
        }

        // .flex-1.min-w-0 holds two <p>'s: title, then creator.
        const textWrap = upNextRoot.querySelector('.flex-1.min-w-0');
        const [titleEl, creatorEl] = textWrap ? textWrap.querySelectorAll('p') : [];
        const title = titleEl?.textContent?.trim() || '';
        if (!title) return null;
        const thumbnail = upNextRoot.querySelector('img')?.src || '';
        const videoId = getVideoIdFromThumbUrl(thumbnail) || State.titleIndex.get(title.toLowerCase()) || null;
        return { key: videoId || thumbnail || title, title, creator: creatorEl?.textContent?.trim() || '', thumbnail };
    }

    function maybeShowNextVideoFromUpNext() {
        const info = getUpNextVideoInfo();
        if (!info) return;
        showNextVideoNotificationWithInfo(info, 'n-key-upnext');
    }

    // Single gate for the Mini-HUD; `key` dedupes (video id, else thumbnail URL or title).
    function showNextVideoNotificationWithInfo(info, source) {
        if (!document.fullscreenElement) return;
        if (!info?.title || !info.key || info.key === State.lastNextHudVideoId) return;
        State.lastNextHudVideoId = info.key;
        showNextVideoHUD({ title: info.title, creator: info.creator, thumbnail: info.thumbnail });
    }

    function showNextVideoNotificationFor(videoId, fallbackTitle, source) {
        if (!videoId) return;
        const meta = State.videoMeta.get(videoId);
        showNextVideoNotificationWithInfo({
            key: videoId,
            title: meta?.title || fallbackTitle || '',
            creator: meta?.uploaderDisplay || '',
            thumbnail: meta?.thumbnailUrl || '',
        }, source);
    }

    // Fallback if the console message disappears: the active queue row (border-orange-500).
    function maybeShowNextVideoNotification() {
        if (!document.fullscreenElement || !isPlaylistPage()) return;
        const row = getActiveQueueRow();
        if (!row) return;
        const videoId = resolveQueueItemVideoId(row);
        if (!videoId) return;
        showNextVideoNotificationFor(videoId, getQueueRowVisibleTitle(row), 'dom-fallback');
    }

    // --- HUD building blocks ---
    // API frames if available; else the page strip, unless fullscreen is ahead of the page (previous video's).
    function timelineFrames() {
        const data = State.currentVideoData;
        const id = getCurrentVideoId();
        if (data?.id && data.id === id && data.timelineThumbnails?.length) {
            return data.timelineThumbnails
                .filter(t => t?.url)
                .map(t => ({ src: t.url, time: Number.isFinite(t.captureTime) ? t.captureTime : null }));
        }
        if (staleFullscreenHref) return [];
        return [...document.querySelectorAll('.timeline-thumbnail-item')].map(item => {
            const img = item.querySelector('img');
            const label = item.querySelector('div:last-child')?.textContent?.trim() || img?.alt?.replace('Thumbnail at ', '') || '';
            return { src: pageImgSrc(img), time: parseTimestamp(label) };
        }).filter(x => x.src);
    }

    function buildThumbs() {
        const data = timelineFrames().slice(0, 10).map(f => ({ ...f, label: formatThumbTime(f.time) }));
        if (!data.length) return null;

        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;gap:8px;margin-top:12px;overflow-x:auto;overflow-y:hidden;padding-bottom:4px;max-width:100%;';

        data.forEach(item => {
            const box = document.createElement('button');
            box.type = 'button';
            box.style.cssText = 'flex:0 0 150px;border:0;padding:0;margin:0;background:transparent;cursor:pointer;position:relative;';

            const thumb = document.createElement('img');
            thumb.src = item.src;
            thumb.draggable = false;
            thumb.loading = 'eager';
            thumb.style.cssText = 'width:150px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;display:block;background:#111;';

            box.onclick = e => {
                e.stopPropagation();
                const v = getVideo();
                if (v && item.time !== null) v.currentTime = item.time;
            };

            box.appendChild(thumb);
            if (item.label) {
                const lbl = document.createElement('div');
                lbl.textContent = item.label;
                lbl.style.cssText = 'position:absolute;right:4px;bottom:4px;font-size:10px;color:white;background:rgba(0,0,0,.65);padding:2px 5px;border-radius:4px;pointer-events:none;';
                box.appendChild(lbl);
            }
            wrap.appendChild(box);
        });

        return wrap;
    }

    function closeHud() {
        clearTimeout(State.hudTimeout);
        clearTimeout(State.hudHardTimeout);
        State.hudHardTimeout = null;
        State.hud?.remove();
        State.hud = null;
    }

    function startHudTimer(ms) {
        clearTimeout(State.hudTimeout);
        State.hudTimeout = setTimeout(() => {
            if (!State.hud) return;
            State.hud.style.opacity = '0';
            State.hud.style.transition = 'opacity 0.25s';
            setTimeout(closeHud, 250);
        }, ms);
    }

    function buildNativeActionBarClone() {
        // Skipped while fullscreen is ahead of the page: those buttons belong to the previous video.
        if (staleFullscreenHref) return null;
        const nativeActionBar = findNativeActionBar();
        if (!nativeActionBar) return null;

        const cloneBar = document.createElement('div');
        cloneBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;';
        [...nativeActionBar.children].forEach(child => {
            if (child.id === 'pmv-page-playlists' || child.dataset?.pmvPlBtn) return;
            if (child.tagName !== 'BUTTON' && child.tagName !== 'A') return;

            const clone = child.cloneNode(true);
            // Strip Vue attributes to avoid duplicate handlers.
            clone.removeAttribute('data-v-18f75d28');
            clone.addEventListener('click', e => {
                e.stopPropagation();
                // Our own buttons (⊘, Tags) open their menus at the clone, not the hidden original.
                forwardedAnchor = { rect: clone.getBoundingClientRect(), at: performance.now() };
                child.click();
                startHudTimer(4000);
                // Snapshot clone: re-sync classes once Vue patched the original (again later for slow API toggles).
                const sync = () => {
                    if (!clone.isConnected) return;
                    clone.className = child.className;
                    if (child.title) clone.title = child.title;
                    if (child.dataset.on !== undefined) clone.dataset.on = child.dataset.on;
                    const label = child.getAttribute('aria-label');
                    if (label) clone.setAttribute('aria-label', label);
                };
                setTimeout(sync, 80);
                setTimeout(sync, 1500);
            });
            clone.style.cssText = (clone.style.cssText || '') + ';pointer-events:auto;';
            cloneBar.appendChild(clone);
        });

        return cloneBar.children.length ? cloneBar : null;
    }

    function buildApiActionBar(videoId) {
        if (!videoId) return null;
        const cvd = State.currentVideoData?.id === videoId ? State.currentVideoData : null;
        const st = { liked: !!cvd?.isLiked, disliked: !!cvd?.isDisliked, favorited: !!cvd?.isFavorited };
        const writeBack = () => {
            const d = State.currentVideoData;
            if (d?.id !== videoId) return;
            d.isLiked = st.liked; d.isDisliked = st.disliked; d.isFavorited = st.favorited;
        };

        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;';
        const buttons = {};
        const paint = () => API_BTNS.forEach(b => {
            const el = buttons[b.key];
            el.className = `${API_BTN_BASE} ${st[b.key] ? b.cls : API_BTN_OFF}`;
            el.title = b.title(st[b.key]);
        });

        API_BTNS.forEach(b => {
            const el = document.createElement('button');
            el.type = 'button';
            el.innerHTML = b.icon;
            el.style.cssText = 'pointer-events:auto;';
            buttons[b.key] = el;
            el.addEventListener('click', async e => {
                e.stopPropagation();
                startHudTimer(4000);
                if (el.disabled) return;
                const before = { ...st };
                const turnOn = !st[b.key];
                st[b.key] = turnOn;
                if (turnOn && b.key === 'liked') st.disliked = false;
                if (turnOn && b.key === 'disliked') st.liked = false;
                paint();
                el.disabled = true;
                try {
                    const res = await fetch(`/api/videos/${videoId}/${b.endpoint}`, {
                        method: 'PUT',
                        headers: { 'content-type': 'application/json', accept: 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ action: turnOn ? b.on : b.off }),
                    });
                    if (!res.ok) throw res.status;
                    const d = (await res.json().catch(() => null))?.data;
                    if (d && b.key !== 'favorited') {
                        if (typeof d.userHasLiked === 'boolean') st.liked = d.userHasLiked;
                        if (typeof d.userHasDisliked === 'boolean') st.disliked = d.userHasDisliked;
                    }
                    writeBack();
                } catch (err) {
                    Object.assign(st, before);
                    toast(`${b.endpoint[0].toUpperCase() + b.endpoint.slice(1)} failed${typeof err === 'number' ? ` (${err})` : ''}`, 'red');
                } finally {
                    el.disabled = false;
                    paint();
                }
            });
            bar.appendChild(el);
        });
        paint();
        // ⊘ and Tags for the video actually playing, first as under the video.
        try {
            const extra = [];
            if (rejectPlaylistId && State.playlists.has(rejectPlaylistId)) extra.push(rejectPageButton(videoId));
            extra.push(tagBarButton(videoId), tagBarButton(videoId, 'stars'));
            extra.reverse().forEach(el => { el.style.pointerEvents = 'auto'; bar.insertBefore(el, bar.firstChild); });
        } catch {}
        return bar;
    }
