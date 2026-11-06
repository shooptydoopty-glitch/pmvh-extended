
(function () {
    'use strict';

    const CACHE_KEY   = 'pmv_firefox_playlist_cache_v1';
    const SETTINGS_KEY = 'pmvbpf_settings_v1';
    const PANEL_PAGES = ['/', '/browse', '/popular', '/trending', '/search',
                         '/discover', '/all-videos', '/watch', '/watch-new'];
    // Prefix-matched pages (dynamic id segment), e.g. a creator's upload grid.
    const PANEL_PREFIX_PAGES = ['/profile/'];
    const HIDE_ATTR   = 'data-pmvbpf-hidden';

    function isFilterPage() {
        const p = location.pathname.replace(/\/$/, '') || '/';
        return PANEL_PAGES.some(pp => p === pp || p.startsWith(pp + '?'))
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

    // ---------------------------------------------------------------------
    // Playlist cache
    // ---------------------------------------------------------------------

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

    // Same-window cache-ready event from the core (faster than the storage event).
    window.addEventListener('pmv:cache-ready', () => {
        loadCache();
        if (playlistFilterMode !== 'any') applyFilter();
    });

    window.addEventListener('storage', e => {
        if (e.key === CACHE_KEY) { loadCache(); if (playlistFilterMode !== 'any') applyFilter(); }
    });

    // Playlists that count toward in/not-in. Empty = any playlist.
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
        if (!selectedPlaylistIds.length) return true; // empty selection = any playlist
        return selectedPlaylistIds.some(id => memberOf.has(id));
    }

    // ---------------------------------------------------------------------
    // Fetch interceptor
    // ---------------------------------------------------------------------
    // Records the last /api/videos URL and indexes thumbnail -> video id.

    const thumbToId = new Map();
    let lastApiUrl  = null;
    let lastApiPage = 1;

    // Shared with the other modules (first to load defines it): one JSON parse per response.
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
            if (/\/api\/videos(\?|$)/.test(rawUrl)) {
                lastApiUrl = rawUrl;
                const u = new URL(rawUrl, location.origin);
                const p = parseInt(u.searchParams.get('page') || '1');
                if (p >= lastApiPage) lastApiPage = p;
                pmvResJson(res).then(json => {
                    indexVideos(json?.data?.videos || json?.videos || json?.data || []);
                }).catch(() => {});
            }
            // Playlist-detail responses also carry thumbnailUrl -> _id mappings.
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

    // ---------------------------------------------------------------------
    // Reading cards
    // ---------------------------------------------------------------------

    function getVideoId(card) {
        if (card.dataset.videoId) return card.dataset.videoId;
        const img = card.querySelector('img[src]');
        const huds = PMVX.state;
        if (img?.src) {
            const clean = img.src.split('?')[0];
            // Resolution order: own interceptor cache, core thumbnailIndex, core titleIndex, raw URL hex.
            if (thumbToId.has(clean)) return thumbToId.get(clean);
            if (huds?.thumbnailIndex?.has(clean)) return huds.thumbnailIndex.get(clean);
            const alt = img.alt?.trim().toLowerCase();
            if (alt && huds?.titleIndex?.has(alt)) return huds.titleIndex.get(alt);
            // Raw URL hex is an asset id, not a video _id; last resort only.
            const m = clean.match(/\/thumbnails\/([a-f0-9]{24})\//) ||
                      clean.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//) ||
                      clean.match(/\/([a-f0-9]{24})\/thumbnail\//);
            if (m) {
                const hexId = m[1];
                const s = huds?.reverse || reverseMap;
                if (s?.has(hexId)) return hexId;
                return hexId;
            }
        }
        const a = card.querySelector('a[href*="/videos/"]');
        if (a) { const m = a.href.match(/\/videos\/([a-f0-9]{24})/); if (m) return m[1]; }
        return null;
    }

    function getAllCards() {
        const seen = new Set(), all = [];
        document.querySelectorAll('[data-video-id]').forEach(c => {
            if (!seen.has(c)) { seen.add(c); all.push(c); }
        });
        if (all.length === 0) {
            document.querySelectorAll('a[href*="/videos/"]').forEach(a => {
                const card = a.closest('[class*="card"]') ||
                             a.closest('[class*="video-item"]') ||
                             a.parentElement?.parentElement || a.parentElement;
                if (card && !seen.has(card)) { seen.add(card); all.push(card); }
            });
        }
        return all;
    }

    // ---------------------------------------------------------------------
    // Filter state
    // ---------------------------------------------------------------------

    let playlistFilterMode = 'any';
    // Staged values, shown by the chips. Committed by the site's Apply button where the page has one
    // (homepage filter menu), otherwise straight away.
    let pendingMode = 'any';

    // ---------------------------------------------------------------------
    // Mode
    // ---------------------------------------------------------------------
    // Filters only cards already loaded; the observer below re-filters new batches.

    PMVX.filterChecks.push(() => playlistFilterMode !== 'any' && isFilterPage() && !PMVX.playlistFilterExempt());

    function setMode(mode) {
        playlistFilterMode = mode;
        pendingMode = mode;
        PMVX.clearActed();
        updateBtnStyles();
        applyFilter();
    }

    // Commits the staged mode and playlist selection.
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
    // Stage on pages with the site's Apply button, apply immediately elsewhere.
    function stagedChange() {
        if (nativeApplyBtn()) updateBtnStyles();
        else commitPending();
    }

    // ---------------------------------------------------------------------
    // Apply filter
    // ---------------------------------------------------------------------

    function applyFilter() {
        if (!isFilterPage()) return 0;

        try {
            const s = PMVX.state;
            if (s?.playlists?.size) { playlistsMap = s.playlists; reverseMap = s.reverse; }
        } catch {}

        const cards = getAllCards();
        let visible = 0, hidden = 0;

        // Off on the favourites views: everything there would count as "in a playlist" or not.
        const off = playlistFilterMode === 'any' || PMVX.playlistFilterExempt();
        cards.forEach(card => {
            if (off) {
                card.removeAttribute(HIDE_ATTR);
                return;
            }
            const id = getVideoId(card);
            if (!id) { card.removeAttribute(HIDE_ATTR); return; }
            const inAny = isInPlaylist(id);
            // Cards just acted on stay until the filter is applied again.
            const show  = (playlistFilterMode === 'in' ? inAny : !inAny) || PMVX.isActed(id);
            if (show) { card.removeAttribute(HIDE_ATTR); visible++; }
            else      { card.setAttribute(HIDE_ATTR, '1'); hidden++; }
        });

        updateCounter(visible, hidden);
        return visible;
    }

    // ---------------------------------------------------------------------
    // Counter
    // ---------------------------------------------------------------------

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

    // ---------------------------------------------------------------------
    // Observer
    // ---------------------------------------------------------------------
    // Re-filters when Vue renders new cards.

    new MutationObserver(muts => {
        if (playlistFilterMode === 'any') return;
        let hasNew = false;
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1 && (n.dataset?.videoId ||
                    n.querySelector?.('[data-video-id]') ||
                    n.querySelector?.('a[href*="/videos/"]'))) {
                    hasNew = true; break;
                }
            }
            if (hasNew) break;
        }
        if (hasNew) requestAnimationFrame(applyFilter);
    }).observe(document.body, { childList: true, subtree: true });

    // ---------------------------------------------------------------------
    // UI injection
    // ---------------------------------------------------------------------
    // Chips in the site's filter row (the "Content:" chips), same shape and colours. One chip cycles
    // Any → Not in playlist → In playlist → Any; a second one opens an inline list of the playlists
    // that count. On the homepage the choice is staged until the site's Apply button and is stored
    // with a saved filter (see the saved-search hooks below).

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
        // Already there (e.g. an SPA navigation reset the flag but the row survived): keep one set.
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
        NF_renderChips = renderChips;
        renderChips();
        window.addEventListener('pmv:cache-ready', renderChips);
        // Full width directly under the native row, inside the site's filter menu.
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

    // Colours per state via data-state: inline styles are lost when Vue re-renders, data-* is not.
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

    // ---------------------------------------------------------------------
    // Saved filters
    // ---------------------------------------------------------------------
    // Saving a filter in the site's menu stores this choice with it, as filters.pmvxPlaylists
    // ({ mode, ids }), and locally under the filter's name in case the server drops the extra key.
    // Loading that saved filter restores it; a saved filter without one turns this filter off.

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

    // Called from the fetch wrapper for POST /api/saved-searches. Returns the response.
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

    // A click on an entry in the site's saved-filter list (name + summary + delete button).
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

    // Re-inject the buttons if Vue replaces the filter row.
    new MutationObserver(() => {
        if (!isFilterPage() || document.getElementById('pmvbpf-btn-in')) return;
        injected = false;
        injectButtons();
    }).observe(document.body, { childList: true, subtree: true });

    // SPA navigation: reset state and re-inject.
    let lastUrl = location.href;
    function onNav() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        injected = false;
        playlistFilterMode = 'any';
        pendingMode = 'any';
        pendingIds = selectedPlaylistIds.slice();
        lastApiPage  = 1;
        setTimeout(injectButtons, 800);
    }
    const _push = history.pushState.bind(history);
    history.pushState = function (...a) { _push(...a); setTimeout(onNav, 0); };
    window.addEventListener('popstate', onNav);

    // Retry injection until the row and playlist cache are available.
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

