'use strict';

// Builds docs/index.html: a single self-contained page that bundles src/*.js,
// so it works when opened from disk and when served by GitHub Pages (/docs).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const modules = ['parser', 'audit', 'report'];
const bundle = [
  'var __defs = {}, __cache = {};',
  'function __require(p) {',
  "  var n = p.replace(/^\\.\\//, '');",
  '  if (!__cache[n]) { var m = { exports: {} }; __cache[n] = m; __defs[n](m, __require); }',
  '  return __cache[n].exports;',
  '}',
  ...modules.map((n) =>
    '__defs[' + JSON.stringify(n) + '] = function (module, require) {\n' + read('src/' + n + '.js') + '\n};'),
].join('\n').replace(/<\/script/gi, '<\\/script');

const html = read('web/template.html').replace('/*__MODULES__*/', () => bundle);
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'index.html'), html);
console.log('Built docs/index.html (' + Math.round(html.length / 1024) + ' KB)');
