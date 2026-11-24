    // --- Hotkeys ---
    // Every key is remappable to a built-in action or a playlist. One table drives dispatch and the cheat sheet.
    const KEYBIND_KEY = 'pmv_keybindings_v1';

    const BUILTIN_ACTIONS = {
        showHud: { label: 'Show HUD panel', run: () => showHud() },
        toggleMute: { label: 'Toggle mute', run: () => toggleMute() },
        volume100: { label: 'Set volume to 100%', run: () => setVolume100() },
        nextVideo: {
            label: 'Next video (Up next when it has items; the playlist itself on a playlist page)', run: () => {
                // Up next takes "next" while it has something ahead (the played item becomes history); otherwise
                // false lets the site's N advance. On playlist pages the playlist owns "next".
                syncQueueCursor();
                const next = isPlaylistPage() ? null : smartQueueItems[queueCursor + 1];
                if (next) {
                    goToVideo(next.href, next.id);
                    return true;
                }
                try { maybeShowNextVideoFromUpNext(); }
                catch {}
                return false;
            }
        },
        refreshPlaylists: {
            label: 'Refresh playlists', run: async () => {
                toast('Refreshing playlists...');
                try {
                    await refreshUserPlaylists({ force: true });
                    scheduleBadges();
                    requestAnimationFrame(() => updateNativePlaylistButtons(true));
                    toast('Playlists refreshed');
                } catch (err) {
                    toast('Refresh failed');
                }
            }
        },
        removeFromAll: {
            label: 'Remove from ALL playlists/favourites', run: async () => {
                const videoId = getCurrentVideoId();
                if (!videoId) { toast('No video'); return; }
                const matches = getMatches(videoId);
                if (!matches.length) { toast('Not in any playlist/favourites'); return; }
                const results = await Promise.allSettled(matches.map(pl => removeFromPlaylist(videoId, pl.id)));
                const okCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
                const failCount = matches.length - okCount;
                updateNativePlaylistButtons(true);
                scheduleBadges();
                if (failCount === 0) toast(`\u2715 Removed from ${okCount} playlist${okCount === 1 ? '' : 's'}`, 'red');
                else toast(`\u2715 ${okCount}/${matches.length} removed (${failCount} failed)`);
            }
        },
        playPause: {
            label: 'Play / pause', run: () => {
                const video = getVideo();
                if (!video) return;
                if (video.paused) video.play().catch(() => {});
                else video.pause();
            }
        },
        fullscreen: { label: 'Fullscreen', run: () => toggleVideoFullscreen() },
        seekBack5: { label: 'Seek back 5s', run: () => seekVideoBy(-5) },
        seekForward5: { label: 'Seek forward 5s', run: () => seekVideoBy(5) },
        skipBack10: { label: 'Skip back 10s', run: () => seekVideoBy(-10) },
        toggleFavourite: {
            label: 'Favourite / unfavourite', run: () => {
                // Fullscreen may run ahead of the page (the on-page button is the previous video's), so call directly.
                if (staleFullscreenHref) { toggleFavouriteViaApi(); return; }
                const btn = findFavouriteButton();
                if (!btn) { toast('No favourite button on this page'); return; }
                const wasOn = /^remove/i.test((btn.title || '').trim());
                btn.click();
                toast(wasOn ? '\u2715 Removed from favourites' : '\u2713 Added to favourites', wasOn ? 'red' : 'green');
            }
        },
        rejectVideo: {
            label: 'Reject: move to the reject list, remove from every other playlist, next video',
            run: () => rejectCurrentVideo(),
        },
        cheatSheet: { label: 'Show hotkey overview', run: () => toggleHotkeyCheatSheet() },
        smartQueue: { label: 'Open Up next', run: () => openQueueSettings() },
        addToQueue: { label: 'Add current video to Up next', run: () => addCurrentVideoToQueue() },
        openVideoPage: {
            label: 'Open video page in a new tab', run: () => {
                // For playlist pages (the playing video has no page URL). Uses the playlist buttons' id resolution
                // (API _id or mapped slug, never a poster asset id), slug form preferred.
                const id = getCurrentVideoId();
                if (!id) { toast('No video'); return; }
                const href = knownHrefForId(id) || `/video/${id}`;
                // Synchronous in the key event: a popup opened after an await loses user activation.
                window.open(href, '_blank', 'noopener,noreferrer');
            }
        },
    };

    const DEFAULT_KEYBINDINGS = {
        i: { action: 'builtin:showHud' },
        m: { action: 'builtin:toggleMute' },
        z: { action: 'builtin:volume100' },
        n: { action: 'builtin:nextVideo' },
        r: { action: 'builtin:refreshPlaylists' },
        '?': { action: 'builtin:cheatSheet' },
    };
    function loadKeybindings() {
        try {
            const raw = localStorage.getItem(KEYBIND_KEY);
            if (raw) return JSON.parse(raw);
        } catch {}
        // First run: built-in actions only; playlist keys are assigned in settings (Assign hotkeys).
        const defaults = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
        try { localStorage.setItem(KEYBIND_KEY, JSON.stringify(defaults)); } catch {}
        return defaults;
    }
    let keybindings = loadKeybindings();
    function saveKeybindings() {
        try { localStorage.setItem(KEYBIND_KEY, JSON.stringify(keybindings)); } catch {}
        // Key caps on the playlist buttons under the player.
        try { document.querySelectorAll('#pmv-page-playlists [data-pmv-pl-btn]').forEach(b => syncPageBtnKey(b, b.dataset.pmvPlBtn)); } catch {}
    }

    // Playlist pages: the playlist owns "next" (the site's N). Elsewhere the next Up next item, else the first
    // Recommended card that is neither current nor rejected. The synthetic N bypasses our key dispatcher.
    let dispatchingSyntheticNext = false;


    // Tag-popup after ✕: tag the rejected video, with the calls of the site's Vote on Tags modal:
    //   GET  /api/videos/<id>/tags/stats    -> data.tags [{ tag, userVote }]
    //   POST /api/videos/<id>/tags/suggest  { tag, tagType: 'general' }                      new tag, +1 vote
    //   POST /api/videos/<id>/tags/vote     { tag, voteType: 'upvote', tagType: 'general' }  existing tag
    // Voting again on an upvoted tag removes the vote, so that case is skipped.
    const TAG_AFTER_REJECT_KEY = 'pmv_tag_after_reject_v1';
    const TAG_RECENT_KEY = 'pmv_tag_recent_v1';
    const TAG_MAX_LEN = 50; // the site's limit for general tags
    const TAG_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle></svg>';
    const STAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/></svg>';
    // Tags and stars/models share the endpoints, told apart by tagType; site length limits 50 and 100.
    const TAG_KINDS = {
        general: { recentKey: TAG_RECENT_KEY, max: TAG_MAX_LEN, stats: 'tags', meta: 'tags', noun: 'tag', icon: TAG_SVG, pre: '#' },
        stars: { recentKey: 'pmv_star_recent_v1', max: 100, stats: 'stars', meta: 'starsTags', noun: 'model', icon: STAR_SVG, pre: '' },
    };
    const tagKind = k => TAG_KINDS[k] || TAG_KINDS.general;

    // The site's vocabulary per kind for autocomplete, loaded once.
    const popularTagsP = {};


    // Toggle a mapped playlist (press again within 3 s to confirm removal); the reject list uses rejectCurrentVideo.
    async function handlePlaylistHotkey(playlistId) {
        if (isRejectList(playlistId)) return rejectCurrentVideo();
        const videoId = getCurrentVideoId();
        if (!videoId) { toast('No video'); return; }
        const plName = getPlaylistDisplayName(State.playlists.get(playlistId)?.name, playlistId) || playlistId;
        const isMember = getMatches(videoId).some(p => p.id === playlistId);

        if (isMember) {
            if (State.pendingRemove && State.pendingRemoveVideoId === videoId && State.pendingRemovePlaylistId === playlistId) {
                State.pendingRemove = false;
                clearTimeout(State.pendingRemoveTimeout);
                const ok = await removeFromPlaylist(videoId, playlistId);
                updateNativePlaylistButtons();
                toast(ok ? '✕ ' + plName : 'Remove failed', ok ? 'red' : null);
                return;
            }
            State.pendingRemove = true;
            State.pendingRemoveVideoId = videoId;
            State.pendingRemovePlaylistId = playlistId;
            toast(`Already in "${plName}" - press again to remove`);
            State.pendingRemoveTimeout = setTimeout(() => { State.pendingRemove = false; }, 3000);
            return;
        }

        const wasRejected = isRejected(videoId);
        const ok = await addToPlaylist(videoId, playlistId);
        updateNativePlaylistButtons(true);
        if (wasRejected) scheduleBadges();
        if (!ok) { toast('Add failed'); return; }
        toast('✓ ' + plName + (wasRejected ? ' (removed from reject list)' : ''), 'green');
    }

    // false = the binding declined the key; decided synchronously, as it settles whether the site's handler runs.
    function runBinding(binding) {
        if (!binding) return false;
        if (binding.action === 'playlist') {
            handlePlaylistHotkey(binding.playlistId).catch(() => {});
            return true;
        }
        if (binding.action?.startsWith('builtin:')) {
            const fn = BUILTIN_ACTIONS[binding.action.slice(8)];
            if (!fn) return false;
            const result = fn.run();
            if (result === false) return false;
            if (result && typeof result.catch === 'function') result.catch(() => {});
            return true;
        }
        return false;
    }

    // Bound keys are exclusive: capture phase on window + stopImmediatePropagation hides them from the site
    // (F, space, J, arrows, 0-9, N). Ctrl/Alt/Cmd chords are never hotkeys; run() returning false declines.
    window.addEventListener('keydown', e => {
        if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
        if (dispatchingSyntheticNext) return;
        // The hotkey editor takes letters itself (pressing a key selects it).
        if (document.getElementById('pmv-keyeditor')) return;
        // The fullscreen-resume prompt after a fresh page load takes the next key itself.
        if (document.getElementById('pmvx-fs-resume')) return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
        const binding = keybindings[e.key.toLowerCase()];
        if (!binding) return;
        if (runBinding(binding) === false) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    // --- Player keys ---
    // The site binds its player keys (F, space, J, arrows, 0-9) in onMounted; after a router.push hop they can
    // stop working, so they are reimplemented on the <video> (bubble phase; stand down on preventDefault).
    // Volume keys omitted: the HUD holds volume at 100%.
    function playerFullscreenTarget() {
        const video = getVideo();
        if (!video) return null;
        // Fullscreen the site's wrapper (.hls-player-wrapper), not the <video>, so its fullscreenchange bookkeeping and controls hold.
        return video.closest('.hls-player-wrapper')
            || video.closest('[class*="player"], [class*="video-container"]')
            || video.parentElement || video;
    }

    function toggleVideoFullscreen() {
        if (document.fullscreenElement) {
            try { document.exitFullscreen(); } catch {}
            return;
        }
        const target = playerFullscreenTarget();
        try { target?.requestFullscreen?.().catch(() => {}); } catch {}
    }

    function seekVideoBy(seconds) {
        const video = getVideo();
        if (!video) return;
        const end = Number.isFinite(video.duration) ? video.duration : null;
        const next = video.currentTime + seconds;
        video.currentTime = Math.max(0, end === null ? next : Math.min(end, next));
    }

    // key -> built-in action; mirrors the site's bindings.
    const PLAYER_KEY_DEFAULTS = {
        ' ': 'playPause',
        k: 'playPause',
        f: 'fullscreen',
        j: 'skipBack10',
        arrowleft: 'seekBack5',
        a: 'seekBack5',
        arrowright: 'seekForward5',
        d: 'seekForward5',
    };

    function playerKeyRows() {
        const shown = key => key === ' ' ? 'Space'
            : key === 'arrowleft' ? '←'
            : key === 'arrowright' ? '→'
            : key.toUpperCase();
        const byAction = new Map();
        Object.entries(PLAYER_KEY_DEFAULTS).forEach(([key, action]) => {
            if (!byAction.has(action)) byAction.set(action, []);
            byAction.get(action).push(shown(key));
        });
        const rows = [...byAction.entries()]
            .map(([action, keys]) => [keys.join(' / '), BUILTIN_ACTIONS[action]?.label || action]);
        rows.push(['0 - 9', 'Seek to 0-90%']);
        return rows;
    }

    // If the site's own switch disables its shortcuts, these stand down too.
    function siteShortcutsDisabled() {
        try {
            return JSON.parse(localStorage.getItem(SITE_PREFS_KEY) || 'null')?.disableKeyboardShortcuts === true;
        } catch { return false; }
    }

    function playerKeysApply(e) {
        if (e.ctrlKey || e.altKey || e.metaKey) return false;
        if (document.getElementById('pmv-keyeditor')) return false;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return false;
        if (keybindings[e.key.toLowerCase()]) return false;   // a custom binding wins
        // Only where the page has a player; card hover previews are <video> too.
        if (!/^\/(video|playlists)\//.test(location.pathname)) return false;
        if (siteShortcutsDisabled()) return false;
        return !!getVideo();
    }

    // Fullscreen is taken in the capture phase: the site's F can fail after an in-page hop (a stale handler
    // calls preventDefault on a detached wrapper). stopImmediatePropagation avoids two racing handlers.
    document.addEventListener('keydown', e => {
        if (e.key.toLowerCase() !== 'f' || !playerKeysApply(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleVideoFullscreen();
    }, true);

    // Other keys only act if nothing else did: a safety net for when the site's handler is gone.
    window.addEventListener('keydown', e => {
        if (e.defaultPrevented) return;
        const key = e.key.toLowerCase();
        if (key === 'f') return;             // owned above
        if (!playerKeysApply(e)) return;
        const video = getVideo();

        if (/^[0-9]$/.test(key)) {
            if (!Number.isFinite(video.duration) || video.duration <= 0) return;
            e.preventDefault();
            video.currentTime = video.duration * (Number(key) / 10);
            return;
        }

        const action = BUILTIN_ACTIONS[PLAYER_KEY_DEFAULTS[key]];
        if (!action) return;
        // Synchronous: a fullscreen request after an await loses user activation.
        e.preventDefault();
        try { action.run(); } catch {}
    });

    // Binding description shared by the cheat sheet and keyboard editor.
    function describeBinding(binding) {
        if (!binding) return null;
        if (binding.action === 'playlist') {
            const name = getPlaylistDisplayName(State.playlists.get(binding.playlistId)?.name, binding.playlistId) || binding.playlistId;
            return isRejectList(binding.playlistId)
                ? `"${name}" reject (out of every other playlist, next video)`
                : `"${name}" toggle (press again within 3 s to remove)`;
        }
        if (binding.action?.startsWith('builtin:')) {
            return BUILTIN_ACTIONS[binding.action.slice(8)]?.label || null;
        }
        return null;
    }

    // --- Hotkey cheat sheet ---
    // Built from `keybindings`, so it stays correct after remaps.
    function toggleHotkeyCheatSheet() {
        const existing = document.getElementById('pmv-hotkeys');
        if (existing) { existing.remove(); return; }

        const rows = Object.entries(keybindings)
            .map(([key, binding]) => ({ key, desc: describeBinding(binding) }))
            .filter(r => r.desc)
            .sort((a, b) => a.key.localeCompare(b.key))
            .map(r => `<tr><td style="color:rgb(100,255,0);padding-right:16px;">${escHtml(r.key.toUpperCase())}</td><td>${escHtml(r.desc)}</td></tr>`)
            .join('');

        const box = document.createElement('div');
        box.id = 'pmv-hotkeys';
        box.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: rgba(20,20,20,0.97); border: 1px solid rgba(255,255,255,0.15);
            border-radius: 12px; padding: 18px 22px; z-index: 999999;
            color: rgba(255,255,255,0.85); font-size: 13px;
            font-family:inherit;font-variant-numeric:tabular-nums; line-height: 1.9;
            min-width: 340px; backdrop-filter: blur(10px);
        `;
        box.innerHTML = `
            <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:white;">⌨ Hotkeys</div>
            <table style="border-collapse:collapse;width:100%;">
                ${rows}
                <tr><td colspan="2" style="color:rgba(255,255,255,0.4);padding-top:8px;">Player (only when the site leaves the key alone):</td></tr>
                ${playerKeyRows().map(([keys, label]) => `<tr><td style="color:rgb(100,255,0);padding-right:16px;">${escHtml(keys)}</td><td>${escHtml(label)}</td></tr>`).join('')}
                <tr><td colspan="2" style="color:rgba(255,255,255,0.4);padding-top:8px;">In the playlist filter box (playlist pages):</td></tr>
                <tr><td style="color:rgb(100,255,0);">Enter</td><td>Apply filter</td></tr>
                <tr><td style="color:rgb(100,255,0);">Escape</td><td>Clear filter</td></tr>
                <tr><td colspan="2" style="color:rgba(255,255,255,0.4);padding-top:8px;">Anywhere:</td></tr>
                <tr><td style="color:rgb(100,255,0);">Ctrl/Cmd+K</td><td>Search (videos, playlists) + open Up next</td></tr>
            </table>
            <div style="margin-top:14px;font-size:11px;color:rgba(255,255,255,0.3);">
                Bind hotkeys to your own key/playlist: the site's full Settings page (/settings) → PMVH Extended → Assign hotkeys.<br>
                Press ? again, or click outside this window, to close.
            </div>
        `;
        document.body.appendChild(box);
        setTimeout(() => document.addEventListener('click', function close(e) {
            if (!box.contains(e.target)) { box.remove(); document.removeEventListener('click', close); }
        }), 0);
    }

    // Only the bottom strip opens the HUD on mousemove (the right edge is the queue sidebar's); "i" works anywhere.
    const HUD_BOTTOM_ZONE_PX = 300;

    document.addEventListener('mousemove', e => {
        if (!document.fullscreenElement || State.quietMode) return;
        // Not over the open queue sidebar (380px wide, much larger than its 24px trigger strip).
        if (State.queueSidebarVisible && State.queueOverlayEl?.matches(':hover')) return;
        // Over a seek bar (the site's or the HUD's strip) the Seekbar-preview wins; the panel closes there.
        const target = e.target instanceof Element ? e.target : null;
        if (target && (target.closest(SCRUB_BAR_SELECTOR) || target.closest('#pmv-scrub-zone'))) {
            if (State.hud) closeHud();
            return;
        }
        const inBottomZone = e.clientY > window.innerHeight - HUD_BOTTOM_ZONE_PX;
        const inQueueEdgeZone = isPlaylistPage() && e.clientX > window.innerWidth - QUEUE_EDGE_ZONE_PX;
        if (!inBottomZone || inQueueEdgeZone) return;
        if (State.hud) { if (!State.hud.matches(':hover')) startHudTimer(1400); return; }
        if (!State.quietMode) showHud();
    });

