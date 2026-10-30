// SPDX-License-Identifier: Apache-2.0
// 2026-10-30: in a phase 03 pilot the implementer of one file stalled the
// Copilot CLI every time ("Session host did not acknowledge ... delivery within
// 120s", once at tool.execution_start). The implementer was told to read the
// rulebook, the inventory and the dependencies with its own tools, so it opened
// large files itself. It now gets the evidence from the runner, as reviewers do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, result, fake, finding } from './helpers.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { safePath, writeJSON, atomicWrite } from '../lib/core.mjs';
import { createCopilotAdapter, agentPrompt } from '../scripts/copilot_adapter.mjs';
import { reviewEvidence } from '../lib/review.mjs';

async function approved(f) {
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Regression fixture only');
}

test('the runner hands the implementer and the fixer frozen evidence when it fits', async t => {
  const f = prepare(t), unit = f.units[0], seen = [];
  await approved(f);
  await translate(f.root, f.config, async args => {
    seen.push(args);
    if (args.role === 'reviewer-rules' && !seen.some(a => a.role === 'fixer')) return { result: result(args.role, args.unit, { findings: [finding] }) };
    if (args.role === 'arbiter') return { result: result(args.role, args.unit, { decisions: args.extra.findings.map(x => ({ finding: x.reference, confirmed: true, reason: 'Rule applies' })) }) };
    return fake(args);
  });
  for (const role of ['implementer', 'fixer']) {
    const call = seen.find(a => a.role === role);
    assert.ok(call, role);
    assert.equal(call.workMode, 'frozen', role);
    const input = JSON.parse(call.workInput);
    const paths = input.files.map(x => x.path);
    for (const name of ['migration/RULEBOOK.md', 'migration/inventory.tsv', unit.source]) assert.ok(paths.includes(name), `${role}: ${name}`);
    // Only this unit's inventory rows, never the whole inventory.
    const rows = input.files.find(x => x.path === 'migration/inventory.tsv').content.split('\n').filter(l => l && !l.startsWith('#')).slice(1);
    assert.ok(rows.every(r => input.sources.includes(r.split('\t')[0])), role);
    // The fixer sees its own candidate; the implementer gets none.
    assert.equal(input.files.find(x => x.path === unit.target).content === '', role === 'implementer', role);
  }
  // Reviewers are unchanged.
  assert.ok(seen.filter(a => a.role.startsWith('reviewer-')).every(a => a.workInput === undefined && typeof a.reviewInput === 'string'));
});

test('a frozen implementer prompt asks for no reads; an oversized one names the files and never the whole inventory', t => {
  const f = prepare(t), unit = f.units[0];
  const frozen = reviewEvidence(f.root, f.config, unit, null, { candidate: false });
  const prompt = agentPrompt({ role: 'implementer', unit, extra: { designInputs: [] }, workInput: frozen.text, workMode: 'frozen' });
  assert.match(prompt, /Use ONLY the frozen task input below/);
  assert.match(prompt, /No tools are available/);
  assert.doesNotMatch(prompt, /Read migration\/RULEBOOK\.md, relevant migration\/inventory\.tsv rows/);
  assert.ok(prompt.includes(frozen.text));
  const assisted = reviewEvidence(f.root, { ...f.config, maxReviewInputBytes: 700 }, unit, null, { candidate: false });
  assert.equal(assisted.mode, 'tool-assisted');
  const big = agentPrompt({ role: 'implementer', unit, extra: { designInputs: [] }, workInput: assisted.text, workMode: 'tool-assisted' });
  assert.match(big, /never view it whole/);
  assert.match(big, /Read nothing else/);
  assert.ok(big.includes(assisted.text));
  // Without runner evidence (the fold benchmark), the old instructions stay.
  assert.match(agentPrompt({ role: 'implementer', unit, extra: { designInputs: [] } }), /Read migration\/RULEBOOK\.md/);
});

test('a frozen implementer runs without file tools; an oversized one keeps read-only tools', async t => {
  // 700 bytes: the implementer's evidence (no candidate) no longer fits frozen.
  for (const [limit, mode] of [[undefined, 'frozen'], [700, 'tool-assisted']]) {
    const f = prepare(t); if (limit) f.config.maxReviewInputBytes = limit;
    await approved(f);
    const unit = f.units[0], log = safePath(f.root, 'argv.jsonl'), script = safePath(f.root, 'argv-cli.mjs');
    const responses = Object.fromEntries(['implementer', 'reviewer-semantics', 'reviewer-rules', 'reviewer-semantics-read', 'reviewer-rules-read'].map(role => [role, result(role.replace(/-read$/, ''), unit)]));
    atomicWrite(script, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
const role = process.env.MIGRATION_KIT_ROLE;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role, argv: process.argv.slice(2) }) + '\\n');
console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(responses)}[role]), toolRequests: [] } }));
console.log(JSON.stringify({ type: 'result', exitCode: 0 }));
`);
    // Only the implementer call matters here; later stages may stop on the tiny limit.
    await translate(f.root, f.config, createCopilotAdapter({ command: process.execPath, prefixArgs: [script] })).catch(() => {});
    const implementer = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(c => c.role === 'implementer');
    const denied = implementer.argv[implementer.argv.indexOf('--deny-tool') + 1];
    assert.equal(denied, mode === 'frozen' ? 'read,write,shell' : 'write,shell', mode);
    assert.equal(implementer.argv.includes('--allow-tool'), mode !== 'frozen', mode);
  }
});
