#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safePath, parseArgs, readJSON, filesUnder, atomicWrite } from '../lib/core.mjs';
export const kitRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function rewriteLinks(text, relativeFile) {
  return text.replace(/\]\(([^)#]+)(#[^)]*)?\)/g, (whole, link, fragment = '') => {
    if (/^[a-z]+:/.test(link) || link.startsWith('/')) return whole;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile), link));
    if (resolved.startsWith('../') || resolved.startsWith('.github/')) return whole;
    return `](${path.posix.relative(path.posix.dirname(relativeFile), `migration-kit/${resolved}`)}${fragment})`;
  });
}
export function install(target, { apply = false, model, harness = 'copilot', withWorkflow = false } = {}) {
  if (!['copilot', 'vscode-local'].includes(harness)) throw new Error('harness must be copilot or vscode-local');
  const root = fs.realpathSync(path.resolve(target));
  if (root === kitRoot || kitRoot.startsWith(`${root}${path.sep}`)) throw new Error('Install into a separate migration target repository');
  const files = new Map();
  for (const dir of ['lib', 'scripts', 'prompts', 'templates', 'docs']) for (const rel of filesUnder(kitRoot, dir)) {
    if (rel === 'scripts/demo.mjs') continue;
    files.set(`migration-kit/${rel}`, fs.readFileSync(safePath(kitRoot, rel), 'utf8'));
  }
  for (const rel of ['README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'UPSTREAM.json']) files.set(`migration-kit/${rel}`, fs.readFileSync(path.join(kitRoot, rel), 'utf8'));
  const runtimePackage = readJSON(path.join(kitRoot, 'package.json'));
  runtimePackage.scripts = { check: 'node scripts/run_migration.mjs doctor --root ..' };
  files.set('migration-kit/package.json', `${JSON.stringify(runtimePackage, null, 2)}\n`);
  for (const rel of filesUnder(kitRoot, '.github')) {
    if (rel.startsWith('.github/workflows/') || (!withWorkflow && rel.startsWith('.github/extensions/')) || rel.startsWith('.github/hooks/')) continue;
    files.set(rel, rewriteLinks(fs.readFileSync(safePath(kitRoot, rel), 'utf8'), rel));
  }
  files.set('.github/hooks/code-migration.json', fs.readFileSync(path.join(kitRoot, `templates/hooks.${harness}.json`), 'utf8'));
  const instructions = '.github/copilot-instructions.md', start = '<!-- code-migration-kit:start -->', end = '<!-- code-migration-kit:end -->';
  const managed = `${start}\n${files.get(instructions).trim()}\n${end}\n`, oldPath = safePath(root, instructions);
  if (fs.existsSync(oldPath)) {
    const old = fs.readFileSync(oldPath, 'utf8');
    if (old.includes(start)) {
      if (!old.includes(managed.trim())) throw new Error('Existing managed instructions differ; reconcile them before reinstalling');
      files.set(instructions, old);
    } else files.set(instructions, `${old.trimEnd()}\n\n${managed}`);
  } else files.set(instructions, managed);
  const config = readJSON(path.join(kitRoot, 'templates/migration-config.json'));
  if (model) for (const role of Object.keys(config.models)) config.models[role] = model;
  if (!fs.existsSync(safePath(root, 'migration/config.json'))) files.set('migration/config.json', `${JSON.stringify(config, null, 2)}\n`);
  for (const rel of ['RULEBOOK.md', 'inventory.tsv']) if (!fs.existsSync(safePath(root, `migration/${rel}`))) files.set(`migration/${rel}`, fs.readFileSync(path.join(kitRoot, `templates/${rel}`), 'utf8'));
  const changes = [];
  for (const [rel, content] of files) {
    const file = safePath(root, rel);
    if (fs.existsSync(file)) {
      if (!fs.statSync(file).isFile()) throw new Error(`Destination is not a regular file: ${rel}`);
      if (fs.readFileSync(file, 'utf8') === content) continue;
      if (rel !== instructions) throw new Error(`Refusing to overwrite an existing different file: ${rel}`);
    }
    changes.push(rel);
  }
  if (apply) for (const rel of changes) atomicWrite(safePath(root, rel), files.get(rel));
  return { applied: apply, target: root, harness, changes,
    next: 'Edit migration/config.json, draft the rulebook and inventory, then follow migration-kit/README.md. Existing configuration is retained.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.target) throw new Error('Usage: node scripts/install.mjs --target PATH [--model MODEL_ID] [--harness copilot|vscode-local] [--with-workflow] [--apply]');
    console.log(JSON.stringify(install(args.target, { apply: args.apply, model: args.model, harness: args.harness, withWorkflow: args['with-workflow'] }), null, 2));
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
