    // --- API ---

    // Own requests are marked quiet so the interceptor doesn't index their playlist responses twice.
    async function api(url, opts) {
        quietUrls.add(url);
        let res;
        try { res = await fetch(url, opts); }
        finally { quietUrls.delete(url); }
        if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
        return pmvResJson(res);
    }

    // Site moderation flags plus three only some lists carry; Nudity = hasExplicitContent, SFW its inverse.
    const CONTENT_FLAGS = PMVX.contentFlags;

    // localStorage: id -> [trueBits, knownBits], bit i = CONTENT_FLAGS[i]. Full documents omit never-set
    // moderation flags (known false); partial copies (playlist videoDetails) add only the flags they carry.
    const FLAG_CACHE_KEY = 'pmvx_flag_cache_v1';
    const FLAG_CACHE_MAX = 15000;
    let flagCache = null;
    let flagSaveTimer = 0;
    function flagCacheMap() {
        if (!flagCache) {
            flagCache = new Map();
            try {
                const o = JSON.parse(localStorage.getItem(FLAG_CACHE_KEY) || '{}');
                for (const k in o) if (Array.isArray(o[k])) flagCache.set(k, o[k]);
            } catch {}
        }
        return flagCache;
    }
    function saveFlagCache() {
        clearTimeout(flagSaveTimer);
        flagSaveTimer = setTimeout(() => {
            try {
                const entries = [...flagCacheMap().entries()];
                localStorage.setItem(FLAG_CACHE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-FLAG_CACHE_MAX))));
            } catch {}
        }, 1500);
    }
    function rememberFlags(v) {
        if (!v?._id) return;
        const full = 'moderationStatus' in v || 'isReleased' in v;
        let t = 0, k = 0;
        CONTENT_FLAGS.forEach(([key], i) => {
            if (typeof v[key] === 'boolean') { k |= 1 << i; if (v[key]) t |= 1 << i; }
            else if (full && i < 8) k |= 1 << i;
        });
        if (!k) return;
        const m = flagCacheMap();
        const prev = m.get(v._id);
        if (prev) { t = (prev[0] & ~k) | t; k = prev[1] | k; if (prev[0] === t && prev[1] === k) return; }
        m.delete(v._id);
        m.set(v._id, [t, k]);
        saveFlagCache();
    }

    function votedTerms(votes) {
        const m = new Map();
        (Array.isArray(votes) ? votes : []).forEach(tv => {
            if (!tv?.tag) return;
            const k = String(tv.tag).toLowerCase().trim();
            m.set(k, (m.get(k) || 0) + (tv.upvotes?.length || 0) - (tv.downvotes?.length || 0));
        });
        return [...m].filter(([, score]) => score >= 1).map(([k]) => k);
    }

    // Returns the number of new thumbnail URLs; queue badges are invalidated only when > 0.
    function indexVideoDetails(details) {
        if (!Array.isArray(details)) return 0;
        let added = 0;
        const putThumb = (u, id) => {
            if (!u) return;
            const c = cleanUrl(u);
            if (State.thumbnailIndex.get(c) !== id) { State.thumbnailIndex.set(c, id); added++; }
        };
        details.forEach(v => {
            if (!v?._id) return;
            [v.thumbnailUrl, v.rawThumbnailUrl, v.previewUrl].forEach(u => putThumb(u, v._id));
            Object.values(v.thumbnailSizes || {}).forEach(t => putThumb(t?.url, v._id));
            if (v.title) State.titleIndex.set(v.title.trim().toLowerCase(), v._id);
            rememberFlags(v);
            // tags/top5Tags hold at most 5 and playlist data has no starsTags; full sets come from tagVotes
            // (full documents only) and aren't overwritten by later trimmed copies.
            const full = Array.isArray(v.tagVotes);
            const prev = State.videoMeta.get(v._id);
            const baseTags = (v.tags || v.top5Tags || []).map(t => String(t).toLowerCase());
            const baseStars = (v.starsTags || v.stars || []).map(s => (typeof s === 'string' ? s : (s?.name || '')).toLowerCase()).filter(Boolean);
            let tags, starsTags;
            if (full) {
                const unified = v.tagVotes.some(tv => tv?.tagType);
                const general = unified ? v.tagVotes.filter(tv => !tv?.tagType || tv.tagType === 'general') : v.tagVotes;
                const starVotes = Array.isArray(v.starVotes) && v.starVotes.length ? v.starVotes
                    : (unified ? v.tagVotes.filter(tv => tv?.tagType === 'stars') : []);
                tags = [...new Set([...baseTags, ...votedTerms(general)])];
                starsTags = [...new Set([...baseStars, ...votedTerms(starVotes)])];
            } else if (prev?.full) {
                tags = [...new Set([...prev.tags, ...baseTags])];
                starsTags = [...new Set([...prev.starsTags, ...baseStars])];
            } else {
                tags = baseTags;
                starsTags = baseStars;
            }
            State.videoMeta.set(v._id, {
                full: full || !!prev?.full,
                tags,
                starsTags,
                music: (Array.isArray(v.music) ? v.music : []).map(m => String(m?.artist || '').toLowerCase().trim()).filter(Boolean),
                bayesianRating: v.bayesianRating || 0,
                width: v.width || 0,
                height: v.height || 0,
                duration: v.duration || '',
                uploader: (v.uploaderUsername || v.uploader || '').toLowerCase(),
                uploaderDisplay: v.uploaderUsername || v.uploader || v.user?.username || '',
                title: v.title || '',
                thumbnailUrl: v.thumbnailUrl || v.rawThumbnailUrl || Object.values(v.thumbnailSizes || {})[0]?.url || '',
                previewUrl: v.previewUrl || '',
                uploadDate: v.uploadDate || null,
                views: v.views || 0,
                description: String(v.description || '').toLowerCase(),
            });
        });
        return added;
    }

    // Account id from the session (user.id, not auth userId); cached per page, none when logged out.
    let ownerIdPromise = null;
    function getOwnerId() {
        if (!ownerIdPromise) {
            ownerIdPromise = api('/api/auth/session')
                .then(j => j?.user?.id || j?.session?.user?.customUserId || null)
                .catch(() => { ownerIdPromise = null; return null; });
        }
        return ownerIdPromise;
    }

    async function refreshUserPlaylists({ force = false } = {}) {
        if (!force && State.ready && cacheIsFresh()) return;
        if (State.refreshPromise) return State.refreshPromise;

        State.refreshPromise = (async () => {
            const ownerId = await getOwnerId();
            if (!ownerId) return;
            const listJson = await api(`/api/playlists?owner=${ownerId}&limit=100`);
            const list = Array.isArray(listJson) ? listJson : (listJson.playlists || listJson.data || []);

            State.thumbnailIndex.clear();
            State.titleIndex.clear();

            function buildPlaylistEntry(p, detail) {
                const root = detail?.data || detail;
                const videos = root?.videos || [];
                const videoDetails = root?.videoDetails || [];
                const ids = new Set();

                videos.forEach(v => {
                    if (typeof v === 'string') ids.add(v);
                    else if (v?._id) ids.add(v._id);
                    else if (v?.id) ids.add(v.id);
                    else if (v?.video?._id) ids.add(v.video._id);
                });

                videoDetails.forEach(v => {
                    if (v?._id) ids.add(v._id);
                });
                indexVideoDetails(videoDetails);

                return { id: p._id, name: p.name || p.title || p._id, ids };
            }

            const nextPlaylists = new Map();

            // Largest playlist first, merged as soon as it lands so lookups work while the rest loads.
            const sizeOf = p => p.validVideoCount ?? (Array.isArray(p.videos) ? p.videos.length : 0);
            const priorityIdx = list.length
                ? list.reduce((best, p, i, a) => (sizeOf(p) > sizeOf(a[best]) ? i : best), 0)
                : -1;
            const restList = priorityIdx === -1 ? list : list.filter((_, i) => i !== priorityIdx);

            // Notifies other modules early only on a cold start; one localStorage write at the end.
            const wasReady = State.ready;
            const priorityDone = priorityIdx === -1 ? Promise.resolve() : (async () => {
                try {
                    const p = list[priorityIdx];
                    const detail = await api(`/api/playlists/${p._id}?fetchAll=true`);
                    const entry = buildPlaylistEntry(p, detail);
                    nextPlaylists.set(entry.id, entry);
                    State.playlists.set(entry.id, entry);
                    State.ready = true;
                    rebuildReverseIndex();
                    if (!wasReady) notifyCacheReady();
                } catch {}
            })();

            // fetchAll=true is required, else only the first page of each playlist comes back. Two at a time.
            const [results] = await Promise.all([
                settledWithLimit(restList, 2,
                    p => api(`/api/playlists/${p._id}?fetchAll=true`).then(detail => ({ p, detail }))),
                priorityDone,
            ]);

            results.forEach(r => {
                if (r.status !== 'fulfilled') {
                    return;
                }
                const { p, detail } = r.value;
                const entry = buildPlaylistEntry(p, detail);
                nextPlaylists.set(entry.id, entry);
            });

            State.playlists = nextPlaylists;
            State.ready = true;
            rebuildReverseIndex();
            saveCache();
        })();

        try {
            await State.refreshPromise;
        } finally {
            State.refreshPromise = null;
        }
    }

    // --- Fetch interceptor ---

    const nativeFetch = window.fetch;

    // --- Rate-limit guard (429) ---
    // The site rate-limits per IP across all /api/ calls, so our bursts break its requests too.
    // Rate-limited GETs wait out Retry-After (or 1s/2s/4s) and retry; bulk work uses settledWithLimit().
    const MAX_429_RETRIES = 3;
    const MAX_RETRY_WAIT_MS = 30000;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function retryAfterMs(res, attempt) {
        const h = res.headers.get('Retry-After');
        if (h) {
            const secs = Number(h);
            if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
            const d = Date.parse(h) - Date.now();
            if (Number.isFinite(d) && d > 0) return Math.min(d, MAX_RETRY_WAIT_MS);
        }
        return 1000 * 2 ** attempt;
    }

    async function guardedFetch(thisArg, args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0] || '');
        if (!/\/api\//.test(url)) return nativeFetch.apply(thisArg, args);

        const method = (args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
        if (method !== 'GET') return nativeFetch.apply(thisArg, args);

        for (let attempt = 0; ; attempt++) {
            // A Request object can only be reused without a body (GET).
            const res = await nativeFetch.apply(thisArg, attempt > 0 && args[0] instanceof Request
                ? [args[0].clone(), ...args.slice(1)] : args);
            if (res.status !== 429 || attempt >= MAX_429_RETRIES) {
                return res;
            }
            const waitMs = retryAfterMs(res, attempt);
            await sleep(waitMs);
        }
    }

    // Like Promise.allSettled, but at most `limit` at a time (rate limit).
    async function settledWithLimit(items, limit, fn) {
        const results = new Array(items.length);
        let next = 0;
        async function worker() {
            while (next < items.length) {
                const i = next++;
                try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
                catch (reason) { results[i] = { status: 'rejected', reason }; }
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
        return results;
    }

    const pmvResJson = PMVX.resJson || (PMVX.resJson = res => {
        if (!res.__pmvJson) {
            try { res.__pmvJson = res.clone().json(); }
            catch (e) { res.__pmvJson = Promise.reject(e); }
            res.__pmvJson.catch(() => {});
        }
        return res.__pmvJson;
    });
    // Own in-flight URLs; the /playlists filter also adds lookups that must not be indexed.
    const quietUrls = PMVX.quietUrls || (PMVX.quietUrls = new Set());

    // Shared in-flight single-video lookups, the site's own GETs included. Use fetchVideoDeduped()
    // so concurrent callers share one request and retry budget; recentVideos answers repeats.
    const pendingVideoApiFetches = new Map();
    const RECENT_VIDEO_TTL_MS = 30000;
    const recentVideos = new Map(); // requested id -> { v, at }
    function rememberVideo(reqId, v) {
        if (!v?._id) return;
        const e = { v, at: Date.now() };
        recentVideos.set(reqId, e);
        recentVideos.set(v._id, e);
        if (recentVideos.size > 400) {
            const cutoff = Date.now() - RECENT_VIDEO_TTL_MS;
            for (const [k, x] of recentVideos) {
                if (x.at < cutoff || recentVideos.size > 300) recentVideos.delete(k);
            }
        }
    }
    // Likes, dislikes and favourites change the video data, so drop its cached entries.
    function forgetVideo(id) {
        for (const [k, x] of recentVideos) if (k === id || x.v._id === id) recentVideos.delete(k);
    }
    function recentVideo(id) {
        const e = recentVideos.get(id);
        if (!e) return null;
        if (Date.now() - e.at > RECENT_VIDEO_TTL_MS) { recentVideos.delete(id); return null; }
        return e.v;
    }

    window.fetch = async function (...args) {
        // Index-limit bump: Vue falls back to index 0 when page 1 has fewer items than ?index=,
        // so raise the limit past it. Do not change.
        try {
            const rawUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const pm = rawUrl.match(/(\/api\/playlists\/[a-f0-9]{24})\?(.*)$/);
            if (pm) {
                const params = new URLSearchParams(pm[2]);
                if (params.get('page') === '1' && params.get('limit') && !params.get('fetchAll')) {
                    const index = parseInt(new URLSearchParams(location.search).get('index') || '0', 10);
                    const currentLimit = parseInt(params.get('limit'), 10);
                    if (Number.isFinite(index) && index >= currentLimit) {
                        const newLimit = index + 50;
                        const newUrl = `${pm[1]}?page=1&limit=${newLimit}`;
                        if (typeof args[0] === 'string') args[0] = newUrl;
                        else if (args[0] instanceof Request) args[0] = new Request(newUrl, args[0]);
                        else if (args[0]?.url) args[0] = { ...args[0], url: newUrl };
                    }
                }
                // One-shot fetchAll, set by the playlist-page filter before it triggers Vue's next-page fetch so Vue
                // treats the response as its own. Only page=1 is rewritten; later pages would duplicate rows.
                if (PMVX.forceFetchAllNext && !params.get('fetchAll')) {
                    PMVX.forceFetchAllNext = false;
                    if (params.get('page') === '1') {
                        params.set('fetchAll', 'true');
                        const newUrl = `${pm[1]}?${params.toString()}`;
                        if (typeof args[0] === 'string') args[0] = newUrl;
                        else if (args[0] instanceof Request) args[0] = new Request(newUrl, args[0]);
                        else if (args[0]?.url) args[0] = { ...args[0], url: newUrl };
                    }
                }
            }
        } catch {}

        // A site GET for a video nobody registered becomes the shared in-flight lookup for that id.
        let videoDeferred = null;
        try {
            const u0 = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const m0 = u0.match(/\/api\/videos\/([a-f0-9]{24})$/);
            const method0 = (args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
            const mut = method0 !== 'GET' && u0.match(/\/api\/videos\/([a-f0-9]{24})\//);
            if (mut) forgetVideo(mut[1]);
            // After an in-place hand-over the page saves progress under the earlier video with the playing
            // one's time; re-target it to the playing video.
            if (staleFullscreenId && method0 === 'PUT' && /\/api\/users\/watch-progress$/.test(u0) && typeof args[1]?.body === 'string') {
                try {
                    const body = JSON.parse(args[1].body);
                    if (body.videoId && body.videoId !== staleFullscreenId) {
                        args[1] = { ...args[1], body: JSON.stringify({ ...body, videoId: staleFullscreenId }) };
                    }
                } catch {}
            }
            // The site's own favourite toggles update the card hearts.
            if (mut && /\/favorite$/.test(u0) && typeof args[1]?.body === 'string') {
                try { const a = JSON.parse(args[1].body).action; if (a) noteFavourite(mut[1], a === 'favorite'); } catch {}
            }
            if (m0 && method0 === 'GET' && !quietUrls.has(u0) && !pendingVideoApiFetches.has(m0[1])) {
                let resolve;
                const p = new Promise(r => { resolve = r; });
                videoDeferred = { id: m0[1], p, resolve };
                pendingVideoApiFetches.set(m0[1], p);
                // Waiters get null if the response never parses.
                setTimeout(() => {
                    resolve(null);
                    if (pendingVideoApiFetches.get(m0[1]) === p) pendingVideoApiFetches.delete(m0[1]);
                }, 20000);
            }
        } catch {}
        const settleVideoDeferred = v => {
            if (!videoDeferred) return;
            const d = videoDeferred;
            videoDeferred = null;
            d.resolve(v || null);
            if (pendingVideoApiFetches.get(d.id) === d.p) pendingVideoApiFetches.delete(d.id);
        };

        let res;
        try { res = await guardedFetch(this, args); }
        catch (e) { settleVideoDeferred(null); throw e; }

        try {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const jsonP = /\/api\//.test(url) ? pmvResJson(res) : null;

            // PMVX.apiTaps: listeners get (url, json) of every API response.
            if (jsonP && PMVX.apiTaps.length) {
                jsonP.then(json => PMVX.apiTaps.forEach(fn => { try { fn(url, json); } catch {} })).catch(() => {});
            }

            if (jsonP) {
                jsonP.then(json => {
                    if (learnVideoIds(json)) scheduleBadges();
                }).catch(() => {});
            }

            if (jsonP && /\/api\/videos\/[a-f0-9]{24}$/.test(url)) {
                const urlId = url.match(/\/api\/videos\/([a-f0-9]{24})$/)[1];
                jsonP.then(json => {
                    const v = json?.data || json;
                    if (!res.ok || !v?._id) { settleVideoDeferred(null); return; }
                    if (videoDeferred) indexVideoDetails([v]);
                    rememberVideo(urlId, v);
                    settleVideoDeferred(v);
                    if (urlId !== v._id) State.slugToApiId.set(urlId, v._id);

                    // The slug part is optional (/video/slug_<hex> or /video/<hex>). Without an id match, background
                    // fetches (e.g. sidebar hover previews) would be taken for the playing video.
                    const pageId = location.pathname.match(/^\/video\/(?:[^?#]*_)?([0-9a-f]{24})(?:[?#]|$)/i)?.[1];
                    // Playlist pages: compare with the active queue row (border-orange-500).
                    const isCurrentPage = pageId
                        ? (urlId === pageId || v._id === pageId || State.slugToApiId.get(pageId) === v._id)
                        : (location.pathname.startsWith('/playlists/')
                            ? v._id === getActiveQueueVideoId()
                            : true);
                    if (isCurrentPage) adoptCurrentVideo(v);
                }).catch(() => settleVideoDeferred(null));
            } else {
                settleVideoDeferred(null);
            }

            // storage.pmvhaven.com/<id>/: used only for the page video, so background fetches don't overwrite state.
            const storageM = url.match(/storage\.pmvhaven\.com\/([a-f0-9]{24})\//);
            if (storageM) {
                const idFromStorage = storageM[1];
                const pageId = location.pathname.match(/^\/video\/(?:[^?#]*_)?([0-9a-f]{24})(?:[?#]|$)/i)?.[1];
                if (pageId && (idFromStorage === pageId || State.slugToApiId.get(pageId) === idFromStorage)) {
                    if (!State.currentVideoData?.id) {
                        State.currentVideoId = idFromStorage;
                    }
                }
            }

            // Site playlist responses (not quiet ones): index their videos so queue rows resolve.
            if (jsonP && /\/api\/playlists\/[a-f0-9]{24}(?:\?|$)/.test(url) && !quietUrls.has(url)) {
                jsonP.then(json => {
                    const details = json?.data?.videoDetails || json?.videoDetails;
                    if (!Array.isArray(details)) return;
                    if (indexVideoDetails(details) > 0) {
                        document.querySelectorAll('[data-pmv-queue-checked]').forEach(el => {
                            delete el.dataset.pmvQueueChecked;
                        });
                        scheduleBadges();
                    }
                }).catch(() => {});
            }
            // Site video lists (discover, browse, search): full metadata lets the filter see more than a card's two tags.
            if (jsonP && !quietUrls.has(url) && !/\/api\/(?:videos\/[a-f0-9]{24}|playlists\/)/.test(url)) {
                jsonP.then(json => {
                    const list = [json?.videos, json?.data, json?.data?.videos, json?.results]
                        .find(a => Array.isArray(a) && a.length && a[0]?._id && typeof a[0].title === 'string' && 'duration' in a[0]);
                    if (list && indexVideoDetails(list.filter(v => Array.isArray(v?.tags) || Array.isArray(v?.top5Tags))) > 0) scheduleBadges();
                }).catch(() => {});
            }
        } catch { settleVideoDeferred(null); }

        return res;
    };

    function adoptCurrentVideo(v) {
        State.currentVideoData = {
            id: v._id,
            title: v.title || null,
            creator: v.uploader || v.uploaderUsername || v.user?.username || null,
            tags: Array.isArray(v.tags) ? v.tags : [],
            top5Tags: Array.isArray(v.top5Tags) ? v.top5Tags : [],
            starsTags: Array.isArray(v.starsTags) ? v.starsTags
                : Array.isArray(v.stars) ? v.stars.map(s => (typeof s === 'string' ? s : (s?.name || ''))).filter(Boolean)
                : [],
            description: v.description || null,
            bayesianRating: v.bayesianRating ?? null,
            uploadDate: v.uploadDate || null,
            // The user's like/dislike/favourite state for the API buttons.
            isLiked: v.isLiked === true,
            isDisliked: v.isDisliked === true,
            isFavorited: v.isFavorited === true,
            // Timeline frames {url, captureTime}, kept for fullscreen hand-over.
            timelineThumbnails: Array.isArray(v.timelineThumbnails)
                ? v.timelineThumbnails.filter(t => t?.url).map(t => ({ url: t.url, captureTime: t.captureTime }))
                : [],
        };
        State.currentVideoId = v._id;
        const existing = document.getElementById('pmv-page-playlists');
        if (existing && existing.dataset.forVideo !== v._id) existing.remove();
        try { injectPagePlaylistButtons(v._id); } catch {}
        try { updateNativePlaylistButtons(true); } catch {}
    }

    // --- Video identification / meta ---

    function getJsonLdVideoId() {
        try {
            const jsonLd = document.querySelector('script[type="application/ld+json"]');
            if (!jsonLd) return null;
            const data = JSON.parse(jsonLd.textContent);

            if (data['@type'] === 'VideoObject') {
                for (const u of [data.contentUrl, data.thumbnailUrl]) {
                    if (!u) continue;
                    const m = u.match(/\/([a-f0-9]{24})[\/\.]/);
                    if (m) return m[1];
                }
                if (data.embedUrl) {
                    const m = data.embedUrl.match(/\/videos\/([a-f0-9]{24})/);
                    if (m) return m[1];
                }
                return null;
            }

            if (data['@type'] === 'ItemList') {
                const index = parseInt(new URLSearchParams(location.search).get('index') || '0', 10);
                const item = data.itemListElement?.find(el => el.position === index + 1);
                const m = (item?.item?.embedUrl || '').match(/\/videos\/([a-f0-9]{24})/);
                return m ? m[1] : null;
            }
        } catch {}
        return null;
    }

    // --- Watched tracking ---
    // Local playback history (PMVX.watched / __pmvIsWatched / __pmvMarkWatched), attached from getVideo()'s init.
    let watchedMap = new Map(); // videoId -> ISO timestamp
    (function loadWatched() {
        try {
            const raw = localStorage.getItem(WATCHED_KEY);
            if (!raw) return;
            watchedMap = new Map(Object.entries(JSON.parse(raw)));
        } catch {}
    })();
    function saveWatched() {
        try {
            if (watchedMap.size > WATCHED_MAX) {
                const sorted = [...watchedMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
                for (const [id] of sorted.slice(0, watchedMap.size - WATCHED_MAX)) watchedMap.delete(id);
            }
            localStorage.setItem(WATCHED_KEY, JSON.stringify(Object.fromEntries(watchedMap)));
        } catch {}
    }
    function markWatched(videoId) {
        if (!videoId) return;
        watchedMap.set(videoId, new Date().toISOString());
        saveWatched();
    }
    PMVX.watched = watchedMap;
    PMVX.isWatched = id => watchedMap.has(id);
    PMVX.markWatched = markWatched;

    // Dedup per current id: Vue reuses the same <video> element across auto-advance.
    let lastMarkedWatchedId = null;
    function maybeMarkWatchedFromPlayback(v) {
        const id = getCurrentVideoId();
        if (!id || id === lastMarkedWatchedId) return;
        if (!v.duration || !Number.isFinite(v.duration)) return;
        if (v.ended || v.currentTime / v.duration >= 0.85) {
            lastMarkedWatchedId = id;
            markWatched(id);
        }
    }

