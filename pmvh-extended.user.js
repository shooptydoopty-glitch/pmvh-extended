// ==UserScript==
// @name         PMVH Extended for PMVHaven
// @namespace    https://github.com/shooptydoopty-glitch/pmvh-extended
// @version      1.2.95
// @description  Playlist tools for PMVHaven: playlist buttons and badges everywhere, a fullscreen HUD, an Up next queue, filters for videos and playlists, remappable hotkeys, a command palette and a seekbar preview.
// @author       shooptydoopty-glitch
// @license      MIT
// @homepageURL  https://github.com/shooptydoopty-glitch/pmvh-extended
// @supportURL   https://github.com/shooptydoopty-glitch/pmvh-extended/issues
// @updateURL    https://raw.githubusercontent.com/shooptydoopty-glitch/pmvh-extended/main/pmvh-extended.user.js
// @downloadURL  https://raw.githubusercontent.com/shooptydoopty-glitch/pmvh-extended/main/pmvh-extended.user.js
// @match        https://pmvhaven.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==


(function () {
'use strict';

// --- Core ---
// Shared namespace for cross-module state and hooks; kept off `window` on purpose.
const PMVX = {};

// Runs at document-start so the fetch interceptors see the first API calls; DOM code waits for <body>.
function whenBody(fn) {
    if (document.body) { fn(); return; }
    const root = document.documentElement;
    if (!root) { setTimeout(() => whenBody(fn), 10); return; }
    const mo = new MutationObserver(() => {
        if (!document.body) return;
        mo.disconnect();
        fn();
    });
    mo.observe(root, { childList: true });
}

// --- Performance mode (Settings): how often pages are rescanned, visual ---
// effects and concurrent background requests.
const PERF_KEY = 'pmv_perf_v1';
const PERF_MODES = {
    smooth:   { scanMs: 0,   effects: true,  lookups: 3 },
    balanced: { scanMs: 120, effects: true,  lookups: 3 },
    light:    { scanMs: 400, effects: false, lookups: 1 },
};
let perfMode = (() => { try { const m = localStorage.getItem(PERF_KEY); return PERF_MODES[m] ? m : 'balanced'; } catch { return 'balanced'; } })();
PMVX.perfMode = () => perfMode;
PMVX.perf = () => PERF_MODES[perfMode];
PMVX.setPerfMode = mode => {
    if (!PERF_MODES[mode]) return;
    perfMode = mode;
    try { localStorage.setItem(PERF_KEY, mode); } catch {}
    applyEffectsMode();
};

// No effects: no blur, transitions or animations in our UI, nor the site's blur and pulsing badges.
function applyEffectsMode() {
    const id = 'pmvx-reduced-effects';
    const existing = document.getElementById(id);
    if (PMVX.perf().effects) { existing?.remove(); return; }
    if (existing) return;
    const root = document.head || document.documentElement;
    if (!root) { setTimeout(applyEffectsMode, 10); return; } // document-start: no <html> yet
    const st = document.createElement('style');
    st.id = id;
    st.textContent = `
[id^="pmv"], [id^="pmv"] *, [data-pmv-tools-settings] *, .pmvnf-dd, .header-glass,
.backdrop-blur-sm, .backdrop-blur, .backdrop-blur-md, .backdrop-blur-lg, .backdrop-blur-xl {
  backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
[id^="pmv"], [id^="pmv"] *, [data-pmv-tools-settings] *, .icon-badge, .animate-pulse, .animate-spin {
  transition: none !important; animation: none !important; }
.header-glass { background: rgba(10,10,10,0.97) !important; }`;
    root.appendChild(st);
}
applyEffectsMode();

// Acted-on videos stay visible until a filter is re-applied (clearActed) or the page changes,
// so a card never vanishes under the cursor.
let actedPath = location.pathname;
PMVX.acted = new Set();
function actedFresh() {
    if (location.pathname !== actedPath) { actedPath = location.pathname; PMVX.acted.clear(); }
}
PMVX.markActed = id => { if (!id) return; actedFresh(); PMVX.acted.add(id); };
PMVX.isActed = id => { actedFresh(); return !!id && PMVX.acted.has(id); };
PMVX.clearActed = () => PMVX.acted.clear();

// "=term" matches a whole word only ("=ch" not "challenge"); other terms match anywhere. Lower case.
const termWordRes = new Map();
PMVX.termMatch = (hay, term) => {
    if (!hay || !term) return false;
    if (term.length > 1 && term[0] === '=') {
        const w = term.slice(1);
        let re = termWordRes.get(w);
        if (!re) {
            re = new RegExp('(?:^|[^\\p{L}\\p{N}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^\\p{L}\\p{N}])', 'u');
            if (termWordRes.size > 500) termWordRes.clear();
            termWordRes.set(w, re);
        }
        return re.test(hay);
    }
    return hay.includes(term);
};
PMVX.plainQuotes = s => String(s ?? '').replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019\u201A\u201B]/g, "'");
PMVX.termLabel = term => (term && term.length > 1 && term[0] === '=') ? term.slice(1) : term;
PMVX.isWordTerm = term => !!term && term.length > 1 && term[0] === '=';

// Playlist pages and favourites views, where in/not-in-playlist filters would hide nearly everything.
// Called per card, so cached for 250 ms.
let pfxAt = 0, pfxVal = false;
PMVX.playlistFilterExempt = () => {
    const now = performance.now();
    if (now - pfxAt < 250) return pfxVal;
    pfxAt = now;
    const p = location.pathname.replace(/\/+$/, '') || '/';
    let v = /^\/playlists\/[^/]+/.test(p);
    if (!v && p === '/profile') {
        v = /favorites/i.test(location.hash) || [...document.querySelectorAll('button')]
            .some(b => /^Favorites\b/.test(b.textContent.trim()) && /\btext-orange-4/.test(b.className));
    }
    if (!v && p === '/') {
        v = [...document.querySelectorAll('button')]
            .some(b => b.textContent.trim() === 'Favorites' && /\bbg-orange-|border-orange-|text-orange-/.test(b.className.replace(/hover:\S+/g, '')));
    }
    pfxVal = v;
    return v;
};
PMVX.currentPlaylistPageId = () => location.pathname.match(/^\/playlists\/([a-f0-9]{24})/i)?.[1] || null;

// DOM writes only when the value changes: an unchanged write is still a mutation and wakes every observer.
PMVX.setText = (n, t) => { if (n && n.textContent !== t) n.textContent = t; };
PMVX.setAttr = (n, k, v) => { if (!n) return; if (v == null) { if (n.hasAttribute(k)) n.removeAttribute(k); } else if (n.getAttribute(k) !== v) n.setAttribute(k, v); };

// --- Navigation ---
// One hook on the site's client-side routing (Vue router: pushState; Back/Forward: popstate). replaceState
// (query updates on the same page) is left out on purpose. beforeRoute runs synchronously before pushState,
// with the old page still mounted; onRoute(path, prevPath) runs after the URL changed.
const routeBefore = [], routeAfter = [];
let routeHref = location.href, routePath = location.pathname;
function routeChanged() {
    if (location.href === routeHref) return;
    const prev = routePath;
    routeHref = location.href; routePath = location.pathname;
    routeAfter.forEach(fn => { try { fn(location.pathname, prev); } catch {} });
}
const sitePushState = history.pushState;
history.pushState = function (...a) {
    routeBefore.forEach(fn => { try { fn(); } catch {} });
    const r = sitePushState.apply(this, a);
    setTimeout(routeChanged, 0);
    return r;
};
window.addEventListener('popstate', () => setTimeout(routeChanged, 0));
PMVX.beforeRoute = fn => routeBefore.push(fn);
PMVX.onRoute = fn => routeAfter.push(fn);

PMVX.apiTaps = [];
// [API key, label]. Order matters: the flag cache stores them as bits.
PMVX.contentFlags = [
    ['hasExplicitContent', 'Nudity'], ['hasGayContent', 'Gay'], ['hasTransContent', 'Trans'],
    ['hasExtremeContent', 'Extreme'], ['hasVoiceOver', 'Voice-over'], ['isRemix', 'Remix'],
    ['isPromotional', 'Promo'], ['seizureWarning', 'Seizure warning'],
    ['hasFunscript', 'Funscript'], ['isVertical', 'Vertical'], ['hasMusicData', 'Music'],
];
PMVX.filterChecks = [];
PMVX.anyCardFilterActive = () => PMVX.filterChecks.some(fn => { try { return !!fn(); } catch { return false; } });

// One run per frame, at least `scanMs` apart.
PMVX.scheduler = fn => {
    let pending = false, last = 0;
    return () => {
        if (pending) return;
        pending = true;
        const wait = Math.max(0, last + PMVX.perf().scanMs - performance.now());
        const go = () => requestAnimationFrame(() => { pending = false; last = performance.now(); fn(); });
        if (wait) setTimeout(go, wait); else go();
    };
};

// Playlist-page and /playlists filters: safe at document-start.

(function () {
    'use strict';

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

    // --- Filter syntax ---
    //   foo / -foo           show only / hide rows matching foo (title, tags, performers)
    //   "foo bar" / =foo     whole word or phrase only (also -"foo bar")
    //   !in / !out           hide rows in any / in no playlist
    //   !in:name / !out:name hide rows in / not in playlist "name" (partial name)
    //   !seen / !unseen      show only watched / unwatched

    // Quoted substrings (optionally with -) are one token; the rest splits on whitespace.
    function tokenizeRaw(raw) {
        // A quote only closes at a token end, so the apostrophes in '80s or 90's stay inside their word.
        const re = /-?=?"[^"]*"(?=\s|$)|-?=?'[^']*'(?=\s|$)|\S+/g;
        return PMVX.plainQuotes(raw).trim().match(re) || [];
    }
    // Quoted (smart quotes too) and =term match only whole words (PMVX.termMatch); stored as "=term".
    function stripTerm(term) {
        if (term[0] === '=') return '=' + stripQuotes(term.slice(1));
        const inner = stripQuotes(term);
        return inner !== term ? '=' + inner : term;
    }

    function stripQuotes(term) {
        if (term.length >= 2) {
            if (term.startsWith('"') && term.endsWith('"')) return term.slice(1, -1);
            if (term.startsWith("'") && term.endsWith("'")) return term.slice(1, -1);
        }
        return term;
    }

    function parseTokens(raw) {
        const tokens = tokenizeRaw(raw);
        const result = {
            textExclude: [],
            textInclude: [],
            playlistFilters: [], // { mode: 'in'|'out', name: string|null }
            seenFilter: null, // 'seen' | 'unseen' | null
        };

        tokens.forEach(tok => {
            if (tok.startsWith('!in')) {
                const name = tok.slice(3).replace(/^:/, '').toLowerCase().trim() || null;
                result.playlistFilters.push({ mode: 'in', name });
            } else if (tok.startsWith('!out')) {
                const name = tok.slice(4).replace(/^:/, '').toLowerCase().trim() || null;
                result.playlistFilters.push({ mode: 'out', name });
            } else if (tok === '!seen') {
                result.seenFilter = 'seen';
            } else if (tok === '!unseen') {
                result.seenFilter = 'unseen';
            } else if (tok.startsWith('-')) {
                const t = stripTerm(tok.slice(1)).toLowerCase();
                if (t && t !== '=') result.textExclude.push(t);
            } else {
                const t = stripTerm(tok).toLowerCase();
                if (t && t !== '=') result.textInclude.push(t);
            }
        });

        return result;
    }

    // Typed chip text -> stored term: "a b" becomes =a b, a stray " (unclosed, or 12" vinyl) is dropped.
    function chipTerm(raw) {
        return stripTerm(PMVX.plainQuotes(raw).trim().replace(/^#/, '').toLowerCase()).replace(/"/g, '').trim();
    }

    // Normalizes meta.duration to seconds (number or "H:MM:SS" / "M:SS" string).
    function toDurationSeconds(raw) {
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string' && raw.includes(':')) {
            const parts = raw.split(':').map(n => parseInt(n, 10));
            if (parts.some(Number.isNaN)) return 0;
            return parts.reduce((acc, n) => acc * 60 + n, 0);
        }
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : 0;
    }

    // vid/descOn come from applyFilter() to save DOM and localStorage lookups.
    function rowPassesFilter(row, tokens, vid = undefined, descOn = undefined) {
        const { textExclude, textInclude, playlistFilters, seenFilter } = tokens;
        const videoId = vid === undefined ? getRowVideoId(row) : vid;
        const matchDesc = descOn === undefined ? matchDescEnabled() : descOn;

        // Title always; tags and performers when known via videoMeta.
        const meta = videoId ? PMVX.state?.videoMeta?.get(videoId) : null;
        const text = (row.querySelector('h4')?.textContent || row.textContent || '').toLowerCase();
        const haystacks = [text, ...(meta?.tags || []), ...(meta?.starsTags || [])];
        if (matchDesc && meta?.description) haystacks.push(meta.description);
        for (const term of textInclude) {
            if (!haystacks.some(h => PMVX.termMatch(h, term))) return false;
        }
        for (const term of textExclude) {
            if (haystacks.some(h => PMVX.termMatch(h, term))) return false;
        }

        if (playlistFilters.length > 0) {
            const { playlists, reverse } = getLivePlaylists();
            const memberOf = videoId ? (reverse.get(videoId) || new Set()) : new Set();

            for (const pf of playlistFilters) {
                if (pf.name) {
                    let matchedId = null;
                    playlists.forEach((p, id) => {
                        if (p.name.toLowerCase().includes(pf.name)) matchedId = id;
                    });

                    const inThat = matchedId ? memberOf.has(matchedId) : false;
                    if (pf.mode === 'in'  &&  inThat) return false;
                    if (pf.mode === 'out' && !inThat) return false;
                } else {
                    const inAny = memberOf.size > 0;
                    if (pf.mode === 'in'  &&  inAny) return false;
                    if (pf.mode === 'out' && !inAny) return false;
                }
            }
        }

        // Local playback history; an unknown ID is never filtered out.
        if (seenFilter && videoId && typeof PMVX.isWatched === 'function') {
            const isWatched = PMVX.isWatched(videoId);
            if (seenFilter === 'seen' && !isWatched) return false;
            if (seenFilter === 'unseen' && isWatched) return false;
        }

        // An unknown rating or duration never filters a row out.
        if ((BTN.ratingMin > 0 || BTN.ratingMax < 100) && meta && meta.bayesianRating > 0) {
            if (meta.bayesianRating < BTN.ratingMin || meta.bayesianRating > BTN.ratingMax) return false;
        }

        if ((BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)) && meta) {
            const dur = toDurationSeconds(meta.duration);
            if (dur > 0 && (dur < BTN.durationMin || dur > BTN.durationMax)) return false;
        }

        if (flagsReject(videoId)) return false;

        if (BTN.savedSearch) {
            const ss = BTN.savedSearch;
            // excludeTags/gay/trans also work from text; rating and aspect need meta.
            if (meta) {
                if (ss.excludeTags?.length) {
                    for (const t of ss.excludeTags) {
                        if (meta.tags.includes(t)) return false;
                    }
                }
                if (ss.minRating && meta.bayesianRating > 0 && meta.bayesianRating < ss.minRating) return false;
                if (ss.aspectFilter && meta.width && meta.height) {
                    const ratio = meta.width / meta.height;
                    const allowedAspects = BTN.savedSearch._rawAspect || [];
                    const aspectOk = allowedAspects.length === 0 || allowedAspects.some(a => {
                        if (a === '16:9') return ratio >= 1.7  && ratio <= 1.8;
                        if (a === '21:9') return ratio >= 2.3  && ratio <= 2.45;
                        if (a === '4:3')  return ratio >= 1.3  && ratio <= 1.35;
                        return false;
                    });
                    if (!aspectOk) return false;
                }
            }
        }

        if (BTN.playlistMode !== 'all') {
            const { reverse } = getLivePlaylists();
            const memberOf = videoId ? (reverse.get(videoId) || new Set()) : new Set();
            const inSelected = inSelectedPlaylists(memberOf);
            if (inSelected !== null && BTN.playlistMode === 'in'  && !inSelected) return false;
            if (inSelected !== null && BTN.playlistMode === 'out' &&  inSelected) return false;
        }

        return true;
    }


    // --- Up next preview helpers ---
    // The preview is a <button> after the "Up Next" label <p>, not a [role="button"] div.

    function findUpNextButton() {
        const labels = document.querySelectorAll('p');
        for (const p of labels) {
            const txt = (p.textContent || '').trim();
            if (/^up\s*next$/i.test(txt)) {
                const btn = p.nextElementSibling;
                if (btn?.tagName === 'BUTTON') return btn;
                const wrap = p.parentElement;
                const wrapBtn = wrap?.querySelector('button');
                if (wrapBtn) return wrapBtn;
            }
        }
        return null;
    }

    function upNextWrapper(btn) {
        return btn?.closest('div.mt-3, div[class*="bg-[#181818]"]') || btn?.parentElement;
    }

    function getUpNextTitle(btn) {
        return btn?.querySelector('p.line-clamp-2, p.font-medium')?.textContent ||
               btn?.querySelector('p')?.textContent || '';
    }

    function getUpNextVideoId(btn) {
        if (!btn) return null;
        const huds = PMVX.state;
        const img  = btn.querySelector('img[src]');

        // 1. titleIndex via alt.
        const alt = img?.alt?.trim().toLowerCase();
        if (alt && huds?.titleIndex?.has(alt)) return huds.titleIndex.get(alt);

        // 2. thumbnailIndex (exact URL).
        if (img?.src && huds?.thumbnailIndex) {
            const clean = img.src.split('?')[0];
            if (huds.thumbnailIndex.has(clean)) return huds.thumbnailIndex.get(clean);
        }

        // 3. URL hex (maybe an asset id: nothing better is known for the preview).
        return img?.src ? thumbHex(img.src) : null;
    }

    function upNextPassesFilter(btn, tokens) {
        if (!btn) return true;
        // Same rules as the rows; the preview has no <h4>, so its title stands in for the row text.
        return rowPassesFilter({ querySelector: () => null, textContent: getUpNextTitle(btn) }, tokens, getUpNextVideoId(btn));
    }

    // --- Applying the filter ---

    let lastAppliedValue = null;
    let lastAppliedDataVersion = -1;


    // One function, not a new arrow per run: the fetch queue keeps callbacks in a Set until it is done.
    function reapplyFilter() { applyFilter(NF.lastOwnValue, true); }

    function applyFilter(ownValue, force = false) {
        const currentDataVersion = PMVX.state?.cacheVersion ?? 0;
        if (!force
            && ownValue === lastAppliedValue
            && currentDataVersion === lastAppliedDataVersion) return;
        lastAppliedValue = ownValue;
        lastAppliedDataVersion = currentDataVersion;

        const effectiveValue = getEffectiveFilterValue(ownValue);
        const tokens = parseTokens(effectiveValue);
        // Nothing is filtered until the filter is armed in this session (see sessionFilterArmed).
        const hasOwnFilter = filterLive() && (
            effectiveValue.length > 0
            || BTN.playlistMode !== 'all'
            || BTN.savedSearch !== null
            || BTN.ratingMin > 0 || BTN.ratingMax < 100
            || BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)
            || flagKeysActive().length > 0
        );

        // Filter needs incomplete videoMeta: Fetch all runs in the background and re-applies.
        const needsMeta = hasOwnFilter && (
            !!(BTN.savedSearch && (BTN.savedSearch.minRating || BTN.savedSearch.aspectFilter))
            || BTN.ratingMin > 0 || BTN.ratingMax < 100
            || BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)
            || tokens.textInclude.length > 0
            || tokens.textExclude.length > 0
            || flagKeysActive().length > 0
        );
        autoFetchAllIfNeeded(effectiveValue, hasOwnFilter, needsMeta);

        // Flags and full meta (playlist data has only 5 tags, no models) are fetched in bulk, then rows re-judged.
        const wantFlags = hasOwnFilter && flagKeysActive().length && typeof PMVX.fetchFlags === 'function';
        const wantMeta = hasOwnFilter && (tokens.textInclude.length || tokens.textExclude.length) && typeof PMVX.fetchFullMeta === 'function';
        if (wantFlags || wantMeta) {
            const ids = queueRows().map(r => getRowVideoId(r)).filter(Boolean);
            if (wantFlags) PMVX.fetchFlags(ids, flagKeysActive(), reapplyFilter);
            if (wantMeta) PMVX.fetchFullMeta(ids, reapplyFilter);
        }

        const rows = queueRows();
        let shown = 0, hidden = 0;
        let activeHidden = false;

        // Dedup: the page=1 limit bump makes Vue's pagination repeat first-page videos.
        // Only the first row per video ID shows (the playing row always).
        const seenVideoIds = new Set();
        const descOn = matchDescEnabled();

        rows.forEach(row => {
            const isActive = row.classList.contains('border-orange-500');

            // Rows hidden by the deeplink catch-up stay hidden regardless of the filter.
            if (row.dataset.pmvCatchupHidden === '1') {
                row.style.display = 'none';
                hidden++;
                return;
            }

            const rowVid = getRowVideoId(row);
            if (rowVid) {
                if (seenVideoIds.has(rowVid) && !isActive) {
                    row.style.display = 'none';
                    hidden++;
                    return;
                }
                seenVideoIds.add(rowVid);
            }

            if (!hasOwnFilter) {
                row.style.removeProperty('display');
                return;
            }

            const visible = rowPassesFilter(row, tokens, rowVid, descOn);

            if (!visible && PMVX.isActed(rowVid)) {
                // Just saved/removed/rejected: stays until the next apply.
                row.style.display = '';
                shown++;
                return;
            }

            row.style.display = visible ? '' : 'none';
            visible ? shown++ : hidden++;

            if (isActive && !visible) activeHidden = true;
        });

        updateCounter(hasOwnFilter ? `${shown}/${shown + hidden}` : '');

        // Playing video hidden: press N, but only if a visible row follows;
        // else each skip lands on a filtered video (chains up to SKIP_CHAIN_MAX).
        if (activeHidden) {
            if (shown === 0) {
                updateCounter("No videos match the filter — auto-skip stopped");
                return;
            }
            if (!findNextVisibleRow()) {
                return;
            }
            triggerNextKey();
            return;
        }

        // Up next box: display-only override with the first visible row after the active one; Vue's pointer is untouched.
        overrideUpNext(tokens);
    }

    // --- Up next override ---
    // Up next box shows the first visible row after the active one; Vue's playback pointer is untouched.

    function overrideUpNext(tokens) {
        const upBtn = findUpNextButton();
        const upWrap = upNextWrapper(upBtn);
        if (!upBtn || !upWrap) return;

        const hasFilter = hasAnyActiveFilter();

        // Override also for a sort alone: Vue's up next follows its own unsorted order.
        if (!hasFilter && !sortedRowIds) {
            upWrap.style.removeProperty('display');
            const overlay = upWrap.querySelector('#pmvnf-upnext-overlay');
            if (overlay) overlay.remove();
            return;
        }

        // With a sort, Vue's up next is always wrong.
        if (!sortedRowIds) {
            const upNextPasses = upNextPassesFilter(upBtn, tokens);
            if (upNextPasses) {
                const overlay = upWrap.querySelector('#pmvnf-upnext-overlay');
                if (overlay) overlay.remove();
                upWrap.style.removeProperty('display');
                return;
            }
        }

        let nextVisible;
        if (sortedRowIds) {
            nextVisible = getSortAwareNextRow();
        } else {
            const rows = queueRows();
            const activeIdx = rows.findIndex(r => r.classList.contains('border-orange-500'));
            nextVisible = null;
            for (let i = activeIdx + 1; i < rows.length; i++) {
                if (rows[i].style.display !== 'none') { nextVisible = rows[i]; break; }
            }
        }

        if (!nextVisible) {
            upWrap.style.display = 'none';
            return;
        }

        const nextTitle = nextVisible.querySelector('h4, p')?.textContent?.trim() || '';
        const nextImg   = nextVisible.querySelector('img[src]');

        let overlay = upWrap.querySelector('#pmvnf-upnext-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'pmvnf-upnext-overlay';
            overlay.style.cssText = `
                position:absolute; inset:0; z-index:10;
                background: inherit;
                display:flex; align-items:center; gap:8px;
                padding: inherit;
                pointer-events:none;
            `;
            upWrap.style.position = 'relative';
            upWrap.appendChild(overlay);
        }

        overlay.innerHTML = '';
        if (nextImg) {
            const img = document.createElement('img');
            img.src = nextImg.src;
            img.style.cssText = 'width:80px;height:45px;object-fit:cover;border-radius:4px;flex-shrink:0;';
            overlay.appendChild(img);
        }
        const titleEl = document.createElement('span');
        titleEl.textContent = nextTitle;
        titleEl.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.85);line-clamp:2;overflow:hidden;';
        overlay.appendChild(titleEl);
    }

    // --- Vue input patch ---
    // Vue's v-model only reacts to InputEvents, so the value is set via a dispatched event.
    // Never pass text tokens: Vue matches titles only and would drop tag/performer matches.

    function syncToVue(ownValue) {
        if (!NF.input) return;

        const vueValue = '';

        if (NF.input.value === vueValue) return;

        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        )?.set;

        if (nativeInputValueSetter) {
            nativeInputValueSetter.call(NF.input, vueValue);
        } else {
            NF.input.value = vueValue;
        }

        NF.input.dispatchEvent(new Event('input', { bubbles: true }));
        NF.input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const DURATION_SLIDER_MAX_MIN = 60; // minutes; top end = no limit


    // --- Fetch all ---
    // Loads the whole playlist (PMVX.forceFetchAllNext -> fetchAll=true in the core's interceptor);
    // tag/performer filtering needs videoMeta for every row.
    let manualFetchAllRunning = false;

    async function runManualFetchAll(statusEl, btnEl) {
        if (manualFetchAllRunning) return;
        manualFetchAllRunning = true;
        btnEl.disabled = true;
        statusEl.textContent = 'loading…';
        statusEl.style.color = 'rgba(255,255,255,0.4)';

        const { ok, waitedMs } = await runFetchAllCycle({ maxWaitMs: 20000 });
        if (!ok) {
            statusEl.textContent = 'no queue found';
            statusEl.style.color = 'rgb(252,165,165)';
            btnEl.disabled = false;
            manualFetchAllRunning = false;
            return;
        }

        const { total, withMeta, unknownId } = getMetaCoverage();

        if (total > 0 && withMeta === total) {
            statusEl.textContent = `${withMeta}/${total} metadata complete`;
            statusEl.style.color = 'rgb(134,239,172)';
        } else {
            statusEl.textContent = `${withMeta}/${total} metadata${unknownId ? ` (${unknownId} unknown)` : ''}`;
            statusEl.style.color = 'rgb(253,186,116)';
        }

        applyFilter(NF.lastOwnValue, true);

        btnEl.disabled = false;
        manualFetchAllRunning = false;
    }

    // --- Sorting ---
    // CSS order from cached metadata, loaded rows only; DOM order and Vue's index stay intact
    // (the deeplink catch-up and Up next assume DOM order == playlist order).

    let sortedRowIds = null; // video IDs in sort order
    let currentSortMode = null;
    let ratingSortAscending = false; // mode 'rating' only

    // Next visible row by the active sort; for triggerNextKey()/attachNIntercept().
    function getSortAwareNextRow() {
        if (!sortedRowIds) return null;
        const rows = queueRows();
        const byId = new Map(rows.map(r => [getRowVideoId(r), r]));
        const activeRow = rows.find(r => r.classList.contains('border-orange-500'));
        const activeId = activeRow ? getRowVideoId(activeRow) : null;
        const startPos = activeId ? sortedRowIds.indexOf(activeId) : -1;
        for (let i = startPos + 1; i < sortedRowIds.length; i++) {
            const r = byId.get(sortedRowIds[i]);
            if (!r) continue; // not in the DOM (yet)
            if (rowShouldBeHidden(r)) continue;
            return r;
        }
        return null;
    }

    function getSortValue(meta, mode) {
        if (!meta) return null;
        switch (mode) {
            case 'rating': return meta.bayesianRating || 0;
            case 'date_desc':
            case 'date_asc': return meta.uploadDate ? Date.parse(meta.uploadDate) || 0 : 0;
            default: return null;
        }
    }

    function applySort(mode) {
        const list = queueRows()[0]?.parentElement;
        if (!list) return;
        const rows = Array.from(list.querySelectorAll(':scope > [role="button"]'));
        if (!rows.length) return;

        // Only CSS order, never DOM order: moving nodes would re-trigger the childList observer
        // (re-filtering), and Vue re-renders would undo it.
        list.style.display = 'flex';
        list.style.flexDirection = 'column';

        const videoMeta = PMVX.state?.videoMeta;
        const withMeta = [];
        const withoutMeta = [];
        rows.forEach(r => {
            const vid = getRowVideoId(r);
            const meta = vid ? videoMeta?.get(vid) : null;
            const val = getSortValue(meta, mode);
            if (val === null) withoutMeta.push(r);
            else withMeta.push({ row: r, val });
        });

        const asc = mode === 'date_asc' || (mode === 'rating' && ratingSortAscending);
        withMeta.sort((a, b) => asc ? a.val - b.val : b.val - a.val);
        currentSortMode = mode;
        saveSortSettings();

        // No metadata: bottom. Rows added later stay at order:0 until re-sorted.
        [...withMeta.map(x => x.row), ...withoutMeta].forEach((r, i) => {
            r.style.order = String(i + 1);
        });
        sortedRowIds = [...withMeta.map(x => x.row), ...withoutMeta].map(r => getRowVideoId(r));

        if (withoutMeta.length) {
            updateCounter(`sorted (${withoutMeta.length} rows without metadata at the bottom)`);
        }
    }

    function resetSort() {
        const list = queueRows()[0]?.parentElement;
        if (list) {
            Array.from(list.querySelectorAll(':scope > [role="button"]'))
                .forEach(r => r.style.removeProperty('order'));
        }
        sortedRowIds = null;
        currentSortMode = null;
        saveSortSettings();
    }

    // Merged into the SETTINGS_KEY blob; restoreSortSettings() reads it after loadSettings().
    function saveSortSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const s = raw ? JSON.parse(raw) : {};
            s.sortMode = currentSortMode;
            s.sortAscending = ratingSortAscending;
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        } catch {}
    }

    // --- Playlist-page filter panel ---
    // The native input stays hidden in the DOM (syncToVue() writes to it); own search field + Filters replace it.
    // The panel is a drawer over the queue (absolute in the sidebar card, own scroll): it never pushes it.
    // Chips are composed back into the token string for parseTokens().
    const UI = { pos: [], neg: [], raw: [], seen: null, dpos: [], dneg: [], draw: [], open: false };
    const UI_OPEN_KEY = 'pmvnf_panel_open_v1';
    try { UI.open = localStorage.getItem(UI_OPEN_KEY) === '1'; } catch {}

    function splitText(text) {
        const t = parseTokens(text || '');
        return { pos: t.textInclude.slice(), neg: t.textExclude.slice(), seen: t.seenFilter,
                 raw: tokenizeRaw(text || '').filter(tok => /^!(in|out)/.test(tok)) };
    }
    function textToUi(text) {
        const p = splitText(text);
        UI.pos.splice(0, UI.pos.length, ...p.pos);
        UI.neg.splice(0, UI.neg.length, ...p.neg);
        UI.raw.splice(0, UI.raw.length, ...p.raw);
        UI.seen = p.seen;
        NF.renderOwnChips?.();
    }
    function defaultsToUi(text) {
        const p = splitText(text);
        UI.dpos.splice(0, UI.dpos.length, ...p.pos);
        UI.dneg.splice(0, UI.dneg.length, ...p.neg);
        UI.draw.splice(0, UI.draw.length, ...p.raw, ...(p.seen ? ['!' + p.seen] : []));
    }
    function quoteTerm(term) {
        return PMVX.isWordTerm(term) || /\s/.test(term) ? `"${PMVX.termLabel(term)}"` : term;
    }
    function compose(pos, neg, seen, raw) {
        const parts = [];
        pos.forEach(t => parts.push(quoteTerm(t)));
        neg.forEach(t => parts.push('-' + quoteTerm(t)));
        if (seen === 'seen') parts.push('!seen');
        if (seen === 'unseen') parts.push('!unseen');
        raw.forEach(t => parts.push(t));
        return parts.join(' ');
    }
    const uiToText = () => compose(UI.pos, UI.neg, UI.seen, UI.raw);
    const uiToDefaults = () => compose(UI.dpos, UI.dneg, null, UI.draw);
    function anyPending() {
        return uiToText() !== (NF.lastOwnValue || '')
            || pendingPlaylistMode !== BTN.playlistMode
            || !isSetEqual(pendingSelectedPlaylistIds, BTN.selectedPlaylistIds)
            || pendingSavedSearchName !== BTN.savedSearchName
            || pendingRatingMin !== BTN.ratingMin || pendingRatingMax !== BTN.ratingMax
            || pendingDurationMin !== BTN.durationMin || pendingDurationMax !== BTN.durationMax
            || !sameFlags(pendingFlags, BTN.flags)
            || pendingDefaultTerms !== NF.defaultTerms;
    }

    function injectOwnPanelStyle() {
        if (document.getElementById('pmvnf-panel-style')) return;
        const css = `
[data-pmvnf-native-hidden="1"]{display:none !important;}
[data-pmvnf-card="1"]{position:relative !important;}
#pmvnf-wrap{margin-top:12px;display:flex;flex-direction:column;gap:6px;font-family:inherit;}
#pmvnf-wrap *,#pmvnf-panel *,.pmvnf-dd *{box-sizing:border-box;}
.pmvnf-top{display:flex;gap:6px;align-items:stretch;}
.pmvnf-power{position:relative;flex-shrink:0;align-self:center;width:32px;height:18px;padding:0;border:none;border-radius:9999px;cursor:pointer;background:#3A3A3A;transition:background .15s;}
.pmvnf-power:hover{background:#454545;}
.pmvnf-power[aria-checked="true"]{background:rgb(249,115,22);}
.pmvnf-power[aria-checked="true"]:hover{background:rgb(234,88,12);}
.pmvnf-power .knob{position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .15s;pointer-events:none;}
.pmvnf-power[aria-checked="true"] .knob{transform:translateX(14px);}
#pmvnf-wrap[data-off="1"] .pmvnf-chips{opacity:.4;}
.pmvnf-search{flex:1;min-width:0;position:relative;display:flex;align-items:center;}
.pmvnf-search svg{position:absolute;left:8px;width:14px;height:14px;color:rgb(107,114,128);pointer-events:none;}
.pmvnf-search input{width:100%;padding:6px 10px 6px 28px;border-radius:4px;border:none;outline:none;background:#272727;color:rgb(229,231,235);font-size:12px;font-family:inherit;transition:background .15s;}
.pmvnf-search input:focus{background:#323232;outline:none !important;box-shadow:none !important;}
.pmvnf-search input::placeholder{color:rgb(107,114,128);}
.pmvnf-toggle{display:inline-flex;align-items:center;gap:5px;padding:0 10px;border-radius:4px;border:none;cursor:pointer;flex-shrink:0;
  background:#272727;color:rgb(209,213,219);font-size:11px;font-weight:500;font-family:inherit;white-space:nowrap;}
.pmvnf-toggle:hover{background:#323232;}
.pmvnf-toggle[data-open="1"],.pmvnf-toggle[data-active="1"]{background:rgb(249,115,22);color:#fff;}
.pmvnf-toggle svg{width:12px;height:12px;}
.pmvnf-chev{padding:0 6px;} .pmvnf-chev svg{transition:transform .15s;} .pmvnf-chev[data-open="1"] svg{transform:rotate(180deg);}
.pmvnf-toggle.pending{box-shadow:0 0 0 2px rgba(249,115,22,0.45);}
.pmvnf-toggle .badge{min-width:16px;height:16px;padding:0 4px;border-radius:9999px;background:rgba(0,0,0,0.3);font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;font-variant-numeric:tabular-nums;}
.pmvnf-toggle .badge:empty{display:none;}
.pmvnf-chips{display:flex;flex-wrap:wrap;gap:4px;}
.pmvnf-chips:empty{display:none;}
.pmvnf-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:4px;border:none;cursor:default;font-size:11px;line-height:16px;font-family:inherit;}
.pmvnf-tag svg{width:10px;height:10px;}
.pmvnf-tag .w{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:0 4px;border-radius:3px;background:rgba(0,0,0,0.3);}
.pmvnf-tag .x{display:inline-flex;opacity:.6;padding:2px;border-radius:3px;cursor:pointer;margin-left:1px;}
.pmvnf-tag .x:hover{opacity:1;background:rgba(255,255,255,0.12);}
.pmvnf-tag.pos{background:rgba(249,115,22,0.2);color:rgb(253,186,116);}
.pmvnf-tag.neg{background:rgba(239,68,68,0.2);color:rgb(252,165,165);} .pmvnf-tag.neg .txt{text-decoration:line-through;}
.pmvnf-tag.raw{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.6);font-family:inherit;font-variant-numeric:tabular-nums;}
.pmvnf-tag.def{opacity:.75;outline:1px dashed rgba(255,255,255,0.15);outline-offset:-1px;}
#pmvnf-panel{position:absolute;left:0;right:0;bottom:0;z-index:30;display:none;flex-direction:column;background:#1A1A1A;}
#pmvnf-panel[data-open="1"]{display:flex;}
.pmvnf-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px 8px;display:flex;flex-direction:column;gap:12px;}
.pmvnf-sec{display:flex;flex-direction:column;gap:5px;}
.pmvnf-lab{font-size:10px;font-weight:600;color:rgb(156,163,175);text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:6px;}
.pmvnf-lab .r{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400;color:rgba(255,255,255,0.35);font-family:inherit;font-variant-numeric:tabular-nums;}
#pmvnf-panel input[type=text]{width:100%;padding:6px 10px;border-radius:4px;border:none;outline:none;background:#272727;color:rgb(229,231,235);font-size:12px;font-family:inherit;transition:background .15s;}
#pmvnf-panel input[type=text]:focus{background:#323232;outline:none !important;box-shadow:none !important;}
#pmvnf-panel input::placeholder{color:rgb(107,114,128);}
.pmvnf-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:4px;border:none;cursor:pointer;
  background:#272727;color:rgb(209,213,219);font-size:11px;font-weight:500;line-height:1.2;font-family:inherit;white-space:nowrap;transition:background .15s,color .15s;}
.pmvnf-chip:hover{background:#323232;}
.pmvnf-chip.active{background:rgb(249,115,22);color:#fff;}
.pmvnf-chip.pending{outline:1px dashed rgba(249,115,22,0.8);outline-offset:-1px;}
.pmvnf-chip.active.in{background:rgb(34,197,94);} .pmvnf-chip.active.out{background:rgb(239,68,68);}
.pmvnf-sortseg{display:inline-flex;align-items:stretch;border-radius:4px;background:#272727;color:rgb(209,213,219);overflow:hidden;}
.pmvnf-sortseg[data-active="1"]{background:rgb(249,115,22);color:#fff;}
.pmvnf-sortseg[data-active="1"] .pmvnf-sel.native,.pmvnf-sortseg[data-active="1"] .pmvnf-sel.native svg{color:#fff;}
#pmvnf-sortdir{border:none;background:transparent;color:inherit;cursor:pointer;padding:0 6px 0 8px;font-size:12px;line-height:1;font-family:inherit;border-right:1px solid rgba(255,255,255,0.12);}
#pmvnf-sortdir:hover{background:rgba(255,255,255,0.08);}
.pmvnf-sortseg .pmvnf-sel.native{background:transparent;border-radius:0;padding:6px 6px 6px 7px;gap:4px;}
.pmvnf-sortseg .pmvnf-sel.native[data-active="1"]{background:transparent;}
.pmvnf-sortseg .pmvnf-sel.native svg{width:12px;height:12px;}
.pmvnf-hint{font-size:10px;color:rgba(255,255,255,0.35);line-height:1.4;}
.pmvnf-pillrow{display:flex;justify-content:center;}
.pmvnf-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:9999px;background:rgba(249,115,22,0.12);color:rgb(249,115,22);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;}
.pmvnf-pill .sep{color:rgba(249,115,22,0.5);}
.pmvnf-slider{position:relative;height:26px;}
.pmvnf-slider .track{position:absolute;top:11px;left:0;right:0;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);}
.pmvnf-slider .fill{position:absolute;top:11px;height:4px;border-radius:2px;background:linear-gradient(90deg,rgb(249,115,22),rgb(251,146,60));}
.pmvnf-slider input[type=range]{position:absolute;top:11px;left:0;width:100%;height:4px;margin:0;padding:0;-webkit-appearance:none;appearance:none;background:transparent;pointer-events:none;outline:none;}
.pmvnf-slider input[type=range]::-webkit-slider-runnable-track{background:transparent;height:4px;}
.pmvnf-slider input[type=range]::-moz-range-track{background:transparent;height:4px;border:none;}
.pmvnf-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;border:3px solid rgb(249,115,22);box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;}
.pmvnf-slider input[type=range]::-moz-range-thumb{pointer-events:auto;width:8px;height:8px;border-radius:50%;background:#fff;border:3px solid rgb(249,115,22);box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;}
.pmvnf-sliderlabels{display:flex;justify-content:space-between;color:rgba(255,255,255,0.35);font-size:10px;margin-top:-4px;}
.pmvnf-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 16px;border-top:1px solid #2A2A2A;background:#1A1A1A;flex-shrink:0;}
.pmvnf-apply{padding:6px 12px;border-radius:4px;border:none;cursor:pointer;background:rgb(249,115,22);color:#fff;font-size:11px;font-weight:600;font-family:inherit;}
.pmvnf-apply:hover{background:rgb(234,88,12);}
.pmvnf-apply.pending{box-shadow:0 0 0 2px rgba(249,115,22,0.35);}
.pmvnf-close{margin-left:auto;background:transparent;border:none;color:rgb(156,163,175);cursor:pointer;font-size:11px;font-family:inherit;padding:4px 6px;border-radius:4px;}
.pmvnf-close:hover{background:#272727;color:#fff;}
#pmvnf-counter{font-size:10px;color:rgba(255,255,255,0.4);font-family:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;}
#pmvnf-fetchall-status{font-size:10px;color:rgba(255,255,255,0.3);white-space:nowrap;font-family:inherit;font-variant-numeric:tabular-nums;}
#pmvnf-qfoot{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid #2A2A2A;background:#1A1A1A;flex-shrink:0;}
/* native custom-select look (scaled to the sidebar) */
.pmvnf-sel{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border-radius:6px;cursor:pointer;text-align:left;
  background:#0F0F0F;border:1px solid #2A2A2A;color:#fff;font-size:12px;font-family:inherit;transition:border-color .15s;}
.pmvnf-sel:hover{border-color:#3A3A3A;}
.pmvnf-sel[data-open="1"]{border-color:rgb(249,115,22);}
.pmvnf-sel .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmvnf-sel .t.ph{color:rgb(107,114,128);}
.pmvnf-sel .n{color:rgba(255,255,255,0.4);font-size:10px;font-family:inherit;font-variant-numeric:tabular-nums;}
.pmvnf-sel svg{width:14px;height:14px;color:rgb(156,163,175);flex-shrink:0;transition:transform .15s;}
.pmvnf-sel[data-open="1"] svg{transform:rotate(180deg);}
.pmvnf-sel.native{width:auto;padding:6px 8px;border-radius:4px;background:#272727;border:none;color:rgb(209,213,219);font-size:11px;font-weight:500;}
.pmvnf-sel.native[data-active="1"]{background:rgb(249,115,22);color:#fff;} .pmvnf-sel.native[data-active="1"] svg{color:#fff;}
.pmvnf-dd{position:fixed;z-index:999999;min-width:200px;max-height:min(60vh,420px);overflow-y:auto;border-radius:10px;
  background:#141414;border:1px solid rgba(249,115,22,0.45);box-shadow:0 12px 32px rgba(0,0,0,0.6);font-family:inherit;}
.pmvnf-dd .row{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;border-bottom:1px solid #1F1F1F;}
.pmvnf-dd .row:last-child{border-bottom:none;}
.pmvnf-dd .row:hover{background:rgba(255,255,255,0.04);}
.pmvnf-dd .row[data-sel="1"]{background:rgba(249,115,22,0.12);}
.pmvnf-dd .row .tt{flex:1;min-width:0;}
.pmvnf-dd .row .ti{display:block;color:#fff;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmvnf-dd .row .su{display:block;color:rgb(156,163,175);font-size:10px;margin-top:1px;}
.pmvnf-dd .row .ck{width:14px;height:14px;color:rgb(249,115,22);flex-shrink:0;visibility:hidden;}
.pmvnf-dd .row[data-sel="1"] .ck{visibility:visible;}
.pmvnf-dd .empty{padding:10px 12px;color:rgb(156,163,175);font-size:11px;}
`;
        const st = document.createElement('style');
        st.id = 'pmvnf-panel-style';
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const mkChip = (text, onClick, title) => { const b = mk('button', 'pmvnf-chip', text); b.type = 'button'; if (title) b.title = title; b.onclick = onClick; return b; };
    const SVG_X = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    const SVG_BAN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
    const SVG_FILTER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H3m9 14H3M14 3v4m2 10v4m5-9h-9m9 7h-5m5-14h-7m-6 5v4m0-2H3"/></svg>';
    const SVG_CHEV = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    const SVG_CHECK = '<svg class="ck" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    const SVG_SEARCH = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

    // Site-style custom select; items(): [{value,title,sub}]. position:fixed: the scrolling panel would clip it.
    let openDd = null;
    function closeDd() { if (openDd) { openDd.list.remove(); openDd.btn.dataset.open = '0'; openDd = null; } }
    document.addEventListener('click', e => { if (openDd && !openDd.list.contains(e.target) && !openDd.btn.contains(e.target)) closeDd(); }, true);
    window.addEventListener('resize', closeDd);
    function mkSelect({ items, multi = false, isSelected, onPick, label, placeholder = 'Choose…', native = false, emptyText = 'Nothing available', icon = null }) {
        const btn = mk('button', 'pmvnf-sel' + (native ? ' native' : ''));
        btn.type = 'button';
        if (icon) { const i = mk('span'); i.innerHTML = icon; i.style.display = 'inline-flex'; btn.appendChild(i); }
        const t = mk('span', 't'); const n = mk('span', 'n'); const ch = mk('span'); ch.innerHTML = SVG_CHEV; ch.style.display = 'inline-flex';
        btn.append(t, n, ch);
        const render = () => {
            const list = items();
            const sel = list.filter(i => isSelected(i.value));
            if (!sel.length) { t.textContent = placeholder; t.classList.add('ph'); n.textContent = ''; }
            else { t.classList.remove('ph'); t.textContent = sel.length <= 2 ? sel.map(i => i.title).join(', ') : `${sel.length} selected`; n.textContent = sel.length > 2 ? '' : ''; }
            btn.dataset.active = sel.length && native ? '1' : '0';
            if (label) btn.title = label;
        };
        const open = () => {
            closeDd();
            const list = mk('div', 'pmvnf-dd');
            const its = items();
            if (!its.length) list.appendChild(mk('div', 'empty', emptyText));
            its.forEach(it => {
                const row = mk('div', 'row');
                row.dataset.sel = isSelected(it.value) ? '1' : '0';
                const tt = mk('div', 'tt'); tt.appendChild(mk('span', 'ti', it.title)); if (it.sub) tt.appendChild(mk('span', 'su', it.sub));
                row.appendChild(tt);
                const ck = mk('span'); ck.innerHTML = SVG_CHECK; ck.style.display = 'inline-flex'; row.appendChild(ck.firstChild);
                row.onclick = () => {
                    onPick(it.value);
                    render();
                    if (multi) [...list.querySelectorAll('.row')].forEach((r, i) => r.dataset.sel = isSelected(its[i].value) ? '1' : '0');
                    else closeDd();
                };
                list.appendChild(row);
            });
            document.body.appendChild(list);
            const r = btn.getBoundingClientRect();
            const w = Math.max(r.width, 220);
            list.style.minWidth = w + 'px';
            let left = r.left; if (left + w > innerWidth - 8) left = Math.max(8, innerWidth - 8 - w);
            list.style.left = left + 'px';
            const h = list.getBoundingClientRect().height;
            if (r.bottom + 4 + h > innerHeight - 8 && r.top - 4 - h > 8) list.style.top = (r.top - 4 - h) + 'px';
            else list.style.top = (r.bottom + 4) + 'px';
            btn.dataset.open = '1';
            openDd = { btn, list };
        };
        btn.onclick = (e) => { e.stopPropagation(); if (openDd?.btn === btn) closeDd(); else open(); };
        render();
        return { el: btn, render };
    }

    function mkDualSlider({ min, max, getRange, setRange, fmt, presets }) {
        const sec = mk('div');
        const pillRow = mk('div', 'pmvnf-pillrow');
        const pill = mk('div', 'pmvnf-pill');
        const pA = mk('span'), pB = mk('span');
        pill.append(pA, mk('span', 'sep', '-'), pB); pillRow.appendChild(pill);
        const slider = mk('div', 'pmvnf-slider');
        const fill = mk('div', 'fill');
        const rA = mk('input'); rA.type = 'range'; rA.min = String(min); rA.max = String(max); rA.step = '1';
        const rB = mk('input'); rB.type = 'range'; rB.min = String(min); rB.max = String(max); rB.step = '1';
        slider.append(mk('div', 'track'), fill, rA, rB);
        const labels = mk('div', 'pmvnf-sliderlabels');
        labels.append(mk('span', null, fmt(min, false)), mk('span', null, fmt(max, true)));
        const chips = mk('div', 'pmvnf-chips');
        const presetBtns = presets.map(p => { const c = mkChip(p.label, () => { setRange(p.a, p.b); render(); }, p.title); chips.appendChild(c); return c; });
        const paint = (a, b) => {
            pA.textContent = fmt(a, false); pB.textContent = fmt(b, true);
            fill.style.left = ((a - min) / (max - min) * 100) + '%';
            fill.style.width = (Math.max(0, b - a) / (max - min) * 100) + '%';
        };
        const render = () => {
            const [a, b] = getRange();
            rA.value = String(a); rB.value = String(b);
            paint(a, b);
            presetBtns.forEach((c, i) => c.classList.toggle('active', presets[i].a === a && presets[i].b === b));
            refreshPendingMarks();
        };
        const onInput = (which) => () => {
            let a = parseInt(rA.value, 10), b = parseInt(rB.value, 10);
            if (a > b) { if (which === 'a') { b = a; rB.value = String(b); } else { a = b; rA.value = String(a); } }
            paint(a, b); setRange(a, b);
            presetBtns.forEach((c, i) => c.classList.toggle('active', presets[i].a === a && presets[i].b === b));
            refreshPendingMarks();
        };
        rA.addEventListener('input', onInput('a')); rB.addEventListener('input', onInput('b'));
        sec.append(pillRow, slider, labels, chips);
        return { el: sec, render };
    }

    let refreshPendingMarks = () => {};

    // Replaces the native "Added" sort button, kept hidden: the arrow clicks it for the site's own order.
    // Applies immediately; re-attached from startObserver().
    const SORT_ITEMS = () => [
        { value: 'native', title: 'Added', sub: 'Site order' },
        { value: 'rating', title: 'Rating', sub: 'By rating' },
        { value: 'date', title: 'Upload date', sub: 'By upload date' },
    ];
    let nativeSortAsc = false; // tracks arrow clicks on the site's order
    const sortMode = () => !currentSortMode ? 'native' : currentSortMode === 'rating' ? 'rating' : 'date';
    const sortAsc = () => sortMode() === 'native' ? nativeSortAsc : sortMode() === 'rating' ? ratingSortAscending : currentSortMode === 'date_asc';
    let sortSel = null, sortDirBtn = null;
    function applySortChoice(mode, asc) {
        if (mode === 'native') {
            if (currentSortMode) resetSort();
            if (asc !== nativeSortAsc) { nativeSortAsc = asc; document.querySelector('[data-pmvnf-native-sort="1"]')?.click(); }
        } else if (mode === 'rating') {
            ratingSortAscending = asc; applySort('rating'); saveSortSettings(); applyFilter(NF.lastOwnValue, true);
        } else {
            applySort(asc ? 'date_asc' : 'date_desc'); saveSortSettings(); applyFilter(NF.lastOwnValue, true);
        }
        sortSel?.render(); renderSortDir();
    }
    function renderSortDir() {
        if (!sortDirBtn) return;
        const asc = sortAsc();
        sortDirBtn.innerHTML = asc ? '&#8593;' : '&#8595;';
        sortDirBtn.title = (asc ? 'Low → high / old → new' : 'High → low / new → old') + ' — click to reverse';
        sortDirBtn.dataset.active = currentSortMode ? '1' : '0';
    }
    function injectSortSelect() {
        if (document.getElementById('pmvnf-sort')) return;
        const btns = [...document.querySelectorAll('button')];
        const shuffle = btns.find(b => b.textContent.trim() === 'Shuffle');
        const row = shuffle?.parentElement;
        if (!row) return;
        const added = [...row.querySelectorAll('button')].find(b => !/^(Shuffle|Loop|Auto)$/.test(b.textContent.trim()) && !b.id);
        if (added) { added.setAttribute('data-pmvnf-native-hidden', '1'); added.setAttribute('data-pmvnf-native-sort', '1'); }
        sortSel = mkSelect({
            native: true, label: 'Queue sort order', placeholder: 'Added',
            items: SORT_ITEMS,
            isSelected: v => v === sortMode(),
            onPick: v => applySortChoice(v, v === sortMode() ? sortAsc() : false),
        });
        sortSel.el.id = 'pmvnf-sort';
        const r0 = sortSel.render;
        sortSel.render = () => { r0(); sortSel.el.dataset.active = currentSortMode ? '1' : '0'; };
        // Compact [arrow | Added] segment for the Shuffle/Loop/Auto row.
        const seg = mk('div', 'pmvnf-sortseg'); seg.id = 'pmvnf-sortseg';
        sortDirBtn = mk('button'); sortDirBtn.type = 'button'; sortDirBtn.id = 'pmvnf-sortdir';
        sortDirBtn.onclick = () => applySortChoice(sortMode(), !sortAsc());
        seg.append(sortDirBtn, sortSel.el);
        const r1 = sortSel.render;
        sortSel.render = () => { r1(); seg.dataset.active = currentSortMode ? '1' : '0'; };
        sortSel.render(); renderSortDir();
        if (added) row.insertBefore(seg, added); else row.appendChild(seg);
    }

    // Fetch all footer under the queue list, not in the drawer.
    function injectQueueFooter() {
        if (document.getElementById('pmvnf-qfoot')) return;
        const list = queueRows()[0]?.closest('.overflow-y-auto');
        const card = list?.parentElement;
        if (!list || !card) return;
        const foot = mk('div'); foot.id = 'pmvnf-qfoot';
        const faBtn = mkChip('⟳ Fetch all', () => runManualFetchAll(faStatus, faBtn), 'Load the whole playlist and check that tag and performer metadata is complete');
        const faStatus = mk('span'); faStatus.id = 'pmvnf-fetchall-status';
        foot.append(faBtn, faStatus);
        card.insertBefore(foot, list.nextSibling);
    }

    function buildOwnInput() {
        if (NF.ownInput?.isConnected) return;
        injectOwnPanelStyle();
        document.getElementById('pmvnf-wrap')?.remove();
        document.getElementById('pmvnf-panel')?.remove();
        textToUi(NF.lastOwnValue);
        defaultsToUi(pendingDefaultTerms);

        const nativeWrapper = NF.input.parentElement;         // .mt-3.relative
        const header = nativeWrapper?.parentElement;           // .p-4.border-b (sidebar header)
        const card = header?.parentElement;                    // .bg-[#1A1A1A] sidebar card
        if (nativeWrapper) nativeWrapper.setAttribute('data-pmvnf-native-hidden', '1');
        if (card) card.setAttribute('data-pmvnf-card', '1');

        const wrap = mk('div'); wrap.id = 'pmvnf-wrap';
        const top = mk('div', 'pmvnf-top');
        const search = mk('div', 'pmvnf-search');
        search.innerHTML = SVG_SEARCH;
        const inpPos = mk('input');
        inpPos.type = 'text'; inpPos.spellcheck = false; inpPos.autocomplete = 'off';
        inpPos.placeholder = 'Filter videos… (title, tag, performer — Enter)';
        inpPos.dataset.pmvnfKind = 'pos'; inpPos.dataset.pmvnfApply = '1';
        inpPos.addEventListener('keydown', e => e.stopPropagation(), true);
        search.appendChild(inpPos);
        NF.ownInput = inpPos;
        // Filters applies; the chevron toggles the drawer.
        const toggle = mk('button', 'pmvnf-toggle'); toggle.type = 'button'; toggle.id = 'pmvnf-apply';
        toggle.innerHTML = `${SVG_FILTER}<span class="lbl">Filters</span><span class="badge"></span>`;
        const badge = toggle.querySelector('.badge');
        const lbl = toggle.querySelector('.lbl');
        const chev = mk('button', 'pmvnf-toggle pmvnf-chev'); chev.type = 'button';
        chev.innerHTML = SVG_CHEV; chev.title = 'Expand filters';
        top.append(search, toggle, chev);
        const topChips = mk('div', 'pmvnf-chips');
        wrap.append(top, topChips);

        if (header) header.insertBefore(wrap, nativeWrapper.nextSibling); else document.body.prepend(wrap);

        const panel = mk('div'); panel.id = 'pmvnf-panel';
        panel.dataset.open = UI.open ? '1' : '0';
        const body = mk('div', 'pmvnf-body');
        panel.appendChild(body);
        (card || document.body).appendChild(panel);
        // While the drawer is open the card keeps a minimum height (header + drawer),
        // else a filter leaving few rows would shrink it.
        const placePanel = () => {
            if (!card || !header) return;
            const top = Math.max(0, Math.round(header.getBoundingClientRect().bottom - card.getBoundingClientRect().top));
            panel.style.top = top + 'px';
            const foot = document.getElementById('pmvnf-qfoot');
            const footH = foot ? Math.round(foot.getBoundingClientRect().height) : 0;
            panel.style.bottom = footH + 'px';
            const want = UI.open ? (top + Math.round(Math.min(520, window.innerHeight * 0.7)) + footH) + 'px' : '';
            if (card.style.minHeight !== want) card.style.minHeight = want;
        };
        placePanel();
        // A rebuild (Vue replaced the input) drops the previous panel's observer and listener.
        NF.panelCleanup?.();
        const onReady = () => { try { updatePlBtn(); } catch {} };
        let ro = null;
        try { ro = new ResizeObserver(placePanel); ro.observe(header); ro.observe(card); } catch {}
        NF.panelCleanup = () => { ro?.disconnect(); window.removeEventListener('pmv:cache-ready', onReady); };
        const setOpen = (v) => {
            UI.open = v;
            panel.dataset.open = v ? '1' : '0';
            chev.dataset.open = v ? '1' : '0';
            chev.title = v ? 'Collapse filters' : 'Expand filters';
            try { localStorage.setItem(UI_OPEN_KEY, v ? '1' : '0'); } catch {}
            placePanel();
            if (v) loadSavedSearchList();
            else closeDd();
        };
        // Filters is also the switch: active with nothing staged → off (settings kept); else apply.
        toggle.onclick = () => {
            if (!anyPending() && toggle.dataset.active === '1') { setFilterEnabled(false); return; }
            applyAll();
        };
        chev.onclick = () => setOpen(!UI.open);

        const drawChips = (host, kind, list, extraCls = '') => {
            host.textContent = '';
            list.forEach((term, i) => {
                const c = mk('span', `pmvnf-tag ${kind.replace('d', '')} ${extraCls}`.trim());
                if (kind.endsWith('neg')) { const ic = mk('span'); ic.innerHTML = SVG_BAN; ic.style.display = 'inline-flex'; c.appendChild(ic); }
                const isRaw = kind.endsWith('raw');
                const word = !isRaw && PMVX.isWordTerm(term);
                const txt = mk('span', 'txt', isRaw ? term : '#' + (word ? `"${PMVX.termLabel(term)}"` : term));
                c.appendChild(txt);
                // Click the term: toggle whole-word match.
                if (!isRaw) {
                    txt.style.cursor = 'pointer';
                    txt.title = word ? 'Whole word only — click to match it anywhere in the text' : 'Matches anywhere in the text — click to match it only as a whole word';
                    txt.onclick = () => { list[i] = word ? term.slice(1) : '=' + term; afterChipChange(kind); };
                }
                const x = mk('span', 'x'); x.innerHTML = SVG_X; x.title = 'Remove';
                x.onclick = () => { list.splice(i, 1); afterChipChange(kind); };
                c.appendChild(x);
                host.appendChild(c);
            });
        };
        const renderTagChips = () => {
            topChips.textContent = '';
            // Only the search field's terms here; excluded ones are in the drawer's Exclude section.
            const a = mk('div', 'pmvnf-chips'), c = mk('div', 'pmvnf-chips');
            drawChips(a, 'pos', UI.pos); drawChips(c, 'raw', UI.raw);
            [...a.children, ...c.children].forEach(el => topChips.appendChild(el));
            drawChips(negChips, 'neg', UI.neg);
            drawChips(defChips, 'dpos', UI.dpos, 'def');
            const d2 = mk('div'); drawChips(d2, 'dneg', UI.dneg, 'def'); [...d2.children].forEach(el => defChips.appendChild(el));
            const d3 = mk('div'); drawChips(d3, 'draw', UI.draw, 'def'); [...d3.children].forEach(el => defChips.appendChild(el));
        };
        const afterChipChange = (kind) => {
            if (kind.startsWith('d')) { pendingDefaultTerms = uiToDefaults(); updateDefaultsBtn(); }
            renderTagChips(); refreshPendingMarks();
        };
        NF.renderOwnChips = () => { renderTagChips(); renderSeen(); };
        NF.onOwnKey = (e) => {
            const kind = e.target?.dataset?.pmvnfKind;
            if (!kind) return false;
            const inp = e.target;
            const immediate = inp.dataset.pmvnfApply === '1';
            if (e.key === 'Enter') {
                const term = chipTerm(inp.value);
                if (!term || term === '=') { if (!inp.value.trim()) applyAll(); inp.value = ''; return true; }
                const isDef = kind.startsWith('d');
                const list = UI[kind], other = UI[isDef ? (kind === 'dpos' ? 'dneg' : 'dpos') : (kind === 'pos' ? 'neg' : 'pos')];
                if (!list.includes(term)) list.push(term);
                const j = other.indexOf(term); if (j !== -1) other.splice(j, 1);
                inp.value = '';
                afterChipChange(kind);
                if (immediate) applyAll();
                return true;
            }
            if (e.key === 'Backspace' && !inp.value && UI[kind].length) { UI[kind].pop(); afterChipChange(kind); return true; }
            if (e.key === 'Escape') { inp.value = ''; inp.blur(); if (UI.open && !immediate) setOpen(false); return true; }
            return false;
        };

        const secNeg = mk('div', 'pmvnf-sec');
        secNeg.appendChild(mk('div', 'pmvnf-lab', 'Exclude'));
        const inpNeg = mk('input'); inpNeg.type = 'text'; inpNeg.spellcheck = false; inpNeg.autocomplete = 'off';
        inpNeg.placeholder = 'Hide videos with… (title, tag or performer)'; inpNeg.dataset.pmvnfKind = 'neg';
        inpNeg.addEventListener('keydown', e => e.stopPropagation(), true);
        const negChips = mk('div', 'pmvnf-chips');
        secNeg.append(inpNeg, negChips, mk('div', 'pmvnf-hint', 'Enter adds · Enter in an empty field applies · Backspace in an empty field removes the last one · "quotes" or a click on a term: whole word only'));
        body.appendChild(secNeg);

        const secDef = mk('div', 'pmvnf-sec');
        const labDef = mk('div', 'pmvnf-lab', 'Always');
        const defMark = mk('span', 'r'); labDef.appendChild(defMark);
        secDef.appendChild(labDef);
        const inpDPos = mk('input'); inpDPos.type = 'text'; inpDPos.spellcheck = false; inpDPos.autocomplete = 'off';
        inpDPos.placeholder = 'Always require…'; inpDPos.dataset.pmvnfKind = 'dpos';
        const inpDNeg = mk('input'); inpDNeg.type = 'text'; inpDNeg.spellcheck = false; inpDNeg.autocomplete = 'off';
        inpDNeg.placeholder = 'Always exclude…'; inpDNeg.dataset.pmvnfKind = 'dneg';
        [inpDPos, inpDNeg].forEach(i => i.addEventListener('keydown', e => e.stopPropagation(), true));
        const defChips = mk('div', 'pmvnf-chips');
        secDef.append(inpDPos, inpDNeg, defChips, mk('div', 'pmvnf-hint', 'Applies in every playlist, on top of the filter above.'));
        body.appendChild(secDef);
        updateDefaultsBtn = () => { defMark.textContent = pendingDefaultTerms !== NF.defaultTerms ? 'not applied' : (NF.defaultTerms ? 'active' : ''); refreshPendingMarks(); };

        const secPl = mk('div', 'pmvnf-sec');
        const labPl = mk('div', 'pmvnf-lab', 'Playlist');
        secPl.appendChild(labPl);
        const plModes = mk('div', 'pmvnf-chips');
        const modeChips = [['all', 'All', ''], ['in', '✓ In playlist', 'in'], ['out', '✕ Not in playlist', 'out']].map(([m, txt, cls]) => {
            const c = mkChip(txt, () => { pendingPlaylistMode = m; updatePlBtn(); }, 'Takes effect when you apply');
            if (cls) c.classList.add(cls);
            c.dataset.mode = m; plModes.appendChild(c); return c;
        });
        secPl.appendChild(plModes);
        const plSel = mkSelect({
            multi: true, placeholder: 'Any playlist', label: 'Which of your playlists count for In / Not in playlist',
            emptyText: 'No playlists yet — log in to load yours.',
            items: () => [...getLivePlaylists().playlists.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ value: p.id, title: p.name, sub: `${p.ids.size} videos` })),
            isSelected: id => pendingSelectedPlaylistIds.includes(id),
            onPick: id => { pendingSelectedPlaylistIds = pendingSelectedPlaylistIds.includes(id) ? pendingSelectedPlaylistIds.filter(x => x !== id) : [...pendingSelectedPlaylistIds, id]; updatePlBtn(); },
        });
        secPl.appendChild(plSel.el);
        updatePlBtn = function () {
            modeChips.forEach(c => {
                c.classList.toggle('active', c.dataset.mode === pendingPlaylistMode);
                c.classList.toggle('pending', c.dataset.mode === pendingPlaylistMode && pendingPlaylistMode !== BTN.playlistMode);
            });
            plSel.render();
            plSel.el.style.opacity = pendingPlaylistMode === 'all' ? '0.5' : '1';
            plSel.el.classList.toggle('pending', !isSetEqual(pendingSelectedPlaylistIds, BTN.selectedPlaylistIds));
            refreshPendingMarks();
        };
        body.appendChild(secPl);

        const secSeen = mk('div', 'pmvnf-sec');
        secSeen.appendChild(mk('div', 'pmvnf-lab', 'Watched'));
        const seenRow = mk('div', 'pmvnf-chips');
        const seenChips = [[null, 'All'], ['unseen', 'Unwatched'], ['seen', 'Watched']].map(([v, txt]) => {
            const c = mkChip(txt, () => { UI.seen = v; renderSeen(); refreshPendingMarks(); }, v === null ? '' : v === 'unseen' ? 'Hides videos you have watched (85%+)' : 'Hides videos you have not watched yet');
            c.dataset.seen = v === null ? '' : v; seenRow.appendChild(c); return c;
        });
        const renderSeen = () => seenChips.forEach(c => c.classList.toggle('active', (c.dataset.seen || null) === UI.seen));
        secSeen.appendChild(seenRow);
        body.appendChild(secSeen);

        // Content flags cycle off -> hide -> only these -> off; staged like the rest.
        const secFlags = mk('div', 'pmvnf-sec');
        secFlags.appendChild(mk('div', 'pmvnf-lab', 'Content'));
        const flagRow = mk('div', 'pmvnf-chips');
        const flagChips = (PMVX.contentFlags || []).map(([key, label]) => {
            const c = mkChip(label, () => {
                const f = { ...pendingFlags };
                const m = f[key];
                if (!m) f[key] = 'out'; else if (m === 'out') f[key] = 'in'; else delete f[key];
                pendingFlags = f;
                updateFlagBtns();
            });
            c.dataset.flag = key; c.dataset.label = label;
            flagRow.appendChild(c);
            return c;
        });
        updateFlagBtns = () => {
            flagChips.forEach(c => {
                const m = pendingFlags[c.dataset.flag];
                c.className = 'pmvnf-chip' + (m ? ' active ' + m : '') + ((m || '') !== (BTN.flags[c.dataset.flag] || '') ? ' pending' : '');
                c.textContent = (m === 'out' ? '\u2298 ' : m === 'in' ? '\u2713 ' : '') + c.dataset.label;
                c.title = m === 'out' ? `Hides videos flagged ${c.dataset.label} \u2014 click: only these`
                    : m === 'in' ? `Only videos flagged ${c.dataset.label} \u2014 click: off`
                    : `Click: hide videos flagged ${c.dataset.label}`;
            });
            refreshPendingMarks();
        };
        updateFlagBtns();
        secFlags.append(flagRow, mk('div', 'pmvnf-hint', 'Click: hide (\u2298) \u2192 only these (\u2713) \u2192 off. Flags the playlist data lacks are fetched once; videos whose flag is still unknown stay visible.'));
        body.appendChild(secFlags);

        const secRat = mk('div', 'pmvnf-sec'); secRat.appendChild(mk('div', 'pmvnf-lab', 'Rating'));
        const ratSlider = mkDualSlider({ min: 0, max: 100,
            getRange: () => [pendingRatingMin, pendingRatingMax], setRange: (a, b) => { pendingRatingMin = a; pendingRatingMax = b; },
            fmt: (v, isMax) => (isMax && v >= 100) ? 'Any' : v + '%',
            presets: [{ a: 0, b: 100, label: 'Any' }, { a: 90, b: 100, label: '90%+' }, { a: 80, b: 100, label: '80%+' }, { a: 70, b: 100, label: '70%+' }, { a: 50, b: 80, label: '50-80%' }] });
        secRat.appendChild(ratSlider.el); body.appendChild(secRat);
        updateRatBtn = () => ratSlider.render();
        const secDur = mk('div', 'pmvnf-sec'); secDur.appendChild(mk('div', 'pmvnf-lab', 'Duration'));
        const M = DURATION_SLIDER_MAX_MIN;
        const durSlider = mkDualSlider({ min: 0, max: M,
            getRange: () => [Math.round(pendingDurationMin / 60), Number.isFinite(pendingDurationMax) ? Math.round(pendingDurationMax / 60) : M],
            setRange: (a, b) => { pendingDurationMin = a * 60; pendingDurationMax = b >= M ? Infinity : b * 60; },
            fmt: (v, isMax) => (isMax && v >= M) ? 'Any' : v + 'm',
            presets: [{ a: 0, b: M, label: 'Any' }, { a: 0, b: 5, label: '<5m' }, { a: 5, b: 10, label: '5-10m' }, { a: 10, b: 20, label: '10-20m' }, { a: 20, b: M, label: '20m+' }] });
        secDur.appendChild(durSlider.el); body.appendChild(secDur);
        updateDurBtn = () => durSlider.render();

        const secSs = mk('div', 'pmvnf-sec'); secSs.appendChild(mk('div', 'pmvnf-lab', 'Saved search'));
        let ssList = null;
        const ssSel = mkSelect({
            placeholder: 'None', label: 'One of your saved searches as an extra filter',
            emptyText: ssList === null ? 'loading…' : 'No saved searches on your account.',
            items: () => [{ value: '', title: 'None', sub: 'No saved search' }, ...((ssList || []).map(ss => { const name = ss.name || ss.title || '(unnamed)'; return { value: name, title: name, sub: [ss.excludeTags?.length ? `${ss.excludeTags.length} excluded tags` : '', ss.minRating ? `rating ${ss.minRating}%+` : ''].filter(Boolean).join(' · ') || 'Saved search', ss }; }))],
            isSelected: v => (v || '') === (pendingSavedSearchName || ''),
            onPick: v => {
                if (!v) { pendingSavedSearch = null; pendingSavedSearchName = ''; }
                else { const ss = (ssList || []).find(s => (s.name || s.title || '(unnamed)') === v); pendingSavedSearch = ss ? parseSavedSearch(ss) : pendingSavedSearch; pendingSavedSearchName = v; }
                updateSsBtn();
            },
        });
        secSs.appendChild(ssSel.el); body.appendChild(secSs);
        updateSsBtn = () => { ssSel.render(); ssSel.el.classList.toggle('pending', pendingSavedSearchName !== BTN.savedSearchName); refreshPendingMarks(); };
        const loadSavedSearchList = async () => { if (ssList) return; try { ssList = await fetchSavedSearches(); } catch { ssList = []; } ssSel.render(); };

        const actions = mk('div', 'pmvnf-actions');
        const counter = mk('span'); counter.id = 'pmvnf-counter';
        const closeBtn = mk('button', 'pmvnf-close', 'Close ✕'); closeBtn.type = 'button'; closeBtn.onclick = () => setOpen(false);
        // Copies the site-wide header filter into this one, staged until Filters.
        const syncBtn = mk('button', 'pmvnf-close', 'Sync from site filter'); syncBtn.type = 'button';
        syncBtn.title = 'Copy the site-wide filter (terms, watched, playlist, rating, max length, content flags) into this one \u2014 then press Filters';
        syncBtn.onclick = () => {
            const g = PMVX.siteFilterSnapshot?.();
            if (!g) { counter.textContent = 'Site filter not available'; return; }
            UI.pos.splice(0, UI.pos.length, ...g.include);
            UI.neg.splice(0, UI.neg.length, ...g.exclude);
            UI.seen = g.seen === 'seen' || g.seen === 'unseen' ? g.seen : null;
            pendingPlaylistMode = g.playlistMode || 'all';
            pendingSelectedPlaylistIds = (g.playlistIds || []).slice();
            pendingRatingMin = g.ratingMin ?? 0; pendingRatingMax = g.ratingMax ?? 100;
            pendingDurationMin = 0; pendingDurationMax = g.maxMinutes > 0 ? g.maxMinutes * 60 : Infinity;
            pendingFlags = { ...(g.flags || {}) }; updateFlagBtns();
            renderTagChips(); renderSeen(); updatePlBtn(); ratSlider.render(); durSlider.render(); refreshPendingMarks();
            counter.textContent = 'Copied \u2014 press Filters to apply';
        };
        actions.append(counter, syncBtn, closeBtn);
        panel.appendChild(actions);

        NF.applyAll = () => applyAll();
        function applyAll() {
            const text = uiToText();
            [inpPos, inpNeg, inpDPos, inpDNeg].forEach(i => i.value = '');
            onOwnInput(text);
        }

        refreshPendingMarks = () => {
            const pend = anyPending();
            lbl.textContent = pend ? 'Filters *' : 'Filters';
            toggle.classList.toggle('pending', pend);
            let n = 0;
            const t = parseTokens(NF.lastOwnValue || '');
            n += t.textInclude.length + t.textExclude.length + (t.seenFilter ? 1 : 0);
            if (BTN.playlistMode !== 'all') n++;
            n += flagKeysActive().length;
            if (BTN.ratingMin > 0 || BTN.ratingMax < 100) n++;
            if (BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)) n++;
            if (BTN.savedSearchName) n++;
            if (NF.defaultTerms) n++;
            badge.textContent = n ? String(n) : '';
            toggle.dataset.active = n && filterLive() ? '1' : '0';
            toggle.title = pend ? 'Apply changes'
                : (n && filterLive() ? 'Filter on \u2014 click to turn it off (settings are kept)'
                : n && !NF.enabled ? 'Filter is off \u2014 click to apply and turn it on'
                : (n && !sessionFilterArmed ? 'Remembered from your last visit — not active yet, click to apply' : 'Apply filters'));
        };

        renderTagChips(); renderSeen(); updatePlBtn(); ratSlider.render(); durSlider.render(); updateSsBtn(); updateDefaultsBtn(); refreshPendingMarks();
        injectQueueFooter();
        setOpen(UI.open);
        injectSortSelect();
        window.addEventListener('pmv:cache-ready', onReady);
        attachOwnInputKeyIntercept();
    }

    // Document-level capture; reads NF.ownInput per event so it survives panel rebuilds.
    let ownInputKeyInterceptActive = false;
    function attachOwnInputKeyIntercept() {
        if (ownInputKeyInterceptActive) return;
        ownInputKeyInterceptActive = true;
        document.addEventListener('keydown', e => {
            if (e.target?.dataset?.pmvnfKind && typeof NF.onOwnKey === 'function') {
                if (NF.onOwnKey(e)) { e.stopImmediatePropagation(); e.preventDefault(); }
                return;
            }
            if (e.target !== NF.ownInput) return;
            if (e.key === 'Enter') {
                e.stopImmediatePropagation();
                e.preventDefault();
                onOwnInput(NF.ownInput.value);
            } else if (e.key === 'Escape') {
                e.stopImmediatePropagation();
                e.preventDefault();
                NF.ownInput.value = '';
                onOwnInput('');
            }
        }, true);
    }

    function updateCounter(msg) {
        const el = document.getElementById('pmvnf-counter');
        if (el) el.textContent = msg;
    }


    // --- Main flow ---

    function onOwnInput(value) {
        // First Enter/Filter press arms filtering.
        sessionFilterArmed = true;
        PMVX.clearActed();
        if (!NF.enabled) setFilterEnabled(true, { refilter: false });
        try { NF.renderPower?.(); } catch {}

        BTN.playlistMode = pendingPlaylistMode;
        BTN.selectedPlaylistIds = pendingSelectedPlaylistIds.slice();
        BTN.savedSearch = pendingSavedSearch;
        BTN.savedSearchName = pendingSavedSearchName;
        BTN.ratingMin = pendingRatingMin;
        BTN.ratingMax = pendingRatingMax;
        BTN.durationMin = pendingDurationMin;
        BTN.durationMax = pendingDurationMax;
        BTN.flags = { ...pendingFlags };
        updateFlagBtns();
        if (NF.defaultTerms !== pendingDefaultTerms) {
            NF.defaultTerms = pendingDefaultTerms;
            saveDefaultTerms();
        }
        NF.lastOwnValue = value;
        try { textToUi(value); defaultsToUi(pendingDefaultTerms); NF.renderOwnChips?.(); } catch {}
        updatePlBtn();
        updateSsBtn();
        updateRatBtn();
        updateDurBtn();
        updateDefaultsBtn();
        try { refreshPendingMarks(); } catch {}
        watchVideoList(); // self-heal if Vue replaced the container

        saveSettings();
        syncToVue(value);

        // Two frames so Vue's DOM update lands first.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => applyFilter(value, true));
        });
    }

    function pollNative() {
        // Off the playlist page (or input replaced): stop; attachNativeInput restarts it for a new input.
        if (!NF.input?.isConnected) { clearInterval(NF.pollTimer); NF.pollTimer = null; return; }
        // Self-heal: reattach the observer if Vue replaced the queue container.
        watchVideoList();
        watchActiveRow();

        const v = NF.input.value;
        if (v !== NF.lastNativeValue) {
            NF.lastNativeValue = v;
            // Native input changed: re-apply our filters on top of Vue's result.
            if (hasAnyActiveFilter()) {
                requestAnimationFrame(() => applyFilter(NF.lastOwnValue, true));
            }
        }
    }

    let listObserver = null;
    let watchedListContainer = null;

    function watchVideoList() {
        const list = queueRows()[0]?.parentElement;
        if (!list) return;

        // Reattach if Vue replaced the container (old observer watches a detached node).
        if (listObserver && watchedListContainer === list && document.contains(list)) return;
        if (listObserver) listObserver.disconnect();
        watchedListContainer = list;

        // Coalesced per frame; force: new rows have no display state and the cache guard would skip them.
        const scheduleListFilter = PMVX.scheduler(() => {
            if (hasAnyActiveFilter()) applyFilter(NF.lastOwnValue, true);
        });
        listObserver = new MutationObserver(scheduleListFilter);

        // subtree: placeholder rows are hydrated in place (nested mutation).
        listObserver.observe(list, { childList: true, subtree: true });
    }

    // --- Auto-skip ---

    let activeRowObserver = null;
    let activeRowContainer = null;
    let skipChainCount = 0;
    const SKIP_CHAIN_MAX = 30;
    const SKIP_CHAIN_WINDOW_MS = 5000;
    let lastSkipResetTime = 0;

    function rowShouldBeHidden(row) {
        if (!hasAnyActiveFilter()) return false;
        const tokens = parseTokens(getEffectiveFilterValue(NF.lastOwnValue));
        return !rowPassesFilter(row, tokens);
    }

    function findNextVisibleRow() {
        const rows = queueRows();
        const activeIdx = rows.findIndex(r => r.classList.contains('border-orange-500'));
        for (let i = activeIdx + 1; i < rows.length; i++) {
            if (!rowShouldBeHidden(rows[i])) return rows[i];
        }
        return null;
    }

    // Intercept N and click the next visible row so Vue never activates a filtered video.
    let nInterceptActive = false;
    function attachNIntercept() {
        if (nInterceptActive) return;
        nInterceptActive = true;
        document.addEventListener('keydown', e => {
            if (e.key !== 'n' && e.key !== 'N') return;
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

            if (sortedRowIds) {
                // With a sort, Vue's DOM-order next is wrong: always click ours.
                const nextRow = getSortAwareNextRow();
                if (!nextRow) return; // end of sort order: native N
                e.stopImmediatePropagation();
                e.preventDefault();
                nextRow.click();
                return;
            }

            // No sort: intercept only if Vue's next row is filtered.
            if (!hasAnyActiveFilter()) return;

            const nextRow = findNextVisibleRow();
            if (!nextRow) return;

            const rows = queueRows();
            const activeIdx = rows.findIndex(r => r.classList.contains('border-orange-500'));
            const vueNext = rows[activeIdx + 1];

            if (!vueNext || !rowShouldBeHidden(vueNext)) return;

            e.stopImmediatePropagation();
            e.preventDefault();
            nextRow.click();
        }, true); // capture: before Vue
    }

    function triggerNextKey() {
        const now = Date.now();
        if (now - lastSkipResetTime > SKIP_CHAIN_WINDOW_MS) {
            skipChainCount = 0;
            lastSkipResetTime = now;
        }
        skipChainCount++;
        if (skipChainCount > SKIP_CHAIN_MAX) {
            console.warn('[PMVH Extended] Auto-skip stopped: too many consecutive skips');
            return;
        }
        if (sortedRowIds) {
            const next = getSortAwareNextRow();
            if (next) { next.click(); return; }
        }
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'n', code: 'KeyN', keyCode: 78, which: 78, bubbles: true
        }));
    }

    function watchActiveRow() {
        const container = queueRows()[0]?.parentElement;
        // Reattach when Vue or a playlist navigation replaced the queue container.
        if (!container || (activeRowObserver && container === activeRowContainer)) return;
        activeRowObserver?.disconnect();
        activeRowContainer = container;

        let lastActiveRow = container.querySelector('.border-orange-500');

        activeRowObserver = new MutationObserver(() => {
            const active = container.querySelector('.border-orange-500');
            if (!active || active === lastActiveRow) return;
            lastActiveRow = active;

            if (!hasAnyActiveFilter()) return;
            if (!rowShouldBeHidden(active)) {
                const tokens = parseTokens(getEffectiveFilterValue(NF.lastOwnValue));
                requestAnimationFrame(() => overrideUpNext(tokens));
                return;
            }

            skipChainCount = 0;
            triggerNextKey();
        });

        activeRowObserver.observe(container, {
            attributes: true,
            attributeFilter: ['class'],
            subtree: true
        });
    }

    let upNextObserver = null;
    let lastUpNextTitle = '';

    function watchUpNext() {
        if (upNextObserver) return;
        // Observes the body (incl. characterData); the box is cached and re-searched at most twice a second.
        let upNextBtn = null;
        let upNextLookAt = 0;
        let upNextRaf = false;
        const check = () => {
            const newTitle = getUpNextTitle(upNextBtn);
            if (newTitle === lastUpNextTitle) return;
            lastUpNextTitle = newTitle;
            const tokens = parseTokens(getEffectiveFilterValue(NF.lastOwnValue));
            requestAnimationFrame(() => overrideUpNext(tokens));
        };
        upNextObserver = new MutationObserver(muts => {
            if (!hasAnyActiveFilter()) return;
            if (upNextBtn?.isConnected) {
                const wrap = upNextBtn.parentElement || upNextBtn;
                if (!muts.some(m => wrap.contains(m.target))) return;
                check();
                return;
            }
            if (upNextRaf || performance.now() - upNextLookAt < 500) return;
            upNextRaf = true;
            requestAnimationFrame(() => {
                upNextRaf = false;
                upNextLookAt = performance.now();
                upNextBtn = findUpNextButton();
                check();
            });
        });
        upNextObserver.observe(document.body, {
            childList: true, subtree: true, characterData: true
        });
    }

    // --- Deeplink catch-up ---
    // Scrolls the queue so Vue's own lazy-load reaches ?index=; bounded, no own fetch.
    // Thumbnails far behind the target are unloaded; row nodes stay for Vue's v-for.
    const CATCHUP_UNLOAD_BUFFER = 100;
    let catchUpRunning = false;

    // --- Shared fetch-all cycle ---
    // Sets fetchAll, scrolls to the absolute bottom (relative scrollBy is unreliable) and polls until
    // untilPredicate holds or the row count is stable for 3 checks. Updates no UI.
    async function runFetchAllCycle({ untilPredicate = null, maxWaitMs = 20000, pollMs = 400 } = {}) {
        const scrollEl = queueRows()[0]?.closest('.overflow-y-auto');
        if (!scrollEl) return { ok: false, reason: 'no-scroll-container', rowCount: 0, waitedMs: 0 };

        PMVX.forceFetchAllNext = true;
        const kickScroll = () => {
            scrollEl.scrollTop = scrollEl.scrollHeight;
            scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));
        };
        kickScroll();

        let waited = 0;
        let rowCount = queueRows().length;
        let stableTicks = 0;
        let ticksSinceKick = 0;
        let hitPredicate = false;
        while (waited < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollMs));
            waited += pollMs;
            const newCount = queueRows().length;
            const grew = newCount !== rowCount;
            rowCount = newCount;
            if (untilPredicate) {
                if (untilPredicate(newCount)) { hitPredicate = true; break; }
            } else if (!grew) {
                stableTicks++;
                if (stableTicks >= 3) break;
            } else {
                stableTicks = 0;
            }
            // Kick on growth or after one stalled tick: the core honors fetchAll only on a page=1 request,
            // and re-kicking during a page fetch re-dispatches scroll and duplicates rows.
            if (grew) {
                kickScroll();
                ticksSinceKick = 0;
            } else {
                ticksSinceKick++;
                if (ticksSinceKick >= 2) {
                    kickScroll();
                    ticksSinceKick = 0;
                }
            }
        }

        PMVX.forceFetchAllNext = false;
        return { ok: true, rowCount, waitedMs: waited, hitPredicate };
    }

    function getMetaCoverage() {
        const rows = queueRows();
        const videoMeta = PMVX.state?.videoMeta;
        let withMeta = 0, unknownId = 0;
        rows.forEach(row => {
            const vid = getRowVideoId(row);
            if (!vid) { unknownId++; return; }
            if (videoMeta?.has(vid)) withMeta++;
        });
        return { total: rows.length, withMeta, unknownId };
    }

    // Single-flight, once per filter value (pollNative runs every 300ms).
    let backgroundFetchAllRunning = false;
    let lastAutoFetchFilterKey = null;

    async function autoFetchAllIfNeeded(ownValue, hasOwnFilter, needsMeta) {
        if (!hasOwnFilter || !needsMeta) return;
        if (backgroundFetchAllRunning || manualFetchAllRunning) return;
        const { total, withMeta } = getMetaCoverage();
        if (total === 0 || withMeta === total) return;
        if (lastAutoFetchFilterKey === ownValue) return;
        lastAutoFetchFilterKey = ownValue;

        backgroundFetchAllRunning = true;
        await runFetchAllCycle();
        backgroundFetchAllRunning = false;
        applyFilter(NF.lastOwnValue, true);
    }

    async function catchUpToDeeplinkIndex(urlIndex) {
        if (catchUpRunning) return;
        catchUpRunning = true;

        const startRowCount = queueRows().length;

        // fetchAll=true on Vue's next page fetch: one large fetch instead of many scroll rounds.
        const { ok, rowCount, waitedMs } = await runFetchAllCycle({
            untilPredicate: count => count > urlIndex,
            maxWaitMs: 16000,
        });

        if (!ok) {
            catchUpRunning = false;
            return;
        }


        if (rowCount > urlIndex) {
            hideAndUnloadOutsideWindow(urlIndex);
            const rowsNow = queueRows();
            const activeRow = rowsNow[urlIndex] || document.querySelector('.border-orange-500');
            activeRow?.scrollIntoView({ block: 'center', behavior: 'instant' });
        }

        catchUpRunning = false;
    }

    // Rows more than CATCHUP_UNLOAD_BUFFER before the target: hidden, img.src emptied.
    function hideAndUnloadOutsideWindow(targetIdx) {
        const rows = queueRows();
        const cutoff = Math.max(0, targetIdx - CATCHUP_UNLOAD_BUFFER);
        for (let i = 0; i < cutoff; i++) {
            const row = rows[i];
            if (!row) continue;
            row.style.display = 'none';
            row.dataset.pmvCatchupHidden = '1';
            const img = row.querySelector('img[src]');
            if (img && img.src) img.src = '';
        }
    }

    function attachNativeInput() {
        const found = document.querySelector('input[placeholder="Filter videos..."]');
        if (!found || found.dataset.pmvNfPatch) return;
        found.dataset.pmvNfPatch = '1';
        NF.input = found;

        // ?index=N needs DOM row N, but an SSR load embeds only a first batch and no client fetch.
        try {
            const urlIndex = parseInt(new URLSearchParams(location.search).get('index') || '', 10);
            const rowCount = queueRows().length;
            if (Number.isFinite(urlIndex) && urlIndex >= rowCount) {
                catchUpToDeeplinkIndex(urlIndex);
            }
        } catch {}

        buildOwnInput();
        watchVideoList();
        watchActiveRow();
        watchUpNext();
        attachNIntercept();

        clearInterval(NF.pollTimer);
        NF.pollTimer = setInterval(pollNative, 300);
    }

    // SPA navigation watcher; at document-start it waits for the body.
    let domObserverStarted = false;
    function startObserver() {
        if (domObserverStarted) return; // safeBoot runs again on every playlist navigation
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', startObserver, { once: true });
            return;
        }
        const domObserver = new MutationObserver(() => {
            attachNativeInput();
            if (NF.ownInput && !NF.ownInput.isConnected) {
                NF.ownInput = null;
                buildOwnInput();
            }
            if (NF.ownInput?.isConnected && !document.getElementById('pmvnf-sort')) { try { injectSortSelect(); } catch {} }
            if (NF.ownInput?.isConnected && !document.getElementById('pmvnf-qfoot')) { try { injectQueueFooter(); } catch {} }
        });
        domObserver.observe(document.body, { childList: true, subtree: true });
        domObserverStarted = true;
    }

    function boot() {
        loadPlaylistCache();
        attachNativeInput();
        checkForStuckHugePlaylist();

        // Retry every 500ms (max 10s) for a slow Vue mount.
        let tries = 0;
        const retryTimer = setInterval(() => {
            if (document.querySelector('#pmvnf-wrap') || ++tries > 20) {
                clearInterval(retryTimer);
                return;
            }
            attachNativeInput();
        }, 500);
    }

    // The site can stall on very large playlists: explain it instead of a silent spinner.
    function checkForStuckHugePlaylist() {
        if (!location.pathname.startsWith('/playlists/')) return;
        setTimeout(() => {
            if (queueRows()[0]) return;
            if (!document.body.innerText.includes('Loading playlist')) return;
            if (document.getElementById('pmvnf-stuck-notice')) return;
            const box = document.createElement('div');
            box.id = 'pmvnf-stuck-notice';
            box.style.cssText = `
                position: fixed; top: 70px; right: 12px; z-index: 999999;
                background: rgba(20,20,20,0.97); border: 1px solid rgba(250,204,21,0.4);
                border-radius: 8px; padding: 10px 14px; max-width: 300px;
                color: rgba(255,255,255,0.85); font-size: 12px;
                font-family:inherit;font-variant-numeric:tabular-nums; line-height: 1.6;
                box-shadow: 0 4px 16px rgba(0,0,0,0.6);
            `;
            box.innerHTML = `
                <div style="font-weight:700;color:rgb(250,204,21);margin-bottom:4px;">⚠ Playlist not loading</div>
                <div>PMVHaven's own playlist page is not finishing loading. This happens with very large playlists (thousands of videos), also without this script.</div>
                <div style="margin-top:6px;font-size:10px;color:rgba(255,255,255,0.3);cursor:pointer;text-decoration:underline;" id="pmvnf-stuck-dismiss">Close</div>
            `;
            document.body.appendChild(box);
            box.querySelector('#pmvnf-stuck-dismiss').onclick = () => box.remove();
        }, 10000);
    }

    // --- Boot ---
    // Defers init in background tabs until they become visible.
    let bootRan = false;
    const safeBoot = () => {
        if (bootRan) return;
        bootRan = true;
        boot();
        startObserver();
    };

    if (document.visibilityState === 'visible') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', safeBoot, { once: true });
        } else {
            safeBoot();
        }
    } else {
        document.addEventListener('visibilitychange', function onVis() {
            if (document.visibilityState !== 'visible') return;
            document.removeEventListener('visibilitychange', onVis);
            safeBoot();
        });
    }

    // The core dispatches this on client-side navigation to /playlists/<id>.
    window.addEventListener('pmv:playlist-navigate', () => {
        bootRan = false;
        setTimeout(safeBoot, 100);
    });

    // --- /playlists browse filter ---
    // The list endpoint has only video IDs: each card costs one /api/playlists/<id> request, cached per id by video count.
    // Terms match tags/starsTags (and description, if on) case-insensitively; unloaded cards stay visible (fail-open).
    (function playlistBrowseFilter() {
        const KEY_SETTINGS = 'pmvnf_browse_filter_v1';
        const KEY_CACHE    = 'pmvnf_browse_tagcache_v2'; // per-video tag indices
        const CACHE_MAX    = 1500;
        const CONCURRENCY  = 3;
        const BAR_ID       = 'pmvpb-bar';
        const BTN_ID       = 'pmvpb-btn';
        const STYLE_ID     = 'pmvpb-style';

        const PB = {
            raw: '',
            terms: { neg: [], pos: [] },
            overlap: [],        // own playlist ids for overlap
            mineRange: { min: null, max: null }, // fractions; typed !mine overrides
            countRange: { min: null, max: null }, // videos in the playlist
            newRange: { min: null, max: null },   // videos not in my playlists
            sort: 'site',       // 'site' | 'score'
            open: false,
            toggle: null,
            mode: 'hide',       // 'hide' | 'sink'
            enabled: true,
            autoScan: false,
            scanIds: new Set(),
            fullIds: new Set(), // fetch in full next time (✓ refetch)
            desc: true,
            tokens: { neg: [], pos: [] },
            listInfo: new Map(),  // id → { count, name }
            tags: new Map(),      // id → { count, at, tags }
            pending: new Map(),
            failed: new Set(),
            queue: [],
            running: 0,
            bar: null,
            input: null,
            counter: null,
            observer: null,
            active: false,
            sessionStart: Date.now(), // older cache entries predate this session
        };

        const isBrowsePage = () => location.pathname.replace(/\/+$/, '') === '/playlists';

        // --- Persistence ---
        function loadSettings() {
            try {
                const s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || 'null');
                if (s && typeof s.raw === 'string') PB.raw = s.raw;
                if (s && (s.mode === 'hide' || s.mode === 'sink')) PB.mode = s.mode;
            if (s && Array.isArray(s.overlap)) PB.overlap = s.overlap.filter(x => typeof x === 'string');
            if (s && s.mineRange && typeof s.mineRange === 'object') PB.mineRange = { min: parseBound(s.mineRange.min), max: parseBound(s.mineRange.max) };
            if (s && typeof s.open === 'boolean') PB.open = s.open;
            if (s && typeof s.enabled === 'boolean') PB.enabled = s.enabled;
            if (s && typeof s.autoScan === 'boolean') PB.autoScan = s.autoScan;
            const count = v => (v == null || v === '' || !Number.isFinite(+v)) ? null : Math.max(0, Math.round(+v)); // not parseBound: no fractions
            ['countRange', 'newRange'].forEach(k => { if (s?.[k]) PB[k] = { min: count(s[k].min), max: count(s[k].max) }; });
            if (s?.sort === 'score') PB.sort = 'score';
            } catch {}
            PB.desc = matchDescEnabled();
            try {
                const s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || 'null');
                if (s && s.terms && Array.isArray(s.terms.neg) && Array.isArray(s.terms.pos)) {
                    PB.terms = {
                        neg: s.terms.neg.filter(t => t && typeof t.term === 'string' && t.term.trim()).map(t => ({ term: t.term.trim().toLowerCase(), max: parseBound(t.max) ?? 0 })),
                        pos: s.terms.pos.filter(t => t && typeof t.term === 'string' && t.term.trim()).map(t => ({ term: t.term.trim().toLowerCase(), min: parseBound(t.min) })),
                    };
                } else if (PB.raw) {
                    // Migrate the legacy typed syntax once.
                    const parsed = parse(PB.raw);
                    PB.terms = { neg: parsed.neg, pos: parsed.pos };
                    if (parsed.mine) PB.mineRange = parsed.mine;
                    PB.raw = '';
                }
            } catch {}
            PB.tokens = { neg: PB.terms.neg, pos: PB.terms.pos, mine: null };
        }
        function saveSettings() {
            setMatchDesc(PB.desc);
            try { localStorage.setItem(KEY_SETTINGS, JSON.stringify({ terms: PB.terms, mode: PB.mode, overlap: PB.overlap, mineRange: PB.mineRange, countRange: PB.countRange, newRange: PB.newRange, sort: PB.sort, open: PB.open, enabled: PB.enabled, autoScan: PB.autoScan })); } catch {}
        }
        function loadCache() {
            try {
                const c = JSON.parse(localStorage.getItem(KEY_CACHE) || 'null');
                if (!c || typeof c !== 'object') return;
                Object.entries(c).forEach(([id, e]) => {
                    if (e && Array.isArray(e.tags) && Array.isArray(e.vids)) PB.tags.set(id, e);
                });
            } catch {}
        }
        let saveTimer = null;
        function saveCacheSoon() {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                try {
                    let entries = [...PB.tags.entries()];
                    if (entries.length > CACHE_MAX) {
                        entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
                        entries = entries.slice(0, CACHE_MAX);
                        PB.tags = new Map(entries);
                    }
                    localStorage.setItem(KEY_CACHE, JSON.stringify(Object.fromEntries(entries)));
                } catch (e) {
                    // Quota: drop the oldest half and retry once.
                    try {
                        const entries = [...PB.tags.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
                        PB.tags = new Map(entries.slice(0, Math.floor(entries.length / 2)));
                        localStorage.setItem(KEY_CACHE, JSON.stringify(Object.fromEntries(PB.tags)));
                    } catch {}
                }
            }, 800);
        }

        // --- Parsing ---
        // Token: [+-]term or [+-]"two words", optional threshold: -trans(0.1) hides above 10%, +anal(0.5) needs >= 50%.
        // !mine(a-b): share in the ticked own playlists within [a, b]; bounds optional, > 1 = percent, unknown fails open.
        function parseBound(v) {
            if (v == null || v === '') return null;
            let n = parseFloat(v);
            if (!Number.isFinite(n)) return null;
            if (n > 1) n = n / 100;
            return Math.min(1, Math.max(0, n));
        }
        function parse(raw) {
            const out = { neg: [], pos: [], mine: null };
            raw = String(raw || '').replace(/!mine\(\s*([\d.]*)\s*%?\s*-\s*([\d.]*)\s*%?\s*\)/gi, (_, a, b) => {
                out.mine = { min: parseBound(a), max: parseBound(b) };
                return ' ';
            });
            const re = /([+-]?)"([^"]+)"(?:\((\d*\.?\d+)\s*%?\))?|([+-]?)([^\s("]+)(?:\((\d*\.?\d+)\s*%?\))?/g;
            let m;
            while ((m = re.exec(raw || ''))) {
                const sign = m[1] || m[4] || '';
                const term = (m[2] || m[5] || '').trim().toLowerCase();
                const thrRaw = m[3] || m[6];
                if (!term) continue;
                let thr = null;
                if (thrRaw != null) {
                    thr = parseFloat(thrRaw);
                    if (!Number.isFinite(thr)) thr = null;
                    else if (thr > 1) thr = thr / 100;   // 10 or 10% → 0.10
                    if (thr != null) thr = Math.min(1, Math.max(0, thr));
                }
                if (sign === '-') out.neg.push({ term, max: thr ?? 0 });
                else out.pos.push({ term, min: thr });
            }
            return out;
        }
        // Off = no filter: all cards shown, no tag fetches; overlap badges stay.
        const hasTagFilter = () => PB.enabled && (PB.tokens.neg.length > 0 || PB.tokens.pos.length > 0);
        const activeMineRange = () => PB.tokens.mine || ((PB.mineRange.min != null || PB.mineRange.max != null) ? PB.mineRange : null);
        const hasRange = r => r.min != null || r.max != null;
        const outside = (v, r) => v != null && ((r.min != null && v < r.min) || (r.max != null && v > r.max));
        const rangeText = r => r.min != null && r.max != null ? `${r.min}\u2013${r.max}` : r.min != null ? `${r.min}+` : `\u2264${r.max}`;
        // Videos not in my playlists (the ticked ones, else all of them); null when unknown.
        const newOf = id => { if (!hasRange(PB.newRange)) return null; const o = overlapOf(id, true); return o ? o.total - o.n : null; };
        const hasFilter = () => PB.enabled && (hasTagFilter() || !!activeMineRange() || hasRange(PB.countRange) || hasRange(PB.newRange));

        // --- Fetch interceptor ---
        // Records video counts from list pages; wrapped once, chains with other fetch wrappers.
        if (!PMVX.pbFetchWrapped) {
            PMVX.pbFetchWrapped = true;
            const orig = window.fetch;
            window.fetch = async function (...args) {
                const res = await orig.apply(this, args);
                try {
                    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || String(args[0]));
                    if (/\/api\/playlists\?/.test(url)) {
                        pmvResJson(res).then(j => {
                            const list = Array.isArray(j) ? j : (j?.data || j?.playlists || []);
                            if (!Array.isArray(list)) return;
                            list.forEach(p => {
                                if (!p?._id) return;
                                PB.listInfo.set(p._id, {
                                    count: p.validVideoCount ?? (Array.isArray(p.videos) ? p.videos.length : null),
                                    name: p.name || '',
                                    desc: String(p.description || ''),
                                    videos: Array.isArray(p.videos) ? p.videos.map(v => typeof v === 'string' ? v : (v?._id || v?.id)).filter(Boolean) : [],
                                });
                            });
                            if (PB.active) scheduleApply();
                        }).catch(() => {});
                    }
                } catch {}
                return res;
            };
        }

        // --- Per-playlist tag loading ---
        function cardId(card) {
            const href = card.getAttribute('href') || '';
            const m = href.match(/\/playlists\/([a-f0-9]{24})/);
            return m ? m[1] : null;
        }
        function cardCount(card) {
            // Fallback: the card's top-left badge is the video count.
            const info = PB.listInfo.get(cardId(card));
            if (info && Number.isFinite(info.count)) return info.count;
            const t = (card.innerText || '').trim().split('\n')[0];
            const n = parseInt(t, 10);
            return Number.isFinite(n) ? n : null;
        }
        // A cached entry stays fresh until the video count moves by more than RESCAN_SHARE, or refresh is pressed.
        const RESCAN_SHARE = 0.10;
        function isFresh(entry, count) {
            if (!entry) return false;
            if (count == null || entry.count == null || entry.count === count) return true;
            const base = Math.max(1, entry.count);
            return Math.abs(count - entry.count) / base <= RESCAN_SHARE;
        }
        // Click on the ::after cached marker refetches (hit-tested by position; capture phase blocks the router).
        const MARKER_HIT = 44; // px square, top-right
        function refreshOne(id) {
            if (!id) return;
            PB.scanIds.add(id);
            PB.fullIds.add(id);
            PB.tags.delete(id);
            PB.failed.delete(id);
            fracMemo.clear();
            saveCacheSoon();
            applyFilter();
        }
        function onCardClick(e) {
            if (!PB.active) return;
            const card = e.target?.closest?.('.playlists-grid > a[data-pmvpb-cached="1"]');
            if (!card) return;
            const r = card.getBoundingClientRect();
            if (e.clientX < r.right - MARKER_HIT || e.clientY > r.top + MARKER_HIT) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.type === 'click') refreshOne(cardId(card));
        }
        // Scan page button: tags for the cards on the page.
        function scanVisible() {
            document.querySelectorAll('.playlists-grid > a[href*="/playlists/"]').forEach(card => {
                const id = cardId(card);
                if (!id) return;
                PB.scanIds.add(id);
                PB.failed.delete(id);
            });
            applyFilter();
        }
        function ensureLoaded(id, count, force = false) {
            if (!id || PB.pending.has(id) || PB.failed.has(id)) return;
            if (!force && isFresh(PB.tags.get(id), count)) return;
            let resolve;
            const p = new Promise(r => { resolve = r; });
            PB.pending.set(id, p);
            PB.queue.push({ id, count, resolve, full: PB.fullIds.has(id) });
            pump();
        }
        function pump() {
            while (PB.running < Math.min(CONCURRENCY, PMVX.perf().lookups) && PB.queue.length) {
                const job = PB.queue.shift();
                PB.running++;
                fetchTags(job.id, job.count, job.full).then(({ tags, vids, desc, sampled }) => {
                    PB.fullIds.delete(job.id);
                    PB.tags.set(job.id, { count: job.count, at: Date.now(), tags, vids, desc, sampled });
                    saveCacheSoon();
                }).catch(err => {
                    PB.failed.add(job.id);
                }).finally(() => {
                    PB.running--;
                    PB.pending.delete(job.id);
                    job.resolve();
                    scheduleApply();
                    pump();
                });
            }
        }
        // Quiet: skipped by the core's indexes (PMVX.quietUrls); body parsed once (pmvResJson).
        async function getPlaylistJson(url) {
            quietUrls.add(url);
            let res;
            try { res = await fetch(url, { credentials: 'include' }); }
            finally { quietUrls.delete(url); }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await pmvResJson(res);
            return j?.data || j;
        }
        // Over FULL_UNDER videos, sample SAMPLE_PAGE-video pages: first, last and m = clamp(round(log2(count/100)), 1, 4)
        // evenly spaced between (round(1 + i·(P−1)/(m+1))); tag shares are proportions, so ≤ 6 requests estimate them well.
        // e.g. 400 → 4 pages (200 videos), 1000 → 5 (250), 5000+ → 6 (300). Clicking ✓ fetches in full.
        const FULL_UNDER = 300;
        // Prefix for models in a playlist's tag vocabulary (older entries lack it).
        const STAR = '\u2605';
        const SAMPLE_PAGE = 50;
        function samplePages(count) {
            const P = Math.ceil(count / SAMPLE_PAGE);
            const m = Math.max(1, Math.min(4, Math.round(Math.log2(count / 100))));
            const pages = new Set([1, P]);
            for (let i = 1; i <= m; i++) pages.add(Math.round(1 + i * (P - 1) / (m + 1)));
            return [...pages].sort((a, b) => a - b);
        }
        async function fetchTags(id, count, full) {
            let details = [];
            let desc = '';
            let sampled = null;
            if (full || !Number.isFinite(count) || count <= FULL_UNDER) {
                const root = await getPlaylistJson(`/api/playlists/${id}?fetchAll=true`);
                details = root?.videoDetails || [];
                desc = String(root?.description || '');
            } else {
                // Sequential: other playlists' jobs already run in parallel.
                const seen = new Set();
                let ok = 0, lastErr = null;
                for (const page of samplePages(count)) {
                    const url = `/api/playlists/${id}?page=${page}&limit=${SAMPLE_PAGE}`;
                    let root = null;
                    for (let attempt = 0; attempt < 2 && !root; attempt++) {
                        try { root = await getPlaylistJson(url); }
                        catch (e) {
                            lastErr = e;
                            if (attempt === 0 && /429/.test(e.message)) await new Promise(r => setTimeout(r, 1500));
                            else break;
                        }
                    }
                    if (!root) continue; // a missing page shrinks the sample, doesn't fail the scan
                    ok++;
                    if (!desc) desc = String(root?.description || '');
                    (root?.videoDetails || []).forEach(v => {
                        const key = v?._id || v?.id;
                        if (key && seen.has(key)) return;
                        if (key) seen.add(key);
                        details.push(v);
                    });
                }
                if (!ok) throw lastErr || new Error('no pages');
                sampled = { n: details.length, of: count };
            }
            // tags: playlist-local vocabulary; vids: per-video indices into it.
            const vocab = new Map();
            const vids = [];
            details.forEach(v => {
                const own = new Set();
                (v?.tags || v?.top5Tags || []).forEach(t => { if (t) own.add(String(t).toLowerCase()); });
                (v?.starsTags || v?.stars || []).forEach(s => {
                    const n = typeof s === 'string' ? s : s?.name;
                    if (n) own.add(STAR + String(n).toLowerCase()); // marked: model lists match only these
                });
                const idx = [];
                own.forEach(t => {
                    if (!vocab.has(t)) vocab.set(t, vocab.size);
                    idx.push(vocab.get(t));
                });
                vids.push(idx);
            });
            return { tags: [...vocab.keys()], vids, desc, sampled };
        }

        // --- Evaluation ---
        // Returns { state: 'pass'|'fail'|'pending', hits }; the description (list response) can decide before tags load.
        function descOf(id) {
            if (!PB.desc) return '';
            const d = PB.listInfo.get(id)?.desc ?? PB.tags.get(id)?.desc ?? '';
            return String(d).toLowerCase();
        }
        // Share of videos in the ticked own playlists (all own with allMine); null when unknown.
        function overlapOf(id, allMine = false) {
            if (!PB.overlap.length && !allMine) return null;
            const info = PB.listInfo.get(id);
            if (!info || !info.videos) return null;
            const { playlists } = getLivePlaylists();
            const sel = PB.overlap.length ? PB.overlap.map(pid => playlists.get(pid)).filter(Boolean) : [...playlists.values()].filter(p => p.id !== id);
            if (!sel.length) return null;
            const per = new Map();
            let n = 0;
            for (const v of info.videos) {
                let hit = false;
                for (const p of sel) {
                    if (p.ids.has(v)) { hit = true; per.set(p.name, (per.get(p.name) || 0) + 1); }
                }
                if (hit) n++;
            }
            const total = Number.isFinite(info.count) && info.count > 0 ? info.count : info.videos.length;
            return { n, total, frac: total ? n / total : 0, per };
        }

        // Share of videos with a tag/performer containing `term`, memoised per (playlist, fetch time, term).
        const fracMemo = new Map();
        function fraction(id, entry, term) {
            const key = id + '|' + (entry.at || 0) + '|' + term;
            const hit = fracMemo.get(key);
            if (hit) return hit;
            const matchIdx = new Set();
            entry.tags.forEach((t, i) => { if (PMVX.termMatch(t, term)) matchIdx.add(i); });
            let n = 0;
            if (matchIdx.size) {
                for (const idx of entry.vids) {
                    if (idx.some(i => matchIdx.has(i))) n++;
                }
            }
            const total = entry.vids.length;
            const r = { n, total, frac: total ? n / total : 0 };
            if (fracMemo.size > 5000) fracMemo.clear();
            fracMemo.set(key, r);
            return r;
        }
        const pct = f => Math.round(f * 100) + '%';

        // --- Score: share of a playlist's (sampled) videos that pass your filters, 0–100. ---
        // A video passes with no exclude term and every require term on its tags (model lists vs its models only).
        // Terms: site-wide filter (if on) + this page's tag filter, without share thresholds; titles aren't scanned.
        function scoreTerms() {
            const out = { exc: [], inc: [], mExc: [], mInc: [] };
            const s = PMVX.siteFilterSnapshot?.();
            if (s?.active) {
                out.exc.push(...(s.exclude || [])); out.inc.push(...(s.include || []));
                out.mExc.push(...(s.modelsExclude || [])); out.mInc.push(...(s.modelsInclude || []));
            }
            if (PB.enabled) {
                PB.tokens.neg.forEach(t => out.exc.push(t.term));
                PB.tokens.pos.forEach(t => out.inc.push(t.term));
            }
            for (const k in out) out[k] = [...new Set(out[k])];
            return out;
        }
        const scoreActive = () => { const t = scoreTerms(); return !!(t.exc.length || t.inc.length || t.mExc.length || t.mInc.length); };
        const scoreMemo = new Map();
        function scoreOf(id, entry) {
            if (!entry?.vids?.length) return null;
            const t = scoreTerms();
            if (!(t.exc.length || t.inc.length || t.mExc.length || t.mInc.length)) return null;
            const key = id + '|' + (entry.at || 0) + '|' + JSON.stringify(t);
            if (scoreMemo.has(key)) return scoreMemo.get(key);
            const marked = entry.tags.some(x => x[0] === STAR);
            const isModel = x => x[0] === STAR;
            const label = x => isModel(x) ? x.slice(1) : x;
            // Vocabulary indices per term; old entries (no model marks) match tag terms on everything.
            const idx = (term, models) => {
                const set = new Set();
                entry.tags.forEach((x, i) => {
                    if (marked && isModel(x) !== models) return;
                    if (PMVX.termMatch(label(x), term)) set.add(i);
                });
                return set;
            };
            const E = t.exc.map(x => idx(x, false)), I = t.inc.map(x => idx(x, false));
            const ME = t.mExc.map(x => idx(x, true)), MI = t.mInc.map(x => idx(x, true));
            let pass = 0;
            for (const v of entry.vids) {
                const has = set => v.some(i => set.has(i));
                if (E.some(has) || ME.some(has)) continue;
                if (!I.every(has) || !MI.every(has)) continue;
                pass++;
            }
            const total = entry.vids.length;
            const score = Math.round(100 * pass / total);
            const r = { score, grade: score >= 70 ? 'hi' : score >= 40 ? 'mid' : 'lo',
                line: `Score ${score}: ${pass} of ${total}${entry.sampled ? ' sampled' : ''} videos pass your filters` };
            if (scoreMemo.size > 2000) scoreMemo.clear();
            scoreMemo.set(key, r);
            return r;
        }
        // Every filter a playlist fails on its own (evaluate() stops at the first): 'neg:<term>', 'pos:<term>', 'mine'.
        function failKeys(id, count) {
            const entry = PB.tags.get(id);
            const desc = descOf(id);
            const out = [];
            const mineRange = activeMineRange();
            if (mineRange) {
                const o = overlapOf(id);
                if (o && ((mineRange.min != null && o.frac < mineRange.min) || (mineRange.max != null && o.frac > mineRange.max))) out.push('mine');
            }
            if (outside(count, PB.countRange)) out.push('count');
            if (outside(newOf(id), PB.newRange)) out.push('new');
            for (const { term, max } of PB.tokens.neg) {
                if (desc && PMVX.termMatch(desc, term)) { out.push('neg:' + term); continue; }
                if (!entry) continue;
                const f = fraction(id, entry, term);
                if (f.n > 0 && f.frac > max) out.push('neg:' + term);
            }
            if (entry) {
                for (const { term, min } of PB.tokens.pos) {
                    if (desc && PMVX.termMatch(desc, term)) continue;
                    const f = fraction(id, entry, term);
                    if (!(min == null ? f.n > 0 : (f.n > 0 && f.frac >= min))) out.push('pos:' + term);
                }
            }
            return out;
        }
        PB.removedBy = new Map();
        PB.removedOnly = new Map();
        PB.removedOf = 0;
        function paintRemovedCounts() {
            document.querySelectorAll('#' + BAR_ID + ' [data-pmvpb-key]').forEach(c => {
                const key = c.dataset.pmvpbKey;
                const n = PB.removedBy.get(key) || 0;
                const only = PB.removedOnly.get(key) || 0;
                let cnt = c.querySelector('.cnt');
                if (!cnt) { cnt = document.createElement('span'); cnt.className = 'cnt'; c.insertBefore(cnt, c.querySelector('.x')); }
                PMVX.setText(cnt, '\u2212' + n);
                PMVX.setAttr(cnt, 'data-zero', n ? '' : '1');
                PMVX.setAttr(cnt, 'title', `Removes ${n} of ${PB.removedOf} playlists on this page` + (n ? ` (${only} only because of this filter)` : ''));
            });
        }
        function evaluate(id, count) {
            const entry = PB.tags.get(id);
            // Stale data is used while the refetch runs.
            const desc = descOf(id);
            // No tag data yet (or the fetch failed): unknown, never a reason to hide.
            const pending = hasTagFilter() && !entry;
            const hits = [];
            const mineRange = activeMineRange();
            if (mineRange) {
                const o = overlapOf(id);
                if (o) {
                    const { min, max } = mineRange;
                    if ((min != null && o.frac < min) || (max != null && o.frac > max)) {
                        const rng = (min != null ? pct(min) : '0%') + '–' + (max != null ? pct(max) : '100%');
                        return { state: 'fail', hits: [`overlap ${pct(o.frac)} (${o.n}/${o.total}) outside ${rng}`] };
                    }
                }
            }
            if (outside(count, PB.countRange)) return { state: 'fail', hits: [`${count} videos, outside ${rangeText(PB.countRange)}`] };
            const nw = newOf(id);
            if (outside(nw, PB.newRange)) return { state: 'fail', hits: [`${nw} videos not in my playlists, outside ${rangeText(PB.newRange)}`] };
            for (const { term, max } of PB.tokens.neg) {
                // A description hit covers the whole playlist: no threshold.
                if (desc && PMVX.termMatch(desc, term)) { hits.push('description: ' + term); continue; }
                if (!entry) continue;
                const f = fraction(id, entry, term);
                if (f.n > 0 && f.frac > max) {
                    hits.push(max > 0 ? `${term} ${pct(f.frac)} (${f.n}/${f.total}, max ${pct(max)})` : `${term} (${f.n}/${f.total})`);
                }
            }
            if (hits.length) return { state: 'fail', hits };
            if (pending) return { state: 'pending', hits: [] };
            for (const { term, min } of PB.tokens.pos) {
                if (desc && PMVX.termMatch(desc, term)) continue;
                const f = entry ? fraction(id, entry, term) : { n: 0, total: 0, frac: 0 };
                const ok = min == null ? f.n > 0 : (f.n > 0 && f.frac >= min);
                if (!ok) return { state: 'fail', hits: [min == null ? 'no ' + term : `${term} ${pct(f.frac)} (${f.n}/${f.total}, min ${pct(min)})`] };
            }
            return { state: 'pass', hits: [] };
        }

        let applyTimer = null;
        function scheduleApply() {
            clearTimeout(applyTimer);
            applyTimer = setTimeout(() => { applyFilter(); applyVideoSection(); }, 60);
        }
        // --- Follow button on playlist cards ---
        //   GET    /api/playlists/followed?limit=…  -> { success, playlists: [...] }
        //   POST   /api/playlists/<id>/follow       -> { success, isFollowing }; DELETE unfollows
        // "+ Follow" on hover, "✓ Following" stays; not on own playlists, nothing when logged out (list fails).
        PB.followed = null; // Set of ids once loaded
        let followLoad = null;
        function loadFollowed() {
            if (followLoad) return followLoad;
            followLoad = fetch('/api/playlists/followed?limit=500', { credentials: 'include', headers: { accept: 'application/json' } })
                .then(r => r.ok ? r.json() : null)
                .then(j => {
                    if (!j?.success || !Array.isArray(j.playlists)) return;
                    PB.followed = new Set(j.playlists.map(p => p?._id || p?.id).filter(Boolean));
                    scheduleApply();
                })
                .catch(() => {});
            return followLoad;
        }
        function paintFollowBtn(b, on) {
            b.dataset.on = on ? '1' : '';
            b.textContent = on ? '\u2713 Following' : '+ Follow';
            b.title = on ? 'Unfollow this playlist' : 'Follow this playlist';
        }
        function ensureFollowButtons(cards) {
            loadFollowed();
            if (!PB.followed) return;
            const mine = getLivePlaylists().playlists;
            cards.forEach(card => {
                const id = cardId(card);
                let b = card.querySelector(':scope > .pmvpb-follow');
                if (!id || mine.has(id)) { b?.remove(); return; }
                if (!b) {
                    b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'pmvpb-follow';
                    // The card link may act on mousedown: keep every phase on the button.
                    ['mousedown', 'mouseup'].forEach(t => b.addEventListener(t, e => { e.preventDefault(); e.stopPropagation(); }));
                    b.addEventListener('click', async e => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (b.dataset.busy) return;
                        const pid = cardId(card);
                        const was = PB.followed.has(pid);
                        b.dataset.busy = '1';
                        paintFollowBtn(b, !was);
                        try {
                            const r = await fetch(`/api/playlists/${pid}/follow`, { method: was ? 'DELETE' : 'POST', credentials: 'include', headers: { accept: 'application/json' } });
                            const j = r.ok ? await r.json().catch(() => ({})) : null;
                            if (!r.ok || j?.success === false) throw new Error('HTTP ' + r.status);
                            const now = typeof j?.isFollowing === 'boolean' ? j.isFollowing : !was;
                            if (now) PB.followed.add(pid); else PB.followed.delete(pid);
                            paintFollowBtn(b, now);
                        } catch {
                            paintFollowBtn(b, was);
                        } finally {
                            delete b.dataset.busy;
                        }
                    });
                    card.appendChild(b);
                }
                const on = PB.followed.has(id);
                if (b.dataset.on !== (on ? '1' : '') || !b.textContent) paintFollowBtn(b, on);
            });
        }

        function applyFilter() {
            if (!PB.active) return;
            try { renderMineChips(); } catch {}
            try { ensureFollowButtons([...document.querySelectorAll('.playlists-grid > a[href*="/playlists/"]')]); } catch {}
            const cards = [...document.querySelectorAll('.playlists-grid > a[href*="/playlists/"]')];
            let hidden = 0, pending = 0, fromCache = 0, notScanned = 0;
            const removedBy = new Map(), removedOnly = new Map();
            let evaluated = 0;
            cards.forEach(card => {
                const id = cardId(card);
                if (!id) return;
                const count = cardCount(card);
                const entry = PB.tags.get(id);
                if (isFresh(entry, count)) card.setAttribute('data-pmvpb-cached', '1');
                else card.removeAttribute('data-pmvpb-cached');
                // ≈ instead of ✓: tags from a sample; clicking it fetches the whole playlist.
                if (entry?.sampled && card.hasAttribute('data-pmvpb-cached')) card.setAttribute('data-pmvpb-sampled', '1');
                else card.removeAttribute('data-pmvpb-sampled');
                const sc = card.hasAttribute('data-pmvpb-cached') ? scoreOf(id, entry) : null;
                if (sc) {
                    if (card.getAttribute('data-pmvpb-score') !== String(sc.score)) card.setAttribute('data-pmvpb-score', String(sc.score));
                    if (card.getAttribute('data-pmvpb-grade') !== sc.grade) card.setAttribute('data-pmvpb-grade', sc.grade);
                } else { card.removeAttribute('data-pmvpb-score'); card.removeAttribute('data-pmvpb-grade'); }
                // Highest score first, unscored after; CSS order only, the site's list stays as it is.
                const ord = PB.sort !== 'score' ? '' : String(sc ? 100 - sc.score : 101);
                if (card.style.order !== ord) card.style.order = ord;
                const ov = overlapOf(id);
                let ovTitle = '';
                if (ov) {
                    card.setAttribute('data-pmvpb-overlap', `${ov.n}/${ov.total}`);
                    if (ov.n === 0) card.setAttribute('data-pmvpb-overlap-zero', '1'); else card.removeAttribute('data-pmvpb-overlap-zero');
                    const perTxt = [...ov.per.entries()].sort((a, b) => b[1] - a[1]).map(([nm, c]) => `${nm} (${c})`).join(', ');
                    ovTitle = `In my playlists: ${ov.n} of ${ov.total} (${pct(ov.frac)})` + (perTxt ? ' — ' + perTxt : '');
                } else {
                    card.removeAttribute('data-pmvpb-overlap');
                    card.removeAttribute('data-pmvpb-overlap-zero');
                }
                const setTitle = (hitTxt) => {
                    const parts = [sc?.line, hitTxt, ovTitle].filter(Boolean);
                    if (parts.length) { card.title = parts.join('\n'); card.dataset.pmvpbTitled = '1'; }
                    else if (card.dataset.pmvpbTitled) { card.removeAttribute('title'); delete card.dataset.pmvpbTitled; }
                };
                if (hasTagFilter() || scoreActive()) {
                    const cached = PB.tags.get(id);
                    if (cached && cached.at < PB.sessionStart && isFresh(cached, count)) fromCache++;
                    if (PB.autoScan || PB.scanIds.has(id)) ensureLoaded(id, count);
                    else if (!isFresh(cached, count)) notScanned++;
                }
                if (!hasFilter()) {
                    delete card.dataset.pmvpbHide;
                    delete card.dataset.pmvpbSink;
                    card.removeAttribute('data-pmvpb-pending');
                    setTitle('');
                    return;
                }
                const keys = failKeys(id, count);
                evaluated++;
                keys.forEach(k => removedBy.set(k, (removedBy.get(k) || 0) + 1));
                if (keys.length === 1) removedOnly.set(keys[0], (removedOnly.get(keys[0]) || 0) + 1);
                const r = evaluate(id, count);
                if (r.state === 'pending') {
                    if (PB.pending.has(id)) pending++;
                    card.setAttribute('data-pmvpb-pending', '1');
                    delete card.dataset.pmvpbHide;
                    delete card.dataset.pmvpbSink;
                    return;
                }
                card.removeAttribute('data-pmvpb-pending');
                if (r.state === 'fail') {
                    hidden++;
                    if (PB.mode === 'hide') { card.dataset.pmvpbHide = '1'; delete card.dataset.pmvpbSink; }
                    else { card.dataset.pmvpbSink = '1'; delete card.dataset.pmvpbHide; }
                    setTitle('Matches: ' + r.hits.join(', '));
                } else {
                    delete card.dataset.pmvpbHide;
                    delete card.dataset.pmvpbSink;
                    setTitle('');
                }
            });
            PB.removedBy = removedBy; PB.removedOnly = removedOnly; PB.removedOf = evaluated || cards.length;
            paintRemovedCounts();
            updateCounter(cards.length, hidden, pending, fromCache, notScanned);
            // Hiding shortens the page: nudge infinite scroll while fewer than 24 cards show.
            if (hasFilter() && hidden && (cards.length - hidden) < 24) {
                try { window.dispatchEvent(new Event('scroll')); } catch {}
            }
        }
        function updateSummary(total, hidden) {
            if (!PB.toggle) return;
            const host = PB.toggle;
            host.textContent = '';
            const pill = (cls, text) => { const sp = el('span', 'sp ' + cls); sp.textContent = text; host.appendChild(sp); };
            const neg = PB.terms.neg, pos = PB.terms.pos;
            if (neg.length) pill('neg', `\u2298 ${neg.length} excluded`);
            if (pos.length) pill('pos', `+ ${pos.length} required`);
            const { playlists } = getLivePlaylists();
            const names = PB.overlap.map(id => playlists.get(id)?.name).filter(Boolean);
            const r = PB.mineRange;
            if (r.min != null || r.max != null) {
                pill('pl', `${r.min != null ? pct(r.min) : '0%'}\u2013${r.max != null ? pct(r.max) : '100%'} in ${names.length === 1 ? names[0] : (names.length ? names.length + ' playlists' : 'my playlists')}`);
            } else if (names.length) {
                pill('pl', names.length === 1 ? names[0] : `${names.length} playlists`);
            }
            if (hasRange(PB.countRange)) pill('pl', rangeText(PB.countRange) + ' videos');
            if (hasRange(PB.newRange)) pill('pl', rangeText(PB.newRange) + ' new');
            PB.lastTotal = total; PB.lastHidden = hidden;
            // Result next to "N playlists total" via data-* + ::after, which survives Vue re-renders.
            const rc = document.querySelector('.playlists-dashboard .results-count');
            if (rc) {
                const any = PB.terms.neg.length || PB.terms.pos.length || r.min != null || r.max != null || hasRange(PB.countRange) || hasRange(PB.newRange);
                const note = !PB.enabled ? (any ? 'filter off' : '')
                    : (hasFilter() && total ? `${hidden} of ${total} ${PB.mode === 'hide' ? 'hidden' : 'moved down'}` : '');
                if (note) { if (rc.getAttribute('data-pmvpb-note') !== note) rc.setAttribute('data-pmvpb-note', note); }
                else rc.removeAttribute('data-pmvpb-note');
            }

            const lines = [];
            if (pos.length) lines.push('Required: ' + pos.map(t => t.term + (t.min != null ? ' \u2265' + pct(t.min) : '')).join(', '));
            if (neg.length) lines.push('Excluded: ' + neg.map(t => t.term + (t.max > 0 ? ' \u2264' + pct(t.max) : '')).join(', '));
            if (names.length) lines.push('My playlists: ' + names.join(', '));
            const btn = host.closest('#' + BTN_ID);
            if (btn) PMVX.setAttr(btn, 'title', lines.length ? lines.join('\n') : 'Filter playlists by the tags of their videos');
        }
        function updateCounter(total, hidden, pending, fromCache, notScanned = 0) {
            updateSummary(total, hidden);
            if (!PB.counter) return;
            if (!hasFilter()) { PB.counter.textContent = ''; return; }
            const parts = [];
            parts.push(`${hidden} of ${total} ${PB.mode === 'hide' ? 'hidden' : 'moved down'}`);
            if (pending) parts.push(`${pending} loading…`);
            if (notScanned) parts.push(`${notScanned} not scanned — press Scan page`);
            if (fromCache) parts.push(`${fromCache} cached`);
            if (PB.failed.size) parts.push(`${PB.failed.size} failed`);
            PB.counter.textContent = parts.join(' · ');
        }

        // --- Styles ---
        function injectStyles() {
            if (document.getElementById(STYLE_ID)) return;
            const st = document.createElement('style');
            st.id = STYLE_ID;
            st.textContent = `
                .playlists-grid > a[data-pmvpb-hide="1"] { display: none !important; }
                .playlists-grid > a[data-pmvpb-sink="1"] { order: 9999 !important; opacity: 0.35; filter: grayscale(0.6); }
                .playlists-grid > a[data-pmvpb-pending="1"] { outline: 1px dashed rgba(255,255,255,0.10); outline-offset: -1px; }
                .playlists-grid > a[data-pmvpb-cached="1"], .playlists-grid > a[data-pmvpb-overlap] { position: relative; }
                .playlists-grid > a { position: relative; }
                .playlists-grid > a > .pmvpb-follow { position: absolute; top: 6px; right: 32px; z-index: 21; padding: 2px 9px; border-radius: 9999px;
                    font: inherit; font-size: 11px; font-weight: 600; line-height: 16px; cursor: pointer; white-space: nowrap;
                    background: rgba(0,0,0,0.8); color: #fff; border: 1px solid rgba(168,85,247,0.6); box-shadow: 0 1px 4px rgba(0,0,0,0.6);
                    opacity: 0; transition: opacity .15s, background .15s; }
                .playlists-grid > a:hover > .pmvpb-follow, .playlists-grid > a > .pmvpb-follow[data-on="1"] { opacity: 1; }
                .playlists-grid > a > .pmvpb-follow:hover { background: rgba(168,85,247,0.35); }
                .playlists-grid > a > .pmvpb-follow[data-on="1"] { background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)); border-color: transparent; }
                .playlists-grid > a > .pmvpb-follow[data-busy="1"] { opacity: 0.6; }
                .playlists-grid > a[data-pmvpb-cached="1"]::after {
                    content: '\\2713'; position: absolute; top: 6px; right: 6px; z-index: 20;
                    width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 50%;
                    background: rgba(0,0,0,0.85); color: rgb(233,213,255); font-size: 11px; font-weight: 700;
                    font-family:inherit;font-variant-numeric:tabular-nums; cursor: pointer;
                    box-shadow: 0 0 0 1px rgba(168,85,247,0.5); }
                .playlists-grid > a[data-pmvpb-cached="1"][data-pmvpb-sampled="1"]::after { content: '\\2248'; }
                .playlists-grid > a[data-pmvpb-cached="1"][data-pmvpb-score]::after { content: attr(data-pmvpb-score); width: auto; min-width: 18px; padding: 0 6px; border-radius: 9999px; }
                .playlists-grid > a[data-pmvpb-cached="1"][data-pmvpb-sampled="1"][data-pmvpb-score]::after { content: '\\2248 ' attr(data-pmvpb-score); }
                .playlists-grid > a[data-pmvpb-grade="hi"]::after { color: rgb(134,239,172) !important; box-shadow: 0 0 0 1px rgba(34,197,94,0.6) !important; }
                .playlists-grid > a[data-pmvpb-grade="mid"]::after { color: rgb(253,224,71) !important; box-shadow: 0 0 0 1px rgba(234,179,8,0.6) !important; }
                .playlists-grid > a[data-pmvpb-grade="lo"]::after { color: rgb(252,165,165) !important; box-shadow: 0 0 0 1px rgba(239,68,68,0.6) !important; }
                .playlists-grid > a[data-pmvpb-overlap]::before {
                    content: attr(data-pmvpb-overlap); position: absolute; top: 6px; left: 6px; z-index: 20;
                    padding: 2px 8px; border-radius: 9999px; line-height: 16px;
                    background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)); color: #fff;
                    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; pointer-events: none;
                    text-shadow: 0 1px 1px rgba(0,0,0,0.35); box-shadow: 0 1px 4px rgba(0,0,0,0.6); }
                .playlists-grid > a[data-pmvpb-overlap-zero="1"]::before { background: rgba(0,0,0,0.85); color: rgb(209,213,219);
                    box-shadow: 0 0 0 1px rgba(255,255,255,0.2), 0 1px 4px rgba(0,0,0,0.6); font-weight: 500; }

                #${BAR_ID} { margin: 0 0 16px; color: #fff; font-family: inherit; box-sizing: border-box; }
                #${BAR_ID} * { box-sizing: border-box; }
                #${BTN_ID} { display: flex; align-items: center; gap: .6rem; margin-left: auto; min-width: 0; max-width: 100%; box-sizing: border-box;
                    padding: .45rem .6rem .45rem 1.1rem; background: #1e1e1e99; border: 1px solid hsla(0,0%,100%,.1); border-radius: 10px;
                    color: #9ca3af; font-size: .9rem; font-weight: 500; font-family: inherit; cursor: pointer; user-select: none; transition: all .2s; outline: none; }
                #${BTN_ID}:hover { background: #282828cc; color: #fff; border-color: #a855f74d; }
                #${BTN_ID}:focus-visible { border-color: #a855f780; box-shadow: 0 0 0 3px #a855f71f; }
                #${BTN_ID}[data-open="1"] { background: #282828cc; color: #fff; border-color: #a855f780; box-shadow: 0 0 0 3px #a855f71f; }
                #${BTN_ID} svg { width: 16px; height: 16px; flex-shrink: 0; }
                #${BTN_ID} .ico { display: inline-flex; color: rgb(192,132,252); }
                #${BTN_ID} .lbl { white-space: nowrap; }
                #${BTN_ID} .chev { color: rgb(156,163,175); transition: transform .2s; }
                #${BTN_ID}[data-open="1"] .chev { transform: rotate(180deg); }
                #${BTN_ID} .sum { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
                #${BTN_ID} .sum:empty { display: none; }
                #${BTN_ID} .sp { flex-shrink: 0; padding: 2px 8px; border-radius: 9999px; font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap; }
                #${BTN_ID} .sp.neg { background: rgba(239,68,68,0.15); color: rgb(252,165,165); }
                #${BTN_ID} .sp.pos { background: rgba(249,115,22,0.15); color: rgb(253,186,116); }
                #${BTN_ID} .sp.pl { background: rgba(168,85,247,0.15); color: rgb(192,132,252); flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
                #${BTN_ID}[data-enabled="0"] .sp { opacity: .45; }
                #${BTN_ID} .pwr { display: inline-flex; align-items: center; padding: 4px 2px 4px .6rem; border-left: 1px solid hsla(0,0%,100%,.1); outline: none; }
                #${BTN_ID} .pwr:focus-visible .sw { box-shadow: 0 0 0 3px #a855f740; }
                #${BTN_ID} .sw { position: relative; width: 34px; height: 20px; border-radius: 9999px; background: #3A3A3A; transition: background .15s; }
                #${BTN_ID} .pwr:hover .sw { background: #474747; }
                #${BTN_ID} .knob { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
                #${BTN_ID} .pwr[aria-checked="true"] .sw { background: linear-gradient(135deg, #a855f7, #8b5cf6); }
                #${BTN_ID} .pwr[aria-checked="true"] .knob { transform: translateX(14px); }
                .playlists-dashboard .results-count[data-pmvpb-note]::after { content: ' \\00B7  ' attr(data-pmvpb-note); color: rgb(192,132,252); }
                #${BAR_ID}[data-enabled="0"] .pmvpb-tagchips { opacity: .45; }
                #${BAR_ID} { position: relative; margin: -1.6rem 0 1.25rem; }
                #${BAR_ID}[data-open="0"] { display: none; }
                #${BAR_ID} .pmvpb-caret { position: absolute; top: -6px; left: 50%; width: 12px; height: 12px; background: #111; border-left: 1px solid #a855f74d; border-top: 1px solid #a855f74d; transform: rotate(45deg); }
                #${BAR_ID} .pmvpb-panel { padding: 16px 20px; background: #111; border: 1px solid #a855f74d; border-radius: 12px; }
                #${BAR_ID} .pmvpb-grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 4fr) minmax(0, 3fr); gap: 20px; }
                @media (max-width: 1100px) { #${BAR_ID} .pmvpb-grid { grid-template-columns: 1fr 1fr; } }
                @media (max-width: 720px)  { #${BAR_ID} .pmvpb-grid { grid-template-columns: 1fr; } }
                #${BAR_ID} h3 { margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid #1F1F1F; color: #fff; font-size: 14px; font-weight: 600;
                    display: flex; align-items: center; gap: 8px; }
                #${BAR_ID} h3 svg { width: 14px; height: 14px; color: rgb(192,132,252); flex-shrink: 0; }
                #${BAR_ID} .pmvpb-label { display: block; color: rgb(156,163,175); font-size: 12px; font-weight: 500; margin-bottom: 6px; }
                #${BAR_ID} .pmvpb-inrow { display: flex; gap: 8px; align-items: stretch; }
                #${BAR_ID} input[type=text] { flex: 1; min-width: 0; width: 100%; padding: 9px 12px; background: #0A0A0A; border: 2px solid #2A2A2A; border-radius: 8px;
                    color: #fff; font-size: 13px; font-family:inherit;font-variant-numeric:tabular-nums; outline: none; caret-color: rgb(168,85,247); }
                #${BAR_ID} input[type=text]:focus, #${BAR_ID} input[type=text]:focus-visible { border-color: rgba(168,85,247,0.6); outline: none !important; box-shadow: none !important; }
                #${BAR_ID} input[type=text]::placeholder { color: rgb(107,114,128); }
                #${BAR_ID} .pmvpb-hint { color: rgba(255,255,255,0.35); font-size: 11px; margin-top: 6px; line-height: 1.5; font-family:inherit;font-variant-numeric:tabular-nums; }
                #${BAR_ID} .pmvpb-hint b { color: rgba(255,255,255,0.6); font-weight: 600; }
                #${BAR_ID} .pmvpb-tagrow { margin-bottom: 10px; }
                #${BAR_ID} .pmvpb-tagrow input[type=text] { padding: 7px 12px; font-family: inherit; font-size: 13px; }
                #${BAR_ID} .pmvpb-tagchips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; min-height: 0; }
                #${BAR_ID} .pmvpb-tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; border: none; cursor: pointer;
                    font-size: 12px; line-height: 16px; font-family: inherit; transition: background .15s; }
                #${BAR_ID} .pmvpb-tag svg { width: 10px; height: 10px; }
                #${BAR_ID} .pmvpb-tag .ico svg { width: 11px; height: 11px; }
                #${BAR_ID} .pmvpb-tag .cnt { font-size: 10px; font-weight: 600; opacity: 0.85; font-variant-numeric: tabular-nums; }
                #${BAR_ID} .pmvpb-tag .cnt[data-zero="1"] { opacity: 0.4; }
                #${BAR_ID} .pmvpb-rangecnt .cnt { font-size: 12px; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; margin-left: 8px; }
                #${BAR_ID} .pmvpb-rangecnt .cnt[data-zero="1"] { opacity: 0.5; }
                #${BAR_ID} .pmvpb-tag .x { display: inline-flex; opacity: 0.6; margin-left: 2px; padding: 2px; border-radius: 3px; }
                #${BAR_ID} .pmvpb-tag .x:hover { opacity: 1; background: rgba(255,255,255,0.12); }
                #${BAR_ID} .pmvpb-tag .thr { font-size: 10px; font-weight: 700; padding: 0 4px; border-radius: 3px; background: rgba(0,0,0,0.35); font-family:inherit;font-variant-numeric:tabular-nums; }
                #${BAR_ID} .pmvpb-tag.pos { background: rgba(249,115,22,0.2); color: rgb(253,186,116); }
                #${BAR_ID} .pmvpb-tag.pos:hover { background: rgba(249,115,22,0.3); }
                #${BAR_ID} .pmvpb-tag.neg { background: rgba(239,68,68,0.2); color: rgb(252,165,165); }
                #${BAR_ID} .pmvpb-tag.neg:hover { background: rgba(239,68,68,0.3); }
                #${BAR_ID} .pmvpb-tag.neg .txt { text-decoration: line-through; }
                #${BAR_ID} .pmvpb-tag.editing { box-shadow: 0 0 0 1px currentColor; }
                #${BAR_ID} .pmvpb-edit { margin: 2px 0 10px; padding: 10px 12px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); }
                #${BAR_ID} .pmvpb-edit.neg { border-color: rgba(239,68,68,0.3); }
                #${BAR_ID} .pmvpb-edit.pos { border-color: rgba(249,115,22,0.3); }
                #${BAR_ID} .pmvpb-edit-head { font-size: 12px; color: rgba(255,255,255,0.75); margin-bottom: 6px; }
                #${BAR_ID} .pmvpb-edit-head b { color: #fff; }
                #${BAR_ID} .pmvpb-edit-head .val { color: rgb(168,85,247); font-weight: 700; font-family:inherit;font-variant-numeric:tabular-nums; }
                #${BAR_ID} .pmvpb-edit input[type=range] { width: 100%; accent-color: rgb(168,85,247); margin: 4px 0; }
                #${BAR_ID} .pmvpb-edit .pmvpb-chips { margin-top: 4px; }
                #${BAR_ID} .pmvpb-edit .pmvpb-hint { margin-top: 6px; }
                #${BAR_ID} .pmvpb-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
                #${BAR_ID} .pmvpb-chip { padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; line-height: 1.2;
                    background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.1); transition: background .15s, color .15s; white-space: nowrap; }
                #${BAR_ID} .pmvpb-chip:hover { background: rgba(255,255,255,0.09); color: #fff; }
                #${BAR_ID} .pmvpb-chip.active { background: rgba(168,85,247,0.2); color: rgb(168,85,247); border-color: rgba(168,85,247,0.5); font-weight: 600; }
                #${BAR_ID} .pmvpb-chip .n { opacity: 0.5; margin-left: 6px; font-weight: 400; font-family:inherit;font-variant-numeric:tabular-nums; }
                #${BAR_ID} .pmvpb-primary { padding: 0 16px; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
                    background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)); color: #fff; border: none; }
                #${BAR_ID} .pmvpb-primary:hover { filter: brightness(1.12); }
                #${BAR_ID} .pmvpb-counter { color: rgba(255,255,255,0.4); font-size: 12px; margin-top: 10px; min-height: 16px; font-family:inherit;font-variant-numeric:tabular-nums; }
                #${BAR_ID} .pmvpb-empty { color: rgba(255,255,255,0.4); font-size: 12px; line-height: 1.5; }

                #${BAR_ID} .pmvpb-pill { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 9999px; background: rgba(168,85,247,0.1);
                    color: rgb(168,85,247); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
                #${BAR_ID} .pmvpb-pill .sep { color: rgba(168,85,247,0.5); }
                #${BAR_ID} .pmvpb-pillrow { display: flex; justify-content: center; margin-bottom: 2px; }
                #${BAR_ID} .pmvpb-slider { position: relative; height: 40px; }
                #${BAR_ID} .pmvpb-track { position: absolute; top: 17px; left: 0; right: 0; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.1); }
                #${BAR_ID} .pmvpb-range { position: absolute; top: 17px; height: 6px; border-radius: 3px; background: linear-gradient(90deg, rgb(168,85,247), rgb(192,132,252)); }
                #${BAR_ID} .pmvpb-slider input[type=range] { position: absolute; top: 17px; left: 0; width: 100%; height: 6px; margin: 0; padding: 0;
                    -webkit-appearance: none; appearance: none; background: transparent; pointer-events: none; outline: none; }
                #${BAR_ID} .pmvpb-slider input[type=range]::-webkit-slider-runnable-track { background: transparent; height: 6px; }
                #${BAR_ID} .pmvpb-slider input[type=range]::-moz-range-track { background: transparent; height: 6px; border: none; }
                #${BAR_ID} .pmvpb-slider input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; pointer-events: auto; width: 18px; height: 18px; margin-top: -6px;
                    border-radius: 50%; background: #fff; border: 3px solid rgb(168,85,247); box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: pointer; }
                #${BAR_ID} .pmvpb-slider input[type=range]::-moz-range-thumb { pointer-events: auto; width: 12px; height: 12px;
                    border-radius: 50%; background: #fff; border: 3px solid rgb(168,85,247); box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: pointer; }
                #${BAR_ID} .pmvpb-sliderlabels { display: flex; justify-content: space-between; color: rgba(255,255,255,0.4); font-size: 12px; margin-top: -4px; }
            `;
            (document.head || document.documentElement).appendChild(st);
        }

        // --- Panel ---
        const ICONS = {
            filter: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H3m9 14H3M14 3v4m2 10v4m5-9h-9m9 7h-5m5-14h-7m-6 5v4m0-2H3"/></svg>',
            list:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13"/></svg>',
            range:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 6H3m18 6H3m18 6H3M9 3v6m6 3v6"/></svg>',
        };
        const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
        const chip = (text, title, onClick) => { const b = el('button', 'pmvpb-chip', text); b.type = 'button'; if (title) b.title = title; b.onclick = onClick; return b; };
        let renderMineChips = () => {};

        function buildBar() {
            const header = document.querySelector('.playlists-dashboard .dashboard-header');
            if (!header || !header.parentElement) return false;
            ensureFilterButton(header);
            if (document.getElementById(BAR_ID)) return true;

            const bar = el('div');
            bar.id = BAR_ID;
            bar.dataset.open = PB.open ? '1' : '0';
            bar.dataset.enabled = PB.enabled ? '1' : '0';
            const panel = el('div', 'pmvpb-panel');
            bar.appendChild(panel);
            const caret = el('span', 'pmvpb-caret');
            bar.insertBefore(caret, panel);
            const grid = el('div', 'pmvpb-grid');
            panel.appendChild(grid);

            const s1 = el('section');
            const h1 = el('h3'); h1.innerHTML = ICONS.filter + ' Playlist contents';
            s1.appendChild(h1);

            const dl = el('datalist'); dl.id = 'pmvpb-tag-suggest';
            let dlSig = -1;
            const refreshSuggest = () => {
                if (PB.tags.size === dlSig) return;
                dlSig = PB.tags.size;
                const freq = new Map();
                PB.tags.forEach(e => (e.tags || []).forEach(t => freq.set(t, (freq.get(t) || 0) + 1)));
                dl.textContent = '';
                [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400).forEach(([t]) => {
                    const o = el('option'); o.value = t; dl.appendChild(o);
                });
            };
            s1.appendChild(dl);

            let editing = null; // { kind, term }
            const chipRows = {};
            const editorHost = el('div', 'pmvpb-editor');

            const mkTagRow = (kind, labelTxt, placeholder) => {
                const wrap = el('div', 'pmvpb-tagrow');
                wrap.appendChild(el('label', 'pmvpb-label', labelTxt));
                const inp = el('input');
                inp.type = 'text'; inp.spellcheck = false; inp.autocomplete = 'off';
                inp.placeholder = placeholder; inp.setAttribute('list', dl.id);
                inp.addEventListener('focus', refreshSuggest);
                const add = () => {
                    let term = PMVX.plainQuotes(inp.value).trim().replace(/^#/, '').toLowerCase();
                    // "quoted": whole word only.
                    const q = term.match(/^["'](.+)["']$/);
                    if (q) term = '=' + q[1].trim();
                    if (!term || term === '=') return;
                    const list = PB.terms[kind];
                    if (!list.some(t => t.term === term)) list.push(kind === 'neg' ? { term, max: 0 } : { term, min: null });
                    // A tag can't be both required and excluded.
                    const other = kind === 'neg' ? 'pos' : 'neg';
                    PB.terms[other] = PB.terms[other].filter(t => t.term !== term);
                    inp.value = '';
                    applyTerms();
                };
                inp.addEventListener('keydown', e => {
                    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(); }
                    else if (e.key === 'Escape') { inp.value = ''; inp.blur(); }
                    else if (e.key === 'Backspace' && !inp.value && PB.terms[kind].length) { PB.terms[kind].pop(); applyTerms(); }
                }, true);
                inp.addEventListener('change', () => { if (inp.value.trim()) add(); }); // datalist pick
                wrap.appendChild(inp);
                const chips = el('div', 'pmvpb-tagchips');
                wrap.appendChild(chips);
                chipRows[kind] = chips;
                return { wrap, inp };
            };
            const rowPos = mkTagRow('pos', 'Must contain', 'Add tag or performer…');
            const rowNeg = mkTagRow('neg', 'Exclude', 'Exclude tag or performer…');

            const thrText = (kind, t) => kind === 'neg'
                ? (t.max > 0 ? `≤${pct(t.max)}` : '')
                : (t.min != null ? `≥${pct(t.min)}` : '');
            const renderChips = () => {
                ['pos', 'neg'].forEach(kind => {
                    const host = chipRows[kind];
                    host.textContent = '';
                    PB.terms[kind].forEach(t => {
                        const c = el('button', 'pmvpb-tag ' + kind);
                        c.type = 'button';
                        c.dataset.pmvpbKey = kind + ':' + t.term;
                        c.title = kind === 'neg'
                            ? `Hides playlists where ${t.max > 0 ? 'more than ' + pct(t.max) : 'at least one'} of the videos have "${t.term}" — click to set the allowed share`
                            : `Requires ${t.min != null ? 'at least ' + pct(t.min) : 'at least one'} of the videos to have "${t.term}" — click to set the required share`;
                        if (kind === 'neg') {
                            const ic = el('span', 'ico');
                            ic.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
                            c.appendChild(ic);
                        }
                        c.appendChild(el('span', 'txt', '#' + (PMVX.isWordTerm(t.term) ? `"${PMVX.termLabel(t.term)}"` : t.term)));
                        const th = thrText(kind, t);
                        if (th) c.appendChild(el('span', 'thr', th));
                        const x = el('span', 'x');
                        x.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
                        x.title = 'Remove';
                        x.onclick = (e) => {
                            e.stopPropagation();
                            PB.terms[kind] = PB.terms[kind].filter(o => o !== t);
                            if (editing && editing.term === t.term && editing.kind === kind) editing = null;
                            applyTerms();
                        };
                        c.appendChild(x);
                        c.classList.toggle('editing', !!editing && editing.kind === kind && editing.term === t.term);
                        c.onclick = () => {
                            editing = (editing && editing.kind === kind && editing.term === t.term) ? null : { kind, term: t.term };
                            renderChips(); renderEditor();
                        };
                        host.appendChild(c);
                    });
                });
                paintRemovedCounts();
            };
            const renderEditor = () => {
                editorHost.textContent = '';
                if (!editing) return;
                const t = PB.terms[editing.kind].find(o => o.term === editing.term);
                if (!t) { editing = null; return; }
                const neg = editing.kind === 'neg';
                const cur = neg ? Math.round((t.max || 0) * 100) : Math.round((t.min ?? 0) * 100);
                const box = el('div', 'pmvpb-edit ' + editing.kind);
                const head = el('div', 'pmvpb-edit-head');
                head.innerHTML = `<b></b> — ${neg ? 'hide if more than' : 'require at least'} <span class="val">${cur}%</span> of the videos to have this tag`;
                head.querySelector('b').textContent = '#' + (PMVX.isWordTerm(t.term) ? `"${PMVX.termLabel(t.term)}"` : t.term);
                const r = el('input'); r.type = 'range'; r.min = '0'; r.max = '100'; r.step = '1'; r.value = String(cur);
                const val = head.querySelector('.val');
                const presets = el('div', 'pmvpb-chips');
                const setTo = (v) => {
                    if (neg) t.max = v / 100; else t.min = v > 0 ? v / 100 : null;
                    applyTerms();
                };
                r.addEventListener('input', () => { val.textContent = r.value + '%'; });
                r.addEventListener('change', () => setTo(parseInt(r.value, 10)));
                (neg ? [[0, 'Any video', 'Even one video with this tag'], [10, '≤10%'], [25, '≤25%'], [50, '≤50%']]
                     : [[0, 'At least one', 'At least one video with this tag'], [25, '≥25%'], [50, '≥50%'], [90, '≥90%']]).forEach(([v, txt, title]) => {
                    const c = chip(txt, title || '', () => setTo(v));
                    c.classList.toggle('active', v === cur);
                    presets.appendChild(c);
                });
                const hint = el('div', 'pmvpb-hint', neg
                    ? 'Without a share, a single video with this tag hides the playlist.'
                    : 'Without a share, a single video with this tag is enough.');
                const isWord = PMVX.isWordTerm(t.term);
                const wordChip = chip('Whole word', isWord ? 'Only tags containing this as a separate word — click to match anywhere' : 'Match only as a separate word (ch, not challenge)', () => {
                    const next = isWord ? t.term.slice(1) : '=' + t.term;
                    if (PB.terms[editing.kind].some(o => o !== t && o.term === next)) return;
                    t.term = next;
                    editing = { kind: editing.kind, term: next };
                    fracMemo.clear();
                    applyTerms();
                });
                wordChip.classList.toggle('active', isWord);
                presets.appendChild(wordChip);
                box.append(head, r, presets, hint);
                editorHost.appendChild(box);
            };
            PB.renderChips = renderChips;
            PB.renderEditor = renderEditor;

            s1.append(rowPos.wrap, rowNeg.wrap, editorHost);
            const chips1 = el('div', 'pmvpb-chips');
            const hideChip = chip('Hide', 'Filtered playlists are hidden', () => { PB.mode = 'hide'; renderModeChips(); saveSettings(); applyFilter(); });
            const sinkChip = chip('Move down', 'Filtered playlists are dimmed and moved to the bottom', () => { PB.mode = 'sink'; renderModeChips(); saveSettings(); applyFilter(); });
            const descChip = chip('Description', '', () => { PB.desc = !PB.desc; renderModeChips(); saveSettings(); applyFilter(); });
            const scanChip = chip('⟳ Scan page', 'Fetch the tags of the playlists on this page. Playlists over 300 videos are sampled (first, last and a few pages in between, about 300 videos) to keep it quick. Cached data is reused until a playlist\u2019s video count changes by more than 10%; click ✓ on a card to fetch that playlist in full.', scanVisible);
            const autoChip = chip('Auto-scan', '', () => { PB.autoScan = !PB.autoScan; renderModeChips(); saveSettings(); applyFilter(); });
            const sortChip = chip('Sort by score', 'Highest Score-pill first; needs Headerfilter terms and scanned playlists', () => { PB.sort = PB.sort === 'score' ? 'site' : 'score'; renderModeChips(); saveSettings(); applyFilter(); });
            const renderModeChips = () => {
                hideChip.classList.toggle('active', PB.mode === 'hide');
                sinkChip.classList.toggle('active', PB.mode === 'sink');
                descChip.classList.toggle('active', !!PB.desc);
                autoChip.classList.toggle('active', !!PB.autoScan);
                sortChip.classList.toggle('active', PB.sort === 'score');
                autoChip.title = PB.autoScan
                    ? 'Tags are fetched automatically for every playlist shown (one request each) — click to scan only on request'
                    : 'Tags are fetched only when you press Scan page — click to fetch them automatically';
                descChip.title = PB.desc
                    ? 'Terms also match the playlist description — click to match video tags only'
                    : 'Video tags and performers only — click to also match the playlist description';
            };
            renderModeChips();
            chips1.append(hideChip, sinkChip, sortChip, descChip, scanChip, autoChip);
            s1.appendChild(chips1);
            const counter = el('div', 'pmvpb-counter');
            s1.appendChild(counter);
            renderChips();
            const inp = rowPos.inp;

            const s2 = el('section');
            const h2 = el('h3'); h2.innerHTML = ICONS.list + ' My playlists';
            s2.appendChild(h2);
            s2.appendChild(el('label', 'pmvpb-label', 'Counted for the overlap badge in the top-left corner of each card'));
            const mineChips = el('div', 'pmvpb-chips');
            mineChips.style.marginTop = '0';
            s2.appendChild(mineChips);
            let mineSig = null;
            renderMineChips = () => {
                loadPlaylistCache();
                const { playlists } = getLivePlaylists();
                const list = [...playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
                const sig = list.map(p => p.id + ':' + p.ids.size).join('|') + '#' + PB.overlap.join(',');
                if (sig === mineSig) return;
                mineSig = sig;
                mineChips.textContent = '';
                if (!list.length) {
                    mineChips.appendChild(el('div', 'pmvpb-empty', 'No playlists yet — log in to load yours.'));
                    return;
                }
                list.forEach(p => {
                    const c = chip(p.name, `${p.ids.size} videos`, () => {
                        PB.overlap = PB.overlap.includes(p.id) ? PB.overlap.filter(x => x !== p.id) : [...PB.overlap, p.id];
                        saveSettings(); renderMineChips(); applyFilter();
                    });
                    c.classList.toggle('active', PB.overlap.includes(p.id));
                    c.appendChild(el('span', 'n', String(p.ids.size)));
                    mineChips.appendChild(c);
                });
            };
            renderMineChips();

            // Range section: dual slider over `steps` (first = no minimum, last = Any), pill and presets.
            const rangeSection = ({ title, label, key, range, steps, fmt, presets }) => {
                const sec = el('section');
                const h = el('h3'); h.innerHTML = ICONS.range + ' ' + title;
                sec.append(h, el('label', 'pmvpb-label', label));
                const pillRow = el('div', 'pmvpb-pillrow'), pill = el('div', 'pmvpb-pill');
                const pMin = el('span'), pMax = el('span');
                pill.append(pMin, el('span', 'sep', '-'), pMax);
                const cnt = el('span', 'pmvpb-rangecnt'); cnt.dataset.pmvpbKey = key;
                pillRow.append(pill, cnt);
                const last = steps.length - 1;
                const mk = () => { const r = el('input'); r.type = 'range'; r.min = '0'; r.max = String(last); r.step = '1'; return r; };
                const rMin = mk(), rMax = mk(), fill = el('div', 'pmvpb-range');
                const slider = el('div', 'pmvpb-slider'); slider.append(el('div', 'pmvpb-track'), fill, rMin, rMax);
                const labels = el('div', 'pmvpb-sliderlabels'); labels.append(el('span', null, fmt(steps[0])), el('span', null, fmt(steps[last])));
                const idx = v => { const i = steps.findIndex(x => x >= v - 1e-9); return i < 0 ? last : i; };
                const paint = (a, b) => {
                    pMin.textContent = fmt(steps[a]); pMax.textContent = b >= last ? 'Any' : fmt(steps[b]);
                    fill.style.left = (100 * a / last) + '%'; fill.style.width = (100 * (b - a) / last) + '%';
                };
                const presetRow = el('div', 'pmvpb-chips');
                const set = r => { PB[range] = r; saveSettings(); render(); applyFilter(); };
                const btns = presets.map(p => presetRow.appendChild(chip(p.t, p.title, () => set({ min: p.min ?? null, max: p.max ?? null }))));
                const render = () => {
                    const r = PB[range];
                    const a = r.min != null ? idx(r.min) : 0, b = r.max != null ? idx(r.max) : last;
                    rMin.value = String(a); rMax.value = String(b); paint(a, b);
                    btns.forEach((c, i) => c.classList.toggle('active', (presets[i].min ?? null) === r.min && (presets[i].max ?? null) === r.max));
                };
                const drag = which => () => {
                    let a = +rMin.value, b = +rMax.value;
                    if (a > b) { if (which === 'min') rMax.value = String(b = a); else rMin.value = String(a = b); }
                    paint(a, b);
                };
                const release = () => set({ min: +rMin.value > 0 ? steps[+rMin.value] : null, max: +rMax.value < last ? steps[+rMax.value] : null });
                rMin.addEventListener('input', drag('min')); rMax.addEventListener('input', drag('max'));
                rMin.addEventListener('change', release); rMax.addEventListener('change', release);
                render();
                sec.append(pillRow, slider, labels, presetRow);
                return sec;
            };
            const COUNT_STEPS = [0, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000];
            const countFmt = v => v >= 5000 ? '5000+' : String(v);
            const s3 = rangeSection({
                title: 'Overlap range', label: 'Share of videos that are also in the selected playlists', key: 'mine', range: 'mineRange',
                steps: Array.from({ length: 101 }, (_, i) => i / 100), fmt: v => Math.round(v * 100) + '%',
                presets: [
                    { t: 'Any', title: 'No range filter' },
                    { t: '0%', max: 0, title: 'Only playlists with no overlap at all' },
                    { t: '<10%', max: 0.1, title: 'At most 10% overlap' },
                    { t: '50%+', min: 0.5, title: 'At least half overlaps' },
                    { t: '90%+', min: 0.9, title: 'Almost everything overlaps' },
                ],
            });
            const s4 = rangeSection({
                title: 'Videos', label: 'Number of videos in the playlist', key: 'count', range: 'countRange', steps: COUNT_STEPS, fmt: countFmt,
                presets: [
                    { t: 'Any', title: 'No limit' },
                    { t: '\u226450', max: 50, title: 'Small playlists' },
                    { t: '50\u2013300', min: 50, max: 300, title: 'Medium playlists' },
                    { t: '300+', min: 300, title: 'Large playlists' },
                    { t: '1000+', min: 1000, title: 'Very large playlists' },
                ],
            });
            const s5 = rangeSection({
                title: 'New videos', label: 'Videos not in my playlists (the selected ones, else all of them)', key: 'new', range: 'newRange', steps: COUNT_STEPS, fmt: countFmt,
                presets: [
                    { t: 'Any', title: 'No limit' },
                    { t: '0', max: 0, title: 'Nothing new: every video is already in my playlists' },
                    { t: '\u226410', max: 10, title: 'Almost nothing new' },
                    { t: '50+', min: 50, title: 'At least 50 new videos' },
                    { t: '200+', min: 200, title: 'At least 200 new videos' },
                ],
            });

            grid.append(s1, s2, s3, s4, s5);
            header.insertAdjacentElement('afterend', bar);
            PB.bar = bar; PB.input = inp; PB.counter = counter;
            placeCaret();
            return true;
        }

        // Filters control: trailing child of the site's tab row after Vue's v-for fragment; the page observer re-inserts it.
        function setOpen(v) {
            PB.open = v;
            const bar = document.getElementById(BAR_ID);
            if (bar) bar.dataset.open = v ? '1' : '0';
            const btn = document.getElementById(BTN_ID);
            if (btn) { btn.dataset.open = v ? '1' : '0'; btn.setAttribute('aria-expanded', v ? 'true' : 'false'); }
            saveSettings();
            if (v) { placeCaret(); setTimeout(() => PB.input?.focus(), 0); }
        }
        function renderPower() {
            const btn = document.getElementById(BTN_ID);
            const bar = document.getElementById(BAR_ID);
            if (bar) bar.dataset.enabled = PB.enabled ? '1' : '0';
            if (!btn) return;
            btn.dataset.enabled = PB.enabled ? '1' : '0';
            const sw = btn.querySelector('.pwr');
            sw.setAttribute('aria-checked', PB.enabled ? 'true' : 'false');
            sw.title = PB.enabled
                ? 'Filter on \u2014 click to turn off (settings are kept)'
                : 'Filter off \u2014 click to turn on';
        }
        function ensureFilterButton(header) {
            const row = header.querySelector('.filter-pills');
            let btn = document.getElementById(BTN_ID);
            if (btn && (row ? btn.parentElement === row : btn.isConnected)) return btn;
            if (!btn) {
                btn = el('div');
                btn.id = BTN_ID;
                btn.className = 'pmvpb-toggle';
                btn.setAttribute('role', 'button');
                btn.tabIndex = 0;
                btn.innerHTML = `<span class="ico">${ICONS.filter}</span><span class="lbl">Filters</span><span class="sum"></span>` +
                    '<span class="pwr" role="switch" tabindex="0"><span class="sw"><span class="knob"></span></span></span>' +
                    '<svg class="chev" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
                const flip = () => {
                    PB.enabled = !PB.enabled;
                    saveSettings();
                    renderPower();
                    applyFilter();
                };
                const pwr = btn.querySelector('.pwr');
                pwr.addEventListener('click', e => { e.stopPropagation(); flip(); });
                pwr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); flip(); } });
                btn.addEventListener('click', () => setOpen(!PB.open));
                btn.addEventListener('keydown', e => { if (e.target === btn && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(!PB.open); } });
            }
            btn.dataset.open = PB.open ? '1' : '0';
            btn.setAttribute('aria-expanded', PB.open ? 'true' : 'false');
            if (row) row.appendChild(btn);
            else header.insertAdjacentElement('afterend', btn); // no tab row: above the panel
            PB.toggle = btn.querySelector('.sum');
            renderPower();
            try { updateSummary(PB.lastTotal || 0, PB.lastHidden || 0); } catch {}
            return btn;
        }
        function placeCaret() {
            const bar = document.getElementById(BAR_ID), btn = document.getElementById(BTN_ID);
            const caret = bar?.querySelector('.pmvpb-caret');
            if (!caret || !btn || bar.dataset.open !== '1') return;
            requestAnimationFrame(() => {
                const b = btn.getBoundingClientRect(), r = bar.getBoundingClientRect();
                if (!b.width || !r.width) return;
                caret.style.left = Math.round(Math.max(16, Math.min(r.width - 32, b.left + b.width / 2 - r.left - 8))) + 'px';
            });
        }
        function applyTerms() {
            PB.tokens = { neg: PB.terms.neg, pos: PB.terms.pos, mine: null };
            saveSettings();
            PB.renderChips?.(); PB.renderEditor?.();
            applyFilter();
        }
        // Debug/test hook: set chips from the legacy typed syntax.
        function commit(value) {
            const parsed = parse(String(value || ''));
            PB.terms = { neg: parsed.neg, pos: parsed.pos };
            if (parsed.mine) PB.mineRange = parsed.mine;
            applyTerms();
        }

        // (playlistBrowseFilter continues in 07-video-checker.js, which also closes it.)
        // (Still inside playlistBrowseFilter from 06-playlists-overview.js: same scope, PB etc.)

        // --- Video pages: "Playlists with this video" ---
        // Scan button: loads the video ids of the playlists shown (one small request each) for the overlap badge
        // (ticked own playlists, else all). With a tag filter also tags: ✓/≈ pass, ⊘ fail (dimmed); never hidden here.
        const VSCAN_ID = 'pmvpb-vscan';
        const isVideoPage = () => /^\/video\/[^/]+/.test(location.pathname);
        PB.vactive = false;
        PB.vscan = null; // ids being scanned from the button, or null
        PB.idsPending = new Set();
        // Video ids + count of one playlist: the single-playlist endpoint lists every id even with limit=1.
        async function loadIds(id) {
            if (PB.idsPending.has(id)) return;
            PB.idsPending.add(id);
            try {
                const root = await getPlaylistJson(`/api/playlists/${id}?page=1&limit=1`);
                if (root && Array.isArray(root.videos)) {
                    PB.listInfo.set(id, {
                        count: root.validVideoCount ?? root.videos.length,
                        name: root.name || '',
                        desc: String(root.description || ''),
                        videos: root.videos.map(v => typeof v === 'string' ? v : (v?._id || v?.id)).filter(Boolean),
                    });
                }
            } catch { PB.failed.add(id); }
            finally { PB.idsPending.delete(id); scheduleApply(); }
        }
        async function loadIdsAll(ids) {
            const list = [...ids];
            const worker = async () => { while (list.length) await loadIds(list.shift()); };
            await Promise.all(Array.from({ length: Math.min(list.length, Math.max(1, PMVX.perf().lookups)) }, worker));
        }
        const hasIds = id => !!PB.listInfo.get(id)?.videos;
        const isMine = id => getLivePlaylists().playlists.has(id);
        function overlapLabel() {
            const { playlists } = getLivePlaylists();
            const names = PB.overlap.map(id => playlists.get(id)?.name).filter(Boolean);
            if (!names.length) return 'my playlists';
            return names.length === 1 ? names[0] : `${names.length} playlists`;
        }
        function findVideoSection() {
            const h = [...document.querySelectorAll('h3')].find(x => /^\s*Playlists with this video\b/i.test(x.textContent || ''));
            if (!h) return null;
            const header = h.parentElement;
            const grid = header?.nextElementSibling;
            if (!header || !grid || !grid.querySelector(':scope > a[href*="/playlists/"]')) return null;
            return { header, grid };
        }
        function vCardCount(card) {
            const info = PB.listInfo.get(cardId(card));
            if (info && Number.isFinite(info.count)) return info.count;
            const b = card.querySelector('[class~="top-1.5"][class~="right-1.5"]');
            const n = parseInt((b?.textContent || '').replace(/[^\d]/g, ''), 10);
            return Number.isFinite(n) ? n : null;
        }
        function topTags(entry, n = 6) {
            const cnt = new Map();
            entry.vids.forEach(idx => idx.forEach(i => cnt.set(i, (cnt.get(i) || 0) + 1)));
            const total = entry.vids.length || 1;
            return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
                .map(([i, c]) => `${entry.tags[i]} ${pct(c / total)}`).join(', ');
        }
        function vScan() {
            const sec = findVideoSection();
            if (!sec) return;
            const ids = new Set();
            const cards = [...sec.grid.querySelectorAll(':scope > a[href*="/playlists/"]')];
            const withTags = hasTagFilter() || scoreActive();
            // All loaded and fresh: the button reads Rescan and refetches everything.
            const force = !vTodo(cards);
            const idJobs = [];
            cards.forEach(card => {
                const id = cardId(card);
                if (!id) return;
                ids.add(id);
                PB.failed.delete(id);
                if (force || !hasIds(id)) idJobs.push(id);
                if (withTags) {
                    PB.scanIds.add(id);
                    ensureLoaded(id, vCardCount(card), force);
                }
            });
            idJobs.forEach(id => PB.idsPending.add(id)); // counted as busy right away
            PB.vscan = ids;
            applyVideoSection();
            idJobs.forEach(id => PB.idsPending.delete(id));
            loadIdsAll(idJobs);
        }
        const setText = PMVX.setText, setAttr = PMVX.setAttr;
        function ensureVideoButton(header) {
            let w = document.getElementById(VSCAN_ID);
            if (w && w.parentElement === header) return w;
            if (!w) {
                w = el('div');
                w.id = VSCAN_ID;
                const note = el('span', 'note');
                const b = el('button', 'btn', '⟳ Scan');
                b.type = 'button';
                b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); vScan(); });
                w.append(note, b);
            }
            header.appendChild(w);
            return w;
        }
        function vTodo(cards) {
            const withTags = hasTagFilter() || scoreActive();
            return cards.filter(c => {
                const id = cardId(c);
                if (!id) return false;
                return !hasIds(id) || (withTags && !isFresh(PB.tags.get(id), vCardCount(c)));
            }).length;
        }
        function applyVideoSection() {
            if (!PB.vactive) return;
            const sec = findVideoSection();
            if (!sec) return;
            setAttr(sec.grid, 'data-pmvpb-vgrid', '1');
            const w = ensureVideoButton(sec.header);
            const btn = w.querySelector('.btn'), note = w.querySelector('.note');
            const cards = [...sec.grid.querySelectorAll(':scope > a[href*="/playlists/"]')];
            const filterOn = hasFilter();
            let failN = 0, known = 0, busy = 0, failedN = 0, ovKnown = 0;
            cards.forEach(card => {
                const id = cardId(card);
                if (!id) return;
                const count = vCardCount(card);
                const entry = PB.tags.get(id);
                const loading = PB.pending.has(id) || PB.idsPending.has(id);
                if (loading) busy++;
                if (PB.failed.has(id) && PB.vscan?.has(id)) failedN++;
                const lines = [];
                // Overlap pill top-left; the site's count badge shows "mine/total" via data-* + CSS, so Vue keeps the node.
                const mine = isMine(id);
                const ov = mine ? null : overlapOf(id, true);
                const badge = card.querySelector('[class~="top-1.5"][class~="right-1.5"]');
                if (badge) setAttr(badge, 'data-pmvpb-ov', ov ? `${ov.n}/${ov.total}` : null);
                if (mine) {
                    setAttr(card, 'data-pmvpb-voverlap', 'mine');
                    setAttr(card, 'data-pmvpb-overlap-zero', null);
                    lines.push('One of your playlists');
                } else if (ov) {
                    ovKnown++;
                    setAttr(card, 'data-pmvpb-voverlap', ov.n && ov.frac < 0.005 ? '<1%' : pct(ov.frac));
                    setAttr(card, 'data-pmvpb-overlap-zero', ov.n ? null : '1');
                    const perTxt = [...ov.per.entries()].sort((a, b) => b[1] - a[1]).map(([nm, c]) => `${nm} (${c})`).join(', ');
                    lines.push(`In ${overlapLabel()}: ${ov.n} of ${ov.total} (${pct(ov.frac)})` + (perTxt ? ' — ' + perTxt : ''));
                } else {
                    setAttr(card, 'data-pmvpb-voverlap', null);
                    setAttr(card, 'data-pmvpb-overlap-zero', null);
                }
                let state = null;
                if (filterOn && (entry || (ov && !hasTagFilter()))) {
                    known++;
                    const r = evaluate(id, count);
                    if (r.state === 'fail') { state = 'fail'; failN++; lines.push('Fails your playlist filter: ' + r.hits.join(', ')); }
                    else if (r.state === 'pass') { state = entry?.sampled ? 'sampled' : 'pass'; lines.push('Passes your playlist filter'); }
                }
                if (entry) {
                    const tt = topTags(entry);
                    if (tt) lines.push('Top tags: ' + tt);
                    if (entry.sampled) lines.push(`Tags sampled from ${entry.sampled.n} of ${entry.sampled.of} videos`);
                    if (hasTagFilter() && !isFresh(entry, count)) lines.push('Video count changed since the scan — press Scan to refresh');
                }
                const sc = entry ? scoreOf(id, entry) : null;
                if (sc) {
                    lines.unshift(sc.line);
                    if (!state) state = entry.sampled ? 'sampled' : 'pass';
                    setAttr(card, 'data-pmvpb-vscore', (state === 'fail' ? '\u2298 ' : entry.sampled ? '\u2248 ' : '') + sc.score);
                    setAttr(card, 'data-pmvpb-grade', sc.grade);
                } else { setAttr(card, 'data-pmvpb-vscore', null); setAttr(card, 'data-pmvpb-grade', null); }
                setAttr(card, 'data-pmvpb-vstate', loading ? 'busy' : state);
                if (lines.length) { setAttr(card, 'title', lines.join('\n')); card.dataset.pmvpbTitled = '1'; }
                else if (card.dataset.pmvpbTitled) { card.removeAttribute('title'); delete card.dataset.pmvpbTitled; }
            });
            const total = cards.length;
            const scanning = PB.vscan && [...PB.vscan].some(id => PB.pending.has(id) || PB.idsPending.has(id));
            if (PB.vscan && !scanning) PB.vscan = null;
            setText(btn, scanning ? `Scanning… ${total - busy}/${total}` : (vTodo(cards) ? '⟳ Scan' : '⟳ Rescan'));
            btn.disabled = !!scanning;
            setAttr(btn, 'title', `Count how many videos of each playlist are already in ${overlapLabel()} (tick playlists under Filters on the Playlists page to narrow it).`
                + (hasTagFilter() ? ' Also checks their tags against your playlist filter; playlists over 300 videos are sampled.' : ''));
            const parts = [];
            if (ovKnown) parts.push(`overlap with ${overlapLabel()}`);
            if (known && filterOn) parts.push(failN ? `${failN} of ${known} fail your filter` : `all ${known} pass your filter`);
            if (failedN) parts.push(`${failedN} failed`);
            setText(note, parts.join(' · '));
            setAttr(note, 'data-fail', filterOn && failN ? '1' : null);
        }
        function injectVideoStyles() {
            if (document.getElementById(STYLE_ID + '-v')) return;
            const st = document.createElement('style');
            st.id = STYLE_ID + '-v';
            st.textContent = `
                #${VSCAN_ID} { display: inline-flex; align-items: center; gap: 10px; margin-left: auto; min-width: 0; }
                #${VSCAN_ID} .note { color: rgb(156,163,175); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
                #${VSCAN_ID} .note[data-fail="1"] { color: rgb(252,165,165); }
                #${VSCAN_ID} .btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font: inherit; font-size: 12px; font-weight: 500; line-height: 16px;
                    background: #2A2A2A; color: #fff; border: 1px solid #3A3A3A; border-radius: 8px; cursor: pointer; white-space: nowrap; transition: background .2s, border-color .2s; }
                #${VSCAN_ID} .btn:hover { background: #3A3A3A; border-color: rgba(249,115,22,0.4); }
                #${VSCAN_ID} .btn:disabled { opacity: .6; cursor: default; }
                [data-pmvpb-vgrid] > a { position: relative; }
                [data-pmvpb-vgrid] > a[data-pmvpb-voverlap]::before {
                    content: attr(data-pmvpb-voverlap); position: absolute; top: 6px; left: 6px; z-index: 20;
                    padding: 2px 8px; border-radius: 9999px; line-height: 16px;
                    background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)); color: #fff;
                    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; pointer-events: none;
                    text-shadow: 0 1px 1px rgba(0,0,0,0.35); box-shadow: 0 1px 4px rgba(0,0,0,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-overlap-zero="1"]::before { background: rgba(0,0,0,0.85); color: rgb(209,213,219);
                    box-shadow: 0 0 0 1px rgba(255,255,255,0.2), 0 1px 4px rgba(0,0,0,0.6); font-weight: 500; }
                [data-pmvpb-vgrid] [data-pmvpb-ov] { font-size: 0 !important; background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)) !important;
                    color: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.6); }
                [data-pmvpb-vgrid] [data-pmvpb-ov]::after { content: attr(data-pmvpb-ov); margin-left: 4px; font-size: 12px; line-height: 16px; font-weight: 700;
                    font-variant-numeric: tabular-nums; text-shadow: 0 1px 1px rgba(0,0,0,0.35); }
                [data-pmvpb-vgrid] > a[data-pmvpb-overlap-zero="1"] [data-pmvpb-ov] { background: rgba(0,0,0,0.85) !important; color: rgb(209,213,219);
                    box-shadow: 0 0 0 1px rgba(255,255,255,0.2), 0 1px 4px rgba(0,0,0,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-voverlap="mine"]::before { background: rgba(0,0,0,0.85); color: rgb(192,132,252);
                    box-shadow: 0 0 0 1px rgba(168,85,247,0.5), 0 1px 4px rgba(0,0,0,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate]::after {
                    position: absolute; top: 32px; right: 6px; z-index: 20; width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 50%;
                    background: rgba(0,0,0,0.85); color: rgb(253,186,116); font-size: 11px; font-weight: 700; font-family: inherit; pointer-events: none;
                    box-shadow: 0 0 0 1px rgba(249,115,22,0.5); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="pass"]::after { content: '\\2713'; }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="sampled"]::after { content: '\\2248'; }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="busy"]::after { content: '\\2026'; color: rgb(209,213,219); box-shadow: 0 0 0 1px rgba(255,255,255,0.2); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="fail"]::after { content: '\\2298'; color: rgb(252,165,165); box-shadow: 0 0 0 1px rgba(239,68,68,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vscore]:not([data-pmvpb-vstate="busy"])::after { content: attr(data-pmvpb-vscore); width: auto; min-width: 18px; padding: 0 6px; border-radius: 9999px; }
                [data-pmvpb-vgrid] > a[data-pmvpb-grade="hi"]:not([data-pmvpb-vstate="busy"])::after { color: rgb(134,239,172); box-shadow: 0 0 0 1px rgba(34,197,94,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-grade="mid"]:not([data-pmvpb-vstate="busy"])::after { color: rgb(253,224,71); box-shadow: 0 0 0 1px rgba(234,179,8,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-grade="lo"]:not([data-pmvpb-vstate="busy"])::after { color: rgb(252,165,165); box-shadow: 0 0 0 1px rgba(239,68,68,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="fail"] { opacity: 0.4; filter: grayscale(0.6); transition: opacity .2s; }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="fail"]:hover { opacity: 0.85; }
            `;
            (document.head || document.documentElement).appendChild(st);
        }
        const scheduleVideo = PMVX.scheduler(applyVideoSection);
        function vstart() {
            if (PB.vactive) return;
            PB.vactive = true;
            injectVideoStyles();
            // Self-heal: Vue re-renders the section (and drops the button) on navigation between videos.
            PB.vobserver = new MutationObserver(scheduleVideo);
            PB.vobserver.observe(document.body, { childList: true, subtree: true });
            window.addEventListener('pmv:cache-ready', scheduleVideo);
            try { loadPlaylistCache(); } catch {}
            applyVideoSection();
        }
        function vstop() {
            if (!PB.vactive) return;
            PB.vactive = false;
            PB.vobserver?.disconnect();
            PB.vobserver = null;
            window.removeEventListener('pmv:cache-ready', scheduleVideo);
            PB.vscan = null;
            document.getElementById(VSCAN_ID)?.remove();
        }

        // --- Lifecycle ---
        function start() {
            if (PB.active) return;
            PB.active = true;
            PB.failed.clear(); // a new visit retries what failed last time (also Mini-checker failures)
            injectStyles();
            // Self-heal: re-insert the bar and re-apply when Vue replaces the header or grid.
            PB.observer = new MutationObserver(muts => {
                // Our own bar and button rewrite their text on every run; reacting to that would loop.
                if (muts.every(m => m.target.closest?.('#' + BAR_ID + ', #' + BTN_ID))) return;
                const btn = document.getElementById(BTN_ID);
                const row = document.querySelector('.playlists-dashboard .dashboard-header .filter-pills');
                if (!document.getElementById(BAR_ID) || !btn?.isConnected || (row && btn.parentElement !== row)) buildBar();
                scheduleApply();
            });
            PB.observer.observe(document.body, { childList: true, subtree: true });
            // Also mousedown/mouseup: the card may act before click, and an <a> would navigate.
            ['mousedown', 'mouseup', 'click'].forEach(t => document.addEventListener(t, onCardClick, true));
            if (!PB.resizeHooked) { PB.resizeHooked = true; window.addEventListener('resize', () => { if (PB.active) placeCaret(); }); }
            buildBar();
            applyFilter();
            window.addEventListener('pmv:cache-ready', scheduleApply);
            window.addEventListener('pmv:cache-ready', renderMineChipsOnReady);
        }
        function renderMineChipsOnReady() { renderMineChips(); }
        function stop() {
            window.removeEventListener('pmv:cache-ready', scheduleApply);
            window.removeEventListener('pmv:cache-ready', renderMineChipsOnReady);
            if (!PB.active) return;
            PB.active = false;
            ['mousedown', 'mouseup', 'click'].forEach(t => document.removeEventListener(t, onCardClick, true));
            PB.observer?.disconnect();
            PB.observer = null;
            document.getElementById(BAR_ID)?.remove();
            document.getElementById(BTN_ID)?.remove();
            document.querySelectorAll('[data-pmvpb-note]').forEach(n => n.removeAttribute('data-pmvpb-note'));
            PB.bar = PB.input = PB.counter = PB.toggle = null;
            // Queued scans would keep hitting the API after we left; running ones finish.
            PB.queue.splice(0).forEach(job => { PB.pending.delete(job.id); job.resolve(); });
        }
        function onRoute() {
            if (isBrowsePage()) start(); else stop();
            // Playlist pages too: their expandable video info (hud/13-badges.js) carries the same section.
            if (isVideoPage() || /^\/playlists\/[0-9a-f]{24}/i.test(location.pathname)) { PB.vscan = null; vstart(); scheduleVideo(); } else vstop();
        }

        loadSettings();
        loadCache();
        const bootPb = () => {
            onRoute();
            PMVX.onRoute((path, prev) => { if (path !== prev) onRoute(); });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPb, { once: true });
        else bootPb();

    })();


})();

// Core (HUD, queue, badges, settings, hotkeys), the browse filter, header search and tag menu need <body>.
whenBody(() => {

(function () {
    'use strict';


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
        refreshEdits: null, // [playlistId, videoId, added] made while a refresh runs
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
    // Another tab saved playlist changes: take them over (not mid-refresh or with an own save pending).
    window.addEventListener('storage', e => {
        if (e.key === CACHE_KEY && !State.refreshPromise && !saveCacheTimer && loadCache()) notifyCacheReady();
    });

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

    // --- API ---

    // Own requests are marked quiet so the interceptor doesn't index their playlist responses twice.
    async function api(url, opts) {
        quietUrls.add(url);
        let res;
        try { res = await fetch(url, opts); }
        finally { quietUrls.delete(url); }
        if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
        return pmvResJson(res);
    }

    // Site moderation flags plus three only some lists carry; Nudity = hasExplicitContent, SFW its inverse.
    const CONTENT_FLAGS = PMVX.contentFlags;

    // localStorage: id -> [trueBits, knownBits], bit i = CONTENT_FLAGS[i]. Full documents omit never-set
    // moderation flags (known false); partial copies (playlist videoDetails) add only the flags they carry.
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

    function votedTerms(votes) {
        const m = new Map();
        (Array.isArray(votes) ? votes : []).forEach(tv => {
            if (!tv?.tag) return;
            const k = String(tv.tag).toLowerCase().trim();
            m.set(k, (m.get(k) || 0) + (tv.upvotes?.length || 0) - (tv.downvotes?.length || 0));
        });
        return [...m].filter(([, score]) => score >= 1).map(([k]) => k);
    }

    // Returns the number of new thumbnail URLs; queue badges are invalidated only when > 0.
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
            [v.thumbnailUrl, v.rawThumbnailUrl, v.previewUrl].forEach(u => putThumb(u, v._id));
            Object.values(v.thumbnailSizes || {}).forEach(t => putThumb(t?.url, v._id));
            if (v.title) State.titleIndex.set(v.title.trim().toLowerCase(), v._id);
            rememberFlags(v);
            // tags/top5Tags hold at most 5 and playlist data has no starsTags; full sets come from tagVotes
            // (full documents only) and aren't overwritten by later trimmed copies.
            const full = Array.isArray(v.tagVotes);
            const prev = State.videoMeta.get(v._id);
            const baseTags = (v.tags || v.top5Tags || []).map(t => String(t).toLowerCase());
            const baseStars = (v.starsTags || v.stars || []).map(s => (typeof s === 'string' ? s : (s?.name || '')).toLowerCase()).filter(Boolean);
            let tags, starsTags;
            if (full) {
                const unified = v.tagVotes.some(tv => tv?.tagType);
                const general = unified ? v.tagVotes.filter(tv => !tv?.tagType || tv.tagType === 'general') : v.tagVotes;
                const starVotes = Array.isArray(v.starVotes) && v.starVotes.length ? v.starVotes
                    : (unified ? v.tagVotes.filter(tv => tv?.tagType === 'stars') : []);
                tags = [...new Set([...baseTags, ...votedTerms(general)])];
                starsTags = [...new Set([...baseStars, ...votedTerms(starVotes)])];
            } else if (prev?.full) {
                tags = [...new Set([...prev.tags, ...baseTags])];
                starsTags = [...new Set([...prev.starsTags, ...baseStars])];
            } else {
                tags = baseTags;
                starsTags = baseStars;
            }
            State.videoMeta.set(v._id, {
                full: full || !!prev?.full,
                tags,
                starsTags,
                music: (Array.isArray(v.music) ? v.music : []).map(m => String(m?.artist || '').toLowerCase().trim()).filter(Boolean),
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
                description: String(v.description || '').toLowerCase(),
            });
        });
        return added;
    }

    // Account id from the session (user.id, not auth userId); cached per page, none when logged out.
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
            const list = [];
            for (let page = 1; ; page++) {
                const listJson = await api(`/api/playlists?owner=${ownerId}&limit=100&page=${page}`);
                const part = Array.isArray(listJson) ? listJson : (listJson.playlists || listJson.data || []);
                list.push(...part);
                if (!listJson?.meta?.hasMore || !part.length) break;
            }
            State.refreshEdits = [];

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
            let failed = false;

            // Largest playlist first, merged as soon as it lands so lookups work while the rest loads.
            const sizeOf = p => p.validVideoCount ?? (Array.isArray(p.videos) ? p.videos.length : 0);
            const priorityIdx = list.length
                ? list.reduce((best, p, i, a) => (sizeOf(p) > sizeOf(a[best]) ? i : best), 0)
                : -1;
            const restList = priorityIdx === -1 ? list : list.filter((_, i) => i !== priorityIdx);

            // Notifies other modules early only on a cold start; one localStorage write at the end.
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
                } catch { failed = true; }
            })();

            // fetchAll=true is required, else only the first page of each playlist comes back. Two at a time.
            const [results] = await Promise.all([
                settledWithLimit(restList, 2,
                    p => api(`/api/playlists/${p._id}?fetchAll=true`).then(detail => ({ p, detail }))),
                priorityDone,
            ]);

            results.forEach(r => {
                if (r.status !== 'fulfilled') {
                    failed = true;
                    return;
                }
                const { p, detail } = r.value;
                const entry = buildPlaylistEntry(p, detail);
                nextPlaylists.set(entry.id, entry);
            });

            // A playlist that failed to load keeps its old entry; no fresh cache, so the next page load retries.
            list.forEach(p => { if (!nextPlaylists.has(p._id) && State.playlists.has(p._id)) nextPlaylists.set(p._id, State.playlists.get(p._id)); });
            // Adds/removes made while the fetches ran may be missing from their responses.
            State.refreshEdits.forEach(([pid, vid, added]) => nextPlaylists.get(pid)?.ids[added ? 'add' : 'delete'](vid));
            State.playlists = nextPlaylists;
            State.ready = true;
            rebuildReverseIndex();
            if (!failed) saveCache();
        })();

        try {
            await State.refreshPromise;
        } finally {
            State.refreshPromise = null;
            State.refreshEdits = null;
        }
    }

    // --- Fetch interceptor ---

    const nativeFetch = window.fetch;

    // --- Rate-limit guard (429) ---
    // The site rate-limits per IP across all /api/ calls, so our bursts break its requests too.
    // Rate-limited GETs wait out Retry-After (or 1s/2s/4s) and retry; bulk work uses settledWithLimit().
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

    // Like Promise.allSettled, but at most `limit` at a time (rate limit).
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

    const pmvResJson = PMVX.resJson || (PMVX.resJson = res => {
        if (!res.__pmvJson) {
            try { res.__pmvJson = res.clone().json(); }
            catch (e) { res.__pmvJson = Promise.reject(e); }
            res.__pmvJson.catch(() => {});
        }
        return res.__pmvJson;
    });
    // Own in-flight URLs; the /playlists filter also adds lookups that must not be indexed.
    const quietUrls = PMVX.quietUrls || (PMVX.quietUrls = new Set());

    // Shared in-flight single-video lookups, the site's own GETs included. Use fetchVideoDeduped()
    // so concurrent callers share one request and retry budget; recentVideos answers repeats.
    const pendingVideoApiFetches = new Map();
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
    // Likes, dislikes and favourites change the video data, so drop its cached entries.
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
        // Index-limit bump: Vue falls back to index 0 when page 1 has fewer items than ?index=,
        // so raise the limit past it. Do not change.
        try {
            const rawUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const pm = rawUrl.match(/(\/api\/playlists\/[a-f0-9]{24})\?(.*)$/);
            if (pm) {
                const params = new URLSearchParams(pm[2]);
                if (params.get('page') === '1' && params.get('limit') && !params.get('fetchAll')) {
                    const index = parseInt(new URLSearchParams(location.search).get('index') || '0', 10);
                    const currentLimit = parseInt(params.get('limit'), 10);
                    if (Number.isFinite(index) && index >= currentLimit) {
                        const newLimit = index + 50;
                        const newUrl = `${pm[1]}?page=1&limit=${newLimit}`;
                        if (typeof args[0] === 'string') args[0] = newUrl;
                        else if (args[0] instanceof Request) args[0] = new Request(newUrl, args[0]);
                        else if (args[0]?.url) args[0] = { ...args[0], url: newUrl };
                    }
                }
                // One-shot fetchAll, set by the playlist-page filter before it triggers Vue's next-page fetch so Vue
                // treats the response as its own. Only page=1 is rewritten; later pages would duplicate rows.
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
            // After an in-place hand-over the page saves progress under the earlier video with the playing
            // one's time; re-target it to the playing video.
            if (staleFullscreenId && method0 === 'PUT' && /\/api\/users\/watch-progress$/.test(u0) && typeof args[1]?.body === 'string') {
                try {
                    const body = JSON.parse(args[1].body);
                    if (body.videoId && body.videoId !== staleFullscreenId) {
                        args[1] = { ...args[1], body: JSON.stringify({ ...body, videoId: staleFullscreenId }) };
                    }
                } catch {}
            }
            // The site's own favourite toggles update the card hearts.
            if (mut && /\/favorite$/.test(u0) && typeof args[1]?.body === 'string') {
                try { const a = JSON.parse(args[1].body).action; if (a) noteFavourite(mut[1], a === 'favorite'); } catch {}
            }
            if (m0 && method0 === 'GET' && !quietUrls.has(u0) && !pendingVideoApiFetches.has(m0[1])) {
                let resolve;
                const p = new Promise(r => { resolve = r; });
                videoDeferred = { id: m0[1], p, resolve };
                pendingVideoApiFetches.set(m0[1], p);
                // Waiters get null if the response never parses.
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
            const jsonP = /\/api\//.test(url) ? pmvResJson(res) : null;

            // PMVX.apiTaps: listeners get (url, json) of every API response.
            if (jsonP && PMVX.apiTaps.length) {
                jsonP.then(json => PMVX.apiTaps.forEach(fn => { try { fn(url, json); } catch {} })).catch(() => {});
            }

            if (jsonP) {
                jsonP.then(json => {
                    if (learnVideoIds(json)) scheduleBadges();
                }).catch(() => {});
            }

            if (jsonP && /\/api\/videos\/[a-f0-9]{24}$/.test(url)) {
                const urlId = url.match(/\/api\/videos\/([a-f0-9]{24})$/)[1];
                jsonP.then(json => {
                    const v = json?.data || json;
                    if (!res.ok || !v?._id) { settleVideoDeferred(null); return; }
                    if (videoDeferred) indexVideoDetails([v]);
                    rememberVideo(urlId, v);
                    settleVideoDeferred(v);
                    if (urlId !== v._id) State.slugToApiId.set(urlId, v._id);

                    // The slug part is optional (/video/slug_<hex> or /video/<hex>). Without an id match, background
                    // fetches (e.g. sidebar hover previews) would be taken for the playing video.
                    const pageId = location.pathname.match(/^\/video\/(?:[^?#]*_)?([0-9a-f]{24})(?:[?#]|$)/i)?.[1];
                    // Playlist pages: compare with the active queue row (border-orange-500).
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

            // storage.pmvhaven.com/<id>/: used only for the page video, so background fetches don't overwrite state.
            const storageM = url.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//);
            if (storageM) {
                const idFromStorage = storageM[1];
                const pageId = location.pathname.match(/^\/video\/(?:[^?#]*_)?([0-9a-f]{24})(?:[?#]|$)/i)?.[1];
                if (pageId && (idFromStorage === pageId || State.slugToApiId.get(pageId) === idFromStorage)) {
                    if (!State.currentVideoData?.id) {
                        State.currentVideoId = idFromStorage;
                    }
                }
            }

            // Site playlist responses (not quiet ones): index their videos so queue rows resolve.
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
            // Site video lists (discover, browse, search): full metadata lets the filter see more than a card's two tags.
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
            // The user's like/dislike/favourite state for the API buttons.
            isLiked: v.isLiked === true,
            isDisliked: v.isDisliked === true,
            isFavorited: v.isFavorited === true,
            // Timeline frames {url, captureTime}, kept for fullscreen hand-over.
            timelineThumbnails: Array.isArray(v.timelineThumbnails)
                ? v.timelineThumbnails.filter(t => t?.url).map(t => ({ url: t.url, captureTime: t.captureTime }))
                : [],
        };
        State.currentVideoId = v._id;
        const existing = document.getElementById('pmv-page-playlists');
        if (existing && existing.dataset.forVideo !== v._id) existing.remove();
        try { injectPagePlaylistButtons(v._id); } catch {}
        try { updateNativePlaylistButtons(true); } catch {}
    }

    // --- Video identification / meta ---

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

    // --- Watched tracking ---
    // Local playback history (PMVX.isWatched / PMVX.markWatched), attached from getVideo()'s init.
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
            // Merge what other tabs wrote since we loaded; the newest timestamp wins.
            const stored = JSON.parse(localStorage.getItem(WATCHED_KEY) || '{}') || {};
            for (const [id, at] of Object.entries(stored)) if (!(watchedMap.get(id) >= at)) watchedMap.set(id, at);
            if (watchedMap.size > WATCHED_MAX) {
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
    PMVX.isWatched = id => watchedMap.has(id);
    PMVX.markWatched = markWatched;

    // Dedup per current id: Vue reuses the same <video> element across auto-advance.
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

    // --- Current video and playlist membership ---
    function getCurrentVideoId() {
        // Playlist pages: the active queue row (border-orange-500) wins over currentVideoData (lags a step on
        // advance) and the poster (its hex is a thumbnail asset id).
        if (location.pathname.startsWith('/playlists/')) {
            const active = getActiveQueueVideoId();
            if (active) return active;
        }
        if (State.currentVideoData?.id) return State.currentVideoData.id;

        // /video/ pages: the URL hex (slug id or API _id) is the only reliable id before any API response.
        // Must precede the poster fallback: a poster hex is a thumbnail asset id, not a video _id.
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

    // Vue often hydrates from SSR without a client fetch, so fetch here (deduped) to fill
    // State.currentVideoData; adopted only if it is still the video on screen.
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
        // Resolves indices, arrays of indices and devalue's Reactive/Ref wrappers.
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
            // SSR lists (homepage first page) never pass the fetch interceptor; read their metadata here.
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
        // During a fullscreen hand-over the page still shows the previous video; use only fetched data.
        const pageIsBehind = !!staleFullscreenHref;

        const liveTitle = pageIsBehind ? null :
            document.querySelector('.min-w-0 h1')?.textContent?.trim() ||
            document.querySelector('h1')?.textContent?.trim();

        // Creator: orange gradient h3, text nodes only (skips the "Creator" badge).
        let liveCreator = null;
        const uploaderH3 = pageIsBehind ? null : document.querySelector('h3.bg-gradient-to-r.from-orange-400');
        if (uploaderH3) {
            const text = [...uploaderH3.childNodes]
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent).join('').trim();
            if (text) liveCreator = text;
        }
        // Fallback: the "More from X (N)" h3.
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

        const domTags = pageIsBehind ? [] : [...document.querySelectorAll('a[href^="/search?tags="]')]
            .slice(0, 15)
            .map(a => (a.getAttribute('title')?.replace(/^Search for '|'$/g, '') ||
                       a.textContent.replace(/^#/, '')).trim())
            .filter(Boolean);

        // Performers: /search?stars= or /model/ links; /model/ titles read "View <name>'s profile", so use the text.
        const domStars = pageIsBehind ? [] : [...document.querySelectorAll('a[href^="/search?stars="], a[href^="/model/"]')]
            .slice(0, 10)
            .map(a => (a.querySelector('.truncate')?.textContent || a.textContent || '').replace(/^#/, '').trim())
            .filter(Boolean);

        let liveDescription = null;
        const descBlock = pageIsBehind ? null : document.querySelector('div.bg-\\[\\#1A1A1A\\] p.whitespace-pre-wrap, div.bg-\\[\\#1A1A1A\\] p.text-gray-300');
        if (descBlock) liveDescription = descBlock.textContent.trim() || null;

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
    // --- Settings export/import ---
    // Exports every pmv*-prefixed localStorage key.
    function collectPmvSettings() {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            // Settings only: caches are rebuilt from the site.
            if (!k || !k.startsWith('pmv') || /cache/i.test(k)) continue;
            out[k] = localStorage.getItem(k); // raw: parsing would strip the quotes off JSON string values
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

    // --- Settings section ---
    // Section in the site's Settings modal (teleported to <body>: h2 "Settings" + `space-y-6` list),
    // styled like the native ones; the observer re-adds it when Vue rebuilds the list.
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

    // Inline copy of the site's CustomSelect. items(): [{ value, label, desc }].
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
            let count;
            try { count = applyPmvSettings(parsed); }
            catch (e) { toast(`Import stopped: ${e.message || e}`); return; }
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

        const scrubItems = () => [
            { value: 'hybrid', label: 'Live', desc: 'Frame cache built in the background (more CPU)' },
            { value: 'frames', label: 'Timeline thumbnails', desc: "The site's own preview frames" },
            { value: 'off', label: 'Off', desc: 'No preview' },
        ];
        const scrubSel = mkToolsSelect(scrubItems, () => scrubMode(), v => setScrubMode(v));
        slots[0].replaceWith(scrubSel.el);

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

        const vol = sec.querySelector('[data-vol]');
        const paintVol = () => vol.setAttribute('aria-checked', volumeLockEnabled() ? 'true' : 'false');
        vol.onclick = () => { setVolumeLock(!volumeLockEnabled()); paintVol(); };
        paintVol();

        const tagRej = sec.querySelector('[data-tagrej]');
        const paintTagRej = () => tagRej.setAttribute('aria-checked', tagAfterReject() ? 'true' : 'false');
        tagRej.onclick = () => { setTagAfterReject(!tagAfterReject()); paintTagRej(); };
        paintTagRej();

        const rejectItems = () => {
            const items = [{ value: '', label: 'None', desc: 'No reject list' }];
            [...State.playlists.values()]
                .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
                .forEach(p => items.push({ value: p.id, label: getPlaylistDisplayName(p.name, p.id) || p.id, desc: `${p.ids.size} videos` }));
            if (rejectPlaylistId && !State.playlists.has(rejectPlaylistId)) {
                // Not loaded yet: keep it instead of showing "None".
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

        sec.querySelector('[data-more]').replaceWith(moreSettingsCard());

        sec.addEventListener('click', e => {
            if (!e.target.closest('.ts-cs, .ts-dd')) { scrubSel.close(); rejectSel.close(); }
        });
        return sec;
    }

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

    // --- /settings page: playlist names & colours ---
    // Per-playlist short names and colours (pmv_playlist_config_v1), saved on change.

    function savePlaylistConfig() {
        try {
            const raw = JSON.parse(localStorage.getItem(PLAYLIST_CONFIG_KEY) || '{}') || {};
            raw.styles = playlistConfig.styles;
            if (!raw.order) raw.order = playlistConfig.order;
            if (!Object.keys(raw.styles).length && !(raw.order || []).length) localStorage.removeItem(PLAYLIST_CONFIG_KEY);
            else localStorage.setItem(PLAYLIST_CONFIG_KEY, JSON.stringify(raw));
        } catch {}
        document.querySelectorAll('[data-playlist-name], [data-pmv-rec-badge]').forEach(el => el.remove());
        document.querySelectorAll('[data-pmv-checked], [data-pmv-rec-checked], [data-pmv-mf-checked]').forEach(el => {
            delete el.dataset.pmvChecked; delete el.dataset.pmvRecChecked; delete el.dataset.pmvMfChecked;
        });
        try { scheduleBadges(); } catch {}
    }

    // All entries for a playlist: by id, plus legacy ones by lower-cased name.
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
        const onReady = () => { if (sec.isConnected) render(); else window.removeEventListener('pmv:cache-ready', onReady); };
        window.addEventListener('pmv:cache-ready', onReady);
        list.appendChild(sec);
        if (location.hash === '#pmvx') setTimeout(() => sec.scrollIntoView({ block: 'start', behavior: 'smooth' }), 100);
    }

    // Vue re-renders can drop the section; put it back.
    let settingsPageQueued = false;
    new MutationObserver(() => {
        if (settingsPageQueued || location.pathname.replace(/\/+$/, '') !== '/settings') return;
        settingsPageQueued = true;
        requestAnimationFrame(() => { settingsPageQueued = false; try { injectSettingsPageSection(); } catch {} });
    }).observe(document.body, { childList: true, subtree: true });

    // --- Sidebar: hide items (set on the full settings page) ---
    // Keys: "g:<label>" (group header + items) or "a:<href>" (one link); hidden via data-* flag + stylesheet.
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

    // --- Sidebar: "Saved content" group ---
    // Favorites + own playlists under Explore, cloned from the sidebar's rows; re-added on Vue re-renders.

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

    // PMVX.navRowHook(link, playlist) / navRowSig(playlist) (in the redraw signature) let builds extend rows.
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
        // Keep only icon and label: drop badges and Vue comment nodes.
        a.textContent = '';
        if (svgEl) { setNavIcon(svgEl, icon); a.appendChild(svgEl); }
        span.className = 'flex-1';
        // min-width:0 lets long names ellipsize instead of widening the sidebar.
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

    // The site's gear: header button whose lucide:settings icon has an r=3 center circle.
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
        // Logged out: no gear, so open a modal copy holding only this section.
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

    // --- Hotkey editor ---
    // Click or press a key to bind it inline (saved at once). Tiles: orange action, green playlist, red reject list.
    const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm?']; // '?' is Shift+/ (hotkey overview)

    function bindingKind(b) {
        if (!b) return '';
        if (b.action === 'playlist') return isRejectList(b.playlistId) ? 'reject' : 'playlist';
        return b.action === 'builtin:rejectVideo' ? 'reject' : 'action';
    }
    function bindingShort(b) {
        if (!b) return '';
        if (b.action === 'playlist') return getPlaylistDisplayName(State.playlists.get(b.playlistId)?.name, b.playlistId) || b.playlistId;
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

    // Keys the player handles itself (see PLAYER_KEY_DEFAULTS); a binding overrides them.
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

    // --- Command palette (Ctrl/Cmd+K) ---
    // Navigates via location.href, not a SPA transition.
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
            const name = getPlaylistDisplayName(p.name, id) || id;
            if (!q || name.toLowerCase().includes(q)) {
                results.push({ type: 'playlist', id, label: name, sub: `${p.ids.size} videos`, href: `/playlists/${id}` });
            }
        });

        if (q) { // titleIndex can be large: videos only with a query
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
                        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${r.type === 'playlist' ? 'rgb(165,180,252)' : 'rgba(255,255,255,0.85)'};">${r.type === 'playlist' ? '▶ ' : ''}${escHtml(r.label)}</span>
                        <span style="color:rgba(255,255,255,0.3);font-size:10px;white-space:nowrap;flex-shrink:0;">${escHtml(r.sub || '')}</span>
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

    // --- Up next panel: settings, Previous queues, Saved queues, Undo ---
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
                <label class="flex items-center gap-1" style="margin-bottom:6px;" title="A long session in one page keeps growing in memory. A full page load clears it; Up next and the playback position are kept. A page load ends fullscreen; one click or key on the new page puts it back.">
                    <span>Fresh page load every</span>
                    <input id="sq-fresh" type="number" min="0" max="200" placeholder="off" value="${s.freshEvery || ''}" style="${Q_INPUT}width:52px;">
                    <span>videos, in fullscreen every</span>
                    <input id="sq-fresh-fs" type="number" min="0" max="200" placeholder="off" value="${s.freshEveryFs || ''}" style="${Q_INPUT}width:52px;">
                    <span>(empty = off)</span>
                </label>
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
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);">
                    <div class="text-gray-300" style="margin-bottom:6px;font-weight:600;">Saved queues</div>
                    <div class="flex items-center gap-2" style="margin-bottom:6px;">
                        <input id="sq-save-name" type="text" placeholder="Name this queue\u2026" maxlength="60" style="${Q_INPUT}flex:1;min-width:90px;">
                        <button id="sq-save" type="button" class="${Q_CHIP_ON}" style="cursor:pointer;" title="Save Up next from the current video on; kept until you delete it">Save</button>
                    </div>
                    <div id="sq-saved-list">${savedQueuesHtml()}</div>
                    <div class="text-gray-300" style="margin:10px 0 6px;font-weight:600;">Previous queues</div>
                    <div id="sq-prev-list">${prevQueuesHtml()}</div>
                </div>
            </div>`;
    }

    // Two-step click ("Clear all?"): the second click within 3 s goes through.
    function confirmClick(btn, label) {
        if (btn.dataset.armed === '1') { clearTimeout(btn._pmvArm); delete btn.dataset.armed; return true; }
        btn.dataset.armed = '1';
        btn._pmvLabel = btn.textContent;
        btn.textContent = label;
        btn.style.color = 'rgb(252,165,165)';
        btn.style.borderColor = 'rgba(239,68,68,.5)';
        btn._pmvArm = setTimeout(() => {
            if (!btn.isConnected) return;
            delete btn.dataset.armed;
            btn.textContent = btn._pmvLabel;
            btn.style.color = ''; btn.style.borderColor = '';
        }, 3000);
        return false;
    }

    function loadPrevQueues() {
        try {
            const a = JSON.parse(localStorage.getItem(QUEUE_PREV_KEY) || '[]');
            const now = Date.now();
            return (Array.isArray(a) ? a : []).filter(q => q && Array.isArray(q.items) && q.items.length && now - (q.at || 0) < QUEUE_PREV_MAX_AGE_MS);
        } catch { return []; }
    }

    function storePrevQueues(list) {
        try { localStorage.setItem(QUEUE_PREV_KEY, JSON.stringify(list.slice(0, QUEUE_PREV_MAX))); } catch {}
    }

    function snapshotQueue(label) {
        const snap = {
            label, at: Date.now(), cursor: queueCursor, active: smartQueueActive, manual: [...manuallyAddedIds],
            items: smartQueueItems.map(it => ({ id: it.id, href: it.href, meta: it.meta ? { ...it.meta } : {} })),
        };
        if (!snap.items.length) return snap;
        const list = loadPrevQueues().filter(q => queueSig(q.items) !== queueSig(snap.items));
        list.unshift(snap);
        storePrevQueues(list);
        return snap;
    }

    function loadQueueUndo() { return loadPrevQueues()[0] || null; }

    function prevQueueCount() { return loadPrevQueues().length; }

    // Restores a previous queue; the replaced queue goes into the list, so this is undoable too.
    function restoreQueueSnapshot(snap) {
        if (!snap) return;
        const rest = loadPrevQueues().filter(q => !(q.at === snap.at && queueSig(q.items) === queueSig(snap.items)));
        storePrevQueues(rest);
        // Not when the current queue is only part of the restored one (an undo).
        const restoredIds = new Set(snap.items.map(it => it.id));
        if (smartQueueItems.length && !smartQueueItems.every(it => restoredIds.has(it.id))) snapshotQueue(`Replaced by a restore \u2022 ${smartQueueItems.length} videos`);
        smartQueueItems = snap.items.map(it => ({ ...it, meta: it.meta ? { ...it.meta } : {} }));
        manuallyAddedIds = new Set(snap.manual || []);
        smartQueueActive = snap.active !== false;
        queueCursor = Math.min(snap.cursor ?? -1, smartQueueItems.length - 1);
        dismissedCurrentId = null;
        document.getElementById('pmv-undo-toast')?.remove();
        renderQueueSidebar();
        toast(`↺ Up next restored (${upcomingCount()} to come)`, 'green', { under: upNextToastAnchor() });
    }

    function prevQueuesHtml() {
        const list = loadPrevQueues();
        if (!list.length) return '<div class="text-gray-500">Nothing yet. Cleared or replaced queues are kept here for 14 days.</div>';
        return list.map((q, i) => {
            const d = new Date(q.at);
            const when = d.toDateString() === new Date().toDateString()
                ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
            const first = q.items[Math.max(0, (q.cursor ?? -1) + 1)]?.meta?.title || q.items[0]?.meta?.title || '';
            return `<div class="flex items-center gap-2" style="margin-bottom:4px;">
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;" title="${escHtml(first)}">${escHtml(q.label || q.items.length + ' videos')}</span>
                <span class="text-gray-500" style="white-space:nowrap;">${escHtml(when)}</span>
                <button type="button" class="${Q_CHIP_ON}" style="cursor:pointer;" data-sq-prev="${i}" title="Put this queue back (the current one is kept in this list)">Restore</button>
            </div>`;
        }).join('');
    }

    // Undo toast under Up next in the header; fades after 2 s (held on hover).
    function showQueueUndo(msg, snap) {
        document.getElementById('pmv-undo-toast')?.remove();
        const el = document.createElement('div');
        el.id = 'pmv-undo-toast';
        el.style.cssText = 'position:fixed;bottom:30px;right:30px;z-index:1000003;display:flex;align-items:center;gap:12px;padding:8px 8px 8px 14px;' +
            'border-radius:10px;background:rgba(0,0,0,.9);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.5);';
        const t = document.createElement('span');
        t.textContent = msg;
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Undo';
        b.style.cssText = 'padding:5px 12px;border-radius:7px;border:none;cursor:pointer;font:inherit;font-weight:600;color:#000;background:rgb(100,255,0);';
        b.onclick = e => { e.preventDefault(); e.stopPropagation(); restoreQueueSnapshot(snap); };
        el.append(t, b);
        const anchor = upNextToastAnchor();
        const r = anchor && !document.fullscreenElement && anchor.isConnected ? anchor.getBoundingClientRect() : null;
        if (r && r.width) { el.style.bottom = 'auto'; el.style.top = Math.round(r.bottom + 8) + 'px'; el.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px'; }
        (document.fullscreenElement || document.body).appendChild(el);
        el.style.transition = 'opacity .3s';
        let timer = null;
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2000);
        };
        el.addEventListener('mouseenter', () => { clearTimeout(timer); el.style.opacity = '1'; });
        el.addEventListener('mouseleave', arm);
        arm();
    }

    function loadSavedQueues() {
        try {
            const a = JSON.parse(localStorage.getItem(SAVED_QUEUES_KEY) || '[]');
            return Array.isArray(a) ? a.filter(q => q && typeof q.name === 'string' && Array.isArray(q.items)) : [];
        } catch { return []; }
    }

    function storeSavedQueues(list) {
        try { localStorage.setItem(SAVED_QUEUES_KEY, JSON.stringify(list.slice(0, SAVED_QUEUES_MAX))); return true; }
        catch { return false; }
    }

    function savedQueuesHtml() {
        const list = loadSavedQueues();
        if (!list.length) return '<div class="text-gray-500">None yet. Saved queues stay until you delete them.</div>';
        return list.map(q => {
            const when = q.at ? new Date(q.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
            return `<div class="flex items-center gap-2" style="margin-bottom:4px;">
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;" title="${escHtml(q.name)}">${escHtml(q.name)}</span>
                <span class="text-gray-500" style="white-space:nowrap;">${q.items.length} \u2022 ${escHtml(when)}</span>
                <button type="button" class="${Q_CHIP_ON}" style="cursor:pointer;" data-sq-load="${q.at}" title="Replace Up next with this queue">Load</button>
                <button type="button" class="${Q_CHIP_OFF}" style="cursor:pointer;" data-sq-append="${q.at}" title="Add these videos to the end of Up next">Add</button>
                <button type="button" class="${Q_CHIP_OFF}" style="cursor:pointer;" data-sq-del="${q.at}" title="Delete (click twice)">\u2715</button>
            </div>`;
        }).join('');
    }

    function wireQueueSettings(panel) {
        const q = sel => panel.querySelector(sel);
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
        bind('#sq-fresh', 'freshEvery', el => Math.max(0, parseInt(el.value, 10) || 0));
        bind('#sq-fresh-fs', 'freshEveryFs', el => Math.max(0, parseInt(el.value, 10) || 0));
        q('#sq-tag').onchange = () => { queueSettings.tagFilter = q('#sq-tag').value; saveQueueSettings(); };

        q('#sq-generate').onclick = () => {
            queueSettings.tagFilter = q('#sq-tag').value;
            saveQueueSettings();
            const generated = generateSmartQueue(queueSettings)
                .filter(c => !manuallyAddedIds.has(c.id))
                .map(c => ({ id: c.id, href: knownHrefForId(c.id), meta: resolveQueueMeta(c.id) }));
            // Hand-added videos that were already played stay out; the new queue starts unplayed.
            const played = new Set(smartQueueItems.slice(0, queueCursor + 1).map(it => it.id));
            const added = [...manuallyAddedIds].filter(id => !played.has(id)).map(id => {
                const existing = smartQueueItems.find(it => it.id === id);
                return { id, href: existing?.href || knownHrefForId(id), meta: resolveQueueMeta(id) };
            });
            if (smartQueueItems.length) snapshotQueue(`Before "Fill from your playlists" \u2022 ${smartQueueItems.length} videos`);
            smartQueueItems = [...added, ...generated];
            queueCursor = -1;
            dismissedCurrentId = null;
            queueHistoryShown = QUEUE_HISTORY_SHOWN;
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

        const prevList = q('#sq-prev-list');
        if (prevList) prevList.onclick = e => {
            const b = e.target.closest('[data-sq-prev]');
            if (!b) return;
            e.preventDefault(); e.stopPropagation();
            restoreQueueSnapshot(loadPrevQueues()[+b.dataset.sqPrev]);
        };

        const savedList = q('#sq-saved-list');
        const redrawSaved = () => { if (savedList) savedList.innerHTML = savedQueuesHtml(); };
        const copyItems = items => items.filter(it => it?.id).map(it => ({ id: it.id, href: it.href, meta: it.meta ? { ...it.meta } : {} }));
        const saveBtn = q('#sq-save');
        if (saveBtn) saveBtn.onclick = () => {
            const items = copyItems(smartQueueItems.slice(Math.max(0, queueCursor)));
            if (!items.length) { toast('Up next is empty'); return; }
            const input = q('#sq-save-name');
            const name = (input.value || '').trim() || `Queue ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
            const list = loadSavedQueues().filter(x => x.name !== name);
            if (list.length >= SAVED_QUEUES_MAX) { toast(`${SAVED_QUEUES_MAX} saved queues: delete one first`, 'red'); return; }
            list.unshift({ name, at: Date.now(), items });
            if (!storeSavedQueues(list)) { toast('Could not save (storage full)', 'red'); return; }
            input.value = '';
            redrawSaved();
            toast(`\u2713 Saved "${name}" (${items.length} videos)`, 'green');
        };
        if (savedList) savedList.onclick = e => {
            const b = e.target.closest('button');
            if (!b) return;
            e.preventDefault();
            e.stopPropagation();
            const list = loadSavedQueues();
            // By save time, not position: another tab may have changed the list since it was drawn.
            const at = b.dataset.sqLoad ?? b.dataset.sqAppend ?? b.dataset.sqDel;
            const idx = list.findIndex(x => String(x.at) === at);
            const saved = list[idx];
            if (!saved) return;
            if (b.dataset.sqDel !== undefined) {
                if (b.dataset.armed !== '1') {
                    b.dataset.armed = '1'; b.textContent = 'Delete?';
                    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = '\u2715'; } }, 3000);
                    return;
                }
                list.splice(idx, 1);
                storeSavedQueues(list);
                redrawSaved();
                return;
            }
            const items = copyItems(saved.items);
            if (b.dataset.sqLoad !== undefined) {
                if (upcomingCount() > 0 && b.dataset.armed !== '1') {
                    b.dataset.armed = '1'; b.textContent = 'Replace?';
                    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Load'; } }, 3000);
                    return;
                }
                if (smartQueueItems.length) snapshotQueue(`Replaced by "${saved.name}" \u2022 ${smartQueueItems.length} videos`);
                smartQueueItems = items;
                queueCursor = -1;
                dismissedCurrentId = null;
                queueHistoryShown = QUEUE_HISTORY_SHOWN;
            } else {
                const have = new Set(smartQueueItems.map(it => it.id));
                smartQueueItems = smartQueueItems.concat(items.filter(it => !have.has(it.id)));
            }
            // Loaded videos count as added by hand, so auto-refill never swaps them out.
            items.forEach(it => manuallyAddedIds.add(it.id));
            smartQueueActive = true;
            toast(b.dataset.sqLoad !== undefined ? `Loaded "${saved.name}" (${items.length} videos)` : `Added "${saved.name}" to Up next`, 'green');
            renderQueueSidebar();
        };
    }

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

    // --- Up next refill ---
    function scoreRecommendedCandidate(id, card, tagScores) {
        const meta = State.videoMeta.get(id);
        if (meta) {
            const tagScore = (meta.tags || []).reduce((sum, t) => sum + (tagScores.get(t) || 0), 0);
            return tagScore + (meta.bayesianRating || 0) / 20;
        }
        return (scrapeCardMeta(card).bayesianRating ?? 50) / 20;
    }

    function topUpQueueFromRecommended() {
        const targetSize = queueSettings.targetSize;
        // Only items still ahead count toward the target.
        if (!smartQueueActive || !queueSettings.autoRefill || upcomingCount() >= targetSize) return;
        const container = findVisibleRecommendedContainer();
        if (!container) return;

        const existingIds = new Set(smartQueueItems.map(it => it.id));
        const useFilter = queueSettings.useNfFilter && filterIsMeaningful();
        const candidates = [];
        let rejected = 0;
        const tagScores = computeTagAffinity(); // loops over all known videos: once per top-up, not per card
        container.querySelectorAll('.w-40').forEach(thumbDiv => {
            const card = thumbDiv.parentElement;
            if (!card) return;
            const slugId = resolveRecCardVideoId(card);
            if (!slugId) return;
            const apiId = State.slugToApiId.get(slugId) || slugId;
            if (existingIds.has(apiId)) return;
            const meta = resolveQueueMeta(apiId, card);
            if (useFilter && !passesFilter(apiId, meta)) { rejected++; return; }
            candidates.push({ id: apiId, href: cardHref(card), meta, score: scoreRecommendedCandidate(apiId, card, tagScores) });
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
                const shown = new Set(order);
                const cursorId = smartQueueItems[queueCursor]?.id;
                // Collapsed played rows are not in the DOM: keep them in front, else a drag deletes them.
                smartQueueItems = [...smartQueueItems.filter(it => !shown.has(it.id)), ...order.map(id => byId.get(id)).filter(Boolean)];
                const currentId = getCurrentVideoId();
                const moved = smartQueueItems.findIndex(it => it.id === currentId);
                queueCursor = moved !== -1 ? moved : smartQueueItems.findIndex(it => it.id === cursorId);
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
    // --- Playlist-page filter applied to the queue ---
    // Applies the playlist-page filter's saved settings to queue candidates; unknown values never filter.
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


    // Filter summary, plus how many candidates the last refill rejected (a tight filter leaves the queue short).
    let lastFilteredOut = 0;

    function filterSummary() {
        const c = filterConfig;
        const bits = [];
        const terms = filterTerms(c.exclude).length + filterTerms(c.include).length;
        if (terms) bits.push(`${terms} term${terms === 1 ? '' : 's'}`);
        const models = filterTerms(c.modelsExclude).length + filterTerms(c.modelsInclude).length;
        if (models) bits.push(`${models} model${models === 1 ? '' : 's'}`);
        if (c.ratingMin > 0 || c.ratingMax < 100) bits.push(`${c.ratingMin}-${c.ratingMax}%`);
        if (c.maxMinutes > 0) bits.push(`max ${c.maxMinutes}m`);
        if (c.seen !== 'any') bits.push(c.seen);
        if (c.playlistMode !== 'all') bits.push(c.playlistMode === 'in' ? 'in playlist' : 'not in playlist');
        if (c.savedSearchName) bits.push(`"${c.savedSearchName}"`);
        return bits.length ? ` (${bits.join(', ')})` : ' (nothing set)';
    }


    const Q_INPUT = 'background:#0F0F0F;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#fff;padding:3px 6px;font:inherit;';


    // Previous queues: Up next before a clear or replace, newest first, in localStorage (QUEUE_PREV_MAX,
    // QUEUE_PREV_MAX_AGE_MS), so a cleared queue can come back after the Undo is gone.
    const QUEUE_PREV_KEY = 'pmv_queue_prev_v1';
    const QUEUE_PREV_MAX = 10;
    const QUEUE_PREV_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
    try {
        const old = JSON.parse(localStorage.getItem('pmv_queue_undo_v1') || 'null');
        if (old?.items?.length) {
            const a = JSON.parse(localStorage.getItem('pmv_queue_prev_v1') || '[]');
            localStorage.setItem('pmv_queue_prev_v1', JSON.stringify([old, ...(Array.isArray(a) ? a : [])]));
        }
        localStorage.removeItem('pmv_queue_undo_v1');
    } catch {}
    const queueSig = items => items.map(it => it.id).join(',');


    // Saved queues: named Up next copies in localStorage until deleted (the auto backup only bridges a restart).
    const SAVED_QUEUES_KEY = 'pmv_saved_queues_v1';
    const SAVED_QUEUES_MAX = 20;


    // Links use `oldId` when present, else `_id`; API responses and __NUXT_DATA__ carry both, so slug -> _id
    // mappings are learned without per-card lookups. Returns the number of new mappings.
    const HEX24_RE = /^[0-9a-f]{24}$/i;


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
            State.refreshEdits?.push([playlistId, videoId, true]);
            saveCacheSoon();
            refreshQueuePlaylistChips(videoId);
            invalidateCardBadges(videoId);
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
        State.refreshEdits?.push([playlistId, videoId, false]);
        saveCacheSoon();
        refreshQueuePlaylistChips(videoId);
        invalidateCardBadges(videoId);
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
        // In fullscreen the bar is only built on fullscreenchange, so rebuild it here.
        if (document.fullscreenElement) createProgressBar();

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
        const makeTagSwitch = (el, tag, neutralStyle, render, kind) => {
            el.dataset.pmvTagChip = tag;
            const paint = () => {
                const state = tagFilterState(tag, kind);
                el.style.cssText = TAG_STYLE_BASE + neutralStyle + (TAG_STATE_STYLE[state] || '');
                el.title = TAG_STATE_TITLE[state];
                render(state);
            };
            paint();
            el.addEventListener('click', e => {
                e.stopPropagation();
                cycleTagInFilter(tag, kind);
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
                state => { nameSpan.textContent = (state === 'exclude' ? '⊘ ' : '') + star; }, 'stars');
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
    // --- Native playlist button highlight ---

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
            if (btn.dataset.pmvPlaylistButton !== '1') btn.dataset.pmvPlaylistButton = '1';
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

        injectPagePlaylistButtons(videoId);
    }


    function injectPagePlaylistButtons(videoId) {
        if (!location.pathname.startsWith('/video/') && !location.pathname.startsWith('/playlists/')) return;
        if (!State.ready || !videoId) return;

        const nativeBar = nativeActionBar();
        if (!nativeBar) return;
        ensureRejectBarButton(videoId, nativeBar);

        const existing = document.getElementById('pmv-page-playlists');
        if (existing) {
            if (existing.dataset.forVideo === videoId) {
                existing.querySelectorAll('[data-pmv-pl-btn]').forEach(b => {
                    const plId = b.dataset.pmvPlBtn;
                    const inPl = State.playlists.get(plId)?.ids.has(videoId) || false;
                    applyPageBtnStyle(b, inPl);
                });
                return;
            }
            existing.remove();
        }

        // Own row below the native bar, in the same grid parent.
        const wrap = document.createElement('div');
        wrap.id = 'pmv-page-playlists';
        wrap.dataset.forVideo = videoId;
        wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;margin-top:8px;grid-column:1/-1;';

        // The reject list is the ⊘ in the action bar, not a playlist button.
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
            lbl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
            lbl.textContent = displayName;
            b.appendChild(lbl);
            syncPageBtnKey(b, pl.id);

            b.addEventListener('click', async e => {
                e.stopPropagation();
                b.disabled = true;
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

    // Same toggle as the ⊘ on cards (no skip, unlike the hotkey). Vue owns the bar, so the
    // heartbeat re-inserts it after a rebuild.
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
        const flag = on ? '1' : '';
        const title = on ? 'Rejected — click to remove from the reject list' : 'Reject (move to the reject list, remove from every other playlist)';
        if (btn.dataset.on !== flag) btn.dataset.on = flag;
        if (btn.title !== title) btn.title = title;
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
    // Compact tag menu instead of the site's Vote on Tags modal; also on playlist pages, which lack that button.
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

    // The site's "Vote on Tags" buttons open the compact tag menu too; Shift+click keeps the modal.
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

    // At the start of the action bar: ⊘ (with a reject list), Tags, Models, open-page (playlist pages).
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

        let ext = pageOwn('[data-pmv-open-page]');
        if (ok && location.pathname.startsWith('/playlists/')) {
            if (!ext || ext.parentElement !== bar || ext.dataset.forVideo !== videoId) { ext?.remove(); ext = openPageBarButton(videoId); }
            want.push(ext);
        } else ext?.remove();

        if (!ok) return;
        // Move only when out of place.
        want.forEach((el, i) => { if (bar.children[i] !== el) bar.insertBefore(el, bar.children[i] || null); });
    }

    // Key cap: first hotkey bound to the playlist; negative margins into the padding fill the pill's height.
    function playlistHotkeys(plId) {
        return Object.keys(keybindings)
            .filter(k => keybindings[k]?.action === 'playlist' && keybindings[k].playlistId === plId)
            .sort();
    }
    function syncPageBtnKey(btn, plId) {
        const keys = playlistHotkeys(plId);
        let cap = btn.querySelector('[data-pmv-plkey]');
        // The label takes the rest, so the cap sits at the right edge.
        const lbl = btn.querySelector('span');
        if (lbl) { lbl.style.flex = keys.length ? '1 1 auto' : ''; lbl.style.textAlign = keys.length ? 'center' : ''; }
        // Up to 24px wider for the cap, so a long label keeps its 82px of room.
        btn.style.width = keys.length ? 'auto' : '82px';
        btn.style.minWidth = keys.length ? '82px' : '';
        btn.style.maxWidth = keys.length ? '106px' : '';
        if (!keys.length) { cap?.remove(); return; }
        if (!cap) {
            cap = document.createElement('kbd');
            cap.dataset.pmvPlkey = '1';
            cap.style.cssText = 'flex:0 0 auto;display:inline-block;min-width:24px;height:24px;padding:0 4px;margin:-3px -4px -3px 4px;box-sizing:border-box;border-radius:4px;border:1px solid currentColor;background:rgba(255,255,255,0.06);font:700 13px/22px system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;font-variant-numeric:tabular-nums;opacity:0.8;';
        }
        // The button may be styled before its label is added.
        if (btn.lastElementChild !== cap) btn.appendChild(cap);
        const k = keys[0];
        cap.textContent = k.length === 1 ? k.toUpperCase() : k.slice(0, 3);
        btn.title = (State.playlists.get(plId)?.name || '') + ' \u2014 key ' + keys.map(x => x.toUpperCase()).join(', ');
    }

    function applyPageBtnStyle(btn, active) {
        const plId = btn.dataset.pmvPlBtn;
        const name = State.playlists.get(plId)?.name || '';
        btn.title = name;
        const lbl = btn.querySelector('span');
        if (lbl) lbl.textContent = getPlaylistDisplayName(name, plId);
        syncPageBtnKey(btn, plId);

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

    // --- Site-wide filter ---
    // Own filter, editable from the header on any page: the header button switches it on, the panel edits it.
    const FILTER_KEY = 'pmv_filter_v1';
    const FILTER_DEFAULTS = {
        active: false,
        exclude: '',       // space separated, "quoted" phrases ok; title, tags, music, uploader (not models)
        include: '',
        modelsExclude: '', // same syntax, matched only against models (starsTags)
        modelsInclude: '',
        ratingMin: 0,
        ratingMax: 100,
        maxMinutes: 0,     // 0 = no cap
        playlistMode: 'all',
        playlistIds: [],
        seen: 'any',       // 'any' | 'seen' | 'unseen'
        savedSearch: null,
        savedSearchName: '',
        flags: {},          // content flag key -> 'out' (hide) | 'in' (only these)
        bigPages: false,   // raise the site's page size to its max
        mergeGrids: true,
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

    // Site saved searches use the playlist-page filter's rules, so one setup works everywhere.
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

    // Plain words match anywhere; "quoted" (smart quotes too) or =word: whole word only, stored as "=term".
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

    const filterKeys = kind => (kind === 'star' || kind === 'stars') ? ['modelsInclude', 'modelsExclude'] : ['include', 'exclude'];
    function tagFilterState(tag, kind) {
        const t = String(tag).toLowerCase().trim();
        const [inc, exc] = filterKeys(kind);
        if (filterTerms(filterConfig[inc]).includes(t)) return 'include';
        if (filterTerms(filterConfig[exc]).includes(t)) return 'exclude';
        return null;
    }

    // Exclude term (or saved-search tag) this tag would trip, or null; the tag menu warns with it.
    function tagHiddenBy(tag, kind = 'general') {
        if (!filterConfig.active) return null;
        const t = String(tag).toLowerCase().trim();
        if (!t) return null;
        const term = filterTerms(filterConfig[filterKeys(kind)[1]]).find(x => PMVX.termMatch(t, x));
        if (term) return PMVX.termLabel(term);
        if (kind !== 'stars' && filterConfig.savedSearch?.excludeTags?.includes(t)) return t;
        return null;
    }

    // Click cycles: off -> required -> excluded -> removed. Adding switches hiding on; removing leaves it.
    const TAG_CYCLE = { null: 'include', include: 'exclude', exclude: null };
    function cycleTagInFilter(tag, kind) {
        const t = String(tag).toLowerCase().trim();
        if (!t) return null;
        return setTagInFilter(t, TAG_CYCLE[tagFilterState(t, kind)], kind);
    }
    // next: 'include' | 'exclude' | null (remove); kind 'star' uses the model lists.
    function setTagInFilter(tag, next, kind) {
        const t = String(tag).toLowerCase().trim();
        if (!t) return null;
        const [incKey, excKey] = filterKeys(kind);
        const include = filterTerms(filterConfig[incKey]).filter(x => x !== t);
        const exclude = filterTerms(filterConfig[excKey]).filter(x => x !== t);
        if (next === 'include') include.push(t);
        if (next === 'exclude') exclude.push(t);
        filterConfig[incKey] = joinFilterTerms(include);
        filterConfig[excKey] = joinFilterTerms(exclude);
        if (next) filterConfig.active = true;
        saveFilterConfig();
        applyFilterToCards();
        // The playlist-page filter has no model lists: plain terms only.
        if (incKey === 'include') setNfDefaultTag(t, next);
        document.getElementById('pmv-filter-panel')?.refresh?.();
        return next;
    }

    // Tag menu hook (tags, stars, music artists).
    PMVX.tagFilter = { state: (t, kind) => tagFilterState(t, kind), set: (t, next, kind) => setTagInFilter(t, next, kind) };

    // One-time migration: plain terms that are a model name (and not a tag) move to the model lists.
    const MODELS_MIGRATED_KEY = 'pmv_filter_models_migrated_v1';
    (function migrateModelTerms() {
        try { if (localStorage.getItem(MODELS_MIGRATED_KEY)) return; } catch { return; }
        const plain = [...filterTerms(filterConfig.include), ...filterTerms(filterConfig.exclude)];
        if (!plain.length) { try { localStorage.setItem(MODELS_MIGRATED_KEY, '1'); } catch {} return; }
        setTimeout(async () => {
            const [stars, tags] = await Promise.all([popularTags('stars'), popularTags('general')]);
            if (!stars?.length) return; // try again next load
            const starSet = new Set(stars.map(n => n.toLowerCase())), tagSet = new Set((tags || []).map(n => n.toLowerCase()));
            const isModel = t => { const l = PMVX.termLabel(t); return starSet.has(l) && !tagSet.has(l); };
            let moved = 0;
            [['include', 'modelsInclude'], ['exclude', 'modelsExclude']].forEach(([from, to]) => {
                const all = filterTerms(filterConfig[from]);
                const m = all.filter(isModel);
                if (!m.length) return;
                moved += m.length;
                filterConfig[from] = joinFilterTerms(all.filter(t => !isModel(t)));
                filterConfig[to] = joinFilterTerms([...filterTerms(filterConfig[to]), ...m.filter(t => !filterTerms(filterConfig[to]).includes(t))]);
            });
            try { localStorage.setItem(MODELS_MIGRATED_KEY, '1'); } catch {}
            if (moved) { saveFilterConfig(); applyFilterToCards(); document.getElementById('pmv-filter-panel')?.refresh?.(); }
        }, 4000);
    })();

    // Also written to the playlist-page filter's fixed terms (storage + refilter event), replacing earlier tokens like -trans(0.1).
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
            || filterTerms(c.modelsExclude).length > 0
            || filterTerms(c.modelsInclude).length > 0
            || c.ratingMin > 0 || c.ratingMax < 100
            || c.maxMinutes > 0
            || c.playlistMode !== 'all'
            || c.seen !== 'any'
            || !!c.savedSearch
            || Object.values(c.flags || {}).some(Boolean);
    }

    // Content flag of a video, or undefined when unknown (then it never hides). Vertical falls back to stored size.
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

    // Unknown flags: GET /api/videos/bulk?ids=… (≤100 ids, full docs), one call at a time, pause between
    // calls, longer on HTTP 429; each id once per page load. onDone runs when the queue empties.
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
    // Same queue for full tag/model lists: playlist data carries only 5 tags.
    const fullTried = new Set();
    PMVX.fetchFullMeta = (ids, onDone) => {
        let added = 0;
        ids.forEach(id => {
            if (!id || fullTried.has(id) || State.videoMeta.get(id)?.full) return;
            fullTried.add(id); flagQueue.add(id); added++;
        });
        if (onDone && (added || flagFetching)) flagDone.add(onDone);
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

    // `meta` is read off the card, the cache fills the rest. Unknown data never hides a video.
    function passesFilter(id, meta, c = filterConfig) {
        return filterReasons(id, meta, c, false).length === 0;
    }

    // Block reasons as short labels ("⊘ term", "rating 41%" …); all=false stops at the first.
    function filterReasons(id, meta, c = filterConfig, all = true) {
        const out = [];
        const hit = label => { out.push(label); return !all; };
        const cached = id ? State.videoMeta.get(id) : null;
        const title = (meta?.title || cached?.title || '').toLowerCase();
        const uploader = (meta?.uploaderDisplay || cached?.uploaderDisplay || '').toLowerCase();
        // Tags from cache (complete, fetched videos only) plus card (what it shows): neither alone suffices.
        const tags = [...new Set([
            ...(meta?.tags || []),
            ...(cached?.tags || []),
            ...(cached?.music || []),
        ].map(t => String(t).toLowerCase()))];
        const haystacks = [title, uploader, ...tags];

        for (const term of filterTerms(c.exclude)) if (haystacks.some(h => PMVX.termMatch(h, term)) && hit('\u2298 ' + PMVX.termLabel(term))) return out;
        for (const term of filterTerms(c.include)) if (!haystacks.some(h => PMVX.termMatch(h, term)) && hit('needs ' + PMVX.termLabel(term))) return out;

        const mExc = filterTerms(c.modelsExclude), mInc = filterTerms(c.modelsInclude);
        if ((mExc.length || mInc.length) && Array.isArray(cached?.starsTags)) {
            const models = cached.starsTags.map(m => String(typeof m === 'string' ? m : m?.name || '').toLowerCase()).filter(Boolean);
            for (const term of mExc) if (models.some(h => PMVX.termMatch(h, term)) && hit('\u2298 model ' + PMVX.termLabel(term))) return out;
            for (const term of mInc) if (!models.some(h => PMVX.termMatch(h, term)) && hit('needs model ' + PMVX.termLabel(term))) return out;
        }

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
            // Same partial tag picture: an excluded tag the card doesn't show can't be caught.
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

    // Hide via a stylesheet rule on a data-* flag: Vue re-renders wipe inline styles but keep data attributes.
    function ensureFilterStyle() {
        if (document.getElementById('pmv-filter-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-filter-style';
        st.textContent = '[data-pmv-filtered="1"]{display:none !important;}';
        (document.head || document.documentElement).appendChild(st);
    }

    let filterHiddenCount = 0;
    // Hidden here: id -> { title, href, thumb, reasons }, plus every judged card. Off-DOM: the site prunes hidden cards.
    const filterHiddenLog = new Map();
    const filterSeen = new Set();
    let filterLogPath = location.pathname + location.search;
    function resetFilterLog() { filterHiddenLog.clear(); filterSeen.clear(); filterLogPath = location.pathname + location.search; }

    // Marks/unmarks (never removes) cards in grids (data-video-id), Recommended (.w-40) and "More from". Throttled
    // (observer calls up to once a frame): filter off touches only marked cards; cards are stamped with their judged id so
    // only new/changed ones are judged; full pass at most 1/s or on a direct call; card scrapes cached per card+id (WeakMap).
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
        // Up next rows show block reasons; re-render them on change.
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
            // Up next rows are never hidden, only labelled with the reason.
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

        const flagKeys = Object.keys(filterConfig.flags || {}).filter(k => filterConfig.flags[k]);
        if (flagKeys.length && full) {
            const ids = [...filterSeen].filter(k => /^[a-f0-9]{24}$/.test(k));
            PMVX.fetchFlags(ids, flagKeys, () => { filterFullPassAt = 0; applyFilterToCards(true); });
        }
    }

    const FILTER_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>';

    // Buttons sit in a body-level bar pinned over the header's control row (which gets extra padding). Not in
    // the row itself: Vue manages it (v-if placeholders filled after hydration), so injected nodes misplace.
    const HEADER_GAP_PX = 104;  // divider, both buttons, spacing

    const QUEUE_BADGE_HTML =
        '<span data-pmv-queue-count style="position:absolute;top:0;right:0;min-width:15px;height:15px;' +
        'line-height:15px;padding:0 3px;border-radius:8px;background:rgb(100,255,0);color:#000;' +
        'font-size:10px;font-weight:700;text-align:center;"></span>';


    function ensureHeaderStyle() {
        if (document.getElementById('pmv-headroom-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-headroom-style';
        // Padding, not margin (flex row: box stays); keyed on a data attribute as Vue rewrites class/style. --pmv-headroom = bar width.
        st.textContent = `[data-pmv-headroom="1"]{padding-right:calc(var(--pmv-headroom, ${HEADER_GAP_PX}px) + 16px) !important;}`;
        (document.head || document.documentElement).appendChild(st);
    }

    // Mobile and desktop headers both exist; the visible one has width. Layout cached; redone if the row is gone, on resize or ResizeObserver.
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
            // Above the header (z-50), below the site's modals.
            bar.style.cssText = 'position:fixed;z-index:60;display:flex;align-items:center;gap:12px;';
            const divider = document.createElement('span');
            divider.setAttribute('data-pmv-header-divider', '1');
            divider.style.cssText = 'width:1px;height:20px;background:rgba(255,255,255,0.12);flex-shrink:0;pointer-events:none;';
            bar.appendChild(divider);
            document.body.appendChild(bar);
            // Counter text changes the bar width: keep the reserved room in step.
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
        const w = Math.max(HEADER_GAP_PX, Math.ceil(bar.offsetWidth || 0));
        const room = w + 'px';
        if (document.documentElement.style.getPropertyValue('--pmv-headroom') !== room) document.documentElement.style.setProperty('--pmv-headroom', room);
        // Right-anchored, so a wider bar grows to the left.
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
        document.querySelectorAll('[data-pmv-hidden-btn], [data-pmv-filter-btn], [data-pmv-queue-btn]').forEach(btn => {
            if (!bar.contains(btn)) btn.remove();
        });
        updateFilterButton();
        updateQueueButton();
    }

    function attachFilterButton() { ensureHeaderButtons(); }

    // SVG presentation attributes, not CSS color: inline `color !important` still computes to the site's grey.
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

    // Hidden cards' images often never load (lazy, display:none): use cached video data.
    function cardThumbUrl(el, id, meta) {
        const img = el.querySelector('img');
        const fromImg = img && (img.currentSrc || img.getAttribute('src') || img.dataset?.src || (img.getAttribute('srcset') || '').split(/\s+/)[0]);
        const ok = u => u && !u.startsWith('data:') ? u : '';
        return ok(fromImg) || ok(meta?.thumbnailUrl) || (id ? ok(State.videoMeta.get(id)?.thumbnailUrl) || ok(resolveQueueMeta(id)?.thumbnailUrl) : '') || '';
    }

    // Hidden videos grouped by reason, one foldable row each, largest first (ratings/lengths share a row).
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

    // --- Site-wide filter panel ---
    // Styled like the playlist-page filter drawer; edits stage in a draft until Apply, the on/off switch acts at once.
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
#pmv-filter-panel .gf-tag .star{display:inline-flex;color:rgb(250,204,21);}
#pmv-filter-panel .gf-tag.pos.model{background:rgba(234,179,8,0.18);color:rgb(253,224,71);}
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

    // Site-style select. items(): [{ value, title, sub }]; multi keeps the list open.
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

    // Dual slider 0..max with pill and presets. get() -> [a, b]; set(a, b).
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

    // Plain values for the playlist-page filter's "Sync from site filter".
    PMVX.siteFilterSnapshot = () => ({
        include: filterTerms(filterConfig.include), exclude: filterTerms(filterConfig.exclude),
        modelsInclude: filterTerms(filterConfig.modelsInclude), modelsExclude: filterTerms(filterConfig.modelsExclude),
        active: !!filterConfig.active,
        seen: filterConfig.seen, playlistMode: filterConfig.playlistMode, playlistIds: (filterConfig.playlistIds || []).slice(),
        ratingMin: filterConfig.ratingMin, ratingMax: filterConfig.ratingMax, maxMinutes: filterConfig.maxMinutes,
        flags: { ...(filterConfig.flags || {}) },
    });

    function toggleFilterPanel(anchorBtn) {
        const existing = document.getElementById('pmv-filter-panel');
        if (existing) { existing.remove(); closeGfDropdown(); return; }
        ensureGfStyle();

        // On document.body, outside Vue's tree, so header re-renders can't remove the open panel.
        const box = document.createElement('div');
        box.id = 'pmv-filter-panel';
        const r = anchorBtn.getBoundingClientRect();
        box.style.top = Math.round(r.bottom + 8) + 'px';
        box.style.left = Math.round(Math.max(8, Math.min(r.right - 360, window.innerWidth - 368))) + 'px';
        document.body.appendChild(box);

        let d = JSON.parse(JSON.stringify(filterConfig));
        const sigOf = c => JSON.stringify({ ...c, active: null });
        const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
        const sec = (label, hint) => { const s2 = mk('div', 'gf-sec'); s2.appendChild(mk('div', 'gf-lab', label)); if (hint) s2.dataset.hint = hint; return s2; };
        let status = () => {};
        const refreshPending = () => { const p = sigOf(d) !== sigOf(filterConfig); applyBtn.classList.toggle('pending', p); applyBtn.textContent = p ? 'Apply' : 'Applied'; };

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

        // Term chips: Enter adds, click toggles whole word, × removes.
        const termSection = (key, label, placeholder, kind, other, model = false) => {
            const s2 = sec(label);
            const inp = mk('input'); inp.type = 'text'; inp.placeholder = placeholder; inp.spellcheck = false;
            const chips = mk('div', 'gf-chips');
            const draw = () => {
                chips.textContent = '';
                filterTerms(d[key]).forEach((t, i, all) => {
                    const c = mk('span', 'gf-tag ' + kind + (model ? ' model' : ''));
                    if (kind === 'neg') { const ic = mk('span'); ic.innerHTML = GF_SVG.ban; ic.style.display = 'inline-flex'; c.appendChild(ic); }
                    if (model) { const ic = mk('span', 'star'); ic.innerHTML = STAR_SVG; c.appendChild(ic); }
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
                e.stopPropagation(); // keep site/script hotkeys out
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = inp.value.trim();
                    if (!v) { applyBtn.click(); return; }
                    const add = filterTerms(v);
                    const cur = filterTerms(d[key]);
                    add.forEach(t => { if (!cur.includes(t)) cur.push(t); });
                    d[key] = joinFilterTerms(cur);
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
        const sExc = termSection('exclude', 'Exclude', 'Hide videos with… (title, tag, music, uploader)', 'neg', 'include');
        const sInc = termSection('include', 'Require', 'Only videos with…', 'pos', 'exclude');
        const sMExc = termSection('modelsExclude', 'Exclude models', 'Hide videos with model…', 'neg', 'modelsInclude', true);
        const sMInc = termSection('modelsInclude', 'Require models', 'Only videos with model…', 'pos', 'modelsExclude', true);
        const drawAllTerms = () => { sExc.draw(); sInc.draw(); sMExc.draw(); sMInc.draw(); };
        const hint = mk('div', 'gf-hint', 'Enter adds · Backspace in an empty field removes the last one · "quotes" or a click on a term: whole word only');
        body.append(sExc, sInc, sMExc, sMInc, hint);

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

        // Content flags cycle: off -> hide (⊘) -> only (✓) -> off.
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

        const sRate = sec('Rating');
        sRate.appendChild(gfRange({
            max: 100,
            get: () => [d.ratingMin || 0, d.ratingMax ?? 100],
            set: (a, b) => { d.ratingMin = a; d.ratingMax = b; refreshPending(); },
            fmt: (v, side) => side === 'b' && v >= 100 ? 'Any' : v + '%',
            presets: [{ t: 'Any', a: 0, b: 100 }, { t: '90%+', a: 90, b: 100 }, { t: '80%+', a: 80, b: 100 }, { t: '70%+', a: 70, b: 100 }, { t: '50-80%', a: 50, b: 80 }],
        }));
        body.appendChild(sRate);

        // Length: maximum only (0..60 min, 60 = any); lower handle hidden.
        const sLen = sec('Max length');
        const LEN_ANY = 60;
        const lenWrap = gfRange({
            max: LEN_ANY,
            get: () => [0, d.maxMinutes > 0 ? Math.min(d.maxMinutes, LEN_ANY) : LEN_ANY],
            set: (a, b) => { d.maxMinutes = b >= LEN_ANY ? 0 : b; refreshPending(); },
            fmt: (v, side) => side === 'b' && v >= LEN_ANY ? 'Any' : v + 'm',
            presets: [{ t: 'Any', a: 0, b: LEN_ANY }, { t: '≤5m', a: 0, b: 5 }, { t: '≤10m', a: 0, b: 10 }, { t: '≤20m', a: 0, b: 20 }, { t: '≤30m', a: 0, b: 30 }],
        });
        lenWrap.querySelectorAll('input[type=range]')[0].style.display = 'none';
        sLen.appendChild(lenWrap);
        body.appendChild(sLen);

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
            // Keep what the site had before we changed it, so syncSitePrefs can give it back.
            filterConfig = { ...FILTER_DEFAULTS, siteInfiniteWas: filterConfig.siteInfiniteWas, sitePageSizeWas: filterConfig.sitePageSizeWas };
            saveFilterConfig(); syncSitePrefs(); applyFilterToCards(); reopen();
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
            saveFilterConfig(); applyFilterToCards(); reopen();
        };
        refreshPending();
        // External changes (a tag clicked in the HUD) redraw the open panel.
        box.refresh = () => { d = JSON.parse(JSON.stringify(filterConfig)); reopen(); };

        // Deferred: binding now would catch the opening click.
        setTimeout(() => {
            const onDocClick = e => {
                if (!box.isConnected) { document.removeEventListener('click', onDocClick); return; }
                // composedPath: a chip redrawn by its own click is no longer in the box.
                const path = e.composedPath ? e.composedPath() : [];
                if (path.includes(box) || box.contains(e.target) || !e.target.isConnected || e.target.closest('[data-pmv-filter-btn], .pmv-gf-dd')) return;
                closeGfDropdown();
                if (!e.target.closest('.gf-sel')) { box.remove(); document.removeEventListener('click', onDocClick); }
            };
            document.addEventListener('click', onDocClick);
        }, 0);
    }

    // --- Homepage state across Back / Forward ---
    // The site's homepage resets its filters and page on return. Its saved-search component's props getCurrentFilters()
    // and onLoad(filters) (found via Vue's vnode tree from #__nuxt) let us keep filters, depth, page and scroll per tab
    // (sessionStorage) and restore them on Back/Forward, not on a fresh visit. Logged in only: the component needs it.
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
    // Copy of "Saved Searches" next to "More Filters" (the site hides it in the folded panel); it clicks the
    // original to open the site's dialog. Vue owns the row, so a 1 s check re-inserts it.
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
    setInterval(() => { if (!document.hidden) { try { ensureSavedSearchShortcut(); } catch {} } }, 1000);

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
            let pr = null;
            for (let i = 0; i < 40 && isHomePath() && !(pr = homeFilterProps()); i++) await wait(250);
            if (!pr || !isHomePath()) return;
            const now = JSON.stringify(pr.getCurrentFilters() || {});
            if (now !== JSON.stringify(saved.filters || {})) {
                pr.onLoad(saved.filters || {});
                await wait(600);
            }
            // Same depth: pages mode → saved page; autoscroll → load batches until the count is back.
            const paging = siteListPaging();
            if (paging && !paging.infinite && saved.page > 1) {
                for (let i = 0; i < 20 && siteListPaging()?.pending; i++) await wait(250);
                const btn = [...document.querySelectorAll('nav[aria-label="Pagination"] button, [aria-label="Pagination"] button')]
                    .find(b => b.textContent.trim() === String(saved.page));
                btn?.click();
                await wait(800);
            } else if (saved.count > homeListCount()) {
                const target = Math.min(saved.count, 100); // the site keeps ~100 cards
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
    // Capture before the route changes (homepage still mounted), on link clicks and regularly.
    (() => {
        PMVX.beforeRoute(() => { try { captureHomeState(); } catch {} });
        document.addEventListener('click', e => { if (e.target.closest?.('a[href]')) { try { captureHomeState(); } catch {} } }, true);
        setInterval(() => { if (isHomePath() && !document.hidden) { try { captureHomeState(); } catch {} } }, 2000);
        window.addEventListener('pagehide', () => { try { captureHomeState(); } catch {} });
        // popstate fires before the router renders the homepage: hold capture off so the reset page isn't saved.
        window.addEventListener('popstate', () => {
            homeBackNav = true;
            homeRestoring = true;
            setTimeout(() => {
                if (homeBackNav && isHomePath()) restoreHomeState(); else homeRestoring = false;
                homeBackNav = false;
            }, 50);
        });
        // A Back that reloads (bfcache miss) is a back_forward navigation.
        try {
            const nav = performance.getEntriesByType('navigation')[0];
            if (nav?.type === 'back_forward' && isHomePath()) { homeRestoring = true; setTimeout(restoreHomeState, 300); }
        } catch {}
    })();

    // --- Pagination ---
    // A filter hiding most of a page breaks both modes. Autoscroll off: a page (`videosPerPage`, API cap 100) is replaced,
    // so a strict filter can leave one card; raise it. Autoscroll on: the IntersectionObserver sentinel (1000px rootMargin)
    // only reports changes, so a mostly hidden batch stalls loading; the list is windowed (100, trimmed to 60), so top-up stops below.

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

    // Nuxt keeps list paging in useState keyed by page type ($shomepage-current-page, …), surviving in-page navigation.
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

    // Container with the most cards: the list grid, not a Recommended rail or "More from" strip.
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

    // Counted from cards, not data-video-id: an unresolved card counts, so this only waits, never skips a page.
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

    // Settles the site prefs the filter depends on (read at site init: apply on next page change or reload).
    // Autoscroll + strict filter = load/filter/trim treadmill (~100 cards kept, oldest dropped), so the site is put
    // on pages while the filter hides things and the user's setting restored after. Big pages only help in that mode.
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

    // Observers only report changes: move the sentinel far off (300vh, past the 1000px margin), then into view; into view alone fails on short pages.
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

    // Prunes hidden items from the site's own list, which it trims past 100 (taking survivors along). Hidden cards
    // are display:none, so nothing moves. Autoscroll + active filter only; floor kept: an empty list drops the sentinel.
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

    // The site's own list length (what its memory limit watches), not the DOM count; they differ briefly after a prune.
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
        const final = kept.length >= PRUNE_FLOOR ? kept : list.slice(-PRUNE_FLOOR);
        if (final.length === list.length) return 0;
        try { st[key] = final; } catch { return 0; }
        return list.length - final.length;
    }

    // The site renders lists in chunked grids with ads between, leaving short rows. Merge: the parent takes the chunk
    // classes, chunks get display:contents, empty separators collapse, visible banners span the row. Classes are
    // re-applied per pass: Vue patches rewrite class, data-* survives.
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
        // Only chunks with identical classes are one list; other rails sharing the parent must not merge.
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
            // Attribute survives Vue patches and re-init.
            parent.setAttribute('data-pmv-grid-was', parent.className || '');
            parent.setAttribute('data-pmv-grid-merge', '1');
        }
        chunks[0].classList.forEach(cls => { if (!parent.classList.contains(cls)) parent.classList.add(cls); });

        [...parent.children].forEach(child => {
            if (chunks.includes(child)) {
                if (child.getAttribute('data-pmv-grid-chunk') !== '1') child.setAttribute('data-pmv-grid-chunk', '1');
                return;
            }
            // Judged by contents (an empty grid item stretches to row height), every pass so late banners get their row back.
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

        // Fewer cards than before: the site is trimming (past ~100); more would only feed that, so stop for this page.
        if (pumpState.lastCards && total < pumpState.lastCards) {
            pumpState.tries = PUMP_MAX_TRIES;
            return;
        }
        // Nothing new from a nudge: the site won't deliver (rate limit or window full); stop after two until the next page.
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
        if (visible >= below) { skipState.seen = skipState.done = 0; return; } // the max counts thin pages in a row

        // Playlist membership and ratings resolve late: skip only if still thin on a second look.
        if (++skipState.seen < 2) { setTimeout(skipThinPage, 1500); return; }
        if (skipState.done >= SKIP_MAX_PAGES) return;

        const next = [...document.querySelectorAll('button')]
            .find(b => b.textContent.trim() === '»' && !b.disabled);
        if (!next) return;
        skipState.done++;
        toast(`Page ${paging.page}: ${visible} of ${total} left — next page`);
        next.click();
    }

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
                invalidateCardBadges(id, card);
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

    // Playlist membership changed: drop the markers so the next pass redraws labels and tint.
    function invalidateCardBadges(videoId, card = null) {
        const cards = [...document.querySelectorAll('[data-video-id]')].filter(c => c.dataset.videoId === videoId);
        if (card && !cards.includes(card)) cards.push(card);
        cards.forEach(c => { c.querySelectorAll('[data-playlist-name]').forEach(el => el.remove()); delete c.dataset.pmvChecked; });
        document.querySelectorAll('[data-pmv-rec-checked], [data-pmv-mf-checked]').forEach(el => { delete el.dataset.pmvRecChecked; delete el.dataset.pmvMfChecked; });
        scheduleBadges();
        try { addMoreFromBadges(); } catch {}
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

    // --- More about this video ---
    function viVideoCard(v) {
        const r = Number(v.bayesianRating);
        const hue = Number.isFinite(r) ? Math.max(0, Math.min(120, r * 1.2)) : 0;
        const rating = Number.isFinite(r) && r > 0
            ? `<div class="inline-flex items-center gap-1 font-semibold select-none rounded-full border flex-shrink-0" style="padding:3px 6px;font-size:10px;line-height:1;background:linear-gradient(135deg, hsla(${hue} 70% 55% / 0.7), hsla(${hue} 70% 41% / 0.7));border:1px solid hsla(${hue} 70% 59% / 0.8);color:#FFFFFF;" role="img" aria-label="Rating badge">${VI_SVG.thumb}<span>${Math.round(r)}%</span></div>` : '';
        return `<a href="/video/${escHtml(viSlug(v.title) || 'video')}_${escHtml(v._id)}" class="${VI_CARD}">
            <div class="relative aspect-video bg-[#0A0A0A] overflow-hidden">
                ${v.thumbnailUrl ? `<img src="${escHtml(v.thumbnailUrl)}" alt="${escHtml(v.title || '')}" class="w-full h-full object-cover transition-transform duration-300 opacity-100 group-hover:scale-110" loading="lazy">` : ''}
                <div class="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-20"><div class="w-10 h-10 rounded-full bg-orange-600/80 hover:bg-orange-600 backdrop-blur-sm border border-orange-400/30 flex items-center justify-center text-white">${VI_SVG.play}</div></div>
                ${v.duration ? `<div class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 bg-black/80 backdrop-blur-sm rounded text-white text-xs font-semibold z-20">${escHtml(v.duration)}</div>` : ''}
            </div>
            <div class="p-2 space-y-1">
                <h4 class="text-sm font-semibold line-clamp-2 group-hover:text-blue-400 transition-colors leading-tight text-white">${escHtml(v.title || '')}</h4>
                <div class="flex items-center gap-2 text-xs text-gray-500"><span class="flex items-center gap-0.5">${VI_SVG.eye} ${viCompact(v.views)}</span><span>•</span><span class="flex items-center gap-0.5">${VI_SVG.cal} ${escHtml(String(v.uploadDate || '').slice(0, 10))}</span></div>
                <div class="flex items-center gap-1.5 flex-wrap">${rating}</div>
            </div></a>`;
    }

    function viPlaylistCard(p) {
        const thumbs = (Array.isArray(p.videoThumbnails) && p.videoThumbnails.length ? p.videoThumbnails : (p.thumbnails || [])).slice(0, 4);
        const cover = thumbs.length >= 2
            ? `<div class="w-full h-full grid grid-cols-2">${thumbs.map((t, i) => `<div class="relative overflow-hidden"><img src="${escHtml(t)}" alt="Video ${i + 1}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300" loading="lazy"></div>`).join('')}</div>`
            : ((p.thumbnailUrl || thumbs[0]) ? `<img src="${escHtml(p.thumbnailUrl || thumbs[0])}" alt="" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300" loading="lazy">` : '');
        return `<a href="/playlists/${escHtml(p._id)}" class="${VI_CARD}">
            <div class="relative aspect-video bg-[#0A0A0A] overflow-hidden">${cover}
                <div class="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-black/80 backdrop-blur-sm rounded text-white text-xs font-semibold">${VI_SVG.videoCount} ${escHtml(String(p.videoCount ?? ''))}</div>
            </div>
            <div class="p-2 space-y-1.5">
                <h4 class="text-sm font-semibold line-clamp-2 group-hover:text-blue-400 transition-colors leading-tight text-white">${escHtml(p.name || '')}</h4>
                <div class="flex items-center gap-1 text-xs text-gray-400"><span class="flex items-center gap-1 truncate">${VI_SVG.user}<span class="truncate">${escHtml(p.owner || '')}</span></span></div>
                <div class="flex items-center gap-2 text-xs text-gray-500"><span class="flex items-center gap-0.5">${VI_SVG.eye} ${viCompact(p.views)}</span><span>•</span><span class="flex items-center gap-0.5">${VI_SVG.clock} ${escHtml(viAgo(p.updatedAt || p.createdAt))}</span></div>
            </div></a>`;
    }

    function viSectionsHtml(d) {
        const v = d.video || {};
        const stars = Array.isArray(v.starsTags) ? v.starsTags.filter(Boolean) : [];
        const models = `<div class="bg-[#1A1A1A] rounded-lg p-3"><div class="flex items-center gap-2 flex-wrap">
            <span class="text-xs font-semibold text-gray-400 flex items-center gap-1 mr-1">${VI_SVG.userCircle(12, 'text-yellow-300')} Models</span>
            ${stars.length ? stars.map(s => `<a href="/model/${escHtml(viSlug(s) || 'star')}" class="inline-flex items-center gap-1.5 px-2 py-0.5 bg-gradient-to-r from-yellow-500/25 to-amber-500/25 border border-yellow-400/40 text-yellow-200 rounded-md text-xs font-semibold shadow-sm hover:from-yellow-500/35 hover:to-amber-500/35 hover:border-yellow-400/60 transition-all"><span class="truncate">${escHtml(s)}</span></a>`).join('')
                : '<span class="text-xs text-gray-500">None tagged</span>'}
        </div></div>`;
        const pls = Array.isArray(d.playlists) ? d.playlists : [];
        const playlists = pls.length ? `<div class="bg-[#1A1A1A] rounded-lg p-4">
            <div class="flex items-center justify-between mb-4"><h3 class="text-lg font-bold text-white flex items-center gap-2">${VI_SVG.listVideo} Playlists with this video <span class="text-sm font-normal text-gray-400">(${pls.length})</span></h3></div>
            <div class="${VI_GRID}">${pls.map(viPlaylistCard).join('')}</div></div>` : '';
        const ups = Array.isArray(d.uploaderVideos) ? d.uploaderVideos.filter(x => x?._id && x._id !== v._id) : [];
        const who = v.uploaderUsername || v.uploader || '';
        const more = ups.length ? `<div class="bg-[#1A1A1A] rounded-lg p-4">
            <div class="flex items-center justify-between mb-4"><h3 class="text-lg font-bold text-white flex items-center gap-2">${VI_SVG.userCircle(20)} More from ${escHtml(who)} <span class="text-sm font-normal text-gray-400">(${escHtml(String(d.uploaderVideosCount ?? ups.length))})</span></h3>
                ${v.uploaderId ? `<a href="/users/${escHtml(v.uploaderId)}" class="text-sm text-orange-400 hover:text-orange-300 transition-colors flex items-center gap-1"> View channel ${VI_SVG.arrow}</a>` : ''}</div>
            <div class="${VI_GRID}">${ups.map(viVideoCard).join('')}</div></div>` : '';
        return models + playlists + more;
    }

    function renderVideoInfo(box, key) {
        box.dataset.vid = vinfo.vid;
        box.dataset.state = key;
        const sub = vinfo.loading ? 'Loading…' : vinfo.error ? 'Could not load — click to retry' : 'Models • Playlists with this video • More from uploader';
        box.innerHTML = `<button type="button" data-pmv-vinfo-toggle aria-expanded="${vinfo.open}" class="w-full flex items-center justify-between gap-3 bg-[#1A1A1A] rounded-lg px-4 py-3 text-left text-gray-300 hover:text-white transition-colors">
                <span class="flex items-center gap-2 min-w-0"><span class="text-orange-400 flex-shrink-0">${VI_SVG.info}</span><span class="text-sm font-semibold text-white flex-shrink-0">${vinfo.open ? 'Less about this video' : 'More about this video'}</span><span class="text-xs text-gray-400 truncate">${sub}</span></span>
                <span class="flex-shrink-0" style="transition:transform .2s;${vinfo.open ? 'transform:rotate(180deg);' : ''}">${VI_SVG.chev}</span>
            </button>
            ${vinfo.open && vinfo.data ? `<div class="space-y-4 mt-4">${viSectionsHtml(vinfo.data)}</div>` : ''}`;
        box.querySelector('[data-pmv-vinfo-toggle]').onclick = () => {
            if (vinfo.error) { vinfo.open = true; loadVideoInfo(); return; }
            vinfo.open = !vinfo.open;
            if (vinfo.open && !vinfo.data && !vinfo.loading) loadVideoInfo();
            else ensureVideoInfo();
        };
        if (vinfo.open && vinfo.data) { try { addMoreFromBadges(); } catch {} }
    }

    async function loadVideoInfo() {
        const seq = vinfo.seq, vid = vinfo.vid;
        vinfo.loading = true; vinfo.error = false;
        ensureVideoInfo();
        try {
            const json = await api(`/api/videos/${vid}/watch-page`);
            if (seq !== vinfo.seq) return;
            vinfo.data = json?.data?.video ? json.data : null;
            if (!vinfo.data) vinfo.error = true;
        } catch { if (seq === vinfo.seq) vinfo.error = true; }
        finally { if (seq === vinfo.seq) { vinfo.loading = false; ensureVideoInfo(); } }
    }

    // After the info block under the player; self-healing via the page observer.
    function ensureVideoInfo() {
        let box = document.getElementById(VINFO_ID);
        if (!isPlaylistPage()) { box?.remove(); return; }
        const col = document.querySelector('.playlist-page div.grid > div.min-w-0');
        const anchor = col && [...col.children].find(el => el.classList.contains('space-y-4') && el.classList.contains('mb-4'));
        if (!anchor) { box?.remove(); return; }
        // Only the active queue row counts; none (mid re-render) keeps the current state.
        const vid = getActiveQueueVideoId() || vinfo.vid;
        if (!vid) return;
        if (vid !== vinfo.vid) Object.assign(vinfo, { vid, open: false, data: null, loading: false, error: false, seq: vinfo.seq + 1 });
        if (!box) { box = document.createElement('div'); box.id = VINFO_ID; box.className = 'mb-4'; }
        if (box.previousElementSibling !== anchor || !box.isConnected) anchor.after(box);
        const key = `${vinfo.open ? 1 : 0}${vinfo.loading ? 1 : 0}${vinfo.data ? 1 : 0}${vinfo.error ? 1 : 0}`;
        if (box.dataset.vid !== vid || box.dataset.state !== key) renderVideoInfo(box, key);
    }
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
        if (!onPage) { document.getElementById('pmv-notif-selpl')?.remove(); document.getElementById('pmv-notif-read')?.remove(); return; }
        if (!State.ready) return;

        const toFetch = [];
        const doneCards = new Set();

        document.querySelectorAll('a[href*="/video/"]').forEach(link => {
            const card = link.closest('div.group');
            if (!card?.querySelector('input[type="checkbox"]')) return;
            wireNotifMarkAsRead(link);
            // Title and thumbnail both link to the video: one label row per card, after the first link.
            if (doneCards.has(card)) { if (link.nextElementSibling?.dataset?.pmvNotifBadge !== undefined) link.nextElementSibling.remove(); return; }
            doneCards.add(card);
            const apiId = resolveNotifVideoApiId(link);
            if (!apiId) return;
            const meta = State.videoMeta.get(apiId);
            if (meta) {
                renderNotifPreview(card, apiId, meta);
            } else if (!card.dataset.pmvNotifPreviewBusy && !lookupOnCooldown(apiId)) {
                card.dataset.pmvNotifPreviewBusy = '1';
                toFetch.push({ card, apiId });
            }

            const matching = [];
            State.playlists.forEach(p => { if (p.ids.has(apiId)) matching.push({ id: p.id, name: p.name }); });
            const key = matching.map(m => m.name).join('|');
            // data-* survives Vue re-renders; the select button reads it.
            card.dataset.pmvInpl = matching.length ? '1' : '0';

            const existing = link.nextElementSibling?.dataset?.pmvNotifBadge !== undefined
                ? link.nextElementSibling : null;
            if (existing && existing.dataset.pmvNotifBadge === key) return;
            existing?.remove();

            const row = document.createElement('div');
            row.dataset.pmvNotifBadge = key;
            row.dataset.pmvBadge = '1';
            row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px;';
            matching.forEach(({ id: plId, name }) => {
                const badge = document.createElement('span');
                badge.dataset.playlistName = name;
                const badgeRgb = playlistBadgeRgb(name, plId);
                badge.style.cssText = `display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;font-size:11px;background:rgba(${badgeRgb},0.15);border:1px solid rgba(${badgeRgb},0.4);color:rgb(${badgeRgb});max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
                badge.title = 'In playlist: ' + name;
                badge.textContent = (isRejectList(plId) ? '\u2298 ' : '\u2713 ') + name;
                row.appendChild(badge);
            });
            // Same Up next button as on video cards (Kaartknoppen); the global sync keeps its state.
            const aqBtn = cardBtn('queue', 'Add to Up next', CARD_ICON.upNext);
            aqBtn.dataset.pmvAddqueue = '1';
            aqBtn.dataset.qid = apiId;
            aqBtn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                if (queuedPosition(apiId)) { removeFromQueue(apiId); toast('\u2212 Removed from Up next', null, { under: upNextToastAnchor() }); return; }
                addVideoToQueue(apiId, card, link.getAttribute('href'));
            });
            row.appendChild(aqBtn);
            syncQueueCardBtn(aqBtn);
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
    // Resolved from State and the live DOM per call, not data-pmv-inpl (can be stale mid-loop).
    function getNotifInPlaylistBoxes() {
        return [...document.querySelectorAll('div.group')]
            .map(card => {
                const checkbox = card.querySelector('input[type="checkbox"]');
                const link = card.querySelector('a[href*="/video/"]');
                if (!checkbox || !link) return null;
                const apiId = resolveNotifVideoApiId(link);
                return apiId && isVideoInPlaylist(apiId) ? checkbox : null;
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
                clickNotifCheckboxesWhere(isVideoInPlaylist, { target: !allChecked });
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

        // Mark the selected unread ones read via the site's own per-card button (its request, its UI update).
        let readBtn = document.getElementById('pmv-notif-read');
        if (!readBtn) {
            readBtn = document.createElement('button');
            readBtn.id = 'pmv-notif-read';
            readBtn.type = 'button';
            readBtn.title = 'Mark the selected notifications as read';
            readBtn.addEventListener('click', async () => {
                if (readBtn.dataset.busy) return;
                readBtn.dataset.busy = '1';
                // The site's own bulk button (shown with an unread selection) does it in one request.
                const bulk = [...document.querySelectorAll('button')].find(b => b !== readBtn && !b.disabled && !b.closest('div.group')
                    && /mark/i.test(b.textContent) && /read/i.test(b.textContent) && !/\ball\b/i.test(b.textContent));
                if (bulk) bulk.click();
                else for (const b of selectedNotifReadButtons()) {
                    if (b.isConnected) b.click();
                    await new Promise(r => setTimeout(r, 250)); // one at a time: the site rate-limits bursts
                }
                delete readBtn.dataset.busy;
                updateNotifSelectButton();
            });
        }
        if (readBtn.previousElementSibling !== btn) btn.after(readBtn);
        const unread = selectedNotifReadButtons().length;
        const readStyle = !unread ? 'display:none;'
            : 'display:inline-flex;align-items:center;padding:4px 12px;border-radius:9999px;font-size:12px;line-height:1.33;cursor:pointer;white-space:nowrap;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.25);color:rgb(229,231,235);'
              + (row ? '' : 'position:fixed;right:16px;bottom:56px;z-index:9999;');
        PMVX.setAttr(readBtn, 'style', readStyle);
        PMVX.setText(readBtn, `\u2713 Mark read (${unread})`);
    }

    function selectedNotifReadButtons() {
        return [...document.querySelectorAll('div.group')]
            .filter(card => card.querySelector('input[type="checkbox"]')?.checked)
            .map(card => card.querySelector('button[title="Mark as read"]'))
            .filter(Boolean);
    }

    // Keep the select/deselect label in sync with manual checkbox clicks.
    document.addEventListener('change', e => {
        // Next frame: on "Select All" Vue ticks the other boxes after this capture-phase listener.
        if (e.target?.matches?.('input[type="checkbox"]') && document.getElementById('pmv-notif-selpl')) {
            requestAnimationFrame(updateNotifSelectButton);
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

    // --- Navigation ---

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

    // --- Cached player repair ---
    // Nuxt's KeepAlive doesn't remount a reactivated page's player, and the media sweep emptied its
    // <video> while detached; reloadSource() restores it (up to two nudges). Production Vue hides
    // instances, so the player is found by walking the vnode tree (Suspense keeps its branch aside).
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

    // URL change detection: popstate plus a title MutationObserver (router pushes skip popstate).
    function onUrlChange() {
        if (location.href === State.lastUrl) return;
        sweepDetachedMediaFor();
        State.lastUrl = location.href;
        if (location.pathname.startsWith('/video/')) videoHopsThisPage++;
        closeHud();
        hideQueueSidebarNow();
        // Reset now so getCurrentVideoId() doesn't return the previous video's ID.
        State.currentVideoData = null;
        // The seekbar preview's second player belongs to the previous video; the next hover rebuilds it.
        try { scrubHide(); scrubDrop(); } catch {}
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
        if (location.pathname.startsWith('/playlists/')) {
            setTimeout(() => {
                try { window.dispatchEvent(new CustomEvent('pmv:playlist-navigate')); } catch {}
            }, 300);
        }
    }

    window.addEventListener('popstate', onUrlChange);

    new MutationObserver(onUrlChange).observe(
        document.querySelector('title') || document.head,
        { childList: true, characterData: true, subtree: true }
    );

    // 2s heartbeat: volume enforcement and video element discovery only.
    setInterval(() => {
        getVideo();
        updateNativePlaylistButtons();
        if (State.ready) { try { ensureRejectBarButton(getCurrentVideoId()); } catch {} }
    }, 2000);

    // --- Context menu ---
    // Playlist menu for a video, opened by the "+" button on cards.

    function closeCtxMenu() {
        document.getElementById('pmv-ctx-menu')?.remove();
    }

    function buildCtxMenu(videoId, x, y, target) {
        closeCtxMenu();
        // Kept so "Open in new tab" can find the card link.
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
            const link = _ctxTarget?.closest('a[href*="/video/"]') ||
                         _ctxTarget?.closest('[data-video-id]')?.querySelector('a[href*="/video/"]');
            const href = link?.getAttribute('href');
            if (href) window.open(href, '_blank');
        });

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
                // Contrast is in text and icon colour only: near gray when not in the playlist, vivid when in it.
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

                const icon = document.createElement('span');
                icon.style.cssText = 'width:14px;flex-shrink:0;font-size:12px;text-align:center;' +
                    (inPl ? `color:rgba(${activeRgb},1);` : `color:rgba(${inactiveRgb},0.5);`);
                icon.textContent = inPl ? '✓' : '+';

                const label = document.createElement('span');
                label.textContent = displayName;
                label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

                row.appendChild(icon);
                row.appendChild(label);

                // The menu stays open: the row is busy during the change, then the menu redraws in place
                // (a reject list change also moves the video out of other playlists).
                row.addEventListener('click', async e => {
                    e.stopPropagation();
                    if (row.dataset.busy) return;
                    row.dataset.busy = '1';
                    row.style.opacity = '0.5';
                    row.style.pointerEvents = 'none';
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
                    // Redraw only if this menu is still open (a click outside closes it).
                    if (document.getElementById('pmv-ctx-menu') === menu) {
                        const btn = menu._pmvBtn;
                        buildCtxMenu(videoId, parseFloat(menu.style.left) || x, parseFloat(menu.style.top) || y, target);
                        const next = document.getElementById('pmv-ctx-menu');
                        if (next && btn) next._pmvBtn = btn;
                    }
                });

                menu.appendChild(row);
            });
        }

        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth)  menu.style.left = Math.max(0, window.innerWidth - rect.width - 8) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top  = Math.max(0, window.innerHeight - rect.height - 8) + 'px';
    }

    document.addEventListener('click', e => {
        if (!e.target.closest('#pmv-ctx-menu')) closeCtxMenu();
    }, true);
    document.addEventListener('scroll', closeCtxMenu, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); }, true);

    // --- Seekbar preview ---
    // Frame above the player's time bar at the hovered time; prepared ahead, a hover never seeks.
    // Layers: the ten API frames (timelineThumbnails) show at once; over them a cache built in the background
    // once the video plays. Cache: hidden players on the lowest rendition via the site's own hls.js constructor
    // (segments from the HTTP cache: CPU, not bandwidth). Frames are taken at keyframes (a seek decodes from the
    // previous one), timed from the TS segments (PES PTS of random-access packets); seeking SCRUB_KEY_MARGIN past
    // one lands cheaply. Then gaps > SCRUB_GAP get a middle frame, widest first (costly mid-GOP seeks). Segments go
    // coarse-to-fine across players; without TS (plain file, fMP4) one player walks 2 s steps.
    // The bar (onMousemove=handleProgressHover) is matched on document mouse events, not attached to: Vue may rebuild it.
    // Setting: hybrid = live cache (default), frames = API frames only, off.
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

    // 16:9 and wider at a fixed width; portrait capped in height.
    function scrubDims(video) {
        const ar = (video?.videoWidth && video?.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
        let w = SCRUB_W, h = Math.round(w / ar);
        if (h > SCRUB_MAX_H) { h = SCRUB_MAX_H; w = Math.round(h * ar); }
        return { w, h };
    }

    // API frames: from the video's own data once loaded, else the page's strip (not mid fullscreen hand-over).
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
        // In fullscreen only the fullscreen element's children show, so the tip follows it.
        const root = getFullscreenRoot() || document.body;
        if (Scrub.tip.parentElement !== root) root.appendChild(Scrub.tip);
        return Scrub.tip;
    }

    // Hidden players sit in a display:none box on body: seeking and drawImage work there, and
    // being attached keeps the media sweep (detached elements only) off them.
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

    // HLS when the site's hls.js has a URL, else the file; a blob: URL (MSE without hls) can't be reopened.
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
            // Tap the player's fragment loader: bytes it loads anyway are parsed for keyframes (synchronously,
            // before hls.js hands them to its worker). Without a tap scrubBuildFromIndex fetches fragments itself.
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
            // Lowest level only (preview is 176px wide). maxBufferLength below fragment length loads only the
            // fragment at the seek position, keeping memory flat; a walking player (no index) buffers everything.
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

    // --- Taking a frame ---

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

    // Seeks a hidden player to t and keeps the frame; false if the seek did not land.
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

    // Coarse-to-fine order (0, n/2, n/4, 3n/4, ...) so every stretch gets a nearby frame early.
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

    // --- Keyframe index from TS segments ---

    // Level playlist as hls.js read it (fragments with url, start, duration); null if it never loads.
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

    // Keyframe times of one MPEG-TS segment: PTS of random-access video PES packets, placed on the
    // media timeline as hls.js does; null if not TS.
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

    // Keyframe times per fragment sequence number from the tapped loader; waiters are notified.
    function scrubTapFrag(g, frag, data) {
        if (!frag || typeof frag.sn !== 'number' || !(data instanceof ArrayBuffer) || !data.byteLength) return;
        const times = scrubParseTs(data, frag.start);
        g.fragTimes.set(frag.sn, times);
        const waiters = g.fragWaiters.get(frag.sn);
        if (waiters) { g.fragWaiters.delete(frag.sn); waiters.forEach(r => r(times)); }
    }

    // Resolves with the fragment's keyframe times (null: not TS), or undefined on timeout.
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
        // Players claim fragments coarse-to-fine; keyframes go in order within a fragment.
        const order = scrubOrder(frags.length);
        let next = 0;
        let indexed = false;
        const perFragCap = Math.max(2, Math.floor(SCRUB_FRAMES_MAX / frags.length));
        const work = async g => {
            while (live() && next < order.length && !scrubFramesFull()) {
                if (document.hidden) { await scrubSleep(250); continue; }
                const frag = frags[order[next++]];
                // Loading starts at this player's first fragment; each later seek makes hls.js fetch its fragment.
                if (!g.started) { g.started = true; try { g.hls.startLoad(frag.start); } catch {} }
                // The first grab at the fragment start (a keyframe) makes the tapped player load it and deliver the
                // rest of its keyframe times; if the tap yields nothing in time, the fragment is fetched separately.
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
                    // Too many to keep: an even pick across the fragment.
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

    // Fills the widest gaps first until none exceeds SCRUB_GAP or the cache is full.
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

    // No index (plain file or fMP4): one player, 2 s steps, coarse-to-fine.
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

    // --- Showing ---

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
            // The site hides controls after idle seconds and Vue may drop the bar; the tip must not outlive either.
            Scrub.watch = setInterval(() => {
                if (!bar.isConnected) { scrubHide(); return; }
                if (!ownStrip && bar.closest('.controls-bar-wrapper')?.classList.contains('controls-hidden')) scrubHide();
            }, 250);
        }
    }

    document.addEventListener('mousemove', e => {
        if (scrubMode() === 'off') return;
        const target = e.target instanceof Element ? e.target : null;
        // During a drag-seek the preview follows the pointer anywhere, via the bar it started on.
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

    // --- Hotkeys ---
    // Every key is remappable to a built-in action or a playlist. One table drives dispatch and the cheat sheet.
    const KEYBIND_KEY = 'pmv_keybindings_v1';

    const BUILTIN_ACTIONS = {
        showHud: { label: 'Show HUD panel', run: () => showHud() },
        toggleMute: { label: 'Toggle mute', run: () => toggleMute() },
        volume100: { label: 'Set volume to 100%', run: () => setVolume100() },
        nextVideo: {
            label: 'Next video (Up next when it has items; the playlist itself on a playlist page)', run: () => {
                // Up next takes "next" while it has something ahead (the played item becomes history); otherwise
                // false lets the site's N advance. On playlist pages the playlist owns "next".
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
                // Fullscreen may run ahead of the page (the on-page button is the previous video's), so call directly.
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
                // For playlist pages (the playing video has no page URL). Uses the playlist buttons' id resolution
                // (API _id or mapped slug, never a poster asset id), slug form preferred.
                const id = getCurrentVideoId();
                if (!id) { toast('No video'); return; }
                const href = knownHrefForId(id) || `/video/${id}`;
                // Synchronous in the key event: a popup opened after an await loses user activation.
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
        // First run: built-in actions only; playlist keys are assigned in settings (Assign hotkeys).
        const defaults = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
        try { localStorage.setItem(KEYBIND_KEY, JSON.stringify(defaults)); } catch {}
        return defaults;
    }
    let keybindings = loadKeybindings();
    function saveKeybindings() {
        try { localStorage.setItem(KEYBIND_KEY, JSON.stringify(keybindings)); } catch {}
        // Key caps on the playlist buttons under the player.
        try { document.querySelectorAll('#pmv-page-playlists [data-pmv-pl-btn]').forEach(b => syncPageBtnKey(b, b.dataset.pmvPlBtn)); } catch {}
    }

    // Playlist pages: the playlist owns "next" (the site's N). Elsewhere the next Up next item, else the first
    // Recommended card that is neither current nor rejected. The synthetic N bypasses our key dispatcher.
    let dispatchingSyntheticNext = false;


    // Tag-popup after ✕: tag the rejected video, with the calls of the site's Vote on Tags modal:
    //   GET  /api/videos/<id>/tags/stats    -> data.tags [{ tag, userVote }]
    //   POST /api/videos/<id>/tags/suggest  { tag, tagType: 'general' }                      new tag, +1 vote
    //   POST /api/videos/<id>/tags/vote     { tag, voteType: 'upvote', tagType: 'general' }  existing tag
    // Voting again on an upvoted tag removes the vote, so that case is skipped.
    const TAG_AFTER_REJECT_KEY = 'pmv_tag_after_reject_v1';
    const TAG_RECENT_KEY = 'pmv_tag_recent_v1';
    const TAG_MAX_LEN = 50; // the site's limit for general tags
    const TAG_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle></svg>';
    const STAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/></svg>';
    // Tags and stars/models share the endpoints, told apart by tagType; site length limits 50 and 100.
    const TAG_KINDS = {
        general: { recentKey: TAG_RECENT_KEY, max: TAG_MAX_LEN, stats: 'tags', meta: 'tags', noun: 'tag', icon: TAG_SVG, pre: '#' },
        stars: { recentKey: 'pmv_star_recent_v1', max: 100, stats: 'stars', meta: 'starsTags', noun: 'model', icon: STAR_SVG, pre: '' },
    };
    const tagKind = k => TAG_KINDS[k] || TAG_KINDS.general;

    // The site's vocabulary per kind for autocomplete, loaded once.
    const popularTagsP = {};


    // Toggle a mapped playlist (press again within 3 s to confirm removal); the reject list uses rejectCurrentVideo.
    async function handlePlaylistHotkey(playlistId) {
        if (isRejectList(playlistId)) return rejectCurrentVideo();
        const videoId = getCurrentVideoId();
        if (!videoId) { toast('No video'); return; }
        const plName = getPlaylistDisplayName(State.playlists.get(playlistId)?.name, playlistId) || playlistId;
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

    // false = the binding declined the key; decided synchronously, as it settles whether the site's handler runs.
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

    // Bound keys are exclusive: capture phase on window + stopImmediatePropagation hides them from the site
    // (F, space, J, arrows, 0-9, N). Ctrl/Alt/Cmd chords are never hotkeys; run() returning false declines.
    window.addEventListener('keydown', e => {
        if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
        if (dispatchingSyntheticNext) return;
        // The hotkey editor takes letters itself (pressing a key selects it).
        if (document.getElementById('pmv-keyeditor')) return;
        // The fullscreen-resume prompt after a fresh page load takes the next key itself.
        if (document.getElementById('pmvx-fs-resume')) return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
        const binding = keybindings[e.key.toLowerCase()];
        if (!binding) return;
        if (runBinding(binding) === false) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    // --- Player keys ---
    // The site binds its player keys (F, space, J, arrows, 0-9) in onMounted; after a router.push hop they can
    // stop working, so they are reimplemented on the <video> (bubble phase; stand down on preventDefault).
    // Volume keys omitted: the HUD holds volume at 100%.
    function playerFullscreenTarget() {
        const video = getVideo();
        if (!video) return null;
        // Fullscreen the site's wrapper (.hls-player-wrapper), not the <video>, so its fullscreenchange bookkeeping and controls hold.
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

    // If the site's own switch disables its shortcuts, these stand down too.
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
        // Only where the page has a player; card hover previews are <video> too.
        if (!/^\/(video|playlists)\//.test(location.pathname)) return false;
        if (siteShortcutsDisabled()) return false;
        return !!getVideo();
    }

    // Fullscreen is taken in the capture phase: the site's F can fail after an in-page hop (a stale handler
    // calls preventDefault on a detached wrapper). stopImmediatePropagation avoids two racing handlers.
    document.addEventListener('keydown', e => {
        if (e.key.toLowerCase() !== 'f' || !playerKeysApply(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleVideoFullscreen();
    }, true);

    // Other keys only act if nothing else did: a safety net for when the site's handler is gone.
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
        // Synchronous: a fullscreen request after an await loses user activation.
        e.preventDefault();
        try { action.run(); } catch {}
    });

    // Binding description shared by the cheat sheet and keyboard editor.
    function describeBinding(binding) {
        if (!binding) return null;
        if (binding.action === 'playlist') {
            const name = getPlaylistDisplayName(State.playlists.get(binding.playlistId)?.name, binding.playlistId) || binding.playlistId;
            return isRejectList(binding.playlistId)
                ? `"${name}" reject (out of every other playlist, next video)`
                : `"${name}" toggle (press again within 3 s to remove)`;
        }
        if (binding.action?.startsWith('builtin:')) {
            return BUILTIN_ACTIONS[binding.action.slice(8)]?.label || null;
        }
        return null;
    }

    // --- Hotkey cheat sheet ---
    // Built from `keybindings`, so it stays correct after remaps.
    function toggleHotkeyCheatSheet() {
        const existing = document.getElementById('pmv-hotkeys');
        if (existing) { existing.remove(); return; }

        const rows = Object.entries(keybindings)
            .map(([key, binding]) => ({ key, desc: describeBinding(binding) }))
            .filter(r => r.desc)
            .sort((a, b) => a.key.localeCompare(b.key))
            .map(r => `<tr><td style="color:rgb(100,255,0);padding-right:16px;">${escHtml(r.key.toUpperCase())}</td><td>${escHtml(r.desc)}</td></tr>`)
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

    // Only the bottom strip opens the HUD on mousemove (the right edge is the queue sidebar's); "i" works anywhere.
    const HUD_BOTTOM_ZONE_PX = 300;

    document.addEventListener('mousemove', e => {
        if (!document.fullscreenElement || State.quietMode) return;
        // Not over the open queue sidebar (380px wide, much larger than its 24px trigger strip).
        if (State.queueSidebarVisible && State.queueOverlayEl?.matches(':hover')) return;
        // Over a seek bar (the site's or the HUD's strip) the Seekbar-preview wins; the panel closes there.
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

    // --- Reject ---
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

    // Reject key: reject (addToPlaylist drops other lists) and skip; on a rejected video, un-reject without skipping.
    async function rejectCurrentVideo() {
        const videoId = getCurrentVideoId();
        if (!videoId) { toast('No video'); return; }
        await toggleRejectVideo(videoId, { skip: true });
    }

    // Reject key and card ✕: toggle reject-list membership (only the key skips); resolves to the new state or null.
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

    function tagAfterReject() { try { return localStorage.getItem(TAG_AFTER_REJECT_KEY) !== '0'; } catch { return true; } }

    function setTagAfterReject(on) { try { localStorage.setItem(TAG_AFTER_REJECT_KEY, on ? '1' : '0'); } catch {} }

    // --- Tag popup (quick tag manager) ---
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

    // Tag-popup: the video's tags (click = upvote, again = unvote) plus an input with autocomplete and recent
    // tags. Opens at the given rect (the card may be hidden by then); closes on Esc, ✕ or an outside click.
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
                const by = tagHiddenBy(t, kind);
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
                const by = tagHiddenBy(t.tag, kind);
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
                const by = tagHiddenBy(t, kind);
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
                const by = tagHiddenBy(tag, kind);
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

        // Below the anchor if it fits, else above, within the viewport; redone when the tag list changes the height.
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
    // --- Init ---

    function init() {
        const hasCache = loadCache();
        try { learnVideoIdsFromNuxtPayload(); } catch {}

        try {
            observer.observe(document.body, { childList: true, subtree: true });
        } catch {}

        getVideo();
        forceVolume100({ silent: true });
        onPossibleVideoChange();
        // Before the playlist cache: the header filter only needs title/rating/length.
        try { attachFilterButton(); } catch {}
        try { applyFilterToCards(); } catch {}
        // The bar is positioned off the header row's box.
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

    // Fetch interceptor is live from document-start; init() waits for "load" (also fires in background tabs).
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init, { once: true });
    }
})();


(function () {
    'use strict';

    const CACHE_KEY   = 'pmv_firefox_playlist_cache_v1';
    const SETTINGS_KEY = 'pmvbpf_settings_v1';
    const PANEL_PAGES = ['/', '/browse', '/popular', '/trending', '/search',
                         '/discover', '/all-videos', '/watch', '/watch-new'];
    const PANEL_PREFIX_PAGES = ['/profile/'];
    const HIDE_ATTR   = 'data-pmvbpf-hidden';

    function isFilterPage() {
        const p = location.pathname.replace(/\/$/, '') || '/';
        return PANEL_PAGES.includes(p)
            || PANEL_PREFIX_PAGES.some(pp => p.startsWith(pp));
    }

    // Hide via a data-* attribute + stylesheet: Vue re-renders clear inline styles, not data-*.
    (function injectHideStyle() {
        const css = `a[${HIDE_ATTR}]{display:none !important;}`;
        const style = document.createElement('style');
        style.id = 'pmvbpf-style';
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    })();

    // --- Playlist cache ---

    let playlistsMap = new Map();
    let reverseMap   = new Map();
    let cacheLoaded  = false;

    function loadCache() {
        try {
            const s = PMVX.state;
            if (s?.playlists?.size) {
                playlistsMap = s.playlists;
                reverseMap   = s.reverse;
                cacheLoaded  = true;
                return true;
            }
        } catch {}
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
            cacheLoaded = playlistsMap.size > 0;
            return cacheLoaded;
        } catch { return false; }
    }

    // Same-window event from the core; faster than the storage event.
    window.addEventListener('pmv:cache-ready', () => {
        loadCache();
        if (playlistFilterMode !== 'any') applyFilter();
    });

    window.addEventListener('storage', e => {
        if (e.key === CACHE_KEY) { loadCache(); if (playlistFilterMode !== 'any') applyFilter(); }
    });

    // Playlists that count for in/not-in; empty = any playlist.
    let selectedPlaylistIds = [];
    (function loadPickerSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (Array.isArray(s.selectedPlaylistIds)) selectedPlaylistIds = s.selectedPlaylistIds.slice();
        } catch {}
    })();
    let pendingIds = selectedPlaylistIds.slice();
    function savePickerSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ selectedPlaylistIds })); } catch {}
    }

    function isInPlaylist(videoId) {
        let memberOf;
        try {
            const s = PMVX.state;
            memberOf = s?.reverse?.size ? s.reverse.get(videoId) : reverseMap.get(videoId);
        } catch { memberOf = reverseMap.get(videoId); }
        if (!memberOf || !memberOf.size) return false;
        if (!selectedPlaylistIds.length) return true;
        return selectedPlaylistIds.some(id => memberOf.has(id));
    }

    // --- Fetch interceptor ---

    const thumbToId = new Map();

    // PMVX.resJson is shared (first module defines it): one JSON parse per response.
    const pmvResJson = PMVX.resJson || (PMVX.resJson = res => {
        if (!res.__pmvJson) {
            try { res.__pmvJson = res.clone().json(); }
            catch (e) { res.__pmvJson = Promise.reject(e); }
            res.__pmvJson.catch(() => {});
        }
        return res.__pmvJson;
    });

    const _origFetch = window.fetch;
    window.fetch = async function (...args) {
        const rawUrl0 = typeof args[0] === 'string' ? args[0]
                      : args[0] instanceof Request  ? args[0].url
                      : String(args[0]);
        const isSavedSearches = /\/api\/saved-searches(\?|$)/.test(rawUrl0);
        const method = String(args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
        const res = isSavedSearches && method === 'POST'
            ? await saveWithPlaylists(_origFetch, this, args)
            : await _origFetch.apply(this, args);
        if (isSavedSearches) pmvResJson(res).then(rememberSavedList).catch(() => {});
        try {
            const rawUrl = rawUrl0;
            // _pmvx=: the script's own side lists (star popout), not the page's grid.
            if (/\/api\/videos(\?|$)/.test(rawUrl) && !/[?&]_pmvx=/.test(rawUrl)) {
                pmvResJson(res).then(json => {
                    indexVideos(json?.data?.videos || json?.videos || json?.data || []);
                }).catch(() => {});
            }
            // Playlist-detail responses carry thumbnailUrl -> _id too.
            if (/\/api\/playlists\/[a-f0-9]{24}/.test(rawUrl)) {
                pmvResJson(res).then(json => {
                    const details = json?.data?.videoDetails || json?.videoDetails || [];
                    indexVideos(details);
                }).catch(() => {});
            }
        } catch {}
        return res;
    };

    function indexVideos(videos) {
        if (!Array.isArray(videos)) return;
        videos.forEach(v => {
            if (!v?._id) return;
            [v.thumbnailUrl, v.rawThumbnailUrl, v.previewUrl].forEach(u => {
                if (u) thumbToId.set(u.split('?')[0], v._id);
            });
        });
    }

    // --- Reading cards ---

    function getVideoId(card) {
        if (card.dataset.videoId) return card.dataset.videoId;
        const img = card.querySelector('img[src]');
        const huds = PMVX.state;
        if (img?.src) {
            const clean = img.src.split('?')[0];
            if (thumbToId.has(clean)) return thumbToId.get(clean);
            if (huds?.thumbnailIndex?.has(clean)) return huds.thumbnailIndex.get(clean);
            const alt = img.alt?.trim().toLowerCase();
            if (alt && huds?.titleIndex?.has(alt)) return huds.titleIndex.get(alt);
            // Raw URL hex is an asset id, not a video _id; last resort only.
            const m = clean.match(/\/thumbnails\/([a-f0-9]{24})\//) ||
                      clean.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//) ||
                      clean.match(/\/([a-f0-9]{24})\/thumbnail\//);
            if (m) return m[1];
        }
        return null;
    }

    function getAllCards() {
        const seen = new Set(), all = [];
        document.querySelectorAll('[data-video-id]').forEach(c => {
            if (!seen.has(c)) { seen.add(c); all.push(c); }
        });
        return all;
    }

    // --- Filter state ---

    let playlistFilterMode = 'any';
    // Staged; committed by the site's Apply where there is one (homepage), otherwise at once.
    let pendingMode = 'any';

    // --- Mode ---

    PMVX.filterChecks.push(() => playlistFilterMode !== 'any' && isFilterPage() && !PMVX.playlistFilterExempt());

    function setMode(mode) {
        playlistFilterMode = mode;
        pendingMode = mode;
        PMVX.clearActed();
        updateBtnStyles();
        applyFilter();
    }

    function commitPending() {
        if (pendingIds.join(',') !== selectedPlaylistIds.join(',')) {
            selectedPlaylistIds = pendingIds.slice();
            savePickerSettings();
        }
        setMode(pendingMode);
    }

    function nativeApplyBtn() {
        for (const b of document.querySelectorAll('button')) {
            if (b.textContent?.trim() === 'Apply' && b.getClientRects().length) return b;
        }
        return null;
    }
    function stagedChange() {
        if (nativeApplyBtn()) updateBtnStyles();
        else commitPending();
    }

    // --- Apply filter ---

    function applyFilter() {
        if (!isFilterPage()) return 0;

        try {
            const s = PMVX.state;
            if (s?.playlists?.size) { playlistsMap = s.playlists; reverseMap = s.reverse; }
        } catch {}

        const cards = getAllCards();
        let visible = 0, hidden = 0;

        // Off on favourites views, where every card would count as in (or not in) a playlist.
        const off = playlistFilterMode === 'any' || PMVX.playlistFilterExempt();
        cards.forEach(card => {
            if (off) {
                card.removeAttribute(HIDE_ATTR);
                return;
            }
            const id = getVideoId(card);
            if (!id) { card.removeAttribute(HIDE_ATTR); return; }
            const inAny = isInPlaylist(id);
            const show  = (playlistFilterMode === 'in' ? inAny : !inAny) || PMVX.isActed(id);
            if (show) { card.removeAttribute(HIDE_ATTR); visible++; }
            else      { card.setAttribute(HIDE_ATTR, '1'); hidden++; }
        });

        updateCounter(visible, hidden);
        return visible;
    }

    // --- Counter ---

    function updateCounter(shown, hidden) {
        const el = document.getElementById('pmvbpf-counter');
        if (!el) return;
        if (playlistFilterMode === 'any') {
            el.textContent = '';
            el.style.display = 'none';
        } else {
            el.textContent = `${shown} shown · ${hidden} hidden`;
            el.style.display = 'inline';
        }
    }

    // --- Observer ---

    new MutationObserver(muts => {
        if (playlistFilterMode === 'any') return;
        let hasNew = false;
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1 && (n.dataset?.videoId ||
                    n.querySelector?.('[data-video-id]'))) {
                    hasNew = true; break;
                }
            }
            if (hasNew) break;
        }
        if (hasNew) requestAnimationFrame(applyFilter);
    }).observe(document.body, { childList: true, subtree: true });

    // --- UI injection ---
    // Chips in the site's "Content:" row: one cycles Any → Not in → In playlist, one lists the playlists
    // that count. On the homepage the choice waits for the site's Apply and is stored with saved filters.

    let injected = false;

    function findContentRow() {
        for (const span of document.querySelectorAll('span')) {
            if (span.textContent?.trim() === 'Content:') return span.parentElement;
        }
        // Profile pages have no "Content:" row; fall back to "Sort by:".
        for (const span of document.querySelectorAll('span')) {
            if (span.textContent?.trim() === 'Sort by:' && !span.children.length) return span.parentElement;
        }
        return null;
    }

    const CHIP_CLASS = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full border cursor-pointer transition-all text-xs';
    const svg = paths => `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    const ICON = {
        list: svg('<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>'),
        check: svg('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
        ban: svg('<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'),
        chevron: svg('<path d="m6 9 6 6 6-6"/>'),
    };
    const NEXT_MODE = { any: 'out', out: 'in', in: 'any' };

    function mkChip(id) {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = id;
        b.className = CHIP_CLASS + ' pmvbpf-chip';
        return b;
    }

    function injectButtons() {
        if (injected || !isFilterPage()) return;
        // SPA navigation can reset the flag while the row survives: keep one set.
        const ids = ['pmvbpf-sep', 'pmvbpf-btn-in', 'pmvbpf-btn-pick', 'pmvbpf-counter', 'pmvbpf-panel'];
        ids.forEach(id => [...document.querySelectorAll('#' + id)].slice(1).forEach(el => el.remove()));
        if (document.getElementById('pmvbpf-btn-in')?.isConnected) { injected = true; updateBtnStyles(); return; }
        const row = findContentRow();
        if (!row) return;
        if (!cacheLoaded && !loadCache()) { scheduleRetry(); return; }

        injected = true;
        injectPanelStyle();

        row.appendChild(Object.assign(document.createElement('div'), {
            id: 'pmvbpf-sep', className: 'w-px h-5 bg-[#2A2A2A] mx-1'
        }));

        const modeChip = mkChip('pmvbpf-btn-in');
        modeChip.addEventListener('click', () => { pendingMode = NEXT_MODE[pendingMode] || 'any'; stagedChange(); });

        const pickChip = mkChip('pmvbpf-btn-pick');
        pickChip.title = 'Which playlists count for In / Not in playlist (none = any playlist)';
        pickChip.addEventListener('click', () => {
            const pnl = document.getElementById('pmvbpf-panel');
            if (!pnl) return;
            pnl.hidden = !pnl.hidden;
            updateBtnStyles();
        });

        const panel = document.createElement('div');
        panel.id = 'pmvbpf-panel';
        panel.hidden = true;
        const lab = document.createElement('div');
        lab.className = 'text-gray-400 text-xs font-medium';
        lab.style.marginBottom = '8px';
        lab.textContent = 'Playlists that count — none selected = any playlist';
        const chips = document.createElement('div');
        chips.className = 'flex flex-wrap items-center gap-2';
        panel.append(lab, chips);
        let chipSig = null;
        const renderChips = () => {
            const live = PMVX.state?.playlists?.size ? PMVX.state.playlists : playlistsMap;
            const list = [...live.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            const sig = list.map(p => p.id + ':' + p.ids.size).join('|') + '#' + pendingIds.join(',');
            if (sig === chipSig) return;
            chipSig = sig;
            chips.textContent = '';
            if (!list.length) {
                const e = document.createElement('span');
                e.className = 'text-xs text-gray-500';
                e.textContent = 'No playlists yet — log in to load yours.';
                chips.appendChild(e);
                return;
            }
            const all = mkChip('');
            all.removeAttribute('id');
            all.dataset.state = pendingIds.length ? 'off' : 'pick';
            all.textContent = 'Any playlist';
            all.onclick = () => { pendingIds = []; renderChips(); stagedChange(); };
            chips.appendChild(all);
            list.forEach(p => {
                const c = mkChip('');
                c.removeAttribute('id');
                const sel = pendingIds.includes(p.id);
                c.dataset.state = sel ? 'pick' : 'off';
                c.title = `${p.ids.size} videos`;
                c.textContent = p.name || p.id;
                const n = document.createElement('span');
                n.className = 'pmvbpf-n';
                n.textContent = String(p.ids.size);
                c.appendChild(n);
                c.onclick = () => {
                    pendingIds = sel ? pendingIds.filter(x => x !== p.id) : [...pendingIds, p.id];
                    renderChips();
                    stagedChange();
                };
                chips.appendChild(c);
            });
        };
        window.removeEventListener('pmv:cache-ready', NF_renderChips); // the previous inject's chips
        NF_renderChips = renderChips;
        renderChips();
        window.addEventListener('pmv:cache-ready', renderChips);
        if (row.parentElement) row.parentElement.insertBefore(panel, row.nextSibling);

        const counter = Object.assign(document.createElement('span'), { id: 'pmvbpf-counter' });
        counter.className = 'text-xs text-gray-500';
        counter.style.cssText = 'display:none;margin-left:4px;';

        row.appendChild(modeChip);
        row.appendChild(pickChip);
        row.appendChild(counter);
        updateBtnStyles();
    }
    let NF_renderChips = null;

    // State colours via data-state: Vue re-renders drop inline styles, not data-*.
    function injectPanelStyle() {
        if (document.getElementById('pmvbpf-panel-style')) return;
        const st = document.createElement('style');
        st.id = 'pmvbpf-panel-style';
        st.textContent = `
.pmvbpf-chip{font-family:inherit;line-height:1.2;white-space:nowrap;}
.pmvbpf-chip[data-state="off"]{background:#1A1A1A;border-color:#2A2A2A;color:rgb(156,163,175);}
.pmvbpf-chip[data-state="off"]:hover{border-color:#3A3A3A;}
.pmvbpf-chip[data-state="in"]{background:rgba(34,197,94,.2);border-color:rgba(34,197,94,.5);color:rgb(134,239,172);}
.pmvbpf-chip[data-state="out"]{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.4);color:rgb(248,113,113);}
.pmvbpf-chip[data-state="pick"]{background:rgba(249,115,22,.2);border-color:rgba(249,115,22,.5);color:rgb(253,186,116);}
.pmvbpf-chip[data-pending="1"]{border-style:dashed;}
.pmvbpf-chip svg{flex-shrink:0;}
.pmvbpf-chip .pmvbpf-n{opacity:.55;font-variant-numeric:tabular-nums;}
#pmvbpf-panel{margin-top:12px;padding-top:12px;border-top:1px solid #1F1F1F;width:100%;box-sizing:border-box;}
#pmvbpf-panel[hidden]{display:none;}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    function updateBtnStyles() {
        const mc = document.getElementById('pmvbpf-btn-in');
        if (mc) {
            const st = pendingMode === 'in' ? 'in' : pendingMode === 'out' ? 'out' : 'off';
            mc.dataset.state = st;
            mc.innerHTML = (st === 'out' ? ICON.ban : st === 'in' ? ICON.check : ICON.list) + '<span></span>';
            mc.lastChild.textContent = st === 'out' ? 'Not in playlist' : st === 'in' ? 'In playlist' : 'Playlists';
            const staged = pendingMode !== playlistFilterMode;
            mc.dataset.pending = staged ? '1' : '';
            mc.title = (st === 'off' ? 'Filter on your playlists: click for Not in playlist, again for In playlist'
                : st === 'out' ? 'Only videos that are not in your playlists (click: In playlist)'
                : 'Only videos that are in your playlists (click: off)')
                + (staged ? ' — press Apply' : '');
        }
        const pc = document.getElementById('pmvbpf-btn-pick');
        if (pc) {
            const pnl = document.getElementById('pmvbpf-panel');
            const n = pendingIds.length;
            pc.dataset.state = n ? 'pick' : 'off';
            pc.dataset.pending = pendingIds.join(',') !== selectedPlaylistIds.join(',') ? '1' : '';
            pc.innerHTML = '<span></span>' + ICON.chevron;
            pc.firstChild.textContent = n ? `${n} playlist${n === 1 ? '' : 's'}` : 'Any playlist';
            const chev = pc.lastChild;
            if (chev && pnl && !pnl.hidden) chev.style.transform = 'rotate(180deg)';
        }
        NF_renderChips?.();
    }

    // The site's Clear resets this filter too; its Apply commits the staged choice.
    document.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn || !isFilterPage()) return;
        const txt = btn.textContent?.trim();
        if (txt === 'Clear' || txt === 'Clear all') {
            pendingIds = selectedPlaylistIds.slice();
            if (playlistFilterMode !== 'any' || pendingMode !== 'any') setMode('any');
        } else if (txt === 'Apply' && document.getElementById('pmvbpf-btn-in')) {
            commitPending();
        }
    }, true);

    // --- Saved filters ---
    // Saved as filters.pmvxPlaylists ({ mode, ids }), plus locally by name in case the server drops it.
    // Loading a saved filter without it turns this filter off.

    const SAVED_KEY = 'pmvbpf_saved_v1';
    const SAVED_FIELD = 'pmvxPlaylists';
    let savedList = [];
    const readSavedLocal = () => { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}') || {}; } catch { return {}; } };
    function writeSavedLocal(name, val) {
        const m = readSavedLocal();
        if (val) m[name] = val; else delete m[name];
        try { localStorage.setItem(SAVED_KEY, JSON.stringify(m)); } catch {}
    }
    function currentSavedValue() {
        return pendingMode === 'any' ? null : { mode: pendingMode, ids: pendingIds.slice() };
    }

    async function saveWithPlaylists(orig, ctx, args) {
        const init = args[1] || {};
        let body;
        try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { body = null; }
        if (!body || typeof body.name !== 'string' || !isFilterPage() || !document.getElementById('pmvbpf-btn-in')) {
            return orig.apply(ctx, args);
        }
        const val = currentSavedValue();
        writeSavedLocal(body.name.trim(), val);
        if (!val) return orig.apply(ctx, args);
        const withField = { ...body, filters: { ...(body.filters || {}), [SAVED_FIELD]: val } };
        const res = await orig.apply(ctx, [args[0], { ...init, body: JSON.stringify(withField) }]);
        // A server that rejects the extra key gets the original request; the local copy still works.
        if (!res.ok) return orig.apply(ctx, args);
        return res;
    }

    function rememberSavedList(json) {
        const list = json?.data;
        if (Array.isArray(list)) savedList = list;
        else if (json?.data?._id) savedList = [json.data, ...savedList.filter(s => s._id !== json.data._id)];
    }

    // Click on an entry in the site's saved-filter list.
    document.addEventListener('click', e => {
        if (!isFilterPage()) return;
        if (e.target.closest('button')) return; // delete / cancel
        const item = e.target.closest('div.cursor-pointer');
        if (!item || !item.querySelector('button[title="Delete saved search"]')) return;
        const name = item.querySelector('p')?.textContent?.trim();
        if (!name) return;
        const entry = savedList.find(s => (s.name || '').trim() === name);
        const val = entry?.filters?.[SAVED_FIELD] || readSavedLocal()[name] || null;
        // After the site's own load handler, which clears and re-applies its filters.
        setTimeout(() => {
            pendingIds = Array.isArray(val?.ids) ? val.ids.slice() : selectedPlaylistIds.slice();
            pendingMode = val && (val.mode === 'in' || val.mode === 'out') ? val.mode : 'any';
            commitPending();
        }, 0);
    }, true);

    new MutationObserver(() => {
        if (!isFilterPage() || document.getElementById('pmvbpf-btn-in')) return;
        injected = false;
        injectButtons();
    }).observe(document.body, { childList: true, subtree: true });

    // SPA navigation: reset and re-inject.
    // Path only: a query change (page, sort) must not switch the Content-chip back to Any.
    let lastPath = location.pathname;
    function onNav() {
        if (location.pathname === lastPath) return;
        lastPath = location.pathname;
        injected = false;
        playlistFilterMode = 'any';
        pendingMode = 'any';
        pendingIds = selectedPlaylistIds.slice();
        setTimeout(injectButtons, 800);
    }
    PMVX.onRoute(onNav);

    let retryTimer = null, retryCount = 0;
    function scheduleRetry() {
        if (retryTimer) return;
        retryTimer = setInterval(() => {
            retryCount++;
            injected = false;
            loadCache();
            injectButtons();
            if (injected || retryCount > 30) { clearInterval(retryTimer); retryTimer = null; retryCount = 0; }
        }, 800);
    }

    loadCache();
    if (isFilterPage()) setTimeout(injectButtons, 1200);

})();

(function () {
    'use strict';

    // --- Header search ---
    // Panel under the site's search popout. /search reads q, tags, stars, creator, musicArtist itself; other
    // params stay in the page URL and the fetch wrapper adds them to its API calls. /api/videos/search ignores
    // rating, quality, ratio and date, so those are applied here. Plain "Everything" text is left to the site.

    const SCOPE_KEY  = 'pmvx_search_scope_v1';
    const FILTER_KEY = 'pmvx_search_filters_v1';
    const FOPEN_KEY  = 'pmvx_search_filters_open_v1';
    const RECENT_KEY = 'pmvx_search_recent_v1';
    const RECENT_MAX = 8;
    const DUR_MAX = 30; // minutes; slider's top end = no maximum

    const SCOPES = [
        { id: 'all',     label: 'Everything', ph: 'Search everything...' },
        { id: 'title',   label: 'Title',      ph: 'Search titles only...' },
        { id: 'tag',     label: 'Tags',       ph: 'Find a tag...' },
        { id: 'star',    label: 'Stars',      ph: 'Find a star...' },
        { id: 'creator', label: 'Creator',    ph: 'Find a creator...' },
        { id: 'music',   label: 'Music',      ph: 'Find an artist...' },
    ];
    const enc = encodeURIComponent;
    // inc/exc: the API (and /search URL) parameters; single: one value only.
    const KINDS = {
        tag:     { label: 'Tag',     sym: '#', inc: 'tags',        exc: 'excludeTags',
                   ac: q => `/api/tags/autocomplete?q=${enc(q)}&type=general&limit=8` },
        star:    { label: 'Star',    sym: '✦', inc: 'stars',       exc: 'excludeStars',
                   ac: q => `/api/tags/autocomplete?q=${enc(q)}&type=stars&limit=8` },
        creator: { label: 'Creator', sym: '@', inc: 'creator',     exc: 'excludeCreators', single: true,
                   ac: q => `/api/creators/autocomplete?q=${enc(q)}&limit=8` },
        music:   { label: 'Artist',  sym: '♪', inc: 'musicArtist', exc: null, single: true,
                   ac: q => `/api/music/artists/autocomplete?q=${enc(q)}&limit=8` },
    };
    const SORTS = [
        { v: '',                t: 'Relevance',    s: 'Best match first' },
        { v: '-uploadDate',     t: 'Newest',       s: 'Most recent uploads' },
        { v: 'uploadDate',      t: 'Oldest',       s: 'Oldest uploads' },
        { v: '-bayesianRating', t: 'Most popular', s: 'Highest rating' },
        { v: '-likes',          t: 'Most liked',   s: 'Most likes' },
    ];
    const RATINGS = [{ v: 0, t: 'Any' }, { v: 60, t: '60%+' }, { v: 70, t: '70%+' }, { v: 80, t: '80%+' }, { v: 90, t: '90%+' }];
    const QUALITIES = [{ v: 0, t: 'Any' }, { v: 720, t: '720p+' }, { v: 1080, t: '1080p+' }, { v: 2160, t: '4K' }];
    const ASPECTS = [{ v: '', t: 'Any' }, { v: '16:9', t: '16:9' }, { v: '9:16', t: 'Vertical' }, { v: '4:3', t: '4:3' }, { v: '1:1', t: '1:1' }];
    const DATES = [{ v: 0, t: 'Any time' }, { v: 1, t: 'Today' }, { v: 7, t: 'This week' }, { v: 30, t: 'This month' }, { v: 365, t: 'This year' }];
    const DUR_PRESETS = [
        { a: 0, b: DUR_MAX, label: 'Any' }, { a: 0, b: 4, label: 'Under 4 min' },
        { a: 4, b: 10, label: '4–10 min' }, { a: 10, b: DUR_MAX, label: '10 min+' }, { a: 20, b: DUR_MAX, label: '20 min+' },
    ];
    const F_DEFAULT = { sort: '', durMin: 0, durMax: DUR_MAX, rating: 0, quality: 0, aspect: '', days: 0 };

    const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
    const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

    let scope = SCOPES.some(s => s.id === load(SCOPE_KEY, 'all')) ? load(SCOPE_KEY, 'all') : 'all';
    const F = Object.assign({}, F_DEFAULT, load(FILTER_KEY, {}));
    let filtersOpen = !!load(FOPEN_KEY, false);
    let terms = [];       // [{ kind, name, neg }]
    let sugg = [];        // [{ kind, name, count }]
    let hi = -1;
    let lastSearchFetch = 0;

    const isDefaultFilters = f => Object.keys(F_DEFAULT).every(k => f[k] === F_DEFAULT[k]);

    // --- Query <-> URL, and the /search page's API calls ---
    function buildParams(st) {
        const p = new URLSearchParams();
        if (st.text) p.set('q', st.text);
        if (st.text && st.scope === 'title') p.set('in', 'title');
        for (const [kind, k] of Object.entries(KINDS)) {
            const inc = st.terms.filter(t => t.kind === kind && !t.neg).map(t => t.name);
            const exc = st.terms.filter(t => t.kind === kind && t.neg).map(t => t.name);
            if (inc.length) p.set(k.inc, k.single ? inc[inc.length - 1] : inc.join(','));
            if (exc.length && k.exc) p.set(k.exc, exc.join(','));
        }
        const f = st.f;
        if (f.sort) p.set('sort', f.sort);
        if (f.durMin > 0) p.set('durationMin', String(f.durMin * 60));
        if (f.durMax < DUR_MAX) p.set('durationMax', String(f.durMax * 60));
        if (f.rating > 0) p.set('minRating', String(f.rating));
        if (f.quality > 0) p.set('minHeight', String(f.quality));
        if (f.aspect) p.set('aspect', f.aspect);
        if (f.days > 0) {
            const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (f.days - 1));
            p.set('uploadDateFrom', d.toISOString());
        }
        return p;
    }

    // Params /search does not read itself; added to its API calls only when missing (the page's own win).
    const EXTRA_KEYS = ['sort', 'durationMin', 'durationMax', 'minRating', 'minHeight', 'aspect', 'uploadDateFrom',
                        'excludeTags', 'excludeStars', 'excludeCreators'];
    function pageExtras() {
        if ((location.pathname.replace(/\/$/, '') || '/') !== '/search') return null;
        const sp = new URLSearchParams(location.search);
        const ex = {};
        let any = false;
        [...EXTRA_KEYS, 'in'].forEach(k => { const v = sp.get(k); if (v) { ex[k] = v; any = true; } });
        if (!any) return null;
        ex.q = sp.get('q') || '';
        return ex;
    }
    const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    function aspectOk(v, want) {
        const w = Number(v.width), h = Number(v.height);
        if (want === '9:16' && v.isVertical) return true;
        if (!(w > 0 && h > 0)) return true; // unknown: keep
        const r = w / h;
        switch (want) {
            case '16:9': return r >= 1.6 && r <= 1.9;
            case '9:16': return r <= 0.7;
            case '4:3':  return r >= 1.25 && r < 1.45;
            case '1:1':  return r >= 0.9 && r <= 1.1;
            case '21:9': return r > 2.1;
            default: return true;
        }
    }
    function keepVideo(v, ex) {
        if (!v || typeof v !== 'object') return true;
        if (ex.in === 'title' && ex.q) {
            const title = fold(v.title);
            const words = fold(PMVX.plainQuotes(ex.q)).replace(/"/g, ' ').split(/\s+/).filter(Boolean);
            if (!words.every(w => title.includes(w))) return false;
        }
        const minR = Number(ex.minRating);
        if (minR > 0 && typeof v.bayesianRating === 'number' && v.bayesianRating < minR) return false;
        const minH = Number(ex.minHeight);
        if (minH > 0 && Number(v.height) > 0 && Number(v.height) < minH) return false;
        if (ex.aspect && !aspectOk(v, ex.aspect)) return false;
        if (ex.uploadDateFrom && v.uploadDate) {
            const from = Date.parse(ex.uploadDateFrom), at = Date.parse(v.uploadDate);
            if (from && at && at < from) return false;
        }
        return true;
    }

    const _fetch = window.fetch;
    const SEARCH_API = /\/api\/videos(\/search)?(\?|$)/;
    window.fetch = async function (...args) {
        let ex = null, isText = false;
        try {
            const a0 = args[0];
            const raw = typeof a0 === 'string' ? a0 : a0 instanceof Request ? a0.url : a0 instanceof URL ? a0.href : '';
            if (raw && SEARCH_API.test(raw) && (location.pathname.replace(/\/$/, '') === '/search')) {
                const u = new URL(raw, location.origin);
                if (u.origin === location.origin && u.searchParams.has('page')) {
                    lastSearchFetch = Date.now();
                    ex = pageExtras();
                    isText = /\/api\/videos\/search$/.test(u.pathname);
                    let changed = false;
                    if (ex) EXTRA_KEYS.forEach(k => { if (ex[k] && !u.searchParams.has(k)) { u.searchParams.set(k, ex[k]); changed = true; } });
                    if (changed) {
                        const s = u.pathname + u.search;
                        args[0] = a0 instanceof Request ? new Request(s, a0) : s;
                    }
                }
            }
        } catch {}
        const res = await _fetch.apply(this, args);
        if (!ex || !isText || !res.ok) return res;
        if (!(ex.in === 'title' || ex.minRating || ex.minHeight || ex.aspect || ex.uploadDateFrom)) return res;
        try {
            const json = await res.clone().json();
            const list = Array.isArray(json?.data) ? json.data : null;
            if (!list) return res;
            const kept = list.filter(v => keepVideo(v, ex));
            if (kept.length === list.length) return res;
            json.data = kept;
            const headers = new Headers(res.headers);
            headers.delete('content-length'); headers.delete('content-encoding');
            return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
        } catch { return res; }
    };

    // --- The site's popout ---
    let container = null, mo = null, wasOpen = false;
    function findContainer() {
        if (container?.isConnected) return container;
        container = document.querySelector('.search-container');
        try { mo?.disconnect(); } catch {}
        mo = null;
        if (container) {
            mo = new MutationObserver(syncOpen);
            mo.observe(container, { attributes: true, attributeFilter: ['class'] });
        }
        return container;
    }
    const nativeInput = () => findContainer()?.querySelector('input[type="text"]') || null;
    const isOpen = () => !!findContainer()?.classList.contains('opacity-100');
    const box = () => findContainer()?.firstElementChild || container;

    function setNativeValue(v) {
        const inp = nativeInput();
        if (!inp) return;
        inp.value = v;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function closeNative() {
        const btns = findContainer()?.querySelectorAll('button');
        const x = btns && btns[btns.length - 1];
        if (x && !x.matches('[aria-label="Search"]')) x.click();
    }

    // --- Panel ---
    const SVG_STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/></svg>';
    const SVG_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    const SVG_BAN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
    const SVG_FILTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H3m9 14H3M14 3v4m2 10v4m5-9h-9m9 7h-5m5-14h-7m-6 5v4m0-2H3"/></svg>';
    const SVG_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    const SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    const SVG_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
    const SVG_MUSIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="18" r="4"/><path d="M12 18V2l7 4"/></svg>';
    const SVG_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>';
    const SVG_HASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>';
    const KIND_ICON = { tag: SVG_HASH, star: SVG_STAR, creator: SVG_USER, music: SVG_MUSIC };

    function injectStyle() {
        if (document.getElementById('pmvsx-style')) return;
        const st = document.createElement('style');
        st.id = 'pmvsx-style';
        st.textContent = `
#pmvsx{position:fixed;z-index:70;display:none;flex-direction:column;background:#1A1A1A;border:1px solid #2A2A2A;border-radius:8px;
  box-shadow:0 12px 32px rgba(0,0,0,0.55);overflow:hidden;font-family:inherit;color:rgb(209,213,219);}
#pmvsx[data-open="1"]{display:flex;}
#pmvsx *{box-sizing:border-box;}
#pmvsx svg{width:12px;height:12px;flex-shrink:0;}
.pmvsx-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;}
.pmvsx-row{display:flex;flex-wrap:wrap;gap:4px;align-items:center;}
.pmvsx-lab{font-size:10px;font-weight:600;color:rgb(156,163,175);text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:6px;margin-bottom:5px;}
.pmvsx-lab .r{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400;color:rgba(255,255,255,0.35);font-variant-numeric:tabular-nums;}
.pmvsx-lab button{background:none;border:none;padding:0;cursor:pointer;color:rgba(255,255,255,0.4);font-size:10px;font-family:inherit;text-transform:none;letter-spacing:0;font-weight:400;}
.pmvsx-lab button:hover{color:#fff;}
.pmvsx-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:4px;border:none;cursor:pointer;background:#272727;
  color:rgb(209,213,219);font-size:11px;font-weight:500;line-height:1.2;font-family:inherit;white-space:nowrap;transition:background .15s,color .15s;}
.pmvsx-chip:hover{background:#323232;}
.pmvsx-chip.active{background:rgb(249,115,22);color:#fff;}
.pmvsx-term{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 6px;border-radius:4px;border:1px solid transparent;cursor:pointer;
  font-size:11px;line-height:16px;font-family:inherit;max-width:100%;}
.pmvsx-term .txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmvsx-term .x{display:inline-flex;opacity:.6;padding:2px;border-radius:3px;}
.pmvsx-term .x:hover{opacity:1;background:rgba(255,255,255,0.12);}
.pmvsx-term.pos{background:rgba(245,158,11,0.16);color:rgb(252,211,77);}
.pmvsx-term.pos.star{background:rgba(234,179,8,.14);border-color:rgba(234,179,8,.45);color:rgb(253,224,71);}
.pmvsx-term.neg{background:rgba(239,68,68,0.18);color:rgb(252,165,165);} .pmvsx-term.neg .txt{text-decoration:line-through;}
.pmvsx-list{display:flex;flex-direction:column;margin:0 -12px;}
.pmvsx-item{display:flex;align-items:center;gap:10px;padding:7px 12px;cursor:pointer;font-size:12px;color:#fff;}
.pmvsx-item:hover,.pmvsx-item[data-hi="1"]{background:rgba(249,115,22,0.10);}
.pmvsx-item .ic{display:inline-flex;color:rgb(156,163,175);}
.pmvsx-item .ic.star{color:rgb(250,204,21);}
.pmvsx-item .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmvsx-item .nm b{color:rgb(251,146,60);font-weight:600;}
.pmvsx-item .su{color:rgb(107,114,128);font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums;}
.pmvsx-item .act{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;border:none;background:transparent;
  color:rgb(107,114,128);cursor:pointer;padding:0;}
.pmvsx-item .act:hover{background:rgba(239,68,68,0.18);color:rgb(252,165,165);}
.pmvsx-item .act.rm:hover{background:rgba(255,255,255,0.1);color:#fff;}
.pmvsx-empty{font-size:11px;color:rgb(107,114,128);padding:2px 0;}
.pmvsx-ftoggle{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:4px;border:none;cursor:pointer;background:#272727;
  color:rgb(209,213,219);font-size:11px;font-weight:500;font-family:inherit;}
.pmvsx-ftoggle:hover{background:#323232;}
.pmvsx-ftoggle[data-active="1"]{background:rgb(249,115,22);color:#fff;}
.pmvsx-ftoggle .chev{display:inline-flex;transition:transform .15s;} .pmvsx-ftoggle[data-open="1"] .chev{transform:rotate(180deg);}
.pmvsx-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;background:rgba(249,115,22,0.12);color:rgb(251,146,60);
  font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;}
.pmvsx-fbody{display:none;flex-direction:column;gap:10px;padding:10px;border-radius:8px;background:#111;border:1px solid #1F1F1F;}
.pmvsx-fbody[data-open="1"]{display:flex;}
.pmvsx-sel{position:relative;display:inline-flex;}
.pmvsx-selbtn{display:inline-flex;align-items:center;gap:8px;min-width:170px;padding:6px 10px;border-radius:6px;cursor:pointer;text-align:left;
  background:#0F0F0F;border:1px solid #2A2A2A;color:#fff;font-size:12px;font-family:inherit;}
.pmvsx-selbtn:hover{border-color:#3A3A3A;} .pmvsx-selbtn[data-open="1"]{border-color:rgb(249,115,22);}
.pmvsx-selbtn .t{flex:1;} .pmvsx-selbtn .chev{display:inline-flex;color:rgb(156,163,175);transition:transform .15s;}
.pmvsx-selbtn[data-open="1"] .chev{transform:rotate(180deg);}
.pmvsx-dd{position:fixed;z-index:71;min-width:220px;border-radius:10px;background:#141414;border:1px solid rgba(249,115,22,0.45);
  box-shadow:0 12px 32px rgba(0,0,0,0.6);overflow:hidden;}
.pmvsx-dd .o{display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;border-bottom:1px solid #1F1F1F;}
.pmvsx-dd .o:last-child{border-bottom:none;}
.pmvsx-dd .o:hover{background:rgba(255,255,255,0.04);} .pmvsx-dd .o[data-sel="1"]{background:rgba(249,115,22,0.12);}
.pmvsx-dd .tt{flex:1;min-width:0;} .pmvsx-dd .ti{display:block;color:#fff;font-size:12px;font-weight:500;}
.pmvsx-dd .su{display:block;color:rgb(156,163,175);font-size:10px;margin-top:1px;}
.pmvsx-dd .ck{display:inline-flex;color:rgb(249,115,22);visibility:hidden;} .pmvsx-dd .o[data-sel="1"] .ck{visibility:visible;}
.pmvsx-dd .ck svg{width:14px;height:14px;}
.pmvsx-pillrow{display:flex;justify-content:center;}
.pmvsx-pill.range{font-size:11px;}
.pmvsx-slider{position:relative;height:26px;}
.pmvsx-slider .track{position:absolute;top:11px;left:0;right:0;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);}
.pmvsx-slider .fill{position:absolute;top:11px;height:4px;border-radius:2px;background:linear-gradient(90deg,rgb(249,115,22),rgb(251,146,60));}
.pmvsx-slider input[type=range]{position:absolute;top:11px;left:0;width:100%;height:4px;margin:0;padding:0;-webkit-appearance:none;appearance:none;background:transparent;pointer-events:none;outline:none;}
.pmvsx-slider input[type=range]::-webkit-slider-runnable-track{background:transparent;height:4px;}
.pmvsx-slider input[type=range]::-moz-range-track{background:transparent;height:4px;border:none;}
.pmvsx-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;border:3px solid rgb(249,115,22);box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;}
.pmvsx-slider input[type=range]::-moz-range-thumb{pointer-events:auto;width:8px;height:8px;border-radius:50%;background:#fff;border:3px solid rgb(249,115,22);box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;}
.pmvsx-ends{display:flex;justify-content:space-between;color:rgba(255,255,255,0.35);font-size:10px;margin:-4px 0 4px;}
.pmvsx-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid #2A2A2A;background:#1A1A1A;flex-shrink:0;}
.pmvsx-hint{flex:1;min-width:0;font-size:10px;color:rgba(255,255,255,0.35);line-height:1.4;}
.pmvsx-hint kbd{font-family:inherit;font-size:10px;padding:0 4px;border-radius:3px;background:#272727;color:rgb(209,213,219);}
.pmvsx-go{padding:6px 12px;border-radius:4px;border:none;cursor:pointer;background:rgb(249,115,22);color:#fff;font-size:11px;font-weight:600;font-family:inherit;}
.pmvsx-go:hover{background:rgb(234,88,12);}
.pmvsx-go:disabled{opacity:.4;cursor:default;background:rgb(249,115,22);}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const ico = (svg, cls) => { const s = mk('span', cls || 'ic'); s.innerHTML = svg; s.style.display = 'inline-flex'; return s; };
    const fmtCount = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); };
    const fmtMin = (m, top) => top && m >= DUR_MAX ? `${DUR_MAX}+ min` : `${m} min`;

    let panel = null, el = {};
    function buildPanel() {
        if (panel?.isConnected) return panel;
        injectStyle();
        panel = mk('div'); panel.id = 'pmvsx';
        panel.setAttribute('data-pmvx-search', '1');
        // The site closes and clears its search on any click outside its box: keep ours inside.
        panel.addEventListener('click', e => { e.stopPropagation(); if (dd && !dd.contains(e.target) && !e.target.closest('.pmvsx-selbtn')) closeDd(); });
        // Keep the caret in the site's input.
        panel.addEventListener('mousedown', e => { if (!e.target.closest('input')) e.preventDefault(); });

        const body = mk('div', 'pmvsx-body');
        const secScope = mk('div');
        const scopeLab = mk('div', 'pmvsx-lab', 'Search in');
        el.scopeHint = mk('span', 'r');
        scopeLab.appendChild(el.scopeHint);
        el.scopes = mk('div', 'pmvsx-row');
        secScope.append(scopeLab, el.scopes);
        el.terms = mk('div', 'pmvsx-row');
        el.list = mk('div');
        const secF = mk('div');
        const fRow = mk('div', 'pmvsx-row');
        el.ftoggle = mk('button', 'pmvsx-ftoggle'); el.ftoggle.type = 'button';
        el.ftoggle.append(ico(SVG_FILTER, ''), mk('span', null, 'Filters'), ico(SVG_CHEV, 'chev'));
        el.ftoggle.onclick = () => { filtersOpen = !filtersOpen; save(FOPEN_KEY, filtersOpen); renderFilters(); place(); };
        el.fsum = mk('span', 'pmvsx-row');
        el.freset = mk('button', 'pmvsx-chip', 'Reset'); el.freset.type = 'button';
        el.freset.style.marginLeft = 'auto';
        el.freset.onclick = () => { Object.assign(F, F_DEFAULT); save(FILTER_KEY, F); renderFilters(); };
        fRow.append(el.ftoggle, el.fsum, el.freset);
        el.fbody = mk('div', 'pmvsx-fbody');
        el.fbody.style.marginTop = '8px';
        buildFilterBody(el.fbody);
        secF.append(fRow, el.fbody);

        body.append(secScope, el.terms, el.list, secF);
        const foot = mk('div', 'pmvsx-foot');
        el.hint = mk('div', 'pmvsx-hint');
        el.hint.innerHTML = '<kbd>↵</kbd> search · <kbd>Tab</kbd> where · <kbd>↑</kbd><kbd>↓</kbd> pick · <kbd>#</kbd>tag <kbd>*</kbd>star <kbd>@</kbd>creator, <kbd>-</kbd> to exclude · click a chip to exclude it';
        el.go = mk('button', 'pmvsx-go', 'Search'); el.go.type = 'button';
        el.go.onclick = () => { submit(true); };
        foot.append(el.hint, el.go);
        panel.append(body, foot);
        document.body.appendChild(panel);
        return panel;
    }

    let dd = null;
    function closeDd() { if (dd) { dd.remove(); dd = null; el.sortBtn?.setAttribute('data-open', '0'); } }
    function chipRow(items, get, set) {
        const row = mk('div', 'pmvsx-row');
        const btns = items.map(it => {
            const b = mk('button', 'pmvsx-chip', it.t); b.type = 'button';
            b.onclick = () => { set(it.v); save(FILTER_KEY, F); renderFilters(); };
            row.appendChild(b);
            return b;
        });
        return { el: row, render: () => btns.forEach((b, i) => b.classList.toggle('active', items[i].v === get())) };
    }
    const fRenders = [];
    function section(parent, label, node) {
        const s = mk('div');
        const lab = mk('div', 'pmvsx-lab', label);
        s.append(lab, node);
        parent.appendChild(s);
        return lab;
    }
    function buildFilterBody(fb) {
        const sel = mk('div', 'pmvsx-sel');
        el.sortBtn = mk('button', 'pmvsx-selbtn'); el.sortBtn.type = 'button';
        const st = mk('span', 't');
        el.sortBtn.append(st, ico(SVG_CHEV, 'chev'));
        el.sortBtn.onclick = () => {
            if (dd) { closeDd(); return; }
            dd = mk('div', 'pmvsx-dd');
            SORTS.forEach(o => {
                const row = mk('div', 'o'); row.dataset.sel = o.v === F.sort ? '1' : '0';
                const tt = mk('div', 'tt'); tt.append(mk('span', 'ti', o.t), mk('span', 'su', o.s));
                row.append(tt, ico(SVG_CHECK, 'ck'));
                row.onclick = () => { F.sort = o.v; save(FILTER_KEY, F); closeDd(); renderFilters(); };
                dd.appendChild(row);
            });
            panel.appendChild(dd); // inside the panel: no outside click for the site
            const r = el.sortBtn.getBoundingClientRect();
            dd.style.left = Math.max(8, Math.min(r.left, innerWidth - 228)) + 'px';
            const h = dd.getBoundingClientRect().height;
            dd.style.top = (r.bottom + 4 + h > innerHeight - 8 && r.top - 4 - h > 8 ? r.top - 4 - h : r.bottom + 4) + 'px';
            el.sortBtn.dataset.open = '1';
        };
        sel.appendChild(el.sortBtn);
        section(fb, 'Sort by', sel);
        fRenders.push(() => { st.textContent = (SORTS.find(o => o.v === F.sort) || SORTS[0]).t; });

        const wrap = mk('div');
        const pillRow = mk('div', 'pmvsx-pillrow'); const pill = mk('span', 'pmvsx-pill range'); pillRow.appendChild(pill);
        const slider = mk('div', 'pmvsx-slider'); const fill = mk('div', 'fill');
        const rA = mk('input'); rA.type = 'range'; rA.min = '0'; rA.max = String(DUR_MAX); rA.step = '1';
        const rB = mk('input'); rB.type = 'range'; rB.min = '0'; rB.max = String(DUR_MAX); rB.step = '1';
        slider.append(mk('div', 'track'), fill, rA, rB);
        const ends = mk('div', 'pmvsx-ends'); ends.append(mk('span', null, '0 min'), mk('span', null, `${DUR_MAX}+ min`));
        const presets = mk('div', 'pmvsx-row');
        const pBtns = DUR_PRESETS.map(p => {
            const b = mk('button', 'pmvsx-chip', p.label); b.type = 'button';
            b.onclick = () => { F.durMin = p.a; F.durMax = p.b; save(FILTER_KEY, F); renderFilters(); };
            presets.appendChild(b); return b;
        });
        const paint = (a, b) => {
            pill.textContent = a === 0 && b >= DUR_MAX ? 'Any length' : `${fmtMin(a)} – ${fmtMin(b, true)}`;
            fill.style.left = (a / DUR_MAX * 100) + '%';
            fill.style.width = (Math.max(0, b - a) / DUR_MAX * 100) + '%';
            pBtns.forEach((c, i) => c.classList.toggle('active', DUR_PRESETS[i].a === a && DUR_PRESETS[i].b === b));
        };
        const onInput = which => () => {
            let a = parseInt(rA.value, 10), b = parseInt(rB.value, 10);
            if (a > b) { if (which === 'a') { b = a; rB.value = String(b); } else { a = b; rA.value = String(a); } }
            F.durMin = a; F.durMax = b; paint(a, b);
        };
        rA.addEventListener('input', onInput('a')); rB.addEventListener('input', onInput('b'));
        const done = () => { save(FILTER_KEY, F); renderFilters(); nativeInput()?.focus(); };
        rA.addEventListener('change', done); rB.addEventListener('change', done);
        wrap.append(pillRow, slider, ends, presets);
        section(fb, 'Length', wrap);
        fRenders.push(() => { rA.value = String(F.durMin); rB.value = String(F.durMax); paint(F.durMin, F.durMax); });

        const rating = chipRow(RATINGS, () => F.rating, v => { F.rating = v; });
        section(fb, 'Rating', rating.el); fRenders.push(rating.render);
        const quality = chipRow(QUALITIES, () => F.quality, v => { F.quality = v; });
        section(fb, 'Quality', quality.el); fRenders.push(quality.render);
        const aspect = chipRow(ASPECTS, () => F.aspect, v => { F.aspect = v; });
        section(fb, 'Aspect ratio', aspect.el); fRenders.push(aspect.render);
        const date = chipRow(DATES, () => F.days, v => { F.days = v; });
        section(fb, 'Uploaded', date.el); fRenders.push(date.render);
    }

    function filterSummary(f) {
        const out = [];
        if (f.sort) out.push((SORTS.find(o => o.v === f.sort) || {}).t);
        if (f.durMin > 0 || f.durMax < DUR_MAX) out.push(f.durMax >= DUR_MAX ? `${f.durMin}+ min` : f.durMin === 0 ? `< ${f.durMax} min` : `${f.durMin}–${f.durMax} min`);
        if (f.rating) out.push(`${f.rating}%+`);
        if (f.quality) out.push((QUALITIES.find(o => o.v === f.quality) || {}).t);
        if (f.aspect) out.push((ASPECTS.find(o => o.v === f.aspect) || {}).t);
        if (f.days) out.push((DATES.find(o => o.v === f.days) || {}).t);
        return out.filter(Boolean);
    }
    function renderFilters() {
        if (!panel) return;
        fRenders.forEach(fn => fn());
        const sum = filterSummary(F);
        el.fsum.replaceChildren(...sum.map(s => mk('span', 'pmvsx-pill', s)));
        el.ftoggle.dataset.active = sum.length ? '1' : '0';
        el.ftoggle.dataset.open = filtersOpen ? '1' : '0';
        el.fbody.dataset.open = filtersOpen ? '1' : '0';
        el.freset.style.display = sum.length ? '' : 'none';
        renderGo();
    }

    function renderScopes() {
        el.scopes.replaceChildren(...SCOPES.map(s => {
            const b = mk('button', 'pmvsx-chip' + (s.id === scope ? ' active' : ''), s.label); b.type = 'button';
            b.onclick = () => setScope(s.id);
            return b;
        }));
        el.scopeHint.textContent = scope === 'title' ? 'only titles, not tags or descriptions'
            : scope === 'all' ? "the site's own search" : 'pick a suggestion or press ↵';
        const inp = nativeInput();
        if (inp) inp.placeholder = (SCOPES.find(s => s.id === scope) || SCOPES[0]).ph;
    }
    function setScope(id) {
        scope = id; save(SCOPE_KEY, scope);
        renderScopes(); refreshSuggestions(); renderGo();
        nativeInput()?.focus();
    }

    function termEl(t, i) {
        const k = KINDS[t.kind];
        const c = mk('span', 'pmvsx-term ' + (t.neg ? 'neg' : 'pos') + (t.kind === 'star' ? ' star' : ''));
        if (t.neg) c.appendChild(ico(SVG_BAN, ''));
        c.appendChild(t.kind === 'star' ? ico(SVG_STAR, '') : mk('span', null, k.sym));
        c.appendChild(mk('span', 'txt', t.name));
        const x = ico(SVG_X, 'x'); x.title = 'Remove';
        x.onclick = e => { e.stopPropagation(); terms.splice(i, 1); renderTerms(); };
        c.appendChild(x);
        c.title = `${k.label}: ${t.neg ? 'excluded' : 'required'}` + (k.exc ? ' — click to ' + (t.neg ? 'require' : 'exclude') : '');
        c.onclick = () => { if (!k.exc) return; t.neg = !t.neg; renderTerms(); };
        return c;
    }
    function renderTerms() {
        el.terms.replaceChildren(...terms.map(termEl));
        el.terms.style.display = terms.length ? '' : 'none';
        renderList(); renderGo();
        place();
    }
    function addTerm(list, kind, name, neg) {
        name = String(name || '').trim();
        if (!name || !KINDS[kind]) return;
        if (neg && !KINDS[kind].exc) neg = false;
        const low = name.toLowerCase();
        for (let i = list.length - 1; i >= 0; i--) {
            const t = list[i];
            if (t.kind !== kind) continue;
            if (t.name.toLowerCase() === low || (KINDS[kind].single && !neg && !t.neg)) list.splice(i, 1);
        }
        list.push({ kind, name, neg: !!neg });
    }

    // Input prefixes: #tag, *star, @creator; a leading "-" excludes.
    function parseInput(raw) {
        let t = String(raw || '').trim(), neg = false, kind = null;
        if (/^-[#*@]/.test(t)) { neg = true; t = t.slice(1); }
        if (t[0] === '#') kind = 'tag'; else if (t[0] === '*') kind = 'star'; else if (t[0] === '@') kind = 'creator';
        if (kind) t = t.slice(1).trim();
        else if (KINDS[scope]) kind = scope;
        return { text: t, kind, neg };
    }

    // Site autocomplete: cached, debounced, last request wins.
    const acCache = new Map();
    async function acFetch(url) {
        if (acCache.has(url)) return acCache.get(url);
        const p = _fetch(url, { credentials: 'include' }).then(r => r.ok ? r.json() : null).then(j => Array.isArray(j?.data) ? j.data : []).catch(() => []);
        acCache.set(url, p);
        if (acCache.size > 120) acCache.delete(acCache.keys().next().value);
        return p;
    }
    const nameOf = it => typeof it === 'string' ? it : String(it?.name ?? it?.artist ?? '').trim();
    let acTimer = 0, acSeq = 0;
    function refreshSuggestions() {
        clearTimeout(acTimer);
        const p = parseInput(nativeInput()?.value || '');
        if (p.text.length < 2 || (!p.kind && scope === 'title')) { sugg = []; hi = -1; renderList(); return; }
        const seq = ++acSeq;
        acTimer = setTimeout(async () => {
            let out = [];
            if (p.kind) {
                const data = await acFetch(KINDS[p.kind].ac(p.text));
                out = data.map(it => ({ kind: p.kind, name: nameOf(it), count: it?.usageCount }));
            } else {
                // Everything: tags and stars come from one call, told apart by type.
                const [tags, creators] = await Promise.all([
                    acFetch(`/api/tags/autocomplete?q=${enc(p.text)}&limit=8`),
                    acFetch(KINDS.creator.ac(p.text)),
                ]);
                const ts = tags.map(it => ({ kind: it?.type === 'stars' ? 'star' : 'tag', name: nameOf(it), count: it?.usageCount }));
                out = [...ts.filter(s => s.kind === 'tag').slice(0, 4), ...ts.filter(s => s.kind === 'star').slice(0, 3),
                       ...creators.slice(0, 3).map(it => ({ kind: 'creator', name: nameOf(it), count: it?.usageCount }))];
            }
            if (seq !== acSeq) return;
            const have = new Set(terms.map(t => t.kind + '\n' + t.name.toLowerCase()));
            sugg = out.filter(s => s.name && !have.has(s.kind + '\n' + s.name.toLowerCase())).slice(0, 10);
            hi = -1;
            renderList();
        }, 160);
    }

    function highlight(name, q) {
        const span = mk('span', 'nm');
        const i = fold(name).indexOf(fold(q));
        if (!q || i < 0) { span.textContent = name; return span; }
        span.append(document.createTextNode(name.slice(0, i)), mk('b', null, name.slice(i, i + q.length)), document.createTextNode(name.slice(i + q.length)));
        return span;
    }
    function pickSuggestion(s, neg) {
        addTerm(terms, s.kind, s.name, neg ?? parseInput(nativeInput()?.value || '').neg);
        setNativeValue('');
        sugg = []; hi = -1;
        renderTerms();
        nativeInput()?.focus();
    }
    function renderList() {
        if (!panel) return;
        const raw = nativeInput()?.value || '';
        const p = parseInput(raw);
        const nodes = [];
        if (sugg.length) {
            const lab = mk('div', 'pmvsx-lab', 'Suggestions');
            const list = mk('div', 'pmvsx-list');
            sugg.forEach((s, i) => {
                const k = KINDS[s.kind];
                const row = mk('div', 'pmvsx-item'); row.dataset.hi = i === hi ? '1' : '0';
                row.append(ico(KIND_ICON[s.kind], 'ic' + (s.kind === 'star' ? ' star' : '')), highlight(s.name, p.text),
                           mk('span', 'su', k.label + (s.count ? ' · ' + fmtCount(s.count) : '')));
                if (k.exc) {
                    const ex = mk('button', 'act'); ex.type = 'button'; ex.innerHTML = SVG_BAN; ex.title = 'Exclude';
                    ex.onclick = e => { e.stopPropagation(); pickSuggestion(s, true); };
                    row.appendChild(ex);
                }
                row.title = `Add ${k.label.toLowerCase()} “${s.name}”` + (k.exc ? ' (⊘ excludes)' : '');
                row.onclick = () => pickSuggestion(s);
                row.onmouseenter = () => { if (hi !== i) { hi = i; list.querySelectorAll('.pmvsx-item').forEach((r, j) => r.dataset.hi = j === i ? '1' : '0'); } };
                list.appendChild(row);
            });
            nodes.push(lab, list);
        } else if (!raw.trim() && !terms.length) {
            const rec = load(RECENT_KEY, []);
            if (Array.isArray(rec) && rec.length) {
                const lab = mk('div', 'pmvsx-lab', 'Recent');
                const clr = mk('button', null, 'Clear'); clr.type = 'button'; clr.style.marginLeft = 'auto';
                clr.onclick = () => { save(RECENT_KEY, []); renderList(); place(); };
                lab.appendChild(clr);
                const list = mk('div', 'pmvsx-list');
                rec.forEach((st, i) => {
                    const row = mk('div', 'pmvsx-item');
                    row.append(ico(SVG_CLOCK, 'ic'), mk('span', 'nm', describe(st)));
                    const rm = mk('button', 'act rm'); rm.type = 'button'; rm.innerHTML = SVG_X; rm.title = 'Remove from recent';
                    rm.onclick = e => { e.stopPropagation(); const r = load(RECENT_KEY, []); r.splice(i, 1); save(RECENT_KEY, r); renderList(); place(); };
                    row.appendChild(rm);
                    row.title = 'Search again';
                    row.onclick = () => { pushRecent(st); go(st); };
                    list.appendChild(row);
                });
                nodes.push(lab, list);
            }
        } else if (p.kind && p.text.length >= 2) {
            nodes.push(mk('div', 'pmvsx-empty', `↵ adds ${KINDS[p.kind].label.toLowerCase()} “${p.text}”${p.neg ? ' as excluded' : ''} and searches`));
        }
        el.list.replaceChildren(...nodes);
        el.list.style.display = nodes.length ? '' : 'none';
    }

    function describe(st) {
        const parts = [];
        if (st.text) parts.push(`“${st.text}”` + (st.scope === 'title' ? ' in titles' : ''));
        (st.terms || []).forEach(t => parts.push((t.neg ? '⊘ ' : '') + KINDS[t.kind].sym + t.name));
        parts.push(...filterSummary(Object.assign({}, F_DEFAULT, st.f)));
        return parts.join(' · ') || '(empty)';
    }
    function pushRecent(st) {
        const key = describe(st);
        const rec = (load(RECENT_KEY, []) || []).filter(r => r && describe(r) !== key);
        rec.unshift({ text: st.text, scope: st.scope, terms: st.terms, f: st.f });
        save(RECENT_KEY, rec.slice(0, RECENT_MAX));
    }

    // Current search: chips plus the input (as a chip when prefixed).
    function snapshot() {
        const p = parseInput(nativeInput()?.value || '');
        const list = terms.map(t => ({ ...t }));
        let text = '';
        if (p.text) { if (p.kind) addTerm(list, p.kind, p.text, p.neg); else text = p.text; }
        return { text, scope: p.kind ? 'all' : scope, terms: list, f: { ...F } };
    }
    const isPlain = st => !st.terms.length && st.scope !== 'title' && isDefaultFilters(st.f);
    function renderGo() {
        if (!el.go) return;
        const st = snapshot();
        el.go.disabled = !st.text && !st.terms.length;
    }

    function go(st) {
        const qs = buildParams(st).toString();
        const url = '/search' + (qs ? '?' + qs : '');
        closeNative();
        hide();
        if ((location.pathname.replace(/\/$/, '') || '/') === '/search') { location.assign(url); return; }
        const router = document.querySelector('#__nuxt')?.__vue_app__?.config?.globalProperties?.$router;
        if (!router) { location.assign(url); return; }
        const t0 = Date.now();
        router.push(url).catch(() => location.assign(url));
        // A kept-alive /search page does not search again on a new URL: reload if it stayed quiet.
        setTimeout(() => {
            if ((location.pathname.replace(/\/$/, '') || '/') === '/search' && lastSearchFetch < t0) location.reload();
        }, 2500);
    }
    // Returns true when handled here (the site's own search must not run).
    function submit(force) {
        const st = snapshot();
        if (!st.text && !st.terms.length) return !!force;
        pushRecent(st);
        if (isPlain(st) && !force) return false;
        go(st);
        return true;
    }

    // --- Open / close / placement ---
    let followUntil = 0;
    function place() {
        if (!panel || panel.dataset.open !== '1') return;
        const b = box();
        if (!b) return;
        const r = b.getBoundingClientRect();
        if (!r.width) return;
        const w = Math.max(r.width, Math.min(420, innerWidth - 16));
        const left = Math.max(8, Math.min(r.left, innerWidth - 8 - w));
        const top = r.bottom + 6;
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.width = w + 'px';
        panel.style.maxHeight = Math.max(160, innerHeight - top - 12) + 'px';
    }
    function follow() {
        place();
        if (Date.now() < followUntil && panel?.dataset.open === '1') requestAnimationFrame(follow);
    }
    function show() {
        buildPanel();
        panel.dataset.open = '1';
        renderScopes(); renderTerms(); renderFilters(); refreshSuggestions();
        followUntil = Date.now() + 600; // the site's box slides in over 400 ms
        follow();
    }
    function hide() {
        closeDd();
        if (panel) panel.dataset.open = '0';
        terms = []; sugg = []; hi = -1; clearTimeout(acTimer); acSeq++;
    }
    function syncOpen() {
        const open = isOpen();
        if (open === wasOpen) return;
        wasOpen = open;
        if (open) show(); else hide();
    }

    // Capture: before the site's own Enter/Escape handlers.
    window.addEventListener('keydown', e => {
        const inp = nativeInput();
        if (!inp || e.target !== inp || !isOpen() || e.isComposing) return;
        const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!sugg.length) return;
            stop();
            hi = e.key === 'ArrowDown' ? (hi + 1) % sugg.length : (hi <= 0 ? sugg.length - 1 : hi - 1);
            renderList();
            panel?.querySelector('.pmvsx-item[data-hi="1"]')?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            if (hi >= 0 && sugg[hi]) { stop(); pickSuggestion(sugg[hi], e.shiftKey || undefined); return; }
            if (submit(false)) stop();
        } else if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
            stop();
            const i = SCOPES.findIndex(s => s.id === scope);
            setScope(SCOPES[(i + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length].id);
        } else if (e.key === 'Backspace' && !inp.value && terms.length) {
            stop(); terms.pop(); renderTerms();
        } else if (e.key === 'Escape' && (dd || hi >= 0)) {
            stop(); closeDd(); hi = -1; renderList();
        }
    }, true);
    window.addEventListener('click', e => {
        const btn = e.target?.closest?.('button[aria-label="Search"]');
        if (!btn || !findContainer()?.contains(btn) || !isOpen()) return;
        if (submit(false)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    document.addEventListener('input', e => {
        if (e.target !== nativeInput() || !isOpen()) return;
        refreshSuggestions(); renderList(); renderGo();
    }, true);
    window.addEventListener('resize', () => { closeDd(); place(); });

    // Vue may re-render the header: re-find the box and catch a missed open/close.
    findContainer();
    syncOpen();
    setInterval(() => { if (!document.hidden) { findContainer(); syncOpen(); } }, 1000);
    document.addEventListener('click', e => { if (e.target?.closest?.('.search-trigger')) setTimeout(() => { findContainer(); syncOpen(); }, 0); }, true);
})();

(function () {
    'use strict';

    // --- Tag menu ---
    // Tag, star and music chips open a menu instead of navigating; Ctrl/Cmd/Shift/middle click keep the link.
    // Stars load from /api/models/<slug> (knows aliases), else /api/videos?stars= (exact tag).
    // The "_pmvx" marker keeps these calls out of the browse module's pagination.

    const SORT_KEY = 'pmvx_star_sort_v2';
    const PAGE = 16;
    // Profile page sort values; `alt` is the same order on /api/videos.
    const SORTS = [
        { v: '-releaseDate',    alt: '-uploadDate',     t: 'Newest' },
        { v: 'releaseDate',     alt: 'uploadDate',      t: 'Oldest' },
        { v: '-views',          alt: '-views',          t: 'Most Viewed' },
        { v: '-bayesianRating', alt: '-bayesianRating', t: 'Highest Rated' },
    ];
    const enc = encodeURIComponent;
    let sort = (() => { try { const v = localStorage.getItem(SORT_KEY); return SORTS.some(s => s.v === v) ? v : '-bayesianRating'; } catch { return '-bayesianRating'; } })();

    const SVG_STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/></svg>';
    const SVG_HASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>';
    const SVG_DISC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M6 12c0-1.7.7-3.2 1.8-4.2"/><circle cx="12" cy="12" r="2"/><path d="M18 12c0 1.7-.7 3.2-1.8 4.2"/></svg>';
    const SVG_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    const SVG_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
    const SVG_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
    const SVG_BAN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
    const SVG_QUEUE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h13M3 12h9M3 18h9M17 11v8M13 15h8"/></svg>';
    const SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    const SVG_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
    const SVG_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
    const SVG_THUMB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
    const SVG_CHECKBADGE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2z"/><path d="m8.5 12 2.5 2.5 4.5-5" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const qparam = (a, k) => { try { return new URL(a.getAttribute('href') || '', location.origin).searchParams.get(k) || ''; } catch { return ''; } };
    const textOf = a => ((a.querySelector('.truncate')?.textContent || a.textContent || '').replace(/\s+/g, ' ').trim());

    // Chips under the player. read(a) -> { name, term, title, ... } or null.
    const KINDS = {
        tag: {
            sel: 'a[href^="/search?tags="]', icon: SVG_HASH, what: 'tag', go: 'Search results',
            read: a => { const t = (qparam(a, 'tags').split(',')[0] || textOf(a).replace(/^#/, '')).trim(); return t ? { name: t, title: '#' + t, term: t } : null; },
        },
        star: {
            sel: 'a[href^="/model/"]', icon: SVG_STAR, what: 'star', go: 'Full profile',
            read: a => {
                const n = textOf(a);
                const slug = decodeURIComponent((a.getAttribute('href') || '').replace(/^\/model\//, '').split(/[?#]/)[0]);
                return n ? { name: n, title: n, term: n, slug: slug || n } : null;
            },
        },
        music: {
            sel: 'a[href^="/search?musicArtist="]', icon: SVG_DISC, what: 'artist', go: 'Search results',
            read: a => {
                const artist = qparam(a, 'musicArtist').trim(), song = qparam(a, 'musicSong').trim();
                return artist ? { name: artist, title: song ? `${artist} – ${song}` : artist, term: artist, artist, song } : null;
            },
        },
    };
    const ANY_SEL = Object.values(KINDS).map(k => k.sel).join(', ');
    const kindOf = a => Object.keys(KINDS).find(k => a.matches(KINDS[k].sel)) || null;

    // Card chips: buttons in the card link titled "Search for: …"; music reads "Artist - Song" (split on the
    // first " - "). The "+N" button has another title and stays native.
    const CARD_CHIP_SEL = 'a[href^="/video/"] button[title^="Search for:"]';
    function readCardChip(b) {
        const txt = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) return null;
        if (txt[0] === '#') {
            const t = txt.slice(1).trim();
            return t ? { kind: 'tag', item: { name: t, title: '#' + t, term: t, href: '/search?' + new URLSearchParams({ tags: t }) } } : null;
        }
        if (!b.querySelector('svg') && !/green/.test(b.className)) return null;
        const i = txt.indexOf(' - ');
        const artist = (i > 0 ? txt.slice(0, i) : txt).trim(), song = (i > 0 ? txt.slice(i + 3) : '').trim();
        if (!artist) return null;
        const q = { musicArtist: artist }; if (song) q.musicSong = song;
        return { kind: 'music', item: { name: artist, title: song ? `${artist} – ${song}` : artist, term: artist, artist, song, href: '/search?' + new URLSearchParams(q) } };
    }
    // Player links count only on video pages (a /model/ link elsewhere is plain navigation).
    function chipAt(target) {
        const b = target?.closest?.(CARD_CHIP_SEL);
        if (b) { const r = readCardChip(b); return r ? { el: b, ...r } : null; }
        // Also in the video info on playlist pages (#pmv-vinfo).
        if (!isVideoPage() && !target?.closest?.('#pmv-vinfo')) return null;
        const a = target?.closest?.(ANY_SEL);
        if (!a) return null;
        const kind = kindOf(a);
        const item = kind && KINDS[kind].read(a);
        return item ? { el: a, kind, item } : null;
    }

    const isVideoPage = () => /^\/video\//.test(location.pathname);
    const currentVideoId = () => PMVX.state?.currentVideoId || location.pathname.match(/([a-f0-9]{24})\/?$/i)?.[1] || null;

    function injectStyle() {
        if (document.getElementById('pmvst-style')) return;
        const st = document.createElement('style');
        st.id = 'pmvst-style';
        st.textContent = `
#pmvst{position:fixed;z-index:80;display:flex;flex-direction:column;width:min(360px,calc(100vw - 16px));background:#1A1A1A;border:1px solid #2A2A2A;
  border-radius:12px;box-shadow:0 20px 40px rgba(0,0,0,0.6);overflow:hidden;font-family:inherit;color:rgb(209,213,219);
  --acc:249,115,22;--acc-fg:253,186,116;}
#pmvst[data-kind="star"]{--acc:234,179,8;--acc-fg:253,224,71;}
#pmvst[data-kind="music"]{--acc:34,197,94;--acc-fg:134,239,172;}
#pmvst *{box-sizing:border-box;}
#pmvst svg{flex-shrink:0;}
.pmvst-head{display:flex;align-items:center;gap:10px;padding:12px 12px 10px;}
.pmvst-av{width:40px;height:40px;border-radius:9999px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;
  background:rgba(var(--acc),0.2);border:1px solid rgba(var(--acc),0.45);color:rgb(var(--acc-fg));}
#pmvst[data-kind="tag"] .pmvst-av{border-radius:10px;}
.pmvst-av img{width:100%;height:100%;object-fit:cover;display:block;}
.pmvst-av svg{width:18px;height:18px;}
.pmvst-who{flex:1;min-width:0;}
.pmvst-name{display:flex;align-items:center;gap:5px;color:#fff;font-size:15px;font-weight:700;line-height:1.25;}
.pmvst-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmvst-name svg{width:14px;height:14px;color:rgb(250,204,21);}
.pmvst-sub{font-size:12px;color:rgb(156,163,175);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;}
.pmvst-close{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:rgb(156,163,175);cursor:pointer;flex-shrink:0;}
.pmvst-close:hover{background:#2A2A2A;color:#fff;} .pmvst-close svg{width:16px;height:16px;}
.pmvst-acts{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px;border-bottom:1px solid #2A2A2A;}
.pmvst-row{display:flex;align-items:center;gap:6px;}
.pmvst-lab{font-size:10px;font-weight:600;color:rgb(107,114,128);text-transform:uppercase;letter-spacing:.05em;width:44px;flex-shrink:0;}
.pmvst-fbtn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:7px 8px;border-radius:8px;border:1px solid #2A2A2A;
  background:#141414;color:rgb(209,213,219);font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s;}
.pmvst-fbtn svg{width:13px;height:13px;}
.pmvst-fbtn:hover{border-color:#3A3A3A;color:#fff;}
.pmvst-fbtn.inc[data-on="1"]{background:rgba(245,158,11,0.18);border-color:rgba(245,158,11,0.6);color:rgb(252,211,77);}
.pmvst-fbtn.exc[data-on="1"]{background:rgba(239,68,68,0.18);border-color:rgba(239,68,68,0.6);color:rgb(252,165,165);}
.pmvst-fbtn.exc[data-on="1"] .t{text-decoration:line-through;}
.pmvst-go{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 10px;border-radius:8px;border:none;background:rgb(249,115,22);
  color:#fff;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;transition:background .15s;}
.pmvst-go:hover{background:rgb(234,88,12);} .pmvst-go svg{width:13px;height:13px;}
.pmvst-sort{flex:1;min-width:0;padding:6px 8px;background:#141414;border:1px solid #1E1E1E;border-radius:8px;color:#fff;font-size:12px;font-family:inherit;cursor:pointer;outline:none;}
.pmvst-sort:hover{border-color:#2A2A2A;} .pmvst-sort:focus{border-color:rgb(249,115,22);}
.pmvst-seg{display:inline-flex;border-radius:8px;overflow:hidden;border:1px solid #1E1E1E;flex-shrink:0;}
.pmvst-seg button{padding:6px 9px;border:none;background:#141414;color:rgb(156,163,175);font-size:12px;font-weight:500;font-family:inherit;cursor:pointer;}
.pmvst-seg button:hover{color:#fff;} .pmvst-seg button[data-on="1"]{background:rgba(var(--acc),0.2);color:rgb(var(--acc-fg));}
.pmvst-body{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px;scrollbar-width:thin;scrollbar-color:#3A3A3A transparent;}
.pmvst-card{display:block;border-radius:12px;overflow:hidden;background:linear-gradient(135deg,#1F1F1F,#171717);border:1px solid #2A2A2A;color:inherit;text-decoration:none;
  transition:border-color .2s,box-shadow .2s;flex-shrink:0;}
.pmvst-card:hover{border-color:rgba(249,115,22,0.5);box-shadow:0 10px 24px rgba(0,0,0,0.45);}
.pmvst-thumb{position:relative;aspect-ratio:16/9;background:#0F0F0F;overflow:hidden;}
.pmvst-thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .3s,opacity .2s;}
.pmvst-card:hover .pmvst-thumb img{transform:scale(1.04);}
.pmvst-card[data-seen="1"] .pmvst-thumb img{opacity:.45;}
.pmvst-badge{position:absolute;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,0.8);color:#fff;font-size:11px;font-weight:600;line-height:16px;font-variant-numeric:tabular-nums;}
.pmvst-dur{right:8px;bottom:8px;}
.pmvst-seen{left:8px;bottom:8px;color:rgb(209,213,219);}
.pmvst-pl{left:8px;top:8px;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(249,115,22,0.92);}
.pmvst-q{position:absolute;right:8px;top:8px;display:inline-flex;align-items:center;justify-content:center;gap:3px;height:28px;min-width:28px;padding:0 6px;
  border-radius:6px;border:none;cursor:pointer;background:rgba(0,0,0,0.8);color:#fff;opacity:0;transition:opacity .15s,background .15s;font-size:11px;font-weight:700;font-family:inherit;}
.pmvst-card:hover .pmvst-q,.pmvst-q[data-on="1"]{opacity:1;}
.pmvst-q:hover{background:rgb(249,115,22);} .pmvst-q[data-on="1"]{background:rgb(34,197,94);}
.pmvst-q svg{width:14px;height:14px;}
.pmvst-info{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;}
.pmvst-trow{display:flex;align-items:flex-start;gap:8px;}
.pmvst-title{flex:1;min-width:0;font-size:14px;font-weight:600;color:#fff;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;transition:color .15s;}
.pmvst-card:hover .pmvst-title{color:rgb(251,146,60);}
.pmvst-rate{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:6px;font-size:11px;font-weight:700;flex-shrink:0;font-variant-numeric:tabular-nums;
  background:rgba(34,197,94,0.15);color:rgb(74,222,128);border:1px solid rgba(34,197,94,0.3);}
.pmvst-rate.mid{background:rgba(234,179,8,0.15);color:rgb(250,204,21);border-color:rgba(234,179,8,0.3);}
.pmvst-rate.low{background:rgba(239,68,68,0.15);color:rgb(248,113,113);border-color:rgba(239,68,68,0.3);}
.pmvst-rate svg{width:11px;height:11px;}
.pmvst-up{display:flex;align-items:center;gap:6px;font-size:12px;color:rgb(156,163,175);min-width:0;}
.pmvst-up .a{width:20px;height:20px;border-radius:9999px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgb(59,130,246),rgb(147,51,234));color:#fff;font-size:10px;font-weight:700;}
.pmvst-up .a img{width:100%;height:100%;object-fit:cover;}
.pmvst-up span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmvst-foot{display:flex;align-items:center;gap:12px;font-size:12px;color:rgb(107,114,128);font-variant-numeric:tabular-nums;}
.pmvst-foot span{display:inline-flex;align-items:center;gap:4px;} .pmvst-foot svg{width:12px;height:12px;}
.pmvst-msg{padding:28px 8px;text-align:center;font-size:13px;color:rgb(107,114,128);}
.pmvst-spin{width:22px;height:22px;margin:8px auto;border-radius:9999px;border:2px solid #2A2A2A;border-top-color:rgb(249,115,22);animation:pmvst-spin .8s linear infinite;flex-shrink:0;}
@keyframes pmvst-spin{to{transform:rotate(360deg);}}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const ico = svg => { const s = mk('span'); s.innerHTML = svg; s.style.display = 'inline-flex'; return s; };
    const fmtCount = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n); };
    const fmtSecs = s => { s = Math.round(Number(s) || 0); if (!s) return ''; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(r).padStart(2, '0'); };
    const fmtDur = v => (typeof v.duration === 'string' && v.duration) ? v.duration : fmtSecs(v.durationSeconds ?? (typeof v.duration === 'number' ? v.duration : 0));
    const ago = iso => {
        const t = Date.parse(iso); if (!t) return '';
        const d = Math.max(0, (Date.now() - t) / 864e5);
        return d < 1 ? 'today' : d < 30 ? `${Math.floor(d)}d ago` : d < 365 ? `${Math.floor(d / 30)}mo ago` : `${Math.floor(d / 365)}y ago`;
    };
    const thumbOf = v => v.thumbnailSizes?.md?.url || v.thumbnailSizes?.lg?.url || v.thumbnailSizes?.sm?.url || v.thumbnailUrl || v.rawThumbnailUrl || '';
    const uploaderOf = v => v.uploaderUsername || (typeof v.uploader === 'string' ? v.uploader : v.uploader?.username) || v.user?.username || '';
    function playlistNames(id) {
        try {
            const set = PMVX.state?.reverse?.get(id);
            if (!set?.size) return [];
            return [...set].map(pid => PMVX.state.playlists?.get(pid)?.name).filter(Boolean);
        } catch { return []; }
    }

    // --- Data ---
    async function getJson(url) {
        const res = await window.fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
    }
    async function fromVideos(params, page) {
        const alt = (SORTS.find(s => s.v === sort) || SORTS[0]).alt;
        const j = await getJson(`/api/videos?${params}&sort=${enc(alt)}&limit=${PAGE}&page=${page}&_pmvx=menu`);
        const list = [j?.data, j?.videos, j?.data?.videos].find(a => Array.isArray(a) && a.length) || [];
        const pg = j?.pagination || j?.data?.pagination || {};
        return { list, total: pg.total ?? pg.totalVideos, more: list.length > 0 && pg.hasNext !== false && !(pg.totalPages && page >= pg.totalPages) };
    }
    // One page for the open menu: { list, total, more, star }. A star's source is fixed by page 1.
    async function fetchPage(c, page) {
        const it = c.item;
        if (c.kind === 'tag') return fromVideos(`tags=${enc(it.name)}`, page);
        if (c.kind === 'music') return fromVideos(`musicArtist=${enc(it.artist)}` + (c.musicMode === 'song' && it.song ? `&musicSong=${enc(it.song)}` : ''), page);
        if (c.src !== 'stars') {
            try {
                const j = await getJson(`/api/models/${enc(it.slug)}?page=${page}&limit=${PAGE}&sort=${enc(sort)}`);
                const list = Array.isArray(j?.videos) ? j.videos : null;
                if (j?.success !== false && list && (list.length || page > 1)) {
                    c.src = 'model';
                    const pg = j.pagination || {};
                    const pages = pg.pages ?? pg.totalPages;
                    return { list, total: pg.total, more: list.length > 0 && (pages ? page < pages : list.length >= PAGE), star: j.star || null };
                }
            } catch {}
            if (page > 1) return { list: [], total: null, more: false };
            c.src = 'stars';
        }
        return fromVideos(`stars=${enc(it.name)}`, page);
    }

    // --- Menu ---
    let pop = null, anchor = null, cur = null, el = {};

    let openWatch = null;
    function close() {
        clearInterval(openWatch); openWatch = null;
        if (!pop) return;
        pop.remove(); pop = null; anchor = null; el = {};
        if (cur) cur.seq++;
        cur = null;
    }

    function place() {
        if (!pop) return;
        const w = pop.offsetWidth;
        const r = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
        const HEADER = 64;
        let top, maxH;
        if (r && r.width) {
            const below = innerHeight - r.bottom - 14, above = r.top - 14 - HEADER;
            if (below >= 420 || below >= above) { top = r.bottom + 6; maxH = below; }
            else { maxH = Math.min(above, 700); top = r.top - 6 - Math.min(pop.scrollHeight, maxH); }
            pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 8 - w)) + 'px';
        } else {
            top = HEADER + 16; maxH = innerHeight - top - 16;
            pop.style.left = Math.max(8, (innerWidth - w) / 2) + 'px';
        }
        pop.style.maxHeight = Math.max(260, Math.min(maxH, 700)) + 'px';
        pop.style.top = Math.max(HEADER + 6, top) + 'px';
    }

    function filterState() { try { return PMVX.tagFilter?.state(cur.item.term, cur.kind) || null; } catch { return null; } }
    function setFilter(next) {
        if (!PMVX.tagFilter || !cur) return;
        const label = cur.kind === 'tag' ? '#' + cur.item.name : cur.item.name;
        const res = PMVX.tagFilter.set(cur.item.term, next, cur.kind);
        const where = cur.kind === 'star' ? 'model filter' : 'filter';
        PMVX.toast?.(res === 'include' ? `+ ${label} required in ${where}` : res === 'exclude' ? `− ${label} excluded in ${where}` : `${label} removed from ${where}`,
            res === 'exclude' ? 'red' : res === 'include' ? 'green' : null);
        renderFilter();
    }
    function renderFilter() {
        if (!el.inc) return;
        const st = filterState();
        el.inc.dataset.on = st === 'include' ? '1' : '';
        el.exc.dataset.on = st === 'exclude' ? '1' : '';
        const what = KINDS[cur.kind].what;
        el.inc.title = st === 'include' ? 'Required in the filter — click to remove' : `Show only videos with this ${what} (site-wide filter)`;
        el.exc.title = st === 'exclude' ? 'Excluded in the filter — click to remove' : `Hide videos with this ${what} (site-wide filter)`;
    }

    function open(a, kind, item) {
        close();
        injectStyle();
        anchor = a;
        const K = KINDS[kind];
        cur = { kind, item, href: item.href || a.getAttribute('href'), musicMode: item.song ? 'song' : 'artist', src: null, page: 0, total: null, star: null,
                seen: new Set(), shown: 0, seq: 0, loading: false, more: true, error: false };
        pop = mk('div'); pop.id = 'pmvst'; pop.dataset.kind = kind;
        // While open: close when its chip is gone, keep the filter state current.
        openWatch = setInterval(() => { if (anchor && !anchor.isConnected) close(); else if (pop) renderFilter(); }, 500);
        pop.setAttribute('data-pmvx-tag-menu', '1');

        const head = mk('div', 'pmvst-head');
        el.av = mk('div', 'pmvst-av'); el.av.appendChild(ico(K.icon));
        const who = mk('div', 'pmvst-who');
        el.name = mk('div', 'pmvst-name'); el.name.appendChild(mk('span', null, kind === 'music' ? (item.song || item.artist) : item.title));
        el.sub = mk('div', 'pmvst-sub', 'Loading…');
        who.append(el.name, el.sub);
        const x = mk('button', 'pmvst-close'); x.type = 'button'; x.title = 'Close (Esc)'; x.appendChild(ico(SVG_X));
        x.onclick = close;
        head.append(el.av, who, x);

        const acts = mk('div', 'pmvst-acts');
        // Click again to remove; music filters on the artist.
        if (PMVX.tagFilter) {
            const row = mk('div', 'pmvst-row');
            row.appendChild(mk('span', 'pmvst-lab', 'Filter'));
            const sfx = kind === 'music' ? ' artist' : '';
            el.inc = mk('button', 'pmvst-fbtn inc'); el.inc.type = 'button'; el.inc.append(ico(SVG_PLUS), mk('span', 't', 'Require' + sfx));
            el.exc = mk('button', 'pmvst-fbtn exc'); el.exc.type = 'button'; el.exc.append(ico(SVG_BAN), mk('span', 't', 'Exclude' + sfx));
            el.inc.onclick = () => setFilter(filterState() === 'include' ? null : 'include');
            el.exc.onclick = () => setFilter(filterState() === 'exclude' ? null : 'exclude');
            row.append(el.inc, el.exc);
            acts.appendChild(row);
        }
        const row2 = mk('div', 'pmvst-row');
        row2.appendChild(mk('span', 'pmvst-lab', 'Open'));
        const go = mk('a', 'pmvst-go'); go.href = cur.href || '#';
        go.append(mk('span', null, K.go), ico(SVG_ARROW));
        go.title = kind === 'star' ? `${item.name}'s profile page` : 'The site\'s search results, as a normal click on the chip';
        go.onclick = e => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
            e.preventDefault();
            const h = go.getAttribute('href'); close();
            if (!PMVX.navigate?.(h)) location.href = h;
        };
        row2.appendChild(go);
        acts.appendChild(row2);
        const row3 = mk('div', 'pmvst-row');
        row3.appendChild(mk('span', 'pmvst-lab', 'Videos'));
        const sel = mk('select', 'pmvst-sort'); sel.title = 'Sort';
        SORTS.forEach(s => { const o = mk('option', null, s.t); o.value = s.v; sel.appendChild(o); });
        sel.value = sort;
        sel.onchange = () => { sort = sel.value; try { localStorage.setItem(SORT_KEY, sort); } catch {} reload(); };
        row3.appendChild(sel);
        if (kind === 'music' && item.song) {
            const seg = mk('div', 'pmvst-seg');
            const mb = (mode, label) => {
                const b = mk('button', null, label); b.type = 'button';
                b.dataset.on = cur.musicMode === mode ? '1' : '';
                b.onclick = () => { if (cur.musicMode === mode) return; cur.musicMode = mode; seg.querySelectorAll('button').forEach(x2 => x2.dataset.on = x2 === b ? '1' : ''); reload(); };
                return b;
            };
            seg.append(mb('song', 'Song'), mb('artist', 'Artist'));
            row3.appendChild(seg);
        }
        acts.appendChild(row3);

        el.body = mk('div', 'pmvst-body');
        el.body.addEventListener('scroll', () => {
            const b = el.body;
            if (b && b.scrollTop + b.clientHeight > b.scrollHeight - 400) load();
        }, { passive: true });
        pop.append(head, acts, el.body);
        document.body.appendChild(pop);
        renderFilter();
        place();
        load();
    }

    function reload() {
        if (!cur) return;
        cur = { ...cur, src: null, page: 0, total: null, seen: new Set(), shown: 0, seq: cur.seq + 1, loading: false, more: true, error: false };
        el.body.replaceChildren();
        el.body.scrollTop = 0;
        load();
    }

    function renderHead() {
        if (!cur || !el.sub) return;
        const s = cur.star;
        if (s?.name) el.name.firstChild.textContent = s.name;
        if (s?.isVerified && !el.name.querySelector('svg')) { const v = ico(SVG_CHECKBADGE); v.title = 'Verified'; el.name.appendChild(v); }
        if (s?.avatarUrl && !el.av.querySelector('img')) { const img = mk('img'); img.alt = ''; img.src = s.avatarUrl; el.av.replaceChildren(img); }
        const parts = [];
        if (cur.kind === 'music' && cur.item.song) parts.push(cur.item.artist);
        if (cur.total != null) parts.push(`${fmtCount(cur.total)} video${cur.total === 1 ? '' : 's'}`);
        const aliases = (Array.isArray(s?.aliases) ? s.aliases : []).filter(Boolean);
        if (aliases.length) parts.push('aka ' + aliases.join(', '));
        el.sub.textContent = parts.join(' · ') || (cur.loading ? 'Loading…' : '');
        el.sub.title = el.sub.textContent;
    }

    function renderStatus() {
        if (!el.body) return;
        el.body.querySelectorAll('.pmvst-msg, .pmvst-spin').forEach(n => n.remove());
        if (cur.loading) el.body.appendChild(mk('div', 'pmvst-spin'));
        else if (cur.error && !cur.shown) el.body.appendChild(mk('div', 'pmvst-msg', 'Could not load videos.'));
        else if (!cur.more && !cur.shown) el.body.appendChild(mk('div', 'pmvst-msg', 'No other videos yet.'));
    }

    function card(v) {
        const id = v._id;
        const href = `/video/${id}`;
        const a = mk('a', 'pmvst-card'); a.href = href;
        const seen = typeof PMVX.isWatched === 'function' && PMVX.isWatched(id);
        if (seen) a.dataset.seen = '1';
        const th = mk('div', 'pmvst-thumb');
        const img = mk('img'); img.loading = 'lazy'; img.alt = ''; img.src = thumbOf(v);
        th.appendChild(img);
        const dur = fmtDur(v); if (dur) th.appendChild(mk('span', 'pmvst-badge pmvst-dur', dur));
        if (seen) th.appendChild(mk('span', 'pmvst-badge pmvst-seen', 'Watched'));
        const pls = playlistNames(id);
        if (pls.length) { const b = mk('span', 'pmvst-badge pmvst-pl', pls.length === 1 ? pls[0] : `${pls.length} playlists`); b.title = 'In: ' + pls.join(', '); th.appendChild(b); }
        if (PMVX.upNext) {
            const q = mk('button', 'pmvst-q'); q.type = 'button';
            const sync = () => {
                const pos = PMVX.upNext.position(id);
                q.dataset.on = pos ? '1' : '';
                q.replaceChildren(ico(pos ? SVG_CHECK : SVG_QUEUE));
                if (pos) q.appendChild(mk('span', null, String(pos)));
                q.title = pos ? `In Up next (#${pos}) — click to remove` : 'Add to Up next';
            };
            q.onclick = e => {
                e.preventDefault(); e.stopPropagation();
                if (PMVX.upNext.position(id)) PMVX.upNext.remove(id);
                else PMVX.upNext.add(id, href, { title: v.title || '', thumbnailUrl: thumbOf(v), duration: fmtDur(v), uploaderDisplay: uploaderOf(v), bayesianRating: v.bayesianRating || 0 });
                sync();
            };
            sync();
            th.appendChild(q);
        }

        const info = mk('div', 'pmvst-info');
        const trow = mk('div', 'pmvst-trow');
        trow.appendChild(mk('div', 'pmvst-title', v.title || ''));
        if (v.bayesianRating > 0) {
            const r = Math.round(v.bayesianRating);
            const rb = mk('span', 'pmvst-rate' + (r >= 70 ? '' : r >= 50 ? ' mid' : ' low'));
            rb.append(ico(SVG_THUMB), mk('span', null, r + '%'));
            trow.appendChild(rb);
        }
        info.appendChild(trow);
        const upName = uploaderOf(v);
        if (upName) {
            const up = mk('div', 'pmvst-up');
            const av = mk('span', 'a');
            if (v.uploaderAvatarUrl) { const i = mk('img'); i.alt = ''; i.loading = 'lazy'; i.src = v.uploaderAvatarUrl; av.appendChild(i); }
            else av.textContent = upName.charAt(0).toUpperCase();
            up.append(av, mk('span', null, upName));
            info.appendChild(up);
        }
        const foot = mk('div', 'pmvst-foot');
        if (v.views) { const s = mk('span'); s.append(ico(SVG_EYE), document.createTextNode(fmtCount(v.views))); foot.appendChild(s); }
        const when = ago(v.releaseDate || v.uploadDate);
        if (when) { const s = mk('span'); s.append(ico(SVG_CAL), document.createTextNode(when)); foot.appendChild(s); }
        if (foot.childNodes.length) info.appendChild(foot);
        a.append(th, info);
        a.title = v.title || '';
        a.onclick = e => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            close();
            if (!PMVX.navigate?.(href)) location.href = href;
        };
        return a;
    }

    async function load() {
        if (!cur || cur.loading || !cur.more) return;
        const c = cur, seq = c.seq;
        c.loading = true; c.error = false;
        renderStatus(); renderHead();
        try {
            const r = await fetchPage(c, c.page + 1);
            if (cur !== c || c.seq !== seq) return;
            c.page++;
            if (r.star) c.star = r.star;
            if (r.total != null) c.total = r.total;
            c.more = r.more;
            const here = currentVideoId();
            r.list.forEach(v => {
                if (!v?._id || v._id === here || c.seen.has(v._id)) return;
                c.seen.add(v._id);
                el.body.appendChild(card(v));
                c.shown++;
            });
        } catch {
            if (cur !== c || c.seq !== seq) return;
            c.error = true; c.more = false;
        }
        c.loading = false;
        renderHead(); renderStatus();
        place();
        // Keep going until the list fills the menu (the current video may have been the only one).
        if (c.more && el.body && el.body.scrollHeight <= el.body.clientHeight + 100) load();
    }

    // --- Wiring ---
    let lastToggle = { el: null, at: 0 };
    window.addEventListener('click', e => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        if (e.target?.closest?.('#pmvst')) return;
        const c = chipAt(e.target);
        if (!c) return;
        // Also keeps the card's link from navigating.
        e.preventDefault();
        e.stopImmediatePropagation();
        // After client-side navigation the site re-dispatches a click on the same chip within the same tick:
        // count one toggle per chip per 300 ms, or the second click closes the menu right away.
        const now = performance.now();
        if (c.el === lastToggle.el && now - lastToggle.at < 300) { e.preventDefault(); e.stopImmediatePropagation(); return; }
        lastToggle = { el: c.el, at: now };
        if (pop && anchor === c.el) { close(); return; }
        open(c.el, c.kind, c.item);
    }, true);
    document.addEventListener('pointerdown', e => {
        if (!pop || pop.contains(e.target) || chipAt(e.target)) return;
        // Toasts and the queue panel stay usable without closing the menu.
        if (e.target?.closest?.('#pmv-toast, #pmv-queue-floating')) return;
        close();
    }, true);
    window.addEventListener('keydown', e => { if (pop && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } }, true);
    window.addEventListener('resize', () => place());
    window.addEventListener('scroll', e => { if (pop && !pop.contains(e.target)) place(); }, { passive: true, capture: true });
    // Filter changes elsewhere (panel, other tab) show in the open menu.
    window.addEventListener('storage', () => renderFilter());
    PMVX.onRoute((path, prev) => { if (path !== prev) close(); });
})();

});
})();
