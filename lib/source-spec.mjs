// SPDX-License-Identifier: Apache-2.0
// Source-as-spec: when the original cannot run and no specification exists,
// the source code is the only specification. This module scaffolds the
// source-only preparation mechanically and reports what is still missing for
// the single 00b–02 review. It never records a phase or an approval.
import fs from 'node:fs';
import path from 'node:path';
import { safePath, readJSON, writeJSON, atomicWrite, fileHash, filesUnder, reviewDependencyPath, sourceSpecRoot, specPlaceholder } from './core.mjs';
import { pluginRoot, kitScript, pythonCommand } from './runtime.mjs';

export const contractsFile = `${sourceSpecRoot}/contracts.md`;
const planFile = 'migration/judge-plan.json';

function draftContracts(config, sources) {
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
const parser = (language, kit, src, root) => {
  const l = String(language).toLowerCase();
  if (/python/.test(l)) {
    const base = fs.existsSync(safePath(root, `${src}/__init__.py`)) ? path.posix.dirname(src) : src;
    return { cmd: `${pythonCommand()} ${kit('scripts/depmap_python.py')} --root ${base} --out migration/depmap`, base };
  }
  if (/typescript|javascript|\bjs\b|\bts\b|node/.test(l)) return { cmd: `node ${kit('scripts/depmap_ts.mjs')} --root ${src} --out migration/depmap`, base: src };
  // Checked before C: "C#" would otherwise match \bc\b.
  const legacy = [[/c#|csharp|c-sharp/, 'csharp'], [/vb\.?net|visual basic/, 'vbnet'], [/\bjava\b/, 'java'], [/\bphp\b/, 'php'], [/cobol/, 'cobol']]
    .find(([re]) => re.test(l));
  // VB6 and VBA (.frm/.bas/.cls) are not VB.NET: they need an adapter.
  if (legacy && legacy[1] === 'vbnet' && /vb\s*[1-6]\b|visual basic\s*[1-6]\b|for applications|\bvba\b/.test(l)) return null;
  if (legacy) return { cmd: `${pythonCommand()} ${kit(`scripts/depmap_${legacy[1]}.py`)} --root ${src} --out migration/depmap`, base: src };
  if (/^c$|\bc\b|c\+\+|cpp/.test(l)) return { cmd: `${pythonCommand()} ${kit('scripts/depmap_c.py')} --root ${src} --out migration/depmap`, base: src };
  return null;
};

export function sourceSpecPlan(root, config) {
  const sources = [...new Set(config.sourceRoots.flatMap(dir => filesUnder(root, dir)))].sort();
  if (!sources.length) throw new Error(`No source files under ${config.sourceRoots.join(', ')}; check sourceRoots in migration/config.json`);
  const plan = { schemaVersion: 1, verificationMode: 'source-only',
    method: 'Source-as-spec: the source code is the only specification; public contracts and expectations are inferred from cited source lines, never observed on the original runtime',
    sources,
    scenarios: [{ path: contractsFile, contract: 'Per-file public interface, inputs/outputs/errors and edge cases inferred from the source', expectationBasis: 'source-inferred' }],
    unverified: ['The original runtime was not executed; behavioral equivalence is unverified.',
      'No external specification exists; behavior that the source does not show is unknown and marked TODO(port).'] };
  return { sources, plan, contracts: draftContracts(config, sources) };
}

// Preview by default; apply writes only files that do not exist yet. Switching
// the profile edits config.json, which invalidates earlier approvals by design.
export function initSourceSpec(root, config, { apply = false } = {}) {
  const { plan, contracts } = sourceSpecPlan(root, config);
  const changes = [];
  const configFile = safePath(root, 'migration/config.json');
  const switching = config.verificationMode !== 'source-only' || config.preparationProfile !== 'source-as-spec';
  const modeChange = config.verificationMode !== 'source-only';
  if (switching) changes.push({ path: 'migration/config.json', change: 'verificationMode: source-only, preparationProfile: source-as-spec' });
  for (const [rel, content] of [[planFile, `${JSON.stringify(plan, null, 2)}\n`], [contractsFile, `${contracts}\n`]]) {
    if (!fs.existsSync(safePath(root, rel))) changes.push({ path: rel, change: 'create draft', content });
  }
  if (apply) {
    if (switching) {
      const value = readJSON(configFile);
      Object.assign(value, { verificationMode: 'source-only', preparationProfile: 'source-as-spec' });
      writeJSON(configFile, value);
      Object.assign(config, { verificationMode: 'source-only', preparationProfile: 'source-as-spec' });
    }
    for (const c of changes) if (c.content) atomicWrite(safePath(root, c.path), c.content);
  }
  return { applied: apply, changes: changes.map(({ path: p, change }) => ({ path: p, change })),
    ...(switching ? { warning: !modeChange
      ? 'Changing the preparation profile edits config.json, which invalidates phase 02 onward and every approval; 00, 00b and 01 records stay valid.'
      : 'Changing the verification mode invalidates every phase record from 00 and every approval; those phases are reviewed again.' } : {}),
    readiness: apply ? sourceSpecReadiness(root, config) : undefined,
    next: apply ? 'Draft every missing item in readiness from the source, then show the whole specification package to the user and record phase complete 00b,01,02 only after their OK.'
      : 'Show these changes to the user; rerun with --apply after they agree.' };
}

// What the single specification review still needs. "template" means the
// installed template was never edited; "placeholder" means TODO(spec) remains.
export function sourceSpecReadiness(root, config) {
  const kit = rel => kitScript(root, rel);
  // Same files the 00b check reads: every scenario in the plan.
  let scenarios = new Set([contractsFile]);
  try { scenarios = new Set([contractsFile, ...readJSON(safePath(root, planFile)).scenarios.map(s => s.path)]); } catch {}
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
  const src = config.sourceRoots[0], command = parser(config.sourceLanguage, kit, src, root);
  // Parser paths are relative to its --root: re-prefix them, and keep only the
  // source roots when the parser walked a wider directory.
  const base = command?.base ?? src;
  const prefix = base === '.' ? '' : ` --prefix '${base}/'`;
  const include = base !== src ? config.sourceRoots.map(r => ` --include '${r}/'`).join('') : '';
  return { ready: items.every(i => i.status === 'ready'), items,
    commands: { dependencyMap: command ? command.cmd : `No bundled parser for ${config.sourceLanguage}; write a deterministic adapter under migration/tools/ (docs/DEPENDENCY-MAPPERS.md)`,
      manifest: `${pythonCommand()} ${kit('scripts/make_manifest.py')} --order migration/depmap/order.txt --out migration/manifest.tsv${prefix}${include} --sub '${src}/=${config.outputRoots[0]}/' --sub '.SOURCE_EXT=.TARGET_EXT'`,
      reviewDependencies: `node ${kit('scripts/make_review_dependencies.mjs')} --source-roots ${config.sourceRoots.join(',')} --depmap-root ${base} --edges migration/depmap/edges.tsv` } };
}
