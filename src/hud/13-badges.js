    // --- Badges ---

    function scheduleBadges() {
        if (State.quietMode || State.observerPaused || State.badgeScheduled) return;
        State.badgeScheduled = true;
        const run = () => {
            State.badgeScheduled = false;
            addBadges();
            addQueueBadges();
            addRecommendedBadges();
            addNotificationBadges();
            attachFilterButton();
            applyFilterToCards();
            // Self-heal the Up next panel after a re-render; only when missing, as rebuilding interrupts a drag.
            if (smartQueueItems.length && !document.getElementById('pmv-queue-sidebar')) {
                try { renderQueueSidebar(); } catch {}
            }
            syncSitePrefs();
            mergeListChunks();
            // Own pruning shrinks the list too; don't count it as site trimming.
            if (pruneFilteredFromSiteList()) pumpState.lastCards = 0;
            topUpList();
            skipThinPage();
        };
        if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
        else setTimeout(run, 250);
    }


    // Reject ✕ on a card, only while a reject list is set; red when rejected.
    // With a card filter active it takes a second click within REJECT_ARM_MS.
    const REJECT_ARM_MS = 3000;
    // Buttons match the site's "+N" tag button; the ✕ goes top-left in the thumbnail, above the site's badges.
    const CARD_ICON = {
        external: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
        queueAdd: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 6H3"/><path d="M12 12H3"/><path d="M12 18H3"/><path d="M18 12v7"/><path d="M14.5 15.5h7"/></svg>',
        plus: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
        upNext: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5v11L10 12z"/><path d="M11 6.5v11l7.5-5.5z"/><path d="M21 6.5v11"/></svg>',
    };
    function ensureCardBtnStyle() {
        if (document.getElementById('pmv-cardbtn-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-cardbtn-style';
        st.textContent = `
.pmv-cardbtn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:26px;min-width:34px;padding:0 8px;
  border-radius:8px;border:1px solid rgba(55,65,81,.3);background:rgba(31,41,55,.3);color:rgb(156,163,175);font-family:inherit;font-size:12px;
  font-weight:600;line-height:1;cursor:pointer;flex-shrink:0;transition:color .15s,background .15s,border-color .15s;vertical-align:middle;}
.pmv-cardbtn:hover{color:rgb(253,186,116);background:rgba(249,115,22,.2);border-color:rgba(249,115,22,.4);}
.pmv-cardbtn svg{width:14px;height:14px;flex-shrink:0;}
.pmv-cardbtn[data-kind="open"]{color:rgba(255,255,255,.85);background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.22);}
.pmv-cardbtn[data-kind="open"]:hover{color:#fff;background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.4);}
.pmv-cardbtn[data-kind="queue"], .pmv-cardbtn[data-kind="playlists"]{color:rgb(134,239,172);background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.3);}
.pmv-cardbtn[data-kind="queue"]:hover, .pmv-cardbtn[data-kind="playlists"]:hover{color:rgb(187,247,208);background:rgba(34,197,94,.2);border-color:rgba(34,197,94,.5);}
.pmv-cardbtn[data-kind="queue"]{position:relative;}
.pmv-cardbtn[data-kind="queue"][data-on="1"]{color:rgb(100,255,0);background:rgba(34,197,94,.24);border-color:rgba(100,255,0,.6);}
.pmv-cardbtn[data-kind="queue"][data-on="1"]::after{content:attr(data-qpos);position:absolute;top:-7px;right:-7px;min-width:15px;height:15px;padding:0 3px;box-sizing:border-box;
  border-radius:8px;background:rgb(100,255,0);color:#000;font-size:10px;font-weight:700;line-height:15px;text-align:center;pointer-events:none;}
.pmv-cardbtn[data-kind="fav"]{color:rgba(${FAV_RGB},.75);background:rgba(${FAV_RGB},.06);border-color:rgba(${FAV_RGB},.25);}
.pmv-cardbtn[data-kind="fav"]:hover{color:rgb(${FAV_RGB});background:rgba(${FAV_RGB},.14);border-color:rgba(${FAV_RGB},.45);}
.pmv-cardbtn[data-kind="fav"][data-on="1"]{color:rgb(${FAV_RGB});background:rgba(236,72,153,.28);border-color:rgba(236,72,153,.6);}
.pmv-cardbtn[data-kind="fav"][data-on="1"]:hover{background:rgba(236,72,153,.3);}
.pmv-cardbtn[data-rec="1"]{margin:2px 4px 0 0;}
.pmv-thumbx{position:absolute;top:.75rem;left:.75rem;z-index:21;display:inline-flex;align-items:center;gap:4px;padding:.25rem .625rem;border-radius:.5rem;
  font-family:inherit;font-size:12px;font-weight:700;line-height:1rem;cursor:pointer;color:rgb(241,245,249);border:1px solid rgba(100,116,139,.5);
  background:linear-gradient(to right,rgba(51,65,85,.95),rgba(30,41,59,.95));box-shadow:0 10px 15px -3px rgba(0,0,0,.3);transition:background .15s,border-color .15s;}
.pmv-thumbx:hover{border-color:rgba(${REJECT_RGB},.7);}
.pmv-thumbx[data-on="1"]{color:#fff;border-color:rgba(${REJECT_RGB},.7);background:linear-gradient(to right,rgba(220,38,38,.92),rgba(153,27,27,.92));}
.pmv-thumbx[data-armed="1"]{color:#fff;border-color:rgb(${REJECT_RGB});background:rgb(220,38,38);}
.pmv-thumbx[data-small="1"]{top:5px;left:5px;width:20px;height:20px;padding:0;justify-content:center;border-radius:9999px;font-size:10px;line-height:1;
  color:rgba(255,255,255,.8);background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.12);box-shadow:none;opacity:.55;transition:opacity .15s,background .15s;}
a:hover .pmv-thumbx[data-small="1"], .group:hover .pmv-thumbx[data-small="1"], div:hover > .pmv-thumbx[data-small="1"], .pmv-thumbx[data-small="1"]:hover{opacity:1;}
.pmv-thumbx[data-small="1"]:hover{background:rgba(220,38,38,.85);border-color:transparent;color:#fff;}
.pmv-thumbx[data-small="1"][data-on="1"]{opacity:1;color:#fff;background:rgba(220,38,38,.75);border-color:transparent;}
.pmv-thumbx[data-small="1"][data-armed="1"]{opacity:1;width:auto;padding:0 8px;border-radius:.5rem;color:#fff;background:rgb(220,38,38);}
[data-pmv-rejthumb] > .absolute.left-3:not(.bottom-3):not([data-pmv-reject-btn]){transform:translateY(2.25rem);}`;
        (document.head || document.documentElement).appendChild(st);
    }
    function cardBtn(kind, title, icon) {
        ensureCardBtnStyle();
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pmv-cardbtn';
        b.dataset.kind = kind;
        b.dataset.pmvBadge = '1';
        b.title = title;
        b.innerHTML = icon;
        b.addEventListener('mousedown', e => e.stopPropagation());
        return b;
    }
    // Thumbnail box: .aspect-video (grid) or .w-40 (Recommended).
    function cardThumb(card) {
        return card.querySelector('.aspect-video') || card.querySelector('.w-40') || card.querySelector('img')?.parentElement || null;
    }
    function placeRejectInThumb(card, btn) {
        const thumb = cardThumb(card);
        if (!thumb) return false;
        if (getComputedStyle(thumb).position === 'static') thumb.style.position = 'relative';
        thumb.dataset.pmvRejthumb = '1';
        // Small variant on cards without a resolution pill (Recommended, More from).
        if (!thumb.querySelector(':scope > .absolute.top-3.right-3')) btn.dataset.small = '1';
        thumb.appendChild(btn);
        return true;
    }
    // "+" opens the playlist menu under the button; a second click closes it.
    function playlistPickButton(resolveId) {
        const b = cardBtn('playlists', 'Add to a playlist', CARD_ICON.queueAdd);
        b.dataset.pmvPlpick = '1';
        b.addEventListener('mousedown', () => { b._wasOpen = document.getElementById('pmv-ctx-menu')?._pmvBtn === b; });
        b.addEventListener('click', async e => {
            e.preventDefault();
            e.stopPropagation();
            if (b._wasOpen) { b._wasOpen = false; closeCtxMenu(); return; }
            const id = await resolveId();
            if (!id) { toast('Video not found'); return; }
            const r = b.getBoundingClientRect();
            buildCtxMenu(id, r.left, r.bottom + 4, b);
            const menu = document.getElementById('pmv-ctx-menu');
            if (menu) menu._pmvBtn = b;
        });
        return b;
    }

    // Writes only what changed: every write is a DOM mutation that would wake the page observer again.
    function styleRejectCardBtn(btn, on) {
        const armed = !on && btn.dataset.armed === '1';
        const flag = on ? '1' : '';
        const text = armed ? '\u2298 Reject?' : '\u2298';
        const title = armed ? 'Click again to reject'
            : on ? 'Remove from reject list'
            : 'Reject (move to the reject list, remove from every other playlist)';
        if (btn.dataset.on !== flag) btn.dataset.on = flag;
        if (btn.textContent !== text) btn.textContent = text;
        if (btn.title !== title) btn.title = title;
    }

    function disarmRejectBtn(btn) {
        clearTimeout(btn._pmvArmTimer);
        if (btn.dataset.armed !== '1') return;
        delete btn.dataset.armed;
        styleRejectCardBtn(btn, btn.dataset.on === '1');
    }

    function rejectCardButtonEl(card, resolveId, initialOn) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.pmvRejectBtn = '1';
        btn.dataset.pmvBadge = '1';
        ensureCardBtnStyle();
        btn.className = 'pmv-thumbx';
        btn.dataset.on = initialOn ? '1' : '';
        styleRejectCardBtn(btn, initialOn);
        btn.addEventListener('mousedown', e => e.stopPropagation());
        btn.addEventListener('click', async e => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.dataset.busy) return;
            const on = btn.dataset.on === '1';
            if (!on && btn.dataset.armed !== '1' && PMVX.anyCardFilterActive()) {
                btn.dataset.armed = '1';
                styleRejectCardBtn(btn, false);
                clearTimeout(btn._pmvArmTimer);
                btn._pmvArmTimer = setTimeout(() => disarmRejectBtn(btn), REJECT_ARM_MS);
                return;
            }
            disarmRejectBtn(btn);
            btn.dataset.busy = '1';
            btn.style.opacity = '0.5';
            try {
                const rect = btn.getBoundingClientRect();
                const id = await resolveId();
                if (!id) { toast('Video not found'); return; }
                const now = await toggleRejectVideo(id);
                if (now === null) return;
                if (now && tagAfterReject()) {
                    const title = State.videoMeta.get(id)?.title || card.querySelector('h3, h4')?.textContent.trim() || '';
                    openTagPopup(id, rect, title);
                }
                btn.dataset.on = now ? '1' : '';
                styleRejectCardBtn(btn, now);
                // Force a re-badge and re-tint on the next pass.
                card.querySelectorAll('[data-playlist-name]').forEach(el => el.remove());
                delete card.dataset.pmvChecked;
                delete card.dataset.pmvRecChecked;
                delete card.dataset.pmvMfChecked;
                scheduleBadges();
            } catch {
                toast('Reject failed');
            } finally {
                delete btn.dataset.busy;
                btn.style.opacity = '';
            }
        });
        return btn;
    }

    // Badge passes call this for existing buttons; it leaves an armed button alone.
    function refreshRejectCardBtn(btn, on) {
        if (btn.dataset.on !== (on ? '1' : '')) btn.dataset.on = on ? '1' : '';
        if (on) disarmRejectBtn(btn);
        styleRejectCardBtn(btn, on);
    }

    // Heart: GET /api/users/favorite-ids -> { favorites: [id] } (once per page load);
    // PUT /api/videos/<id>/favorite { action: "favorite" | "unfavorite" }.
    const FAV_RGB = '244,114,182'; // pink-400, the site's favourites colour
    const HEART_SVG = on => `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`;
    let favIds = null;          // Set once loaded; null = unknown (logged out or not loaded yet)
    let favLoad = null;
    function loadFavIds() {
        if (favLoad) return favLoad;
        favLoad = fetch('/api/users/favorite-ids', { credentials: 'include', headers: { accept: 'application/json' } })
            .then(r => r.ok ? r.json() : null)
            .then(j => {
                const list = j?.favorites || j?.data?.favorites;
                if (Array.isArray(list)) { favIds = new Set(list); refreshFavButtons(); }
            })
            .catch(() => {});
        return favLoad;
    }
    function isFavourite(id) { return !!(id && favIds?.has(id)); }
    function noteFavourite(id, on) {
        if (!favIds) favIds = new Set();
        if (on) favIds.add(id); else favIds.delete(id);
        refreshFavButtons();
    }
    function styleFavCardBtn(btn, on) {
        btn.dataset.on = on ? '1' : '';
        btn.title = on ? 'Remove from favourites' : 'Add to favourites';
        btn.innerHTML = HEART_SVG(on); // filled when favourited, outline otherwise
    }
    function refreshFavButtons() {
        document.querySelectorAll('[data-pmv-fav-btn]').forEach(btn => {
            const id = btn._pmvFavId?.();
            styleFavCardBtn(btn, isFavourite(id));
        });
    }
    // `knownId` gives the API _id if it is known without a request; `resolveId` may fetch it.
    function favCardButtonEl(knownId, resolveId) {
        const btn = cardBtn('fav', 'Add to favourites', '');
        btn.dataset.pmvFavBtn = '1';
        btn._pmvFavId = knownId;
        styleFavCardBtn(btn, isFavourite(knownId()));
        loadFavIds();
        btn.addEventListener('mousedown', e => e.stopPropagation());
        btn.addEventListener('click', async e => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.dataset.busy) return;
            btn.dataset.busy = '1';
            btn.style.opacity = '0.5';
            try {
                const id = await resolveId();
                if (!id) { toast('Video not found'); return; }
                await loadFavIds();
                const wasOn = isFavourite(id);
                const res = await fetch(`/api/videos/${id}/favorite`, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ action: wasOn ? 'unfavorite' : 'favorite' }),
                });
                if (!res.ok) { toast(res.status === 401 ? 'Log in to favourite videos' : `Favourite failed (${res.status})`, 'red'); return; }
                // The fetch hook already ran noteFavourite; sync the page's own state too.
                if (State.currentVideoData?.id === id) State.currentVideoData.isFavorited = !wasOn;
                PMVX.markActed(id);
                toast(wasOn ? '✕ Removed from favourites' : '♥ Added to favourites', wasOn ? null : 'green');
            } catch {
                toast('Favourite failed', 'red');
            } finally {
                delete btn.dataset.busy;
                btn.style.opacity = '';
            }
        });
        return btn;
    }

    function addBadges() {
        if (State.quietMode) return;

        document.querySelectorAll('[data-video-id]').forEach(card => {
            const videoId = card.dataset.videoId;
            if (!videoId) return;

            // Skip processed cards unless a badge or reject button went missing (Vue re-render).
            if (card.dataset.pmvChecked === videoId && State.ready
                && !(isVideoInPlaylist(videoId) && !card.querySelector('[data-playlist-name]'))
                && !(rejectPlaylistId && !card.querySelector('[data-pmv-reject-btn]'))
                && card.querySelector('[data-pmv-plpick]')) return;
            card.dataset.pmvChecked = videoId;

            const tagRows = [...card.querySelectorAll('.flex.items-center.gap-1\\.5.flex-wrap')];
            let targetRow = null;
            for (const row of tagRows) {
                const s = row.getAttribute('style') || '';
                if (!s.includes('display: none') && !s.includes('display:none')) { targetRow = row; break; }
            }
            if (!targetRow) {
                targetRow = tagRows[1] || tagRows[0];
                if (targetRow) targetRow.style.setProperty('display', 'flex', 'important');
            }
            if (!targetRow) return;

            // <button> + window.open(): a nested <a> is invalid inside a card link.
            if (!targetRow.querySelector('[data-pmv-opentab]')) {
                const cardHref = card.tagName === 'A'
                    ? card.getAttribute('href')
                    : card.querySelector('a[href*="/video/"]')?.getAttribute('href');
                if (cardHref) {
                    const otBtn = cardBtn('open', 'Open in new tab', CARD_ICON.external);
                    otBtn.dataset.pmvOpentab = '1';
                    otBtn.addEventListener('click', e => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(cardHref, '_blank', 'noopener,noreferrer');
                    });
                    targetRow.appendChild(otBtn);
                }
            }

            // Up next button; uses the resolved _id, not the slug/asset id.
            if (!targetRow.querySelector('[data-pmv-addqueue]')) {
                const aqBtn = cardBtn('queue', 'Add to Up next', CARD_ICON.upNext);
                aqBtn.dataset.pmvAddqueue = '1';
                aqBtn.dataset.qid = videoId;
                aqBtn.addEventListener('click', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (queuedPosition(videoId)) { removeFromQueue(videoId); toast('\u2212 Removed from Up next', null, { under: upNextToastAnchor() }); return; }
                    addVideoToQueue(videoId, card);
                });
                targetRow.appendChild(aqBtn);
                syncQueueCardBtn(aqBtn);
            }

            if (!targetRow.querySelector('[data-pmv-plpick]')) {
                const pb = playlistPickButton(async () => card.dataset.videoId || videoId);
                const aq = targetRow.querySelector('[data-pmv-addqueue]');
                if (aq) aq.after(pb); else targetRow.appendChild(pb);
            }

            if (!targetRow.querySelector('[data-pmv-fav-btn]')) {
                const fb = favCardButtonEl(() => card.dataset.videoId || videoId, async () => card.dataset.videoId || videoId);
                const pb = targetRow.querySelector('[data-pmv-plpick]') || targetRow.querySelector('[data-pmv-addqueue]');
                if (pb) pb.after(fb); else targetRow.appendChild(fb);
            }

            const rjBtn = card.querySelector('[data-pmv-reject-btn]');
            if (!rejectPlaylistId) rjBtn?.remove();
            else if (rjBtn) refreshRejectCardBtn(rjBtn, isRejected(videoId));
            else placeRejectInThumb(card, rejectCardButtonEl(card, async () => videoId, isRejected(videoId)));

            if (!State.ready) {
                if (!targetRow.querySelector('[data-playlist-loading]')) {
                    const lbadge = document.createElement('span');
                    lbadge.dataset.playlistLoading = '1';
                    lbadge.dataset.pmvBadge = '1';
                    lbadge.style.cssText = 'display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;font-size:11px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.35);';
                    lbadge.textContent = '...';
                    targetRow.appendChild(lbadge);
                }
                return;
            }

            targetRow.querySelectorAll('[data-playlist-loading]').forEach(el => el.remove());

            const matching = [];
            State.playlists.forEach(p => { if (p.ids.has(videoId)) matching.push({ id: p.id, name: p.name }); });
            if (!matching.length) return;

            matching.forEach(({ id: plId, name }) => {
                if (targetRow.querySelector(`[data-playlist-name="${CSS.escape(name)}"]`)) return;
                const badge = document.createElement('span');
                badge.dataset.playlistName = name;
                badge.dataset.pmvBadge = '1';
                const badgeRgb = playlistBadgeRgb(name, plId);
                badge.style.cssText = `display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;font-size:11px;background:rgba(${badgeRgb},0.15);border:1px solid rgba(${badgeRgb},0.4);color:rgb(${badgeRgb});max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
                badge.title = 'In playlist: ' + name;
                // Short name (Settings → Playlist names); full name in the tooltip.
                badge.textContent = (isRejectList(plId) ? '\u2298 ' : '✓ ') + (getPlaylistDisplayName(name, plId) || name);
                targetRow.appendChild(badge);
            });
        });
    }


    // Primary trigger: the site logs "Switching playlist video" {newVideoId, newVideo} on every index
    // change, before any media/HLS loading, so it doesn't depend on readyState or DOM classes.
    (function installPlaylistSwitchLogHook() {
        const origConsoleLog = console.log.bind(console);
        console.log = function (...args) {
            origConsoleLog(...args);
            try {
                if (typeof args[0] === 'string' && args[0].indexOf('Switching playlist video') !== -1) {
                    const data = args[1];
                    if (data && data.newVideoId) {
                        showNextVideoNotificationFor(data.newVideoId, data.newVideo || null, 'console-hook');
                    }
                }
            } catch {}
        };
    })();


    function addQueueBadges() {
        if (State.quietMode || !State.ready) return;

        // Scoped to queue thumbnails; much narrower than all [role="button"].
        document.querySelectorAll('.w-24.h-14 img').forEach(img => {
            const itemRoot = img.closest('[role="button"]');
            if (!itemRoot) return;

            const videoId = resolveQueueItemVideoId(itemRoot);
            if (!videoId) return;
            if (itemRoot.dataset.pmvQueueChecked === videoId) return;
            itemRoot.dataset.pmvQueueChecked = videoId;

            const targetRow =
                itemRoot.querySelector('.flex-1.min-w-0 .flex.items-center.gap-1.flex-wrap') ||
                itemRoot.querySelector('.flex.items-center.gap-1.flex-wrap') ||
                itemRoot.querySelector('.flex-1.min-w-0');
            if (!targetRow) return;

            targetRow.querySelectorAll('[data-pmv-check]').forEach(el => el.remove());

            const matching = [];
            State.playlists.forEach(p => { if (p.ids.has(videoId)) matching.push(p.name); });
            if (!matching.length) return;

            const check = document.createElement('span');
            check.dataset.pmvCheck = '1';
            check.dataset.pmvBadge = '1';
            const rej = isRejected(videoId);
            const rgb = rej ? REJECT_RGB : '100,255,0';
            check.textContent = rej ? '\u2298' : '✓';
            check.title = matching.join(', ');
            check.style.cssText = `display:inline-flex;align-items:center;padding:2px 6px;border-radius:6px;font-size:11px;font-weight:500;background:rgba(${rgb},0.15);border:1px solid rgba(${rgb},0.4);color:rgb(${rgb});flex-shrink:0;line-height:1;`;
            targetRow.appendChild(check);
        });
    }

    // --- Recommended sidebar ---
    // Badges and playlist filter on /video/ pages.

    function getVideoIdFromHref(href) {
        // /video/<slug>_<24hex>?from=recommended; slug and query optional.
        if (!href) return null;
        const m = href.match(/\/video\/(?:[^?#]*_)?([0-9a-f]{24})(?:[?#]|$)/i);
        return m ? m[1] : null;
    }

    function getVideoIdFromThumbUrl(src) {
        if (!src) return null;
        // video.pmvhaven.com/thumbnails/<24hex>/thumb_lg.webp
        let m = src.match(/thumbnails\/([0-9a-f]{24})\//i);
        if (m) return m[1];
        // storage.pmvhaven.com/<24hex>/thumbnail/...
        m = src.match(/\/([0-9a-f]{24})\/thumbnail\//i);
        if (m) return m[1];
        return null;
    }

    function isVideoInPlaylist(videoId) {
        if (!videoId || !State.ready) return false;
        for (const p of State.playlists.values()) {
            if (p.ids.has(videoId)) return true;
        }
        return false;
    }

    // Bounded retry (not a poller) to wait out SSR/hydration; a new kick cancels the old one.
    let kickTimers = [];
    function kickRecommended() {
        kickTimers.forEach(clearTimeout);
        kickTimers = [0, 150, 400, 900, 1800].map((d, i) => setTimeout(() => {
            try { addRecommendedBadges(); } catch {}
            try { addMoreFromBadges(); } catch {}
            try { topUpQueueFromRecommended(); } catch {}
            const panel = document.getElementById('pmv-queue-sidebar');
            const container = findVisibleRecommendedContainer();
            if (i === 0 || (smartQueueItems.length && (!panel || (container && panel.nextElementSibling !== container)))) {
                try { renderQueueSidebar(); } catch {}
            }
        }, d));
    }

    // Re-badge once the cache is ready (kicks may have fired before State.ready).
    window.addEventListener('pmv:cache-ready', () => {
        document.querySelectorAll('[data-pmv-rec-checked]').forEach(el => {
            delete el.dataset.pmvRecChecked;
        });
        document.querySelectorAll('[data-pmv-mf-checked]').forEach(el => { delete el.dataset.pmvMfChecked; });
        try { addRecommendedBadges(); } catch {}
        try { addMoreFromBadges(); } catch {}
    });

    function resolveRecCardVideoId(card) {
        // Order: own href, inner link, title (titleIndex), thumbnail.
        const selfHref = card.tagName === 'A' ? card.getAttribute('href') : null;
        if (selfHref) {
            const fromSelf = getVideoIdFromHref(selfHref);
            if (fromSelf) return fromSelf;
        }
        const innerLink = card.querySelector('a[href*="/video/"]');
        if (innerLink) {
            const fromInner = getVideoIdFromHref(innerLink.getAttribute('href'));
            if (fromInner) return fromInner;
        }
        const h4 = card.querySelector('h4');
        if (h4) {
            const fromTitle = State.titleIndex.get(h4.textContent.trim().toLowerCase());
            if (fromTitle) return fromTitle;
        }
        const img = card.querySelector('img');
        if (img) {
            const src = img.getAttribute('src') || img.src || '';
            const fromThumb = getVideoIdFromThumbUrl(src);
            if (fromThumb) return fromThumb;
            const srcClean = src.split('?')[0];
            if (srcClean && State.thumbnailIndex.has(srcClean)) return State.thumbnailIndex.get(srcClean);
        }
        return null;
    }

    // "+" on a Recommended card: placed without the cache; the API id is resolved on click.
    function placeRecAddQueueButton(card, slugId, targetEl) {
        const infoDiv = targetEl || card.querySelector('.flex-1.min-w-0');
        if (!infoDiv) return;
        placeRecRejectButton(card, slugId, infoDiv);
        if (infoDiv.querySelector('[data-pmv-rec-addqueue]')) return;

        const aqBtn = cardBtn('queue', 'Add to Up next', CARD_ICON.upNext);
        aqBtn.dataset.pmvRecAddqueue = '1';
        aqBtn.dataset.rec = '1';
        aqBtn.dataset.qid = slugId;
        // Queued under the slug id at once; the API id is swapped in later (only for dedupe and chips).
        aqBtn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            const queuedId = [State.slugToApiId.get(slugId), slugId].find(id => id && queuedPosition(id));
            if (queuedId) { removeFromQueue(queuedId); toast('\u2212 Removed from Up next', null, { under: upNextToastAnchor() }); return; }
            const known = State.slugToApiId.get(slugId);
            addVideoToQueue(known || slugId, card);
            if (known) return;
            fetchVideoDeduped(slugId)
                .then(v => {
                    if (!v?._id) return;
                    State.slugToApiId.set(slugId, v._id);
                    adoptResolvedQueueId(slugId, v._id);
                })
                .catch(() => noteLookupFailure(slugId));
        });
        // Playlist "+" and heart; the resolved id is cached in slugToApiId.
        const resolveId = async () => {
            const id = knownApiIdForCard(card, slugId);
            if (id) return id;
            const v = await fetchVideoDeduped(slugId).catch(() => { noteLookupFailure(slugId); return null; });
            if (!v?._id) return null;
            State.slugToApiId.set(slugId, v._id);
            return v._id;
        };
        queueMicrotask(() => syncQueueCardBtn(aqBtn));
        const plBtn = playlistPickButton(resolveId);
        plBtn.dataset.rec = '1';
        const favBtn = favCardButtonEl(() => knownApiIdForCard(card, slugId), resolveId);
        favBtn.dataset.rec = '1';
        infoDiv.append(aqBtn, plBtn, favBtn);
    }

    // ✕ on Recommended / More from cards; colour follows the known id, resolved on click.
    function placeRecRejectButton(card, slugId, infoDiv) {
        const existing = card.querySelector('[data-pmv-reject-btn]');
        if (!rejectPlaylistId) { existing?.remove(); return; }
        const known = knownApiIdForCard(card, slugId);
        if (existing) { refreshRejectCardBtn(existing, isRejected(known)); return; }
        const btn = rejectCardButtonEl(card, async () => {
            const id = knownApiIdForCard(card, slugId);
            if (id) return id;
            const v = await fetchVideoDeduped(slugId).catch(() => { noteLookupFailure(slugId); return null; });
            if (!v?._id) return null;
            State.slugToApiId.set(slugId, v._id);
            return v._id;
        }, isRejected(known));
        placeRejectInThumb(card, btn);
    }

    function placeRecBadge(card, videoId) {
        const inPl = isVideoInPlaylist(videoId);

        const pinned = PMVX.isActed(videoId);
        if (State.recFilterMode === 'in' && !inPl && !pinned) {
            card.style.setProperty('display', 'none', 'important'); return;
        }
        if (State.recFilterMode === 'out' && inPl && !pinned) {
            card.style.setProperty('display', 'none', 'important'); return;
        }
        card.style.removeProperty('display');

        card.dataset.pmvRecChecked = videoId;

        const infoDiv = card.querySelector('.flex-1.min-w-0');
        if (!infoDiv) return;

        infoDiv.querySelectorAll('[data-pmv-rec-badge]').forEach(el => el.remove());
        applyInPlaylistTint(card, inPl, isRejected(videoId));
        if (!inPl) return;

        const badge = playlistCheckBadgeEl(videoId);
        if (!badge) return;
        const ratingRow = infoDiv.querySelector('[class*="gap-1"][class*="flex-wrap"]') ||
                          infoDiv.querySelector('[class*="gap-1"]');
        if (ratingRow) ratingRow.appendChild(badge);
        else infoDiv.appendChild(badge);
    }

    // Inline tint (green in playlist, red rejected); Vue re-renders wipe it, the badge pass reapplies.
    function applyInPlaylistTint(el, on, rejected = false) {
        if (!el) return;
        if (on) {
            const rgb = rejected ? REJECT_RGB : QUEUE_IN_PLAYLIST_RGB;
            el.style.background = `rgba(${rgb},0.07)`;
            el.style.boxShadow = `inset 0 0 0 1px rgba(${rgb},0.35)`;
            el.style.borderRadius = el.style.borderRadius || '8px';
        } else {
            el.style.removeProperty('background');
            el.style.removeProperty('box-shadow');
        }
    }

    // "✓ <playlists>" chip for Recommended / More from cards; null if in none.
    function playlistCheckBadgeEl(videoId) {
        const matching = [], shown = [];
        State.playlists.forEach(p => { if (p.ids.has(videoId)) { matching.push(p.name); shown.push(getPlaylistDisplayName(p.name, p.id) || p.name); } });
        if (!matching.length) return null;

        const badge = document.createElement('span');
        badge.dataset.pmvRecBadge = '1';
        badge.dataset.pmvBadge = '1';
        const rej = isRejected(videoId);
        const rgb = rej ? REJECT_RGB : '100,255,0';
        badge.title = 'In playlist: ' + matching.join(', ');
        badge.textContent = (rej ? '\u2298 ' : '✓ ') + shown.join(', ');
        badge.style.cssText = `display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:500;background:rgba(${rgb},0.15);border:1px solid rgba(${rgb},0.4);color:rgb(${rgb});max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;`;
        return badge;
    }

    // More from cards are plain <a> links without data-video-id. Resolve without fetching (slug cache,
    // titleIndex/thumbnailIndex; a hit means "in a playlist"): fetching every card causes 429 bursts.
    function knownApiIdForCard(card, slugId) {
        const mapped = State.slugToApiId.get(slugId);
        if (mapped) return mapped;
        // Newer videos have no oldId, so a slug can be the playlist video's _id.
        if (State.reverse.has(slugId)) return slugId;
        const h4 = card.querySelector('h4');
        const byTitle = h4 && State.titleIndex.get(h4.textContent.trim().toLowerCase());
        if (byTitle) return byTitle;
        const src = (card.querySelector('img')?.getAttribute('src') || '').split('?')[0];
        return (src && State.thumbnailIndex.get(src)) || null;
    }

    // --- Video info on playlist pages ---
    // "More about this video": models, Playlists with this video, More from, from one /watch-page request.
    // Markup copies the video page's so Mini-checker, labels and card buttons attach; collapses on next video.
    const VINFO_ID = 'pmv-vinfo';
    const vinfo = { vid: null, open: false, data: null, loading: false, error: false, seq: 0 };
    const VI_SVG = {
        info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>',
        chev: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
        userCircle: (s, cls = '') => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" class="${cls}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/></svg>`,
        listVideo: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H3m7 7H3m7 7H3m12-6.997a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997a1 1 0 0 1-1.517-.86z"/></svg>',
        arrow: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-7-7 7 7-7 7"/></svg>',
        play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        eye: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>',
        cal: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
        clock: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
        user: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        videoCount: '<svg viewBox="0 0 24 24" width="10" height="10" class="inline" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect width="14" height="12" x="2" y="6" rx="2"/></svg>',
        thumb: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>',
    };
    const viSlug = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const viCompact = n => {
        n = Number(n) || 0;
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
    };
    const viAgo = iso => {
        const t = Date.parse(iso || '');
        if (!Number.isFinite(t)) return '';
        const s = Math.max(0, (Date.now() - t) / 1000);
        const steps = [[31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
        for (const [sec, u] of steps) if (s >= sec) return `${Math.floor(s / sec)}${u} ago`;
        return 'just now';
    };
    const VI_CARD = 'group bg-[#0F0F0F] rounded-lg overflow-hidden border border-[#2A2A2A] hover:border-orange-500/40 transition-all duration-300 hover:shadow-lg hover:shadow-orange-500/10';
    const VI_GRID = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4';


    function addMoreFromBadges() {
        try { learnVideoIdsFromNuxtPayload(); } catch {}
        [...document.querySelectorAll('h3')]
            .filter(h => /^More from/i.test(h.textContent.trim()))
            .forEach(h3 => {
                const container = h3.parentElement?.parentElement;
                if (!container) return;
                container.querySelectorAll('a[href*="/video/"]').forEach(card => {
                    const slugId = getVideoIdFromHref(card.getAttribute('href'));
                    if (!slugId) return;
                    const row = card.querySelector('[class*="gap-1"][class*="flex-wrap"]');
                    if (!row) return;

                    placeRecAddQueueButton(card, slugId, row);

                    if (!State.ready) return;
                    const apiId = knownApiIdForCard(card, slugId);
                    const key = apiId || slugId;
                    if (card.dataset.pmvMfChecked === key) return;

                    if (apiId) {
                        card.dataset.pmvMfChecked = key;
                        row.querySelectorAll('[data-pmv-rec-badge]').forEach(el => el.remove());
                        const badge = playlistCheckBadgeEl(apiId);
                        applyInPlaylistTint(card, !!badge, isRejected(apiId));
                        if (badge) row.appendChild(badge);
                    } else {
                        armMoreFromHoverResolve(card, row, slugId);
                    }
                });
            });
    }

    // Unresolved cards resolve on hover: one deduped request after a delay; bulk lookups hit the rate limit.
    function armMoreFromHoverResolve(card, row, slugId) {
        if (card.dataset.pmvMfArmed) return;
        card.dataset.pmvMfArmed = '1';

        let timer = null;
        card.addEventListener('pointerenter', () => {
            timer = setTimeout(async () => {
                if (card.dataset.pmvMfChecked) return;
                try {
                    const v = await fetchVideoDeduped(slugId);
                    const apiId = v?._id;
                    if (!apiId || !card.isConnected) return;
                    State.slugToApiId.set(slugId, apiId);
                    card.dataset.pmvMfChecked = apiId;
                    row.querySelectorAll('[data-pmv-rec-badge]').forEach(el => el.remove());
                    const badge = playlistCheckBadgeEl(apiId);
                    applyInPlaylistTint(card, !!badge, isRejected(apiId));
                    if (badge) row.appendChild(badge);
                } catch {}
            }, 350);
        });
        card.addEventListener('pointerleave', () => clearTimeout(timer));
    }

