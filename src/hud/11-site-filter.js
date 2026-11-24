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
            filterConfig = { ...FILTER_DEFAULTS };
            saveFilterConfig(); applyFilterToCards(); reopen();
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
            saveFilterConfig(); reopen();
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

