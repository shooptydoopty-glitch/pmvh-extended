        // (Still inside playlistBrowseFilter from 06-playlists-overview.js: same scope, PB etc.)

        // --- Video pages: "Playlists with this video" ---
        // Scan button: loads the video ids of the playlists shown (one small request each) for the overlap badge
        // (ticked own playlists, else all). With a tag filter also tags: ✓/≈ pass, ⊘ fail (dimmed); never hidden here.
        const VSCAN_ID = 'pmvpb-vscan';
        const isVideoPage = () => /^\/video\/[^/]+/.test(location.pathname);
        PB.vactive = false;
        PB.vscan = null; // ids being scanned from the button, or null
        PB.idsPending = new Set();
        // Video ids + count of one playlist: the single-playlist endpoint lists every id even with limit=1.
        async function loadIds(id) {
            if (PB.idsPending.has(id)) return;
            PB.idsPending.add(id);
            try {
                const root = await getPlaylistJson(`/api/playlists/${id}?page=1&limit=1`);
                if (root && Array.isArray(root.videos)) {
                    PB.listInfo.set(id, {
                        count: root.validVideoCount ?? root.videos.length,
                        name: root.name || '',
                        desc: String(root.description || ''),
                        videos: root.videos.map(v => typeof v === 'string' ? v : (v?._id || v?.id)).filter(Boolean),
                    });
                }
            } catch { PB.failed.add(id); }
            finally { PB.idsPending.delete(id); scheduleApply(); }
        }
        async function loadIdsAll(ids) {
            const list = [...ids];
            const worker = async () => { while (list.length) await loadIds(list.shift()); };
            await Promise.all(Array.from({ length: Math.min(list.length, Math.max(1, PMVX.perf().lookups)) }, worker));
        }
        const hasIds = id => !!PB.listInfo.get(id)?.videos;
        const isMine = id => getLivePlaylists().playlists.has(id);
        function overlapLabel() {
            const { playlists } = getLivePlaylists();
            const names = PB.overlap.map(id => playlists.get(id)?.name).filter(Boolean);
            if (!names.length) return 'my playlists';
            return names.length === 1 ? names[0] : `${names.length} playlists`;
        }
        function findVideoSection() {
            const h = [...document.querySelectorAll('h3')].find(x => /^\s*Playlists with this video\b/i.test(x.textContent || ''));
            if (!h) return null;
            const header = h.parentElement;
            const grid = header?.nextElementSibling;
            if (!header || !grid || !grid.querySelector(':scope > a[href*="/playlists/"]')) return null;
            return { header, grid };
        }
        function vCardCount(card) {
            const info = PB.listInfo.get(cardId(card));
            if (info && Number.isFinite(info.count)) return info.count;
            const b = card.querySelector('[class~="top-1.5"][class~="right-1.5"]');
            const n = parseInt((b?.textContent || '').replace(/[^\d]/g, ''), 10);
            return Number.isFinite(n) ? n : null;
        }
        function topTags(entry, n = 6) {
            const cnt = new Map();
            entry.vids.forEach(idx => idx.forEach(i => cnt.set(i, (cnt.get(i) || 0) + 1)));
            const total = entry.vids.length || 1;
            return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
                .map(([i, c]) => `${entry.tags[i]} ${pct(c / total)}`).join(', ');
        }
        function vScan() {
            const sec = findVideoSection();
            if (!sec) return;
            const ids = new Set();
            const cards = [...sec.grid.querySelectorAll(':scope > a[href*="/playlists/"]')];
            const withTags = hasTagFilter() || scoreActive();
            // All loaded and fresh: the button reads Rescan and refetches everything.
            const force = !vTodo(cards);
            const idJobs = [];
            cards.forEach(card => {
                const id = cardId(card);
                if (!id) return;
                ids.add(id);
                PB.failed.delete(id);
                if (force || !hasIds(id)) idJobs.push(id);
                if (withTags) {
                    PB.scanIds.add(id);
                    ensureLoaded(id, vCardCount(card), force);
                }
            });
            idJobs.forEach(id => PB.idsPending.add(id)); // counted as busy right away
            PB.vscan = ids;
            applyVideoSection();
            idJobs.forEach(id => PB.idsPending.delete(id));
            loadIdsAll(idJobs);
        }
        const setText = PMVX.setText, setAttr = PMVX.setAttr;
        function ensureVideoButton(header) {
            let w = document.getElementById(VSCAN_ID);
            if (w && w.parentElement === header) return w;
            if (!w) {
                w = el('div');
                w.id = VSCAN_ID;
                const note = el('span', 'note');
                const b = el('button', 'btn', '⟳ Scan');
                b.type = 'button';
                b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); vScan(); });
                w.append(note, b);
            }
            header.appendChild(w);
            return w;
        }
        function vTodo(cards) {
            const withTags = hasTagFilter() || scoreActive();
            return cards.filter(c => {
                const id = cardId(c);
                if (!id) return false;
                return !hasIds(id) || (withTags && !isFresh(PB.tags.get(id), vCardCount(c)));
            }).length;
        }
        function applyVideoSection() {
            if (!PB.vactive) return;
            const sec = findVideoSection();
            if (!sec) return;
            setAttr(sec.grid, 'data-pmvpb-vgrid', '1');
            const w = ensureVideoButton(sec.header);
            const btn = w.querySelector('.btn'), note = w.querySelector('.note');
            const cards = [...sec.grid.querySelectorAll(':scope > a[href*="/playlists/"]')];
            const filterOn = hasFilter();
            let failN = 0, known = 0, busy = 0, failedN = 0, ovKnown = 0;
            cards.forEach(card => {
                const id = cardId(card);
                if (!id) return;
                const count = vCardCount(card);
                const entry = PB.tags.get(id);
                const loading = PB.pending.has(id) || PB.idsPending.has(id);
                if (loading) busy++;
                if (PB.failed.has(id) && PB.vscan?.has(id)) failedN++;
                const lines = [];
                // Overlap pill top-left; the site's count badge shows "mine/total" via data-* + CSS, so Vue keeps the node.
                const mine = isMine(id);
                const ov = mine ? null : overlapOf(id, true);
                const badge = card.querySelector('[class~="top-1.5"][class~="right-1.5"]');
                if (badge) setAttr(badge, 'data-pmvpb-ov', ov ? `${ov.n}/${ov.total}` : null);
                if (mine) {
                    setAttr(card, 'data-pmvpb-voverlap', 'mine');
                    setAttr(card, 'data-pmvpb-overlap-zero', null);
                    lines.push('One of your playlists');
                } else if (ov) {
                    ovKnown++;
                    setAttr(card, 'data-pmvpb-voverlap', ov.n && ov.frac < 0.005 ? '<1%' : pct(ov.frac));
                    setAttr(card, 'data-pmvpb-overlap-zero', ov.n ? null : '1');
                    const perTxt = [...ov.per.entries()].sort((a, b) => b[1] - a[1]).map(([nm, c]) => `${nm} (${c})`).join(', ');
                    lines.push(`In ${overlapLabel()}: ${ov.n} of ${ov.total} (${pct(ov.frac)})` + (perTxt ? ' — ' + perTxt : ''));
                } else {
                    setAttr(card, 'data-pmvpb-voverlap', null);
                    setAttr(card, 'data-pmvpb-overlap-zero', null);
                }
                let state = null;
                if (filterOn && (entry || (ov && !hasTagFilter()))) {
                    known++;
                    const r = evaluate(id, count);
                    if (r.state === 'fail') { state = 'fail'; failN++; lines.push('Fails your playlist filter: ' + r.hits.join(', ')); }
                    else if (r.state === 'pass') { state = entry?.sampled ? 'sampled' : 'pass'; lines.push('Passes your playlist filter'); }
                }
                if (entry) {
                    const tt = topTags(entry);
                    if (tt) lines.push('Top tags: ' + tt);
                    if (entry.sampled) lines.push(`Tags sampled from ${entry.sampled.n} of ${entry.sampled.of} videos`);
                    if (hasTagFilter() && !isFresh(entry, count)) lines.push('Video count changed since the scan — press Scan to refresh');
                }
                const sc = entry ? scoreOf(id, entry) : null;
                if (sc) {
                    lines.unshift(sc.line);
                    if (!state) state = entry.sampled ? 'sampled' : 'pass';
                    setAttr(card, 'data-pmvpb-vscore', (state === 'fail' ? '\u2298 ' : entry.sampled ? '\u2248 ' : '') + sc.score);
                    setAttr(card, 'data-pmvpb-grade', sc.grade);
                } else { setAttr(card, 'data-pmvpb-vscore', null); setAttr(card, 'data-pmvpb-grade', null); }
                setAttr(card, 'data-pmvpb-vstate', loading ? 'busy' : state);
                if (lines.length) { setAttr(card, 'title', lines.join('\n')); card.dataset.pmvpbTitled = '1'; }
                else if (card.dataset.pmvpbTitled) { card.removeAttribute('title'); delete card.dataset.pmvpbTitled; }
            });
            const total = cards.length;
            const scanning = PB.vscan && [...PB.vscan].some(id => PB.pending.has(id) || PB.idsPending.has(id));
            if (PB.vscan && !scanning) PB.vscan = null;
            setText(btn, scanning ? `Scanning… ${total - busy}/${total}` : (vTodo(cards) ? '⟳ Scan' : '⟳ Rescan'));
            btn.disabled = !!scanning;
            setAttr(btn, 'title', `Count how many videos of each playlist are already in ${overlapLabel()} (tick playlists under Filters on the Playlists page to narrow it).`
                + (hasTagFilter() ? ' Also checks their tags against your playlist filter; playlists over 300 videos are sampled.' : ''));
            const parts = [];
            if (ovKnown) parts.push(`overlap with ${overlapLabel()}`);
            if (known && filterOn) parts.push(failN ? `${failN} of ${known} fail your filter` : `all ${known} pass your filter`);
            if (failedN) parts.push(`${failedN} failed`);
            setText(note, parts.join(' · '));
            setAttr(note, 'data-fail', filterOn && failN ? '1' : null);
        }
        function injectVideoStyles() {
            if (document.getElementById(STYLE_ID + '-v')) return;
            const st = document.createElement('style');
            st.id = STYLE_ID + '-v';
            st.textContent = `
                #${VSCAN_ID} { display: inline-flex; align-items: center; gap: 10px; margin-left: auto; min-width: 0; }
                #${VSCAN_ID} .note { color: rgb(156,163,175); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
                #${VSCAN_ID} .note[data-fail="1"] { color: rgb(252,165,165); }
                #${VSCAN_ID} .btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font: inherit; font-size: 12px; font-weight: 500; line-height: 16px;
                    background: #2A2A2A; color: #fff; border: 1px solid #3A3A3A; border-radius: 8px; cursor: pointer; white-space: nowrap; transition: background .2s, border-color .2s; }
                #${VSCAN_ID} .btn:hover { background: #3A3A3A; border-color: rgba(249,115,22,0.4); }
                #${VSCAN_ID} .btn:disabled { opacity: .6; cursor: default; }
                [data-pmvpb-vgrid] > a { position: relative; }
                [data-pmvpb-vgrid] > a[data-pmvpb-voverlap]::before {
                    content: attr(data-pmvpb-voverlap); position: absolute; top: 6px; left: 6px; z-index: 20;
                    padding: 2px 8px; border-radius: 9999px; line-height: 16px;
                    background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)); color: #fff;
                    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; pointer-events: none;
                    text-shadow: 0 1px 1px rgba(0,0,0,0.35); box-shadow: 0 1px 4px rgba(0,0,0,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-overlap-zero="1"]::before { background: rgba(0,0,0,0.85); color: rgb(209,213,219);
                    box-shadow: 0 0 0 1px rgba(255,255,255,0.2), 0 1px 4px rgba(0,0,0,0.6); font-weight: 500; }
                [data-pmvpb-vgrid] [data-pmvpb-ov] { font-size: 0 !important; background: linear-gradient(135deg, rgb(168,85,247), rgb(139,92,246)) !important;
                    color: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.6); }
                [data-pmvpb-vgrid] [data-pmvpb-ov]::after { content: attr(data-pmvpb-ov); margin-left: 4px; font-size: 12px; line-height: 16px; font-weight: 700;
                    font-variant-numeric: tabular-nums; text-shadow: 0 1px 1px rgba(0,0,0,0.35); }
                [data-pmvpb-vgrid] > a[data-pmvpb-overlap-zero="1"] [data-pmvpb-ov] { background: rgba(0,0,0,0.85) !important; color: rgb(209,213,219);
                    box-shadow: 0 0 0 1px rgba(255,255,255,0.2), 0 1px 4px rgba(0,0,0,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-voverlap="mine"]::before { background: rgba(0,0,0,0.85); color: rgb(192,132,252);
                    box-shadow: 0 0 0 1px rgba(168,85,247,0.5), 0 1px 4px rgba(0,0,0,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate]::after {
                    position: absolute; top: 32px; right: 6px; z-index: 20; width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 50%;
                    background: rgba(0,0,0,0.85); color: rgb(253,186,116); font-size: 11px; font-weight: 700; font-family: inherit; pointer-events: none;
                    box-shadow: 0 0 0 1px rgba(249,115,22,0.5); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="pass"]::after { content: '\\2713'; }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="sampled"]::after { content: '\\2248'; }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="busy"]::after { content: '\\2026'; color: rgb(209,213,219); box-shadow: 0 0 0 1px rgba(255,255,255,0.2); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="fail"]::after { content: '\\2298'; color: rgb(252,165,165); box-shadow: 0 0 0 1px rgba(239,68,68,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vscore]:not([data-pmvpb-vstate="busy"])::after { content: attr(data-pmvpb-vscore); width: auto; min-width: 18px; padding: 0 6px; border-radius: 9999px; }
                [data-pmvpb-vgrid] > a[data-pmvpb-grade="hi"]:not([data-pmvpb-vstate="busy"])::after { color: rgb(134,239,172); box-shadow: 0 0 0 1px rgba(34,197,94,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-grade="mid"]:not([data-pmvpb-vstate="busy"])::after { color: rgb(253,224,71); box-shadow: 0 0 0 1px rgba(234,179,8,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-grade="lo"]:not([data-pmvpb-vstate="busy"])::after { color: rgb(252,165,165); box-shadow: 0 0 0 1px rgba(239,68,68,0.6); }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="fail"] { opacity: 0.4; filter: grayscale(0.6); transition: opacity .2s; }
                [data-pmvpb-vgrid] > a[data-pmvpb-vstate="fail"]:hover { opacity: 0.85; }
            `;
            (document.head || document.documentElement).appendChild(st);
        }
        const scheduleVideo = PMVX.scheduler(applyVideoSection);
        function vstart() {
            if (PB.vactive) return;
            PB.vactive = true;
            injectVideoStyles();
            // Self-heal: Vue re-renders the section (and drops the button) on navigation between videos.
            PB.vobserver = new MutationObserver(scheduleVideo);
            PB.vobserver.observe(document.body, { childList: true, subtree: true });
            window.addEventListener('pmv:cache-ready', scheduleVideo);
            try { loadPlaylistCache(); } catch {}
            applyVideoSection();
        }
        function vstop() {
            if (!PB.vactive) return;
            PB.vactive = false;
            PB.vobserver?.disconnect();
            PB.vobserver = null;
            window.removeEventListener('pmv:cache-ready', scheduleVideo);
            PB.vscan = null;
            document.getElementById(VSCAN_ID)?.remove();
        }

        // --- Lifecycle ---
        function start() {
            if (PB.active) return;
            PB.active = true;
            PB.failed.clear(); // a new visit retries what failed last time (also Mini-checker failures)
            injectStyles();
            // Self-heal: re-insert the bar and re-apply when Vue replaces the header or grid.
            PB.observer = new MutationObserver(muts => {
                // Our own bar and button rewrite their text on every run; reacting to that would loop.
                if (muts.every(m => m.target.closest?.('#' + BAR_ID + ', #' + BTN_ID))) return;
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
            window.addEventListener('pmv:cache-ready', renderMineChipsOnReady);
        }
        function renderMineChipsOnReady() { renderMineChips(); }
        function stop() {
            window.removeEventListener('pmv:cache-ready', scheduleApply);
            window.removeEventListener('pmv:cache-ready', renderMineChipsOnReady);
            if (!PB.active) return;
            PB.active = false;
            ['mousedown', 'mouseup', 'click'].forEach(t => document.removeEventListener(t, onCardClick, true));
            PB.observer?.disconnect();
            PB.observer = null;
            document.getElementById(BAR_ID)?.remove();
            document.getElementById(BTN_ID)?.remove();
            document.querySelectorAll('[data-pmvpb-note]').forEach(n => n.removeAttribute('data-pmvpb-note'));
            PB.bar = PB.input = PB.counter = PB.toggle = null;
            // Queued scans would keep hitting the API after we left; running ones finish.
            PB.queue.splice(0).forEach(job => { PB.pending.delete(job.id); job.resolve(); });
        }
        function onRoute() {
            if (isBrowsePage()) start(); else stop();
            // Playlist pages too: their expandable video info (hud/13-badges.js) carries the same section.
            if (isVideoPage() || /^\/playlists\/[0-9a-f]{24}/i.test(location.pathname)) { PB.vscan = null; vstart(); scheduleVideo(); } else vstop();
        }

        loadSettings();
        loadCache();
        const bootPb = () => {
            onRoute();
            PMVX.onRoute((path, prev) => { if (path !== prev) onRoute(); });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPb, { once: true });
        else bootPb();

    })();


