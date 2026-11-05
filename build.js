#!/usr/bin/env node
// Builds pmvh-extended.user.js from src/. No dependencies: `node build.js`.
'use strict';
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const read = f => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8').replace(/\s+$/, '') + '\n';

const out = [
    read('header.js').replace('{{VERSION}}', pkg.version),
    '',
    '(function () {',
    "'use strict';",
    '',
    read('core.js'),
    '// Playlist-page and /playlists filters: safe at document-start.',
    read('filter.js'),
    '// Core (HUD, queue, badges, settings, hotkeys) and the browse filter need <body>.',
    'whenBody(() => {',
    read('hud.js'),
    read('browse.js'),
    '});',
    '})();',
    '',
].join('\n');

fs.writeFileSync(path.join(__dirname, 'pmvh-extended.user.js'), out);
console.log(`pmvh-extended.user.js ${pkg.version}: ${out.split('\n').length} lines`);
