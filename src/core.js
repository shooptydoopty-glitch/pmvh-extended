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
