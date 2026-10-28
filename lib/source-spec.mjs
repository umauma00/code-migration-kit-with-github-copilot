// SPDX-License-Identifier: Apache-2.0
// Source-as-spec: when the original cannot run and no specification exists,
// the source code is the only specification. This module scaffolds the
// source-only preparation mechanically and reports what is still missing for
// the single 00b–02 review. It never records a phase or an approval.
import fs from 'node:fs';
import path from 'node:path';
import { safePath, readJSON, writeJSON, atomicWrite, fileHash, filesUnder, reviewDependencyPath, sourceSpecRoot, specPlaceholder } from './core.mjs';
import { pluginRoot, kitScript, pythonCommand, shellWord } from './runtime.mjs';

// The specification is the source itself. A per-file contract memo cost one
// survey call per scope and then a review of the memo as well, so the plan
// lists the sources mechanically and reviewers read the cited lines directly.
export const sourcesFile = `${sourceSpecRoot}/sources.md`;
// Plans made before 0.10.0 name this memo; their TODO(spec) gate still applies.
export const contractsFile = `${sourceSpecRoot}/contracts.md`;
const planFile = 'migration/judge-plan.json';

function sourceIndex(config, sources) {
  return [`# Source specification index (${config.sourceLanguage} -> ${config.targetLanguage})`, '',
    'The source code is the only specification. These files are it; nothing here restates them.',
    'Reviewers read the cited source lines directly. Behavior the source does not show is unknown and is marked TODO(port) in the inventory.', '',
    ...sources.map(p => `- ${p}`), ''].join('\n');
}

export function legacyContractsSkeleton(config, sources) {
  return [`# Source-derived contracts (${config.sourceLanguage} -> ${config.targetLanguage})`, '',
    'The source code is the only specification. Every statement below cites source lines;',
    `expectations are inferred, never observed on the original runtime. Replace every ${specPlaceholder}.`, '',
    ...sources.flatMap(p => [`## ${p}`, '',
      `- Public interface: ${specPlaceholder}`,
      `- Inputs, outputs and errors: ${specPlaceholder}`,
      `- Edge cases and numeric/text semantics: ${specPlaceholder}`,
      `- Evidence (source lines): ${specPlaceholder}`, ''])].join('\n');
}

