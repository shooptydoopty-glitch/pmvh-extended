(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // Tag menu
    // ---------------------------------------------------------------------
    // On a video page a click on a tag, a star (model) or a music chip under the player opens a menu
    // instead of leaving the page: require or exclude it in the site-wide filter, go on to where the
    // chip normally leads (search results, or the star's profile), and that tag's / star's / song's
    // videos in one column of cards in the site's own style, with sort and more on scroll.
    // Ctrl/Cmd/Shift/middle click keep the site's own link.
    // Videos: stars from /api/models/<slug> (the profile page's call, which knows aliases), falling
    // back to /api/videos?stars= (exact tag); tags and music from /api/videos. The "_pmvx" marker keeps
    // these calls out of the browse module's pagination.

    const SORT_KEY = 'pmvx_star_sort_v2';
    const PAGE = 16;
    // The profile page's sort options; `alt` is the same order on /api/videos.
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

    // Chip kinds under the player. read(a) -> { name, term, title, ... } or null.
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

    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------
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

    // ---------------------------------------------------------------------
    // Menu
    // ---------------------------------------------------------------------
    let pop = null, anchor = null, cur = null, el = {};

    function close() {
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

    function filterState() { try { return PMVX.tagFilter?.state(cur.item.term) || null; } catch { return null; } }
    function setFilter(next) {
        if (!PMVX.tagFilter || !cur) return;
        const label = cur.kind === 'tag' ? '#' + cur.item.name : cur.item.name;
        const res = PMVX.tagFilter.set(cur.item.term, next);
        PMVX.toast?.(res === 'include' ? `+ ${label} required in filter` : res === 'exclude' ? `− ${label} excluded in filter` : `${label} removed from filter`,
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
        cur = { kind, item, href: a.getAttribute('href'), musicMode: item.song ? 'song' : 'artist', src: null, page: 0, total: null, star: null,
                seen: new Set(), shown: 0, seq: 0, loading: false, more: true, error: false };
        pop = mk('div'); pop.id = 'pmvst'; pop.dataset.kind = kind;
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
        // Filter: require / exclude (click again to remove); music filters on the artist.
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
        // Where the chip normally leads.
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
        // Sort, and for music: this song or everything by the artist.
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

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------
    window.addEventListener('click', e => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || !isVideoPage()) return;
        const a = e.target?.closest?.(ANY_SEL);
        if (!a || a.closest('#pmvst')) return;
        const kind = kindOf(a);
        const item = kind && KINDS[kind].read(a);
        if (!item) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (pop && anchor === a) { close(); return; }
        open(a, kind, item);
    }, true);
    document.addEventListener('pointerdown', e => {
        if (!pop || pop.contains(e.target) || e.target?.closest?.(ANY_SEL)) return;
        // Toasts and the queue panel stay usable without closing the menu.
        if (e.target?.closest?.('#pmv-toast, #pmv-queue-floating')) return;
        close();
    }, true);
    window.addEventListener('keydown', e => { if (pop && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } }, true);
    window.addEventListener('resize', () => place());
    window.addEventListener('scroll', e => { if (pop && !pop.contains(e.target)) place(); }, { passive: true, capture: true });
    // Another filter change (filter panel, another tab) shows in the open menu.
    window.addEventListener('storage', () => renderFilter());
    // Close on navigation, or when its chip is gone.
    let lastPath = location.pathname;
    setInterval(() => {
        if (location.pathname !== lastPath) { lastPath = location.pathname; close(); }
        else if (pop && anchor && !anchor.isConnected) close();
        else if (pop) renderFilter();
    }, 500);
})();
