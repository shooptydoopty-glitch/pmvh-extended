    // --- Up next panel: settings, Previous queues, Saved queues, Undo ---
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
        return list.map(q => {
            const when = q.at ? new Date(q.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
            return `<div class="flex items-center gap-2" style="margin-bottom:4px;">
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;" title="${escHtml(q.name)}">${escHtml(q.name)}</span>
                <span class="text-gray-500" style="white-space:nowrap;">${q.items.length} \u2022 ${escHtml(when)}</span>
                <button type="button" class="${Q_CHIP_ON}" style="cursor:pointer;" data-sq-load="${q.at}" title="Replace Up next with this queue">Load</button>
                <button type="button" class="${Q_CHIP_OFF}" style="cursor:pointer;" data-sq-append="${q.at}" title="Add these videos to the end of Up next">Add</button>
                <button type="button" class="${Q_CHIP_OFF}" style="cursor:pointer;" data-sq-del="${q.at}" title="Delete (click twice)">\u2715</button>
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
            // Hand-added videos that were already played stay out; the new queue starts unplayed.
            const played = new Set(smartQueueItems.slice(0, queueCursor + 1).map(it => it.id));
            const added = [...manuallyAddedIds].filter(id => !played.has(id)).map(id => {
                const existing = smartQueueItems.find(it => it.id === id);
                return { id, href: existing?.href || knownHrefForId(id), meta: resolveQueueMeta(id) };
            });
            if (smartQueueItems.length) snapshotQueue(`Before "Fill from your playlists" \u2022 ${smartQueueItems.length} videos`);
            smartQueueItems = [...added, ...generated];
            queueCursor = -1;
            dismissedCurrentId = null;
            queueHistoryShown = QUEUE_HISTORY_SHOWN;
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
            if (list.length >= SAVED_QUEUES_MAX) { toast(`${SAVED_QUEUES_MAX} saved queues: delete one first`, 'red'); return; }
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
            // By save time, not position: another tab may have changed the list since it was drawn.
            const at = b.dataset.sqLoad ?? b.dataset.sqAppend ?? b.dataset.sqDel;
            const idx = list.findIndex(x => String(x.at) === at);
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

    // --- Up next refill ---
    function scoreRecommendedCandidate(id, card, tagScores) {
        const meta = State.videoMeta.get(id);
        if (meta) {
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
        const tagScores = computeTagAffinity(); // loops over all known videos: once per top-up, not per card
        container.querySelectorAll('.w-40').forEach(thumbDiv => {
            const card = thumbDiv.parentElement;
            if (!card) return;
            const slugId = resolveRecCardVideoId(card);
            if (!slugId) return;
            const apiId = State.slugToApiId.get(slugId) || slugId;
            if (existingIds.has(apiId)) return;
            const meta = resolveQueueMeta(apiId, card);
            if (useFilter && !passesFilter(apiId, meta)) { rejected++; return; }
            candidates.push({ id: apiId, href: cardHref(card), meta, score: scoreRecommendedCandidate(apiId, card, tagScores) });
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
