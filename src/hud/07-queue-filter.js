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

    function scoreRecommendedCandidate(id, card) {
        const meta = State.videoMeta.get(id);
        if (meta) {
            const tagScores = computeTagAffinity();
            const tagScore = (meta.tags || []).reduce((sum, t) => sum + (tagScores.get(t) || 0), 0);
            return tagScore + (meta.bayesianRating || 0) / 20;
        }
        return (scrapeCardMeta(card).bayesianRating ?? 50) / 20;
    }

    function topUpQueueFromRecommended() {
        const targetSize = queueSettings.targetSize;
        // Only items still ahead count toward the target.
        if (!smartQueueActive || !queueSettings.autoRefill || upcomingCount() >= targetSize) return;
        const container = findVisibleRecommendedContainer();
        if (!container) return;

        const existingIds = new Set(smartQueueItems.map(it => it.id));
        const useFilter = queueSettings.useNfFilter && filterIsMeaningful();
        const candidates = [];
        let rejected = 0;
        container.querySelectorAll('.w-40').forEach(thumbDiv => {
            const card = thumbDiv.parentElement;
            if (!card) return;
            const slugId = resolveRecCardVideoId(card);
            if (!slugId) return;
            const apiId = State.slugToApiId.get(slugId) || slugId;
            if (existingIds.has(apiId)) return;
            const meta = resolveQueueMeta(apiId, card);
            if (useFilter && !passesFilter(apiId, meta)) { rejected++; return; }
            candidates.push({ id: apiId, href: cardHref(card), meta, score: scoreRecommendedCandidate(apiId, card) });
        });
        lastFilteredOut = rejected;
        if (!candidates.length) { renderQueueSidebar(); return; }

        candidates.sort((a, b) => b.score - a.score);
        const need = targetSize - upcomingCount();
        smartQueueItems.push(...candidates.slice(0, need).map(({ id, href, meta }) => ({ id, href, meta })));
        renderQueueSidebar();
    }

    function generateSmartQueue({ count, minRating, maxDuration, unseenOnly, tagFilter }) {
        const tagScores = computeTagAffinity();
        const tagFilterLower = tagFilter.trim().toLowerCase();
        const candidates = [];

        State.videoMeta.forEach((meta, id) => {
            if ((meta.bayesianRating || 0) < minRating) return;
            if (maxDuration && durationToMinutes(meta.duration) > maxDuration) return;
            if (unseenOnly && PMVX.isWatched?.(id)) return;
            if (tagFilterLower && !(meta.tags || []).some(t => t.toLowerCase().includes(tagFilterLower))) return;

            const tagScore = (meta.tags || []).reduce((sum, t) => sum + (tagScores.get(t) || 0), 0);
            const score = tagScore + (meta.bayesianRating || 0) / 20;
            candidates.push({ id, meta, score });
        });

        candidates.sort((a, b) => b.score - a.score);
        return candidates.slice(0, count);
    }

    const Q_INPUT = 'background:#0F0F0F;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#fff;padding:3px 6px;font:inherit;';

    function queueSettingsHtml() {
        const s = queueSettings;
        return `
            <div id="pmv-sq-set" class="mb-2 p-2 rounded-lg text-xs text-gray-400" style="background:#0F0F0F;border:1px solid rgba(255,255,255,0.08);">
                <label class="flex items-center gap-2" style="margin-bottom:6px;">
                    <input id="sq-autorefill" type="checkbox" ${s.autoRefill ? 'checked' : ''}>
                    <span>Auto-refill from Recommended, up to</span>
                    <input id="sq-target" type="number" min="1" max="20" value="${s.targetSize}" style="${Q_INPUT}width:46px;">
                    <span>videos</span>
                </label>
                <div class="flex items-center gap-2 flex-wrap" style="margin-bottom:6px;">
                    <label class="flex items-center gap-1"><span>Count</span><input id="sq-count" type="number" min="1" max="100" value="${s.count}" style="${Q_INPUT}width:52px;"></label>
                    <label class="flex items-center gap-1"><span>Min. rating</span><input id="sq-rating" type="number" min="0" max="100" value="${s.minRating}" style="${Q_INPUT}width:46px;"><span>%</span></label>
                    <label class="flex items-center gap-1"><span>Max length</span><input id="sq-duration" type="number" min="0" placeholder="none" value="${s.maxDuration || ''}" style="${Q_INPUT}width:70px;"><span>min</span></label>
                </div>
                <label class="flex items-center gap-1" style="margin-bottom:6px;" title="A long session in one page keeps growing in memory. A full page load clears it; Up next and the playback position are kept. A page load ends fullscreen; one click or key on the new page puts it back.">
                    <span>Fresh page load every</span>
                    <input id="sq-fresh" type="number" min="0" max="200" placeholder="off" value="${s.freshEvery || ''}" style="${Q_INPUT}width:52px;">
                    <span>videos, in fullscreen every</span>
                    <input id="sq-fresh-fs" type="number" min="0" max="200" placeholder="off" value="${s.freshEveryFs || ''}" style="${Q_INPUT}width:52px;">
                    <span>(empty = off)</span>
                </label>
                <label class="flex items-center gap-1" style="margin-bottom:6px;" title="Uses the filter behind the funnel button in the header">
                    <input id="sq-nffilter" type="checkbox" ${s.useNfFilter ? 'checked' : ''}>
                    <span>Apply my filter${filterSummary()}</span>
                </label>
                <div class="flex items-center gap-2 flex-wrap" style="margin-bottom:6px;">
                    <label class="flex items-center gap-1"><input id="sq-unseen" type="checkbox" ${s.unseenOnly ? 'checked' : ''}><span>Unseen only</span></label>
                    <input id="sq-tag" type="text" placeholder="tag contains..." value="${escHtml(s.tagFilter)}" style="${Q_INPUT}flex:1;min-width:90px;">
                </div>
                <div class="flex items-center gap-2">
                    <button id="sq-generate" type="button" class="${Q_CHIP_ON}" style="cursor:pointer;">Fill from your playlists</button>
                    <span id="sq-status" class="text-gray-500"></span>
                </div>
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);">
                    <div class="text-gray-300" style="margin-bottom:6px;font-weight:600;">Saved queues</div>
                    <div class="flex items-center gap-2" style="margin-bottom:6px;">
                        <input id="sq-save-name" type="text" placeholder="Name this queue\u2026" maxlength="60" style="${Q_INPUT}flex:1;min-width:90px;">
                        <button id="sq-save" type="button" class="${Q_CHIP_ON}" style="cursor:pointer;" title="Save Up next from the current video on; kept until you delete it">Save</button>
                    </div>
                    <div id="sq-saved-list">${savedQueuesHtml()}</div>
                    <div class="text-gray-300" style="margin:10px 0 6px;font-weight:600;">Previous queues</div>
                    <div id="sq-prev-list">${prevQueuesHtml()}</div>
                </div>
            </div>`;
    }

    // Two-step click ("Clear all?"): the second click within 3 s goes through.
    function confirmClick(btn, label) {
        if (btn.dataset.armed === '1') { clearTimeout(btn._pmvArm); delete btn.dataset.armed; return true; }
        btn.dataset.armed = '1';
        btn._pmvLabel = btn.textContent;
        btn.textContent = label;
        btn.style.color = 'rgb(252,165,165)';
        btn.style.borderColor = 'rgba(239,68,68,.5)';
        btn._pmvArm = setTimeout(() => {
            if (!btn.isConnected) return;
            delete btn.dataset.armed;
            btn.textContent = btn._pmvLabel;
            btn.style.color = ''; btn.style.borderColor = '';
        }, 3000);
        return false;
    }

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
    function loadPrevQueues() {
        try {
            const a = JSON.parse(localStorage.getItem(QUEUE_PREV_KEY) || '[]');
            const now = Date.now();
            return (Array.isArray(a) ? a : []).filter(q => q && Array.isArray(q.items) && q.items.length && now - (q.at || 0) < QUEUE_PREV_MAX_AGE_MS);
        } catch { return []; }
    }
    function storePrevQueues(list) {
        try { localStorage.setItem(QUEUE_PREV_KEY, JSON.stringify(list.slice(0, QUEUE_PREV_MAX))); } catch {}
    }
    const queueSig = items => items.map(it => it.id).join(',');
    function snapshotQueue(label) {
        const snap = {
            label, at: Date.now(), cursor: queueCursor, active: smartQueueActive, manual: [...manuallyAddedIds],
            items: smartQueueItems.map(it => ({ id: it.id, href: it.href, meta: it.meta ? { ...it.meta } : {} })),
        };
        if (!snap.items.length) return snap;
        const list = loadPrevQueues().filter(q => queueSig(q.items) !== queueSig(snap.items));
        list.unshift(snap);
        storePrevQueues(list);
        return snap;
    }
    function loadQueueUndo() { return loadPrevQueues()[0] || null; }
    function prevQueueCount() { return loadPrevQueues().length; }
    // Restores a previous queue; the replaced queue goes into the list, so this is undoable too.
    function restoreQueueSnapshot(snap) {
        if (!snap) return;
        const rest = loadPrevQueues().filter(q => !(q.at === snap.at && queueSig(q.items) === queueSig(snap.items)));
        storePrevQueues(rest);
        // Not when the current queue is only part of the restored one (an undo).
        const restoredIds = new Set(snap.items.map(it => it.id));
        if (smartQueueItems.length && !smartQueueItems.every(it => restoredIds.has(it.id))) snapshotQueue(`Replaced by a restore \u2022 ${smartQueueItems.length} videos`);
        smartQueueItems = snap.items.map(it => ({ ...it, meta: it.meta ? { ...it.meta } : {} }));
        manuallyAddedIds = new Set(snap.manual || []);
        smartQueueActive = snap.active !== false;
        queueCursor = Math.min(snap.cursor ?? -1, smartQueueItems.length - 1);
        dismissedCurrentId = null;
        document.getElementById('pmv-undo-toast')?.remove();
        renderQueueSidebar();
        toast(`↺ Up next restored (${upcomingCount()} to come)`, 'green', { under: upNextToastAnchor() });
    }
    function prevQueuesHtml() {
        const list = loadPrevQueues();
        if (!list.length) return '<div class="text-gray-500">Nothing yet. Cleared or replaced queues are kept here for 14 days.</div>';
        return list.map((q, i) => {
            const d = new Date(q.at);
            const when = d.toDateString() === new Date().toDateString()
                ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
            const first = q.items[Math.max(0, (q.cursor ?? -1) + 1)]?.meta?.title || q.items[0]?.meta?.title || '';
            return `<div class="flex items-center gap-2" style="margin-bottom:4px;">
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;" title="${escHtml(first)}">${escHtml(q.label || q.items.length + ' videos')}</span>
                <span class="text-gray-500" style="white-space:nowrap;">${escHtml(when)}</span>
                <button type="button" class="${Q_CHIP_ON}" style="cursor:pointer;" data-sq-prev="${i}" title="Put this queue back (the current one is kept in this list)">Restore</button>
            </div>`;
        }).join('');
    }

    // Undo toast under Up next in the header; fades after 2 s (held on hover).
    function showQueueUndo(msg, snap) {
        document.getElementById('pmv-undo-toast')?.remove();
        const el = document.createElement('div');
        el.id = 'pmv-undo-toast';
        el.style.cssText = 'position:fixed;bottom:30px;right:30px;z-index:1000003;display:flex;align-items:center;gap:12px;padding:8px 8px 8px 14px;' +
            'border-radius:10px;background:rgba(0,0,0,.9);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.5);';
        const t = document.createElement('span');
        t.textContent = msg;
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Undo';
        b.style.cssText = 'padding:5px 12px;border-radius:7px;border:none;cursor:pointer;font:inherit;font-weight:600;color:#000;background:rgb(100,255,0);';
        b.onclick = e => { e.preventDefault(); e.stopPropagation(); restoreQueueSnapshot(snap); };
        el.append(t, b);
        const anchor = upNextToastAnchor();
        const r = anchor && !document.fullscreenElement && anchor.isConnected ? anchor.getBoundingClientRect() : null;
        if (r && r.width) { el.style.bottom = 'auto'; el.style.top = Math.round(r.bottom + 8) + 'px'; el.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px'; }
        (document.fullscreenElement || document.body).appendChild(el);
        el.style.transition = 'opacity .3s';
        let timer = null;
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2000);
        };
        el.addEventListener('mouseenter', () => { clearTimeout(timer); el.style.opacity = '1'; });
        el.addEventListener('mouseleave', arm);
        arm();
    }

    // Saved queues: named Up next copies in localStorage until deleted (the auto backup only bridges a restart).
    const SAVED_QUEUES_KEY = 'pmv_saved_queues_v1';
    const SAVED_QUEUES_MAX = 20;
    function loadSavedQueues() {
        try {
            const a = JSON.parse(localStorage.getItem(SAVED_QUEUES_KEY) || '[]');
            return Array.isArray(a) ? a.filter(q => q && typeof q.name === 'string' && Array.isArray(q.items)) : [];
        } catch { return []; }
    }
    function storeSavedQueues(list) {
        try { localStorage.setItem(SAVED_QUEUES_KEY, JSON.stringify(list.slice(0, SAVED_QUEUES_MAX))); return true; }
        catch { return false; }
    }
    function savedQueuesHtml() {
        const list = loadSavedQueues();
        if (!list.length) return '<div class="text-gray-500">None yet. Saved queues stay until you delete them.</div>';
        return list.map((q, i) => {
            const when = q.at ? new Date(q.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
            return `<div class="flex items-center gap-2" style="margin-bottom:4px;">
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;" title="${escHtml(q.name)}">${escHtml(q.name)}</span>
                <span class="text-gray-500" style="white-space:nowrap;">${q.items.length} \u2022 ${escHtml(when)}</span>
                <button type="button" class="${Q_CHIP_ON}" style="cursor:pointer;" data-sq-load="${i}" title="Replace Up next with this queue">Load</button>
                <button type="button" class="${Q_CHIP_OFF}" style="cursor:pointer;" data-sq-append="${i}" title="Add these videos to the end of Up next">Add</button>
                <button type="button" class="${Q_CHIP_OFF}" style="cursor:pointer;" data-sq-del="${i}" title="Delete (click twice)">\u2715</button>
            </div>`;
        }).join('');
    }

    function wireQueueSettings(panel) {
        const q = sel => panel.querySelector(sel);
        const bind = (sel, key, read) => {
            const el = q(sel);
            if (el) el.onchange = () => { queueSettings[key] = read(el); saveQueueSettings(); renderQueueSidebar(); };
        };
        bind('#sq-autorefill', 'autoRefill', el => el.checked);
        bind('#sq-target', 'targetSize', el => Math.max(1, parseInt(el.value, 10) || 5));
        bind('#sq-count', 'count', el => parseInt(el.value, 10) || 20);
        bind('#sq-rating', 'minRating', el => parseInt(el.value, 10) || 0);
        bind('#sq-duration', 'maxDuration', el => parseInt(el.value, 10) || 0);
        bind('#sq-unseen', 'unseenOnly', el => el.checked);
        bind('#sq-nffilter', 'useNfFilter', el => el.checked);
        bind('#sq-fresh', 'freshEvery', el => Math.max(0, parseInt(el.value, 10) || 0));
        bind('#sq-fresh-fs', 'freshEveryFs', el => Math.max(0, parseInt(el.value, 10) || 0));
        q('#sq-tag').onchange = () => { queueSettings.tagFilter = q('#sq-tag').value; saveQueueSettings(); };

        q('#sq-generate').onclick = () => {
            queueSettings.tagFilter = q('#sq-tag').value;
            saveQueueSettings();
            const generated = generateSmartQueue(queueSettings)
                .filter(c => !manuallyAddedIds.has(c.id))
                .map(c => ({ id: c.id, href: knownHrefForId(c.id), meta: resolveQueueMeta(c.id) }));
            const added = [...manuallyAddedIds].map(id => {
                const existing = smartQueueItems.find(it => it.id === id);
                return { id, href: existing?.href || knownHrefForId(id), meta: resolveQueueMeta(id) };
            });
            if (smartQueueItems.length) snapshotQueue(`Before "Fill from your playlists" \u2022 ${smartQueueItems.length} videos`);
            smartQueueItems = [...added, ...generated];
            smartQueueActive = true;

            if (smartQueueItems.length) {
                renderQueueSidebar();
            } else {
                const st = q('#sq-status');
                st.textContent = State.videoMeta.size === 0
                    ? 'Nothing cached yet \u2014 browse around or refresh playlists.'
                    : 'Nothing matched these filters.';
            }
        };

        const prevList = q('#sq-prev-list');
        if (prevList) prevList.onclick = e => {
            const b = e.target.closest('[data-sq-prev]');
            if (!b) return;
            e.preventDefault(); e.stopPropagation();
            restoreQueueSnapshot(loadPrevQueues()[+b.dataset.sqPrev]);
        };

        const savedList = q('#sq-saved-list');
        const redrawSaved = () => { if (savedList) savedList.innerHTML = savedQueuesHtml(); };
        const copyItems = items => items.filter(it => it?.id).map(it => ({ id: it.id, href: it.href, meta: it.meta ? { ...it.meta } : {} }));
        const saveBtn = q('#sq-save');
        if (saveBtn) saveBtn.onclick = () => {
            const items = copyItems(smartQueueItems.slice(Math.max(0, queueCursor)));
            if (!items.length) { toast('Up next is empty'); return; }
            const input = q('#sq-save-name');
            const name = (input.value || '').trim() || `Queue ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
            const list = loadSavedQueues().filter(x => x.name !== name);
            list.unshift({ name, at: Date.now(), items });
            if (!storeSavedQueues(list)) { toast('Could not save (storage full)', 'red'); return; }
            input.value = '';
            redrawSaved();
            toast(`\u2713 Saved "${name}" (${items.length} videos)`, 'green');
        };
        if (savedList) savedList.onclick = e => {
            const b = e.target.closest('button');
            if (!b) return;
            e.preventDefault();
            e.stopPropagation();
            const list = loadSavedQueues();
            const idx = +(b.dataset.sqLoad ?? b.dataset.sqAppend ?? b.dataset.sqDel);
            const saved = list[idx];
            if (!saved) return;
            if (b.dataset.sqDel !== undefined) {
                if (b.dataset.armed !== '1') {
                    b.dataset.armed = '1'; b.textContent = 'Delete?';
                    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = '\u2715'; } }, 3000);
                    return;
                }
                list.splice(idx, 1);
                storeSavedQueues(list);
                redrawSaved();
                return;
            }
            const items = copyItems(saved.items);
            if (b.dataset.sqLoad !== undefined) {
                if (upcomingCount() > 0 && b.dataset.armed !== '1') {
                    b.dataset.armed = '1'; b.textContent = 'Replace?';
                    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Load'; } }, 3000);
                    return;
                }
                if (smartQueueItems.length) snapshotQueue(`Replaced by "${saved.name}" \u2022 ${smartQueueItems.length} videos`);
                smartQueueItems = items;
                queueCursor = -1;
                dismissedCurrentId = null;
                queueHistoryShown = QUEUE_HISTORY_SHOWN;
            } else {
                const have = new Set(smartQueueItems.map(it => it.id));
                smartQueueItems = smartQueueItems.concat(items.filter(it => !have.has(it.id)));
            }
            // Loaded videos count as added by hand, so auto-refill never swaps them out.
            items.forEach(it => manuallyAddedIds.add(it.id));
            smartQueueActive = true;
            toast(b.dataset.sqLoad !== undefined ? `Loaded "${saved.name}" (${items.length} videos)` : `Added "${saved.name}" to Up next`, 'green');
            renderQueueSidebar();
        };
    }

    function openQueueSettings() {
        if (!findVisibleRecommendedContainer()) {
            toast('Up next appears on a video page, next to "Recommended"');
            return;
        }
        queueSettingsOpen = true;
        queueCollapsed = false;
        renderQueueSidebar();
        document.getElementById('pmv-sq-set')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function getCurrentVideoId() {
        // Playlist pages: the active queue row (border-orange-500) wins over currentVideoData (lags a step on
        // advance) and the poster (its hex is a thumbnail asset id).
        if (location.pathname.startsWith('/playlists/')) {
            const active = getActiveQueueVideoId();
            if (active) return active;
        }
        if (State.currentVideoData?.id) return State.currentVideoData.id;

        // /video/ pages: the URL hex (slug id or API _id) is the only reliable id before any API response.
        // Must precede the poster fallback: a poster hex is a thumbnail asset id, not a video _id.
        const pageId = location.pathname.match(/^\/video\/(?:[^?#]*_)?([0-9a-f]{24})(?:[?#]|$)/i)?.[1];
        if (pageId) return State.slugToApiId.get(pageId) || pageId;

        const v = getVideo();
        if (v?.poster) {
            const m = v.poster.match(/\/([a-f0-9]{24})/);
            if (m) return m[1];
        }

        const link = document.querySelector('a[href*="/videos/"][aria-current="page"], a[href*="/videos/"].active');
        if (link) {
            const m = link.href.match(/\/videos\/([a-f0-9]{24})/);
            if (m) return m[1];
        }

        return getJsonLdVideoId();
    }

    // Vue often hydrates from SSR without a client fetch, so fetch here (deduped) to fill
    // State.currentVideoData; adopted only if it is still the video on screen.
    function ensureCurrentVideoData(videoId) {
        if (!videoId || State.currentVideoData?.id === videoId) return;
        if (lookupOnCooldown(videoId)) return;
        fetchVideoDeduped(videoId).then(v => {
            if (!v?._id || State.currentVideoData?.id === v._id) return;
            if (videoId !== v._id) State.slugToApiId.set(videoId, v._id);
            const cur = getCurrentVideoId();
            if (cur !== videoId && cur !== v._id) return;
            adoptCurrentVideo(v);
        }).catch(() => noteLookupFailure(videoId));
    }

    // Links use `oldId` when present, else `_id`; API responses and __NUXT_DATA__ carry both, so slug -> _id
    // mappings are learned without per-card lookups. Returns the number of new mappings.
    const HEX24_RE = /^[0-9a-f]{24}$/i;
    function learnVideoId(id, oldId) {
        if (typeof id !== 'string' || !HEX24_RE.test(id)) return 0;
        if (typeof oldId === 'string' && HEX24_RE.test(oldId) && oldId !== id) {
            if (State.slugToApiId.get(oldId) === id) return 0;
            State.slugToApiId.set(oldId, id);
            return 1;
        }
        if (State.slugToApiId.has(id)) return 0;
        State.slugToApiId.set(id, id);
        return 1;
    }

    function learnVideoIds(root) {
        let added = 0, guard = 0;
        const stack = [root];
        while (stack.length && guard++ < 300000) {
            const o = stack.pop();
            if (!o || typeof o !== 'object') continue;
            if (Array.isArray(o)) {
                for (const x of o) if (x && typeof x === 'object') stack.push(x);
                continue;
            }
            if (typeof o._id === 'string' && typeof o.title === 'string'
                && ('duration' in o || 'previewUrl' in o || 'oldId' in o)) {
                added += learnVideoId(o._id, o.oldId);
            }
            for (const k in o) {
                const v = o[k];
                if (v && typeof v === 'object') stack.push(v);
            }
        }
        return added;
    }

    // Nuxt's payload is devalue's flat array: objects hold indices into it.
    function learnVideoIdsFromNuxtPayload() {
        const el = document.getElementById('__NUXT_DATA__');
        if (!el || el.dataset.pmvLearned) return 0;
        el.dataset.pmvLearned = '1';
        let arr;
        try { arr = JSON.parse(el.textContent); } catch { return 0; }
        if (!Array.isArray(arr)) return 0;
        const val = ref => (typeof ref === 'number' ? arr[ref] : ref);
        // Resolves indices, arrays of indices and devalue's Reactive/Ref wrappers.
        const res = (ref, depth = 0) => {
            if (typeof ref !== 'number' || ref < 0 || depth > 4) return typeof ref === 'number' ? undefined : ref;
            const x = arr[ref];
            if (Array.isArray(x)) {
                if (typeof x[0] === 'string' && /^(Reactive|ShallowReactive|Ref|ShallowRef)$/.test(x[0])) return res(x[1], depth + 1);
                return x.map(r => res(r, depth + 1));
            }
            return x;
        };
        const FIELDS = ['_id', 'title', 'duration', 'tags', 'top5Tags', 'starsTags', 'bayesianRating', 'width', 'height',
            'uploaderUsername', 'uploader', 'thumbnailUrl', 'previewUrl', 'uploadDate', 'views', 'description',
            ...CONTENT_FLAGS.map(([k]) => k)];
        let added = 0;
        const videos = [];
        for (const o of arr) {
            if (!o || typeof o !== 'object' || Array.isArray(o) || !('_id' in o) || !('title' in o)) continue;
            if (!('duration' in o || 'previewUrl' in o || 'oldId' in o)) continue;
            added += learnVideoId(val(o._id), val(o.oldId));
            // SSR lists (homepage first page) never pass the fetch interceptor; read their metadata here.
            if (!('tags' in o || 'top5Tags' in o)) continue;
            const v = {};
            FIELDS.forEach(k => { if (k in o) v[k] = res(o[k]); });
            if (typeof v._id === 'string' && typeof v.title === 'string') videos.push(v);
        }
        if (videos.length) { try { indexVideoDetails(videos); } catch {} }
        return added;
    }

    function getMatches(videoId) {
        if (!videoId) return [];
        const ids = State.reverse.get(videoId);
        if (!ids) return [];
        return [...ids].map(id => State.playlists.get(id)).filter(Boolean);
    }

    function getMeta() {
        // During a fullscreen hand-over the page still shows the previous video; use only fetched data.
        const pageIsBehind = !!staleFullscreenHref;

        const liveTitle = pageIsBehind ? null :
            document.querySelector('.min-w-0 h1')?.textContent?.trim() ||
            document.querySelector('h1')?.textContent?.trim();

        // Creator: orange gradient h3, text nodes only (skips the "Creator" badge).
        let liveCreator = null;
        const uploaderH3 = pageIsBehind ? null : document.querySelector('h3.bg-gradient-to-r.from-orange-400');
        if (uploaderH3) {
            const text = [...uploaderH3.childNodes]
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent).join('').trim();
            if (text) liveCreator = text;
        }
        // Fallback: the "More from X (N)" h3.
        if (!liveCreator && !pageIsBehind) {
            const h3s = document.querySelectorAll('h3[class]');
            for (const h of h3s) {
                const t = h.textContent.trim();
                if (t.startsWith('More from ')) {
                    liveCreator = t.replace(/^More from /, '').replace(/\s*\(\d+\)$/, '').trim() || null;
                    break;
                }
            }
        }

        const domTags = pageIsBehind ? [] : [...document.querySelectorAll('a[href^="/search?tags="]')]
            .slice(0, 15)
            .map(a => (a.getAttribute('title')?.replace(/^Search for '|'$/g, '') ||
                       a.textContent.replace(/^#/, '')).trim())
            .filter(Boolean);

        // Performers: /search?stars= or /model/ links; /model/ titles read "View <name>'s profile", so use the text.
        const domStars = pageIsBehind ? [] : [...document.querySelectorAll('a[href^="/search?stars="], a[href^="/model/"]')]
            .slice(0, 10)
            .map(a => (a.querySelector('.truncate')?.textContent || a.textContent || '').replace(/^#/, '').trim())
            .filter(Boolean);

        let liveDescription = null;
        const descBlock = pageIsBehind ? null : document.querySelector('div.bg-\\[\\#1A1A1A\\] p.whitespace-pre-wrap, div.bg-\\[\\#1A1A1A\\] p.text-gray-300');
        if (descBlock) liveDescription = descBlock.textContent.trim() || null;

        let ldCreator = null, ldDescription = null;
        try {
            const jsonLd = pageIsBehind ? null : document.querySelector('script[type="application/ld+json"]');
            if (jsonLd) {
                const data = JSON.parse(jsonLd.textContent);
                if (data['@type'] === 'VideoObject') {
                    ldCreator = data.creator?.name || null;
                    ldDescription = data.description || null;
                }
            }
        } catch {}

        return {
            title: liveTitle || State.currentVideoData?.title || document.querySelector('meta[property="og:title"]')?.content || 'Unknown',
            creator: liveCreator || State.currentVideoData?.creator || ldCreator || 'Unknown',
            tags: domTags.length ? domTags : (State.currentVideoData?.tags || []).slice(0, 15),
            starsTags: domStars.length ? domStars : (State.currentVideoData?.starsTags || []).slice(0, 10),
            description: liveDescription || ldDescription || State.currentVideoData?.description || null,
        };
    }

