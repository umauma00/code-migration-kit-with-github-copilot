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
const workerRoles = ['implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer'];
function parseRoleModels(value) {
  if (value === undefined) return {};
  const out = {};
  for (const pair of String(value).split(',').map(p => p.trim()).filter(Boolean)) {
    const [role, id] = pair.split('=').map(p => p?.trim());
    const roles = role === 'reviewers' ? ['reviewer-semantics', 'reviewer-rules'] : [role];
    if (!id || roles.some(r => !workerRoles.includes(r))) throw new Error(`--models takes role=MODEL_ID pairs for ${workerRoles.join(', ')} (or reviewers=MODEL_ID); got ${pair}`);
    for (const r of roles) out[r] = id;
  }
  return out;
}
function setModels(config, model, roleModels) {
  for (const role of Object.keys(config.models)) if (model) config.models[role] = model;
  Object.assign(config.models, roleModels);
}
export function install(target, { apply = false, model, harness = 'copilot', withWorkflow = false, layout = 'repository', workerBackend = 'copilot-cli', nativeHarness = harness, verificationMode, preparationProfile, language, nativeModelVerification, models, fixPolicy, nativeInput } = {}) {
  if (language !== undefined && !['ja', 'en'].includes(language)) throw new Error('language must be ja or en');
  // Upstream model plan: tier by blast radius (reviewers largest or mid tier,
  // high-volume implementers mid or small, fixers mid). --models overrides --model per role.
  const roleModels = parseRoleModels(models);
  // Report language lives outside config.json so changing it never revokes approvals.
  const preferences = language && !fs.existsSync(safePath(fs.realpathSync(path.resolve(target)), 'migration/preferences.json'))
    ? `${JSON.stringify({ schemaVersion: 1, userLanguage: language }, null, 2)}\n` : null;
  if (verificationMode !== undefined && !['runtime', 'source-only'].includes(verificationMode)) throw new Error('verificationMode must be runtime or source-only');
  if (preparationProfile !== undefined && !['standard', 'source-as-spec'].includes(preparationProfile)) throw new Error('preparationProfile must be standard or source-as-spec');
  // Source as the only specification implies source-only verification.
  if (preparationProfile === 'source-as-spec') {
    if (verificationMode === 'runtime') throw new Error('source-as-spec requires verificationMode source-only');
    verificationMode = 'source-only';
  }
  if (!['repository', 'plugin'].includes(layout)) throw new Error('layout must be repository or plugin');
  if (!['copilot', 'vscode-local'].includes(harness)) throw new Error('harness must be copilot or vscode-local');
  if (!['copilot-cli', 'native'].includes(workerBackend)) throw new Error('workerBackend must be copilot-cli or native');
  if (workerBackend === 'native' && (!['copilot', 'vscode-local'].includes(nativeHarness) || (layout === 'plugin' && nativeHarness !== 'copilot'))) throw new Error('Native harness must be copilot or vscode-local; vscode-local requires repository layout');
  if (workerBackend === 'native' && withWorkflow) throw new Error('Native workers use the host session, not the experimental workflow');
  // New native projects default to the VS Code-only mode: VS Code does not report
  // the executed subagent model, so host-metadata cannot complete on it today.
  if (nativeModelVerification !== undefined && workerBackend !== 'native') throw new Error('--native-model-verification requires --worker-backend native');
  if (nativeModelVerification !== undefined && !['host-metadata', 'requested-unverified'].includes(nativeModelVerification)) throw new Error('nativeModelVerification must be host-metadata or requested-unverified');
  if (workerBackend === 'native') nativeModelVerification ??= 'requested-unverified';
  if (fixPolicy !== undefined && !['rereview', 'single-pass'].includes(fixPolicy)) throw new Error('fixPolicy must be rereview or single-pass');
  if (nativeInput !== undefined && !['inline', 'file'].includes(nativeInput)) throw new Error('nativeInput must be inline or file');
  if (nativeInput !== undefined && workerBackend !== 'native') throw new Error('--native-input requires --worker-backend native');
  if (nativeInput === 'file' && layout === 'plugin') throw new Error('--native-input file requires the repository-copy layout');
  const warnings = workerBackend !== 'native' ? [] : nativeModelVerification === 'requested-unverified'
    ? ['workerBackend native runs inside VS Code without the Copilot CLI. nativeModelVerification is requested-unverified: requested models are passed to the host, but the executed subagent model is recorded as unverified. Use --native-model-verification host-metadata or the copilot-cli backend when observed models are required.']
    : ['workerBackend native with host-metadata is EXPERIMENTAL: VS Code does not report the executed subagent model, so native jobs cannot be submitted under this contract. Use requested-unverified for VS Code-only runs, or the copilot-cli backend.'];
  const configureBackend = config => {
    config.workerBackend = workerBackend;
    if (verificationMode !== undefined) config.verificationMode = verificationMode;
    if (preparationProfile !== undefined) config.preparationProfile = preparationProfile;
    if (workerBackend === 'native') Object.assign(config, { nativeHarness, nativeModelVerification });
    if (fixPolicy !== undefined) config.fixPolicy = fixPolicy;
    if (nativeInput !== undefined) config.nativeInput = nativeInput;
  };
  if (layout === 'plugin' && (harness !== 'copilot' || withWorkflow)) throw new Error('Plugin layout uses Copilot hooks and does not include the experimental workflow extension');
  const root = fs.realpathSync(path.resolve(target));
  if (root === kitRoot || kitRoot.startsWith(`${root}${path.sep}`)) throw new Error('Install into a separate migration target repository');
  const existingConfig = safePath(root, 'migration/config.json');
  if (layout === 'repository' && fs.existsSync(existingConfig) && readJSON(existingConfig).runtime === 'plugin') throw new Error('Existing configuration uses plugin layout; reconcile it explicitly before switching to repository layout');
  if (layout === 'plugin') {
    const files = new Map(), configPath = safePath(root, 'migration/config.json');
    if (fs.existsSync(configPath)) {
      if (readJSON(configPath).runtime !== 'plugin') throw new Error('Existing configuration uses repository layout; reconcile it explicitly before switching to plugin layout');
    } else {
      const config = readJSON(path.join(kitRoot, 'templates/migration-config.json'));
      config.runtime = 'plugin';
      configureBackend(config);
      setModels(config, model, roleModels);
      files.set('migration/config.json', `${JSON.stringify(config, null, 2)}\n`);
    }
    for (const rel of ['RULEBOOK.md', 'inventory.tsv']) {
      const name = `migration/${rel}`, file = safePath(root, name);
      if (fs.existsSync(file)) {
        if (!fs.statSync(file).isFile()) throw new Error(`Destination is not a regular file: ${name}`);
      } else files.set(name, fs.readFileSync(path.join(kitRoot, `templates/${rel}`), 'utf8'));
    }
    if (preferences) files.set('migration/preferences.json', preferences);
    if (apply) for (const [name, content] of files) atomicWrite(safePath(root, name), content);
    return { applied: apply, target: root, layout, changes: [...files.keys()], ...(warnings.length ? { warnings } : {}),
      next: 'Edit migration/config.json (languages, paths, models and commands), then invoke the code-migration skill from the installed plugin. Existing configuration is retained.' };
  }
  const files = new Map();
  for (const dir of ['lib', 'scripts', 'prompts', 'templates', 'docs']) for (const rel of filesUnder(kitRoot, dir)) {
    if (rel === 'scripts/demo.mjs') continue;
    files.set(`migration-kit/${rel}`, fs.readFileSync(safePath(kitRoot, rel), 'utf8'));
  }
  for (const rel of ['README.md', 'README.en.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'UPSTREAM.json']) files.set(`migration-kit/${rel}`, fs.readFileSync(path.join(kitRoot, rel), 'utf8'));
  const runtimePackage = readJSON(path.join(kitRoot, 'package.json'));
  runtimePackage.scripts = { check: 'node scripts/run_migration.mjs doctor --root ..' };
  files.set('migration-kit/package.json', `${JSON.stringify(runtimePackage, null, 2)}\n`);
  for (const rel of filesUnder(kitRoot, '.github')) {
    if (rel.startsWith('.github/plugin/') || rel.startsWith('.github/workflows/') || (!withWorkflow && rel.startsWith('.github/extensions/')) || rel.startsWith('.github/hooks/')) continue;
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
  configureBackend(config);
  setModels(config, model, roleModels);
  if (!fs.existsSync(safePath(root, 'migration/config.json'))) files.set('migration/config.json', `${JSON.stringify(config, null, 2)}\n`);
  for (const rel of ['RULEBOOK.md', 'inventory.tsv']) if (!fs.existsSync(safePath(root, `migration/${rel}`))) files.set(`migration/${rel}`, fs.readFileSync(path.join(kitRoot, `templates/${rel}`), 'utf8'));
  if (preferences) files.set('migration/preferences.json', preferences);
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
  return { applied: apply, target: root, harness, changes, ...(warnings.length ? { warnings } : {}),
    next: 'Edit migration/config.json, draft the rulebook and inventory, then follow migration-kit/README.md. Existing configuration is retained.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.target) throw new Error('Usage: node scripts/install.mjs --target PATH [--layout repository|plugin] [--model MODEL_ID] [--harness copilot|vscode-local] [--worker-backend copilot-cli|native] [--native-harness copilot|vscode-local] [--verification-mode runtime|source-only] [--preparation-profile standard|source-as-spec] [--native-model-verification requested-unverified|host-metadata] [--models implementer=ID,reviewers=ID,arbiter=ID,fixer=ID] [--language ja|en] [--fix-policy rereview|single-pass] [--native-input inline|file] [--with-workflow] [--apply]');
    console.log(JSON.stringify(install(args.target, { apply: args.apply, model: args.model, harness: args.harness, withWorkflow: args['with-workflow'], layout: args.layout, workerBackend: args['worker-backend'], nativeHarness: args['native-harness'], verificationMode: args['verification-mode'], preparationProfile: args['preparation-profile'], nativeModelVerification: args['native-model-verification'], models: args.models, language: args.language, fixPolicy: args['fix-policy'], nativeInput: args['native-input'] }), null, 2));
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
