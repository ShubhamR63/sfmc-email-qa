'use strict';

const { overallResult } = require('./audit');

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const cell = (s) => '`' + esc(s).replace(/`/g, "'") + '`';

function flag(text) {
  return /^Missing|^\(empty\)$/.test(text) ? '**' + esc(text) + '**' : cell(text);
}

function statusText(issues) {
  const shown = issues.filter((i) => i.level !== 'info' || issues.length === 1);
  if (!shown.length) return 'OK';
  const icon = { fail: 'FAIL', warn: 'WARN', info: 'INFO' };
  return shown.map((i) => icon[i.level] + ': ' + i.msg).join('; ');
}

function table(headers, rows) {
  if (!rows.length) return '_None_\n';
  const out = ['| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |'];
  rows.forEach((r) => out.push('| ' + r.join(' | ') + ' |'));
  return out.join('\n') + '\n';
}

function toMarkdown(r, opts) {
  const strict = !!(opts && opts.strict);
  const result = overallResult(r, strict);
  const L = [];
  const h = (t) => L.push('\n## ' + t + '\n');

  L.push('# Email QA Report');
  L.push('');
  L.push('- **File:** `' + r.file + '`');
  L.push('- **Overall result:** **' + result + '**');

  h('1. HREF Audit');
  L.push(table(['#', 'Line', 'HREF', 'Alias', 'ALT', 'SRC', 'Status'],
    r.hrefRows.map((x, i) => [i + 1, x.line, cell(x.href), flag(x.alias), flag(x.alt),
      x.textLink ? '**' + esc(x.src) + '**' : cell(x.src), esc(statusText(x.issues))])));

  h('2. SRC Audit');
  L.push(table(['#', 'Line', 'SRC', 'HREF', 'Alias', 'ALT', 'Status'],
    r.srcRows.map((x, i) => [i + 1, x.line, flag(x.src),
      flag(x.href), flag(x.alias), flag(x.alt), esc(statusText(x.issues))])));

  h('3. HREF and SRC Validation');
  L.push('| Metric | Count |\n| --- | --- |');
  L.push('| Total HREF Count | ' + r.summary.totalHrefs + ' |');
  L.push('| Total SRC Count | ' + r.summary.totalSrcs + ' |');
  L.push('| Total Alias Count | ' + r.summary.totalAliases + ' |');
  const hrefList = (title, rows) => {
    L.push('\n### ' + title + ' (' + rows.length + ')\n');
    L.push(rows.length ? rows.map((x) => '- Line ' + x.line + ': ' + cell(x.href)).join('\n') : '_None_');
  };
  const srcList = (title, rows) => {
    L.push('\n### ' + title + ' (' + rows.length + ')\n');
    L.push(rows.length ? rows.map((x) => '- Line ' + x.line + ': ' + cell(x.src)).join('\n') : '_None_');
  };
  hrefList('HREFs without Alias', r.lists.hrefsWithoutAlias);
  hrefList('HREFs without ALT', r.lists.hrefsWithoutAlt);
  hrefList('HREFs without SRC', r.lists.hrefsWithoutSrc);
  srcList('SRCs without HREF', r.lists.srcsWithoutHref);
  srcList('SRCs without Alias', r.lists.srcsWithoutAlias);
  srcList('SRCs without ALT', r.lists.srcsWithoutAlt);

  h('4. Alias Validation');
  L.push(table(['Line', 'Alias', 'Status'], r.aliases.map((a) => {
    const dup = r.duplicateAliases.find((d) => d.alias.trim().toLowerCase() === a.alias.trim().toLowerCase());
    const st = [];
    if (/\s/.test(a.alias)) st.push('FAIL: contains spaces (use "' + a.alias.trim().replace(/\s+/g, '_') + '")');
    if (dup) st.push('FAIL: duplicate (' + dup.count + 'x, lines ' + dup.lines.join(', ') + ')');
    return [a.line, cell(a.alias), st.length ? esc(st.join('; ')) : 'OK'];
  })));
  L.push('\n**Missing aliases (' + r.missingAliasLinks.length + '):**\n');
  L.push(r.missingAliasLinks.length
    ? r.missingAliasLinks.map((x) => '- Line ' + x.line + ': ' + cell(x.href)).join('\n') : '_None_');
  L.push('\n**Duplicate aliases (' + r.duplicateAliases.length + '):** '
    + (r.duplicateAliases.length
      ? r.duplicateAliases.map((d) => '`' + d.alias + '` x' + d.count).join(', ') : '_None_'));
  L.push('\n**Aliases containing spaces (' + r.aliasesWithSpaces.length + '):** '
    + (r.aliasesWithSpaces.length ? r.aliasesWithSpaces.map((a) => '`' + a.alias + '`').join(', ') : '_None_'));

  h('5. ALT Validation');
  L.push(table(['Line', 'SRC', 'ALT', 'Status'], r.altList.map((a) => [
    a.line, cell(a.src), flag(a.alt), a.issues.length ? esc(a.issues.map((i) => i.msg).join('; ')) : 'OK'])));

  h('6. Tracking Code Validation');
  const trackingBad = r.tracking.some((t) => t.problems.some((p) => p.level === 'fail'));
  L.push(table(['Tracking Code', 'Found', 'Status', 'Details'], r.tracking.map((t) => [
    cell('<custom name="' + t.code + '" type="tracking"/>'), t.found,
    t.status === 'OK' ? 'OK' : '**' + t.status + '**',
    t.problems.length ? esc(t.problems.map((p) => p.msg).join('; ')).replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Before &lt;body&gt;'])));
  if (trackingBad) L.push('\n**Tracking Code Placement Issue Found**');
  if (r.bodyLine) L.push('\n_Opening `<body>` tag at line ' + r.bodyLine + '._');

  h('7. Content Block Validation');
  if (r.contentBlocks.length) {
    L.push(table(['Line', 'Content Block Type', 'Value'],
      r.contentBlocks.map((b) => [b.line, b.type, cell(b.value)])));
  } else {
    L.push('**No Content Block found in this email.**');
  }

  h('8. Unsubscribe Validation');
  if (r.unsubscribe.ok) {
    L.push('Unsubscribe implementation found: content block present and '
      + '`href="%%=RedirectTo(@urlOrganic)=%%"` with `alias="unsubscribe"`.');
  } else {
    L.push('**Unsubscribe check failed:** ' + r.unsubscribe.problems.join('; ') + '\n');
    L.push('```\n' + r.unsubscribe.message + '\n```');
  }

  h('9. HTTPS Validation');
  L.push(table(['Line', 'HREF', 'Type', 'Finding'], r.httpsFindings.map((f) => [
    f.line, cell(f.href), f.kind, esc(f.issues.map((i) => i.msg).join('; '))])));

  h('10. Final QA Summary');
  L.push('**Overall: ' + result + '**\n');
  L.push(table(['Check', 'Count', 'Result'], r.checks.map((c) => [c.name, c.value, c.result])));
  if (r.rowFailures) {
    L.push('\n_' + r.rowFailures + ' row(s) in the HREF/SRC inventories contain at least one FAIL finding._');
  }
  L.push('\nLegend: FAIL = breaks the audit, WARN = fails only with `--strict`, INFO = informational.');
  return L.join('\n') + '\n';
}

function toJson(r, opts) {
  return JSON.stringify(Object.assign({ result: overallResult(r, !!(opts && opts.strict)) }, r), null, 2);
}

module.exports = { toMarkdown, toJson };
