    // --- Video helpers ---

    // Volume lock (Settings, off by default): keeps the player unmuted at 100 %.
    function setVolumeLock(on) {
        State.forceVolume100 = !!on;
        try { localStorage.setItem('pmv_volume_lock_v1', on ? '1' : '0'); } catch {}
        if (on) forceVolume100({ silent: false });
    }
    function volumeLockEnabled() {
        try { return localStorage.getItem('pmv_volume_lock_v1') === '1'; } catch { return false; }
    }
    function forceVolume100({ silent = true } = {}) {
        if (!State.forceVolume100) return;
        const v = getVideo();
        if (!v) return;
        const now = Date.now();
        if (silent && now - State.lastForcedVolumeAt < 500) return;
        State.lastForcedVolumeAt = now;
        try { v.muted = false; v.volume = 1; State.lastVolume = 1; } catch {}
    }

    function getVideo() {
        if (State.video?.isConnected) return State.video;

        // Skip the hover-preview <video> (notifications): not the player, must stay muted.
        const v = document.querySelector('video:not([data-pmv-preview-video])');
        if (!v) { State.video = null; return null; }

        State.video = v;

        if (!v._pmvInit) {
            v._pmvInit = true;

            v.addEventListener('volumechange', () => {
                if (State.forceVolume100 && (v.muted || v.volume < 0.99)) {
                    setTimeout(() => forceVolume100({ silent: true }), 80);
                    return;
                }
                if (v.volume > 0) State.lastVolume = v.volume;
            });

            // Seekbar-preview: buffer the low rendition shortly after each new source plays (scrubWarm).
            const warmSoon = () => {
                clearTimeout(Scrub.warmTimer);
                Scrub.warmTimer = setTimeout(scrubWarm, SCRUB_WARM_DELAY);
            };
            v.addEventListener('playing', warmSoon);
            if (!v.paused && v.readyState >= 2) warmSoon();

            v.addEventListener('loadedmetadata', () => {
                if (State.forceVolume100) {
                    setTimeout(() => forceVolume100({ silent: true }), 80);
                    setTimeout(() => forceVolume100({ silent: true }), 600);
                }
                // Fires on every src swap (playlist auto-advance), after Vue's currentVideoIndex watch.
                try { maybeShowNextVideoNotification(); } catch {}
            });

            v.addEventListener('play', () => {
                if (State.forceVolume100) setTimeout(() => forceVolume100({ silent: true }), 80);
            });

            v.addEventListener('emptied', () => { if (State.video === v) State.video = null; });

            v.addEventListener('timeupdate', () => maybeMarkWatchedFromPlayback(v));
            v.addEventListener('ended', () => maybeMarkWatchedFromPlayback(v));
        }

        return v;
    }

    function setVolume100() {
        const v = getVideo();
        if (!v) return;
        try { v.muted = false; v.volume = 1; State.lastVolume = 1; } catch {}
        toast('Volume 100%');
    }

    function toggleMute() {
        const v = getVideo();
        if (!v) return;
        if (v.muted || v.volume === 0) {
            State.forceVolume100 = volumeLockEnabled();
            try { v.muted = false; if (!v.volume) v.volume = 1; } catch {}
            toast('Unmuted');
        } else {
            State.forceVolume100 = false;
            v.muted = true;
            toast('Muted');
        }
    }

    // --- Playlist mutation ---

    async function addToPlaylist(videoId, playlistId) {
        const res = await api(`/api/playlists/${playlistId}/add-video`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId })
        });
        if (!res.success && !res.added) return false;

        const pl = State.playlists.get(playlistId);
        if (pl) {
            pl.ids.add(videoId);
            let s = State.reverse.get(videoId);
            if (!s) { s = new Set(); State.reverse.set(videoId, s); }
            s.add(playlistId);
            saveCacheSoon();
            refreshQueuePlaylistChips(videoId);
        }
        // Filters keep this video visible until applied again (PMVX.markActed).
        PMVX.markActed(videoId);

        // The reject list is exclusive with other playlists; enforced here so every surface behaves the same.
        if (isRejectList(playlistId)) {
            const others = getMatches(videoId).filter(p => p.id !== playlistId);
            if (others.length) await Promise.allSettled(others.map(p => removeFromPlaylist(videoId, p.id)));
        } else if (isRejected(videoId)) {
            await removeFromPlaylist(videoId, rejectPlaylistId).catch(() => {});
        }
        return true;
    }

    async function removeFromPlaylist(videoId, playlistId) {
        const res = await api(`/api/playlists/${playlistId}/remove-video`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId })
        });
        if (!res.success) return false;

        State.playlists.get(playlistId)?.ids.delete(videoId);
        State.reverse.get(videoId)?.delete(playlistId);
        saveCacheSoon();
        refreshQueuePlaylistChips(videoId);
        PMVX.markActed(videoId);
        return true;
    }

    // --- Light cleanup ---

    function pauseObserverBriefly(ms = 1000) {
        if (!observer || State.observerPaused) return;
        State.observerPaused = true;
        try { observer.disconnect(); } catch {}
        setTimeout(() => {
            try {
                observer.observe(document.body, { childList: true, subtree: true });
            } catch {}
            State.observerPaused = false;
        }, ms);
    }

    // Lazily unloads far-offscreen thumbnails; src restored from dataset.pmvOrigSrc on intersect. Stays
    // observed after stripping: a display:none row never intersects, so unobserving would leave it blank.
    const _farOffscreenIO = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const img = entry.target;
            if (entry.isIntersecting) {
                // A cleared img.src reads back as the document URL, so the pmvUnloaded marker is required.
                if (img.dataset.pmvUnloaded === '1' && img.dataset.pmvOrigSrc) {
                    img.src = img.dataset.pmvOrigSrc;
                    delete img.dataset.pmvUnloaded;
                }
                return;
            }
            if (img.dataset.pmvUnloaded === '1') return;
            const src = img.src || '';
            const looksLikeThumb = src.includes('/thumbnail/') || src.includes('webp320') ||
                                   src.includes('thumb') || img.closest('[data-video-id]');
            if (!looksLikeThumb) return;
            img.dataset.pmvOrigSrc = src;
            img.dataset.pmvUnloaded = '1';
            img.removeAttribute('srcset');
            img.removeAttribute('sizes');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = '';
        });
    }, { rootMargin: '2500px' });

    function unloadFarOffscreenImages() {
        document.querySelectorAll('img').forEach(img => _farOffscreenIO.observe(img));
    }

    function softDomClean() {
        pauseObserverBriefly(1000);
        closeHud();
        removeProgressBar();

        document.querySelectorAll('#pmv-toast, #pmv-progress-bar, #pmv-ctx-menu, #pmv-page-playlists, [data-pmv-badge="1"]').forEach(el => el.remove());

        // Reset markers so badges and page playlist buttons are re-placed.
        document.querySelectorAll('[data-pmv-checked]').forEach(el => delete el.dataset.pmvChecked);
        document.querySelectorAll('[data-pmv-queue-checked]').forEach(el => delete el.dataset.pmvQueueChecked);
        document.querySelectorAll('[data-pmv-rec-checked]').forEach(el => delete el.dataset.pmvRecChecked);

        State.nativePlaylistButtonLastVideoId = null;

        unloadFarOffscreenImages();
        State.currentVideoData = null;

        setTimeout(() => {
            if (!State.quietMode) {
                scheduleBadges();
                kickRecommended();
                requestAnimationFrame(() => updateNativePlaylistButtons(true));
            }
        }, 1000);
    }

    // --- UI: toast / HUD / thumbnails ---

    // color: 'green' | 'red' | null; `under`: anchor element (the toast sits below it, right-aligned).
    PMVX.toast = (...a) => toast(...a);
    function toast(msg, color, { under = null } = {}) {
        document.getElementById('pmv-toast')?.remove();
        if (!color) {
            if (/^playlists refreshed$/i.test(msg) || /^refreshing playlists/i.test(msg) ||
                /^volume locked/i.test(msg)        || /^unmuted/i.test(msg)) {
                color = 'green';
            }
        }
        const isGreen = color === 'green';
        const isRed   = color === 'red';
        const el = document.createElement('div');
        el.id = 'pmv-toast';
        el.textContent = msg;
        el.style.cssText = `position:fixed;bottom:30px;right:30px;` +
            `background:${isGreen ? 'rgba(20,60,10,0.92)' : isRed ? 'rgba(60,10,10,0.92)' : 'rgba(0,0,0,0.86)'};` +
            `color:${isGreen ? 'rgb(120,255,60)' : isRed ? 'rgb(255,90,90)' : 'white'};` +
            `border:1px solid ${isGreen ? 'rgba(100,255,0,0.45)' : isRed ? 'rgba(255,60,60,0.45)' : 'transparent'};` +
            `padding:10px 14px;border-radius:10px;z-index:999999;font-size:14px;pointer-events:none;`;
        const anchor = under && !document.fullscreenElement && under.isConnected ? under.getBoundingClientRect() : null;
        if (anchor && anchor.width) {
            el.style.bottom = 'auto';
            el.style.top = Math.round(anchor.bottom + 8) + 'px';
            el.style.right = Math.max(8, Math.round(window.innerWidth - anchor.right)) + 'px';
        }
        (document.fullscreenElement || document.body).appendChild(el);
        clearTimeout(State.toastTimeout);
        State.toastTimeout = setTimeout(() => el.remove(), 2500);
    }

    function parseTimestamp(text) {
        if (!text) return null;
        const parts = text.trim().split(':').map(Number);
        if (parts.some(Number.isNaN)) return null;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return null;
    }

    function formatThumbTime(seconds) {
        if (!Number.isFinite(seconds)) return '';
        const total = Math.round(seconds);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    // An <img> src as the site set it, even after unloadFarOffscreenImages() emptied it (reads back as the
    // page URL). Needed for the site's timeline strip, which is always off-screen and emptied in fullscreen.
    function pageImgSrc(img) {
        if (!img) return '';
        if (img.dataset.pmvUnloaded === '1') return img.dataset.pmvOrigSrc || '';
        return img.getAttribute('src') ? img.src : '';
    }

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

    // --- Native action buttons ---
    // Cloned into the HUD to stay reachable; one detector for every page with this row.

    function findNativeActionBar() {
        // Signals from specific to generic (labels vary per page, change on click); first match walked up to its row.
        const anchorStrategies = [
            () => document.querySelector('[aria-label="Like video"]'),
            () => document.querySelector('[aria-label^="Like"]'),
            () => [...document.querySelectorAll('button[title]')]
                .find(b => /^(Like|Unlike)\b/.test(b.title)),
        ];
        const containerSelectors = [
            '.flex.items-center.gap-2',
            '.flex.items-center.gap-3',
            '.flex.items-center.gap-1',
        ];

        for (const tryAnchor of anchorStrategies) {
            const anchor = tryAnchor();
            if (!anchor) continue;
            for (const sel of containerSelectors) {
                const container = anchor.closest(sel);
                if (container) return container;
            }
            if (anchor.parentElement) return anchor.parentElement;
        }
        return null;
    }

    // The site's favourite button (by title): clicking it keeps the site's count, icon and cache in step; the HUD
    // clone is skipped (title is a snapshot). Stale fallback: PUT /api/videos/<id>/favorite {action: "favorite"|"unfavorite"}
    async function toggleFavouriteViaApi() {
        const videoId = getCurrentVideoId();
        if (!videoId) { toast('No video'); return; }

        // Direction from the video's data (cached, else one lookup); unknown = not favourited, so the key adds.
        let wasOn = false;
        const cvd = State.currentVideoData;
        if (cvd?.id === videoId) wasOn = cvd.isFavorited === true;
        else {
            try { wasOn = (await fetchVideoDeduped(videoId))?.isFavorited === true; } catch {}
        }

        try {
            const res = await fetch(`/api/videos/${videoId}/favorite`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ action: wasOn ? 'unfavorite' : 'favorite' }),
            });
            // Fail loudly: a failed call leaves no trace on the page.
            if (!res.ok) { toast(`Favourite failed (${res.status})`, 'red'); return; }
        } catch { toast('Favourite failed', 'red'); return; }

        if (State.currentVideoData?.id === videoId) State.currentVideoData.isFavorited = !wasOn;
        toast(wasOn ? '\u2715 Removed from favourites' : '\u2713 Added to favourites', wasOn ? 'red' : 'green');
    }

    function findFavouriteButton() {
        return [...document.querySelectorAll('button[title]')].find(btn =>
            /^(add to|remove from) favorites$/i.test((btn.title || '').trim())
            && !(State.hud && State.hud.contains(btn))) || null;
    }

    // Set by the HUD's cloned buttons right before forwarding a click; read once, within 500 ms.
    let forwardedAnchor = null;
    function takeForwardedAnchor() {
        const a = forwardedAnchor;
        forwardedAnchor = null;
        return a && performance.now() - a.at < 500 ? a.rect : null;
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

    // Stand-ins while fullscreen is ahead of the page: PUT /api/videos/<id>/like|dislike|favorite {action: "like"|"unlike"|...}
    // for the video playing. Initial state from /api/videos/<id> (isLiked/isDisliked/isFavorited), via refreshHudAfterHandover.
    const API_BTN_BASE = 'inline-flex items-center justify-center px-3 py-1.5 rounded-lg transition-all text-sm w-[52px]';
    const API_BTN_OFF = 'bg-[#2A2A2A] text-gray-400 hover:bg-[#3A3A3A] hover:text-white';
    const lucide = paths => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths.map(d => `<path d="${d}"/>`).join('')}</svg>`;
    const API_BTNS = [
        { key: 'liked', endpoint: 'like', on: 'like', off: 'unlike', cls: 'bg-green-500/20 text-green-400 hover:bg-green-500/30',
          title: on => on ? 'Unlike' : 'Like video',
          icon: lucide(['M7 10v12', 'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z']) },
        { key: 'disliked', endpoint: 'dislike', on: 'dislike', off: 'undislike', cls: 'bg-red-500/20 text-red-400 hover:bg-red-500/30',
          title: on => on ? 'Remove dislike' : 'Dislike video',
          icon: lucide(['M17 14V2', 'M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z']) },
        { key: 'favorited', endpoint: 'favorite', on: 'favorite', off: 'unfavorite', cls: 'bg-pink-500/20 text-pink-400 hover:bg-pink-500/30',
          title: on => on ? 'Remove from favorites' : 'Add to favorites',
          icon: lucide(['M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z']) },
    ];

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