// Suggested deterministic parser per language. Python resolves imports
// relative to --root: a source root that is itself a package (has
// __init__.py) is imported by name, so parse from its parent; otherwise
// (src layout, flat scripts) parse from the source root itself.
function commonDirectory(directories) {
  const parts = directories[0].split('/');
  for (const dir of directories.slice(1)) {
    const next = dir.split('/');
    while (parts.some((part, i) => next[i] !== part)) parts.pop();
  }
  return parts.join('/') || '.';
}
const parser = (language, kit, roots, root) => {
  const l = String(language).toLowerCase();
  const src = commonDirectory(roots);
  const selection = base => roots.map(dir => ` --source-root ${shellWord(path.posix.relative(base, dir) || '.')}`).join('');
  if (/python/.test(l)) {
    const base = commonDirectory(roots.map(dir => fs.existsSync(safePath(root, `${dir}/__init__.py`)) ? path.posix.dirname(dir) : dir));
    return { cmd: `${pythonCommand()} ${kit('scripts/depmap_python.py')} --root ${shellWord(base)} --out migration/depmap${selection(base)}`, base };
  }
  if (/typescript|javascript|\bjs\b|\bts\b|node/.test(l)) return { cmd: `node ${kit('scripts/depmap_ts.mjs')} --root ${shellWord(src)} --out migration/depmap${selection(src)}`, base: src };
  // Checked before C: "C#" would otherwise match \bc\b.
  const legacy = [[/c#|csharp|c-sharp/, 'csharp'], [/vb\.?net|visual basic/, 'vbnet'], [/\bjava\b/, 'java'], [/\bphp\b/, 'php'], [/cobol/, 'cobol']]
    .find(([re]) => re.test(l));
  // VB6 and VBA (.frm/.bas/.cls) are not VB.NET: they need an adapter.
  if (legacy && legacy[1] === 'vbnet' && /vb\s*[1-6]\b|visual basic\s*[1-6]\b|for applications|\bvba\b/.test(l)) return null;
  if (legacy) return { cmd: `${pythonCommand()} ${kit(`scripts/depmap_${legacy[1]}.py`)} --root ${shellWord(src)} --out migration/depmap${selection(src)}`, base: src };
  if (/^c$|\bc\b|c\+\+|cpp/.test(l)) return { cmd: `${pythonCommand()} ${kit('scripts/depmap_c.py')} --root ${shellWord(src)} --out migration/depmap${selection(src)}`, base: src };
  return null;
};

// File extensions for the manifest command: the source side comes from the
// files the parser ordered (or the language's usual ones before it ran), the
// target side from the target language. Unknown languages keep a placeholder
// that make_manifest.py refuses, so a guess never writes wrong targets.
const sourceExtensions = [[/c#|csharp|c-sharp/, ['.cs']], [/vb\.?net|visual basic/, ['.vb']], [/\bjava\b/, ['.java']],
  [/\bphp\b/, ['.php', '.inc']], [/cobol/, ['.cbl', '.cob', '.cpy']], [/python/, ['.py']], [/typescript|\bts\b/, ['.ts', '.tsx']],
  [/javascript|\bjs\b|node/, ['.js', '.jsx', '.mjs', '.cjs']], [/c\+\+|cpp/, ['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh']], [/^c$|\bc language\b/, ['.c', '.h']]];
const targetExtensions = [[/typescript|\bts\b/, '.ts'], [/javascript|\bjs\b|node/, '.js'], [/kotlin/, '.kt'], [/\bjava\b/, '.java'],
  [/c#|csharp|c-sharp/, '.cs'], [/\bgo\b|golang/, '.go'], [/rust/, '.rs'], [/python/, '.py'], [/\bphp\b/, '.php'], [/swift/, '.swift'],
  [/dart/, '.dart'], [/ruby/, '.rb'], [/scala/, '.scala'], [/vb\.?net|visual basic/, '.vb']];
function extensionArgs(root, config, quoted) {
  const target = targetExtensions.find(([re]) => re.test(String(config.targetLanguage).toLowerCase()))?.[1];
  let found = [];
  try {
    found = fs.readFileSync(safePath(root, 'migration/depmap/order.txt'), 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'))
      .flatMap(l => l.split('\t')).map(p => path.posix.extname(p).toLowerCase()).filter(Boolean);
  } catch {}
  // The most common extension becomes the target's; any other keeps its own
  // in the name (a.inc -> a.inc.ts), so a.php and a.inc never collide.
  const counts = new Map();
  for (const ext of found) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  const source = found.length ? [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1))
    : sourceExtensions.find(([re]) => re.test(String(config.sourceLanguage).toLowerCase()))?.[1] ?? [];
  if (!target || !source.length) return ` --ext ${quoted('.SOURCE_EXT=.TARGET_EXT')}`;
  return source.map((ext, i) => ext === target ? '' : ` --ext ${quoted(`${ext}=${i ? ext : ''}${target}`)}`).join('');
}

export function sourceSpecPlan(root, config) {
  const sources = [...new Set(config.sourceRoots.flatMap(dir => filesUnder(root, dir)))].sort();
  if (!sources.length) throw new Error(`No source files under ${config.sourceRoots.join(', ')}; check sourceRoots in migration/config.json`);
  const plan = { schemaVersion: 1, verificationMode: 'source-only',
    method: 'Source-as-spec: the source code is the only specification; reviewers infer behavior from cited source lines, never from observing the original runtime',
    sources,
    scenarios: [{ path: sourcesFile, contract: 'The listed source files are the specification; reviewers infer behavior from cited source lines', expectationBasis: 'source-inferred' }],
    unverified: ['The original runtime was not executed; behavioral equivalence is unverified.',
      'No external specification exists; behavior that the source does not show is unknown and marked TODO(port).'] };
  return { sources, plan, index: sourceIndex(config, sources) };
}

// Switching the profile edits config.json, which invalidates earlier approvals
// by design, so a switch is a preview until --apply. Either way only files that
// do not exist yet are written.
export function initSourceSpec(root, config, { apply = false } = {}) {
  const { plan, index } = sourceSpecPlan(root, config);
  const changes = [];
  const configFile = safePath(root, 'migration/config.json');
  const switching = config.verificationMode !== 'source-only' || config.preparationProfile !== 'source-as-spec';
  const modeChange = config.verificationMode !== 'source-only';
  if (switching) changes.push({ path: 'migration/config.json', change: 'verificationMode: source-only, preparationProfile: source-as-spec' });
  // A plan drafted before 0.10.0 names contracts.md; do not add an unused index beside it.
  const existingPlan = (() => { try { return readJSON(safePath(root, planFile)); } catch { return null; } })();
  const needsIndex = !existingPlan || existingPlan.scenarios?.some(s => s.path === sourcesFile);
  for (const [rel, content] of [[planFile, `${JSON.stringify(plan, null, 2)}\n`], ...(needsIndex ? [[sourcesFile, `${index}\n`]] : [])]) {
    if (!fs.existsSync(safePath(root, rel))) changes.push({ path: rel, change: 'create draft', content });
  }
  // Without a profile switch the drafts are the kit's own scaffold (never an
  // overwrite), so there is nothing for the person to agree to: write them.
  const write = apply || !switching;
  if (write) {
    if (switching) {
      const value = readJSON(configFile);
      Object.assign(value, { verificationMode: 'source-only', preparationProfile: 'source-as-spec' });
      writeJSON(configFile, value);
      Object.assign(config, { verificationMode: 'source-only', preparationProfile: 'source-as-spec' });
    }
    for (const c of changes) if (c.content) atomicWrite(safePath(root, c.path), c.content);
  }
  return { applied: write, changes: changes.map(({ path: p, change }) => ({ path: p, change })),
    ...(switching ? { warning: !modeChange
      ? 'Changing the preparation profile edits config.json, which invalidates phase 02 onward and every approval; 00, 00b and 01 records stay valid.'
      : 'Changing the verification mode invalidates every phase record from 00 and every approval; those phases are reviewed again.' } : {}),
    readiness: write ? sourceSpecReadiness(root, config) : undefined,
    next: write ? 'Draft every missing item in readiness from the source (no per-file contract memo is needed), then show the whole specification package to the user and record phase complete 00b,01,02 only after their OK.'
      : 'Show these changes to the user; rerun with --apply after they agree.' };
}

// What the single specification review still needs. "template" means the
// installed template was never edited; "placeholder" means TODO(spec) remains.
export function sourceSpecReadiness(root, config) {
  const kit = rel => kitScript(root, rel);
  // Same files the 00b check reads: every scenario in the plan.
  let scenarios = new Set([sourcesFile]);
  try { scenarios = new Set(readJSON(safePath(root, planFile)).scenarios.map(s => s.path)); } catch {}
  const state = (rel, template) => {
    const file = safePath(root, rel);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) return 'missing';
    if (template && fileHash(file) === fileHash(path.join(pluginRoot, template))) return 'template';
    // Same rule as the phase 02 check: unreplaced placeholders mean undrafted rules.
    if (rel === 'migration/RULEBOOK.md' && /\[source language\]|\[target language\]/.test(fs.readFileSync(file, 'utf8'))) return 'template';
    if (scenarios.has(rel) && fs.readFileSync(file, 'utf8').includes(specPlaceholder)) return 'placeholder';
    return 'ready';
  };
  const items = [
    ['00', 'migration/feasibility.md'], ['00b', planFile], ...[...scenarios].map(p => ['00b', p]), ['00b', 'migration/judge-report.md'],
    ['01', 'migration/depmap/edges.tsv'], ['01', 'migration/depmap/order.txt'], ['01', 'migration/manifest.tsv'],
    ['01', reviewDependencyPath(config)], ['01', 'migration/depmap/report.md'],
    ['02', 'migration/RULEBOOK.md', 'templates/RULEBOOK.md'], ['02', 'migration/inventory.tsv', 'templates/inventory.tsv'], ['02', 'migration/gap-report.md']
  ].map(([phase, rel, template]) => ({ phase, path: rel, status: state(rel, template) }));
  const src = config.sourceRoots[0], command = parser(config.sourceLanguage, kit, config.sourceRoots, root);
  // Parser paths are relative to its --root: re-prefix them, and keep only the
  // source roots when the parser walked a wider directory.
  const base = command?.base ?? commonDirectory(config.sourceRoots);
  const quoted = value => { const word = shellWord(value); return word === value ? `'${word}'` : word; };
  const prefix = base === '.' ? '' : ` --prefix ${quoted(`${base}/`)}`;
  const include = base !== src || config.sourceRoots.length > 1 ? config.sourceRoots.map(r => ` --include ${quoted(`${r}/`)}`).join('') : '';
  const mappings = config.sourceRoots.map(r => {
    const target = config.sourceRoots.length === 1 ? config.outputRoots[0]
      : path.posix.join(config.outputRoots[0], base === '.' ? r : path.posix.relative(base, r));
    return ` --map-root ${quoted(`${r}=${target}`)}`;
  }).join('');
  return { ready: items.every(i => i.status === 'ready'), items,
    commands: { dependencyMap: command ? command.cmd : `No bundled parser for ${config.sourceLanguage}; write a deterministic adapter under migration/tools/ (docs/DEPENDENCY-MAPPERS.md)`,
      manifest: `${pythonCommand()} ${kit('scripts/make_manifest.py')} --order migration/depmap/order.txt --out migration/manifest.tsv${prefix}${include}${mappings}${extensionArgs(root, config, quoted)}`,
      reviewDependencies: `node ${kit('scripts/make_review_dependencies.mjs')} --source-roots ${shellWord(config.sourceRoots.join(','))} --depmap-root ${shellWord(base)} --edges migration/depmap/edges.tsv` } };
}
