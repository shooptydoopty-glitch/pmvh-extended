    // --- Homepage state across Back / Forward ---
    // The site's homepage resets its filters and page on return. Its saved-search component's props getCurrentFilters()
    // and onLoad(filters) (found via Vue's vnode tree from #__nuxt) let us keep filters, depth, page and scroll per tab
    // (sessionStorage) and restore them on Back/Forward, not on a fresh visit. Logged in only: the component needs it.
    const HOME_STATE_KEY = 'pmvx_home_state_v1';
    function homeFilterProps() {
        const root = document.querySelector('#__nuxt')?._vnode;
        if (!root) return null;
        const seen = new Set(), stack = [root];
        while (stack.length) {
            const v = stack.pop();
            if (!v || typeof v !== 'object' || seen.has(v)) continue;
            seen.add(v);
            const pr = v.props;
            if (pr && typeof pr.getCurrentFilters === 'function' && typeof pr.onLoad === 'function') return pr;
            if (v.component) stack.push(v.component.subTree);
            if (v.suspense) stack.push(v.suspense.activeBranch);
            if (Array.isArray(v.children)) for (const c of v.children) stack.push(c);
            if (seen.size > 20000) break;
        }
        return null;
    }
    // Copy of "Saved Searches" next to "More Filters" (the site hides it in the folded panel); it clicks the
    // original to open the site's dialog. Vue owns the row, so a 1 s check re-inserts it.
    function nativeSavedSearchesBtn() {
        return [...document.querySelectorAll('.filter-panel-wrapper button')]
            .find(b => !b.dataset.pmvSavedShortcut && /^Saved Searches/.test(b.textContent.trim())) || null;
    }
    function ensureSavedSearchShortcut() {
        const cur = document.querySelector('[data-pmv-saved-shortcut]');
        const mf = [...document.querySelectorAll('button')].find(b => !b.dataset.pmvSavedShortcut && b.textContent.trim() === 'More Filters');
        const native = mf ? nativeSavedSearchesBtn() : null;
        if (!mf || !native) { cur?.remove(); return; }
        let b = cur;
        if (!b || b.parentElement !== mf.parentElement) {
            cur?.remove();
            b = document.createElement('button');
            b.type = 'button';
            b.dataset.pmvSavedShortcut = '1';
            b.className = 'flex items-center gap-2 text-sm px-3 py-2.5 rounded-lg border transition-colors bg-[#1A1A1A] border-[#2A2A2A] hover:bg-[#232323] text-gray-300';
            b.style.flexShrink = '0';
            b.title = 'Saved searches';
            b.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                const n = nativeSavedSearchesBtn();
                if (n) n.click(); else toast('Saved searches not available');
            });
            mf.after(b);
        }
        if (b._pmvSrc !== native.innerHTML) {
            b._pmvSrc = native.innerHTML;
            b.innerHTML = native.innerHTML;
        }
    }
    setInterval(() => { if (!document.hidden) { try { ensureSavedSearchShortcut(); } catch {} } }, 1000);

    const isHomePath = () => location.pathname === '/' || location.pathname === '';
    function homeListCount() { return document.querySelectorAll('[data-video-id]').length; }
    function captureHomeState() {
        if (!isHomePath() || homeRestoring) return;
        const pr = homeFilterProps();
        if (!pr) return;
        let filters;
        try { filters = JSON.parse(JSON.stringify(pr.getCurrentFilters() || {})); } catch { return; }
        const paging = siteListPaging();
        const state = { filters, count: homeListCount(), page: paging?.page || 1, infinite: !!paging?.infinite, scrollY: Math.round(scrollY), at: Date.now() };
        try { sessionStorage.setItem(HOME_STATE_KEY, JSON.stringify(state)); } catch {}
    }
    let homeRestoring = false;
    let homeBackNav = false;
    async function restoreHomeState() {
        homeRestoring = true;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        try {
            let saved;
            try { saved = JSON.parse(sessionStorage.getItem(HOME_STATE_KEY) || 'null'); } catch { saved = null; }
            if (!saved || Date.now() - saved.at > 6 * 60 * 60 * 1000) return;
            let pr = null;
            for (let i = 0; i < 40 && isHomePath() && !(pr = homeFilterProps()); i++) await wait(250);
            if (!pr || !isHomePath()) return;
            const now = JSON.stringify(pr.getCurrentFilters() || {});
            if (now !== JSON.stringify(saved.filters || {})) {
                pr.onLoad(saved.filters || {});
                await wait(600);
            }
            // Same depth: pages mode → saved page; autoscroll → load batches until the count is back.
            const paging = siteListPaging();
            if (paging && !paging.infinite && saved.page > 1) {
                for (let i = 0; i < 20 && siteListPaging()?.pending; i++) await wait(250);
                const btn = [...document.querySelectorAll('nav[aria-label="Pagination"] button, [aria-label="Pagination"] button')]
                    .find(b => b.textContent.trim() === String(saved.page));
                btn?.click();
                await wait(800);
            } else if (saved.count > homeListCount()) {
                const target = Math.min(saved.count, 100); // the site keeps ~100 cards
                for (let i = 0; i < 12 && isHomePath() && homeListCount() < target; i++) {
                    window.scrollTo(0, document.documentElement.scrollHeight);
                    window.dispatchEvent(new Event('scroll'));
                    await wait(700);
                }
            }
            for (let i = 0; i < 20 && siteListPaging()?.pending; i++) await wait(250);
            if (isHomePath()) window.scrollTo({ top: saved.scrollY || 0, left: 0, behavior: 'auto' });
        } catch {} finally {
            homeRestoring = false;
        }
    }
    // Capture before the route changes (homepage still mounted), on link clicks and regularly.
    (() => {
        PMVX.beforeRoute(() => { try { captureHomeState(); } catch {} });
        document.addEventListener('click', e => { if (e.target.closest?.('a[href]')) { try { captureHomeState(); } catch {} } }, true);
        setInterval(() => { if (isHomePath() && !document.hidden) { try { captureHomeState(); } catch {} } }, 2000);
        window.addEventListener('pagehide', () => { try { captureHomeState(); } catch {} });
        // popstate fires before the router renders the homepage: hold capture off so the reset page isn't saved.
        window.addEventListener('popstate', () => {
            homeBackNav = true;
            homeRestoring = true;
            setTimeout(() => {
                if (homeBackNav && isHomePath()) restoreHomeState(); else homeRestoring = false;
                homeBackNav = false;
            }, 50);
        });
        // A Back that reloads (bfcache miss) is a back_forward navigation.
        try {
            const nav = performance.getEntriesByType('navigation')[0];
            if (nav?.type === 'back_forward' && isHomePath()) { homeRestoring = true; setTimeout(restoreHomeState, 300); }
        } catch {}
    })();

    // --- Pagination ---
    // A filter hiding most of a page breaks both modes. Autoscroll off: a page (`videosPerPage`, API cap 100) is replaced,
    // so a strict filter can leave one card; raise it. Autoscroll on: the IntersectionObserver sentinel (1000px rootMargin)
    // only reports changes, so a mostly hidden batch stalls loading; the list is windowed (100, trimmed to 60), so top-up stops below.

    const SITE_PREFS_KEY = 'user-preferences-v1';
    const SITE_PAGE_MAX = 100;  // server cap
    const PUMP_CARD_CEILING = 90;  // below the site's 100-item window
    const PUMP_COOLDOWN_MS = 1200;
    const PUMP_MAX_TRIES = 8;
    const SKIP_MAX_PAGES = 10;

    function nuxtState() {
        return document.querySelector('#__nuxt')?.__vue_app__?.config
            ?.globalProperties?.$nuxt?.payload?.state || null;
    }

    // Nuxt keeps list paging in useState keyed by page type ($shomepage-current-page, …), surviving in-page navigation.
    function siteListPaging() {
        const st = nuxtState();
        if (!st) return null;
        const path = location.pathname;
        const prefixes = [];
        if (path === '/') prefixes.push('$shomepage');
        if (path.startsWith('/search')) prefixes.push('$ssearch');
        const suffix = '-current-page';
        Object.keys(st).forEach(k => { if (k.endsWith(suffix)) prefixes.push(k.slice(0, -suffix.length)); });
        for (const pre of prefixes) {
            const page = st[`${pre}-current-page`];
            if (typeof page !== 'number') continue;
            const total = st[`${pre}-total-pages`];
            return {
                page,
                totalPages: typeof total === 'number' && total > 0 ? total : 0,
                pending: st[`${pre}-pending`] === true,
                infinite: st['$suser-prefs-infinite-scroll'] === true,
                perPage: Number(st['$suser-prefs-videos-per-page']) || 0,
            };
        }
        return null;
    }

    // Container with the most cards: the list grid, not a Recommended rail or "More from" strip.
    function mainCardGrid() {
        const counts = new Map();
        let best = null, bestN = 0;
        document.querySelectorAll('a[href*="/video/"]').forEach(card => {
            const parent = card.parentElement;
            if (!parent) return;
            const n = (counts.get(parent) || 0) + 1;
            counts.set(parent, n);
            if (n > bestN) { bestN = n; best = parent; }
        });
        return bestN >= 4 ? best : null;
    }

    // Counted from cards, not data-video-id: an unresolved card counts, so this only waits, never skips a page.
    function listCards() {
        const merged = listChunks();
        const grids = merged ? merged.chunks : [mainCardGrid()].filter(Boolean);
        const cards = [];
        grids.forEach(grid => [...grid.children].forEach(el => {
            if (el.matches('a[href*="/video/"]')) cards.push(el);
        }));
        return cards;
    }

    function listCardCounts() {
        const cards = listCards();
        return {
            total: cards.length,
            visible: cards.filter(el => el.getAttribute('data-pmv-filtered') !== '1').length,
            last: cards[cards.length - 1] || null,
        };
    }

    function siteIsLoadingMore() {
        return !!document.querySelector('.animate-spin');
    }

    // Settles the site prefs the filter depends on (read at site init: apply on next page change or reload).
    // Autoscroll + strict filter = load/filter/trim treadmill (~100 cards kept, oldest dropped), so the site is put
    // on pages while the filter hides things and the user's setting restored after. Big pages only help in that mode.
    function syncSitePrefs() {
        let prefs;
        try { prefs = JSON.parse(localStorage.getItem(SITE_PREFS_KEY) || 'null'); } catch { return; }
        if (!prefs || typeof prefs !== 'object') return;
        let changed = false;

        if (filterConfig.pagedWhenFiltered && filterConfig.active && filterIsMeaningful()) {
            if (prefs.infiniteScrolling !== false) {
                filterConfig.siteInfiniteWas = prefs.infiniteScrolling === true;
                saveFilterConfig();
                prefs.infiniteScrolling = false;
                changed = true;
            }
        } else if (filterConfig.siteInfiniteWas && prefs.infiniteScrolling !== true) {
            filterConfig.siteInfiniteWas = false;
            saveFilterConfig();
            prefs.infiniteScrolling = true;
            changed = true;
        }

        const have = Number(prefs.videosPerPage) || 0;
        const want = filterConfig.bigPages && prefs.infiniteScrolling !== true
            ? SITE_PAGE_MAX
            : (have === SITE_PAGE_MAX ? (Number(filterConfig.sitePageSizeWas) || 32) : have);
        if (want && want !== have) {
            if (want === SITE_PAGE_MAX && have > 0 && filterConfig.sitePageSizeWas !== have) {
                filterConfig.sitePageSizeWas = have;
                saveFilterConfig();
            }
            prefs.videosPerPage = want;
            changed = true;
        }

        if (changed) {
            try { localStorage.setItem(SITE_PREFS_KEY, JSON.stringify(prefs)); } catch {}
        }
    }

    // Observers only report changes: move the sentinel far off (300vh, past the 1000px margin), then into view; into view alone fails on short pages.
    function nudgeInfiniteSentinel(afterEl) {
        const sentinel = [...document.querySelectorAll('div')].find(d =>
            d.className === 'h-4' && (afterEl.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (!sentinel) return false;
        const previous = sentinel.getAttribute('style');
        const park = css => { sentinel.style.cssText = css; };
        const frame = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        (async () => {
            park('position:fixed;top:300vh;left:0;width:1px;height:4px;');
            await frame();
            park('position:fixed;top:0;left:0;width:1px;height:4px;');
            await frame();
            setTimeout(() => {
                if (previous === null) sentinel.removeAttribute('style');
                else sentinel.setAttribute('style', previous);
            }, 120);
        })();
        return true;
    }

    // Prunes hidden items from the site's own list, which it trims past 100 (taking survivors along). Hidden cards
    // are display:none, so nothing moves. Autoscroll + active filter only; floor kept: an empty list drops the sentinel.
    const PRUNE_FLOOR = 8;

    function siteListKey() {
        const st = nuxtState();
        if (!st) return null;
        const suffix = '-accumulated-videos';
        const path = location.pathname;
        const prefixes = [];
        if (path === '/') prefixes.push('$shomepage');
        if (path.startsWith('/search')) prefixes.push('$ssearch');
        Object.keys(st).forEach(k => { if (k.endsWith(suffix)) prefixes.push(k.slice(0, -suffix.length)); });
        for (const pre of prefixes) {
            if (Array.isArray(st[pre + suffix])) return pre + suffix;
        }
        return null;
    }

    // The site's own list length (what its memory limit watches), not the DOM count; they differ briefly after a prune.
    function siteListLength() {
        const st = nuxtState();
        const key = st && siteListKey();
        return key && Array.isArray(st[key]) ? st[key].length : 0;
    }

    function pruneFilteredFromSiteList() {
        if (!filterConfig.active || !filterIsMeaningful()) return 0;
        const paging = siteListPaging();
        if (!paging || !paging.infinite) return 0;
        const st = nuxtState();
        const key = st && siteListKey();
        if (!key) return 0;
        const list = st[key];
        if (!Array.isArray(list) || list.length <= PRUNE_FLOOR) return 0;

        const hidden = new Set();
        document.querySelectorAll('[data-pmv-filtered="1"][data-video-id]').forEach(card => {
            hidden.add(card.getAttribute('data-video-id'));
        });
        if (!hidden.size) return 0;

        const kept = list.filter(item => !hidden.has(String(item?._id ?? item?.id)));
        const dropped = list.length - kept.length;
        if (!dropped) return 0;
        const final = kept.length >= PRUNE_FLOOR ? kept : list.slice(-PRUNE_FLOOR);
        if (final.length === list.length) return 0;
        try { st[key] = final; } catch { return 0; }
        return list.length - final.length;
    }

    // The site renders lists in chunked grids with ads between, leaving short rows. Merge: the parent takes the chunk
    // classes, chunks get display:contents, empty separators collapse, visible banners span the row. Classes are
    // re-applied per pass: Vue patches rewrite class, data-* survives.
    function ensureMergeStyle() {
        if (document.getElementById('pmv-grid-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-grid-style';
        st.textContent =
            '[data-pmv-grid-chunk="1"]{display:contents;}' +
            '[data-pmv-grid-span="1"]{grid-column:1 / -1;}' +
            '[data-pmv-grid-collapse="1"]{display:none !important;}';
        (document.head || document.documentElement).appendChild(st);
    }

    function listChunks() {
        const counts = new Map();
        document.querySelectorAll('a[href*="/video/"]').forEach(card => {
            const parent = card.parentElement;
            if (!parent) return;
            counts.set(parent, (counts.get(parent) || 0) + 1);
        });
        const chunks = [...counts.entries()].filter(([, n]) => n >= 4).map(([el]) => el);
        if (chunks.length < 2) return null;
        const parent = chunks[0].parentElement;
        if (!parent || chunks.some(c => c.parentElement !== parent)) return null;
        // Only chunks with identical classes are one list; other rails sharing the parent must not merge.
        const cls = chunks[0].className || '';
        if (!/(^|\s)grid(\s|$)/.test(cls)) return null;
        if (chunks.some(c => (c.className || '') !== cls)) return null;
        return { parent, chunks };
    }

    function mergeListChunks() {
        if (!filterConfig.mergeGrids) return;
        const found = listChunks();
        if (!found) return;
        ensureMergeStyle();
        const { parent, chunks } = found;

        if (parent.getAttribute('data-pmv-grid-merge') !== '1') {
            // Attribute survives Vue patches and re-init.
            parent.setAttribute('data-pmv-grid-was', parent.className || '');
            parent.setAttribute('data-pmv-grid-merge', '1');
        }
        chunks[0].classList.forEach(cls => { if (!parent.classList.contains(cls)) parent.classList.add(cls); });

        [...parent.children].forEach(child => {
            if (chunks.includes(child)) {
                if (child.getAttribute('data-pmv-grid-chunk') !== '1') child.setAttribute('data-pmv-grid-chunk', '1');
                return;
            }
            // Judged by contents (an empty grid item stretches to row height), every pass so late banners get their row back.
            const empty = ![...child.querySelectorAll('*')]
                .some(el => el.getBoundingClientRect().height > 0);
            if (empty) {
                if (child.getAttribute('data-pmv-grid-collapse') !== '1') {
                    child.removeAttribute('data-pmv-grid-span');
                    child.setAttribute('data-pmv-grid-collapse', '1');
                }
            } else if (child.getAttribute('data-pmv-grid-span') !== '1') {
                child.removeAttribute('data-pmv-grid-collapse');
                child.setAttribute('data-pmv-grid-span', '1');
            }
        });
    }

    function unmergeListChunks() {
        document.querySelectorAll('[data-pmv-grid-merge]').forEach(parent => {
            parent.className = parent.getAttribute('data-pmv-grid-was') || '';
            parent.removeAttribute('data-pmv-grid-was');
            parent.removeAttribute('data-pmv-grid-merge');
        });
        document.querySelectorAll('[data-pmv-grid-chunk],[data-pmv-grid-span],[data-pmv-grid-collapse]').forEach(el => {
            el.removeAttribute('data-pmv-grid-chunk');
            el.removeAttribute('data-pmv-grid-span');
            el.removeAttribute('data-pmv-grid-collapse');
        });
    }

    let pumpState = { key: '', tries: 0, lastAt: 0, lastCards: 0, stalls: 0 };

    function topUpList() {
        const target = Math.max(0, parseInt(filterConfig.topUpTarget, 10) || 0);
        if (!target || !filterConfig.active || !filterIsMeaningful()) return;
        const paging = siteListPaging();
        if (!paging || !paging.infinite || paging.pending) return;

        const key = location.pathname + location.search;
        if (pumpState.key !== key) pumpState = { key, tries: 0, lastAt: 0, lastCards: 0, stalls: 0 };

        const { total, visible, last } = listCardCounts();
        if (!total || !last || visible >= target) return;
        if ((siteListLength() || total) >= PUMP_CARD_CEILING) return;
        if (paging.totalPages && paging.page >= paging.totalPages) return;
        if (pumpState.tries >= PUMP_MAX_TRIES || siteIsLoadingMore()) return;
        if (Date.now() - pumpState.lastAt < PUMP_COOLDOWN_MS) return;

        // Fewer cards than before: the site is trimming (past ~100); more would only feed that, so stop for this page.
        if (pumpState.lastCards && total < pumpState.lastCards) {
            pumpState.tries = PUMP_MAX_TRIES;
            return;
        }
        // Nothing new from a nudge: the site won't deliver (rate limit or window full); stop after two until the next page.
        if (pumpState.lastCards && total === pumpState.lastCards && ++pumpState.stalls >= 2) {
            pumpState.tries = PUMP_MAX_TRIES;
            return;
        }
        if (total > pumpState.lastCards) pumpState.stalls = 0;

        pumpState.lastAt = Date.now();
        pumpState.tries++;
        pumpState.lastCards = total;
        if (nudgeInfiniteSentinel(last)) {
            // A nudge that loads nothing causes no mutation, so the badge pass would never notice.
            setTimeout(topUpList, PUMP_COOLDOWN_MS + 400);
        }
    }

    let skipState = { key: '', seen: 0, done: 0 };

    function skipThinPage() {
        const below = Math.max(0, parseInt(filterConfig.skipBelow, 10) || 0);
        if (!below || !filterConfig.active || !filterIsMeaningful()) return;
        const paging = siteListPaging();
        if (!paging || paging.infinite || paging.pending) return;
        if (!paging.totalPages || paging.page >= paging.totalPages) return;

        const { total, visible } = listCardCounts();
        if (!total) return;

        const key = `${location.pathname}${location.search}#${paging.page}`;
        if (skipState.key !== key) skipState = { key, seen: 0, done: skipState.done };
        if (visible >= below) { skipState.seen = 0; return; }

        // Playlist membership and ratings resolve late: skip only if still thin on a second look.
        if (++skipState.seen < 2) { setTimeout(skipThinPage, 1500); return; }
        if (skipState.done >= SKIP_MAX_PAGES) return;

        const next = [...document.querySelectorAll('button')]
            .find(b => b.textContent.trim() === '»' && !b.disabled);
        if (!next) return;
        skipState.done++;
        toast(`Page ${paging.page}: ${visible} of ${total} left — next page`);
        next.click();
    }

