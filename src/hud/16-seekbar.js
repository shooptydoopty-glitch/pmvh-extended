    // --- Seekbar preview ---
    // Frame above the player's time bar at the hovered time; prepared ahead, a hover never seeks.
    // Layers: the ten API frames (timelineThumbnails) show at once; over them a cache built in the background
    // once the video plays. Cache: hidden players on the lowest rendition via the site's own hls.js constructor
    // (segments from the HTTP cache: CPU, not bandwidth). Frames are taken at keyframes (a seek decodes from the
    // previous one), timed from the TS segments (PES PTS of random-access packets); seeking SCRUB_KEY_MARGIN past
    // one lands cheaply. Then gaps > SCRUB_GAP get a middle frame, widest first (costly mid-GOP seeks). Segments go
    // coarse-to-fine across players; without TS (plain file, fMP4) one player walks 2 s steps.
    // The bar (onMousemove=handleProgressHover) is matched on document mouse events, not attached to: Vue may rebuild it.
    // Setting: hybrid = live cache (default), frames = API frames only, off.
    const SCRUB_KEY = 'pmv_scrub_preview_v1';
    const SCRUB_BAR_SELECTOR = '.controls-bar-wrapper .cursor-pointer.py-3';
    const SCRUB_W = 176;            // width of a landscape preview
    const SCRUB_MAX_H = 176;        // height cap for a portrait one
    const SCRUB_LIFT = 38;          // px between the bar's box and the preview: clears the site's time label
    const SCRUB_WARM_DELAY = 1500;  // ms after the real video starts playing before the cache is built
    const SCRUB_FRAMES_MAX = 600;   // frames kept per video at most (176x99x4 bytes each: ~40 MB)
    const SCRUB_GAP = 2.5;          // s; wider gaps between frames get one in the middle
    const SCRUB_KEY_MARGIN = 0.08;  // s past a keyframe time to seek: lands on it without decoding the GOP before
    const SCRUB_GEN_MAX = 3;        // hidden players at most
    const SCRUB_WALK_STEP = 2;      // s between frames when there is no keyframe index
    const SCRUB_ZONE_PX = 26;       // height of the HUD's own hover/seek strip at the bottom of fullscreen

    let scrubModeCached = (() => { try { return localStorage.getItem(SCRUB_KEY) || 'frames'; } catch { return 'frames'; } })();
    // The live frame cache is skipped in Light mode (it runs hidden players).
    function scrubMode() { return scrubModeCached === 'hybrid' && PMVX.perfMode() === 'light' ? 'frames' : scrubModeCached; }
    function setScrubMode(mode) {
        scrubModeCached = mode;
        try { localStorage.setItem(SCRUB_KEY, mode); } catch {}
        if (mode !== 'hybrid') scrubDrop();
        if (mode === 'off') scrubHide();
        if (mode === 'hybrid') scrubWarm();
    }

    const Scrub = {
        tip: null, img: null, canvas: null, ctx: null, gensRoot: null,
        visible: false, dragBar: null, dragSeek: false, watch: null, warmTimer: null,
        key: null, failedKey: null, token: 0,
        gens: [],            // { video, hls }
        frames: null,        // { t: number[], b: ImageBitmap[] }, sorted by t
        framesW: 0, framesH: 0, gapStall: 0,
    };

    // 16:9 and wider at a fixed width; portrait capped in height.
    function scrubDims(video) {
        const ar = (video?.videoWidth && video?.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
        let w = SCRUB_W, h = Math.round(w / ar);
        if (h > SCRUB_MAX_H) { h = SCRUB_MAX_H; w = Math.round(h * ar); }
        return { w, h };
    }

    // API frames: from the video's own data once loaded, else the page's strip (not mid fullscreen hand-over).
    function scrubApiFrames() {
        return timelineFrames().filter(f => f.time !== null);
    }

    function scrubNearestApiFrame(t) {
        let best = null;
        for (const f of scrubApiFrames()) {
            if (!best || Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
        }
        return best;
    }

    function ensureScrubTip() {
        if (!Scrub.tip) {
            const tip = document.createElement('div');
            tip.id = 'pmv-scrub-preview';
            tip.style.cssText = 'position:fixed;z-index:1000000;pointer-events:none;display:none;' +   // above the HUD panel
                'border-radius:8px;overflow:hidden;background:#000;' +
                'box-shadow:0 4px 18px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.18);';
            const img = document.createElement('img');
            img.draggable = false;
            img.decoding = 'async';
            img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;';
            tip.appendChild(img);
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;';
            tip.appendChild(canvas);
            const label = document.createElement('div');
            label.style.cssText = 'position:absolute;left:50%;bottom:4px;transform:translateX(-50%);display:none;' +
                'padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.75);color:#fff;font-size:11px;font-family:inherit;font-variant-numeric:tabular-nums;';
            tip.appendChild(label);
            Scrub.tip = tip;
            Scrub.img = img;
            Scrub.canvas = canvas;
            Scrub.ctx = canvas.getContext('2d');
            Scrub.label = label;
        }
        // In fullscreen only the fullscreen element's children show, so the tip follows it.
        const root = getFullscreenRoot() || document.body;
        if (Scrub.tip.parentElement !== root) root.appendChild(Scrub.tip);
        return Scrub.tip;
    }

    // Hidden players sit in a display:none box on body: seeking and drawImage work there, and
    // being attached keeps the media sweep (detached elements only) off them.
    function ensureScrubGensRoot() {
        if (Scrub.gensRoot?.isConnected) return Scrub.gensRoot;
        if (!Scrub.gensRoot) {
            const box = document.createElement('div');
            box.id = 'pmv-scrub-gens';
            box.style.cssText = 'display:none;';
            Scrub.gensRoot = box;
        }
        document.body.appendChild(Scrub.gensRoot);
        return Scrub.gensRoot;
    }

    // HLS when the site's hls.js has a URL, else the file; a blob: URL (MSE without hls) can't be reopened.
    function scrubSource() {
        const video = getVideo();
        if (!video) return null;
        const api = findPlayerApi();
        const hls = api?.hls?.value;
        if (hls?.url && typeof hls.constructor === 'function') {
            return { kind: 'hls', url: hls.url, Hls: hls.constructor, bitrate: hls.levels?.[0]?.bitrate || 0 };
        }
        const src = video.currentSrc || video.getAttribute('src') || '';
        if (src && !src.startsWith('blob:')) return { kind: 'file', url: src };
        return null;
    }

    function scrubDrop() {
        Scrub.token++;
        clearTimeout(Scrub.warmTimer);
        for (const g of Scrub.gens) {
            if (g.hls) { try { g.hls.destroy(); } catch {} }
            try { g.video.pause(); g.video.removeAttribute('src'); g.video.srcObject = null; g.video.load(); } catch {}
            g.video.remove();
        }
        Scrub.gens = [];
        if (Scrub.frames) for (const b of Scrub.frames.b) { try { b.close(); } catch {} }
        Scrub.frames = null;
        Scrub.key = null;
        if (Scrub.canvas) Scrub.canvas.style.display = 'none';
    }

    function scrubWarm() {
        if (scrubMode() !== 'hybrid') return;
        if (!/^\/(video|playlists)\//.test(location.pathname)) return;
        try { scrubBuild(); } catch {}
    }

    function scrubMakePlayer(source, full) {
        const video = document.createElement('video');
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.dataset.pmvPreviewVideo = '1';   // getVideo() must never take this for the player
        ensureScrubGensRoot().appendChild(video);
        const g = { video, hls: null, fragTimes: new Map(), fragWaiters: new Map(), tapped: false };
        if (source.kind === 'hls') {
            // Tap the player's fragment loader: bytes it loads anyway are parsed for keyframes (synchronously,
            // before hls.js hands them to its worker). Without a tap scrubBuildFromIndex fetches fragments itself.
            const Base = source.Hls.DefaultConfig?.loader;
            let fLoader;
            if (typeof Base === 'function') {
                fLoader = class extends Base {
                    load(context, config, callbacks) {
                        const onSuccess = callbacks?.onSuccess;
                        if (onSuccess) {
                            callbacks = {
                                ...callbacks,
                                onSuccess: (response, stats, ctx, details) => {
                                    try { scrubTapFrag(g, (ctx || context)?.frag, response?.data); } catch {}
                                    onSuccess(response, stats, ctx, details);
                                },
                            };
                        }
                        return super.load(context, config, callbacks);
                    }
                };
                g.tapped = true;
            }
            // Lowest level only (preview is 176px wide). maxBufferLength below fragment length loads only the
            // fragment at the seek position, keeping memory flat; a walking player (no index) buffers everything.
            const h = new source.Hls({
                autoStartLoad: false, enableWorker: true,
                startLevel: 0, capLevelToPlayerSize: true,
                maxBufferLength: full ? 4 * 3600 : 20, maxMaxBufferLength: full ? 4 * 3600 : 40,
                backBufferLength: full ? Infinity : 5, maxBufferSize: full ? 400 * 1000 * 1000 : 30 * 1000 * 1000,
                fragLoadingMaxRetry: 2, levelLoadingMaxRetry: 2, manifestLoadingMaxRetry: 2,
                ...(fLoader ? { fLoader } : {}),
            });
            const parsed = source.Hls.Events?.MANIFEST_PARSED || 'hlsManifestParsed';
            h.on(parsed, () => { try { h.currentLevel = 0; } catch {} });
            h.loadSource(source.url);
            h.attachMedia(video);
            g.hls = h;
        } else {
            video.src = source.url;
        }
        return g;
    }

    function scrubBuild() {
        const key = getCurrentVideoId();
        if (!key || Scrub.failedKey === key) return;
        if (Scrub.key === key && Scrub.gens.length && Scrub.gens.every(g => g.video.isConnected && !mediaIsDead(g.video))) return;
        scrubDrop();
        const main = getVideo();
        const dur = main?.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const source = scrubSource();
        if (!source) return;
        Scrub.key = key;
        const token = ++Scrub.token;
        const live = () => Scrub.token === token;
        Scrub.frames = { t: [], b: [] };
        const dims = scrubDims(main);
        Scrub.framesW = dims.w;
        Scrub.framesH = dims.h;
        try {
            if (source.kind === 'hls') {
                const count = Math.max(1, Math.min(SCRUB_GEN_MAX, Math.floor((navigator.hardwareConcurrency || 2) / 2) || 1));
                for (let i = 0; i < count; i++) Scrub.gens.push(scrubMakePlayer(source, false));
                scrubBuildFromIndex(token, live, dur).catch(() => { if (live()) scrubWalk(token, live, dur).catch(() => {}); });
            } else {
                Scrub.gens.push(scrubMakePlayer(source, true));
                scrubWalk(token, live, dur).catch(() => {});
            }
        } catch {
            Scrub.failedKey = key;
            scrubDrop();
        }
    }

    // --- Taking a frame ---

    const scrubSleep = ms => new Promise(r => setTimeout(r, ms));
    const scrubIdle = () => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 200 }) : setTimeout(r, 16)));

    function scrubSeek(video, t, timeoutMs = 5000) {
        return new Promise(resolve => {
            let settled = false;
            const finish = ok => { if (settled) return; settled = true; video.removeEventListener('seeked', onSeeked); resolve(ok); };
            const onSeeked = () => finish(true);
            video.addEventListener('seeked', onSeeked);
            setTimeout(() => finish(false), timeoutMs);
            try { video.currentTime = t; } catch { finish(false); }
        });
    }

    // Sorted insert; skips frames within 0.1 s of an existing one.
    function scrubKeep(t, bmp) {
        const f = Scrub.frames;
        if (!f) { try { bmp.close(); } catch {} return false; }
        let lo = 0, hi = f.t.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (f.t[mid] < t) lo = mid + 1; else hi = mid; }
        if ((lo < f.t.length && Math.abs(f.t[lo] - t) < 0.1) || (lo > 0 && Math.abs(f.t[lo - 1] - t) < 0.1)) { try { bmp.close(); } catch {} return false; }
        f.t.splice(lo, 0, t);
        f.b.splice(lo, 0, bmp);
        return true;
    }

    // Seeks a hidden player to t and keeps the frame; false if the seek did not land.
    async function scrubGrab(g, t, live) {
        const video = g.video;
        const landed = await scrubSeek(video, t);
        if (!live() || !landed || video.readyState < 2) return false;
        if (!g.canvas) {
            g.canvas = document.createElement('canvas');
            g.canvas.width = Scrub.framesW;
            g.canvas.height = Scrub.framesH;
            g.ctx = g.canvas.getContext('2d');
        }
        g.ctx.drawImage(video, 0, 0, Scrub.framesW, Scrub.framesH);
        const bmp = await createImageBitmap(g.canvas);
        if (!live()) { try { bmp.close(); } catch {} return false; }
        scrubKeep(video.currentTime, bmp);
        return true;
    }

    function scrubFramesFull() { return !Scrub.frames || Scrub.frames.t.length >= SCRUB_FRAMES_MAX; }

    // Coarse-to-fine order (0, n/2, n/4, 3n/4, ...) so every stretch gets a nearby frame early.
    function scrubOrder(n) {
        const order = [];
        const done = new Uint8Array(n);
        let stride = 1;
        while (stride * 2 < n) stride *= 2;
        for (; stride >= 1; stride = Math.floor(stride / 2)) {
            for (let i = 0; i < n; i += stride) if (!done[i]) { done[i] = 1; order.push(i); }
        }
        return order;
    }

    // --- Keyframe index from TS segments ---

    // Level playlist as hls.js read it (fragments with url, start, duration); null if it never loads.
    async function scrubLevelDetails(h, live) {
        for (let i = 0; i < 100; i++) {
            if (!live()) return null;
            const d = h.levels?.[0]?.details;
            if (d?.fragments?.length) return d;
            if (i === 0) { try { h.startLoad(0); } catch {} }
            await scrubSleep(100);
        }
        return null;
    }

    // Keyframe times of one MPEG-TS segment: PTS of random-access video PES packets, placed on the
    // media timeline as hls.js does; null if not TS.
    function scrubParseTs(buf, fragStart) {
        const b = new Uint8Array(buf);
        const n = Math.floor(b.length / 188);
        if (n < 10 || b[0] !== 0x47 || b[188] !== 0x47) return null;
        let pmtPid = -1, videoPid = -1, firstDts = null;
        const keys = [];
        const stamp = o => (((b[o] & 0x0e) * 536870912) + (b[o + 1] * 4194304) + ((b[o + 2] & 0xfe) * 16384) + (b[o + 3] * 128) + ((b[o + 4] & 0xfe) / 2));
        for (let i = 0; i < n; i++) {
            const o = i * 188;
            if (b[o] !== 0x47) continue;
            const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
            const pusi = b[o + 1] & 0x40;
            const afc = (b[o + 3] >> 4) & 3;
            let p = o + 4, rai = false;
            if (afc & 2) { const afl = b[o + 4]; if (afl > 0) rai = !!(b[o + 5] & 0x40); p = o + 5 + afl; }
            if (!(afc & 1) || p >= o + 188) continue;
            if (pid === 0 && pusi) {
                const s = p + 1 + b[p];
                const sl = ((b[s + 1] & 0x0f) << 8) | b[s + 2];
                for (let j = s + 8; j < s + 3 + sl - 4; j += 4) {
                    const prog = (b[j] << 8) | b[j + 1];
                    if (prog !== 0) { pmtPid = ((b[j + 2] & 0x1f) << 8) | b[j + 3]; break; }
                }
                continue;
            }
            if (pid === pmtPid && pusi && videoPid < 0) {
                const s = p + 1 + b[p];
                const sl = ((b[s + 1] & 0x0f) << 8) | b[s + 2];
                const pil = ((b[s + 10] & 0x0f) << 8) | b[s + 11];
                let j = s + 12 + pil;
                const end = s + 3 + sl - 4;
                while (j < end) {
                    const st = b[j];
                    const epid = ((b[j + 1] & 0x1f) << 8) | b[j + 2];
                    const eil = ((b[j + 3] & 0x0f) << 8) | b[j + 4];
                    if (st === 0x1b || st === 0x24) { videoPid = epid; break; }
                    j += 5 + eil;
                }
                continue;
            }
            if (pid !== videoPid || !pusi) continue;
            if (b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) continue;
            const flags = b[p + 7];
            if (!(flags & 0x80)) continue;
            const pts = stamp(p + 9);
            const dts = (flags & 0x40) ? stamp(p + 14) : pts;
            if (firstDts === null) firstDts = dts;
            if (rai) keys.push(pts);
        }
        if (firstDts === null) return null;
        return keys.map(pts => fragStart + (pts - firstDts) / 90000);
    }

    // Keyframe times per fragment sequence number from the tapped loader; waiters are notified.
    function scrubTapFrag(g, frag, data) {
        if (!frag || typeof frag.sn !== 'number' || !(data instanceof ArrayBuffer) || !data.byteLength) return;
        const times = scrubParseTs(data, frag.start);
        g.fragTimes.set(frag.sn, times);
        const waiters = g.fragWaiters.get(frag.sn);
        if (waiters) { g.fragWaiters.delete(frag.sn); waiters.forEach(r => r(times)); }
    }

    // Resolves with the fragment's keyframe times (null: not TS), or undefined on timeout.
    function scrubWaitFragTimes(g, sn, ms) {
        if (g.fragTimes.has(sn)) return Promise.resolve(g.fragTimes.get(sn));
        return new Promise(resolve => {
            const list = g.fragWaiters.get(sn) || [];
            list.push(resolve);
            g.fragWaiters.set(sn, list);
            setTimeout(() => resolve(undefined), ms);
        });
    }

    async function scrubBuildFromIndex(token, live, dur) {
        const gens = Scrub.gens;
        const details = await scrubLevelDetails(gens[0].hls, live);
        if (!details) throw new Error('no level');
        const frags = details.fragments;
        // Players claim fragments coarse-to-fine; keyframes go in order within a fragment.
        const order = scrubOrder(frags.length);
        let next = 0;
        let indexed = false;
        const perFragCap = Math.max(2, Math.floor(SCRUB_FRAMES_MAX / frags.length));
        const work = async g => {
            while (live() && next < order.length && !scrubFramesFull()) {
                if (document.hidden) { await scrubSleep(250); continue; }
                const frag = frags[order[next++]];
                // Loading starts at this player's first fragment; each later seek makes hls.js fetch its fragment.
                if (!g.started) { g.started = true; try { g.hls.startLoad(frag.start); } catch {} }
                // The first grab at the fragment start (a keyframe) makes the tapped player load it and deliver the
                // rest of its keyframe times; if the tap yields nothing in time, the fragment is fetched separately.
                let times;
                let startGrabbed = false;
                if (g.tapped) {
                    const wait = scrubWaitFragTimes(g, frag.sn, 8000);
                    startGrabbed = await scrubGrab(g, Math.min(frag.start + SCRUB_KEY_MARGIN, dur - 0.05), live);
                    if (!live()) return;
                    times = await wait;
                }
                if (times === undefined) {
                    times = null;
                    try {
                        const res = await fetch(frag.url);
                        if (res.ok) times = scrubParseTs(await res.arrayBuffer(), frag.start);
                    } catch {}
                }
                if (!live()) return;
                if (!times) throw new Error('not ts');   // no index: hand the whole thing to scrubWalk
                if (startGrabbed) times = times.filter(t => t - frag.start > 0.15);
                indexed = true;
                if (times.length > perFragCap) {
                    // Too many to keep: an even pick across the fragment.
                    const step = times.length / perFragCap;
                    times = Array.from({ length: perFragCap }, (_, i) => times[Math.floor(i * step)]);
                }
                for (const t of times) {
                    if (!live() || scrubFramesFull()) return;
                    if (t >= dur - 0.05) continue;
                    await scrubGrab(g, Math.min(t + SCRUB_KEY_MARGIN, dur - 0.05), live);
                    await scrubIdle();
                }
            }
        };
        await Promise.all(gens.map(g => work(g).catch(e => { if (!indexed) throw e; })));
        if (!live()) return;
        await scrubFillGaps(token, live, dur);
    }

    // Fills the widest gaps first until none exceeds SCRUB_GAP or the cache is full.
    async function scrubFillGaps(token, live, dur) {
        const gens = Scrub.gens;
        const gaps = () => {
            const f = Scrub.frames;
            if (!f) return [];
            const out = [];
            let prev = 0;
            for (let i = 0; i <= f.t.length; i++) {
                const t = i < f.t.length ? f.t[i] : dur;
                if (t - prev > SCRUB_GAP) out.push({ a: prev, b: t });
                prev = t;
            }
            return out.sort((x, y) => (y.b - y.a) - (x.b - x.a));
        };
        let busy = 0;
        Scrub.gapStall = 0;
        for (const g of gens) if (!g.started) { g.started = true; try { g.hls?.startLoad(-1); } catch {} }
        while (live() && !scrubFramesFull()) {
            if (document.hidden) { await scrubSleep(250); continue; }
            const list = gaps();
            if (!list.length) return;
            const batch = list.slice(0, gens.length);
            await Promise.all(batch.map((gap, i) => scrubGrab(gens[i], (gap.a + gap.b) / 2, live)));
            if (++busy % 4 === 0) await scrubIdle();
            // Stops after three rounds without progress.
            const after = gaps();
            if (after.length >= list.length && after[0].b - after[0].a >= list[0].b - list[0].a) { if (++Scrub.gapStall > 3) return; } else Scrub.gapStall = 0;
        }
    }

    // No index (plain file or fMP4): one player, 2 s steps, coarse-to-fine.
    async function scrubWalk(token, live, dur) {
        const g = Scrub.gens[0];
        if (!g) return;
        if (g.hls) { try { g.hls.startLoad(0); } catch {} }
        const step = Math.max(SCRUB_WALK_STEP, dur / SCRUB_FRAMES_MAX);
        const n = Math.floor(dur / step) + 1;
        const queue = scrubOrder(n);
        const tries = new Uint8Array(n);
        while (queue.length && live() && !scrubFramesFull()) {
            if (document.hidden) { await scrubSleep(250); continue; }
            const i = queue.shift();
            const ok = await scrubGrab(g, Math.min(i * step, Math.max(0, dur - 0.05)), live);
            if (!ok && ++tries[i] <= 3) { queue.push(i); await scrubSleep(300); }
            await scrubIdle();
        }
    }

    // --- Showing ---

    function scrubCachedNear(t) {
        const f = Scrub.frames;
        if (!f || !f.t.length) return null;
        let lo = 0, hi = f.t.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (f.t[mid] < t) lo = mid + 1; else hi = mid; }
        if (lo > 0 && Math.abs(f.t[lo - 1] - t) < Math.abs(f.t[lo] - t)) lo--;
        return f.b[lo];
    }

    function scrubHide() {
        Scrub.visible = false;
        clearInterval(Scrub.watch);
        Scrub.watch = null;
        if (Scrub.tip) Scrub.tip.style.display = 'none';
    }

    function scrubShowAt(bar, clientX) {
        const video = getVideo();
        const dur = video?.duration;
        if (!video || !Number.isFinite(dur) || dur <= 0) { scrubHide(); return; }
        const rect = bar.getBoundingClientRect();
        if (rect.width <= 0) { scrubHide(); return; }
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const t = pos * dur;

        const frame = scrubNearestApiFrame(t);
        const cached = scrubCachedNear(t);
        if (!frame && !cached) { scrubHide(); return; }   // nothing to show yet: no empty black box

        const tip = ensureScrubTip();
        const { w, h } = scrubDims(video);
        tip.style.width = w + 'px';
        tip.style.height = h + 'px';
        const left = Math.max(rect.left, Math.min(rect.right - w, clientX - w / 2));
        tip.style.left = Math.round(left) + 'px';
        tip.style.top = Math.round(rect.top - SCRUB_LIFT - h) + 'px';
        tip.style.display = 'block';

        if (frame) {
            if (Scrub.img.getAttribute('src') !== frame.src) Scrub.img.src = frame.src;
            Scrub.img.style.display = 'block';
        } else {
            Scrub.img.style.display = 'none';
        }
        if (cached) {
            if (Scrub.canvas.width !== Scrub.framesW || Scrub.canvas.height !== Scrub.framesH) {
                Scrub.canvas.width = Scrub.framesW;
                Scrub.canvas.height = Scrub.framesH;
            }
            try { Scrub.ctx.drawImage(cached, 0, 0, Scrub.framesW, Scrub.framesH); } catch {}
            Scrub.canvas.style.display = 'block';
        } else {
            Scrub.canvas.style.display = 'none';
        }

        const ownStrip = bar.id === 'pmv-scrub-zone';
        if (Scrub.label) {
            Scrub.label.textContent = formatTime(t);
            Scrub.label.style.display = ownStrip ? 'block' : 'none';   // the site's bar shows its own
        }

        if (!Scrub.visible) {
            Scrub.visible = true;
            // The site hides controls after idle seconds and Vue may drop the bar; the tip must not outlive either.
            Scrub.watch = setInterval(() => {
                if (!bar.isConnected) { scrubHide(); return; }
                if (!ownStrip && bar.closest('.controls-bar-wrapper')?.classList.contains('controls-hidden')) scrubHide();
            }, 250);
        }
    }

    document.addEventListener('mousemove', e => {
        if (scrubMode() === 'off') return;
        const target = e.target instanceof Element ? e.target : null;
        // During a drag-seek the preview follows the pointer anywhere, via the bar it started on.
        const bar = target?.closest(SCRUB_BAR_SELECTOR) || target?.closest('#pmv-scrub-zone') || Scrub.dragBar;
        if (!bar) { if (Scrub.visible) scrubHide(); return; }
        if (Scrub.dragSeek && Scrub.dragBar === bar) {
            const v = getVideo();
            const r = bar.getBoundingClientRect();
            if (v && Number.isFinite(v.duration) && v.duration > 0 && r.width > 0) {
                try { v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.duration; } catch {}
            }
        }
        scrubShowAt(bar, e.clientX);
    }, true);
    document.addEventListener('pointerdown', e => {
        const target = e.target instanceof Element ? e.target : null;
        // The own strip sets dragBar itself (its handler also seeks).
        if (target?.closest('#pmv-scrub-zone')) return;
        Scrub.dragBar = target?.closest(SCRUB_BAR_SELECTOR) || null;
        Scrub.dragSeek = false;
    }, true);
    const scrubDragEnd = () => { Scrub.dragBar = null; Scrub.dragSeek = false; };
    window.addEventListener('pointerup', scrubDragEnd, true);
    window.addEventListener('pointercancel', scrubDragEnd, true);
    document.addEventListener('mouseleave', () => scrubHide());
    document.addEventListener('fullscreenchange', () => scrubHide());

