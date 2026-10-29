// SPDX-License-Identifier: Apache-2.0
// 0.23.0: preparation audits and reviews get one repair round in every mode, as
// upstream 02 ("revise once and resubmit; still contested, the row is UNKNOWN").
// Without this rule a normal-mode 00b–02 review looped fix → re-review for hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const kit = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(kit, file), 'utf8').replace(/\s+/g, ' ');

test('every instruction copy limits preparation audits to one repair round in every mode and reports what remains', () => {
  for (const file of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = read(file);
    assert.match(text, /In every mode an audit or independent review \(00b\/01\/02, the source-as-spec package review included\) gets one repair round, as upstream/, file);
    assert.match(text, /re-audit only the fixed items once with a fresh request\. Never a third round: a row still contested becomes UNKNOWN/, file);
    assert.match(text, /Report the fixed findings, the open ones with evidence and the rows made UNKNOWN \(with counts\) in the phase report; the person decides at the gate, not mid-phase \(in auto mode the same list goes into the record's note and the run continues\)/, file);
    assert.match(text, /fix the confirmed ones, re-audit only the fixed items once with a fresh request\)/, file);
  }
  for (const file of ['.github/agents/migration-orchestrator.agent.md', 'com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md']) {
    const text = read(file);
    assert.match(text, /In every mode a preparation audit or independent review that returns changes gets one fix and one fresh re-audit of the fixed items, as upstream/, file);
    assert.match(text, /is never fixed again; the phase report lists the fixed findings, the open ones with their evidence and the UNKNOWN counts, and the person decides at the gate/, file);
    assert.match(text, /Inside a phase ask nothing either: an audit or review that returns changes gets one fix and one fresh re-audit of the fixed items/, file);
  }
  const audits = read('docs/PREPARATION-AUDITS.md');
  assert.match(audits, /## One repair round \(all modes\)/);
  assert.match(audits, /gets one repair round in every mode: confirm each finding against the source, fix the confirmed ones, and re-audit only the fixed items once/);
  assert.match(audits, /Report every open item to the person in the phase report: the findings fixed, the findings still open with their evidence, and the rows made UNKNOWN this way \(with counts\)/);
  assert.doesNotMatch(audits, /until no confirmed issue remains/, 'the comparator audit must not loop');
  assert.doesNotMatch(audits, /Reconcile and re-audit before completing 02/, 'the joint audit is not re-run, as upstream');
  assert.match(audits, /the joint audit is not run again/);
  assert.match(audits, /Sampling ends after a clean round or after three rounds/, 'a hand-written graph keeps its three rounds');
  assert.match(read('docs/PHASE-HANDOFF.md'), /In every mode a preparation audit or independent review that returns `changes` gets one repair round, as upstream/);
  assert.match(read('prompts/00b-judge-setup.md'), /re-audit the repaired assertions once with fresh contexts; report weaknesses still confirmed after that one round as open limitations/);
  const inventory = read('prompts/02-gap-inventory.md');
  assert.match(inventory, /re-audit the fixed rows once; a row still contested after that one round becomes UNKNOWN/);
  assert.match(inventory, /re-review only the fixed items once \(one repair round; what is still contested becomes UNKNOWN or an open finding, never fixed again\)/);
  assert.match(read('docs/SOURCE-AS-SPEC.md'), /直した箇所だけを1回だけ\*\*新しい依頼で再レビューする（フォーク元と同じく修正は1回まで。どのモードでも同じ）/);
  assert.match(read('docs/SOURCE-AS-SPEC.en.md'), /re-review \*\*only the fixed items, once\*\*, with a fresh request \(one repair round as upstream, in every mode\)/);
});

test('the auto-mode sections point to the every-mode rule, and no 00b-02 text keeps an open-ended loop', () => {
  assert.match(read('docs/ORDERED-WORKFLOW.md'), /直した箇所だけを新しい依頼で再監査します（この修正1回の規則はどのモードでも同じです。\[準備監査\]\(PREPARATION-AUDITS\.md#one-repair-round-all-modes\)）/);
  assert.match(read('docs/ORDERED-WORKFLOW.en.md'), /re-audit only the fixed items once with a fresh request \(this one-round rule applies in every mode; see \[preparation audits\]\(PREPARATION-AUDITS\.md#one-repair-round-all-modes\)\)/);
  assert.match(read('prompts/02-gap-inventory.md'), /the findings fixed in the repair round, open findings with their evidence\) and choices: proceed to migration \(recommended\), revise, pause \(in auto mode, put the same list into the record's note/);
  const loops = /until no confirmed issue remains|Reconcile and re-audit before completing|repair and re-audit with fresh contexts\. Mutation|fix its findings, then show ONE/;
  const files = ['docs', 'prompts', 'skills', '.github', 'com.github.copilot'].flatMap(dir => fs.readdirSync(path.join(kit, dir), { recursive: true }).map(f => path.join(dir, String(f))))
    .filter(f => f.endsWith('.md') && fs.statSync(path.join(kit, f)).isFile());
  assert.ok(files.length > 20);
  for (const file of files) assert.doesNotMatch(read(file), loops, file);
});

test('the phase-handoff link to the one-repair-round section resolves', () => {
  const audits = fs.readFileSync(path.join(kit, 'docs/PREPARATION-AUDITS.md'), 'utf8');
  assert.match(read('docs/PHASE-HANDOFF.md'), /\(PREPARATION-AUDITS\.md#one-repair-round-all-modes\)/);
  const slugs = audits.split('\n').filter(l => /^#+ /.test(l)).map(l => l.replace(/^#+ /, '').toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'));
  assert.ok(slugs.includes('one-repair-round-all-modes'), slugs.join(', '));
});
