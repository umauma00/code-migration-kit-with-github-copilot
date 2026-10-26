// SPDX-License-Identifier: Apache-2.0
// Lexical filtering for the stdlib-only JS/TS mapper. Contents of comments,
// strings, regexes and template text are data; template expressions are code.
// This is not a TypeScript type checker or a tsconfig alias resolver.
function nonCode(text, jsxEnabled) {
  const ranges = [], comments = [], holes = [], parens = [];
  let i = 0, previous = '', template = false, segment = 0, jsx = null;
  const regexAfter = new Set(['', '=', '(', '[', '{', ',', ':', ';', '!', '?', '+', '-', '*', '/', '%', '~', '&', '|', '^', '<', '>', '=>', '&&', '||', '??', 'return', 'throw', 'case', 'yield', 'else', 'do', 'control-close']);
  const controls = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
  const tagAt = at => text.slice(at).match(/^<([A-Za-z_$][\w$.:-]*)(?=[\s/>])|^<(?=>)/);
  const beginJSX = at => {
    const tag = tagAt(at);
    if (!tag) return false;
    const name = tag[1] ?? '';
    // A TS type assertion or generic parameter also starts with <Name>.
    // Require a closing tag or a self-closing opener before entering JSX.
    const close = name ? new RegExp(`</${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`) : /<\/>/;
    if (!/^<[^<>]*\/\s*>/.test(text.slice(at)) && !close.test(text.slice(at + tag[0].length))) return false;
    jsx = { tags: [name], mode: 'tag' }; segment = at;
    i = at + tag[0].length;
    return true;
  };
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (jsx) {
      if (ch === '{') {
        ranges.push([segment, i + 1]); holes.push({ depth: 1, jsx }); jsx = null; i++; previous = ''; continue;
      }
      if (jsx.mode === 'tag') {
        if (ch === '"' || ch === "'") { const end = text.indexOf(ch, i + 1); i = end < 0 ? text.length : end + 1; continue; }
        if (ch === '>') {
          if (text[i - 1] === '/') jsx.tags.pop();
          i++;
          if (!jsx.tags.length) { ranges.push([segment, i]); jsx = null; previous = 'literal'; }
          else jsx.mode = 'text';
          continue;
        }
      } else if (ch === '<') {
        const close = text.slice(i).match(/^<\/([A-Za-z_$][\w$.:-]*)?\s*>/);
        if (close && (close[1] ?? '') === jsx.tags.at(-1)) {
          jsx.tags.pop(); i += close[0].length;
          if (!jsx.tags.length) { ranges.push([segment, i]); jsx = null; previous = 'literal'; }
          continue;
        }
        const tag = tagAt(i);
        if (tag) { jsx.tags.push(tag[1] ?? ''); jsx.mode = 'tag'; i += tag[0].length; continue; }
      }
      i++; continue;
    }
    if (template) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { ranges.push([segment, ++i]); template = false; previous = 'literal'; continue; }
      if (ch === '$' && next === '{') { ranges.push([segment, i + 2]); i += 2; holes.push({ depth: 1 }); template = false; previous = ''; continue; }
      i++; continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && (next === '/' || next === '*')) {
      const start = i;
      if (next === '/') { i = text.indexOf('\n', i + 2); if (i < 0) i = text.length; }
      else { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; }
      ranges.push([start, i]); comments.push([start, i]); continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i++, quote = ch;
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i++] === quote) break; }
      ranges.push([start, i]); previous = 'literal'; continue;
    }
    if (ch === '`') { segment = i++; template = true; continue; }
    if (jsxEnabled && ch === '<' && regexAfter.has(previous) && beginJSX(i)) continue;
    if (ch === '/' && regexAfter.has(previous)) {
      let end = i + 1, characterClass = false, closed = false;
      for (; end < text.length && !/[\r\n]/.test(text[end]); end++) {
        if (text[end] === '\\') { end++; continue; }
        if (text[end] === '[') characterClass = true;
        else if (text[end] === ']') characterClass = false;
        else if (text[end] === '/' && !characterClass) { end++; closed = true; break; }
      }
      if (closed) { while (/[a-z]/i.test(text[end] ?? '') && end < text.length) end++; ranges.push([i, end]); i = end; previous = 'literal'; continue; }
    }
    if (/[\w$]/.test(ch)) { const start = i++; while (i < text.length && /[\w$]/.test(text[i])) i++; previous = text.slice(start, i); continue; }
    if (ch === '(') parens.push(controls.has(previous));
    if (ch === ')') { previous = parens.pop() ? 'control-close' : ')'; i++; continue; }
    if (holes.length) {
      if (ch === '{') holes.at(-1).depth++;
      else if (ch === '}' && --holes.at(-1).depth === 0) {
        const hole = holes.pop(); segment = i++; jsx = hole.jsx ?? null; template = !jsx; continue;
      }
    }
    const pair = text.slice(i, i + 2);
    if (['=>', '&&', '||', '??', '++', '--'].includes(pair)) { previous = pair; i += 2; }
    else { previous = ch; i++; }
  }
  if (template || jsx) ranges.push([segment, text.length]);
  const hidden = at => {
    let low = 0, high = ranges.length;
    while (low < high) { const mid = (low + high) >> 1; if (ranges[mid][0] <= at) low = mid + 1; else high = mid; }
    return low > 0 && at < ranges[low - 1][1];
  };
  return { hidden, comments };
}

