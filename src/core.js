// ---------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------
// Shared namespace for the modules below (cache state, watch history,
// cross-module hooks). Kept off `window` on purpose.
const PMVX = {};

// The script runs at document-start so the fetch interceptors see the
// site's first API calls; modules that touch the DOM wait for <body>.
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

// ---------------------------------------------------------------------
// Performance mode (Settings): how often pages are rescanned, visual
// effects, and how many background requests run at once.
// ---------------------------------------------------------------------
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

// Without effects: no backdrop blur, transitions or animations in the
// script's UI, and none of the site's own blur and pulsing badges either.
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

// Videos the user just acted on (saved, removed, rejected). Filters keep showing them until the
// filter is applied again or the page changes, so an action never makes a card vanish under the
// cursor. Each filter module calls clearActed() when the user re-applies it.
let actedPath = location.pathname;
PMVX.acted = new Set();
function actedFresh() {
    if (location.pathname !== actedPath) { actedPath = location.pathname; PMVX.acted.clear(); }
}
PMVX.markActed = id => { if (!id) return; actedFresh(); PMVX.acted.add(id); };
PMVX.isActed = id => { actedFresh(); return !!id && PMVX.acted.has(id); };
PMVX.clearActed = () => PMVX.acted.clear();

// Filter terms: "=term" matches only as a whole word ("=ch" hits "ch" and "big ch", not
// "challenge"); any other term matches anywhere in the text. Texts and terms are lower case.
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
// Smart quotes from macOS / iOS keyboards count as plain quotes.
PMVX.plainQuotes = s => String(s ?? '').replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019\u201A\u201B]/g, "'");
PMVX.termLabel = term => (term && term.length > 1 && term[0] === '=') ? term.slice(1) : term;
PMVX.isWordTerm = term => !!term && term.length > 1 && term[0] === '=';

// Card filters register a check here; true while any of them can hide cards on this page.
// Where an in/not-in-playlist filter would hide (nearly) everything: a playlist's own page and
// the favourites views (profile Favorites tab, the homepage Favorites pill or content chip).
// Checked per card, so the DOM lookup is cached for 250 ms.
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
// The playlist whose page this is (its own videos are always "in" it), or null.
PMVX.currentPlaylistPageId = () => location.pathname.match(/^\/playlists\/([a-f0-9]{24})/i)?.[1] || null;

PMVX.apiTaps = [];
PMVX.filterChecks = [];
PMVX.anyCardFilterActive = () => PMVX.filterChecks.some(fn => { try { return !!fn(); } catch { return false; } });

// Coalesces calls into one run per frame, spaced at least `scanMs` apart.
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
