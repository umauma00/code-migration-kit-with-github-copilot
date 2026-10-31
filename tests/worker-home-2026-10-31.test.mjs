// SPDX-License-Identifier: Apache-2.0
// 2026-10-31: on a Windows PC whose Copilot CLI home held 2,959 sessions and a
// 192 MB session index, workers kept failing with "session host did not
// complete the ... event within 120s" while the CLI log said "Session store
// tracking backlog limit reached; live indexing paused". Workers now run in a
// CLI home of their own that carries the person's settings, not their records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, result } from './helpers.mjs';
import { safePath, atomicWrite, loadConfig } from '../lib/core.mjs';
import { createCopilotAdapter, copilotEnv } from '../scripts/copilot_adapter.mjs';
import { prepareWorkerHome, workerCopilotHome, userCopilotHome, resetPreparedWorkerHomes, sessionStateDirs, workerIndexLimitBytes } from '../lib/worker-home.mjs';
import { sessionsStatus, pruneSessions, recordSession } from '../lib/sessions.mjs';
import { isSignInFailure, isSystemicFailure } from '../lib/failures.mjs';

// A person's CLI home in a temporary folder, restored after the test.
function personHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-person-home-')), home = path.join(dir, '.copilot');
  fs.mkdirSync(home);
  const previous = process.env.COPILOT_HOME; process.env.COPILOT_HOME = home;
  resetPreparedWorkerHomes();
  t.after(() => { if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous; resetPreparedWorkerHomes(); fs.rmSync(dir, { recursive: true, force: true }); });
  return home;
}

