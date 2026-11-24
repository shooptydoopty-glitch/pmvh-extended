    // --- Command palette (Ctrl/Cmd+K) ---
    // Navigates via location.href, not a SPA transition.
    function buildCommandPaletteResults(query) {
        const q = query.trim().toLowerCase();
        const results = [];

        if (!q || 'up next queue'.includes(q) || q.includes('queue') || q.includes('next')) {
            results.push({ type: 'action', label: 'Open Up next', sub: '', action: () => openQueueSettings() });
        }
        if (!q || 'settings'.includes(q) || q.includes('setting')) {
            results.push({ type: 'action', label: 'Open settings', sub: '', action: () => openToolsSettings() });
        }

        State.playlists.forEach((p, id) => {
            const name = getPlaylistDisplayName(p.name) || id;
            if (!q || name.toLowerCase().includes(q)) {
                results.push({ type: 'playlist', id, label: name, sub: `${p.ids.size} videos`, href: `/playlists/${id}` });
            }
        });

        if (q) { // titleIndex can be large: videos only with a query
            let count = 0;
            for (const [title, id] of State.titleIndex) {
                if (count >= 40) break;
                if (!title.includes(q)) continue;
                const meta = State.videoMeta.get(id);
                results.push({
                    type: 'video', id,
                    label: meta?.title || title,
                    sub: [meta?.uploaderDisplay, meta?.bayesianRating ? Math.round(meta.bayesianRating) + '%' : null].filter(Boolean).join(' · '),
                    href: `/video/${id}`,
                });
                count++;
            }
        }

        return results.slice(0, 30);
    }

    function toggleCommandPalette() {
        const existing = document.getElementById('pmv-cmdk');
        if (existing) { existing.remove(); return; }

        const box = document.createElement('div');
        box.id = 'pmv-cmdk';
        box.style.cssText = `
            position: fixed; top: 18%; left: 50%; transform: translateX(-50%);
            background: rgba(20,20,20,0.98); border: 1px solid rgba(255,255,255,0.15);
            border-radius: 10px; z-index: 9999999; width: 480px; max-width: 90vw;
            box-shadow: 0 8px 32px rgba(0,0,0,0.7); font-family:inherit;font-variant-numeric:tabular-nums;
            backdrop-filter: blur(10px);
        `;
        box.innerHTML = `
            <input id="pmv-cmdk-input" type="text" placeholder="Search videos and playlists..." spellcheck="false"
                style="width:100%;box-sizing:border-box;padding:12px 14px;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.1);color:white;font-size:14px;font-family:inherit;outline:none;">
            <div id="pmv-cmdk-results" style="max-height:360px;overflow-y:auto;"></div>
        `;
        document.body.appendChild(box);

        const input = box.querySelector('#pmv-cmdk-input');
        const resultsEl = box.querySelector('#pmv-cmdk-results');
        let selectedIdx = 0;
        let current = [];

        const render = () => {
            current = buildCommandPaletteResults(input.value);
            selectedIdx = 0;
            resultsEl.innerHTML = current.length
                ? current.map((r, i) => `
                    <div data-i="${i}" style="padding:8px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:10px;${i === selectedIdx ? 'background:rgba(99,102,241,0.15);' : ''}">
                        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${r.type === 'playlist' ? 'rgb(165,180,252)' : 'rgba(255,255,255,0.85)'};">${r.type === 'playlist' ? '▶ ' : ''}${r.label}</span>
                        <span style="color:rgba(255,255,255,0.3);font-size:10px;white-space:nowrap;flex-shrink:0;">${r.sub || ''}</span>
                    </div>`).join('')
                : `<div style="padding:14px;color:rgba(255,255,255,0.3);font-size:12px;">${input.value.trim() ? 'No results' : 'Type to search videos, or browse playlists below'}</div>`;
        };
        const highlight = () => {
            [...resultsEl.children].forEach((el, i) => {
                el.style.background = i === selectedIdx ? 'rgba(99,102,241,0.15)' : '';
            });
            resultsEl.children[selectedIdx]?.scrollIntoView({ block: 'nearest' });
        };
        const activate = i => {
            const r = current[i];
            if (!r) return;
            if (r.action) { box.remove(); r.action(); }
            else location.href = r.href;
        };

        render();
        input.focus();

        input.addEventListener('input', render);
        input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, current.length - 1); highlight(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); highlight(); }
            else if (e.key === 'Enter') { e.preventDefault(); activate(selectedIdx); }
            else if (e.key === 'Escape') { box.remove(); }
        });
        resultsEl.addEventListener('click', e => {
            const row = e.target.closest('[data-i]');
            if (row) activate(parseInt(row.dataset.i, 10));
        });

        setTimeout(() => document.addEventListener('click', function close(e) {
            if (!box.contains(e.target)) { box.remove(); document.removeEventListener('click', close); }
        }), 0);
    }

    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            toggleCommandPalette();
        }
    });

