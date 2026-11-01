// SPDX-License-Identifier: Apache-2.0
// 2026-11-01 (CLI 1.0.105, Windows, kit 0.40.0): every phase 00b survey worker
// failed while starting its MCP servers, three runs in a row, before any
// prompt. The 0.34.0 worker home copied every top-level file of ~/.copilot,
// including the CLI's MCP ownership records and a "-writer.binding" file bound
// to the person's home, and copied them again on every command. The worker
// home now takes only the sign-in and settings files and the plugin, agent,
// skill, hook and extension folders, empties an older worker home once, and a
// worker that cannot start its MCP servers or storage there is repeated in the
// person's home instead of failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, result } from './helpers.mjs';
import { safePath, atomicWrite } from '../lib/core.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { prepareWorkerHome, workerCopilotHome, resetPreparedWorkerHomes, workerHomeMarker, workerHomeLayout, workerSettingFiles, workerLinkedFolders } from '../lib/worker-home.mjs';
import { isHomeStateFailure, isSignedOut, isSystemicFailure } from '../lib/failures.mjs';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
function personHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-person-home-')), home = path.join(dir, '.copilot');
  fs.mkdirSync(home);
  const previous = process.env.COPILOT_HOME; process.env.COPILOT_HOME = home;
  resetPreparedWorkerHomes();
  t.after(() => { if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous; resetPreparedWorkerHomes(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(`${home}-migration-kit-workers`, { recursive: true, force: true }); });
  return home;
}
function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the worker home takes only the sign-in, settings and plugin folders, never the CLI state or MCP servers', t => {
  const home = personHome(t), root = project(t);
  assert.deepEqual(workerSettingFiles, ['config.json', 'settings.json']);
  for (const [name, body] of [['config.json', '{"loggedInUsers":[{"login":"someone"}]}'], ['settings.json', '{}'], ['mcp-config.json', '{"mcpServers":{"company":{}}}'],
    ['mcp-installations.json', '{"storageId":"person"}'], ['mcp-activations.json', '{}'], ['mcp-installations-writer.binding', 'person-home'], ['permissions-config.json', '{}'],
    ['statusline.sh', '#!/bin/sh\n'], ['keybindings.json', '{}']]) fs.writeFileSync(path.join(home, name), body);
  for (const dir of [...workerLinkedFolders, 'ide', 'mcp-oauth-config', 'plugin-data', 'protected', 'cache']) fs.mkdirSync(path.join(home, dir, 'inside'), { recursive: true });
  const worker = prepareWorkerHome(root, {});
  assert.deepEqual(fs.readdirSync(worker).sort(), [workerHomeMarker, ...workerSettingFiles, ...workerLinkedFolders].sort());
  for (const dir of workerLinkedFolders) assert.ok(fs.lstatSync(path.join(worker, dir)).isSymbolicLink(), dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(worker, workerHomeMarker), 'utf8')), { layout: workerHomeLayout });
  // What the CLI writes there itself stays, a link to anything else goes (the link only).
  resetPreparedWorkerHomes();
  fs.writeFileSync(path.join(worker, 'mcp-installations.json'), '{"storageId":"worker"}');
  fs.symlinkSync(path.join(home, 'ide'), path.join(worker, 'ide'), linkType);
  prepareWorkerHome(root, {});
  assert.equal(fs.readFileSync(path.join(worker, 'mcp-installations.json'), 'utf8'), '{"storageId":"worker"}');
  assert.ok(!fs.existsSync(path.join(worker, 'ide')));
  assert.ok(fs.existsSync(path.join(home, 'ide', 'inside')), 'the person\'s folder is untouched');
});

