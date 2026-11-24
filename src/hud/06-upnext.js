    // --- Up next queue ---
    // Ranked by constraints and tag affinity from the user's playlists; candidates from State.videoMeta.
    function computeTagAffinity() {
        const scores = new Map();
        State.videoMeta.forEach((meta, id) => {
            if (!State.reverse.has(id)) return; // only videos in at least one playlist
            const weight = (meta.bayesianRating || 50) / 100;
            (meta.tags || []).forEach(tag => {
                scores.set(tag, (scores.get(tag) || 0) + weight);
            });
        });
        return scores;
    }

    function durationToMinutes(raw) {
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw / 60;
        if (typeof raw === 'string' && raw.includes(':')) {
            const parts = raw.split(':').map(n => parseInt(n, 10));
            if (parts.some(Number.isNaN)) return 0;
            return parts.reduce((acc, n) => acc * 60 + n, 0) / 60;
        }
        return 0;
    }

    // One ordered, drag-reorderable list; manuallyAddedIds marks user adds (order is independent).
    let smartQueueItems = []; // [{id, meta}], order = play order
    let manuallyAddedIds = new Set();
    // Set once the queue is used; gates auto-top-up. Reset by "clear".
    let smartQueueActive = false;
    // Index of the playing item: earlier entries are history, later ones upcoming. -1 = none from the queue.
    let queueCursor = -1;
    // Played items kept (capped); one shown, "Show more" reveals older ones in steps.
    const QUEUE_HISTORY_MAX = 200;
    const QUEUE_HISTORY_SHOWN = 1;
    const QUEUE_HISTORY_STEP = 10;
    let queueHistoryShown = QUEUE_HISTORY_SHOWN;
    // Id of a playing row the user removed, so syncQueueCursor() does not re-add it until they move on.
    let dismissedCurrentId = null;
    let queueSettingsOpen = false;
    let queueCollapsed = false;

    // Per-tab sessionStorage: survives page loads, stays out of the settings export.
    const QUEUE_STATE_KEY = 'pmv_queue_v1';
    // Dated localStorage copy, adopted by an empty tab (sessionStorage dies with the browser).
    const QUEUE_BACKUP_KEY = 'pmv_queue_backup_v1';
    const QUEUE_BACKUP_MAX_AGE_MS = 12 * 60 * 60 * 1000;

    function saveQueueState() {
        const state = {
            items: smartQueueItems,
            manual: [...manuallyAddedIds],
            active: smartQueueActive,
            collapsed: queueCollapsed,
            cursor: queueCursor,
        };
        try {
            sessionStorage.setItem(QUEUE_STATE_KEY, JSON.stringify(state));
        } catch { /* quota/private mode — queue just won't survive the hop */ }
        try {
            localStorage.setItem(QUEUE_BACKUP_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
        } catch {}
    }

    function loadQueueBackup() {
        try {
            const d = JSON.parse(localStorage.getItem(QUEUE_BACKUP_KEY) || 'null');
            if (!d || !Array.isArray(d.items) || !d.items.length) return null;
            if (!Number.isFinite(d.savedAt) || Date.now() - d.savedAt > QUEUE_BACKUP_MAX_AGE_MS) return null;
            return d;
        } catch { return null; }
    }

    function loadQueueState() {
        try {
            const d = JSON.parse(sessionStorage.getItem(QUEUE_STATE_KEY) || 'null') || loadQueueBackup();
            if (!d) return;
            if (Array.isArray(d.items)) smartQueueItems = d.items.filter(it => it && typeof it.id === 'string');
            if (Array.isArray(d.manual)) manuallyAddedIds = new Set(d.manual);
            smartQueueActive = !!d.active;
            queueCollapsed = !!d.collapsed;
            queueCursor = Number.isInteger(d.cursor) ? d.cursor : -1;
            if (!sessionStorage.getItem(QUEUE_STATE_KEY)) saveQueueState();
        } catch { /* corrupt entry — start empty rather than break boot */ }
    }
    loadQueueState();

    // Queue settings are a preference: localStorage, included in the settings export.
    const QUEUE_SETTINGS_KEY = 'pmv_queue_settings_v1';
    const QUEUE_SETTINGS_DEFAULTS = { count: 20, minRating: 0, maxDuration: 0, unseenOnly: false, tagFilter: '', autoRefill: true, targetSize: 5, useNfFilter: true, freshEvery: 20, freshEveryFs: 10 };
    function loadQueueSettings() {
        try { return { ...QUEUE_SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem(QUEUE_SETTINGS_KEY) || '{}') }; }
        catch { return { ...QUEUE_SETTINGS_DEFAULTS }; }
    }
    let queueSettings = loadQueueSettings();
    function saveQueueSettings() {
        try { localStorage.setItem(QUEUE_SETTINGS_KEY, JSON.stringify(queueSettings)); } catch { /* quota/private mode */ }
    }

    // DOM fallback per card. Walks text nodes: textContent glues fields together, childless scans miss icon spans.
    function cardLeafTexts(card) {
        const out = [];
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n.textContent.trim();
            if (t) out.push(t);
        }
        return out;
    }

    const RATING_RE = /^\d{1,3}%$/;
    const DURATION_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
    const ASPECT_LABELS = new Set(['9:16', '16:10', '10:16', '9:21', '21:10']);

    function scrapeCardTitle(card, leaves) {
        // Grids use <h4>; the Recommended sidebar has none, so img alt, then the longest text.
        const h4 = card.querySelector('h4')?.textContent?.trim();
        if (h4) return h4;
        const alt = card.querySelector('img')?.getAttribute('alt')?.trim();
        if (alt) return alt;
        const candidates = leaves.filter(t =>
            t.length > 3 && !RATING_RE.test(t) && !DURATION_RE.test(t) &&
            !/\bviews?\b/i.test(t) && !/^[•·|]$/.test(t) &&
            !/^\w{3} \d{1,2}, \d{4}$/.test(t));
        return candidates.sort((a, b) => b.length - a.length)[0];
    }

    // Chip title "Search for: #Tag" beats its text; never click "+N" open (re-triggers the observer, loops).
    function scrapeCardTags(card) {
        const out = new Set();
        // The "#" matters: the track chip uses "Search for: <artist> - <song>".
        card.querySelectorAll('[title^="Search for:"]').forEach(el => {
            const raw = el.getAttribute('title');
            if (!/^Search for:\s*#/.test(raw)) return;
            const t = raw.replace(/^Search for:\s*#/, '').trim();
            if (t) out.add(t.toLowerCase());
        });
        if (!out.size) {
            card.querySelectorAll('button, a, span').forEach(el => {
                if (el.childElementCount) return;
                const t = el.textContent.trim();
                if (/^#\S/.test(t)) out.add(t.slice(1).toLowerCase());
            });
        }
        return [...out];
    }

    function scrapeCardMeta(card) {
        if (!card) return {};
        const leaves = cardLeafTexts(card);
        const rating = leaves.find(t => RATING_RE.test(t));
        // Some cards show an aspect pill ("9:16") that looks like a time.
        const times = leaves.filter(t => DURATION_RE.test(t));
        const duration = times.length > 1 ? (times.find(t => !ASPECT_LABELS.has(t)) || times[times.length - 1]) : times[0];
        const viewsIdx = leaves.findIndex(t => /\bviews?\b/i.test(t));
        const img = card.querySelector('img');
        const uploaderLink = card.querySelector('a[href^="/profile/"], a[href^="/user/"]')?.textContent?.trim();
        return {
            title: scrapeCardTitle(card, leaves),
            thumbnailUrl: img?.getAttribute('src') || img?.src || undefined,
            bayesianRating: rating ? parseInt(rating, 10) : undefined,
            duration: duration || undefined,
            uploaderDisplay: uploaderLink || (viewsIdx > 0 ? leaves[viewsIdx - 1] : undefined),
            tags: scrapeCardTags(card),
        };
    }

    // Cache wins, DOM fills gaps (State.currentVideoData too); only the five row fields, for sessionStorage.
    function currentPageMeta(id) {
        const cvd = State.currentVideoData;
        if (!cvd || cvd.id !== id) return {};
        const v = getVideo();
        const secs = v && Number.isFinite(v.duration) ? Math.round(v.duration) : 0;
        return {
            title: cvd.title || undefined,
            uploaderDisplay: cvd.creator || undefined,
            bayesianRating: cvd.bayesianRating ?? undefined,
            thumbnailUrl: v?.poster || undefined,
            duration: secs > 0 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : undefined,
        };
    }

    function resolveQueueMeta(id, card) {
        const cached = State.videoMeta.get(id);
        const scraped = card ? scrapeCardMeta(card) : currentPageMeta(id);
        return {
            title: cached?.title || scraped.title,
            thumbnailUrl: cached?.thumbnailUrl || scraped.thumbnailUrl,
            duration: cached?.duration || scraped.duration,
            uploaderDisplay: cached?.uploaderDisplay || scraped.uploaderDisplay,
            bayesianRating: cached?.bayesianRating ?? scraped.bayesianRating,
        };
    }

    // Carry the card's own href (its hex is the slug id, not the API _id); swaps in place via the Vue Router.
    // A route change detaches <video> without pausing it and detached media keeps decoding (the player may
    // even restart it), so every media element seen is muted and unsourced once detached, never before.
    let inPlaceHandover = false;

    const seenMediaEls = new Set();
    const mediaDetachedAt = new WeakMap();

    function killDetachedMedia(el) {
        try {
            el.pause();
            el.muted = true;
            el.removeAttribute('src');
            el.srcObject = null;
            el.load();
        } catch {}
    }

    function mediaIsDead(el) {
        return el.paused && !el.currentSrc && !el.getAttribute('src') && !el.srcObject;
    }

    function trackMediaElements() {
        document.querySelectorAll('video, audio').forEach(el => {
            if (seenMediaEls.has(el)) return;
            seenMediaEls.add(el);
            // The player can restart a detached element at any time, so tear down on play.
            el.addEventListener('play', () => { if (!el.isConnected) killDetachedMedia(el); });
        });
    }

    // graceMs (0 during navigation): the site moves its player between containers, so detached != discarded.
    function sweepDetachedMedia(graceMs = 0) {
        const now = Date.now();
        seenMediaEls.forEach(el => {
            if (el.isConnected) { mediaDetachedAt.delete(el); return; }
            // Already dead: drop to bound the set; its play listener still covers a restart.
            if (mediaIsDead(el)) { seenMediaEls.delete(el); return; }
            const since = mediaDetachedAt.get(el);
            if (since === undefined) {
                mediaDetachedAt.set(el, now);
                if (graceMs) return;
            } else if (graceMs && now - since < graceMs) {
                return;
            }
            killDetachedMedia(el);
        });
    }

    // Detaching happens somewhere in the transition, so sweep throughout; prune only at the end.
    let mediaSweepTimer = null;
    function sweepDetachedMediaFor(ms = 3000) {
        trackMediaElements();
        if (!inPlaceHandover) document.querySelectorAll('video, audio').forEach(el => { try { el.pause(); } catch {} });
        clearInterval(mediaSweepTimer);
        const until = Date.now() + ms;
        mediaSweepTimer = setInterval(() => {
            sweepDetachedMedia();
            if (Date.now() <= until) return;
            clearInterval(mediaSweepTimer);
        }, 100);
    }

    function stopCurrentPlayback() { sweepDetachedMediaFor(); }

    PMVX.navigate = href => navigateInPage(href);
    function navigateInPage(href) {
        if (!href) return false;
        try {
            const router = document.querySelector('#__nuxt')?.__vue_app__?.config?.globalProperties?.$router;
            if (!router?.push) return false;
            stopCurrentPlayback();
            router.push(href);
            return true;
        } catch {}
        return false;
    }

    // --- Fullscreen hand-over ---
    // A route change ends fullscreen, which cannot be re-requested. In fullscreen the next video loads into
    // the same <video> instead; the page catches up when fullscreen ends.
    let staleFullscreenHref = null;
    // API id playing in place; the page holds the earlier video until it catches up.
    let staleFullscreenId = null;

    async function videoStreamUrl(videoId) {
        // Deduped: the page-data lookup that follows is answered from this.
        try {
            const video = await fetchVideoDeduped(videoId);
            if (!video) return null;
            return (video.hlsEnabled && video.hlsMasterPlaylistUrl) ? video.hlsMasterPlaylistUrl : (video.videoUrl || null);
        } catch { return null; }
    }

    async function playInPlace(href, videoId) {
        if (!document.fullscreenElement || !videoId) return false;
        const api = findPlayerApi();
        const hls = api?.hls?.value;
        const video = api?.videoElement?.value;
        if (!hls || !video || typeof hls.loadSource !== 'function') return false;

        const url = await videoStreamUrl(videoId);
        // Fullscreen may have ended meanwhile; navigate normally then.
        if (!url || !document.fullscreenElement) return false;

        // Detach first: a new hls.js source over buffered data causes bufferAppendError.
        // Without startPosition hls.js resumes at the previous source's position; force 0, then restore.
        try {
            const prevStart = hls.config.startPosition;
            hls.config.startPosition = 0;
            const restore = () => { try { hls.config.startPosition = prevStart; } catch {} };
            try { hls.once?.('hlsFragLoaded', restore); } catch {}
            setTimeout(restore, 15000);
            hls.stopLoad();
            hls.detachMedia();
            hls.loadSource(url);
            hls.attachMedia(video);
        } catch { return false; }
        try { video.play()?.catch(() => {}); } catch {}

        guardHandoverStart(video);
        // The script reads the video id from the address bar.
        try { history.replaceState(history.state, '', href); } catch {}
        staleFullscreenHref = href;
        staleFullscreenId = videoId;
        const hudWasOpen = !!State.hud;
        inPlaceHandover = true;
        try { onUrlChange(); } catch {} finally { inPlaceHandover = false; }
        // onUrlChange closes the panel; restore it once the new video's data has arrived.
        refreshHudAfterHandover(videoId, hudWasOpen);
        return true;
    }

    // The page re-applies its own video's watchProgress % on each loaded source, so a handed-over video would
    // jump there. For a few seconds, an unrequested seek (no click/key since) goes back to 0.
    let handoverGuardOff = null;
    function guardHandoverStart(video) {
        handoverGuardOff?.();
        let userActed = false;
        const onInput = () => { userActed = true; };
        const onSeeking = () => {
            if (userActed || !(video.currentTime > 1)) return;
            try { video.currentTime = 0; } catch {}
        };
        window.addEventListener('pointerdown', onInput, true);
        window.addEventListener('keydown', onInput, true);
        video.addEventListener('seeking', onSeeking);
        const off = () => {
            window.removeEventListener('pointerdown', onInput, true);
            window.removeEventListener('keydown', onInput, true);
            video.removeEventListener('seeking', onSeeking);
            clearTimeout(timer);
            if (handoverGuardOff === off) handoverGuardOff = null;
        };
        const timer = setTimeout(off, 6000);
        handoverGuardOff = off;
    }

    // Nothing re-renders the panel when the core's fetch lands; rebuild once the data is there (with timeout).
    function refreshHudAfterHandover(videoId, wasOpen) {
        if (!wasOpen) return;
        let tries = 0;
        const timer = setInterval(() => {
            const ready = State.currentVideoData?.id === videoId;
            if (!ready && ++tries <= 20) return;
            clearInterval(timer);
            if (document.fullscreenElement && staleFullscreenHref) {
                try { showHud(); } catch {}
            }
        }, 150);
    }

    // Restore the position once the page catches up; retried until the player can seek.
    function resumePlaybackAt(seconds) {
        if (!(seconds > 1)) return;
        let tries = 0;
        const timer = setInterval(() => {
            const video = getVideo();
            if (video && video.readyState > 0 && Number.isFinite(video.duration)) {
                try { video.currentTime = Math.min(seconds, Math.max(0, video.duration - 1)); } catch {}
                clearInterval(timer);
                return;
            }
            if (++tries > 24) clearInterval(timer);
        }, 250);
    }

    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement || !staleFullscreenHref || freshLoading) return;
        const href = staleFullscreenHref;
        staleFullscreenHref = null;
        staleFullscreenId = null;
        const at = (() => { try { return getVideo()?.currentTime || 0; } catch { return 0; } })();
        if (freshLoadDue()) { freshLoad(href, at); return; }
        if (!navigateInPage(href)) { location.href = href; return; }
        resumePlaybackAt(at);
        // The URL already points here, so onUrlChange won't react; run the after-navigation work directly.
        setTimeout(() => {
            try { kickRecommended(); } catch {}
            try { scheduleBadges(); } catch {}
            try { updateNativePlaylistButtons(true); } catch {}
        }, 150);
    });

    // Video links without the site's referral marker (?from=home, ?from=recommended …).
    function cleanVideoHref(href) {
        if (!href) return href;
        try {
            const u = new URL(href, location.origin);
            u.searchParams.delete('from');
            return u.pathname + (u.search === '?' ? '' : u.search) + u.hash;
        } catch { return href; }
    }

    // Full load every N videos: in-page hops leak site state; the queue survives in sessionStorage. Fullscreen
    // has a lower count: a browser re-enters fullscreen only on a click or key, so the new page asks for one.
    const FRESH_LOAD_KEY = 'pmvx_fresh_load_v1';
    let videoHopsThisPage = 0;
    let freshLoading = false;
    function freshLoadDue(fullscreen = false) {
        const n = fullscreen ? queueSettings.freshEveryFs : queueSettings.freshEvery;
        return n > 0 && videoHopsThisPage >= n;
    }
    function freshLoad(href, resumeAt = 0, fs = false) {
        freshLoading = true;
        try { saveQueueState(); } catch {}
        try {
            const path = new URL(href, location.origin).pathname;
            sessionStorage.setItem(FRESH_LOAD_KEY, JSON.stringify({ at: Date.now(), path, t: resumeAt || 0, fs }));
        } catch {}
        try { document.querySelectorAll('video, audio').forEach(el => el.pause()); } catch {}
        location.href = href;
    }
    // One click or key (Esc skips) restores fullscreen and plays; the gesture also unblocks autoplay.
    function offerFullscreenResume(video) {
        if (document.getElementById('pmvx-fs-resume')) return;
        const ov = document.createElement('div');
        ov.id = 'pmvx-fs-resume';
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);cursor:pointer;';
        ov.innerHTML = `<div style="display:flex;align-items:center;gap:14px;padding:18px 26px;border-radius:14px;background:rgba(0,0,0,0.82);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.12);color:#fff;font:600 16px/1.3 system-ui,sans-serif;">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
            <div>Continue in fullscreen<div style="font-weight:400;font-size:12px;color:rgba(255,255,255,0.6);margin-top:2px;">Click or press any key \u00b7 Esc to stay here</div></div>
        </div>`;
        const done = () => {
            ov.remove();
            window.removeEventListener('keydown', onKey, true);
        };
        const go = () => {
            done();
            try { playerFullscreenTarget()?.requestFullscreen?.().catch(() => {}); } catch {}
            try { (getVideo() || video).play()?.catch(() => {}); } catch {}
        };
        const onKey = e => {
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === 'Escape') done(); else go();
        };
        ov.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); go(); });
        window.addEventListener('keydown', onKey, true);
        document.body.appendChild(ov);
    }
    // After a fresh load: play (and seek back) once ready; hint if autoplay is blocked.
    (function resumeAfterFreshLoad() {
        let d = null;
        try {
            d = JSON.parse(sessionStorage.getItem(FRESH_LOAD_KEY) || 'null');
            sessionStorage.removeItem(FRESH_LOAD_KEY);
        } catch {}
        if (!d || Date.now() - d.at > 60000 || d.path !== location.pathname) return;
        let tries = 0;
        const timer = setInterval(() => {
            const v = getVideo();
            if (!v || (v.readyState < 1 && !d.fs)) { if (++tries > 80) clearInterval(timer); return; }
            clearInterval(timer);
            if (d.t > 1) resumePlaybackAt(d.t);
            if (d.fs) { try { v.play()?.catch(() => {}); } catch {} offerFullscreenResume(v); return; }
            if (!v.paused) return;
            const p = v.play();
            if (p?.catch) p.catch(() => toast('Fresh page loaded \u2014 press play to continue'));
        }, 250);
    })();

    function goToVideo(href, id) {
        const target = cleanVideoHref(href) || `/video/${id}`;
        if (document.fullscreenElement && id && freshLoadDue(true)) { freshLoad(target, 0, true); return; }
        if (document.fullscreenElement && id) {
            playInPlace(target, id).then(handled => {
                if (handled) return;
                if (!navigateInPage(target)) location.href = target;
            });
            return;
        }
        if (freshLoadDue()) { freshLoad(target); return; }
        if (!navigateInPage(target)) location.href = target;
    }

    function cardHref(card) {
        if (!card) return null;
        const href = card.tagName === 'A'
            ? card.getAttribute('href')
            : card.querySelector('a[href*="/video/"]')?.getAttribute('href');
        return href && href.includes('/video/') ? cleanVideoHref(href) : null;
    }

    // Slug URL from the slug-to-API-id map for items without a card; null = use the bare id.
    function knownHrefForId(apiId) {
        for (const [slugId, mapped] of State.slugToApiId) {
            if (mapped === apiId) return `/video/${slugId}`;
        }
        return null;
    }

    // Keeps queueCursor on the playing item; a video opened outside the queue is inserted after it.
    function syncQueueCursor() {
        if (!location.pathname.startsWith('/video/')) return;
        const id = getCurrentVideoId();
        if (!id) return;

        if (dismissedCurrentId && dismissedCurrentId !== id) dismissedCurrentId = null;

        const idx = smartQueueItems.findIndex(it => it.id === id);
        if (idx !== -1 && idx !== queueCursor && idx !== queueCursor + 1) {
            // Opened out of turn: cut in after the current one; the rest keeps its order (not counted as played).
            const [item] = smartQueueItems.splice(idx, 1);
            if (idx < queueCursor) queueCursor--;
            queueCursor++;
            smartQueueItems.splice(queueCursor, 0, item);
        } else if (idx !== -1) { queueCursor = idx; }
        else if (smartQueueActive && id !== dismissedCurrentId) {
            const at = Math.min(queueCursor + 1, smartQueueItems.length);
            smartQueueItems.splice(at, 0, {
                id,
                href: cleanVideoHref(location.pathname + location.search),
                meta: resolveQueueMeta(id),
            });
            queueCursor = at;
        } else return;

        trimQueueHistory();
    }

    function upcomingCount() {
        return Math.max(0, smartQueueItems.length - (queueCursor + 1));
    }

    function trimQueueHistory() {
        const excess = queueCursor - QUEUE_HISTORY_MAX;
        if (excess <= 0) return;
        smartQueueItems.splice(0, excess);
        queueCursor -= excess;
    }

    // Items after the playing one, or null when it is not the queue's current item.
    function queueRemaining() {
        syncQueueCursor();
        if (queueCursor < 0 || !smartQueueItems.length) return null;
        if (smartQueueItems[queueCursor]?.id !== getCurrentVideoId()) return null;
        return upcomingCount();
    }

    // Position of a video among the videos still to come in Up next (1 = next), or 0.
    function queuedPosition(id) {
        if (!id) return 0;
        const idx = smartQueueItems.findIndex(it => it.id === id);
        return idx > queueCursor ? idx - queueCursor : 0;
    }
    // Card's Up next button shows the queue position; Recommended rows use slug ids, so API id first.
    function syncQueueCardBtn(btn) {
        const raw = btn.dataset.qid;
        const pos = queuedPosition(State.slugToApiId.get(raw)) || queuedPosition(raw);
        const on = pos > 0;
        if ((btn.dataset.on === '1') === on && (!on || btn.dataset.qpos === String(pos))) return;
        btn.dataset.on = on ? '1' : '';
        if (on) btn.dataset.qpos = String(pos); else delete btn.dataset.qpos;
        btn.title = on ? `In Up next (#${pos}) \u2014 click to remove` : 'Add to Up next';
    }
    function syncQueueCardBtns() {
        document.querySelectorAll('[data-pmv-addqueue], [data-pmv-rec-addqueue]').forEach(syncQueueCardBtn);
    }

    function addVideoToQueue(videoId, card, hrefOverride, metaOverride) {
        if (!videoId) { toast('No video'); return; }
        smartQueueActive = true;
        manuallyAddedIds.add(videoId);
        const was = smartQueueItems.findIndex(it => it.id === videoId);
        if (was !== -1 && was >= queueCursor) {
            toast('Already in Up next', null, { under: upNextToastAnchor() });
            renderQueueSidebar();
            return;
        }
        if (was !== -1) {
            smartQueueItems.splice(was, 1);
            queueCursor--;                           // keep pointing at the same item
        }
        const href = hrefOverride || cardHref(card) || (card ? null : location.pathname + location.search);
        smartQueueItems.push({ id: videoId, href, meta: metaOverride || resolveQueueMeta(videoId, card) });
        toast(`+ Added to Up next (${upcomingCount()})`, 'green', { under: upNextToastAnchor() });
        renderQueueSidebar();
    }
    // Up next messages appear under the header button (or its open panel).
    function upNextToastAnchor() {
        const panel = document.getElementById('pmv-queue-floating');
        if (panel && panel.getClientRects().length) return panel;
        return [...document.querySelectorAll('[data-pmv-queue-btn]')].find(b => b.getClientRects().length) || null;
    }
    function addCurrentVideoToQueue() { addVideoToQueue(getCurrentVideoId()); }
    // For panels with their own video lists (star popout): id and link known, no card.
    PMVX.upNext = {
        add: (id, href, meta) => addVideoToQueue(id, null, href, meta),
        remove: id => { removeFromQueue(id); toast('\u2212 Removed from Up next', null, { under: upNextToastAnchor() }); },
        position: id => queuedPosition(id),
    };
    // A row added under its slug id is re-keyed in place once the API _id is known.
    function adoptResolvedQueueId(tempId, realId) {
        if (tempId === realId) return;
        const idx = smartQueueItems.findIndex(it => it.id === tempId);
        if (idx === -1) return;
        const dupe = smartQueueItems.findIndex(it => it.id === realId);
        if (dupe !== -1 && dupe !== idx) smartQueueItems.splice(idx, 1);
        else smartQueueItems[idx] = { ...smartQueueItems[idx], id: realId };
        if (manuallyAddedIds.delete(tempId)) manuallyAddedIds.add(realId);
        renderQueueSidebar();
    }

    function removeFromQueue(videoId) {
        manuallyAddedIds.delete(videoId);
        const idx = smartQueueItems.findIndex(it => it.id === videoId);
        if (idx === -1) return;
        smartQueueItems.splice(idx, 1);
        if (videoId === getCurrentVideoId()) dismissedCurrentId = videoId;
        if (idx < queueCursor) queueCursor--;
        else if (idx === queueCursor) queueCursor = idx - 1; // nothing from the queue is playing
        renderQueueSidebar();
    }

    // Visible "Recommended" (mobile and desktop h3 exist): the h3's grandparent, or null off /video/.
    function findVisibleRecommendedContainer() {
        const h3 = [...document.querySelectorAll('h3')].find(el => {
            if (el.textContent.trim() !== 'Recommended') return false;
            // No boxes: inside a display:none ancestor.
            return el.getClientRects().length > 0;
        });
        return h3?.parentElement?.parentElement || null;
    }

    // Site's Tailwind classes copied from a Recommended card; only classes in the compiled CSS work.
    const Q_CHIP = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border';
    const Q_CHIP_ON = `${Q_CHIP} bg-orange-500/10 border-orange-500/30 text-orange-300`;
    const Q_CHIP_OFF = `${Q_CHIP} bg-white/5 border-white/10 text-gray-400`;
    const Q_CHIP_ADD = `${Q_CHIP} bg-green-500/10 border-green-500/30 text-green-300`;

    // Titles, uploaders and playlist names can contain markup; escape everything interpolated.
    function escHtml(v) {
        return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    const QUEUE_IN_PLAYLIST_RGB = '100,255,0';

    function queuePlaylistChipsHtml(videoId) {
        const chips = [];
        State.playlists.forEach((p, plId) => {
            if (!p.ids.has(videoId)) return;
            const rgb = isRejectList(plId) ? REJECT_RGB : QUEUE_IN_PLAYLIST_RGB;
            chips.push(`<span title="In playlist: ${escHtml(p.name)}" style="display:inline-flex;align-items:center;padding:0 5px;border-radius:5px;font-size:10px;font-weight:700;line-height:15px;max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(${rgb},0.15);border:1px solid rgba(${rgb},0.4);color:rgb(${rgb});">${escHtml(getPlaylistDisplayName(p.name, plId))}</span>`);
        });
        return chips.join('');
    }

    function refreshQueuePlaylistChips(videoId) {
        if (smartQueueItems.some(it => it.id === videoId)) renderQueueSidebar();
    }

    // Native Recommended card plus a position column and hover-revealed reorder/remove (group-hover).
    function sidebarRowHtml({ id, href, meta }, isCurrent, index, pinned, isPlayed) {
        const bits = [
            meta?.bayesianRating ? Math.round(meta.bayesianRating) + '%' : '',
            isCurrent ? 'now playing' : (isPlayed ? 'played' : (pinned ? 'added' : 'suggested')),
        ].filter(Boolean);
        const plChips = queuePlaylistChipsHtml(id);
        // Site-wide filter on: red chips for why it would hide this video (playlist reasons: tint/chips).
        const reasons = filterConfig.active && filterIsMeaningful()
            ? filterReasons(id, meta, filterConfig, true).filter(r => r !== 'in playlist' && r !== 'not in playlist').slice(0, 3) : [];
        const reasonChips = reasons.map(r => `<span title="Your filter would hide this video" style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:500;background:rgba(${REJECT_RGB},0.12);border:1px solid rgba(${REJECT_RGB},0.45);color:rgb(${REJECT_RGB});white-space:nowrap;">${escHtml(r)}</span>`).join('');
        const tintRgb = isRejected(id) ? REJECT_RGB : QUEUE_IN_PLAYLIST_RGB;
        const rowStyle = [
            plChips ? `background:rgba(${tintRgb},0.07);box-shadow:inset 0 0 0 1px rgba(${tintRgb},0.35);` : '',
            isPlayed ? 'opacity:0.45;' : '',
        ].join('');
        const inPlaylistStyle = rowStyle ? ` style="${rowStyle}"` : '';
        return `
            <a href="${escHtml(cleanVideoHref(href) || '/video/' + id)}" draggable="true" data-queue-id="${escHtml(id)}"${inPlaylistStyle} class="flex gap-2 hover:bg-[#1A1A1A] p-2 rounded-lg transition-colors group cursor-grab${isCurrent ? ' bg-[#1A1A1A]' : ''}">
                <div class="w-4 flex-shrink-0 flex items-center justify-center text-xs ${isCurrent ? 'text-orange-400' : 'text-gray-500'}">${isCurrent ? '▶' : index + 1}</div>
                <div class="w-40 aspect-video flex-shrink-0 bg-[#0F0F0F] rounded-lg overflow-hidden relative">
                    ${meta?.thumbnailUrl ? `<img src="${escHtml(meta.thumbnailUrl)}" alt="" loading="lazy" class="w-full h-full object-contain bg-black transition-transform duration-200 opacity-100 group-hover:scale-105">` : ''}
                    ${meta?.duration ? `<div class="absolute bottom-1 right-1 bg-black/80 px-1 py-0.5 rounded text-[10px] text-white">${escHtml(meta.duration)}</div>` : ''}
                </div>
                <div class="flex-1 min-w-0">
                    <h4 class="text-white text-sm font-medium line-clamp-2 group-hover:text-orange-400 transition-colors mb-1">${escHtml(meta?.title || id)}</h4>
                    <div class="text-xs text-gray-400 mb-1 truncate">${escHtml(meta?.uploaderDisplay || '')}</div>
                    <div class="flex items-center gap-2 text-xs text-gray-500">${bits.map(b => `<span>${escHtml(b)}</span>`).join('<span>•</span>')}</div>
                    ${plChips || reasonChips ? `<div class="flex items-center gap-1 flex-wrap mt-1">${plChips}${reasonChips}</div>` : ''}
                </div>
                <div class="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-colors" style="flex-direction:column;justify-content:center;">
                    <span class="text-gray-500 text-xs cursor-grab" title="Drag to reorder">⠿</span>
                    <button data-remove-queue="${escHtml(id)}" type="button" title="Remove from Up next" class="text-gray-500 hover:text-white text-xs" style="background:none;border:none;cursor:pointer;padding:0;">✕</button>
                </div>
            </a>`;
    }

    function healQueueMeta() {
        smartQueueItems.forEach(it => {
            if (it.meta?.title) return;
            const filled = resolveQueueMeta(it.id);
            if (filled.title) it.meta = filled;
        });
    }

    // The queue contents, shared by the inline view (above Recommended) and the header-button panel.
    function queueBodyHtml() {
        const currentId = getCurrentVideoId();
        const played = Math.max(0, queueCursor);
        const headSub = smartQueueItems.length
            ? `${upcomingCount()} up next${played ? ` \u2022 ${played} played` : ''} \u2022 auto-refill ${queueSettings.autoRefill ? 'on' : 'off'}${queueSettings.useNfFilter && lastFilteredOut ? ` \u2022 ${lastFilteredOut} filtered out` : ''}`
            : 'Empty \u2014 add with "+", or generate below';

        const firstShown = Math.max(0, played - queueHistoryShown);
        const foldBtn = firstShown > 0
            ? `<button id="pmv-sq-more" type="button" class="${Q_CHIP_OFF}" style="cursor:pointer;flex:1;justify-content:center;">Show more \u2022 ${firstShown} earlier</button>`
            : (queueHistoryShown > QUEUE_HISTORY_SHOWN && played > QUEUE_HISTORY_SHOWN
                ? `<button id="pmv-sq-less" type="button" class="${Q_CHIP_OFF}" style="cursor:pointer;flex:1;justify-content:center;">Show less</button>` : '');
        const moreBtn = played > 0
            ? `<div style="display:flex;gap:6px;justify-content:flex-end;margin-bottom:6px;">${foldBtn}` +
              `<button id="pmv-sq-clear-played" type="button" title="Remove the ${played} played video${played === 1 ? '' : 's'} from Up next" class="${Q_CHIP_OFF}" style="cursor:pointer;justify-content:center;">Clear${foldBtn ? '' : ` ${played} played`}</button></div>`
            : '';
        const rows = smartQueueItems.length
            ? moreBtn + smartQueueItems.map((item, i) => i < firstShown ? '' : sidebarRowHtml(item, item.id === currentId, i, manuallyAddedIds.has(item.id), queueCursor >= 0 && i < queueCursor)).join('')
            : '<div class="text-xs text-gray-500 p-2">Nothing queued yet.' + (prevQueueCount() ? ' <button id="pmv-sq-restore-prev2" type="button" style="cursor:pointer;color:rgb(134,239,172);background:none;border:none;font:inherit;text-decoration:underline;">\u21ba Restore the previous queue</button>' : '') + '</div>';

        return `
            <div class="mb-2 flex items-center justify-between gap-2">
                <!-- "Up next" is OUR queue. PMVHaven's own "Up Next" preview is a
                     different thing on the playlist pages (getUpNextVideoInfo()
                     matches a <p> whose text is exactly "Up Next" — this <h3>
                     can't collide with it). -->
                <h3 class="text-lg font-bold text-white">Up next</h3>
                <div class="flex items-center gap-1.5 flex-wrap">
                    <button id="pmv-sq-settings" type="button" title="Settings" class="${queueSettingsOpen ? Q_CHIP_ON : Q_CHIP_OFF}" style="cursor:pointer;">Settings</button>
                    <button id="pmv-sq-collapse" type="button" title="${queueCollapsed ? 'Expand' : 'Collapse'}" class="${Q_CHIP_OFF}" style="cursor:pointer;">${queueCollapsed ? '\u2304' : '\u2303'}</button>
                    ${prevQueueCount() ? `<button id="pmv-sq-restore-prev" type="button" title="Restore the previous queue (${prevQueueCount()} kept; all of them in Settings)" class="${Q_CHIP_OFF}" style="cursor:pointer;">\u21ba</button>` : ''}
                    <button id="pmv-sq-clear" type="button" title="Clear Up next" class="${Q_CHIP_OFF}" style="cursor:pointer;">\u2715</button>
                </div>
            </div>
            <div class="text-xs text-gray-500 mb-2">${headSub}</div>
            ${queueSettingsOpen ? queueSettingsHtml() : ''}
            <div id="pmv-sq-rows"${queueCollapsed ? ' hidden' : ''}>${rows}</div>
        `;
    }

    function wireQueuePanel(panel, rerender) {
        panel.querySelector('#pmv-sq-settings').onclick = () => { queueSettingsOpen = !queueSettingsOpen; rerender(); };
        panel.querySelector('#pmv-sq-collapse').onclick = () => { queueCollapsed = !queueCollapsed; rerender(); };
        const more = panel.querySelector('#pmv-sq-more');
        if (more) more.onclick = e => { e.preventDefault(); e.stopPropagation(); queueHistoryShown += QUEUE_HISTORY_STEP; rerender(); };
        const less = panel.querySelector('#pmv-sq-less');
        if (less) less.onclick = e => { e.preventDefault(); e.stopPropagation(); queueHistoryShown = QUEUE_HISTORY_SHOWN; rerender(); };
        ['#pmv-sq-restore-prev', '#pmv-sq-restore-prev2'].forEach(sel => {
            const rb = panel.querySelector(sel);
            if (rb) rb.onclick = e => { e.preventDefault(); e.stopPropagation(); restoreQueueSnapshot(loadQueueUndo()); };
        });
        // Both clears need a second click, then offer Undo (old queue also goes to Previous queues).
        const clearPlayed = panel.querySelector('#pmv-sq-clear-played');
        if (clearPlayed) clearPlayed.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            const n = Math.max(0, queueCursor);
            if (!n) return;
            if (!confirmClick(clearPlayed, `Clear ${n} played?`)) return;
            const snap = snapshotQueue(`Cleared ${n} played \u2022 ${smartQueueItems.length} videos`);
            smartQueueItems.splice(0, n).forEach(it => manuallyAddedIds.delete(it.id));
            queueCursor -= n;
            queueHistoryShown = QUEUE_HISTORY_SHOWN;
            rerender();
            showQueueUndo(`Cleared ${n} played`, snap);
        };
        const clearAll = panel.querySelector('#pmv-sq-clear');
        clearAll.onclick = e => {
            e?.preventDefault?.();
            e?.stopPropagation?.();
            if (!smartQueueItems.length) return;
            if (!confirmClick(clearAll, 'Clear all?')) return;
            const snap = snapshotQueue(`Cleared \u2022 ${smartQueueItems.length} videos`);
            smartQueueItems = [];
            manuallyAddedIds = new Set();
            smartQueueActive = false;
            queueSettingsOpen = false;
            queueCursor = -1;
            dismissedCurrentId = null;
            rerender();
            showQueueUndo('Up next cleared', snap);
        };

        const rowsEl = panel.querySelector('#pmv-sq-rows');
        rowsEl.querySelectorAll('[data-remove-queue]').forEach(btn => {
            btn.onclick = e => { e.preventDefault(); e.stopPropagation(); removeFromQueue(btn.dataset.removeQueue); };
        });
        rowsEl.querySelectorAll('[data-queue-id]').forEach(row => {
            row.addEventListener('click', e => {
                if (e.target.closest('[data-remove-queue]')) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let modified clicks open a new tab
                if (!document.fullscreenElement && freshLoadDue()) { e.preventDefault(); freshLoad(row.getAttribute('href')); return; }
                // Via goToVideo, so from fullscreen the source is handed over instead.
                if (!document.fullscreenElement && !navigateInPage(row.getAttribute('href'))) return;
                e.preventDefault();
                // From the header popout: close it, show Up next docked on the video page.
                if (panel.id === 'pmv-queue-floating' && !document.fullscreenElement) { panel.remove(); dockQueueSoon(); }
                if (document.fullscreenElement) goToVideo(row.getAttribute('href'), row.getAttribute('data-queue-id'));
            });
        });
        if (queueSettingsOpen) wireQueueSettings(panel);
        attachQueueDragReorder(rowsEl);
    }

    function renderQueueSidebar() {
        syncQueueCursor();
        healQueueMeta();
        saveQueueState();
        try { syncQueueCardBtns(); } catch {}
        updateQueueButton();
        renderQueueFloating();

        const container = findVisibleRecommendedContainer();
        let panel = document.getElementById('pmv-queue-sidebar');

        // Stays up when empty while settings are open, so "Generate" is reachable.
        if (!container?.parentElement || (!smartQueueItems.length && !queueSettingsOpen)) { panel?.remove(); return; }

        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'pmv-queue-sidebar';
            panel.className = 'mb-6';
            container.parentElement.insertBefore(panel, container);
        }

        panel.innerHTML = queueBodyHtml();
        wireQueuePanel(panel, renderQueueSidebar);
    }

    // Header button: queue anywhere (inline needs a video page), count badge, cards' "play next" outline.
    const QUEUE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5v11L10 12z"></path><path d="M11 6.5v11l7.5-5.5z"></path><path d="M21 6.5v11"></path></svg>';

    function updateQueueButton() {
        const n = upcomingCount();
        const label = n ? `Up next \u2014 ${n} queued` : 'Up next (empty)';
        const text = n > 99 ? '99+' : String(n);
        document.querySelectorAll('[data-pmv-queue-btn]').forEach(btn => {
            setBtnColor(btn, n ? 'rgb(100, 255, 0)' : 'rgb(156, 163, 175)');
            let badge = btn.querySelector('[data-pmv-queue-count]');
            if (!badge) {
                btn.insertAdjacentHTML('beforeend', QUEUE_BADGE_HTML);
                badge = btn.querySelector('[data-pmv-queue-count]');
            }
            if (badge.textContent !== text) badge.textContent = text;
            const vis = n ? '' : 'none';
            if (badge.style.display !== vis) badge.style.display = vis;
            if (btn.title !== label) btn.title = label;
        });
    }

    // Recommended may appear late or linger after a route change; keep re-placing until settled.
    let dockTimer = null;
    function dockQueueSoon() {
        clearInterval(dockTimer);
        const until = Date.now() + 6000;
        dockTimer = setInterval(() => {
            if (Date.now() > until || document.fullscreenElement) { clearInterval(dockTimer); return; }
            const container = findVisibleRecommendedContainer();
            const panel = document.getElementById('pmv-queue-sidebar');
            if (container && (!panel || !panel.isConnected || panel.nextElementSibling !== container)) {
                try { renderQueueSidebar(); } catch {}
            }
        }, 200);
    }

    function ensureQueueFloatingStyle() {
        if (document.getElementById('pmv-queue-floating-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-queue-floating-style';
        st.textContent = `
#pmv-queue-floating h3{color:rgb(251,146,60);}
#pmv-queue-floating [data-queue-id]:hover{background:#333333 !important;}
#pmv-queue-floating [data-queue-id].bg-\\[\\#1A1A1A\\]{background:rgba(249,115,22,0.12) !important;box-shadow:inset 3px 0 0 rgb(249,115,22);}
#pmv-queue-floating::-webkit-scrollbar{width:8px;}
#pmv-queue-floating::-webkit-scrollbar-thumb{background:rgba(249,115,22,0.35);border-radius:4px;}
#pmv-queue-floating::-webkit-scrollbar-thumb:hover{background:rgba(249,115,22,0.6);}
`;
        document.head.appendChild(st);
    }

    function renderQueueFloating() {
        const box = document.getElementById('pmv-queue-floating');
        if (!box) return;
        box.innerHTML = queueBodyHtml();
        wireQueuePanel(box, renderQueueSidebar);
    }

    function toggleQueueFloating(anchorBtn) {
        const existing = document.getElementById('pmv-queue-floating');
        if (existing) { existing.remove(); return; }

        // On document.body, outside Vue's tree.
        const box = document.createElement('div');
        box.id = 'pmv-queue-floating';
        const r = anchorBtn.getBoundingClientRect();
        box.style.cssText =
            'position:fixed;z-index:999999;width:420px;max-width:calc(100vw - 16px);' +
            'max-height:calc(100vh - 90px);overflow:auto;' +
            `top:${Math.round(r.bottom + 8)}px;left:${Math.round(Math.min(r.left, window.innerWidth - 428))}px;` +
            'background:#232323;border:1px solid rgba(249,115,22,0.35);border-top:3px solid rgb(249,115,22);' +
            'border-radius:12px;padding:12px;color:white;scrollbar-color:rgba(249,115,22,0.35) transparent;' +
            'box-shadow:0 12px 40px rgba(0,0,0,0.7),0 0 24px rgba(249,115,22,0.12);';
        ensureQueueFloatingStyle();
        document.body.appendChild(box);
        renderQueueFloating();

        setTimeout(() => {
            const onDocClick = e => {
                if (box.contains(e.target) || e.target.closest('[data-pmv-queue-btn]')) return;
                box.remove();
                document.removeEventListener('click', onDocClick);
            };
            document.addEventListener('click', onDocClick);
        }, 0);
    }

    // Native drag-and-drop: dragover moves the DOM node, dragend rebuilds smartQueueItems from DOM order.
    function attachQueueDragReorder(rowsEl) {
        let draggingId = null;
        rowsEl.querySelectorAll('[data-queue-id]').forEach(row => {
            row.addEventListener('dragstart', e => {
                draggingId = row.dataset.queueId;
                row.style.opacity = '0.4';
                e.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragend', () => {
                row.style.opacity = '';
                const order = [...rowsEl.querySelectorAll('[data-queue-id]')].map(r => r.dataset.queueId);
                const byId = new Map(smartQueueItems.map(it => [it.id, it]));
                smartQueueItems = order.map(id => byId.get(id)).filter(Boolean);
                const currentId = getCurrentVideoId();
                const moved = smartQueueItems.findIndex(it => it.id === currentId);
                if (moved !== -1) queueCursor = moved;
                saveQueueState();
                draggingId = null;
            });
            row.addEventListener('dragover', e => {
                e.preventDefault();
                if (!draggingId || draggingId === row.dataset.queueId) return;
                const draggedEl = rowsEl.querySelector(`[data-queue-id="${draggingId}"]`);
                if (!draggedEl) return;
                const rect = row.getBoundingClientRect();
                const before = e.clientY < rect.top + rect.height / 2;
                rowsEl.insertBefore(draggedEl, before ? row : row.nextSibling);
            });
        });
    }

    // --- Queue refill ---
    // Tops up an active queue from Recommended, scored like generateSmartQueue() (DOM rating as fallback).