function decodeSpecifier(value) {
  try {
    return value.replace(/\\(?:\r\n|[\r\n]|u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|[\s\S])/gi, escape => {
      const body = escape.slice(1);
      if (/^[\r\n]/.test(body)) return '';
      if (/^u\{/.test(body)) return String.fromCodePoint(parseInt(body.slice(2, -1), 16));
      if (/^u[0-9a-f]{4}$/i.test(body)) return String.fromCharCode(parseInt(body.slice(1), 16));
      if (/^x[0-9a-f]{2}$/i.test(body)) return String.fromCharCode(parseInt(body.slice(1), 16));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[body] ?? body;
    });
  } catch { return null; }
}

/** @returns {string[]} Statically written import/export/require specifiers; issues receives unresolved calls. */
export function moduleSpecifiers(text, issues = [], { jsx = true } = {}) {
  const { hidden, comments } = nonCode(text, jsx), found = [], chunks = [];
  let cursor = 0;
  for (const [start, end] of comments) {
    chunks.push(text.slice(cursor, start), text.slice(start, end).replace(/[^\r\n]/g, ' ')); cursor = end;
  }
  chunks.push(text.slice(cursor));
  const code = chunks.join('');
  const literalCalls = new Set();
  const isReference = at => {
    if (hidden(at) || /[\w$]/.test(text[at - 1] ?? '')) return false;
    let before = at - 1;
    while (before >= 0 && /\s/.test(text[before])) before--;
    return text[before] !== '.';
  };
  const pattern = /\b(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s*)(["'])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
  for (const match of code.matchAll(pattern)) {
    if (!isReference(match.index)) continue;
    const call = /^(?:import|require)\s*\(/.test(match[0]);
    // A string prefix of a computed expression is not a literal import.
    // Treating './' + name as './' can invent an edge to index.js.
    if (call && !/^[\s]*[),]/.test(code.slice(match.index + match[0].length))) continue;
    const value = decodeSpecifier(match[2]);
    if (value !== null) { found.push(value); if (call) literalCalls.add(match.index); }
  }
  for (const match of code.matchAll(/\b(?:import|require)\s*\(/g)) {
    if (!isReference(match.index) || literalCalls.has(match.index)) continue;
    issues.push({ reference: text.slice(match.index, Math.min(text.length, match.index + 160)).split(/[\r\n]/)[0], reason: 'computed or unsupported module specifier; use an audited adapter' });
  }
  return found;
}
