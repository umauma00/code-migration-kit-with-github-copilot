import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { install, kitRoot, otherWorktreeMigrations } from '../scripts/install.mjs';

const read = rel => fs.readFileSync(path.join(kitRoot, rel), 'utf8');
const json = rel => JSON.parse(read(rel));
const marketplaceSource = 'umauma00/code-migration-kit-with-github-copilot#feat/github-copilot-migration-kit';

test('plugin.json keeps to the closed Agent Plugins 1.0 manifest that the CLI, VS Code and the app read', () => {
  const manifest = json('plugin.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  const allowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
  assert.deepEqual(Object.keys(manifest).filter(k => !allowed.includes(k)), []);
  assert.match(manifest.name, /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/);
  assert.doesNotMatch(manifest.name, /--|\.\./);
  assert.equal(manifest.version, json('package.json').version);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.every(k => typeof k === 'string'));
  assert.deepEqual(Object.keys(manifest.author).filter(k => !['name', 'email', 'url'].includes(k)), []);
});

test('the marketplace lists the root plugin with the same name and version', () => {
  const market = json('.github/plugin/marketplace.json'), manifest = json('plugin.json');
  assert.match(market.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(market.name.length <= 64 && market.owner?.name);
  assert.equal(market.metadata.version, manifest.version);
  assert.equal(market.plugins.length, 1);
  const [entry] = market.plugins;
  assert.equal(entry.name, manifest.name);
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.description, manifest.description);
  assert.equal(fs.realpathSync(path.join(kitRoot, entry.source)), fs.realpathSync(kitRoot));
  // Component paths are fixed by Agent Plugins 1.0; an entry that sets them would diverge between surfaces.
  for (const key of ['agents', 'skills', 'hooks', 'commands', 'mcpServers', 'lspServers']) assert.equal(entry[key], undefined, key);
});

test('components sit where Agent Plugins 1.0 and the com.github.copilot namespace put them', () => {
  for (const dir of fs.readdirSync(path.join(kitRoot, 'skills'))) {
    const skill = read(`skills/${dir}/SKILL.md`);
    assert.equal(skill.match(/^name: (.+)$/m)[1], dir);
  }
  const agents = fs.readdirSync(path.join(kitRoot, 'com.github.copilot/agents'));
  assert.ok(agents.includes('code-migration-plugin-orchestrator.agent.md'));
  assert.ok(agents.every(f => f.endsWith('.agent.md')));
  const hooks = json('com.github.copilot/hooks/hooks.json');
  assert.equal(hooks.version, 1);
  assert.ok(hooks.hooks.preToolUse[0].bash.includes('${PLUGIN_ROOT}'));
});

test('installation docs give every surface the same marketplace source and plugin identifier', () => {
  const market = json('.github/plugin/marketplace.json'), id = `${market.plugins[0].name}@${market.name}`;
  for (const doc of ['docs/PLUGIN.md', 'docs/PLUGIN.en.md']) {
    const text = read(doc);
    assert.ok(text.includes(`copilot plugin marketplace add ${marketplaceSource}`), doc);
    assert.ok(text.includes(`copilot plugin install ${id}`), doc);
    assert.match(text, /### GitHub Copilot CLI\n[\s\S]*### VS Code\n[\s\S]*### GitHub Copilot app\n/, doc);
    assert.match(text, /chat\.plugins\.enabled/, doc);
    assert.match(text, /Current checkout/, doc);
    assert.match(text, /This computer/, doc);
    assert.match(text, /2026-10-29/, doc);
    const add = text.match(/ghapp:\/\/plugins\/marketplace\/add\?source=([^`\s]+)/)[1];
    assert.equal(decodeURIComponent(add), marketplaceSource, doc);
    const inst = text.match(/ghapp:\/\/plugins\/install\?source=([^`\s]+)/)[1];
    assert.equal(decodeURIComponent(inst), id, doc);
    const defaults = JSON.parse(text.match(/```json\n(\{\n  "extraKnownMarketplaces"[\s\S]*?)```/)[1]);
    assert.ok(defaults.extraKnownMarketplaces[market.name], doc);
    assert.equal(defaults.enabledPlugins[id], true, doc);
  }
  for (const doc of ['README.md', 'README.en.md']) {
    const text = read(doc);
    assert.ok(text.includes(`copilot plugin marketplace add ${marketplaceSource}`), doc);
    assert.ok(text.includes('GitHub Copilot app'), doc);
    assert.doesNotMatch(text.slice(text.indexOf('copilot plugin install')), /^.*`code-migration` (skill|スキル)/m, doc);
  }
});

test('both copies of the code-migration skill describe the GitHub Copilot app host', () => {
  for (const rel of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = read(rel);
    assert.match(text, /The GitHub Copilot app is built on the Copilot CLI/, rel);
    assert.match(text, /`\/sandbox off`/, rel);
    assert.match(text, /`existingMigrations`/, rel);
    assert.match(text, /without\nthe sandbox's limits/, rel);
  }
});

function gitRepo(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-app-worktree-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, stdio: 'pipe' });
  git(main, 'init', '-q');
  fs.writeFileSync(path.join(main, 'README'), 'x\n');
  git(main, 'add', 'README');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', path.join(base, 'session'));
  return { base, main, session: path.join(base, 'session') };
}

test('initializing in a new worktree points to the migration another worktree already holds', t => {
  const { main, session } = gitRepo(t);
  assert.deepEqual(otherWorktreeMigrations(session), []);
  assert.equal(install(session, { layout: 'plugin' }).existingMigrations, undefined);
  install(main, { layout: 'plugin', apply: true });
  const preview = install(session, { layout: 'plugin' });
  assert.deepEqual(preview.existingMigrations, [main]);
  assert.match(preview.existingMigrationsNote, /Current checkout/);
  assert.deepEqual(fs.readdirSync(session).filter(f => f !== '.git'), ['README']);
  // The checkout that holds the migration is not pointed elsewhere, and neither is a worktree
  // that already has its own.
  assert.equal(install(main, { layout: 'plugin' }).existingMigrations, undefined);
  install(session, { layout: 'plugin', apply: true });
  assert.equal(install(session, { layout: 'plugin' }).existingMigrations, undefined);
});

test('a target in a subdirectory is matched to the same subdirectory of other worktrees', t => {
  const { main, session } = gitRepo(t);
  fs.mkdirSync(path.join(main, 'app'));
  fs.mkdirSync(path.join(session, 'app'));
  install(path.join(main, 'app'), { layout: 'plugin', apply: true });
  assert.deepEqual(otherWorktreeMigrations(path.join(session, 'app')), [path.join(main, 'app')]);
  assert.deepEqual(otherWorktreeMigrations(session), []);
});

test('a target outside git has no other worktrees', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-app-nogit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(otherWorktreeMigrations(fs.realpathSync(root)), []);
});

test('the other worktree is found from either side, for a repository copy too, and for directory names starting with two dots', t => {
  const { main, session } = gitRepo(t);
  install(session, { layout: 'plugin', apply: true });
  assert.deepEqual(install(main, { layout: 'plugin' }).existingMigrations, [session]);
  assert.deepEqual(install(main, { model: 'm' }).existingMigrations, [session]);
  for (const root of [main, session]) fs.mkdirSync(path.join(root, '..cache/app'), { recursive: true });
  install(path.join(session, '..cache/app'), { layout: 'plugin', apply: true });
  assert.deepEqual(otherWorktreeMigrations(path.join(main, '..cache/app')), [path.join(session, '..cache/app')]);
});
