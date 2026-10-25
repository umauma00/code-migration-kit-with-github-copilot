// SPDX-License-Identifier: Apache-2.0
// Every command the guides, prompts, skills, agents and scripts tell a person
// or an agent to run must parse against the spec of the script it names
// (lib/cli.mjs): known command and action, known options, values where an
// option needs one, no stray words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { kitRoot } from '../scripts/install.mjs';
import { usage } from '../scripts/run_migration.mjs';
import { humanGate } from '../lib/guardrails.mjs';
import { specs, parseCommandLine, allOptions, resolve } from '../lib/cli.mjs';

// Records of past runs and reviews quote commands as they were then.
const skipped = /^(?:tests|fixtures|node_modules|lib\/vendor|docs\/validation|docs\/reviews|docs\/plans|\.git)(?:\/|$)|^CHANGELOG\.md$|^lib\/cli\.mjs$/;
const textFile = /\.(?:md|mjs|js|py|sh|html|json|ya?ml|txt)$/;
const byScript = new Map(Object.values(specs).map(spec => [spec.script, spec]));
const scriptPattern = new RegExp(`(?:^|[\\s/\\\\"'\`(])(${[...byScript.keys()].map(s => s.replace('.', '\\.')).join('|')})(?=[\\s\`"'),;]|$)`, 'g');

export function kitFiles(dir = kitRoot, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (skipped.test(name)) continue;
    if (entry.isDirectory()) out.push(...kitFiles(path.join(dir, entry.name), name));
    else if (textFile.test(entry.name)) out.push(name);
  }
  return out;
}

// Code the reader is meant to type: fenced blocks and inline spans in
// Markdown, <pre>/<code> in HTML, string literals and comments in scripts.
// A block holds whole command lines; a span is prose quoting a command,
// which may leave out values ("`phase complete` records ...").
function codeRegions(name, text) {
  const spans = body => [...body.matchAll(/`([^`\n]+)`/g)].map(m => ({ text: m[1], span: true }));
  if (name.endsWith('.html')) {
    const decode = s => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return [...text.matchAll(/<(pre|code)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(m => ({ text: decode(m[2]), span: m[1] === 'code' }));
  }
  if (name.endsWith('.md')) {
    const regions = [];
    const withoutFences = text.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_, body) => { regions.push({ text: body, span: false }); return ''; });
    return [...regions, ...spans(withoutFences)];
  }
  // Scripts: the whole text, with JS/JSON escapes turned back into lines; the
  // messages they print quote commands in backticks.
  const body = text.replace(/\\n/g, '\n').replace(/\\(["`])/g, '$1');
  return [{ text: body, span: false }, ...spans(body).filter(r => !r.text.includes('${'))];
}

// Shell-like words of one command, up to where the command ends.
function words(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#' || c === '`' || c === ';' || c === ')' || c === '>' || line.startsWith('&&', i) || line.startsWith('||', i)) break;
    if (c === '|' ) break;
    let word = '';
    while (i < line.length && !/\s/.test(line[i])) {
      const q = line[i];
      if (q === '"' || q === "'") {
        const end = line.indexOf(q, i + 1);
        // An unmatched quote closes the string the command was written in.
        if (end < 0) { if (word) out.push(word); return out; }
        word += line.slice(i + 1, end) || 'TEXT'; i = end + 1;
      } else if (q === '`' || q === ';' || (q === ')' && !word.includes('('))) break;
      else word += line[i++];
    }
    out.push(word);
  }
  return out;
}

// Optional parts and alternatives: [--x V] -> --x V; (--a x | --b y) -> --a x.
const unbracket = text => text.replace(/\(([^()|]*?) \| [^()]*\)/g, '$1').replace(/\[([^\][]*)\]/g, '$1');
// Words that stand for a value the reader fills in: ID, TEXT, X (an
// interpolation), <what you reviewed>, ….
const standsForValue = w => /^(?:[A-Z][A-Z0-9_]*(?:[,.][A-Z0-9_.]+)*|X|<.*>|.*….*|.*\.\.\..*)$/.test(w) || /[A-Z]{2,}/.test(w);
const placeholder = w => /^(?:…|\.\.\.|\.{3,}|COMMAND|options)$/.test(w);

