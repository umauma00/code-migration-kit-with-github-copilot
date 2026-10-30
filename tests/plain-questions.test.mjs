import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxQuestion } from '../lib/sandbox.mjs';
import { planPilot } from '../lib/pilot.mjs';

// The person answering a question knows nothing about the kit (docs/PHASE-HANDOFF.md,
// "Write every question for someone who knows nothing about the kit"). Kit-owned
// Japanese choice labels and examples are held to it here: no kit terms, setting
// keys or command lines. Product names stay; a term may follow the everyday
// words in parentheses; the person's own host input (/sandbox off) is named exactly.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const japanese = /[぀-ヿ一-鿿]/;
export function jargon(text) {
  const rest = text.replace(/\$\{[^}]*\}/g, '').replace(/（[^（）]*）|\([^()]*\)/g, '')
    .replaceAll('/sandbox off', '').replace(/Copilot CLI|Copilot|GitHub|VS Code|\bCLI\b|\bAI\b/g, '');
  return [...new Set(rest.match(/--?[a-z][\w-]*|[A-Za-z][A-Za-z_.]{2,}|\b[a-z]+[A-Z]\w*/g) ?? [])];
}

test('the plainness check itself catches kit terms and commands', () => {
  for (const bad of ['translation-only pilot を実行する', 'grant を失効して target を片付ける', '--max-files を小さくする', 'maxFixRounds を増やす', 'judge からやり直す'])
    assert.notDeepEqual(jargon(bad), [], bad);
  for (const ok of ['26 ファイルで試運転する', '自動で進めるモード（autopilot）をやめる', 'このセッションのチャット入力欄に /sandbox off と入力する', 'Copilot CLI を更新する', `工程 \${id} を終えずに進む`])
    assert.deepEqual(jargon(ok), [], ok);
});

test('every Japanese choice label in the failure guidance is plain', () => {
  const source = read('lib/guidance.mjs');
  const labels = [...source.matchAll(/label: (?:t\()?(['`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2]).filter(l => japanese.test(l));
  assert.ok(labels.length >= 90, `found ${labels.length} labels`);
  const bad = labels.map(l => [l, jargon(l)]).filter(([, words]) => words.length);
  assert.deepEqual(bad, []);
});

test('the sandbox setup question is plain in Japanese apart from the blocked paths it names', () => {
  const q = sandboxQuestion({ ok: false, blocked: [{ access: 'write', path: '/tmp', error: 'EPERM' }, { access: 'loopback', host: '127.0.0.1', error: 'EPERM' }] }, 'ja');
  for (const text of [q.question, ...q.choices.map(c => c.label)])
    assert.deepEqual(jargon(text.replaceAll('/tmp', '').replaceAll('127.0.0.1', '')), [], text);
});

test('the pilot plan sentence for the approval question is plain', () => {
  const source = read('lib/pilot.mjs');
  const sentence = source.match(/ja: `([^`]*)`/)[1];
  assert.deepEqual(jargon(sentence.replace(/\$\{[^}]*\}/g, '')), []);
  assert.equal(typeof planPilot, 'function');
});

test('Japanese question and reply examples in the handoff contract are plain', () => {
  const doc = read('docs/PHASE-HANDOFF.md');
  const examples = [...doc.matchAll(/「([^「」\n]*)」|"([^"\n]*[぀-ヿ一-鿿][^"\n]*)"/g)].map(m => m[1] ?? m[2]);
  assert.ok(examples.length >= 8, `found ${examples.length} examples`);
  assert.deepEqual(examples.map(e => [e, jargon(e)]).filter(([, w]) => w.length), []);
});

test('the question rule is stated where the orchestrator reads it', () => {
  assert.match(read('docs/PHASE-HANDOFF.md'), /### Write every question for someone who knows nothing about the kit/);
  for (const rel of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md', '.github/agents/migration-orchestrator.agent.md', 'com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md'])
    assert.match(read(rel), /knows nothing about the kit/, rel);
  assert.match(read('docs/PLAIN-WORDS.md'), /\| grant \|/);
});
