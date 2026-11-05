// ---------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------
// Shared namespace for the modules below (cache state, watch history,
// cross-module hooks). Kept off `window` on purpose.
const PMVX = {};

// The script runs at document-start so the fetch interceptors see the
// site's first API calls; modules that touch the DOM wait for <body>.
function whenBody(fn) {
    if (document.body) { fn(); return; }
    const root = document.documentElement;
    if (!root) { setTimeout(() => whenBody(fn), 10); return; }
    const mo = new MutationObserver(() => {
        if (!document.body) return;
        mo.disconnect();
        fn();
    });
    mo.observe(root, { childList: true });
}
