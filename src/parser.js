'use strict';

/**
 * Minimal, dependency-free HTML scanner tuned for SFMC emails.
 *
 * Why not a generic HTML parser? SFMC templates contain AMPscript such as
 *   href="%%=RedirectTo(concat("https://", @host))=%%"
 * whose nested quotes break normal HTML parsers. This scanner treats
 * AMPscript expressions as atomic inside attribute values.
 *
 * All transformations keep the string length identical so that positions
 * (and therefore line numbers) always map back to the original source.
 */

const blank = (s) => s.replace(/[^\r\n]/g, ' ');

/** Blank out HTML comments but keep the content of Outlook conditional comments. */
function stripComments(html) {
  return html
    .replace(/<!--\s*\[if[^\]]*\]>(?:<!-->)?/gi, blank)
    .replace(/(?:<!--)?<!\[endif\]-->/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/** Blank out AMPscript blocks (%%[ ... ]%%) so their contents are not parsed as HTML. */
function maskAmpscriptBlocks(text) {
  return text.replace(/%%\[[\s\S]*?\]%%/g, blank);
}

/** Return the index just after the AMPscript atom that starts at position i. */
function skipAtom(s, i) {
  if (s.startsWith('%%=', i)) {
    const end = s.indexOf('=%%', i + 3);
    return end < 0 ? s.length : end + 3;
  }
  if (s.startsWith('%%[', i)) {
    const end = s.indexOf(']%%', i + 3);
    return end < 0 ? s.length : end + 3;
  }
  const end = s.indexOf('%%', i + 2);
  return end < 0 ? i + 2 : end + 2;
}

function parseTag(s, start) {
  let i = start + 1;
  const closing = s[i] === '/';
  if (closing) i++;
  let j = i;
  while (j < s.length && /[A-Za-z0-9:_-]/.test(s[j])) j++;
  const name = s.slice(i, j).toLowerCase();
  i = j;

  const attrs = [];
  let selfClosing = false;

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '>') { i++; break; }
    if (s[i] === '/' && s[i + 1] === '>') { selfClosing = true; i += 2; break; }
    if (s[i] === '/') { i++; continue; }

    const nameStart = i;
    if (s.startsWith('%%', i)) {
      i = skipAtom(s, i);
      attrs.push({ name: s.slice(nameStart, i), value: '' });
      continue;
    }
    while (i < s.length && !/[\s=>]/.test(s[i]) && !(s[i] === '/' && s[i + 1] === '>')) i++;
    const attrName = s.slice(nameStart, i);

    let k = i;
    while (k < s.length && /\s/.test(s[k])) k++;
    if (s[k] !== '=') {
      attrs.push({ name: attrName, value: '' });
      continue;
    }
    i = k + 1;
    while (i < s.length && /\s/.test(s[i])) i++;

    let value;
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i++];
      const valueStart = i;
      while (i < s.length && s[i] !== quote) {
        i = s.startsWith('%%', i) ? skipAtom(s, i) : i + 1;
      }
      value = s.slice(valueStart, i);
      i++; // closing quote
    } else {
      const valueStart = i;
      while (i < s.length && !/[\s>]/.test(s[i])) {
        i = s.startsWith('%%', i) ? skipAtom(s, i) : i + 1;
      }
      value = s.slice(valueStart, i);
    }
    attrs.push({ name: attrName, value });
  }

  return { name, closing, attrs, selfClosing, start, end: i };
}

/** Return every start/end tag in document order. Script/style bodies are skipped. */
function scanTags(s) {
  const tags = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('%%=', i)) { i = skipAtom(s, i); continue; }
    if (s[i] !== '<') { i++; continue; }
    if (!/^<\/?[A-Za-z]/.test(s.substr(i, 3))) { i++; continue; }

    const tag = parseTag(s, i);
    tags.push(tag);
    i = tag.end;

    if (!tag.closing && (tag.name === 'script' || tag.name === 'style')) {
      const closer = new RegExp('</' + tag.name, 'ig');
      closer.lastIndex = i;
      const m = closer.exec(s);
      i = m ? m.index : s.length;
    }
  }
  return tags;
}

/** Case-insensitive attribute lookup. Returns undefined when the attribute is absent. */
function attr(tag, name) {
  const a = tag.attrs.find((x) => x.name.toLowerCase() === name);
  return a ? a.value : undefined;
}

/** Returns a function mapping a character offset to a 1-based line number. */
function makeLineLookup(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

module.exports = { stripComments, maskAmpscriptBlocks, scanTags, attr, makeLineLookup };
