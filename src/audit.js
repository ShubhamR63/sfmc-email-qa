'use strict';

const {
  stripComments, maskAmpscriptBlocks, scanTags, attr, makeLineLookup,
} = require('./parser');

const MISSING = 'Missing';
const TEXT_LINK = 'Missing / Text Link';

const AMP_ATOM = /%%=[\s\S]*?=%%|%%[A-Za-z_]\w*%%/g;

const PLACEHOLDER_ALTS = [
  /^(image|img|photo|picture|pic|graphic|icon|logo|banner|spacer|alt|alt ?text|text|link|button|cta)$/i,
  /^(placeholder|untitled|undefined|null|none|n\/a|na|tbd|todo|xxx+|test|sample|dummy|default)$/i,
  /^(insert|enter|add|your)\b.*\b(alt|text|description)\b/i,
  /lorem ipsum/i,
  /\.(jpe?g|png|gif|webp|svg|bmp)$/i,
  /^(image|img|dsc|screenshot)[-_ ]?\d+/i,
];

const TRACKING_CODES = ['opencounter', 'usermatch'];
const UNSUB_REQUIRED_TEXT = [
  'Add Unsub block:',
  '%%=ContentBlockByKey("xxxxxxxxxx")=%%',
  'or',
  '%%=ContentBlockByID(xxxxxx)=%%',
  '',
  'href="%%=RedirectTo(@urlOrganic)=%%"',
  'alias="unsubscribe"',
].join('\n');

const issue = (level, msg) => ({ level, msg });

/* ------------------------------------------------------------------ */
/* URL classification                                                  */
/* ------------------------------------------------------------------ */

/**
 * Classify an href/src value.
 * kind: empty | ampscript | https | http | mailto | tel | sms | data | invalid
 */