// The command lines written for each script, as word lists.
export function documentedCommands(name, text) {
  const found = [];
  for (const { text: body, span } of codeRegions(name, text)) {
    let region = body.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
    // R="node migration-kit/scripts/run_migration.mjs" ... $R survey run ...
    for (const [, variable, command] of region.matchAll(/^\s*([A-Z_]+)=["']?(node [^"'\s]+)/gm)) region = region.replace(new RegExp(`\\$\\{?${variable}\\}?(?=\\s)`, 'g'), command);
    // A span that starts with a runner command quotes it without the script path.
    const first = region.trim().split(/\s+/)[0];
    if (span && specs.run_migration.commands[first] && /\s/.test(region.trim()) && !/\$\{/.test(region)) {
      const argv = words(unbracket(region.split(' | ')[0])).filter(w => !placeholder(w));
      found.push({ spec: specs.run_migration, argv, line: region.trim(), span: true });
      continue;
    }
    for (const line of region.split(/\r?\n/)) {
      for (const m of line.matchAll(scriptPattern)) {
        const spec = byScript.get(m[1]);
        // In scripts, only a command line (node/python/bash ... SCRIPT) or a quoted
        // `SCRIPT ...` is an instruction; an import or a comment naming the file is not.
        const before = line.slice(0, m.index + m[0].length - m[1].length);
        // Generated commands count too: `${pythonCommand()} ${k}/scripts/...`, `${kit('scripts/...')}`.
        if (!/\.(?:md|html)$/.test(name) && !/(?:(?:\b(?:node|python3?|py|bash|sh)|\$\{[^}]*\})\s+["']?[^\s"']*|`[^`\s]*|kit\(['"][^'"]*)$/.test(before)) continue;
        // Interpolated values stand for one word each.
        let rest = line.slice(m.index + m[0].length).replace(/^['"]?\)?\}?/, '').replace(/\$\{[^}]*\}/g, 'X');
        rest = unbracket(rest);
        const argv = words(rest).filter(w => !placeholder(w));
        if (!argv.length) continue;
        // A comment or prose that only names the script ("run_migration.mjs and ...").
        if (spec.commands && !argv[0].startsWith('-') && !/^[a-z][a-z-]*(?:\|[a-z][a-z-]*)*$/.test(argv[0])) continue;
        found.push({ spec, argv, line: line.trim(), span: span || (argv.length === 1 && !argv[0].startsWith('-')) });
      }
    }
  }
  return found;
}

// Every alternative of `a|b` in a command or action position is its own command.
function expand(spec, argv) {
  const at = [0, 1].filter(i => argv[i] && !argv[i].startsWith('-') && argv[i].includes('|') && spec.commands);
  let lines = [argv];
  for (const i of at) lines = lines.flatMap(l => l[i].split('|').map(alt => l.map((w, j) => j === i ? alt : w)));
  return lines;
}

// Prose quoting a command (`phase complete`, `repair --queue`) has to name a
// real command, action and options; a command line must parse in full.
function checkNames(spec, argv) {
  const kinds = allOptions(spec), positional = [], options = [], given = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    options.push(key);
    if (kinds[key] !== null && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) given[key] = argv[++i];
  }
  let target = { name: spec.script, options: allOptions(spec) };
  if (spec.commands && positional.length) {
    const entry = spec.commands[positional[0]];
    if (!entry) throw new Error(`Unknown command ${positional[0]}`);
    if (entry.sub && positional[1] === undefined) {
      if (options.length) throw new Error(`Missing action for ${positional[0]}. Use ${positional[0]} ${Object.keys(entry.sub).join(' | ')}`);
      return;
    }
    target = resolve(spec, positional);
  }
  for (const key of options) if (!(key in target.options) && key !== 'help') throw new Error(`Option --${key} does not apply to ${target.name}`);
  // Values that are written out must be valid ones.
  const written = [...positional.slice(target.used ?? 0, (target.used ?? 0) + (target.args?.length ?? 0))];
  const line = [...positional.slice(0, (target.used ?? 0) + written.length), ...Object.entries(given).flatMap(([k, v]) => ['--' + k, v])];
  for (let i = written.length; i < (target.args?.length ?? 0); i++) line.splice(target.used + i, 0, 'ID');
  for (const key of options) if (kinds[key] !== null && !(key in given)) line.push('--' + key, 'VALUE');
  for (const key of options) if (kinds[key] === null) line.push('--' + key);
  parseCommandLine(line, spec, { placeholder: standsForValue });
}

export function checkCommand(spec, argv, span = false) {
  for (const line of expand(spec, argv)) {
    if (span) checkNames(spec, line); else parseCommandLine(line, spec, { placeholder: standsForValue });
  }
}

// Places that name a command on purpose to say it does not exist.
const intended = [['docs/PHASE-HANDOFF.md', 'post-parity'], ['docs/PHASE-HANDOFF.md', 'approve judge']];

test('every documented command parses against its script spec', () => {
  const problems = [];
  let checked = 0;
  for (const name of kitFiles()) {
    const text = fs.readFileSync(path.join(kitRoot, name), 'utf8');
    for (const { spec, argv, line, span } of documentedCommands(name, text)) {
      checked++;
      if (intended.some(([file, words]) => file === name && argv.join(' ') === words)) continue;
      try { checkCommand(spec, argv, span); } catch (e) { problems.push(`${name}: ${line}\n    -> ${e.message}`); }
    }
  }
  assert.ok(checked > 150, `expected to find the documented commands, found ${checked}`);
  assert.deepEqual(problems, []);
});

test('every line of the runner usage parses against the runner spec', () => {
  const lines = usage.split('\n').filter(l => /^  [a-z]/.test(l)).map(l => l.trim().split(/\s{2,}/)[0]);
  assert.ok(lines.length > 20);
  for (const line of lines) {
    // "build | smoke | parity | handoff" lists commands; "sessions status | prune" lists actions.
    const parts = line.split(' | ').map(part => words(unbracket(part)));
    const alternatives = parts.map((part, i) => i && !specs.run_migration.commands[part[0]] ? [parts[0][0], ...part] : part);
    for (const alt of alternatives) assert.doesNotThrow(() => checkCommand(specs.run_migration, alt.filter(w => !placeholder(w))), line);
  }
});

test('no option is a flag in one command and takes a value in another', () => {
  for (const spec of Object.values(specs)) {
    const kinds = new Map();
    const visit = options => { for (const [k, v] of Object.entries(options ?? {})) { const kind = v === null ? 'flag' : 'value'; assert.equal(kinds.get(k) ?? kind, kind, `${spec.script} --${k}`); kinds.set(k, kind); } };
    visit(spec.global); visit(spec.options);
    const walk = node => { visit(node.options); for (const c of Object.values(node.sub ?? {})) walk(c); };
    for (const c of Object.values(spec.commands ?? {})) walk(c);
  }
});

test('the runner rejects unknown options, stray words and missing actions with the accepted options', () => {
  const runner = specs.run_migration;
  assert.throws(() => parseCommandLine(['status', '--formt', 'json'], runner), /Unknown option --formt\. Options for status: --root PATH, --copilot PATH, --format/);
  assert.throws(() => parseCommandLine(['phase', 'start'], runner), /phase start needs ID/);
  assert.throws(() => parseCommandLine(['phase', 'start', '03', '04'], runner), /Unexpected 04/);
  assert.throws(() => parseCommandLine(['models'], runner), /Missing action for models\. Use models list \| set/);
  assert.throws(() => parseCommandLine(['translate', '--note', 'x'], runner), /--note does not apply to translate/);
  assert.throws(() => parseCommandLine(['approve', 'build', '--note=ok'], runner), /as two words/);
  assert.throws(() => parseCommandLine(['approve', 'build', '--note'], runner), /Missing value for --note \(expected --note TEXT\)/);
  assert.deepEqual(parseCommandLine(['phase', 'complete', '01', '--confirm-no-dependencies', '--note', 'ok'], runner),
    { _: ['phase', 'complete', '01'], 'confirm-no-dependencies': true, note: 'ok' });
  assert.equal(parseCommandLine(['phase', '--help'], runner).help, true);
});

test('a help request is never a human gate, and a value option still takes -h as its value', () => {
  const r = 'node migration-kit/scripts/run_migration.mjs';
  for (const command of [`${r} models set --help`, `${r} phase complete -h`, `${r} build-loop --help`, `${r} approve translation --note x --help`])
    assert.equal(humanGate(command), null, command);
  // Only the help segment is exempt; the next command of the line is still a gate.
  assert.equal(humanGate(`${r} models set --help && ${r} models set --role all --model m`), 'models set');
  assert.equal(humanGate(`${r} phase complete 03 --note -h`), 'phase complete 03');
  // A help flag the runner never receives keeps the gate: a comment, a
  // redirection target, a substitution or a line continuation.
  for (const command of [`${r} phase complete 00 --note "Reviewed fixture scope" # --help`, `${r} phase complete 00 --note "Reviewed fixture scope" > --help`,
    `${r} phase complete 00 --note "Reviewed" 2> --help`, `${r} phase complete 00 --note "Reviewed" < --help`, `${r} phase complete 00 --note "$(echo ok)" --help`,
    `${r} phase complete 00 --note ok \\\n # --help`])
    assert.equal(humanGate(command), 'phase complete 00', command);
  assert.equal(humanGate(`${r} models set --role all --model m # -h`), 'models set');
  assert.equal(humanGate(`${r} build-loop --note ok > -h`), 'build-loop');
  assert.deepEqual(parseCommandLine(['phase', 'complete', '03', '--note', '-h'], specs.run_migration), { _: ['phase', 'complete', '03'], note: '-h' });
});

test('a phase list may have spaces after its commas, as phase complete reads it', () => {
  assert.deepEqual(parseCommandLine(['phase', 'complete', '00, 00b', '--note', 'ok'], specs.run_migration)._, ['phase', 'complete', '00, 00b']);
  assert.doesNotThrow(() => parseCommandLine(['phase', 'complete', '00,00b,01', '--note', 'ok'], specs.run_migration));
  assert.throws(() => parseCommandLine(['phase', 'complete', '00, 0x', '--note', 'ok'], specs.run_migration), /must be one of .*not 0x/);
});

test('every option a bundled Python mapper accepts is in its spec', async () => {
  const { spawnSync } = await import('node:child_process');
  const { python } = await import('./helpers.mjs');
  for (const [name, spec] of Object.entries(specs).filter(([n]) => /^depmap_/.test(n) && specs[n].script.endsWith('.py'))) {
    const r = spawnSync(python, ['-I', path.join(kitRoot, 'scripts', spec.script), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${spec.script} --help: ${r.stderr}`);
    const accepted = [...new Set(r.stdout.match(/--[a-z][a-z-]*/g))].filter(o => o !== '--help').map(o => o.slice(2)).sort();
    assert.deepEqual(Object.keys(spec.options).sort(), accepted, name);
  }
});
