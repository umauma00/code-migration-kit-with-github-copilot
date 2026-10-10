import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, fake, ready } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, loadReviewDependencies, reviewSources, roles } from '../lib/core.mjs';
import { inventorySlice } from '../lib/review.mjs';
import { runStage, approve, translate } from '../lib/pipeline.mjs';
import { copilotArgs } from '../scripts/copilot_adapter.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { makeReviewDependencies } from '../scripts/make_review_dependencies.mjs';
import { createWorkflowDefinition } from '../lib/workflow.mjs';
import { runProcess } from '../lib/process.mjs';
import { kitRoot } from '../scripts/install.mjs';

const write = (f, p, data) => atomicWrite(safePath(f.root, p), data);
const edges = 'migration/depmap/edges.tsv';

test('rereview 1: every CLI role disables ambient instructions; doctor rejects an unsupported CLI', async t => {
  for (const role of roles) assert.ok(copilotArgs(role, 'chosen-model').includes('--no-custom-instructions'));
  const f = prepare(t), command = safePath(f.root, 'help-double');
  write(f, 'help-double', '#!/bin/sh\nprintf "%s\\n" "--agent --model --available-tools --deny-tool --output-format"\n');
  fs.chmodSync(command, 0o755);
  const check = (await doctor(f.root, f.config, { checkCLI: true, command })).checks.find(c => c.check === 'required flags');
  assert.equal(check.ok, false); assert.deepEqual(check.missing, ['--no-custom-instructions']);
});

test('rereview 1: workflow cancellation reaches the shared runner without calling the host SDK agent', async t => {
  const f = await ready(t, { workflow: true }), controller = new AbortController(), started = safePath(f.root, 'worker-started.json');
  write(f, 'slow-cli.mjs', "import fs from 'node:fs'; for await (const c of process.stdin) {} fs.writeFileSync('worker-started.json', JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000);\n");
  const running = createWorkflowDefinition(f.root, { command: process.execPath, prefixArgs: [safePath(f.root, 'slow-cli.mjs')] }).run({
    args: { stage: 'translate' }, signal: controller.signal, phase() {}, log() {}, agent() { assert.fail('SDK agent must not run'); }
  });
  const rejected = assert.rejects(running, /Interrupted/);
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(started), 'Worker must start before cancelling');
  } finally { controller.abort(); }
  await rejected;
  assert.throws(() => process.kill(readJSON(started).pid, 0), e => e.code === 'ESRCH');
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});
