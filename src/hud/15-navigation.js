    // --- Navigation ---

    function enterQuietMode() {
        State.quietMode = true;
        closeHud();
        setTimeout(() => {
            State.quietMode = false;
            scheduleBadges();
            requestAnimationFrame(() => updateNativePlaylistButtons(true));
            if (document.fullscreenElement) showHud();
        }, QUIET_MS);
    }

    function onPossibleVideoChange() {
        const id = getCurrentVideoId();
        if (!id || id === State.currentVideoId) return;

        State.currentVideoId = id;
        State.pendingRemove = false;
        clearTimeout(State.pendingRemoveTimeout);
        ensureCurrentVideoData(id);
        enterQuietMode();

        if (State.lastSoftCleanVideoId !== id) {
            State.lastSoftCleanVideoId = id;
            State.videosSinceSoftClean += 1;
        }

        unloadFarOffscreenImages();

        if (State.videosSinceSoftClean >= SOFT_CLEAN_EVERY_VIDEOS) {
            State.videosSinceSoftClean = 0;
            setTimeout(softDomClean, 1500);
        }
    }

    // --- Cached player repair ---
    // Nuxt's KeepAlive doesn't remount a reactivated page's player, and the media sweep emptied its
    // <video> while detached; reloadSource() restores it (up to two nudges). Production Vue hides
    // instances, so the player is found by walking the vnode tree (Suspense keeps its branch aside).
    function findPlayerApi() {
        const root = document.querySelector('#__nuxt')?._vnode?.component;
        if (!root) return null;
        const seen = new Set();
        const walk = (vnode, depth) => {
            if (!vnode || typeof vnode !== 'object' || depth > 120) return null;
            const inst = vnode.component;
            if (inst && !seen.has(inst)) {
                seen.add(inst);
                if (inst.exposed && typeof inst.exposed.reloadSource === 'function') return inst.exposed;
                const hit = walk(inst.subTree, depth + 1);
                if (hit) return hit;
            }
            if (vnode.suspense) {
                const hit = walk(vnode.suspense.activeBranch, depth + 1)
                    || walk(vnode.suspense.pendingBranch, depth + 1);
                if (hit) return hit;
            }
            if (vnode.ssContent) {
                const hit = walk(vnode.ssContent, depth + 1);
                if (hit) return hit;
            }
            for (const list of [vnode.children, vnode.dynamicChildren]) {
                if (!Array.isArray(list)) continue;
                for (const child of list) {
                    const hit = walk(child, depth + 1);
                    if (hit) return hit;
                }
            }
            return null;
        };
        try { return walk(root.subTree, 0); } catch { return null; }
    }

    let playerRepairDone = false;

    function repairEmptyPlayer() {
        if (playerRepairDone) return;
        if (!/^\/(video|playlists)\//.test(location.pathname)) return;
        const video = getVideo();
        if (!video) return;
        // Still loading is normal; only a player with no source is nudged.
        if (video.currentSrc || video.getAttribute('src') || video.readyState > 0) return;
        const api = findPlayerApi();
        if (!api) return;
        playerRepairDone = true;
        try { api.reloadSource(); } catch {}
    }

    // URL change detection: popstate plus a title MutationObserver (router pushes skip popstate).
    function onUrlChange() {
        if (location.href === State.lastUrl) return;
        sweepDetachedMediaFor();
        State.lastUrl = location.href;
        if (location.pathname.startsWith('/video/')) videoHopsThisPage++;
        closeHud();
        hideQueueSidebarNow();
        // Reset now so getCurrentVideoId() doesn't return the previous video's ID.
        State.currentVideoData = null;
        // The seekbar preview's second player belongs to the previous video; the next hover rebuilds it.
        try { scrubHide(); scrubDrop(); } catch {}
        try {
            const v = getVideo();
            if (v && !v.paused && !inPlaceHandover) v.pause();
        } catch {}
        setTimeout(() => forceVolume100({ silent: true }), 500);
        setTimeout(() => forceVolume100({ silent: true }), 1500);
        // A page restored from KeepAlive needs a moment to settle; check twice.
        playerRepairDone = false;
        setTimeout(repairEmptyPlayer, 1500);
        setTimeout(repairEmptyPlayer, 3500);
        setTimeout(() => {
            onPossibleVideoChange();
            updateNativePlaylistButtons(true);
        }, 120);
        // Re-badge/re-filter the SSR Recommended sidebar after SPA navigation.
        kickRecommended();
        if (location.pathname.startsWith('/playlists/')) {
            setTimeout(() => {
                try { window.dispatchEvent(new CustomEvent('pmv:playlist-navigate')); } catch {}
            }, 300);
        }
    }

    window.addEventListener('popstate', onUrlChange);

    new MutationObserver(onUrlChange).observe(
        document.querySelector('title') || document.head,
        { childList: true, characterData: true, subtree: true }
    );

    // 2s heartbeat: volume enforcement and video element discovery only.
    setInterval(() => {
        getVideo();
        updateNativePlaylistButtons();
        if (State.ready) { try { ensureRejectBarButton(getCurrentVideoId()); } catch {} }
    }, 2000);

    // --- Context menu ---
    // Playlist menu for a video, opened by the "+" button on cards.

    function closeCtxMenu() {
        document.getElementById('pmv-ctx-menu')?.remove();
    }

    function buildCtxMenu(videoId, x, y, target) {
        closeCtxMenu();
        // Kept so "Open in new tab" can find the card link.
        const _ctxTarget = target || null;

        const menu = document.createElement('div');
        menu.id = 'pmv-ctx-menu';
        menu.style.cssText = [
            'position:fixed',
            `left:${x}px`,
            `top:${y}px`,
            'z-index:2147483647',
            'background:rgba(18,18,18,0.97)',
            'border:1px solid rgba(255,255,255,0.13)',
            'border-radius:10px',
            'padding:6px 0',
            'min-width:210px',
            'max-width:280px',
            'box-shadow:0 8px 32px rgba(0,0,0,0.7)',
            'font-size:13px',
            'color:white',
            'user-select:none',
        ].join(';');

        const openRow = document.createElement('div');
        openRow.style.cssText = [
            'display:flex',
            'align-items:center',
            'gap:8px',
            'padding:8px 14px',
            'cursor:pointer',
            'transition:background .1s',
            'color:oklch(70.5% .213 47.604)',
            'font-weight:500',
        ].join(';');
        openRow.addEventListener('mouseenter', () => { openRow.style.background = 'rgba(255,255,255,0.06)'; });
        openRow.addEventListener('mouseleave', () => { openRow.style.background = ''; });
        openRow.addEventListener('click', e => {
            e.stopPropagation();
            closeCtxMenu();
            const link = _ctxTarget?.closest('a[href*="/video/"]') ||
                         _ctxTarget?.closest('[data-video-id]')?.querySelector('a[href*="/video/"]');
            const href = link?.getAttribute('href');
            if (href) window.open(href, '_blank');
        });

        const openIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        openIcon.setAttribute('viewBox', '0 0 24 24'); openIcon.setAttribute('width', '14'); openIcon.setAttribute('height', '14');
        openIcon.setAttribute('fill', 'none'); openIcon.setAttribute('stroke', 'currentColor');
        openIcon.setAttribute('stroke-width', '2'); openIcon.setAttribute('stroke-linecap', 'round'); openIcon.setAttribute('stroke-linejoin', 'round');
        openIcon.style.flexShrink = '0';
        openIcon.innerHTML = '<path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>';
        const openLabel = document.createElement('span');
        openLabel.textContent = 'Open in new tab';
        openRow.appendChild(openIcon);
        openRow.appendChild(openLabel);
        menu.appendChild(openRow);

        const orangeDivider = document.createElement('div');
        orangeDivider.style.cssText = 'height:1px;background:oklch(70.5% .213 47.604);opacity:0.35;margin:2px 0 6px;';
        menu.appendChild(orangeDivider);

        if (!State.ready || State.playlists.size === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'Loading playlists...';
            empty.style.cssText = 'padding:8px 14px;opacity:.45;';
            menu.appendChild(empty);
        } else {
            [...State.playlists.values()]
                .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
                .forEach(pl => {
                const inPl = pl.ids.has(videoId);
                const customStyle = getPlaylistStyle(pl.name, pl.id);
                const displayName = getPlaylistDisplayName(pl.name, pl.id);
                const colorHex = customStyle ? customStyle.color : FALLBACK_COLOR;
                const activeRgb = hexToRgbStr(colorHex);
                const inactiveRgb = mixToGrayStr(colorHex);
                // Contrast is in text and icon colour only: near gray when not in the playlist, vivid when in it.
                const textColor = inPl ? `rgb(${activeRgb})` : `rgba(${inactiveRgb},0.75)`;
                const hoverBg = `rgba(${inPl ? activeRgb : inactiveRgb},${inPl ? 0.12 : 0.06})`;

                const row = document.createElement('div');
                row.style.cssText = [
                    'display:flex',
                    'align-items:center',
                    'gap:8px',
                    'padding:7px 14px',
                    'cursor:pointer',
                    'transition:background .1s',
                    `color:${textColor}`,
                    `font-weight:${inPl ? '700' : '400'}`,
                ].join(';');

                row.addEventListener('mouseenter', () => {
                    row.style.background = hoverBg;
                });
                row.addEventListener('mouseleave', () => {
                    row.style.background = '';
                });

                const icon = document.createElement('span');
                icon.style.cssText = 'width:14px;flex-shrink:0;font-size:12px;text-align:center;' +
                    (inPl ? `color:rgba(${activeRgb},1);` : `color:rgba(${inactiveRgb},0.5);`);
                icon.textContent = inPl ? '✓' : '+';

                const label = document.createElement('span');
                label.textContent = displayName;
                label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

                row.appendChild(icon);
                row.appendChild(label);

                // The menu stays open: the row is busy during the change, then the menu redraws in place
                // (a reject list change also moves the video out of other playlists).
                row.addEventListener('click', async e => {
                    e.stopPropagation();
                    if (row.dataset.busy) return;
                    row.dataset.busy = '1';
                    row.style.opacity = '0.5';
                    row.style.pointerEvents = 'none';
                    if (inPl) {
                        const ok = await removeFromPlaylist(videoId, pl.id);
                        updateNativePlaylistButtons(true);
                        scheduleBadges();
                        toast(ok ? '✕ ' + displayName : 'Remove failed', ok ? 'red' : null);
                    } else {
                        const ok = await addToPlaylist(videoId, pl.id);
                        updateNativePlaylistButtons(true);
                        scheduleBadges();
                        toast(ok ? '✓ ' + displayName : 'Add failed', ok ? 'green' : null);
                    }
                    // Redraw only if this menu is still open (a click outside closes it).
                    if (document.getElementById('pmv-ctx-menu') === menu) {
                        const btn = menu._pmvBtn;
                        buildCtxMenu(videoId, parseFloat(menu.style.left) || x, parseFloat(menu.style.top) || y, target);
                        const next = document.getElementById('pmv-ctx-menu');
                        if (next && btn) next._pmvBtn = btn;
                    }
                });

                menu.appendChild(row);
            });
        }

        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth)  menu.style.left = Math.max(0, window.innerWidth - rect.width - 8) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top  = Math.max(0, window.innerHeight - rect.height - 8) + 'px';
    }

    document.addEventListener('click', e => {
        if (!e.target.closest('#pmv-ctx-menu')) closeCtxMenu();
    }, true);
    document.addEventListener('scroll', closeCtxMenu, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); }, true);

