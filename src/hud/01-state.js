    // --- Configuration ---

    const CACHE_KEY = 'pmv_firefox_playlist_cache_v1';
    const CACHE_TTL = 12 * 60 * 60 * 1000;
    const WATCHED_KEY = 'pmv_watched_v1';
    const WATCHED_MAX = 3000;
    const QUIET_MS = 2200;
    const SOFT_CLEAN_EVERY_VIDEOS = 4;

    // { styles: { "<name or id>": { label?, color } }, order: ["<name or id>", ...] }; names case-insensitive.
    const PLAYLIST_CONFIG_KEY = 'pmv_playlist_config_v1';
    const playlistConfig = (() => {
        try {
            const c = JSON.parse(localStorage.getItem(PLAYLIST_CONFIG_KEY) || '{}');
            return { styles: c.styles || {}, order: (c.order || []).map(s => String(s).trim().toLowerCase()) };
        } catch { return { styles: {}, order: [] }; }
    })();

    // No explicit color: a stable muted one derived from the name.
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

    // Reject list (Settings): exclusive with all other lists; "already saved" shows red instead of green.
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

    function getPlaylistDisplayName(name, id) {
        const s = getPlaylistStyle(name, id);
        return (s && s.label) || name || '';
    }

    // Badges stay green unless a color is set by id; derived colors are skipped so a color keeps its meaning.
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

    // Inactive state: mix toward gray-400 in RGB (low alpha over near-black turns yellow olive).
    const GRAY_RGB = [156, 163, 175];
    function mixToGrayStr(hex, ratio = 0.65) {
        const [r, g, b] = hexToRgbArr(hex);
        const mr = Math.round(r * (1 - ratio) + GRAY_RGB[0] * ratio);
        const mg = Math.round(g * (1 - ratio) + GRAY_RGB[1] * ratio);
        const mb = Math.round(b * (1 - ratio) + GRAY_RGB[2] * ratio);
        return `${mr},${mg},${mb}`;
    }

    // --- State ---

    const State = {
        playlists: new Map(),
        reverse: new Map(),
        cacheLoadedAt: 0,
        refreshPromise: null,
        ready: false,

        currentVideoId: null,
        currentVideoData: null,
        video: null,

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

        thumbnailIndex: new Map(),   // URL without query → _id
        titleIndex: new Map(),       // lowercased title → _id
        videoMeta: new Map(),        // _id → { tags, bayesianRating, width, height, duration, uploader }
        slugToApiId: new Map(),      // slug ID (from href) → API _id

        lastNextHudVideoId: null,
        nextHudEl: null,
        nextHudHideTimer: null,
    };

    try { PMVX.state = State; } catch {}
    PMVX.filterChecks.push(() => State.recFilterMode !== 'all');

    // --- Utilities ---


    // Stripped at write time so lookups need no split().
    function cleanUrl(u) {
        if (!u) return '';
        const q = u.indexOf('?');
        return q === -1 ? u : u.slice(0, q);
    }

    // --- Cache ---

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

    // Use saveCacheSoon(): one write and one pmv:cache-ready event per burst.
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
            notifyCacheReady();
        } catch {}
    }

    function cacheIsFresh() {
        return State.cacheLoadedAt && Date.now() - State.cacheLoadedAt < CACHE_TTL;
    }