test('the worker home carries the person\'s settings and plugins but none of their session records', t => {
  const home = personHome(t), root = os.tmpdir();
  fs.writeFileSync(path.join(home, 'config.json'), '{"loggedInUsers":[{"login":"someone"}],"trustedFolders":["/work"]}');
  fs.writeFileSync(path.join(home, 'settings.json'), '{"model":"x"}');
  fs.writeFileSync(path.join(home, 'mcp-config.json'), '{"mcpServers":{}}');
  for (const name of ['session-store.db', 'session-store.db-wal', 'session-store.db-shm', 'command-history-state.json', 'settings.json.lock']) fs.writeFileSync(path.join(home, name), 'record');
  for (const dir of ['installed-plugins/p', 'agents', 'session-state/11111111-1111-4111-8111-111111111111', 'logs', 'pkg']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const worker = prepareWorkerHome(root, {});
  assert.equal(worker, `${home}-migration-kit-workers`);
  assert.equal(worker, workerCopilotHome(root, {}));
  assert.deepEqual(fs.readdirSync(worker).sort(), ['agents', 'config.json', 'installed-plugins', 'mcp-config.json', 'settings.json']);
  assert.equal(fs.readFileSync(path.join(worker, 'config.json'), 'utf8'), fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  // Folders are links, so plugins and agents stay exactly the person's.
  assert.ok(fs.lstatSync(path.join(worker, 'installed-plugins')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(worker, 'installed-plugins/p')));
  // "shared" keeps workers in the person's home.
  assert.equal(workerCopilotHome(root, { workerCopilotHome: 'shared' }), null);
  assert.equal(prepareWorkerHome(root, { workerCopilotHome: 'shared' }), null);
  assert.equal(copilotEnv('implementer').COPILOT_HOME, home);
  assert.equal(copilotEnv('implementer', worker).COPILOT_HOME, worker);
});

test('settings are copied once per process, and a worker index past the limit starts over', t => {
  const home = personHome(t), root = os.tmpdir();
  fs.writeFileSync(path.join(home, 'config.json'), '{"a":1}');
  const worker = prepareWorkerHome(root, {});
  fs.writeFileSync(path.join(home, 'config.json'), '{"a":2}');
  assert.equal(prepareWorkerHome(root, {}), worker);
  assert.equal(fs.readFileSync(path.join(worker, 'config.json'), 'utf8'), '{"a":1}', 'no rewrite while workers may be running');
  resetPreparedWorkerHomes();
  fs.writeFileSync(path.join(worker, 'session-store.db'), Buffer.alloc(1024));
  prepareWorkerHome(root, {});
  assert.equal(fs.readFileSync(path.join(worker, 'config.json'), 'utf8'), '{"a":2}', 'a new process takes the current settings');
  assert.ok(fs.existsSync(path.join(worker, 'session-store.db')), 'a small worker index is kept');
  resetPreparedWorkerHomes();
  fs.truncateSync(path.join(worker, 'session-store.db'), workerIndexLimitBytes + 1);
  fs.writeFileSync(path.join(worker, 'session-store.db-wal'), 'x');
  prepareWorkerHome(root, {});
  assert.ok(!fs.existsSync(path.join(worker, 'session-store.db')) && !fs.existsSync(path.join(worker, 'session-store.db-wal')));
});

test('workerCopilotHome accepts separate or shared', t => {
  const f = prepare(t);
  for (const value of ['separate', 'shared']) assert.equal(loadConfig(f.root, { config: { ...f.config, workerCopilotHome: value } }).workerCopilotHome, value);
  assert.throws(() => loadConfig(f.root, { config: { ...f.config, workerCopilotHome: 'other' } }), /workerCopilotHome must be separate or shared/);
});

// A CLI double that records the CLI home of each call and answers like a worker.
function cliDouble(f, body) {
  const script = safePath(f.root, 'home-cli.mjs'), log = safePath(f.root, 'homes.jsonl');
  atomicWrite(script, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
for await (const _ of process.stdin);
const home = process.env.COPILOT_HOME;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ home, config: fs.existsSync(home + '/config.json') }) + '\\n');
${body}
console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(result('implementer', f.units[0]))}), toolRequests: [] } }));
console.log(JSON.stringify({ type: 'result', exitCode: 0 }));
`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [script] });
  const call = () => adapter({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {} });
  return { call, homes: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('workers run in the worker home, with the person\'s settings there', async t => {
  const home = personHome(t), f = prepare(t);
  fs.writeFileSync(path.join(home, 'config.json'), '{}');
  const cli = cliDouble(f, '');
  const response = await cli.call();
  assert.equal(response.cliHomeWarning, undefined);
  assert.deepEqual(cli.homes(), [{ home: `${home}-migration-kit-workers`, config: true }]);
  // "shared" leaves the person's home in place.
  const shared = createCopilotAdapter({ command: process.execPath, prefixArgs: [safePath(f.root, 'home-cli.mjs')] });
  await shared({ root: f.root, config: { ...f.config, workerCopilotHome: 'shared' }, role: 'implementer', unit: f.units[0], extra: {} });
  assert.equal(cli.homes()[1].home, home);
});

test('a CLI signed out only in the worker home is retried in the person\'s home, and later calls stay there', async t => {
  const home = personHome(t), f = prepare(t);
  const cli = cliDouble(f, `if (home.endsWith('-migration-kit-workers')) { process.stderr.write('Error: No authentication information found.\\nTo authenticate, you can use any of the following methods\\n'); process.exit(1); }`);
  const first = await cli.call();
  assert.match(first.cliHomeWarning, /not signed in in the kit's worker home/);
  const second = await cli.call();
  assert.match(second.cliHomeWarning, /person's Copilot CLI home/);
  assert.deepEqual(cli.homes().map(h => h.home), [`${home}-migration-kit-workers`, home, home]);
});

test('a network error with sign-in help is not a reason to leave the worker home', async t => {
  const home = personHome(t), f = prepare(t);
  const help = 'Error: Failed to fetch models: connect ETIMEDOUT 140.82.112.21:443\nTo authenticate, you can use any of the following methods';
  assert.equal(isSignInFailure(help), false);
  assert.equal(isSignInFailure('To authenticate, you can use any of the following methods'), true);
  assert.equal(isSignInFailure('session.error authentication: token expired'), true);
  const cli = cliDouble(f, `process.stderr.write(${JSON.stringify(`${help}\n`)}); process.exit(1);`);
  const error = await cli.call().catch(e => e);
  assert.match(error.message, /ETIMEDOUT/);
  assert.equal(isSystemicFailure(error), false);
  assert.deepEqual(cli.homes().map(h => h.home), [`${home}-migration-kit-workers`]);
  // A sign-in failure in both homes still stops the run as a sign-in problem.
  const signedOut = cliDouble(f, `process.stderr.write('To authenticate, you can use any of the following methods\\n'); process.exit(1);`);
  const stop = await signedOut.call().catch(e => e);
  assert.equal(isSystemicFailure(stop), true);
  assert.deepEqual(signedOut.homes().slice(-2).map(h => h.home), [`${home}-migration-kit-workers`, home]);
});

test('sessions status and prune find worker sessions in the worker home and in the person\'s home', t => {
  const home = personHome(t), f = prepare(t);
  const [inWorker, inPerson, gone] = [0, 1, 2].map(() => recordSession(f.root, '1-abcdef12', { role: 'implementer', target: f.units[0].target }));
  const [workerState, personState] = sessionStateDirs(f.root);
  assert.equal(workerState, path.join(`${home}-migration-kit-workers`, 'session-state'));
  assert.equal(personState, path.join(userCopilotHome(f.root), 'session-state'));
  for (const [dir, id] of [[workerState, inWorker], [personState, inPerson]]) { fs.mkdirSync(path.join(dir, id), { recursive: true }); fs.writeFileSync(path.join(dir, id, 'events.jsonl'), '{}\n'); }
  const own = path.join(personState, '22222222-2222-4222-8222-222222222222'); fs.mkdirSync(own);
  const status = sessionsStatus(f.root);
  assert.equal(status.recorded, 3); assert.equal(status.present, 2); assert.deepEqual(status.sessionStates, [workerState, personState]);
  assert.equal(pruneSessions(f.root).removed, 2);
  assert.ok(!fs.existsSync(path.join(workerState, inWorker)) && !fs.existsSync(path.join(personState, inPerson)));
  assert.ok(fs.existsSync(own), 'the person\'s own sessions are never touched');
  assert.ok(!fs.existsSync(path.join(personState, gone)));
});
