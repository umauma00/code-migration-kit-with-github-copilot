import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, result, cliOutput } from './helpers.mjs';
import { safePath, atomicWrite } from '../lib/core.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { decide } from '../scripts/migration_hook.mjs';

test('tool-assisted reviews run on the read-only twin profile with read tools and the listed-file prompt', async t => {
  const f = prepare(t), unit = f.units[0];
  atomicWrite(safePath(f.root, 'review-cli.mjs'), `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 0.0.0-test.'); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
fs.writeFileSync('review-call.json', JSON.stringify({ argv: process.argv.slice(2), role: process.env.MIGRATION_KIT_ROLE, prompt }));
console.log(${JSON.stringify(cliOutput(result('reviewer-rules', unit)))});
`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [safePath(f.root, 'review-cli.mjs')] });
  const response = await adapter({ ...f, role: 'reviewer-rules', unit, reviewInput: '{"mode":"tool-assisted","files":[]}', reviewMode: 'tool-assisted' });
  assert.equal(response.result.verdict, 'pass'); assert.equal(response.workerProfile, 'reviewer-rules-read');
  const call = JSON.parse(fs.readFileSync(safePath(f.root, 'review-call.json'), 'utf8')), argv = call.argv;
  assert.equal(argv[argv.indexOf('--agent') + 1], 'migration-reviewer-rules-read');
  assert.equal(argv[argv.indexOf('--allow-tool') + 1], 'read'); assert.equal(argv[argv.indexOf('--deny-tool') + 1], 'write,shell');
  assert.equal(call.role, 'reviewer-rules-read');
  assert.match(call.prompt, /Tool-assisted review input/); assert.match(call.prompt, /never open migration\/runs/);
  await adapter({ ...f, role: 'reviewer-rules', unit, reviewInput: '{}' });
  const frozen = JSON.parse(fs.readFileSync(safePath(f.root, 'review-call.json'), 'utf8'));
  assert.equal(frozen.argv[frozen.argv.indexOf('--agent') + 1], 'migration-reviewer-rules');
  assert.equal(frozen.argv[frozen.argv.indexOf('--deny-tool') + 1], 'read,write,shell');
});

test('the hook limits tool-assisted reviewers to named evidence outside run records', t => {
  const root = '/repo', role = 'reviewer-semantics-read', view = path => ({ toolName: 'view', toolArgs: { path }, cwd: root });
  assert.equal(decide(view('src/math_ops.py'), role), null);
  assert.equal(decide(view('/repo/migration/RULEBOOK.md'), role), null);
  for (const path of ['migration/runs/1/x.json', 'migration/state/units', 'migration/results/build.json', '.', '/repo', '../other', 'migration'])
    assert.match(decide(view(path), role), /may not read/, path);
  assert.match(decide({ toolName: 'grep', toolArgs: { pattern: 'x' }, cwd: root }, role), /must name/);
  assert.match(decide({ toolName: 'bash', toolArgs: { command: 'ls' } }, role), /read-only/);
  assert.match(decide(view('src/math_ops.py'), 'reviewer-semantics'), /no tools/);
});

// CLI 1.0.105 names grep/rg and glob targets `paths` (a string or an array),
// for every model; gpt-6-luna's search tool is rg. Before, every search by a
// tool-assisted reviewer was denied for naming no path.
test('tool-assisted reviewers can search listed paths with grep, rg and glob, and only those', () => {
  const root = '/repo', role = 'reviewer-rules-read', call = (toolName, toolArgs) => decide({ toolName, toolArgs, cwd: root }, role);
  for (const tool of ['grep', 'rg', 'glob']) {
    assert.equal(call(tool, { pattern: 'x', paths: 'src' }), null, tool);
    assert.equal(call(tool, { pattern: 'x', paths: ['src', 'lib/util.py'] }), null, tool);
    assert.match(call(tool, { pattern: 'x', paths: ['src', 'migration/runs'] }), /may not read migration\/runs/, tool);
    assert.match(call(tool, { pattern: 'x', paths: '.' }), /may not read/, tool);
    assert.match(call(tool, { pattern: 'x', paths: [] }), /must name/, tool);
    assert.match(call(tool, { pattern: 'x' }), /must name/, tool);
  }
  for (const pattern of ['../migration/runs/**', '/repo/migration/runs/*', 'a/../../x', '..\\runs\\*', '{..,.}/migration/runs/*', '{/repo,src}/migration/runs/*', 'C:..\\migration\\runs\\*', '~/x', ['../migration/runs/**']])
    assert.match(call('glob', { pattern, paths: 'src' }), /may not search/, String(pattern));
  // One key cannot hide another.
  assert.match(call('grep', { pattern: 'x', path: 'src', paths: ['migration/runs'] }), /may not read migration\/runs/);
  assert.match(call('grep', { pattern: 'x', file_path: 'src', paths: ['migration/runs'] }), /may not read migration\/runs/);
  assert.match(call('grep', { pattern: 'x', path: 'src', paths: [] }), /may not read|must name/);
  assert.equal(call('grep', { pattern: 'x', path: 'src', paths: ['lib'] }), null);
  assert.equal(call('grep', { pattern: 'x', path: null, paths: ['src'] }), null, 'an unused key sent as null');
  for (const target of ['src/link/../runs/rec.json', 'src/..', 'src\\..\\migration']) assert.match(call('view', { path: target }), /may not read/, target);
  assert.equal(call('glob', { pattern: '**/*.py', paths: 'src' }), null);
});
