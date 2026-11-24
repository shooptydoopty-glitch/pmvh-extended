#!/usr/bin/env node
// Builds pmvh-extended.user.js from src/. No dependencies: `node build.js`.
'use strict';
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const read = f => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8').replace(/\s+$/, '') + '\n';
// A module split over src/<name>/*.js: the files are joined in file-name order inside one function
// scope, so they share their top-level names (no imports needed between them).
const readModule = (name, gap) => {
    const dir = path.join(__dirname, 'src', name);
    const parts = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
        .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    return ("\n(function () {\n    'use strict';\n" + gap + parts + '})();').replace(/\s+$/, '') + '\n';
};

const out = [
    read('header.js').replace('{{VERSION}}', pkg.version),
    '',
    '(function () {',
    "'use strict';",
    '',
    read('core.js'),
    '// Playlist-page and /playlists filters: safe at document-start.',
    readModule('filter', '\n'),
    '// Core (HUD, queue, badges, settings, hotkeys), the browse filter, header search and tag menu need <body>.',
    'whenBody(() => {',
    readModule('hud', '\n\n'),
    read('browse.js'),
    read('search.js'),
    read('tagmenu.js'),
    '});',
    '})();',
    '',
].join('\n');

// Syntax check of the joined script (a split file can still break the whole).
new (require('vm').Script)(out, { filename: 'pmvh-extended.user.js' });
fs.writeFileSync(path.join(__dirname, 'pmvh-extended.user.js'), out);
console.log(`pmvh-extended.user.js ${pkg.version}: ${out.split('\n').length} lines`);