test('a worker home from 0.34.0 to 0.40.x is emptied once, keeping session records and never following links', t => {
  const home = personHome(t), root = project(t);
  fs.writeFileSync(path.join(home, 'config.json'), '{"a":1}');
  fs.writeFileSync(path.join(home, 'mcp-installations-writer.binding'), 'person-home');
  for (const dir of ['installed-plugins/p', 'ide/kept']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const worker = workerCopilotHome(root, {});
  fs.mkdirSync(worker, { recursive: true });
  // What 0.34.0 left: copies of every file, links to every folder, and what
  // worker CLIs wrote against those copies; plus the workers' records.
  for (const name of ['config.json', 'mcp-config.json', 'mcp-installations.json', 'mcp-installations-writer.binding', 'session-store.db', 'session-store.db-wal', 'x-writer.lock']) fs.writeFileSync(path.join(worker, name), 'old');
  fs.symlinkSync(path.join(home, 'ide'), path.join(worker, 'ide'), linkType);
  fs.symlinkSync(path.join(home, 'installed-plugins'), path.join(worker, 'installed-plugins'), linkType);
  for (const dir of ['protected/root', 'session-state/11111111-1111-4111-8111-111111111111', 'logs']) fs.mkdirSync(path.join(worker, dir), { recursive: true });
  prepareWorkerHome(root, {});
  assert.deepEqual(fs.readdirSync(worker).sort(), [workerHomeMarker, 'config.json', 'installed-plugins', 'logs', 'session-state', 'session-store.db', 'session-store.db-wal', 'x-writer.lock'].sort());
  assert.equal(fs.readFileSync(path.join(worker, 'config.json'), 'utf8'), '{"a":1}');
  assert.ok(fs.existsSync(path.join(home, 'ide', 'kept')) && fs.existsSync(path.join(home, 'installed-plugins', 'p')), 'linked folders are removed as links, never emptied');
  assert.ok(fs.existsSync(path.join(worker, 'session-state', '11111111-1111-4111-8111-111111111111')));
  // Once only: the CLI's own state in the current layout is kept.
  resetPreparedWorkerHomes();
  fs.mkdirSync(path.join(worker, 'protected', 'root'), { recursive: true });
  prepareWorkerHome(root, {});
  assert.ok(fs.existsSync(path.join(worker, 'protected', 'root')));
});

test('MCP host and protected storage failures are told apart from other failures', () => {
  for (const message of [
    'Error: Failed to initialize MCP host: The protected storage writer association does not match.',
    'MCP installation ownership storage failed. Could not safely read mcp-installations.json in the selected profile: denied',
    'Another process is changing MCP configuration.',
    'The shared writer lock timed out.',
    'transaction root is bound to another lock namespace',
    'The storage directory is writable by group or other users. Choose a private COPILOT_HOME'])
    assert.equal(isHomeStateFailure(message), true, message);
  for (const message of ['connect ETIMEDOUT 140.82.112.21:443', 'Error: 401 Unauthorized', 'session.error forbidden: model not enabled', 'session host did not complete the session.idle event within 120s', 'MCP server company: tool call failed'])
    assert.equal(isHomeStateFailure(message), false, message);
  // Not a sign-in problem, and not a reason to stop the whole run.
  assert.equal(isSignedOut('Error: Failed to initialize MCP host: The protected storage writer association does not match.'), false);
});

function cliDouble(f, body) {
  const script = safePath(f.root, 'home-cli.mjs'), log = safePath(f.root, 'homes.jsonl');
  atomicWrite(script, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
for await (const _ of process.stdin);
const home = process.env.COPILOT_HOME;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ home }) + '\\n');
${body}
console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(result('implementer', f.units[0]))}), toolRequests: [] } }));
console.log(JSON.stringify({ type: 'result', exitCode: 0 }));
`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [script] });
  return { call: () => adapter({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {} }), homes: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).home) };
}

test('a worker that cannot start its MCP servers in the worker home is repeated in the person\'s home, and later calls stay there', async t => {
  const home = personHome(t), f = prepare(t);
  const cli = cliDouble(f, `if (home.endsWith('-migration-kit-workers')) { process.stderr.write('Error: Failed to initialize MCP host: The protected storage writer association does not match.\\n'); process.exit(1); }`);
  const first = await cli.call();
  assert.match(first.cliHomeWarning, /could not start its MCP servers or its storage in the kit's worker home/);
  const second = await cli.call();
  assert.match(second.cliHomeWarning, /person's Copilot CLI home/);
  assert.deepEqual(cli.homes(), [`${home}-migration-kit-workers`, home, home]);
});

test('the same failure in both homes fails that call as before and moves no later call', async t => {
  const home = personHome(t), f = prepare(t);
  const cli = cliDouble(f, `process.stderr.write('Error: Failed to initialize MCP host: The shared writer lock timed out.\\n'); process.exit(1);`);
  const error = await cli.call().catch(e => e);
  assert.match(error.message, /Failed to initialize MCP host/);
  assert.equal(isSystemicFailure(error), false);
  await cli.call().catch(() => {});
  assert.deepEqual(cli.homes(), [`${home}-migration-kit-workers`, home, `${home}-migration-kit-workers`, home]);
});
