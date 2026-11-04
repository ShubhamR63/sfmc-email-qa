'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { audit, overallResult, classifyUrl } = require('../src/audit');

const sample = (n) => fs.readFileSync(path.join(__dirname, '..', 'samples', n), 'utf8');

const wrap = (body, head) => `<html><head>${head || ''}</head>
<custom name="opencounter" type="tracking"/>
<custom name="usermatch" type="tracking" />
<body>${body}</body></html>`;

test('good sample passes; --strict fails on warnings', () => {
  const r = audit(sample('good-email.html'), 'good');
  assert.strictEqual(overallResult(r, false), 'PASS');
  assert.strictEqual(overallResult(r, true), 'FAIL');
  assert.strictEqual(r.summary.totalHrefs, 6);
  assert.strictEqual(r.summary.totalSrcs, 3);
});

test('bad sample fails with expected counts', () => {
  const r = audit(sample('bad-email.html'), 'bad');
  assert.strictEqual(overallResult(r, false), 'FAIL');
  assert.strictEqual(r.summary.totalHrefs, 9);
  assert.strictEqual(r.summary.totalSrcs, 5);
  assert.strictEqual(r.summary.duplicateAliases, 1);
  assert.strictEqual(r.summary.aliasesWithSpaces, 1);
  assert.strictEqual(r.summary.missingAliases, 2);
  assert.strictEqual(r.summary.trackingIssues, 2);
  assert.strictEqual(r.summary.contentBlockIssues, 1);
  assert.strictEqual(r.summary.unsubscribeIssues, 1);
});

test('text-only and AMPscript hrefs are never omitted', () => {
  const r = audit(wrap('<a href="%%=RedirectTo(@x)=%%" alias="a">t</a><a href="mailto:a@b.com" alias="b">m</a>'), 'x');
  assert.strictEqual(r.hrefRows.length, 2);
  assert.strictEqual(r.hrefRows[0].src, 'Missing / Text Link');
});

test('images without links are still in the SRC inventory', () => {
  const r = audit(wrap('<img src="https://a.com/x.png" alt="x"><img src="https://a.com/y.png" alt="y">'), 'x');
  assert.strictEqual(r.srcRows.length, 2);
  assert.strictEqual(r.srcRows[0].href, 'Missing');
});

test('AMPscript with nested quotes and > inside attribute values', () => {
  const r = audit(wrap(`<a href="%%=RedirectTo(concat("https://a.com/?q=", IIF(@a > 1, "x", "y")))=%%" alias="nested"><img src="https://a.com/i.png" alt="Nested"></a>`), 'x');
  assert.strictEqual(r.hrefRows.length, 1);
  assert.strictEqual(r.hrefRows[0].alias, 'nested');
  assert.strictEqual(r.srcRows.length, 1);
});

test('AMPscript blocks and HTML comments do not produce phantom links', () => {
  const r = audit(wrap(`%%[ SET @h = '<a href="https://ghost.com">x</a>' ]%%<!-- <a href="https://old.com" alias="old">x</a> --><a href="https://real.com" alias="real">r</a>`), 'x');
  assert.deepStrictEqual(r.hrefRows.map((x) => x.href), ['https://real.com']);
});

test('Outlook conditional comment content is audited', () => {
  const r = audit(wrap(`<!--[if mso]><a href="https://mso.com" alias="mso">m</a><![endif]-->`), 'x');
  assert.strictEqual(r.hrefRows.length, 1);
});

test('single-quoted and unquoted attributes are parsed', () => {
  const r = audit(wrap(`<a href='https://a.com' alias=one><img src=https://a.com/i.png alt='Single'></a>`), 'x');
  assert.strictEqual(r.hrefRows[0].alias, 'one');
  assert.strictEqual(r.srcRows[0].alt, 'Single');
});

test('attribute names are case-insensitive', () => {
  const r = audit(wrap(`<A HREF="https://a.com" ALIAS="up"><IMG SRC="https://a.com/i.png" ALT="Up"></A>`), 'x');
  assert.strictEqual(r.hrefRows.length, 1);
  assert.strictEqual(r.srcRows[0].alt, 'Up');
});

test('tracking code placement and missing codes', () => {
  const after = audit('<html><body><custom name="opencounter" type="tracking"/></body></html>', 'x');
  assert.strictEqual(after.tracking[0].status, 'INCORRECT PLACEMENT');
  assert.strictEqual(after.tracking[1].status, 'MISSING');
  const ok = audit(wrap(''), 'x');
  assert.ok(ok.tracking.every((t) => t.status === 'OK'));
});

test('content blocks by key and id are reported', () => {
  const r = audit(wrap('%%=ContentBlockByKey("k1")=%% %%=ContentBlockByID(1234)=%%'), 'x');
  assert.deepStrictEqual(r.contentBlocks.map((b) => [b.type, b.value]),
    [['ContentBlockByKey', 'k1'], ['ContentBlockByID', '1234']]);
});

test('unsubscribe requires block and RedirectTo(@urlOrganic) with alias', () => {
  const ok = audit(wrap('%%=ContentBlockByKey("u")=%%<a href="%%=RedirectTo(@urlOrganic)=%%" alias="unsubscribe">u</a>'), 'x');
  assert.strictEqual(ok.unsubscribe.ok, true);
  const bad = audit(wrap('<a href="%%=RedirectTo(@urlOrganic)=%%" alias="unsub">u</a>'), 'x');
  assert.strictEqual(bad.unsubscribe.ok, false);
  assert.ok(bad.unsubscribe.message.startsWith('Add Unsub block:\n%%=ContentBlockByKey("xxxxxxxxxx")=%%'));
});

test('placeholder and empty ALT detection', () => {
  const r = audit(wrap('<a href="https://a.com" alias="a"><img src="https://a.com/1.png" alt="image"></a><a href="https://b.com" alias="b"><img src="https://a.com/2.png" alt=""></a>'), 'x');
  assert.strictEqual(r.summary.emptyOrPlaceholderAlts, 2);
});

test('URL classification', () => {
  assert.strictEqual(classifyUrl('https://a.com').kind, 'https');
  assert.strictEqual(classifyUrl('http://a.com').kind, 'http');
  assert.strictEqual(classifyUrl('%%=RedirectTo(@u)=%%').kind, 'ampscript');
  assert.strictEqual(classifyUrl('%%view_email_url%%').kind, 'ampscript');
  assert.strictEqual(classifyUrl('').kind, 'empty');
  assert.strictEqual(classifyUrl('#').kind, 'invalid');
  assert.strictEqual(classifyUrl('/relative').kind, 'invalid');
  assert.strictEqual(classifyUrl('https://').kind, 'invalid');
  assert.strictEqual(classifyUrl('%%=RedirectTo(@u').kind, 'invalid');
});
