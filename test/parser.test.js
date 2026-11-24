// Zijbalkfilter parser: typed chips -> text -> tokens must round-trip. Run: node test/parser.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const slice = (text, from, to) => {
    const a = text.indexOf(from), b = text.indexOf(to, a);
    assert(a !== -1 && b !== -1, `marker not found: ${from} / ${to}`);
    return text.slice(a, b);
};
const code = [
    'const PMVX = {};',
    slice(src('core.js'), 'const termWordRes', 'PMVX.isWordTerm') + 'PMVX.isWordTerm = term => !!term && term.length > 1 && term[0] === "=";',
    slice(src('filter/02-syntax.js'), 'function tokenizeRaw', '// Normalizes meta.duration'),
    slice(src('filter/04-panel.js'), 'function quoteTerm', 'const uiToText'),
    'return { parseTokens, compose, chipTerm };',
].join('\n');
const { parseTokens, compose, chipTerm } = new Function(code)();

const roundTrip = typed => parseTokens(compose(typed.map(chipTerm), [], null, [])).textInclude;

assert.deepStrictEqual(roundTrip(['"big tits']), ['=big tits']);
assert.deepStrictEqual(roundTrip(['12" vinyl']), ['=12 vinyl']);
assert.deepStrictEqual(roundTrip(["'80s", "90's"]), ["'80s", "90's"]);
assert.deepStrictEqual(roundTrip(['"foo bar"']), ['=foo bar']);
assert.deepStrictEqual(roundTrip(['#Remix']), ['remix']);
assert.deepStrictEqual(parseTokens('-"foo bar" baz').textExclude, ['=foo bar']);
assert.deepStrictEqual(parseTokens("rock 'n' roll").textInclude, ['rock', "=n", 'roll']);
console.log('parser ok');
