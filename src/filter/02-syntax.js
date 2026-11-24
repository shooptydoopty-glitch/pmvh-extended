    // --- Filter syntax ---
    //   foo / -foo           show only / hide rows matching foo (title, tags, performers)
    //   "foo bar" / =foo     whole word or phrase only (also -"foo bar")
    //   !in / !out           hide rows in any / in no playlist
    //   !in:name / !out:name hide rows in / not in playlist "name" (partial name)
    //   !seen / !unseen      show only watched / unwatched

    // Quoted substrings (optionally with -) are one token; the rest splits on whitespace.
    function tokenizeRaw(raw) {
        const re = /-?=?"[^"]*"|-?=?'[^']*'|\S+/g;
        return PMVX.plainQuotes(raw).trim().match(re) || [];
    }
    // Quoted (smart quotes too) and =term match only whole words (PMVX.termMatch); stored as "=term".
    function stripTerm(term) {
        if (term[0] === '=') return '=' + stripQuotes(term.slice(1));
        const inner = stripQuotes(term);
        return inner !== term ? '=' + inner : term;
    }

    function stripQuotes(term) {
        if (term.length >= 2) {
            if (term.startsWith('"') && term.endsWith('"')) return term.slice(1, -1);
            if (term.startsWith("'") && term.endsWith("'")) return term.slice(1, -1);
        }
        return term;
    }

    function parseTokens(raw) {
        const tokens = tokenizeRaw(raw);
        const result = {
            textExclude: [],
            textInclude: [],
            playlistFilters: [], // { mode: 'in'|'out', name: string|null }
            seenFilter: null, // 'seen' | 'unseen' | null
        };

        tokens.forEach(tok => {
            if (tok.startsWith('!in')) {
                const name = tok.slice(3).replace(/^:/, '').toLowerCase().trim() || null;
                result.playlistFilters.push({ mode: 'in', name });
            } else if (tok.startsWith('!out')) {
                const name = tok.slice(4).replace(/^:/, '').toLowerCase().trim() || null;
                result.playlistFilters.push({ mode: 'out', name });
            } else if (tok === '!seen') {
                result.seenFilter = 'seen';
            } else if (tok === '!unseen') {
                result.seenFilter = 'unseen';
            } else if (tok.startsWith('-')) {
                const t = stripTerm(tok.slice(1)).toLowerCase();
                if (t && t !== '=') result.textExclude.push(t);
            } else {
                const t = stripTerm(tok).toLowerCase();
                if (t && t !== '=') result.textInclude.push(t);
            }
        });

        return result;
    }

    // Normalizes meta.duration to seconds (number or "H:MM:SS" / "M:SS" string).
    function toDurationSeconds(raw) {
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string' && raw.includes(':')) {
            const parts = raw.split(':').map(n => parseInt(n, 10));
            if (parts.some(Number.isNaN)) return 0;
            return parts.reduce((acc, n) => acc * 60 + n, 0);
        }
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : 0;
    }

    // vid/descOn come from applyFilter() to save DOM and localStorage lookups.
    function rowPassesFilter(row, tokens, vid = undefined, descOn = undefined) {
        const { textExclude, textInclude, playlistFilters, seenFilter } = tokens;
        const videoId = vid === undefined ? getRowVideoId(row) : vid;
        const matchDesc = descOn === undefined ? matchDescEnabled() : descOn;

        // Title always; tags and performers when known via videoMeta.
        const meta = videoId ? PMVX.state?.videoMeta?.get(videoId) : null;
        const text = (row.querySelector('h4')?.textContent || row.textContent || '').toLowerCase();
        const haystacks = [text, ...(meta?.tags || []), ...(meta?.starsTags || [])];
        if (matchDesc && meta?.description) haystacks.push(meta.description);
        for (const term of textInclude) {
            if (!haystacks.some(h => PMVX.termMatch(h, term))) return false;
        }
        for (const term of textExclude) {
            if (haystacks.some(h => PMVX.termMatch(h, term))) return false;
        }

        if (playlistFilters.length > 0) {
            const { playlists, reverse } = getLivePlaylists();
            const memberOf = videoId ? (reverse.get(videoId) || new Set()) : new Set();

            for (const pf of playlistFilters) {
                if (pf.name) {
                    let matchedId = null;
                    playlists.forEach((p, id) => {
                        if (p.name.toLowerCase().includes(pf.name)) matchedId = id;
                    });

                    const inThat = matchedId ? memberOf.has(matchedId) : false;
                    if (pf.mode === 'in'  &&  inThat) return false;
                    if (pf.mode === 'out' && !inThat) return false;
                } else {
                    const inAny = memberOf.size > 0;
                    if (pf.mode === 'in'  &&  inAny) return false;
                    if (pf.mode === 'out' && !inAny) return false;
                }
            }
        }

        // Local playback history; an unknown ID is never filtered out.
        if (seenFilter && videoId && typeof PMVX.isWatched === 'function') {
            const isWatched = PMVX.isWatched(videoId);
            if (seenFilter === 'seen' && !isWatched) return false;
            if (seenFilter === 'unseen' && isWatched) return false;
        }

        // An unknown rating or duration never filters a row out.
        if ((BTN.ratingMin > 0 || BTN.ratingMax < 100) && meta && meta.bayesianRating > 0) {
            if (meta.bayesianRating < BTN.ratingMin || meta.bayesianRating > BTN.ratingMax) return false;
        }

        if ((BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)) && meta) {
            const dur = toDurationSeconds(meta.duration);
            if (dur > 0 && (dur < BTN.durationMin || dur > BTN.durationMax)) return false;
        }

        if (flagsReject(videoId)) return false;

        if (BTN.savedSearch) {
            const ss = BTN.savedSearch;
            // excludeTags/gay/trans also work from text; rating and aspect need meta.
            if (meta) {
                if (ss.excludeTags?.length) {
                    for (const t of ss.excludeTags) {
                        if (meta.tags.includes(t)) return false;
                    }
                }
                if (ss.minRating && meta.bayesianRating > 0 && meta.bayesianRating < ss.minRating) return false;
                if (ss.aspectFilter && meta.width && meta.height) {
                    const ratio = meta.width / meta.height;
                    const allowedAspects = BTN.savedSearch._rawAspect || [];
                    const aspectOk = allowedAspects.length === 0 || allowedAspects.some(a => {
                        if (a === '16:9') return ratio >= 1.7  && ratio <= 1.8;
                        if (a === '21:9') return ratio >= 2.3  && ratio <= 2.45;
                        if (a === '4:3')  return ratio >= 1.3  && ratio <= 1.35;
                        return false;
                    });
                    if (!aspectOk) return false;
                }
            }
        }

        if (BTN.playlistMode !== 'all') {
            const { reverse } = getLivePlaylists();
            const memberOf = videoId ? (reverse.get(videoId) || new Set()) : new Set();
            const inSelected = inSelectedPlaylists(memberOf);
            if (inSelected !== null && BTN.playlistMode === 'in'  && !inSelected) return false;
            if (inSelected !== null && BTN.playlistMode === 'out' &&  inSelected) return false;
        }

        return true;
    }


    // --- Up next preview helpers ---
    // The preview is a <button> after the "Up Next" label <p>, not a [role="button"] div.

    function findUpNextButton() {
        const labels = document.querySelectorAll('p');
        for (const p of labels) {
            const txt = (p.textContent || '').trim();
            if (/^up\s*next$/i.test(txt)) {
                const btn = p.nextElementSibling;
                if (btn?.tagName === 'BUTTON') return btn;
                const wrap = p.parentElement;
                const wrapBtn = wrap?.querySelector('button');
                if (wrapBtn) return wrapBtn;
            }
        }
        return null;
    }

    function upNextWrapper(btn) {
        return btn?.closest('div.mt-3, div[class*="bg-[#181818]"]') || btn?.parentElement;
    }

    function getUpNextTitle(btn) {
        return btn?.querySelector('p.line-clamp-2, p.font-medium')?.textContent ||
               btn?.querySelector('p')?.textContent || '';
    }

    function getUpNextVideoId(btn) {
        if (!btn) return null;
        const huds = PMVX.state;
        const img  = btn.querySelector('img[src]');

        // 1. titleIndex via alt.
        const alt = img?.alt?.trim().toLowerCase();
        if (alt && huds?.titleIndex?.has(alt)) return huds.titleIndex.get(alt);

        // 2. thumbnailIndex (exact URL).
        if (img?.src && huds?.thumbnailIndex) {
            const clean = img.src.split('?')[0];
            if (huds.thumbnailIndex.has(clean)) return huds.thumbnailIndex.get(clean);
        }

        // 3. URL hex, only if in a playlist (else an asset ID).
        const { reverse } = getLivePlaylists();
        if (img?.src) {
            const m = img.src.match(/\/thumbnails\/([a-f0-9]{24})\//) ||
                      img.src.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//) ||
                      img.src.match(/\/([a-f0-9]{24})\/thumbnail\//);
            if (m && reverse?.has(m[1])) return m[1];
        }

        // 4. Unvalidated hex.
        if (img?.src) {
            const m = img.src.match(/\/thumbnails\/([a-f0-9]{24})\//) ||
                      img.src.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//) ||
                      img.src.match(/\/([a-f0-9]{24})\/thumbnail\//);
            if (m) return m[1];
        }

        return null;
    }

    function upNextPassesFilter(btn, tokens) {
        if (!btn) return true;
        const text = getUpNextTitle(btn).toLowerCase();
        const upVid = getUpNextVideoId(btn);
        const upMeta = upVid ? PMVX.state?.videoMeta?.get(upVid) : null;
        const upHay = [text];
        if (matchDescEnabled() && upMeta?.description) upHay.push(upMeta.description);
        for (const term of tokens.textInclude) if (!upHay.some(h => PMVX.termMatch(h, term))) return false;
        for (const term of tokens.textExclude) if (upHay.some(h => PMVX.termMatch(h, term))) return false;

        if (tokens.playlistFilters.length > 0) {
            const vid = getUpNextVideoId(btn);
            const { playlists, reverse } = getLivePlaylists();
            const memberOf = vid ? (reverse.get(vid) || new Set()) : new Set();

            for (const pf of tokens.playlistFilters) {
                if (pf.name) {
                    let matchedId = null;
                    playlists.forEach((p, id) => {
                        if (p.name.toLowerCase().includes(pf.name)) matchedId = id;
                    });
                    const inThat = matchedId ? memberOf.has(matchedId) : false;
                    if (pf.mode === 'in'  &&  inThat) return false;
                    if (pf.mode === 'out' && !inThat) return false;
                } else {
                    const inAny = memberOf.size > 0;
                    if (pf.mode === 'in'  &&  inAny) return false;
                    if (pf.mode === 'out' && !inAny) return false;
                }
            }
        }
        const vid2 = getUpNextVideoId(btn);
        const meta2 = vid2 ? PMVX.state?.videoMeta?.get(vid2) : null;

        if (tokens.seenFilter && vid2 && typeof PMVX.isWatched === 'function') {
            const isWatched2 = PMVX.isWatched(vid2);
            if (tokens.seenFilter === 'seen' && !isWatched2) return false;
            if (tokens.seenFilter === 'unseen' && isWatched2) return false;
        }

        if ((BTN.ratingMin > 0 || BTN.ratingMax < 100) && meta2 && meta2.bayesianRating > 0) {
            if (meta2.bayesianRating < BTN.ratingMin || meta2.bayesianRating > BTN.ratingMax) return false;
        }

        if ((BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)) && meta2) {
            const dur2 = toDurationSeconds(meta2.duration);
            if (dur2 > 0 && (dur2 < BTN.durationMin || dur2 > BTN.durationMax)) return false;
        }

        if (flagsReject(vid2)) return false;

        if (BTN.savedSearch && meta2) {
            const ss = BTN.savedSearch;
            if (ss.excludeTags?.length) {
                for (const t of ss.excludeTags) {
                    if (meta2.tags.includes(t)) return false;
                }
            }
            if (ss.minRating && meta2.bayesianRating > 0 && meta2.bayesianRating < ss.minRating) return false;
            if (ss.aspectFilter && meta2.width && meta2.height) {
                const ratio = meta2.width / meta2.height;
                const aspectOk = (ss._rawAspect || []).some(a => {
                    if (a === '16:9') return ratio >= 1.7  && ratio <= 1.8;
                    if (a === '21:9') return ratio >= 2.3  && ratio <= 2.45;
                    if (a === '4:3')  return ratio >= 1.3  && ratio <= 1.35;
                    return false;
                });
                if (!aspectOk) return false;
            }
        }

        if (BTN.playlistMode !== 'all') {
            const { reverse } = getLivePlaylists();
            const memberOf2 = vid2 ? (reverse.get(vid2) || new Set()) : new Set();
            const inSelected = inSelectedPlaylists(memberOf2);
            if (inSelected !== null && BTN.playlistMode === 'in'  && !inSelected) return false;
            if (inSelected !== null && BTN.playlistMode === 'out' &&  inSelected) return false;
        }

        return true;
    }

    // --- Applying the filter ---

    let lastAppliedValue = null;
    let lastAppliedDataVersion = -1;


    function applyFilter(ownValue, force = false) {
        const currentDataVersion = PMVX.state?.cacheVersion ?? 0;
        if (!force
            && ownValue === lastAppliedValue
            && currentDataVersion === lastAppliedDataVersion) return;
        lastAppliedValue = ownValue;
        lastAppliedDataVersion = currentDataVersion;

        const effectiveValue = getEffectiveFilterValue(ownValue);
        const tokens = parseTokens(effectiveValue);
        // Nothing is filtered until the filter is armed in this session (see sessionFilterArmed).
        const hasOwnFilter = filterLive() && (
            effectiveValue.length > 0
            || BTN.playlistMode !== 'all'
            || BTN.savedSearch !== null
            || BTN.ratingMin > 0 || BTN.ratingMax < 100
            || BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)
            || flagKeysActive().length > 0
        );

        // Filter needs incomplete videoMeta: Fetch all runs in the background and re-applies.
        const needsMeta = hasOwnFilter && (
            !!(BTN.savedSearch && (BTN.savedSearch.minRating || BTN.savedSearch.aspectFilter))
            || BTN.ratingMin > 0 || BTN.ratingMax < 100
            || BTN.durationMin > 0 || Number.isFinite(BTN.durationMax)
            || tokens.textInclude.length > 0
            || tokens.textExclude.length > 0
            || flagKeysActive().length > 0
        );
        autoFetchAllIfNeeded(effectiveValue, hasOwnFilter, needsMeta);

        // Flags missing from playlist data: fetched in bulk, then rows re-judged.
        if (hasOwnFilter && flagKeysActive().length && typeof PMVX.fetchFlags === 'function') {
            const ids = queueRows().map(r => getRowVideoId(r)).filter(Boolean);
            PMVX.fetchFlags(ids, flagKeysActive(), () => applyFilter(NF.lastOwnValue, true));
        }
        // Playlist data has only 5 tags and no models per video: fetch full meta, then re-judge.
        if (hasOwnFilter && (tokens.textInclude.length || tokens.textExclude.length) && typeof PMVX.fetchFullMeta === 'function') {
            const ids = queueRows().map(r => getRowVideoId(r)).filter(Boolean);
            PMVX.fetchFullMeta(ids, () => applyFilter(NF.lastOwnValue, true));
        }

        const rows = queueRows();
        let shown = 0, hidden = 0;
        let activeHidden = false;

        // Dedup: the page=1 limit bump makes Vue's pagination repeat first-page videos.
        // Only the first row per video ID shows (the playing row always).
        const seenVideoIds = new Set();
        const descOn = matchDescEnabled();

        rows.forEach(row => {
            const isActive = row.classList.contains('border-orange-500');

            // Rows hidden by the deeplink catch-up stay hidden regardless of the filter.
            if (row.dataset.pmvCatchupHidden === '1') {
                row.style.display = 'none';
                hidden++;
                return;
            }

            const rowVid = getRowVideoId(row);
            if (rowVid) {
                if (seenVideoIds.has(rowVid) && !isActive) {
                    row.style.display = 'none';
                    hidden++;
                    return;
                }
                seenVideoIds.add(rowVid);
            }

            if (!hasOwnFilter) {
                row.style.removeProperty('display');
                return;
            }

            const visible = rowPassesFilter(row, tokens, rowVid, descOn);

            if (!visible && PMVX.isActed(rowVid)) {
                // Just saved/removed/rejected: stays until the next apply.
                row.style.display = '';
                shown++;
                return;
            }

            row.style.display = visible ? '' : 'none';
            visible ? shown++ : hidden++;

            if (isActive && !visible) activeHidden = true;
        });

        updateCounter(hasOwnFilter ? `${shown}/${shown + hidden}` : '');

        // Playing video hidden: press N, but only if a visible row follows;
        // else each skip lands on a filtered video (chains up to SKIP_CHAIN_MAX).
        if (activeHidden) {
            if (shown === 0) {
                updateCounter("No videos match the filter — auto-skip stopped");
                return;
            }
            if (!findNextVisibleRow()) {
                return;
            }
            triggerNextKey();
            return;
        }

        // Up next box: display-only override with the first visible row after the active one; Vue's pointer is untouched.
        overrideUpNext(tokens);
    }