function classifyUrl(raw) {
  const value = raw === undefined ? '' : raw.trim();
  if (value === '') return { kind: 'empty' };

  const hasAmp = /%%/.test(value);
  const rest = value.replace(AMP_ATOM, 'AMP');
  if (hasAmp && /%%/.test(rest)) {
    return { kind: 'invalid', reason: 'Unbalanced or malformed AMPscript expression' };
  }
  // A value that starts with an AMPscript expression is generated at send
  // time, so its scheme cannot be validated statically.
  if (/^%%/.test(value)) return { kind: 'ampscript' };

  if (/\s/.test(rest)) return { kind: 'invalid', reason: 'Contains whitespace' };
  if (/^https:\/\/[^/?#]+/i.test(rest)) return { kind: 'https' };
  if (/^http:\/\/[^/?#]+/i.test(rest)) return { kind: 'http' };
  if (/^mailto:\S+/i.test(rest)) return { kind: 'mailto' };
  if (/^tel:\S+/i.test(rest)) return { kind: 'tel' };
  if (/^sms:\S+/i.test(rest)) return { kind: 'sms' };
  if (/^data:/i.test(rest)) return { kind: 'data' };
  if (/^https?:\/\/?$/i.test(rest) || /^https?:\/\/[/?#]/i.test(rest)) {
    return { kind: 'invalid', reason: 'No host name' };
  }
  if (rest === '#') return { kind: 'invalid', reason: 'Placeholder "#" link' };
  if (/^javascript:/i.test(rest)) return { kind: 'invalid', reason: 'javascript: URL' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(rest)) {
    return { kind: 'invalid', reason: 'Unsupported scheme "' + rest.split(':')[0] + ':"' };
  }
  return { kind: 'invalid', reason: 'Not an absolute URL (relative or malformed)' };
}

function isHidden(tag) {
  const style = (attr(tag, 'style') || '').replace(/\s+/g, '').toLowerCase();
  return attr(tag, 'hidden') !== undefined
    || /display:none|visibility:hidden|font-size:0(px)?(;|$)|mso-hide:all/.test(style);
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

function extractLinksAndImages(tags, lineOf) {
  const hrefs = [];
  const srcs = [];
  let openAnchor = null;

  const addSrc = (tag, src, type) => {
    const entry = {
      type,
      src,
      srcPresent: src !== undefined,
      alt: type === 'img' ? attr(tag, 'alt') : undefined,
      line: lineOf(tag.start),
      anchor: openAnchor,
      hidden: isHidden(tag),
    };
    srcs.push(entry);
    if (openAnchor) openAnchor.images.push(entry);
  };

  for (const tag of tags) {
    if (tag.closing) {
      if (tag.name === 'a') openAnchor = null;
      continue;
    }

    if (tag.name === 'a' || tag.name === 'area') {
      const href = attr(tag, 'href');
      const alias = attr(tag, 'alias');
      const entry = {
        tag: tag.name,
        href,
        hrefPresent: href !== undefined,
        alias,
        line: lineOf(tag.start),
        hidden: isHidden(tag),
        images: [],
      };
      hrefs.push(entry);
      openAnchor = tag.name === 'a' ? entry : openAnchor;
    }

    if (tag.name === 'img') addSrc(tag, attr(tag, 'src'), 'img');
    else if (/^v:(fill|imagedata)$/.test(tag.name)) addSrc(tag, attr(tag, 'src'), tag.name);
    else if (tag.name === 'link' && /icon/i.test(attr(tag, 'rel') || '')) {
      addSrc(tag, attr(tag, 'href'), 'favicon');
    }

    const bg = attr(tag, 'background');
    if (bg !== undefined && tag.name !== 'img') addSrc(tag, bg, 'background');

    const style = attr(tag, 'style');
    if (style) {
      const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
      let m;
      while ((m = re.exec(style))) addSrc(tag, m[2], 'css-background');
    }
  }
  return { hrefs, srcs };
}

function extractContentBlocks(text, lineOf) {
  const re = /\bContentBlockBy(Key|ID|Name)\s*\(\s*("[^"]*"|'[^']*'|[^)\s,]+)/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(text))) {
    const kindRaw = m[1].toLowerCase();
    const kind = kindRaw === 'id' ? 'ContentBlockByID'
      : kindRaw === 'key' ? 'ContentBlockByKey' : 'ContentBlockByName';
    blocks.push({ type: kind, value: m[2].replace(/^["']|["']$/g, ''), line: lineOf(m.index) });
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Validations                                                         */
/* ------------------------------------------------------------------ */

function aliasState(alias) {
  if (alias === undefined) return { text: MISSING, missing: true };
  if (alias.trim() === '') return { text: 'Missing (empty alias)', missing: true };
  return { text: alias, missing: false };
}

function validateAlt(img) {
  const issues = [];
  if (img.type !== 'img') return { text: 'n/a', issues };
  const linked = !!img.anchor;
  if (img.alt === undefined) {
    issues.push(issue('fail', 'Missing ALT'));
    return { text: MISSING, issues, missing: true };
  }
  const trimmed = img.alt.trim();
  if (trimmed === '') {
    issues.push(issue(linked ? 'fail' : 'warn',
      linked ? 'Empty ALT on linked image' : 'Empty ALT (decorative image?)'));
    return { text: '(empty)', issues, empty: true };
  }
  if (PLACEHOLDER_ALTS.some((re) => re.test(trimmed))) {
    issues.push(issue('fail', 'Placeholder ALT text'));
    return { text: img.alt, issues, placeholder: true };
  }
  return { text: img.alt, issues };
}

function hrefUrlIssues(cls, raw) {
  switch (cls.kind) {
    case 'empty': return [issue('fail', raw === undefined ? 'Missing href attribute' : 'Empty href')];
    case 'http': return [issue('fail', 'Non-HTTPS link (http://)')];
    case 'invalid': return [issue('fail', 'Invalid href: ' + cls.reason)];
    default: return [];
  }
}

function srcUrlIssues(cls, entry) {
  const label = entry.type === 'favicon' ? 'href' : 'SRC';
  switch (cls.kind) {
    case 'empty': return [issue('fail', entry.srcPresent ? 'Empty ' + label : 'Missing ' + label)];
    case 'http': return [issue('warn', 'Non-HTTPS ' + label + ' (http://)')];
    case 'invalid': return [issue('fail', 'Invalid ' + label + ': ' + cls.reason)];
    default: return [];
  }
}

function validateTracking(tags, bodyTag) {
  const results = [];
  for (const code of TRACKING_CODES) {
    const found = tags.filter((t) => !t.closing && t.name === 'custom'
      && (attr(t, 'name') || '').toLowerCase() === code
      && (attr(t, 'type') || '').toLowerCase() === 'tracking');
    const problems = [];
    let status = 'OK';
    if (found.length === 0) {
      status = 'MISSING';
      problems.push(issue('fail', 'Tracking code "' + code + '" is missing'));
    } else {
      const afterBody = bodyTag ? found.filter((t) => t.start > bodyTag.start) : [];
      if (afterBody.length) {
        status = 'INCORRECT PLACEMENT';
        problems.push(issue('fail', 'Tracking code "' + code + '" is placed after the opening <body> tag'));
      }
      if (!bodyTag) {
        problems.push(issue('warn', 'No <body> tag found; placement of "' + code + '" cannot be verified'));
      }
      if (found.length > 1) {
        problems.push(issue('warn', 'Tracking code "' + code + '" appears ' + found.length + ' times'));
      }
    }
    results.push({ code, status, found: found.length, problems });
  }
  return results;
}

function validateUnsubscribe(hrefs, blocks) {
  const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
  const unsubLinks = hrefs.filter((h) =>
    norm(h.href) === '%%=redirectto(@urlorganic)=%%'
    && (h.alias || '').trim().toLowerCase() === 'unsubscribe');
  const hasBlock = blocks.length > 0;
  const hasLink = unsubLinks.length > 0;
  const problems = [];
  if (!hasBlock) problems.push('No ContentBlockByKey()/ContentBlockByID() found');
  if (!hasLink) {
    problems.push('No href="%%=RedirectTo(@urlOrganic)=%%" with alias="unsubscribe" found');
  }
  return { ok: hasBlock && hasLink, hasBlock, hasLink, problems, message: UNSUB_REQUIRED_TEXT };
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

function audit(source, fileName) {
  const original = source.replace(/^\uFEFF/, '');
  const noComments = stripComments(original);
  const masked = maskAmpscriptBlocks(noComments);
  const lineOf = makeLineLookup(original);
  const tags = scanTags(masked);
  const bodyTag = tags.find((t) => !t.closing && t.name === 'body') || null;

  const { hrefs, srcs } = extractLinksAndImages(tags, lineOf);
  const blocks = extractContentBlocks(noComments, lineOf);

  // ---- HREF rows
  const hrefRows = hrefs.map((h) => {
    const cls = classifyUrl(h.href);
    const al = aliasState(h.alias);
    const urlIssues = hrefUrlIssues(cls, h.href);
    const issues = [...urlIssues];
    if (h.href !== undefined && h.href !== h.href.trim()) {
      issues.push(issue('warn', 'href has leading/trailing whitespace'));
    }
    if (al.missing) issues.push(issue('fail', 'Missing Alias'));
    if (!al.missing && /\s/.test(h.alias)) issues.push(issue('fail', 'Alias contains spaces'));
    if (h.hidden) issues.push(issue('warn', 'Hidden link'));

    let srcText;
    let altText;
    if (h.images.length === 0) {
      srcText = TEXT_LINK;
      altText = MISSING;
      issues.push(issue('info', 'Text link (no SRC/ALT)'));
    } else {
      srcText = h.images.map((i) => (i.src === undefined || i.src.trim() === '' ? MISSING : i.src)).join(' | ');
      altText = h.images.map((i) => validateAlt(i).text).join(' | ');
      h.images.forEach((img) => {
        validateAlt(img).issues.forEach((x) => issues.push(x));
        srcUrlIssues(classifyUrl(img.src), img).forEach((x) => issues.push(x));
      });
    }
    return {
      href: h.href === undefined ? MISSING : (h.href === '' ? '(empty)' : h.href),
      alias: al.text,
      alt: altText,
      src: srcText,
      line: h.line,
      kind: cls.kind,
      urlIssues,
      textLink: h.images.length === 0,
      aliasMissing: al.missing,
      altMissing: h.images.length === 0 || h.images.some((i) => i.type === 'img' && validateAlt(i).missing),
      issues,
    };
  });

  // ---- SRC rows
  const srcRows = srcs.map((s) => {
    const alt = validateAlt(s);
    const issues = [...srcUrlIssues(classifyUrl(s.src), s), ...alt.issues];
    const a = s.anchor;
    const al = a ? aliasState(a.alias) : { text: MISSING, missing: true };
    const hrefMissing = !a;
    if (hrefMissing) issues.push(issue('warn', 'Missing HREF (image not linked)'));
    else {
      if (a.href === undefined || a.href.trim() === '') issues.push(issue('fail', 'Parent link has empty/missing href'));
      if (al.missing) issues.push(issue('fail', 'Missing Alias'));
    }
    if (s.hidden) issues.push(issue('warn', 'Hidden image'));
    if (s.type !== 'img') issues.push(issue('info', 'Source type: ' + s.type));
    return {
      src: s.src === undefined ? MISSING : (s.src === '' ? '(empty)' : s.src),
      href: a ? (a.href === undefined ? MISSING : a.href === '' ? '(empty)' : a.href) : MISSING,
      alias: al.text,
      alt: alt.text,
      line: s.line,
      type: s.type,
      hrefMissing,
      aliasMissing: al.missing,
      altMissing: !!alt.missing,
      issues,
    };
  });

  // ---- Alias validation
  const aliasList = hrefs.map((h) => ({ alias: h.alias, line: h.line, href: h.href }))
    .filter((x) => x.alias !== undefined && x.alias.trim() !== '');
  const byName = new Map();
  aliasList.forEach((x) => {
    const key = x.alias.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(x);
  });
  const duplicateAliases = [...byName.values()].filter((g) => g.length > 1)
    .map((g) => ({ alias: g[0].alias, count: g.length, lines: g.map((x) => x.line) }));
  const aliasesWithSpaces = aliasList.filter((x) => /\s/.test(x.alias));
  const missingAliasLinks = hrefRows.filter((r) => r.aliasMissing);

  // ---- ALT validation
  const altList = srcRows.filter((r) => r.type === 'img').map((r) => ({
    src: r.src, alt: r.alt, line: r.line, issues: r.issues.filter((i) => /ALT/.test(i.msg)),
  }));

  // ---- Tracking / unsub
  const tracking = validateTracking(tags, bodyTag);
  const trackingIssues = tracking.filter((t) => t.problems.some((p) => p.level === 'fail'));
  const unsubscribe = validateUnsubscribe(hrefs, blocks);

  // ---- HTTPS validation
  const httpsFindings = hrefRows
    .filter((r) => ['http', 'empty', 'invalid'].includes(r.kind))
    .map((r) => ({ href: r.href, line: r.line, kind: r.kind, issues: r.urlIssues }));

  // ---- Summary
  const count = (rows, fn) => rows.filter(fn).length;
  const summary = {
    totalHrefs: hrefRows.length,
    totalSrcs: srcRows.length,
    totalAliases: aliasList.length,
    duplicateAliases: duplicateAliases.length,
    aliasesWithSpaces: aliasesWithSpaces.length,
    missingAliases: missingAliasLinks.length,
    missingAlts: count(srcRows, (r) => r.type === 'img' && r.altMissing),
    emptyOrPlaceholderAlts: count(srcRows, (r) => r.issues.some((i) => i.level === 'fail' && /Empty ALT|Placeholder ALT/.test(i.msg))),
    decorativeEmptyAlts: count(srcRows, (r) => r.issues.some((i) => i.level === 'warn' && /Empty ALT/.test(i.msg))),
    missingHrefs: count(srcRows, (r) => r.hrefMissing),
    missingSrcs: count(hrefRows, (r) => r.textLink),
    imagesWithoutSrc: count(srcRows, (r) => r.src === MISSING || r.src === '(empty)'),
    nonHttpsLinks: count(hrefRows, (r) => ['http', 'empty', 'invalid'].includes(r.kind)),
    trackingIssues: trackingIssues.length,
    contentBlocks: blocks.length,
    contentBlockIssues: blocks.length === 0 ? 1 : 0,
    unsubscribeIssues: unsubscribe.ok ? 0 : 1,
  };

  // Each check: FAIL breaks the audit, WARN only fails with --strict, INFO never does.
  const checks = [
    ['Total HREFs', summary.totalHrefs, 'info'],
    ['Total SRCs', summary.totalSrcs, 'info'],
    ['Total Aliases', summary.totalAliases, 'info'],
    ['Duplicate Aliases', summary.duplicateAliases, 'fail'],
    ['Aliases With Spaces', summary.aliasesWithSpaces, 'fail'],
    ['Missing Aliases', summary.missingAliases, 'fail'],
    ['Missing ALTs', summary.missingAlts, 'fail'],
    ['Empty / Placeholder ALTs', summary.emptyOrPlaceholderAlts, 'fail'],
    ['Empty ALT on unlinked images (decorative)', summary.decorativeEmptyAlts, 'warn'],
    ['Missing HREFs (unlinked images)', summary.missingHrefs, 'warn'],
    ['Missing SRCs (text links)', summary.missingSrcs, 'info'],
    ['Images with missing/empty SRC', summary.imagesWithoutSrc, 'fail'],
    ['Non-HTTPS / Empty / Invalid Links', summary.nonHttpsLinks, 'fail'],
    ['Tracking Code Issues', summary.trackingIssues, 'fail'],
    ['Content Block Issues', summary.contentBlockIssues, 'fail'],
    ['Unsubscribe Issues', summary.unsubscribeIssues, 'fail'],
  ].map(([name, value, severity]) => {
    const isCount = severity !== 'info';
    return { name, value, severity, result: !isCount ? 'INFO' : value === 0 ? 'PASS' : severity === 'warn' ? 'WARN' : 'FAIL' };
  });

  // Row-level failures not covered above (e.g. broken SRC URLs, hidden links).
  const rowFailures = [...hrefRows, ...srcRows].filter((r) => r.issues.some((i) => i.level === 'fail')).length;

  return {
    file: fileName,
    bodyLine: bodyTag ? lineOf(bodyTag.start) : null,
    hrefRows, srcRows,
    aliases: aliasList, duplicateAliases, aliasesWithSpaces, missingAliasLinks,
    altList,
    tracking,
    contentBlocks: blocks,
    unsubscribe,
    httpsFindings,
    lists: {
      hrefsWithoutAlias: hrefRows.filter((r) => r.aliasMissing),
      hrefsWithoutAlt: hrefRows.filter((r) => r.altMissing),
      hrefsWithoutSrc: hrefRows.filter((r) => r.textLink),
      srcsWithoutHref: srcRows.filter((r) => r.hrefMissing),
      srcsWithoutAlias: srcRows.filter((r) => r.aliasMissing),
      srcsWithoutAlt: srcRows.filter((r) => r.altMissing),
    },
    summary,
    checks,
    rowFailures,
  };
}

function overallResult(report, strict) {
  const failed = report.checks.some((c) => c.result === 'FAIL' || (strict && c.result === 'WARN'));
  return failed || report.rowFailures > 0 ? 'FAIL' : 'PASS';
}

module.exports = { audit, overallResult, classifyUrl, UNSUB_REQUIRED_TEXT };
