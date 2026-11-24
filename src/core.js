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
