(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // Header search
    // ---------------------------------------------------------------------
    // The site's search popout ("Search everything...") gets a panel right below it: where to search
    // (everything, title, tags, stars, creator, music), suggestions from the site's own autocomplete,
    // include/exclude chips, filters and recent searches. A search goes to /search with the parameters
    // that page reads itself (q, tags, stars, creator, musicArtist); the rest (sort, length, rating,
    // quality, ratio, upload date, exclusions, title-only) stays in the page URL and is added to the
    // page's API calls by the fetch wrapper below. /api/videos/search (used when there is text) ignores
    // rating, quality, ratio and date, so those are applied to its results here.
    // Plain text in "Everything" with no chips or filters is left to the site.

    const SCOPE_KEY  = 'pmvx_search_scope_v1';
    const FILTER_KEY = 'pmvx_search_filters_v1';
    const FOPEN_KEY  = 'pmvx_search_filters_open_v1';
    const RECENT_KEY = 'pmvx_search_recent_v1';
    const RECENT_MAX = 8;
    const DUR_MAX = 30; // minutes; the slider's top end means "no maximum"

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
    let hi = -1;          // highlighted suggestion
    let lastSearchFetch = 0;

    const isDefaultFilters = f => Object.keys(F_DEFAULT).every(k => f[k] === F_DEFAULT[k]);

    // ---------------------------------------------------------------------
    // Query <-> URL, and the /search page's API calls
    // ---------------------------------------------------------------------
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

    // Page-URL parameters the /search page does not read itself; copied into its API calls when missing
    // there (so the page's own filters, once set, win).
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

    // ---------------------------------------------------------------------
    // The site's popout
    // ---------------------------------------------------------------------
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

    // ---------------------------------------------------------------------
    // Panel
    // ---------------------------------------------------------------------
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
        // The site closes (and clears) its search on any click outside its own box: keep ours inside it.
        panel.addEventListener('click', e => { e.stopPropagation(); if (dd && !dd.contains(e.target) && !e.target.closest('.pmvsx-selbtn')) closeDd(); });
        // Keep the caret in the site's input while clicking chips and rows.
        panel.addEventListener('mousedown', e => { if (!e.target.closest('input')) e.preventDefault(); });

        const body = mk('div', 'pmvsx-body');
        // Where to search
        const secScope = mk('div');
        const scopeLab = mk('div', 'pmvsx-lab', 'Search in');
        el.scopeHint = mk('span', 'r');
        scopeLab.appendChild(el.scopeHint);
        el.scopes = mk('div', 'pmvsx-row');
        secScope.append(scopeLab, el.scopes);
        // Chips
        el.terms = mk('div', 'pmvsx-row');
        // Suggestions / recent
        el.list = mk('div');
        // Filters
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

    // Filter body: sort dropdown, length slider, chip rows.
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
        // Sort
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
            panel.appendChild(dd); // inside the panel, so the site does not see an outside click
            const r = el.sortBtn.getBoundingClientRect();
            dd.style.left = Math.max(8, Math.min(r.left, innerWidth - 228)) + 'px';
            const h = dd.getBoundingClientRect().height;
            dd.style.top = (r.bottom + 4 + h > innerHeight - 8 && r.top - 4 - h > 8 ? r.top - 4 - h : r.bottom + 4) + 'px';
            el.sortBtn.dataset.open = '1';
        };
        sel.appendChild(el.sortBtn);
        section(fb, 'Sort by', sel);
        fRenders.push(() => { st.textContent = (SORTS.find(o => o.v === F.sort) || SORTS[0]).t; });

        // Length: dual slider with presets
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

    // Suggestions from the site's autocomplete (cached, debounced, last request wins).
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

    // What a search would be right now: chips plus the input (as a chip when it is a tag/star/... ).
    function snapshot() {
        const p = parseInput(nativeInput()?.value || '');
        const list = terms.map(t => ({ ...t }));
        let text = '';
        if (p.text) { if (p.kind) addTerm(list, p.kind, p.text, p.neg); else text = p.text; }
        return { text, scope: p.kind ? 'all' : scope, terms: list, f: { ...F } };
    }
    // Plain text in Everything without chips or filters: the site's own search.
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

    // ---------------------------------------------------------------------
    // Open / close / placement
    // ---------------------------------------------------------------------
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

    // Keys in the site's input (capture: before the site's own Enter/Escape handlers).
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
    // The site's magnifier button.
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

    // The header can be re-rendered by Vue: re-find the box (cheap) and pick up a missed open/close.
    findContainer();
    syncOpen();
    setInterval(() => { findContainer(); syncOpen(); }, 1000);
    document.addEventListener('click', e => { if (e.target?.closest?.('.search-trigger')) setTimeout(() => { findContainer(); syncOpen(); }, 0); }, true);
})();
