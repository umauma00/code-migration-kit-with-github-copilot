#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safePath, readJSON, filesUnder, atomicWrite } from '../lib/core.mjs';
import { parseCommandLine, specs } from '../lib/cli.mjs';
export const kitRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryUrl = readJSON(path.join(kitRoot, 'plugin.json')).repository;
function rewriteLinks(text, relativeFile) {
  return text.replace(/\]\(([^)#]+)(#[^)]*)?\)/g, (whole, link, fragment = '') => {
    if (/^[a-z]+:/.test(link) || link.startsWith('/')) return whole;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile), link));
    if (resolved.startsWith('../') || resolved.startsWith('.github/')) return whole;
    return `](${path.posix.relative(path.posix.dirname(relativeFile), `migration-kit/${resolved}`)}${fragment})`;
  });
}
// Development records stay in the kit repository (history/ is not copied); point copied documents at it.
function linkHistory(text, relativeFile) {
  if (!relativeFile.endsWith('.md')) return text;
  return text.replace(/\]\(([^)#]+)(#[^)]*)?\)/g, (whole, link, fragment = '') => {
    if (/^[a-z]+:/.test(link) || link.startsWith('/')) return whole;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile), link));
    return resolved.startsWith('history/') ? `](${repositoryUrl}/blob/HEAD/${resolved}${fragment})` : whole;
  });
}
// The GitHub Copilot app can start each session in a new git worktree. Migration
// state is not committed, so initializing there would start a second migration
// beside the one in another checkout. List the other worktrees that already hold one.
export function otherWorktreeMigrations(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  // native realpath expands Windows short names, so git's paths and the target compare.
  let top, list;
  try { top = fs.realpathSync.native(git(['rev-parse', '--show-toplevel']).trim()); list = git(['worktree', 'list', '--porcelain']); } catch { return []; }
  const rel = path.relative(top, fs.realpathSync.native(root));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return [];
  const found = [];
  for (const line of list.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue;
    let other;
    try { other = fs.realpathSync.native(line.slice('worktree '.length)); } catch { continue; }
    if (other === top) continue;
    const candidate = path.join(other, rel);
    if (fs.existsSync(path.join(candidate, 'migration/config.json'))) found.push(candidate);
  }
  return found;
}
const existingMigrationsNote = 'A migration already exists in another worktree of this repository (existingMigrations). Its state is not committed, so initializing here would start a second one. Ask the person whether to resume it in that checkout (in the GitHub Copilot app, start the session with Workspace: Current checkout) or to start a new migration here, before --apply.';
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
const templateFor = (rel, language) => rel === 'RULEBOOK.md' && language === 'ja' ? 'templates/RULEBOOK.ja.md' : `templates/${rel}`;
function recordedLanguage(target) {
  try { return readJSON(safePath(fs.realpathSync(target), 'migration/preferences.json')).userLanguage ?? null; } catch { return null; }
}
function setModels(config, model, roleModels) {
  for (const role of Object.keys(config.models)) if (model) config.models[role] = model;
  Object.assign(config.models, roleModels);
}
export function install(target, { apply = false, model, harness = 'copilot', withWorkflow = false, layout = 'repository', workerBackend = 'copilot-cli', verificationMode, preparationProfile, language, models, fixPolicy } = {}) {
  if (language !== undefined && !['ja', 'en'].includes(language)) throw new Error('language must be ja or en');
  // Upstream model plan: tier by blast radius (reviewers largest or mid tier,
  // high-volume implementers mid or small, fixers mid). --models overrides --model per role.
  const roleModels = parseRoleModels(models);
  // Report language lives outside config.json so changing it never revokes approvals.
  const preferences = language && !fs.existsSync(safePath(fs.realpathSync(path.resolve(target)), 'migration/preferences.json'))
    ? `${JSON.stringify({ schemaVersion: 1, userLanguage: language }, null, 2)}\n` : null;
  // The rulebook is read by the person too: with Japanese recorded (or chosen
  // now), its template is the Japanese one, so the rules are drafted in it. A
  // recorded choice wins, as the existing preferences file is kept.
  const rulebookLanguage = recordedLanguage(path.resolve(target)) ?? language;
  if (verificationMode !== undefined && !['runtime', 'source-only'].includes(verificationMode)) throw new Error('verificationMode must be runtime or source-only');
  if (preparationProfile !== undefined && !['standard', 'source-as-spec'].includes(preparationProfile)) throw new Error('preparationProfile must be standard or source-as-spec');
  // Source as the only specification implies source-only verification.
  if (preparationProfile === 'source-as-spec') {
    if (verificationMode === 'runtime') throw new Error('source-as-spec requires verificationMode source-only');
    verificationMode = 'source-only';
  }
  if (!['repository', 'plugin'].includes(layout)) throw new Error('layout must be repository or plugin');
  if (!['copilot', 'vscode-local'].includes(harness)) throw new Error('harness must be copilot or vscode-local');
  // Workers always run as Copilot CLI processes, also when the migration is driven
  // from VS Code chat. The VS Code subagent (native) backend was removed in 0.3.0.
  if (workerBackend !== 'copilot-cli') throw new Error('The native worker backend was removed: workers always run as Copilot CLI processes, also from VS Code chat. Install and sign in to the Copilot CLI, then omit --worker-backend');
  if (fixPolicy !== undefined && !['rereview', 'single-pass'].includes(fixPolicy)) throw new Error('fixPolicy must be rereview or single-pass');
  const configureBackend = config => {
    config.workerBackend = workerBackend;
    if (verificationMode !== undefined) config.verificationMode = verificationMode;
    if (preparationProfile !== undefined) config.preparationProfile = preparationProfile;
    if (fixPolicy !== undefined) config.fixPolicy = fixPolicy;
  };
  if (layout === 'plugin' && (harness !== 'copilot' || withWorkflow)) throw new Error('Plugin layout uses Copilot hooks and does not include the experimental workflow extension');
  const root = fs.realpathSync(path.resolve(target));
  if (root === kitRoot || kitRoot.startsWith(`${root}${path.sep}`)) throw new Error('Install into a separate migration target repository');
  const existingConfig = safePath(root, 'migration/config.json');
  if (layout === 'repository' && fs.existsSync(existingConfig) && readJSON(existingConfig).runtime === 'plugin') throw new Error('Existing configuration uses plugin layout; reconcile it explicitly before switching to repository layout');
  const existingMigrations = fs.existsSync(existingConfig) ? [] : otherWorktreeMigrations(root);
  const withExisting = result => existingMigrations.length ? { ...result, existingMigrations, existingMigrationsNote } : result;
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
      } else files.set(name, fs.readFileSync(path.join(kitRoot, templateFor(rel, rulebookLanguage)), 'utf8'));
    }
    if (preferences) files.set('migration/preferences.json', preferences);
    if (apply) for (const [name, content] of files) atomicWrite(safePath(root, name), content);
    return withExisting({ applied: apply, target: root, layout, changes: [...files.keys()],
      next: 'Edit migration/config.json (languages, paths, models and commands), then select the code-migration-plugin-orchestrator agent from the installed plugin. Existing configuration is retained.' });
  }
  const files = new Map();
  for (const dir of ['lib', 'scripts', 'prompts', 'templates', 'docs']) for (const rel of filesUnder(kitRoot, dir)) {
    if (rel === 'scripts/demo.mjs') continue;
    files.set(`migration-kit/${rel}`, linkHistory(fs.readFileSync(safePath(kitRoot, rel), 'utf8'), rel));
  }
  for (const rel of ['README.md', 'README.en.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'UPSTREAM.json']) files.set(`migration-kit/${rel}`, linkHistory(fs.readFileSync(path.join(kitRoot, rel), 'utf8'), rel));
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
  for (const rel of ['RULEBOOK.md', 'inventory.tsv']) if (!fs.existsSync(safePath(root, `migration/${rel}`))) files.set(`migration/${rel}`, fs.readFileSync(path.join(kitRoot, templateFor(rel, rulebookLanguage)), 'utf8'));
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
  return withExisting({ applied: apply, target: root, harness, changes,
    next: 'Edit migration/config.json, then select the migration-orchestrator agent in a new chat to draft the rulebook and inventory. Existing configuration is retained.' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseCommandLine(process.argv.slice(2), specs.install);
    const usage = 'Usage: node scripts/install.mjs --target PATH [--layout repository|plugin] [--model MODEL_ID] [--harness copilot|vscode-local] [--verification-mode runtime|source-only] [--preparation-profile standard|source-as-spec] [--models implementer=ID,reviewers=ID,arbiter=ID,fixer=ID] [--language ja|en] [--fix-policy rereview|single-pass] [--with-workflow] [--apply]';
    if (args.help) { console.log(usage); process.exit(0); }
    if (!args.target) throw new Error(usage);
    console.log(JSON.stringify(install(args.target, { apply: args.apply, model: args.model, harness: args.harness, withWorkflow: args['with-workflow'], layout: args.layout, workerBackend: args['worker-backend'], verificationMode: args['verification-mode'], preparationProfile: args['preparation-profile'], models: args.models, language: args.language, fixPolicy: args['fix-policy'] }), null, 2));
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
