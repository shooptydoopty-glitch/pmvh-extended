    // --- Native playlist button highlight ---

    function findNativePlaylistButton() {
        if (State.nativePlaylistButton?.isConnected) return State.nativePlaylistButton;
        const found = [...document.querySelectorAll('button, [role="button"]')].find(btn => {
            const d = btn.querySelector('svg path')?.getAttribute('d') || '';
            return d.includes('M16 5H3') && d.includes('M18 9v6') && d.includes('h-6');
        }) || null;
        State.nativePlaylistButton = found;
        return found;
    }

    function updateNativePlaylistButtons(force = false) {
        if (!State.ready) return;
        const videoId = getCurrentVideoId();
        if (!videoId) return;
        if (!force && State.nativePlaylistButtonLastVideoId === videoId) return;
        State.nativePlaylistButtonLastVideoId = videoId;

        const btn = findNativePlaylistButton();
        if (btn) {
            const inAny = getMatches(videoId).length > 0;
            const rgb = isRejected(videoId) ? REJECT_RGB : '100,255,0';
            if (btn.dataset.pmvPlaylistButton !== '1') btn.dataset.pmvPlaylistButton = '1';
            btn.style.transition = 'color 120ms ease, border-color 120ms ease';
            if (inAny) {
                btn.style.color = `rgb(${rgb})`;
                btn.style.borderColor = `rgba(${rgb},.45)`;
                btn.style.boxShadow = `0 0 0 1px rgba(${rgb},.18) inset`;
            } else {
                btn.style.color = '';
                btn.style.borderColor = '';
                btn.style.boxShadow = '';
            }
        }

        injectPagePlaylistButtons(videoId);
    }


    function injectPagePlaylistButtons(videoId) {
        if (!location.pathname.startsWith('/video/') && !location.pathname.startsWith('/playlists/')) return;
        if (!State.ready || !videoId) return;

        const nativeBar = nativeActionBar();
        if (!nativeBar) return;
        ensureRejectBarButton(videoId, nativeBar);

        const existing = document.getElementById('pmv-page-playlists');
        if (existing) {
            if (existing.dataset.forVideo === videoId) {
                existing.querySelectorAll('[data-pmv-pl-btn]').forEach(b => {
                    const plId = b.dataset.pmvPlBtn;
                    const inPl = State.playlists.get(plId)?.ids.has(videoId) || false;
                    applyPageBtnStyle(b, inPl);
                });
                return;
            }
            existing.remove();
        }

        // Own row below the native bar, in the same grid parent.
        const wrap = document.createElement('div');
        wrap.id = 'pmv-page-playlists';
        wrap.dataset.forVideo = videoId;
        wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;margin-top:8px;grid-column:1/-1;';

        // The reject list is the ⊘ in the action bar, not a playlist button.
        const rejectId = rejectPlaylistId && State.playlists.has(rejectPlaylistId) ? rejectPlaylistId : null;

        [...State.playlists.values()]
            .filter(pl => pl.id !== rejectId)
            .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
            .forEach(pl => {
            const inPl = pl.ids.has(videoId);
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.pmvPlBtn = pl.id;
            b.title = pl.name;
            const displayName = getPlaylistDisplayName(pl.name, pl.id);
            b.style.cssText = [
                'display:inline-flex',
                'align-items:center',
                'justify-content:center',
                'padding:5px 6px',
                'border-radius:6px',
                'font-size:12px',
                'white-space:nowrap',
                'cursor:pointer',
                'transition:all .15s',
                'width:82px',
                'box-sizing:border-box',
                'overflow:hidden',
                'text-overflow:ellipsis',
            ].join(';');
            applyPageBtnStyle(b, inPl);

            const lbl = document.createElement('span');
            lbl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
            lbl.textContent = displayName;
            b.appendChild(lbl);
            syncPageBtnKey(b, pl.id);

            b.addEventListener('click', async e => {
                e.stopPropagation();
                b.disabled = true;
                b.style.background = 'rgba(255,255,255,.04)';
                b.style.border = '1px solid rgba(255,255,255,.08)';
                b.style.color = 'rgba(255,255,255,.3)';
                b.style.fontWeight = '400';
                try {
                    if (pl.ids.has(videoId)) {
                        const ok = await removeFromPlaylist(videoId, pl.id);
                        if (ok) toast('✕ ' + displayName, 'red');
                        else toast('Remove failed');
                    } else {
                        const ok = await addToPlaylist(videoId, pl.id);
                        if (ok) toast('✓ ' + displayName, 'green');
                        else toast('Add failed');
                    }
                    updateNativePlaylistButtons(true);
                    scheduleBadges();
                } finally {
                    b.disabled = false;
                }
            });

            wrap.appendChild(b);
        });

        nativeBar.parentElement?.appendChild(wrap);
    }

    // The site's action bar under the video (Like, Dislike, Favourite, …).
    function nativeActionBar() {
        const nativeBtn = findNativePlaylistButton();
        return nativeBtn?.closest('.flex.items-center.gap-2') ||
            (() => {
                const anchor = [...document.querySelectorAll('button[title]')]
                    .find(b => /^Like/i.test(b.title) || /^Add to playlist$/i.test(b.title));
                return anchor?.closest('.flex.items-center.gap-2') || null;
            })();
    }

    // Same toggle as the ⊘ on cards (no skip, unlike the hotkey). Vue owns the bar, so the
    // heartbeat re-inserts it after a rebuild.
    const BAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" style="font-size:16px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m4.9 4.9 14.2 14.2"></path></svg>';
    function ensureRejectBtnStyle() {
        if (document.getElementById('pmv-reject-bar-style')) return;
        const st = document.createElement('style');
        st.id = 'pmv-reject-bar-style';
        st.textContent = `
[data-pmv-reject-page]:hover{color:rgb(252,165,165) !important;background:rgba(220,38,38,.22) !important;}
[data-pmv-reject-page][data-on="1"]{color:#fff !important;background:rgba(220,38,38,.85) !important;}
[data-pmv-reject-page][data-on="1"]:hover{background:rgba(220,38,38,.7) !important;}`;
        (document.head || document.documentElement).appendChild(st);
    }
    function styleRejectPageBtn(btn, on) {
        const flag = on ? '1' : '';
        const title = on ? 'Rejected — click to remove from the reject list' : 'Reject (move to the reject list, remove from every other playlist)';
        if (btn.dataset.on !== flag) btn.dataset.on = flag;
        if (btn.title !== title) btn.title = title;
    }
    function rejectPageButton(videoId) {
        ensureRejectBtnStyle();
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.pmvRejectPage = '1';
        b.dataset.forVideo = videoId;
        b.className = 'inline-flex items-center justify-center px-3 py-1.5 rounded-lg transition-all text-sm w-[52px] bg-[#2A2A2A] text-gray-400 hover:bg-[#3A3A3A] hover:text-white';
        b.innerHTML = BAN_SVG;
        styleRejectPageBtn(b, isRejected(videoId));
        b.addEventListener('click', async e => {
            e.preventDefault();
            e.stopPropagation();
            if (b.disabled) return;
            b.disabled = true;
            b.style.opacity = '0.5';
            try {
                const rect = takeForwardedAnchor() || b.getBoundingClientRect();
                const now = await toggleRejectVideo(videoId);
                if (now !== null) styleRejectPageBtn(b, now);
                if (now && tagAfterReject()) openTagPopup(videoId, rect, State.currentVideoData?.id === videoId ? State.currentVideoData.title : '');
            } finally {
                b.disabled = false;
                b.style.opacity = '';
            }
        });
        return b;
    }
    // Compact tag menu instead of the site's Vote on Tags modal; also on playlist pages, which lack that button.
    const VOTE_TAGS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" style="font-size:16px;" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m9 12l2 2l4-4"></path><path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5zm17 12H2"></path></g></svg>';
    function tagBarButton(videoId, kind = 'general') {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.pmvTagBar = kind;
        b.dataset.forVideo = videoId;
        b.className = 'inline-flex items-center justify-center px-3 py-1.5 rounded-lg transition-all text-sm w-[52px] bg-[#2A2A2A] text-gray-400 hover:bg-[#3A3A3A] hover:text-white';
        b.title = kind === 'stars' ? 'Models \u2014 vote or add' : 'Tags \u2014 vote or add';
        b.innerHTML = kind === 'stars' ? STAR_SVG.replace('width="14" height="14"', 'width="16" height="16"') : VOTE_TAGS_SVG;
        b.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            const open = document.getElementById('pmv-tag-pop');
            if (open && open.dataset.forVideo === videoId && open._pmvToggle === b) { closeTagPopup(); return; }
            const title = State.currentVideoData?.id === videoId ? State.currentVideoData.title : '';
            const pop = openTagPopup(videoId, takeForwardedAnchor() || b.getBoundingClientRect(), title,
                { heading: kind === 'stars' ? 'Models' : 'Tags', toggleEl: b, kind });
            pop._pmvToggle = b;
        });
        return b;
    }

    // The site's "Vote on Tags" buttons open the compact tag menu too; Shift+click keeps the modal.
    document.addEventListener('click', e => {
        if (e.shiftKey || !State.ready) return;
        const b = e.target.closest?.('button');
        if (!b || b.dataset.pmvTagBar || b.closest('#pmv-tag-pop, [data-pmv-hud]')) return;
        if (!/^Vote on Tags( Now)?$/.test(b.textContent.trim()) && b.title !== 'Suggest and vote on tags') return;
        const videoId = getCurrentVideoId();
        if (!videoId) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const title = State.currentVideoData?.id === videoId ? State.currentVideoData.title : '';
        const pop = openTagPopup(videoId, b.getBoundingClientRect(), title, { heading: 'Tags', toggleEl: b });
        pop._pmvToggle = b;
    }, true);

    // A button, not a link: the HUD forwards clicks on its clone, and a cloned link would open twice.
    function openPageBarButton(videoId) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.pmvOpenPage = '1';
        b.dataset.forVideo = videoId;
        b.className = 'inline-flex items-center justify-center px-3 py-1.5 rounded-lg transition-all text-sm w-[52px] bg-[#2A2A2A] text-gray-400 hover:bg-[#3A3A3A] hover:text-white';
        b.title = 'Open the video page in a new tab';
        b.innerHTML = CARD_ICON.external.replace('<svg ', '<svg width="16" height="16" ');
        const go = e => {
            e.preventDefault();
            e.stopPropagation();
            const title = State.currentVideoData?.id === videoId ? State.currentVideoData.title : '';
            const slug = String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
            window.open(`/video/${slug ? slug + '_' : ''}${videoId}`, '_blank', 'noopener');
        };
        b.addEventListener('click', go);
        b.addEventListener('auxclick', e => { if (e.button === 1) go(e); });
        return b;
    }

    // At the start of the action bar: ⊘ (with a reject list), Tags, Models, open-page (playlist pages).
    function ensureRejectBarButton(videoId, bar = null) {
        const onPage = location.pathname.startsWith('/video/') || location.pathname.startsWith('/playlists/');
        if (onPage && videoId && !bar) bar = nativeActionBar();
        const ok = onPage && videoId && bar;
        const hasList = rejectPlaylistId && State.playlists.has(rejectPlaylistId);

        const want = [];
        const pageOwn = sel => [...document.querySelectorAll(sel)].find(el => !el.closest('[data-pmv-hud]')) || null;
        let rej = pageOwn('[data-pmv-reject-page]');
        if (ok && hasList) {
            if (!rej || rej.parentElement !== bar || rej.dataset.forVideo !== videoId) { rej?.remove(); rej = rejectPageButton(videoId); }
            else styleRejectPageBtn(rej, isRejected(videoId));
            want.push(rej);
        } else rej?.remove();

        for (const kind of ['general', 'stars']) {
            let tag = pageOwn(`[data-pmv-tag-bar="${kind}"]`);
            if (ok && State.ready) {
                if (!tag || tag.parentElement !== bar || tag.dataset.forVideo !== videoId) { tag?.remove(); tag = tagBarButton(videoId, kind); }
                want.push(tag);
            } else tag?.remove();
        }

        let ext = pageOwn('[data-pmv-open-page]');
        if (ok && location.pathname.startsWith('/playlists/')) {
            if (!ext || ext.parentElement !== bar || ext.dataset.forVideo !== videoId) { ext?.remove(); ext = openPageBarButton(videoId); }
            want.push(ext);
        } else ext?.remove();

        if (!ok) return;
        // Move only when out of place.
        want.forEach((el, i) => { if (bar.children[i] !== el) bar.insertBefore(el, bar.children[i] || null); });
    }

    // Key cap: first hotkey bound to the playlist; negative margins into the padding fill the pill's height.
    function playlistHotkeys(plId) {
        return Object.keys(keybindings)
            .filter(k => keybindings[k]?.action === 'playlist' && keybindings[k].playlistId === plId)
            .sort();
    }
    function syncPageBtnKey(btn, plId) {
        const keys = playlistHotkeys(plId);
        let cap = btn.querySelector('[data-pmv-plkey]');
        // The label takes the rest, so the cap sits at the right edge.
        const lbl = btn.querySelector('span');
        if (lbl) { lbl.style.flex = keys.length ? '1 1 auto' : ''; lbl.style.textAlign = keys.length ? 'center' : ''; }
        // Up to 24px wider for the cap, so a long label keeps its 82px of room.
        btn.style.width = keys.length ? 'auto' : '82px';
        btn.style.minWidth = keys.length ? '82px' : '';
        btn.style.maxWidth = keys.length ? '106px' : '';
        if (!keys.length) { cap?.remove(); return; }
        if (!cap) {
            cap = document.createElement('kbd');
            cap.dataset.pmvPlkey = '1';
            cap.style.cssText = 'flex:0 0 auto;display:inline-block;min-width:24px;height:24px;padding:0 4px;margin:-3px -4px -3px 4px;box-sizing:border-box;border-radius:4px;border:1px solid currentColor;background:rgba(255,255,255,0.06);font:700 13px/22px system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;font-variant-numeric:tabular-nums;opacity:0.8;';
        }
        // The button may be styled before its label is added.
        if (btn.lastElementChild !== cap) btn.appendChild(cap);
        const k = keys[0];
        cap.textContent = k.length === 1 ? k.toUpperCase() : k.slice(0, 3);
        btn.title = (State.playlists.get(plId)?.name || '') + ' \u2014 key ' + keys.map(x => x.toUpperCase()).join(', ');
    }

    function applyPageBtnStyle(btn, active) {
        const plId = btn.dataset.pmvPlBtn;
        const name = State.playlists.get(plId)?.name || '';
        btn.title = name;
        const lbl = btn.querySelector('span');
        if (lbl) lbl.textContent = getPlaylistDisplayName(name, plId);
        syncPageBtnKey(btn, plId);

        const customStyle = getPlaylistStyle(name, plId);
        const colorHex = customStyle ? customStyle.color : FALLBACK_COLOR;
        const activeRgb = hexToRgbStr(colorHex);
        const inactiveRgb = mixToGrayStr(colorHex);
        if (active) {
            btn.style.background = `rgba(${activeRgb},0.24)`;
            btn.style.border = `2px solid rgba(${activeRgb},0.9)`;
            btn.style.color = `rgb(${activeRgb})`;
            btn.style.fontWeight = '700';
        } else {
            btn.style.background = `rgba(${inactiveRgb},0.05)`;
            btn.style.border = `1px solid rgba(${inactiveRgb},0.45)`;
            btn.style.color = `rgba(${inactiveRgb},0.75)`;
            btn.style.fontWeight = '400';
        }
    }

