
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
        const res = await _origFetch.apply(this, args);
        try {
            const rawUrl = typeof args[0] === 'string' ? args[0]
                         : args[0] instanceof Request  ? args[0].url
                         : String(args[0]);
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

    // ---------------------------------------------------------------------
    // Mode
    // ---------------------------------------------------------------------
    // Filters only cards already loaded; the observer below re-filters new batches.

    function setMode(mode) {
        playlistFilterMode = mode;
        updateBtnStyles();
        applyFilter();
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

        cards.forEach(card => {
            if (playlistFilterMode === 'any') {
                card.removeAttribute(HIDE_ATTR);
                return;
            }
            const id = getVideoId(card);
            if (!id) { card.removeAttribute(HIDE_ATTR); return; }
            const inAny = isInPlaylist(id);
            const show  = playlistFilterMode === 'in' ? inAny : !inAny;
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

    function injectButtons() {
        if (injected || !isFilterPage()) return;
        const row = findContentRow();
        if (!row) return;
        if (!cacheLoaded && !loadCache()) { scheduleRetry(); return; }

        injected = true;

        row.appendChild(Object.assign(document.createElement('div'), {
            id: 'pmvbpf-sep', className: 'w-px h-5 bg-[#2A2A2A] mx-1'
        }));

        const btnIn  = makeBtn('✓ In playlist',     '#22c55e', () => setMode(playlistFilterMode === 'in'  ? 'any' : 'in'));
        const btnOut = makeBtn('✕ Not in playlist', '#f97316', () => setMode(playlistFilterMode === 'out' ? 'any' : 'out'));
        btnIn.id  = 'pmvbpf-btn-in';
        btnOut.id = 'pmvbpf-btn-out';

        // Playlist picker: a pill toggles an inline chip panel under the row (no floating dropdown).
        injectPanelStyle();
        const pickBtn = makeBtn('Playlists ▾', '#f97316', () => {
            const pnl = document.getElementById('pmvbpf-panel');
            if (!pnl) return;
            pnl.hidden = !pnl.hidden;
            renderPickLabel();
        });
        pickBtn.id = 'pmvbpf-btn-pick';
        pickBtn.title = 'Choose which playlists count (none = any playlist)';
        const renderPickLabel = () => {
            const pnl = document.getElementById('pmvbpf-panel');
            const n = selectedPlaylistIds.length;
            pickBtn.textContent = (n ? `Playlists (${n}) ` : 'Playlists ') + (pnl && !pnl.hidden ? '▴' : '▾');
            styleBtn(pickBtn, n > 0, '#f97316');
        };
        const pickWrap = document.createElement('div');
        pickWrap.style.cssText = 'display:inline-flex;';
        pickWrap.appendChild(pickBtn);

        const panel = document.createElement('div');
        panel.id = 'pmvbpf-panel';
        panel.hidden = true;
        const lab = document.createElement('div');
        lab.className = 'pmvbpf-lab';
        lab.textContent = 'Playlists that count for In / Not in playlist — none selected = any playlist';
        const chips = document.createElement('div');
        chips.className = 'pmvbpf-chips';
        panel.append(lab, chips);
        let chipSig = null;
        const renderChips = () => {
            const live = PMVX.state?.playlists?.size ? PMVX.state.playlists : playlistsMap;
            const list = [...live.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            const sig = list.map(p => p.id + ':' + p.ids.size).join('|') + '#' + selectedPlaylistIds.join(',');
            if (sig === chipSig) return;
            chipSig = sig;
            chips.textContent = '';
            if (!list.length) {
                const e = document.createElement('div');
                e.className = 'pmvbpf-empty';
                e.textContent = 'No playlists yet — log in to load yours.';
                chips.appendChild(e);
                return;
            }
            const all = document.createElement('button');
            all.type = 'button';
            all.className = 'pmvbpf-chip' + (selectedPlaylistIds.length ? '' : ' active');
            all.textContent = 'Any playlist';
            all.onclick = () => { selectedPlaylistIds = []; savePickerSettings(); renderChips(); renderPickLabel(); if (playlistFilterMode !== 'any') applyFilter(); };
            chips.appendChild(all);
            list.forEach(p => {
                const c = document.createElement('button');
                c.type = 'button';
                const sel = selectedPlaylistIds.includes(p.id);
                c.className = 'pmvbpf-chip' + (sel ? ' active' : '');
                c.title = `${p.ids.size} videos`;
                c.textContent = p.name || p.id;
                const n = document.createElement('span');
                n.className = 'n';
                n.textContent = String(p.ids.size);
                c.appendChild(n);
                c.onclick = () => {
                    selectedPlaylistIds = sel ? selectedPlaylistIds.filter(x => x !== p.id) : [...selectedPlaylistIds, p.id];
                    savePickerSettings();
                    renderChips(); renderPickLabel();
                    if (playlistFilterMode !== 'any') applyFilter();
                };
                chips.appendChild(c);
            });
        };
        renderChips();
        renderPickLabel();
        window.addEventListener('pmv:cache-ready', renderChips);
        // Full-width panel directly under the native row.
        if (row.parentElement) row.parentElement.insertBefore(panel, row.nextSibling);

        const counter = Object.assign(document.createElement('span'), { id: 'pmvbpf-counter' });
        counter.style.cssText = 'font-size:11px;color:rgba(255,255,255,.35);display:none;margin-left:4px;';

        row.appendChild(btnIn);
        row.appendChild(btnOut);
        row.appendChild(pickWrap);
        row.appendChild(counter);
        updateBtnStyles();
    }

    function injectPanelStyle() {
        if (document.getElementById('pmvbpf-panel-style')) return;
        const st = document.createElement('style');
        st.id = 'pmvbpf-panel-style';
        st.textContent = `
#pmvbpf-panel{margin:10px 0 4px;padding:12px 16px;background:#111;border:1px solid #1F1F1F;border-radius:12px;width:100%;box-sizing:border-box;}
#pmvbpf-panel[hidden]{display:none;}
#pmvbpf-panel .pmvbpf-lab{color:rgb(156,163,175);font-size:12px;font-weight:500;margin-bottom:8px;}
#pmvbpf-panel .pmvbpf-chips{display:flex;flex-wrap:wrap;gap:8px;}
#pmvbpf-panel .pmvbpf-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;line-height:1.2;white-space:nowrap;
  background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.1);transition:background .15s,color .15s;font-family:inherit;}
#pmvbpf-panel .pmvbpf-chip:hover{background:rgba(255,255,255,0.09);color:#fff;}
#pmvbpf-panel .pmvbpf-chip.active{background:rgba(249,115,22,0.2);color:rgb(249,115,22);border-color:rgba(249,115,22,0.5);font-weight:600;}
#pmvbpf-panel .pmvbpf-chip .n{opacity:.5;font-weight:400;font-family:ui-monospace,monospace;font-size:11px;}
#pmvbpf-panel .pmvbpf-empty{color:rgba(255,255,255,0.4);font-size:12px;}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    function makeBtn(label, activeColor, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.pmvColor = activeColor;
        btn.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:4px 10px;
            border-radius:9999px;border:1px solid #2A2A2A;background:#1A1A1A;
            color:#9ca3af;font-size:12px;cursor:pointer;transition:all 0.15s;white-space:nowrap;`;
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        btn.addEventListener('mouseenter', () => { if (!btn.dataset.active) btn.style.borderColor = '#3A3A3A'; });
        btn.addEventListener('mouseleave', () => { if (!btn.dataset.active) { btn.style.borderColor = '#2A2A2A'; btn.style.background = '#1A1A1A'; btn.style.color = '#9ca3af'; }});
        return btn;
    }

    function updateBtnStyles() {
        styleBtn(document.getElementById('pmvbpf-btn-in'),  playlistFilterMode === 'in',  '#22c55e');
        styleBtn(document.getElementById('pmvbpf-btn-out'), playlistFilterMode === 'out', '#f97316');
    }

    function styleBtn(btn, active, color) {
        if (!btn) return;
        const [r, g, b] = [1,3,5].map(i => parseInt(color.slice(i, i+2), 16));
        if (active) {
            btn.dataset.active = '1';
            btn.style.background  = `rgba(${r},${g},${b},.15)`;
            btn.style.borderColor = `rgba(${r},${g},${b},.5)`;
            btn.style.color       = color;
        } else {
            delete btn.dataset.active;
            btn.style.background  = '#1A1A1A';
            btn.style.borderColor = '#2A2A2A';
            btn.style.color       = '#9ca3af';
        }
    }

    // Reset the mode when the site's Clear button is used.
    document.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const txt = btn.textContent?.trim();
        if ((txt === 'Clear' || txt === 'Clear all') && playlistFilterMode !== 'any') setMode('any');
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

