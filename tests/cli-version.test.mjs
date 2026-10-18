import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, ready, cliDouble } from './helpers.mjs';
import { safePath, atomicWrite, readJSON, roles } from '../lib/core.mjs';
import { translate } from '../lib/pipeline.mjs';
import { runtimeLayout } from '../lib/runtime.mjs';
import { assistedReviewerRoles } from '../lib/review.mjs';
import { copilotArgs, copilotEnv, createCopilotAdapter, probeAgentName, requiredCopilotFlags } from '../scripts/copilot_adapter.mjs';
import { doctor } from '../scripts/run_migration.mjs';

const write = (f, name, value) => atomicWrite(safePath(f.root, name), value);

test('workers follow the user CLI: no auto-update pinning in arguments or environment', () => {
  for (const role of roles) assert.ok(!copilotArgs(role, 'chosen-model').includes('--no-auto-update'));
  const saved = process.env.COPILOT_AUTO_UPDATE;
  delete process.env.COPILOT_AUTO_UPDATE;
  try { assert.equal('COPILOT_AUTO_UPDATE' in copilotEnv('implementer'), false); }
  finally { if (saved !== undefined) process.env.COPILOT_AUTO_UPDATE = saved; }
});

// A CLI double that reports a configurable agent list for an unknown --agent.
function agentCli(f, available) {
  const file = safePath(f.root, 'agent-cli.mjs');
  write(f, 'agent-cli.mjs', `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('GitHub Copilot CLI 9.9.9.'); process.exit(0); }
if (argv.includes('--help')) { console.log(${JSON.stringify(requiredCopilotFlags(runtimeLayout(f.root, f.config)).join(' '))}); process.exit(0); }
const agent = argv[argv.indexOf('--agent') + 1];
console.error('No such agent: ' + agent + ', available: ' + ${JSON.stringify(available.join(', '))});
process.exit(1);
`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('doctor proves every worker agent resolves and names the missing ones', async t => {
  const f = prepare(t), ids = [...roles, ...assistedReviewerRoles, 'surveyor'].map(role => `migration-${role}`);
  const ok = await doctor(f.root, f.config, { checkCLI: true, command: agentCli(f, ['other', ...ids]) });
  const passed = ok.checks.find(c => c.check === 'worker agents resolve');
  assert.equal(passed.ok, true); assert.deepEqual(passed.missing, []);
  const report = await doctor(f.root, f.config, { checkCLI: true, command: agentCli(f, ids.filter(id => id !== 'migration-fixer')) });
  const failed = report.checks.find(c => c.check === 'worker agents resolve');
  assert.equal(failed.ok, false); assert.deepEqual(failed.missing, ['migration-fixer']);
  assert.equal(report.ok, false);
});

test('doctor fails the agent check when the CLI does not report an agent list', async t => {
  const f = prepare(t), file = safePath(f.root, 'silent-cli.mjs');
  write(f, 'silent-cli.mjs', `#!/usr/bin/env node
console.log(${JSON.stringify(requiredCopilotFlags().join(' '))});\n`);
  fs.chmodSync(file, 0o755);
  const check = (await doctor(f.root, f.config, { checkCLI: true, command: file })).checks.find(c => c.check === 'worker agents resolve');
  assert.equal(check.ok, false); assert.match(check.detail, /did not report its agent list/);
  assert.ok(!probeAgentName.startsWith('migration-'));
});

test('a CLI version change during translation warns, is recorded, and does not stop the run', async t => {
  const f = await ready(t), transport = cliDouble(f);
  write(f, 'versioned-cli.mjs', `import fs from 'node:fs';
if (process.argv.includes('--version')) {
  const n = fs.existsSync('version-count') ? Number(fs.readFileSync('version-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('version-count', String(n));
  console.log('GitHub Copilot CLI ' + (n === 1 ? '1.0.0' : '1.0.1') + '.');
  process.exit(0);
}
await import(${JSON.stringify(transport.prefixArgs[0])});
`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [safePath(f.root, 'versioned-cli.mjs')] });
  const errors = [], original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let report;
  try { report = await translate(f.root, f.config, adapter); } finally { console.error = original; }
  assert.equal(report.done, 1);
  assert.deepEqual(report.cliVersions, ['1.0.0', '1.0.1']);
  assert.deepEqual(report.warnings, ['Copilot CLI version changed during this run: 1.0.0 -> 1.0.1']);
  assert.equal(errors.filter(e => e.includes('version changed')).length, 1);
  assert.deepEqual(readJSON(safePath(f.root, `migration/runs/${report.runId}/summary.json`)).cliVersions, ['1.0.0', '1.0.1']);
});

test('an unreadable CLI version is recorded as unknown without blocking workers', async t => {
  const f = await ready(t), transport = cliDouble(f);
  write(f, 'no-version-cli.mjs', `if (process.argv.includes('--version')) process.exit(3);\nawait import(${JSON.stringify(transport.prefixArgs[0])});\n`);
  const report = await translate(f.root, f.config, createCopilotAdapter({ command: process.execPath, prefixArgs: [safePath(f.root, 'no-version-cli.mjs')] }));
  assert.equal(report.done, 1);
  assert.equal(report.cliVersions, undefined);
  assert.match(report.warnings[0], /version unknown/);
});
