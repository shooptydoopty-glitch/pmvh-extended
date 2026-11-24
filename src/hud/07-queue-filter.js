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


