    // --- Main flow ---

    function onOwnInput(value) {
        // First Enter/Filter press arms filtering.
        sessionFilterArmed = true;
        PMVX.clearActed();
        if (!NF.enabled) setFilterEnabled(true, { refilter: false });
        try { NF.renderPower?.(); } catch {}

        BTN.playlistMode = pendingPlaylistMode;
        BTN.selectedPlaylistIds = pendingSelectedPlaylistIds.slice();
        BTN.savedSearch = pendingSavedSearch;
        BTN.savedSearchName = pendingSavedSearchName;
        BTN.ratingMin = pendingRatingMin;
        BTN.ratingMax = pendingRatingMax;
        BTN.durationMin = pendingDurationMin;
        BTN.durationMax = pendingDurationMax;
        BTN.flags = { ...pendingFlags };
        updateFlagBtns();
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
        watchVideoList(); // self-heal if Vue replaced the container

        saveSettings();
        syncToVue(value);

        // Two frames so Vue's DOM update lands first.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => applyFilter(value, true));
        });
    }

    function pollNative() {
        // Off the playlist page (or input replaced): stop; attachNativeInput restarts it for a new input.
        if (!NF.input?.isConnected) { clearInterval(NF.pollTimer); NF.pollTimer = null; return; }
        // Self-heal: reattach the observer if Vue replaced the queue container.
        watchVideoList();

        const v = NF.input.value;
        if (v !== NF.lastNativeValue) {
            NF.lastNativeValue = v;
            // Native input changed: re-apply our filters on top of Vue's result.
            if (hasAnyActiveFilter()) {
                requestAnimationFrame(() => applyFilter(NF.lastOwnValue, true));
            }
        }
    }

    let listObserver = null;
    let watchedListContainer = null;

    function watchVideoList() {
        const list = queueRows()[0]?.parentElement;
        if (!list) return;

        // Reattach if Vue replaced the container (old observer watches a detached node).
        if (listObserver && watchedListContainer === list && document.contains(list)) return;
        if (listObserver) listObserver.disconnect();
        watchedListContainer = list;

        // Coalesced per frame; force: new rows have no display state and the cache guard would skip them.
        const scheduleListFilter = PMVX.scheduler(() => {
            if (hasAnyActiveFilter()) applyFilter(NF.lastOwnValue, true);
        });
        listObserver = new MutationObserver(scheduleListFilter);

        // subtree: placeholder rows are hydrated in place (nested mutation).
        listObserver.observe(list, { childList: true, subtree: true });
    }

    // --- Auto-skip ---

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

    function findNextVisibleRow() {
        const rows = queueRows();
        const activeIdx = rows.findIndex(r => r.classList.contains('border-orange-500'));
        for (let i = activeIdx + 1; i < rows.length; i++) {
            if (!rowShouldBeHidden(rows[i])) return rows[i];
        }
        return null;
    }

    // Intercept N and click the next visible row so Vue never activates a filtered video.
    let nInterceptActive = false;
    function attachNIntercept() {
        if (nInterceptActive) return;
        nInterceptActive = true;
        document.addEventListener('keydown', e => {
            if (e.key !== 'n' && e.key !== 'N') return;
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

            if (sortedRowIds) {
                // With a sort, Vue's DOM-order next is wrong: always click ours.
                const nextRow = getSortAwareNextRow();
                if (!nextRow) return; // end of sort order: native N
                e.stopImmediatePropagation();
                e.preventDefault();
                nextRow.click();
                return;
            }

            // No sort: intercept only if Vue's next row is filtered.
            if (!hasAnyActiveFilter()) return;

            const nextRow = findNextVisibleRow();
            if (!nextRow) return;

            const rows = queueRows();
            const activeIdx = rows.findIndex(r => r.classList.contains('border-orange-500'));
            const vueNext = rows[activeIdx + 1];

            if (!vueNext || !rowShouldBeHidden(vueNext)) return;

            e.stopImmediatePropagation();
            e.preventDefault();
            nextRow.click();
        }, true); // capture: before Vue
    }

    function triggerNextKey() {
        const now = Date.now();
        if (now - lastSkipResetTime > SKIP_CHAIN_WINDOW_MS) {
            skipChainCount = 0;
            lastSkipResetTime = now;
        }
        skipChainCount++;
        if (skipChainCount > SKIP_CHAIN_MAX) {
            console.warn('[PMVH Extended] Auto-skip stopped: too many consecutive skips');
            return;
        }
        if (sortedRowIds) {
            const next = getSortAwareNextRow();
            if (next) { next.click(); return; }
        }
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'n', code: 'KeyN', keyCode: 78, which: 78, bubbles: true
        }));
    }

    function watchActiveRow() {
        if (activeRowObserver) return;

        const container = queueRows()[0]?.parentElement;
        if (!container) return;

        let lastActiveRow = container.querySelector('.border-orange-500');

        activeRowObserver = new MutationObserver(() => {
            const active = container.querySelector('.border-orange-500');
            if (!active || active === lastActiveRow) return;
            lastActiveRow = active;

            if (!hasAnyActiveFilter()) return;
            if (!rowShouldBeHidden(active)) {
                const tokens = parseTokens(NF.lastOwnValue);
                requestAnimationFrame(() => overrideUpNext(tokens));
                return;
            }

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
        // Observes the body (incl. characterData); the box is cached and re-searched at most twice a second.
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

    // --- Deeplink catch-up ---
    // Scrolls the queue so Vue's own lazy-load reaches ?index=; bounded, no own fetch.
    // Thumbnails far behind the target are unloaded; row nodes stay for Vue's v-for.
    const CATCHUP_UNLOAD_BUFFER = 100;
    let catchUpRunning = false;

    // --- Shared fetch-all cycle ---
    // Sets fetchAll, scrolls to the absolute bottom (relative scrollBy is unreliable) and polls until
    // untilPredicate holds or the row count is stable for 3 checks. Updates no UI.
    async function runFetchAllCycle({ untilPredicate = null, maxWaitMs = 20000, pollMs = 400 } = {}) {
        const scrollEl = queueRows()[0]?.closest('.overflow-y-auto');
        if (!scrollEl) return { ok: false, reason: 'no-scroll-container', rowCount: 0, waitedMs: 0 };

        PMVX.forceFetchAllNext = true;
        const kickScroll = () => {
            scrollEl.scrollTop = scrollEl.scrollHeight;
            scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));
        };
        kickScroll();

        let waited = 0;
        let rowCount = queueRows().length;
        let stableTicks = 0;
        let ticksSinceKick = 0;
        let hitPredicate = false;
        while (waited < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollMs));
            waited += pollMs;
            const newCount = queueRows().length;
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
            // Kick on growth or after one stalled tick: the core honors fetchAll only on a page=1 request,
            // and re-kicking during a page fetch re-dispatches scroll and duplicates rows.
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

    function getMetaCoverage() {
        const rows = queueRows();
        const videoMeta = PMVX.state?.videoMeta;
        let withMeta = 0, unknownId = 0;
        rows.forEach(row => {
            const vid = getRowVideoId(row);
            if (!vid) { unknownId++; return; }
            if (videoMeta?.has(vid)) withMeta++;
        });
        return { total: rows.length, withMeta, unknownId };
    }

    // Single-flight, once per filter value (pollNative runs every 300ms).
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

        const startRowCount = queueRows().length;

        // fetchAll=true on Vue's next page fetch: one large fetch instead of many scroll rounds.
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
            const rowsNow = queueRows();
            const activeRow = rowsNow[urlIndex] || document.querySelector('.border-orange-500');
            activeRow?.scrollIntoView({ block: 'center', behavior: 'instant' });
        }

        catchUpRunning = false;
    }

    // Rows more than CATCHUP_UNLOAD_BUFFER before the target: hidden, img.src emptied.
    function hideAndUnloadOutsideWindow(targetIdx) {
        const rows = queueRows();
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

        // ?index=N needs DOM row N, but an SSR load embeds only a first batch and no client fetch.
        try {
            const urlIndex = parseInt(new URLSearchParams(location.search).get('index') || '', 10);
            const rowCount = queueRows().length;
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

    // SPA navigation watcher; at document-start it waits for the body.
    function startObserver() {
        if (!document.body) {
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

    function boot() {
        loadPlaylistCache();
        attachNativeInput();
        checkForStuckHugePlaylist();

        // Retry every 500ms (max 10s) for a slow Vue mount.
        let tries = 0;
        const retryTimer = setInterval(() => {
            if (document.querySelector('#pmvnf-wrap') || ++tries > 20) {
                clearInterval(retryTimer);
                return;
            }
            attachNativeInput();
        }, 500);
    }

    // The site can stall on very large playlists: explain it instead of a silent spinner.
    function checkForStuckHugePlaylist() {
        if (!location.pathname.startsWith('/playlists/')) return;
        setTimeout(() => {
            if (queueRows()[0]) return;
            if (!document.body.innerText.includes('Loading playlist')) return;
            if (document.getElementById('pmvnf-stuck-notice')) return;
            const box = document.createElement('div');
            box.id = 'pmvnf-stuck-notice';
            box.style.cssText = `
                position: fixed; top: 70px; right: 12px; z-index: 999999;
                background: rgba(20,20,20,0.97); border: 1px solid rgba(250,204,21,0.4);
                border-radius: 8px; padding: 10px 14px; max-width: 300px;
                color: rgba(255,255,255,0.85); font-size: 12px;
                font-family:inherit;font-variant-numeric:tabular-nums; line-height: 1.6;
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

    // --- Boot ---
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
        document.addEventListener('visibilitychange', function onVis() {
            if (document.visibilityState !== 'visible') return;
            document.removeEventListener('visibilitychange', onVis);
            safeBoot();
        });
    }

    // The core dispatches this on client-side navigation to /playlists/<id>.
    window.addEventListener('pmv:playlist-navigate', () => {
        bootRan = false;
        setTimeout(safeBoot, 100);
    });

