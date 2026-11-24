    // --- More about this video ---
    function viVideoCard(v) {
        const r = Number(v.bayesianRating);
        const hue = Number.isFinite(r) ? Math.max(0, Math.min(120, r * 1.2)) : 0;
        const rating = Number.isFinite(r) && r > 0
            ? `<div class="inline-flex items-center gap-1 font-semibold select-none rounded-full border flex-shrink-0" style="padding:3px 6px;font-size:10px;line-height:1;background:linear-gradient(135deg, hsla(${hue} 70% 55% / 0.7), hsla(${hue} 70% 41% / 0.7));border:1px solid hsla(${hue} 70% 59% / 0.8);color:#FFFFFF;" role="img" aria-label="Rating badge">${VI_SVG.thumb}<span>${Math.round(r)}%</span></div>` : '';
        return `<a href="/video/${escHtml(viSlug(v.title) || 'video')}_${escHtml(v._id)}" class="${VI_CARD}">
            <div class="relative aspect-video bg-[#0A0A0A] overflow-hidden">
                ${v.thumbnailUrl ? `<img src="${escHtml(v.thumbnailUrl)}" alt="${escHtml(v.title || '')}" class="w-full h-full object-cover transition-transform duration-300 opacity-100 group-hover:scale-110" loading="lazy">` : ''}
                <div class="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-20"><div class="w-10 h-10 rounded-full bg-orange-600/80 hover:bg-orange-600 backdrop-blur-sm border border-orange-400/30 flex items-center justify-center text-white">${VI_SVG.play}</div></div>
                ${v.duration ? `<div class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 bg-black/80 backdrop-blur-sm rounded text-white text-xs font-semibold z-20">${escHtml(v.duration)}</div>` : ''}
            </div>
            <div class="p-2 space-y-1">
                <h4 class="text-sm font-semibold line-clamp-2 group-hover:text-blue-400 transition-colors leading-tight text-white">${escHtml(v.title || '')}</h4>
                <div class="flex items-center gap-2 text-xs text-gray-500"><span class="flex items-center gap-0.5">${VI_SVG.eye} ${viCompact(v.views)}</span><span>•</span><span class="flex items-center gap-0.5">${VI_SVG.cal} ${escHtml(String(v.uploadDate || '').slice(0, 10))}</span></div>
                <div class="flex items-center gap-1.5 flex-wrap">${rating}</div>
            </div></a>`;
    }

    function viPlaylistCard(p) {
        const thumbs = (Array.isArray(p.videoThumbnails) && p.videoThumbnails.length ? p.videoThumbnails : (p.thumbnails || [])).slice(0, 4);
        const cover = thumbs.length >= 2
            ? `<div class="w-full h-full grid grid-cols-2">${thumbs.map((t, i) => `<div class="relative overflow-hidden"><img src="${escHtml(t)}" alt="Video ${i + 1}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300" loading="lazy"></div>`).join('')}</div>`
            : ((p.thumbnailUrl || thumbs[0]) ? `<img src="${escHtml(p.thumbnailUrl || thumbs[0])}" alt="" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300" loading="lazy">` : '');
        return `<a href="/playlists/${escHtml(p._id)}" class="${VI_CARD}">
            <div class="relative aspect-video bg-[#0A0A0A] overflow-hidden">${cover}
                <div class="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-black/80 backdrop-blur-sm rounded text-white text-xs font-semibold">${VI_SVG.videoCount} ${escHtml(String(p.videoCount ?? ''))}</div>
            </div>
            <div class="p-2 space-y-1.5">
                <h4 class="text-sm font-semibold line-clamp-2 group-hover:text-blue-400 transition-colors leading-tight text-white">${escHtml(p.name || '')}</h4>
                <div class="flex items-center gap-1 text-xs text-gray-400"><span class="flex items-center gap-1 truncate">${VI_SVG.user}<span class="truncate">${escHtml(p.owner || '')}</span></span></div>
                <div class="flex items-center gap-2 text-xs text-gray-500"><span class="flex items-center gap-0.5">${VI_SVG.eye} ${viCompact(p.views)}</span><span>•</span><span class="flex items-center gap-0.5">${VI_SVG.clock} ${escHtml(viAgo(p.updatedAt || p.createdAt))}</span></div>
            </div></a>`;
    }

    function viSectionsHtml(d) {
        const v = d.video || {};
        const stars = Array.isArray(v.starsTags) ? v.starsTags.filter(Boolean) : [];
        const models = `<div class="bg-[#1A1A1A] rounded-lg p-3"><div class="flex items-center gap-2 flex-wrap">
            <span class="text-xs font-semibold text-gray-400 flex items-center gap-1 mr-1">${VI_SVG.userCircle(12, 'text-yellow-300')} Models</span>
            ${stars.length ? stars.map(s => `<a href="/model/${escHtml(viSlug(s) || 'star')}" class="inline-flex items-center gap-1.5 px-2 py-0.5 bg-gradient-to-r from-yellow-500/25 to-amber-500/25 border border-yellow-400/40 text-yellow-200 rounded-md text-xs font-semibold shadow-sm hover:from-yellow-500/35 hover:to-amber-500/35 hover:border-yellow-400/60 transition-all"><span class="truncate">${escHtml(s)}</span></a>`).join('')
                : '<span class="text-xs text-gray-500">None tagged</span>'}
        </div></div>`;
        const pls = Array.isArray(d.playlists) ? d.playlists : [];
        const playlists = pls.length ? `<div class="bg-[#1A1A1A] rounded-lg p-4">
            <div class="flex items-center justify-between mb-4"><h3 class="text-lg font-bold text-white flex items-center gap-2">${VI_SVG.listVideo} Playlists with this video <span class="text-sm font-normal text-gray-400">(${pls.length})</span></h3></div>
            <div class="${VI_GRID}">${pls.map(viPlaylistCard).join('')}</div></div>` : '';
        const ups = Array.isArray(d.uploaderVideos) ? d.uploaderVideos.filter(x => x?._id && x._id !== v._id) : [];
        const who = v.uploaderUsername || v.uploader || '';
        const more = ups.length ? `<div class="bg-[#1A1A1A] rounded-lg p-4">
            <div class="flex items-center justify-between mb-4"><h3 class="text-lg font-bold text-white flex items-center gap-2">${VI_SVG.userCircle(20)} More from ${escHtml(who)} <span class="text-sm font-normal text-gray-400">(${escHtml(String(d.uploaderVideosCount ?? ups.length))})</span></h3>
                ${v.uploaderId ? `<a href="/users/${escHtml(v.uploaderId)}" class="text-sm text-orange-400 hover:text-orange-300 transition-colors flex items-center gap-1"> View channel ${VI_SVG.arrow}</a>` : ''}</div>
            <div class="${VI_GRID}">${ups.map(viVideoCard).join('')}</div></div>` : '';
        return models + playlists + more;
    }

    function renderVideoInfo(box, key) {
        box.dataset.vid = vinfo.vid;
        box.dataset.state = key;
        const sub = vinfo.loading ? 'Loading…' : vinfo.error ? 'Could not load — click to retry' : 'Models • Playlists with this video • More from uploader';
        box.innerHTML = `<button type="button" data-pmv-vinfo-toggle aria-expanded="${vinfo.open}" class="w-full flex items-center justify-between gap-3 bg-[#1A1A1A] rounded-lg px-4 py-3 text-left text-gray-300 hover:text-white transition-colors">
                <span class="flex items-center gap-2 min-w-0"><span class="text-orange-400 flex-shrink-0">${VI_SVG.info}</span><span class="text-sm font-semibold text-white flex-shrink-0">${vinfo.open ? 'Less about this video' : 'More about this video'}</span><span class="text-xs text-gray-400 truncate">${sub}</span></span>
                <span class="flex-shrink-0" style="transition:transform .2s;${vinfo.open ? 'transform:rotate(180deg);' : ''}">${VI_SVG.chev}</span>
            </button>
            ${vinfo.open && vinfo.data ? `<div class="space-y-4 mt-4">${viSectionsHtml(vinfo.data)}</div>` : ''}`;
        box.querySelector('[data-pmv-vinfo-toggle]').onclick = () => {
            if (vinfo.error) { vinfo.open = true; loadVideoInfo(); return; }
            vinfo.open = !vinfo.open;
            if (vinfo.open && !vinfo.data && !vinfo.loading) loadVideoInfo();
            else ensureVideoInfo();
        };
        if (vinfo.open && vinfo.data) { try { addMoreFromBadges(); } catch {} }
    }

    async function loadVideoInfo() {
        const seq = vinfo.seq, vid = vinfo.vid;
        vinfo.loading = true; vinfo.error = false;
        ensureVideoInfo();
        try {
            const json = await api(`/api/videos/${vid}/watch-page`);
            if (seq !== vinfo.seq) return;
            vinfo.data = json?.data?.video ? json.data : null;
            if (!vinfo.data) vinfo.error = true;
        } catch { if (seq === vinfo.seq) vinfo.error = true; }
        finally { if (seq === vinfo.seq) { vinfo.loading = false; ensureVideoInfo(); } }
    }

    // After the info block under the player; self-healing via the page observer.
    function ensureVideoInfo() {
        let box = document.getElementById(VINFO_ID);
        if (!isPlaylistPage()) { box?.remove(); return; }
        const col = document.querySelector('.playlist-page div.grid > div.min-w-0');
        const anchor = col && [...col.children].find(el => el.classList.contains('space-y-4') && el.classList.contains('mb-4'));
        if (!anchor) { box?.remove(); return; }
        // Only the active queue row counts; none (mid re-render) keeps the current state.
        const vid = getActiveQueueVideoId() || vinfo.vid;
        if (!vid) return;
        if (vid !== vinfo.vid) Object.assign(vinfo, { vid, open: false, data: null, loading: false, error: false, seq: vinfo.seq + 1 });
        if (!box) { box = document.createElement('div'); box.id = VINFO_ID; box.className = 'mb-4'; }
        if (box.previousElementSibling !== anchor || !box.isConnected) anchor.after(box);
        const key = `${vinfo.open ? 1 : 0}${vinfo.loading ? 1 : 0}${vinfo.data ? 1 : 0}${vinfo.error ? 1 : 0}`;
        if (box.dataset.vid !== vid || box.dataset.state !== key) renderVideoInfo(box, key);
    }
