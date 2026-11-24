    // --- Hotkey editor ---
    // Click or press a key to bind it inline (saved at once). Tiles: orange action, green playlist, red reject list.
    const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm?']; // '?' is Shift+/ (hotkey overview)

    function bindingKind(b) {
        if (!b) return '';
        if (b.action === 'playlist') return isRejectList(b.playlistId) ? 'reject' : 'playlist';
        return b.action === 'builtin:rejectVideo' ? 'reject' : 'action';
    }
    function bindingShort(b) {
        if (!b) return '';
        if (b.action === 'playlist') return getPlaylistDisplayName(State.playlists.get(b.playlistId)?.name, b.playlistId) || b.playlistId;
        const label = BUILTIN_ACTIONS[b.action?.slice(8)]?.label || '';
        return label.split(/\s[(:]|:\s/)[0];
    }

    function ensureKeyEditorStyle() {
        if (document.getElementById('pmv-ke-style')) return;
        const K = '#pmv-keyeditor';
        const st = document.createElement('style');
        st.id = 'pmv-ke-style';
        st.textContent = `
${K}{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);font-family:inherit;}
${K} .ke-card{background:#1A1A1A;border:1px solid #2A2A2A;border-radius:12px;width:100%;max-width:720px;max-height:90vh;overflow-y:auto;padding:24px;box-sizing:border-box;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);color:#fff;}
${K} .ke-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;}
${K} .ke-head h2{margin:0;font-size:24px;line-height:32px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px;}
${K} .ke-head h2 svg{width:24px;height:24px;}
${K} .ke-x{display:inline-flex;padding:8px;border:none;border-radius:8px;background:transparent;color:rgb(156,163,175);cursor:pointer;}
${K} .ke-x:hover{background:#2A2A2A;color:#fff;} ${K} .ke-x svg{width:20px;height:20px;}
${K} .ke-kb{display:flex;flex-direction:column;gap:6px;padding:16px;background:#0F0F0F;border-radius:8px;}
${K} .ke-row{display:flex;gap:6px;}
${K} .ke-key{width:56px;height:52px;flex-shrink:0;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-start;padding:6px 7px;box-sizing:border-box;
  border-radius:8px;border:1px solid #2A2A2A;background:#161616;cursor:pointer;text-align:left;font-family:inherit;transition:border-color .15s,background .15s,box-shadow .15s;}
${K} .ke-key:hover{border-color:#3A3A3A;background:#1C1C1C;}
${K} .ke-key .k{font-size:13px;line-height:14px;font-weight:700;color:rgb(209,213,219);}
${K} .ke-key .a{width:100%;font-size:9px;line-height:11px;color:rgb(107,114,128);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;}
${K} .ke-key[data-kind="action"]{border-color:rgba(249,115,22,.45);background:rgba(249,115,22,.08);} ${K} .ke-key[data-kind="action"] .a{color:rgb(253,186,116);}
${K} .ke-key[data-kind="playlist"]{border-color:rgba(100,255,0,.35);background:rgba(100,255,0,.06);} ${K} .ke-key[data-kind="playlist"] .a{color:rgb(163,230,53);}
${K} .ke-key[data-kind="reject"]{border-color:rgba(239,68,68,.5);background:rgba(239,68,68,.08);} ${K} .ke-key[data-kind="reject"] .a{color:rgb(252,165,165);}
${K} .ke-key[data-kind] .k{color:#fff;}
${K} .ke-key[data-sel="1"]{box-shadow:0 0 0 2px rgb(249,115,22);border-color:transparent;}
${K} .ke-key{position:relative;}
${K} .ke-key[data-site="1"]{border-style:dashed;border-color:#3A3A3A;}
${K} .ke-key[data-site="1"] .a{color:rgb(156,163,175);font-style:italic;}
${K} .ke-key[data-changed="1"]::after{content:'';position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:rgb(249,115,22);}
${K} .ke-key[data-over="1"]::after{content:'!';position:absolute;top:4px;right:4px;width:13px;height:13px;border-radius:50%;background:rgb(234,179,8);color:#000;font-size:9px;font-weight:800;line-height:13px;text-align:center;}
${K} .ke-legend .sw-dash{width:12px;height:10px;border:1px dashed #6B7280;border-radius:3px;background:transparent;}
${K} .ke-legend .sw-dot{width:6px;height:6px;border-radius:50%;background:rgb(249,115,22);}
${K} .ke-legend .sw-bang{width:13px;height:13px;border-radius:50%;background:rgb(234,179,8);color:#000;font-size:9px;font-weight:800;line-height:13px;text-align:center;font-style:normal;}
${K} .ke-meta{display:flex;flex-direction:column;gap:4px;font-size:13px;color:rgb(156,163,175);}
${K} .ke-meta b{color:rgb(229,231,235);font-weight:500;}
${K} .ke-note{font-size:13px;line-height:18px;color:rgb(250,204,21);}
${K} .ke-defs{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
@media (max-width:640px){${K} .ke-defs{grid-template-columns:1fr;}}
${K} .ke-defs h4{margin:0 0 6px;font-size:13px;font-weight:600;color:rgb(156,163,175);text-transform:uppercase;letter-spacing:.04em;}
${K} .ke-def{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #222;font-size:13px;color:rgb(209,213,219);}
${K} .ke-def:last-child{border-bottom:none;}
${K} .ke-def .t{flex:1;min-width:0;}
${K} .ke-def .st{font-size:11px;padding:1px 6px;border-radius:9999px;background:rgba(249,115,22,.15);color:rgb(253,186,116);white-space:nowrap;}
${K} .ke-def .st.over{background:rgba(234,179,8,.15);color:rgb(250,204,21);}
${K} .ke-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:rgb(156,163,175);}
${K} .ke-legend span{display:inline-flex;align-items:center;gap:6px;}
${K} .ke-legend i{width:10px;height:10px;border-radius:3px;display:inline-block;}
${K} .ke-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border-radius:6px;background:#1E1E1E;border:1px solid #2A2A2A;
  border-bottom-width:2px;color:#fff;font-size:13px;font-weight:700;font-family:inherit;box-sizing:border-box;}
${K} .ke-list{display:flex;flex-direction:column;}
${K} .ke-item{display:flex;align-items:center;gap:12px;padding:8px 4px;border-bottom:1px solid #222;cursor:pointer;border-radius:6px;}
${K} .ke-item:last-child{border-bottom:none;}
${K} .ke-item:hover{background:rgba(255,255,255,.03);}
${K} .ke-item .t{flex:1;min-width:0;font-size:14px;color:rgb(229,231,235);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
${K} .ke-item .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
${K} .ke-item .rm{display:inline-flex;padding:6px;border:none;border-radius:6px;background:transparent;color:rgb(107,114,128);cursor:pointer;}
${K} .ke-item .rm:hover{background:#2A2A2A;color:#fff;} ${K} .ke-item .rm svg{width:14px;height:14px;}
${K} .ke-empty{font-size:14px;color:rgb(107,114,128);padding:4px 0;}
${K} .ke-warn{font-size:13px;line-height:18px;color:rgb(252,165,165);}
${K} .ke-foot{margin-top:24px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
${K} .ke-foot .h{font-size:12px;color:rgb(107,114,128);}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    const KIND_COLOR = { action: 'rgb(249,115,22)', playlist: 'rgb(100,255,0)', reject: 'rgb(239,68,68)' };

    // Keys the player handles itself (see PLAYER_KEY_DEFAULTS); a binding overrides them.
    const SITE_KEY_ROWS = [
        ['Space / K', 'Play / pause', [' ', 'k']],
        ['F', 'Fullscreen', ['f']],
        ['J', 'Skip back 10 s', ['j']],
        ['A / \u2190', 'Seek back 5 s', ['a']],
        ['D / \u2192', 'Seek forward 5 s', ['d']],
        ['0\u20139', 'Jump to 0\u201390 %', ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']],
    ];
    function siteShortcut(key) {
        const row = SITE_KEY_ROWS.find(r => r[2].includes(key));
        return row ? row[1] : null;
    }
    function sameBinding(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }

    function buildKeybindingEditor(initialKey) {
        document.getElementById('pmv-keyeditor')?._pmvClose?.();
        ensureToolsSettingsStyle();
        ensureKeyEditorStyle();

        let selected = initialKey && KEYBOARD_ROWS.join('').includes(initialKey) ? initialKey : null;

        const ov = document.createElement('div');
        ov.id = 'pmv-keyeditor';
        ov.innerHTML = `
            <div class="ke-card">
                <div class="ke-head">
                    <h2>${TS_SVG.keyboard}Hotkeys</h2>
                    <button type="button" class="ke-x" data-close title="Close">${TS_SVG.x}</button>
                </div>
                <div data-pmv-tools-settings="1" data-body></div>
                <div class="ke-foot">
                    <span class="h">Esc closes • <span class="ke-kbd" style="min-width:20px;height:20px;font-size:11px;">?</span> shows all hotkeys</span>
                    <button type="button" class="ts-btn" data-close style="background:#2A2A2A;">Close</button>
                </div>
            </div>`;
        const body = ov.querySelector('[data-body]');

        const render = () => {
            body.textContent = '';

            const kbSec = document.createElement('div');
            kbSec.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
            kbSec.innerHTML = `<h3>Keyboard<span class="sub">click or press a key</span></h3>`;
            const kb = document.createElement('div');
            kb.className = 'ke-kb';
            KEYBOARD_ROWS.forEach((row, i) => {
                const rowEl = document.createElement('div');
                rowEl.className = 'ke-row';
                rowEl.style.paddingLeft = `${[0, 18, 46][i]}px`;
                for (const letter of row) {
                    const b = keybindings[letter];
                    const key = document.createElement('button');
                    key.type = 'button';
                    key.className = 'ke-key';
                    const site = siteShortcut(letter);
                    const def = DEFAULT_KEYBINDINGS[letter];
                    if (b) key.dataset.kind = bindingKind(b);
                    else if (site) key.dataset.site = '1';
                    if (b && site) key.dataset.over = '1';
                    else if (!sameBinding(b, def)) key.dataset.changed = '1';
                    if (letter === selected) key.dataset.sel = '1';
                    key.innerHTML = `<span class="k">${letter.toUpperCase()}</span><span class="a"></span>`;
                    key.querySelector('.a').textContent = b ? bindingShort(b) : (site || '');
                    key.title = [
                        b ? describeBinding(b) : (site ? `Site: ${site}` : 'Unbound'),
                        b && site ? `Replaces the site shortcut: ${site}` : '',
                        !sameBinding(b, def) ? `Default: ${def ? describeBinding(def) : 'not bound'}` : '',
                    ].filter(Boolean).join('\n');
                    key.onclick = () => { selected = letter === selected ? null : letter; render(); };
                    rowEl.appendChild(key);
                }
                kb.appendChild(rowEl);
            });
            const legend = document.createElement('div');
            legend.className = 'ke-legend';
            legend.innerHTML = `<span><i style="background:${KIND_COLOR.action};"></i>Action</span><span><i style="background:${KIND_COLOR.playlist};"></i>Playlist</span><span><i style="background:${KIND_COLOR.reject};"></i>Reject list</span>` +
                `<span><i class="sw-dash"></i>Site shortcut</span><span><i class="sw-dot"></i>Changed from default</span><span><i class="sw-bang">!</i>Replaces a site shortcut</span>`;
            kb.appendChild(legend);
            kbSec.appendChild(kb);

            // Selected key: binding picker
            if (selected) {
                const card = document.createElement('div');
                card.className = 'ts-card';
                const cur = keybindings[selected];
                card.innerHTML = `
                    <div>
                        <label class="ts-lab"><span class="ke-kbd">${selected.toUpperCase()}</span>${cur ? 'Bound to' : 'Not bound'}</label>
                        <p class="ts-desc"></p>
                    </div>`;
                card.querySelector('.ts-desc').textContent = cur ? describeBinding(cur) : 'Pick an action or one of your playlists for this key.';
                const def = DEFAULT_KEYBINDINGS[selected];
                const site = siteShortcut(selected);
                const meta = document.createElement('div');
                meta.className = 'ke-meta';
                meta.innerHTML = `<span>Default: <b></b></span>${site ? '<span>Site shortcut: <b></b></span>' : ''}`;
                meta.querySelectorAll('b')[0].textContent = def ? describeBinding(def) : 'not bound';
                if (site) meta.querySelectorAll('b')[1].textContent = site;
                card.appendChild(meta);
                if (cur && site) {
                    const n = document.createElement('div');
                    n.className = 'ke-note';
                    n.textContent = `This binding replaces the site shortcut (${site}). Unbind the key to get it back.`;
                    card.appendChild(n);
                }
                if (!sameBinding(cur, def)) {
                    const restore = document.createElement('button');
                    restore.type = 'button';
                    restore.className = 'ts-btn';
                    restore.style.alignSelf = 'flex-start';
                    restore.textContent = def ? 'Restore default' : 'Unbind (default)';
                    restore.onclick = () => {
                        if (def) keybindings[selected] = JSON.parse(JSON.stringify(def));
                        else delete keybindings[selected];
                        saveKeybindings();
                        render();
                    };
                    card.appendChild(restore);
                }
                const value = () => {
                    const b = keybindings[selected];
                    if (!b) return '';
                    return b.action === 'playlist' ? 'playlist:' + b.playlistId : b.action;
                };
                const items = () => {
                    const out = [{ value: '', label: 'None', desc: 'Key does nothing (the site’s own shortcut, if any, still works)' }];
                    out.push({ header: true, label: 'Actions' });
                    Object.entries(BUILTIN_ACTIONS).forEach(([k, a]) => {
                        const short = a.label.split(/\s[(:]|:\s/)[0];
                        out.push({ value: 'builtin:' + k, label: short, desc: short !== a.label ? a.label : '' });
                    });
                    out.push({ header: true, label: 'Playlists' });
                    [...State.playlists.values()]
                        .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
                        .forEach(p => out.push({
                            value: 'playlist:' + p.id,
                            label: getPlaylistDisplayName(p.name, p.id) || p.id,
                            desc: isRejectList(p.id) ? 'Reject list — removed from every other playlist, skips to the next video' : `${p.ids.size} videos • press again within 3s to remove`,
                        }));
                    return out;
                };
                const sel = mkToolsSelect(items, value, v => {
                    if (!v) delete keybindings[selected];
                    else if (v.startsWith('playlist:')) keybindings[selected] = { action: 'playlist', playlistId: v.slice(9) };
                    else keybindings[selected] = { action: v };
                    saveKeybindings();
                    render();
                });
                card.appendChild(sel.el);
                if (bindingKind(cur) === 'reject') {
                    const w = document.createElement('div');
                    w.className = 'ke-warn';
                    w.textContent = 'This key adds the video to your reject list, removes it from every other playlist and skips to the next video.';
                    card.appendChild(w);
                }
                kbSec.appendChild(card);
            }
            body.appendChild(kbSec);

            const listSec = document.createElement('div');
            listSec.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
            const bound = Object.keys(keybindings).filter(k => keybindings[k]).sort();
            listSec.innerHTML = `<h3>Bound keys<span class="sub">${bound.length}</span></h3>`;
            const list = document.createElement('div');
            list.className = 'ke-list';
            if (!bound.length) list.innerHTML = '<div class="ke-empty">No keys bound yet.</div>';
            bound.forEach(k => {
                const b = keybindings[k];
                const row = document.createElement('div');
                row.className = 'ke-item';
                row.innerHTML = `<span class="ke-kbd">${escHtml(k.toUpperCase())}</span><span class="dot" style="background:${KIND_COLOR[bindingKind(b)] || '#555'};"></span><span class="t"></span><button type="button" class="rm" title="Unbind">${TS_SVG.x}</button>`;
                row.querySelector('.t').textContent = describeBinding(b) || '';
                row.querySelector('.t').title = describeBinding(b) || '';
                row.onclick = () => { if (KEYBOARD_ROWS.join('').includes(k)) { selected = k; render(); ov.querySelector('.ke-card').scrollTo({ top: 0, behavior: 'smooth' }); } };
                row.querySelector('.rm').onclick = e => { e.stopPropagation(); delete keybindings[k]; saveKeybindings(); if (selected === k) selected = null; render(); };
                list.appendChild(row);
            });
            listSec.appendChild(list);
            body.appendChild(listSec);

            const defSec = document.createElement('div');
            defSec.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
            defSec.innerHTML = `<h3>Default shortcuts<span class="sub">for reference</span></h3>`;
            const grid = document.createElement('div');
            grid.className = 'ke-defs';
            const col = (title, rows) => {
                const c = document.createElement('div');
                c.innerHTML = `<h4>${title}</h4>`;
                rows.forEach(([keyLabel, text, status, cls]) => {
                    const r = document.createElement('div');
                    r.className = 'ke-def';
                    r.innerHTML = `<span class="ke-kbd"></span><span class="t"></span>${status ? `<span class="st ${cls || ''}"></span>` : ''}`;
                    r.querySelector('.ke-kbd').textContent = keyLabel;
                    r.querySelector('.t').textContent = text;
                    if (status) r.querySelector('.st').textContent = status;
                    c.appendChild(r);
                });
                return c;
            };
            grid.appendChild(col('PMVH Extended', Object.entries(DEFAULT_KEYBINDINGS).map(([k, b]) => [
                k.toUpperCase(), bindingShort(b),
                sameBinding(keybindings[k], b) ? '' : (keybindings[k] ? 'remapped' : 'unbound'),
            ])));
            grid.appendChild(col('PMVHaven player', SITE_KEY_ROWS.map(([label, text, keys]) => [
                label, text, keys.some(k => keybindings[k]) ? 'replaced' : '', 'over',
            ])));
            defSec.appendChild(grid);
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'ts-btn';
            reset.style.alignSelf = 'flex-start';
            reset.textContent = 'Reset all hotkeys to defaults';
            let armed = false;
            reset.onclick = () => {
                if (!armed) {
                    armed = true;
                    reset.textContent = 'Click again to reset \u2014 your own bindings are removed';
                    setTimeout(() => { armed = false; if (reset.isConnected) reset.textContent = 'Reset all hotkeys to defaults'; }, 3000);
                    return;
                }
                keybindings = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
                saveKeybindings();
                selected = null;
                render();
            };
            defSec.appendChild(reset);
            body.appendChild(defSec);
        };

        const onKey = e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;
            if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
            const k = (e.key || '').toLowerCase();
            if (k.length === 1 && KEYBOARD_ROWS.join('').includes(k)) {
                // Selects the key instead of running its hotkey.
                e.preventDefault(); e.stopPropagation();
                selected = k; render();
            }
        };
        const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
        ov._pmvClose = close;
        ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
        document.addEventListener('keydown', onKey, true);
        render();
        (getFullscreenRoot() || document.body).appendChild(ov);
    }

