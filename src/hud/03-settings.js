    // --- Settings export/import ---
    // Exports every pmv*-prefixed localStorage key.
    function collectPmvSettings() {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            // Settings only: caches are rebuilt from the site.
            if (!k || !k.startsWith('pmv') || /cache/i.test(k)) continue;
            out[k] = localStorage.getItem(k); // raw: parsing would strip the quotes off JSON string values
        }
        return out;
    }
    function applyPmvSettings(obj) {
        let count = 0;
        for (const [k, v] of Object.entries(obj)) {
            if (!k.startsWith('pmv')) continue; // never touch unrelated keys
            localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
            count++;
        }
        return count;
    }

    // --- Settings section ---
    // Section in the site's Settings modal (teleported to <body>: h2 "Settings" + `space-y-6` list),
    // styled like the native ones; the observer re-adds it when Vue rebuilds the list.
    const TS_SVG = {
        gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg>',
        volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"></path><path d="M16 9a5 5 0 0 1 0 6"></path><path d="M19.4 18.4a9 9 0 0 0 0-12.8"></path></svg>',
        film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18"></rect><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"></path></svg>',
        ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="m4.9 4.9 14.2 14.2"></path></svg>',
        keyboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"></path></svg>',
        database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14a9 3 0 0 0 18 0V5"></path><path d="M3 12a9 3 0 0 0 18 0"></path></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="14" height="14" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>',
        download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m7 10 5 5 5-5"></path><path d="M12 15V3"></path></svg>',
        upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m17 8-5-5-5 5"></path><path d="M12 3v12"></path></svg>',
        chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>',
        x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>',
        gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    };

    function ensureToolsSettingsStyle() {
        if (document.getElementById('pmv-ts-style')) return;
        const R = '[data-pmv-tools-settings]';
        const st = document.createElement('style');
        st.id = 'pmv-ts-style';
        st.textContent = `
${R}{display:flex;flex-direction:column;gap:16px;font-family:inherit;}
${R} *{box-sizing:border-box;}
${R} h3{margin:0;padding-bottom:8px;border-bottom:1px solid #2A2A2A;color:#fff;font-size:18px;line-height:28px;font-weight:600;display:flex;align-items:baseline;gap:8px;}
${R} h3 .sub{margin-left:auto;font-size:12px;line-height:16px;font-weight:400;color:rgb(107,114,128);}
${R} .ts-card{padding:16px;background:#0F0F0F;border-radius:8px;display:flex;flex-direction:column;gap:12px;}
${R} .ts-lab{color:#fff;font-weight:500;font-size:16px;line-height:24px;display:flex;align-items:center;gap:8px;}
${R} .ts-lab svg{width:18px;height:18px;flex-shrink:0;}
${R} .ts-desc{margin:4px 0 0;font-size:14px;line-height:20px;color:rgb(156,163,175);}
${R} .ts-meta{font-size:12px;line-height:16px;color:rgb(107,114,128);word-break:break-word;}
${R} .ts-cs{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:.75rem;background:#0000004d;border:1px solid hsla(0,0%,100%,.1);
  border-radius:8px;color:#fff;font-family:inherit;font-size:.95rem;cursor:pointer;transition:all .2s;text-align:left;}
${R} .ts-cs:hover{border-color:#fff3;background:#0006;}
${R} .ts-cs[data-open="1"],${R} .ts-cs:focus-visible{outline:none;border-color:#f9731680;box-shadow:0 0 0 3px #f973161a;}
${R} .ts-cs .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
${R} .ts-cs[data-empty="1"]{color:#ffffff80;}
${R} .ts-cs svg{width:18px;height:18px;flex-shrink:0;color:#fff6;transition:transform .2s;}
${R} .ts-cs[data-open="1"] svg{transform:rotate(180deg);}
${R} .ts-dd{margin-top:8px;background:#1a1a1a;border:1px solid rgba(249,115,22,.3);border-radius:8px;max-height:300px;overflow-y:auto;box-shadow:0 8px 24px #0006;}
${R} .ts-dd[hidden]{display:none;}
${R} .ts-dd::-webkit-scrollbar{width:8px;} ${R} .ts-dd::-webkit-scrollbar-track{background:#0003;border-radius:4px;}
${R} .ts-dd::-webkit-scrollbar-thumb{background:#f973164d;border-radius:4px;} ${R} .ts-dd::-webkit-scrollbar-thumb:hover{background:#f9731680;}
${R} .ts-it{display:flex;align-items:center;gap:.75rem;width:100%;padding:.75rem 1rem;background:none;border:none;border-bottom:1px solid hsla(0,0%,100%,.05);
  color:#fff;text-align:left;cursor:pointer;transition:all .2s;font-family:inherit;}
${R} .ts-it:last-child{border-bottom:none;}
${R} .ts-gh{padding:10px 16px 6px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:rgb(107,114,128);background:#151515;border-bottom:1px solid hsla(0,0%,100%,.05);}
${R} .ts-it:hover{background:#f973161a;}
${R} .ts-it[data-sel="1"]{background:#f9731626;}
${R} .ts-it .c{display:flex;flex-direction:column;gap:.25rem;flex:1;min-width:0;}
${R} .ts-it .l{font-size:.95rem;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
${R} .ts-it .d{font-size:.8rem;color:#ffffff80;line-height:1.3;}
${R} .ts-it svg{width:18px;height:18px;flex-shrink:0;color:#f97316;visibility:hidden;}
${R} .ts-it[data-sel="1"] svg{visibility:visible;}
${R} .ts-row2{display:flex;align-items:center;justify-content:space-between;gap:16px;}
${R} .ts-sw{position:relative;display:inline-flex;align-items:center;flex-shrink:0;width:44px;height:24px;border:none;padding:0;border-radius:9999px;background:#2A2A2A;cursor:pointer;transition:background .15s;}
${R} .ts-sw[aria-checked="true"]{background:rgb(249,115,22);}
${R} .ts-sw .k{position:absolute;left:4px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s;}
${R} .ts-sw[aria-checked="true"] .k{transform:translateX(20px);}
${R} .ts-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:8px 16px;border-radius:8px;cursor:pointer;font-family:inherit;
  font-size:14px;line-height:20px;font-weight:500;transition:all .15s;border:1px solid transparent;background:#2A2A2A;color:#fff;}
${R} .ts-btn:hover{background:#3A3A3A;}
${R} .ts-btn svg{width:16px;height:16px;flex-shrink:0;}
${R} .ts-btn.accent{background:rgba(249,115,22,.2);border-color:rgba(249,115,22,.4);color:rgb(253,186,116);}
${R} .ts-btn.accent:hover{background:rgba(249,115,22,.3);border-color:rgba(249,115,22,.6);}
${R} .ts-row{display:flex;gap:8px;flex-wrap:wrap;} ${R} .ts-row > .ts-btn{flex:1;}
${R} textarea{display:block;width:100%;height:110px;padding:8px 12px;resize:vertical;background:#1E1E1E;border:1px solid #2A2A2A;border-radius:8px;
  color:#fff;font-size:12px;line-height:16px;font-family:inherit;font-variant-numeric:tabular-nums;outline:none;}
${R} textarea:focus{outline:none;box-shadow:0 0 0 2px rgb(249,115,22);}
${R} textarea::placeholder{color:rgb(107,114,128);}
`;
        (document.head || document.documentElement).appendChild(st);
    }

    // Inline copy of the site's CustomSelect. items(): [{ value, label, desc }].
    function mkToolsSelect(items, getValue, onPick) {
        const wrap = document.createElement('div');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ts-cs';
        btn.innerHTML = `<span class="t"></span>${TS_SVG.chev}`;
        const dd = document.createElement('div');
        dd.className = 'ts-dd';
        dd.hidden = true;
        wrap.append(btn, dd);
        const paint = () => {
            const cur = items().find(i => !i.header && i.value === getValue());
            btn.querySelector('.t').textContent = cur ? cur.label : 'None';
            btn.dataset.empty = cur && cur.value ? '0' : '1';
        };
        const close = () => { dd.hidden = true; btn.dataset.open = '0'; };
        btn.onclick = e => {
            e.stopPropagation();
            if (!dd.hidden) { close(); return; }
            wrap.closest('[data-pmv-tools-settings]')?.querySelectorAll('.ts-dd').forEach(d => { d.hidden = true; d.previousElementSibling.dataset.open = '0'; });
            dd.innerHTML = items().map(it => it.header ? `<div class="ts-gh">${escHtml(it.label)}</div>` : `
                <button type="button" class="ts-it" data-v="${escHtml(it.value)}" data-sel="${it.value === getValue() ? '1' : '0'}">
                    <span class="c"><span class="l">${escHtml(it.label)}</span>${it.desc ? `<span class="d">${escHtml(it.desc)}</span>` : ''}</span>${TS_SVG.check}
                </button>`).join('');
            dd.querySelectorAll('.ts-it').forEach(row => {
                row.onclick = ev => {
                    ev.stopPropagation();
                    close();
                    if (row.dataset.v !== getValue()) { onPick(row.dataset.v); paint(); }
                };
            });
            dd.hidden = false;
            btn.dataset.open = '1';
            dd.scrollIntoView({ block: 'nearest' });
        };
        paint();
        return { el: wrap, close, paint };
    }

    function toolsCard(icon, iconColor, label, desc, control) {
        const c = document.createElement('div');
        c.className = 'ts-card';
        c.innerHTML = `<div><label class="ts-lab"><span style="display:inline-flex;${iconColor ? `color:${iconColor};` : ''}">${icon}</span>${label}</label><p class="ts-desc">${desc}</p></div>`;
        if (control) c.appendChild(control);
        return c;
    }

    function moreSettingsCard() {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ts-btn';
        b.style.width = '100%';
        b.innerHTML = `${TS_SVG.gear}Open full settings`;
        b.onclick = () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.getElementById('pmv-ts-modal')?.remove();
            siteNavigate('/settings#pmvx');
        };
        return toolsCard(TS_SVG.gear, '', 'More settings', 'Hotkeys, playlist names &amp; colours and backup are on the full settings page', b);
    }

    function hotkeysCard() {
        const hk = document.createElement('button');
        hk.type = 'button';
        hk.className = 'ts-btn accent';
        hk.style.width = '100%';
        hk.innerHTML = `${TS_SVG.keyboard}Assign hotkeys`;
        hk.onclick = () => buildKeybindingEditor();
        return toolsCard(TS_SVG.keyboard, '', 'Hotkeys', 'Remap every hotkey, including the playlist buttons', hk);
    }

    function backupCard() {
        const keys = Object.keys(collectPmvSettings());

        const bk = document.createElement('div');
        bk.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
        bk.innerHTML = `
            <div class="ts-meta">${keys.length} stored key${keys.length === 1 ? '' : 's'}: ${escHtml(keys.map(k => k.replace(/^pmv[a-z]*_?/, '')).join(', ') || '(none)')}</div>
            <textarea spellcheck="false" placeholder="Export fills this box. To import, paste JSON here or load a file."></textarea>
            <div class="ts-row">
                <button type="button" class="ts-btn" data-k="export" title="Fill the box and copy to the clipboard">${TS_SVG.copy}Export</button>
                <button type="button" class="ts-btn" data-k="download">${TS_SVG.download}Download</button>
                <button type="button" class="ts-btn" data-k="file" title="Load a .json file into the box">${TS_SVG.upload}Load file</button>
            </div>
            <button type="button" class="ts-btn accent" data-k="import">Import (reloads the page)</button>
            <input type="file" accept="application/json,.json" hidden>`;
        const ta = bk.querySelector('textarea');
        const fileInput = bk.querySelector('input[type=file]');
        const exportJson = () => JSON.stringify(collectPmvSettings(), null, 2);
        bk.querySelector('[data-k="export"]').onclick = async () => {
            ta.value = exportJson();
            ta.select();
            try { await navigator.clipboard.writeText(ta.value); toast('Settings copied to clipboard', 'green'); } catch {}
        };
        bk.querySelector('[data-k="download"]').onclick = () => {
            const blob = new Blob([exportJson()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pmvhaven-settings-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        bk.querySelector('[data-k="file"]').onclick = () => fileInput.click();
        fileInput.onchange = async () => {
            const f = fileInput.files?.[0];
            if (!f) return;
            try { ta.value = await f.text(); } catch { toast('Could not read file'); }
            fileInput.value = '';
        };
        bk.querySelector('[data-k="import"]').onclick = () => {
            let parsed;
            try { parsed = JSON.parse(ta.value); }
            catch { toast('Invalid JSON'); return; }
            if (!parsed || typeof parsed !== 'object') { toast('Invalid JSON'); return; }
            let count;
            try { count = applyPmvSettings(parsed); }
            catch (e) { toast(`Import stopped: ${e.message || e}`); return; }
            toast(`${count} setting(s) imported - reloading`);
            setTimeout(() => location.reload(), 1200);
        };
        return toolsCard(TS_SVG.database, '', 'Backup', 'Filters, Up next, watch history, hotkeys and playlist names', bk);
    }

    function buildToolsSettingsSection() {
        ensureToolsSettingsStyle();
        const sec = document.createElement('div');
        sec.setAttribute('data-pmv-tools-settings', '1');
        const card = (icon, iconColor, label, desc) => `
            <div class="ts-card">
                <div>
                    <label class="ts-lab"><span style="display:inline-flex;${iconColor ? `color:${iconColor};` : ''}">${icon}</span>${label}</label>
                    <p class="ts-desc">${desc}</p>
                </div>
                <div data-slot></div>
            </div>`;
        sec.innerHTML = `
            <h3>PMVH Extended<span class="sub">userscript</span></h3>
            <div class="ts-card">
                <div>
                    <label class="ts-lab"><span style="display:inline-flex;">${TS_SVG.gauge}</span>Performance</label>
                    <p class="ts-desc">Lower this on slower computers if scrolling or video playback stutters</p>
                </div>
                <div data-perf></div>
            </div>
            ${card(TS_SVG.film, '', 'Seekbar preview', 'Frame shown above the seekbar while you scrub. Live builds a frame cache in the background and uses more CPU.')}
            <div class="ts-card"><div class="ts-row2">
                <div>
                    <label class="ts-lab"><span style="display:inline-flex;">${TS_SVG.volume}</span>Volume lock</label>
                    <p class="ts-desc">Keep the player unmuted at 100 % on every video</p>
                </div>
                <button type="button" class="ts-sw" role="switch" data-vol><span class="k"></span></button>
            </div></div>
            ${card(TS_SVG.ban, 'rgb(248,113,113)', 'Reject list', 'Adding a video there removes it from every other playlist and shows it red instead of green. The Reject hotkey also skips to the next video.')}
            <div class="ts-card"><div class="ts-row2">
                <div>
                    <label class="ts-lab"><span style="display:inline-flex;">${TAG_SVG}</span>Tag after reject</label>
                    <p class="ts-desc">After rejecting a video (⊘), ask for a tag and add it to the video on the site</p>
                </div>
                <button type="button" class="ts-sw" role="switch" data-tagrej><span class="k"></span></button>
            </div></div>
            <div class="ts-card" data-more></div>
        `;
        const slots = sec.querySelectorAll('[data-slot]');

        const scrubItems = () => [
            { value: 'hybrid', label: 'Live', desc: 'Frame cache built in the background (more CPU)' },
            { value: 'frames', label: 'Timeline thumbnails', desc: "The site's own preview frames" },
            { value: 'off', label: 'Off', desc: 'No preview' },
        ];
        const scrubSel = mkToolsSelect(scrubItems, () => scrubMode(), v => setScrubMode(v));
        slots[0].replaceWith(scrubSel.el);

        const perfItems = () => [
            { value: 'smooth', label: 'Smooth', desc: 'Pages update instantly, all effects — for fast computers' },
            { value: 'balanced', label: 'Balanced', desc: 'Page updates batched slightly, all effects (default)' },
            { value: 'light', label: 'Light', desc: 'For slower computers: fewer page updates, no blur or animations (also the site\u2019s), one background request at a time, no live seekbar preview' },
        ];
        const perfSel = mkToolsSelect(perfItems, () => PMVX.perfMode(), v => {
            PMVX.setPerfMode(v);
            if (v === 'light') scrubDrop();
            else if (scrubModeCached === 'hybrid') scrubWarm();
            scrubSel.paint?.();
        });
        sec.querySelector('[data-perf]').replaceWith(perfSel.el);

        const vol = sec.querySelector('[data-vol]');
        const paintVol = () => vol.setAttribute('aria-checked', volumeLockEnabled() ? 'true' : 'false');
        vol.onclick = () => { setVolumeLock(!volumeLockEnabled()); paintVol(); };
        paintVol();

        const tagRej = sec.querySelector('[data-tagrej]');
        const paintTagRej = () => tagRej.setAttribute('aria-checked', tagAfterReject() ? 'true' : 'false');
        tagRej.onclick = () => { setTagAfterReject(!tagAfterReject()); paintTagRej(); };
        paintTagRej();

        const rejectItems = () => {
            const items = [{ value: '', label: 'None', desc: 'No reject list' }];
            [...State.playlists.values()]
                .sort((a, b) => playlistSortIndex(a.name) - playlistSortIndex(b.name))
                .forEach(p => items.push({ value: p.id, label: getPlaylistDisplayName(p.name, p.id) || p.id, desc: `${p.ids.size} videos` }));
            if (rejectPlaylistId && !State.playlists.has(rejectPlaylistId)) {
                // Not loaded yet: keep it instead of showing "None".
                items.push({ value: rejectPlaylistId, label: rejectPlaylistId, desc: 'Not loaded yet' });
            }
            return items;
        };
        const rejectSel = mkToolsSelect(rejectItems, () => rejectPlaylistId || '', v => {
            setRejectPlaylistId(v);
            document.getElementById('pmv-page-playlists')?.remove();
            document.querySelectorAll('[data-pmv-checked]').forEach(el => delete el.dataset.pmvChecked);
            updateNativePlaylistButtons(true);
            scheduleBadges();
            try { renderQueueSidebar(); } catch {}
            const name = rejectItems().find(i => i.value === v)?.label;
            toast(v ? '⊘ Reject list: ' + name : 'Reject list off');
        });
        slots[1].replaceWith(rejectSel.el);

        sec.querySelector('[data-more]').replaceWith(moreSettingsCard());

        sec.addEventListener('click', e => {
            if (!e.target.closest('.ts-cs, .ts-dd')) { scrubSel.close(); rejectSel.close(); }
        });
        return sec;
    }

    function nativeSettingsList() {
        for (const ov of document.body.children) {
            if (ov.tagName !== 'DIV' || !ov.classList.contains('inset-0')) continue;
            const h2 = ov.querySelector('h2');
            if (!h2 || h2.textContent.trim() !== 'Settings') continue;
            const list = h2.parentElement?.nextElementSibling;
            if (list?.classList.contains('space-y-6')) return list;
        }
        return null;
    }

    function injectToolsSettings() {
        const list = nativeSettingsList();
        if (!list || list.querySelector(':scope > [data-pmv-tools-settings]')) return;
        list.appendChild(buildToolsSettingsSection());
    }

    let toolsSettingsQueued = false;
    new MutationObserver(() => {
        if (toolsSettingsQueued) return;
        toolsSettingsQueued = true;
        requestAnimationFrame(() => { toolsSettingsQueued = false; try { injectToolsSettings(); } catch {} });
    }).observe(document.body, { childList: true, subtree: true });

    // --- /settings page: playlist names & colours ---
    // Per-playlist short names and colours (pmv_playlist_config_v1), saved on change.

    function savePlaylistConfig() {
        try {
            const raw = JSON.parse(localStorage.getItem(PLAYLIST_CONFIG_KEY) || '{}') || {};
            raw.styles = playlistConfig.styles;
            if (!raw.order) raw.order = playlistConfig.order;
            if (!Object.keys(raw.styles).length && !(raw.order || []).length) localStorage.removeItem(PLAYLIST_CONFIG_KEY);
            else localStorage.setItem(PLAYLIST_CONFIG_KEY, JSON.stringify(raw));
        } catch {}
        document.querySelectorAll('[data-playlist-name], [data-pmv-rec-badge]').forEach(el => el.remove());
        document.querySelectorAll('[data-pmv-checked], [data-pmv-rec-checked], [data-pmv-mf-checked]').forEach(el => {
            delete el.dataset.pmvChecked; delete el.dataset.pmvRecChecked; delete el.dataset.pmvMfChecked;
        });
        try { scheduleBadges(); } catch {}
    }

    // All entries for a playlist: by id, plus legacy ones by lower-cased name.
    function playlistStyleKeys(p) {
        const name = p.name || '';
        return [p.id, name.trim().toLowerCase(), name].filter((k, i, a) => k && a.indexOf(k) === i);
    }
    function setPlaylistStyle(p, patch) {
        const cur = getPlaylistStyle(p.name, p.id) || {};
        const explicit = playlistStyleKeys(p).map(k => playlistConfig.styles[k]).find(Boolean) || {};
        playlistStyleKeys(p).forEach(k => delete playlistConfig.styles[k]);
        const next = { label: explicit.label || null, color: explicit.color || null, ...patch };
        if (!next.label) delete next.label;
        if (!next.color) delete next.color;
        if (Object.keys(next).length) playlistConfig.styles[p.id] = next;
        return cur;
    }

    function settingsPageList() {
        if (location.pathname.replace(/\/+$/, '') !== '/settings') return null;
        for (const h1 of document.querySelectorAll('h1')) {
            if (h1.textContent.trim() !== 'Settings') continue;
            const wrap = h1.closest('.max-w-4xl');
            const list = wrap && [...wrap.children].find(c => c.classList.contains('space-y-6'));
            if (list) return list;
        }
        return null;
    }

    function injectSettingsPageSection() {
        const list = settingsPageList();
        if (!list || list.querySelector(':scope > #pmvx-settings-names')) return;
        if (!document.getElementById('pmvx-settings-names-style')) {
            const st = document.createElement('style');
            st.id = 'pmvx-settings-names-style';
            st.textContent = `
#pmvx-settings-names .pn-row{display:flex;align-items:center;gap:12px;padding:8px 12px;background:#161616;border:1px solid #1F1F1F;border-radius:8px;}
#pmvx-settings-names .pn-name{flex:1;min-width:0;color:#fff;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#pmvx-settings-names .pn-name small{color:rgb(107,114,128);font-weight:400;margin-left:6px;font-variant-numeric:tabular-nums;}
#pmvx-settings-names input[type=text]{width:180px;max-width:40%;background:#1A1A1A;border:1px solid #2A2A2A;border-radius:8px;padding:6px 10px;color:#fff;font-size:13px;outline:none;font-family:inherit;}
#pmvx-settings-names input[type=text]:focus{border-color:rgba(249,115,22,.6);}
#pmvx-settings-names input[type=color]{width:28px;height:28px;padding:0;border:1px solid #2A2A2A;border-radius:9999px;background:none;cursor:pointer;flex-shrink:0;overflow:hidden;}
#pmvx-settings-names input[type=color]::-webkit-color-swatch-wrapper{padding:0;}
#pmvx-settings-names input[type=color]::-webkit-color-swatch{border:none;border-radius:9999px;}
#pmvx-settings-names .pn-reset{color:rgb(107,114,128);background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;font-size:13px;line-height:1;}
#pmvx-settings-names .pn-reset:hover{color:rgb(248,113,113);background:rgba(239,68,68,.1);}
#pmvx-settings-names .pn-reset[disabled]{visibility:hidden;}
#pmvx-settings-names .pn-btn{padding:6px 12px;border-radius:8px;border:1px solid #2A2A2A;background:none;color:rgb(156,163,175);font-size:12px;font-weight:500;cursor:pointer;}
#pmvx-settings-names .pn-btn:hover{border-color:rgba(239,68,68,.5);background:rgba(239,68,68,.1);color:rgb(248,113,113);}`;
            document.head.appendChild(st);
        }
        ensureToolsSettingsStyle();
        const sec = document.createElement('div');
        sec.id = 'pmvx-settings-names';
        sec.className = 'bg-gradient-to-br from-[#1A1A1A] to-[#0F0F0F] border border-[#2A2A2A] rounded-xl p-6 shadow-2xl';
        sec.innerHTML = `
            <h2 class="text-xl font-semibold text-white mb-6 flex items-center gap-2 border-b border-[#2A2A2A] pb-3">
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-orange-400"><path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/></svg>
                PMVH Extended
                <span class="text-sm text-gray-500 font-normal" style="margin-left:auto;">Quick settings: gear at the top right</span>
            </h2>
            <div data-pmv-tools-settings="1" data-body></div>`;
        const body = sec.querySelector('[data-body]');
        const names = document.createElement('div');
        names.className = 'ts-card';
        names.innerHTML = `
            <div>
                <label class="ts-lab"><span style="display:inline-flex;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/></svg></span>Playlist names &amp; colours</label>
                <p class="ts-desc">Short name shown on playlist buttons, badges and the sidebar (empty = the playlist's own name) and its colour. Saved as you type.</p>
            </div>
            <div class="space-y-2" data-rows></div>
            <div style="display:flex;align-items:center;gap:12px;">
                <span class="ts-meta" data-status></span>
                <div style="flex:1"></div>
                <button type="button" class="pn-btn" data-reset-all>Reset all names &amp; colours</button>
            </div>`;
        body.append(hotkeysCard(), names, sidebarCard(), backupCard());
        const rowsEl = names.querySelector('[data-rows]');
        const status = names.querySelector('[data-status]');
        const flash = t => { status.textContent = t; clearTimeout(flash.t); flash.t = setTimeout(() => { status.textContent = ''; }, 1800); };

        const render = () => {
            rowsEl.textContent = '';
            const list = [...State.playlists.values()].sort((a, b) =>
                playlistSortIndex(a.name) - playlistSortIndex(b.name) || (a.name || '').localeCompare(b.name || ''));
            if (!list.length) {
                const e = document.createElement('div');
                e.className = 'text-sm text-gray-500';
                e.textContent = 'No playlists loaded yet — open any page while logged in, then come back.';
                rowsEl.appendChild(e);
                return;
            }
            list.forEach(p => {
                const explicit = playlistStyleKeys(p).map(k => playlistConfig.styles[k]).find(Boolean) || null;
                const st = getPlaylistStyle(p.name, p.id) || {};
                const row = document.createElement('div');
                row.className = 'pn-row';
                const color = document.createElement('input');
                color.type = 'color';
                color.value = '#' + (isRejectList(p.id) ? REJECT_HEX : (st.color || FALLBACK_COLOR));
                color.disabled = isRejectList(p.id);
                color.title = isRejectList(p.id) ? 'The reject list is always red' : 'Colour';
                const name = document.createElement('div');
                name.className = 'pn-name';
                name.title = p.name || p.id;
                name.textContent = p.name || p.id;
                const n = document.createElement('small');
                n.textContent = `${p.ids.size}`;
                name.appendChild(n);
                const label = document.createElement('input');
                label.type = 'text';
                label.placeholder = 'Short name';
                label.value = explicit?.label || '';
                const reset = document.createElement('button');
                reset.type = 'button';
                reset.className = 'pn-reset';
                reset.textContent = '✕';
                reset.title = 'Reset name and colour';
                reset.disabled = !explicit;
                let t = null;
                label.addEventListener('input', () => {
                    clearTimeout(t);
                    t = setTimeout(() => {
                        setPlaylistStyle(p, { label: label.value.trim() || null });
                        savePlaylistConfig();
                        reset.disabled = false;
                        flash('Saved');
                    }, 400);
                });
                color.addEventListener('change', () => {
                    setPlaylistStyle(p, { color: color.value.replace('#', '').toLowerCase() });
                    savePlaylistConfig();
                    reset.disabled = false;
                    flash('Saved');
                });
                reset.addEventListener('click', () => {
                    playlistStyleKeys(p).forEach(k => delete playlistConfig.styles[k]);
                    savePlaylistConfig();
                    flash('Reset');
                    render();
                });
                row.append(color, name, label, reset);
                rowsEl.appendChild(row);
            });
        };
        names.querySelector('[data-reset-all]').addEventListener('click', () => {
            if (!confirm('Reset the short names and colours of all playlists?')) return;
            Object.keys(playlistConfig.styles).forEach(k => delete playlistConfig.styles[k]);
            savePlaylistConfig();
            flash('All reset');
            render();
        });
        render();
        const onReady = () => { if (sec.isConnected) render(); else window.removeEventListener('pmv:cache-ready', onReady); };
        window.addEventListener('pmv:cache-ready', onReady);
        list.appendChild(sec);
        if (location.hash === '#pmvx') setTimeout(() => sec.scrollIntoView({ block: 'start', behavior: 'smooth' }), 100);
    }

    // Vue re-renders can drop the section; put it back.
    let settingsPageQueued = false;
    new MutationObserver(() => {
        if (settingsPageQueued || location.pathname.replace(/\/+$/, '') !== '/settings') return;
        settingsPageQueued = true;
        requestAnimationFrame(() => { settingsPageQueued = false; try { injectSettingsPageSection(); } catch {} });
    }).observe(document.body, { childList: true, subtree: true });

    // --- Sidebar: hide items (set on the full settings page) ---
    // Keys: "g:<label>" (group header + items) or "a:<href>" (one link); hidden via data-* flag + stylesheet.
    const NAV_HIDE_KEY = 'pmv_sidebar_hidden_v1';
    let navHidden = new Set((() => { try { return JSON.parse(localStorage.getItem(NAV_HIDE_KEY) || '[]'); } catch { return []; } })());
    function saveNavHidden() {
        try { if (navHidden.size) localStorage.setItem(NAV_HIDE_KEY, JSON.stringify([...navHidden])); else localStorage.removeItem(NAV_HIDE_KEY); } catch {}
    }
    function navLinkLabel(a) {
        const span = a.querySelector('span.flex-1');
        const t = (span ? span.textContent : [...a.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ') || a.textContent).trim();
        return t.replace(/\s+BETA$/i, '').replace(/\s+/g, ' ');
    }
    // Every hideable entry of the visible sidebar: [{ key, label, el, group, depth }]
    function navEntries() {
        const aside = [...document.querySelectorAll('aside')].find(a => a.getClientRects().length && a.querySelector('nav'));
        if (!aside) return [];
        const out = [];
        const inGroup = new Set();
        aside.querySelectorAll('button[aria-label^="Toggle "][aria-label$=" submenu"]').forEach(btn => {
            const label = btn.getAttribute('aria-label').slice(7, -8).trim();
            const wrap = btn.id === 'pmvx-saved-nav' ? btn : (btn.closest('#pmvx-saved-nav') || btn.closest('div.mt-1') || btn.parentElement?.parentElement);
            if (!wrap || inGroup.has(wrap)) return;
            inGroup.add(wrap);
            out.push({ key: 'g:' + label, label, el: wrap, group: true, depth: 0 });
            if (wrap.id === 'pmvx-saved-nav') return; // its playlists come and go
            wrap.querySelectorAll('a[href]').forEach(a => {
                if (a.closest('div.flex.items-center.justify-between') && a.closest('div.flex.items-center.justify-between').contains(btn)) return; // the header link
                const label2 = navLinkLabel(a);
                if (label2) out.push({ key: 'a:' + a.getAttribute('href'), label: label2, el: a, group: false, depth: 1, parent: label });
            });
        });
        aside.querySelectorAll('a[href]').forEach(a => {
            if ([...inGroup].some(w => w.contains(a))) return;
            if (a.closest('.mobile-profile')) return;
            const label = navLinkLabel(a);
            if (!label || out.some(e => e.key === 'a:' + a.getAttribute('href'))) return;
            out.push({ key: 'a:' + a.getAttribute('href'), label, el: a, group: false, depth: 0 });
        });
        return out;
    }
    function applyNavHidden() {
        if (!document.getElementById('pmv-navhide-style')) {
            const st = document.createElement('style');
            st.id = 'pmv-navhide-style';
            st.textContent = '[data-pmvx-nav-hidden="1"]{display:none !important;}';
            (document.head || document.documentElement).appendChild(st);
        }
        if (!navHidden.size && !document.querySelector('[data-pmvx-nav-hidden]')) return;
        navEntries().forEach(e => {
            const hide = navHidden.has(e.key);
            if (hide && e.el.dataset.pmvxNavHidden !== '1') e.el.dataset.pmvxNavHidden = '1';
            else if (!hide && e.el.dataset.pmvxNavHidden) delete e.el.dataset.pmvxNavHidden;
        });
    }

    function sidebarCard() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
        const render = () => {
            wrap.textContent = '';
            const list = navEntries();
            if (!list.length) {
                const e = document.createElement('div');
                e.className = 'ts-meta';
                e.textContent = 'The sidebar is not open on this page — open it to choose items.';
                wrap.appendChild(e);
                return;
            }
            list.forEach(e => {
                const row = document.createElement('div');
                row.className = 'ts-row2';
                row.style.cssText = `padding:6px 0 6px ${e.depth ? 18 : 0}px;border-bottom:1px solid #1F1F1F;`;
                const lab = document.createElement('span');
                lab.style.cssText = `font-size:14px;color:${e.group ? '#fff' : 'rgb(209,213,219)'};font-weight:${e.group ? 600 : 400};`;
                lab.textContent = e.label + (e.group ? ' (group)' : '');
                const sw = document.createElement('button');
                sw.type = 'button';
                sw.className = 'ts-sw';
                sw.setAttribute('role', 'switch');
                sw.innerHTML = '<span class="k"></span>';
                const paint = () => sw.setAttribute('aria-checked', navHidden.has(e.key) ? 'false' : 'true');
                paint();
                sw.onclick = () => {
                    if (navHidden.has(e.key)) navHidden.delete(e.key); else navHidden.add(e.key);
                    saveNavHidden(); applyNavHidden(); paint();
                };
                row.append(lab, sw);
                wrap.appendChild(row);
            });
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'ts-btn';
            reset.style.marginTop = '8px';
            reset.textContent = 'Show everything';
            reset.onclick = () => { navHidden.clear(); saveNavHidden(); applyNavHidden(); render(); };
            wrap.appendChild(reset);
        };
        render();
        // The sidebar may render after this card.
        if (!navEntries().length) setTimeout(render, 1500);
        return toolsCard('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>',
            '', 'Sidebar', 'Hide items you never use. A group hides its header and everything in it.', wrap);
    }

    // --- Sidebar: "Saved content" group ---
    // Favorites + own playlists under Explore, cloned from the sidebar's rows; re-added on Vue re-renders.

    const SAVED_NAV_KEY = 'pmv_saved_nav_open_v1';
    const SAVED_NAV_ICON = {
        bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>',
        heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
        list: '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/>',
        ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
        chevronDown: '<path d="m6 9 6 6 6-6"/>',
        chevronRight: '<path d="m9 18 6-6-6-6"/>',
    };
    let savedNavOpen = (() => { try { return localStorage.getItem(SAVED_NAV_KEY) !== '0'; } catch { return true; } })();
    let savedNavSig = '';

    function setNavIcon(svgEl, paths) {
        if (!svgEl) return;
        svgEl.setAttribute('viewBox', '0 0 24 24');
        svgEl.innerHTML = `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
    }

    function siteNavigate(href) {
        const router = document.querySelector('#__nuxt')?.__vue_app__?.config?.globalProperties?.$router;
        if (router) router.push(href).catch(() => { location.href = href; });
        else location.href = href;
    }

    // PMVX.navRowHook(link, playlist) / navRowSig(playlist) (in the redraw signature) let builds extend rows.
    PMVX.refreshSavedNav = () => { try { injectSavedNav(); } catch {} };

    function savedNavLink(template, href, label, icon, extraTitle) {
        const a = template.cloneNode(true);
        [...a.attributes].forEach(at => { if (at.name !== 'class' && !at.name.startsWith('data-v-')) a.removeAttribute(at.name); });
        a.href = href;
        a.title = extraTitle || label;
        a.dataset.pmvSavedNav = '1';
        a.classList.remove('router-link-active', 'router-link-exact-active');
        const svgEl = a.querySelector('svg');
        const span = a.querySelector('span.flex-1') || document.createElement('span');
        // Keep only icon and label: drop badges and Vue comment nodes.
        a.textContent = '';
        if (svgEl) { setNavIcon(svgEl, icon); a.appendChild(svgEl); }
        span.className = 'flex-1';
        // min-width:0 lets long names ellipsize instead of widening the sidebar.
        span.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;';
        a.style.minWidth = '0';
        a.style.maxWidth = '100%';
        a.style.overflow = 'hidden';
        span.textContent = label;
        a.appendChild(span);
        a.addEventListener('click', e => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            siteNavigate(href);
        });
        return a;
    }

    function injectSavedNav() {
        const exploreToggle = document.querySelector('aside button[aria-label="Toggle Explore submenu"]');
        const exploreGroup = exploreToggle?.closest('div.mt-1');
        if (!exploreGroup) return;
        const existing = document.getElementById('pmvx-saved-nav');
        const playlists = [...State.playlists.values()].sort((a, b) =>
            playlistSortIndex(a.name) - playlistSortIndex(b.name) || (a.name || '').localeCompare(b.name || ''));
        if (!playlists.length) { existing?.remove(); return; }
        const sig = savedNavOpen + '|' + playlists.map(p => p.id + ':' + getPlaylistDisplayName(p.name, p.id) + ':' + p.ids.size + ':' + (PMVX.navRowSig?.(p) || '')).join('|');
        if (existing && existing.previousElementSibling === exploreGroup && savedNavSig === sig) return;

        const headRowTpl = exploreToggle.closest('div.flex.items-center.justify-between');
        const linkTpl = exploreGroup.querySelector('#watch-videos-group a') || exploreGroup.querySelector('a');
        if (!headRowTpl || !linkTpl) return;

        const group = document.createElement('div');
        group.id = 'pmvx-saved-nav';
        group.className = exploreGroup.className;
        group.style.minWidth = '0';
        group.style.maxWidth = '100%';

        const head = headRowTpl.cloneNode(true);
        head.querySelectorAll('[aria-controls],[aria-expanded]').forEach(el => { el.removeAttribute('aria-controls'); el.removeAttribute('aria-expanded'); });
        const headLink = head.querySelector('a');
        const toggle = head.querySelector('button');
        if (headLink) {
            headLink.removeAttribute('href');
            headLink.removeAttribute('aria-label');
            // No role="button": the playlist-page filter finds queue rows by [role="button"].
            headLink.setAttribute('aria-expanded', savedNavOpen ? 'true' : 'false');
            headLink.classList.remove('router-link-active', 'router-link-exact-active');
            headLink.style.cursor = 'pointer';
            const icon = headLink.querySelector('svg');
            const iconClone = icon ? icon.cloneNode(false) : null;
            headLink.textContent = '';
            if (iconClone) { setNavIcon(iconClone, SAVED_NAV_ICON.bookmark); headLink.appendChild(iconClone); }
            headLink.appendChild(document.createTextNode(' Saved content '));
        }
        if (toggle) {
            toggle.setAttribute('aria-label', 'Toggle Saved content submenu');
            setNavIcon(toggle.querySelector('svg'), savedNavOpen ? SAVED_NAV_ICON.chevronDown : SAVED_NAV_ICON.chevronRight);
        }
        const flip = e => {
            e.preventDefault();
            e.stopPropagation();
            savedNavOpen = !savedNavOpen;
            try { localStorage.setItem(SAVED_NAV_KEY, savedNavOpen ? '1' : '0'); } catch {}
            injectSavedNav();
        };
        headLink?.addEventListener('click', flip);
        toggle?.addEventListener('click', flip);
        group.appendChild(head);

        if (savedNavOpen) {
            const items = document.createElement('div');
            items.className = exploreGroup.querySelector('#watch-videos-group')?.className || 'mt-1 space-y-1 pl-3';
            items.appendChild(savedNavLink(linkTpl, '/profile#favorites', 'Favorites', SAVED_NAV_ICON.heart));
            playlists.forEach(p => {
                const name = getPlaylistDisplayName(p.name, p.id) || p.name || p.id;
                const rej = isRejectList(p.id);
                const a = savedNavLink(linkTpl, `/playlists/${p.id}`, name, rej ? SAVED_NAV_ICON.ban : SAVED_NAV_ICON.list,
                    `${p.name || p.id} — ${p.ids.size} videos`);
                const n = document.createElement('span');
                n.textContent = String(p.ids.size);
                n.style.cssText = 'flex-shrink:0;font-size:11px;color:rgb(107,114,128);font-variant-numeric:tabular-nums;';
                a.appendChild(n);
                try { PMVX.navRowHook?.(a, p); } catch {}
                items.appendChild(a);
            });
            group.appendChild(items);
        }

        savedNavSig = sig;
        if (existing) existing.replaceWith(group);
        exploreGroup.after(group);
    }

    let favTabTries = 0;
    function openFavoritesTabIfAsked() {
        if (location.pathname.replace(/\/+$/, '') !== '/profile' || location.hash !== '#favorites') { favTabTries = 0; return; }
        if (favTabTries > 40) return;
        favTabTries++;
        const tab = [...document.querySelectorAll('button')].find(b =>
            b.classList.contains('pb-3') && /^Favorites\b/.test(b.textContent.trim()));
        if (!tab) return;
        favTabTries = 99;
        if (!tab.className.includes('text-orange-400')) tab.click();
    }

    let savedNavQueued = false;
    new MutationObserver(() => {
        if (savedNavQueued) return;
        savedNavQueued = true;
        requestAnimationFrame(() => {
            savedNavQueued = false;
            try { injectSavedNav(); } catch {}
            try { applyNavHidden(); } catch {}
            try { openFavoritesTabIfAsked(); } catch {}
        });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('pmv:cache-ready', () => { try { injectSavedNav(); } catch {} });

    // The site's gear: header button whose lucide:settings icon has an r=3 center circle.
    function siteSettingsButton() {
        const row = headerControlRow();
        return row && [...row.querySelectorAll('button')]
            .find(b => b.querySelector('svg circle[r="3"][cx="12"][cy="12"]')) || null;
    }

    function openToolsSettings() {
        if (nativeSettingsList()) {
            nativeSettingsList().querySelector(':scope > [data-pmv-tools-settings]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
        }
        const gear = siteSettingsButton();
        if (gear) {
            gear.click();
            // Scrolled to once Vue has rendered the modal and the section is added.
            setTimeout(() => {
                injectToolsSettings();
                nativeSettingsList()?.querySelector(':scope > [data-pmv-tools-settings]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }, 150);
            return;
        }
        // Logged out: no gear, so open a modal copy holding only this section.
        if (document.getElementById('pmv-ts-modal')) return;
        const ov = document.createElement('div');
        ov.id = 'pmv-ts-modal';
        ov.style.cssText = 'position:fixed;inset:0;z-index:999990;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);';
        ov.innerHTML = `
            <div style="background:#1A1A1A;border:1px solid #2A2A2A;border-radius:12px;max-width:672px;width:100%;padding:24px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);max-height:90vh;overflow-y:auto;box-sizing:border-box;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                    <h2 style="margin:0;font-size:24px;line-height:32px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px;"><span style="display:inline-flex;width:24px;height:24px;">${TS_SVG.gear}</span>Settings</h2>
                    <button type="button" data-close style="display:inline-flex;padding:8px;border:none;border-radius:8px;background:transparent;color:rgb(156,163,175);cursor:pointer;"><span style="display:inline-flex;width:20px;height:20px;">${TS_SVG.x}</span></button>
                </div>
                <div data-body></div>
                <div style="margin-top:24px;display:flex;justify-content:flex-end;gap:12px;">
                    <button type="button" data-close style="padding:8px 16px;border:none;border-radius:8px;background:#2A2A2A;color:#fff;cursor:pointer;font-family:inherit;font-size:16px;">Close</button>
                </div>
            </div>`;
        ov.querySelector('[data-body]').replaceWith(buildToolsSettingsSection());
        const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
        const onKey = e => { if (e.key === 'Escape' && !document.getElementById('pmv-keyeditor')) { e.stopPropagation(); close(); } };
        ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(ov);
    }

