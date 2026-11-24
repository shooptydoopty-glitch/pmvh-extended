    // --- Reject ---
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

    function tagAfterReject() { try { return localStorage.getItem(TAG_AFTER_REJECT_KEY) !== '0'; } catch { return true; } }

    function setTagAfterReject(on) { try { localStorage.setItem(TAG_AFTER_REJECT_KEY, on ? '1' : '0'); } catch {} }

    // --- Tag popup (quick tag manager) ---
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
