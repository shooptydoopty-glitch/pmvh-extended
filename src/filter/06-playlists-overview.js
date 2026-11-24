    // --- /playlists browse filter ---
    // The list endpoint has only video IDs: each card costs one /api/playlists/<id> request, cached per id by video count.
    // Terms match tags/starsTags (and description, if on) case-insensitively; unloaded cards stay visible (fail-open).
    (function playlistBrowseFilter() {
        const KEY_SETTINGS = 'pmvnf_browse_filter_v1';
        const KEY_CACHE    = 'pmvnf_browse_tagcache_v2'; // per-video tag indices
        const CACHE_MAX    = 1500;
        const CONCURRENCY  = 3;
        const BAR_ID       = 'pmvpb-bar';
        const BTN_ID       = 'pmvpb-btn';
        const STYLE_ID     = 'pmvpb-style';

        const PB = {
            raw: '',
            terms: { neg: [], pos: [] },
            overlap: [],        // own playlist ids for overlap
            mineRange: { min: null, max: null }, // fractions; typed !mine overrides
            open: false,
            toggle: null,
            mode: 'hide',       // 'hide' | 'sink'
            enabled: true,
            autoScan: false,
            scanIds: new Set(),
            fullIds: new Set(), // fetch in full next time (✓ refetch)
            desc: true,
            tokens: { neg: [], pos: [] },
            listInfo: new Map(),  // id → { count, name }
            tags: new Map(),      // id → { count, at, tags }
            pending: new Map(),
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

        // --- Persistence ---
        function loadSettings() {
            try {
                const s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || 'null');
                if (s && typeof s.raw === 'string') PB.raw = s.raw;
                if (s && (s.mode === 'hide' || s.mode === 'sink')) PB.mode = s.mode;
            if (s && Array.isArray(s.overlap)) PB.overlap = s.overlap.filter(x => typeof x === 'string');
            if (s && s.mineRange && typeof s.mineRange === 'object') PB.mineRange = { min: parseBound(s.mineRange.min), max: parseBound(s.mineRange.max) };
            if (s && typeof s.open === 'boolean') PB.open = s.open;
            if (s && typeof s.enabled === 'boolean') PB.enabled = s.enabled;
            if (s && typeof s.autoScan === 'boolean') PB.autoScan = s.autoScan;
            } catch {}
            PB.desc = matchDescEnabled();
            try {
                const s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || 'null');
                if (s && s.terms && Array.isArray(s.terms.neg) && Array.isArray(s.terms.pos)) {
                    PB.terms = {
                        neg: s.terms.neg.filter(t => t && typeof t.term === 'string' && t.term.trim()).map(t => ({ term: t.term.trim().toLowerCase(), max: parseBound(t.max) ?? 0 })),
                        pos: s.terms.pos.filter(t => t && typeof t.term === 'string' && t.term.trim()).map(t => ({ term: t.term.trim().toLowerCase(), min: parseBound(t.min) })),
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
            try { localStorage.setItem(KEY_SETTINGS, JSON.stringify({ terms: PB.terms, mode: PB.mode, overlap: PB.overlap, mineRange: PB.mineRange, open: PB.open, enabled: PB.enabled, autoScan: PB.autoScan })); } catch {}
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

        // --- Parsing ---
        // Token: [+-]term or [+-]"two words", optional threshold: -trans(0.1) hides above 10%, +anal(0.5) needs >= 50%.
        // !mine(a-b): share in the ticked own playlists within [a, b]; bounds optional, > 1 = percent, unknown fails open.
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
        // Off = no filter: all cards shown, no tag fetches; overlap badges stay.
        const hasTagFilter = () => PB.enabled && (PB.tokens.neg.length > 0 || PB.tokens.pos.length > 0);
        const activeMineRange = () => PB.tokens.mine || ((PB.mineRange.min != null || PB.mineRange.max != null) ? PB.mineRange : null);
        const hasFilter = () => PB.enabled && (hasTagFilter() || !!activeMineRange());

        // --- Fetch interceptor ---
        // Records video counts from list pages; wrapped once, chains with other fetch wrappers.
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

        // --- Per-playlist tag loading ---
        function cardId(card) {
            const href = card.getAttribute('href') || '';
            const m = href.match(/\/playlists\/([a-f0-9]{24})/);
            return m ? m[1] : null;
        }
        function cardCount(card) {
            // Fallback: the card's top-left badge is the video count.
            const info = PB.listInfo.get(cardId(card));
            if (info && Number.isFinite(info.count)) return info.count;
            const t = (card.innerText || '').trim().split('\n')[0];
            const n = parseInt(t, 10);
            return Number.isFinite(n) ? n : null;
        }
        // A cached entry stays fresh until the video count moves by more than RESCAN_SHARE, or refresh is pressed.
        const RESCAN_SHARE = 0.10;
        function isFresh(entry, count) {
            if (!entry) return false;
            if (count == null || entry.count == null || entry.count === count) return true;
            const base = Math.max(1, entry.count);
            return Math.abs(count - entry.count) / base <= RESCAN_SHARE;
        }
        // Click on the ::after cached marker refetches (hit-tested by position; capture phase blocks the router).
        const MARKER_HIT = 44; // px square, top-right
        function refreshOne(id) {
            if (!id) return;
            PB.scanIds.add(id);
            PB.fullIds.add(id);
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
        // Scan page button: tags for the cards on the page.
        function scanVisible() {
            document.querySelectorAll('.playlists-grid > a[href*="/playlists/"]').forEach(card => {
                const id = cardId(card);
                if (!id) return;
                PB.scanIds.add(id);
                PB.failed.delete(id);
            });
            applyFilter();
        }
        function ensureLoaded(id, count, force = false) {
            if (!id || PB.pending.has(id) || PB.failed.has(id)) return;
            if (!force && isFresh(PB.tags.get(id), count)) return;
            let resolve;
            const p = new Promise(r => { resolve = r; });
            PB.pending.set(id, p);
            PB.queue.push({ id, count, resolve, full: PB.fullIds.has(id) });
            pump();
        }
        function pump() {
            while (PB.running < Math.min(CONCURRENCY, PMVX.perf().lookups) && PB.queue.length) {
                const job = PB.queue.shift();
                PB.running++;
                fetchTags(job.id, job.count, job.full).then(({ tags, vids, desc, sampled }) => {
                    PB.fullIds.delete(job.id);
                    PB.tags.set(job.id, { count: job.count, at: Date.now(), tags, vids, desc, sampled });
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
        // Quiet: skipped by the core's indexes (PMVX.quietUrls); body parsed once (pmvResJson).
        async function getPlaylistJson(url) {
            quietUrls.add(url);
            let res;
            try { res = await fetch(url, { credentials: 'include' }); }
            finally { quietUrls.delete(url); }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await pmvResJson(res);
            return j?.data || j;
        }
        // Over FULL_UNDER videos, sample SAMPLE_PAGE-video pages: first, last and m = clamp(round(log2(count/100)), 1, 4)
        // evenly spaced between (round(1 + i·(P−1)/(m+1))); tag shares are proportions, so ≤ 6 requests estimate them well.
        // e.g. 400 → 4 pages (200 videos), 1000 → 5 (250), 5000+ → 6 (300). Clicking ✓ fetches in full.
        const FULL_UNDER = 300;
        // Prefix for models in a playlist's tag vocabulary (older entries lack it).
        const STAR = '\u2605';
        const SAMPLE_PAGE = 50;
        function samplePages(count) {
            const P = Math.ceil(count / SAMPLE_PAGE);
            const m = Math.max(1, Math.min(4, Math.round(Math.log2(count / 100))));
            const pages = new Set([1, P]);
            for (let i = 1; i <= m; i++) pages.add(Math.round(1 + i * (P - 1) / (m + 1)));
            return [...pages].sort((a, b) => a - b);
        }
        async function fetchTags(id, count, full) {
            let details = [];
            let desc = '';
            let sampled = null;
            if (full || !Number.isFinite(count) || count <= FULL_UNDER) {
                const root = await getPlaylistJson(`/api/playlists/${id}?fetchAll=true`);
                details = root?.videoDetails || [];
                desc = String(root?.description || '');
            } else {
                // Sequential: other playlists' jobs already run in parallel.
                const seen = new Set();
                let ok = 0, lastErr = null;
                for (const page of samplePages(count)) {
                    const url = `/api/playlists/${id}?page=${page}&limit=${SAMPLE_PAGE}`;
                    let root = null;
                    for (let attempt = 0; attempt < 2 && !root; attempt++) {
                        try { root = await getPlaylistJson(url); }
                        catch (e) {
                            lastErr = e;
                            if (attempt === 0 && /429/.test(e.message)) await new Promise(r => setTimeout(r, 1500));
                            else break;
                        }
                    }
                    if (!root) continue; // a missing page shrinks the sample, doesn't fail the scan
                    ok++;
                    if (!desc) desc = String(root?.description || '');
                    (root?.videoDetails || []).forEach(v => {
                        const key = v?._id || v?.id;
                        if (key && seen.has(key)) return;
                        if (key) seen.add(key);
                        details.push(v);
                    });
                }
                if (!ok) throw lastErr || new Error('no pages');
                sampled = { n: details.length, of: count };
            }
            // tags: playlist-local vocabulary; vids: per-video indices into it.
            const vocab = new Map();
            const vids = [];
            details.forEach(v => {
                const own = new Set();
                (v?.tags || v?.top5Tags || []).forEach(t => { if (t) own.add(String(t).toLowerCase()); });
                (v?.starsTags || v?.stars || []).forEach(s => {
                    const n = typeof s === 'string' ? s : s?.name;
                    if (n) own.add(STAR + String(n).toLowerCase()); // marked: model lists match only these
                });
                const idx = [];
                own.forEach(t => {
                    if (!vocab.has(t)) vocab.set(t, vocab.size);
                    idx.push(vocab.get(t));
                });
                vids.push(idx);
            });
            return { tags: [...vocab.keys()], vids, desc, sampled };
        }

        // --- Evaluation ---
        // Returns { state: 'pass'|'fail'|'pending', hits }; the description (list response) can decide before tags load.
        function descOf(id) {
            if (!PB.desc) return '';
            const d = PB.listInfo.get(id)?.desc ?? PB.tags.get(id)?.desc ?? '';
            return String(d).toLowerCase();
        }
        // Share of videos in the ticked own playlists (all own with allMine); null when unknown.
        function overlapOf(id, allMine = false) {
            if (!PB.overlap.length && !allMine) return null;
            const info = PB.listInfo.get(id);
            if (!info || !info.videos) return null;
            const { playlists } = getLivePlaylists();
            const sel = PB.overlap.length ? PB.overlap.map(pid => playlists.get(pid)).filter(Boolean) : [...playlists.values()].filter(p => p.id !== id);
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

        // Share of videos with a tag/performer containing `term`, memoised per (playlist, fetch time, term).
        const fracMemo = new Map();
        function fraction(id, entry, term) {
            const key = id + '|' + (entry.at || 0) + '|' + term;
            const hit = fracMemo.get(key);
            if (hit) return hit;
            const matchIdx = new Set();
            entry.tags.forEach((t, i) => { if (PMVX.termMatch(t, term)) matchIdx.add(i); });
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

        // --- Score: share of a playlist's (sampled) videos that pass your filters, 0–100. ---
        // A video passes with no exclude term and every require term on its tags (model lists vs its models only).
        // Terms: site-wide filter (if on) + this page's tag filter, without share thresholds; titles aren't scanned.
        function scoreTerms() {
            const out = { exc: [], inc: [], mExc: [], mInc: [] };
            const s = PMVX.siteFilterSnapshot?.();
            if (s?.active) {
                out.exc.push(...(s.exclude || [])); out.inc.push(...(s.include || []));
                out.mExc.push(...(s.modelsExclude || [])); out.mInc.push(...(s.modelsInclude || []));
            }
            if (PB.enabled) {
                PB.tokens.neg.forEach(t => out.exc.push(t.term));
                PB.tokens.pos.forEach(t => out.inc.push(t.term));
            }
            for (const k in out) out[k] = [...new Set(out[k])];
            return out;
        }
        const scoreActive = () => { const t = scoreTerms(); return !!(t.exc.length || t.inc.length || t.mExc.length || t.mInc.length); };
        const scoreMemo = new Map();
        function scoreOf(id, entry) {
            if (!entry?.vids?.length) return null;
            const t = scoreTerms();
            if (!(t.exc.length || t.inc.length || t.mExc.length || t.mInc.length)) return null;
            const key = id + '|' + (entry.at || 0) + '|' + JSON.stringify(t);
            if (scoreMemo.has(key)) return scoreMemo.get(key);
            const marked = entry.tags.some(x => x[0] === STAR);
            const isModel = x => x[0] === STAR;
            const label = x => isModel(x) ? x.slice(1) : x;
            // Vocabulary indices per term; old entries (no model marks) match tag terms on everything.
            const idx = (term, models) => {
                const set = new Set();
                entry.tags.forEach((x, i) => {
                    if (marked && isModel(x) !== models) return;
                    if (PMVX.termMatch(label(x), term)) set.add(i);
                });
                return set;
            };
            const E = t.exc.map(x => idx(x, false)), I = t.inc.map(x => idx(x, false));
            const ME = t.mExc.map(x => idx(x, true)), MI = t.mInc.map(x => idx(x, true));
            let pass = 0;
            for (const v of entry.vids) {
                const has = set => v.some(i => set.has(i));
                if (E.some(has) || ME.some(has)) continue;
                if (!I.every(has) || !MI.every(has)) continue;
                pass++;
            }
            const total = entry.vids.length;
            const score = Math.round(100 * pass / total);
            const r = { score, grade: score >= 70 ? 'hi' : score >= 40 ? 'mid' : 'lo',
                line: `Score ${score}: ${pass} of ${total}${entry.sampled ? ' sampled' : ''} videos pass your filters` };
            if (scoreMemo.size > 2000) scoreMemo.clear();
            scoreMemo.set(key, r);
            return r;
        }
        // Every filter a playlist fails on its own (evaluate() stops at the first): 'neg:<term>', 'pos:<term>', 'mine'.
        function failKeys(id) {
            const entry = PB.tags.get(id);
            const desc = descOf(id);
            const out = [];
            const mineRange = activeMineRange();
            if (mineRange) {
                const o = overlapOf(id);
                if (o && ((mineRange.min != null && o.frac < mineRange.min) || (mineRange.max != null && o.frac > mineRange.max))) out.push('mine');
            }
            for (const { term, max } of PB.tokens.neg) {
                if (desc && PMVX.termMatch(desc, term)) { out.push('neg:' + term); continue; }
                if (!entry) continue;
                const f = fraction(id, entry, term);
                if (f.n > 0 && f.frac > max) out.push('neg:' + term);
            }
            if (entry) {
                for (const { term, min } of PB.tokens.pos) {
                    if (desc && PMVX.termMatch(desc, term)) continue;
                    const f = fraction(id, entry, term);
                    if (!(min == null ? f.n > 0 : (f.n > 0 && f.frac >= min))) out.push('pos:' + term);
                }
            }
            return out;
        }
        PB.removedBy = new Map();
        PB.removedOnly = new Map();
        PB.removedOf = 0;
        function paintRemovedCounts() {
            document.querySelectorAll('#' + BAR_ID + ' [data-pmvpb-key]').forEach(c => {
                const key = c.dataset.pmvpbKey;
                const n = PB.removedBy.get(key) || 0;
                const only = PB.removedOnly.get(key) || 0;
                let cnt = c.querySelector('.cnt');
                if (!cnt) { cnt = document.createElement('span'); cnt.className = 'cnt'; c.insertBefore(cnt, c.querySelector('.x')); }
                cnt.textContent = '\u2212' + n;
                cnt.dataset.zero = n ? '' : '1';
                cnt.title = `Removes ${n} of ${PB.removedOf} playlists on this page` + (n ? ` (${only} only because of this filter)` : '');
            });
        }
        function evaluate(id, count) {
            const entry = PB.tags.get(id);
            // Stale data is used while the refetch runs.
            const desc = descOf(id);
            // No tag data yet (or the fetch failed): unknown, never a reason to hide.
            const pending = hasTagFilter() && !entry;
            const hits = [];
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
                // A description hit covers the whole playlist: no threshold.
                if (desc && PMVX.termMatch(desc, term)) { hits.push('description: ' + term); continue; }
                if (!entry) continue;
                const f = fraction(id, entry, term);
                if (f.n > 0 && f.frac > max) {
                    hits.push(max > 0 ? `${term} ${pct(f.frac)} (${f.n}/${f.total}, max ${pct(max)})` : `${term} (${f.n}/${f.total})`);
                }
            }
            if (hits.length) return { state: 'fail', hits };
            if (pending) return { state: 'pending', hits: [] };
            for (const { term, min } of PB.tokens.pos) {
                if (desc && PMVX.termMatch(desc, term)) continue;
                const f = entry ? fraction(id, entry, term) : { n: 0, total: 0, frac: 0 };
                const ok = min == null ? f.n > 0 : (f.n > 0 && f.frac >= min);
                if (!ok) return { state: 'fail', hits: [min == null ? 'no ' + term : `${term} ${pct(f.frac)} (${f.n}/${f.total}, min ${pct(min)})`] };
            }
            return { state: 'pass', hits: [] };
        }

        let applyTimer = null;
        function scheduleApply() {
            clearTimeout(applyTimer);
            applyTimer = setTimeout(() => { applyFilter(); applyVideoSection(); }, 60);
        }
        // --- Follow button on playlist cards ---
        //   GET    /api/playlists/followed?limit=…  -> { success, playlists: [...] }
        //   POST   /api/playlists/<id>/follow       -> { success, isFollowing }; DELETE unfollows
        // "+ Follow" on hover, "✓ Following" stays; not on own playlists, nothing when logged out (list fails).
        PB.followed = null; // Set of ids once loaded
        let followLoad = null;
        function loadFollowed() {
            if (followLoad) return followLoad;
            followLoad = fetch('/api/playlists/followed?limit=500', { credentials: 'include', headers: { accept: 'application/json' } })
                .then(r => r.ok ? r.json() : null)
                .then(j => {
                    if (!j?.success || !Array.isArray(j.playlists)) return;
                    PB.followed = new Set(j.playlists.map(p => p?._id || p?.id).filter(Boolean));
                    scheduleApply();
                })
                .catch(() => {});
            return followLoad;
        }
        function paintFollowBtn(b, on) {
            b.dataset.on = on ? '1' : '';
            b.textContent = on ? '\u2713 Following' : '+ Follow';
            b.title = on ? 'Unfollow this playlist' : 'Follow this playlist';
        }
        function ensureFollowButtons(cards) {
            loadFollowed();
            if (!PB.followed) return;
            const mine = getLivePlaylists().playlists;
            cards.forEach(card => {
                const id = cardId(card);
                let b = card.querySelector(':scope > .pmvpb-follow');
                if (!id || mine.has(id)) { b?.remove(); return; }
                if (!b) {
                    b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'pmvpb-follow';
                    // The card link may act on mousedown: keep every phase on the button.
                    ['mousedown', 'mouseup'].forEach(t => b.addEventListener(t, e => { e.preventDefault(); e.stopPropagation(); }));
                    b.addEventListener('click', async e => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (b.dataset.busy) return;
                        const pid = cardId(card);
                        const was = PB.followed.has(pid);
                        b.dataset.busy = '1';
                        paintFollowBtn(b, !was);
                        try {
                            const r = await fetch(`/api/playlists/${pid}/follow`, { method: was ? 'DELETE' : 'POST', credentials: 'include', headers: { accept: 'application/json' } });
                            const j = r.ok ? await r.json().catch(() => ({})) : null;
                            if (!r.ok || j?.success === false) throw new Error('HTTP ' + r.status);
                            const now = typeof j?.isFollowing === 'boolean' ? j.isFollowing : !was;
                            if (now) PB.followed.add(pid); else PB.followed.delete(pid);
                            paintFollowBtn(b, now);
                        } catch {
                            paintFollowBtn(b, was);
                        } finally {
                            delete b.dataset.busy;
                        }
                    });
                    card.appendChild(b);
                }
                const on = PB.followed.has(id);
                if (b.dataset.on !== (on ? '1' : '') || !b.textContent) paintFollowBtn(b, on);
            });
        }

        function applyFilter() {
            if (!PB.active) return;
            try { renderMineChips(); } catch {}
            try { ensureFollowButtons([...document.querySelectorAll('.playlists-grid > a[href*="/playlists/"]')]); } catch {}
            const cards = [...document.querySelectorAll('.playlists-grid > a[href*="/playlists/"]')];
            let hidden = 0, pending = 0, fromCache = 0, notScanned = 0;
            const removedBy = new Map(), removedOnly = new Map();
            let evaluated = 0;
            cards.forEach(card => {
                const id = cardId(card);
                if (!id) return;
                const count = cardCount(card);
                const entry = PB.tags.get(id);
                if (isFresh(entry, count)) card.setAttribute('data-pmvpb-cached', '1');
                else card.removeAttribute('data-pmvpb-cached');
                // ≈ instead of ✓: tags from a sample; clicking it fetches the whole playlist.
                if (entry?.sampled && card.hasAttribute('data-pmvpb-cached')) card.setAttribute('data-pmvpb-sampled', '1');
                else card.removeAttribute('data-pmvpb-sampled');
                const sc = card.hasAttribute('data-pmvpb-cached') ? scoreOf(id, entry) : null;
                if (sc) {
                    if (card.getAttribute('data-pmvpb-score') !== String(sc.score)) card.setAttribute('data-pmvpb-score', String(sc.score));
                    if (card.getAttribute('data-pmvpb-grade') !== sc.grade) card.setAttribute('data-pmvpb-grade', sc.grade);
                } else { card.removeAttribute('data-pmvpb-score'); card.removeAttribute('data-pmvpb-grade'); }
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
                    const parts = [sc?.line, hitTxt, ovTitle].filter(Boolean);
                    if (parts.length) { card.title = parts.join('\n'); card.dataset.pmvpbTitled = '1'; }
                    else if (card.dataset.pmvpbTitled) { card.removeAttribute('title'); delete card.dataset.pmvpbTitled; }
                };
                if (hasTagFilter() || scoreActive()) {
                    const cached = PB.tags.get(id);
                    if (cached && cached.at < PB.sessionStart && isFresh(cached, count)) fromCache++;
                    if (PB.autoScan || PB.scanIds.has(id)) ensureLoaded(id, count);
                    else if (!isFresh(cached, count)) notScanned++;
                }
                if (!hasFilter()) {
                    delete card.dataset.pmvpbHide;
                    delete card.dataset.pmvpbSink;
                    card.removeAttribute('data-pmvpb-pending');
                    setTitle('');
                    return;
                }
                const keys = failKeys(id);
                evaluated++;
                keys.forEach(k => removedBy.set(k, (removedBy.get(k) || 0) + 1));
                if (keys.length === 1) removedOnly.set(keys[0], (removedOnly.get(keys[0]) || 0) + 1);
                const r = evaluate(id, count);
                if (r.state === 'pending') {
                    if (PB.pending.has(id)) pending++;
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
            PB.removedBy = removedBy; PB.removedOnly = removedOnly; PB.removedOf = evaluated || cards.length;
            paintRemovedCounts();
            updateCounter(cards.length, hidden, pending, fromCache, notScanned);
            // Hiding shortens the page: nudge infinite scroll while fewer than 24 cards show.
            if (hasFilter() && hidden && (cards.length - hidden) < 24) {
                try { window.dispatchEvent(new Event('scroll')); } catch {}
            }
        }
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
            // Result next to "N playlists total" via data-* + ::after, which survives Vue re-renders.
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
        function updateCounter(total, hidden, pending, fromCache, notScanned = 0) {
            updateSummary(total, hidden);
            if (!PB.counter) return;
            if (!hasFilter()) { PB.counter.textContent = ''; return; }
            const parts = [];
            parts.push(`${hidden} of ${total} ${PB.mode === 'hide' ? 'hidden' : 'moved down'}`);
            if (pending) parts.push(`${pending} loading…`);
            if (notScanned) parts.push(`${notScanned} not scanned — press Scan page`);
            if (fromCache) parts.push(`${fromCache} cached`);
            if (PB.failed.size) parts.push(`${PB.failed.size} failed`);
            PB.counter.textContent = parts.join(' · ');
        }

        // --- Styles ---
        function injectStyles() {
            if (document.getElementById(STYLE_ID)) return;
            const st = document.createElement('style');
            st.id = STYLE_ID;
            st.textContent = `
                .playlists-grid > a[data-pmvpb-hide="1"] { display: none !important; }
                .playlists-grid > a[data-pmvpb-sink="1"] { order: 9999; opacity: 0.35; filter: grayscale(0.6); }
                .playlists-grid > a[data-pmvpb-pending="1"] { outline: 1px dashed rgba(255,255,255,0.10); outline-offset: -1px; }
                .playlists-grid > a[data-pmvpb-cached="1"], .playlists-grid > a[data-pmvpb-overlap] { position: relative; }
                .playlists-grid > a { position: relative; }
                .playlists-grid > a > .pmvpb-follow { position: absolute; top: 6px; right: 32px; z-index: 21; padding: 2px 9px; border-radius: 9999px;
                    font: inherit; font-size: 11px; font-weight: 600; line-height: 16px; cursor: pointer; white-space: nowrap;
                    background: rgba(0,0,0,0.8); color: #fff; border: 1px solid rgba(168,85,247,0.6); box-shadow: 0 1px 4px rgba(0,0,0,0.6);
                    opacity: 0; transition: opacity .15s, background .15s; }
                .playlists-grid > a:hover > .pmvpb-follow, .playlists-grid > a > .pmvpb-follow[data-on="1"] { opacity: 1; }
                .playlists-grid > a > .pmvpb-follow:hover { background: rgba(168,85,247,0.35); }
                .playlists-grid > a > .pmvpb-follow[data-on="1"] { background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)); border-color: transparent; }
                .playlists-grid > a > .pmvpb-follow[data-busy="1"] { opacity: 0.6; }
                .playlists-grid > a[data-pmvpb-cached="1"]::after {
                    content: '\\2713'; position: absolute; top: 6px; right: 6px; z-index: 20;
                    width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 50%;
                    background: rgba(0,0,0,0.85); color: rgb(233,213,255); font-size: 11px; font-weight: 700;
                    font-family:inherit;font-variant-numeric:tabular-nums; cursor: pointer;
                    box-shadow: 0 0 0 1px rgba(168,85,247,0.5); }
                .playlists-grid > a[data-pmvpb-cached="1"][data-pmvpb-sampled="1"]::after { content: '\\2248'; }
                .playlists-grid > a[data-pmvpb-cached="1"][data-pmvpb-score]::after { content: attr(data-pmvpb-score); width: auto; min-width: 18px; padding: 0 6px; border-radius: 9999px; }
                .playlists-grid > a[data-pmvpb-cached="1"][data-pmvpb-sampled="1"][data-pmvpb-score]::after { content: '\\2248 ' attr(data-pmvpb-score); }
                .playlists-grid > a[data-pmvpb-grade="hi"]::after { color: rgb(134,239,172) !important; box-shadow: 0 0 0 1px rgba(34,197,94,0.6) !important; }
                .playlists-grid > a[data-pmvpb-grade="mid"]::after { color: rgb(253,224,71) !important; box-shadow: 0 0 0 1px rgba(234,179,8,0.6) !important; }
                .playlists-grid > a[data-pmvpb-grade="lo"]::after { color: rgb(252,165,165) !important; box-shadow: 0 0 0 1px rgba(239,68,68,0.6) !important; }
                .playlists-grid > a[data-pmvpb-overlap]::before {
                    content: attr(data-pmvpb-overlap); position: absolute; top: 6px; left: 6px; z-index: 20;
                    padding: 2px 8px; border-radius: 9999px; line-height: 16px;
                    background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)); color: #fff;
                    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; pointer-events: none;
                    text-shadow: 0 1px 1px rgba(0,0,0,0.35); box-shadow: 0 1px 4px rgba(0,0,0,0.6); }
                .playlists-grid > a[data-pmvpb-overlap-zero="1"]::before { background: rgba(0,0,0,0.85); color: rgb(209,213,219);
                    box-shadow: 0 0 0 1px rgba(255,255,255,0.2), 0 1px 4px rgba(0,0,0,0.6); font-weight: 500; }

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
                    color: #fff; font-size: 13px; font-family:inherit;font-variant-numeric:tabular-nums; outline: none; caret-color: rgb(168,85,247); }
                #${BAR_ID} input[type=text]:focus, #${BAR_ID} input[type=text]:focus-visible { border-color: rgba(168,85,247,0.6); outline: none !important; box-shadow: none !important; }
                #${BAR_ID} input[type=text]::placeholder { color: rgb(107,114,128); }
                #${BAR_ID} .pmvpb-hint { color: rgba(255,255,255,0.35); font-size: 11px; margin-top: 6px; line-height: 1.5; font-family:inherit;font-variant-numeric:tabular-nums; }
                #${BAR_ID} .pmvpb-hint b { color: rgba(255,255,255,0.6); font-weight: 600; }
                #${BAR_ID} .pmvpb-tagrow { margin-bottom: 10px; }
                #${BAR_ID} .pmvpb-tagrow input[type=text] { padding: 7px 12px; font-family: inherit; font-size: 13px; }
                #${BAR_ID} .pmvpb-tagchips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; min-height: 0; }
                #${BAR_ID} .pmvpb-tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; border: none; cursor: pointer;
                    font-size: 12px; line-height: 16px; font-family: inherit; transition: background .15s; }
                #${BAR_ID} .pmvpb-tag svg { width: 10px; height: 10px; }
                #${BAR_ID} .pmvpb-tag .ico svg { width: 11px; height: 11px; }
                #${BAR_ID} .pmvpb-tag .cnt { font-size: 10px; font-weight: 600; opacity: 0.85; font-variant-numeric: tabular-nums; }
                #${BAR_ID} .pmvpb-tag .cnt[data-zero="1"] { opacity: 0.4; }
                #${BAR_ID} .pmvpb-rangecnt .cnt { font-size: 12px; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; margin-left: 8px; }
                #${BAR_ID} .pmvpb-rangecnt .cnt[data-zero="1"] { opacity: 0.5; }
                #${BAR_ID} .pmvpb-tag .x { display: inline-flex; opacity: 0.6; margin-left: 2px; padding: 2px; border-radius: 3px; }
                #${BAR_ID} .pmvpb-tag .x:hover { opacity: 1; background: rgba(255,255,255,0.12); }
                #${BAR_ID} .pmvpb-tag .thr { font-size: 10px; font-weight: 700; padding: 0 4px; border-radius: 3px; background: rgba(0,0,0,0.35); font-family:inherit;font-variant-numeric:tabular-nums; }
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
                #${BAR_ID} .pmvpb-edit-head .val { color: rgb(168,85,247); font-weight: 700; font-family:inherit;font-variant-numeric:tabular-nums; }
                #${BAR_ID} .pmvpb-edit input[type=range] { width: 100%; accent-color: rgb(168,85,247); margin: 4px 0; }
                #${BAR_ID} .pmvpb-edit .pmvpb-chips { margin-top: 4px; }
                #${BAR_ID} .pmvpb-edit .pmvpb-hint { margin-top: 6px; }
                #${BAR_ID} .pmvpb-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
                #${BAR_ID} .pmvpb-chip { padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; line-height: 1.2;
                    background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.1); transition: background .15s, color .15s; white-space: nowrap; }
                #${BAR_ID} .pmvpb-chip:hover { background: rgba(255,255,255,0.09); color: #fff; }
                #${BAR_ID} .pmvpb-chip.active { background: rgba(168,85,247,0.2); color: rgb(168,85,247); border-color: rgba(168,85,247,0.5); font-weight: 600; }
                #${BAR_ID} .pmvpb-chip .n { opacity: 0.5; margin-left: 6px; font-weight: 400; font-family:inherit;font-variant-numeric:tabular-nums; }
                #${BAR_ID} .pmvpb-primary { padding: 0 16px; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
                    background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)); color: #fff; border: none; }
                #${BAR_ID} .pmvpb-primary:hover { filter: brightness(1.12); }
                #${BAR_ID} .pmvpb-counter { color: rgba(255,255,255,0.4); font-size: 12px; margin-top: 10px; min-height: 16px; font-family:inherit;font-variant-numeric:tabular-nums; }
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

        // --- Panel ---
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

            const s1 = el('section');
            const h1 = el('h3'); h1.innerHTML = ICONS.filter + ' Playlist contents';
            s1.appendChild(h1);

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
                    let term = PMVX.plainQuotes(inp.value).trim().replace(/^#/, '').toLowerCase();
                    // "quoted": whole word only.
                    const q = term.match(/^["'](.+)["']$/);
                    if (q) term = '=' + q[1].trim();
                    if (!term || term === '=') return;
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
                        c.dataset.pmvpbKey = kind + ':' + t.term;
                        c.title = kind === 'neg'
                            ? `Hides playlists where ${t.max > 0 ? 'more than ' + pct(t.max) : 'at least one'} of the videos have "${t.term}" — click to set the allowed share`
                            : `Requires ${t.min != null ? 'at least ' + pct(t.min) : 'at least one'} of the videos to have "${t.term}" — click to set the required share`;
                        if (kind === 'neg') {
                            const ic = el('span', 'ico');
                            ic.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
                            c.appendChild(ic);
                        }
                        c.appendChild(el('span', 'txt', '#' + (PMVX.isWordTerm(t.term) ? `"${PMVX.termLabel(t.term)}"` : t.term)));
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
                paintRemovedCounts();
            };
            const renderEditor = () => {
                editorHost.textContent = '';
                if (!editing) return;
                const t = PB.terms[editing.kind].find(o => o.term === editing.term);
                if (!t) { editing = null; return; }
                const neg = editing.kind === 'neg';
                const cur = neg ? Math.round((t.max || 0) * 100) : Math.round((t.min ?? 0) * 100);
                const box = el('div', 'pmvpb-edit ' + editing.kind);
                const head = el('div', 'pmvpb-edit-head');
                head.innerHTML = `<b></b> — ${neg ? 'hide if more than' : 'require at least'} <span class="val">${cur}%</span> of the videos to have this tag`;
                head.querySelector('b').textContent = '#' + (PMVX.isWordTerm(t.term) ? `"${PMVX.termLabel(t.term)}"` : t.term);
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
                const isWord = PMVX.isWordTerm(t.term);
                const wordChip = chip('Whole word', isWord ? 'Only tags containing this as a separate word — click to match anywhere' : 'Match only as a separate word (ch, not challenge)', () => {
                    const next = isWord ? t.term.slice(1) : '=' + t.term;
                    if (PB.terms[editing.kind].some(o => o !== t && o.term === next)) return;
                    t.term = next;
                    editing = { kind: editing.kind, term: next };
                    fracMemo.clear();
                    applyTerms();
                });
                wordChip.classList.toggle('active', isWord);
                presets.appendChild(wordChip);
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
            const scanChip = chip('⟳ Scan page', 'Fetch the tags of the playlists on this page. Playlists over 300 videos are sampled (first, last and a few pages in between, about 300 videos) to keep it quick. Cached data is reused until a playlist\u2019s video count changes by more than 10%; click ✓ on a card to fetch that playlist in full.', scanVisible);
            const autoChip = chip('Auto-scan', '', () => { PB.autoScan = !PB.autoScan; renderModeChips(); saveSettings(); applyFilter(); });
            const renderModeChips = () => {
                hideChip.classList.toggle('active', PB.mode === 'hide');
                sinkChip.classList.toggle('active', PB.mode === 'sink');
                descChip.classList.toggle('active', !!PB.desc);
                autoChip.classList.toggle('active', !!PB.autoScan);
                autoChip.title = PB.autoScan
                    ? 'Tags are fetched automatically for every playlist shown (one request each) — click to scan only on request'
                    : 'Tags are fetched only when you press Scan page — click to fetch them automatically';
                descChip.title = PB.desc
                    ? 'Terms also match the playlist description — click to match video tags only'
                    : 'Video tags and performers only — click to also match the playlist description';
            };
            renderModeChips();
            chips1.append(hideChip, sinkChip, descChip, scanChip, autoChip);
            s1.appendChild(chips1);
            const counter = el('div', 'pmvpb-counter');
            s1.appendChild(counter);
            renderChips();
            const inp = rowPos.inp;

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

            const s3 = el('section');
            const h3 = el('h3'); h3.innerHTML = ICONS.range + ' Overlap range';
            s3.appendChild(h3);
            s3.appendChild(el('label', 'pmvpb-label', 'Share of videos that are also in the selected playlists'));
            const pillRow = el('div', 'pmvpb-pillrow');
            const pill = el('div', 'pmvpb-pill');
            const pMin = el('span', null, '0%'); const pSep = el('span', 'sep', '-'); const pMax = el('span', null, 'Any');
            pill.append(pMin, pSep, pMax); pillRow.appendChild(pill);
            const rangeCnt = el('span', 'pmvpb-rangecnt');
            rangeCnt.dataset.pmvpbKey = 'mine';
            pillRow.appendChild(rangeCnt);
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

        // Filters control: trailing child of the site's tab row after Vue's v-for fragment; the page observer re-inserts it.
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

        // (playlistBrowseFilter continues in 07-video-checker.js, which also closes it.)
