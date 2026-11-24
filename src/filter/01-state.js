    // --- State ---

    const NF = {
        input: null, // native Vue filter input
        ownInput: null,
        pollTimer: null,
        lastOwnValue: '',
        lastNativeValue: '',
        vuePatchApplied: false,
        defaultTerms: '',
    };

    const BTN = {
        playlistMode: 'all',   // 'all' | 'in' | 'out'
        selectedPlaylistIds: [], // counted by playlistMode; empty = any playlist
        savedSearch: null, // { excludeTags, minRating, aspectFilter }
        savedSearches: null,
        savedSearchName: '',
        ratingMin: 0, // independent of savedSearch.minRating
        ratingMax: 100,
        durationMin: 0, // seconds; Infinity max = no cap
        durationMax: Infinity,
        flags: {}, // content flag key -> 'out' (hide) | 'in' (only these)
    };

    // Staged values; onOwnInput() (Enter / Filter button) commits them to BTN.*.
    let pendingPlaylistMode = BTN.playlistMode;
    let pendingSelectedPlaylistIds = BTN.selectedPlaylistIds.slice();
    let pendingSavedSearch = BTN.savedSearch;
    let pendingSavedSearchName = BTN.savedSearchName;
    let pendingRatingMin = BTN.ratingMin;
    let pendingRatingMax = BTN.ratingMax;
    let pendingDurationMin = BTN.durationMin;
    let pendingDurationMax = BTN.durationMax;
    let pendingFlags = { ...BTN.flags };
    let pendingDefaultTerms = '';
    let updatePlBtn = () => {};
    let updateSsBtn = () => {};
    let updateRatBtn = () => {};
    let updateDurBtn = () => {};
    let updateFlagBtns = () => {};
    let updateDefaultsBtn = () => {};


    // --- Persisted filter settings ---
    const SETTINGS_KEY = 'pmvnf_filter_settings_v1';
    // Shared by all text filters: terms also match the description. Default on.
    const DESC_KEY = 'pmvnf_match_desc_v1';
    function matchDescEnabled() { try { return localStorage.getItem(DESC_KEY) !== '0'; } catch { return true; } }

    // Shared with other modules: one JSON parse per response; URLs the core interceptor skips.
    const pmvResJson = PMVX.resJson || (PMVX.resJson = res => {
        if (!res.__pmvJson) {
            try { res.__pmvJson = res.clone().json(); }
            catch (e) { res.__pmvJson = Promise.reject(e); }
            res.__pmvJson.catch(() => {});
        }
        return res.__pmvJson;
    });
    const quietUrls = PMVX.quietUrls || (PMVX.quietUrls = new Set());
    function setMatchDesc(on) { try { localStorage.setItem(DESC_KEY, on ? '1' : '0'); } catch {} }

    function isSetEqual(a, b) {
        if (a.length !== b.length) return false;
        const sa = new Set(a);
        return b.every(id => sa.has(id));
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({
                textFilter: NF.lastOwnValue,
                playlistMode: BTN.playlistMode,
                selectedPlaylistIds: BTN.selectedPlaylistIds,
                savedSearch: BTN.savedSearch,
                savedSearchName: BTN.savedSearchName,
                ratingMin: BTN.ratingMin,
                ratingMax: BTN.ratingMax,
                durationMin: BTN.durationMin,
                // Infinity is not valid JSON; -1 stands for 'no cap'.
                durationMax: Number.isFinite(BTN.durationMax) ? BTN.durationMax : -1,
                flags: BTN.flags,
            }));
        } catch {}
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (typeof s.textFilter === 'string') NF.lastOwnValue = s.textFilter;
            if (s.playlistMode === 'all' || s.playlistMode === 'in' || s.playlistMode === 'out') {
                BTN.playlistMode = s.playlistMode;
            }
            if (Array.isArray(s.selectedPlaylistIds)) BTN.selectedPlaylistIds = s.selectedPlaylistIds.slice();
            if (s.savedSearch && typeof s.savedSearch === 'object') BTN.savedSearch = s.savedSearch;
            if (typeof s.savedSearchName === 'string') BTN.savedSearchName = s.savedSearchName;
            if (typeof s.ratingMin === 'number') BTN.ratingMin = s.ratingMin;
            if (typeof s.ratingMax === 'number') BTN.ratingMax = s.ratingMax;
            if (typeof s.durationMin === 'number') BTN.durationMin = s.durationMin;
            if (typeof s.durationMax === 'number') BTN.durationMax = s.durationMax < 0 ? Infinity : s.durationMax;
            if (s.flags && typeof s.flags === 'object') BTN.flags = { ...s.flags };
        } catch {}
        pendingPlaylistMode = BTN.playlistMode;
        pendingSelectedPlaylistIds = BTN.selectedPlaylistIds.slice();
        pendingSavedSearch = BTN.savedSearch;
        pendingSavedSearchName = BTN.savedSearchName;
        pendingRatingMin = BTN.ratingMin;
        pendingRatingMax = BTN.ratingMax;
        pendingDurationMin = BTN.durationMin;
        pendingDurationMax = BTN.durationMax;
        pendingFlags = { ...BTN.flags };
    }

    loadSettings();

    const sameFlags = (a, b) => { const ka = Object.keys(a).filter(k => a[k]), kb = Object.keys(b).filter(k => b[k]); return ka.length === kb.length && ka.every(k => a[k] === b[k]); };
    const flagKeysActive = () => Object.keys(BTN.flags).filter(k => BTN.flags[k]);
    // True when a known flag rules the video out; an unknown flag never does.
    function flagsReject(videoId) {
        if (!videoId || typeof PMVX.videoFlag !== 'function') return false;
        for (const key of flagKeysActive()) {
            const v = PMVX.videoFlag(videoId, key);
            if (v === undefined) continue;
            if (BTN.flags[key] === 'out' && v) return true;
            if (BTN.flags[key] === 'in' && !v) return true;
        }
        return false;
    }

    // --- Default filter terms ---
    // Same syntax as the search bar; always prepended to the typed text.
    const DEFAULT_TERMS_KEY = 'pmvnf_default_terms_v1';

    function loadDefaultTerms() {
        try {
            const raw = localStorage.getItem(DEFAULT_TERMS_KEY);
            if (typeof raw === 'string') NF.defaultTerms = raw;
        } catch {}
    }

    function saveDefaultTerms() {
        try { localStorage.setItem(DEFAULT_TERMS_KEY, NF.defaultTerms); } catch {}
    }

    loadDefaultTerms();
    pendingDefaultTerms = NF.defaultTerms;

    // Input for parseTokens(). Never sent to Vue's own input.
    function getEffectiveFilterValue(ownValue) {
        return (NF.defaultTerms + ' ' + ownValue).trim();
    }

    // In selected playlists (or any when none selected); this page's playlist never counts.
    function inSelectedPlaylists(memberOf) {
        const here = PMVX.currentPlaylistPageId();
        const ids = BTN.selectedPlaylistIds.filter(id => id !== here);
        if (ids.length) return ids.some(id => memberOf.has(id));
        if (BTN.selectedPlaylistIds.length) return null; // only this playlist was selected: no effect
        for (const id of memberOf) if (id !== here) return true;
        return false;
    }

    // Saved state only fills the controls; filtering starts after Enter/Filter in this session.
    let sessionFilterArmed = false;

    // Off shows every row but keeps the settings; applying turns it on, a stored "off" is dropped.
    const ENABLED_KEY = 'pmvnf_enabled_v1';
    NF.enabled = true;
    try { localStorage.removeItem(ENABLED_KEY); } catch {}
    function filterLive() { return sessionFilterArmed && NF.enabled; }
    function setFilterEnabled(on, { refilter = true } = {}) {
        NF.enabled = !!on;
        PMVX.clearActed();
        try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch {}
        try { NF.renderPower?.(); } catch {}
        try { refreshPendingMarks(); } catch {}
        if (!refilter) return;
        // Switching on before anything was applied counts as pressing Filter.
        if (on && !sessionFilterArmed && NF.applyAll) { NF.applyAll(); return; }
        applyFilter(NF.lastOwnValue, /* force= */ true);
    }

    // Gate re-evaluation on hasAnyActiveFilter(), not NF.lastOwnValue, or button-only filters are missed.
    PMVX.filterChecks.push(() => location.pathname.startsWith('/playlists/') && hasAnyActiveFilter());
    function queueRows() {
        return [...document.querySelectorAll('[role="button"]')].filter(r => !r.closest('aside, nav, [id^="pmv"]'));
    }

    function hasAnyActiveFilter() {
        return filterLive() && (
            !!NF.lastOwnValue
            || !!NF.defaultTerms
            || BTN.playlistMode !== 'all'
            || BTN.savedSearch !== null
            || BTN.ratingMin > 0 || BTN.ratingMax < 100
            || BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)
            || flagKeysActive().length > 0
        );
    }

    // --- Playlist data ---

    const CACHE_KEY = 'pmv_firefox_playlist_cache_v1';

    let playlistsMap = new Map(); // id → { id, name, ids: Set<videoId> }
    let reverseMap   = new Map(); // videoId → Set<playlistId>

    async function fetchSavedSearches() {
        if (BTN.savedSearches) return BTN.savedSearches;
        try {
            const res = await fetch('/api/saved-searches', { credentials: 'include' });
            if (!res.ok) return [];
            const data = await res.json();
            // Response shape: { success, data: [...] }
            BTN.savedSearches = Array.isArray(data) ? data
                : Array.isArray(data.data) ? data.data
                : (data.searches || data.savedSearches || []);
            return BTN.savedSearches;
        } catch { return []; }
    }

    function parseSavedSearch(ss) {
        const raw = ss.filters || ss.params || ss.query || ss;
        const rawTags = raw.excludeTags ?? raw.exclude_tags ?? [];
        const excludeTags = (typeof rawTags === 'string' ? rawTags.split(',') : rawTags)
            .map(t => t.trim().toLowerCase()).filter(Boolean);
        const hasAspect = Array.isArray(raw.aspect) ? raw.aspect.length > 0 : !!(raw.aspect);
        const excludeGay   = raw.includeGay   === 'exclude' || raw.excludeGay   === true;
        const excludeTrans = raw.includeTrans  === 'exclude' || raw.excludeTrans === true;
        const minRating = raw.minRating ? Number(raw.minRating) : 0;
        const rawAspect = Array.isArray(raw.aspect) ? raw.aspect : (raw.aspect ? [raw.aspect] : []);
        return { excludeTags, minRating, aspectFilter: hasAspect, excludeGay, excludeTrans, _rawAspect: rawAspect };
    }

    function loadPlaylistCache() {
        try {
            const s = PMVX.state;
            if (s?.playlists?.size) {
                playlistsMap = s.playlists;
                reverseMap   = s.reverse;
                return playlistsMap.size > 0;
            }
        } catch {}

        // Fallback: localStorage cache (core not ready yet).
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return false;
            const cached = JSON.parse(raw);
            if (!Array.isArray(cached.playlists)) return false;

            playlistsMap.clear();
            reverseMap.clear();

            cached.playlists.forEach(p => {
                const ids = new Set(p.ids || []);
                playlistsMap.set(p.id, { id: p.id, name: p.name, ids });
                ids.forEach(vid => {
                    if (!reverseMap.has(vid)) reverseMap.set(vid, new Set());
                    reverseMap.get(vid).add(p.id);
                });
            });

            return playlistsMap.size > 0;
        } catch { return false; }
    }

    window.addEventListener('pmv:cache-ready', () => {
        loadPlaylistCache();
        if (hasAnyActiveFilter()) {
            requestAnimationFrame(() => applyFilter(NF.lastOwnValue, /* force= */ true));
        }
    });

    window.addEventListener('storage', e => {
        if (e.key !== CACHE_KEY) return;
        loadPlaylistCache();
        // Forced: the localStorage cache has no version for applyFilter's cacheVersion guard.
        if (hasAnyActiveFilter()) {
            requestAnimationFrame(() => applyFilter(NF.lastOwnValue, /* force= */ true));
        }
    });

    // Core wrote clicked tags to the default terms (no storage event here); an added tag arms the filter.
    window.addEventListener('pmv:nf-default-terms', e => {
        loadDefaultTerms();
        pendingDefaultTerms = NF.defaultTerms;
        try { defaultsToUi(pendingDefaultTerms); NF.renderOwnChips?.(); } catch {}
        updateDefaultsBtn();
        try { refreshPendingMarks(); } catch {}
        if (sessionFilterArmed) requestAnimationFrame(() => applyFilter(NF.lastOwnValue, /* force= */ true));
        else if (e.detail?.added && NF.input) onOwnInput(NF.lastOwnValue);
    });

    function getLivePlaylists() {
        try {
            const s = PMVX.state;
            if (s?.playlists?.size) return { playlists: s.playlists, reverse: s.reverse };
        } catch {}
        return { playlists: playlistsMap, reverse: reverseMap };
    }

    // --- Video ID from a row ---
    // Thumbnails carry an asset ID, not the video _id: index lookups first.

    // Hex id in a thumbnail URL: often an asset id, so callers check it against the playlists first.
    function thumbHex(src) {
        const m = src.match(/\/thumbnails\/([a-f0-9]{24})\//) || src.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//) || src.match(/\/([a-f0-9]{24})\/thumbnail\//);
        return m ? m[1] : null;
    }

    function getRowVideoId(row) {
        if (row.dataset.videoId) return row.dataset.videoId;

        // 1. ID resolved by the core.
        if (row.dataset.pmvQueueChecked) {
            const id = row.dataset.pmvQueueChecked;
            // Trust only playlist-known IDs; others may be asset IDs.
            const { reverse } = getLivePlaylists();
            if (reverse?.has(id)) return id;
        }

        const img = row.querySelector('img[src]');
        const huds = PMVX.state;

        // 2. Visible title via titleIndex (img.alt lags when Vue recycles nodes).
        const titleEl = row.querySelector('.flex-1.min-w-0 p, .flex-1.min-w-0 span, .flex-1.min-w-0');
        const visibleTitle = (titleEl?.firstChild?.nodeValue?.trim() ||
                              titleEl?.childNodes?.[0]?.textContent?.trim() ||
                              titleEl?.textContent?.trim() || '').toLowerCase();
        if (visibleTitle && huds?.titleIndex?.has(visibleTitle)) {
            return huds.titleIndex.get(visibleTitle);
        }

        // 3. titleIndex via alt text.
        const alt = img?.alt?.trim().toLowerCase();
        if (alt && huds?.titleIndex?.has(alt)) {
            return huds.titleIndex.get(alt);
        }

        // 4. thumbnailIndex (exact URL).
        if (img?.src && huds?.thumbnailIndex) {
            const clean = img.src.split('?')[0];
            if (huds.thumbnailIndex.has(clean)) return huds.thumbnailIndex.get(clean);
        }

        // 5. Thumbnail URL hex, only if it is in a playlist.
        const { reverse } = getLivePlaylists();
        if (img?.src) {
            const hex = thumbHex(img.src);
            if (hex && reverse?.has(hex)) return hex;
        }

        // 6. Video link href.
        const link = row.querySelector('a[href*="/video/"]') ||
                     row.closest('a[href*="/video/"]');
        if (link?.href) {
            const m = link.href.match(/_([a-f0-9]{24})(?:[?#/]|$)/);
            if (m) return m[1];
        }

        // 7. Unvalidated hex (maybe an asset ID); last resort for !in/!out.
        if (img?.src) {
            const hex = thumbHex(img.src);
            if (hex) return hex;
        }

        return null;
    }

