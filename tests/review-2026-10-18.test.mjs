// SPDX-License-Identifier: Apache-2.0
// Regressions for the 2026-10-18 review against Copilot CLI 1.0.98 and current
// VS Code documentation: JSON-mode errors, prompt-mode hooks, observed models,
// scheduling and the upstream single-pass fix policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepare, result, finding, fake } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { loadConfig, contextHash, safePath, writeJSON, readJSON, done, unitState, atomicWrite, waitsForDependencies } from '../lib/core.mjs';
import { createCopilotAdapter, copilotEnv, copilotStreamError, copilotStreamFacts, parseCopilotOutput } from '../scripts/copilot_adapter.mjs';
import { isTransientFailure, isSystemicFailure } from '../lib/failures.mjs';

const persist = f => writeJSON(safePath(f.root, 'migration/config.json'), f.config);
async function approved(f) {
  persist(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Regression fixture only');
}
const events = list => list.map(e => JSON.stringify(e)).join('\n');
const sessionError = (errorType, statusCode, message) => ({ type: 'session.error', data: { errorType, statusCode, message } });

test('JSON-mode session.error on stdout names the cause and drives retry/stop classification', () => {
  // Shapes observed from Copilot CLI 1.0.98 with -s --output-format json: stderr empty, exit 1.
  const limited = events([sessionError('rate_limit', 429, 'Failed to get response from the AI model; retried 5 times Last error: 429 Rate limit exceeded'), { type: 'result', exitCode: 1 }]);
  const auth = events([sessionError('authentication', 401, 'Authentication failed with provider (HTTP 401).'), { type: 'result', exitCode: 1 }]);
  const unavailable = events([sessionError('query', 503, 'Last error: 503 Service Unavailable'), { type: 'result', exitCode: 1 }]);
  assert.match(copilotStreamError(limited), /^session\.error rate_limit 429: /);
  const wrap = stdout => new Error(`Copilot implementer failed (exit 1): ${copilotStreamError(stdout)}`);
  assert.equal(isTransientFailure(wrap(limited)), true);
  assert.equal(isTransientFailure(wrap(unavailable)), true);
  assert.equal(isSystemicFailure(wrap(auth)), true);
  assert.equal(isTransientFailure(wrap(auth)), false);
  assert.equal(copilotStreamError(events([{ type: 'result', exitCode: 0 }])), '');
  // A session.error before a successful result still fails, with its cause.
  assert.throws(() => parseCopilotOutput(events([sessionError('rate_limit', 429, 'slow down'), { type: 'result', exitCode: 0 }])), /session\.error rate_limit 429: slow down/);
});

test('the CLI adapter retries a stdout-only rate limit and records CLI-reported model and usage', async t => {
  const f = prepare(t); f.config.transientRetryDelayMs = 1; await approved(f);
  const unit = f.units[0], counter = safePath(f.root, 'calls.txt'), script = safePath(f.root, 'stdout-error-cli.mjs');
  const responses = Object.fromEntries(['implementer', 'reviewer-semantics', 'reviewer-rules'].map(role => [role, result(role, unit)]));
  atomicWrite(script, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.98.'); process.exit(0); }
for await (const _ of process.stdin);
const role = process.env.MIGRATION_KIT_ROLE, n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
if (n === 0) { console.log(JSON.stringify({ type: 'session.error', data: { errorType: 'rate_limit', statusCode: 429, message: '429 Rate limit exceeded' } })); console.log(JSON.stringify({ type: 'result', exitCode: 1 })); process.exit(1); }
console.log(JSON.stringify({ type: 'model.call_final_result', data: { model: role === 'reviewer-rules' ? 'fallback-model' : 'test-double', result: 'success' } }));
console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(responses)}[role]), toolRequests: [] } }));
console.log(JSON.stringify({ type: 'result', exitCode: 0, usage: { premiumRequests: 1, totalApiDurationMs: 12, sessionDurationMs: 30 } }));
`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [script] });
  const report = await translate(f.root, f.config, adapter);
  assert.equal(report.done, 1);
  assert.deepEqual(report.observedModels, ['fallback-model', 'test-double']);
  assert.ok(report.warnings.some(w => /reported model fallback-model for requested test-double/.test(w)));
  const runDir = safePath(f.root, `migration/runs/${report.runId}`);
  const attempts = fs.readdirSync(runDir).filter(n => n !== 'summary.json' && n.endsWith('.json')).map(n => readJSON(path.join(runDir, n)));
  const implementer = attempts.find(a => a.role === 'implementer');
  assert.equal(implementer.retries.length, 1);
  assert.match(implementer.retries[0].error, /session\.error rate_limit 429/);
  assert.deepEqual(implementer.cliUsage, { premiumRequests: 1, totalApiDurationMs: 12, sessionDurationMs: 30 });
  assert.equal(implementer.observedModel, 'test-double');
});

test('CLI-reported model facts ignore subagent events and stay unknown when ambiguous', () => {
  const stream = events([{ type: 'model.call_final_result', agentId: 'child', data: { model: 'child-model', result: 'success' } },
    { type: 'model.call_final_result', data: { model: 'main-model', result: 'success' } }, { type: 'result', exitCode: 0 }]);
  assert.equal(copilotStreamFacts(stream).observedModel, 'main-model');
  const mixed = events([{ type: 'model.call_final_result', data: { model: 'a', result: 'success' } }, { type: 'model.call_final_result', data: { model: 'b', result: 'success' } }]);
  assert.equal(copilotStreamFacts(mixed).observedModel, null);
  assert.deepEqual(copilotStreamFacts(mixed).observedModels, ['a', 'b']);
});

test('runner-started tool-assisted reviewers always admit repository hooks in prompt mode', () => {
  // Copilot CLI loads repository hooks in -p only in trusted folders unless this
  // is set; without them tool-assisted reviewers could read migration/runs.
  assert.equal(copilotEnv('reviewer-rules-read').GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS, 'true');
});

test('plugin hook uses PowerShell environment syntax for the plugin root', () => {
  const entry = readJSON(path.join(kitRoot, 'com.github.copilot/hooks/hooks.json')).hooks.preToolUse[0];
  assert.match(entry.bash, /\$\{PLUGIN_ROOT\}/);
  assert.match(entry.powershell, /\$env:PLUGIN_ROOT\/scripts\/migration_hook\.mjs/);
});

test('new installs fan out without dependency waits unless a unit typecheck needs translated dependencies', async t => {
  const template = readJSON(path.join(kitRoot, 'templates/migration-config.json'));
  assert.equal(template.dependencyOrder, 'auto'); assert.equal(template.concurrency, 1, 'one worker at a time until the computer is known to keep up'); assert.equal(template.fixPolicy, 'single-pass');
  assert.equal(waitsForDependencies({ dependencyOrder: 'auto', commands: { typecheck: null } }), false);
  assert.equal(waitsForDependencies({ dependencyOrder: 'auto', commands: { typecheck: ['tsc'] } }), true);
  assert.equal(waitsForDependencies({ commands: { typecheck: null } }), true, 'unset keeps the earlier behavior');
  const run = async order => {
    const f = prepare(t, { count: 3 }); Object.assign(f.config, { concurrency: 3, dependencyOrder: order }); f.config.commands.typecheck = null;
    await approved(f);
    const trace = [];
    await translate(f.root, f.config, async args => {
      trace.push(`${args.role}:${path.basename(args.unit.target)}`);
      if (args.role === 'implementer' && args.unit.target.includes('math_ops')) await delay(150);
      return fake(args);
    });
    return trace;
  };
  const free = await run('auto'), ordered = await run('reviewed');
  assert.ok(free.indexOf('implementer:main.mjs') < free.indexOf('reviewer-semantics:math_ops.mjs'), free.join(' '));
  assert.ok(ordered.indexOf('implementer:main.mjs') > ordered.indexOf('reviewer-rules:math_ops.mjs'), ordered.join(' '));
});

test('configuration rejects unknown scheduling values, none with typecheck and concurrency above 64', t => {
  const f = prepare(t);
  for (const [patch, pattern] of [[{ dependencyOrder: 'later' }, /dependencyOrder must be/], [{ dependencyOrder: 'none' }, /cannot be combined with a per-unit typecheck/],
    [{ fixPolicy: 'twice' }, /fixPolicy must be/], [{ concurrency: 65 }, /Invalid concurrency/]]) {
    writeJSON(safePath(f.root, 'migration/config.json'), { ...f.config, ...patch });
    assert.throws(() => loadConfig(f.root), pattern);
  }
  writeJSON(safePath(f.root, 'migration/config.json'), { ...f.config, concurrency: 64 });
  assert.equal(loadConfig(f.root).concurrency, 64);
});

test('fixPolicy single-pass: one fix of the confirmed findings completes on the original two reviews', async t => {
  const f = prepare(t); f.config.fixPolicy = 'single-pass'; f.config.commands.typecheck = null; await approved(f);
  const unit = f.units[0], fixed = `${result('implementer', unit).content}\n// fixed: floor division\n`, calls = [];
  const report = await translate(f.root, f.config, async args => {
    calls.push(args.role);
    if (args.role.startsWith('reviewer-')) return { ...await fake(args), result: result(args.role, unit, { findings: [finding] }) };
    if (args.role === 'fixer') return { ...await fake(args), result: result('fixer', unit, { content: fixed }) };
    return fake(args);
  });
  assert.equal(report.done, 1);
  // Two findings at one source line are still arbitrated: the same place is not agreement.
  assert.deepEqual(calls.sort(), ['arbiter', 'fixer', 'implementer', 'reviewer-rules', 'reviewer-semantics']);
  assert.equal(fs.readFileSync(safePath(f.root, unit.target), 'utf8'), fixed);
  const context = contextHash(f.root, f.config), state = unitState(f.root, unit);
  assert.equal(done(f.root, unit, context), true);
  assert.deepEqual(state.singlePass.confirmed, ['reviewer-rules:F1', 'reviewer-semantics:F1']);
  // The receipt binds the fix record: tampering revokes completion.
  const record = readJSON(safePath(f.root, state.singlePass.fix.path)); record.result.content += '// edited\n';
  writeJSON(safePath(f.root, state.singlePass.fix.path), record);
  assert.equal(done(f.root, unit, context), false);
});

