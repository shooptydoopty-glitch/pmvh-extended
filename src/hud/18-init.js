    // --- Init ---

    function init() {
        const hasCache = loadCache();
        try { learnVideoIdsFromNuxtPayload(); } catch {}

        try {
            observer.observe(document.body, { childList: true, subtree: true });
        } catch {}

        getVideo();
        forceVolume100({ silent: true });
        onPossibleVideoChange();
        // Before the playlist cache: the header filter only needs title/rating/length.
        try { attachFilterButton(); } catch {}
        try { applyFilterToCards(); } catch {}
        // The bar is positioned off the header row's box.
        window.addEventListener('resize', () => { hdrDirty = true; try { ensureHeaderBar(); } catch {} });
        // Written as early as possible: the site reads its page size at init.
        try { syncSitePrefs(); } catch {}

        if (!hasCache) {
            refreshUserPlaylists({ force: true }).then(() => {
                scheduleBadges();
                kickRecommended();
            }).catch(e => {
            });
        } else {
            scheduleBadges();
            kickRecommended();
            requestAnimationFrame(() => updateNativePlaylistButtons(true));
            refreshUserPlaylists({ force: false }).then(() => {
                scheduleBadges();
                kickRecommended();
            }).catch(e => {
            });
        }



    }

    // Fetch interceptor is live from document-start; init() waits for "load" (also fires in background tabs).
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init, { once: true });
    }
