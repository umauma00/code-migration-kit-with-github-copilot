import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxQuestion } from '../lib/sandbox.mjs';

// The person answering a question knows nothing about the kit (docs/PHASE-HANDOFF.md,
// "Write every question for someone who knows nothing about the kit"). Kit-owned
// Japanese choice labels and examples are held to it here: no kit terms, setting
// keys or command lines. Product names stay; a term may follow the everyday
// words in parentheses; the person's own host input (/sandbox off) is named exactly.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const japanese = /[぀-ヿ一-鿿]/;
// Kit words a person would not know, in katakana as well as in English.
const kitKatakana = /ゲート|マニフェスト|グラント|ターゲット|ランナー|レシート|インベントリ|ジャッジ/g;
// Inside parentheses a term may follow its everyday words, but never a command
// line, an option or a setting key.
const commandLike = /--?[a-z][\w-]*|\b(?:launchctl|ulimit|grep|sed|npm|git)\b|\b[a-z]+[A-Z]\w*|\b\w+\.\w+\b|\b[a-z]+_[a-z_]+\b|\b(?:node|run_migration|phase|approve|translate|pilot|survey|guardrails|doctor|status)\s+[a-z-]+/g;
export function jargon(text) {
  const bare = text.replace(/\$\{[^}]*\}/g, '').replaceAll('/sandbox off', '').replace(/macOS/g, '');
  const inside = [...bare.matchAll(/（([^（）]*)）|\(([^()]*)\)/g)].map(m => m[1] ?? m[2]).join(' ');
  const rest = bare.replace(/（[^（）]*）|\([^()]*\)/g, '').replace(/Copilot CLI|Copilot|GitHub|VS Code|\bCLI\b|\bAI\b/g, '');
  return [...new Set([...(rest.match(/--?[a-z][\w-]*|[A-Za-z][A-Za-z_.]{2,}|\b[a-z]+[A-Z]\w*/g) ?? []),
    ...(bare.match(kitKatakana) ?? []), ...(inside.match(commandLike) ?? [])])];
}

test('the plainness check itself catches kit terms and commands', () => {
  for (const bad of ['translation-only pilot を実行する', 'grant を失効して target を片付ける', '--max-files を小さくする', 'maxFixRounds を増やす', 'judge からやり直す',
    '承認などのゲート以外の選択', '免除する（guardrails install --waiver）', '上限を増やす（maxAgentCalls）', '範囲を細かくする（--max-files）'])
    assert.notDeepEqual(jargon(bad), [], bad);
  for (const ok of ['26 ファイルで試運転する', '自動で進めるモード（autopilot）をやめる', 'このセッションのチャット入力欄に /sandbox off と入力する', 'Copilot CLI を更新する', `工程 \${id} を終えずに進む`])
    assert.deepEqual(jargon(ok), [], ok);
});

test('every Japanese choice label in the failure guidance is plain', () => {
  const source = read('lib/guidance.mjs');
  // Plain strings, t('ja', ...) and builders such as m => t(`ja ${m[1]}`, ...).
  const labels = [...source.matchAll(/label: (?:(?:\([^)]*\)|\w+) => )?(?:t\()?(['`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2]).filter(l => japanese.test(l));
  assert.ok(labels.length >= 100, `found ${labels.length} labels`);
  const bad = labels.map(l => [l, jargon(l)]).filter(([, words]) => words.length);
  assert.deepEqual(bad, []);
});

test('the sandbox setup question is plain in Japanese apart from the blocked paths it names', () => {
  const q = sandboxQuestion({ ok: false, blocked: [{ access: 'write', path: '/tmp', error: 'EPERM' }, { access: 'loopback', host: '127.0.0.1', error: 'EPERM' }] }, 'ja');
  for (const text of [q.question, ...q.choices.map(c => c.label)])
    assert.deepEqual(jargon(text.replaceAll('/tmp', '').replaceAll('127.0.0.1', '')), [], text);
});

test('the pilot plan sentences for the approval question are plain in both languages', () => {
  const source = read('lib/pilot.mjs');
  // Every sentence of the plan (the file count with and without the files they
  // use, the auto-mode note and the whole sentence), and the branches that sit
  // inside \${...} as quoted strings. A single word in quotes is a compared
  // value ('translation'), not a sentence.
  const ja = [...source.matchAll(/ja: `([^`]*)`/g)].map(m => m[1]), en = [...source.matchAll(/en: `([^`]*)`/g)].map(m => m[1]);
  assert.ok(ja.length >= 4 && en.length >= 4, 'every sentence is found');
  const branches = text => [...text.matchAll(/'((?:\\.|[^'])*)'/g)].map(m => m[1]).filter(b => !/^[\w-]+$/.test(b));
  assert.ok(ja.flatMap(branches).length >= 3 && en.flatMap(branches).length >= 3, 'every branch is found');
  for (const part of [...ja, ...ja.flatMap(branches)]) assert.deepEqual(jargon(part), [], part);
  for (const part of [...en, ...en.flatMap(branches)]) assert.doesNotMatch(part.replace(/\$\{[^}]*\}/g, ''), /grant|target|translation-only|manifest|judge|boundary|scope/i, part);
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