test('fixPolicy single-pass flags an unchanged fix and keeps typecheck-only fixes under review', async t => {
  const f = prepare(t); f.config.fixPolicy = 'single-pass'; f.config.commands.typecheck = null; await approved(f);
  const unit = f.units[0];
  const error = await translate(f.root, f.config, async args => args.role.startsWith('reviewer-')
    ? { ...await fake(args), result: result(args.role, unit, { findings: [finding] }) } : fake(args)).catch(e => e);
  assert.match(error.message, /unchanged; confirmed findings remain open/);
  const g = prepare(t); g.config.fixPolicy = 'single-pass'; g.config.commands.typecheck = [process.execPath, '-e', 'process.exit(require("fs").readFileSync(process.argv[1], "utf8").includes("BROKEN") ? 1 : 0)', '{target}'];
  await approved(g);
  const roles = [];
  const report = await translate(g.root, g.config, async args => {
    roles.push(args.role);
    if (args.role === 'implementer') return { ...await fake(args), result: result('implementer', g.units[0], { content: '// BROKEN\n' }) };
    return fake(args);
  });
  assert.equal(report.done, 1);
  // The failing typecheck becomes the first fix; that fix is then reviewed.
  assert.deepEqual(roles.slice(0, 2), ['implementer', 'fixer']);
  assert.equal(roles.filter(r => r.startsWith('reviewer-')).length, 2, 'the typecheck fix is still reviewed');
  assert.equal(unitState(g.root, g.units[0]).singlePass, undefined);
});

test('failure guidance names rate limits and stdout authentication errors', async () => {
  const { failureGuidance } = await import('../lib/guidance.mjs');
  assert.equal(failureGuidance('Copilot implementer failed (exit 1): session.error rate_limit 429: Last error: 429 Rate limit exceeded').id, 'rate-limit');
  assert.equal(failureGuidance('Copilot implementer failed (exit 1): session.error authentication 401: Authentication failed with provider').id, 'copilot-auth');
});

test('installer records the chosen fix policy and refuses the removed native backend', async t => {
  const { install } = await import('../scripts/install.mjs');
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-policies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'm', fixPolicy: 'single-pass' });
  const config = readJSON(path.join(root, 'migration/config.json'));
  assert.equal(config.fixPolicy, 'single-pass'); assert.equal(config.dependencyOrder, 'auto'); assert.equal(config.workerBackend, 'copilot-cli');
  assert.equal(fs.readdirSync(path.join(root, '.github/agents')).some(n => n.includes('-native-')), false);
  assert.throws(() => install(root, { model: 'm', workerBackend: 'native' }), /native worker backend was removed/);
  assert.throws(() => install(root, { model: 'm', fixPolicy: 'never' }), /fixPolicy must be/);
});
