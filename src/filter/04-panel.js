    // --- Playlist-page filter panel ---
    // The native input stays hidden in the DOM (syncToVue() writes to it); own search field + Filters replace it.
    // The panel is a drawer over the queue (absolute in the sidebar card, own scroll): it never pushes it.
    // Chips are composed back into the token string for parseTokens().
    const UI = { pos: [], neg: [], raw: [], seen: null, dpos: [], dneg: [], draw: [], open: false };
    const UI_OPEN_KEY = 'pmvnf_panel_open_v1';
    try { UI.open = localStorage.getItem(UI_OPEN_KEY) === '1'; } catch {}

    function splitText(text) {
        const t = parseTokens(text || '');
        return { pos: t.textInclude.slice(), neg: t.textExclude.slice(), seen: t.seenFilter,
                 raw: tokenizeRaw(text || '').filter(tok => /^!(in|out)/.test(tok)) };
    }
    function textToUi(text) {
        const p = splitText(text);
        UI.pos.splice(0, UI.pos.length, ...p.pos);
        UI.neg.splice(0, UI.neg.length, ...p.neg);
        UI.raw.splice(0, UI.raw.length, ...p.raw);
        UI.seen = p.seen;
        NF.renderOwnChips?.();
    }
    function defaultsToUi(text) {
        const p = splitText(text);
        UI.dpos.splice(0, UI.dpos.length, ...p.pos);
        UI.dneg.splice(0, UI.dneg.length, ...p.neg);
        UI.draw.splice(0, UI.draw.length, ...p.raw, ...(p.seen ? ['!' + p.seen] : []));
    }
    function quoteTerm(term) {
        return PMVX.isWordTerm(term) || /\s/.test(term) ? `"${PMVX.termLabel(term)}"` : term;
    }
    function compose(pos, neg, seen, raw) {
        const parts = [];
        pos.forEach(t => parts.push(quoteTerm(t)));
        neg.forEach(t => parts.push('-' + quoteTerm(t)));
        if (seen === 'seen') parts.push('!seen');
        if (seen === 'unseen') parts.push('!unseen');
        raw.forEach(t => parts.push(t));
        return parts.join(' ');
    }
    const uiToText = () => compose(UI.pos, UI.neg, UI.seen, UI.raw);
    const uiToDefaults = () => compose(UI.dpos, UI.dneg, null, UI.draw);
    function anyPending() {
        return uiToText() !== (NF.lastOwnValue || '')
            || pendingPlaylistMode !== BTN.playlistMode
            || !isSetEqual(pendingSelectedPlaylistIds, BTN.selectedPlaylistIds)
            || pendingSavedSearchName !== BTN.savedSearchName
            || pendingRatingMin !== BTN.ratingMin || pendingRatingMax !== BTN.ratingMax
            || pendingDurationMin !== BTN.durationMin || pendingDurationMax !== BTN.durationMax
            || !sameFlags(pendingFlags, BTN.flags)
            || pendingDefaultTerms !== NF.defaultTerms;
    }

    function injectOwnPanelStyle() {
        if (document.getElementById('pmvnf-panel-style')) return;
        const css = `
[data-pmvnf-native-hidden="1"]{display:none !important;}
[data-pmvnf-card="1"]{position:relative !important;}
#pmvnf-wrap{margin-top:12px;display:flex;flex-direction:column;gap:6px;font-family:inherit;}
#pmvnf-wrap *,#pmvnf-panel *,.pmvnf-dd *{box-sizing:border-box;}
.pmvnf-top{display:flex;gap:6px;align-items:stretch;}
.pmvnf-power{position:relative;flex-shrink:0;align-self:center;width:32px;height:18px;padding:0;border:none;border-radius:9999px;cursor:pointer;background:#3A3A3A;transition:background .15s;}
.pmvnf-power:hover{background:#454545;}
.pmvnf-power[aria-checked="true"]{background:rgb(249,115,22);}
.pmvnf-power[aria-checked="true"]:hover{background:rgb(234,88,12);}
.pmvnf-power .knob{position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .15s;pointer-events:none;}
.pmvnf-power[aria-checked="true"] .knob{transform:translateX(14px);}
#pmvnf-wrap[data-off="1"] .pmvnf-chips{opacity:.4;}
.pmvnf-search{flex:1;min-width:0;position:relative;display:flex;align-items:center;}
.pmvnf-search svg{position:absolute;left:8px;width:14px;height:14px;color:rgb(107,114,128);pointer-events:none;}
.pmvnf-search input{width:100%;padding:6px 10px 6px 28px;border-radius:4px;border:none;outline:none;background:#272727;color:rgb(229,231,235);font-size:12px;font-family:inherit;transition:background .15s;}
.pmvnf-search input:focus{background:#323232;outline:none !important;box-shadow:none !important;}
.pmvnf-search input::placeholder{color:rgb(107,114,128);}
.pmvnf-toggle{display:inline-flex;align-items:center;gap:5px;padding:0 10px;border-radius:4px;border:none;cursor:pointer;flex-shrink:0;
  background:#272727;color:rgb(209,213,219);font-size:11px;font-weight:500;font-family:inherit;white-space:nowrap;}
.pmvnf-toggle:hover{background:#323232;}
.pmvnf-toggle[data-open="1"],.pmvnf-toggle[data-active="1"]{background:rgb(249,115,22);color:#fff;}
.pmvnf-toggle svg{width:12px;height:12px;}
.pmvnf-chev{padding:0 6px;} .pmvnf-chev svg{transition:transform .15s;} .pmvnf-chev[data-open="1"] svg{transform:rotate(180deg);}
.pmvnf-toggle.pending{box-shadow:0 0 0 2px rgba(249,115,22,0.45);}
.pmvnf-toggle .badge{min-width:16px;height:16px;padding:0 4px;border-radius:9999px;background:rgba(0,0,0,0.3);font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;font-variant-numeric:tabular-nums;}
.pmvnf-toggle .badge:empty{display:none;}
.pmvnf-chips{display:flex;flex-wrap:wrap;gap:4px;}
.pmvnf-chips:empty{display:none;}
.pmvnf-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:4px;border:none;cursor:default;font-size:11px;line-height:16px;font-family:inherit;}
.pmvnf-tag svg{width:10px;height:10px;}
.pmvnf-tag .w{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:0 4px;border-radius:3px;background:rgba(0,0,0,0.3);}
.pmvnf-tag .x{display:inline-flex;opacity:.6;padding:2px;border-radius:3px;cursor:pointer;margin-left:1px;}
.pmvnf-tag .x:hover{opacity:1;background:rgba(255,255,255,0.12);}
.pmvnf-tag.pos{background:rgba(249,115,22,0.2);color:rgb(253,186,116);}
.pmvnf-tag.neg{background:rgba(239,68,68,0.2);color:rgb(252,165,165);} .pmvnf-tag.neg .txt{text-decoration:line-through;}
.pmvnf-tag.raw{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.6);font-family:inherit;font-variant-numeric:tabular-nums;}
.pmvnf-tag.def{opacity:.75;outline:1px dashed rgba(255,255,255,0.15);outline-offset:-1px;}
#pmvnf-panel{position:absolute;left:0;right:0;bottom:0;z-index:30;display:none;flex-direction:column;background:#1A1A1A;}
#pmvnf-panel[data-open="1"]{display:flex;}
.pmvnf-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px 8px;display:flex;flex-direction:column;gap:12px;}
.pmvnf-sec{display:flex;flex-direction:column;gap:5px;}
.pmvnf-lab{font-size:10px;font-weight:600;color:rgb(156,163,175);text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:6px;}
.pmvnf-lab .r{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400;color:rgba(255,255,255,0.35);font-family:inherit;font-variant-numeric:tabular-nums;}
#pmvnf-panel input[type=text]{width:100%;padding:6px 10px;border-radius:4px;border:none;outline:none;background:#272727;color:rgb(229,231,235);font-size:12px;font-family:inherit;transition:background .15s;}
#pmvnf-panel input[type=text]:focus{background:#323232;outline:none !important;box-shadow:none !important;}
#pmvnf-panel input::placeholder{color:rgb(107,114,128);}
.pmvnf-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:4px;border:none;cursor:pointer;
  background:#272727;color:rgb(209,213,219);font-size:11px;font-weight:500;line-height:1.2;font-family:inherit;white-space:nowrap;transition:background .15s,color .15s;}
.pmvnf-chip:hover{background:#323232;}
.pmvnf-chip.active{background:rgb(249,115,22);color:#fff;}
.pmvnf-chip.pending{outline:1px dashed rgba(249,115,22,0.8);outline-offset:-1px;}
.pmvnf-chip.active.in{background:rgb(34,197,94);} .pmvnf-chip.active.out{background:rgb(239,68,68);}
.pmvnf-sortseg{display:inline-flex;align-items:stretch;border-radius:4px;background:#272727;color:rgb(209,213,219);overflow:hidden;}
.pmvnf-sortseg[data-active="1"]{background:rgb(249,115,22);color:#fff;}
.pmvnf-sortseg[data-active="1"] .pmvnf-sel.native,.pmvnf-sortseg[data-active="1"] .pmvnf-sel.native svg{color:#fff;}
#pmvnf-sortdir{border:none;background:transparent;color:inherit;cursor:pointer;padding:0 6px 0 8px;font-size:12px;line-height:1;font-family:inherit;border-right:1px solid rgba(255,255,255,0.12);}
#pmvnf-sortdir:hover{background:rgba(255,255,255,0.08);}
.pmvnf-sortseg .pmvnf-sel.native{background:transparent;border-radius:0;padding:6px 6px 6px 7px;gap:4px;}
.pmvnf-sortseg .pmvnf-sel.native[data-active="1"]{background:transparent;}
.pmvnf-sortseg .pmvnf-sel.native svg{width:12px;height:12px;}
.pmvnf-hint{font-size:10px;color:rgba(255,255,255,0.35);line-height:1.4;}
.pmvnf-pillrow{display:flex;justify-content:center;}
.pmvnf-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:9999px;background:rgba(249,115,22,0.12);color:rgb(249,115,22);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;}
.pmvnf-pill .sep{color:rgba(249,115,22,0.5);}
.pmvnf-slider{position:relative;height:26px;}
.pmvnf-slider .track{position:absolute;top:11px;left:0;right:0;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);}
.pmvnf-slider .fill{position:absolute;top:11px;height:4px;border-radius:2px;background:linear-gradient(90deg,rgb(249,115,22),rgb(251,146,60));}
.pmvnf-slider input[type=range]{position:absolute;top:11px;left:0;width:100%;height:4px;margin:0;padding:0;-webkit-appearance:none;appearance:none;background:transparent;pointer-events:none;outline:none;}
.pmvnf-slider input[type=range]::-webkit-slider-runnable-track{background:transparent;height:4px;}
.pmvnf-slider input[type=range]::-moz-range-track{background:transparent;height:4px;border:none;}
.pmvnf-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;border:3px solid rgb(249,115,22);box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;}
.pmvnf-slider input[type=range]::-moz-range-thumb{pointer-events:auto;width:8px;height:8px;border-radius:50%;background:#fff;border:3px solid rgb(249,115,22);box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;}
.pmvnf-sliderlabels{display:flex;justify-content:space-between;color:rgba(255,255,255,0.35);font-size:10px;margin-top:-4px;}
.pmvnf-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 16px;border-top:1px solid #2A2A2A;background:#1A1A1A;flex-shrink:0;}
.pmvnf-apply{padding:6px 12px;border-radius:4px;border:none;cursor:pointer;background:rgb(249,115,22);color:#fff;font-size:11px;font-weight:600;font-family:inherit;}
.pmvnf-apply:hover{background:rgb(234,88,12);}
.pmvnf-apply.pending{box-shadow:0 0 0 2px rgba(249,115,22,0.35);}
.pmvnf-close{margin-left:auto;background:transparent;border:none;color:rgb(156,163,175);cursor:pointer;font-size:11px;font-family:inherit;padding:4px 6px;border-radius:4px;}
.pmvnf-close:hover{background:#272727;color:#fff;}
#pmvnf-counter{font-size:10px;color:rgba(255,255,255,0.4);font-family:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;}
#pmvnf-fetchall-status{font-size:10px;color:rgba(255,255,255,0.3);white-space:nowrap;font-family:inherit;font-variant-numeric:tabular-nums;}
#pmvnf-qfoot{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid #2A2A2A;background:#1A1A1A;flex-shrink:0;}
/* native custom-select look (scaled to the sidebar) */
.pmvnf-sel{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border-radius:6px;cursor:pointer;text-align:left;
  background:#0F0F0F;border:1px solid #2A2A2A;color:#fff;font-size:12px;font-family:inherit;transition:border-color .15s;}
.pmvnf-sel:hover{border-color:#3A3A3A;}
.pmvnf-sel[data-open="1"]{border-color:rgb(249,115,22);}
.pmvnf-sel .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmvnf-sel .t.ph{color:rgb(107,114,128);}
.pmvnf-sel .n{color:rgba(255,255,255,0.4);font-size:10px;font-family:inherit;font-variant-numeric:tabular-nums;}
.pmvnf-sel svg{width:14px;height:14px;color:rgb(156,163,175);flex-shrink:0;transition:transform .15s;}
.pmvnf-sel[data-open="1"] svg{transform:rotate(180deg);}
.pmvnf-sel.native{width:auto;padding:6px 8px;border-radius:4px;background:#272727;border:none;color:rgb(209,213,219);font-size:11px;font-weight:500;}
.pmvnf-sel.native[data-active="1"]{background:rgb(249,115,22);color:#fff;} .pmvnf-sel.native[data-active="1"] svg{color:#fff;}
.pmvnf-dd{position:fixed;z-index:999999;min-width:200px;max-height:min(60vh,420px);overflow-y:auto;border-radius:10px;
  background:#141414;border:1px solid rgba(249,115,22,0.45);box-shadow:0 12px 32px rgba(0,0,0,0.6);font-family:inherit;}
.pmvnf-dd .row{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;border-bottom:1px solid #1F1F1F;}
.pmvnf-dd .row:last-child{border-bottom:none;}
.pmvnf-dd .row:hover{background:rgba(255,255,255,0.04);}
.pmvnf-dd .row[data-sel="1"]{background:rgba(249,115,22,0.12);}
.pmvnf-dd .row .tt{flex:1;min-width:0;}
.pmvnf-dd .row .ti{display:block;color:#fff;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pmvnf-dd .row .su{display:block;color:rgb(156,163,175);font-size:10px;margin-top:1px;}
.pmvnf-dd .row .ck{width:14px;height:14px;color:rgb(249,115,22);flex-shrink:0;visibility:hidden;}
.pmvnf-dd .row[data-sel="1"] .ck{visibility:visible;}
.pmvnf-dd .empty{padding:10px 12px;color:rgb(156,163,175);font-size:11px;}
`;
        const st = document.createElement('style');
        st.id = 'pmvnf-panel-style';
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const mkChip = (text, onClick, title) => { const b = mk('button', 'pmvnf-chip', text); b.type = 'button'; if (title) b.title = title; b.onclick = onClick; return b; };
    const SVG_X = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    const SVG_BAN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
    const SVG_FILTER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H3m9 14H3M14 3v4m2 10v4m5-9h-9m9 7h-5m5-14h-7m-6 5v4m0-2H3"/></svg>';
    const SVG_CHEV = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    const SVG_CHECK = '<svg class="ck" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    const SVG_SEARCH = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

    // Site-style custom select; items(): [{value,title,sub}]. position:fixed: the scrolling panel would clip it.
    let openDd = null;
    function closeDd() { if (openDd) { openDd.list.remove(); openDd.btn.dataset.open = '0'; openDd = null; } }
    document.addEventListener('click', e => { if (openDd && !openDd.list.contains(e.target) && !openDd.btn.contains(e.target)) closeDd(); }, true);
    window.addEventListener('resize', closeDd);
    function mkSelect({ items, multi = false, isSelected, onPick, label, placeholder = 'Choose…', native = false, emptyText = 'Nothing available', icon = null }) {
        const btn = mk('button', 'pmvnf-sel' + (native ? ' native' : ''));
        btn.type = 'button';
        if (icon) { const i = mk('span'); i.innerHTML = icon; i.style.display = 'inline-flex'; btn.appendChild(i); }
        const t = mk('span', 't'); const n = mk('span', 'n'); const ch = mk('span'); ch.innerHTML = SVG_CHEV; ch.style.display = 'inline-flex';
        btn.append(t, n, ch);
        const render = () => {
            const list = items();
            const sel = list.filter(i => isSelected(i.value));
            if (!sel.length) { t.textContent = placeholder; t.classList.add('ph'); n.textContent = ''; }
            else { t.classList.remove('ph'); t.textContent = sel.length <= 2 ? sel.map(i => i.title).join(', ') : `${sel.length} selected`; n.textContent = sel.length > 2 ? '' : ''; }
            btn.dataset.active = sel.length && native ? '1' : '0';
            if (label) btn.title = label;
        };
        const open = () => {
            closeDd();
            const list = mk('div', 'pmvnf-dd');
            const its = items();
            if (!its.length) list.appendChild(mk('div', 'empty', emptyText));
            its.forEach(it => {
                const row = mk('div', 'row');
                row.dataset.sel = isSelected(it.value) ? '1' : '0';
                const tt = mk('div', 'tt'); tt.appendChild(mk('span', 'ti', it.title)); if (it.sub) tt.appendChild(mk('span', 'su', it.sub));
                row.appendChild(tt);
                const ck = mk('span'); ck.innerHTML = SVG_CHECK; ck.style.display = 'inline-flex'; row.appendChild(ck.firstChild);
                row.onclick = () => {
                    onPick(it.value);
                    render();
                    if (multi) [...list.querySelectorAll('.row')].forEach((r, i) => r.dataset.sel = isSelected(its[i].value) ? '1' : '0');
                    else closeDd();
                };
                list.appendChild(row);
            });
            document.body.appendChild(list);
            const r = btn.getBoundingClientRect();
            const w = Math.max(r.width, 220);
            list.style.minWidth = w + 'px';
            let left = r.left; if (left + w > innerWidth - 8) left = Math.max(8, innerWidth - 8 - w);
            list.style.left = left + 'px';
            const h = list.getBoundingClientRect().height;
            if (r.bottom + 4 + h > innerHeight - 8 && r.top - 4 - h > 8) list.style.top = (r.top - 4 - h) + 'px';
            else list.style.top = (r.bottom + 4) + 'px';
            btn.dataset.open = '1';
            openDd = { btn, list };
        };
        btn.onclick = (e) => { e.stopPropagation(); if (openDd?.btn === btn) closeDd(); else open(); };
        render();
        return { el: btn, render };
    }

    function mkDualSlider({ min, max, getRange, setRange, fmt, presets }) {
        const sec = mk('div');
        const pillRow = mk('div', 'pmvnf-pillrow');
        const pill = mk('div', 'pmvnf-pill');
        const pA = mk('span'), pB = mk('span');
        pill.append(pA, mk('span', 'sep', '-'), pB); pillRow.appendChild(pill);
        const slider = mk('div', 'pmvnf-slider');
        const fill = mk('div', 'fill');
        const rA = mk('input'); rA.type = 'range'; rA.min = String(min); rA.max = String(max); rA.step = '1';
        const rB = mk('input'); rB.type = 'range'; rB.min = String(min); rB.max = String(max); rB.step = '1';
        slider.append(mk('div', 'track'), fill, rA, rB);
        const labels = mk('div', 'pmvnf-sliderlabels');
        labels.append(mk('span', null, fmt(min, false)), mk('span', null, fmt(max, true)));
        const chips = mk('div', 'pmvnf-chips');
        const presetBtns = presets.map(p => { const c = mkChip(p.label, () => { setRange(p.a, p.b); render(); }, p.title); chips.appendChild(c); return c; });
        const paint = (a, b) => {
            pA.textContent = fmt(a, false); pB.textContent = fmt(b, true);
            fill.style.left = ((a - min) / (max - min) * 100) + '%';
            fill.style.width = (Math.max(0, b - a) / (max - min) * 100) + '%';
        };
        const render = () => {
            const [a, b] = getRange();
            rA.value = String(a); rB.value = String(b);
            paint(a, b);
            presetBtns.forEach((c, i) => c.classList.toggle('active', presets[i].a === a && presets[i].b === b));
            refreshPendingMarks();
        };
        const onInput = (which) => () => {
            let a = parseInt(rA.value, 10), b = parseInt(rB.value, 10);
            if (a > b) { if (which === 'a') { b = a; rB.value = String(b); } else { a = b; rA.value = String(a); } }
            paint(a, b); setRange(a, b);
            presetBtns.forEach((c, i) => c.classList.toggle('active', presets[i].a === a && presets[i].b === b));
            refreshPendingMarks();
        };
        rA.addEventListener('input', onInput('a')); rB.addEventListener('input', onInput('b'));
        sec.append(pillRow, slider, labels, chips);
        return { el: sec, render };
    }

    let refreshPendingMarks = () => {};

    // Replaces the native "Added" sort button, kept hidden: the arrow clicks it for the site's own order.
    // Applies immediately; re-attached from startObserver().
    const SORT_ITEMS = () => [
        { value: 'native', title: 'Added', sub: 'Site order' },
        { value: 'rating', title: 'Rating', sub: 'By rating' },
        { value: 'date', title: 'Upload date', sub: 'By upload date' },
    ];
    let nativeSortAsc = false; // tracks arrow clicks on the site's order
    const sortMode = () => !currentSortMode ? 'native' : currentSortMode === 'rating' ? 'rating' : 'date';
    const sortAsc = () => sortMode() === 'native' ? nativeSortAsc : sortMode() === 'rating' ? ratingSortAscending : currentSortMode === 'date_asc';
    let sortSel = null, sortDirBtn = null;
    function applySortChoice(mode, asc) {
        if (mode === 'native') {
            if (currentSortMode) resetSort();
            if (asc !== nativeSortAsc) { nativeSortAsc = asc; document.querySelector('[data-pmvnf-native-sort="1"]')?.click(); }
        } else if (mode === 'rating') {
            ratingSortAscending = asc; applySort('rating'); saveSortSettings(); applyFilter(NF.lastOwnValue, true);
        } else {
            applySort(asc ? 'date_asc' : 'date_desc'); saveSortSettings(); applyFilter(NF.lastOwnValue, true);
        }
        sortSel?.render(); renderSortDir();
    }
    function renderSortDir() {
        if (!sortDirBtn) return;
        const asc = sortAsc();
        sortDirBtn.innerHTML = asc ? '&#8593;' : '&#8595;';
        sortDirBtn.title = (asc ? 'Low → high / old → new' : 'High → low / new → old') + ' — click to reverse';
        sortDirBtn.dataset.active = currentSortMode ? '1' : '0';
    }
    function injectSortSelect() {
        if (document.getElementById('pmvnf-sort')) return;
        const btns = [...document.querySelectorAll('button')];
        const shuffle = btns.find(b => b.textContent.trim() === 'Shuffle');
        const row = shuffle?.parentElement;
        if (!row) return;
        const added = [...row.querySelectorAll('button')].find(b => !/^(Shuffle|Loop|Auto)$/.test(b.textContent.trim()) && !b.id);
        if (added) { added.setAttribute('data-pmvnf-native-hidden', '1'); added.setAttribute('data-pmvnf-native-sort', '1'); }
        sortSel = mkSelect({
            native: true, label: 'Queue sort order', placeholder: 'Added',
            items: SORT_ITEMS,
            isSelected: v => v === sortMode(),
            onPick: v => applySortChoice(v, v === sortMode() ? sortAsc() : false),
        });
        sortSel.el.id = 'pmvnf-sort';
        const r0 = sortSel.render;
        sortSel.render = () => { r0(); sortSel.el.dataset.active = currentSortMode ? '1' : '0'; };
        // Compact [arrow | Added] segment for the Shuffle/Loop/Auto row.
        const seg = mk('div', 'pmvnf-sortseg'); seg.id = 'pmvnf-sortseg';
        sortDirBtn = mk('button'); sortDirBtn.type = 'button'; sortDirBtn.id = 'pmvnf-sortdir';
        sortDirBtn.onclick = () => applySortChoice(sortMode(), !sortAsc());
        seg.append(sortDirBtn, sortSel.el);
        const r1 = sortSel.render;
        sortSel.render = () => { r1(); seg.dataset.active = currentSortMode ? '1' : '0'; };
        sortSel.render(); renderSortDir();
        if (added) row.insertBefore(seg, added); else row.appendChild(seg);
    }

    // Fetch all footer under the queue list, not in the drawer.
    function injectQueueFooter() {
        if (document.getElementById('pmvnf-qfoot')) return;
        const list = queueRows()[0]?.closest('.overflow-y-auto');
        const card = list?.parentElement;
        if (!list || !card) return;
        const foot = mk('div'); foot.id = 'pmvnf-qfoot';
        const faBtn = mkChip('⟳ Fetch all', () => runManualFetchAll(faStatus, faBtn), 'Load the whole playlist and check that tag and performer metadata is complete');
        const faStatus = mk('span'); faStatus.id = 'pmvnf-fetchall-status';
        foot.append(faBtn, faStatus);
        card.insertBefore(foot, list.nextSibling);
    }

    function buildOwnInput() {
        if (NF.ownInput?.isConnected) return;
        injectOwnPanelStyle();
        document.getElementById('pmvnf-wrap')?.remove();
        document.getElementById('pmvnf-panel')?.remove();
        textToUi(NF.lastOwnValue);
        defaultsToUi(pendingDefaultTerms);

        const nativeWrapper = NF.input.parentElement;         // .mt-3.relative
        const header = nativeWrapper?.parentElement;           // .p-4.border-b (sidebar header)
        const card = header?.parentElement;                    // .bg-[#1A1A1A] sidebar card
        if (nativeWrapper) nativeWrapper.setAttribute('data-pmvnf-native-hidden', '1');
        if (card) card.setAttribute('data-pmvnf-card', '1');

        const wrap = mk('div'); wrap.id = 'pmvnf-wrap';
        const top = mk('div', 'pmvnf-top');
        const search = mk('div', 'pmvnf-search');
        search.innerHTML = SVG_SEARCH;
        const inpPos = mk('input');
        inpPos.type = 'text'; inpPos.spellcheck = false; inpPos.autocomplete = 'off';
        inpPos.placeholder = 'Filter videos… (title, tag, performer — Enter)';
        inpPos.dataset.pmvnfKind = 'pos'; inpPos.dataset.pmvnfApply = '1';
        inpPos.addEventListener('keydown', e => e.stopPropagation(), true);
        search.appendChild(inpPos);
        NF.ownInput = inpPos;
        // Filters applies; the chevron toggles the drawer.
        const toggle = mk('button', 'pmvnf-toggle'); toggle.type = 'button'; toggle.id = 'pmvnf-apply';
        toggle.innerHTML = `${SVG_FILTER}<span class="lbl">Filters</span><span class="badge"></span>`;
        const badge = toggle.querySelector('.badge');
        const lbl = toggle.querySelector('.lbl');
        const chev = mk('button', 'pmvnf-toggle pmvnf-chev'); chev.type = 'button';
        chev.innerHTML = SVG_CHEV; chev.title = 'Expand filters';
        top.append(search, toggle, chev);
        const topChips = mk('div', 'pmvnf-chips');
        wrap.append(top, topChips);

        if (header) header.insertBefore(wrap, nativeWrapper.nextSibling); else document.body.prepend(wrap);

        const panel = mk('div'); panel.id = 'pmvnf-panel';
        panel.dataset.open = UI.open ? '1' : '0';
        const body = mk('div', 'pmvnf-body');
        panel.appendChild(body);
        (card || document.body).appendChild(panel);
        // While the drawer is open the card keeps a minimum height (header + drawer),
        // else a filter leaving few rows would shrink it.
        const placePanel = () => {
            if (!card || !header) return;
            const top = Math.max(0, Math.round(header.getBoundingClientRect().bottom - card.getBoundingClientRect().top));
            panel.style.top = top + 'px';
            const foot = document.getElementById('pmvnf-qfoot');
            const footH = foot ? Math.round(foot.getBoundingClientRect().height) : 0;
            panel.style.bottom = footH + 'px';
            const want = UI.open ? (top + Math.round(Math.min(520, window.innerHeight * 0.7)) + footH) + 'px' : '';
            if (card.style.minHeight !== want) card.style.minHeight = want;
        };
        placePanel();
        // A rebuild (Vue replaced the input) drops the previous panel's observer and listener.
        NF.panelCleanup?.();
        const onReady = () => { try { updatePlBtn(); } catch {} };
        let ro = null;
        try { ro = new ResizeObserver(placePanel); ro.observe(header); ro.observe(card); } catch {}
        NF.panelCleanup = () => { ro?.disconnect(); window.removeEventListener('pmv:cache-ready', onReady); };
        const setOpen = (v) => {
            UI.open = v;
            panel.dataset.open = v ? '1' : '0';
            chev.dataset.open = v ? '1' : '0';
            chev.title = v ? 'Collapse filters' : 'Expand filters';
            try { localStorage.setItem(UI_OPEN_KEY, v ? '1' : '0'); } catch {}
            placePanel();
            if (v) loadSavedSearchList();
            else closeDd();
        };
        // Filters is also the switch: active with nothing staged → off (settings kept); else apply.
        toggle.onclick = () => {
            if (!anyPending() && toggle.dataset.active === '1') { setFilterEnabled(false); return; }
            applyAll();
        };
        chev.onclick = () => setOpen(!UI.open);

        const drawChips = (host, kind, list, extraCls = '') => {
            host.textContent = '';
            list.forEach((term, i) => {
                const c = mk('span', `pmvnf-tag ${kind.replace('d', '')} ${extraCls}`.trim());
                if (kind.endsWith('neg')) { const ic = mk('span'); ic.innerHTML = SVG_BAN; ic.style.display = 'inline-flex'; c.appendChild(ic); }
                const isRaw = kind.endsWith('raw');
                const word = !isRaw && PMVX.isWordTerm(term);
                const txt = mk('span', 'txt', isRaw ? term : '#' + (word ? `"${PMVX.termLabel(term)}"` : term));
                c.appendChild(txt);
                // Click the term: toggle whole-word match.
                if (!isRaw) {
                    txt.style.cursor = 'pointer';
                    txt.title = word ? 'Whole word only — click to match it anywhere in the text' : 'Matches anywhere in the text — click to match it only as a whole word';
                    txt.onclick = () => { list[i] = word ? term.slice(1) : '=' + term; afterChipChange(kind); };
                }
                const x = mk('span', 'x'); x.innerHTML = SVG_X; x.title = 'Remove';
                x.onclick = () => { list.splice(i, 1); afterChipChange(kind); };
                c.appendChild(x);
                host.appendChild(c);
            });
        };
        const renderTagChips = () => {
            topChips.textContent = '';
            // Only the search field's terms here; excluded ones are in the drawer's Exclude section.
            const a = mk('div', 'pmvnf-chips'), c = mk('div', 'pmvnf-chips');
            drawChips(a, 'pos', UI.pos); drawChips(c, 'raw', UI.raw);
            [...a.children, ...c.children].forEach(el => topChips.appendChild(el));
            drawChips(negChips, 'neg', UI.neg);
            drawChips(defChips, 'dpos', UI.dpos, 'def');
            const d2 = mk('div'); drawChips(d2, 'dneg', UI.dneg, 'def'); [...d2.children].forEach(el => defChips.appendChild(el));
            const d3 = mk('div'); drawChips(d3, 'draw', UI.draw, 'def'); [...d3.children].forEach(el => defChips.appendChild(el));
        };
        const afterChipChange = (kind) => {
            if (kind.startsWith('d')) { pendingDefaultTerms = uiToDefaults(); updateDefaultsBtn(); }
            renderTagChips(); refreshPendingMarks();
        };
        NF.renderOwnChips = () => { renderTagChips(); renderSeen(); };
        NF.onOwnKey = (e) => {
            const kind = e.target?.dataset?.pmvnfKind;
            if (!kind) return false;
            const inp = e.target;
            const immediate = inp.dataset.pmvnfApply === '1';
            if (e.key === 'Enter') {
                const term = chipTerm(inp.value);
                if (!term || term === '=') { if (!inp.value.trim()) applyAll(); inp.value = ''; return true; }
                const isDef = kind.startsWith('d');
                const list = UI[kind], other = UI[isDef ? (kind === 'dpos' ? 'dneg' : 'dpos') : (kind === 'pos' ? 'neg' : 'pos')];
                if (!list.includes(term)) list.push(term);
                const j = other.indexOf(term); if (j !== -1) other.splice(j, 1);
                inp.value = '';
                afterChipChange(kind);
                if (immediate) applyAll();
                return true;
            }
            if (e.key === 'Backspace' && !inp.value && UI[kind].length) { UI[kind].pop(); afterChipChange(kind); return true; }
            if (e.key === 'Escape') { inp.value = ''; inp.blur(); if (UI.open && !immediate) setOpen(false); return true; }
            return false;
        };

        const secNeg = mk('div', 'pmvnf-sec');
        secNeg.appendChild(mk('div', 'pmvnf-lab', 'Exclude'));
        const inpNeg = mk('input'); inpNeg.type = 'text'; inpNeg.spellcheck = false; inpNeg.autocomplete = 'off';
        inpNeg.placeholder = 'Hide videos with… (title, tag or performer)'; inpNeg.dataset.pmvnfKind = 'neg';
        inpNeg.addEventListener('keydown', e => e.stopPropagation(), true);
        const negChips = mk('div', 'pmvnf-chips');
        secNeg.append(inpNeg, negChips, mk('div', 'pmvnf-hint', 'Enter adds · Enter in an empty field applies · Backspace in an empty field removes the last one · "quotes" or a click on a term: whole word only'));
        body.appendChild(secNeg);

        const secDef = mk('div', 'pmvnf-sec');
        const labDef = mk('div', 'pmvnf-lab', 'Always');
        const defMark = mk('span', 'r'); labDef.appendChild(defMark);
        secDef.appendChild(labDef);
        const inpDPos = mk('input'); inpDPos.type = 'text'; inpDPos.spellcheck = false; inpDPos.autocomplete = 'off';
        inpDPos.placeholder = 'Always require…'; inpDPos.dataset.pmvnfKind = 'dpos';
        const inpDNeg = mk('input'); inpDNeg.type = 'text'; inpDNeg.spellcheck = false; inpDNeg.autocomplete = 'off';
        inpDNeg.placeholder = 'Always exclude…'; inpDNeg.dataset.pmvnfKind = 'dneg';
        [inpDPos, inpDNeg].forEach(i => i.addEventListener('keydown', e => e.stopPropagation(), true));
        const defChips = mk('div', 'pmvnf-chips');
        secDef.append(inpDPos, inpDNeg, defChips, mk('div', 'pmvnf-hint', 'Applies in every playlist, on top of the filter above.'));
        body.appendChild(secDef);
        updateDefaultsBtn = () => { defMark.textContent = pendingDefaultTerms !== NF.defaultTerms ? 'not applied' : (NF.defaultTerms ? 'active' : ''); refreshPendingMarks(); };

        const secPl = mk('div', 'pmvnf-sec');
        const labPl = mk('div', 'pmvnf-lab', 'Playlist');
        secPl.appendChild(labPl);
        const plModes = mk('div', 'pmvnf-chips');
        const modeChips = [['all', 'All', ''], ['in', '✓ In playlist', 'in'], ['out', '✕ Not in playlist', 'out']].map(([m, txt, cls]) => {
            const c = mkChip(txt, () => { pendingPlaylistMode = m; updatePlBtn(); }, 'Takes effect when you apply');
            if (cls) c.classList.add(cls);
            c.dataset.mode = m; plModes.appendChild(c); return c;
        });
        secPl.appendChild(plModes);
        const plSel = mkSelect({
            multi: true, placeholder: 'Any playlist', label: 'Which of your playlists count for In / Not in playlist',
            emptyText: 'No playlists yet — log in to load yours.',
            items: () => [...getLivePlaylists().playlists.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ value: p.id, title: p.name, sub: `${p.ids.size} videos` })),
            isSelected: id => pendingSelectedPlaylistIds.includes(id),
            onPick: id => { pendingSelectedPlaylistIds = pendingSelectedPlaylistIds.includes(id) ? pendingSelectedPlaylistIds.filter(x => x !== id) : [...pendingSelectedPlaylistIds, id]; updatePlBtn(); },
        });
        secPl.appendChild(plSel.el);
        updatePlBtn = function () {
            modeChips.forEach(c => {
                c.classList.toggle('active', c.dataset.mode === pendingPlaylistMode);
                c.classList.toggle('pending', c.dataset.mode === pendingPlaylistMode && pendingPlaylistMode !== BTN.playlistMode);
            });
            plSel.render();
            plSel.el.style.opacity = pendingPlaylistMode === 'all' ? '0.5' : '1';
            plSel.el.classList.toggle('pending', !isSetEqual(pendingSelectedPlaylistIds, BTN.selectedPlaylistIds));
            refreshPendingMarks();
        };
        body.appendChild(secPl);

        const secSeen = mk('div', 'pmvnf-sec');
        secSeen.appendChild(mk('div', 'pmvnf-lab', 'Watched'));
        const seenRow = mk('div', 'pmvnf-chips');
        const seenChips = [[null, 'All'], ['unseen', 'Unwatched'], ['seen', 'Watched']].map(([v, txt]) => {
            const c = mkChip(txt, () => { UI.seen = v; renderSeen(); refreshPendingMarks(); }, v === null ? '' : v === 'unseen' ? 'Hides videos you have watched (85%+)' : 'Hides videos you have not watched yet');
            c.dataset.seen = v === null ? '' : v; seenRow.appendChild(c); return c;
        });
        const renderSeen = () => seenChips.forEach(c => c.classList.toggle('active', (c.dataset.seen || null) === UI.seen));
        secSeen.appendChild(seenRow);
        body.appendChild(secSeen);

        // Content flags cycle off -> hide -> only these -> off; staged like the rest.
        const secFlags = mk('div', 'pmvnf-sec');
        secFlags.appendChild(mk('div', 'pmvnf-lab', 'Content'));
        const flagRow = mk('div', 'pmvnf-chips');
        const flagChips = (PMVX.contentFlags || []).map(([key, label]) => {
            const c = mkChip(label, () => {
                const f = { ...pendingFlags };
                const m = f[key];
                if (!m) f[key] = 'out'; else if (m === 'out') f[key] = 'in'; else delete f[key];
                pendingFlags = f;
                updateFlagBtns();
            });
            c.dataset.flag = key; c.dataset.label = label;
            flagRow.appendChild(c);
            return c;
        });
        updateFlagBtns = () => {
            flagChips.forEach(c => {
                const m = pendingFlags[c.dataset.flag];
                c.className = 'pmvnf-chip' + (m ? ' active ' + m : '') + ((m || '') !== (BTN.flags[c.dataset.flag] || '') ? ' pending' : '');
                c.textContent = (m === 'out' ? '\u2298 ' : m === 'in' ? '\u2713 ' : '') + c.dataset.label;
                c.title = m === 'out' ? `Hides videos flagged ${c.dataset.label} \u2014 click: only these`
                    : m === 'in' ? `Only videos flagged ${c.dataset.label} \u2014 click: off`
                    : `Click: hide videos flagged ${c.dataset.label}`;
            });
            refreshPendingMarks();
        };
        updateFlagBtns();
        secFlags.append(flagRow, mk('div', 'pmvnf-hint', 'Click: hide (\u2298) \u2192 only these (\u2713) \u2192 off. Flags the playlist data lacks are fetched once; videos whose flag is still unknown stay visible.'));
        body.appendChild(secFlags);

        const secRat = mk('div', 'pmvnf-sec'); secRat.appendChild(mk('div', 'pmvnf-lab', 'Rating'));
        const ratSlider = mkDualSlider({ min: 0, max: 100,
            getRange: () => [pendingRatingMin, pendingRatingMax], setRange: (a, b) => { pendingRatingMin = a; pendingRatingMax = b; },
            fmt: (v, isMax) => (isMax && v >= 100) ? 'Any' : v + '%',
            presets: [{ a: 0, b: 100, label: 'Any' }, { a: 90, b: 100, label: '90%+' }, { a: 80, b: 100, label: '80%+' }, { a: 70, b: 100, label: '70%+' }, { a: 50, b: 80, label: '50-80%' }] });
        secRat.appendChild(ratSlider.el); body.appendChild(secRat);
        updateRatBtn = () => ratSlider.render();
        const secDur = mk('div', 'pmvnf-sec'); secDur.appendChild(mk('div', 'pmvnf-lab', 'Duration'));
        const M = DURATION_SLIDER_MAX_MIN;
        const durSlider = mkDualSlider({ min: 0, max: M,
            getRange: () => [Math.round(pendingDurationMin / 60), Number.isFinite(pendingDurationMax) ? Math.round(pendingDurationMax / 60) : M],
            setRange: (a, b) => { pendingDurationMin = a * 60; pendingDurationMax = b >= M ? Infinity : b * 60; },
            fmt: (v, isMax) => (isMax && v >= M) ? 'Any' : v + 'm',
            presets: [{ a: 0, b: M, label: 'Any' }, { a: 0, b: 5, label: '<5m' }, { a: 5, b: 10, label: '5-10m' }, { a: 10, b: 20, label: '10-20m' }, { a: 20, b: M, label: '20m+' }] });
        secDur.appendChild(durSlider.el); body.appendChild(secDur);
        updateDurBtn = () => durSlider.render();

        const secSs = mk('div', 'pmvnf-sec'); secSs.appendChild(mk('div', 'pmvnf-lab', 'Saved search'));
        let ssList = null;
        const ssSel = mkSelect({
            placeholder: 'None', label: 'One of your saved searches as an extra filter',
            emptyText: ssList === null ? 'loading…' : 'No saved searches on your account.',
            items: () => [{ value: '', title: 'None', sub: 'No saved search' }, ...((ssList || []).map(ss => { const name = ss.name || ss.title || '(unnamed)'; return { value: name, title: name, sub: [ss.excludeTags?.length ? `${ss.excludeTags.length} excluded tags` : '', ss.minRating ? `rating ${ss.minRating}%+` : ''].filter(Boolean).join(' · ') || 'Saved search', ss }; }))],
            isSelected: v => (v || '') === (pendingSavedSearchName || ''),
            onPick: v => {
                if (!v) { pendingSavedSearch = null; pendingSavedSearchName = ''; }
                else { const ss = (ssList || []).find(s => (s.name || s.title || '(unnamed)') === v); pendingSavedSearch = ss ? parseSavedSearch(ss) : pendingSavedSearch; pendingSavedSearchName = v; }
                updateSsBtn();
            },
        });
        secSs.appendChild(ssSel.el); body.appendChild(secSs);
        updateSsBtn = () => { ssSel.render(); ssSel.el.classList.toggle('pending', pendingSavedSearchName !== BTN.savedSearchName); refreshPendingMarks(); };
        const loadSavedSearchList = async () => { if (ssList) return; try { ssList = await fetchSavedSearches(); } catch { ssList = []; } ssSel.render(); };

        const actions = mk('div', 'pmvnf-actions');
        const counter = mk('span'); counter.id = 'pmvnf-counter';
        const closeBtn = mk('button', 'pmvnf-close', 'Close ✕'); closeBtn.type = 'button'; closeBtn.onclick = () => setOpen(false);
        // Copies the site-wide header filter into this one, staged until Filters.
        const syncBtn = mk('button', 'pmvnf-close', 'Sync from site filter'); syncBtn.type = 'button';
        syncBtn.title = 'Copy the site-wide filter (terms, watched, playlist, rating, max length, content flags) into this one \u2014 then press Filters';
        syncBtn.onclick = () => {
            const g = PMVX.siteFilterSnapshot?.();
            if (!g) { counter.textContent = 'Site filter not available'; return; }
            UI.pos.splice(0, UI.pos.length, ...g.include);
            UI.neg.splice(0, UI.neg.length, ...g.exclude);
            UI.seen = g.seen === 'seen' || g.seen === 'unseen' ? g.seen : null;
            pendingPlaylistMode = g.playlistMode || 'all';
            pendingSelectedPlaylistIds = (g.playlistIds || []).slice();
            pendingRatingMin = g.ratingMin ?? 0; pendingRatingMax = g.ratingMax ?? 100;
            pendingDurationMin = 0; pendingDurationMax = g.maxMinutes > 0 ? g.maxMinutes * 60 : Infinity;
            pendingFlags = { ...(g.flags || {}) }; updateFlagBtns();
            renderTagChips(); renderSeen(); updatePlBtn(); ratSlider.render(); durSlider.render(); refreshPendingMarks();
            counter.textContent = 'Copied \u2014 press Filters to apply';
        };
        actions.append(counter, syncBtn, closeBtn);
        panel.appendChild(actions);

        NF.applyAll = () => applyAll();
        function applyAll() {
            const text = uiToText();
            [inpPos, inpNeg, inpDPos, inpDNeg].forEach(i => i.value = '');
            onOwnInput(text);
        }

        refreshPendingMarks = () => {
            const pend = anyPending();
            lbl.textContent = pend ? 'Filters *' : 'Filters';
            toggle.classList.toggle('pending', pend);
            let n = 0;
            const t = parseTokens(NF.lastOwnValue || '');
            n += t.textInclude.length + t.textExclude.length + (t.seenFilter ? 1 : 0);
            if (BTN.playlistMode !== 'all') n++;
            n += flagKeysActive().length;
            if (BTN.ratingMin > 0 || BTN.ratingMax < 100) n++;
            if (BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)) n++;
            if (BTN.savedSearchName) n++;
            if (NF.defaultTerms) n++;
            badge.textContent = n ? String(n) : '';
            toggle.dataset.active = n && filterLive() ? '1' : '0';
            toggle.title = pend ? 'Apply changes'
                : (n && filterLive() ? 'Filter on \u2014 click to turn it off (settings are kept)'
                : n && !NF.enabled ? 'Filter is off \u2014 click to apply and turn it on'
                : (n && !sessionFilterArmed ? 'Remembered from your last visit — not active yet, click to apply' : 'Apply filters'));
        };

        renderTagChips(); renderSeen(); updatePlBtn(); ratSlider.render(); durSlider.render(); updateSsBtn(); updateDefaultsBtn(); refreshPendingMarks();
        injectQueueFooter();
        setOpen(UI.open);
        injectSortSelect();
        window.addEventListener('pmv:cache-ready', onReady);
        attachOwnInputKeyIntercept();
    }

    // Document-level capture; reads NF.ownInput per event so it survives panel rebuilds.
    let ownInputKeyInterceptActive = false;
    function attachOwnInputKeyIntercept() {
        if (ownInputKeyInterceptActive) return;
        ownInputKeyInterceptActive = true;
        document.addEventListener('keydown', e => {
            if (e.target?.dataset?.pmvnfKind && typeof NF.onOwnKey === 'function') {
                if (NF.onOwnKey(e)) { e.stopImmediatePropagation(); e.preventDefault(); }
                return;
            }
            if (e.target !== NF.ownInput) return;
            if (e.key === 'Enter') {
                e.stopImmediatePropagation();
                e.preventDefault();
                onOwnInput(NF.ownInput.value);
            } else if (e.key === 'Escape') {
                e.stopImmediatePropagation();
                e.preventDefault();
                NF.ownInput.value = '';
                onOwnInput('');
            }
        }, true);
    }

    function updateCounter(msg) {
        const el = document.getElementById('pmvnf-counter');
        if (el) el.textContent = msg;
    }


