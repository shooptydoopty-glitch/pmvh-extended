
(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    const NF = {
        input: null, // native Vue filter input
        ownInput: null, // own input bar
        pollTimer: null,
        lastOwnValue: '',
        lastNativeValue: '',
        vuePatchApplied: false,
        defaultTerms: '', // always applied (see DEFAULT_TERMS_KEY)
    };

    // Button state of the filter panel.
    const BTN = {
        playlistMode: 'all',   // 'all' | 'in' | 'out'
        selectedPlaylistIds: [], // counted by playlistMode; empty = any playlist
        savedSearch: null, // { excludeTags, minRating, aspectFilter }
        savedSearches: null, // cached server list
        savedSearchName: '',
        ratingMin: 0, // independent of savedSearch.minRating
        ratingMax: 100,
        durationMin: 0, // seconds; Infinity max = no cap
        durationMax: Infinity,
    };

    // Staged values: panel controls only change these; onOwnInput() (Enter / Filter button)
    // commits them to BTN.*.
    let pendingPlaylistMode = BTN.playlistMode;
    let pendingSelectedPlaylistIds = BTN.selectedPlaylistIds.slice();
    let pendingSavedSearch = BTN.savedSearch;
    let pendingSavedSearchName = BTN.savedSearchName;
    let pendingRatingMin = BTN.ratingMin;
    let pendingRatingMax = BTN.ratingMax;
    let pendingDurationMin = BTN.durationMin;
    let pendingDurationMax = BTN.durationMax;
    // Default terms are staged the same way and committed in onOwnInput().
    let pendingDefaultTerms = '';
    // Assigned in buildOwnInput(); declared here so onOwnInput() can call them.
    let updatePlBtn = () => {};
    let updateSsBtn = () => {};
    let updateRatBtn = () => {};
    let updateDurBtn = () => {};
    let updateDefaultsBtn = () => {};


    // ---------------------------------------------------------------------
    // Persisted filter settings
    // ---------------------------------------------------------------------
    // Button filters and typed text are stored in localStorage; only serializable fields are written.
    const SETTINGS_KEY = 'pmvnf_filter_settings_v1';
    // Shared by all text filters (rows, Up next, /playlists): when on, terms also match
    // the description. Default on.
    const DESC_KEY = 'pmvnf_match_desc_v1';
    function matchDescEnabled() { try { return localStorage.getItem(DESC_KEY) !== '0'; } catch { return true; } }

    // Shared with the other modules (whichever loads first defines them): one JSON parse
    // per response, and the URLs the core interceptor does not index.
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
        } catch {}
        // Align pending values with the loaded state so the UI shows no unapplied changes.
        pendingPlaylistMode = BTN.playlistMode;
        pendingSelectedPlaylistIds = BTN.selectedPlaylistIds.slice();
        pendingSavedSearch = BTN.savedSearch;
        pendingSavedSearchName = BTN.savedSearchName;
        pendingRatingMin = BTN.ratingMin;
        pendingRatingMax = BTN.ratingMax;
        pendingDurationMin = BTN.durationMin;
        pendingDurationMax = BTN.durationMax;
    }

    loadSettings();

    // ---------------------------------------------------------------------
    // Default filter terms
    // ---------------------------------------------------------------------
    // Staged like the other controls; same syntax as the search bar, always prepended (see getEffectiveFilterValue).
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

    // Merges default terms and typed text into one string for parseTokens().
    // Never sent to Vue's own input.
    function getEffectiveFilterValue(ownValue) {
        return (NF.defaultTerms + ' ' + ownValue).trim();
    }

    // In/out check: membership of the selected playlists, or of any playlist when none is selected.
    function inSelectedPlaylists(memberOf) {
        const ids = BTN.selectedPlaylistIds;
        return ids.length ? ids.some(id => memberOf.has(id)) : memberOf.size > 0;
    }

    // Saved state is only restored into the controls on load. Filtering starts once Enter or
    // Filter is pressed in the current session (onOwnInput()), so remembered filters never auto-apply.
    let sessionFilterArmed = false;

    // On/off switch: off shows every row but keeps all filter settings; sorting is unaffected.
    // Persisted across reloads.
    const ENABLED_KEY = 'pmvnf_enabled_v1';
    NF.enabled = (() => { try { return localStorage.getItem(ENABLED_KEY) !== '0'; } catch { return true; } })();
    function filterLive() { return sessionFilterArmed && NF.enabled; }
    function setFilterEnabled(on, { refilter = true } = {}) {
        NF.enabled = !!on;
        try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch {}
        try { NF.renderPower?.(); } catch {}
        try { refreshPendingMarks(); } catch {}
        if (!refilter) return;
        // Switching on before anything was applied counts as pressing Filter.
        if (on && !sessionFilterArmed && NF.applyAll) { NF.applyAll(); return; }
        applyFilter(NF.lastOwnValue, /* force= */ true);
    }

    // True if any filter (text, default terms, playlist, saved search, ranges) is active.
    // Use this, not NF.lastOwnValue, for re-evaluation decisions, or button-only filters are missed.
    function hasAnyActiveFilter() {
        return filterLive() && (
            !!NF.lastOwnValue
            || !!NF.defaultTerms
            || BTN.playlistMode !== 'all'
            || BTN.savedSearch !== null
            || BTN.ratingMin > 0 || BTN.ratingMax < 100
            || BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)
        );
    }

    // ---------------------------------------------------------------------
    // Playlist data
    // ---------------------------------------------------------------------
    // Read from the core's in-memory state when available, else from its localStorage cache.

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
        // Lowercase tags.
        const rawTags = raw.excludeTags ?? raw.exclude_tags ?? [];
        const excludeTags = (typeof rawTags === 'string' ? rawTags.split(',') : rawTags)
            .map(t => t.trim().toLowerCase()).filter(Boolean);
        // aspect: array like ["16:9","21:9"] or a string.
        const hasAspect = Array.isArray(raw.aspect) ? raw.aspect.length > 0 : !!(raw.aspect);
        // Gay/trans: include* === 'exclude'.
        const excludeGay   = raw.includeGay   === 'exclude' || raw.excludeGay   === true;
        const excludeTrans = raw.includeTrans  === 'exclude' || raw.excludeTrans === true;
        const minRating = raw.minRating ? Number(raw.minRating) : 0;
        const rawAspect = Array.isArray(raw.aspect) ? raw.aspect : (raw.aspect ? [raw.aspect] : []);
        return { excludeTags, minRating, aspectFilter: hasAspect, excludeGay, excludeTrans, _rawAspect: rawAspect };
    }

    function loadPlaylistCache() {
        // 1. Live in-memory state of the core.
        try {
            const s = PMVX.state;
            if (s?.playlists?.size) {
                playlistsMap = s.playlists;
                reverseMap   = s.reverse;
                return playlistsMap.size > 0;
            }
        } catch {}

        // 2. localStorage cache (core not ready yet).
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

    // Core cache-ready event.
    window.addEventListener('pmv:cache-ready', () => {
        loadPlaylistCache();
        if (hasAnyActiveFilter()) {
            requestAnimationFrame(() => applyFilter(NF.lastOwnValue, /* force= */ true));
        }
    });

    // localStorage cache updated.
    window.addEventListener('storage', e => {
        if (e.key !== CACHE_KEY) return;
        loadPlaylistCache();
        // Forced: the localStorage cache has no version for applyFilter's cacheVersion guard.
        if (hasAnyActiveFilter()) {
            requestAnimationFrame(() => applyFilter(NF.lastOwnValue, /* force= */ true));
        }
    });

    // The core writes clicked tags into the default terms and fires this event (storage events
    // don't reach the writing window). A tag added before the filter is armed counts as pressing
    // Filter; a removal only refilters when armed. Unapplied panel edits are replaced.
    window.addEventListener('pmv:nf-default-terms', e => {
        loadDefaultTerms();
        pendingDefaultTerms = NF.defaultTerms;
        try { defaultsToUi(pendingDefaultTerms); NF.renderOwnChips?.(); } catch {}
        updateDefaultsBtn();
        try { refreshPendingMarks(); } catch {}
        if (sessionFilterArmed) requestAnimationFrame(() => applyFilter(NF.lastOwnValue, /* force= */ true));
        else if (e.detail?.added && NF.input) onOwnInput(NF.lastOwnValue);
    });

    // Prefer live state from the core.
    function getLivePlaylists() {
        try {
            const s = PMVX.state;
            if (s?.playlists?.size) return { playlists: s.playlists, reverse: s.reverse };
        } catch {}
        return { playlists: playlistsMap, reverse: reverseMap };
    }

    // ---------------------------------------------------------------------
    // Video ID from a row
    // ---------------------------------------------------------------------
    // Row thumbnails carry a media (asset) ID that is not the video _id, so index lookups come first.

    function getRowVideoId(row) {
        // Explicit data attribute.
        if (row.dataset.videoId) return row.dataset.videoId;

        // 1. ID already resolved by the core (data-pmv-queue-checked).
        if (row.dataset.pmvQueueChecked) {
            const id = row.dataset.pmvQueueChecked;
            // Trust only IDs known to belong to a playlist; otherwise it may be an asset ID.
            const { reverse } = getLivePlaylists();
            if (reverse?.has(id)) return id;
        }

        const img = row.querySelector('img[src]');
        const huds = PMVX.state;

        // 2. Visible title via titleIndex; more reliable than img.alt, which lags when Vue recycles nodes.
        const titleEl = row.querySelector('.flex-1.min-w-0 p, .flex-1.min-w-0 span, .flex-1.min-w-0');
        const visibleTitle = (titleEl?.firstChild?.nodeValue?.trim() ||
                              titleEl?.childNodes?.[0]?.textContent?.trim() ||
                              titleEl?.textContent?.trim() || '').toLowerCase();
        if (visibleTitle && huds?.titleIndex?.has(visibleTitle)) {
            return huds.titleIndex.get(visibleTitle);
        }

        // 3. titleIndex via alt text (layouts without a title node).
        const alt = img?.alt?.trim().toLowerCase();
        if (alt && huds?.titleIndex?.has(alt)) {
            return huds.titleIndex.get(alt);
        }

        // 4. thumbnailIndex (exact URL match).
        if (img?.src && huds?.thumbnailIndex) {
            const clean = img.src.split('?')[0];
            if (huds.thumbnailIndex.has(clean)) return huds.thumbnailIndex.get(clean);
        }

        // 5. Hex from the thumbnail URL, only if it belongs to a playlist (otherwise an asset ID).
        const { reverse } = getLivePlaylists();
        if (img?.src) {
            const m = img.src.match(/\/thumbnails\/([a-f0-9]{24})\//) ||
                      img.src.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//) ||
                      img.src.match(/\/([a-f0-9]{24})\/thumbnail\//);
            if (m && reverse?.has(m[1])) return m[1];
        }

        // 6. Href of a video link in the row.
        const link = row.querySelector('a[href*="/video/"]') ||
                     row.closest('a[href*="/video/"]');
        if (link?.href) {
            const m = link.href.match(/_([a-f0-9]{24})(?:[?#/]|$)/);
            if (m) return m[1];
        }

        // 7. Unvalidated hex (possibly an asset ID); last resort for !in/!out.
        if (img?.src) {
            const m = img.src.match(/\/thumbnails\/([a-f0-9]{24})\//) ||
                      img.src.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//) ||
                      img.src.match(/\/([a-f0-9]{24})\/thumbnail\//);
            if (m) return m[1];
        }

        return null;
    }

    // ---------------------------------------------------------------------
    // Filter syntax
    // ---------------------------------------------------------------------
    //   foo         show only rows matching "foo" (title, tags or performers)
    //   -foo        hide rows matching "foo"
    //   "foo bar"   multi-word term (also -"foo bar")
    //   !in / !out  hide rows in any playlist / in no playlist
    //   !in:name    hide rows in playlist "name"
    //   !out:name   hide rows not in playlist "name"

    // Tokenizer: quoted substrings (optionally prefixed with -) form one token;
    // everything else splits on whitespace.
    function tokenizeRaw(raw) {
        const re = /-?"[^"]*"|-?'[^']*'|\S+/g;
        return raw.trim().match(re) || [];
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
            textExclude: [], // strings that must NOT appear in the text
            textInclude: [], // strings that MUST appear in the text
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
                result.textExclude.push(stripQuotes(tok.slice(1)).toLowerCase());
            } else {
                result.textInclude.push(stripQuotes(tok).toLowerCase());
            }
        });

        return result;
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

    // vid / descOn are passed in by applyFilter() to avoid repeated DOM and localStorage lookups.
    function rowPassesFilter(row, tokens, vid = undefined, descOn = undefined) {
        const { textExclude, textInclude, playlistFilters, seenFilter } = tokens;
        const videoId = vid === undefined ? getRowVideoId(row) : vid;
        const matchDesc = descOn === undefined ? matchDescEnabled() : descOn;

        // Text: the row title always, plus tags and performers when known via videoMeta.
        const meta = videoId ? PMVX.state?.videoMeta?.get(videoId) : null;
        const text = (row.querySelector('h4')?.textContent || row.textContent || '').toLowerCase();
        const haystacks = [text, ...(meta?.tags || []), ...(meta?.starsTags || [])];
        if (matchDesc && meta?.description) haystacks.push(meta.description);
        for (const term of textInclude) {
            if (!haystacks.some(h => h.includes(term))) return false;
        }
        for (const term of textExclude) {
            if (haystacks.some(h => h.includes(term))) return false;
        }

        if (playlistFilters.length > 0) {
            const { playlists, reverse } = getLivePlaylists();
            const memberOf = videoId ? (reverse.get(videoId) || new Set()) : new Set();

            for (const pf of playlistFilters) {
                if (pf.name) {
                    // Partial name match.
                    let matchedId = null;
                    playlists.forEach((p, id) => {
                        if (p.name.toLowerCase().includes(pf.name)) matchedId = id;
                    });

                    const inThat = matchedId ? memberOf.has(matchedId) : false;
                    if (pf.mode === 'in'  &&  inThat) return false; // it's in there, hide it
                    if (pf.mode === 'out' && !inThat) return false; // it's not in there, hide it
                } else {
                    // No name: any playlist.
                    const inAny = memberOf.size > 0;
                    if (pf.mode === 'in'  &&  inAny) return false;
                    if (pf.mode === 'out' && !inAny) return false;
                }
            }
        }

        // Meta-based checks.

        // !seen / !unseen use local playback history; an unknown ID is never filtered out.
        if (seenFilter && videoId && typeof PMVX.isWatched === 'function') {
            const isWatched = PMVX.isWatched(videoId);
            if (seenFilter === 'seen' && !isWatched) return false;
            if (seenFilter === 'unseen' && isWatched) return false;
        }

        // Rating range; an unknown rating is never filtered out.
        if ((BTN.ratingMin > 0 || BTN.ratingMax < 100) && meta && meta.bayesianRating > 0) {
            if (meta.bayesianRating < BTN.ratingMin || meta.bayesianRating > BTN.ratingMax) return false;
        }

        // Duration range; an unknown duration is never filtered out.
        if ((BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)) && meta) {
            const dur = toDurationSeconds(meta.duration);
            if (dur > 0 && (dur < BTN.durationMin || dur > BTN.durationMax)) return false;
        }

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
                    // The ratio must fall within one of the aspects.
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

        // Playlist mode button.
        if (BTN.playlistMode !== 'all') {
            const { reverse } = getLivePlaylists();
            const memberOf = videoId ? (reverse.get(videoId) || new Set()) : new Set();
            const inSelected = inSelectedPlaylists(memberOf);
            if (BTN.playlistMode === 'in'  && !inSelected) return false;
            if (BTN.playlistMode === 'out' &&  inSelected) return false;
        }

        return true;
    }


    // ---------------------------------------------------------------------
    // Up next preview helpers
    // ---------------------------------------------------------------------
    // The preview is a <button> after the "Up Next" label <p>, not a [role="button"] div.

    function findUpNextButton() {
        // The label <p> sits directly above the preview button.
        const labels = document.querySelectorAll('p');
        for (const p of labels) {
            const txt = (p.textContent || '').trim();
            if (/^up\s*next$/i.test(txt)) {
                const btn = p.nextElementSibling;
                if (btn?.tagName === 'BUTTON') return btn;
                // Or via the parent's next button.
                const wrap = p.parentElement;
                const wrapBtn = wrap?.querySelector('button');
                if (wrapBtn) return wrapBtn;
            }
        }
        return null;
    }

    function upNextWrapper(btn) {
        // Styleable wrapper around the box.
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

        // 2. thumbnailIndex exact URL match.
        if (img?.src && huds?.thumbnailIndex) {
            const clean = img.src.split('?')[0];
            if (huds.thumbnailIndex.has(clean)) return huds.thumbnailIndex.get(clean);
        }

        // 3. Hex from the URL, only if in the reverse map (excludes asset IDs).
        const { reverse } = getLivePlaylists();
        if (img?.src) {
            const m = img.src.match(/\/thumbnails\/([a-f0-9]{24})\//) ||
                      img.src.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//) ||
                      img.src.match(/\/([a-f0-9]{24})\/thumbnail\//);
            if (m && reverse?.has(m[1])) return m[1];
        }

        // 4. Unvalidated hex.
        if (img?.src) {
            const m = img.src.match(/\/thumbnails\/([a-f0-9]{24})\//) ||
                      img.src.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//) ||
                      img.src.match(/\/([a-f0-9]{24})\/thumbnail\//);
            if (m) return m[1];
        }

        return null;
    }

    function upNextPassesFilter(btn, tokens) {
        if (!btn) return true;
        const text = getUpNextTitle(btn).toLowerCase();
        const upVid = getUpNextVideoId(btn);
        const upMeta = upVid ? PMVX.state?.videoMeta?.get(upVid) : null;
        const upHay = [text];
        if (matchDescEnabled() && upMeta?.description) upHay.push(upMeta.description);
        for (const term of tokens.textInclude) if (!upHay.some(h => h.includes(term))) return false;
        for (const term of tokens.textExclude) if (upHay.some(h => h.includes(term))) return false;

        if (tokens.playlistFilters.length > 0) {
            const vid = getUpNextVideoId(btn);
            const { playlists, reverse } = getLivePlaylists();
            const memberOf = vid ? (reverse.get(vid) || new Set()) : new Set();

            for (const pf of tokens.playlistFilters) {
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
        // Meta-based button filters.
        const vid2 = getUpNextVideoId(btn);
        const meta2 = vid2 ? PMVX.state?.videoMeta?.get(vid2) : null;

        if (tokens.seenFilter && vid2 && typeof PMVX.isWatched === 'function') {
            const isWatched2 = PMVX.isWatched(vid2);
            if (tokens.seenFilter === 'seen' && !isWatched2) return false;
            if (tokens.seenFilter === 'unseen' && isWatched2) return false;
        }

        if ((BTN.ratingMin > 0 || BTN.ratingMax < 100) && meta2 && meta2.bayesianRating > 0) {
            if (meta2.bayesianRating < BTN.ratingMin || meta2.bayesianRating > BTN.ratingMax) return false;
        }

        if ((BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)) && meta2) {
            const dur2 = toDurationSeconds(meta2.duration);
            if (dur2 > 0 && (dur2 < BTN.durationMin || dur2 > BTN.durationMax)) return false;
        }

        if (BTN.savedSearch && meta2) {
            const ss = BTN.savedSearch;
            if (ss.excludeTags?.length) {
                for (const t of ss.excludeTags) {
                    if (meta2.tags.includes(t)) return false;
                }
            }
            if (ss.minRating && meta2.bayesianRating > 0 && meta2.bayesianRating < ss.minRating) return false;
            if (ss.aspectFilter && meta2.width && meta2.height) {
                const ratio = meta2.width / meta2.height;
                const aspectOk = (ss._rawAspect || []).some(a => {
                    if (a === '16:9') return ratio >= 1.7  && ratio <= 1.8;
                    if (a === '21:9') return ratio >= 2.3  && ratio <= 2.45;
                    if (a === '4:3')  return ratio >= 1.3  && ratio <= 1.35;
                    return false;
                });
                if (!aspectOk) return false;
            }
        }

        if (BTN.playlistMode !== 'all') {
            const { reverse } = getLivePlaylists();
            const memberOf2 = vid2 ? (reverse.get(vid2) || new Set()) : new Set();
            const inSelected = inSelectedPlaylists(memberOf2);
            if (BTN.playlistMode === 'in'  && !inSelected) return false;
            if (BTN.playlistMode === 'out' &&  inSelected) return false;
        }

        return true;
    }

    // ---------------------------------------------------------------------
    // Applying the filter
    // ---------------------------------------------------------------------

    let lastAppliedValue = null;
    let lastAppliedDataVersion = -1;


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
        );

        // Auto-fetch: if the active filter needs videoMeta that is incomplete, start the Fetch all
        // cycle in the background; it re-applies the filter when done.
        const needsMeta = hasOwnFilter && (
            !!(BTN.savedSearch && (BTN.savedSearch.minRating || BTN.savedSearch.aspectFilter))
            || BTN.ratingMin > 0 || BTN.ratingMax < 100
            || BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)
            || tokens.textInclude.length > 0
            || tokens.textExclude.length > 0
        );
        autoFetchAllIfNeeded(effectiveValue, hasOwnFilter, needsMeta);

        // All queue rows.
        const rows = document.querySelectorAll('[role="button"]');
        let shown = 0, hidden = 0;
        let activeHidden = false;

        // Grace window: rows just added/removed (PMVX.justAddedIds: Map<id, timestamp>)
        // stay in place briefly.
        const GRACE_MS = 2500;
        const justAddedIds = PMVX.justAddedIds;

        // Dedup: the page=1 limit bump can make Vue's pagination return videos already in the
        // enlarged first page. Only the first row per video ID counts; later duplicates are hidden,
        // except the playing row.
        const seenVideoIds = new Set();
        const descOn = matchDescEnabled(); // once per pass

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

            if (!visible) {
                const addedAt = rowVid && justAddedIds?.get(rowVid);
                if (addedAt && (Date.now() - addedAt < GRACE_MS)) {
                    // Just added/removed: keep the row for a moment.
                    row.style.display = '';
                    shown++;
                    return;
                }
            }

            row.style.display = visible ? '' : 'none';
            visible ? shown++ : hidden++;

            if (isActive && !visible) activeHidden = true;
        });

        // Up next: display-only override, see overrideUpNext().

        updateCounter(hasOwnFilter ? `${shown}/${shown + hidden}` : '');

        // If the playing video is hidden, trigger N to advance, but only when a visible row exists
        // further on; otherwise every skip lands on a filtered video and chains up to SKIP_CHAIN_MAX skips.
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

        // Up next box: display-only override with the first visible row after the active one;
        // Vue's pointer is untouched.
        overrideUpNext(tokens);
    }

    // ---------------------------------------------------------------------
    // Up next override
    // ---------------------------------------------------------------------
    // Replaces the Up next title/thumbnail with the first visible row after the active one, leaving Vue's playback pointer alone.

    let upNextOverrideActive = false;

    function overrideUpNext(tokens) {
        const upBtn = findUpNextButton();
        const upWrap = upNextWrapper(upBtn);
        if (!upBtn || !upWrap) return;

        const hasFilter = filterLive() && (
                          tokens.textExclude.length > 0 ||
                          tokens.textInclude.length > 0 ||
                          tokens.playlistFilters.length > 0 ||
                          BTN.playlistMode !== 'all' ||
                          BTN.savedSearch !== null ||
                          BTN.ratingMin > 0 || BTN.ratingMax < 100 ||
                          BTN.durationMin > 0 || Number.isFinite(BTN.durationMax));

        // Also override when only a sort is active: Vue's up next follows its own unsorted order.
        if (!hasFilter && !sortedRowIds) {
            // Neither filter nor sort: restore the original.
            upWrap.style.removeProperty('display');
            const overlay = upWrap.querySelector('#pmvnf-upnext-overlay');
            if (overlay) overlay.remove();
            upNextOverrideActive = false;
            return;
        }

        // With a sort active Vue's up next is always wrong, so override regardless of upNextPassesFilter.
        if (!sortedRowIds) {
            const upNextPasses = upNextPassesFilter(upBtn, tokens);
            if (upNextPasses) {
                // Up next is visible: no override needed.
                const overlay = upWrap.querySelector('#pmvnf-upnext-overlay');
                if (overlay) overlay.remove();
                upWrap.style.removeProperty('display');
                upNextOverrideActive = false;
                return;
            }
        }

        // Next row by sort order (+ filter) when sorting, otherwise the first visible row after
        // the active one in DOM order.
        let nextVisible;
        if (sortedRowIds) {
            nextVisible = getSortAwareNextRow();
        } else {
            const rows = Array.from(document.querySelectorAll('[role="button"]'));
            const activeIdx = rows.findIndex(r => r.classList.contains('border-orange-500'));
            nextVisible = null;
            for (let i = activeIdx + 1; i < rows.length; i++) {
                if (rows[i].style.display !== 'none') { nextVisible = rows[i]; break; }
            }
        }

        if (!nextVisible) {
            // Nothing visible left: hide the box.
            upWrap.style.display = 'none';
            upNextOverrideActive = false;
            return;
        }

        // Take title and thumbnail from the visible row.
        const nextTitle = nextVisible.querySelector('h4, p')?.textContent?.trim() || '';
        const nextImg   = nextVisible.querySelector('img[src]');

        // Create or update the overlay on the box.
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

        upNextOverrideActive = true;
    }

    // ---------------------------------------------------------------------
    // Vue input patch
    // ---------------------------------------------------------------------
    // Vue's v-model only reacts to InputEvents, so the native input is written via a dispatched event.
    // Always sends '' to Vue: its native filter only matches titles and would remove rows that match here
    // via a tag or performer. All text matching happens in applyFilter()/rowPassesFilter().

    function syncToVue(ownValue) {
        if (!NF.input) return;

        const vueValue = '';

        if (NF.input.value === vueValue) return;

        // Set the value and dispatch an InputEvent so Vue's listener fires.
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

    const DURATION_SLIDER_MAX_MIN = 60; // duration slider upper end in minutes (= no limit)


    // ---------------------------------------------------------------------
    // Fetch all
    // ---------------------------------------------------------------------
    // Loads the whole playlist via fetchAll=true (PMVX.forceFetchAllNext, read by the core's fetch interceptor),
    // then reports metadata coverage; tag/performer filtering needs videoMeta for every row.
    let manualFetchAllRunning = false;

    async function runManualFetchAll(statusEl, btnEl) {
        if (manualFetchAllRunning) return;
        manualFetchAllRunning = true;
        btnEl.disabled = true;
        statusEl.textContent = 'loading…';
        statusEl.style.color = 'rgba(255,255,255,0.4)';

        // Shared cycle (runFetchAllCycle).
        const { ok, waitedMs } = await runFetchAllCycle({ maxWaitMs: 20000 });
        if (!ok) {
            statusEl.textContent = 'no queue found';
            statusEl.style.color = 'rgb(252,165,165)';
            btnEl.disabled = false;
            manualFetchAllRunning = false;
            return;
        }

        // Metadata coverage: rows with a videoMeta entry.
        const { total, withMeta, unknownId } = getMetaCoverage();

        if (total > 0 && withMeta === total) {
            statusEl.textContent = `${withMeta}/${total} metadata complete`;
            statusEl.style.color = 'rgb(134,239,172)';
        } else {
            statusEl.textContent = `${withMeta}/${total} metadata${unknownId ? ` (${unknownId} unknown)` : ''}`;
            statusEl.style.color = 'rgb(253,186,116)';
        }

        // Re-apply with the new metadata.
        applyFilter(NF.lastOwnValue, true);

        btnEl.disabled = false;
        manualFetchAllRunning = false;
    }

    // ---------------------------------------------------------------------
    // Sorting
    // ---------------------------------------------------------------------
    // Client-side via CSS order from cached metadata (rating, upload date, views); only loaded rows are sorted.
    // DOM order and Vue's playlist index are untouched. Rows loaded later have no order until sorting is
    // reapplied; the deeplink catch-up and Up next assume DOM order == playlist order.

    let sortedRowIds = null; // video IDs in applied sort order
    let currentSortMode = null; // last applied sort key
    let ratingSortAscending = false; // only used by mode 'rating'

    // Next row according to the active sort (filtered); used by triggerNextKey()/attachNIntercept().
    function getSortAwareNextRow() {
        if (!sortedRowIds) return null;
        const rows = Array.from(document.querySelectorAll('[role="button"]'));
        const byId = new Map(rows.map(r => [getRowVideoId(r), r]));
        const activeRow = rows.find(r => r.classList.contains('border-orange-500'));
        const activeId = activeRow ? getRowVideoId(activeRow) : null;
        const startPos = activeId ? sortedRowIds.indexOf(activeId) : -1;
        for (let i = startPos + 1; i < sortedRowIds.length; i++) {
            const r = byId.get(sortedRowIds[i]);
            if (!r) continue; // not (yet) in the DOM, e.g. a row scrolled out of view
            if (rowShouldBeHidden(r)) continue; // the filter still excludes it
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
        const list = document.querySelector('[role="button"]')?.parentElement;
        if (!list) return;
        const rows = Array.from(list.querySelectorAll(':scope > [role="button"]'));
        if (!rows.length) return;

        // Only the CSS `order` property is set, never the DOM order: moving nodes would trigger the
        // childList MutationObserver (re-running the filter), and Vue re-renders would undo the reorder.
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

        // Rows without metadata get the highest order values (bottom). Rows added later default to
        // order:0 until sorting is reapplied.
        [...withMeta.map(x => x.row), ...withoutMeta].forEach((r, i) => {
            r.style.order = String(i + 1);
        });
        sortedRowIds = [...withMeta.map(x => x.row), ...withoutMeta].map(r => getRowVideoId(r));

        if (withoutMeta.length) {
            updateCounter(`sorted (${withoutMeta.length} rows without metadata at the bottom)`);
        }
    }

    // Clears the CSS order override, restoring Vue's DOM order.
    function resetSort() {
        const list = document.querySelector('[role="button"]')?.parentElement;
        if (list) {
            Array.from(list.querySelectorAll(':scope > [role="button"]'))
                .forEach(r => r.style.removeProperty('order'));
        }
        sortedRowIds = null;
        currentSortMode = null;
        saveSortSettings();
    }

    // Persists sort mode and direction into the SETTINGS_KEY blob (merged). Declared here because
    // the sort state does not exist yet when loadSettings() runs; restoreSortSettings() loads it later.
    function saveSortSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const s = raw ? JSON.parse(raw) : {};
            s.sortMode = currentSortMode;
            s.sortAscending = ratingSortAscending;
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        } catch {}
    }

    // ---------------------------------------------------------------------
    // Playlist-page filter panel
    // ---------------------------------------------------------------------
    // - The native filter input stays in the DOM (syncToVue() writes to it) but is hidden; an own search
    //   field and Filters button take its place, with active chips below.
    // - The panel is a drawer over the queue (absolute in the sidebar card, own scroll), so it never
    //   pushes or clips the queue.
    // - Playlist, saved search and sort use dropdowns in the site's custom-select style; default terms
    //   are visible chips.
    // - Chips are composed back into the token string parseTokens() consumes.
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
    function quoteTerm(term) { return /\s/.test(term) ? `"${term}"` : term; }
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
.pmvnf-toggle .badge{min-width:16px;height:16px;padding:0 4px;border-radius:9999px;background:rgba(0,0,0,0.3);font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-family:ui-monospace,monospace;}
.pmvnf-toggle .badge:empty{display:none;}
.pmvnf-chips{display:flex;flex-wrap:wrap;gap:4px;}
.pmvnf-chips:empty{display:none;}
.pmvnf-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:4px;border:none;cursor:default;font-size:11px;line-height:16px;font-family:inherit;}
.pmvnf-tag svg{width:10px;height:10px;}
.pmvnf-tag .x{display:inline-flex;opacity:.6;padding:2px;border-radius:3px;cursor:pointer;margin-left:1px;}
.pmvnf-tag .x:hover{opacity:1;background:rgba(255,255,255,0.12);}
.pmvnf-tag.pos{background:rgba(249,115,22,0.2);color:rgb(253,186,116);}
.pmvnf-tag.neg{background:rgba(239,68,68,0.2);color:rgb(252,165,165);} .pmvnf-tag.neg .txt{text-decoration:line-through;}
.pmvnf-tag.raw{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.6);font-family:ui-monospace,monospace;}
.pmvnf-tag.def{opacity:.75;outline:1px dashed rgba(255,255,255,0.15);outline-offset:-1px;}
#pmvnf-panel{position:absolute;left:0;right:0;bottom:0;z-index:30;display:none;flex-direction:column;background:#1A1A1A;}
#pmvnf-panel[data-open="1"]{display:flex;}
.pmvnf-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px 8px;display:flex;flex-direction:column;gap:12px;}
.pmvnf-sec{display:flex;flex-direction:column;gap:5px;}
.pmvnf-lab{font-size:10px;font-weight:600;color:rgb(156,163,175);text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:6px;}
.pmvnf-lab .r{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400;color:rgba(255,255,255,0.35);font-family:ui-monospace,monospace;}
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
#pmvnf-counter{font-size:10px;color:rgba(255,255,255,0.4);font-family:ui-monospace,monospace;white-space:nowrap;}
#pmvnf-fetchall-status{font-size:10px;color:rgba(255,255,255,0.3);white-space:nowrap;font-family:ui-monospace,monospace;}
#pmvnf-qfoot{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid #2A2A2A;background:#1A1A1A;flex-shrink:0;}
/* native custom-select look (scaled to the sidebar) */
.pmvnf-sel{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border-radius:6px;cursor:pointer;text-align:left;
  background:#0F0F0F;border:1px solid #2A2A2A;color:#fff;font-size:12px;font-family:inherit;transition:border-color .15s;}
.pmvnf-sel:hover{border-color:#3A3A3A;}
.pmvnf-sel[data-open="1"]{border-color:rgb(249,115,22);}
.pmvnf-sel .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmvnf-sel .t.ph{color:rgb(107,114,128);}
.pmvnf-sel .n{color:rgba(255,255,255,0.4);font-size:10px;font-family:ui-monospace,monospace;}
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

    // Dropdown in the site's custom-select style. items(): [{value,title,sub}]; multi toggles values,
    // single picks one and closes. The list is position:fixed because the scrolling panel would clip an absolute one.
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

    // Sort dropdown replacing the native "Added" button in the Shuffle/Loop/Auto row. The native button is
    // hidden, not removed: the arrow forwards clicks to it for the site's own order. Modes: Added (site order),
    // Rating, Upload date; the arrow toggles direction. Applies immediately. Re-attached from startObserver().
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
        // Compact segment [arrow | Added] to fit the Shuffle/Loop/Auto row.
        const seg = mk('div', 'pmvnf-sortseg'); seg.id = 'pmvnf-sortseg';
        sortDirBtn = mk('button'); sortDirBtn.type = 'button'; sortDirBtn.id = 'pmvnf-sortdir';
        sortDirBtn.onclick = () => applySortChoice(sortMode(), !sortAsc());
        seg.append(sortDirBtn, sortSel.el);
        const r1 = sortSel.render;
        sortSel.render = () => { r1(); seg.dataset.active = currentSortMode ? '1' : '0'; };
        sortSel.render(); renderSortDir();
        if (added) row.insertBefore(seg, added); else row.appendChild(seg);
    }

    // Fetch all footer under the queue list (not in the drawer). Re-attached when missing.
    function injectQueueFooter() {
        if (document.getElementById('pmvnf-qfoot')) return;
        const list = document.querySelector('[role="button"]')?.closest('.overflow-y-auto');
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
        const card = header?.parentElement;                    // .bg-[#1A1A1A].rounded-lg.overflow-hidden.flex.flex-col
        if (nativeWrapper) nativeWrapper.setAttribute('data-pmvnf-native-hidden', '1');
        if (card) card.setAttribute('data-pmvnf-card', '1');

        // Top row: search field and Filters button, chips below.
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
        const power = mk('button', 'pmvnf-power'); power.type = 'button';
        power.setAttribute('role', 'switch');
        power.innerHTML = '<span class="knob"></span>';
        power.onclick = () => setFilterEnabled(!NF.enabled);
        top.append(search, power, toggle, chev);
        const topChips = mk('div', 'pmvnf-chips');
        wrap.append(top, topChips);
        NF.renderPower = () => {
            power.setAttribute('aria-checked', NF.enabled ? 'true' : 'false');
            power.title = NF.enabled
                ? 'Filter on \u2014 click to turn off (settings are kept)'
                : 'Filter off \u2014 click to turn on';
            wrap.dataset.off = NF.enabled ? '0' : '1';
        };
        NF.renderPower();
        if (header) header.insertBefore(wrap, nativeWrapper.nextSibling); else document.body.prepend(wrap);

        // Drawer.
        const panel = mk('div'); panel.id = 'pmvnf-panel';
        panel.dataset.open = UI.open ? '1' : '0';
        const body = mk('div', 'pmvnf-body');
        panel.appendChild(body);
        (card || document.body).appendChild(panel);
        const placePanel = () => {
            if (!card || !header) return;
            const top = header.getBoundingClientRect().bottom - card.getBoundingClientRect().top;
            panel.style.top = Math.max(0, Math.round(top)) + 'px';
            const foot = document.getElementById('pmvnf-qfoot');
            panel.style.bottom = (foot ? Math.round(foot.getBoundingClientRect().height) : 0) + 'px';
        };
        placePanel();
        try { new ResizeObserver(placePanel).observe(header); } catch {}
        const setOpen = (v) => {
            UI.open = v;
            panel.dataset.open = v ? '1' : '0';
            chev.dataset.open = v ? '1' : '0';
            chev.title = v ? 'Collapse filters' : 'Expand filters';
            try { localStorage.setItem(UI_OPEN_KEY, v ? '1' : '0'); } catch {}
            if (v) { placePanel(); loadSavedSearchList(); }
            else closeDd();
        };
        toggle.onclick = () => applyAll();
        chev.onclick = () => setOpen(!UI.open);

        // Chips (shared renderer).
        const drawChips = (host, kind, list, extraCls = '') => {
            host.textContent = '';
            list.forEach((term, i) => {
                const c = mk('span', `pmvnf-tag ${kind.replace('d', '')} ${extraCls}`.trim());
                if (kind.endsWith('neg')) { const ic = mk('span'); ic.innerHTML = SVG_BAN; ic.style.display = 'inline-flex'; c.appendChild(ic); }
                c.appendChild(mk('span', 'txt', kind.endsWith('raw') ? term : '#' + term));
                const x = mk('span', 'x'); x.innerHTML = SVG_X; x.title = 'Remove';
                x.onclick = () => { list.splice(i, 1); afterChipChange(kind); };
                c.appendChild(x);
                host.appendChild(c);
            });
        };
        const renderTagChips = () => {
            topChips.textContent = '';
            const a = mk('div', 'pmvnf-chips'), b = mk('div', 'pmvnf-chips'), c = mk('div', 'pmvnf-chips');
            drawChips(a, 'pos', UI.pos); drawChips(b, 'neg', UI.neg); drawChips(c, 'raw', UI.raw);
            [...a.children, ...b.children, ...c.children].forEach(el => topChips.appendChild(el));
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
                const term = inp.value.trim().replace(/^#/, '').toLowerCase();
                if (!term) { applyAll(); return true; }
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

        // Exclude.
        const secNeg = mk('div', 'pmvnf-sec');
        secNeg.appendChild(mk('div', 'pmvnf-lab', 'Exclude'));
        const inpNeg = mk('input'); inpNeg.type = 'text'; inpNeg.spellcheck = false; inpNeg.autocomplete = 'off';
        inpNeg.placeholder = 'Hide videos with… (title, tag or performer)'; inpNeg.dataset.pmvnfKind = 'neg';
        inpNeg.addEventListener('keydown', e => e.stopPropagation(), true);
        const negChips = mk('div', 'pmvnf-chips');
        secNeg.append(inpNeg, negChips, mk('div', 'pmvnf-hint', 'Enter adds · Enter in an empty field applies · Backspace in an empty field removes the last one'));
        body.appendChild(secNeg);

        // Default terms (always active).
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

        // Playlist.
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

        // Seen.
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

        // Rating / duration.
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

        // Saved search (dropdown, loaded lazily).
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

        // Actions (sticky at the bottom of the drawer).
        const actions = mk('div', 'pmvnf-actions');
        const counter = mk('span'); counter.id = 'pmvnf-counter';
        const closeBtn = mk('button', 'pmvnf-close', 'Close ✕'); closeBtn.type = 'button'; closeBtn.onclick = () => setOpen(false);
        actions.append(counter, closeBtn);
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
            if (BTN.ratingMin > 0 || BTN.ratingMax < 100) n++;
            if (BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)) n++;
            if (BTN.savedSearchName) n++;
            if (NF.defaultTerms) n++;
            badge.textContent = n ? String(n) : '';
            toggle.dataset.active = n && filterLive() ? '1' : '0';
            toggle.title = pend ? 'Apply changes'
                : (n && !NF.enabled ? 'Filter is off \u2014 click to apply and turn it on'
                : (n && !sessionFilterArmed ? 'Remembered from your last visit — not active yet, click to apply' : 'Apply filters'));
        };

        renderTagChips(); renderSeen(); updatePlBtn(); ratSlider.render(); durSlider.render(); updateSsBtn(); updateDefaultsBtn(); refreshPendingMarks();
        injectQueueFooter();
        setOpen(UI.open);
        injectSortSelect();
        window.addEventListener('pmv:cache-ready', () => { try { updatePlBtn(); } catch {} });
        attachOwnInputKeyIntercept();
    }

    // Document-level capture handler for Enter/Escape in the own input. Reads NF.ownInput on each
    // event so it survives panel rebuilds.
    let ownInputKeyInterceptActive = false;
    function attachOwnInputKeyIntercept() {
        if (ownInputKeyInterceptActive) return;
        ownInputKeyInterceptActive = true;
        document.addEventListener('keydown', e => {
            // Chip inputs of the panel: Enter adds a chip (or applies when empty), Backspace removes, Escape clears.
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


    // ---------------------------------------------------------------------
    // Main flow
    // ---------------------------------------------------------------------

    function onOwnInput(value) {
        // First Enter/Filter press arms filtering (see sessionFilterArmed).
        sessionFilterArmed = true;
        // Applying implies the filter switch turns on.
        if (!NF.enabled) setFilterEnabled(true, { refilter: false });

        // Commit staged playlist-mode / saved-search button values only on Enter/Filter.
        BTN.playlistMode = pendingPlaylistMode;
        BTN.selectedPlaylistIds = pendingSelectedPlaylistIds.slice();
        BTN.savedSearch = pendingSavedSearch;
        BTN.savedSearchName = pendingSavedSearchName;
        BTN.ratingMin = pendingRatingMin;
        BTN.ratingMax = pendingRatingMax;
        BTN.durationMin = pendingDurationMin;
        BTN.durationMax = pendingDurationMax;
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
        watchVideoList(); // reattach if Vue replaced the container

        saveSettings(); // persist filter settings
        syncToVue(value);

        // Wait a tick so Vue's DOM update lands before applyFilter runs.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => applyFilter(value, true));
        });
    }

    // Poll the native input; re-run the filter when the user types there.
    function pollNative() {
        // Self-heal: reattach the observer if Vue replaced the queue container.
        watchVideoList();

        if (!NF.input) return;
        const v = NF.input.value;
        if (v !== NF.lastNativeValue) {
            NF.lastNativeValue = v;
            // The native filter handles text; apply button filters on top of its result.
            if (hasAnyActiveFilter()) {
                requestAnimationFrame(() => applyFilter(NF.lastOwnValue, true));
            }
        }
    }

    // Re-apply our filter layer after Vue adds or hides rows.
    let listObserver = null;
    let watchedListContainer = null;

    function watchVideoList() {
        const list = document.querySelector('[role="button"]')?.parentElement;
        if (!list) return;

        // Reattach if Vue replaced the container (the old observer would watch a detached node).
        if (listObserver && watchedListContainer === list && document.contains(list)) return;
        if (listObserver) listObserver.disconnect();
        watchedListContainer = list;

        let listObserverRafPending = false;
        listObserver = new MutationObserver(() => {
            // rAF debounce: coalesces mutation bursts and avoids feedback loops.
            if (listObserverRafPending) return;
            listObserverRafPending = true;
            requestAnimationFrame(() => {
                listObserverRafPending = false;
                if (!hasAnyActiveFilter()) return;
                // force: new rows have no display state yet and the cache guard would skip them.
                applyFilter(NF.lastOwnValue, true);
            });
        });

        // subtree: placeholder rows are hydrated in place, which is a nested mutation.
        listObserver.observe(list, { childList: true, subtree: true });
    }

    // ---------------------------------------------------------------------
    // Auto-skip
    // ---------------------------------------------------------------------
    // Acts only when a filtered-out video is actually playing.

    let activeRowObserver = null;
    let skipChainCount = 0;
    const SKIP_CHAIN_MAX = 30;
    const SKIP_CHAIN_WINDOW_MS = 5000;
    let lastSkipResetTime = 0;

    function rowShouldBeHidden(row) {
        if (!hasAnyActiveFilter()) return false;
        const tokens = parseTokens(NF.lastOwnValue);
        return !rowPassesFilter(row, tokens);
    }

    // First visible row after the current active row.
    function findNextVisibleRow() {
        const rows = Array.from(document.querySelectorAll('[role="button"]'));
        const activeIdx = rows.findIndex(r => r.classList.contains('border-orange-500'));
        for (let i = activeIdx + 1; i < rows.length; i++) {
            if (!rowShouldBeHidden(rows[i])) return rows[i];
        }
        return null;
    }

    // Intercept the N key and click the first visible row so Vue never activates a filtered video.
    let nInterceptActive = false;
    function attachNIntercept() {
        if (nInterceptActive) return;
        nInterceptActive = true;
        document.addEventListener('keydown', e => {
            if (e.key !== 'n' && e.key !== 'N') return;
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

            if (sortedRowIds) {
                // With a sort active, Vue's DOM-order "next" is wrong: always click the correct row.
                const nextRow = getSortAwareNextRow();
                if (!nextRow) return; // end of sort order: native N
                e.stopImmediatePropagation();
                e.preventDefault();
                nextRow.click();
                return;
            }

            // No sort: intercept only when a filter is active and Vue's next row would be filtered.
            if (!hasAnyActiveFilter()) return;

            const nextRow = findNextVisibleRow();
            if (!nextRow) return; // no visible next: native N

            // Would Vue's own next row be filtered?
            const rows = Array.from(document.querySelectorAll('[role="button"]'));
            const activeIdx = rows.findIndex(r => r.classList.contains('border-orange-500'));
            const vueNext = rows[activeIdx + 1];

            if (!vueNext || !rowShouldBeHidden(vueNext)) return; // fine: don't intercept

            // Block N and click the correct row.
            e.stopImmediatePropagation();
            e.preventDefault();
            nextRow.click();
        }, true); // capture phase: before Vue
    }

    function triggerNextKey() {
        const now = Date.now();
        if (now - lastSkipResetTime > SKIP_CHAIN_WINDOW_MS) {
            skipChainCount = 0;
            lastSkipResetTime = now;
        }
        skipChainCount++;
        if (skipChainCount > SKIP_CHAIN_MAX) {
            console.warn('[PMVHaven Extended] Auto-skip stopped: too many consecutive skips');
            return;
        }
        // With a sort active, click the next row in sort order instead of dispatching a synthetic N.
        if (sortedRowIds) {
            const next = getSortAwareNextRow();
            if (next) { next.click(); return; }
            // No sort-aware next: fall back to native N.
        }
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'n', code: 'KeyN', keyCode: 78, which: 78, bubbles: true
        }));
    }

    function watchActiveRow() {
        if (activeRowObserver) return;

        const container = document.querySelector('[role="button"]')?.parentElement;
        if (!container) return;

        let lastActiveRow = container.querySelector('.border-orange-500');

        activeRowObserver = new MutationObserver(() => {
            const active = container.querySelector('.border-orange-500');
            if (!active || active === lastActiveRow) return;
            lastActiveRow = active;

            if (!hasAnyActiveFilter()) return;
            if (!rowShouldBeHidden(active)) {
                // Active row is visible: update the override.
                const tokens = parseTokens(NF.lastOwnValue);
                requestAnimationFrame(() => overrideUpNext(tokens));
                return;
            }

            // A filtered video became active: skip it.
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
        // Watches the body (including characterData). The Up Next box is cached; it is re-searched at most twice a second.
        let upNextBtn = null;
        let upNextLookAt = 0;
        let upNextRaf = false;
        const check = () => {
            const newTitle = getUpNextTitle(upNextBtn);
            if (newTitle === lastUpNextTitle) return;
            lastUpNextTitle = newTitle;
            const tokens = parseTokens(NF.lastOwnValue);
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

    // ---------------------------------------------------------------------
    // Deeplink catch-up
    // ---------------------------------------------------------------------
    // Scrolls the queue so Vue's own page-based lazy-load reaches ?index=; bounded retries, no own fetch.
    // Thumbnails of rows far behind the frontier are unloaded (img.src emptied); row nodes stay for Vue's v-for.
    const CATCHUP_UNLOAD_BUFFER = 100;  // keep the last 100 rows intact
    let catchUpRunning = false;

    // ---------------------------------------------------------------------
    // Shared fetch-all cycle
    // ---------------------------------------------------------------------
    // Used by deeplink catch-up, the Fetch-all button and the auto-trigger.
    // Sets the fetchAll flag, scrolls to the absolute bottom (relative scrollBy is unreliable) and polls until
    // untilPredicate holds or the row count stops growing for 3 checks. Updates no UI.
    async function runFetchAllCycle({ untilPredicate = null, maxWaitMs = 20000, pollMs = 400 } = {}) {
        const scrollEl = document.querySelector('[role="button"]')?.closest('.overflow-y-auto');
        if (!scrollEl) return { ok: false, reason: 'no-scroll-container', rowCount: 0, waitedMs: 0 };

        PMVX.forceFetchAllNext = true;
        const kickScroll = () => {
            scrollEl.scrollTop = scrollEl.scrollHeight;
            scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));
        };
        kickScroll();

        let waited = 0;
        let rowCount = document.querySelectorAll('[role="button"]').length;
        let stableTicks = 0;
        let ticksSinceKick = 0;
        let hitPredicate = false;
        while (waited < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollMs));
            waited += pollMs;
            const newCount = document.querySelectorAll('[role="button"]').length;
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
            // Kick on growth or after one stalled tick: the core honors the fetchAll flag only on a page=1 request,
            // and re-kicking while a page fetch is in flight re-dispatches scroll and duplicates rows.
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

    // Number of DOM rows that have a videoMeta entry (tags/stars) in the shared cache.
    function getMetaCoverage() {
        const rows = document.querySelectorAll('[role="button"]');
        const videoMeta = PMVX.state?.videoMeta;
        let withMeta = 0, unknownId = 0;
        rows.forEach(row => {
            const vid = getRowVideoId(row);
            if (!vid) { unknownId++; return; }
            if (videoMeta?.has(vid)) withMeta++;
        });
        return { total: rows.length, withMeta, unknownId };
    }

    // Auto fetch-all when a filter needs videoMeta and the data is incomplete.
    // Single-flight, and once per filter value (pollNative runs every 300ms).
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

        const startRowCount = document.querySelectorAll('[role="button"]').length;

        // Force fetchAll=true on Vue's next page fetch (honored by the core): one large fetch instead of many scroll rounds.
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
            const rowsNow = document.querySelectorAll('[role="button"]');
            const activeRow = rowsNow[urlIndex] || document.querySelector('.border-orange-500');
            activeRow?.scrollIntoView({ block: 'center', behavior: 'instant' });
        }

        catchUpRunning = false;
    }

    // Hide and unload (img.src='') rows more than CATCHUP_UNLOAD_BUFFER ahead of the target; row nodes stay for Vue's v-for.
    function hideAndUnloadOutsideWindow(targetIdx) {
        const rows = Array.from(document.querySelectorAll('[role="button"]'));
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

        // Deeplink: ?index=N needs a DOM row at position N, but an SSR load embeds only a first batch
        // and does no client fetch the core could enlarge.
        try {
            const urlIndex = parseInt(new URLSearchParams(location.search).get('index') || '', 10);
            const rowCount = document.querySelectorAll('[role="button"]').length;
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

    // SPA navigation watcher; waits for document.body if it does not exist yet.
    function startObserver() {
        if (!document.body) {
            // document-start: no body yet, wait for DOMContentLoaded.
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
    }

    // Init, retrying so a slow Vue mount is still caught.
    function boot() {
        loadPlaylistCache();
        attachNativeInput();
        checkForStuckHugePlaylist();

        // Retry every 500ms until the wrap is inserted (max 10s)
        let tries = 0;
        const retryTimer = setInterval(() => {
            if (document.querySelector('#pmvnf-wrap') || ++tries > 20) {
                clearInterval(retryTimer);
                return;
            }
            attachNativeInput();
        }, 500);
    }

    // Detect a playlist that never finishes loading (the site's own frontend can stall on very large playlists)
    // and explain it instead of leaving a silent spinner.
    function checkForStuckHugePlaylist() {
        if (!location.pathname.startsWith('/playlists/')) return;
        setTimeout(() => {
            if (document.querySelector('[role="button"]')) return; // loaded fine
            if (!document.body.innerText.includes('Loading playlist')) return;
            if (document.getElementById('pmvnf-stuck-notice')) return;
            const box = document.createElement('div');
            box.id = 'pmvnf-stuck-notice';
            box.style.cssText = `
                position: fixed; top: 70px; right: 12px; z-index: 999999;
                background: rgba(20,20,20,0.97); border: 1px solid rgba(250,204,21,0.4);
                border-radius: 8px; padding: 10px 14px; max-width: 300px;
                color: rgba(255,255,255,0.85); font-size: 12px;
                font-family: ui-monospace, monospace; line-height: 1.6;
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

    // ---------------------------------------------------------------------
    // Boot
    // ---------------------------------------------------------------------
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
        // Background tab: wait until it becomes active.
        document.addEventListener('visibilitychange', function onVis() {
            if (document.visibilityState !== 'visible') return;
            document.removeEventListener('visibilitychange', onVis);
            safeBoot();
        });
    }

    // SPA navigation: the core dispatches this when the URL changes to /playlists/<id>.
    window.addEventListener('pmv:playlist-navigate', () => {
        bootRan = false; // allow safeBoot to run again
        setTimeout(safeBoot, 100);
    });

    // ---------------------------------------------------------------------
    // /playlists browse filter
    // ---------------------------------------------------------------------
    // Filters playlist cards by the tags of the videos they contain. The list endpoint carries only video IDs,
    // so each visible card costs one /api/playlists/<id>?fetchAll=true call. Results are cached in localStorage
    // per playlist id, keyed on video count; the refresh button forces a refetch.
    //
    // Syntax:
    //   -hypno          hide playlists containing >=1 video tagged hypno
    //   -"two words"    quoted multi-word term
    //   +anal / anal    keep only playlists containing >=1 video tagged anal
    //   -trans(0.1)     hide when more than 10% of the videos are tagged trans
    //   +anal(50%)      keep only when at least 50% of the videos are tagged anal
    // With the description toggle on (default) a term also matches the playlist description.
    // Terms match case-insensitively as substrings of a video's tags and starsTags (performers).
    // Playlists whose detail has not loaded yet stay visible (fail-open) and are re-evaluated on arrival.
    (function playlistBrowseFilter() {
        const KEY_SETTINGS = 'pmvnf_browse_filter_v1';
        const KEY_CACHE    = 'pmvnf_browse_tagcache_v2'; // v2: per-video tag indices
        const CACHE_MAX    = 1500;            // playlists kept in localStorage
        const CONCURRENCY  = 3;
        const BAR_ID       = 'pmvpb-bar';
        const BTN_ID       = 'pmvpb-btn';
        const STYLE_ID     = 'pmvpb-style';

        const PB = {
            raw: '',            // legacy typed text
            terms: { neg: [], pos: [] }, // chips
            overlap: [],        // own playlist ids for overlap
            mineRange: { min: null, max: null }, // fractions; typed !mine overrides
            open: false,        // panel expanded
            toggle: null,
            mode: 'hide',       // 'hide' | 'sink'
            enabled: true,      // off: nothing hidden or sunk
            desc: true,         // also match the description
            tokens: { neg: [], pos: [] },
            listInfo: new Map(),  // id → { count, name }
            tags: new Map(),      // id → { count, at, tags }
            pending: new Map(),   // id → Promise
            failed: new Set(),
            queue: [],
            running: 0,
            bar: null,
            input: null,
            counter: null,
            observer: null,
            routeTimer: null,
            active: false,
            sessionStart: Date.now(), // older cache entries predate this session
        };

        const isBrowsePage = () => location.pathname.replace(/\/+$/, '') === '/playlists';

        // ---------------------------------------------------------------------
        // Persistence
        // ---------------------------------------------------------------------
        function loadSettings() {
            try {
                const s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || 'null');
                if (s && typeof s.raw === 'string') PB.raw = s.raw;
                if (s && (s.mode === 'hide' || s.mode === 'sink')) PB.mode = s.mode;
            if (s && Array.isArray(s.overlap)) PB.overlap = s.overlap.filter(x => typeof x === 'string');
            if (s && s.mineRange && typeof s.mineRange === 'object') PB.mineRange = { min: parseBound(s.mineRange.min), max: parseBound(s.mineRange.max) };
            if (s && typeof s.open === 'boolean') PB.open = s.open;
            if (s && typeof s.enabled === 'boolean') PB.enabled = s.enabled;
            } catch {}
            PB.desc = matchDescEnabled();
            try {
                const s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || 'null');
                if (s && s.terms && Array.isArray(s.terms.neg) && Array.isArray(s.terms.pos)) {
                    PB.terms = {
                        neg: s.terms.neg.filter(t => t && typeof t.term === 'string').map(t => ({ term: t.term.toLowerCase(), max: parseBound(t.max) ?? 0 })),
                        pos: s.terms.pos.filter(t => t && typeof t.term === 'string').map(t => ({ term: t.term.toLowerCase(), min: parseBound(t.min) })),
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
            try { localStorage.setItem(KEY_SETTINGS, JSON.stringify({ terms: PB.terms, mode: PB.mode, overlap: PB.overlap, mineRange: PB.mineRange, open: PB.open, enabled: PB.enabled })); } catch {}
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

        // ---------------------------------------------------------------------
        // Parsing
        // ---------------------------------------------------------------------
        // Token: [+-]term or [+-]"two words", with an optional threshold: -trans(0.1) hides when more than 10% of
        // the videos match; +anal(0.5) requires at least 50%. Without one: any/none. Entries: neg {term,max}, pos {term,min}.
        // !mine(a-b): keep playlists whose share of videos in the ticked own playlists lies in [a, b]; either bound
        // is optional, values > 1 are percentages, unknown overlap fails open.
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
        // Off counts as no filter: all cards shown, no tag fetches. Overlap badges stay.
        const hasTagFilter = () => PB.enabled && (PB.tokens.neg.length > 0 || PB.tokens.pos.length > 0);
        const activeMineRange = () => PB.tokens.mine || ((PB.mineRange.min != null || PB.mineRange.max != null) ? PB.mineRange : null);
        const hasFilter = () => PB.enabled && (hasTagFilter() || !!activeMineRange());

        // ---------------------------------------------------------------------
        // Fetch interceptor
        // ---------------------------------------------------------------------
        // Records video counts from list pages. Wrapped once; chains with other fetch wrappers.
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

        // ---------------------------------------------------------------------
        // Per-playlist tag loading
        // ---------------------------------------------------------------------
        function cardId(card) {
            const href = card.getAttribute('href') || '';
            const m = href.match(/\/playlists\/([a-f0-9]{24})/);
            return m ? m[1] : null;
        }
        function cardCount(card) {
            // The badge in the card's top-left corner is the video count.
            const info = PB.listInfo.get(cardId(card));
            if (info && Number.isFinite(info.count)) return info.count;
            const t = (card.innerText || '').trim().split('\n')[0];
            const n = parseInt(t, 10);
            return Number.isFinite(n) ? n : null;
        }
        // A cached playlist is reused until its video count changes or refresh is pressed.
        function isFresh(entry, count) {
            if (!entry) return false;
            if (count != null && entry.count != null && entry.count !== count) return false;
            return true;
        }
        // Clicking a card's cached marker (an ::after pseudo-element, so nothing is injected into Vue's card)
        // refetches that playlist; detected by position. Capture phase keeps the router from navigating.
        const MARKER_HIT = 30; // px square, top-right
        function refreshOne(id) {
            if (!id) return;
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
        // Refresh: drop the cache for cards on the page and refetch.
        function refreshVisible() {
            const cards = [...document.querySelectorAll('.playlists-grid > a[href*="/playlists/"]')];
            let n = 0;
            cards.forEach(card => {
                const id = cardId(card);
                if (!id) return;
                if (PB.tags.delete(id)) n++;
                PB.failed.delete(id);
            });
            fracMemo.clear();
            saveCacheSoon();
            applyFilter();
        }
        function ensureLoaded(id, count) {
            if (!id || PB.pending.has(id) || PB.failed.has(id)) return;
            if (isFresh(PB.tags.get(id), count)) return;
            // One in-flight promise per id; the queue drains at CONCURRENCY.
            let resolve;
            const p = new Promise(r => { resolve = r; });
            PB.pending.set(id, p);
            PB.queue.push({ id, count, resolve });
            pump();
        }
        function pump() {
            while (PB.running < CONCURRENCY && PB.queue.length) {
                const job = PB.queue.shift();
                PB.running++;
                fetchTags(job.id).then(({ tags, vids, desc }) => {
                    PB.tags.set(job.id, { count: job.count, at: Date.now(), tags, vids, desc });
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
        // Quiet: these requests are skipped by the core's indexes (PMVX.quietUrls); the body is parsed once (pmvResJson).
        async function fetchTags(id) {
            const url = `/api/playlists/${id}?fetchAll=true`;
            quietUrls.add(url);
            let res;
            try { res = await fetch(url, { credentials: 'include' }); }
            finally { quietUrls.delete(url); }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await pmvResJson(res);
            const root = j?.data || j;
            const details = root?.videoDetails || [];
            const desc = String(root?.description || '');
            // tags: playlist-local vocabulary; vids: per-video indices into it.
            const vocab = new Map();
            const vids = [];
            details.forEach(v => {
                const own = new Set();
                (v?.tags || v?.top5Tags || []).forEach(t => { if (t) own.add(String(t).toLowerCase()); });
                (v?.starsTags || v?.stars || []).forEach(s => {
                    const n = typeof s === 'string' ? s : s?.name;
                    if (n) own.add(String(n).toLowerCase());
                });
                const idx = [];
                own.forEach(t => {
                    if (!vocab.has(t)) vocab.set(t, vocab.size);
                    idx.push(vocab.get(t));
                });
                vids.push(idx);
            });
            return { tags: [...vocab.keys()], vids, desc };
        }

        // ---------------------------------------------------------------------
        // Evaluation
        // ---------------------------------------------------------------------
        // Returns { state: 'pass'|'fail'|'pending', hits }. The description comes from the list response,
        // so it can decide a card before its tags load.
        function descOf(id) {
            if (!PB.desc) return '';
            const d = PB.listInfo.get(id)?.desc ?? PB.tags.get(id)?.desc ?? '';
            return String(d).toLowerCase();
        }
        // Overlap with the ticked own playlists (cached video id sets x list-response ids); null when unknown.
        function overlapOf(id) {
            if (!PB.overlap.length) return null;
            const info = PB.listInfo.get(id);
            if (!info || !info.videos) return null;
            const { playlists } = getLivePlaylists();
            const sel = PB.overlap.map(pid => playlists.get(pid)).filter(Boolean);
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

        // Fraction of videos with a tag/performer containing `term`; memoised per (playlist, fetch time, term).
        const fracMemo = new Map();
        function fraction(id, entry, term) {
            const key = id + '|' + (entry.at || 0) + '|' + term;
            const hit = fracMemo.get(key);
            if (hit) return hit;
            const matchIdx = new Set();
            entry.tags.forEach((t, i) => { if (t.includes(term)) matchIdx.add(i); });
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
        function evaluate(id, count) {
            const entry = PB.tags.get(id);
            // Stale data is used while the refetch runs.
            const desc = descOf(id);
            const pending = hasTagFilter() && !entry && !PB.failed.has(id);
            const hits = [];
            // !mine range: independent of tag data, so decided first.
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
            for (const { term, max } of PB.tokens.neg) {
                // A description hit applies to the whole playlist: no threshold.
                if (desc && desc.includes(term)) { hits.push('description: ' + term); continue; }
                if (!entry) continue;
                const f = fraction(id, entry, term);
                if (f.n > 0 && f.frac > max) {
                    hits.push(max > 0 ? `${term} ${pct(f.frac)} (${f.n}/${f.total}, max ${pct(max)})` : `${term} (${f.n}/${f.total})`);
                }
            }
            if (hits.length) return { state: 'fail', hits };
            if (pending) return { state: 'pending', hits: [] };
            for (const { term, min } of PB.tokens.pos) {
                if (desc && desc.includes(term)) continue;
                const f = entry ? fraction(id, entry, term) : { n: 0, total: 0, frac: 0 };
                const ok = min == null ? f.n > 0 : (f.n > 0 && f.frac >= min);
                if (!ok) return { state: 'fail', hits: [min == null ? 'no ' + term : `${term} ${pct(f.frac)} (${f.n}/${f.total}, min ${pct(min)})`] };
            }
            return { state: 'pass', hits: [] };
        }

        let applyTimer = null;
        function scheduleApply() {
            clearTimeout(applyTimer);
            applyTimer = setTimeout(applyFilter, 60);
        }
        function applyFilter() {
            if (!PB.active) return;
            try { renderMineChips(); } catch {}
            const cards = [...document.querySelectorAll('.playlists-grid > a[href*="/playlists/"]')];
            let hidden = 0, pending = 0, fromCache = 0;
            cards.forEach(card => {
                const id = cardId(card);
                if (!id) return;
                const count = cardCount(card);
                // Marker: tags are cached.
                if (isFresh(PB.tags.get(id), count)) card.setAttribute('data-pmvpb-cached', '1');
                else card.removeAttribute('data-pmvpb-cached');
                // Overlap badge (top-left) when own playlists are ticked.
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
                    const parts = [hitTxt, ovTitle].filter(Boolean);
                    if (parts.length) { card.title = parts.join('\n'); card.dataset.pmvpbTitled = '1'; }
                    else if (card.dataset.pmvpbTitled) { card.removeAttribute('title'); delete card.dataset.pmvpbTitled; }
                };
                if (hasTagFilter()) {
                    const cached = PB.tags.get(id);
                    if (cached && cached.at < PB.sessionStart && isFresh(cached, count)) fromCache++;
                    ensureLoaded(id, count);
                }
                if (!hasFilter()) {
                    delete card.dataset.pmvpbHide;
                    delete card.dataset.pmvpbSink;
                    card.removeAttribute('data-pmvpb-pending');
                    setTitle('');
                    return;
                }
                const r = evaluate(id, count);
                if (r.state === 'pending') {
                    pending++;
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
            updateCounter(cards.length, hidden, pending, fromCache);
            // Hiding shortens the page: nudge infinite scroll for the next page, but only while fewer than 24 cards are visible.
            if (hasFilter() && hidden && (cards.length - hidden) < 24) {
                try { window.dispatchEvent(new Event('scroll')); } catch {}
            }
        }
        // Summary pills next to the Filters button; the full list is in its tooltip.
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
            PB.lastTotal = total; PB.lastHidden = hidden;
            // Result next to "N playlists total" via a data-* attribute + ::after, which survives Vue re-renders.
            const rc = document.querySelector('.playlists-dashboard .results-count');
            if (rc) {
                const any = PB.terms.neg.length || PB.terms.pos.length || r.min != null || r.max != null;
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
            if (btn) btn.title = lines.length ? lines.join('\n') : 'Filter playlists by the tags of their videos';
        }
        function updateCounter(total, hidden, pending, fromCache) {
            updateSummary(total, hidden);
            if (!PB.counter) return;
            if (!hasFilter()) { PB.counter.textContent = ''; return; }
            const parts = [];
            parts.push(`${hidden} of ${total} ${PB.mode === 'hide' ? 'hidden' : 'moved down'}`);
            if (pending) parts.push(`${pending} loading…`);
            if (fromCache) parts.push(`${fromCache} cached`);
            if (PB.failed.size) parts.push(`${PB.failed.size} failed`);
            PB.counter.textContent = parts.join(' · ');
        }

        // ---------------------------------------------------------------------
        // Styles
        // ---------------------------------------------------------------------
        // Mirrors the site's "More Filters" panel, in the purple of the /playlists page.
        function injectStyles() {
            if (document.getElementById(STYLE_ID)) return;
            const st = document.createElement('style');
            st.id = STYLE_ID;
            st.textContent = `
                .playlists-grid > a[data-pmvpb-hide="1"] { display: none !important; }
                .playlists-grid > a[data-pmvpb-sink="1"] { order: 9999; opacity: 0.35; filter: grayscale(0.6); }
                .playlists-grid > a[data-pmvpb-pending="1"] { outline: 1px dashed rgba(255,255,255,0.10); outline-offset: -1px; }
                .playlists-grid > a[data-pmvpb-cached="1"], .playlists-grid > a[data-pmvpb-overlap] { position: relative; }
                .playlists-grid > a[data-pmvpb-cached="1"]::after {
                    content: '\\2713'; position: absolute; top: 6px; right: 6px; z-index: 20;
                    width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 50%;
                    background: rgba(0,0,0,0.65); color: rgb(192,132,252); font-size: 11px; font-weight: 700;
                    font-family: ui-monospace, monospace; cursor: pointer;
                    box-shadow: 0 0 0 1px rgba(168,85,247,0.5); }
                .playlists-grid > a[data-pmvpb-overlap]::before {
                    content: attr(data-pmvpb-overlap); position: absolute; top: 6px; left: 6px; z-index: 20;
                    padding: 1px 7px; border-radius: 9999px; line-height: 16px;
                    background: rgba(0,0,0,0.7); color: rgb(168,85,247); font-size: 11px; font-weight: 600;
                    font-family: ui-monospace, monospace; pointer-events: none;
                    box-shadow: 0 0 0 1px rgba(168,85,247,0.5); }
                .playlists-grid > a[data-pmvpb-overlap-zero="1"]::before { color: rgba(255,255,255,0.45); box-shadow: 0 0 0 1px rgba(255,255,255,0.18); font-weight: 400; }

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
                    color: #fff; font-size: 13px; font-family: ui-monospace, monospace; outline: none; caret-color: rgb(168,85,247); }
                #${BAR_ID} input[type=text]:focus, #${BAR_ID} input[type=text]:focus-visible { border-color: rgba(168,85,247,0.6); outline: none !important; box-shadow: none !important; }
                #${BAR_ID} input[type=text]::placeholder { color: rgb(107,114,128); }
                #${BAR_ID} .pmvpb-hint { color: rgba(255,255,255,0.35); font-size: 11px; margin-top: 6px; line-height: 1.5; font-family: ui-monospace, monospace; }
                #${BAR_ID} .pmvpb-hint b { color: rgba(255,255,255,0.6); font-weight: 600; }
                #${BAR_ID} .pmvpb-tagrow { margin-bottom: 10px; }
                #${BAR_ID} .pmvpb-tagrow input[type=text] { padding: 7px 12px; font-family: inherit; font-size: 13px; }
                #${BAR_ID} .pmvpb-tagchips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; min-height: 0; }
                #${BAR_ID} .pmvpb-tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; border: none; cursor: pointer;
                    font-size: 12px; line-height: 16px; font-family: inherit; transition: background .15s; }
                #${BAR_ID} .pmvpb-tag svg { width: 10px; height: 10px; }
                #${BAR_ID} .pmvpb-tag .ico svg { width: 11px; height: 11px; }
                #${BAR_ID} .pmvpb-tag .x { display: inline-flex; opacity: 0.6; margin-left: 2px; padding: 2px; border-radius: 3px; }
                #${BAR_ID} .pmvpb-tag .x:hover { opacity: 1; background: rgba(255,255,255,0.12); }
                #${BAR_ID} .pmvpb-tag .thr { font-size: 10px; font-weight: 700; padding: 0 4px; border-radius: 3px; background: rgba(0,0,0,0.35); font-family: ui-monospace, monospace; }
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
                #${BAR_ID} .pmvpb-edit-head .val { color: rgb(168,85,247); font-weight: 700; font-family: ui-monospace, monospace; }
                #${BAR_ID} .pmvpb-edit input[type=range] { width: 100%; accent-color: rgb(168,85,247); margin: 4px 0; }
                #${BAR_ID} .pmvpb-edit .pmvpb-chips { margin-top: 4px; }
                #${BAR_ID} .pmvpb-edit .pmvpb-hint { margin-top: 6px; }
                #${BAR_ID} .pmvpb-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
                #${BAR_ID} .pmvpb-chip { padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; line-height: 1.2;
                    background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.1); transition: background .15s, color .15s; white-space: nowrap; }
                #${BAR_ID} .pmvpb-chip:hover { background: rgba(255,255,255,0.09); color: #fff; }
                #${BAR_ID} .pmvpb-chip.active { background: rgba(168,85,247,0.2); color: rgb(168,85,247); border-color: rgba(168,85,247,0.5); font-weight: 600; }
                #${BAR_ID} .pmvpb-chip .n { opacity: 0.5; margin-left: 6px; font-weight: 400; font-family: ui-monospace, monospace; }
                #${BAR_ID} .pmvpb-primary { padding: 0 16px; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
                    background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)); color: #fff; border: none; }
                #${BAR_ID} .pmvpb-primary:hover { filter: brightness(1.12); }
                #${BAR_ID} .pmvpb-counter { color: rgba(255,255,255,0.4); font-size: 12px; margin-top: 10px; min-height: 16px; font-family: ui-monospace, monospace; }
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

        // ---------------------------------------------------------------------
        // Panel
        // ---------------------------------------------------------------------
        const ICONS = {
            filter: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H3m9 14H3M14 3v4m2 10v4m5-9h-9m9 7h-5m5-14h-7m-6 5v4m0-2H3"/></svg>',
            list:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13"/></svg>',
            range:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 6H3m18 6H3m18 6H3M9 3v6m6 3v6"/></svg>',
        };
        const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
        const chip = (text, title, onClick) => { const b = el('button', 'pmvpb-chip', text); b.type = 'button'; if (title) b.title = title; b.onclick = onClick; return b; };
        let renderMineChips = () => {};
        let renderRange = () => {};

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

            // Tag chips (include / exclude)
            const s1 = el('section');
            const h1 = el('h3'); h1.innerHTML = ICONS.filter + ' Playlist contents';
            s1.appendChild(h1);

            // Suggestions: tags seen in cached playlists, most common first.
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
                    const term = inp.value.trim().replace(/^#/, '').toLowerCase();
                    if (!term) return;
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
                        c.title = kind === 'neg'
                            ? `Hides playlists where ${t.max > 0 ? 'more than ' + pct(t.max) : 'at least one'} of the videos have "${t.term}" — click to set the allowed share`
                            : `Requires ${t.min != null ? 'at least ' + pct(t.min) : 'at least one'} of the videos to have "${t.term}" — click to set the required share`;
                        if (kind === 'neg') {
                            const ic = el('span', 'ico');
                            ic.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
                            c.appendChild(ic);
                        }
                        c.appendChild(el('span', 'txt', '#' + t.term));
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
            };
            // Inline share editor for the selected chip: one slider.
            const renderEditor = () => {
                editorHost.textContent = '';
                if (!editing) return;
                const t = PB.terms[editing.kind].find(o => o.term === editing.term);
                if (!t) { editing = null; return; }
                const neg = editing.kind === 'neg';
                const cur = neg ? Math.round((t.max || 0) * 100) : Math.round((t.min ?? 0) * 100);
                const box = el('div', 'pmvpb-edit ' + editing.kind);
                const head = el('div', 'pmvpb-edit-head');
                head.innerHTML = `<b>#${t.term}</b> — ${neg ? 'hide if more than' : 'require at least'} <span class="val">${cur}%</span> of the videos to have this tag`;
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
            const refreshChip = chip('⟳ Refresh', 'Fetch the tags of all playlists on this page again. Click ✓ on a card to refresh only that playlist. Otherwise the cache is kept until a playlist\u2019s video count changes.', refreshVisible);
            const renderModeChips = () => {
                hideChip.classList.toggle('active', PB.mode === 'hide');
                sinkChip.classList.toggle('active', PB.mode === 'sink');
                descChip.classList.toggle('active', !!PB.desc);
                descChip.title = PB.desc
                    ? 'Terms also match the playlist description — click to match video tags only'
                    : 'Video tags and performers only — click to also match the playlist description';
            };
            renderModeChips();
            chips1.append(hideChip, sinkChip, descChip, refreshChip);
            s1.appendChild(chips1);
            const counter = el('div', 'pmvpb-counter');
            s1.appendChild(counter);
            renderChips();
            const inp = rowPos.inp;

            // Own playlists (overlap badge)
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

            // Overlap range (dual slider)
            const s3 = el('section');
            const h3 = el('h3'); h3.innerHTML = ICONS.range + ' Overlap range';
            s3.appendChild(h3);
            s3.appendChild(el('label', 'pmvpb-label', 'Share of videos that are also in the selected playlists'));
            const pillRow = el('div', 'pmvpb-pillrow');
            const pill = el('div', 'pmvpb-pill');
            const pMin = el('span', null, '0%'); const pSep = el('span', 'sep', '-'); const pMax = el('span', null, 'Any');
            pill.append(pMin, pSep, pMax); pillRow.appendChild(pill);
            const slider = el('div', 'pmvpb-slider');
            const track = el('div', 'pmvpb-track'); const fill = el('div', 'pmvpb-range');
            const rMin = el('input'); rMin.type = 'range'; rMin.min = '0'; rMin.max = '100'; rMin.step = '1';
            const rMax = el('input'); rMax.type = 'range'; rMax.min = '0'; rMax.max = '100'; rMax.step = '1';
            slider.append(track, fill, rMin, rMax);
            const labels = el('div', 'pmvpb-sliderlabels'); labels.append(el('span', null, '0%'), el('span', null, '100%'));
            const presets = el('div', 'pmvpb-chips');
            const PRESETS = [
                { t: 'Any', min: null, max: null, title: 'No range filter' },
                { t: '0%', min: null, max: 0, title: 'Only playlists with no overlap at all' },
                { t: '<10%', min: null, max: 0.1, title: 'At most 10% overlap' },
                { t: '50%+', min: 0.5, max: null, title: 'At least half overlaps' },
                { t: '90%+', min: 0.9, max: null, title: 'Almost everything overlaps' },
            ];
            const presetBtns = PRESETS.map(p => {
                const c = chip(p.t, p.title, () => { PB.mineRange = { min: p.min, max: p.max }; saveSettings(); renderRange(); applyFilter(); });
                presets.appendChild(c); return c;
            });
            const paint = (a, b) => {
                pMin.textContent = a + '%'; pMax.textContent = b >= 100 ? 'Any' : b + '%';
                fill.style.left = a + '%'; fill.style.width = (b - a) + '%';
            };
            renderRange = () => {
                const a = PB.mineRange.min != null ? Math.round(PB.mineRange.min * 100) : 0;
                const b = PB.mineRange.max != null ? Math.round(PB.mineRange.max * 100) : 100;
                rMin.value = String(a); rMax.value = String(b);
                paint(a, b);
                presetBtns.forEach((c, i) => {
                    const p = PRESETS[i];
                    c.classList.toggle('active', (p.min ?? null) === (PB.mineRange.min ?? null) && (p.max ?? null) === (PB.mineRange.max ?? null));
                });
            };
            const onDrag = (which) => () => {
                let a = parseInt(rMin.value, 10), b = parseInt(rMax.value, 10);
                if (a > b) { if (which === 'min') { b = a; rMax.value = String(b); } else { a = b; rMin.value = String(a); } }
                paint(a, b);
            };
            const onRelease = () => {
                const a = parseInt(rMin.value, 10), b = parseInt(rMax.value, 10);
                PB.mineRange = { min: a > 0 ? a / 100 : null, max: b < 100 ? b / 100 : null };
                saveSettings(); renderRange(); applyFilter();
            };
            rMin.addEventListener('input', onDrag('min')); rMax.addEventListener('input', onDrag('max'));
            rMin.addEventListener('change', onRelease); rMax.addEventListener('change', onRelease);
            renderRange();
            s3.append(pillRow, slider, labels, presets);

            grid.append(s1, s2, s3);
            header.insertAdjacentElement('afterend', bar);
            PB.bar = bar; PB.input = inp; PB.counter = counter;
            placeCaret();
            return true;
        }

        // The Filters control sits in the site's tab row (right-aligned, tab-styled) as a trailing child after Vue's
        // v-for fragment. Clicking it toggles the panel; the switch toggles filtering. The page observer re-inserts it if dropped.
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
        // Notch under the button so the panel reads as unfolding from it.
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
        // Chips changed: re-derive tokens, persist, re-render, re-filter.
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

        // ---------------------------------------------------------------------
        // Lifecycle
        // ---------------------------------------------------------------------
        function start() {
            if (PB.active) return;
            PB.active = true;
            injectStyles();
            // Self-heal: re-insert the bar and re-apply when Vue replaces the header or grid.
            PB.observer = new MutationObserver(() => {
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
            window.addEventListener('pmv:cache-ready', () => renderMineChips());
        }
        function stop() {
            window.removeEventListener('pmv:cache-ready', scheduleApply);
            if (!PB.active) return;
            PB.active = false;
            ['mousedown', 'mouseup', 'click'].forEach(t => document.removeEventListener(t, onCardClick, true));
            PB.observer?.disconnect();
            PB.observer = null;
            document.getElementById(BAR_ID)?.remove();
            document.getElementById(BTN_ID)?.remove();
            document.querySelectorAll('[data-pmvpb-note]').forEach(n => n.removeAttribute('data-pmvpb-note'));
            PB.bar = PB.input = PB.counter = PB.toggle = null;
        }
        function onRoute() {
            if (isBrowsePage()) start(); else stop();
        }

        loadSettings();
        loadCache();
        const bootPb = () => {
            onRoute();
            window.addEventListener('popstate', onRoute);
            // Vue router's pushState fires no event; poll.
            let last = location.pathname;
            PB.routeTimer = setInterval(() => {
                if (location.pathname !== last) { last = location.pathname; onRoute(); }
            }, 500);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPb, { once: true });
        else bootPb();

    })();


})();
