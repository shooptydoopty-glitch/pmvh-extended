    // --- Up next override ---
    // Up next box shows the first visible row after the active one; Vue's playback pointer is untouched.

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

        // Override also for a sort alone: Vue's up next follows its own unsorted order.
        if (!hasFilter && !sortedRowIds) {
            upWrap.style.removeProperty('display');
            const overlay = upWrap.querySelector('#pmvnf-upnext-overlay');
            if (overlay) overlay.remove();
            upNextOverrideActive = false;
            return;
        }

        // With a sort, Vue's up next is always wrong.
        if (!sortedRowIds) {
            const upNextPasses = upNextPassesFilter(upBtn, tokens);
            if (upNextPasses) {
                const overlay = upWrap.querySelector('#pmvnf-upnext-overlay');
                if (overlay) overlay.remove();
                upWrap.style.removeProperty('display');
                upNextOverrideActive = false;
                return;
            }
        }

        let nextVisible;
        if (sortedRowIds) {
            nextVisible = getSortAwareNextRow();
        } else {
            const rows = queueRows();
            const activeIdx = rows.findIndex(r => r.classList.contains('border-orange-500'));
            nextVisible = null;
            for (let i = activeIdx + 1; i < rows.length; i++) {
                if (rows[i].style.display !== 'none') { nextVisible = rows[i]; break; }
            }
        }

        if (!nextVisible) {
            upWrap.style.display = 'none';
            upNextOverrideActive = false;
            return;
        }

        const nextTitle = nextVisible.querySelector('h4, p')?.textContent?.trim() || '';
        const nextImg   = nextVisible.querySelector('img[src]');

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

    // --- Vue input patch ---
    // Vue's v-model only reacts to InputEvents, so the value is set via a dispatched event.
    // Never pass text tokens: Vue matches titles only and would drop tag/performer matches.

    function syncToVue(ownValue) {
        if (!NF.input) return;

        const vueValue = '';

        if (NF.input.value === vueValue) return;

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

    const DURATION_SLIDER_MAX_MIN = 60; // minutes; top end = no limit


    // --- Fetch all ---
    // Loads the whole playlist (PMVX.forceFetchAllNext -> fetchAll=true in the core's interceptor);
    // tag/performer filtering needs videoMeta for every row.
    let manualFetchAllRunning = false;

    async function runManualFetchAll(statusEl, btnEl) {
        if (manualFetchAllRunning) return;
        manualFetchAllRunning = true;
        btnEl.disabled = true;
        statusEl.textContent = 'loading…';
        statusEl.style.color = 'rgba(255,255,255,0.4)';

        const { ok, waitedMs } = await runFetchAllCycle({ maxWaitMs: 20000 });
        if (!ok) {
            statusEl.textContent = 'no queue found';
            statusEl.style.color = 'rgb(252,165,165)';
            btnEl.disabled = false;
            manualFetchAllRunning = false;
            return;
        }

        const { total, withMeta, unknownId } = getMetaCoverage();

        if (total > 0 && withMeta === total) {
            statusEl.textContent = `${withMeta}/${total} metadata complete`;
            statusEl.style.color = 'rgb(134,239,172)';
        } else {
            statusEl.textContent = `${withMeta}/${total} metadata${unknownId ? ` (${unknownId} unknown)` : ''}`;
            statusEl.style.color = 'rgb(253,186,116)';
        }

        applyFilter(NF.lastOwnValue, true);

        btnEl.disabled = false;
        manualFetchAllRunning = false;
    }

    // --- Sorting ---
    // CSS order from cached metadata, loaded rows only; DOM order and Vue's index stay intact
    // (the deeplink catch-up and Up next assume DOM order == playlist order).

    let sortedRowIds = null; // video IDs in sort order
    let currentSortMode = null;
    let ratingSortAscending = false; // mode 'rating' only

    // Next visible row by the active sort; for triggerNextKey()/attachNIntercept().
    function getSortAwareNextRow() {
        if (!sortedRowIds) return null;
        const rows = queueRows();
        const byId = new Map(rows.map(r => [getRowVideoId(r), r]));
        const activeRow = rows.find(r => r.classList.contains('border-orange-500'));
        const activeId = activeRow ? getRowVideoId(activeRow) : null;
        const startPos = activeId ? sortedRowIds.indexOf(activeId) : -1;
        for (let i = startPos + 1; i < sortedRowIds.length; i++) {
            const r = byId.get(sortedRowIds[i]);
            if (!r) continue; // not in the DOM (yet)
            if (rowShouldBeHidden(r)) continue;
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
        const list = queueRows()[0]?.parentElement;
        if (!list) return;
        const rows = Array.from(list.querySelectorAll(':scope > [role="button"]'));
        if (!rows.length) return;

        // Only CSS order, never DOM order: moving nodes would re-trigger the childList observer
        // (re-filtering), and Vue re-renders would undo it.
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

        // No metadata: bottom. Rows added later stay at order:0 until re-sorted.
        [...withMeta.map(x => x.row), ...withoutMeta].forEach((r, i) => {
            r.style.order = String(i + 1);
        });
        sortedRowIds = [...withMeta.map(x => x.row), ...withoutMeta].map(r => getRowVideoId(r));

        if (withoutMeta.length) {
            updateCounter(`sorted (${withoutMeta.length} rows without metadata at the bottom)`);
        }
    }

    function resetSort() {
        const list = queueRows()[0]?.parentElement;
        if (list) {
            Array.from(list.querySelectorAll(':scope > [role="button"]'))
                .forEach(r => r.style.removeProperty('order'));
        }
        sortedRowIds = null;
        currentSortMode = null;
        saveSortSettings();
    }

    // Merged into the SETTINGS_KEY blob; restoreSortSettings() reads it after loadSettings().
    function saveSortSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const s = raw ? JSON.parse(raw) : {};
            s.sortMode = currentSortMode;
            s.sortAscending = ratingSortAscending;
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        } catch {}
    }

