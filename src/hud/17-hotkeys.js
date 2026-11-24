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
    function skipToNextVideo(currentId) {
        if (isPlaylistPage()) {
            dispatchingSyntheticNext = true;
            try {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'n', code: 'KeyN', keyCode: 78, which: 78, bubbles: true
                }));
            } finally { dispatchingSyntheticNext = false; }
            return true;
        }
        syncQueueCursor();
        const next = smartQueueItems[queueCursor + 1];
        if (next) { goToVideo(next.href, next.id); return true; }

        const container = findVisibleRecommendedContainer();
        const card = container && [...container.querySelectorAll('a[href*="/video/"]')].find(a => {
            if (a.closest('[style*="display: none"]')) return false;
            const slug = getVideoIdFromHref(a.getAttribute('href'));
            const apiId = slug && (State.slugToApiId.get(slug) || slug);
            return apiId && apiId !== currentId && !isRejected(apiId);
        });
        if (card) {
            const slug = getVideoIdFromHref(card.getAttribute('href'));
            goToVideo(card.getAttribute('href'), State.slugToApiId.get(slug) || null);
            return true;
        }
        return false;
    }

    // Reject key: reject (addToPlaylist drops other lists) and skip; on a rejected video, un-reject without skipping.
    async function rejectCurrentVideo() {
        const videoId = getCurrentVideoId();
        if (!videoId) { toast('No video'); return; }
        await toggleRejectVideo(videoId, { skip: true });
    }

    // Reject key and card ✕: toggle reject-list membership (only the key skips); resolves to the new state or null.
    async function toggleRejectVideo(videoId, { skip = false } = {}) {
        const rejectId = rejectPlaylistId && State.playlists.has(rejectPlaylistId) ? rejectPlaylistId : null;
        if (!rejectId) { toast('No reject list chosen (Settings \u2192 Reject list)'); return null; }
        const plName = getPlaylistDisplayName(State.playlists.get(rejectId).name, rejectId) || rejectId;

        if (isRejected(videoId)) {
            const ok = await removeFromPlaylist(videoId, rejectId);
            updateNativePlaylistButtons(true);
            scheduleBadges();
            toast(ok ? '\u2715 Off ' + plName : 'Remove failed', ok ? 'green' : null);
            return ok ? false : null;
        }

        const otherCount = getMatches(videoId).filter(p => p.id !== rejectId).length;
        const ok = await addToPlaylist(videoId, rejectId);
        updateNativePlaylistButtons(true);
        scheduleBadges();
        if (!ok) { toast('Add failed'); return null; }
        const others = otherCount ? ` (removed from ${otherCount} other playlist${otherCount === 1 ? '' : 's'})` : '';
        const skipped = skip && skipToNextVideo(videoId);
        toast(`\u2298 ${plName}${others}${skipped ? ' \u2192 next' : ''}`, 'red');
        return true;
    }

    // Tag-popup after ✕: tag the rejected video, with the calls of the site's Vote on Tags modal:
    //   GET  /api/videos/<id>/tags/stats    -> data.tags [{ tag, userVote }]
    //   POST /api/videos/<id>/tags/suggest  { tag, tagType: 'general' }                      new tag, +1 vote
    //   POST /api/videos/<id>/tags/vote     { tag, voteType: 'upvote', tagType: 'general' }  existing tag
    // Voting again on an upvoted tag removes the vote, so that case is skipped.
    const TAG_AFTER_REJECT_KEY = 'pmv_tag_after_reject_v1';
    const TAG_RECENT_KEY = 'pmv_tag_recent_v1';
    const TAG_MAX_LEN = 50; // the site's limit for general tags
    const TAG_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle></svg>';
    function tagAfterReject() { try { return localStorage.getItem(TAG_AFTER_REJECT_KEY) !== '0'; } catch { return true; } }
    function setTagAfterReject(on) { try { localStorage.setItem(TAG_AFTER_REJECT_KEY, on ? '1' : '0'); } catch {} }
    const STAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/></svg>';
    // Tags and stars/models share the endpoints, told apart by tagType; site length limits 50 and 100.
    const TAG_KINDS = {
        general: { recentKey: TAG_RECENT_KEY, max: TAG_MAX_LEN, stats: 'tags', meta: 'tags', noun: 'tag', icon: TAG_SVG, pre: '#' },
        stars: { recentKey: 'pmv_star_recent_v1', max: 100, stats: 'stars', meta: 'starsTags', noun: 'model', icon: STAR_SVG, pre: '' },
    };
    const tagKind = k => TAG_KINDS[k] || TAG_KINDS.general;
    function recentTags(kind = 'general') {
        try {
            const a = JSON.parse(localStorage.getItem(tagKind(kind).recentKey) || '[]');
            return Array.isArray(a) ? a.filter(t => typeof t === 'string' && t).slice(0, 8) : [];
        } catch { return []; }
    }
    function rememberTag(tag, kind = 'general') {
        try {
            const a = [tag, ...recentTags(kind).filter(t => t.toLowerCase() !== tag.toLowerCase())].slice(0, 8);
            localStorage.setItem(tagKind(kind).recentKey, JSON.stringify(a));
        } catch {}
    }

    // The site's vocabulary per kind for autocomplete, loaded once.
    const popularTagsP = {};
    function popularTags(kind = 'general') {
        const type = kind === 'stars' ? 'stars' : 'general';
        if (!popularTagsP[type]) {
            popularTagsP[type] = fetch(`/api/tags/popular?limit=1000&type=${type}`, { credentials: 'include' })
                .then(r => (r.ok ? r.json() : null))
                .then(j => (Array.isArray(j?.data) ? j.data : []).map(t => t?.name).filter(n => typeof n === 'string' && n))
                .catch(() => { popularTagsP[type] = null; return []; });
        }
        return popularTagsP[type];
    }

    async function postSiteJson(url, body) {
        const res = await fetch(url, {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
        });
        let j = null;
        try { j = await res.json(); } catch {}
        if (!res.ok || j?.success === false) throw new Error(j?.message || j?.statusMessage || `HTTP ${res.status}`);
        return j;
    }

    // Resolves to 'added' | 'voted' | 'already'; throws with the site's message on failure.
    async function tagVideoOnSite(id, tag, kind = 'general') {
        const K = tagKind(kind), tagType = kind === 'stars' ? 'stars' : 'general';
        let existing = null;
        try {
            existing = (await videoTagStats(id, kind)).find(t => String(t?.tag).toLowerCase() === tag.toLowerCase()) || null;
        } catch {}
        let result;
        if (existing?.userVote === 'upvote') result = 'already';
        else if (existing) {
            await postSiteJson(`/api/videos/${id}/tags/vote`, { tag: existing.tag, voteType: 'upvote', tagType });
            result = 'voted';
        } else {
            await postSiteJson(`/api/videos/${id}/tags/suggest`, { tag, tagType });
            result = 'added';
        }
        forgetVideo(id);
        // The filter sees the new tag right away.
        const m = State.videoMeta.get(id);
        if (m && Array.isArray(m[K.meta]) && !m[K.meta].includes(tag.toLowerCase())) m[K.meta].push(tag.toLowerCase());
        try { applyFilterToCards(true); } catch {}
        return result;
    }

    function ensureTagPopStyle() {
        if (document.getElementById('pmv-tag-pop-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-tag-pop-style';
        const P = '#pmv-tag-pop';
        st.textContent = `
${P}{position:fixed;z-index:1000002;width:320px;box-sizing:border-box;padding:12px;border-radius:12px;background:#111;border:1px solid #2A2A2A;
  box-shadow:0 12px 32px rgba(0,0,0,.6);color:#e5e7eb;font-family:inherit;font-size:13px;line-height:1.3;}
${P} *{box-sizing:border-box;font-family:inherit;}
${P} .tp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;}
${P} .tp-title{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:14px;color:#fff;}
${P} .tp-title svg{color:rgb(251,146,60);}
${P}[data-kind="stars"] .tp-title svg{color:rgb(250,204,21);}
${P}[data-kind="stars"] .tp-chip:not([data-hide]):not([data-vote="up"]){border-color:rgba(234,179,8,.45);background:rgba(234,179,8,.14);color:rgb(253,224,71);}
${P} .tp-x{border:none;background:none;color:#9ca3af;cursor:pointer;font-size:13px;padding:2px 4px;border-radius:6px;}
${P} .tp-x:hover{color:#fff;background:#1F1F1F;}
${P} .tp-sub{color:#9ca3af;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:8px;}
${P} .tp-in{position:relative;display:flex;gap:6px;}
${P} input{flex:1;min-width:0;height:34px;padding:0 10px;border-radius:8px;border:1px solid #2A2A2A;background:#1A1A1A;color:#fff;font-size:13px;outline:none !important;box-shadow:none !important;}
${P} input:focus{border-color:rgba(249,115,22,.6);}
${P} input:disabled{opacity:.6;}
${P} .tp-add{height:34px;padding:0 12px;border-radius:8px;border:none;cursor:pointer;color:#fff;font-weight:600;font-size:13px;
  background:linear-gradient(to right,rgb(249,115,22),rgb(234,88,12));}
${P} .tp-add:disabled{opacity:.5;cursor:default;}
${P} .tp-sug{position:absolute;left:0;right:0;top:38px;z-index:2;max-height:210px;overflow-y:auto;padding:4px;border-radius:8px;background:#1A1A1A;border:1px solid #2A2A2A;box-shadow:0 8px 20px rgba(0,0,0,.5);}
${P} .tp-sug[hidden]{display:none;}
${P} .tp-opt{display:block;width:100%;text-align:left;padding:6px 8px;border:none;border-radius:6px;background:none;color:#d1d5db;font-size:13px;cursor:pointer;}
${P} .tp-opt:hover, ${P} .tp-opt[data-hi="1"]{background:rgba(249,115,22,.15);color:#fff;}
${P} .tp-opt b{color:rgb(251,146,60);font-weight:600;}
${P} .tp-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;}
${P} .tp-chips:empty{display:none;}
${P} .tp-chip{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;border-radius:9999px;border:1px solid #2A2A2A;background:#1F1F1F;color:#d1d5db;font-size:12px;cursor:pointer;}
${P} .tp-chip:hover{border-color:rgba(249,115,22,.5);color:#fff;}
${P} .tp-chip[data-vote="up"]{color:rgb(134,239,172);background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.35);}
${P} .tp-chip[data-vote="up"]:hover{border-color:rgba(34,197,94,.6);}
${P} .tp-chip[data-vote="down"]{color:rgb(252,165,165);border-color:rgba(239,68,68,.35);}
${P} .tp-chip .tp-n{margin-left:4px;font-size:10px;color:#6b7280;}
${P} .tp-chip[data-hide="1"]{color:rgb(252,165,165);background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.45);}
${P} .tp-chip[data-hide="1"]:hover{border-color:rgba(239,68,68,.7);color:#fff;}
${P} .tp-chip[data-hide="1"][data-vote="up"]{background:rgba(239,68,68,.22);border-color:rgba(239,68,68,.6);}
${P} .tp-opt[data-hide="1"]{color:rgb(252,165,165);}
${P} .tp-opt[data-hide="1"] b{color:rgb(255,120,120);}
${P} .tp-opt .tp-ban{margin-right:6px;color:rgb(255,110,110);}
${P} .tp-label{margin-top:10px;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;}
${P} .tp-label[hidden]{display:none;}
${P} .tp-label + .tp-chips{margin-top:5px;}
${P} .tp-have{max-height:150px;overflow-y:auto;}
${P} .tp-note{font-size:12px;color:#6b7280;}
${P} .tp-msg{margin-top:8px;font-size:12px;color:#9ca3af;}
${P} .tp-msg:empty{display:none;}
${P} .tp-msg[data-err]{color:rgb(255,110,110);}`;
        (document.head || document.documentElement).appendChild(st);
    }

    function closeTagPopup() { document.getElementById('pmv-tag-pop')?._pmvClose?.(); }

    // Tag votes on the video, as the site's Vote on Tags modal has them: [{ tag, upvotes, downvotes, score, userVote }].
    async function videoTagStats(id, kind = 'general') {
        const st = await (await fetch(`/api/videos/${id}/tags/stats`, { credentials: 'include' })).json();
        const list = st?.data?.[tagKind(kind).stats];
        return Array.isArray(list) ? list : [];
    }

    // Tag-popup: the video's tags (click = upvote, again = unvote) plus an input with autocomplete and recent
    // tags. Opens at the given rect (the card may be hidden by then); closes on Esc, ✕ or an outside click.
    function openTagPopup(id, rect, title, { heading = 'Tag video', align = 'left', toggleEl = null, kind = 'general' } = {}) {
        closeTagPopup();
        ensureTagPopStyle();
        const K = tagKind(kind);
        const tagType = kind === 'stars' ? 'stars' : 'general';
        const pop = document.createElement('div');
        pop.id = 'pmv-tag-pop';
        pop.dataset.forVideo = id;
        pop.dataset.kind = tagType;
        pop.innerHTML = `
            <div class="tp-head"><span class="tp-title">${K.icon}${escHtml(heading)}</span><button type="button" class="tp-x" title="Close (Esc)">✕</button></div>
            ${title ? `<div class="tp-sub" title="${escHtml(title)}">${escHtml(title)}</div>` : ''}
            <div class="tp-in">
                <input type="text" maxlength="${K.max}" placeholder="Add a ${K.noun}\u2026" spellcheck="false" autocomplete="off">
                <button type="button" class="tp-add">Add</button>
                <div class="tp-sug" hidden></div>
            </div>
            <div class="tp-label" data-recent-label hidden>Recent</div>
            <div class="tp-chips" data-recent></div>
            <div class="tp-label" data-have-label>On this video</div>
            <div class="tp-chips tp-have" data-have><span class="tp-note">Loading…</span></div>
            <div class="tp-msg"></div>`;
        const input = pop.querySelector('input');
        const addBtn = pop.querySelector('.tp-add');
        const sug = pop.querySelector('.tp-sug');
        const haveBox = pop.querySelector('[data-have]');
        const recentBox = pop.querySelector('[data-recent]');
        const recentLabel = pop.querySelector('[data-recent-label]');
        const msg = pop.querySelector('.tp-msg');
        let have = null;       // stats, null while loading
        let vocab = [];
        let hi = -1;
        let busy = false;
        const onVideo = t => !!have?.some(x => String(x.tag).toLowerCase() === t.toLowerCase());
        const say = (text, err) => { if (err) msg.dataset.err = '1'; else delete msg.dataset.err; msg.textContent = text || ''; };

        const paintRecent = () => {
            recentBox.innerHTML = '';
            const list = recentTags(kind).filter(t => !onVideo(t)).slice(0, 6);
            list.forEach(t => {
                const c = document.createElement('button');
                c.type = 'button';
                c.className = 'tp-chip';
                const by = tagHiddenBy(t, kind);
                c.textContent = (by ? '\u2298 ' : '+ ') + K.pre + t;
                if (by) c.dataset.hide = '1';
                c.title = by ? `Add this ${K.noun} \u2014 your filter hides videos with it (\u2298 ${by})` : `Add this ${K.noun}`;
                c.onclick = () => submit(t);
                recentBox.appendChild(c);
            });
            recentLabel.hidden = !list.length;
        };
        const paintHave = () => {
            haveBox.innerHTML = '';
            if (!have) { haveBox.innerHTML = `<span class="tp-note">Could not load ${K.noun}s</span>`; return; }
            if (!have.length) { haveBox.innerHTML = `<span class="tp-note">No ${K.noun}s yet</span>`; return; }
            [...have].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).forEach(t => {
                const c = document.createElement('button');
                c.type = 'button';
                c.className = 'tp-chip';
                const up = t.userVote === 'upvote', down = t.userVote === 'downvote';
                c.dataset.vote = up ? 'up' : down ? 'down' : '';
                const by = tagHiddenBy(t.tag, kind);
                if (by) c.dataset.hide = '1';
                c.innerHTML = `${by ? '\u2298 ' : up ? '\u2713 ' : ''}${K.pre}${escHtml(t.tag)}<span class="tp-n">${escHtml(t.score ?? 0)}</span>`;
                c.title = `${t.upvotes ?? 0} up \u2022 ${t.downvotes ?? 0} down \u2014 ` + (up ? 'click to remove your upvote' : 'click to upvote')
                    + (by ? ` \u2014 your filter hides videos with it (\u2298 ${by})` : '');
                c.onclick = () => toggleVote(t);
                haveBox.appendChild(c);
            });
        };
        async function reload() {
            try { have = await videoTagStats(id, kind); } catch { have = null; }
            if (!pop.isConnected) return;
            paintHave();
            paintRecent();
            place();
        }
        async function toggleVote(t) {
            if (busy) return;
            busy = true;
            say(t.userVote === 'upvote' ? 'Removing vote…' : 'Voting…');
            try {
                await postSiteJson(`/api/videos/${id}/tags/vote`, { tag: t.tag, voteType: 'upvote', tagType });
                forgetVideo(id);
                say(t.userVote === 'upvote' ? `Removed your vote on ${K.pre}${t.tag}` : `Upvoted ${K.pre}${t.tag}`);
                if (t.userVote !== 'upvote') rememberTag(t.tag, kind);
                await reload();
            } catch (e) {
                say(e?.message || 'Vote failed', true);
            } finally {
                busy = false;
            }
        }

        const options = () => [...sug.querySelectorAll('.tp-opt')];
        const paintHi = () => options().forEach((o, i) => { o.dataset.hi = i === hi ? '1' : ''; if (i === hi) o.scrollIntoView({ block: 'nearest' }); });
        const paintSug = () => {
            const q = input.value.trim().replace(/^#+/, '').toLowerCase();
            hi = -1;
            if (!q) { sug.hidden = true; sug.innerHTML = ''; return; }
            const starts = [], has = [];
            for (const t of vocab) {
                const l = t.toLowerCase();
                if (l === q || onVideo(t)) continue;
                if (l.startsWith(q)) starts.push(t); else if (l.includes(q)) has.push(t);
                if (starts.length >= 8) break;
            }
            const list = [...starts, ...has].slice(0, 8);
            sug.innerHTML = '';
            list.forEach(t => {
                const o = document.createElement('button');
                o.type = 'button';
                o.className = 'tp-opt';
                const i = t.toLowerCase().indexOf(q);
                const by = tagHiddenBy(t, kind);
                o.innerHTML = (by ? '<span class="tp-ban">\u2298</span>' : '') + escHtml(t.slice(0, i)) + '<b>' + escHtml(t.slice(i, i + q.length)) + '</b>' + escHtml(t.slice(i + q.length));
                if (by) { o.dataset.hide = '1'; o.title = `Your filter hides videos with this tag (\u2298 ${by})`; }
                o.onmousedown = e => e.preventDefault();
                o.onclick = () => submit(t);
                sug.appendChild(o);
            });
            sug.hidden = !list.length;
        };

        async function submit(raw) {
            const tag = String(raw || '').replace(/^#+/, '').replace(/\s+/g, ' ').trim();
            if (!tag || busy) return;
            if (tag.length > K.max) { say(`At most ${K.max} characters`, true); return; }
            busy = true;
            input.disabled = addBtn.disabled = true;
            say('Adding…');
            sug.hidden = true;
            try {
                const r = await tagVideoOnSite(id, tag, kind);
                rememberTag(tag, kind);
                const by = tagHiddenBy(tag, kind);
                const nm = K.pre + tag;
                say((r === 'added' ? `${nm} added with +1 vote` : r === 'voted' ? `Upvoted ${nm}` : `You already upvoted ${nm}`)
                    + (by ? ` \u2014 your filter now hides this video (\u2298 ${by})` : ''));
                input.value = '';
                await reload();
            } catch (e) {
                say(e?.message || 'Failed to add tag', true);
            } finally {
                busy = false;
                input.disabled = addBtn.disabled = false;
                if (pop.isConnected) input.focus();
            }
        }

        input.addEventListener('input', paintSug);
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            const opts = options();
            if (e.key === 'ArrowDown' && !sug.hidden && opts.length) { e.preventDefault(); hi = (hi + 1) % opts.length; paintHi(); }
            else if (e.key === 'ArrowUp' && !sug.hidden && opts.length) { e.preventDefault(); hi = hi <= 0 ? opts.length - 1 : hi - 1; paintHi(); }
            else if (e.key === 'Tab' && !sug.hidden && opts.length) { e.preventDefault(); input.value = opts[Math.max(0, hi)].textContent; paintSug(); }
            else if (e.key === 'Enter') { e.preventDefault(); submit(hi >= 0 && opts[hi] ? opts[hi].textContent : input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); if (!sug.hidden) { sug.hidden = true; hi = -1; } else close(); }
        });
        input.addEventListener('keyup', e => e.stopPropagation());
        input.addEventListener('keypress', e => e.stopPropagation());
        addBtn.onclick = () => submit(input.value);
        pop.querySelector('.tp-x').onclick = () => close();

        // A click on the button that opened it is left to that button (it toggles).
        const onDown = e => { const path = e.composedPath(); if (!path.includes(pop) && !(toggleEl && path.includes(toggleEl))) close(); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        function close() {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
            pop.remove();
        }
        pop._pmvClose = close;

        // Below the anchor if it fits, else above, within the viewport; redone when the tag list changes the height.
        let above = null;
        function place() {
            const w = pop.offsetWidth, h = pop.offsetHeight;
            const vw = document.documentElement.clientWidth, vh = window.innerHeight;
            const r = rect && rect.width ? rect : { left: vw / 2 - w / 2, right: vw / 2 + w / 2, top: vh / 2 - h / 2, bottom: vh / 2 - h / 2 };
            if (above === null) above = r.bottom + 6 + h + 220 > vh && r.top - h - 6 > 8;
            const top = above ? r.top - h - 6 : r.bottom + 6;
            pop.style.top = Math.round(Math.max(8, Math.min(top, vh - h - 8))) + 'px';
            const left = align === 'right' ? r.right - w : r.left;
            pop.style.left = Math.round(Math.max(8, Math.min(left, vw - w - 8))) + 'px';
        }

        paintRecent();
        (document.fullscreenElement || document.body).appendChild(pop);
        place();
        setTimeout(() => {
            if (!pop.isConnected) return;
            document.addEventListener('pointerdown', onDown, true);
            document.addEventListener('keydown', onKey, true);
        }, 0);
        input.focus({ preventScroll: true });
        reload();
        popularTags(kind).then(v => { vocab = v || []; if (pop.isConnected && input.value) paintSug(); });
        return pop;
    }

    // Toggle a mapped playlist (press again within 3 s to confirm removal); the reject list uses rejectCurrentVideo.
    async function handlePlaylistHotkey(playlistId) {
        if (isRejectList(playlistId)) return rejectCurrentVideo();
        const videoId = getCurrentVideoId();
        if (!videoId) { toast('No video'); return; }
        const plName = getPlaylistDisplayName(State.playlists.get(playlistId)?.name) || playlistId;
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
            const name = getPlaylistDisplayName(State.playlists.get(binding.playlistId)?.name) || binding.playlistId;
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
            .map(r => `<tr><td style="color:rgb(100,255,0);padding-right:16px;">${r.key.toUpperCase()}</td><td>${r.desc}</td></tr>`)
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

