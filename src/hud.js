
(function () {
    'use strict';


    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    const CACHE_KEY = 'pmv_firefox_playlist_cache_v1';
    const CACHE_TTL = 12 * 60 * 60 * 1000;
    const WATCHED_KEY = 'pmv_watched_v1';
    const WATCHED_MAX = 3000; // cap on stored entries
    const QUIET_MS = 2200;
    const SOFT_CLEAN_EVERY_VIDEOS = 4;

    // Per-playlist appearance and button order, stored in localStorage as
    // pmv_playlist_config_v1 (included in settings export/import):
    //   { styles: { "<name or id>": { label?, color } }, order: ["<name or id>", ...] }
    // Names match case-insensitively against the API name.
    const PLAYLIST_CONFIG_KEY = 'pmv_playlist_config_v1';
    const playlistConfig = (() => {
        try {
            const c = JSON.parse(localStorage.getItem(PLAYLIST_CONFIG_KEY) || '{}');
            return { styles: c.styles || {}, order: (c.order || []).map(s => String(s).trim().toLowerCase()) };
        } catch { return { styles: {}, order: [] }; }
    })();

    // Playlists without an explicit color get a stable one derived from the name, in a muted band.
    const FALLBACK_COLOR = '78d64c';
    function derivedColor(seed) {
        let h = 0;
        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
        const hue = h % 360;
        const [r, g, b] = hslToRgb(hue / 360, 0.45, 0.58);
        return [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    }
    function hslToRgb(h, s, l) {
        const f = n => {
            const k = (n + h * 12) % 12;
            const a = s * Math.min(l, 1 - l);
            return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
        };
        return [f(0), f(8), f(4)];
    }

    function playlistSortIndex(name) {
        const idx = playlistConfig.order.indexOf((name || '').trim().toLowerCase());
        return idx === -1 ? playlistConfig.order.length : idx;
    }

    // Reject list: a playlist chosen in Settings. A video in it is removed from every other list,
    // adding it elsewhere removes it from the reject list, and "already saved" renders red instead of green.
    const REJECT_KEY = 'pmv_reject_playlist_v1';
    const REJECT_HEX = 'ff5050';
    const REJECT_RGB = '255,80,80';
    let rejectPlaylistId = (() => {
        try { return JSON.parse(localStorage.getItem(REJECT_KEY) || 'null') || null; } catch { return null; }
    })();
    function setRejectPlaylistId(id) {
        rejectPlaylistId = id || null;
        try {
            if (rejectPlaylistId) localStorage.setItem(REJECT_KEY, JSON.stringify(rejectPlaylistId));
            else localStorage.removeItem(REJECT_KEY);
        } catch {}
    }
    function isRejectList(id) { return !!id && id === rejectPlaylistId; }
    function isRejected(videoId) {
        return !!(videoId && rejectPlaylistId && State.playlists.get(rejectPlaylistId)?.ids.has(videoId));
    }

    function getPlaylistStyle(name, id) {
        const key = (name || '').trim().toLowerCase();
        const s = (id && playlistConfig.styles[id]) || playlistConfig.styles[key] || playlistConfig.styles[name];
        if (isRejectList(id)) return { label: (s && s.label) || null, color: REJECT_HEX };
        if (s) return { label: s.label || null, color: s.color || derivedColor(key || id || '') };
        if (!key && !id) return null;
        return { label: null, color: derivedColor(key || id) };
    }

    // Button text is always lowercase; the full name stays in the title tooltip.
    function getPlaylistDisplayName(name, id) {
        const s = getPlaylistStyle(name, id);
        return (s && s.label) || name || '';
    }

    // Badges stay green unless a playlist has an explicit color by id in pmv_playlist_config_v1.
    // Auto-derived colors are not used here, so a color keeps its meaning.
    function playlistBadgeRgb(name, id) {
        if (isRejectList(id)) return REJECT_RGB;
        const s = id && playlistConfig.styles[id];
        return s && s.color ? hexToRgbStr(s.color) : '100,255,0';
    }

    function hexToRgbArr(hex) {
        const n = parseInt(hex, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function hexToRgbStr(hex) {
        const [r, g, b] = hexToRgbArr(hex);
        return `${r},${g},${b}`;
    }

    // Blends a color toward neutral gray (Tailwind gray-400) for the inactive state.
    // Blended in RGB; low alpha over near-black skews saturated hues (yellow) toward olive.
    const GRAY_RGB = [156, 163, 175];
    function mixToGrayStr(hex, ratio = 0.65) {
        const [r, g, b] = hexToRgbArr(hex);
        const mr = Math.round(r * (1 - ratio) + GRAY_RGB[0] * ratio);
        const mg = Math.round(g * (1 - ratio) + GRAY_RGB[1] * ratio);
        const mb = Math.round(b * (1 - ratio) + GRAY_RGB[2] * ratio);
        return `${mr},${mg},${mb}`;
    }

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    const State = {
        playlists: new Map(),
        reverse: new Map(),
        cacheLoadedAt: 0,
        refreshPromise: null,
        ready: false,

        currentVideoId: null,
        currentVideoData: null,
        video: null,               // cached <video> element

        hud: null,
        hudTimeout: null,
        hudHardTimeout: null,
        toastTimeout: null,
        progressBar: null,
        progressRaf: null,

        queueOverlayEl: null,
        queueUpNextEl: null,
        queueUpNextOrigParent: null,
        queueUpNextOrigNext: null,
        queueScrollerEl: null,
        queueScrollerOrigParent: null,
        queueScrollerOrigNext: null,
        queueSidebarVisible: false,
        queueHideTimer: null,

        lastVolume: 1,
        forceVolume100: (() => { try { return localStorage.getItem('pmv_volume_lock_v1') === '1'; } catch { return false; } })(),
        lastForcedVolumeAt: 0,

        quietMode: false,
        lastUrl: location.href,

        pendingRemove: false,
        pendingRemoveVideoId: null,
        pendingRemoveTimeout: null,

        badgeScheduled: false,
        recFilterMode: 'all',   // 'all' | 'in' | 'out'
        lastBadgeRunAt: 0,
        minBadgeGapMs: 1400,

        nativePlaylistButton: null,
        nativePlaylistButtonLastVideoId: null,

        observerPaused: false,

        videosSinceSoftClean: 0,
        lastSoftCleanVideoId: null,

        thumbnailIndex: new Map(),   // clean URL (no query) → video _id
        titleIndex: new Map(),       // lowercased title → video _id
        videoMeta: new Map(),        // video _id → { tags, bayesianRating, width, height, duration, uploader }
        slugToApiId: new Map(),      // slug ID (from href) → actual API _id

        lastNextHudVideoId: null,    // last video ID shown in the next-video mini-HUD
        nextHudEl: null,
        nextHudHideTimer: null,
    };

    try { PMVX.state = State; } catch {}
    PMVX.filterChecks.push(() => State.recFilterMode !== 'all');

    // ---------------------------------------------------------------------
    // Utilities
    // ---------------------------------------------------------------------


    // Strip the query string at write time so lookups need no split().
    function cleanUrl(u) {
        if (!u) return '';
        const q = u.indexOf('?');
        return q === -1 ? u : u.slice(0, q);
    }

    // ---------------------------------------------------------------------
    // Cache
    // ---------------------------------------------------------------------

    function rebuildReverseIndex() {
        State.reverse.clear();
        State.playlists.forEach(playlist => {
            playlist.ids.forEach(vid => {
                let s = State.reverse.get(vid);
                if (!s) { s = new Set(); State.reverse.set(vid, s); }
                s.add(playlist.id);
            });
        });
    }

    function loadCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return false;
            const cached = JSON.parse(raw);
            if (!cached.updatedAt || !Array.isArray(cached.playlists)) return false;

            State.playlists.clear();
            cached.playlists.forEach(p => {
                State.playlists.set(p.id, { id: p.id, name: p.name, ids: new Set(p.ids || []) });
            });
            State.cacheLoadedAt = cached.updatedAt;
            State.ready = true;
            rebuildReverseIndex();
            return true;
        } catch (e) {
            return false;
        }
    }

    // Mutations go through saveCacheSoon(): one localStorage write and one pmv:cache-ready event per burst.
    let saveCacheTimer = null;
    function saveCacheSoon() {
        clearTimeout(saveCacheTimer);
        saveCacheTimer = setTimeout(() => { saveCacheTimer = null; saveCache(); }, 250);
    }
    window.addEventListener('pagehide', () => { if (saveCacheTimer) saveCache(); });

    function notifyCacheReady() {
        try { window.dispatchEvent(new CustomEvent('pmv:cache-ready')); } catch {}
    }

    function saveCache() {
        clearTimeout(saveCacheTimer);
        saveCacheTimer = null;
        try {
            const data = {
                updatedAt: Date.now(),
                playlists: [...State.playlists.values()].map(p => ({
                    id: p.id, name: p.name, ids: [...p.ids]
                }))
            };
            localStorage.setItem(CACHE_KEY, JSON.stringify(data));
            State.cacheLoadedAt = data.updatedAt;
            // Notify the other modules that the cache is ready.
            notifyCacheReady();
        } catch {}
    }

    function cacheIsFresh() {
        return State.cacheLoadedAt && Date.now() - State.cacheLoadedAt < CACHE_TTL;
    }

    // ---------------------------------------------------------------------
    // API
    // ---------------------------------------------------------------------

    // Own requests are marked "quiet" while in flight so the interceptor does not index their playlist
    // responses twice. The body is parsed once and shared (pmvResJson).
    async function api(url, opts) {
        quietUrls.add(url);
        let res;
        try { res = await fetch(url, opts); }
        finally { quietUrls.delete(url); }
        if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
        return pmvResJson(res);
    }

    // The site's content flags (its own moderation list: Gay, Trans, Nudity, Extreme, VO, Remix, Promo,
    // Seizure) plus three that only some lists carry. Nudity is hasExplicitContent; SFW is its inverse.
    // The list lives in core.js (PMVX.contentFlags), shared with the playlist-page filter.
    const CONTENT_FLAGS = PMVX.contentFlags;

    // Content flags per video, kept across pages and visits (localStorage): id -> [trueBits, knownBits],
    // bit i = CONTENT_FLAGS[i]. Full video documents (they carry moderationStatus / isReleased) leave the
    // site's eight moderation flags out when a video was never flagged: those count as known and false.
    // Partial copies (playlist videoDetails) only add the flags they do carry.
    const FLAG_CACHE_KEY = 'pmvx_flag_cache_v1';
    const FLAG_CACHE_MAX = 15000;
    let flagCache = null;
    let flagSaveTimer = 0;
    function flagCacheMap() {
        if (!flagCache) {
            flagCache = new Map();
            try {
                const o = JSON.parse(localStorage.getItem(FLAG_CACHE_KEY) || '{}');
                for (const k in o) if (Array.isArray(o[k])) flagCache.set(k, o[k]);
            } catch {}
        }
        return flagCache;
    }
    function saveFlagCache() {
        clearTimeout(flagSaveTimer);
        flagSaveTimer = setTimeout(() => {
            try {
                const entries = [...flagCacheMap().entries()];
                localStorage.setItem(FLAG_CACHE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-FLAG_CACHE_MAX))));
            } catch {}
        }, 1500);
    }
    function rememberFlags(v) {
        if (!v?._id) return;
        const full = 'moderationStatus' in v || 'isReleased' in v;
        let t = 0, k = 0;
        CONTENT_FLAGS.forEach(([key], i) => {
            if (typeof v[key] === 'boolean') { k |= 1 << i; if (v[key]) t |= 1 << i; }
            else if (full && i < 8) k |= 1 << i;
        });
        if (!k) return;
        const m = flagCacheMap();
        const prev = m.get(v._id);
        if (prev) { t = (prev[0] & ~k) | t; k = prev[1] | k; if (prev[0] === t && prev[1] === k) return; }
        m.delete(v._id);
        m.set(v._id, [t, k]);
        saveFlagCache();
    }

    // Returns the number of new thumbnail URLs; the interceptor invalidates queue badges only when > 0.
    function indexVideoDetails(details) {
        if (!Array.isArray(details)) return 0;
        let added = 0;
        const putThumb = (u, id) => {
            if (!u) return;
            const c = cleanUrl(u);
            if (State.thumbnailIndex.get(c) !== id) { State.thumbnailIndex.set(c, id); added++; }
        };
        details.forEach(v => {
            if (!v?._id) return;
            // Store clean URLs at write time.
            [v.thumbnailUrl, v.rawThumbnailUrl, v.previewUrl].forEach(u => putThumb(u, v._id));
            Object.values(v.thumbnailSizes || {}).forEach(t => putThumb(t?.url, v._id));
            if (v.title) State.titleIndex.set(v.title.trim().toLowerCase(), v._id);
            rememberFlags(v);
            // Full metadata for the tag filter.
            State.videoMeta.set(v._id, {
                tags: (v.tags || v.top5Tags || []).map(t => t.toLowerCase()),
                starsTags: (v.starsTags || v.stars || []).map(s => (typeof s === 'string' ? s : (s?.name || '')).toLowerCase()).filter(Boolean),
                bayesianRating: v.bayesianRating || 0,
                width: v.width || 0,
                height: v.height || 0,
                duration: v.duration || '',
                uploader: (v.uploaderUsername || v.uploader || '').toLowerCase(),
                uploaderDisplay: v.uploaderUsername || v.uploader || v.user?.username || '',
                title: v.title || '',
                thumbnailUrl: v.thumbnailUrl || v.rawThumbnailUrl || Object.values(v.thumbnailSizes || {})[0]?.url || '',
                previewUrl: v.previewUrl || '',
                uploadDate: v.uploadDate || null,
                views: v.views || 0,
                // Lower-cased for description matching (in memory only).
                description: String(v.description || '').toLowerCase(),
            });
        });
        return added;
    }

    // Account id for the playlists API, read from the session (user.id, not the auth userId).
    // Cached for the page lifetime; logged-out visitors get no playlist features.
    let ownerIdPromise = null;
    function getOwnerId() {
        if (!ownerIdPromise) {
            ownerIdPromise = api('/api/auth/session')
                .then(j => j?.user?.id || j?.session?.user?.customUserId || null)
                .catch(() => { ownerIdPromise = null; return null; });
        }
        return ownerIdPromise;
    }

    async function refreshUserPlaylists({ force = false } = {}) {
        if (!force && State.ready && cacheIsFresh()) return;
        if (State.refreshPromise) return State.refreshPromise;

        State.refreshPromise = (async () => {
            const ownerId = await getOwnerId();
            if (!ownerId) return;
            const listJson = await api(`/api/playlists?owner=${ownerId}&limit=100`);
            const list = Array.isArray(listJson) ? listJson : (listJson.playlists || listJson.data || []);

            State.thumbnailIndex.clear();
            State.titleIndex.clear();

            // Builds one playlist entry (ids Set + indexing) from a playlist object and its detail response.
            function buildPlaylistEntry(p, detail) {
                const root = detail?.data || detail;
                const videos = root?.videos || [];
                const videoDetails = root?.videoDetails || [];
                const ids = new Set();

                videos.forEach(v => {
                    if (typeof v === 'string') ids.add(v);
                    else if (v?._id) ids.add(v._id);
                    else if (v?.id) ids.add(v.id);
                    else if (v?.video?._id) ids.add(v.video._id);
                });

                videoDetails.forEach(v => {
                    if (v?._id) ids.add(v._id);
                });
                indexVideoDetails(videoDetails);

                return { id: p._id, name: p.name || p.title || p._id, ids };
            }

            const nextPlaylists = new Map();

            // The largest playlist is fetched first and merged into State.playlists as soon as it returns,
            // so lookups are correct while the rest loads or if another fetch fails.
            const sizeOf = p => p.validVideoCount ?? (Array.isArray(p.videos) ? p.videos.length : 0);
            const priorityIdx = list.length
                ? list.reduce((best, p, i, a) => (sizeOf(p) > sizeOf(a[best]) ? i : best), 0)
                : -1;
            const restList = priorityIdx === -1 ? list : list.filter((_, i) => i !== priorityIdx);

            // Runs alongside the rest and is merged in memory when it lands. Other modules are notified
            // early only on a cold start; the single localStorage write happens at the end.
            const wasReady = State.ready;
            const priorityDone = priorityIdx === -1 ? Promise.resolve() : (async () => {
                try {
                    const p = list[priorityIdx];
                    const detail = await api(`/api/playlists/${p._id}?fetchAll=true`);
                    const entry = buildPlaylistEntry(p, detail);
                    nextPlaylists.set(entry.id, entry);
                    State.playlists.set(entry.id, entry);
                    State.ready = true;
                    rebuildReverseIndex();
                    if (!wasReady) notifyCacheReady();
                } catch {}
            })();

            // fetchAll=true is required: without it only the first page of videos per playlist is returned,
            // and later videos read as "not in the playlist". Two at a time next to the priority fetch.
            const [results] = await Promise.all([
                settledWithLimit(restList, 2,
                    p => api(`/api/playlists/${p._id}?fetchAll=true`).then(detail => ({ p, detail }))),
                priorityDone,
            ]);

            results.forEach(r => {
                if (r.status !== 'fulfilled') {
                    return;
                }
                const { p, detail } = r.value;
                const entry = buildPlaylistEntry(p, detail);
                nextPlaylists.set(entry.id, entry);
            });

            State.playlists = nextPlaylists;
            State.ready = true;
            rebuildReverseIndex();
            saveCache();
        })();

        try {
            await State.refreshPromise;
        } finally {
            State.refreshPromise = null;
        }
    }

    // ---------------------------------------------------------------------
    // Fetch interceptor
    // ---------------------------------------------------------------------

    const nativeFetch = window.fetch;

    // ---------------------------------------------------------------------
    // Rate-limit guard (429)
    // ---------------------------------------------------------------------
    // The site rate-limits per IP across all /api/ calls, so a burst of ours also breaks its own requests.
    // A rate-limited GET waits out Retry-After (or 1s/2s/4s) and retries.
    // Strictly per request, with no shared cooldown; bulk fetches are throttled by settledWithLimit().
    const MAX_429_RETRIES = 3;
    const MAX_RETRY_WAIT_MS = 30000;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function retryAfterMs(res, attempt) {
        const h = res.headers.get('Retry-After');
        if (h) {
            const secs = Number(h);
            if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
            const d = Date.parse(h) - Date.now();
            if (Number.isFinite(d) && d > 0) return Math.min(d, MAX_RETRY_WAIT_MS);
        }
        return 1000 * 2 ** attempt;
    }

    async function guardedFetch(thisArg, args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0] || '');
        if (!/\/api\//.test(url)) return nativeFetch.apply(thisArg, args);

        const method = (args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
        // Only GET is retried; mutations are single deliberate actions.
        if (method !== 'GET') return nativeFetch.apply(thisArg, args);

        for (let attempt = 0; ; attempt++) {
            // A Request object can only be reused without a body (GET).
            const res = await nativeFetch.apply(thisArg, attempt > 0 && args[0] instanceof Request
                ? [args[0].clone(), ...args.slice(1)] : args);
            if (res.status !== 429 || attempt >= MAX_429_RETRIES) {
                return res;
            }
            const waitMs = retryAfterMs(res, attempt);
            await sleep(waitMs);
        }
    }

    // Runs `fn` over `items`, at most `limit` at a time, to stay under the rate limit.
    // Result shape matches Promise.allSettled.
    async function settledWithLimit(items, limit, fn) {
        const results = new Array(items.length);
        let next = 0;
        async function worker() {
            while (next < items.length) {
                const i = next++;
                try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
                catch (reason) { results[i] = { status: 'rejected', reason }; }
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
        return results;
    }

    // One parse per response, shared by all handlers (the other modules define the same helper).
    const pmvResJson = PMVX.resJson || (PMVX.resJson = res => {
        if (!res.__pmvJson) {
            try { res.__pmvJson = res.clone().json(); }
            catch (e) { res.__pmvJson = Promise.reject(e); }
            res.__pmvJson.catch(() => {});
        }
        return res.__pmvJson;
    });
    // URLs of own in-flight requests (see api()), also used by the /playlists filter for lookups
    // of other users' playlists that must not be indexed.
    const quietUrls = PMVX.quietUrls || (PMVX.quietUrls = new Set());

    // Shared in-flight registry for single-video lookups (/api/videos/<id>). Go through
    // fetchVideoDeduped() instead of calling api() directly so concurrent callers share one request
    // and one retry budget. The site's own video GETs are registered here too.
    const pendingVideoApiFetches = new Map();
    // Recently finished lookups are answered from here without a new request.
    const RECENT_VIDEO_TTL_MS = 30000;
    const recentVideos = new Map(); // requested id -> { v, at }
    function rememberVideo(reqId, v) {
        if (!v?._id) return;
        const e = { v, at: Date.now() };
        recentVideos.set(reqId, e);
        recentVideos.set(v._id, e);
        if (recentVideos.size > 400) {
            const cutoff = Date.now() - RECENT_VIDEO_TTL_MS;
            for (const [k, x] of recentVideos) {
                if (x.at < cutoff || recentVideos.size > 300) recentVideos.delete(k);
            }
        }
    }
    // A like / dislike / favourite changes the video's data, so cached entries for it are dropped.
    function forgetVideo(id) {
        for (const [k, x] of recentVideos) if (k === id || x.v._id === id) recentVideos.delete(k);
    }
    function recentVideo(id) {
        const e = recentVideos.get(id);
        if (!e) return null;
        if (Date.now() - e.at > RECENT_VIDEO_TTL_MS) { recentVideos.delete(id); return null; }
        return e.v;
    }

    window.fetch = async function (...args) {
        // Playlist index hijack: Vue falls back to index 0 when the initial load (page=1&limit=50)
        // has fewer items than ?index=. Raise the limit so the response contains at least index+1 real items.
        // Do not change: prevents the player from jumping back to index 0.
        try {
            const rawUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const pm = rawUrl.match(/(\/api\/playlists\/[a-f0-9]{24})\?(.*)$/);
            if (pm) {
                const params = new URLSearchParams(pm[2]);
                if (params.get('page') === '1' && params.get('limit') && !params.get('fetchAll')) {
                    const index = parseInt(new URLSearchParams(location.search).get('index') || '0', 10);
                    const currentLimit = parseInt(params.get('limit'), 10);
                    if (Number.isFinite(index) && index >= currentLimit) {
                        // Extra buffer for the sidebar.
                        const newLimit = index + 50;
                        const newUrl = `${pm[1]}?page=1&limit=${newLimit}`;
                        if (typeof args[0] === 'string') args[0] = newUrl;
                        else if (args[0] instanceof Request) args[0] = new Request(newUrl, args[0]);
                        else if (args[0]?.url) args[0] = { ...args[0], url: newUrl };
                    }
                }
                // One-shot fetchAll force, set by the playlist-page filter right before it triggers Vue's own
                // next-page fetch, so Vue processes the response as its own data. Consumed immediately.
                // The URL is only rewritten for page=1: later pages append to rendered rows and would duplicate them.
                if (PMVX.forceFetchAllNext && !params.get('fetchAll')) {
                    PMVX.forceFetchAllNext = false;
                    if (params.get('page') === '1') {
                        params.set('fetchAll', 'true');
                        const newUrl = `${pm[1]}?${params.toString()}`;
                        if (typeof args[0] === 'string') args[0] = newUrl;
                        else if (args[0] instanceof Request) args[0] = new Request(newUrl, args[0]);
                        else if (args[0]?.url) args[0] = { ...args[0], url: newUrl };
                    }
                }
            }
        } catch {}

        // A site GET for a video nobody registered becomes the shared in-flight lookup for that id.
        let videoDeferred = null;
        try {
            const u0 = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const m0 = u0.match(/\/api\/videos\/([a-f0-9]{24})$/);
            const method0 = (args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
            const mut = method0 !== 'GET' && u0.match(/\/api\/videos\/([a-f0-9]{24})\//);
            if (mut) forgetVideo(mut[1]);
            // The site's own favourite toggles keep the card hearts in step.
            if (mut && /\/favorite$/.test(u0) && typeof args[1]?.body === 'string') {
                try { const a = JSON.parse(args[1].body).action; if (a) noteFavourite(mut[1], a === 'favorite'); } catch {}
            }
            // Own lookups (marked quiet) register themselves.
            if (m0 && method0 === 'GET' && !quietUrls.has(u0) && !pendingVideoApiFetches.has(m0[1])) {
                let resolve;
                const p = new Promise(r => { resolve = r; });
                videoDeferred = { id: m0[1], p, resolve };
                pendingVideoApiFetches.set(m0[1], p);
                // Never leave waiters on a response that fails to parse: they get null.
                setTimeout(() => {
                    resolve(null);
                    if (pendingVideoApiFetches.get(m0[1]) === p) pendingVideoApiFetches.delete(m0[1]);
                }, 20000);
            }
        } catch {}
        const settleVideoDeferred = v => {
            if (!videoDeferred) return;
            const d = videoDeferred;
            videoDeferred = null;
            d.resolve(v || null);
            if (pendingVideoApiFetches.get(d.id) === d.p) pendingVideoApiFetches.delete(d.id);
        };

        let res;
        try { res = await guardedFetch(this, args); }
        catch (e) { settleVideoDeferred(null); throw e; }

        try {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            // One parse shared by all handlers below.
            const jsonP = /\/api\//.test(url) ? pmvResJson(res) : null;

            // Extension point: PMVX.apiTaps listeners get (url, json) of every API response.
            if (jsonP && PMVX.apiTaps.length) {
                jsonP.then(json => PMVX.apiTaps.forEach(fn => { try { fn(url, json); } catch {} })).catch(() => {});
            }

            // Learn slug to _id mappings from any API response.
            if (jsonP) {
                jsonP.then(json => {
                    if (learnVideoIds(json)) scheduleBadges();
                }).catch(() => {});
            }

            // Single-video response: cache the full video metadata.
            if (jsonP && /\/api\/videos\/[a-f0-9]{24}$/.test(url)) {
                const urlId = url.match(/\/api\/videos\/([a-f0-9]{24})$/)[1];
                jsonP.then(json => {
                    const v = json?.data || json;
                    if (!res.ok || !v?._id) { settleVideoDeferred(null); return; }
                    if (videoDeferred) indexVideoDetails([v]);
                    rememberVideo(urlId, v);
                    settleVideoDeferred(v);
                    if (urlId !== v._id) State.slugToApiId.set(urlId, v._id);

                    // The video ID in the URL must match this response. The slug part is optional:
                    // both "/video/title-slug_<hex>" and "/video/<hex>" occur. Without a match, background fetches
                    // (e.g. sidebar hover previews) could be mistaken for the playing video.
                    const pageId = location.pathname.match(/^\/video\/(?:[^?#]*_)?([0-9a-f]{24})(?:[?#]|$)/i)?.[1];
                    // Playlist pages carry the playlist id, so compare with the active queue row (border-orange-500).
                    const isCurrentPage = pageId
                        ? (urlId === pageId || v._id === pageId || State.slugToApiId.get(pageId) === v._id)
                        : (location.pathname.startsWith('/playlists/')
                            ? v._id === getActiveQueueVideoId()
                            : true);
                    if (isCurrentPage) adoptCurrentVideo(v);
                }).catch(() => settleVideoDeferred(null));
            } else {
                settleVideoDeferred(null);
            }

            // storage.pmvhaven.com/<id>/... (thumbnail, preview): only used when the ID matches the page video,
            // so background fetches for other videos do not overwrite state.
            const storageM = url.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//);
            if (storageM) {
                const idFromStorage = storageM[1];
                const pageId = location.pathname.match(/^\/video\/(?:[^?#]*_)?([0-9a-f]{24})(?:[?#]|$)/i)?.[1];
                // Store only for the page video or an already-known mapping.
                if (pageId && (idFromStorage === pageId || State.slugToApiId.get(pageId) === idFromStorage)) {
                    if (!State.currentVideoData?.id) {
                        State.currentVideoId = idFromStorage;
                    }
                }
            }

            // Playlist responses requested by the site: index their videos so queue rows resolve.
            // Quiet (own) requests are skipped. Queue badges are invalidated only when something new arrived.
            if (jsonP && /\/api\/playlists\/[a-f0-9]{24}(?:\?|$)/.test(url) && !quietUrls.has(url)) {
                jsonP.then(json => {
                    const details = json?.data?.videoDetails || json?.videoDetails;
                    if (!Array.isArray(details)) return;
                    if (indexVideoDetails(details) > 0) {
                        document.querySelectorAll('[data-pmv-queue-checked]').forEach(el => {
                            delete el.dataset.pmvQueueChecked;
                        });
                        scheduleBadges();
                    }
                }).catch(() => {});
            }
            // Video lists the site requests (discover, browse, search, ...): their full metadata (all tags,
            // performers, duration) lets the filter judge more than the two tags a card shows.
            if (jsonP && !quietUrls.has(url) && !/\/api\/(?:videos\/[a-f0-9]{24}|playlists\/)/.test(url)) {
                jsonP.then(json => {
                    const list = [json?.videos, json?.data, json?.data?.videos, json?.results]
                        .find(a => Array.isArray(a) && a.length && a[0]?._id && typeof a[0].title === 'string' && 'duration' in a[0]);
                    if (list && indexVideoDetails(list.filter(v => Array.isArray(v?.tags) || Array.isArray(v?.top5Tags))) > 0) scheduleBadges();
                }).catch(() => {});
            }
        } catch { settleVideoDeferred(null); }

        return res;
    };

    // Fills State.currentVideoData for the page video and rebinds the page's playlist buttons to its _id.
    function adoptCurrentVideo(v) {
        State.currentVideoData = {
            id: v._id,
            title: v.title || null,
            creator: v.uploader || v.uploaderUsername || v.user?.username || null,
            tags: Array.isArray(v.tags) ? v.tags : [],
            top5Tags: Array.isArray(v.top5Tags) ? v.top5Tags : [],
            starsTags: Array.isArray(v.starsTags) ? v.starsTags
                : Array.isArray(v.stars) ? v.stars.map(s => (typeof s === 'string' ? s : (s?.name || ''))).filter(Boolean)
                : [],
            description: v.description || null,
            bayesianRating: v.bayesianRating ?? null,
            uploadDate: v.uploadDate || null,
            // The user's own like/dislike/favourite state; the API buttons start from it.
            isLiked: v.isLiked === true,
            isDisliked: v.isDisliked === true,
            isFavorited: v.isFavorited === true,
            // Timeline-strip frames {url, captureTime}, kept for fullscreen hand-over.
            timelineThumbnails: Array.isArray(v.timelineThumbnails)
                ? v.timelineThumbnails.filter(t => t?.url).map(t => ({ url: t.url, captureTime: t.captureTime }))
                : [],
        };
        State.currentVideoId = v._id;
        // Reset and rebuild page buttons with the correct _id.
        const existing = document.getElementById('pmv-page-playlists');
        if (existing && existing.dataset.forVideo !== v._id) existing.remove();
        try { injectPagePlaylistButtons(v._id); } catch {}
        try { updateNativePlaylistButtons(true); } catch {}
    }

    // ---------------------------------------------------------------------
    // Video identification / meta
    // ---------------------------------------------------------------------

    function getJsonLdVideoId() {
        try {
            const jsonLd = document.querySelector('script[type="application/ld+json"]');
            if (!jsonLd) return null;
            const data = JSON.parse(jsonLd.textContent);

            if (data['@type'] === 'VideoObject') {
                for (const u of [data.contentUrl, data.thumbnailUrl]) {
                    if (!u) continue;
                    const m = u.match(/\/([a-f0-9]{24})[\/\.]/);
                    if (m) return m[1];
                }
                if (data.embedUrl) {
                    const m = data.embedUrl.match(/\/videos\/([a-f0-9]{24})/);
                    if (m) return m[1];
                }
                return null;
            }

            if (data['@type'] === 'ItemList') {
                const index = parseInt(new URLSearchParams(location.search).get('index') || '0', 10);
                const item = data.itemListElement?.find(el => el.position === index + 1);
                const m = (item?.item?.embedUrl || '').match(/\/videos\/([a-f0-9]{24})/);
                return m ? m[1] : null;
            }
        } catch {}
        return null;
    }

    // ---------------------------------------------------------------------
    // Watched tracking
    // ---------------------------------------------------------------------
    // Local playback history, exposed via PMVX.watched / __pmvIsWatched / __pmvMarkWatched.
    // Attached from getVideo()'s one-time init, so no extra polling is needed.
    let watchedMap = new Map(); // videoId -> ISO timestamp
    (function loadWatched() {
        try {
            const raw = localStorage.getItem(WATCHED_KEY);
            if (!raw) return;
            watchedMap = new Map(Object.entries(JSON.parse(raw)));
        } catch {}
    })();
    function saveWatched() {
        try {
            if (watchedMap.size > WATCHED_MAX) {
                // Trim oldest-watched entries first.
                const sorted = [...watchedMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
                for (const [id] of sorted.slice(0, watchedMap.size - WATCHED_MAX)) watchedMap.delete(id);
            }
            localStorage.setItem(WATCHED_KEY, JSON.stringify(Object.fromEntries(watchedMap)));
        } catch {}
    }
    function markWatched(videoId) {
        if (!videoId) return;
        watchedMap.set(videoId, new Date().toISOString());
        saveWatched();
    }
    PMVX.watched = watchedMap;
    PMVX.isWatched = id => watchedMap.has(id);
    PMVX.markWatched = markWatched; // manual override

    // Per-video dedup against the current id: Vue reuses the same <video> element across auto-advance.
    let lastMarkedWatchedId = null;
    function maybeMarkWatchedFromPlayback(v) {
        const id = getCurrentVideoId();
        if (!id || id === lastMarkedWatchedId) return;
        if (!v.duration || !Number.isFinite(v.duration)) return;
        if (v.ended || v.currentTime / v.duration >= 0.85) {
            lastMarkedWatchedId = id;
            markWatched(id);
        }
    }

    // ---------------------------------------------------------------------
    // Settings export/import
    // ---------------------------------------------------------------------
    // Exports every pmv*-prefixed localStorage key (scanned dynamically).
    function collectPmvSettings() {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            // Settings only: caches are rebuilt from the site and would bloat the file.
            if (!k || !k.startsWith('pmv') || /cache/i.test(k)) continue;
            try { out[k] = JSON.parse(localStorage.getItem(k)); }
            catch { out[k] = localStorage.getItem(k); } // non-JSON string value
        }
        return out;
    }
    function applyPmvSettings(obj) {
        let count = 0;
        for (const [k, v] of Object.entries(obj)) {
            if (!k.startsWith('pmv')) continue; // never touch unrelated keys
            localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
            count++;
        }
        return count;
    }

    // ---------------------------------------------------------------------
    // Settings section
    // ---------------------------------------------------------------------
    // A section appended to the site's Settings modal (teleported to <body> while open: overlay, card,
    // h2 "Settings", a `space-y-6` section list). Styled like the native sections, with an inline
    // CustomSelect that scrolls with the modal. The observer re-adds the section if the list is rebuilt.
    // Without the gear (logged out) the section opens in a copy of the modal via Ctrl+K.
    const TS_SVG = {
        gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg>',
        volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"></path><path d="M16 9a5 5 0 0 1 0 6"></path><path d="M19.4 18.4a9 9 0 0 0 0-12.8"></path></svg>',
        film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18"></rect><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"></path></svg>',
        ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="m4.9 4.9 14.2 14.2"></path></svg>',
        keyboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"></path></svg>',
        database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14a9 3 0 0 0 18 0V5"></path><path d="M3 12a9 3 0 0 0 18 0"></path></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="14" height="14" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>',
        download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m7 10 5 5 5-5"></path><path d="M12 15V3"></path></svg>',
        upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m17 8-5-5-5 5"></path><path d="M12 3v12"></path></svg>',
        chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>',
        x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>',
        gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    };

    function ensureToolsSettingsStyle() {
        if (document.getElementById('pmv-ts-style')) return;
        const R = '[data-pmv-tools-settings]';
        const st = document.createElement('style');
        st.id = 'pmv-ts-style';
        st.textContent = `
${R}{display:flex;flex-direction:column;gap:16px;font-family:inherit;}
${R} *{box-sizing:border-box;}
${R} h3{margin:0;padding-bottom:8px;border-bottom:1px solid #2A2A2A;color:#fff;font-size:18px;line-height:28px;font-weight:600;display:flex;align-items:baseline;gap:8px;}
${R} h3 .sub{margin-left:auto;font-size:12px;line-height:16px;font-weight:400;color:rgb(107,114,128);}
${R} .ts-card{padding:16px;background:#0F0F0F;border-radius:8px;display:flex;flex-direction:column;gap:12px;}
${R} .ts-lab{color:#fff;font-weight:500;font-size:16px;line-height:24px;display:flex;align-items:center;gap:8px;}
${R} .ts-lab svg{width:18px;height:18px;flex-shrink:0;}
${R} .ts-desc{margin:4px 0 0;font-size:14px;line-height:20px;color:rgb(156,163,175);}
${R} .ts-meta{font-size:12px;line-height:16px;color:rgb(107,114,128);word-break:break-word;}
${R} .ts-cs{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:.75rem;background:#0000004d;border:1px solid hsla(0,0%,100%,.1);
  border-radius:8px;color:#fff;font-family:inherit;font-size:.95rem;cursor:pointer;transition:all .2s;text-align:left;}
${R} .ts-cs:hover{border-color:#fff3;background:#0006;}
${R} .ts-cs[data-open="1"],${R} .ts-cs:focus-visible{outline:none;border-color:#f9731680;box-shadow:0 0 0 3px #f973161a;}
${R} .ts-cs .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
${R} .ts-cs[data-empty="1"]{color:#ffffff80;}
${R} .ts-cs svg{width:18px;height:18px;flex-shrink:0;color:#fff6;transition:transform .2s;}
${R} .ts-cs[data-open="1"] svg{transform:rotate(180deg);}
${R} .ts-dd{margin-top:8px;background:#1a1a1a;border:1px solid rgba(249,115,22,.3);border-radius:8px;max-height:300px;overflow-y:auto;box-shadow:0 8px 24px #0006;}
${R} .ts-dd[hidden]{display:none;}
${R} .ts-dd::-webkit-scrollbar{width:8px;} ${R} .ts-dd::-webkit-scrollbar-track{background:#0003;border-radius:4px;}
${R} .ts-dd::-webkit-scrollbar-thumb{background:#f973164d;border-radius:4px;} ${R} .ts-dd::-webkit-scrollbar-thumb:hover{background:#f9731680;}
${R} .ts-it{display:flex;align-items:center;gap:.75rem;width:100%;padding:.75rem 1rem;background:none;border:none;border-bottom:1px solid hsla(0,0%,100%,.05);
  color:#fff;text-align:left;cursor:pointer;transition:all .2s;font-family:inherit;}
${R} .ts-it:last-child{border-bottom:none;}
${R} .ts-gh{padding:10px 16px 6px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:rgb(107,114,128);background:#151515;border-bottom:1px solid hsla(0,0%,100%,.05);}
${R} .ts-it:hover{background:#f973161a;}
${R} .ts-it[data-sel="1"]{background:#f9731626;}
${R} .ts-it .c{display:flex;flex-direction:column;gap:.25rem;flex:1;min-width:0;}
${R} .ts-it .l{font-size:.95rem;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
${R} .ts-it .d{font-size:.8rem;color:#ffffff80;line-height:1.3;}
${R} .ts-it svg{width:18px;height:18px;flex-shrink:0;color:#f97316;visibility:hidden;}
${R} .ts-it[data-sel="1"] svg{visibility:visible;}
${R} .ts-row2{display:flex;align-items:center;justify-content:space-between;gap:16px;}
${R} .ts-sw{position:relative;display:inline-flex;align-items:center;flex-shrink:0;width:44px;height:24px;border:none;padding:0;border-radius:9999px;background:#2A2A2A;cursor:pointer;transition:background .15s;}
${R} .ts-sw[aria-checked="true"]{background:rgb(249,115,22);}
${R} .ts-sw .k{position:absolute;left:4px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s;}
${R} .ts-sw[aria-checked="true"] .k{transform:translateX(20px);}
${R} .ts-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:8px 16px;border-radius:8px;cursor:pointer;font-family:inherit;
  font-size:14px;line-height:20px;font-weight:500;transition:all .15s;border:1px solid transparent;background:#2A2A2A;color:#fff;}
${R} .ts-btn:hover{background:#3A3A3A;}
${R} .ts-btn svg{width:16px;height:16px;flex-shrink:0;}
${R} .ts-btn.accent{background:rgba(249,115,22,.2);border-color:rgba(249,115,22,.4);color:rgb(253,186,116);}
${R} .ts-btn.accent:hover{background:rgba(249,115,22,.3);border-color:rgba(249,115,22,.6);}
${R} .ts-row{display:flex;gap:8px;flex-wrap:wrap;} ${R} .ts-row > .ts-btn{flex:1;}
${R} textarea{display:block;width:100%;height:110px;padding:8px 12px;resize:vertical;background:#1E1E1E;border:1px solid #2A2A2A;border-radius:8px;
  color:#fff;font-size:12px;line-height:16px;font-family:inherit;font-variant-numeric:tabular-nums;outline:none;}
${R} textarea:focus{outline:none;box-shadow:0 0 0 2px rgb(249,115,22);}
${R} textarea::placeholder{color:rgb(107,114,128);}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    // Inline version of the site's CustomSelect. items(): [{ value, label, desc }].
    function mkToolsSelect(items, getValue, onPick) {
        const wrap = document.createElement('div');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ts-cs';
        btn.innerHTML = `<span class="t"></span>${TS_SVG.chev}`;
        const dd = document.createElement('div');
        dd.className = 'ts-dd';
        dd.hidden = true;
        wrap.append(btn, dd);
        const paint = () => {
            const cur = items().find(i => !i.header && i.value === getValue());
            btn.querySelector('.t').textContent = cur ? cur.label : 'None';
            btn.dataset.empty = cur && cur.value ? '0' : '1';
        };
        const close = () => { dd.hidden = true; btn.dataset.open = '0'; };
        btn.onclick = e => {
            e.stopPropagation();
            if (!dd.hidden) { close(); return; }
            wrap.closest('[data-pmv-tools-settings]')?.querySelectorAll('.ts-dd').forEach(d => { d.hidden = true; d.previousElementSibling.dataset.open = '0'; });
            dd.innerHTML = items().map(it => it.header ? `<div class="ts-gh">${escHtml(it.label)}</div>` : `
                <button type="button" class="ts-it" data-v="${escHtml(it.value)}" data-sel="${it.value === getValue() ? '1' : '0'}">
                    <span class="c"><span class="l">${escHtml(it.label)}</span>${it.desc ? `<span class="d">${escHtml(it.desc)}</span>` : ''}</span>${TS_SVG.check}
                </button>`).join('');
            dd.querySelectorAll('.ts-it').forEach(row => {
                row.onclick = ev => {
                    ev.stopPropagation();
                    close();
                    if (row.dataset.v !== getValue()) { onPick(row.dataset.v); paint(); }
                };
            });
            dd.hidden = false;
            btn.dataset.open = '1';
            dd.scrollIntoView({ block: 'nearest' });
        };
        paint();
        return { el: wrap, close, paint };
    }

    // A settings card (ts-* styles) with a label, a description and a control under it.
    function toolsCard(icon, iconColor, label, desc, control) {
        const c = document.createElement('div');
        c.className = 'ts-card';
        c.innerHTML = `<div><label class="ts-lab"><span style="display:inline-flex;${iconColor ? `color:${iconColor};` : ''}">${icon}</span>${label}</label><p class="ts-desc">${desc}</p></div>`;
        if (control) c.appendChild(control);
        return c;
    }

    function moreSettingsCard() {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ts-btn';
        b.style.width = '100%';
        b.innerHTML = `${TS_SVG.gear}Open full settings`;
        b.onclick = () => {
            // Close the site's modal (Escape), then go to the section on /settings.
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.getElementById('pmv-ts-modal')?.remove();
            siteNavigate('/settings#pmvx');
        };
        return toolsCard(TS_SVG.gear, '', 'More settings', 'Hotkeys, playlist names &amp; colours and backup are on the full settings page', b);
    }

    function hotkeysCard() {
        const hk = document.createElement('button');
        hk.type = 'button';
        hk.className = 'ts-btn accent';
        hk.style.width = '100%';
        hk.innerHTML = `${TS_SVG.keyboard}Assign hotkeys`;
        hk.onclick = () => buildKeybindingEditor();
        return toolsCard(TS_SVG.keyboard, '', 'Hotkeys', 'Remap every hotkey, including the playlist buttons', hk);
    }

    function backupCard() {
        const keys = Object.keys(collectPmvSettings());

        const bk = document.createElement('div');
        bk.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
        bk.innerHTML = `
            <div class="ts-meta">${keys.length} stored key${keys.length === 1 ? '' : 's'}: ${escHtml(keys.map(k => k.replace(/^pmv[a-z]*_?/, '')).join(', ') || '(none)')}</div>
            <textarea spellcheck="false" placeholder="Export fills this box. To import, paste JSON here or load a file."></textarea>
            <div class="ts-row">
                <button type="button" class="ts-btn" data-k="export" title="Fill the box and copy to the clipboard">${TS_SVG.copy}Export</button>
                <button type="button" class="ts-btn" data-k="download">${TS_SVG.download}Download</button>
                <button type="button" class="ts-btn" data-k="file" title="Load a .json file into the box">${TS_SVG.upload}Load file</button>
            </div>
            <button type="button" class="ts-btn accent" data-k="import">Import (reloads the page)</button>
            <input type="file" accept="application/json,.json" hidden>`;
        const ta = bk.querySelector('textarea');
        const fileInput = bk.querySelector('input[type=file]');
        const exportJson = () => JSON.stringify(collectPmvSettings(), null, 2);
        bk.querySelector('[data-k="export"]').onclick = async () => {
            ta.value = exportJson();
            ta.select();
            try { await navigator.clipboard.writeText(ta.value); toast('Settings copied to clipboard', 'green'); } catch {}
        };
        bk.querySelector('[data-k="download"]').onclick = () => {
            const blob = new Blob([exportJson()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pmvhaven-settings-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        bk.querySelector('[data-k="file"]').onclick = () => fileInput.click();
        fileInput.onchange = async () => {
            const f = fileInput.files?.[0];
            if (!f) return;
            try { ta.value = await f.text(); } catch { toast('Could not read file'); }
            fileInput.value = '';
        };
        bk.querySelector('[data-k="import"]').onclick = () => {
            let parsed;
            try { parsed = JSON.parse(ta.value); }
            catch { toast('Invalid JSON'); return; }
            if (!parsed || typeof parsed !== 'object') { toast('Invalid JSON'); return; }
            const count = applyPmvSettings(parsed);
            toast(`${count} setting(s) imported - reloading`);
            setTimeout(() => location.reload(), 1200);
        };
        return toolsCard(TS_SVG.database, '', 'Backup', 'Filters, Up next, watch history, hotkeys and playlist names', bk);
    }

    function buildToolsSettingsSection() {
        ensureToolsSettingsStyle();
        const sec = document.createElement('div');
        sec.setAttribute('data-pmv-tools-settings', '1');
        const card = (icon, iconColor, label, desc) => `
            <div class="ts-card">
                <div>
                    <label class="ts-lab"><span style="display:inline-flex;${iconColor ? `color:${iconColor};` : ''}">${icon}</span>${label}</label>
                    <p class="ts-desc">${desc}</p>
                </div>
                <div data-slot></div>
            </div>`;
        sec.innerHTML = `
            <h3>PMVH Extended<span class="sub">userscript</span></h3>
            <div class="ts-card">
                <div>
                    <label class="ts-lab"><span style="display:inline-flex;">${TS_SVG.gauge}</span>Performance</label>
                    <p class="ts-desc">Lower this on slower computers if scrolling or video playback stutters</p>
                </div>
                <div data-perf></div>
            </div>
            ${card(TS_SVG.film, '', 'Seekbar preview', 'Frame shown above the seekbar while you scrub. Live builds a frame cache in the background and uses more CPU.')}
            <div class="ts-card"><div class="ts-row2">
                <div>
                    <label class="ts-lab"><span style="display:inline-flex;">${TS_SVG.volume}</span>Volume lock</label>
                    <p class="ts-desc">Keep the player unmuted at 100 % on every video</p>
                </div>
                <button type="button" class="ts-sw" role="switch" data-vol><span class="k"></span></button>
            </div></div>
            ${card(TS_SVG.ban, 'rgb(248,113,113)', 'Reject list', 'Adding a video there removes it from every other playlist and shows it red instead of green. The Reject hotkey also skips to the next video.')}
            <div class="ts-card"><div class="ts-row2">
                <div>
                    <label class="ts-lab"><span style="display:inline-flex;">${TAG_SVG}</span>Tag after reject</label>
                    <p class="ts-desc">After rejecting a video (⊘), ask for a tag and add it to the video on the site</p>
                </div>
                <button type="button" class="ts-sw" role="switch" data-tagrej><span class="k"></span></button>
            </div></div>
            <div class="ts-card" data-more></div>
        `;
        const slots = sec.querySelectorAll('[data-slot]');

        // Seekbar preview
        const scrubItems = () => [
            { value: 'hybrid', label: 'Live', desc: 'Frame cache built in the background (more CPU)' },
            { value: 'frames', label: 'Timeline thumbnails', desc: "The site's own preview frames" },
            { value: 'off', label: 'Off', desc: 'No preview' },
        ];
        const scrubSel = mkToolsSelect(scrubItems, () => scrubMode(), v => setScrubMode(v));
        slots[0].replaceWith(scrubSel.el);

        // Performance mode
        const perfItems = () => [
            { value: 'smooth', label: 'Smooth', desc: 'Pages update instantly, all effects — for fast computers' },
            { value: 'balanced', label: 'Balanced', desc: 'Page updates batched slightly, all effects (default)' },
            { value: 'light', label: 'Light', desc: 'For slower computers: fewer page updates, no blur or animations (also the site\u2019s), one background request at a time, no live seekbar preview' },
        ];
        const perfSel = mkToolsSelect(perfItems, () => PMVX.perfMode(), v => {
            PMVX.setPerfMode(v);
            if (v === 'light') scrubDrop();
            else if (scrubModeCached === 'hybrid') scrubWarm();
            scrubSel.paint?.();
        });
        sec.querySelector('[data-perf]').replaceWith(perfSel.el);

        // Volume lock
        const vol = sec.querySelector('[data-vol]');
        const paintVol = () => vol.setAttribute('aria-checked', volumeLockEnabled() ? 'true' : 'false');
        vol.onclick = () => { setVolumeLock(!volumeLockEnabled()); paintVol(); };
        paintVol();

        // Tag after reject
        const tagRej = sec.querySelector('[data-tagrej]');
        const paintTagRej = () => tagRej.setAttribute('aria-checked', tagAfterReject() ? 'true' : 'false');
        tagRej.onclick = () => { setTagAfterReject(!tagAfterReject()); paintTagRej(); };
        paintTagRej();

        // Reject list
        const rejectItems = () => {
            const items = [{ value: '', label: 'None', desc: 'No reject list' }];
            [...State.playlists.values()]
                .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
                .forEach(p => items.push({ value: p.id, label: getPlaylistDisplayName(p.name, p.id) || p.id, desc: `${p.ids.size} videos` }));
            if (rejectPlaylistId && !State.playlists.has(rejectPlaylistId)) {
                // Not loaded yet; keep it visible instead of showing "None".
                items.push({ value: rejectPlaylistId, label: rejectPlaylistId, desc: 'Not loaded yet' });
            }
            return items;
        };
        const rejectSel = mkToolsSelect(rejectItems, () => rejectPlaylistId || '', v => {
            setRejectPlaylistId(v);
            document.getElementById('pmv-page-playlists')?.remove();
            document.querySelectorAll('[data-pmv-checked]').forEach(el => delete el.dataset.pmvChecked);
            updateNativePlaylistButtons(true);
            scheduleBadges();
            try { renderQueueSidebar(); } catch {}
            const name = rejectItems().find(i => i.value === v)?.label;
            toast(v ? '⊘ Reject list: ' + name : 'Reject list off');
        });
        slots[1].replaceWith(rejectSel.el);

        // Advanced settings live on the site's full settings page.
        sec.querySelector('[data-more]').replaceWith(moreSettingsCard());

        // A click elsewhere in the modal folds an open list.
        sec.addEventListener('click', e => {
            if (!e.target.closest('.ts-cs, .ts-dd')) { scrubSel.close(); rejectSel.close(); }
        });
        return sec;
    }

    // The section list of the open Settings modal, if any.
    function nativeSettingsList() {
        for (const ov of document.body.children) {
            if (ov.tagName !== 'DIV' || !ov.classList.contains('inset-0')) continue;
            const h2 = ov.querySelector('h2');
            if (!h2 || h2.textContent.trim() !== 'Settings') continue;
            const list = h2.parentElement?.nextElementSibling;
            if (list?.classList.contains('space-y-6')) return list;
        }
        return null;
    }

    function injectToolsSettings() {
        const list = nativeSettingsList();
        if (!list || list.querySelector(':scope > [data-pmv-tools-settings]')) return;
        list.appendChild(buildToolsSettingsSection());
    }

    let toolsSettingsQueued = false;
    new MutationObserver(() => {
        if (toolsSettingsQueued) return;
        toolsSettingsQueued = true;
        requestAnimationFrame(() => { toolsSettingsQueued = false; try { injectToolsSettings(); } catch {} });
    }).observe(document.body, { childList: true, subtree: true });

    // ---------------------------------------------------------------------
    // /settings page: playlist names & colours
    // ---------------------------------------------------------------------
    // A section in the site's full settings page (same card style as its own sections) for the
    // per-playlist short names and colours in pmv_playlist_config_v1. Saved on change.

    function savePlaylistConfig() {
        try {
            const raw = JSON.parse(localStorage.getItem(PLAYLIST_CONFIG_KEY) || '{}') || {};
            raw.styles = playlistConfig.styles;
            if (!raw.order) raw.order = playlistConfig.order;
            if (!Object.keys(raw.styles).length && !(raw.order || []).length) localStorage.removeItem(PLAYLIST_CONFIG_KEY);
            else localStorage.setItem(PLAYLIST_CONFIG_KEY, JSON.stringify(raw));
        } catch {}
        // Badges and chips pick the new names up on the next pass.
        document.querySelectorAll('[data-playlist-name], [data-pmv-rec-badge]').forEach(el => el.remove());
        document.querySelectorAll('[data-pmv-checked], [data-pmv-rec-checked], [data-pmv-mf-checked]').forEach(el => {
            delete el.dataset.pmvChecked; delete el.dataset.pmvRecChecked; delete el.dataset.pmvMfChecked;
        });
        try { scheduleBadges(); } catch {}
    }

    // Every entry for a playlist: by id, and legacy ones by (lowercased) name.
    function playlistStyleKeys(p) {
        const name = p.name || '';
        return [p.id, name.trim().toLowerCase(), name].filter((k, i, a) => k && a.indexOf(k) === i);
    }
    function setPlaylistStyle(p, patch) {
        const cur = getPlaylistStyle(p.name, p.id) || {};
        const explicit = playlistStyleKeys(p).map(k => playlistConfig.styles[k]).find(Boolean) || {};
        playlistStyleKeys(p).forEach(k => delete playlistConfig.styles[k]);
        const next = { label: explicit.label || null, color: explicit.color || null, ...patch };
        if (!next.label) delete next.label;
        if (!next.color) delete next.color;
        if (Object.keys(next).length) playlistConfig.styles[p.id] = next;
        return cur;
    }

    function settingsPageList() {
        if (location.pathname.replace(/\/+$/, '') !== '/settings') return null;
        for (const h1 of document.querySelectorAll('h1')) {
            if (h1.textContent.trim() !== 'Settings') continue;
            const wrap = h1.closest('.max-w-4xl');
            const list = wrap && [...wrap.children].find(c => c.classList.contains('space-y-6'));
            if (list) return list;
        }
        return null;
    }

    function injectSettingsPageSection() {
        const list = settingsPageList();
        if (!list || list.querySelector(':scope > #pmvx-settings-names')) return;
        if (!document.getElementById('pmvx-settings-names-style')) {
            const st = document.createElement('style');
            st.id = 'pmvx-settings-names-style';
            st.textContent = `
#pmvx-settings-names .pn-row{display:flex;align-items:center;gap:12px;padding:8px 12px;background:#161616;border:1px solid #1F1F1F;border-radius:8px;}
#pmvx-settings-names .pn-name{flex:1;min-width:0;color:#fff;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#pmvx-settings-names .pn-name small{color:rgb(107,114,128);font-weight:400;margin-left:6px;font-variant-numeric:tabular-nums;}
#pmvx-settings-names input[type=text]{width:180px;max-width:40%;background:#1A1A1A;border:1px solid #2A2A2A;border-radius:8px;padding:6px 10px;color:#fff;font-size:13px;outline:none;font-family:inherit;}
#pmvx-settings-names input[type=text]:focus{border-color:rgba(249,115,22,.6);}
#pmvx-settings-names input[type=color]{width:28px;height:28px;padding:0;border:1px solid #2A2A2A;border-radius:9999px;background:none;cursor:pointer;flex-shrink:0;overflow:hidden;}
#pmvx-settings-names input[type=color]::-webkit-color-swatch-wrapper{padding:0;}
#pmvx-settings-names input[type=color]::-webkit-color-swatch{border:none;border-radius:9999px;}
#pmvx-settings-names .pn-reset{color:rgb(107,114,128);background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;font-size:13px;line-height:1;}
#pmvx-settings-names .pn-reset:hover{color:rgb(248,113,113);background:rgba(239,68,68,.1);}
#pmvx-settings-names .pn-reset[disabled]{visibility:hidden;}
#pmvx-settings-names .pn-btn{padding:6px 12px;border-radius:8px;border:1px solid #2A2A2A;background:none;color:rgb(156,163,175);font-size:12px;font-weight:500;cursor:pointer;}
#pmvx-settings-names .pn-btn:hover{border-color:rgba(239,68,68,.5);background:rgba(239,68,68,.1);color:rgb(248,113,113);}`;
            document.head.appendChild(st);
        }
        ensureToolsSettingsStyle();
        const sec = document.createElement('div');
        sec.id = 'pmvx-settings-names';
        sec.className = 'bg-gradient-to-br from-[#1A1A1A] to-[#0F0F0F] border border-[#2A2A2A] rounded-xl p-6 shadow-2xl';
        sec.innerHTML = `
            <h2 class="text-xl font-semibold text-white mb-6 flex items-center gap-2 border-b border-[#2A2A2A] pb-3">
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-orange-400"><path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/></svg>
                PMVH Extended
                <span class="text-sm text-gray-500 font-normal" style="margin-left:auto;">Quick settings: gear at the top right</span>
            </h2>
            <div data-pmv-tools-settings="1" data-body></div>`;
        const body = sec.querySelector('[data-body]');
        const names = document.createElement('div');
        names.className = 'ts-card';
        names.innerHTML = `
            <div>
                <label class="ts-lab"><span style="display:inline-flex;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/></svg></span>Playlist names &amp; colours</label>
                <p class="ts-desc">Short name shown on playlist buttons, badges and the sidebar (empty = the playlist's own name) and its colour. Saved as you type.</p>
            </div>
            <div class="space-y-2" data-rows></div>
            <div style="display:flex;align-items:center;gap:12px;">
                <span class="ts-meta" data-status></span>
                <div style="flex:1"></div>
                <button type="button" class="pn-btn" data-reset-all>Reset all names &amp; colours</button>
            </div>`;
        body.append(hotkeysCard(), names, sidebarCard(), backupCard());
        const rowsEl = names.querySelector('[data-rows]');
        const status = names.querySelector('[data-status]');
        const flash = t => { status.textContent = t; clearTimeout(flash.t); flash.t = setTimeout(() => { status.textContent = ''; }, 1800); };

        const render = () => {
            rowsEl.textContent = '';
            const list = [...State.playlists.values()].sort((a, b) =>
                playlistSortIndex(a.name) - playlistSortIndex(b.name) || (a.name || '').localeCompare(b.name || ''));
            if (!list.length) {
                const e = document.createElement('div');
                e.className = 'text-sm text-gray-500';
                e.textContent = 'No playlists loaded yet — open any page while logged in, then come back.';
                rowsEl.appendChild(e);
                return;
            }
            list.forEach(p => {
                const explicit = playlistStyleKeys(p).map(k => playlistConfig.styles[k]).find(Boolean) || null;
                const st = getPlaylistStyle(p.name, p.id) || {};
                const row = document.createElement('div');
                row.className = 'pn-row';
                const color = document.createElement('input');
                color.type = 'color';
                color.value = '#' + (isRejectList(p.id) ? REJECT_HEX : (st.color || FALLBACK_COLOR));
                color.disabled = isRejectList(p.id);
                color.title = isRejectList(p.id) ? 'The reject list is always red' : 'Colour';
                const name = document.createElement('div');
                name.className = 'pn-name';
                name.title = p.name || p.id;
                name.textContent = p.name || p.id;
                const n = document.createElement('small');
                n.textContent = `${p.ids.size}`;
                name.appendChild(n);
                const label = document.createElement('input');
                label.type = 'text';
                label.placeholder = 'Short name';
                label.value = explicit?.label || '';
                const reset = document.createElement('button');
                reset.type = 'button';
                reset.className = 'pn-reset';
                reset.textContent = '✕';
                reset.title = 'Reset name and colour';
                reset.disabled = !explicit;
                let t = null;
                label.addEventListener('input', () => {
                    clearTimeout(t);
                    t = setTimeout(() => {
                        setPlaylistStyle(p, { label: label.value.trim() || null });
                        savePlaylistConfig();
                        reset.disabled = false;
                        flash('Saved');
                    }, 400);
                });
                color.addEventListener('change', () => {
                    setPlaylistStyle(p, { color: color.value.replace('#', '').toLowerCase() });
                    savePlaylistConfig();
                    reset.disabled = false;
                    flash('Saved');
                });
                reset.addEventListener('click', () => {
                    playlistStyleKeys(p).forEach(k => delete playlistConfig.styles[k]);
                    savePlaylistConfig();
                    flash('Reset');
                    render();
                });
                row.append(color, name, label, reset);
                rowsEl.appendChild(row);
            });
        };
        names.querySelector('[data-reset-all]').addEventListener('click', () => {
            if (!confirm('Reset the short names and colours of all playlists?')) return;
            Object.keys(playlistConfig.styles).forEach(k => delete playlistConfig.styles[k]);
            savePlaylistConfig();
            flash('All reset');
            render();
        });
        render();
        window.addEventListener('pmv:cache-ready', () => { if (sec.isConnected) render(); });
        list.appendChild(sec);
        if (location.hash === '#pmvx') setTimeout(() => sec.scrollIntoView({ block: 'start', behavior: 'smooth' }), 100);
    }

    // Vue may re-render the page and drop the section; put it back.
    let settingsPageQueued = false;
    new MutationObserver(() => {
        if (settingsPageQueued || location.pathname.replace(/\/+$/, '') !== '/settings') return;
        settingsPageQueued = true;
        requestAnimationFrame(() => { settingsPageQueued = false; try { injectSettingsPageSection(); } catch {} });
    }).observe(document.body, { childList: true, subtree: true });

    // ---------------------------------------------------------------------
    // Sidebar: hide items (set on the full settings page)
    // ---------------------------------------------------------------------
    // Keys: "g:<label>" for a group (Explore, Community, Saved content: header and items), "a:<href>" for
    // a single link. Hidden via a data-* flag + stylesheet, re-applied on every sidebar pass.
    const NAV_HIDE_KEY = 'pmv_sidebar_hidden_v1';
    let navHidden = new Set((() => { try { return JSON.parse(localStorage.getItem(NAV_HIDE_KEY) || '[]'); } catch { return []; } })());
    function saveNavHidden() {
        try { if (navHidden.size) localStorage.setItem(NAV_HIDE_KEY, JSON.stringify([...navHidden])); else localStorage.removeItem(NAV_HIDE_KEY); } catch {}
    }
    function navLinkLabel(a) {
        const span = a.querySelector('span.flex-1');
        const t = (span ? span.textContent : [...a.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ') || a.textContent).trim();
        return t.replace(/\s+BETA$/i, '').replace(/\s+/g, ' ');
    }
    // Every hideable entry of the visible sidebar: [{ key, label, el, group, depth }]
    function navEntries() {
        const aside = [...document.querySelectorAll('aside')].find(a => a.getClientRects().length && a.querySelector('nav'));
        if (!aside) return [];
        const out = [];
        const inGroup = new Set();
        aside.querySelectorAll('button[aria-label^="Toggle "][aria-label$=" submenu"]').forEach(btn => {
            const label = btn.getAttribute('aria-label').slice(7, -8).trim();
            const wrap = btn.id === 'pmvx-saved-nav' ? btn : (btn.closest('#pmvx-saved-nav') || btn.closest('div.mt-1') || btn.parentElement?.parentElement);
            if (!wrap || inGroup.has(wrap)) return;
            inGroup.add(wrap);
            out.push({ key: 'g:' + label, label, el: wrap, group: true, depth: 0 });
            if (wrap.id === 'pmvx-saved-nav') return; // its playlists come and go
            wrap.querySelectorAll('a[href]').forEach(a => {
                if (a.closest('div.flex.items-center.justify-between') && a.closest('div.flex.items-center.justify-between').contains(btn)) return; // the header link
                const label2 = navLinkLabel(a);
                if (label2) out.push({ key: 'a:' + a.getAttribute('href'), label: label2, el: a, group: false, depth: 1, parent: label });
            });
        });
        aside.querySelectorAll('a[href]').forEach(a => {
            if ([...inGroup].some(w => w.contains(a))) return;
            if (a.closest('.mobile-profile')) return;
            const label = navLinkLabel(a);
            if (!label || out.some(e => e.key === 'a:' + a.getAttribute('href'))) return;
            out.push({ key: 'a:' + a.getAttribute('href'), label, el: a, group: false, depth: 0 });
        });
        return out;
    }
    function applyNavHidden() {
        if (!document.getElementById('pmv-navhide-style')) {
            const st = document.createElement('style');
            st.id = 'pmv-navhide-style';
            st.textContent = '[data-pmvx-nav-hidden="1"]{display:none !important;}';
            (document.head || document.documentElement).appendChild(st);
        }
        if (!navHidden.size && !document.querySelector('[data-pmvx-nav-hidden]')) return;
        navEntries().forEach(e => {
            const hide = navHidden.has(e.key);
            if (hide && e.el.dataset.pmvxNavHidden !== '1') e.el.dataset.pmvxNavHidden = '1';
            else if (!hide && e.el.dataset.pmvxNavHidden) delete e.el.dataset.pmvxNavHidden;
        });
    }

    // Settings card: one switch per sidebar entry (on = shown).
    function sidebarCard() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
        const render = () => {
            wrap.textContent = '';
            const list = navEntries();
            if (!list.length) {
                const e = document.createElement('div');
                e.className = 'ts-meta';
                e.textContent = 'The sidebar is not open on this page — open it to choose items.';
                wrap.appendChild(e);
                return;
            }
            list.forEach(e => {
                const row = document.createElement('div');
                row.className = 'ts-row2';
                row.style.cssText = `padding:6px 0 6px ${e.depth ? 18 : 0}px;border-bottom:1px solid #1F1F1F;`;
                const lab = document.createElement('span');
                lab.style.cssText = `font-size:14px;color:${e.group ? '#fff' : 'rgb(209,213,219)'};font-weight:${e.group ? 600 : 400};`;
                lab.textContent = e.label + (e.group ? ' (group)' : '');
                const sw = document.createElement('button');
                sw.type = 'button';
                sw.className = 'ts-sw';
                sw.setAttribute('role', 'switch');
                sw.innerHTML = '<span class="k"></span>';
                const paint = () => sw.setAttribute('aria-checked', navHidden.has(e.key) ? 'false' : 'true');
                paint();
                sw.onclick = () => {
                    if (navHidden.has(e.key)) navHidden.delete(e.key); else navHidden.add(e.key);
                    saveNavHidden(); applyNavHidden(); paint();
                };
                row.append(lab, sw);
                wrap.appendChild(row);
            });
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'ts-btn';
            reset.style.marginTop = '8px';
            reset.textContent = 'Show everything';
            reset.onclick = () => { navHidden.clear(); saveNavHidden(); applyNavHidden(); render(); };
            wrap.appendChild(reset);
        };
        render();
        // The sidebar may render after this card.
        if (!navEntries().length) setTimeout(render, 1500);
        return toolsCard('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>',
            '', 'Sidebar', 'Hide items you never use. A group hides its header and everything in it.', wrap);
    }

    // ---------------------------------------------------------------------
    // Sidebar: "Saved content" group
    // ---------------------------------------------------------------------
    // A group under Explore in the site's sidebar: Favorites (the Favorites tab of your profile) and
    // each of your playlists. Built from clones of the sidebar's own header row and links, so it
    // matches their style; re-added when Vue re-renders the sidebar. Collapsed state is remembered.

    const SAVED_NAV_KEY = 'pmv_saved_nav_open_v1';
    const SAVED_NAV_ICON = {
        bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>',
        heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
        list: '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/>',
        ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
        chevronDown: '<path d="m6 9 6 6 6-6"/>',
        chevronRight: '<path d="m9 18 6-6-6-6"/>',
    };
    let savedNavOpen = (() => { try { return localStorage.getItem(SAVED_NAV_KEY) !== '0'; } catch { return true; } })();
    let savedNavSig = '';

    // Swaps the drawing of a cloned site icon, keeping its size and classes.
    function setNavIcon(svgEl, paths) {
        if (!svgEl) return;
        svgEl.setAttribute('viewBox', '0 0 24 24');
        svgEl.innerHTML = `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
    }

    function siteNavigate(href) {
        const router = document.querySelector('#__nuxt')?.__vue_app__?.config?.globalProperties?.$router;
        if (router) router.push(href).catch(() => { location.href = href; });
        else location.href = href;
    }

    // Extension points for builds that add to the sidebar rows: navRowHook(link, playlist) and
    // navRowSig(playlist) (part of the redraw signature); refreshSavedNav redraws.
    PMVX.refreshSavedNav = () => { try { injectSavedNav(); } catch {} };

    function savedNavLink(template, href, label, icon, extraTitle) {
        const a = template.cloneNode(true);
        [...a.attributes].forEach(at => { if (at.name !== 'class' && !at.name.startsWith('data-v-')) a.removeAttribute(at.name); });
        a.href = href;
        a.title = extraTitle || label;
        a.dataset.pmvSavedNav = '1';
        a.classList.remove('router-link-active', 'router-link-exact-active');
        const svgEl = a.querySelector('svg');
        const span = a.querySelector('span.flex-1') || document.createElement('span');
        // Keep only the icon and the label: drop badges and Vue comment nodes.
        a.textContent = '';
        if (svgEl) { setNavIcon(svgEl, icon); a.appendChild(svgEl); }
        span.className = 'flex-1';
        // min-width:0 lets a long name shrink (ellipsis) instead of widening the sidebar.
        span.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;';
        a.style.minWidth = '0';
        a.style.maxWidth = '100%';
        a.style.overflow = 'hidden';
        span.textContent = label;
        a.appendChild(span);
        a.addEventListener('click', e => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            siteNavigate(href);
        });
        return a;
    }

    function injectSavedNav() {
        const exploreToggle = document.querySelector('aside button[aria-label="Toggle Explore submenu"]');
        const exploreGroup = exploreToggle?.closest('div.mt-1');
        if (!exploreGroup) return;
        const existing = document.getElementById('pmvx-saved-nav');
        const playlists = [...State.playlists.values()].sort((a, b) =>
            playlistSortIndex(a.name) - playlistSortIndex(b.name) || (a.name || '').localeCompare(b.name || ''));
        // Logged out (no playlists known): no group.
        if (!playlists.length) { existing?.remove(); return; }
        const sig = savedNavOpen + '|' + playlists.map(p => p.id + ':' + getPlaylistDisplayName(p.name, p.id) + ':' + p.ids.size + ':' + (PMVX.navRowSig?.(p) || '')).join('|');
        if (existing && existing.previousElementSibling === exploreGroup && savedNavSig === sig) return;

        const headRowTpl = exploreToggle.closest('div.flex.items-center.justify-between');
        const linkTpl = exploreGroup.querySelector('#watch-videos-group a') || exploreGroup.querySelector('a');
        if (!headRowTpl || !linkTpl) return;

        const group = document.createElement('div');
        group.id = 'pmvx-saved-nav';
        group.className = exploreGroup.className;
        group.style.minWidth = '0';
        group.style.maxWidth = '100%';

        // Header: a clone of Explore's row, as a toggle.
        const head = headRowTpl.cloneNode(true);
        head.querySelectorAll('[aria-controls],[aria-expanded]').forEach(el => { el.removeAttribute('aria-controls'); el.removeAttribute('aria-expanded'); });
        const headLink = head.querySelector('a');
        const toggle = head.querySelector('button');
        if (headLink) {
            headLink.removeAttribute('href');
            headLink.removeAttribute('aria-label');
            // No role="button": the playlist-page filter finds queue rows by [role="button"].
            headLink.setAttribute('aria-expanded', savedNavOpen ? 'true' : 'false');
            headLink.classList.remove('router-link-active', 'router-link-exact-active');
            headLink.style.cursor = 'pointer';
            const icon = headLink.querySelector('svg');
            const iconClone = icon ? icon.cloneNode(false) : null;
            headLink.textContent = '';
            if (iconClone) { setNavIcon(iconClone, SAVED_NAV_ICON.bookmark); headLink.appendChild(iconClone); }
            headLink.appendChild(document.createTextNode(' Saved content '));
        }
        if (toggle) {
            toggle.setAttribute('aria-label', 'Toggle Saved content submenu');
            setNavIcon(toggle.querySelector('svg'), savedNavOpen ? SAVED_NAV_ICON.chevronDown : SAVED_NAV_ICON.chevronRight);
        }
        const flip = e => {
            e.preventDefault();
            e.stopPropagation();
            savedNavOpen = !savedNavOpen;
            try { localStorage.setItem(SAVED_NAV_KEY, savedNavOpen ? '1' : '0'); } catch {}
            injectSavedNav();
        };
        headLink?.addEventListener('click', flip);
        toggle?.addEventListener('click', flip);
        group.appendChild(head);

        if (savedNavOpen) {
            const items = document.createElement('div');
            items.className = exploreGroup.querySelector('#watch-videos-group')?.className || 'mt-1 space-y-1 pl-3';
            items.appendChild(savedNavLink(linkTpl, '/profile#favorites', 'Favorites', SAVED_NAV_ICON.heart));
            playlists.forEach(p => {
                const name = getPlaylistDisplayName(p.name, p.id) || p.name || p.id;
                const rej = isRejectList(p.id);
                const a = savedNavLink(linkTpl, `/playlists/${p.id}`, name, rej ? SAVED_NAV_ICON.ban : SAVED_NAV_ICON.list,
                    `${p.name || p.id} — ${p.ids.size} videos`);
                const n = document.createElement('span');
                n.textContent = String(p.ids.size);
                n.style.cssText = 'flex-shrink:0;font-size:11px;color:rgb(107,114,128);font-variant-numeric:tabular-nums;';
                a.appendChild(n);
                try { PMVX.navRowHook?.(a, p); } catch {}
                items.appendChild(a);
            });
            group.appendChild(items);
        }

        savedNavSig = sig;
        if (existing) existing.replaceWith(group);
        exploreGroup.after(group);
    }

    // /profile#favorites: open the Favorites tab once the profile has rendered.
    let favTabTries = 0;
    function openFavoritesTabIfAsked() {
        if (location.pathname.replace(/\/+$/, '') !== '/profile' || location.hash !== '#favorites') { favTabTries = 0; return; }
        if (favTabTries > 40) return;
        favTabTries++;
        const tab = [...document.querySelectorAll('button')].find(b =>
            b.classList.contains('pb-3') && /^Favorites\b/.test(b.textContent.trim()));
        if (!tab) return;
        favTabTries = 99;
        if (!tab.className.includes('text-orange-400')) tab.click();
    }

    let savedNavQueued = false;
    new MutationObserver(() => {
        if (savedNavQueued) return;
        savedNavQueued = true;
        requestAnimationFrame(() => {
            savedNavQueued = false;
            try { injectSavedNav(); } catch {}
            try { applyNavHidden(); } catch {}
            try { openFavoritesTabIfAsked(); } catch {}
        });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('pmv:cache-ready', () => { try { injectSavedNav(); } catch {} });

    // The site's gear: the header button whose lucide:settings icon has the r=3 center circle.
    function siteSettingsButton() {
        const row = headerControlRow();
        return row && [...row.querySelectorAll('button')]
            .find(b => b.querySelector('svg circle[r="3"][cx="12"][cy="12"]')) || null;
    }

    function openToolsSettings() {
        if (nativeSettingsList()) {
            nativeSettingsList().querySelector(':scope > [data-pmv-tools-settings]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
        }
        const gear = siteSettingsButton();
        if (gear) {
            gear.click();
            // Scrolled to once Vue has rendered the modal and the section is added.
            setTimeout(() => {
                injectToolsSettings();
                nativeSettingsList()?.querySelector(':scope > [data-pmv-tools-settings]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }, 150);
            return;
        }
        // Logged out: no gear, so open a copy of the modal holding only this section.
        if (document.getElementById('pmv-ts-modal')) return;
        const ov = document.createElement('div');
        ov.id = 'pmv-ts-modal';
        ov.style.cssText = 'position:fixed;inset:0;z-index:999990;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);';
        ov.innerHTML = `
            <div style="background:#1A1A1A;border:1px solid #2A2A2A;border-radius:12px;max-width:672px;width:100%;padding:24px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);max-height:90vh;overflow-y:auto;box-sizing:border-box;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                    <h2 style="margin:0;font-size:24px;line-height:32px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px;"><span style="display:inline-flex;width:24px;height:24px;">${TS_SVG.gear}</span>Settings</h2>
                    <button type="button" data-close style="display:inline-flex;padding:8px;border:none;border-radius:8px;background:transparent;color:rgb(156,163,175);cursor:pointer;"><span style="display:inline-flex;width:20px;height:20px;">${TS_SVG.x}</span></button>
                </div>
                <div data-body></div>
                <div style="margin-top:24px;display:flex;justify-content:flex-end;gap:12px;">
                    <button type="button" data-close style="padding:8px 16px;border:none;border-radius:8px;background:#2A2A2A;color:#fff;cursor:pointer;font-family:inherit;font-size:16px;">Close</button>
                </div>
            </div>`;
        ov.querySelector('[data-body]').replaceWith(buildToolsSettingsSection());
        const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
        const onKey = e => { if (e.key === 'Escape' && !document.getElementById('pmv-keyeditor')) { e.stopPropagation(); close(); } };
        ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(ov);
    }

    // ---------------------------------------------------------------------
    // Hotkey editor
    // ---------------------------------------------------------------------
    // Keyboard diagram: click or press a key, then bind an action or playlist inline (saved immediately).
    // Below it, a list of all bound keys. Tile colors: orange = action, green = playlist, red = reject list.
    // Styled like the site's Settings modal.
    const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm?']; // '?' is Shift+/ (hotkey overview)

    function bindingKind(b) {
        if (!b) return '';
        if (b.action === 'playlist') return isRejectList(b.playlistId) ? 'reject' : 'playlist';
        return b.action === 'builtin:rejectVideo' ? 'reject' : 'action';
    }
    function bindingShort(b) {
        if (!b) return '';
        if (b.action === 'playlist') return getPlaylistDisplayName(State.playlists.get(b.playlistId)?.name) || b.playlistId;
        const label = BUILTIN_ACTIONS[b.action?.slice(8)]?.label || '';
        return label.split(/\s[(:]|:\s/)[0];
    }

    function ensureKeyEditorStyle() {
        if (document.getElementById('pmv-ke-style')) return;
        const K = '#pmv-keyeditor';
        const st = document.createElement('style');
        st.id = 'pmv-ke-style';
        st.textContent = `
${K}{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);font-family:inherit;}
${K} .ke-card{background:#1A1A1A;border:1px solid #2A2A2A;border-radius:12px;width:100%;max-width:720px;max-height:90vh;overflow-y:auto;padding:24px;box-sizing:border-box;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);color:#fff;}
${K} .ke-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;}
${K} .ke-head h2{margin:0;font-size:24px;line-height:32px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px;}
${K} .ke-head h2 svg{width:24px;height:24px;}
${K} .ke-x{display:inline-flex;padding:8px;border:none;border-radius:8px;background:transparent;color:rgb(156,163,175);cursor:pointer;}
${K} .ke-x:hover{background:#2A2A2A;color:#fff;} ${K} .ke-x svg{width:20px;height:20px;}
${K} .ke-kb{display:flex;flex-direction:column;gap:6px;padding:16px;background:#0F0F0F;border-radius:8px;}
${K} .ke-row{display:flex;gap:6px;}
${K} .ke-key{width:56px;height:52px;flex-shrink:0;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-start;padding:6px 7px;box-sizing:border-box;
  border-radius:8px;border:1px solid #2A2A2A;background:#161616;cursor:pointer;text-align:left;font-family:inherit;transition:border-color .15s,background .15s,box-shadow .15s;}
${K} .ke-key:hover{border-color:#3A3A3A;background:#1C1C1C;}
${K} .ke-key .k{font-size:13px;line-height:14px;font-weight:700;color:rgb(209,213,219);}
${K} .ke-key .a{width:100%;font-size:9px;line-height:11px;color:rgb(107,114,128);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;}
${K} .ke-key[data-kind="action"]{border-color:rgba(249,115,22,.45);background:rgba(249,115,22,.08);} ${K} .ke-key[data-kind="action"] .a{color:rgb(253,186,116);}
${K} .ke-key[data-kind="playlist"]{border-color:rgba(100,255,0,.35);background:rgba(100,255,0,.06);} ${K} .ke-key[data-kind="playlist"] .a{color:rgb(163,230,53);}
${K} .ke-key[data-kind="reject"]{border-color:rgba(239,68,68,.5);background:rgba(239,68,68,.08);} ${K} .ke-key[data-kind="reject"] .a{color:rgb(252,165,165);}
${K} .ke-key[data-kind] .k{color:#fff;}
${K} .ke-key[data-sel="1"]{box-shadow:0 0 0 2px rgb(249,115,22);border-color:transparent;}
${K} .ke-key{position:relative;}
${K} .ke-key[data-site="1"]{border-style:dashed;border-color:#3A3A3A;}
${K} .ke-key[data-site="1"] .a{color:rgb(156,163,175);font-style:italic;}
${K} .ke-key[data-changed="1"]::after{content:'';position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:rgb(249,115,22);}
${K} .ke-key[data-over="1"]::after{content:'!';position:absolute;top:4px;right:4px;width:13px;height:13px;border-radius:50%;background:rgb(234,179,8);color:#000;font-size:9px;font-weight:800;line-height:13px;text-align:center;}
${K} .ke-legend .sw-dash{width:12px;height:10px;border:1px dashed #6B7280;border-radius:3px;background:transparent;}
${K} .ke-legend .sw-dot{width:6px;height:6px;border-radius:50%;background:rgb(249,115,22);}
${K} .ke-legend .sw-bang{width:13px;height:13px;border-radius:50%;background:rgb(234,179,8);color:#000;font-size:9px;font-weight:800;line-height:13px;text-align:center;font-style:normal;}
${K} .ke-meta{display:flex;flex-direction:column;gap:4px;font-size:13px;color:rgb(156,163,175);}
${K} .ke-meta b{color:rgb(229,231,235);font-weight:500;}
${K} .ke-note{font-size:13px;line-height:18px;color:rgb(250,204,21);}
${K} .ke-defs{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
@media (max-width:640px){${K} .ke-defs{grid-template-columns:1fr;}}
${K} .ke-defs h4{margin:0 0 6px;font-size:13px;font-weight:600;color:rgb(156,163,175);text-transform:uppercase;letter-spacing:.04em;}
${K} .ke-def{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #222;font-size:13px;color:rgb(209,213,219);}
${K} .ke-def:last-child{border-bottom:none;}
${K} .ke-def .t{flex:1;min-width:0;}
${K} .ke-def .st{font-size:11px;padding:1px 6px;border-radius:9999px;background:rgba(249,115,22,.15);color:rgb(253,186,116);white-space:nowrap;}
${K} .ke-def .st.over{background:rgba(234,179,8,.15);color:rgb(250,204,21);}
${K} .ke-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:rgb(156,163,175);}
${K} .ke-legend span{display:inline-flex;align-items:center;gap:6px;}
${K} .ke-legend i{width:10px;height:10px;border-radius:3px;display:inline-block;}
${K} .ke-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border-radius:6px;background:#1E1E1E;border:1px solid #2A2A2A;
  border-bottom-width:2px;color:#fff;font-size:13px;font-weight:700;font-family:inherit;box-sizing:border-box;}
${K} .ke-list{display:flex;flex-direction:column;}
${K} .ke-item{display:flex;align-items:center;gap:12px;padding:8px 4px;border-bottom:1px solid #222;cursor:pointer;border-radius:6px;}
${K} .ke-item:last-child{border-bottom:none;}
${K} .ke-item:hover{background:rgba(255,255,255,.03);}
${K} .ke-item .t{flex:1;min-width:0;font-size:14px;color:rgb(229,231,235);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
${K} .ke-item .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
${K} .ke-item .rm{display:inline-flex;padding:6px;border:none;border-radius:6px;background:transparent;color:rgb(107,114,128);cursor:pointer;}
${K} .ke-item .rm:hover{background:#2A2A2A;color:#fff;} ${K} .ke-item .rm svg{width:14px;height:14px;}
${K} .ke-empty{font-size:14px;color:rgb(107,114,128);padding:4px 0;}
${K} .ke-warn{font-size:13px;line-height:18px;color:rgb(252,165,165);}
${K} .ke-foot{margin-top:24px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
${K} .ke-foot .h{font-size:12px;color:rgb(107,114,128);}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    const KIND_COLOR = { action: 'rgb(249,115,22)', playlist: 'rgb(100,255,0)', reject: 'rgb(239,68,68)' };

    // Site shortcuts the player handles itself (see PLAYER_KEY_DEFAULTS); a binding replaces them.
    const SITE_KEY_ROWS = [
        ['Space / K', 'Play / pause', [' ', 'k']],
        ['F', 'Fullscreen', ['f']],
        ['J', 'Skip back 10 s', ['j']],
        ['A / \u2190', 'Seek back 5 s', ['a']],
        ['D / \u2192', 'Seek forward 5 s', ['d']],
        ['0\u20139', 'Jump to 0\u201390 %', ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']],
    ];
    function siteShortcut(key) {
        const row = SITE_KEY_ROWS.find(r => r[2].includes(key));
        return row ? row[1] : null;
    }
    function sameBinding(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }

    function buildKeybindingEditor(initialKey) {
        document.getElementById('pmv-keyeditor')?._pmvClose?.();
        ensureToolsSettingsStyle();
        ensureKeyEditorStyle();

        let selected = initialKey && KEYBOARD_ROWS.join('').includes(initialKey) ? initialKey : null;

        const ov = document.createElement('div');
        ov.id = 'pmv-keyeditor';
        ov.innerHTML = `
            <div class="ke-card">
                <div class="ke-head">
                    <h2>${TS_SVG.keyboard}Hotkeys</h2>
                    <button type="button" class="ke-x" data-close title="Close">${TS_SVG.x}</button>
                </div>
                <div data-pmv-tools-settings="1" data-body></div>
                <div class="ke-foot">
                    <span class="h">Esc closes • <span class="ke-kbd" style="min-width:20px;height:20px;font-size:11px;">?</span> shows all hotkeys</span>
                    <button type="button" class="ts-btn" data-close style="background:#2A2A2A;">Close</button>
                </div>
            </div>`;
        const body = ov.querySelector('[data-body]');

        const render = () => {
            body.textContent = '';

            // Keyboard
            const kbSec = document.createElement('div');
            kbSec.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
            kbSec.innerHTML = `<h3>Keyboard<span class="sub">click or press a key</span></h3>`;
            const kb = document.createElement('div');
            kb.className = 'ke-kb';
            KEYBOARD_ROWS.forEach((row, i) => {
                const rowEl = document.createElement('div');
                rowEl.className = 'ke-row';
                rowEl.style.paddingLeft = `${[0, 18, 46][i]}px`;
                for (const letter of row) {
                    const b = keybindings[letter];
                    const key = document.createElement('button');
                    key.type = 'button';
                    key.className = 'ke-key';
                    const site = siteShortcut(letter);
                    const def = DEFAULT_KEYBINDINGS[letter];
                    if (b) key.dataset.kind = bindingKind(b);
                    else if (site) key.dataset.site = '1';
                    if (b && site) key.dataset.over = '1';
                    else if (!sameBinding(b, def)) key.dataset.changed = '1';
                    if (letter === selected) key.dataset.sel = '1';
                    key.innerHTML = `<span class="k">${letter.toUpperCase()}</span><span class="a"></span>`;
                    key.querySelector('.a').textContent = b ? bindingShort(b) : (site || '');
                    key.title = [
                        b ? describeBinding(b) : (site ? `Site: ${site}` : 'Unbound'),
                        b && site ? `Replaces the site shortcut: ${site}` : '',
                        !sameBinding(b, def) ? `Default: ${def ? describeBinding(def) : 'not bound'}` : '',
                    ].filter(Boolean).join('\n');
                    key.onclick = () => { selected = letter === selected ? null : letter; render(); };
                    rowEl.appendChild(key);
                }
                kb.appendChild(rowEl);
            });
            const legend = document.createElement('div');
            legend.className = 'ke-legend';
            legend.innerHTML = `<span><i style="background:${KIND_COLOR.action};"></i>Action</span><span><i style="background:${KIND_COLOR.playlist};"></i>Playlist</span><span><i style="background:${KIND_COLOR.reject};"></i>Reject list</span>` +
                `<span><i class="sw-dash"></i>Site shortcut</span><span><i class="sw-dot"></i>Changed from default</span><span><i class="sw-bang">!</i>Replaces a site shortcut</span>`;
            kb.appendChild(legend);
            kbSec.appendChild(kb);

            // Selected key: binding picker
            if (selected) {
                const card = document.createElement('div');
                card.className = 'ts-card';
                const cur = keybindings[selected];
                card.innerHTML = `
                    <div>
                        <label class="ts-lab"><span class="ke-kbd">${selected.toUpperCase()}</span>${cur ? 'Bound to' : 'Not bound'}</label>
                        <p class="ts-desc"></p>
                    </div>`;
                card.querySelector('.ts-desc').textContent = cur ? describeBinding(cur) : 'Pick an action or one of your playlists for this key.';
                const def = DEFAULT_KEYBINDINGS[selected];
                const site = siteShortcut(selected);
                const meta = document.createElement('div');
                meta.className = 'ke-meta';
                meta.innerHTML = `<span>Default: <b></b></span>${site ? '<span>Site shortcut: <b></b></span>' : ''}`;
                meta.querySelectorAll('b')[0].textContent = def ? describeBinding(def) : 'not bound';
                if (site) meta.querySelectorAll('b')[1].textContent = site;
                card.appendChild(meta);
                if (cur && site) {
                    const n = document.createElement('div');
                    n.className = 'ke-note';
                    n.textContent = `This binding replaces the site shortcut (${site}). Unbind the key to get it back.`;
                    card.appendChild(n);
                }
                if (!sameBinding(cur, def)) {
                    const restore = document.createElement('button');
                    restore.type = 'button';
                    restore.className = 'ts-btn';
                    restore.style.alignSelf = 'flex-start';
                    restore.textContent = def ? 'Restore default' : 'Unbind (default)';
                    restore.onclick = () => {
                        if (def) keybindings[selected] = JSON.parse(JSON.stringify(def));
                        else delete keybindings[selected];
                        saveKeybindings();
                        render();
                    };
                    card.appendChild(restore);
                }
                const value = () => {
                    const b = keybindings[selected];
                    if (!b) return '';
                    return b.action === 'playlist' ? 'playlist:' + b.playlistId : b.action;
                };
                const items = () => {
                    const out = [{ value: '', label: 'None', desc: 'Key does nothing (the site’s own shortcut, if any, still works)' }];
                    out.push({ header: true, label: 'Actions' });
                    Object.entries(BUILTIN_ACTIONS).forEach(([k, a]) => {
                        const short = a.label.split(/\s[(:]|:\s/)[0];
                        out.push({ value: 'builtin:' + k, label: short, desc: short !== a.label ? a.label : '' });
                    });
                    out.push({ header: true, label: 'Playlists' });
                    [...State.playlists.values()]
                        .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
                        .forEach(p => out.push({
                            value: 'playlist:' + p.id,
                            label: getPlaylistDisplayName(p.name, p.id) || p.id,
                            desc: isRejectList(p.id) ? 'Reject list — removed from every other playlist, skips to the next video' : `${p.ids.size} videos • press again within 3s to remove`,
                        }));
                    return out;
                };
                const sel = mkToolsSelect(items, value, v => {
                    if (!v) delete keybindings[selected];
                    else if (v.startsWith('playlist:')) keybindings[selected] = { action: 'playlist', playlistId: v.slice(9) };
                    else keybindings[selected] = { action: v };
                    saveKeybindings();
                    render();
                });
                card.appendChild(sel.el);
                if (bindingKind(cur) === 'reject') {
                    const w = document.createElement('div');
                    w.className = 'ke-warn';
                    w.textContent = 'This key adds the video to your reject list, removes it from every other playlist and skips to the next video.';
                    card.appendChild(w);
                }
                kbSec.appendChild(card);
            }
            body.appendChild(kbSec);

            // Bound keys
            const listSec = document.createElement('div');
            listSec.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
            const bound = Object.keys(keybindings).filter(k => keybindings[k]).sort();
            listSec.innerHTML = `<h3>Bound keys<span class="sub">${bound.length}</span></h3>`;
            const list = document.createElement('div');
            list.className = 'ke-list';
            if (!bound.length) list.innerHTML = '<div class="ke-empty">No keys bound yet.</div>';
            bound.forEach(k => {
                const b = keybindings[k];
                const row = document.createElement('div');
                row.className = 'ke-item';
                row.innerHTML = `<span class="ke-kbd">${escHtml(k.toUpperCase())}</span><span class="dot" style="background:${KIND_COLOR[bindingKind(b)] || '#555'};"></span><span class="t"></span><button type="button" class="rm" title="Unbind">${TS_SVG.x}</button>`;
                row.querySelector('.t').textContent = describeBinding(b) || '';
                row.querySelector('.t').title = describeBinding(b) || '';
                row.onclick = () => { if (KEYBOARD_ROWS.join('').includes(k)) { selected = k; render(); ov.querySelector('.ke-card').scrollTo({ top: 0, behavior: 'smooth' }); } };
                row.querySelector('.rm').onclick = e => { e.stopPropagation(); delete keybindings[k]; saveKeybindings(); if (selected === k) selected = null; render(); };
                list.appendChild(row);
            });
            listSec.appendChild(list);
            body.appendChild(listSec);

            // Defaults: what the script and the site do out of the box.
            const defSec = document.createElement('div');
            defSec.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
            defSec.innerHTML = `<h3>Default shortcuts<span class="sub">for reference</span></h3>`;
            const grid = document.createElement('div');
            grid.className = 'ke-defs';
            const col = (title, rows) => {
                const c = document.createElement('div');
                c.innerHTML = `<h4>${title}</h4>`;
                rows.forEach(([keyLabel, text, status, cls]) => {
                    const r = document.createElement('div');
                    r.className = 'ke-def';
                    r.innerHTML = `<span class="ke-kbd"></span><span class="t"></span>${status ? `<span class="st ${cls || ''}"></span>` : ''}`;
                    r.querySelector('.ke-kbd').textContent = keyLabel;
                    r.querySelector('.t').textContent = text;
                    if (status) r.querySelector('.st').textContent = status;
                    c.appendChild(r);
                });
                return c;
            };
            grid.appendChild(col('PMVH Extended', Object.entries(DEFAULT_KEYBINDINGS).map(([k, b]) => [
                k.toUpperCase(), bindingShort(b),
                sameBinding(keybindings[k], b) ? '' : (keybindings[k] ? 'remapped' : 'unbound'),
            ])));
            grid.appendChild(col('PMVHaven player', SITE_KEY_ROWS.map(([label, text, keys]) => [
                label, text, keys.some(k => keybindings[k]) ? 'replaced' : '', 'over',
            ])));
            defSec.appendChild(grid);
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'ts-btn';
            reset.style.alignSelf = 'flex-start';
            reset.textContent = 'Reset all hotkeys to defaults';
            let armed = false;
            reset.onclick = () => {
                if (!armed) {
                    armed = true;
                    reset.textContent = 'Click again to reset \u2014 your own bindings are removed';
                    setTimeout(() => { armed = false; if (reset.isConnected) reset.textContent = 'Reset all hotkeys to defaults'; }, 3000);
                    return;
                }
                keybindings = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
                saveKeybindings();
                selected = null;
                render();
            };
            defSec.appendChild(reset);
            body.appendChild(defSec);
        };

        const onKey = e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;
            if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
            const k = (e.key || '').toLowerCase();
            if (k.length === 1 && KEYBOARD_ROWS.join('').includes(k)) {
                // Selects the key instead of running its hotkey.
                e.preventDefault(); e.stopPropagation();
                selected = k; render();
            }
        };
        const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
        ov._pmvClose = close;
        ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
        document.addEventListener('keydown', onKey, true);
        render();
        (getFullscreenRoot() || document.body).appendChild(ov);
    }

    // ---------------------------------------------------------------------
    // Command palette (Ctrl/Cmd+K)
    // ---------------------------------------------------------------------
    // Searches every cached video and playlist. Navigates with location.href rather than a SPA transition.
    function buildCommandPaletteResults(query) {
        const q = query.trim().toLowerCase();
        const results = [];

        if (!q || 'up next queue'.includes(q) || q.includes('queue') || q.includes('next')) {
            results.push({ type: 'action', label: 'Open Up next', sub: '', action: () => openQueueSettings() });
        }
        if (!q || 'settings'.includes(q) || q.includes('setting')) {
            results.push({ type: 'action', label: 'Open settings', sub: '', action: () => openToolsSettings() });
        }

        State.playlists.forEach((p, id) => {
            const name = getPlaylistDisplayName(p.name) || id;
            if (!q || name.toLowerCase().includes(q)) {
                results.push({ type: 'playlist', id, label: name, sub: `${p.ids.size} videos`, href: `/playlists/${id}` });
            }
        });

        if (q) { // videos only once a query is typed (titleIndex can be large)
            let count = 0;
            for (const [title, id] of State.titleIndex) {
                if (count >= 40) break;
                if (!title.includes(q)) continue;
                const meta = State.videoMeta.get(id);
                results.push({
                    type: 'video', id,
                    label: meta?.title || title,
                    sub: [meta?.uploaderDisplay, meta?.bayesianRating ? Math.round(meta.bayesianRating) + '%' : null].filter(Boolean).join(' · '),
                    href: `/video/${id}`,
                });
                count++;
            }
        }

        return results.slice(0, 30);
    }

    function toggleCommandPalette() {
        const existing = document.getElementById('pmv-cmdk');
        if (existing) { existing.remove(); return; }

        const box = document.createElement('div');
        box.id = 'pmv-cmdk';
        box.style.cssText = `
            position: fixed; top: 18%; left: 50%; transform: translateX(-50%);
            background: rgba(20,20,20,0.98); border: 1px solid rgba(255,255,255,0.15);
            border-radius: 10px; z-index: 9999999; width: 480px; max-width: 90vw;
            box-shadow: 0 8px 32px rgba(0,0,0,0.7); font-family:inherit;font-variant-numeric:tabular-nums;
            backdrop-filter: blur(10px);
        `;
        box.innerHTML = `
            <input id="pmv-cmdk-input" type="text" placeholder="Search videos and playlists..." spellcheck="false"
                style="width:100%;box-sizing:border-box;padding:12px 14px;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.1);color:white;font-size:14px;font-family:inherit;outline:none;">
            <div id="pmv-cmdk-results" style="max-height:360px;overflow-y:auto;"></div>
        `;
        document.body.appendChild(box);

        const input = box.querySelector('#pmv-cmdk-input');
        const resultsEl = box.querySelector('#pmv-cmdk-results');
        let selectedIdx = 0;
        let current = [];

        const render = () => {
            current = buildCommandPaletteResults(input.value);
            selectedIdx = 0;
            resultsEl.innerHTML = current.length
                ? current.map((r, i) => `
                    <div data-i="${i}" style="padding:8px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:10px;${i === selectedIdx ? 'background:rgba(99,102,241,0.15);' : ''}">
                        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${r.type === 'playlist' ? 'rgb(165,180,252)' : 'rgba(255,255,255,0.85)'};">${r.type === 'playlist' ? '▶ ' : ''}${r.label}</span>
                        <span style="color:rgba(255,255,255,0.3);font-size:10px;white-space:nowrap;flex-shrink:0;">${r.sub || ''}</span>
                    </div>`).join('')
                : `<div style="padding:14px;color:rgba(255,255,255,0.3);font-size:12px;">${input.value.trim() ? 'No results' : 'Type to search videos, or browse playlists below'}</div>`;
        };
        const highlight = () => {
            [...resultsEl.children].forEach((el, i) => {
                el.style.background = i === selectedIdx ? 'rgba(99,102,241,0.15)' : '';
            });
            resultsEl.children[selectedIdx]?.scrollIntoView({ block: 'nearest' });
        };
        const activate = i => {
            const r = current[i];
            if (!r) return;
            if (r.action) { box.remove(); r.action(); }
            else location.href = r.href;
        };

        render();
        input.focus();

        input.addEventListener('input', render);
        input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, current.length - 1); highlight(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); highlight(); }
            else if (e.key === 'Enter') { e.preventDefault(); activate(selectedIdx); }
            else if (e.key === 'Escape') { box.remove(); }
        });
        resultsEl.addEventListener('click', e => {
            const row = e.target.closest('[data-i]');
            if (row) activate(parseInt(row.dataset.i, 10));
        });

        setTimeout(() => document.addEventListener('click', function close(e) {
            if (!box.contains(e.target)) { box.remove(); document.removeEventListener('click', close); }
        }), 0);
    }

    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            toggleCommandPalette();
        }
    });

    // ---------------------------------------------------------------------
    // Up next queue
    // ---------------------------------------------------------------------
    // Ranked, playable list built from constraints (count/rating/duration/seen/tag) and weighted by a
    // tag-affinity score from the user's playlists. Candidates come from State.videoMeta.
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

    // Queue state: one ordered, drag-reorderable list. manuallyAddedIds distinguishes user adds from
    // suggestions; order is independent of that.
    let smartQueueItems = []; // [{id, meta}], order = play order
    let manuallyAddedIds = new Set();
    // True once the queue has been used; gates auto-top-up. Reset by "clear".
    let smartQueueActive = false;
    // Index of the playing item: earlier entries are history, later ones upcoming. -1 = none from the queue.
    let queueCursor = -1;
    // History is capped.
    // Played items kept in Up next; one is shown, "Show more" reveals older ones in steps.
    const QUEUE_HISTORY_MAX = 50;
    const QUEUE_HISTORY_SHOWN = 1;
    const QUEUE_HISTORY_STEP = 10;
    let queueHistoryShown = QUEUE_HISTORY_SHOWN;
    // Id of a playing row the user removed, so syncQueueCursor() does not re-add it until they move on.
    let dismissedCurrentId = null;
    let queueSettingsOpen = false;
    let queueCollapsed = false;

    // The queue survives navigation (full page loads) via sessionStorage, which keeps it per tab
    // and out of the settings export.
    const QUEUE_STATE_KEY = 'pmv_queue_v1';
    // Every save also writes a dated copy to localStorage, which a tab starting empty adopts
    // (sessionStorage does not survive a browser restart).
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

    // Adopt a backup only when the tab has no queue and the copy is recent and non-empty.
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
            // Write the adopted queue to this tab's own store.
            if (!sessionStorage.getItem(QUEUE_STATE_KEY)) saveQueueState();
        } catch { /* corrupt entry — start empty rather than break boot */ }
    }
    loadQueueState();

    // Queue settings are a preference, so they live in localStorage (included in settings export).
    const QUEUE_SETTINGS_KEY = 'pmv_queue_settings_v1';
    const QUEUE_SETTINGS_DEFAULTS = { count: 20, minRating: 0, maxDuration: 0, unseenOnly: false, tagFilter: '', autoRefill: true, targetSize: 5, useNfFilter: true };
    function loadQueueSettings() {
        try { return { ...QUEUE_SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem(QUEUE_SETTINGS_KEY) || '{}') }; }
        catch { return { ...QUEUE_SETTINGS_DEFAULTS }; }
    }
    let queueSettings = loadQueueSettings();
    function saveQueueSettings() {
        try { localStorage.setItem(QUEUE_SETTINGS_KEY, JSON.stringify(queueSettings)); } catch { /* quota/private mode */ }
    }

    // Best-effort title/thumbnail/rating/duration read from a card's DOM when State.videoMeta has nothing.
    // Uses a TreeWalker over text nodes: card.textContent runs fields together ("Aug 10, 2024" + "84%"),
    // and childless-element scans skip spans that also hold an icon.
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
        // Grids use an <h4>; the Recommended sidebar does not, so the image alt text is used there.
        // Longest remaining text is the last resort.
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

    // Tag chips have title "Search for: #Tag", more reliable than their text. Only visible tags are readable;
    // the rest sit behind a "+N" button. Do not click it open: the DOM change re-triggers the observer
    // and loops.
    function scrapeCardTags(card) {
        const out = new Set();
        // The "#" matters: the track chip uses the same title pattern ("Search for: <artist> - <song>").
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
        // Some cards show an aspect pill ("9:16") next to the duration; it looks like a time.
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

    // Merges the cache with a DOM scrape per field (cache wins, scrape fills gaps). Returns only the
    // five fields a row renders, since queue items are stored in sessionStorage.
    // The playing video is often only in State.currentVideoData, so it is checked too.
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

    // Carry the card's own href: the hex in a page URL is the slug id, not the API _id.
    //
    // Swaps the video in place via the Vue Router (instance on #__nuxt, router.push) like a NuxtLink
    // click; falls back to a normal load if the router is unreachable. onUrlChange handles the
    // client-side navigation and shared state survives.
    //
    // A route change detaches the <video> without pausing it, and detached media keeps decoding.
    // The player may also restart it while still attached, so references are held and pressed down
    // across the whole transition. Elements are muted and have their source removed only once
    // detached, never while still on the page. This also covers the site's own navigation, so every
    // media element seen is remembered and torn down once it leaves the page.
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
            // Event-driven: the player can restart an element after any fixed window, so tear down any
            // element that starts playing while off the page.
            el.addEventListener('play', () => { if (!el.isConnected) killDetachedMedia(el); });
        });
    }

    // graceMs applies to sweeps outside a navigation: the site moves its player between containers
    // (theater, fullscreen), so a detached element is not necessarily discarded. 0 during navigation.
    function sweepDetachedMedia(graceMs = 0) {
        const now = Date.now();
        seenMediaEls.forEach(el => {
            if (el.isConnected) { mediaDetachedAt.delete(el); return; }
            // Already torn down; dropped to bound the set. Its play listener still covers a restart.
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

    // Detaching happens somewhere inside the transition, so sweep across the whole handover.
    // Elements are not dropped after one teardown (the player may restart them); pruned at the end.
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


    // ---------------------------------------------------------------------
    // Fullscreen hand-over
    // ---------------------------------------------------------------------
    // A route change replaces the player and ends fullscreen, which cannot be re-requested later.
    // While fullscreen, the next video is instead loaded into the same <video> (as site playlists do),
    // and the page itself catches up when fullscreen ends.
    let staleFullscreenHref = null;

    async function videoStreamUrl(videoId) {
        // Deduped: the following page-data lookup (onUrlChange, ensureCurrentVideoData) is answered from this.
        try {
            const video = await fetchVideoDeduped(videoId);
            if (!video) return null;
            // Same choice as the player: HLS playlist if available, plain file otherwise.
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
        // Fullscreen may have ended during the lookup; an ordinary navigation is better then.
        if (!url || !document.fullscreenElement) return false;

        // Detach first: attaching a new hls.js source over buffered data causes bufferAppendError.
        try {
            hls.stopLoad();
            hls.detachMedia();
            hls.loadSource(url);
            hls.attachMedia(video);
        } catch { return false; }
        try { video.play()?.catch(() => {}); } catch {}

        // Keep the address bar in step, since the rest of the script reads the video id from it.
        try { history.replaceState(history.state, '', href); } catch {}
        staleFullscreenHref = href;
        const hudWasOpen = !!State.hud;
        inPlaceHandover = true;
        try { onUrlChange(); } catch {} finally { inPlaceHandover = false; }
        // onUrlChange closes the panel; restore it once the new video's data has arrived.
        refreshHudAfterHandover(videoId, hudWasOpen);
        return true;
    }

    // The fetch is fired by the core and nothing re-renders the panel when it lands, so rebuild once
    // the data is there, or give up after a few seconds.
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

    // Restore playback position after the page catches up; retried because a seek needs a ready player.
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
        if (document.fullscreenElement || !staleFullscreenHref) return;
        const href = staleFullscreenHref;
        staleFullscreenHref = null;
        const at = (() => { try { return getVideo()?.currentTime || 0; } catch { return 0; } })();
        if (!navigateInPage(href)) { location.href = href; return; }
        resumePlaybackAt(at);
        // The address bar already points here, so onUrlChange has nothing to react to; run the
        // after-navigation work (badges, Up next panel) explicitly.
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

    function goToVideo(href, id) {
        const target = cleanVideoHref(href) || `/video/${id}`;
        if (document.fullscreenElement && id) {
            playInPlace(target, id).then(handled => {
                if (handled) return;
                if (!navigateInPage(target)) location.href = target;
            });
            return;
        }
        if (!navigateInPage(target)) location.href = target;
    }

    function cardHref(card) {
        if (!card) return null;
        const href = card.tagName === 'A'
            ? card.getAttribute('href')
            : card.querySelector('a[href*="/video/"]')?.getAttribute('href');
        return href && href.includes('/video/') ? cleanVideoHref(href) : null;
    }

    // Recovers a slug URL from the slug to API id map for items without a card; null falls back to the bare id.
    function knownHrefForId(apiId) {
        for (const [slugId, mapped] of State.slugToApiId) {
            if (mapped === apiId) return `/video/${slugId}`;
        }
        return null;
    }

    // Keeps `queueCursor` on the playing item. A video reached outside the queue is inserted right
    // after the current one while the queue is active, so earlier items move into the history.
    function syncQueueCursor() {
        if (!location.pathname.startsWith('/video/')) return;
        const id = getCurrentVideoId();
        if (!id) return;

        if (dismissedCurrentId && dismissedCurrentId !== id) dismissedCurrentId = null;

        const idx = smartQueueItems.findIndex(it => it.id === id);
        if (idx !== -1) { queueCursor = idx; }
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

    // Items still waiting after the playing one, or null when the playing video is not the queue's current item.
    function queueRemaining() {
        syncQueueCursor();
        if (queueCursor < 0 || !smartQueueItems.length) return null;
        if (smartQueueItems[queueCursor]?.id !== getCurrentVideoId()) return null;
        return upcomingCount();
    }

    function addVideoToQueue(videoId, card) {
        if (!videoId) { toast('No video'); return; }
        smartQueueActive = true;
        manuallyAddedIds.add(videoId);
        const was = smartQueueItems.findIndex(it => it.id === videoId);
        if (was !== -1 && was >= queueCursor) {
            // Already playing or waiting: do not move it, which would reshuffle the list.
            toast('Already in Up next', null, { under: upNextToastAnchor() });
            renderQueueSidebar();
            return;
        }
        if (was !== -1) {
            // Move out of the history back into line without leaving a duplicate.
            smartQueueItems.splice(was, 1);
            queueCursor--;                           // keep pointing at the same item
        }
        const href = cardHref(card) || (card ? null : location.pathname + location.search);
        // Appended at the end to preserve click order.
        smartQueueItems.push({ id: videoId, href, meta: resolveQueueMeta(videoId, card) });
        toast(`+ Added to Up next (${upcomingCount()})`, 'green', { under: upNextToastAnchor() });
        renderQueueSidebar();
    }
    // Up next messages appear right under Up next in the header (under its panel when that is open).
    function upNextToastAnchor() {
        const panel = document.getElementById('pmv-queue-floating');
        if (panel && panel.getClientRects().length) return panel;
        return [...document.querySelectorAll('[data-pmv-queue-btn]')].find(b => b.getClientRects().length) || null;
    }
    function addCurrentVideoToQueue() { addVideoToQueue(getCurrentVideoId()); }
    // A row added before its API _id was known is keyed by slug id; move it over in place once known.
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

    // The visible "Recommended" section (a mobile and a desktop h3 exist). Returns its container
    // (the h3's grandparent), or null off /video/ pages.
    function findVisibleRecommendedContainer() {
        const h3 = [...document.querySelectorAll('h3')].find(el => {
            if (el.textContent.trim() !== 'Recommended') return false;
            // No boxes: inside a display:none ancestor (the hidden layout).
            return el.getClientRects().length > 0;
        });
        return h3?.parentElement?.parentElement || null;
    }

    // The queue uses the site's own Tailwind class strings, copied from a Recommended card, to match
    // it exactly. Only use classes present in the compiled stylesheet; unused ones silently do nothing.
    const Q_CHIP = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border';
    const Q_CHIP_ON = `${Q_CHIP} bg-orange-500/10 border-orange-500/30 text-orange-300`;
    const Q_CHIP_OFF = `${Q_CHIP} bg-white/5 border-white/10 text-gray-400`;
    const Q_CHIP_ADD = `${Q_CHIP} bg-green-500/10 border-green-500/30 text-green-300`;

    // Row HTML is built from API values (titles, uploaders) and playlist names that can contain
    // markup; everything interpolated goes through this first.
    function escHtml(v) {
        return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // The user's playlists containing this video, in each playlist's color.
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

    // Re-render only when the video whose membership changed is in the queue.
    function refreshQueuePlaylistChips(videoId) {
        if (smartQueueItems.some(it => it.id === videoId)) renderQueueSidebar();
    }

    // One row: a native Recommended card plus a position column and hover-revealed reorder/remove
    // controls (the opacity-0 to group-hover:opacity-100 pattern of the card's play overlay).
    function sidebarRowHtml({ id, href, meta }, isCurrent, index, pinned, isPlayed) {
        const bits = [
            meta?.bayesianRating ? Math.round(meta.bayesianRating) + '%' : '',
            isCurrent ? 'now playing' : (isPlayed ? 'played' : (pinned ? 'added' : 'suggested')),
        ].filter(Boolean);
        const plChips = queuePlaylistChipsHtml(id);
        // With the site-wide filter on: why it would hide this video, as red chips (the row stays).
        // Playlist reasons are left out: the row's tint and playlist chips already show that.
        const reasons = filterConfig.active && filterIsMeaningful()
            ? filterReasons(id, meta, filterConfig, true).filter(r => r !== 'in playlist' && r !== 'not in playlist').slice(0, 3) : [];
        const reasonChips = reasons.map(r => `<span title="Your filter would hide this video" style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:500;background:rgba(${REJECT_RGB},0.12);border:1px solid rgba(${REJECT_RGB},0.45);color:rgb(${REJECT_RGB});white-space:nowrap;">${escHtml(r)}</span>`).join('');
        // Already saved: row tinted green (red for the reject list).
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

    // Fill in rows added with empty metadata once it becomes available.
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

        // Older played items stay folded away behind "Show more".
        // "Clear" next to it drops the played items.
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
            : '<div class="text-xs text-gray-500 p-2">Nothing queued yet.</div>';

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
        const clearPlayed = panel.querySelector('#pmv-sq-clear-played');
        if (clearPlayed) clearPlayed.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            const n = Math.max(0, queueCursor);
            if (!n) return;
            smartQueueItems.splice(0, n).forEach(it => manuallyAddedIds.delete(it.id));
            queueCursor -= n;
            queueHistoryShown = QUEUE_HISTORY_SHOWN;
            rerender();
        };
        panel.querySelector('#pmv-sq-clear').onclick = () => {
            smartQueueItems = [];
            manuallyAddedIds = new Set();
            smartQueueActive = false;
            queueSettingsOpen = false;
            queueCursor = -1;
            dismissedCurrentId = null;
            rerender();
        };

        const rowsEl = panel.querySelector('#pmv-sq-rows');
        rowsEl.querySelectorAll('[data-remove-queue]').forEach(btn => {
            btn.onclick = e => { e.preventDefault(); e.stopPropagation(); removeFromQueue(btn.dataset.removeQueue); };
        });
        rowsEl.querySelectorAll('[data-queue-id]').forEach(row => {
            row.addEventListener('click', e => {
                if (e.target.closest('[data-remove-queue]')) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let modified clicks open a new tab
                // Via goToVideo, so a click from fullscreen hands over the source instead of navigating.
                if (!document.fullscreenElement && !navigateInPage(row.getAttribute('href'))) return;
                e.preventDefault();
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
        updateQueueButton();
        renderQueueFloating();

        const container = findVisibleRecommendedContainer();
        let panel = document.getElementById('pmv-queue-sidebar');

        // The panel stays up with an empty queue while settings are open, so "Generate" is reachable.
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

    // Header button that opens the queue anywhere (the inline queue needs a video page),
    // with a count badge.
    // Same "play next" outline as the Up next button on cards.
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
            'background:rgba(0,0,0,0.92);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.14);' +
            'border-radius:12px;padding:12px;color:white;box-shadow:0 10px 40px rgba(0,0,0,0.6);';
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

    // Native HTML5 drag-and-drop. dragover previews the move by moving the DOM node;
    // dragend rebuilds smartQueueItems from the final DOM order.
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
                // Rebuild smartQueueItems from the final DOM order.
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

    // ---------------------------------------------------------------------
    // Queue refill
    // ---------------------------------------------------------------------
    // Keeps an active queue topped up from the site's own Recommended sidebar for the current video,
    // scored like generateSmartQueue(). Falls back to a DOM-scraped rating when a candidate is not
    // in State.videoMeta.
    // ---------------------------------------------------------------------
    // Playlist-page filter applied to the queue
    // ---------------------------------------------------------------------
    // The playlist-page filter persists its settings, so the same rules are applied to queue
    // candidates by reading them. Unknown values never filter anything out.
    const NF_SETTINGS_KEY = 'pmvnf_filter_settings_v1';
    const NF_DEFAULT_TERMS_KEY = 'pmvnf_default_terms_v1';

    function nfParseTokens(raw) {
        const out = { textInclude: [], textExclude: [], playlistFilters: [], seenFilter: null };
        const strip = t => (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) ? t.slice(1, -1) : t;
        (raw.trim().match(/-?"[^"]*"|-?'[^']*'|\S+/g) || []).forEach(tok => {
            if (tok.startsWith('!in')) out.playlistFilters.push({ mode: 'in', name: tok.slice(3).replace(/^:/, '').toLowerCase().trim() || null });
            else if (tok.startsWith('!out')) out.playlistFilters.push({ mode: 'out', name: tok.slice(4).replace(/^:/, '').toLowerCase().trim() || null });
            else if (tok === '!seen') out.seenFilter = 'seen';
            else if (tok === '!unseen') out.seenFilter = 'unseen';
            else if (tok.startsWith('-')) out.textExclude.push(strip(tok.slice(1)).toLowerCase());
            else out.textInclude.push(strip(tok).toLowerCase());
        });
        return out;
    }

    function loadNfFilter() {
        try {
            const s = JSON.parse(localStorage.getItem(NF_SETTINGS_KEY) || 'null');
            if (!s) return null;
            const terms = localStorage.getItem(NF_DEFAULT_TERMS_KEY) || '';
            return {
                tokens: nfParseTokens(`${terms} ${s.textFilter || ''}`.trim()),
                playlistMode: s.playlistMode || 'all',
                selectedPlaylistIds: Array.isArray(s.selectedPlaylistIds) ? s.selectedPlaylistIds : [],
                savedSearch: s.savedSearch || null,
                ratingMin: typeof s.ratingMin === 'number' ? s.ratingMin : 0,
                ratingMax: typeof s.ratingMax === 'number' ? s.ratingMax : 100,
                durationMin: typeof s.durationMin === 'number' ? s.durationMin : 0,
                durationMax: typeof s.durationMax === 'number' && s.durationMax >= 0 ? s.durationMax : Infinity,
                flags: s.flags && typeof s.flags === 'object' ? { ...s.flags } : {},
            };
        } catch { return null; }
    }


    // Summarizes what the saved filter does, and how many candidates it rejected on the last refill
    // (a tight filter can leave the queue short).
    let lastFilteredOut = 0;

    function filterSummary() {
        const c = filterConfig;
        const bits = [];
        const terms = filterTerms(c.exclude).length + filterTerms(c.include).length;
        if (terms) bits.push(`${terms} term${terms === 1 ? '' : 's'}`);
        if (c.ratingMin > 0 || c.ratingMax < 100) bits.push(`${c.ratingMin}-${c.ratingMax}%`);
        if (c.maxMinutes > 0) bits.push(`max ${c.maxMinutes}m`);
        if (c.seen !== 'any') bits.push(c.seen);
        if (c.playlistMode !== 'all') bits.push(c.playlistMode === 'in' ? 'in playlist' : 'not in playlist');
        if (c.savedSearchName) bits.push(`"${c.savedSearchName}"`);
        return bits.length ? ` (${bits.join(', ')})` : ' (nothing set)';
    }

    function scoreRecommendedCandidate(id, card) {
        const meta = State.videoMeta.get(id);
        if (meta) {
            const tagScores = computeTagAffinity();
            const tagScore = (meta.tags || []).reduce((sum, t) => sum + (tagScores.get(t) || 0), 0);
            return tagScore + (meta.bayesianRating || 0) / 20;
        }
        return (scrapeCardMeta(card).bayesianRating ?? 50) / 20;
    }

    function topUpQueueFromRecommended() {
        const targetSize = queueSettings.targetSize;
        // Only items still ahead count toward the target; history does not block refilling.
        if (!smartQueueActive || !queueSettings.autoRefill || upcomingCount() >= targetSize) return;
        const container = findVisibleRecommendedContainer();
        if (!container) return;

        const existingIds = new Set(smartQueueItems.map(it => it.id));
        const useFilter = queueSettings.useNfFilter && filterIsMeaningful();
        const candidates = [];
        let rejected = 0;
        container.querySelectorAll('.w-40').forEach(thumbDiv => {
            const card = thumbDiv.parentElement;
            if (!card) return;
            const slugId = resolveRecCardVideoId(card);
            if (!slugId) return;
            const apiId = State.slugToApiId.get(slugId) || slugId;
            if (existingIds.has(apiId)) return;
            const meta = resolveQueueMeta(apiId, card);
            if (useFilter && !passesFilter(apiId, meta)) { rejected++; return; }
            candidates.push({ id: apiId, href: cardHref(card), meta, score: scoreRecommendedCandidate(apiId, card) });
        });
        lastFilteredOut = rejected;
        if (!candidates.length) { renderQueueSidebar(); return; }

        candidates.sort((a, b) => b.score - a.score);
        const need = targetSize - upcomingCount();
        smartQueueItems.push(...candidates.slice(0, need).map(({ id, href, meta }) => ({ id, href, meta })));
        renderQueueSidebar();
    }

    function generateSmartQueue({ count, minRating, maxDuration, unseenOnly, tagFilter }) {
        const tagScores = computeTagAffinity();
        const tagFilterLower = tagFilter.trim().toLowerCase();
        const candidates = [];

        State.videoMeta.forEach((meta, id) => {
            if ((meta.bayesianRating || 0) < minRating) return;
            if (maxDuration && durationToMinutes(meta.duration) > maxDuration) return;
            if (unseenOnly && PMVX.isWatched?.(id)) return;
            if (tagFilterLower && !(meta.tags || []).some(t => t.toLowerCase().includes(tagFilterLower))) return;

            const tagScore = (meta.tags || []).reduce((sum, t) => sum + (tagScores.get(t) || 0), 0);
            const score = tagScore + (meta.bayesianRating || 0) / 20;
            candidates.push({ id, meta, score });
        });

        candidates.sort((a, b) => b.score - a.score);
        return candidates.slice(0, count);
    }

    // Settings live inline in the queue panel.
    const Q_INPUT = 'background:#0F0F0F;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#fff;padding:3px 6px;font:inherit;';

    function queueSettingsHtml() {
        const s = queueSettings;
        return `
            <div id="pmv-sq-set" class="mb-2 p-2 rounded-lg text-xs text-gray-400" style="background:#0F0F0F;border:1px solid rgba(255,255,255,0.08);">
                <label class="flex items-center gap-2" style="margin-bottom:6px;">
                    <input id="sq-autorefill" type="checkbox" ${s.autoRefill ? 'checked' : ''}>
                    <span>Auto-refill from Recommended, up to</span>
                    <input id="sq-target" type="number" min="1" max="20" value="${s.targetSize}" style="${Q_INPUT}width:46px;">
                    <span>videos</span>
                </label>
                <div class="flex items-center gap-2 flex-wrap" style="margin-bottom:6px;">
                    <label class="flex items-center gap-1"><span>Count</span><input id="sq-count" type="number" min="1" max="100" value="${s.count}" style="${Q_INPUT}width:52px;"></label>
                    <label class="flex items-center gap-1"><span>Min. rating</span><input id="sq-rating" type="number" min="0" max="100" value="${s.minRating}" style="${Q_INPUT}width:46px;"><span>%</span></label>
                    <label class="flex items-center gap-1"><span>Max length</span><input id="sq-duration" type="number" min="0" placeholder="none" value="${s.maxDuration || ''}" style="${Q_INPUT}width:70px;"><span>min</span></label>
                </div>
                <label class="flex items-center gap-1" style="margin-bottom:6px;" title="Uses the filter behind the funnel button in the header">
                    <input id="sq-nffilter" type="checkbox" ${s.useNfFilter ? 'checked' : ''}>
                    <span>Apply my filter${filterSummary()}</span>
                </label>
                <div class="flex items-center gap-2 flex-wrap" style="margin-bottom:6px;">
                    <label class="flex items-center gap-1"><input id="sq-unseen" type="checkbox" ${s.unseenOnly ? 'checked' : ''}><span>Unseen only</span></label>
                    <input id="sq-tag" type="text" placeholder="tag contains..." value="${escHtml(s.tagFilter)}" style="${Q_INPUT}flex:1;min-width:90px;">
                </div>
                <div class="flex items-center gap-2">
                    <button id="sq-generate" type="button" class="${Q_CHIP_ON}" style="cursor:pointer;">Fill from your playlists</button>
                    <span id="sq-status" class="text-gray-500"></span>
                </div>
            </div>`;
    }

    function wireQueueSettings(panel) {
        const q = sel => panel.querySelector(sel);
        // Controls write straight through to the persisted settings.
        const bind = (sel, key, read) => {
            const el = q(sel);
            if (el) el.onchange = () => { queueSettings[key] = read(el); saveQueueSettings(); renderQueueSidebar(); };
        };
        bind('#sq-autorefill', 'autoRefill', el => el.checked);
        bind('#sq-target', 'targetSize', el => Math.max(1, parseInt(el.value, 10) || 5));
        bind('#sq-count', 'count', el => parseInt(el.value, 10) || 20);
        bind('#sq-rating', 'minRating', el => parseInt(el.value, 10) || 0);
        bind('#sq-duration', 'maxDuration', el => parseInt(el.value, 10) || 0);
        bind('#sq-unseen', 'unseenOnly', el => el.checked);
        bind('#sq-nffilter', 'useNfFilter', el => el.checked);
        q('#sq-tag').onchange = () => { queueSettings.tagFilter = q('#sq-tag').value; saveQueueSettings(); };

        q('#sq-generate').onclick = () => {
            queueSettings.tagFilter = q('#sq-tag').value;
            saveQueueSettings();
            // Keeps manually added items and replaces only the suggested portion.
            const generated = generateSmartQueue(queueSettings)
                .filter(c => !manuallyAddedIds.has(c.id))
                .map(c => ({ id: c.id, href: knownHrefForId(c.id), meta: resolveQueueMeta(c.id) }));
            const added = [...manuallyAddedIds].map(id => {
                const existing = smartQueueItems.find(it => it.id === id);
                return { id, href: existing?.href || knownHrefForId(id), meta: resolveQueueMeta(id) };
            });
            smartQueueItems = [...added, ...generated];
            smartQueueActive = true;

            if (smartQueueItems.length) {
                renderQueueSidebar();
            } else {
                const st = q('#sq-status');
                st.textContent = State.videoMeta.size === 0
                    ? 'Nothing cached yet \u2014 browse around or refresh playlists.'
                    : 'Nothing matched these filters.';
            }
        };
    }

    // Opens the queue panel's settings; needs the Recommended sidebar to anchor to, so it says so otherwise.
    function openQueueSettings() {
        if (!findVisibleRecommendedContainer()) {
            toast('Up next appears on a video page, next to "Recommended"');
            return;
        }
        queueSettingsOpen = true;
        queueCollapsed = false;
        renderQueueSidebar();
        document.getElementById('pmv-sq-set')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function getCurrentVideoId() {
        // Playlist pages: the active queue row (border-orange-500) is the playing video. It wins over
        // currentVideoData, which lags a step when the queue advances, and over the player's poster,
        // whose hex is a thumbnail asset id; either would leave the playlist pills on the wrong video.
        if (location.pathname.startsWith('/playlists/')) {
            const active = getActiveQueueVideoId();
            if (active) return active;
        }
        if (State.currentVideoData?.id) return State.currentVideoData.id;

        // On /video/ pages the URL hex is the one reliable id before any API response: a mapped slug id
        // or the API _id. This must come before the poster fallback: a poster URL hex is a thumbnail
        // asset id, not a video _id, and binding to it breaks the playlist buttons until unrelated
        // data arrives.
        const pageId = location.pathname.match(/^\/video\/(?:[^?#]*_)?([0-9a-f]{24})(?:[?#]|$)/i)?.[1];
        if (pageId) return State.slugToApiId.get(pageId) || pageId;

        const v = getVideo();
        if (v?.poster) {
            const m = v.poster.match(/\/([a-f0-9]{24})/);
            if (m) return m[1];
        }

        const link = document.querySelector('a[href*="/videos/"][aria-current="page"], a[href*="/videos/"].active');
        if (link) {
            const m = link.href.match(/\/videos\/([a-f0-9]{24})/);
            if (m) return m[1];
        }

        return getJsonLdVideoId();
    }

    // Ensures State.currentVideoData (rating, tags, performers, description, uploadDate) is populated.
    // Vue often hydrates from the SSR payload without a client fetch, so one is made here and flows
    // through the interceptor. Goes through fetchVideoDeduped (shared, cached, failures parked);
    // adopted only if it is still the video on screen when the answer lands.
    function ensureCurrentVideoData(videoId) {
        if (!videoId || State.currentVideoData?.id === videoId) return;
        if (lookupOnCooldown(videoId)) return;
        fetchVideoDeduped(videoId).then(v => {
            if (!v?._id || State.currentVideoData?.id === v._id) return;
            if (videoId !== v._id) State.slugToApiId.set(videoId, v._id);
            const cur = getCurrentVideoId();
            if (cur !== videoId && cur !== v._id) return;
            adoptCurrentVideo(v);
        }).catch(() => noteLookupFailure(videoId));
    }

    // Links use the video's `oldId` when present, else `_id`. Every API response and __NUXT_DATA__
    // carries those objects, so slug to _id mappings are learned without per-card lookups.
    // Returns the number of new mappings.
    const HEX24_RE = /^[0-9a-f]{24}$/i;
    function learnVideoId(id, oldId) {
        if (typeof id !== 'string' || !HEX24_RE.test(id)) return 0;
        if (typeof oldId === 'string' && HEX24_RE.test(oldId) && oldId !== id) {
            if (State.slugToApiId.get(oldId) === id) return 0;
            State.slugToApiId.set(oldId, id);
            return 1;
        }
        if (State.slugToApiId.has(id)) return 0;
        State.slugToApiId.set(id, id);
        return 1;
    }

    function learnVideoIds(root) {
        let added = 0, guard = 0;
        const stack = [root];
        while (stack.length && guard++ < 300000) {
            const o = stack.pop();
            if (!o || typeof o !== 'object') continue;
            if (Array.isArray(o)) {
                for (const x of o) if (x && typeof x === 'object') stack.push(x);
                continue;
            }
            // Only video-shaped objects: an _id plus a title and a video-only field.
            if (typeof o._id === 'string' && typeof o.title === 'string'
                && ('duration' in o || 'previewUrl' in o || 'oldId' in o)) {
                added += learnVideoId(o._id, o.oldId);
            }
            for (const k in o) {
                const v = o[k];
                if (v && typeof v === 'object') stack.push(v);
            }
        }
        return added;
    }

    // Nuxt's payload is devalue's flat array: objects hold indices into it.
    function learnVideoIdsFromNuxtPayload() {
        const el = document.getElementById('__NUXT_DATA__');
        if (!el || el.dataset.pmvLearned) return 0;
        el.dataset.pmvLearned = '1';
        let arr;
        try { arr = JSON.parse(el.textContent); } catch { return 0; }
        if (!Array.isArray(arr)) return 0;
        const val = ref => (typeof ref === 'number' ? arr[ref] : ref);
        // Resolves a field: indices into the array, arrays of indices, devalue's Reactive/Ref wrappers.
        const res = (ref, depth = 0) => {
            if (typeof ref !== 'number' || ref < 0 || depth > 4) return typeof ref === 'number' ? undefined : ref;
            const x = arr[ref];
            if (Array.isArray(x)) {
                if (typeof x[0] === 'string' && /^(Reactive|ShallowReactive|Ref|ShallowRef)$/.test(x[0])) return res(x[1], depth + 1);
                return x.map(r => res(r, depth + 1));
            }
            return x;
        };
        const FIELDS = ['_id', 'title', 'duration', 'tags', 'top5Tags', 'starsTags', 'bayesianRating', 'width', 'height',
            'uploaderUsername', 'uploader', 'thumbnailUrl', 'previewUrl', 'uploadDate', 'views', 'description',
            ...CONTENT_FLAGS.map(([k]) => k)];
        let added = 0;
        const videos = [];
        for (const o of arr) {
            if (!o || typeof o !== 'object' || Array.isArray(o) || !('_id' in o) || !('title' in o)) continue;
            if (!('duration' in o || 'previewUrl' in o || 'oldId' in o)) continue;
            added += learnVideoId(val(o._id), val(o.oldId));
            // Server-rendered lists (the homepage's first page) never pass the fetch interceptor:
            // their metadata (all tags, content flags) is read from here.
            if (!('tags' in o || 'top5Tags' in o)) continue;
            const v = {};
            FIELDS.forEach(k => { if (k in o) v[k] = res(o[k]); });
            if (typeof v._id === 'string' && typeof v.title === 'string') videos.push(v);
        }
        if (videos.length) { try { indexVideoDetails(videos); } catch {} }
        return added;
    }

    function getMatches(videoId) {
        if (!videoId) return [];
        const ids = State.reverse.get(videoId);
        if (!ids) return [];
        return [...ids].map(id => State.playlists.get(id)).filter(Boolean);
    }

    function getMeta() {
        // While fullscreen runs ahead of the page (hand-over), page-derived fields still belong to the
        // previous video, so the page is not read; the fetched data is correct.
        const pageIsBehind = !!staleFullscreenHref;

        const liveTitle = pageIsBehind ? null :
            document.querySelector('.min-w-0 h1')?.textContent?.trim() ||
            document.querySelector('h1')?.textContent?.trim();

        // Creator: orange gradient h3, text nodes only (skips the "Creator" badge child).
        let liveCreator = null;
        const uploaderH3 = pageIsBehind ? null : document.querySelector('h3.bg-gradient-to-r.from-orange-400');
        if (uploaderH3) {
            const text = [...uploaderH3.childNodes]
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent).join('').trim();
            if (text) liveCreator = text;
        }
        // Fallback: "More from X (N)"; only h3 elements with a class.
        if (!liveCreator && !pageIsBehind) {
            const h3s = document.querySelectorAll('h3[class]');
            for (const h of h3s) {
                const t = h.textContent.trim();
                if (t.startsWith('More from ')) {
                    liveCreator = t.replace(/^More from /, '').replace(/\s*\(\d+\)$/, '').trim() || null;
                    break;
                }
            }
        }

        // Tags: <a href="/search?tags=...">
        const domTags = pageIsBehind ? [] : [...document.querySelectorAll('a[href^="/search?tags="]')]
            .slice(0, 15)
            .map(a => (a.getAttribute('title')?.replace(/^Search for '|'$/g, '') ||
                       a.textContent.replace(/^#/, '')).trim())
            .filter(Boolean);

        // Performers: <a href="/search?stars=...">, falling back to /model/ links. /model/ titles use
        // "View <name>'s profile", so the visible text (span.truncate or textContent) is used as the name.
        const domStars = pageIsBehind ? [] : [...document.querySelectorAll('a[href^="/search?stars="], a[href^="/model/"]')]
            .slice(0, 10)
            .map(a => (a.querySelector('.truncate')?.textContent || a.textContent || '').replace(/^#/, '').trim())
            .filter(Boolean);

        // Description block on /videos/ detail pages.
        let liveDescription = null;
        const descBlock = pageIsBehind ? null : document.querySelector('div.bg-\\[\\#1A1A1A\\] p.whitespace-pre-wrap, div.bg-\\[\\#1A1A1A\\] p.text-gray-300');
        if (descBlock) liveDescription = descBlock.textContent.trim() || null;

        // JSON-LD fallback for creator and description.
        let ldCreator = null, ldDescription = null;
        try {
            const jsonLd = pageIsBehind ? null : document.querySelector('script[type="application/ld+json"]');
            if (jsonLd) {
                const data = JSON.parse(jsonLd.textContent);
                if (data['@type'] === 'VideoObject') {
                    ldCreator = data.creator?.name || null;
                    ldDescription = data.description || null;
                }
            }
        } catch {}

        return {
            title: liveTitle || State.currentVideoData?.title || document.querySelector('meta[property="og:title"]')?.content || 'Unknown',
            creator: liveCreator || State.currentVideoData?.creator || ldCreator || 'Unknown',
            tags: domTags.length ? domTags : (State.currentVideoData?.tags || []).slice(0, 15),
            starsTags: domStars.length ? domStars : (State.currentVideoData?.starsTags || []).slice(0, 10),
            description: liveDescription || ldDescription || State.currentVideoData?.description || null,
        };
    }

    // ---------------------------------------------------------------------
    // Video helpers
    // ---------------------------------------------------------------------

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
        // Cached element, if still in the DOM.
        if (State.video?.isConnected) return State.video;

        // Excludes the hover-preview <video> (notifications list): it is not the player and must stay muted.
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

            // Seekbar preview: start buffering the low rendition shortly after each new source plays (see scrubWarm).
            const warmSoon = () => {
                clearTimeout(Scrub.warmTimer);
                Scrub.warmTimer = setTimeout(scrubWarm, SCRUB_WARM_DELAY);
            };
            v.addEventListener('playing', warmSoon);
            // Also handle a source that was already playing before this listener was attached.
            if (!v.paused && v.readyState >= 2) warmSoon();

            v.addEventListener('loadedmetadata', () => {
                if (State.forceVolume100) {
                    setTimeout(() => forceVolume100({ silent: true }), 80);
                    setTimeout(() => forceVolume100({ silent: true }), 600);
                }
                // Fires on every src swap (playlist auto-advance) regardless of Vue's DOM details;
                // Vue's currentVideoIndex watch has already run by then.
                try { maybeShowNextVideoNotification(); } catch {}
            });

            v.addEventListener('play', () => {
                if (State.forceVolume100) setTimeout(() => forceVolume100({ silent: true }), 80);
            });

            // Invalidate the cache when the src changes.
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

    // ---------------------------------------------------------------------
    // Playlist mutation
    // ---------------------------------------------------------------------

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
        // Filters keep this video visible until they are applied again (see PMVX.markActed).
        PMVX.markActed(videoId);

        // The reject list is exclusive: a video on it is on no other playlist, and saving it to any
        // other playlist removes it from the reject list. Handled here so every surface (HUD row,
        // page buttons, context menu, hotkey) behaves the same.
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
        // Same for removal while filtering on "in list".
        PMVX.markActed(videoId);
        return true;
    }

    // ---------------------------------------------------------------------
    // Light cleanup
    // ---------------------------------------------------------------------

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

    // IntersectionObserver lazily unloads far-offscreen thumbnails.
    // Observation stays active after stripping: a display:none row is never intersecting, so
    // unobserving would leave it blank. The src is restored from dataset.pmvOrigSrc on intersect.
    const _farOffscreenIO = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const img = entry.target;
            if (entry.isIntersecting) {
                // img.src reads back as the document URL after being cleared, so the pmvUnloaded marker is required.
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

        // Reset processed markers so badges are re-placed after the cleanup.
        document.querySelectorAll('[data-pmv-checked]').forEach(el => delete el.dataset.pmvChecked);
        document.querySelectorAll('[data-pmv-queue-checked]').forEach(el => delete el.dataset.pmvQueueChecked);
        document.querySelectorAll('[data-pmv-rec-checked]').forEach(el => delete el.dataset.pmvRecChecked);

        // Force re-placement of page playlist buttons.
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

    // ---------------------------------------------------------------------
    // UI: toast / HUD / thumbnails
    // ---------------------------------------------------------------------

    // color: 'green' | 'red' | null (neutral)
    // `under`: an element the toast sits directly below (right-aligned), instead of the bottom corner.
    function toast(msg, color, { under = null } = {}) {
        document.getElementById('pmv-toast')?.remove();
        // Fixed system messages default to green.
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

    // Formats seconds like the page's own frame labels ("0:11").
    function formatThumbTime(seconds) {
        if (!Number.isFinite(seconds)) return '';
        const total = Math.round(seconds);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    // The src of an <img> as the site set it, also after unloadFarOffscreenImages() emptied it
    // (an emptied src reads back as the page URL). Needed for the site's timeline strip, which is
    // always off-screen in fullscreen and therefore emptied.
    function pageImgSrc(img) {
        if (!img) return '';
        if (img.dataset.pmvUnloaded === '1') return img.dataset.pmvOrigSrc || '';
        return img.getAttribute('src') ? img.src : '';
    }

    // The video's own API frames when available (same as the page strip); otherwise the page strip,
    // unless fullscreen is ahead of the page (then the strip belongs to the previous video).
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

    // ---------------------------------------------------------------------
    // Native action buttons
    // ---------------------------------------------------------------------
    // Cloned into the HUD so they stay reachable; one reusable detector for every page with this row.

    function findNativeActionBar() {
        // Signals from specific to generic (titles/aria-labels vary per page and change on click);
        // the first match is walked up to its button row.
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
            // Last resort: the button's direct parent.
            if (anchor.parentElement) return anchor.parentElement;
        }
        return null;
    }

    // The site's own favourite button, found by its title ("Add to favorites" / "Remove from favorites").
    // Clicking it keeps the site's count, icon and cache in step; the HUD's cloned copy is skipped
    // because its title is a snapshot.
    // Direct API fallback, for when the page's button is stale:
    //   PUT /api/videos/<id>/favorite  {action: "favorite"|"unfavorite"}
    async function toggleFavouriteViaApi() {
        const videoId = getCurrentVideoId();
        if (!videoId) { toast('No video'); return; }

        // Toggle direction comes from the video's data; unknown counts as not favourited, so the key adds.
        // Uses cached page data when present, otherwise a single lookup.
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
        // Clone only native buttons, not our own injections.
        [...nativeActionBar.children].forEach(child => {
            if (child.id === 'pmv-page-playlists' || child.dataset?.pmvPlBtn) return;
            if (child.tagName !== 'BUTTON' && child.tagName !== 'A') return;

            const clone = child.cloneNode(true);
            // Strip Vue attributes to avoid duplicate handlers.
            clone.removeAttribute('data-v-18f75d28');
            // Forward clicks to the original.
            clone.addEventListener('click', e => {
                e.stopPropagation();
                // Our own buttons (⊘, Tags) open their menus at the clone, not at the hidden original.
                forwardedAnchor = { rect: clone.getBoundingClientRect(), at: performance.now() };
                child.click();
                startHudTimer(4000);
                // The clone is a static snapshot; re-sync its classes shortly after the click,
                // once Vue has patched the original (and again for slower API toggles).
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

    // Stand-ins for the page's like/dislike/favourite buttons while fullscreen is ahead of the page.
    // Same look as the site's, but they call the API for the video actually playing:
    //   PUT /api/videos/<id>/like|dislike|favorite  {action: "like"|"unlike"|...}
    // Initial state comes from /api/videos/<id> (isLiked, isDisliked, isFavorited); the panel is
    // rebuilt when it arrives (refreshHudAfterHandover).
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
                // Like and dislike are mutually exclusive, as on the site.
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

    // ---------------------------------------------------------------------
    // Next-video mini-HUD
    // ---------------------------------------------------------------------
    // Brief bottom-left notification in fullscreen playlists.
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

    // Up-next card beside the main HUD panel. Shows the playlist's own Up Next on playlist pages,
    // otherwise the next item of the user's queue (same choice as the N key). Clicking dispatches
    // a synthetic N keydown.
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

    // "UP NEXT  8 left" label at the end of the HUD's first row; only while the playing video
    // is the current item of the queue.
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

        // Main column; separate from `hud` so the up-next card can sit beside it.
        const mainCol = document.createElement('div');
        mainCol.style.cssText = 'flex:1;min-width:0;';

        // Layout: [title ........ actions] / by · rating · views · duration · date ... up next /
        // tags / description / playlists, then the thumbnail strip.
        const actionBarClone = staleFullscreenHref ? buildApiActionBar(videoId) : buildNativeActionBarClone();
        if (actionBarClone) {
            actionBarClone.style.cssText = 'display:flex;flex-wrap:nowrap;gap:4px;flex-shrink:0;align-items:center;';
        } else if (!opts._retried) {
            // Action bar not rendered yet (the auth-dependent bar can still be hydrating on a fresh
            // /video/ load): retry once.
            setTimeout(() => {
                if (State.hud === hud) showHud({ _retried: true });
            }, 700);
        }

        // Clone the views/date/duration row from the page.
        const metaBar = (() => {
            // Skipped while fullscreen is ahead of the page (numbers belong to the previous video);
            // rating and date below come from fetched data.
            if (staleFullscreenHref) return null;
            // Row: flex-wrap items-center gap-3 with SVG+span children.
            const spans = [...document.querySelectorAll('span')].filter(s =>
                /\d[.,]?\d*K?\s*views/i.test(s.textContent) ||
                /^\d{4}-\d{2}-\d{2}$/.test(s.textContent.trim())
            );
            if (!spans.length) return null;
            return spans[0].closest('.flex.flex-wrap.items-center') ||
                   spans[0].closest('.flex.items-center') || null;
        })();
        const cvd = State.currentVideoData;

        // Header: title left, the action toolbar right.
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:16px;min-width:0;margin-bottom:4px;';
        const title = document.createElement('div');
        title.textContent = meta.title;
        title.style.cssText = 'flex:1;min-width:0;font-size:19px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        header.appendChild(title);
        if (actionBarClone) header.appendChild(actionBarClone);

        // One subdued line: creator, rating, then the page's views/date/duration row (icons included);
        // the upload date from the data only when that row is missing.
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

        // Tags: top5Tags when available, else regular tags; performers follow in the same row
        // with the site's yellow accent.
        const activeTags = (cvd?.top5Tags?.length ? cvd.top5Tags : null) || meta.tags;
        const activeStars = meta.starsTags || [];

        // Each chip toggles the site-wide filter (see cycleTagInFilter): orange = required,
        // red struck-through with ⊘ = excluded.
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
            // Flat SVG sparkle icon, matching the site's performer chips.
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

                // Configured colour, else derived from the name.
                const customStyle = getPlaylistStyle(playlist.name, playlist.id);
                const displayName = getPlaylistDisplayName(playlist.name, playlist.id);
                const colorHex = customStyle ? customStyle.color : FALLBACK_COLOR;
                const activeRgb = hexToRgbStr(colorHex);
                const inactiveRgb = mixToGrayStr(colorHex);

                // Fixed width regardless of label length.
                const BTN_WIDTH = 'width:82px;box-sizing:border-box;text-align:center;overflow:hidden;text-overflow:ellipsis;';
                // Active: muted playlist colour, thicker bright border.
                // Inactive: near gray with a hint of the colour (mixToGrayStr).
                const STYLE_ACTIVE = `font-size:12px;font-weight:700;padding:5px 6px;border-radius:6px;cursor:pointer;background:rgba(${activeRgb},.24);border:2px solid rgba(${activeRgb},.9);color:rgb(${activeRgb});white-space:nowrap;${BTN_WIDTH}box-shadow:0 0 0 1px rgba(${activeRgb},.22) inset;`;
                const STYLE_INACTIVE = `font-size:12px;font-weight:400;padding:5px 6px;border-radius:6px;cursor:pointer;background:rgba(${inactiveRgb},.05);border:1px solid rgba(${inactiveRgb},.45);color:rgba(${inactiveRgb},.75);white-space:nowrap;${BTN_WIDTH}`;
                // Busy: grayer; the green success state is the indicator.
                const STYLE_BUSY = `font-size:12px;font-weight:400;padding:5px 6px;border-radius:6px;cursor:default;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.3);white-space:nowrap;${BTN_WIDTH}`;

                const restyle = () => {
                    btn.textContent = displayName;
                    btn.style.cssText = active ? STYLE_ACTIVE : STYLE_INACTIVE;
                };
                restyle();

                btn.onclick = async e => {
                    e.stopPropagation();
                    const vid = getCurrentVideoId();
                    if (!vid) return;
                    btn.disabled = true;
                    btn.style.cssText = STYLE_BUSY;
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
            // One line; the full text in the tooltip.
            const desc = document.createElement('div');
            desc.textContent = String(descText).replace(/\s+/g, ' ').trim();
            desc.title = descText;
            desc.style.cssText = 'font-size:12px;color:rgba(255,255,255,.5);margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            mainCol.appendChild(desc);
        }
        mainCol.appendChild(playlistRow);


        // Top row: main column plus up-next card; the thumbnail strip spans the full width below.
        const topRow = document.createElement('div');
        topRow.style.cssText = 'display:flex;gap:14px;align-items:flex-start;min-width:0;';
        topRow.appendChild(mainCol);
        const upNextCard = buildUpNextCard();
        if (upNextCard) topRow.appendChild(upNextCard);
        // Queue counter: in the up-next card's label ("UP NEXT  8 left"), else at the end of the subline.
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

        // Hard upper bound: hover only pauses the soft timeout, so this timer closes the HUD
        // 5s after showing regardless of hover.
        clearTimeout(State.hudHardTimeout);
        State.hudHardTimeout = setTimeout(closeHud, 5000);
    }

    // ---------------------------------------------------------------------
    // Progress bar
    // ---------------------------------------------------------------------

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

        // Own seek bar for when the site's controls stay hidden (e.g. after an in-place fullscreen
        // hand-over). Hover for the preview, click/drag to seek; steps aside (no pointer events)
        // when the site's controls are visible.
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

    // ---------------------------------------------------------------------
    // Fullscreen queue sidebar
    // ---------------------------------------------------------------------
    // Playlist pages: in fullscreen only the player wrapper is shown, so the right-hand column is hidden
    // but stays live. The Up Next preview and queue scroller are moved (never cloned: clones lose
    // Vue handlers) into a rounded overlay; the rest of the column stays in place.

    const QUEUE_EDGE_ZONE_PX = 24;  // px from the right edge that reveals the sidebar
    const QUEUE_HIDE_DELAY_MS = 1000;  // grace period before hiding
    const QUEUE_SIDEBAR_WIDTH = 380;  // matches the normal grid column
    const QUEUE_SIDEBAR_MARGIN = 12;  // keeps rounded corners visible

    function isPlaylistPage() {
        return location.pathname.startsWith('/playlists/');
    }

    function findQueueParts() {
        // Wrapper found via its inline height (clamp(...)), falling back to the parent of the
        // scrollable video list.
        const wrapper = [...document.querySelectorAll('div[style*="clamp("]')]
            .find(el => el.querySelector('.w-24.h-14')) ||
            [...document.querySelectorAll('.overflow-y-auto.custom-scrollbar')]
                .find(el => el.querySelector('[role="button"] .w-24.h-14'))?.parentElement ||
            null;
        if (!wrapper) return null;

        const scroller = wrapper.querySelector('.overflow-y-auto.custom-scrollbar');
        if (!scroller) return null;

        // "Up Next" preview: the block containing the <p> label "Up Next".
        const upNext = [...wrapper.querySelectorAll('p')]
            .find(p => p.textContent.trim() === 'Up Next')?.parentElement || null;

        return { scroller, upNext };
    }

    function getActiveQueueRow() {
        // The active row carries bg-[#272727] + border-orange-500: the most stable hook that needs
        // no video IDs. Shared with the fetch interceptor's isCurrentPage check.
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
        // Assign scrollTop directly: scrollIntoView follows the site's smooth scrolling and the
        // sidebar would visibly fly into place.
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
        // Rounded corners (14px, as the HUD) and 80% opacity.
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
            // Use the playing video, not null: with null the next real change (e.g. N right after
            // entering fullscreen) is skipped.
            State.lastNextHudVideoId = getCurrentVideoId();
        } else {
            removeProgressBar(); closeHud(); hideQueueSidebarNow();
            State.lastNextHudVideoId = null;
        }
    });

    // ---------------------------------------------------------------------
    // Native playlist button highlight
    // ---------------------------------------------------------------------

    function findNativePlaylistButton() {
        if (State.nativePlaylistButton?.isConnected) return State.nativePlaylistButton;
        const found = [...document.querySelectorAll('button, [role="button"]')].find(btn => {
            const d = btn.querySelector('svg path')?.getAttribute('d') || '';
            return d.includes('M16 5H3') && d.includes('M18 9v6') && d.includes('h-6');
        }) || null;
        State.nativePlaylistButton = found;
        return found;
    }

    function updateNativePlaylistButtons(force = false) {
        if (!State.ready) return;
        const videoId = getCurrentVideoId();
        if (!videoId) return;
        if (!force && State.nativePlaylistButtonLastVideoId === videoId) return;
        State.nativePlaylistButtonLastVideoId = videoId;

        const btn = findNativePlaylistButton();
        if (btn) {
            const inAny = getMatches(videoId).length > 0;
            const rgb = isRejected(videoId) ? REJECT_RGB : '100,255,0';
            btn.dataset.pmvPlaylistButton = '1';
            btn.style.transition = 'color 120ms ease, border-color 120ms ease';
            if (inAny) {
                btn.style.color = `rgb(${rgb})`;
                btn.style.borderColor = `rgba(${rgb},.45)`;
                btn.style.boxShadow = `0 0 0 1px rgba(${rgb},.18) inset`;
            } else {
                btn.style.color = '';
                btn.style.borderColor = '';
                btn.style.boxShadow = '';
            }
        }

        // Inject/update playlist buttons below the native button bar.
        injectPagePlaylistButtons(videoId);
    }


    function injectPagePlaylistButtons(videoId) {
        // Active on /video/ and /playlists/ pages (same native "Add to Playlist" button, slightly
        // different bar).
        if (!location.pathname.startsWith('/video/') && !location.pathname.startsWith('/playlists/')) return;
        if (!State.ready || !videoId) return;

        // Find the container of the native button bar; the extra row goes right after it.
        const nativeBar = nativeActionBar();
        if (!nativeBar) return;
        ensureRejectBarButton(videoId, nativeBar);

        // Remove the previous injection if videoId changed.
        const existing = document.getElementById('pmv-page-playlists');
        if (existing) {
            if (existing.dataset.forVideo === videoId) {
                // Same video: recompute active status.
                existing.querySelectorAll('[data-pmv-pl-btn]').forEach(b => {
                    const plId = b.dataset.pmvPlBtn;
                    const inPl = State.playlists.get(plId)?.ids.has(videoId) || false;
                    applyPageBtnStyle(b, inPl);
                });
                return;
            }
            existing.remove();
        }

        // Separate row below the native bar, in the same grid parent.
        const wrap = document.createElement('div');
        wrap.id = 'pmv-page-playlists';
        wrap.dataset.forVideo = videoId;
        wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;margin-top:8px;grid-column:1/-1;';

        // The reject list is not a playlist button: it is the ⊘ in the site's action bar.
        const rejectId = rejectPlaylistId && State.playlists.has(rejectPlaylistId) ? rejectPlaylistId : null;

        [...State.playlists.values()]
            .filter(pl => pl.id !== rejectId)
            .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
            .forEach(pl => {
            const inPl = pl.ids.has(videoId);
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.pmvPlBtn = pl.id;
            b.title = pl.name;
            const displayName = getPlaylistDisplayName(pl.name, pl.id);
            b.style.cssText = [
                'display:inline-flex',
                'align-items:center',
                'justify-content:center',
                'padding:5px 6px',
                'border-radius:6px',
                'font-size:12px',
                'white-space:nowrap',
                'cursor:pointer',
                'transition:all .15s',
                'width:82px',
                'box-sizing:border-box',
                'overflow:hidden',
                'text-overflow:ellipsis',
            ].join(';');
            applyPageBtnStyle(b, inPl);

            const lbl = document.createElement('span');
            lbl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            lbl.textContent = displayName;
            b.appendChild(lbl);

            b.addEventListener('click', async e => {
                e.stopPropagation();
                b.disabled = true;
                // Busy: grayer; the label does not change.
                b.style.background = 'rgba(255,255,255,.04)';
                b.style.border = '1px solid rgba(255,255,255,.08)';
                b.style.color = 'rgba(255,255,255,.3)';
                b.style.fontWeight = '400';
                try {
                    if (pl.ids.has(videoId)) {
                        const ok = await removeFromPlaylist(videoId, pl.id);
                        if (ok) toast('✕ ' + displayName, 'red');
                        else toast('Remove failed');
                    } else {
                        const ok = await addToPlaylist(videoId, pl.id);
                        if (ok) toast('✓ ' + displayName, 'green');
                        else toast('Add failed');
                    }
                    updateNativePlaylistButtons(true);
                    scheduleBadges();
                } finally {
                    b.disabled = false;
                }
            });

            wrap.appendChild(b);
        });

        // Insert as next sibling of the native bar.
        nativeBar.parentElement?.appendChild(wrap);
    }

    // The site's action bar under the video (Like, Dislike, Favourite, …).
    function nativeActionBar() {
        const nativeBtn = findNativePlaylistButton();
        return nativeBtn?.closest('.flex.items-center.gap-2') ||
            (() => {
                const anchor = [...document.querySelectorAll('button[title]')]
                    .find(b => /^Like/i.test(b.title) || /^Add to playlist$/i.test(b.title));
                return anchor?.closest('.flex.items-center.gap-2') || null;
            })();
    }

    // ⊘ as the first button of the site's action bar, in its style. The same toggle as the ⊘ on
    // cards (no skip, unlike the hotkey). Vue owns the bar, so the heartbeat re-inserts it when
    // the bar is rebuilt.
    const BAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" style="font-size:16px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m4.9 4.9 14.2 14.2"></path></svg>';
    function ensureRejectBtnStyle() {
        if (document.getElementById('pmv-reject-bar-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-reject-bar-style';
        st.textContent = `
[data-pmv-reject-page]:hover{color:rgb(252,165,165) !important;background:rgba(220,38,38,.22) !important;}
[data-pmv-reject-page][data-on="1"]{color:#fff !important;background:rgba(220,38,38,.85) !important;}
[data-pmv-reject-page][data-on="1"]:hover{background:rgba(220,38,38,.7) !important;}`;
        (document.head || document.documentElement).appendChild(st);
    }
    function styleRejectPageBtn(btn, on) {
        btn.dataset.on = on ? '1' : '';
        btn.title = on ? 'Rejected — click to remove from the reject list' : 'Reject (move to the reject list, remove from every other playlist)';
    }
    function rejectPageButton(videoId) {
        ensureRejectBtnStyle();
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.pmvRejectPage = '1';
        b.dataset.forVideo = videoId;
        b.className = 'inline-flex items-center justify-center px-3 py-1.5 rounded-lg transition-all text-sm w-[52px] bg-[#2A2A2A] text-gray-400 hover:bg-[#3A3A3A] hover:text-white';
        b.innerHTML = BAN_SVG;
        styleRejectPageBtn(b, isRejected(videoId));
        b.addEventListener('click', async e => {
            e.preventDefault();
            e.stopPropagation();
            if (b.disabled) return;
            b.disabled = true;
            b.style.opacity = '0.5';
            try {
                const rect = takeForwardedAnchor() || b.getBoundingClientRect();
                const now = await toggleRejectVideo(videoId);
                if (now !== null) styleRejectPageBtn(b, now);
                if (now && tagAfterReject()) openTagPopup(videoId, rect, State.currentVideoData?.id === videoId ? State.currentVideoData.title : '');
            } finally {
                b.disabled = false;
                b.style.opacity = '';
            }
        });
        return b;
    }
    // Tags button: the compact tag menu (openTagPopup) instead of the site's Vote on Tags modal, with
    // that button's icon (lucide laptop-check). Also on playlist pages, which have no such button.
    const VOTE_TAGS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" style="font-size:16px;" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m9 12l2 2l4-4"></path><path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5zm17 12H2"></path></g></svg>';
    function tagBarButton(videoId, kind = 'general') {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.pmvTagBar = kind;
        b.dataset.forVideo = videoId;
        b.className = 'inline-flex items-center justify-center px-3 py-1.5 rounded-lg transition-all text-sm w-[52px] bg-[#2A2A2A] text-gray-400 hover:bg-[#3A3A3A] hover:text-white';
        b.title = kind === 'stars' ? 'Models \u2014 vote or add' : 'Tags \u2014 vote or add';
        b.innerHTML = kind === 'stars' ? STAR_SVG.replace('width="14" height="14"', 'width="16" height="16"') : VOTE_TAGS_SVG;
        b.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            const open = document.getElementById('pmv-tag-pop');
            if (open && open.dataset.forVideo === videoId && open._pmvToggle === b) { closeTagPopup(); return; }
            const title = State.currentVideoData?.id === videoId ? State.currentVideoData.title : '';
            const pop = openTagPopup(videoId, takeForwardedAnchor() || b.getBoundingClientRect(), title,
                { heading: kind === 'stars' ? 'Models' : 'Tags', toggleEl: b, kind });
            pop._pmvToggle = b;
        });
        return b;
    }

    // The site's own "Vote on Tags" buttons open the compact tag menu instead of its modal;
    // Shift+click still opens the modal.
    document.addEventListener('click', e => {
        if (e.shiftKey || !State.ready) return;
        const b = e.target.closest?.('button');
        if (!b || b.dataset.pmvTagBar || b.closest('#pmv-tag-pop, [data-pmv-hud]')) return;
        if (!/^Vote on Tags( Now)?$/.test(b.textContent.trim()) && b.title !== 'Suggest and vote on tags') return;
        const videoId = getCurrentVideoId();
        if (!videoId) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const title = State.currentVideoData?.id === videoId ? State.currentVideoData.title : '';
        const pop = openTagPopup(videoId, b.getBoundingClientRect(), title, { heading: 'Tags', toggleEl: b });
        pop._pmvToggle = b;
    }, true);

    // A button, not a link: the HUD forwards clicks on its clone, and a cloned link would open twice.
    function openPageBarButton(videoId) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.pmvOpenPage = '1';
        b.dataset.forVideo = videoId;
        b.className = 'inline-flex items-center justify-center px-3 py-1.5 rounded-lg transition-all text-sm w-[52px] bg-[#2A2A2A] text-gray-400 hover:bg-[#3A3A3A] hover:text-white';
        b.title = 'Open the video page in a new tab';
        b.innerHTML = CARD_ICON.external.replace('<svg ', '<svg width="16" height="16" ');
        const go = e => {
            e.preventDefault();
            e.stopPropagation();
            const title = State.currentVideoData?.id === videoId ? State.currentVideoData.title : '';
            const slug = String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
            window.open(`/video/${slug ? slug + '_' : ''}${videoId}`, '_blank', 'noopener');
        };
        b.addEventListener('click', go);
        b.addEventListener('auxclick', e => { if (e.button === 1) go(e); });
        return b;
    }

    // Our buttons at the start of the site's action bar: ⊘ (with a reject list), then Tags and Models.
    function ensureRejectBarButton(videoId, bar = null) {
        const onPage = location.pathname.startsWith('/video/') || location.pathname.startsWith('/playlists/');
        if (onPage && videoId && !bar) bar = nativeActionBar();
        const ok = onPage && videoId && bar;
        const hasList = rejectPlaylistId && State.playlists.has(rejectPlaylistId);

        const want = [];
        const pageOwn = sel => [...document.querySelectorAll(sel)].find(el => !el.closest('[data-pmv-hud]')) || null;
        let rej = pageOwn('[data-pmv-reject-page]');
        if (ok && hasList) {
            if (!rej || rej.parentElement !== bar || rej.dataset.forVideo !== videoId) { rej?.remove(); rej = rejectPageButton(videoId); }
            else styleRejectPageBtn(rej, isRejected(videoId));
            want.push(rej);
        } else rej?.remove();

        for (const kind of ['general', 'stars']) {
            let tag = pageOwn(`[data-pmv-tag-bar="${kind}"]`);
            if (ok && State.ready) {
                if (!tag || tag.parentElement !== bar || tag.dataset.forVideo !== videoId) { tag?.remove(); tag = tagBarButton(videoId, kind); }
                want.push(tag);
            } else tag?.remove();
        }

        // On a playlist page: open the playing video's own page in a new tab.
        let ext = pageOwn('[data-pmv-open-page]');
        if (ok && location.pathname.startsWith('/playlists/')) {
            if (!ext || ext.parentElement !== bar || ext.dataset.forVideo !== videoId) { ext?.remove(); ext = openPageBarButton(videoId); }
            want.push(ext);
        } else ext?.remove();

        if (!ok) return;
        // In order at the start, moved only when out of place.
        want.forEach((el, i) => { if (bar.children[i] !== el) bar.insertBefore(el, bar.children[i] || null); });
    }

    function applyPageBtnStyle(btn, active) {
        const plId = btn.dataset.pmvPlBtn;
        const name = State.playlists.get(plId)?.name || '';
        btn.title = name;
        const lbl = btn.querySelector('span');
        if (lbl) lbl.textContent = getPlaylistDisplayName(name, plId);

        // Active: muted playlist colour, thicker bright border. Inactive: near gray with a hint of the colour.
        const customStyle = getPlaylistStyle(name, plId);
        const colorHex = customStyle ? customStyle.color : FALLBACK_COLOR;
        const activeRgb = hexToRgbStr(colorHex);
        const inactiveRgb = mixToGrayStr(colorHex);
        if (active) {
            btn.style.background = `rgba(${activeRgb},0.24)`;
            btn.style.border = `2px solid rgba(${activeRgb},0.9)`;
            btn.style.color = `rgb(${activeRgb})`;
            btn.style.fontWeight = '700';
        } else {
            btn.style.background = `rgba(${inactiveRgb},0.05)`;
            btn.style.border = `1px solid rgba(${inactiveRgb},0.45)`;
            btn.style.color = `rgba(${inactiveRgb},0.75)`;
            btn.style.fontWeight = '400';
        }
    }

    // ---------------------------------------------------------------------
    // Site-wide filter
    // ---------------------------------------------------------------------
    // Own filter, editable from the header on any page. Hides only while switched on:
    // the header button is the switch, the panel is the editor.
    const FILTER_KEY = 'pmv_filter_v1';
    const FILTER_DEFAULTS = {
        active: false,
        exclude: '',       // space separated, quoted phrases allowed
        include: '',
        ratingMin: 0,
        ratingMax: 100,
        maxMinutes: 0,     // 0 = no cap
        playlistMode: 'all',
        playlistIds: [],
        seen: 'any',       // 'any' | 'seen' | 'unseen'
        savedSearch: null,  // parsed copy of a saved search
        savedSearchName: '',
        flags: {},          // content flag key -> 'out' (hide) | 'in' (only these)
        // Pagination options (see the Pagination section).
        bigPages: false,   // raise the site's own page size to its maximum
        mergeGrids: true,  // one grid instead of one per loaded batch
        pagedWhenFiltered: false, // autoscroll off while the filter hides things
        siteInfiniteWas: false,
        topUpTarget: 24,   // keep loading until this many survive (autoscroll on)
        skipBelow: 1,      // move on from a page with fewer than this (autoscroll off)
        sitePageSizeWas: 0,
    };

    function loadFilterConfig() {
        try { return { ...FILTER_DEFAULTS, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') }; }
        catch { return { ...FILTER_DEFAULTS }; }
    }
    let filterConfig = loadFilterConfig();
    function saveFilterConfig() {
        try { localStorage.setItem(FILTER_KEY, JSON.stringify(filterConfig)); } catch {}
    }

    // Saved searches from the site. Picking one applies the same rules as the playlist-page
    // filter, so a setup made once works everywhere (and covers tags better than card chips).
    let savedSearchCache = null;
    async function fetchSavedSearches() {
        if (savedSearchCache) return savedSearchCache;
        try {
            const res = await fetch('/api/saved-searches', { credentials: 'include' });
            if (!res.ok) return [];
            const data = await res.json();
            savedSearchCache = Array.isArray(data) ? data : (data.data || data.searches || data.savedSearches || []);
            return savedSearchCache;
        } catch { return []; }
    }

    function parseSavedSearch(ss) {
        const raw = ss.filters || ss.params || ss.query || ss;
        const rawTags = raw.excludeTags ?? raw.exclude_tags ?? [];
        const excludeTags = (typeof rawTags === 'string' ? rawTags.split(',') : rawTags)
            .map(t => String(t).trim().toLowerCase()).filter(Boolean);
        const rawAspect = Array.isArray(raw.aspect) ? raw.aspect : (raw.aspect ? [raw.aspect] : []);
        return {
            excludeTags,
            minRating: raw.minRating ? Number(raw.minRating) : 0,
            aspectFilter: rawAspect.length > 0,
            _rawAspect: rawAspect,
        };
    }

    // Terms: plain words match anywhere in the text; "quoted" terms (also smart quotes) and =word match
    // only as a whole word or phrase. Internally a whole-word term is "=term" (PMVX.termMatch).
    function filterTerms(raw) {
        const quoted = t => t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")));
        return (PMVX.plainQuotes(raw).trim().match(/=?"[^"]*"|=?'[^']*'|\S+/g) || [])
            .map(t => {
                if (t[0] === '=') { const b = t.slice(1); return '=' + (quoted(b) ? b.slice(1, -1) : b); }
                return quoted(t) ? '=' + t.slice(1, -1) : t;
            })
            .map(t => t.toLowerCase().trim())
            .filter(t => t && t !== '=');
    }

    function joinFilterTerms(terms) {
        return terms.map(t => PMVX.isWordTerm(t) || /\s/.test(t) ? `"${PMVX.termLabel(t)}"` : t).join(' ');
    }

    // Where a tag stands in the filter: 'include', 'exclude' or null.
    function tagFilterState(tag) {
        const t = String(tag).toLowerCase().trim();
        if (filterTerms(filterConfig.include).includes(t)) return 'include';
        if (filterTerms(filterConfig.exclude).includes(t)) return 'exclude';
        return null;
    }

    // The exclude term (or saved-search tag) of the active site-wide filter that this tag would trip,
    // or null: a video carrying it is hidden. Used by the tag menu to warn before adding.
    function tagHiddenBy(tag) {
        if (!filterConfig.active) return null;
        const t = String(tag).toLowerCase().trim();
        if (!t) return null;
        const term = filterTerms(filterConfig.exclude).find(x => PMVX.termMatch(t, x));
        if (term) return PMVX.termLabel(term);
        if (filterConfig.savedSearch?.excludeTags?.includes(t)) return t;
        return null;
    }

    // Clicking a tag cycles it: not in filter, required, excluded, removed. Adding switches hiding
    // on; removing leaves the switch alone. An open panel gets the new text.
    const TAG_CYCLE = { null: 'include', include: 'exclude', exclude: null };
    function cycleTagInFilter(tag) {
        const t = String(tag).toLowerCase().trim();
        if (!t) return null;
        const next = TAG_CYCLE[tagFilterState(t)];
        const include = filterTerms(filterConfig.include).filter(x => x !== t);
        const exclude = filterTerms(filterConfig.exclude).filter(x => x !== t);
        if (next === 'include') include.push(t);
        if (next === 'exclude') exclude.push(t);
        filterConfig.include = joinFilterTerms(include);
        filterConfig.exclude = joinFilterTerms(exclude);
        if (next) filterConfig.active = true;
        saveFilterConfig();
        applyFilterToCards();
        setNfDefaultTag(t, next);
        document.getElementById('pmv-filter-panel')?.refresh?.();
        return next;
    }

    // The tag is also written to the playlist-page filter's fixed default terms (always required /
    // excluded), straight into its storage; an event makes it refilter if active. Any earlier token
    // for the tag, including share-limited ones like -trans(0.1), is removed first.
    function setNfDefaultTag(tag, state) {
        let raw = '';
        try { raw = localStorage.getItem(NF_DEFAULT_TERMS_KEY) || ''; } catch { return; }
        const termOf = tok => {
            if (tok.startsWith('!')) return null;
            let s = tok.startsWith('-') ? tok.slice(1) : tok;
            s = s.replace(/\([^)]*\)$/, '');
            if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) s = s.slice(1, -1);
            return s.toLowerCase().trim();
        };
        const toks = (raw.trim().match(/-?"[^"]*"|-?'[^']*'|\S+/g) || []).filter(tok => termOf(tok) !== tag);
        const quoted = /\s/.test(tag) ? `"${tag}"` : tag;
        if (state === 'include') toks.push(quoted);
        if (state === 'exclude') toks.push('-' + quoted);
        const out = toks.join(' ');
        if (out === raw.trim()) return;
        try { localStorage.setItem(NF_DEFAULT_TERMS_KEY, out); } catch { return; }
        window.dispatchEvent(new CustomEvent('pmv:nf-default-terms', { detail: { added: !!state } }));
    }

    function filterIsMeaningful(c = filterConfig) {
        return filterTerms(c.exclude).length > 0
            || filterTerms(c.include).length > 0
            || c.ratingMin > 0 || c.ratingMax < 100
            || c.maxMinutes > 0
            || c.playlistMode !== 'all'
            || c.seen !== 'any'
            || !!c.savedSearch
            || Object.values(c.flags || {}).some(Boolean);
    }

    // A content flag of a video, or undefined when it is not known (then it never hides anything).
    // Vertical falls back to the stored size.
    function videoFlag(id, key) {
        if (!id) return undefined;
        const i = CONTENT_FLAGS.findIndex(([k]) => k === key);
        const e = flagCacheMap().get(id);
        if (i >= 0 && e && (e[1] >> i) & 1) return !!((e[0] >> i) & 1);
        if (key === 'isVertical') {
            const m = State.videoMeta.get(id);
            if (m?.width && m?.height) return m.height > m.width;
        }
        return undefined;
    }
    PMVX.videoFlag = videoFlag;

    // Flags still unknown for any of `keys` get fetched in bulk: GET /api/videos/bulk?ids=… (up to 100
    // ids per call, full documents). One call at a time, a short pause between calls, a longer one on
    // HTTP 429; each id is asked for once per page load. onDone runs when the queue is empty.
    const FLAG_BULK = 100;
    const flagQueue = new Set();
    const flagTried = new Set();
    const flagDone = new Set();
    let flagFetching = false;
    function flagsUnknown(id, keys) {
        return keys.some(k => videoFlag(id, k) === undefined);
    }
    PMVX.fetchFlags = (ids, keys, onDone) => {
        let added = 0;
        ids.forEach(id => {
            if (!id || flagTried.has(id) || !flagsUnknown(id, keys)) return;
            flagTried.add(id); flagQueue.add(id); added++;
        });
        if (onDone) flagDone.add(onDone);
        if (added) runFlagFetch();
        return added;
    };
    async function runFlagFetch() {
        if (flagFetching) return;
        flagFetching = true;
        let got = 0;
        try {
            while (flagQueue.size) {
                const batch = [...flagQueue].slice(0, FLAG_BULK);
                batch.forEach(id => flagQueue.delete(id));
                try {
                    const res = await fetch('/api/videos/bulk?ids=' + batch.join(','), { credentials: 'include' });
                    if (res.status === 429) {
                        batch.forEach(id => flagQueue.add(id));
                        await new Promise(r => setTimeout(r, 8000));
                        continue;
                    }
                    if (res.ok) {
                        const j = await res.json();
                        const list = j?.videos || j?.data || [];
                        if (Array.isArray(list)) { indexVideoDetails(list); got += list.length; }
                    }
                } catch {}
                await new Promise(r => setTimeout(r, 400));
            }
        } finally {
            flagFetching = false;
            const fns = [...flagDone];
            flagDone.clear();
            if (got) fns.forEach(fn => { try { fn(); } catch {} });
        }
    }

    // `meta` is what could be read off the card; the cache fills in the rest. Unknown data never
    // causes a hide, so a video that was not fetched yet is not filtered out for no visible reason.
    function passesFilter(id, meta, c = filterConfig) {
        return filterReasons(id, meta, c, false).length === 0;
    }

    // Why the filter blocks a video: short labels ("⊘ term", "needs term", "rating 41%" …). With
    // all=false it stops at the first one (passesFilter); with all=true it collects every reason.
    function filterReasons(id, meta, c = filterConfig, all = true) {
        const out = [];
        const hit = label => { out.push(label); return !all; };
        const cached = id ? State.videoMeta.get(id) : null;
        const title = (meta?.title || cached?.title || '').toLowerCase();
        const uploader = (meta?.uploaderDisplay || cached?.uploaderDisplay || '').toLowerCase();
        // Tags come from both the cache (complete, but only fetched videos) and the card (whatever it
        // shows); neither alone suffices.
        const tags = [...new Set([
            ...(meta?.tags || []),
            ...(cached?.tags || []),
            ...(cached?.starsTags || []),
        ].map(t => String(t).toLowerCase()))];
        const haystacks = [title, uploader, ...tags];

        for (const term of filterTerms(c.exclude)) if (haystacks.some(h => PMVX.termMatch(h, term)) && hit('\u2298 ' + PMVX.termLabel(term))) return out;
        for (const term of filterTerms(c.include)) if (!haystacks.some(h => PMVX.termMatch(h, term)) && hit('needs ' + PMVX.termLabel(term))) return out;

        const rating = meta?.bayesianRating ?? cached?.bayesianRating ?? 0;
        if ((c.ratingMin > 0 || c.ratingMax < 100) && rating > 0) {
            if ((rating < c.ratingMin || rating > c.ratingMax) && hit('rating ' + Math.round(rating) + '%')) return out;
        }

        if (c.maxMinutes > 0) {
            const secs = durationToSeconds(cached?.duration || meta?.duration);
            if (secs > 0 && secs > c.maxMinutes * 60 && hit('over ' + c.maxMinutes + ' min')) return out;
        }

        if (c.seen !== 'any' && id && typeof PMVX.isWatched === 'function') {
            const watched = PMVX.isWatched(id);
            if (c.seen === 'seen' && !watched && hit('not watched')) return out;
            if (c.seen === 'unseen' && watched && hit('watched')) return out;
        }

        const fl = c.flags || {};
        for (const [key, label] of CONTENT_FLAGS) {
            const mode = fl[key];
            if (!mode) continue;
            const v = videoFlag(id, key);
            if (v === undefined) continue;
            if (mode === 'out' && v && hit('\u2298 ' + label)) return out;
            if (mode === 'in' && !v && hit('needs ' + label)) return out;
        }

        const ss = c.savedSearch;
        if (ss) {
            // Tags here come from the same partial picture, so an excluded tag the card does not show
            // cannot be caught.
            const bad = ss.excludeTags?.length ? tags.find(t => ss.excludeTags.includes(t)) : null;
            if (bad && hit('\u2298 ' + bad)) return out;
            if (ss.minRating && rating > 0 && rating < ss.minRating && hit('rating ' + Math.round(rating) + '%')) return out;
            if (ss.aspectFilter && cached?.width && cached?.height) {
                const ratio = cached.width / cached.height;
                const ok = ss._rawAspect.some(aspect => {
                    if (aspect === '16:9') return ratio >= 1.7 && ratio <= 1.8;
                    if (aspect === '21:9') return ratio >= 2.3 && ratio <= 2.45;
                    if (aspect === '4:3') return ratio >= 1.3 && ratio <= 1.35;
                    if (aspect === '1:1') return ratio >= 0.95 && ratio <= 1.05;
                    if (aspect === '9:16') return ratio >= 0.5 && ratio <= 0.6;
                    return false;
                });
                if (!ok && hit('aspect')) return out;
            }
        }

        if (c.playlistMode !== 'all' && id && !PMVX.playlistFilterExempt()) {
            const memberOf = State.reverse.get(id) || new Set();
            const inSel = c.playlistIds.length ? c.playlistIds.some(pid => memberOf.has(pid)) : memberOf.size > 0;
            if (c.playlistMode === 'in' && !inSel && hit('not in playlist')) return out;
            if (c.playlistMode === 'out' && inSel && hit('in playlist')) return out;
        }

        return out;
    }

    function durationToSeconds(raw) {
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string' && raw.includes(':')) {
            const parts = raw.split(':').map(n => parseInt(n, 10));
            return parts.some(Number.isNaN) ? 0 : parts.reduce((acc, n) => acc * 60 + n, 0);
        }
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : 0;
    }

    // Hiding uses a stylesheet rule keyed on a data-* flag: Vue re-renders wipe inline styles
    // but keep data attributes.
    function ensureFilterStyle() {
        if (document.getElementById('pmv-filter-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-filter-style';
        st.textContent = '[data-pmv-filtered="1"]{display:none !important;}';
        (document.head || document.documentElement).appendChild(st);
    }

    let filterHiddenCount = 0;
    // What the filter hid on this page: id -> { title, href, thumb, reasons }, plus every card it judged.
    // Kept apart from the DOM, because hidden cards can be pruned from the site's list.
    const filterHiddenLog = new Map();
    const filterSeen = new Set();
    let filterLogPath = location.pathname + location.search;
    function resetFilterLog() { filterHiddenLog.clear(); filterSeen.clear(); filterLogPath = location.pathname + location.search; }

    // Walks every card surface: grids (data-video-id), the Recommended sidebar (.w-40 thumbs) and
    // the "More from" grid. Cards are marked or unmarked, never removed.
    // Runs from the DOM observer (up to once a frame), so it is throttled:
    // - filter off: only still-marked cards are touched;
    // - a card is stamped with the id it was judged for; observer runs judge only new or changed cards;
    // - all cards at most once a second, and in full when called directly;
    // - what a card shows is scraped once per card+id (WeakMap).
    let filterFullPassAt = 0;
    const cardMetaCache = new WeakMap();
    function cachedCardMeta(card, stamp) {
        const hit = cardMetaCache.get(card);
        if (hit && hit.stamp === stamp) return hit.meta;
        const meta = scrapeCardMeta(card);
        cardMetaCache.set(card, { stamp, meta });
        return meta;
    }

    let queueFilterSig = '';
    function applyFilterToCards(full = true) {
        ensureFilterStyle();
        const on = filterConfig.active && filterIsMeaningful();
        // The Up next rows show why the filter would hide a video; re-render them when it changes.
        const sig = on ? JSON.stringify(filterConfig) : '';
        if (filterLogPath !== location.pathname + location.search) resetFilterLog();
        if (sig !== queueFilterSig) {
            queueFilterSig = sig;
            resetFilterLog();
            if (smartQueueItems.length) { try { renderQueueSidebar(); } catch {} }
        }

        if (!on) {
            document.querySelectorAll('[data-pmv-filtered]').forEach(el => el.removeAttribute('data-pmv-filtered'));
            filterHiddenCount = 0;
            if (filterHiddenLog.size || filterSeen.size) resetFilterLog();
            updateFilterButton();
            return;
        }

        const now = performance.now();
        if (!full && now - filterFullPassAt > 1000) full = true;
        if (full) filterFullPassAt = now;

        const mark = (el, id) => {
            const stamp = id || '?';
            if (!full && el.dataset.pmvFid === stamp) return;
            if (el.dataset.pmvFid !== stamp) el.dataset.pmvFid = stamp;
            const meta = cachedCardMeta(el, stamp);
            const reasons = filterReasons(id, meta, filterConfig, true);
            const key = id || el.getAttribute('href') || stamp;
            filterSeen.add(key);
            if (!reasons.length) { el.removeAttribute('data-pmv-filtered'); filterHiddenLog.delete(key); return; }
            el.setAttribute('data-pmv-filtered', '1');
            const link = el.tagName === 'A' ? el.getAttribute('href') : el.querySelector('a[href*="/video/"]')?.getAttribute('href');
            filterHiddenLog.set(key, {
                id,
                title: meta?.title || el.querySelector('h3, h4')?.textContent.trim() || id || 'Video',
                href: cleanVideoHref(link) || (id ? `/video/${id}` : null),
                thumb: cardThumbUrl(el, id, meta),
                reasons,
            });
        };

        document.querySelectorAll('[data-video-id]').forEach(card => {
            mark(card, card.dataset.videoId);
        });

        document.querySelectorAll('.w-40').forEach(thumb => {
            const card = thumb.parentElement;
            if (!card || card.hasAttribute('data-video-id')) return;
            // Up next rows stay: the filter is shown on them (blocking reason chip), never hides them.
            if (card.matches('[data-queue-id]') || card.closest('#pmv-queue-sidebar, #pmv-queue-floating')) { card.removeAttribute('data-pmv-filtered'); return; }
            const slugId = resolveRecCardVideoId(card);
            mark(card, slugId ? (State.slugToApiId.get(slugId) || slugId) : null);
        });

        [...document.querySelectorAll('h3')]
            .filter(h => /^More from/i.test(h.textContent.trim()))
            .forEach(h3 => {
                const container = h3.parentElement?.parentElement;
                if (!container) return;
                container.querySelectorAll('a[href*="/video/"]').forEach(card => {
                    if (card.hasAttribute('data-video-id')) return;
                    const slugId = getVideoIdFromHref(card.getAttribute('href'));
                    mark(card, slugId ? knownApiIdForCard(card, slugId) : null);
                });
            });

        filterHiddenCount = Math.max(filterHiddenLog.size, document.querySelectorAll('[data-pmv-filtered="1"]').length);
        updateFilterButton();

        // Content flags the cards' data did not carry: fetched in bulk, then judged again.
        const flagKeys = Object.keys(filterConfig.flags || {}).filter(k => filterConfig.flags[k]);
        if (flagKeys.length && full) {
            const ids = [...filterSeen].filter(k => /^[a-f0-9]{24}$/.test(k));
            PMVX.fetchFlags(ids, flagKeys, () => { filterFullPassAt = 0; applyFilterToCards(true); });
        }
    }

    const FILTER_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>';

    // Both buttons live on document.body in a bar pinned to the header's control row; that row gets
    // extra padding via an injected stylesheet rule. They are not inserted into the row itself: Vue
    // manages it (server-rendered v-if placeholders are filled after hydration), so injected nodes
    // end up in wrong slots or displace the site's controls.
    const HEADER_GAP_PX = 104;  // divider, both buttons and spacing

    const QUEUE_BADGE_HTML =
        '<span data-pmv-queue-count style="position:absolute;top:0;right:0;min-width:15px;height:15px;' +
        'line-height:15px;padding:0 3px;border-radius:8px;background:rgb(100,255,0);color:#000;' +
        'font-size:10px;font-weight:700;text-align:center;"></span>';


    function ensureHeaderStyle() {
        if (document.getElementById('pmv-headroom-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-headroom-style';
        // Padding, not margin: the row is a flex container, so its children shift left without changing
        // its box. Keyed on a data attribute because Vue rewrites class/style on patch.
        // --pmv-headroom: the bar's measured width (set in ensureHeaderBar), so extra buttons fit.
        st.textContent = `[data-pmv-headroom="1"]{padding-right:calc(var(--pmv-headroom, ${HEADER_GAP_PX}px) + 16px) !important;}`;
        (document.head || document.documentElement).appendChild(st);
    }

    // The site keeps a mobile and a desktop header in the DOM; the visible one is whichever has width.
    // Measurement and placement (forced layout) are cached and redone only when the row is gone, on
    // window resize, or when a ResizeObserver on the row fires (also catches the mobile/desktop switch).
    let hdrRow = null;
    let hdrRO = null;
    let hdrDirty = true;
    function headerControlRow() {
        if (!hdrDirty && hdrRow?.isConnected) return hdrRow;
        const row = [...document.querySelectorAll('.search-trigger')]
            .map(trigger => trigger.parentElement)
            .find(r => r && r.getBoundingClientRect().width > 0) || null;
        if (row !== hdrRow) {
            try { hdrRO?.disconnect(); } catch {}
            hdrRow = row;
            hdrRO = null;
            if (row && typeof ResizeObserver === 'function') {
                hdrRO = new ResizeObserver(() => { hdrDirty = true; try { ensureHeaderBar(); } catch {} });
                hdrRO.observe(row);
            }
        }
        if (row) hdrDirty = false;
        return row;
    }

    function ensureHeaderBar() {
        ensureHeaderStyle();
        let bar = document.getElementById('pmv-header-bar');
        const measure = hdrDirty || !hdrRow?.isConnected || !bar || bar.style.display === 'none';
        const row = headerControlRow();
        if (!row) {
            if (bar && bar.style.display !== 'none') bar.style.display = 'none';
            return null;
        }
        if (row.getAttribute('data-pmv-headroom') !== '1') row.setAttribute('data-pmv-headroom', '1');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'pmv-header-bar';
            // Above the header background (z-50), below the site's modals.
            bar.style.cssText = 'position:fixed;z-index:60;display:flex;align-items:center;gap:12px;';
            // Hairline marking these as an add-on group.
            const divider = document.createElement('span');
            divider.setAttribute('data-pmv-header-divider', '1');
            divider.style.cssText = 'width:1px;height:20px;background:rgba(255,255,255,0.12);flex-shrink:0;pointer-events:none;';
            bar.appendChild(divider);
            document.body.appendChild(bar);
            // The counter's text changes the bar's width: keep the reserved room in step.
            try {
                new ResizeObserver(() => {
                    const w = Math.max(HEADER_GAP_PX, Math.ceil(bar.offsetWidth || 0)) + 'px';
                    if (document.documentElement.style.getPropertyValue('--pmv-headroom') !== w) document.documentElement.style.setProperty('--pmv-headroom', w);
                }).observe(bar);
            } catch {}
        }
        if (!measure && bar.style.display === 'flex') return bar;
        const r = row.getBoundingClientRect();
        const top = `${Math.round(r.top + (r.height - 36) / 2)}px`;
        if (bar.style.display !== 'flex') bar.style.display = 'flex';
        // Room for whatever the bar holds (the hidden-videos counter comes and goes).
        const w = Math.max(HEADER_GAP_PX, Math.ceil(bar.offsetWidth || 0));
        const room = w + 'px';
        if (document.documentElement.style.getPropertyValue('--pmv-headroom') !== room) document.documentElement.style.setProperty('--pmv-headroom', room);
        // Anchored on the right edge, so a wider bar grows to the left instead of off the page.
        const right = `${Math.max(0, Math.round(document.documentElement.clientWidth - r.right + 8))}px`;
        if (bar.style.top !== top) bar.style.top = top;
        if (bar.style.left) bar.style.left = '';
        if (bar.style.right !== right) bar.style.right = right;
        return bar;
    }

    function ensureHeaderButton(bar, attr, icon, onClick, extraHtml) {
        let btn = bar.querySelector(`[${attr}]`);
        if (btn) return btn;
        btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute(attr, '1');
        btn.style.cssText = 'position:relative;width:36px;height:36px;padding:0;display:flex;' +
            'align-items:center;justify-content:center;background:transparent;border:0;' +
            'border-radius:8px;cursor:pointer;';
        btn.innerHTML = icon + (extraHtml || '');
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onClick(btn); });
        bar.appendChild(btn);
        return btn;
    }

    function ensureHeaderButtons() {
        const bar = ensureHeaderBar();
        if (!bar) return;
        // ⊘ with a red corner badge holding the hidden count (like the Up next badge).
        const hb = ensureHeaderButton(bar, 'data-pmv-hidden-btn',
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>' +
            `<span data-pmv-hidden-count style="position:absolute;top:0;right:0;min-width:15px;height:15px;line-height:15px;padding:0 3px;border-radius:8px;background:rgb(${REJECT_RGB});color:#000;font-size:10px;font-weight:700;text-align:center;font-variant-numeric:tabular-nums;"></span>`,
            btn => toggleHiddenPanel(btn));
        if (!hb.dataset.styled) {
            hb.dataset.styled = '1';
            hb.style.color = 'rgb(156,163,175)';
            hb.style.display = 'none';
        }
        ensureHeaderButton(bar, 'data-pmv-filter-btn', FILTER_ICON, btn => toggleFilterPanel(btn));
        ensureHeaderButton(bar, 'data-pmv-queue-btn', QUEUE_ICON, btn => toggleQueueFloating(btn), QUEUE_BADGE_HTML);
        // Remove stale in-row nodes.
        document.querySelectorAll('[data-pmv-hidden-btn], [data-pmv-filter-btn], [data-pmv-queue-btn]').forEach(btn => {
            if (!bar.contains(btn)) btn.remove();
        });
        updateFilterButton();
        updateQueueButton();
    }

    function attachFilterButton() { ensureHeaderButtons(); }

    // Painted via SVG presentation attributes, not CSS `color`: an inline `color !important` still
    // computes to the site's grey, so currentColor is unusable here.
    function setBtnColor(btn, color) {
        const svg = btn.querySelector('svg');
        if (!svg) return;
        if (svg.getAttribute('stroke') !== color) svg.setAttribute('stroke', color);
        svg.querySelectorAll('[data-pmv-fill]').forEach(el => {
            if (el.getAttribute('fill') !== color) el.setAttribute('fill', color);
        });
    }

    function updateFilterButton() {
        const on = filterConfig.active && filterIsMeaningful();
        const title = on
            ? `Filter on \u2014 ${filterHiddenCount} hidden on this page`
            : (filterIsMeaningful() ? 'Filter off (click to open)' : 'Filter');
        document.querySelectorAll('[data-pmv-filter-btn]').forEach(btn => {
            setBtnColor(btn, on ? 'rgb(100, 255, 0)' : 'rgb(156, 163, 175)');
            if (btn.title !== title) btn.title = title;
        });
        // "⊘ hidden/total" next to the funnel, only while the filter hides something here.
        const n = filterHiddenLog.size, total = Math.max(filterSeen.size, n);
        const txt = n > 999 ? '999+' : String(n);
        document.querySelectorAll('[data-pmv-hidden-btn]').forEach(btn => {
            const show = on && n > 0;
            const disp = show ? 'flex' : 'none';
            if (btn.style.display !== disp) { btn.style.display = disp; hdrDirty = true; requestAnimationFrame(() => { try { ensureHeaderBar(); } catch {} }); }
            const label = btn.querySelector('[data-pmv-hidden-count]');
            if (label && label.textContent !== txt) label.textContent = txt;
            btn.title = `${n} of ${total} videos on this page hidden by your filter — click for the list`;
        });
        const panel = document.getElementById('pmv-hidden-panel');
        if (panel && panel.dataset.sig !== String(n) + '/' + total) renderHiddenPanel(panel);
    }

    // A hidden card's image often never loads (lazy, display:none): fall back to cached video data.
    function cardThumbUrl(el, id, meta) {
        const img = el.querySelector('img');
        const fromImg = img && (img.currentSrc || img.getAttribute('src') || img.dataset?.src || (img.getAttribute('srcset') || '').split(/\s+/)[0]);
        const ok = u => u && !u.startsWith('data:') ? u : '';
        return ok(fromImg) || ok(meta?.thumbnailUrl) || (id ? ok(State.videoMeta.get(id)?.thumbnailUrl) || ok(resolveQueueMeta(id)?.thumbnailUrl) : '') || '';
    }

    // List of the videos the filter hid on this page, grouped by reason: one foldable row per reason
    // ("10 in playlist ›"), largest first. Ratings and lengths share one row each.
    const hiddenOpenGroups = new Set();
    function hiddenGroupKey(reason) {
        if (/^rating \d+%$/.test(reason)) return 'rating';
        if (/^over \d+ min$/.test(reason)) return 'too long';
        return reason;
    }
    function renderHiddenPanel(box) {
        const items = [...filterHiddenLog.values()];
        items.forEach(it => { if (!it.thumb && it.id) it.thumb = State.videoMeta.get(it.id)?.thumbnailUrl || resolveQueueMeta(it.id)?.thumbnailUrl || ''; });
        const total = Math.max(filterSeen.size, items.length);
        box.dataset.sig = items.length + '/' + total;
        const chip = r => `<span style="display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:500;background:rgba(${REJECT_RGB},0.12);border:1px solid rgba(${REJECT_RGB},0.45);color:rgb(${REJECT_RGB});white-space:nowrap;">${escHtml(r)}</span>`;
        const groups = new Map();
        items.forEach(it => {
            const key = hiddenGroupKey(it.reasons[0] || 'filtered');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(it);
        });
        const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
        const CHEV = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;transition:transform .15s;"><path d="m9 18 6-6-6-6"/></svg>';
        const rowHtml = (it, g, k) => `
                <a data-g="${g}" data-k="${k}" href="${escHtml(it.href || '#')}" style="display:flex;gap:10px;align-items:flex-start;padding:6px;border-radius:8px;text-decoration:none;color:inherit;">
                    <div style="width:96px;aspect-ratio:16/9;flex-shrink:0;border-radius:6px;overflow:hidden;background:#0F0F0F;">${it.thumb ? `<img src="${escHtml(it.thumb)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">` : ''}</div>
                    <div style="min-width:0;flex:1;">
                        <div style="font-size:13px;line-height:1.3;color:#fff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escHtml(it.title)}</div>
                        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">${it.reasons.slice(0, 4).map(chip).join('')}</div>
                    </div>
                </a>`;
        box.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
                <strong style="font-size:14px;">Hidden by your filter</strong>
                <button type="button" data-act="edit" class="${Q_CHIP_OFF}" style="cursor:pointer;">Edit filter</button>
            </div>
            <div style="font-size:12px;color:rgb(107,114,128);margin-bottom:8px;">${items.length} of ${total} videos on this page</div>
            ${ordered.length ? ordered.map(([key, list], g) => {
                const open = hiddenOpenGroups.has(key);
                return `
                <div data-group="${g}" style="border-top:1px solid #1F1F1F;">
                    <button type="button" data-toggle="${g}" style="display:flex;align-items:center;gap:8px;width:100%;padding:9px 4px;background:none;border:none;color:#fff;cursor:pointer;font-family:inherit;font-size:13px;text-align:left;">
                        <span style="min-width:22px;font-weight:700;color:rgb(${REJECT_RGB});font-variant-numeric:tabular-nums;">${list.length}</span>
                        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(key)}</span>
                        <span data-chev style="display:inline-flex;color:rgb(156,163,175);${open ? 'transform:rotate(90deg);' : ''}">${CHEV}</span>
                    </button>
                    <div data-list="${g}"${open ? '' : ' hidden'} style="padding-bottom:6px;">${open ? list.map((it, k) => rowHtml(it, g, k)).join('') : ''}</div>
                </div>`;
            }).join('') : '<div style="font-size:12px;color:rgb(107,114,128);">Nothing hidden.</div>'}`;
        const wireRows = scope => scope.querySelectorAll('a[data-g]').forEach(a => {
            a.onmouseenter = () => { a.style.background = 'rgba(255,255,255,0.06)'; };
            a.onmouseleave = () => { a.style.background = ''; };
            a.onclick = e => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                const it = ordered[+a.dataset.g]?.[1][+a.dataset.k];
                box.remove();
                if (it?.href) siteNavigate(it.href);
            };
        });
        box.querySelectorAll('[data-toggle]').forEach(btn => {
            btn.onclick = e => {
                e.stopPropagation();
                const g = +btn.dataset.toggle;
                const [key, list] = ordered[g];
                const listEl = box.querySelector(`[data-list="${g}"]`);
                const chev = btn.querySelector('[data-chev]');
                const open = listEl.hidden;
                if (open) { hiddenOpenGroups.add(key); listEl.innerHTML = list.map((it, k) => rowHtml(it, g, k)).join(''); wireRows(listEl); }
                else hiddenOpenGroups.delete(key);
                listEl.hidden = !open;
                chev.style.transform = open ? 'rotate(90deg)' : '';
            };
        });
        wireRows(box);
        box.querySelector('[data-act="edit"]').onclick = e => {
            e.stopPropagation();
            box.remove();
            const fb = [...document.querySelectorAll('[data-pmv-filter-btn]')].find(b => b.getClientRects().length);
            if (fb) toggleFilterPanel(fb);
        };
    }

    function toggleHiddenPanel(anchorBtn) {
        const existing = document.getElementById('pmv-hidden-panel');
        if (existing) { existing.remove(); return; }
        const box = document.createElement('div');
        box.id = 'pmv-hidden-panel';
        const r = anchorBtn.getBoundingClientRect();
        box.style.cssText =
            'position:fixed;z-index:999999;width:420px;max-width:calc(100vw - 16px);max-height:calc(100vh - 90px);overflow:auto;' +
            `top:${Math.round(r.bottom + 8)}px;left:${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 428)))}px;` +
            'background:rgba(0,0,0,0.92);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.14);' +
            'border-radius:12px;padding:12px;color:white;box-shadow:0 10px 40px rgba(0,0,0,0.6);font-family:inherit;';
        document.body.appendChild(box);
        renderHiddenPanel(box);
        setTimeout(() => {
            const onDocClick = e => {
                if (!box.isConnected) { document.removeEventListener('click', onDocClick); return; }
                const path = e.composedPath ? e.composedPath() : [];
                if (path.includes(box) || box.contains(e.target) || e.target.closest('[data-pmv-hidden-btn]')) return;
                box.remove();
                document.removeEventListener('click', onDocClick);
            };
            document.addEventListener('click', onDocClick);
        }, 0);
    }

    // ---------------------------------------------------------------------
    // Site-wide filter panel
    // ---------------------------------------------------------------------
    // In the style of the playlist-page filter drawer: uppercase section labels, term chips (click a
    // chip: whole word only), choice chips, dual sliders with a pill and presets, site-style dropdowns.
    // Changes are staged in a draft and saved by Apply; the on/off switch acts at once.
    const GF_SVG = {
        ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>',
        x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    };
    function ensureGfStyle() {
        if (document.getElementById('pmv-gf-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-gf-style';
        st.textContent = `
#pmv-filter-panel{position:fixed;z-index:999999;width:360px;max-width:calc(100vw - 16px);max-height:calc(100vh - 90px);display:flex;flex-direction:column;
  background:#1A1A1A;border:1px solid #2A2A2A;border-radius:12px;color:#fff;font-family:inherit;box-shadow:0 12px 40px rgba(0,0,0,0.6);overflow:hidden;}
#pmv-filter-panel *{box-sizing:border-box;}
#pmv-filter-panel .gf-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #2A2A2A;}
#pmv-filter-panel .gf-head strong{font-size:14px;font-weight:600;}
#pmv-filter-panel .gf-head .gf-sub{font-size:11px;color:rgb(107,114,128);margin-left:auto;font-variant-numeric:tabular-nums;}
#pmv-filter-panel .gf-sw{position:relative;width:36px;height:20px;border-radius:9999px;border:none;padding:0;cursor:pointer;background:#3A3A3A;flex-shrink:0;transition:background .15s;}
#pmv-filter-panel .gf-sw::after{content:'';position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s;}
#pmv-filter-panel .gf-sw[aria-checked="true"]{background:rgb(249,115,22);}
#pmv-filter-panel .gf-sw[aria-checked="true"]::after{transform:translateX(16px);}
#pmv-filter-panel .gf-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px 8px;display:flex;flex-direction:column;gap:12px;}
#pmv-filter-panel .gf-sec{display:flex;flex-direction:column;gap:5px;}
#pmv-filter-panel .gf-lab{font-size:10px;font-weight:600;color:rgb(156,163,175);text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:6px;}
#pmv-filter-panel .gf-hint{font-size:10px;color:rgba(255,255,255,0.35);line-height:1.4;}
#pmv-filter-panel input[type=text], #pmv-filter-panel input[type=number]{width:100%;padding:6px 10px;border-radius:4px;border:none;outline:none;background:#272727;color:rgb(229,231,235);font-size:12px;font-family:inherit;}
#pmv-filter-panel input[type=text]:focus, #pmv-filter-panel input[type=number]:focus{background:#323232;outline:none;box-shadow:none;}
#pmv-filter-panel input::placeholder{color:rgb(107,114,128);}
#pmv-filter-panel .gf-chips{display:flex;flex-wrap:wrap;gap:4px;}
#pmv-filter-panel .gf-chips:empty{display:none;}
#pmv-filter-panel .gf-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:4px;font-size:11px;line-height:16px;}
#pmv-filter-panel .gf-tag svg{width:10px;height:10px;}
#pmv-filter-panel .gf-tag .txt{cursor:pointer;}
#pmv-filter-panel .gf-tag .x{display:inline-flex;opacity:.6;padding:2px;border-radius:3px;cursor:pointer;}
#pmv-filter-panel .gf-tag .x:hover{opacity:1;background:rgba(255,255,255,0.12);}
#pmv-filter-panel .gf-tag.pos{background:rgba(249,115,22,0.2);color:rgb(253,186,116);}
#pmv-filter-panel .gf-tag.neg{background:rgba(239,68,68,0.2);color:rgb(252,165,165);}
#pmv-filter-panel .gf-tag.neg .txt{text-decoration:line-through;}
#pmv-filter-panel .gf-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:4px;border:none;cursor:pointer;background:#272727;color:rgb(209,213,219);
  font-size:11px;font-weight:500;line-height:1.2;font-family:inherit;white-space:nowrap;}
#pmv-filter-panel .gf-chip:hover{background:#323232;}
#pmv-filter-panel .gf-chip.active{background:rgb(249,115,22);color:#fff;}
#pmv-filter-panel .gf-chip.active.in{background:rgb(34,197,94);} #pmv-filter-panel .gf-chip.active.out{background:rgb(239,68,68);}
#pmv-filter-panel .gf-pillrow{display:flex;justify-content:center;}
#pmv-filter-panel .gf-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:9999px;background:rgba(249,115,22,0.12);color:rgb(249,115,22);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;}
#pmv-filter-panel .gf-pill .sep{color:rgba(249,115,22,0.5);}
#pmv-filter-panel .gf-slider{position:relative;height:26px;}
#pmv-filter-panel .gf-slider .track{position:absolute;top:11px;left:0;right:0;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);}
#pmv-filter-panel .gf-slider .fill{position:absolute;top:11px;height:4px;border-radius:2px;background:linear-gradient(90deg,rgb(249,115,22),rgb(251,146,60));}
#pmv-filter-panel .gf-slider input[type=range]{position:absolute;top:11px;left:0;width:100%;height:4px;margin:0;padding:0;-webkit-appearance:none;appearance:none;background:transparent;pointer-events:none;outline:none;}
#pmv-filter-panel .gf-slider input[type=range]::-webkit-slider-runnable-track{background:transparent;height:4px;}
#pmv-filter-panel .gf-slider input[type=range]::-moz-range-track{background:transparent;height:4px;border:none;}
#pmv-filter-panel .gf-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;border:3px solid rgb(249,115,22);box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;}
#pmv-filter-panel .gf-slider input[type=range]::-moz-range-thumb{pointer-events:auto;width:8px;height:8px;border-radius:50%;background:#fff;border:3px solid rgb(249,115,22);cursor:pointer;}
#pmv-filter-panel .gf-sliderlabels{display:flex;justify-content:space-between;color:rgba(255,255,255,0.35);font-size:10px;margin-top:-4px;}
#pmv-filter-panel .gf-sel{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border-radius:6px;cursor:pointer;text-align:left;background:#0F0F0F;border:1px solid #2A2A2A;color:#fff;font-size:12px;font-family:inherit;}
#pmv-filter-panel .gf-sel:hover{border-color:#3A3A3A;}
#pmv-filter-panel .gf-sel[data-open="1"]{border-color:rgb(249,115,22);}
#pmv-filter-panel .gf-sel .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#pmv-filter-panel .gf-sel .t.ph{color:rgb(107,114,128);}
#pmv-filter-panel .gf-sel svg{width:14px;height:14px;color:rgb(156,163,175);flex-shrink:0;transition:transform .15s;}
#pmv-filter-panel .gf-sel[data-open="1"] svg{transform:rotate(180deg);}
#pmv-filter-panel .gf-more{background:none;border:none;color:rgb(156,163,175);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;cursor:pointer;padding:0;display:flex;align-items:center;gap:4px;font-family:inherit;}
#pmv-filter-panel .gf-more svg{width:12px;height:12px;transition:transform .15s;}
#pmv-filter-panel .gf-more[data-open="1"] svg{transform:rotate(180deg);}
#pmv-filter-panel .gf-row{display:flex;align-items:center;gap:8px;font-size:11px;color:rgb(209,213,219);}
#pmv-filter-panel .gf-row input[type=number]{width:64px;}
#pmv-filter-panel .gf-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 16px;border-top:1px solid #2A2A2A;background:#1A1A1A;}
#pmv-filter-panel .gf-apply{padding:6px 12px;border-radius:4px;border:none;cursor:pointer;background:rgb(249,115,22);color:#fff;font-size:11px;font-weight:600;font-family:inherit;}
#pmv-filter-panel .gf-apply:hover{background:rgb(234,88,12);}
#pmv-filter-panel .gf-apply.pending{box-shadow:0 0 0 2px rgba(249,115,22,0.35);}
#pmv-filter-panel .gf-ghost{padding:6px 10px;border-radius:4px;border:none;cursor:pointer;background:#272727;color:rgb(209,213,219);font-size:11px;font-weight:500;font-family:inherit;}
#pmv-filter-panel .gf-ghost:hover{background:#323232;}
#pmv-filter-panel .gf-status{margin-left:auto;font-size:10px;color:rgba(255,255,255,0.4);font-variant-numeric:tabular-nums;}
.pmv-gf-dd{position:fixed;z-index:1000000;min-width:220px;max-height:min(60vh,420px);overflow-y:auto;border-radius:10px;background:#141414;border:1px solid rgba(249,115,22,0.45);box-shadow:0 12px 32px rgba(0,0,0,0.6);font-family:inherit;}
.pmv-gf-dd .row{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;border-bottom:1px solid #1F1F1F;}
.pmv-gf-dd .row:last-child{border-bottom:none;}
.pmv-gf-dd .row:hover{background:rgba(255,255,255,0.04);}
.pmv-gf-dd .row[data-sel="1"]{background:rgba(249,115,22,0.12);}
.pmv-gf-dd .tt{flex:1;min-width:0;}
.pmv-gf-dd .ti{display:block;color:#fff;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmv-gf-dd .su{display:block;color:rgb(156,163,175);font-size:10px;margin-top:1px;}
.pmv-gf-dd svg{width:14px;height:14px;color:rgb(249,115,22);flex-shrink:0;visibility:hidden;}
.pmv-gf-dd .row[data-sel="1"] svg{visibility:visible;}
.pmv-gf-dd .empty{padding:10px 12px;color:rgb(156,163,175);font-size:11px;}`;
        (document.head || document.documentElement).appendChild(st);
    }

    function closeGfDropdown() { document.querySelectorAll('.pmv-gf-dd').forEach(d => d.remove()); document.querySelectorAll('#pmv-filter-panel .gf-sel[data-open="1"]').forEach(b => { b.dataset.open = '0'; }); }

    // Site-style custom select. items(): [{ value, title, sub }]; multi keeps the list open.
    function gfSelect({ placeholder, items, label, isSelected, onPick, multi = false }) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gf-sel';
        btn.innerHTML = `<span class="t"></span>${GF_SVG.chev}`;
        const paint = () => {
            const t = btn.querySelector('.t');
            const txt = label();
            t.textContent = txt || placeholder;
            t.classList.toggle('ph', !txt);
        };
        const open = async () => {
            closeGfDropdown();
            btn.dataset.open = '1';
            const dd = document.createElement('div');
            dd.className = 'pmv-gf-dd';
            const r = btn.getBoundingClientRect();
            dd.style.left = Math.round(r.left) + 'px';
            dd.style.width = Math.round(Math.max(r.width, 220)) + 'px';
            dd.style.top = Math.round(r.bottom + 6) + 'px';
            document.body.appendChild(dd);
            const draw = async () => {
                const list = await items();
                dd.textContent = '';
                if (!list.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Nothing to choose'; dd.appendChild(e); return; }
                list.forEach(it => {
                    const row = document.createElement('div');
                    row.className = 'row';
                    row.dataset.sel = isSelected(it.value) ? '1' : '0';
                    row.innerHTML = `<div class="tt"><span class="ti"></span>${it.sub ? '<span class="su"></span>' : ''}</div>${GF_SVG.check}`;
                    row.querySelector('.ti').textContent = it.title;
                    if (it.sub) row.querySelector('.su').textContent = it.sub;
                    row.onclick = e => {
                        e.stopPropagation();
                        onPick(it.value, it);
                        paint();
                        if (multi) draw(); else closeGfDropdown();
                    };
                    dd.appendChild(row);
                });
                // Keep it on screen.
                const dr = dd.getBoundingClientRect();
                if (dr.bottom > innerHeight - 8) dd.style.top = Math.max(8, Math.round(r.top - dr.height - 6)) + 'px';
            };
            draw();
        };
        btn.onclick = e => { e.stopPropagation(); if (btn.dataset.open === '1') closeGfDropdown(); else open(); };
        paint();
        btn.paint = paint;
        return btn;
    }

    // Dual slider 0..max with a pill and preset chips. get() -> [a, b]; set(a, b).
    function gfRange({ max, get, set, fmt, presets }) {
        const wrap = document.createElement('div');
        wrap.innerHTML = `<div class="gf-pillrow"><span class="gf-pill"><span class="a"></span><span class="sep">-</span><span class="b"></span></span></div>
            <div class="gf-slider"><div class="track"></div><div class="fill"></div><input type="range" min="0" max="${max}" step="1"><input type="range" min="0" max="${max}" step="1"></div>
            <div class="gf-sliderlabels"><span>${fmt(0, 'a')}</span><span>${fmt(max, 'b')}</span></div><div class="gf-chips" style="margin-top:4px;"></div>`;
        const [rA, rB] = wrap.querySelectorAll('input[type=range]');
        const fill = wrap.querySelector('.fill'), pa = wrap.querySelector('.a'), pb = wrap.querySelector('.b');
        const chips = wrap.querySelector('.gf-chips');
        const paint = (a, b) => {
            pa.textContent = fmt(a, 'a'); pb.textContent = fmt(b, 'b');
            fill.style.left = (a / max * 100) + '%'; fill.style.width = ((b - a) / max * 100) + '%';
        };
        const render = () => {
            const [a, b] = get();
            rA.value = String(a); rB.value = String(b);
            paint(a, b);
            chips.querySelectorAll('.gf-chip').forEach((c, k) => c.classList.toggle('active', presets[k].a === a && presets[k].b === b));
        };
        presets.forEach(p => {
            const c = document.createElement('button');
            c.type = 'button'; c.className = 'gf-chip'; c.textContent = p.t;
            c.onclick = () => { set(p.a, p.b); render(); };
            chips.appendChild(c);
        });
        const drag = which => () => {
            let a = +rA.value, b = +rB.value;
            if (a > b) { if (which === 'a') { b = a; rB.value = String(b); } else { a = b; rA.value = String(a); } }
            paint(a, b);
        };
        rA.addEventListener('input', drag('a')); rB.addEventListener('input', drag('b'));
        const release = () => { set(+rA.value, +rB.value); render(); };
        rA.addEventListener('change', release); rB.addEventListener('change', release);
        render();
        wrap.render = render;
        return wrap;
    }

    // The site-wide filter as plain values, for the playlist page filter's "Sync from site filter".
    PMVX.siteFilterSnapshot = () => ({
        include: filterTerms(filterConfig.include), exclude: filterTerms(filterConfig.exclude),
        seen: filterConfig.seen, playlistMode: filterConfig.playlistMode, playlistIds: (filterConfig.playlistIds || []).slice(),
        ratingMin: filterConfig.ratingMin, ratingMax: filterConfig.ratingMax, maxMinutes: filterConfig.maxMinutes,
        flags: { ...(filterConfig.flags || {}) },
    });

    function toggleFilterPanel(anchorBtn) {
        const existing = document.getElementById('pmv-filter-panel');
        if (existing) { existing.remove(); closeGfDropdown(); return; }
        ensureGfStyle();

        // Mounted on document.body, outside Vue's tree, so header re-renders cannot remove the open panel.
        const box = document.createElement('div');
        box.id = 'pmv-filter-panel';
        const r = anchorBtn.getBoundingClientRect();
        box.style.top = Math.round(r.bottom + 8) + 'px';
        box.style.left = Math.round(Math.max(8, Math.min(r.right - 360, window.innerWidth - 368))) + 'px';
        document.body.appendChild(box);

        // Draft: everything but the on/off switch waits for Apply.
        let d = JSON.parse(JSON.stringify(filterConfig));
        const sigOf = c => JSON.stringify({ ...c, active: null });
        const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
        const sec = (label, hint) => { const s2 = mk('div', 'gf-sec'); s2.appendChild(mk('div', 'gf-lab', label)); if (hint) s2.dataset.hint = hint; return s2; };
        let status = () => {};
        const refreshPending = () => { const p = sigOf(d) !== sigOf(filterConfig); applyBtn.classList.toggle('pending', p); applyBtn.textContent = p ? 'Apply' : 'Applied'; };

        // Head: title, hidden count, on/off switch (immediate)
        const head = mk('div', 'gf-head');
        head.appendChild(mk('strong', null, 'Filter'));
        const sub = mk('span', 'gf-sub');
        const paintSub = () => { sub.textContent = filterConfig.active && filterIsMeaningful() ? `${filterHiddenCount} hidden on this page` : (filterConfig.active ? 'on' : 'off'); };
        paintSub();
        const sw = mk('button', 'gf-sw');
        sw.type = 'button'; sw.setAttribute('role', 'switch');
        const paintSw = () => { sw.setAttribute('aria-checked', filterConfig.active ? 'true' : 'false'); sw.title = filterConfig.active ? 'Filter on — click to show everything' : 'Filter off — click to hide matching videos'; };
        paintSw();
        sw.onclick = () => {
            filterConfig.active = !filterConfig.active; d.active = filterConfig.active;
            saveFilterConfig(); applyFilterToCards(); paintSw(); paintSub();
        };
        head.append(sub, sw);
        box.appendChild(head);

        const body = mk('div', 'gf-body');
        box.appendChild(body);

        // Term chips (exclude / require): Enter adds, click a chip toggles whole word, × removes.
        const termSection = (key, label, placeholder, kind) => {
            const s2 = sec(label);
            const inp = mk('input'); inp.type = 'text'; inp.placeholder = placeholder; inp.spellcheck = false;
            const chips = mk('div', 'gf-chips');
            const draw = () => {
                chips.textContent = '';
                filterTerms(d[key]).forEach((t, i, all) => {
                    const c = mk('span', 'gf-tag ' + kind);
                    if (kind === 'neg') { const ic = mk('span'); ic.innerHTML = GF_SVG.ban; ic.style.display = 'inline-flex'; c.appendChild(ic); }
                    const word = PMVX.isWordTerm(t);
                    const tx = mk('span', 'txt', word ? `"${PMVX.termLabel(t)}"` : t);
                    tx.title = word ? 'Whole word only — click to match anywhere in the text' : 'Matches anywhere in the text — click to match it only as a whole word';
                    tx.onclick = () => { const next = all.slice(); next[i] = word ? PMVX.termLabel(t) : '=' + t; d[key] = joinFilterTerms(next); draw(); refreshPending(); };
                    const x = mk('span', 'x'); x.innerHTML = GF_SVG.x; x.title = 'Remove';
                    x.onclick = () => { d[key] = joinFilterTerms(all.filter((_, k) => k !== i)); draw(); refreshPending(); };
                    c.append(tx, x);
                    chips.appendChild(c);
                });
            };
            inp.addEventListener('keydown', e => {
                e.stopPropagation(); // site and script hotkeys stay out of the field
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = inp.value.trim();
                    if (!v) { applyBtn.click(); return; }
                    const add = filterTerms(v);
                    const cur = filterTerms(d[key]);
                    add.forEach(t => { if (!cur.includes(t)) cur.push(t); });
                    d[key] = joinFilterTerms(cur);
                    // A term cannot be both required and excluded.
                    const other = key === 'exclude' ? 'include' : 'exclude';
                    d[other] = joinFilterTerms(filterTerms(d[other]).filter(t => !add.includes(t)));
                    inp.value = '';
                    drawAllTerms(); refreshPending();
                } else if (e.key === 'Backspace' && !inp.value) {
                    const cur = filterTerms(d[key]); cur.pop(); d[key] = joinFilterTerms(cur); draw(); refreshPending();
                }
            });
            s2.append(inp, chips);
            s2.draw = draw;
            draw();
            return s2;
        };
        const sExc = termSection('exclude', 'Exclude', 'Hide videos with… (title, tag, performer, uploader)', 'neg');
        const sInc = termSection('include', 'Require', 'Only videos with…', 'pos');
        const drawAllTerms = () => { sExc.draw(); sInc.draw(); };
        const hint = mk('div', 'gf-hint', 'Enter adds · Backspace in an empty field removes the last one · "quotes" or a click on a term: whole word only');
        body.append(sExc, sInc, hint);

        // Choice chips
        const choice = (label, opts, get, set) => {
            const s2 = sec(label);
            const row = mk('div', 'gf-chips');
            const btns = opts.map(o => {
                const b = mk('button', 'gf-chip ' + (o.cls || ''), o.t);
                b.type = 'button'; if (o.title) b.title = o.title;
                b.onclick = () => { set(o.v); paint(); refreshPending(); };
                row.appendChild(b);
                return b;
            });
            const paint = () => btns.forEach((b, k) => b.classList.toggle('active', get() === opts[k].v));
            paint();
            s2.appendChild(row);
            return s2;
        };

        // Playlist mode + which playlists count (dropdown, multi)
        const sPl = choice('Playlist', [
            { v: 'all', t: 'All' }, { v: 'in', t: '✓ In playlist', cls: 'in' }, { v: 'out', t: '✕ Not in playlist', cls: 'out' },
        ], () => d.playlistMode, v => { d.playlistMode = v; plSel.style.display = v === 'all' ? 'none' : ''; });
        const plSel = gfSelect({
            placeholder: 'Any playlist',
            label: () => { const n = d.playlistIds.length; if (!n) return ''; if (n === 1) { const p = State.playlists.get(d.playlistIds[0]); return p ? getPlaylistDisplayName(p.name, p.id) : '1 playlist'; } return `${n} playlists`; },
            items: () => [...State.playlists.values()].sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
                .map(p => ({ value: p.id, title: getPlaylistDisplayName(p.name, p.id) || p.name, sub: `${p.ids.size} videos` })),
            isSelected: v => d.playlistIds.includes(v),
            onPick: v => { d.playlistIds = d.playlistIds.includes(v) ? d.playlistIds.filter(x => x !== v) : [...d.playlistIds, v]; refreshPending(); },
            multi: true,
        });
        plSel.style.display = d.playlistMode === 'all' ? 'none' : '';
        sPl.appendChild(plSel);
        body.appendChild(sPl);

        body.appendChild(choice('Watched', [
            { v: 'any', t: 'All' }, { v: 'unseen', t: 'Unwatched' }, { v: 'seen', t: 'Watched' },
        ], () => d.seen, v => { d.seen = v; }));

        // Content flags: off -> hide (⊘) -> only these (✓) -> off, like the playlist choice.
        const sFlags = sec('Content');
        const fRow = mk('div', 'gf-chips');
        CONTENT_FLAGS.forEach(([key, label]) => {
            const b = mk('button', 'gf-chip');
            b.type = 'button';
            const paint = () => {
                const m = d.flags?.[key];
                b.className = 'gf-chip' + (m ? ' active ' + m : '');
                b.textContent = (m === 'out' ? '\u2298 ' : m === 'in' ? '\u2713 ' : '') + label;
                b.title = m === 'out' ? `Hides videos flagged ${label} \u2014 click: only these`
                    : m === 'in' ? `Only videos flagged ${label} \u2014 click: off`
                    : `Click: hide videos flagged ${label}`;
            };
            paint();
            b.onclick = () => {
                const f = { ...(d.flags || {}) };
                const m = f[key];
                if (!m) f[key] = 'out'; else if (m === 'out') f[key] = 'in'; else delete f[key];
                d.flags = f;
                paint(); refreshPending();
            };
            fRow.appendChild(b);
        });
        sFlags.appendChild(fRow);
        sFlags.appendChild(mk('div', 'gf-hint', 'Click: hide (\u2298) \u2192 only these (\u2713) \u2192 off. Videos whose flag is not known yet stay visible.'));
        body.appendChild(sFlags);

        // Rating
        const sRate = sec('Rating');
        sRate.appendChild(gfRange({
            max: 100,
            get: () => [d.ratingMin || 0, d.ratingMax ?? 100],
            set: (a, b) => { d.ratingMin = a; d.ratingMax = b; refreshPending(); },
            fmt: (v, side) => side === 'b' && v >= 100 ? 'Any' : v + '%',
            presets: [{ t: 'Any', a: 0, b: 100 }, { t: '90%+', a: 90, b: 100 }, { t: '80%+', a: 80, b: 100 }, { t: '70%+', a: 70, b: 100 }, { t: '50-80%', a: 50, b: 80 }],
        }));
        body.appendChild(sRate);

        // Length: maximum only (0..60 min, 60 = any)
        const sLen = sec('Max length');
        const LEN_ANY = 60;
        const lenWrap = gfRange({
            max: LEN_ANY,
            get: () => [0, d.maxMinutes > 0 ? Math.min(d.maxMinutes, LEN_ANY) : LEN_ANY],
            set: (a, b) => { d.maxMinutes = b >= LEN_ANY ? 0 : b; refreshPending(); },
            fmt: (v, side) => side === 'b' && v >= LEN_ANY ? 'Any' : v + 'm',
            presets: [{ t: 'Any', a: 0, b: LEN_ANY }, { t: '≤5m', a: 0, b: 5 }, { t: '≤10m', a: 0, b: 10 }, { t: '≤20m', a: 0, b: 20 }, { t: '≤30m', a: 0, b: 30 }],
        });
        // Only the upper bound is used: hide the lower handle.
        lenWrap.querySelectorAll('input[type=range]')[0].style.display = 'none';
        sLen.appendChild(lenWrap);
        body.appendChild(sLen);

        // Saved search (lazy list)
        const sSs = sec('Saved search');
        const ssSel = gfSelect({
            placeholder: 'None',
            label: () => d.savedSearchName || '',
            items: async () => {
                const list = await fetchSavedSearches();
                return [{ value: '', title: 'None', sub: 'No saved search' }, ...list.map(ss => {
                    const name = ss.name || ss.title || '(unnamed)';
                    return { value: name, title: name, sub: [ss.excludeTags?.length ? `${ss.excludeTags.length} excluded tags` : '', ss.minRating ? `rating ${ss.minRating}%+` : ''].filter(Boolean).join(' · ') || 'Saved search', ss };
                })];
            },
            isSelected: v => (v || '') === (d.savedSearchName || ''),
            onPick: (v, it) => { d.savedSearch = v && it.ss ? parseSavedSearch(it.ss) : null; d.savedSearchName = v || ''; refreshPending(); },
        });
        sSs.appendChild(ssSel);
        body.appendChild(sSs);

        // Pagination (folded)
        const more = mk('button', 'gf-more'); more.type = 'button';
        more.innerHTML = `Pagination ${GF_SVG.chev}`;
        const pag = mk('div', 'gf-sec'); pag.hidden = true;
        more.onclick = () => { pag.hidden = !pag.hidden; more.dataset.open = pag.hidden ? '0' : '1'; };
        const toggleChip = (t, title, key) => {
            const b = mk('button', 'gf-chip', t); b.type = 'button'; b.title = title;
            const paint = () => b.classList.toggle('active', !!d[key]);
            b.onclick = () => { d[key] = !d[key]; paint(); refreshPending(); };
            paint();
            return b;
        };
        const pchips = mk('div', 'gf-chips');
        pchips.append(
            toggleChip('100 per page', "Sets the site's own 'videos per page' preference to 100, the most the API serves. Takes effect on the next page change or reload.", 'bigPages'),
            toggleChip('Pages instead of autoscroll', 'While the filter is hiding things, switch the site from autoscroll to pages, so videos your filter let through are not thrown away as more load.', 'pagedWhenFiltered'),
            toggleChip('One grid', 'Merge the batches the site renders into one grid, which keeps the rows full.', 'mergeGrids'),
        );
        const numRow = (label, title, key, maxV) => {
            const row = mk('label', 'gf-row'); row.title = title;
            row.appendChild(mk('span', null, label));
            const n = mk('input'); n.type = 'number'; n.min = '0'; n.max = String(maxV); n.value = d[key] || ''; n.placeholder = '0';
            n.addEventListener('keydown', e => e.stopPropagation());
            n.addEventListener('input', () => { d[key] = Math.max(0, Math.min(maxV, parseInt(n.value, 10) || 0)); refreshPending(); });
            row.appendChild(n);
            return row;
        };
        pag.append(pchips,
            numRow('Fill to', 'With autoscroll on: keep asking the site for more until this many videos survive the filter. 0 is off.', 'topUpTarget', 100),
            numRow('Skip pages under', 'With autoscroll off: skip to the next page when fewer than this many survive. 1 skips only empty pages, 0 is off.', 'skipBelow', 50));
        body.append(more, pag);

        // Actions
        const actions = mk('div', 'gf-actions');
        const applyBtn = mk('button', 'gf-apply', 'Applied'); applyBtn.type = 'button';
        const clearBtn = mk('button', 'gf-ghost', 'Clear'); clearBtn.type = 'button'; clearBtn.title = 'Reset every filter setting';
        const importBtn = mk('button', 'gf-ghost', 'Sync from playlists'); importBtn.type = 'button'; importBtn.title = 'Copy the filter of the playlist pages into this one';
        const st2 = mk('span', 'gf-status');
        status = msg => { st2.textContent = msg; };
        actions.append(applyBtn, clearBtn, importBtn, st2);
        box.appendChild(actions);

        const reopen = () => { box.remove(); closeGfDropdown(); toggleFilterPanel(anchorBtn); };
        applyBtn.onclick = () => {
            filterConfig = { ...JSON.parse(JSON.stringify(d)), active: filterConfig.active };
            saveFilterConfig();
            syncSitePrefs();
            if (filterConfig.mergeGrids) mergeListChunks(); else unmergeListChunks();
            applyFilterToCards();
            paintSub(); refreshPending();
            status(filterConfig.active ? `${filterHiddenCount} hidden on this page` : 'Saved — the filter is off');
        };
        clearBtn.onclick = () => {
            filterConfig = { ...FILTER_DEFAULTS };
            saveFilterConfig(); applyFilterToCards(); reopen();
        };
        importBtn.onclick = () => {
            const nf = loadNfFilter();
            if (!nf) { status('Nothing saved on the playlist pages'); return; }
            d = {
                ...d,
                exclude: joinFilterTerms(nf.tokens.textExclude),
                include: joinFilterTerms(nf.tokens.textInclude),
                ratingMin: nf.ratingMin, ratingMax: nf.ratingMax,
                maxMinutes: Number.isFinite(nf.durationMax) ? Math.round(nf.durationMax / 60) : 0,
                playlistMode: nf.playlistMode, playlistIds: nf.selectedPlaylistIds.slice(),
                seen: nf.tokens.seenFilter || 'any',
                flags: { ...nf.flags },
            };
            filterConfig = { ...d, active: filterConfig.active };
            saveFilterConfig(); reopen();
        };
        refreshPending();
        // External changes (a tag clicked in the HUD) redraw the open panel from the stored config.
        box.refresh = () => { d = JSON.parse(JSON.stringify(filterConfig)); reopen(); };

        // Deferred close: binding synchronously would catch the click that opened the panel.
        setTimeout(() => {
            const onDocClick = e => {
                if (!box.isConnected) { document.removeEventListener('click', onDocClick); return; }
                // composedPath: a chip redrawn by its own click is no longer in the box, but was.
                const path = e.composedPath ? e.composedPath() : [];
                if (path.includes(box) || box.contains(e.target) || !e.target.isConnected || e.target.closest('[data-pmv-filter-btn], .pmv-gf-dd')) return;
                closeGfDropdown();
                if (!e.target.closest('.gf-sel')) { box.remove(); document.removeEventListener('click', onDocClick); }
            };
            document.addEventListener('click', onDocClick);
        }, 0);
    }

    // ---------------------------------------------------------------------
    // Homepage state across Back / Forward
    // ---------------------------------------------------------------------
    // The site's homepage forgets its filters and starts over at page 1 when you come back to it. Its
    // own saved-search component gets two functions as props, getCurrentFilters() and onLoad(filters)
    // (the same pair "Saved searches" uses); they are found through Vue's vnode tree from #__nuxt.
    // While on the homepage the filters, list depth, page and scroll position are kept per tab
    // (sessionStorage); Back / Forward to the homepage puts them back. A fresh visit (logo, link) does not.
    // Only while logged in: the site renders that component only then.
    const HOME_STATE_KEY = 'pmvx_home_state_v1';
    function homeFilterProps() {
        const root = document.querySelector('#__nuxt')?._vnode;
        if (!root) return null;
        const seen = new Set(), stack = [root];
        while (stack.length) {
            const v = stack.pop();
            if (!v || typeof v !== 'object' || seen.has(v)) continue;
            seen.add(v);
            const pr = v.props;
            if (pr && typeof pr.getCurrentFilters === 'function' && typeof pr.onLoad === 'function') return pr;
            if (v.component) stack.push(v.component.subTree);
            if (v.suspense) stack.push(v.suspense.activeBranch);
            if (Array.isArray(v.children)) for (const c of v.children) stack.push(c);
            if (seen.size > 20000) break;
        }
        return null;
    }
    // "Saved Searches" next to "More Filters": the site keeps that button inside the folded filter
    // panel. The copy mirrors its icon, label and count and clicks the original, which opens the
    // site's own saved-searches dialog. Vue owns the row, so a 1 s check re-inserts it.
    function nativeSavedSearchesBtn() {
        return [...document.querySelectorAll('.filter-panel-wrapper button')]
            .find(b => !b.dataset.pmvSavedShortcut && /^Saved Searches/.test(b.textContent.trim())) || null;
    }
    function ensureSavedSearchShortcut() {
        const cur = document.querySelector('[data-pmv-saved-shortcut]');
        const mf = [...document.querySelectorAll('button')].find(b => !b.dataset.pmvSavedShortcut && b.textContent.trim() === 'More Filters');
        const native = mf ? nativeSavedSearchesBtn() : null;
        if (!mf || !native) { cur?.remove(); return; }
        let b = cur;
        if (!b || b.parentElement !== mf.parentElement) {
            cur?.remove();
            b = document.createElement('button');
            b.type = 'button';
            b.dataset.pmvSavedShortcut = '1';
            b.className = 'flex items-center gap-2 text-sm px-3 py-2.5 rounded-lg border transition-colors bg-[#1A1A1A] border-[#2A2A2A] hover:bg-[#232323] text-gray-300';
            b.style.flexShrink = '0';
            b.title = 'Saved searches';
            b.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                const n = nativeSavedSearchesBtn();
                if (n) n.click(); else toast('Saved searches not available');
            });
            mf.after(b);
        }
        if (b._pmvSrc !== native.innerHTML) {
            b._pmvSrc = native.innerHTML;
            b.innerHTML = native.innerHTML;
        }
    }
    setInterval(() => { try { ensureSavedSearchShortcut(); } catch {} }, 1000);

    const isHomePath = () => location.pathname === '/' || location.pathname === '';
    function homeListCount() { return document.querySelectorAll('[data-video-id]').length; }
    function captureHomeState() {
        if (!isHomePath() || homeRestoring) return;
        const pr = homeFilterProps();
        if (!pr) return;
        let filters;
        try { filters = JSON.parse(JSON.stringify(pr.getCurrentFilters() || {})); } catch { return; }
        const paging = siteListPaging();
        const state = { filters, count: homeListCount(), page: paging?.page || 1, infinite: !!paging?.infinite, scrollY: Math.round(scrollY), at: Date.now() };
        try { sessionStorage.setItem(HOME_STATE_KEY, JSON.stringify(state)); } catch {}
    }
    let homeRestoring = false;
    let homeBackNav = false;
    async function restoreHomeState() {
        homeRestoring = true;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        try {
            let saved;
            try { saved = JSON.parse(sessionStorage.getItem(HOME_STATE_KEY) || 'null'); } catch { saved = null; }
            if (!saved || Date.now() - saved.at > 6 * 60 * 60 * 1000) return;
            // Wait for the page and its filter component.
            let pr = null;
            for (let i = 0; i < 40 && isHomePath() && !(pr = homeFilterProps()); i++) await wait(250);
            if (!pr || !isHomePath()) return;
            const now = JSON.stringify(pr.getCurrentFilters() || {});
            if (now !== JSON.stringify(saved.filters || {})) {
                pr.onLoad(saved.filters || {});
                await wait(600);
            }
            // Same depth: pages mode → the saved page; autoscroll → load batches until the count is back.
            const paging = siteListPaging();
            if (paging && !paging.infinite && saved.page > 1) {
                for (let i = 0; i < 20 && siteListPaging()?.pending; i++) await wait(250);
                const btn = [...document.querySelectorAll('nav[aria-label="Pagination"] button, [aria-label="Pagination"] button')]
                    .find(b => b.textContent.trim() === String(saved.page));
                btn?.click();
                await wait(800);
            } else if (saved.count > homeListCount()) {
                const target = Math.min(saved.count, 100); // the site keeps about 100 cards
                for (let i = 0; i < 12 && isHomePath() && homeListCount() < target; i++) {
                    window.scrollTo(0, document.documentElement.scrollHeight);
                    window.dispatchEvent(new Event('scroll'));
                    await wait(700);
                }
            }
            for (let i = 0; i < 20 && siteListPaging()?.pending; i++) await wait(250);
            if (isHomePath()) window.scrollTo({ top: saved.scrollY || 0, left: 0, behavior: 'auto' });
        } catch {} finally {
            homeRestoring = false;
        }
    }
    // Capture before the route changes (the homepage is still mounted), on link clicks and regularly.
    (() => {
        const push = history.pushState;
        history.pushState = function (...a) { try { captureHomeState(); } catch {} return push.apply(this, a); };
        document.addEventListener('click', e => { if (e.target.closest?.('a[href]')) { try { captureHomeState(); } catch {} } }, true);
        setInterval(() => { if (isHomePath() && !document.hidden) { try { captureHomeState(); } catch {} } }, 2000);
        window.addEventListener('pagehide', () => { try { captureHomeState(); } catch {} });
        // Back / Forward: popstate fires before the router renders the homepage.
        // The capture is held off right away, so the reset page is not saved over the state first.
        window.addEventListener('popstate', () => {
            homeBackNav = true;
            homeRestoring = true;
            setTimeout(() => {
                if (homeBackNav && isHomePath()) restoreHomeState(); else homeRestoring = false;
                homeBackNav = false;
            }, 50);
        });
        // A Back that reloads the page (bfcache miss) is a back_forward navigation.
        try {
            const nav = performance.getEntriesByType('navigation')[0];
            if (nav?.type === 'back_forward' && isHomePath()) { homeRestoring = true; setTimeout(restoreHomeState, 300); }
        } catch {}
    })();

    // ---------------------------------------------------------------------
    // Pagination
    // ---------------------------------------------------------------------
    // A filter that hides most of a page breaks both list-loading modes:
    // - Autoscroll off: a page is `videosPerPage` long and replaced, not appended, so a strict filter
    //   can leave a single card. The API caps pages at 100 and the site accepts any positive stored
    //   preference, so raising it fixes this.
    // - Autoscroll on: the site appends via an IntersectionObserver on a sentinel (1000px rootMargin)
    //   that only reports changes. If a mostly hidden batch does not push the sentinel out of the
    //   margin, no callback fires and loading stops.
    // The site also windows its list (maxItems 100, trimmed to 60), dropping cards off the top,
    // so top-up stops below that window.

    const SITE_PREFS_KEY = 'user-preferences-v1';
    const SITE_PAGE_MAX = 100;  // server cap
    const PUMP_CARD_CEILING = 90;  // below the site's 100-item window
    const PUMP_COOLDOWN_MS = 1200;
    const PUMP_MAX_TRIES = 8;
    const SKIP_MAX_PAGES = 10;

    function nuxtState() {
        return document.querySelector('#__nuxt')?.__vue_app__?.config
            ?.globalProperties?.$nuxt?.payload?.state || null;
    }

    // Nuxt keeps each list page's paging in a useState entry named after the page type
    // ($shomepage-current-page, $ssearch-current-page, ...) that survives in-page navigation,
    // so the prefix comes from the route first.
    function siteListPaging() {
        const st = nuxtState();
        if (!st) return null;
        const path = location.pathname;
        const prefixes = [];
        if (path === '/') prefixes.push('$shomepage');
        if (path.startsWith('/search')) prefixes.push('$ssearch');
        const suffix = '-current-page';
        Object.keys(st).forEach(k => { if (k.endsWith(suffix)) prefixes.push(k.slice(0, -suffix.length)); });
        for (const pre of prefixes) {
            const page = st[`${pre}-current-page`];
            if (typeof page !== 'number') continue;
            const total = st[`${pre}-total-pages`];
            return {
                page,
                totalPages: typeof total === 'number' && total > 0 ? total : 0,
                pending: st[`${pre}-pending`] === true,
                infinite: st['$suser-prefs-infinite-scroll'] === true,
                perPage: Number(st['$suser-prefs-videos-per-page']) || 0,
            };
        }
        return null;
    }

    // The container with the most cards: the list grid, not a Recommended rail or "More from" strip.
    function mainCardGrid() {
        const counts = new Map();
        let best = null, bestN = 0;
        document.querySelectorAll('a[href*="/video/"]').forEach(card => {
            const parent = card.parentElement;
            if (!parent) return;
            const n = (counts.get(parent) || 0) + 1;
            counts.set(parent, n);
            if (n > bestN) { bestN = n; best = parent; }
        });
        return bestN >= 4 ? best : null;
    }

    // All cards of the list across the site's chunks. Counted from the cards, not data-video-id:
    // a card whose id is not resolved yet counts as a result, which only makes this wait, never skip a page.
    function listCards() {
        const merged = listChunks();
        const grids = merged ? merged.chunks : [mainCardGrid()].filter(Boolean);
        const cards = [];
        grids.forEach(grid => [...grid.children].forEach(el => {
            if (el.matches('a[href*="/video/"]')) cards.push(el);
        }));
        return cards;
    }

    function listCardCounts() {
        const cards = listCards();
        return {
            total: cards.length,
            visible: cards.filter(el => el.getAttribute('data-pmv-filtered') !== '1').length,
            last: cards[cards.length - 1] || null,
        };
    }

    function siteIsLoadingMore() {
        return !!document.querySelector('.animate-spin');
    }

    // Settles the two site preferences the filter depends on. Both are read at site init, so changes
    // land on the next page change or reload.
    // Autoscroll works against a strict filter: the site keeps ~100 cards (maxItems 100, trimmed to 60)
    // and drops the oldest, survivors included, so top-up becomes a load/filter/trim treadmill. With
    // autoscroll off a page stands alone and nothing is discarded. So the site is put on pages while
    // the filter hides things, and the user's setting is restored afterwards.
    // A bigger page only helps in that mode; with autoscroll on it reaches the trimming sooner.
    function syncSitePrefs() {
        let prefs;
        try { prefs = JSON.parse(localStorage.getItem(SITE_PREFS_KEY) || 'null'); } catch { return; }
        if (!prefs || typeof prefs !== 'object') return;
        let changed = false;

        if (filterConfig.pagedWhenFiltered && filterConfig.active && filterIsMeaningful()) {
            if (prefs.infiniteScrolling !== false) {
                filterConfig.siteInfiniteWas = prefs.infiniteScrolling === true;
                saveFilterConfig();
                prefs.infiniteScrolling = false;
                changed = true;
            }
        } else if (filterConfig.siteInfiniteWas && prefs.infiniteScrolling !== true) {
            filterConfig.siteInfiniteWas = false;
            saveFilterConfig();
            prefs.infiniteScrolling = true;
            changed = true;
        }

        const have = Number(prefs.videosPerPage) || 0;
        const want = filterConfig.bigPages && prefs.infiniteScrolling !== true
            ? SITE_PAGE_MAX
            : (have === SITE_PAGE_MAX ? (Number(filterConfig.sitePageSizeWas) || 32) : have);
        if (want && want !== have) {
            if (want === SITE_PAGE_MAX && have > 0 && filterConfig.sitePageSizeWas !== have) {
                filterConfig.sitePageSizeWas = have;
                saveFilterConfig();
            }
            prefs.videosPerPage = want;
            changed = true;
        }

        if (changed) {
            try { localStorage.setItem(SITE_PREFS_KEY, JSON.stringify(prefs)); } catch {}
        }
    }

    // An observer only reports changes, so the sentinel is first moved far out of reach (300vh, past
    // the 1000px margin) and then into view, producing a real transition. Moving it into view alone
    // fails on short pages where it never leaves the margin.
    function nudgeInfiniteSentinel(afterEl) {
        const sentinel = [...document.querySelectorAll('div')].find(d =>
            d.className === 'h-4' && (afterEl.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (!sentinel) return false;
        const previous = sentinel.getAttribute('style');
        const park = css => { sentinel.style.cssText = css; };
        const frame = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        (async () => {
            park('position:fixed;top:300vh;left:0;width:1px;height:4px;');
            await frame();
            park('position:fixed;top:0;left:0;width:1px;height:4px;');
            await frame();
            setTimeout(() => {
                if (previous === null) sentinel.removeAttribute('style');
                else sentinel.setAttribute('style', previous);
            }, 120);
        })();
        return true;
    }

    // Removes everything the filter hides from the site's own list, which its memory management
    // watches (past 100 items it trims the top, taking a strict filter's survivors with it). Hidden
    // cards are display:none, so nothing in view moves. Only while the filter is hiding things, only
    // with autoscroll on, and never below a floor: an empty list takes the sentinel with it and loading stops.
    const PRUNE_FLOOR = 8;

    function siteListKey() {
        const st = nuxtState();
        if (!st) return null;
        const suffix = '-accumulated-videos';
        const path = location.pathname;
        const prefixes = [];
        if (path === '/') prefixes.push('$shomepage');
        if (path.startsWith('/search')) prefixes.push('$ssearch');
        Object.keys(st).forEach(k => { if (k.endsWith(suffix)) prefixes.push(k.slice(0, -suffix.length)); });
        for (const pre of prefixes) {
            if (Array.isArray(st[pre + suffix])) return pre + suffix;
        }
        return null;
    }

    // Length of the site's own list (what its memory limit watches), not the DOM card count;
    // the two differ briefly after a prune.
    function siteListLength() {
        const st = nuxtState();
        const key = st && siteListKey();
        return key && Array.isArray(st[key]) ? st[key].length : 0;
    }

    function pruneFilteredFromSiteList() {
        if (!filterConfig.active || !filterIsMeaningful()) return 0;
        const paging = siteListPaging();
        if (!paging || !paging.infinite) return 0;
        const st = nuxtState();
        const key = st && siteListKey();
        if (!key) return 0;
        const list = st[key];
        if (!Array.isArray(list) || list.length <= PRUNE_FLOOR) return 0;

        const hidden = new Set();
        document.querySelectorAll('[data-pmv-filtered="1"][data-video-id]').forEach(card => {
            hidden.add(card.getAttribute('data-video-id'));
        });
        if (!hidden.size) return 0;

        const kept = list.filter(item => !hidden.has(String(item?._id ?? item?.id)));
        const dropped = list.length - kept.length;
        if (!dropped) return 0;
        // Keep the tail topped up to the floor so the site never gets an empty list.
        const final = kept.length >= PRUNE_FLOOR ? kept : list.slice(-PRUNE_FLOOR);
        if (final.length === list.length) return 0;
        try { st[key] = final; } catch { return 0; }
        return list.length - final.length;
    }

    // The site renders a list in chunks, each its own grid, with ad containers between them; each
    // chunk starts a fresh row, leaving short rows mid-list. Merge: the shared parent takes the chunk's
    // classes (responsive rules stay the site's), chunks become display:contents, and separators
    // collapse only while they render nothing; a visible banner spans the full row.
    // Classes are re-applied per pass: a Vue patch rewrites class wholesale, data-* survives.
    function ensureMergeStyle() {
        if (document.getElementById('pmv-grid-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-grid-style';
        st.textContent =
            '[data-pmv-grid-chunk="1"]{display:contents;}' +
            '[data-pmv-grid-span="1"]{grid-column:1 / -1;}' +
            '[data-pmv-grid-collapse="1"]{display:none !important;}';
        (document.head || document.documentElement).appendChild(st);
    }

    function listChunks() {
        const counts = new Map();
        document.querySelectorAll('a[href*="/video/"]').forEach(card => {
            const parent = card.parentElement;
            if (!parent) return;
            counts.set(parent, (counts.get(parent) || 0) + 1);
        });
        const chunks = [...counts.entries()].filter(([, n]) => n >= 4).map(([el]) => el);
        if (chunks.length < 2) return null;
        const parent = chunks[0].parentElement;
        if (!parent || chunks.some(c => c.parentElement !== parent)) return null;
        // Chunks of one list carry identical classes; other rails sharing a parent do not and must not be merged.
        const cls = chunks[0].className || '';
        if (!/(^|\s)grid(\s|$)/.test(cls)) return null;
        if (chunks.some(c => (c.className || '') !== cls)) return null;
        return { parent, chunks };
    }

    function mergeListChunks() {
        if (!filterConfig.mergeGrids) return;
        const found = listChunks();
        if (!found) return;
        ensureMergeStyle();
        const { parent, chunks } = found;

        if (parent.getAttribute('data-pmv-grid-merge') !== '1') {
            // Stored as an attribute so it survives Vue patches and re-initialisation.
            parent.setAttribute('data-pmv-grid-was', parent.className || '');
            parent.setAttribute('data-pmv-grid-merge', '1');
        }
        chunks[0].classList.forEach(cls => { if (!parent.classList.contains(cls)) parent.classList.add(cls); });

        [...parent.children].forEach(child => {
            if (chunks.includes(child)) {
                if (child.getAttribute('data-pmv-grid-chunk') !== '1') child.setAttribute('data-pmv-grid-chunk', '1');
                return;
            }
            // Judged by contents, not box: as a grid item an empty container stretches to the row height.
            // Re-evaluated every pass so a banner that fills in later gets its row back.
            const empty = ![...child.querySelectorAll('*')]
                .some(el => el.getBoundingClientRect().height > 0);
            if (empty) {
                if (child.getAttribute('data-pmv-grid-collapse') !== '1') {
                    child.removeAttribute('data-pmv-grid-span');
                    child.setAttribute('data-pmv-grid-collapse', '1');
                }
            } else if (child.getAttribute('data-pmv-grid-span') !== '1') {
                child.removeAttribute('data-pmv-grid-collapse');
                child.setAttribute('data-pmv-grid-span', '1');
            }
        });
    }

    function unmergeListChunks() {
        document.querySelectorAll('[data-pmv-grid-merge]').forEach(parent => {
            parent.className = parent.getAttribute('data-pmv-grid-was') || '';
            parent.removeAttribute('data-pmv-grid-was');
            parent.removeAttribute('data-pmv-grid-merge');
        });
        document.querySelectorAll('[data-pmv-grid-chunk],[data-pmv-grid-span],[data-pmv-grid-collapse]').forEach(el => {
            el.removeAttribute('data-pmv-grid-chunk');
            el.removeAttribute('data-pmv-grid-span');
            el.removeAttribute('data-pmv-grid-collapse');
        });
    }

    let pumpState = { key: '', tries: 0, lastAt: 0, lastCards: 0, stalls: 0 };

    function topUpList() {
        const target = Math.max(0, parseInt(filterConfig.topUpTarget, 10) || 0);
        if (!target || !filterConfig.active || !filterIsMeaningful()) return;
        const paging = siteListPaging();
        if (!paging || !paging.infinite || paging.pending) return;

        const key = location.pathname + location.search;
        if (pumpState.key !== key) pumpState = { key, tries: 0, lastAt: 0, lastCards: 0, stalls: 0 };

        const { total, visible, last } = listCardCounts();
        if (!total || !last || visible >= target) return;
        if ((siteListLength() || total) >= PUMP_CARD_CEILING) return;
        if (paging.totalPages && paging.page >= paging.totalPages) return;
        if (pumpState.tries >= PUMP_MAX_TRIES || siteIsLoadingMore()) return;
        if (Date.now() - pumpState.lastAt < PUMP_COOLDOWN_MS) return;

        // Fewer cards than before means the site's trimming kicked in (past ~100 it drops the oldest);
        // asking for more only feeds that, so stop for this page view.
        if (pumpState.lastCards && total < pumpState.lastCards) {
            pumpState.tries = PUMP_MAX_TRIES;
            return;
        }
        // A nudge that brings nothing means the site will not deliver (rate limited or window full);
        // after two, stop until the next page.
        if (pumpState.lastCards && total === pumpState.lastCards && ++pumpState.stalls >= 2) {
            pumpState.tries = PUMP_MAX_TRIES;
            return;
        }
        if (total > pumpState.lastCards) pumpState.stalls = 0;

        pumpState.lastAt = Date.now();
        pumpState.tries++;
        pumpState.lastCards = total;
        if (nudgeInfiniteSentinel(last)) {
            // A nudge that loads nothing causes no mutation, so the badge pass would never notice.
            setTimeout(topUpList, PUMP_COOLDOWN_MS + 400);
        }
    }

    let skipState = { key: '', seen: 0, done: 0 };

    function skipThinPage() {
        const below = Math.max(0, parseInt(filterConfig.skipBelow, 10) || 0);
        if (!below || !filterConfig.active || !filterIsMeaningful()) return;
        const paging = siteListPaging();
        if (!paging || paging.infinite || paging.pending) return;
        if (!paging.totalPages || paging.page >= paging.totalPages) return;

        const { total, visible } = listCardCounts();
        if (!total) return;

        const key = `${location.pathname}${location.search}#${paging.page}`;
        if (skipState.key !== key) skipState = { key, seen: 0, done: skipState.done };
        if (visible >= below) { skipState.seen = 0; return; }

        // Playlist membership and ratings resolve after cards appear; skip a page only if it is
        // still this thin on a second look.
        if (++skipState.seen < 2) { setTimeout(skipThinPage, 1500); return; }
        if (skipState.done >= SKIP_MAX_PAGES) return;

        const next = [...document.querySelectorAll('button')]
            .find(b => b.textContent.trim() === '»' && !b.disabled);
        if (!next) return;
        skipState.done++;
        toast(`Page ${paging.page}: ${visible} of ${total} left — next page`);
        next.click();
    }

    // ---------------------------------------------------------------------
    // Badges
    // ---------------------------------------------------------------------

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
            // Self-healing: a page re-render removes the Up next panel and it is otherwise rebuilt only on
            // URL change. Rebuild only when missing; doing it every pass would interrupt a drag.
            if (smartQueueItems.length && !document.getElementById('pmv-queue-sidebar')) {
                try { renderQueueSidebar(); } catch {}
            }
            syncSitePrefs();
            mergeListChunks();
            // Our own pruning shrinks the list too; the top-up must not read that as site trimming.
            if (pruneFilteredFromSiteList()) pumpState.lastCards = 0;
            topUpList();
            skipThinPage();
        };
        if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
        else setTimeout(run, 250);
    }


    // ✕ on a card: reject the video (see toggleRejectVideo) without opening it. Only present while a
    // reject list is chosen; red if rejected, grey otherwise. `resolveId` gives the API _id
    // (directly, or via lookup on slug cards). Kept apart from "+" (pushed to the end of its row) so
    // the two are not mixed up. While a card filter is active, rejecting takes two clicks: the first
    // turns the button red ("Reject?"), a second within REJECT_ARM_MS rejects.
    const REJECT_ARM_MS = 3000;
    // Card action buttons share one size, matching the site's "+N" tag button; the reject ✕ is a badge
    // in the thumbnail's top-left corner in the style of the aspect-ratio badge, and the site's own
    // top-left badges (NEW, Seen …) move down one slot under it.
    const CARD_ICON = {
        external: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
        queueAdd: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 6H3"/><path d="M12 12H3"/><path d="M12 18H3"/><path d="M18 12v7"/><path d="M14.5 15.5h7"/></svg>',
        plus: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
        // Up next: two play triangles and a bar (play next).
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
    // The card's thumbnail box (grid: .aspect-video, Recommended: .w-40).
    function cardThumb(card) {
        return card.querySelector('.aspect-video') || card.querySelector('.w-40') || card.querySelector('img')?.parentElement || null;
    }
    function placeRejectInThumb(card, btn) {
        const thumb = cardThumb(card);
        if (!thumb) return false;
        if (getComputedStyle(thumb).position === 'static') thumb.style.position = 'relative';
        thumb.dataset.pmvRejthumb = '1';
        // Small, subtle variant where the card has no resolution pill (Recommended, More from, …).
        if (!thumb.querySelector(':scope > .absolute.top-3.right-3')) btn.dataset.small = '1';
        thumb.appendChild(btn);
        return true;
    }
    // "+" on a card: the right-click playlist menu, opened under the button. A second click closes it.
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

    function styleRejectCardBtn(btn, on) {
        const armed = !on && btn.dataset.armed === '1';
        btn.dataset.on = on ? '1' : '';
        btn.textContent = armed ? '\u2298 Reject?' : '\u2298';
        btn.title = armed ? 'Click again to reject'
            : on ? 'Remove from reject list'
            : 'Reject (move to the reject list, remove from every other playlist)';
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
                // Re-render this card's badges and tint on the next pass.
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
        btn.dataset.on = on ? '1' : '';
        if (on) disarmRejectBtn(btn);
        styleRejectCardBtn(btn, on);
    }

    // Heart on a card: favourite / unfavourite without opening the video.
    //   GET /api/users/favorite-ids -> { favorites: [id, ...] }   (state, loaded once per page load)
    //   PUT /api/videos/<id>/favorite  { action: "favorite" | "unfavorite" }
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
                // noteFavourite already ran from the fetch hook; keep the page's own state in step too.
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

            // Skip cards already processed for this video ID, unless it is in a playlist and its badge is
            // missing (Vue re-render); cheap Map lookup first, DOM query only for in-playlist cards.
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

            // "Open in tab" button: a <button> + window.open() rather than a nested <a>, which is invalid
            // inside a card that is itself a link. Independent of State.ready.
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

            // "+" button: add this card's video to the Smart Queue without navigating. Uses the card's
            // resolved videoId (real _id, not slug/asset ID).
            if (!targetRow.querySelector('[data-pmv-addqueue]')) {
                const aqBtn = cardBtn('queue', 'Add to Up next', CARD_ICON.upNext);
                aqBtn.dataset.pmvAddqueue = '1';
                aqBtn.addEventListener('click', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    addVideoToQueue(videoId, card);
                });
                targetRow.appendChild(aqBtn);
            }

            // "+": add to a playlist (the right-click menu), after the Up next button.
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

            // ✕ in the thumbnail corner.
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
                // Short name (Settings → Playlist names) on the badge, the full name in its tooltip.
                badge.textContent = (isRejectList(plId) ? '\u2298 ' : '✓ ') + (getPlaylistDisplayName(name, plId) || name);
                targetRow.appendChild(badge);
            });
        });
    }

    function getQueueRowVisibleTitle(itemRoot) {
        const titleEl = itemRoot.querySelector('.flex-1.min-w-0 p, .flex-1.min-w-0 span, .flex-1.min-w-0');
        return titleEl?.firstChild?.nodeValue?.trim() ||
               titleEl?.childNodes?.[0]?.textContent?.trim() ||
               titleEl?.textContent?.trim() || '';
    }

    function resolveQueueItemVideoId(itemRoot) {
        // Visible title text is more reliable than img.alt (Vue recycles nodes on virtual scroll, so alt lags).
        // Displayed videos are always in videoDetails and thus titleIndex.
        const visibleTitle = getQueueRowVisibleTitle(itemRoot);
        if (visibleTitle) return State.titleIndex.get(visibleTitle.toLowerCase()) || null;
        return null;
    }

    // Direct trigger on N: the Up Next preview already shows the next video before anything changes,
    // so it is read synchronously in the keydown tick, before Vue re-renders it.
    // Read off the visible preview rather than resolving an ID: the native block is a plain <button>
    // (queue-row helpers don't apply), and when the playlist-page filter overlays it
    // (#pmvnf-upnext-overlay) the native button still shows the filtered-out video, so the overlay wins.
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

    // Central gate for the mini-HUD whatever the trigger (N key, console hook, DOM fallback).
    // `key` dedupes repeats: video ID if resolvable, else thumbnail URL or title, so a failed ID
    // resolution never blocks it.
    function showNextVideoNotificationWithInfo(info, source) {
        if (!document.fullscreenElement) return;
        if (!info?.title || !info.key || info.key === State.lastNextHudVideoId) return;
        State.lastNextHudVideoId = info.key;
        showNextVideoHUD({ title: info.title, creator: info.creator, thumbnail: info.thumbnail });
    }

    // fallbackTitle is used when videoMeta has no entry yet.
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

    // Primary trigger: the site logs "Switching playlist video" with {newVideoId, newVideo, ...}
    // whenever currentVideoIndex changes (next, N key, queue click). It fires before any media/HLS
    // loading, so it is independent of readyState timing and of which DOM class the site shows.
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

    // Fallback: DOM detection via the active queue row (border-orange-500) in case the console
    // message disappears. Same gate; showNextVideoNotificationFor dedupes by id.
    function maybeShowNextVideoNotification() {
        if (!document.fullscreenElement || !isPlaylistPage()) return;
        const row = getActiveQueueRow();
        if (!row) return;
        const videoId = resolveQueueItemVideoId(row);
        if (!videoId) return;
        showNextVideoNotificationFor(videoId, getQueueRowVisibleTitle(row), 'dom-fallback');
    }

    function addQueueBadges() {
        if (State.quietMode || !State.ready) return;

        // Scope to thumbnail containers, then walk up to the button; much narrower than a global
        // querySelectorAll('[role="button"]').
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


    // ---------------------------------------------------------------------
    // Recommended sidebar
    // ---------------------------------------------------------------------
    // Badges and playlist filter on /video/ pages.

    function getVideoIdFromHref(href) {
        // href: /video/<slug>_<24hex>?from=recommended (slug and query are
        // optional)
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

    // Bounded retry after navigation/load to wait out SSR/hydration; not a poller.
    // A new kick replaces the running one. The Up next panel is rebuilt on the
    // first tick, then only when missing or no longer above Recommended.
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

    // Re-badge as soon as the cache is ready (covers kicks that fired before
    // State.ready).
    window.addEventListener('pmv:cache-ready', () => {
        // Reset so all cards are re-evaluated
        document.querySelectorAll('[data-pmv-rec-checked]').forEach(el => {
            delete el.dataset.pmvRecChecked;
        });
        document.querySelectorAll('[data-pmv-mf-checked]').forEach(el => { delete el.dataset.pmvMfChecked; });
        try { addRecommendedBadges(); } catch {}
        try { addMoreFromBadges(); } catch {}
    });

    function resolveRecCardVideoId(card) {
        // 1. The card itself is an <a href="/video/slug_<id>">
        const selfHref = card.tagName === 'A' ? card.getAttribute('href') : null;
        if (selfHref) {
            const fromSelf = getVideoIdFromHref(selfHref);
            if (fromSelf) return fromSelf;
        }
        // 2. <a href="/video/..."> somewhere inside the card
        const innerLink = card.querySelector('a[href*="/video/"]');
        if (innerLink) {
            const fromInner = getVideoIdFromHref(innerLink.getAttribute('href'));
            if (fromInner) return fromInner;
        }
        // 3. Title → titleIndex (works once the cache is loaded)
        const h4 = card.querySelector('h4');
        if (h4) {
            const fromTitle = State.titleIndex.get(h4.textContent.trim().toLowerCase());
            if (fromTitle) return fromTitle;
        }
        // 4. img.src → thumbUrl or thumbnailIndex
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

    // "+" on a Recommended card. Placed from the card alone (no playlist cache or
    // API id needed); the id is resolved on click.
    function placeRecAddQueueButton(card, slugId, targetEl) {
        const infoDiv = targetEl || card.querySelector('.flex-1.min-w-0');
        if (!infoDiv) return;
        placeRecRejectButton(card, slugId, infoDiv);
        if (infoDiv.querySelector('[data-pmv-rec-addqueue]')) return;

        const aqBtn = cardBtn('queue', 'Add to Up next', CARD_ICON.upNext);
        aqBtn.dataset.pmvRecAddqueue = '1';
        aqBtn.dataset.rec = '1';
        // Added immediately under the card's slug id; the real API id is
        // resolved in the background and swapped in (needed only for dedupe and
        // playlist chips).
        aqBtn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
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
        // "+" (add to a playlist) and the heart after it; the resolved id is cached, so later clicks
        // need no request.
        const resolveId = async () => {
            const id = knownApiIdForCard(card, slugId);
            if (id) return id;
            const v = await fetchVideoDeduped(slugId).catch(() => { noteLookupFailure(slugId); return null; });
            if (!v?._id) return null;
            State.slugToApiId.set(slugId, v._id);
            return v._id;
        };
        const plBtn = playlistPickButton(resolveId);
        plBtn.dataset.rec = '1';
        const favBtn = favCardButtonEl(() => knownApiIdForCard(card, slugId), resolveId);
        favBtn.dataset.rec = '1';
        infoDiv.append(aqBtn, plBtn, favBtn);
    }

    // ✕ on a Recommended / More from card. Placed from the card alone, id resolved
    // on click. Its colour follows the known id, re-checked on every badge pass.
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

    // Tints a card green (in a playlist) or red (rejected). Inline styles do not
    // survive Vue re-renders; the badge pass reapplies them.
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

    // Green "✓ <playlist names>" chip shared by Recommended and More from cards;
    // null when the video is in no playlist.
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

    // "More from <uploader>" cards are plain <a href="/video/slug_<id>"> in a grid
    // and carry no data-video-id.
    //
    // ID resolution is fetch-free: slug cache, then titleIndex/thumbnailIndex.
    // titleIndex holds only playlist videos, so a hit means "in a playlist".
    // Fetching every card on sight causes 429 bursts.
    function knownApiIdForCard(card, slugId) {
        const mapped = State.slugToApiId.get(slugId);
        if (mapped) return mapped;
        // A slug can itself be a playlist video's _id (newer videos have no
        // oldId).
        if (State.reverse.has(slugId)) return slugId;
        const h4 = card.querySelector('h4');
        const byTitle = h4 && State.titleIndex.get(h4.textContent.trim().toLowerCase());
        if (byTitle) return byTitle;
        const src = (card.querySelector('img')?.getAttribute('src') || '').split('?')[0];
        return (src && State.thumbnailIndex.get(src)) || null;
    }

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

    // Cards not resolvable for free are resolved on hover: one request after a
    // short intent delay, deduped via fetchVideoDeduped(). Bulk lookups would
    // saturate the rate limit.
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

    // ---------------------------------------------------------------------
    // Notifications
    // ---------------------------------------------------------------------
    // Playlist indicator per notification.
    // /notifications has no thumbnails or data-video-id, only a "/video/<hex>"
    // link. Resolution makes no API call: slugToApiId, reverse index, titleIndex
    // (playlist videos only, so a hit means "in a playlist"). Idempotent: re-runs
    // replace the badge only when the outcome changes.
    //
    // Thumbnail and tag chips for a notification's video, appended as a full-width
    // block below the row. Idempotent: keyed by apiId.
    function renderNotifPreview(card, apiId, meta) {
        const link = card.querySelector('a[href*="/video/"]');
        // Sibling of the text block inside the justify-between row, filling its
        // empty side.
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
            // Clickable like the homepage card.
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

            // Hover preview: the <video> is created lazily on first hover,
            // then paused/resumed.
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

    // Shared by getNotifInPlaylistBoxes and selectNotifsByTag. hex is the real
    // video _id here; used as a fallback when the video is in no index.
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

    // Opening the video also marks the notification read: click the real button,
    // then navigate after a short delay so its request is not aborted.
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

    // Failed lookups are parked for a while instead of retried on sight; retries
    // would feed the rate limiting.
    const LOOKUP_BACKOFF_MS = 60000;
    const failedLookups = new Map(); // id -> timestamp to retry after

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
            // Replaces the interceptor's deferred for this request; removed
            // from the map only while it is still the entry.
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
            // hex is the real video _id; fallback target for the
            // thumbnail/tags fetch when no index hits.
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
            // data-* survives Vue re-renders — used by the select button below.
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
            // Limited by the performance mode. Metadata is checked first and
            // fetchVideoDeduped shares requests, since one video can appear
            // in several notification rows.
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

    // "Select in playlist": clicks the checkbox of every loaded notification whose
    // video is in a playlist (clicking keeps Vue's v-model in sync); a second press
    // deselects.
    // Mounted next to the All/Unread pills and re-attached on every badge run,
    // since Vue may drop it. Falls back to a fixed button on body.
    function isNotifVideoInPlaylist(apiId) {
        for (const p of State.playlists.values()) {
            if (p.ids.has(apiId)) return true;
        }
        return false;
    }

    // Resolved from State and the live DOM on each call, not from data-pmv-inpl,
    // which can be stale mid-loop.
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

    // Clicks each matching checkbox one at a time with a frame in between, so Vue's
    // re-render settles before the next card is queried.
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

    // Keep the label (select/deselect) in sync with manual checkbox clicks.
    document.addEventListener('change', e => {
        if (e.target?.matches?.('input[type="checkbox"]') && document.getElementById('pmv-notif-selpl')) {
            updateNotifSelectButton();
        }
    }, true);

    function addRecommendedBadges() {
        // Two "Recommended" h3s exist (mobile, desktop); use the visible one.
        const h3 = [...document.querySelectorAll('h3')].find(el => {
            if (el.textContent.trim() !== 'Recommended') return false;
            // No boxes = inside a display:none ancestor (the hidden layout).
            return el.getClientRects().length > 0;
        });
        if (!h3) return;
        const container = h3.parentElement?.parentElement;
        if (!container) return;

        addRecommendedFilter(h3);

        const thumbDivs = [...container.querySelectorAll('.w-40')];

        // The "+" goes on every card first: it needs only the card, not the
        // cache or a resolved id.
        thumbDivs.forEach(thumbDiv => {
            const card = thumbDiv.parentElement;
            if (!card) return;
            const slugId = resolveRecCardVideoId(card);
            if (slugId) placeRecAddQueueButton(card, slugId);
        });

        if (!State.ready) return;

        // Split cards into: already known (skip/direct) and unknown (fetch needed)
        const toFetch = [];
        thumbDivs.forEach(thumbDiv => {
            const card = thumbDiv.parentElement;
            if (!card) return;

            const slugId = resolveRecCardVideoId(card);
            if (!slugId) return;

            // Try via the slugToApiId cache first
            const apiId = State.slugToApiId.get(slugId) || slugId;

            if (card.dataset.pmvRecChecked === apiId) return;

            if (isVideoInPlaylist(apiId) || State.reverse.has(apiId)) {
                // Already known — place directly
                placeRecBadge(card, apiId);
            } else if (!State.slugToApiId.has(slugId)) {
                if (card.dataset.pmvRecFetching || lookupOnCooldown(slugId)) return;
                card.dataset.pmvRecFetching = '1';
                toFetch.push({ card, slugId });
            } else {
                // Slug known but not in a playlist
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

    // Recommended playlist-filter pills use the site's own chip classes.
    const REC_CHIP_COLORS = {
        all: 'bg-orange-500/10 border-orange-500/30 text-orange-300',
        in: 'bg-green-500/10 border-green-500/30 text-green-300',
        out: 'bg-red-500/10 border-red-500/30 text-red-300',
    };
    function applyRecChipClass(btn, active) {
        btn.className = active ? `${Q_CHIP} ${REC_CHIP_COLORS[btn.dataset.pmvRecMode] || REC_CHIP_COLORS.all}` : Q_CHIP_OFF;
    }

    function addRecommendedFilter(h3El) {
        // One-time: add filter buttons to the Recommended header row (the h3's
        // parent).
        const headerRow = h3El.parentElement;
        if (!headerRow || headerRow.querySelector('#pmv-rec-filter')) return;

        const wrapper = document.createElement('div');
        wrapper.id = 'pmv-rec-filter';
        // Same wrapper class the site uses for its own chip row in this header.
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
                // Reset pmvRecChecked so badges are recomputed
                document.querySelectorAll('[data-pmv-rec-checked]').forEach(el => delete el.dataset.pmvRecChecked);
                addRecommendedBadges();
            });

            wrapper.appendChild(btn);
        });

        // Find the badge row in the header (where WiFi/ES/Personalized live)
        const badgeRow = headerRow.querySelector('.flex.items-center.gap-1\\.5.flex-wrap');
        if (badgeRow) badgeRow.parentElement?.insertBefore(wrapper, badgeRow);
        else headerRow.appendChild(wrapper);
    }

    // MutationObserver with rAF debounce. Changes inside own panels (ids pmv*),
    // hidden players and the player control bar (re-renders constantly) do not
    // start a run.
    function isNoiseMutation(m) {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (!t) return true;
        return !!(t.closest('[id^="pmv"]') || t.closest('.controls-bar-wrapper'));
    }
    // One run per frame at most, spaced further apart in the lighter performance modes.
    const scheduleObserverRun = PMVX.scheduler(() => observerRun());
    const observer = new MutationObserver(muts => {
        if (State.observerPaused) return;
        if (muts.every(isNoiseMutation)) return;
        scheduleObserverRun();
    });
    function observerRun() {
        {
            // The Recommended sidebar is SSR and must not be blocked by
            // quietMode/rate limiting; own idempotent run.
            try { addRecommendedBadges(); } catch {}
            try { addMoreFromBadges(); } catch {}
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

    // ---------------------------------------------------------------------
    // Navigation
    // ---------------------------------------------------------------------

    function enterQuietMode() {
        State.quietMode = true;
        closeHud();
        setTimeout(() => {
            State.quietMode = false;
            scheduleBadges();
            requestAnimationFrame(() => updateNativePlaylistButtons(true));
            if (document.fullscreenElement) showHud();
        }, QUIET_MS);
    }

    function onPossibleVideoChange() {
        const id = getCurrentVideoId();
        if (!id || id === State.currentVideoId) return;

        State.currentVideoId = id;
        State.pendingRemove = false;
        clearTimeout(State.pendingRemoveTimeout);
        ensureCurrentVideoData(id);
        enterQuietMode();

        if (State.lastSoftCleanVideoId !== id) {
            State.lastSoftCleanVideoId = id;
            State.videosSinceSoftClean += 1;
        }

        unloadFarOffscreenImages();

        if (State.videosSinceSoftClean >= SOFT_CLEAN_EVERY_VIDEOS) {
            State.videosSinceSoftClean = 0;
            setTimeout(softDomClean, 1500);
        }
    }


    // ---------------------------------------------------------------------
    // Cached player repair
    // ---------------------------------------------------------------------
    // Nuxt keeps visited pages in a KeepAlive. A reactivated page's player is not
    // remounted, and its <video> was emptied by the media sweep while detached, so
    // it has no source.
    // The player component exposes reloadSource() to restore it, so an empty player
    // gets up to two nudges.
    // Vue hides component instances in production builds; the player is found by
    // walking the app's vnode tree (Suspense keeps its branch aside, hence its own
    // step).
    function findPlayerApi() {
        const root = document.querySelector('#__nuxt')?._vnode?.component;
        if (!root) return null;
        const seen = new Set();
        const walk = (vnode, depth) => {
            if (!vnode || typeof vnode !== 'object' || depth > 120) return null;
            const inst = vnode.component;
            if (inst && !seen.has(inst)) {
                seen.add(inst);
                if (inst.exposed && typeof inst.exposed.reloadSource === 'function') return inst.exposed;
                const hit = walk(inst.subTree, depth + 1);
                if (hit) return hit;
            }
            if (vnode.suspense) {
                const hit = walk(vnode.suspense.activeBranch, depth + 1)
                    || walk(vnode.suspense.pendingBranch, depth + 1);
                if (hit) return hit;
            }
            if (vnode.ssContent) {
                const hit = walk(vnode.ssContent, depth + 1);
                if (hit) return hit;
            }
            for (const list of [vnode.children, vnode.dynamicChildren]) {
                if (!Array.isArray(list)) continue;
                for (const child of list) {
                    const hit = walk(child, depth + 1);
                    if (hit) return hit;
                }
            }
            return null;
        };
        try { return walk(root.subTree, 0); } catch { return null; }
    }

    let playerRepairDone = false;

    function repairEmptyPlayer() {
        if (playerRepairDone) return;
        if (!/^\/(video|playlists)\//.test(location.pathname)) return;
        const video = getVideo();
        if (!video) return;
        // Still loading is normal; only a player with no source is nudged.
        if (video.currentSrc || video.getAttribute('src') || video.readyState > 0) return;
        const api = findPlayerApi();
        if (!api) return;
        playerRepairDone = true;
        try { api.reloadSource(); } catch {}
    }

    // Event-driven URL change detection: popstate plus a title MutationObserver
    // (catches router pushes without popstate).
    function onUrlChange() {
        if (location.href === State.lastUrl) return;
        sweepDetachedMediaFor();
        State.lastUrl = location.href;
        closeHud();
        hideQueueSidebarNow();
        // Reset immediately so getCurrentVideoId() does not return the previous
        // video's ID.
        State.currentVideoData = null;
        // The seekbar preview's second player belongs to the previous video;
        // the next hover rebuilds it.
        try { scrubHide(); scrubDrop(); } catch {}
        // Pause the video on navigation away from video/playlist pages
        try {
            const v = getVideo();
            if (v && !v.paused && !inPlaceHandover) v.pause();
        } catch {}
        setTimeout(() => forceVolume100({ silent: true }), 500);
        setTimeout(() => forceVolume100({ silent: true }), 1500);
        // A page restored from KeepAlive needs a moment to settle; check twice.
        playerRepairDone = false;
        setTimeout(repairEmptyPlayer, 1500);
        setTimeout(repairEmptyPlayer, 3500);
        setTimeout(() => {
            onPossibleVideoChange();
            updateNativePlaylistButtons(true);
        }, 120);
        // Re-badge/re-filter the SSR Recommended sidebar after SPA navigation.
        kickRecommended();
        // Notify the playlist-page filter of SPA navigation to a playlist
        if (location.pathname.startsWith('/playlists/')) {
            setTimeout(() => {
                try { window.dispatchEvent(new CustomEvent('pmv:playlist-navigate')); } catch {}
            }, 300);
        }
    }

    window.addEventListener('popstate', onUrlChange);

    // Catch Vue router navigation that doesn't fire popstate (history.pushState directly).
    new MutationObserver(onUrlChange).observe(
        document.querySelector('title') || document.head,
        { childList: true, characterData: true, subtree: true }
    );

    // 2s heartbeat for volume enforcement and video element discovery only.
    setInterval(() => {
        getVideo();
        updateNativePlaylistButtons();
        if (State.ready) { try { ensureRejectBarButton(getCurrentVideoId()); } catch {} }
    }, 2000);


    // ---------------------------------------------------------------------
    // Context menu
    // ---------------------------------------------------------------------
    // Playlist menu for a video, opened by the "+" button on cards.

    function closeCtxMenu() {
        document.getElementById('pmv-ctx-menu')?.remove();
    }

    function buildCtxMenu(videoId, x, y, target) {
        closeCtxMenu();
        // Store the original event target so "Open in new tab" can find the link
        const _ctxTarget = target || null;

        const menu = document.createElement('div');
        menu.id = 'pmv-ctx-menu';
        menu.style.cssText = [
            'position:fixed',
            `left:${x}px`,
            `top:${y}px`,
            'z-index:2147483647',
            'background:rgba(18,18,18,0.97)',
            'border:1px solid rgba(255,255,255,0.13)',
            'border-radius:10px',
            'padding:6px 0',
            'min-width:210px',
            'max-width:280px',
            'box-shadow:0 8px 32px rgba(0,0,0,0.7)',
            'font-size:13px',
            'color:white',
            'user-select:none',
        ].join(';');

        // "Open in new tab" — at the top
        const openRow = document.createElement('div');
        openRow.style.cssText = [
            'display:flex',
            'align-items:center',
            'gap:8px',
            'padding:8px 14px',
            'cursor:pointer',
            'transition:background .1s',
            'color:oklch(70.5% .213 47.604)',
            'font-weight:500',
        ].join(';');
        openRow.addEventListener('mouseenter', () => { openRow.style.background = 'rgba(255,255,255,0.06)'; });
        openRow.addEventListener('mouseleave', () => { openRow.style.background = ''; });
        openRow.addEventListener('click', e => {
            e.stopPropagation();
            closeCtxMenu();
            // Find the video card's href via the target that triggered the context menu
            const link = _ctxTarget?.closest('a[href*="/video/"]') ||
                         _ctxTarget?.closest('[data-video-id]')?.querySelector('a[href*="/video/"]');
            const href = link?.getAttribute('href');
            if (href) window.open(href, '_blank');
        });

        // Arrow icon
        const openIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        openIcon.setAttribute('viewBox', '0 0 24 24'); openIcon.setAttribute('width', '14'); openIcon.setAttribute('height', '14');
        openIcon.setAttribute('fill', 'none'); openIcon.setAttribute('stroke', 'currentColor');
        openIcon.setAttribute('stroke-width', '2'); openIcon.setAttribute('stroke-linecap', 'round'); openIcon.setAttribute('stroke-linejoin', 'round');
        openIcon.style.flexShrink = '0';
        openIcon.innerHTML = '<path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>';
        const openLabel = document.createElement('span');
        openLabel.textContent = 'Open in new tab';
        openRow.appendChild(openIcon);
        openRow.appendChild(openLabel);
        menu.appendChild(openRow);

        // Orange divider
        const orangeDivider = document.createElement('div');
        orangeDivider.style.cssText = 'height:1px;background:oklch(70.5% .213 47.604);opacity:0.35;margin:2px 0 6px;';
        menu.appendChild(orangeDivider);

        if (!State.ready || State.playlists.size === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'Loading playlists...';
            empty.style.cssText = 'padding:8px 14px;opacity:.45;';
            menu.appendChild(empty);
        } else {
            [...State.playlists.values()]
                .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
                .forEach(pl => {
                const inPl = pl.ids.has(videoId);
                const customStyle = getPlaylistStyle(pl.name, pl.id);
                const displayName = getPlaylistDisplayName(pl.name, pl.id);
                const colorHex = customStyle ? customStyle.color : FALLBACK_COLOR;
                const activeRgb = hexToRgbStr(colorHex);
                const inactiveRgb = mixToGrayStr(colorHex);
                // Muted vs vivid contrast is in text and icon colour
                // only: near gray when not in the playlist, vivid when
                // it is.
                const textColor = inPl ? `rgb(${activeRgb})` : `rgba(${inactiveRgb},0.75)`;
                const hoverBg = `rgba(${inPl ? activeRgb : inactiveRgb},${inPl ? 0.12 : 0.06})`;

                const row = document.createElement('div');
                row.style.cssText = [
                    'display:flex',
                    'align-items:center',
                    'gap:8px',
                    'padding:7px 14px',
                    'cursor:pointer',
                    'transition:background .1s',
                    `color:${textColor}`,
                    `font-weight:${inPl ? '700' : '400'}`,
                ].join(';');

                row.addEventListener('mouseenter', () => {
                    row.style.background = hoverBg;
                });
                row.addEventListener('mouseleave', () => {
                    row.style.background = '';
                });

                // Left side: plus or checkmark in the playlist colour
                // (green fallback), muted when not in the playlist.
                const icon = document.createElement('span');
                icon.style.cssText = 'width:14px;flex-shrink:0;font-size:12px;text-align:center;' +
                    (inPl ? `color:rgba(${activeRgb},1);` : `color:rgba(${inactiveRgb},0.5);`);
                icon.textContent = inPl ? '✓' : '+';

                const label = document.createElement('span');
                label.textContent = displayName;
                label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

                row.appendChild(icon);
                row.appendChild(label);

                row.addEventListener('click', async e => {
                    e.stopPropagation();
                    closeCtxMenu();
                    if (inPl) {
                        const ok = await removeFromPlaylist(videoId, pl.id);
                        updateNativePlaylistButtons(true);
                        scheduleBadges();
                        toast(ok ? '✕ ' + displayName : 'Remove failed', ok ? 'red' : null);
                    } else {
                        const ok = await addToPlaylist(videoId, pl.id);
                        updateNativePlaylistButtons(true);
                        scheduleBadges();
                        toast(ok ? '✓ ' + displayName : 'Add failed', ok ? 'green' : null);
                    }
                });

                menu.appendChild(row);
            });
        }

        // Correct position if the menu falls outside the viewport
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth)  menu.style.left = Math.max(0, window.innerWidth - rect.width - 8) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top  = Math.max(0, window.innerHeight - rect.height - 8) + 'px';
    }

    // No right-click menu on cards any more: the "+" button on a card opens the same playlist menu.

    // Close the menu on click outside it, or on scroll/escape
    document.addEventListener('click', e => {
        if (!e.target.closest('#pmv-ctx-menu')) closeCtxMenu();
    }, true);
    document.addEventListener('scroll', closeCtxMenu, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); }, true);

    // ---------------------------------------------------------------------
    // Seekbar preview
    // ---------------------------------------------------------------------
    // A frame above the player's time bar at the hovered time. Frames are prepared
    // ahead; a hover never seeks.
    //
    // Two layers: the ten API frames (timelineThumbnails, kept by the interceptor)
    // show immediately, nearest to the hovered time. Over them, frames from a cache
    // built in the background once the real video plays, so a hover is a lookup and
    // a drawImage.
    //
    // Cache construction:
    // - Hidden players on the lowest rendition, via the site's own hls.js (its
    //   instance's constructor) so the library loads once. Segments come from the
    //   HTTP cache, so extra players cost CPU, not bandwidth.
    // - A seek costs the decoding from the previous keyframe, so frames are taken
    //   at keyframes. Their times are parsed from the TS segments (PES PTS of
    //   random-access packets). Seeking slightly past the keyframe
    //   (SCRUB_KEY_MARGIN) lands on it cheaply.
    // - Gaps wider than SCRUB_GAP get a middle frame afterwards, widest first
    //   (expensive mid-GOP seeks, done last).
    // - Segments are processed coarse-to-fine across players so the whole bar fills
    //   early.
    // - Sources without TS segments (plain file, fMP4) fall back to one player
    //   walking 2 s steps.
    //
    // The bar is matched on document mouse events (the div with
    // onMousemove=handleProgressHover inside .controls-bar-wrapper, classes
    // "relative cursor-pointer py-3 -my-3"), not by attaching to it, since Vue may
    // rebuild it. The preview sits above the site's hover-time label.
    //
    // Setting: hybrid = live cache (default), frames = the API frames only, off.
    const SCRUB_KEY = 'pmv_scrub_preview_v1';
    const SCRUB_BAR_SELECTOR = '.controls-bar-wrapper .cursor-pointer.py-3';
    const SCRUB_W = 176;            // width of a landscape preview
    const SCRUB_MAX_H = 176;        // height cap for a portrait one
    const SCRUB_LIFT = 38;          // px between the bar's box and the preview: clears the site's time label
    const SCRUB_WARM_DELAY = 1500;  // ms after the real video starts playing before the cache is built
    const SCRUB_FRAMES_MAX = 600;   // frames kept per video at most (176x99x4 bytes each: ~40 MB)
    const SCRUB_GAP = 2.5;          // s; wider gaps between frames get one in the middle
    const SCRUB_KEY_MARGIN = 0.08;  // s past a keyframe time to seek: lands on it without decoding the GOP before
    const SCRUB_GEN_MAX = 3;        // hidden players at most
    const SCRUB_WALK_STEP = 2;      // s between frames when there is no keyframe index
    const SCRUB_ZONE_PX = 26;       // height of the HUD's own hover/seek strip at the bottom of fullscreen

    let scrubModeCached = (() => { try { return localStorage.getItem(SCRUB_KEY) || 'frames'; } catch { return 'frames'; } })();
    // The live frame cache is skipped in Light mode (it runs hidden players).
    function scrubMode() { return scrubModeCached === 'hybrid' && PMVX.perfMode() === 'light' ? 'frames' : scrubModeCached; }
    function setScrubMode(mode) {
        scrubModeCached = mode;
        try { localStorage.setItem(SCRUB_KEY, mode); } catch {}
        if (mode !== 'hybrid') scrubDrop();
        if (mode === 'off') scrubHide();
        if (mode === 'hybrid') scrubWarm();
    }

    const Scrub = {
        tip: null, img: null, canvas: null, ctx: null, gensRoot: null,
        visible: false, dragBar: null, dragSeek: false, watch: null, warmTimer: null,
        key: null, failedKey: null, token: 0,
        gens: [],            // { video, hls }
        frames: null,        // { t: number[], b: ImageBitmap[] }, sorted by t
        framesW: 0, framesH: 0, gapStall: 0,
    };

    // Shape of the video: 16:9 and wider at a fixed width, portrait capped in
    // height.
    function scrubDims(video) {
        const ar = (video?.videoWidth && video?.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
        let w = SCRUB_W, h = Math.round(w / ar);
        if (h > SCRUB_MAX_H) { h = SCRUB_MAX_H; w = Math.round(h * ar); }
        return { w, h };
    }

    // The API frames of the playing video: from its own data once loaded, else from
    // the page's strip (not during a fullscreen hand-over).
    function scrubApiFrames() {
        return timelineFrames().filter(f => f.time !== null);
    }

    function scrubNearestApiFrame(t) {
        let best = null;
        for (const f of scrubApiFrames()) {
            if (!best || Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
        }
        return best;
    }

    function ensureScrubTip() {
        if (!Scrub.tip) {
            const tip = document.createElement('div');
            tip.id = 'pmv-scrub-preview';
            tip.style.cssText = 'position:fixed;z-index:1000000;pointer-events:none;display:none;' +   // above the HUD panel
                'border-radius:8px;overflow:hidden;background:#000;' +
                'box-shadow:0 4px 18px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.18);';
            const img = document.createElement('img');
            img.draggable = false;
            img.decoding = 'async';
            img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;';
            tip.appendChild(img);
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;';
            tip.appendChild(canvas);
            const label = document.createElement('div');
            label.style.cssText = 'position:absolute;left:50%;bottom:4px;transform:translateX(-50%);display:none;' +
                'padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.75);color:#fff;font-size:11px;font-family:inherit;font-variant-numeric:tabular-nums;';
            tip.appendChild(label);
            Scrub.tip = tip;
            Scrub.img = img;
            Scrub.canvas = canvas;
            Scrub.ctx = canvas.getContext('2d');
            Scrub.label = label;
        }
        // In fullscreen only children of the fullscreen element are visible, so
        // the tip follows it.
        const root = getFullscreenRoot() || document.body;
        if (Scrub.tip.parentElement !== root) root.appendChild(Scrub.tip);
        return Scrub.tip;
    }

    // Hidden players live in a display:none box on body: seeking and drawImage work
    // there, and being attached keeps the media sweep (detached elements only) off
    // them.
    function ensureScrubGensRoot() {
        if (Scrub.gensRoot?.isConnected) return Scrub.gensRoot;
        if (!Scrub.gensRoot) {
            const box = document.createElement('div');
            box.id = 'pmv-scrub-gens';
            box.style.cssText = 'display:none;';
            Scrub.gensRoot = box;
        }
        document.body.appendChild(Scrub.gensRoot);
        return Scrub.gensRoot;
    }

    // Current source: HLS when the site's hls.js instance has a URL, else the plain
    // file. A blob: URL (MSE without an hls instance) has no second-player option.
    function scrubSource() {
        const video = getVideo();
        if (!video) return null;
        const api = findPlayerApi();
        const hls = api?.hls?.value;
        if (hls?.url && typeof hls.constructor === 'function') {
            return { kind: 'hls', url: hls.url, Hls: hls.constructor, bitrate: hls.levels?.[0]?.bitrate || 0 };
        }
        const src = video.currentSrc || video.getAttribute('src') || '';
        if (src && !src.startsWith('blob:')) return { kind: 'file', url: src };
        return null;
    }

    function scrubDrop() {
        Scrub.token++;
        clearTimeout(Scrub.warmTimer);
        for (const g of Scrub.gens) {
            if (g.hls) { try { g.hls.destroy(); } catch {} }
            try { g.video.pause(); g.video.removeAttribute('src'); g.video.srcObject = null; g.video.load(); } catch {}
            g.video.remove();
        }
        Scrub.gens = [];
        if (Scrub.frames) for (const b of Scrub.frames.b) { try { b.close(); } catch {} }
        Scrub.frames = null;
        Scrub.key = null;
        if (Scrub.canvas) Scrub.canvas.style.display = 'none';
    }

    function scrubWarm() {
        if (scrubMode() !== 'hybrid') return;
        if (!/^\/(video|playlists)\//.test(location.pathname)) return;
        try { scrubBuild(); } catch {}
    }

    function scrubMakePlayer(source, full) {
        const video = document.createElement('video');
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.dataset.pmvPreviewVideo = '1';   // getVideo() must never take this for the player
        ensureScrubGensRoot().appendChild(video);
        const g = { video, hls: null, fragTimes: new Map(), fragWaiters: new Map(), tapped: false };
        if (source.kind === 'hls') {
            // The player's own fragment loader is tapped: bytes it loads
            // anyway are parsed for keyframes (synchronously, before hls.js
            // hands them to its worker), avoiding a second download.
            // Without a tap, scrubBuildFromIndex fetches fragments itself.
            const Base = source.Hls.DefaultConfig?.loader;
            let fLoader;
            if (typeof Base === 'function') {
                fLoader = class extends Base {
                    load(context, config, callbacks) {
                        const onSuccess = callbacks?.onSuccess;
                        if (onSuccess) {
                            callbacks = {
                                ...callbacks,
                                onSuccess: (response, stats, ctx, details) => {
                                    try { scrubTapFrag(g, (ctx || context)?.frag, response?.data); } catch {}
                                    onSuccess(response, stats, ctx, details);
                                },
                            };
                        }
                        return super.load(context, config, callbacks);
                    }
                };
                g.tapped = true;
            }
            // Lowest level only (the picture is 176px wide). Only the
            // fragment at the seek position loads (maxBufferLength below
            // fragment length), keeping memory flat; a walking player (no
            // index) buffers everything.
            const h = new source.Hls({
                autoStartLoad: false, enableWorker: true,
                startLevel: 0, capLevelToPlayerSize: true,
                maxBufferLength: full ? 4 * 3600 : 20, maxMaxBufferLength: full ? 4 * 3600 : 40,
                backBufferLength: full ? Infinity : 5, maxBufferSize: full ? 400 * 1000 * 1000 : 30 * 1000 * 1000,
                fragLoadingMaxRetry: 2, levelLoadingMaxRetry: 2, manifestLoadingMaxRetry: 2,
                ...(fLoader ? { fLoader } : {}),
            });
            const parsed = source.Hls.Events?.MANIFEST_PARSED || 'hlsManifestParsed';
            h.on(parsed, () => { try { h.currentLevel = 0; } catch {} });
            h.loadSource(source.url);
            h.attachMedia(video);
            g.hls = h;
        } else {
            video.src = source.url;
        }
        return g;
    }

    function scrubBuild() {
        const key = getCurrentVideoId();
        if (!key || Scrub.failedKey === key) return;
        if (Scrub.key === key && Scrub.gens.length && Scrub.gens.every(g => g.video.isConnected && !mediaIsDead(g.video))) return;
        scrubDrop();
        const main = getVideo();
        const dur = main?.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const source = scrubSource();
        if (!source) return;
        Scrub.key = key;
        const token = ++Scrub.token;
        const live = () => Scrub.token === token;
        Scrub.frames = { t: [], b: [] };
        const dims = scrubDims(main);
        Scrub.framesW = dims.w;
        Scrub.framesH = dims.h;
        try {
            if (source.kind === 'hls') {
                const count = Math.max(1, Math.min(SCRUB_GEN_MAX, Math.floor((navigator.hardwareConcurrency || 2) / 2) || 1));
                for (let i = 0; i < count; i++) Scrub.gens.push(scrubMakePlayer(source, false));
                scrubBuildFromIndex(token, live, dur).catch(() => { if (live()) scrubWalk(token, live, dur).catch(() => {}); });
            } else {
                Scrub.gens.push(scrubMakePlayer(source, true));
                scrubWalk(token, live, dur).catch(() => {});
            }
        } catch {
            Scrub.failedKey = key;
            scrubDrop();
        }
    }

    // ---------------------------------------------------------------------
    // Taking a frame
    // ---------------------------------------------------------------------

    const scrubSleep = ms => new Promise(r => setTimeout(r, ms));
    const scrubIdle = () => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 200 }) : setTimeout(r, 16)));

    function scrubSeek(video, t, timeoutMs = 5000) {
        return new Promise(resolve => {
            let settled = false;
            const finish = ok => { if (settled) return; settled = true; video.removeEventListener('seeked', onSeeked); resolve(ok); };
            const onSeeked = () => finish(true);
            video.addEventListener('seeked', onSeeked);
            setTimeout(() => finish(false), timeoutMs);
            try { video.currentTime = t; } catch { finish(false); }
        });
    }

    // Sorted insert; skips frames within 0.1 s of an existing one.
    function scrubKeep(t, bmp) {
        const f = Scrub.frames;
        if (!f) { try { bmp.close(); } catch {} return false; }
        let lo = 0, hi = f.t.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (f.t[mid] < t) lo = mid + 1; else hi = mid; }
        if ((lo < f.t.length && Math.abs(f.t[lo] - t) < 0.1) || (lo > 0 && Math.abs(f.t[lo - 1] - t) < 0.1)) { try { bmp.close(); } catch {} return false; }
        f.t.splice(lo, 0, t);
        f.b.splice(lo, 0, bmp);
        return true;
    }

    // Seeks a hidden player to t and keeps the frame. Returns false if the seek did
    // not land.
    async function scrubGrab(g, t, live) {
        const video = g.video;
        const landed = await scrubSeek(video, t);
        if (!live() || !landed || video.readyState < 2) return false;
        if (!g.canvas) {
            g.canvas = document.createElement('canvas');
            g.canvas.width = Scrub.framesW;
            g.canvas.height = Scrub.framesH;
            g.ctx = g.canvas.getContext('2d');
        }
        g.ctx.drawImage(video, 0, 0, Scrub.framesW, Scrub.framesH);
        const bmp = await createImageBitmap(g.canvas);
        if (!live()) { try { bmp.close(); } catch {} return false; }
        scrubKeep(video.currentTime, bmp);
        return true;
    }

    function scrubFramesFull() { return !Scrub.frames || Scrub.frames.t.length >= SCRUB_FRAMES_MAX; }

    // Coarse-to-fine order (0, n/2, n/4, 3n/4, ...) so every stretch has a nearby
    // frame early.
    function scrubOrder(n) {
        const order = [];
        const done = new Uint8Array(n);
        let stride = 1;
        while (stride * 2 < n) stride *= 2;
        for (; stride >= 1; stride = Math.floor(stride / 2)) {
            for (let i = 0; i < n; i += stride) if (!done[i]) { done[i] = 1; order.push(i); }
        }
        return order;
    }

    // ---------------------------------------------------------------------
    // Keyframe index from TS segments
    // ---------------------------------------------------------------------

    // The level playlist as hls.js read it (fragments with url, start, duration);
    // null if it never loads.
    async function scrubLevelDetails(h, live) {
        for (let i = 0; i < 100; i++) {
            if (!live()) return null;
            const d = h.levels?.[0]?.details;
            if (d?.fragments?.length) return d;
            if (i === 0) { try { h.startLoad(0); } catch {} }
            await scrubSleep(100);
        }
        return null;
    }

    // Keyframe times of one MPEG-TS segment: PTS of video PES packets with the
    // random-access flag, placed on the media timeline like hls.js does. Null if
    // not TS.
    function scrubParseTs(buf, fragStart) {
        const b = new Uint8Array(buf);
        const n = Math.floor(b.length / 188);
        if (n < 10 || b[0] !== 0x47 || b[188] !== 0x47) return null;
        let pmtPid = -1, videoPid = -1, firstDts = null;
        const keys = [];
        const stamp = o => (((b[o] & 0x0e) * 536870912) + (b[o + 1] * 4194304) + ((b[o + 2] & 0xfe) * 16384) + (b[o + 3] * 128) + ((b[o + 4] & 0xfe) / 2));
        for (let i = 0; i < n; i++) {
            const o = i * 188;
            if (b[o] !== 0x47) continue;
            const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
            const pusi = b[o + 1] & 0x40;
            const afc = (b[o + 3] >> 4) & 3;
            let p = o + 4, rai = false;
            if (afc & 2) { const afl = b[o + 4]; if (afl > 0) rai = !!(b[o + 5] & 0x40); p = o + 5 + afl; }
            if (!(afc & 1) || p >= o + 188) continue;
            if (pid === 0 && pusi) {
                const s = p + 1 + b[p];
                const sl = ((b[s + 1] & 0x0f) << 8) | b[s + 2];
                for (let j = s + 8; j < s + 3 + sl - 4; j += 4) {
                    const prog = (b[j] << 8) | b[j + 1];
                    if (prog !== 0) { pmtPid = ((b[j + 2] & 0x1f) << 8) | b[j + 3]; break; }
                }
                continue;
            }
            if (pid === pmtPid && pusi && videoPid < 0) {
                const s = p + 1 + b[p];
                const sl = ((b[s + 1] & 0x0f) << 8) | b[s + 2];
                const pil = ((b[s + 10] & 0x0f) << 8) | b[s + 11];
                let j = s + 12 + pil;
                const end = s + 3 + sl - 4;
                while (j < end) {
                    const st = b[j];
                    const epid = ((b[j + 1] & 0x1f) << 8) | b[j + 2];
                    const eil = ((b[j + 3] & 0x0f) << 8) | b[j + 4];
                    if (st === 0x1b || st === 0x24) { videoPid = epid; break; }
                    j += 5 + eil;
                }
                continue;
            }
            if (pid !== videoPid || !pusi) continue;
            if (b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) continue;
            const flags = b[p + 7];
            if (!(flags & 0x80)) continue;
            const pts = stamp(p + 9);
            const dts = (flags & 0x40) ? stamp(p + 14) : pts;
            if (firstDts === null) firstDts = dts;
            if (rai) keys.push(pts);
        }
        if (firstDts === null) return null;
        return keys.map(pts => fragStart + (pts - firstDts) / 90000);
    }

    // Keyframe times by fragment sequence number from the tapped loader; waiters
    // are notified.
    function scrubTapFrag(g, frag, data) {
        if (!frag || typeof frag.sn !== 'number' || !(data instanceof ArrayBuffer) || !data.byteLength) return;
        const times = scrubParseTs(data, frag.start);
        g.fragTimes.set(frag.sn, times);
        const waiters = g.fragWaiters.get(frag.sn);
        if (waiters) { g.fragWaiters.delete(frag.sn); waiters.forEach(r => r(times)); }
    }

    // Resolves with the fragment's keyframe times (null: not TS) or undefined on
    // timeout.
    function scrubWaitFragTimes(g, sn, ms) {
        if (g.fragTimes.has(sn)) return Promise.resolve(g.fragTimes.get(sn));
        return new Promise(resolve => {
            const list = g.fragWaiters.get(sn) || [];
            list.push(resolve);
            g.fragWaiters.set(sn, list);
            setTimeout(() => resolve(undefined), ms);
        });
    }

    async function scrubBuildFromIndex(token, live, dur) {
        const gens = Scrub.gens;
        const details = await scrubLevelDetails(gens[0].hls, live);
        if (!details) throw new Error('no level');
        const frags = details.fragments;
        // Fragments are dealt coarse-to-fine, each player taking the next
        // unclaimed one; keyframes go in order within a fragment.
        const order = scrubOrder(frags.length);
        let next = 0;
        let indexed = false;
        const perFragCap = Math.max(2, Math.floor(SCRUB_FRAMES_MAX / frags.length));
        const work = async g => {
            while (live() && next < order.length && !scrubFramesFull()) {
                if (document.hidden) { await scrubSleep(250); continue; }
                const frag = frags[order[next++]];
                // Loading starts at this player's first fragment; each
                // later seek makes hls.js fetch the fragment it lands
                // in.
                if (!g.started) { g.started = true; try { g.hls.startLoad(frag.start); } catch {} }
                // The fragment start is a keyframe, so the first grab
                // goes there; that makes the tapped player load it and
                // deliver the rest of its keyframe times. If the tap
                // yields nothing in time, the fragment is fetched
                // separately.
                let times;
                let startGrabbed = false;
                if (g.tapped) {
                    const wait = scrubWaitFragTimes(g, frag.sn, 8000);
                    startGrabbed = await scrubGrab(g, Math.min(frag.start + SCRUB_KEY_MARGIN, dur - 0.05), live);
                    if (!live()) return;
                    times = await wait;
                }
                if (times === undefined) {
                    times = null;
                    try {
                        const res = await fetch(frag.url);
                        if (res.ok) times = scrubParseTs(await res.arrayBuffer(), frag.start);
                    } catch {}
                }
                if (!live()) return;
                if (!times) throw new Error('not ts');   // no index: hand the whole thing to scrubWalk
                if (startGrabbed) times = times.filter(t => t - frag.start > 0.15);
                indexed = true;
                if (times.length > perFragCap) {
                    // Too many to keep them all: an even pick across the fragment.
                    const step = times.length / perFragCap;
                    times = Array.from({ length: perFragCap }, (_, i) => times[Math.floor(i * step)]);
                }
                for (const t of times) {
                    if (!live() || scrubFramesFull()) return;
                    if (t >= dur - 0.05) continue;
                    await scrubGrab(g, Math.min(t + SCRUB_KEY_MARGIN, dur - 0.05), live);
                    await scrubIdle();
                }
            }
        };
        await Promise.all(gens.map(g => work(g).catch(e => { if (!indexed) throw e; })));
        if (!live()) return;
        await scrubFillGaps(token, live, dur);
    }

    // Fills the widest gaps first until none exceeds SCRUB_GAP or the cache is full
    // (slow mid-GOP seeks, done last).
    async function scrubFillGaps(token, live, dur) {
        const gens = Scrub.gens;
        const gaps = () => {
            const f = Scrub.frames;
            if (!f) return [];
            const out = [];
            let prev = 0;
            for (let i = 0; i <= f.t.length; i++) {
                const t = i < f.t.length ? f.t[i] : dur;
                if (t - prev > SCRUB_GAP) out.push({ a: prev, b: t });
                prev = t;
            }
            return out.sort((x, y) => (y.b - y.a) - (x.b - x.a));
        };
        let busy = 0;
        Scrub.gapStall = 0;
        for (const g of gens) if (!g.started) { g.started = true; try { g.hls?.startLoad(-1); } catch {} }
        while (live() && !scrubFramesFull()) {
            if (document.hidden) { await scrubSleep(250); continue; }
            const list = gaps();
            if (!list.length) return;
            const batch = list.slice(0, gens.length);
            await Promise.all(batch.map((gap, i) => scrubGrab(gens[i], (gap.a + gap.b) / 2, live)));
            if (++busy % 4 === 0) await scrubIdle();
            // Stops after three rounds without progress.
            const after = gaps();
            if (after.length >= list.length && after[0].b - after[0].a >= list[0].b - list[0].a) { if (++Scrub.gapStall > 3) return; } else Scrub.gapStall = 0;
        }
    }

    // No index (plain file or fMP4): one player, 2 s steps, coarse-to-fine. Slower,
    // but works.
    async function scrubWalk(token, live, dur) {
        const g = Scrub.gens[0];
        if (!g) return;
        if (g.hls) { try { g.hls.startLoad(0); } catch {} }
        const step = Math.max(SCRUB_WALK_STEP, dur / SCRUB_FRAMES_MAX);
        const n = Math.floor(dur / step) + 1;
        const queue = scrubOrder(n);
        const tries = new Uint8Array(n);
        while (queue.length && live() && !scrubFramesFull()) {
            if (document.hidden) { await scrubSleep(250); continue; }
            const i = queue.shift();
            const ok = await scrubGrab(g, Math.min(i * step, Math.max(0, dur - 0.05)), live);
            if (!ok && ++tries[i] <= 3) { queue.push(i); await scrubSleep(300); }
            await scrubIdle();
        }
    }

    // ---------------------------------------------------------------------
    // Showing
    // ---------------------------------------------------------------------

    // Nearest cached frame to t; null while there is none.
    function scrubCachedNear(t) {
        const f = Scrub.frames;
        if (!f || !f.t.length) return null;
        let lo = 0, hi = f.t.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (f.t[mid] < t) lo = mid + 1; else hi = mid; }
        if (lo > 0 && Math.abs(f.t[lo - 1] - t) < Math.abs(f.t[lo] - t)) lo--;
        return f.b[lo];
    }

    function scrubHide() {
        Scrub.visible = false;
        clearInterval(Scrub.watch);
        Scrub.watch = null;
        if (Scrub.tip) Scrub.tip.style.display = 'none';
    }

    function scrubShowAt(bar, clientX) {
        const video = getVideo();
        const dur = video?.duration;
        if (!video || !Number.isFinite(dur) || dur <= 0) { scrubHide(); return; }
        const rect = bar.getBoundingClientRect();
        if (rect.width <= 0) { scrubHide(); return; }
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const t = pos * dur;

        const frame = scrubNearestApiFrame(t);
        const cached = scrubCachedNear(t);
        if (!frame && !cached) { scrubHide(); return; }   // nothing to show yet: no empty black box

        const tip = ensureScrubTip();
        const { w, h } = scrubDims(video);
        tip.style.width = w + 'px';
        tip.style.height = h + 'px';
        // Centered on the cursor, kept within the bar's span.
        const left = Math.max(rect.left, Math.min(rect.right - w, clientX - w / 2));
        tip.style.left = Math.round(left) + 'px';
        tip.style.top = Math.round(rect.top - SCRUB_LIFT - h) + 'px';
        tip.style.display = 'block';

        if (frame) {
            if (Scrub.img.getAttribute('src') !== frame.src) Scrub.img.src = frame.src;
            Scrub.img.style.display = 'block';
        } else {
            Scrub.img.style.display = 'none';
        }
        if (cached) {
            if (Scrub.canvas.width !== Scrub.framesW || Scrub.canvas.height !== Scrub.framesH) {
                Scrub.canvas.width = Scrub.framesW;
                Scrub.canvas.height = Scrub.framesH;
            }
            try { Scrub.ctx.drawImage(cached, 0, 0, Scrub.framesW, Scrub.framesH); } catch {}
            Scrub.canvas.style.display = 'block';
        } else {
            Scrub.canvas.style.display = 'none';
        }

        const ownStrip = bar.id === 'pmv-scrub-zone';
        if (Scrub.label) {
            Scrub.label.textContent = formatTime(t);
            Scrub.label.style.display = ownStrip ? 'block' : 'none';   // the site's bar shows its own
        }

        if (!Scrub.visible) {
            Scrub.visible = true;
            // The site hides controls after idle seconds without a mouse
            // event, and Vue may drop the bar; the tip must not outlive
            // either.
            Scrub.watch = setInterval(() => {
                if (!bar.isConnected) { scrubHide(); return; }
                if (!ownStrip && bar.closest('.controls-bar-wrapper')?.classList.contains('controls-hidden')) scrubHide();
            }, 250);
        }
    }

    document.addEventListener('mousemove', e => {
        if (scrubMode() === 'off') return;
        const target = e.target instanceof Element ? e.target : null;
        // During a drag-seek the preview follows the pointer anywhere, via the
        // bar it started on.
        const bar = target?.closest(SCRUB_BAR_SELECTOR) || target?.closest('#pmv-scrub-zone') || Scrub.dragBar;
        if (!bar) { if (Scrub.visible) scrubHide(); return; }
        if (Scrub.dragSeek && Scrub.dragBar === bar) {
            const v = getVideo();
            const r = bar.getBoundingClientRect();
            if (v && Number.isFinite(v.duration) && v.duration > 0 && r.width > 0) {
                try { v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.duration; } catch {}
            }
        }
        scrubShowAt(bar, e.clientX);
    }, true);
    document.addEventListener('pointerdown', e => {
        const target = e.target instanceof Element ? e.target : null;
        // The own strip sets dragBar itself (its handler also seeks).
        if (target?.closest('#pmv-scrub-zone')) return;
        Scrub.dragBar = target?.closest(SCRUB_BAR_SELECTOR) || null;
        Scrub.dragSeek = false;
    }, true);
    const scrubDragEnd = () => { Scrub.dragBar = null; Scrub.dragSeek = false; };
    window.addEventListener('pointerup', scrubDragEnd, true);
    window.addEventListener('pointercancel', scrubDragEnd, true);
    document.addEventListener('mouseleave', () => scrubHide());
    document.addEventListener('fullscreenchange', () => scrubHide());

    // ---------------------------------------------------------------------
    // Hotkeys
    // ---------------------------------------------------------------------
    // Every key is remappable to a built-in action or a playlist. One table drives dispatch and the cheat sheet.
    const KEYBIND_KEY = 'pmv_keybindings_v1';

    const BUILTIN_ACTIONS = {
        showHud: { label: 'Show HUD panel', run: () => showHud() },
        toggleMute: { label: 'Toggle mute', run: () => toggleMute() },
        volume100: { label: 'Set volume to 100%', run: () => setVolume100() },
        nextVideo: {
            label: 'Next video (Up next when it has items; the playlist itself on a playlist page)', run: () => {
                // Up next takes over "next" while it has something
                // ahead; the played item becomes history above the new
                // one. Otherwise returns false so the site's N advances
                // its playlist. On playlist pages the playlist owns
                // "next" and Up next is left alone.
                syncQueueCursor();
                const next = isPlaylistPage() ? null : smartQueueItems[queueCursor + 1];
                if (next) {
                    goToVideo(next.href, next.id);
                    return true;
                }
                try { maybeShowNextVideoFromUpNext(); }
                catch {}
                return false;
            }
        },
        refreshPlaylists: {
            label: 'Refresh playlists', run: async () => {
                toast('Refreshing playlists...');
                try {
                    await refreshUserPlaylists({ force: true });
                    scheduleBadges();
                    requestAnimationFrame(() => updateNativePlaylistButtons(true));
                    toast('Playlists refreshed');
                } catch (err) {
                    toast('Refresh failed');
                }
            }
        },
        removeFromAll: {
            label: 'Remove from ALL playlists/favourites', run: async () => {
                const videoId = getCurrentVideoId();
                if (!videoId) { toast('No video'); return; }
                const matches = getMatches(videoId);
                if (!matches.length) { toast('Not in any playlist/favourites'); return; }
                const results = await Promise.allSettled(matches.map(pl => removeFromPlaylist(videoId, pl.id)));
                const okCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
                const failCount = matches.length - okCount;
                updateNativePlaylistButtons(true);
                scheduleBadges();
                if (failCount === 0) toast(`\u2715 Removed from ${okCount} playlist${okCount === 1 ? '' : 's'}`, 'red');
                else toast(`\u2715 ${okCount}/${matches.length} removed (${failCount} failed)`);
            }
        },
        playPause: {
            label: 'Play / pause', run: () => {
                const video = getVideo();
                if (!video) return;
                if (video.paused) video.play().catch(() => {});
                else video.pause();
            }
        },
        fullscreen: { label: 'Fullscreen', run: () => toggleVideoFullscreen() },
        seekBack5: { label: 'Seek back 5s', run: () => seekVideoBy(-5) },
        seekForward5: { label: 'Seek forward 5s', run: () => seekVideoBy(5) },
        skipBack10: { label: 'Skip back 10s', run: () => seekVideoBy(-10) },
        toggleFavourite: {
            label: 'Favourite / unfavourite', run: () => {
                // While fullscreen runs ahead of the page, the on-page
                // button belongs to the previous video, so the call is
                // made directly.
                if (staleFullscreenHref) { toggleFavouriteViaApi(); return; }
                const btn = findFavouriteButton();
                if (!btn) { toast('No favourite button on this page'); return; }
                const wasOn = /^remove/i.test((btn.title || '').trim());
                btn.click();
                toast(wasOn ? '\u2715 Removed from favourites' : '\u2713 Added to favourites', wasOn ? 'red' : 'green');
            }
        },
        rejectVideo: {
            label: 'Reject: move to the reject list, remove from every other playlist, next video',
            run: () => rejectCurrentVideo(),
        },
        cheatSheet: { label: 'Show hotkey overview', run: () => toggleHotkeyCheatSheet() },
        smartQueue: { label: 'Open Up next', run: () => openQueueSettings() },
        addToQueue: { label: 'Add current video to Up next', run: () => addCurrentVideoToQueue() },
        openVideoPage: {
            label: 'Open video page in a new tab', run: () => {
                // For playlist pages, where the playing video has no
                // page URL. Uses the playlist buttons' id resolution
                // (API _id or mapped slug), never a poster asset id;
                // prefers the slug form when known.
                const id = getCurrentVideoId();
                if (!id) { toast('No video'); return; }
                const href = knownHrefForId(id) || `/video/${id}`;
                // Synchronous within the key event: a popup opened
                // after an await loses user activation.
                window.open(href, '_blank', 'noopener,noreferrer');
            }
        },
    };

    const DEFAULT_KEYBINDINGS = {
        i: { action: 'builtin:showHud' },
        m: { action: 'builtin:toggleMute' },
        z: { action: 'builtin:volume100' },
        n: { action: 'builtin:nextVideo' },
        r: { action: 'builtin:refreshPlaylists' },
        '?': { action: 'builtin:cheatSheet' },
    };
    function loadKeybindings() {
        try {
            const raw = localStorage.getItem(KEYBIND_KEY);
            if (raw) return JSON.parse(raw);
        } catch {}
        // First run: only built-in actions. Playlist keys stay unbound; assign
        // them in settings (Assign hotkeys).
        const defaults = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
        try { localStorage.setItem(KEYBIND_KEY, JSON.stringify(defaults)); } catch {}
        return defaults;
    }
    let keybindings = loadKeybindings();
    function saveKeybindings() { try { localStorage.setItem(KEYBIND_KEY, JSON.stringify(keybindings)); } catch {} }

    // On playlist pages the playlist owns "next" (the site's N); elsewhere the next
    // Up next item, else the first Recommended card that is neither current nor
    // rejected. The synthetic N bypasses this script's key dispatcher.
    let dispatchingSyntheticNext = false;
    function skipToNextVideo(currentId) {
        if (isPlaylistPage()) {
            dispatchingSyntheticNext = true;
            try {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'n', code: 'KeyN', keyCode: 78, which: 78, bubbles: true
                }));
            } finally { dispatchingSyntheticNext = false; }
            return true;
        }
        syncQueueCursor();
        const next = smartQueueItems[queueCursor + 1];
        if (next) { goToVideo(next.href, next.id); return true; }

        const container = findVisibleRecommendedContainer();
        const card = container && [...container.querySelectorAll('a[href*="/video/"]')].find(a => {
            if (a.closest('[style*="display: none"]')) return false;
            const slug = getVideoIdFromHref(a.getAttribute('href'));
            const apiId = slug && (State.slugToApiId.get(slug) || slug);
            return apiId && apiId !== currentId && !isRejected(apiId);
        });
        if (card) {
            const slug = getVideoIdFromHref(card.getAttribute('href'));
            goToVideo(card.getAttribute('href'), State.slugToApiId.get(slug) || null);
            return true;
        }
        return false;
    }

    // Reject key: add to the reject list (addToPlaylist removes it from other
    // lists), then skip to the next video. On an already rejected video it removes
    // it, without skipping.
    async function rejectCurrentVideo() {
        const videoId = getCurrentVideoId();
        if (!videoId) { toast('No video'); return; }
        await toggleRejectVideo(videoId, { skip: true });
    }

    // Shared by the reject key and the ✕ on cards: toggles reject-list membership.
    // Only the key skips. Resolves to the new state, or null if nothing changed.
    async function toggleRejectVideo(videoId, { skip = false } = {}) {
        const rejectId = rejectPlaylistId && State.playlists.has(rejectPlaylistId) ? rejectPlaylistId : null;
        if (!rejectId) { toast('No reject list chosen (Settings \u2192 Reject list)'); return null; }
        const plName = getPlaylistDisplayName(State.playlists.get(rejectId).name, rejectId) || rejectId;

        if (isRejected(videoId)) {
            const ok = await removeFromPlaylist(videoId, rejectId);
            updateNativePlaylistButtons(true);
            scheduleBadges();
            toast(ok ? '\u2715 Off ' + plName : 'Remove failed', ok ? 'green' : null);
            return ok ? false : null;
        }

        const otherCount = getMatches(videoId).filter(p => p.id !== rejectId).length;
        const ok = await addToPlaylist(videoId, rejectId);
        updateNativePlaylistButtons(true);
        scheduleBadges();
        if (!ok) { toast('Add failed'); return null; }
        const others = otherCount ? ` (removed from ${otherCount} other playlist${otherCount === 1 ? '' : 's'})` : '';
        const skipped = skip && skipToNextVideo(videoId);
        toast(`\u2298 ${plName}${others}${skipped ? ' \u2192 next' : ''}`, 'red');
        return true;
    }

    // After ✕ on a card: "Tag video", a small popup to give the rejected video a tag on the site
    // (usually why it was rejected). Same calls as the site's own Vote on Tags modal:
    //   GET  /api/videos/<id>/tags/stats    -> data.tags [{ tag, userVote }]
    //   POST /api/videos/<id>/tags/suggest  { tag, tagType: 'general' }                      new tag, +1 vote
    //   POST /api/videos/<id>/tags/vote     { tag, voteType: 'upvote', tagType: 'general' }  existing tag
    // Voting again on a tag you already upvoted would remove the vote, so that case is left alone.
    const TAG_AFTER_REJECT_KEY = 'pmv_tag_after_reject_v1';
    const TAG_RECENT_KEY = 'pmv_tag_recent_v1';
    const TAG_MAX_LEN = 50; // the site's limit for general tags
    const TAG_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle></svg>';
    function tagAfterReject() { try { return localStorage.getItem(TAG_AFTER_REJECT_KEY) !== '0'; } catch { return true; } }
    function setTagAfterReject(on) { try { localStorage.setItem(TAG_AFTER_REJECT_KEY, on ? '1' : '0'); } catch {} }
    // Performer chips' sparkle (the site's own icon for stars/models).
    const STAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/></svg>';
    // General tags and stars/models go through the same endpoints, told apart by tagType; the site's
    // length limits are 50 and 100.
    const TAG_KINDS = {
        general: { recentKey: TAG_RECENT_KEY, max: TAG_MAX_LEN, stats: 'tags', meta: 'tags', noun: 'tag', icon: TAG_SVG, pre: '#' },
        stars: { recentKey: 'pmv_star_recent_v1', max: 100, stats: 'stars', meta: 'starsTags', noun: 'model', icon: STAR_SVG, pre: '' },
    };
    const tagKind = k => TAG_KINDS[k] || TAG_KINDS.general;
    function recentTags(kind = 'general') {
        try {
            const a = JSON.parse(localStorage.getItem(tagKind(kind).recentKey) || '[]');
            return Array.isArray(a) ? a.filter(t => typeof t === 'string' && t).slice(0, 8) : [];
        } catch { return []; }
    }
    function rememberTag(tag, kind = 'general') {
        try {
            const a = [tag, ...recentTags(kind).filter(t => t.toLowerCase() !== tag.toLowerCase())].slice(0, 8);
            localStorage.setItem(tagKind(kind).recentKey, JSON.stringify(a));
        } catch {}
    }

    // The site's vocabulary per kind for autocomplete, loaded once on first use.
    const popularTagsP = {};
    function popularTags(kind = 'general') {
        const type = kind === 'stars' ? 'stars' : 'general';
        if (!popularTagsP[type]) {
            popularTagsP[type] = fetch(`/api/tags/popular?limit=1000&type=${type}`, { credentials: 'include' })
                .then(r => (r.ok ? r.json() : null))
                .then(j => (Array.isArray(j?.data) ? j.data : []).map(t => t?.name).filter(n => typeof n === 'string' && n))
                .catch(() => { popularTagsP[type] = null; return []; });
        }
        return popularTagsP[type];
    }

    async function postSiteJson(url, body) {
        const res = await fetch(url, {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
        });
        let j = null;
        try { j = await res.json(); } catch {}
        if (!res.ok || j?.success === false) throw new Error(j?.message || j?.statusMessage || `HTTP ${res.status}`);
        return j;
    }

    // Resolves to 'added' | 'voted' | 'already'; throws with the site's message on failure.
    async function tagVideoOnSite(id, tag, kind = 'general') {
        const K = tagKind(kind), tagType = kind === 'stars' ? 'stars' : 'general';
        let existing = null;
        try {
            existing = (await videoTagStats(id, kind)).find(t => String(t?.tag).toLowerCase() === tag.toLowerCase()) || null;
        } catch {}
        let result;
        if (existing?.userVote === 'upvote') result = 'already';
        else if (existing) {
            await postSiteJson(`/api/videos/${id}/tags/vote`, { tag: existing.tag, voteType: 'upvote', tagType });
            result = 'voted';
        } else {
            await postSiteJson(`/api/videos/${id}/tags/suggest`, { tag, tagType });
            result = 'added';
        }
        forgetVideo(id);
        // The filter sees the new tag right away.
        const m = State.videoMeta.get(id);
        if (m && Array.isArray(m[K.meta]) && !m[K.meta].includes(tag.toLowerCase())) m[K.meta].push(tag.toLowerCase());
        try { applyFilterToCards(true); } catch {}
        return result;
    }

    function ensureTagPopStyle() {
        if (document.getElementById('pmv-tag-pop-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-tag-pop-style';
        const P = '#pmv-tag-pop';
        st.textContent = `
${P}{position:fixed;z-index:1000002;width:320px;box-sizing:border-box;padding:12px;border-radius:12px;background:#111;border:1px solid #2A2A2A;
  box-shadow:0 12px 32px rgba(0,0,0,.6);color:#e5e7eb;font-family:inherit;font-size:13px;line-height:1.3;}
${P} *{box-sizing:border-box;font-family:inherit;}
${P} .tp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;}
${P} .tp-title{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:14px;color:#fff;}
${P} .tp-title svg{color:rgb(251,146,60);}
${P}[data-kind="stars"] .tp-title svg{color:rgb(250,204,21);}
${P}[data-kind="stars"] .tp-chip:not([data-hide]):not([data-vote="up"]){border-color:rgba(234,179,8,.45);background:rgba(234,179,8,.14);color:rgb(253,224,71);}
${P} .tp-x{border:none;background:none;color:#9ca3af;cursor:pointer;font-size:13px;padding:2px 4px;border-radius:6px;}
${P} .tp-x:hover{color:#fff;background:#1F1F1F;}
${P} .tp-sub{color:#9ca3af;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:8px;}
${P} .tp-in{position:relative;display:flex;gap:6px;}
${P} input{flex:1;min-width:0;height:34px;padding:0 10px;border-radius:8px;border:1px solid #2A2A2A;background:#1A1A1A;color:#fff;font-size:13px;outline:none !important;box-shadow:none !important;}
${P} input:focus{border-color:rgba(249,115,22,.6);}
${P} input:disabled{opacity:.6;}
${P} .tp-add{height:34px;padding:0 12px;border-radius:8px;border:none;cursor:pointer;color:#fff;font-weight:600;font-size:13px;
  background:linear-gradient(to right,rgb(249,115,22),rgb(234,88,12));}
${P} .tp-add:disabled{opacity:.5;cursor:default;}
${P} .tp-sug{position:absolute;left:0;right:0;top:38px;z-index:2;max-height:210px;overflow-y:auto;padding:4px;border-radius:8px;background:#1A1A1A;border:1px solid #2A2A2A;box-shadow:0 8px 20px rgba(0,0,0,.5);}
${P} .tp-sug[hidden]{display:none;}
${P} .tp-opt{display:block;width:100%;text-align:left;padding:6px 8px;border:none;border-radius:6px;background:none;color:#d1d5db;font-size:13px;cursor:pointer;}
${P} .tp-opt:hover, ${P} .tp-opt[data-hi="1"]{background:rgba(249,115,22,.15);color:#fff;}
${P} .tp-opt b{color:rgb(251,146,60);font-weight:600;}
${P} .tp-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;}
${P} .tp-chips:empty{display:none;}
${P} .tp-chip{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;border-radius:9999px;border:1px solid #2A2A2A;background:#1F1F1F;color:#d1d5db;font-size:12px;cursor:pointer;}
${P} .tp-chip:hover{border-color:rgba(249,115,22,.5);color:#fff;}
${P} .tp-chip[data-vote="up"]{color:rgb(134,239,172);background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.35);}
${P} .tp-chip[data-vote="up"]:hover{border-color:rgba(34,197,94,.6);}
${P} .tp-chip[data-vote="down"]{color:rgb(252,165,165);border-color:rgba(239,68,68,.35);}
${P} .tp-chip .tp-n{margin-left:4px;font-size:10px;color:#6b7280;}
${P} .tp-chip[data-hide="1"]{color:rgb(252,165,165);background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.45);}
${P} .tp-chip[data-hide="1"]:hover{border-color:rgba(239,68,68,.7);color:#fff;}
${P} .tp-chip[data-hide="1"][data-vote="up"]{background:rgba(239,68,68,.22);border-color:rgba(239,68,68,.6);}
${P} .tp-opt[data-hide="1"]{color:rgb(252,165,165);}
${P} .tp-opt[data-hide="1"] b{color:rgb(255,120,120);}
${P} .tp-opt .tp-ban{margin-right:6px;color:rgb(255,110,110);}
${P} .tp-label{margin-top:10px;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;}
${P} .tp-label[hidden]{display:none;}
${P} .tp-label + .tp-chips{margin-top:5px;}
${P} .tp-have{max-height:150px;overflow-y:auto;}
${P} .tp-note{font-size:12px;color:#6b7280;}
${P} .tp-msg{margin-top:8px;font-size:12px;color:#9ca3af;}
${P} .tp-msg:empty{display:none;}
${P} .tp-msg[data-err]{color:rgb(255,110,110);}`;
        (document.head || document.documentElement).appendChild(st);
    }

    function closeTagPopup() { document.getElementById('pmv-tag-pop')?._pmvClose?.(); }

    // Tag votes on the video, as the site's Vote on Tags modal has them: [{ tag, upvotes, downvotes, score, userVote }].
    async function videoTagStats(id, kind = 'general') {
        const st = await (await fetch(`/api/videos/${id}/tags/stats`, { credentials: 'include' })).json();
        const list = st?.data?.[tagKind(kind).stats];
        return Array.isArray(list) ? list : [];
    }

    // Compact tag menu: the video's tags (click = upvote, again = remove your upvote), plus an input
    // with autocomplete and recent tags for adding. Used after a reject ("Tag video") and by the tag
    // button in the action bar under the video ("Tags"). Opens under (or above) the rect it was
    // opened from (the card itself may be hidden by the filter by then); align 'right' lines up the
    // right edges. Closes on Esc, ✕, or a click outside; stays open for more tags.
    function openTagPopup(id, rect, title, { heading = 'Tag video', align = 'left', toggleEl = null, kind = 'general' } = {}) {
        closeTagPopup();
        ensureTagPopStyle();
        const K = tagKind(kind);
        const tagType = kind === 'stars' ? 'stars' : 'general';
        const pop = document.createElement('div');
        pop.id = 'pmv-tag-pop';
        pop.dataset.forVideo = id;
        pop.dataset.kind = tagType;
        pop.innerHTML = `
            <div class="tp-head"><span class="tp-title">${K.icon}${escHtml(heading)}</span><button type="button" class="tp-x" title="Close (Esc)">✕</button></div>
            ${title ? `<div class="tp-sub" title="${escHtml(title)}">${escHtml(title)}</div>` : ''}
            <div class="tp-in">
                <input type="text" maxlength="${K.max}" placeholder="Add a ${K.noun}\u2026" spellcheck="false" autocomplete="off">
                <button type="button" class="tp-add">Add</button>
                <div class="tp-sug" hidden></div>
            </div>
            <div class="tp-label" data-recent-label hidden>Recent</div>
            <div class="tp-chips" data-recent></div>
            <div class="tp-label" data-have-label>On this video</div>
            <div class="tp-chips tp-have" data-have><span class="tp-note">Loading…</span></div>
            <div class="tp-msg"></div>`;
        const input = pop.querySelector('input');
        const addBtn = pop.querySelector('.tp-add');
        const sug = pop.querySelector('.tp-sug');
        const haveBox = pop.querySelector('[data-have]');
        const recentBox = pop.querySelector('[data-recent]');
        const recentLabel = pop.querySelector('[data-recent-label]');
        const msg = pop.querySelector('.tp-msg');
        let have = null;       // stats, null while loading
        let vocab = [];
        let hi = -1;
        let busy = false;
        const onVideo = t => !!have?.some(x => String(x.tag).toLowerCase() === t.toLowerCase());
        const say = (text, err) => { if (err) msg.dataset.err = '1'; else delete msg.dataset.err; msg.textContent = text || ''; };

        const paintRecent = () => {
            recentBox.innerHTML = '';
            const list = recentTags(kind).filter(t => !onVideo(t)).slice(0, 6);
            list.forEach(t => {
                const c = document.createElement('button');
                c.type = 'button';
                c.className = 'tp-chip';
                const by = tagHiddenBy(t);
                c.textContent = (by ? '\u2298 ' : '+ ') + K.pre + t;
                if (by) c.dataset.hide = '1';
                c.title = by ? `Add this ${K.noun} \u2014 your filter hides videos with it (\u2298 ${by})` : `Add this ${K.noun}`;
                c.onclick = () => submit(t);
                recentBox.appendChild(c);
            });
            recentLabel.hidden = !list.length;
        };
        const paintHave = () => {
            haveBox.innerHTML = '';
            if (!have) { haveBox.innerHTML = `<span class="tp-note">Could not load ${K.noun}s</span>`; return; }
            if (!have.length) { haveBox.innerHTML = `<span class="tp-note">No ${K.noun}s yet</span>`; return; }
            [...have].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).forEach(t => {
                const c = document.createElement('button');
                c.type = 'button';
                c.className = 'tp-chip';
                const up = t.userVote === 'upvote', down = t.userVote === 'downvote';
                c.dataset.vote = up ? 'up' : down ? 'down' : '';
                const by = tagHiddenBy(t.tag);
                if (by) c.dataset.hide = '1';
                c.innerHTML = `${by ? '\u2298 ' : up ? '\u2713 ' : ''}${K.pre}${escHtml(t.tag)}<span class="tp-n">${escHtml(t.score ?? 0)}</span>`;
                c.title = `${t.upvotes ?? 0} up \u2022 ${t.downvotes ?? 0} down \u2014 ` + (up ? 'click to remove your upvote' : 'click to upvote')
                    + (by ? ` \u2014 your filter hides videos with it (\u2298 ${by})` : '');
                c.onclick = () => toggleVote(t);
                haveBox.appendChild(c);
            });
        };
        async function reload() {
            try { have = await videoTagStats(id, kind); } catch { have = null; }
            if (!pop.isConnected) return;
            paintHave();
            paintRecent();
            place();
        }
        async function toggleVote(t) {
            if (busy) return;
            busy = true;
            say(t.userVote === 'upvote' ? 'Removing vote…' : 'Voting…');
            try {
                await postSiteJson(`/api/videos/${id}/tags/vote`, { tag: t.tag, voteType: 'upvote', tagType });
                forgetVideo(id);
                say(t.userVote === 'upvote' ? `Removed your vote on ${K.pre}${t.tag}` : `Upvoted ${K.pre}${t.tag}`);
                if (t.userVote !== 'upvote') rememberTag(t.tag, kind);
                await reload();
            } catch (e) {
                say(e?.message || 'Vote failed', true);
            } finally {
                busy = false;
            }
        }

        const options = () => [...sug.querySelectorAll('.tp-opt')];
        const paintHi = () => options().forEach((o, i) => { o.dataset.hi = i === hi ? '1' : ''; if (i === hi) o.scrollIntoView({ block: 'nearest' }); });
        const paintSug = () => {
            const q = input.value.trim().replace(/^#+/, '').toLowerCase();
            hi = -1;
            if (!q) { sug.hidden = true; sug.innerHTML = ''; return; }
            const starts = [], has = [];
            for (const t of vocab) {
                const l = t.toLowerCase();
                if (l === q || onVideo(t)) continue;
                if (l.startsWith(q)) starts.push(t); else if (l.includes(q)) has.push(t);
                if (starts.length >= 8) break;
            }
            const list = [...starts, ...has].slice(0, 8);
            sug.innerHTML = '';
            list.forEach(t => {
                const o = document.createElement('button');
                o.type = 'button';
                o.className = 'tp-opt';
                const i = t.toLowerCase().indexOf(q);
                const by = tagHiddenBy(t);
                o.innerHTML = (by ? '<span class="tp-ban">\u2298</span>' : '') + escHtml(t.slice(0, i)) + '<b>' + escHtml(t.slice(i, i + q.length)) + '</b>' + escHtml(t.slice(i + q.length));
                if (by) { o.dataset.hide = '1'; o.title = `Your filter hides videos with this tag (\u2298 ${by})`; }
                o.onmousedown = e => e.preventDefault();
                o.onclick = () => submit(t);
                sug.appendChild(o);
            });
            sug.hidden = !list.length;
        };

        async function submit(raw) {
            const tag = String(raw || '').replace(/^#+/, '').replace(/\s+/g, ' ').trim();
            if (!tag || busy) return;
            if (tag.length > K.max) { say(`At most ${K.max} characters`, true); return; }
            busy = true;
            input.disabled = addBtn.disabled = true;
            say('Adding…');
            sug.hidden = true;
            try {
                const r = await tagVideoOnSite(id, tag, kind);
                rememberTag(tag, kind);
                const by = tagHiddenBy(tag);
                const nm = K.pre + tag;
                say((r === 'added' ? `${nm} added with +1 vote` : r === 'voted' ? `Upvoted ${nm}` : `You already upvoted ${nm}`)
                    + (by ? ` \u2014 your filter now hides this video (\u2298 ${by})` : ''));
                input.value = '';
                await reload();
            } catch (e) {
                say(e?.message || 'Failed to add tag', true);
            } finally {
                busy = false;
                input.disabled = addBtn.disabled = false;
                if (pop.isConnected) input.focus();
            }
        }

        input.addEventListener('input', paintSug);
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            const opts = options();
            if (e.key === 'ArrowDown' && !sug.hidden && opts.length) { e.preventDefault(); hi = (hi + 1) % opts.length; paintHi(); }
            else if (e.key === 'ArrowUp' && !sug.hidden && opts.length) { e.preventDefault(); hi = hi <= 0 ? opts.length - 1 : hi - 1; paintHi(); }
            else if (e.key === 'Tab' && !sug.hidden && opts.length) { e.preventDefault(); input.value = opts[Math.max(0, hi)].textContent; paintSug(); }
            else if (e.key === 'Enter') { e.preventDefault(); submit(hi >= 0 && opts[hi] ? opts[hi].textContent : input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); if (!sug.hidden) { sug.hidden = true; hi = -1; } else close(); }
        });
        input.addEventListener('keyup', e => e.stopPropagation());
        input.addEventListener('keypress', e => e.stopPropagation());
        addBtn.onclick = () => submit(input.value);
        pop.querySelector('.tp-x').onclick = () => close();

        // A click on the button that opened it is left to that button (it toggles).
        const onDown = e => { const path = e.composedPath(); if (!path.includes(pop) && !(toggleEl && path.includes(toggleEl))) close(); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        function close() {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
            pop.remove();
        }
        pop._pmvClose = close;

        // Below the anchor when it fits, otherwise above; kept inside the viewport. Redone when the
        // tag list arrives (it changes the height).
        let above = null;
        function place() {
            const w = pop.offsetWidth, h = pop.offsetHeight;
            const vw = document.documentElement.clientWidth, vh = window.innerHeight;
            const r = rect && rect.width ? rect : { left: vw / 2 - w / 2, right: vw / 2 + w / 2, top: vh / 2 - h / 2, bottom: vh / 2 - h / 2 };
            if (above === null) above = r.bottom + 6 + h + 220 > vh && r.top - h - 6 > 8;
            const top = above ? r.top - h - 6 : r.bottom + 6;
            pop.style.top = Math.round(Math.max(8, Math.min(top, vh - h - 8))) + 'px';
            const left = align === 'right' ? r.right - w : r.left;
            pop.style.left = Math.round(Math.max(8, Math.min(left, vw - w - 8))) + 'px';
        }

        paintRecent();
        (document.fullscreenElement || document.body).appendChild(pop);
        place();
        setTimeout(() => {
            if (!pop.isConnected) return;
            document.addEventListener('pointerdown', onDown, true);
            document.addEventListener('keydown', onKey, true);
        }, 0);
        input.focus({ preventScroll: true });
        reload();
        popularTags(kind).then(v => { vocab = v || []; if (pop.isConnected && input.value) paintSug(); });
        return pop;
    }

    // Toggle for any playlist mapped to any key (press again within 3s to confirm
    // removal). A key mapped to the reject list uses rejectCurrentVideo.
    async function handlePlaylistHotkey(playlistId) {
        if (isRejectList(playlistId)) return rejectCurrentVideo();
        const videoId = getCurrentVideoId();
        if (!videoId) { toast('No video'); return; }
        const plName = getPlaylistDisplayName(State.playlists.get(playlistId)?.name) || playlistId;
        const isMember = getMatches(videoId).some(p => p.id === playlistId);

        if (isMember) {
            if (State.pendingRemove && State.pendingRemoveVideoId === videoId && State.pendingRemovePlaylistId === playlistId) {
                State.pendingRemove = false;
                clearTimeout(State.pendingRemoveTimeout);
                const ok = await removeFromPlaylist(videoId, playlistId);
                updateNativePlaylistButtons();
                toast(ok ? '✕ ' + plName : 'Remove failed', ok ? 'red' : null);
                return;
            }
            State.pendingRemove = true;
            State.pendingRemoveVideoId = videoId;
            State.pendingRemovePlaylistId = playlistId;
            toast(`Already in "${plName}" - press again to remove`);
            State.pendingRemoveTimeout = setTimeout(() => { State.pendingRemove = false; }, 3000);
            return;
        }

        const wasRejected = isRejected(videoId);
        const ok = await addToPlaylist(videoId, playlistId);
        updateNativePlaylistButtons(true);
        if (wasRejected) scheduleBadges();
        if (!ok) { toast('Add failed'); return; }
        toast('✓ ' + plName + (wasRejected ? ' (removed from reject list)' : ''), 'green');
    }

    // Returns false when the binding declined the key; anything else (a Promise
    // included) means it took it. Decided synchronously, since it settles whether
    // the site's handler may still run.
    function runBinding(binding) {
        if (!binding) return false;
        if (binding.action === 'playlist') {
            handlePlaylistHotkey(binding.playlistId).catch(() => {});
            return true;
        }
        if (binding.action?.startsWith('builtin:')) {
            const fn = BUILTIN_ACTIONS[binding.action.slice(8)];
            if (!fn) return false;
            const result = fn.run();
            if (result === false) return false;
            if (result && typeof result.catch === 'function') result.catch(() => {});
            return true;
        }
        return false;
    }

    // Bound keys are exclusive: this listens on window in the capture phase and,
    // once a binding takes the key, stopImmediatePropagation keeps the site's
    // handler (F, space, J, arrows, 0-9, N) and later listeners from seeing it.
    // Ctrl/Alt/Cmd presses are browser chords and never hotkeys. An action can
    // decline by returning false from run() ("next" does when Up next has nothing
    // ahead).
    window.addEventListener('keydown', e => {
        if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
        if (dispatchingSyntheticNext) return;
        // The hotkey editor takes letters itself (pressing a key selects it).
        if (document.getElementById('pmv-keyeditor')) return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
        const binding = keybindings[e.key.toLowerCase()];
        if (!binding) return;
        if (runBinding(binding) === false) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    // ---------------------------------------------------------------------
    // Player keys
    // ---------------------------------------------------------------------
    // The site's player shortcuts (F, space, J, arrows, 0-9) are bound in its
    // player's onMounted and dropped in onUnmounted; after an in-page hop
    // (router.push) their handler can stop working. The same shortcuts are
    // implemented here directly on the <video> and are assignable like other
    // hotkeys.
    // Listens on window in the bubble phase and stands down when the site already
    // handled the key (preventDefault). User-bound keys are swallowed earlier, in
    // the capture phase.
    // Volume keys are omitted: the HUD holds volume at 100%.
    function playerFullscreenTarget() {
        const video = getVideo();
        if (!video) return null;
        // The wrapper the site itself fullscreens (.hls-player-wrapper), so its
        // fullscreenchange bookkeeping stays correct. Not the <video>, which
        // drops their controls; panels mount into document.fullscreenElement.
        return video.closest('.hls-player-wrapper')
            || video.closest('[class*="player"], [class*="video-container"]')
            || video.parentElement || video;
    }

    function toggleVideoFullscreen() {
        if (document.fullscreenElement) {
            try { document.exitFullscreen(); } catch {}
            return;
        }
        const target = playerFullscreenTarget();
        try { target?.requestFullscreen?.().catch(() => {}); } catch {}
    }

    function seekVideoBy(seconds) {
        const video = getVideo();
        if (!video) return;
        const end = Number.isFinite(video.duration) ? video.duration : null;
        const next = video.currentTime + seconds;
        video.currentTime = Math.max(0, end === null ? next : Math.min(end, next));
    }

    // key -> built-in action; mirrors the site's bindings.
    const PLAYER_KEY_DEFAULTS = {
        ' ': 'playPause',
        k: 'playPause',
        f: 'fullscreen',
        j: 'skipBack10',
        arrowleft: 'seekBack5',
        a: 'seekBack5',
        arrowright: 'seekForward5',
        d: 'seekForward5',
    };

    // Cheat sheet entries, built from the table above.
    function playerKeyRows() {
        const shown = key => key === ' ' ? 'Space'
            : key === 'arrowleft' ? '←'
            : key === 'arrowright' ? '→'
            : key.toUpperCase();
        const byAction = new Map();
        Object.entries(PLAYER_KEY_DEFAULTS).forEach(([key, action]) => {
            if (!byAction.has(action)) byAction.set(action, []);
            byAction.get(action).push(shown(key));
        });
        const rows = [...byAction.entries()]
            .map(([action, keys]) => [keys.join(' / '), BUILTIN_ACTIONS[action]?.label || action]);
        rows.push(['0 - 9', 'Seek to 0-90%']);
        return rows;
    }

    // When the site's own switch disables its shortcuts, these stay out of the way
    // too.
    function siteShortcutsDisabled() {
        try {
            return JSON.parse(localStorage.getItem(SITE_PREFS_KEY) || 'null')?.disableKeyboardShortcuts === true;
        } catch { return false; }
    }

    function playerKeysApply(e) {
        if (e.ctrlKey || e.altKey || e.metaKey) return false;
        if (document.getElementById('pmv-keyeditor')) return false;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return false;
        if (keybindings[e.key.toLowerCase()]) return false;   // a custom binding wins
        // Only where the page has a player; card hover previews are <video>
        // elements too.
        if (!/^\/(video|playlists)\//.test(location.pathname)) return false;
        if (siteShortcutsDisabled()) return false;
        return !!getVideo();
    }

    // Fullscreen is taken over in the capture phase: the site's F can fail after an
    // in-page hop (a stale handler calls preventDefault and targets a detached
    // wrapper). stopImmediatePropagation avoids two handlers racing.
    document.addEventListener('keydown', e => {
        if (e.key.toLowerCase() !== 'f' || !playerKeysApply(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleVideoFullscreen();
    }, true);

    // The other keys only act where nothing else did: the site's handler normally
    // still reaches them, so this is a safety net for when it is gone.
    window.addEventListener('keydown', e => {
        if (e.defaultPrevented) return;
        const key = e.key.toLowerCase();
        if (key === 'f') return;             // owned above
        if (!playerKeysApply(e)) return;
        const video = getVideo();

        if (/^[0-9]$/.test(key)) {
            if (!Number.isFinite(video.duration) || video.duration <= 0) return;
            e.preventDefault();
            video.currentTime = video.duration * (Number(key) / 10);
            return;
        }

        const action = BUILTIN_ACTIONS[PLAYER_KEY_DEFAULTS[key]];
        if (!action) return;
        // Synchronous within the key event: a fullscreen request after an await
        // loses user activation.
        e.preventDefault();
        try { action.run(); } catch {}
    });

    // Binding description shared by the cheat sheet and keyboard editor.
    function describeBinding(binding) {
        if (!binding) return null;
        if (binding.action === 'playlist') {
            const name = getPlaylistDisplayName(State.playlists.get(binding.playlistId)?.name) || binding.playlistId;
            return isRejectList(binding.playlistId)
                ? `"${name}" reject (out of every other playlist, next video)`
                : `"${name}" toggle (press again within 3 s to remove)`;
        }
        if (binding.action?.startsWith('builtin:')) {
            return BUILTIN_ACTIONS[binding.action.slice(8)]?.label || null;
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // Hotkey cheat sheet
    // ---------------------------------------------------------------------
    // Lists all hotkeys from `keybindings`, so it stays correct after remaps.
    function toggleHotkeyCheatSheet() {
        const existing = document.getElementById('pmv-hotkeys');
        if (existing) { existing.remove(); return; }

        const rows = Object.entries(keybindings)
            .map(([key, binding]) => ({ key, desc: describeBinding(binding) }))
            .filter(r => r.desc)
            .sort((a, b) => a.key.localeCompare(b.key))
            .map(r => `<tr><td style="color:rgb(100,255,0);padding-right:16px;">${r.key.toUpperCase()}</td><td>${r.desc}</td></tr>`)
            .join('');

        const box = document.createElement('div');
        box.id = 'pmv-hotkeys';
        box.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: rgba(20,20,20,0.97); border: 1px solid rgba(255,255,255,0.15);
            border-radius: 12px; padding: 18px 22px; z-index: 999999;
            color: rgba(255,255,255,0.85); font-size: 13px;
            font-family:inherit;font-variant-numeric:tabular-nums; line-height: 1.9;
            min-width: 340px; backdrop-filter: blur(10px);
        `;
        box.innerHTML = `
            <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:white;">⌨ Hotkeys</div>
            <table style="border-collapse:collapse;width:100%;">
                ${rows}
                <tr><td colspan="2" style="color:rgba(255,255,255,0.4);padding-top:8px;">Player (only when the site leaves the key alone):</td></tr>
                ${playerKeyRows().map(([keys, label]) => `<tr><td style="color:rgb(100,255,0);padding-right:16px;">${escHtml(keys)}</td><td>${escHtml(label)}</td></tr>`).join('')}
                <tr><td colspan="2" style="color:rgba(255,255,255,0.4);padding-top:8px;">In the playlist filter box (playlist pages):</td></tr>
                <tr><td style="color:rgb(100,255,0);">Enter</td><td>Apply filter</td></tr>
                <tr><td style="color:rgb(100,255,0);">Escape</td><td>Clear filter</td></tr>
                <tr><td colspan="2" style="color:rgba(255,255,255,0.4);padding-top:8px;">Anywhere:</td></tr>
                <tr><td style="color:rgb(100,255,0);">Ctrl/Cmd+K</td><td>Search (videos, playlists) + open Up next</td></tr>
            </table>
            <div style="margin-top:14px;font-size:11px;color:rgba(255,255,255,0.3);">
                Bind hotkeys to your own key/playlist: the site's full Settings page (/settings) → PMVH Extended → Assign hotkeys.<br>
                Press ? again, or click outside this window, to close.
            </div>
        `;
        document.body.appendChild(box);
        setTimeout(() => document.addEventListener('click', function close(e) {
            if (!box.contains(e.target)) { box.remove(); document.removeEventListener('click', close); }
        }), 0);
    }

    // Only the bottom strip of the screen opens the HUD on mousemove, avoiding
    // conflicts with the queue sidebar hover (right edge). The "i" key shows it
    // regardless.
    const HUD_BOTTOM_ZONE_PX = 300;

    document.addEventListener('mousemove', e => {
        if (!document.fullscreenElement || State.quietMode) return;
        // Stay out of the way while the cursor is over the open queue sidebar
        // (380px wide, much larger than its 24px trigger strip).
        if (State.queueSidebarVisible && State.queueOverlayEl?.matches(':hover')) return;
        // Over the seek bar (the site's or the HUD's own strip) the preview
        // takes priority; the panel does not open there and closes if open.
        const target = e.target instanceof Element ? e.target : null;
        if (target && (target.closest(SCRUB_BAR_SELECTOR) || target.closest('#pmv-scrub-zone'))) {
            if (State.hud) closeHud();
            return;
        }
        const inBottomZone = e.clientY > window.innerHeight - HUD_BOTTOM_ZONE_PX;
        const inQueueEdgeZone = isPlaylistPage() && e.clientX > window.innerWidth - QUEUE_EDGE_ZONE_PX;
        if (!inBottomZone || inQueueEdgeZone) return;
        if (State.hud) { if (!State.hud.matches(':hover')) startHudTimer(1400); return; }
        if (!State.quietMode) showHud();
    });

    // ---------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------

    function init() {
        const hasCache = loadCache();
        try { learnVideoIdsFromNuxtPayload(); } catch {}

        try {
            observer.observe(document.body, { childList: true, subtree: true });
        } catch {}

        getVideo();
        forceVolume100({ silent: true });
        onPossibleVideoChange();
        // The header button works on title/rating/length, so it is created
        // before the playlist cache arrives.
        try { attachFilterButton(); } catch {}
        try { applyFilterToCards(); } catch {}
        // The bar is placed off the header row's box; reposition it when that
        // box moves.
        window.addEventListener('resize', () => { hdrDirty = true; try { ensureHeaderBar(); } catch {} });
        // Written as early as possible: the site reads its page size at init.
        try { syncSitePrefs(); } catch {}

        if (!hasCache) {
            refreshUserPlaylists({ force: true }).then(() => {
                scheduleBadges();
                kickRecommended();
            }).catch(e => {
            });
        } else {
            scheduleBadges();
            kickRecommended();
            requestAnimationFrame(() => updateNativePlaylistButtons(true));
            refreshUserPlaylists({ force: false }).then(() => {
                scheduleBadges();
                kickRecommended();
            }).catch(e => {
            });
        }



    }

    // The fetch interceptor is already active from document-start. init() needs the
    // DOM: wait for "load" so Vue is ready (it fires in background tabs too).
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init, { once: true });
    }
})();




