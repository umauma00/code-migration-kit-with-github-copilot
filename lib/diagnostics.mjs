// SPDX-License-Identifier: Apache-2.0
// Deterministic build-output parsers. They turn one recorded build attempt into
// the file/module/code/message queue that diagnostic_queue.mjs consumes, so no
// agent re-derives the error list by judgment (upstream Step 4). Supported:
// Python (traceback, py_compile/compileall, mypy, pyright), Java (javac, Maven),
// JavaScript (node --check, runtime stacks, ESLint -f unix, tsc), shell
// (bash -n, ShellCheck tty/gcc), rustc/cargo and the generic FILE:LINE[:COL]: error form
// (gcc/clang, Go, Rust short form and others). Unparsed output is reported.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clean = text => String(text).replace(/\s+/g, ' ').trim();
const errorWords = /^(?:fatal error|error|Error|ERROR)$/;

// Each matcher returns {file, line, code, message, severity, format} or null.
const lineMatchers = [
  ['maven', /^\[(ERROR|WARNING)\]\s+(.+?):\[(\d+),\d+\]\s+(.*)$/, m => ({ file: m[2], line: m[3], severity: m[1] === 'ERROR' ? 'error' : 'warning', code: 'javac', message: m[4] })],
  ['tsc', /^(.+?)\((\d+),\d+\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/, m => ({ file: m[1], line: m[2], severity: m[3], code: m[4], message: m[5] })],
  ['pyright', /^\s*(.+?):(\d+):\d+\s+-\s+(error|warning):\s+(.*?)(?:\s+\((report\w+)\))?$/, m => ({ file: m[1], line: m[2], severity: m[3], code: m[5] ?? 'pyright', message: m[4] })],
  ['eslint', /^(.+?):(\d+):\d+:\s+(.*?)\s+\[(Error|Warning)\/([^\]]+)\]$/, m => ({ file: m[1], line: m[2], severity: m[4].toLowerCase(), code: m[5], message: m[3] })],
  ['gcc-style', /^(.+?):(\d+)(?::\d+)?:\s*(fatal error|error|Error|ERROR|warning|Warning)(?:\[([^\]]+)\])?:\s*(.*)$/, m => {
    const trailing = m[5].match(/\s+\[((?:SC\d+)|(?:-W[\w-]+)|(?:[a-z][\w-]*))\]$/);
    return { file: m[1], line: m[2], severity: errorWords.test(m[3]) ? 'error' : 'warning', code: m[4] ?? trailing?.[1] ?? 'error',
      message: trailing ? m[5].slice(0, trailing.index) : m[5] };
  }],
  // bash -n repeats the offending source line as "FILE: line N: `text'"; skip that echo.
  ['bash', /^(.+?):\s+line\s+(\d+):\s+(?!`)(.*)$/, m => ({ file: m[1], line: m[2], severity: 'error', code: 'bash', message: m[3] })],
  // Go and similar compilers print FILE:LINE:COL: message without a severity.
  ['file-line-col', /^(.+?\.[A-Za-z0-9]+):(\d+):(\d+):\s+(?!warning|note|info|hint)(.+)$/, m => ({ file: m[1], line: m[2], severity: 'error', code: 'error', message: m[4] })]
];

export function parseBuildOutput(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n'), found = [];
  let frame = null, nodeFile = null, shellcheck = null, rust = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Python: the last 'File "...", line N' frame before the exception line.
    const py = line.match(/^\s*File "(.+?)", line (\d+)/);
    if (py) { frame = { file: py[1], line: py[2] }; continue; }
    const pyError = line.match(/^(?:Sorry:\s+)?([A-Za-z_][\w.]*(?:Error|Exception))(?::\s*(.*))?$/);
    if (pyError && frame) { found.push({ ...frame, severity: 'error', code: pyError[1], message: pyError[2] || pyError[1], format: 'python' }); frame = null; continue; }
    // node --check: "FILE:LINE", source excerpt, caret, then "SyntaxError: ...".
    // An absolute Windows or POSIX path may contain spaces; a relative one may not.
    const nodeHead = line.match(/^((?:[A-Za-z]:[\\/]|\/)[^:]+?\.(?:mjs|cjs|js|jsx|ts|tsx)):(\d+)$/) ?? line.match(/^((?:file:\/\/|\.{0,2}[\\/]?)[^\s:]+\.(?:mjs|cjs|js|jsx|ts|tsx)):(\d+)$/);
    if (nodeHead) { nodeFile = { file: nodeHead[1], line: nodeHead[2] }; continue; }
    const jsError = line.match(/^(\w*Error)(?::\s*(.*))?$/);
    if (jsError && nodeFile) { found.push({ ...nodeFile, severity: 'error', code: jsError[1], message: jsError[2] || jsError[1], format: 'node' }); nodeFile = null; continue; }
    if (jsError && !frame) {
      // Runtime error: the first stack frame that names a file.
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
        // A parenthesized location may contain spaces (C:\\Users\\Taro Yamada\\...).
        const m = lines[j].match(/^\s+at\s+.*?\((.+):(\d+):\d+\)$/) ?? lines[j].match(/^\s+at\s+((?:file:\/\/)?[^\s()]+?):(\d+):\d+$/);
        const at = m && (!/\s/.test(m[1]) || /^(?:[A-Za-z]:[\\/]|\/|file:\/\/|\.)/.test(m[1])) ? m : null;
        if (at && !at[1].startsWith('node:')) { found.push({ file: at[1], line: at[2], severity: 'error', code: jsError[1], message: jsError[2] || jsError[1], format: 'node-stack' }); break; }
      }
      continue;
    }
    // rustc/cargo: "error[E0425]: message" then "  --> FILE:LINE:COL".
    const rustHead = line.match(/^(error|warning)(?:\[(E\d+)\])?:\s+(.*)$/);
    if (rustHead) { rust = { severity: rustHead[1], code: rustHead[2] ?? rustHead[1], message: rustHead[3] }; continue; }
    const rustAt = line.match(/^\s*-->\s+(.+?):(\d+):\d+$/);
    if (rustAt && rust) { found.push({ ...rust, file: rustAt[1], line: rustAt[2], format: 'rustc' }); rust = null; continue; }
    // ShellCheck tty: "In FILE line N:" then "^-- SC1234 (error): message".
    const scHead = line.match(/^In (.+) line (\d+):$/);
    if (scHead) { shellcheck = { file: scHead[1], line: scHead[2] }; continue; }
    const sc = line.match(/\^-*\^?\s+(SC\d+)\s+\((error|warning|info|style)\):\s+(.*)$/);
    if (sc && shellcheck) { found.push({ ...shellcheck, severity: sc[2] === 'error' ? 'error' : 'warning', code: sc[1], message: sc[3], format: 'shellcheck' }); continue; }
    for (const [format, pattern, build] of lineMatchers) {
      const m = line.match(pattern);
      if (!m) continue;
      const item = { ...build(m), format };
      // javac continuation lines ("symbol:", "location:") qualify the message.
      // They follow the echoed source line and caret, so look a few lines ahead.
      if (format === 'gcc-style') for (let j = i + 1; j < Math.min(lines.length, i + 7) && /^\s/.test(lines[j]); j++) {
        if (/^\s+(symbol|location|required|found|reason):/.test(lines[j])) item.message += `; ${clean(lines[j])}`;
      }
      found.push(item); break;
    }
  }
  return found;
}

function normalizeFile(root, file) {
  let value = file.trim();
  if (value.startsWith('file://')) { try { value = fileURLToPath(value); } catch { return null; } }
  if (path.isAbsolute(value)) {
    let real = value;
    try { real = fs.realpathSync(value); } catch {}
    const relative = path.relative(root, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    value = relative;
  }
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

// Map each diagnostic to exactly one manifest target: exact path first, then a
// unique suffix match for tools that print paths relative to a subdirectory.
export function diagnosticsForUnits(root, units, text) {
  const realRoot = fs.realpathSync(root), targets = units.map(u => u.target);
  const parsed = parseBuildOutput(text), mapped = [], unmapped = [], formats = {};
  for (const item of parsed) {
    const file = normalizeFile(realRoot, item.file);
    const target = file && (targets.includes(file) ? file : (() => {
      const hits = targets.filter(t => t.endsWith(`/${file}`));
      return hits.length === 1 ? hits[0] : null;
    })());
    formats[item.format] = (formats[item.format] ?? 0) + 1;
    if (!target) { unmapped.push(`${item.file}:${item.line}: ${clean(item.message)}`); continue; }
    mapped.push({ file: target, module: path.posix.dirname(target), code: clean(item.code) || 'error',
      message: clean(`line ${item.line}: ${item.message}`), severity: item.severity });
  }
  // A failing build is driven by its errors; warnings form the queue only when
  // the tool reported nothing stronger (for example, a lint that fails on them).
  const errors = mapped.filter(d => d.severity === 'error'), selected = errors.length ? errors : mapped;
  const rows = [...new Map(selected.map(d => [`${d.file}\t${d.code}\t${d.message}`, d])).values()];
  return { rows, unmapped, formats, parsed: parsed.length };
}

export function diagnosticTsv(rows) {
  return `file\tmodule\tcode\tmessage\n${rows.map(r => [r.file, r.module, r.code, r.message].map(v => v.replace(/\t/g, ' ')).join('\t')).join('\n')}\n`;
}
