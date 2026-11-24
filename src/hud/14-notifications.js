    // --- Notifications ---
    // Playlist indicator per notification. /notifications has only a "/video/<hex>" link (no thumbnails, no data-video-id);
    // resolved without API calls via slugToApiId, reverse index, titleIndex (playlist videos only: a hit = in a playlist).
    // Thumbnail + tag chips go in a full-width block below the row. Both idempotent (badge redrawn only on change, preview keyed by apiId).
    function renderNotifPreview(card, apiId, meta) {
        const link = card.querySelector('a[href*="/video/"]');
        // Sibling of the text block in the justify-between row, filling its empty side.
        const textBlock = link?.closest('.flex-1.min-w-0') || null;
        const container = textBlock?.parentElement || card.querySelector(':scope > div') || card;
        const existing = [...container.children].find(el => el.dataset?.pmvNotifPreview !== undefined);
        if (existing && existing.dataset.pmvNotifPreview === apiId) return;
        existing?.remove();
        if (!meta?.thumbnailUrl && !meta?.tags?.length) return;

        const wrap = document.createElement('div');
        wrap.dataset.pmvNotifPreview = apiId;
        wrap.style.cssText = 'display:flex;gap:8px;align-items:center;flex-shrink:0;';

        if (meta.thumbnailUrl) {
            const thumbLink = document.createElement('a');
            thumbLink.href = `/video/${apiId}`;
            wireNotifMarkAsRead(thumbLink);

            const thumbBox = document.createElement('div');
            thumbBox.style.cssText = 'position:relative;width:140px;height:79px;border-radius:6px;overflow:hidden;flex-shrink:0;background:#0F0F0F;';

            const img = document.createElement('img');
            img.src = meta.thumbnailUrl;
            img.loading = 'lazy';
            img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
            thumbBox.appendChild(img);

            // Hover preview: <video> created lazily on first hover, then paused/resumed.
            if (meta.previewUrl) {
                let video = null;
                thumbBox.addEventListener('mouseenter', () => {
                    if (!video) {
                        video = document.createElement('video');
                        video.src = meta.previewUrl;
                        video.muted = true;
                        video.loop = true;
                        video.playsInline = true;
                        video.dataset.pmvPreviewVideo = '1';
                        video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
                        thumbBox.appendChild(video);
                    }
                    video.currentTime = 0;
                    video.play().catch(() => {});
                });
                thumbBox.addEventListener('mouseleave', () => {
                    video?.pause();
                });
            }

            thumbLink.appendChild(thumbBox);
            wrap.appendChild(thumbLink);
        }

        if (meta.tags?.length) {
            const tagRow = document.createElement('div');
            tagRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;max-width:180px;';
            meta.tags.forEach(tag => {
                const chip = document.createElement('span');
                chip.style.cssText = 'display:inline-flex;align-items:center;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,rgba(249,115,22,0.15),rgba(239,68,68,0.15));border:1px solid rgba(249,115,22,0.3);color:rgb(253,186,116);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                chip.textContent = '#' + tag;
                chip.title = `Select all notifications tagged "${tag}"`;
                chip.addEventListener('click', () => selectNotifsByTag(tag));
                tagRow.appendChild(chip);
            });
            wrap.appendChild(tagRow);
        }

        if (textBlock) textBlock.insertAdjacentElement('afterend', wrap);
        else container.appendChild(wrap);
    }

    // hex is the real video _id here; fallback when the video is in no index.
    function resolveNotifVideoApiId(link) {
        const hex = link?.getAttribute('href')
            ?.match(/\/video\/(?:[^?#\/]*_)?([0-9a-f]{24})(?:[?#\/]|$)/i)?.[1]?.toLowerCase();
        if (!hex) return null;
        const title = (link.textContent || '').trim().replace(/^["“]|["”]$/g, '').trim().toLowerCase();
        const videoId = State.slugToApiId.get(hex)
            || (State.reverse.has(hex) ? hex : null)
            || (title && State.titleIndex.get(title))
            || null;
        return videoId || hex;
    }

    // Opening also marks it read: click the real button, navigate after a delay so its request isn't aborted.
    function wireNotifMarkAsRead(link) {
        if (!link || link.dataset.pmvMarkReadWired) return;
        link.dataset.pmvMarkReadWired = '1';
        link.addEventListener('click', e => {
            if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
            const card = link.closest('div.group');
            const readBtn = card?.querySelector('button[title="Mark as read"]');
            if (!readBtn) return;
            e.preventDefault();
            readBtn.click();
            setTimeout(() => { location.href = link.href; }, 200);
        });
    }

    // Failed lookups are parked instead of retried on sight (retries feed the rate limiting).
    const LOOKUP_BACKOFF_MS = 60000;
    const failedLookups = new Map(); // id -> retry-after timestamp (ms)

    function lookupOnCooldown(id) {
        const until = failedLookups.get(id);
        if (!until) return false;
        if (Date.now() >= until) { failedLookups.delete(id); return false; }
        return true;
    }
    function noteLookupFailure(id) {
        failedLookups.set(id, Date.now() + LOOKUP_BACKOFF_MS);
    }

    function fetchVideoDeduped(apiId) {
        const hit = recentVideo(apiId);
        if (hit) return Promise.resolve(hit);
        let p = pendingVideoApiFetches.get(apiId);
        if (!p) {
            // Replaces the interceptor's deferred for this request; deleted from the map only while still the entry.
            p = api(`/api/videos/${apiId}`).then(json => {
                const v = json?.data || json;
                if (v?._id) { indexVideoDetails([v]); rememberVideo(apiId, v); }
                return v;
            });
            pendingVideoApiFetches.set(apiId, p);
            const drop = () => { if (pendingVideoApiFetches.get(apiId) === p) pendingVideoApiFetches.delete(apiId); };
            p.then(drop, drop);
        }
        return p;
    }

    function addNotificationBadges() {
        const onPage = /^\/notifications\/?$/.test(location.pathname);
        if (!onPage) { document.getElementById('pmv-notif-selpl')?.remove(); return; }
        if (!State.ready) return;

        const toFetch = [];

        document.querySelectorAll('a[href*="/video/"]').forEach(link => {
            const card = link.closest('div.group');
            if (!card?.querySelector('input[type="checkbox"]')) return;
            wireNotifMarkAsRead(link);
            const hex = link.getAttribute('href')
                ?.match(/\/video\/(?:[^?#\/]*_)?([0-9a-f]{24})(?:[?#\/]|$)/i)?.[1]?.toLowerCase();
            if (!hex) return;

            const title = link.textContent.trim().replace(/^["\u201c]|["\u201d]$/g, '').trim().toLowerCase();
            const videoId = State.slugToApiId.get(hex)
                || (State.reverse.has(hex) ? hex : null)
                || (title && State.titleIndex.get(title))
                || null;
            // hex is the real video _id: fallback for the thumbnail/tags fetch when no index hits.
            const apiId = videoId || hex;
            const meta = State.videoMeta.get(apiId);
            if (meta) {
                renderNotifPreview(card, apiId, meta);
            } else if (!card.dataset.pmvNotifPreviewBusy && !lookupOnCooldown(apiId)) {
                card.dataset.pmvNotifPreviewBusy = '1';
                toFetch.push({ card, apiId });
            }

            const matching = [];
            if (videoId) State.playlists.forEach(p => { if (p.ids.has(videoId)) matching.push({ id: p.id, name: p.name }); });
            const key = matching.map(m => m.name).join('|');
            // data-* survives Vue re-renders; the select button reads it.
            card.dataset.pmvInpl = matching.length ? '1' : '0';

            const existing = link.nextElementSibling?.dataset?.pmvNotifBadge !== undefined
                ? link.nextElementSibling : null;
            if (existing && existing.dataset.pmvNotifBadge === key) return;
            existing?.remove();
            if (!matching.length) return;

            const row = document.createElement('div');
            row.dataset.pmvNotifBadge = key;
            row.dataset.pmvBadge = '1';
            row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';
            matching.forEach(({ id: plId, name }) => {
                const badge = document.createElement('span');
                badge.dataset.playlistName = name;
                const badgeRgb = playlistBadgeRgb(name, plId);
                badge.style.cssText = `display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;font-size:11px;background:rgba(${badgeRgb},0.15);border:1px solid rgba(${badgeRgb},0.4);color:rgb(${badgeRgb});max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
                badge.title = 'In playlist: ' + name;
                badge.textContent = (isRejectList(plId) ? '\u2298 ' : '\u2713 ') + name;
                row.appendChild(badge);
            });
            link.insertAdjacentElement('afterend', row);
        });

        if (toFetch.length) {
            // Limited by performance mode; metadata first, and fetchVideoDeduped shares requests (one video, several rows).
            settledWithLimit(toFetch, PMVX.perf().lookups, ({ card, apiId }) =>
                (State.videoMeta.has(apiId) ? Promise.resolve() : fetchVideoDeduped(apiId))
                    .catch(() => noteLookupFailure(apiId))
                    .finally(() => {
                        delete card.dataset.pmvNotifPreviewBusy;
                        const meta = State.videoMeta.get(apiId);
                        if (meta) renderNotifPreview(card, apiId, meta);
                    })
            );
        }

        updateNotifSelectButton();
    }

    // "Select in playlist": clicks the checkbox of each loaded notification whose video is in a playlist (keeps Vue's
    // v-model in sync); again deselects. Next to the All/Unread pills, re-attached each run (Vue drops it); else fixed on body.
    function isNotifVideoInPlaylist(apiId) {
        for (const p of State.playlists.values()) {
            if (p.ids.has(apiId)) return true;
        }
        return false;
    }

    // Resolved from State and the live DOM per call, not data-pmv-inpl (can be stale mid-loop).
    function getNotifInPlaylistBoxes() {
        return [...document.querySelectorAll('div.group')]
            .map(card => {
                const checkbox = card.querySelector('input[type="checkbox"]');
                const link = card.querySelector('a[href*="/video/"]');
                if (!checkbox || !link) return null;
                const apiId = resolveNotifVideoApiId(link);
                return apiId && isNotifVideoInPlaylist(apiId) ? checkbox : null;
            })
            .filter(Boolean);
    }

    // One checkbox per frame, so Vue's re-render settles before the next card is queried.
    async function clickNotifCheckboxesWhere(match, { target = true } = {}) {
        let guard = 300;
        while (guard-- > 0) {
            const next = [...document.querySelectorAll('div.group')].find(card => {
                const checkbox = card.querySelector('input[type="checkbox"]');
                if (!checkbox || checkbox.checked === target) return false;
                const link = card.querySelector('a[href*="/video/"]');
                const apiId = link && resolveNotifVideoApiId(link);
                return apiId ? match(apiId) : false;
            })?.querySelector('input[type="checkbox"]');
            if (!next) break;
            next.click();
            await new Promise(r => requestAnimationFrame(r));
        }
        updateNotifSelectButton();
    }

    function selectNotifsByTag(tag) {
        clickNotifCheckboxesWhere(apiId => State.videoMeta.get(apiId)?.tags?.includes(tag), { target: true });
    }

    function findNotifPillRow() {
        for (const label of document.querySelectorAll('label')) {
            if (label.textContent.trim() !== 'Select All') continue;
            const bar = label.parentElement;
            return bar?.querySelector(':scope > div.flex') || bar || null;
        }
        return null;
    }

    const NOTIF_PILL_RGB = '100,255,0';
    function updateNotifSelectButton() {
        let btn = document.getElementById('pmv-notif-selpl');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'pmv-notif-selpl';
            btn.type = 'button';
            btn.addEventListener('click', () => {
                const initial = getNotifInPlaylistBoxes();
                const allChecked = initial.length && initial.every(b => b.checked);
                clickNotifCheckboxesWhere(isNotifVideoInPlaylist, { target: !allChecked });
            });
        }

        const row = findNotifPillRow();
        if (row && btn.parentElement !== row) row.appendChild(btn);
        else if (!row && btn.parentElement !== document.body) document.body.appendChild(btn);

        const boxes = getNotifInPlaylistBoxes();
        const allChecked = boxes.length > 0 && boxes.every(b => b.checked);
        const rgb = allChecked ? NOTIF_PILL_RGB : mixToGrayStr('64ff00');
        const base = `display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:9999px;font-size:12px;line-height:1.33;cursor:pointer;transition:all .15s;white-space:nowrap;box-sizing:border-box;font-weight:${allChecked ? 700 : 400};background:rgba(${rgb},${allChecked ? .15 : .06});border:${allChecked ? 2 : 1}px solid rgba(${rgb},${allChecked ? .5 : .35});color:rgb(${rgb});`;
        btn.style.cssText = row ? base : base + 'position:fixed;right:16px;bottom:16px;z-index:9999;';
        btn.style.opacity = boxes.length ? '1' : '0.4';
        btn.disabled = !boxes.length;
        btn.title = allChecked ? 'Deselect notifications whose video is in a playlist' : 'Select notifications whose video is in a playlist';
        btn.textContent = `\u2713 In playlist (${boxes.length})`;
    }

    // Keep the select/deselect label in sync with manual checkbox clicks.
    document.addEventListener('change', e => {
        if (e.target?.matches?.('input[type="checkbox"]') && document.getElementById('pmv-notif-selpl')) {
            updateNotifSelectButton();
        }
    }, true);

    function addRecommendedBadges() {
        // Two "Recommended" h3s exist (mobile, desktop); use the visible one.
        const h3 = [...document.querySelectorAll('h3')].find(el => {
            if (el.textContent.trim() !== 'Recommended') return false;
            return el.getClientRects().length > 0;
        });
        if (!h3) return;
        const container = h3.parentElement?.parentElement;
        if (!container) return;

        addRecommendedFilter(h3);

        const thumbDivs = [...container.querySelectorAll('.w-40')];

        // The "+" needs only the card, not the cache or a resolved id, so it goes on every card first.
        thumbDivs.forEach(thumbDiv => {
            const card = thumbDiv.parentElement;
            if (!card) return;
            const slugId = resolveRecCardVideoId(card);
            if (slugId) placeRecAddQueueButton(card, slugId);
        });

        if (!State.ready) return;

        const toFetch = [];
        thumbDivs.forEach(thumbDiv => {
            const card = thumbDiv.parentElement;
            if (!card) return;

            const slugId = resolveRecCardVideoId(card);
            if (!slugId) return;

            const apiId = State.slugToApiId.get(slugId) || slugId;

            if (card.dataset.pmvRecChecked === apiId) return;

            if (isVideoInPlaylist(apiId) || State.reverse.has(apiId)) {
                placeRecBadge(card, apiId);
            } else if (!State.slugToApiId.has(slugId)) {
                if (card.dataset.pmvRecFetching || lookupOnCooldown(slugId)) return;
                card.dataset.pmvRecFetching = '1';
                toFetch.push({ card, slugId });
            } else {
                placeRecBadge(card, apiId);
            }
        });

        if (!toFetch.length) return;

        // Concurrency follows the performance mode; slugs mapped meanwhile need no request.
        settledWithLimit(toFetch, PMVX.perf().lookups, ({ card, slugId }) =>
            (State.slugToApiId.has(slugId) ? Promise.resolve({ _id: State.slugToApiId.get(slugId) }) : fetchVideoDeduped(slugId))
                .then(v => {
                    const apiId = v?._id;
                    if (!apiId) { noteLookupFailure(slugId); return; }
                    State.slugToApiId.set(slugId, apiId);
                    placeRecBadge(card, apiId);
                })
                .catch(() => noteLookupFailure(slugId))
                .finally(() => { delete card.dataset.pmvRecFetching; })
        );
    }

    const REC_CHIP_COLORS = {
        all: 'bg-orange-500/10 border-orange-500/30 text-orange-300',
        in: 'bg-green-500/10 border-green-500/30 text-green-300',
        out: 'bg-red-500/10 border-red-500/30 text-red-300',
    };
    function applyRecChipClass(btn, active) {
        btn.className = active ? `${Q_CHIP} ${REC_CHIP_COLORS[btn.dataset.pmvRecMode] || REC_CHIP_COLORS.all}` : Q_CHIP_OFF;
    }

    function addRecommendedFilter(h3El) {
        // One-time: filter chips in the Recommended header row (the h3's parent).
        const headerRow = h3El.parentElement;
        if (!headerRow || headerRow.querySelector('#pmv-rec-filter')) return;

        const wrapper = document.createElement('div');
        wrapper.id = 'pmv-rec-filter';
        // The site's own chip-row wrapper class in this header.
        wrapper.className = 'flex items-center gap-1.5 flex-wrap';
        wrapper.style.marginLeft = '6px';

        const modes = [
            { mode: 'all',  label: 'All',            title: 'Show all recommended videos' },
            { mode: 'in',   label: 'In playlist',    title: 'Show only videos that are in one of your playlists' },
            { mode: 'out',  label: 'Not in playlist', title: 'Show only videos that are NOT in any of your playlists' },
        ];

        modes.forEach(({ mode, label, title }) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.title = title;
            btn.textContent = label;
            btn.dataset.pmvRecMode = mode;
            btn.dataset.pmvBadge = '1';
            btn.style.cursor = 'pointer';
            applyRecChipClass(btn, State.recFilterMode === mode);
            btn.dataset.pmvRecSetStyle = '1';

            btn.addEventListener('click', () => {
                State.recFilterMode = mode;
                PMVX.clearActed();
                document.querySelectorAll('#pmv-rec-filter button[data-pmv-rec-mode]').forEach(b => {
                    applyRecChipClass(b, b.dataset.pmvRecMode === mode);
                });
                document.querySelectorAll('[data-pmv-rec-checked]').forEach(el => delete el.dataset.pmvRecChecked);
                addRecommendedBadges();
            });

            wrapper.appendChild(btn);
        });

        // Badge row in the header (WiFi/ES/Personalized).
        const badgeRow = headerRow.querySelector('.flex.items-center.gap-1\\.5.flex-wrap');
        if (badgeRow) badgeRow.parentElement?.insertBefore(wrapper, badgeRow);
        else headerRow.appendChild(wrapper);
    }

    // rAF-debounced observer. Changes in own panels (ids pmv*), hidden players and the player control bar (constant re-renders) are ignored.
    function isNoiseMutation(m) {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (!t) return true;
        return !!(t.closest('[id^="pmv"]') || t.closest('.controls-bar-wrapper'));
    }
    // At most one run per frame, spaced further apart in lighter performance modes.
    const scheduleObserverRun = PMVX.scheduler(() => observerRun());
    const observer = new MutationObserver(muts => {
        if (State.observerPaused) return;
        if (muts.every(isNoiseMutation)) return;
        scheduleObserverRun();
    });
    function observerRun() {
        {
            // The Recommended sidebar is SSR and must not be blocked by quietMode/rate limiting; own idempotent run.
            try { addRecommendedBadges(); } catch {}
            try { addMoreFromBadges(); } catch {}
            try { ensureVideoInfo(); } catch {}
            try { attachFilterButton(); } catch {}
            try { applyFilterToCards(false); } catch {}
            trackMediaElements();
            sweepDetachedMedia(500);
            // Event-driven fallback, not a poller.
            try { maybeShowNextVideoNotification(); } catch {}
            if (State.quietMode) return;
            getVideo();
            const now = Date.now();
            if (now - State.lastBadgeRunAt < State.minBadgeGapMs) return;
            State.lastBadgeRunAt = now;
            scheduleBadges();
            updateNativePlaylistButtons(true);
        }
    }

