// Opt-in regression check against Copilot CLI 1.0.93's internal native APIs.
// This dependency is confined to tests. No account or model requests are used.
// node tests/verify_plugin_resolution.mjs /absolute/path/to/runtime.node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prepare, ready, fake } from './helpers.mjs';
import { pluginRoot, runtimeLayout } from '../lib/runtime.mjs';
import { contextHash, done } from '../lib/core.mjs';
import { validateWorkerProfile } from '../lib/review.mjs';
import { translate, requireGate } from '../lib/pipeline.mjs';
import { doctor } from '../scripts/run_migration.mjs';

const addon = process.argv[2];
if (!addon || !path.isAbsolute(addon)) throw new Error('Supply Copilot CLI 1.0.93 runtime.node as an absolute path');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-resolution-'));
const previousHome = process.env.COPILOT_HOME;
process.env.COPILOT_HOME = path.join(sandbox, 'home'); fs.mkdirSync(process.env.COPILOT_HOME);
const S = createRequire(import.meta.url)(addon);
const emit = value => console.log(JSON.stringify(value));
let serial = 0;
async function select(root, id, plugins) {
  const discovered = JSON.parse(await S.customAgentsDiscoverJson(JSON.stringify({
    integrationId: 'copilot-cli', configDir: process.env.COPILOT_HOME, projectPaths: [root],
    excludeHostAgents: false, additionalPlugins: plugins, hasResolvedPlugins: true
  })));
  assert.deepEqual(discovered.errors, []);
  const sessionId = `plugin-resolution-${++serial}`;
  S.sessionConstruct(JSON.stringify({ sessionId, workingDirectoryCandidate: root,
    workingDirectoryConventions: 'posix', sessionFsIsLocal: false, initialWorkingDirectory: root,
    sessionStatePath: path.join(sandbox, sessionId), processWorkingDirectory: root,
    defaultIntegrationId: 'copilot-cli', updateOptionsJson: '{}', isLocalSession: false }));
  S.sessionCustomAgentsSetLoadedJson(sessionId, JSON.stringify(discovered.agents));
  assert.equal((await S.sessionBaseSelectCustomAgent(sessionId, id)).kind, 'selected');
  return JSON.parse(S.sessionCustomAgentsSelectedJson(sessionId));
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
try {
  const parent = path.join(sandbox, 'parent'), root = path.join(parent, 'project'); fs.mkdirSync(root, { recursive: true });
  const f = prepare(null, { root, layout: 'plugin' }), role = 'reviewer-rules';
  const layout = runtimeLayout(root, f.config), id = layout.agentId(role);
  const plugins = (await S.configLoaderScanPluginDirPaths([pluginRoot], root)).plugins;
  const aliasFronts = [
    `name: ${id}`, `name: '${id}'`, `"name": "${id}"`,
    `name: "${id.replace('kit:', 'ki\\u0074:')}"`,
    `name: >-\n  ${id}`, `alias: &agent ${id}\nname: *agent`,
    `{name: '${id}', description: alias, tools: [view]}`
  ];
  const paths = [path.join(root, '.github/agents/other.agent.md'),
    path.join(root, '.github/agents/nested/other.md'),
    path.join(parent, '.github/agents/ancestor.agent.md'),
    path.join(root, '.claude/agents/nested/claude.md'),
    path.join(process.env.COPILOT_HOME, 'agents/nested/personal.md')];
  let blocked = 0;
  for (const file of paths) for (const front of aliasFronts) {
    write(file, `\uFEFF---\r\n${front}\n${front.startsWith('{') ? '' : 'description: alias\ntools: [view]\n'}---\nLOCAL_ALIAS`);
    const actual = await select(root, id, plugins);
    assert.equal(actual.path, file);
    assert.throws(() => validateWorkerProfile(root, role, f.config), /shadowed/);
    assert.equal((await doctor(root, f.config)).ok, false);
    blocked++; fs.unlinkSync(file);
  }
  emit({ test: 'local aliases selected by real CLI are blocked', cases: blocked });
  const bare = id.split(':').at(-1), control = path.join(root, '.github/agents', `${bare}.agent.md`);
  for (const name of [bare, id.toUpperCase(), ` ${id} `]) {
    write(control, `---\nname: ${JSON.stringify(name)}\ndescription: noncolliding control\ntools: [view]\n---\nBody`);
    assert.ok((await select(root, id, plugins)).path.startsWith(pluginRoot + path.sep));
    assert.doesNotThrow(() => validateWorkerProfile(root, role, f.config));
  }
  fs.unlinkSync(control);
  emit({ test: 'unqualified, uppercase and spaced names coexist with plugin selector', cases: 3 });

  const completedRoot = path.join(sandbox, 'completed'); fs.mkdirSync(completedRoot);
  const fixture = await ready(null, { root: completedRoot, layout: 'plugin' });
  await translate(fixture.root, fixture.config, fake);
  const before = contextHash(fixture.root, fixture.config);
  assert.equal(done(fixture.root, fixture.units[0], before), true);
  write(path.join(fixture.root, '.github/hooks/context.json'), JSON.stringify({ version: 1,
    hooks: { sessionStart: [{ type: 'command', timeoutSec: 5,
      bash: 'node -e "console.log(JSON.stringify({additionalContext:\'HOOK_CONTEXT_CANARY\'}))"' }] } }));
  const after = contextHash(fixture.root, fixture.config);
  assert.notEqual(after, before);
  assert.equal(done(fixture.root, fixture.units[0], after), false);
  assert.throws(() => requireGate(fixture.root, fixture.config, 'translation', after), /approval|approve|changed/i);
  const sessionId = 'plugin-resolution-hooks';
  await S.hookSessionCreate({ sessionId, cwd: fixture.root, repoRoot: fixture.root,
    settingsJson: '{}', userHooksDir: path.join(sandbox, 'no-user-hooks'), discoverPolicies: false });
  const loaded = await S.hookSessionLoadRepo(sessionId);
  assert.equal(loaded.hookCount, 1); assert.deepEqual(loaded.errors, []);
  const { processorId } = S.hookProcessorConfigureOwned(sessionId, 'plugin-regression');
  try {
    S.hookProcessorRefreshContextOwned(sessionId, processorId, fixture.root);
    const event = await S.hookProcessorEventOwned(sessionId, processorId, 'sessionStart', JSON.stringify({ source: 'new', cwd: fixture.root }));
    assert.equal(event.output.additionalContext, 'HOOK_CONTEXT_CANARY');
    assert.deepEqual(event.failures, []);
  } finally { S.hookProcessorDisposeOwned(sessionId, processorId); }
  emit({ test: 'real project hook is tracked; previous approval and completion are invalidated', pass: true });
  emit({ result: 'All native regressions passed', externalAI: false });
} finally {
  if (previousHome === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previousHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
}
