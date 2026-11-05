// SPDX-License-Identifier: Apache-2.0
// The migration's settings, in the one file the person changes:
// migration/settings.json (named migration/run-settings.json from 0.9.0 to
// 0.44.x; the next command renames it). The first choices are asked as
// questions and recorded there; a later change is an edit of the file.
//
// The kit keeps its own record of what it applied in migration/state/
// (config.json and preferences.json, which the runner, the hooks and the
// approval records read). Until 0.44.x they were migration/config.json and
// migration/preferences.json, beside the file, where they looked like more
// settings files: the next command that does work moves them (moveRecords),
// unchanged, so every record made under them stays current. Every such
// command starts by bringing the file and the records together
// (settingsAtStart): an edit of the file is applied (every entry checked
// first; nothing is written unless all pass), and a change made on the other
// side (models set, preferences, source-spec, or a hand edit of a record) is
// copied into the file instead of being undone. Which side changed is told by
// migration/state/settings-applied.json, the values as they were the last
// time both sides agreed. Switching to auto mode is the one change that waits
// for settings apply, which the host confirms.
//
// `settings init` writes the file from the configuration and, beside it,
// migration/settings.help.md with the explanations and the account's models
// as choices (the file holds only values, so it stays small).
import fs from 'node:fs';
import path from 'node:path';
import { safePath, writeJSON, atomicWrite, roles, effortLevels, contextTiers, loadConfig, operationalConfigKeys, lockRun, configFile, legacyConfigFile, configFileOf, settingsEffect } from './core.mjs';
import { readPreferences, setPreferences, userLanguages, originalRuntimes, phaseModes, specifications, preferencesFile, legacyPreferencesFile, preferencesFileOf } from './preferences.mjs';
import { renameRetry } from './text.mjs';
import { recordContextUpgrade } from './context-upgrade.mjs';
import { autoModeFile, autoModeRecord, autoModeOn } from './auto-mode.mjs';
import { orderedPhases } from './phases.mjs';
import { checkChoice, checkAssignments, readConfigIfPresent } from './models.mjs';
import { detectSourceLanguages, languageQuestion, canonicalLanguage } from './source-detect.mjs';
import { workerHomeDefault } from './worker-home.mjs';
import { defaultWorkerSilenceSeconds, defaultWorkerCallMinutes } from './execution-policy.mjs';

export const settingsFile = 'migration/settings.json';
export const settingsHelpFile = 'migration/settings.help.md';
// The names 0.9.0 to 0.44.x used.
export const legacySettingsFile = 'migration/run-settings.json';
export const legacySettingsHelpFile = 'migration/run-settings.help.md';
// The values as they were when the file and the configuration last agreed.
export const settingsBaseFile = 'migration/state/settings-applied.json';
export const fillIn = 'FILL_IN';
export const sameAsImplementer = 'same-as-implementer';
const modelRoles = [...roles, 'surveyor'];
const modes = ['preserve', 'redesign'], verificationModes = ['runtime', 'source-only'], executionModes = ['continuous', 'bounded'];
// The settings the person decides, in the order the file shows them.
const preferenceKeys = ['reportLanguage', 'originalRuntime', 'phaseMode'];
const configKeys = ['sourceLanguage', 'targetLanguage', 'mode', 'sourceRoots', 'outputRoots', 'verificationRoots', 'verificationMode', 'executionMode', 'concurrency', 'commands'];
// Settings few people change, shown after the _advanced line. Before 0.45.0
// they were only in the configuration record; a file without them keeps their values.
const advancedKeys = ['workerCopilotHome', 'workerSilenceSeconds', 'workerCallMinutes', 'maxReviewInputBytes', 'verificationInputs', 'buildArtifactRoots', 'designInputs', 'packageMap', 'sourceEncoding',
  'dependencyOrder', 'fixPolicy', 'reviewFocus', 'auditModels', 'transientRetries', 'transientRetryDelayMs', 'maxConsecutiveFailures',
  'maxFixRounds', 'maxAgentCalls', 'maxRunInputBytes', 'maxAiCreditsPerCall', 'timeoutSeconds', 'commandTimeoutSeconds'];
const settingKeys = ['schemaVersion', ...preferenceKeys, ...configKeys, 'models', ...advancedKeys];
// The rest of the configuration record is the kit's own (schemaVersion, runtime,
// phasePolicy, markerPolicy, reviewDependencyMap, preparationProfile,
// executionPurpose, pilot, workerBackend): commands set those.
const auditNames = ['rulebook', 'judgeAudit', 'dependencyAudit', 'inventoryAudit', 'stressA', 'stressB', 'stressInspector', 'designAudit'];
// Template defaults are examples, not choices: before a manifest exists, a
// fresh file asks for the languages instead of offering the example pair.
const templateLanguages = { sourceLanguage: 'Python', targetLanguage: 'JavaScript' }, templateRoots = ['src'];
// Editors on Windows may save a byte order mark; JSON.parse rejects it.
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
// What the kit uses when the record leaves a key out. The file shows it, and
// writing it back unchanged must not add the key (that would change the
// reviewed configuration). null: not set, so the key stays out.
const configDefaults = { verificationMode: 'runtime', executionMode: 'continuous', commands: {},
  workerCopilotHome: workerHomeDefault, workerSilenceSeconds: defaultWorkerSilenceSeconds, workerCallMinutes: defaultWorkerCallMinutes, maxReviewInputBytes: 65536, verificationInputs: [], buildArtifactRoots: [], designInputs: [],
  packageMap: null, sourceEncoding: null, dependencyOrder: 'reviewed', fixPolicy: 'rereview', reviewFocus: 'specialized',
  transientRetries: null, transientRetryDelayMs: 5000, maxConsecutiveFailures: 3, maxRunInputBytes: null, maxAiCreditsPerCall: null };
const unsetWhenNull = new Set(['packageMap', 'sourceEncoding', 'transientRetries', 'maxRunInputBytes', 'maxAiCreditsPerCall']);
// Key order is not a change: an object rewritten in another order compares equal.
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const unfilled = value => typeof value === 'string' && /FILL_IN|SELECT_MODEL/.test(value);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const help = {
  ja: {
    _about: `移行の設定はこのファイルだけで変えます。書き換えると、次にキットのコマンドを始めるときに反映されます（status など読むだけのものを除く）。各欄の説明と選択肢（使えるモデルなど）は ${settingsHelpFile} にあります。\`_\` で始まる欄は読み込みで無視します。`,
    _advanced: 'ここから下は細かい設定です。ふつうは変えません。null は「指定なし（キットの既定）」です。',
    reportLanguage: '報告の言語。ja か en。',
    originalRuntime: '移行元のコードをこの環境で実行できるか。available か unavailable。',
    phaseMode: '工程の進め方。normal は前提が揃うまで次の工程に進まない（推奨）。relaxed は前提が足りなくても警告して「直す／進む」を毎回聞き、進んだ工程は見送りとして記録する。auto は relaxed を人に聞かずに進める（Copilot CLI の autopilot 向け。工程の完了・承認・見送りを自動で記録し、自動の印を付ける。上流の規則3「承認ゲートで止まる」に従わない）。切り替えても承認や完了記録は消えない。auto への切り替えだけは、ほかの変更と違い settings apply で反映する（確認が出る）。',
    sourceLanguage: '移行元の言語（例: C#、Java、COBOL）。', targetLanguage: '移行先の言語（例: TypeScript、Go）。',
    mode: 'preserve は動作をそのまま移す、redesign は設計を変える。',
    sourceRoots: '移行元のフォルダー（リポジトリからの相対パスの配列）。', outputRoots: '移行先のコードを書くフォルダー。', verificationRoots: '動作確認に使うテストのフォルダー。',
    verificationMode: 'runtime は元のコードを実行して比べる、source-only は実行できないときにソースだけで確かめる。',
    executionMode: 'continuous は終わるまで続ける、bounded は下の細かい設定の上限（maxAgentCalls など）で止める。', concurrency: '同時に動かすワーカーの数（1〜64）。変えても承認や完了記録は消えない。',
    commands: '各段階のコマンド。null か、["コマンド", "引数", ...] の配列。',
    models: '最初の質問で選んだモデルが全担当に入っています。担当ごとに変えたいときだけ書き換えます。モデル ID は下の「使えるモデル」から選ぶ。エフォートは default か、そのモデルの efforts のどれか。context は default か、そのモデルの contexts にあるときだけ long_context（料金が上がります）。surveyor の model に same-as-implementer を書くと implementer と同じになり、そのときの default は implementer のエフォート・コンテキスト。',
    workerCopilotHome: '変換・レビューを担当する Copilot CLI を動かす置き場所。shared はふだんの ~/.copilot、separate は隣の ~/.copilot-migration-kit-workers（会話の記録を分ける）。',
    workerSilenceSeconds: '作業役の AI 呼び出しが何も出力しない（文章・考え中の内容・イベントのどれも届かない）まま、この秒数たったら、その呼び出しを止めてやり直す（秒、300〜86400。0 は見張らない）。期限ではないので、何か出し続ける呼び出しは止めない。変えても承認や完了記録は消えない。',
    workerCallMinutes: '変換の AI 呼び出し（実装役・修正役・レビュー役・仲裁役）1回が動いてよい時間（分、10〜1440。0 は止めない）。その単位のソース・いまある移行先・RULEBOOK・設計文書の大きさ 8 KiB ごとに1分を足す。無反応の見張りが有効なら、出力が2分以上途切れている間は数えない（その間は無反応の見張りが見る）。過ぎても答えを返さない呼び出しは止めて1回だけやり直し、それでも返さなければそのファイルをその実行では後回しにして、ほかのファイルへ進む。変えても承認や完了記録は消えない。0.46.1 以前のキットでも開くプロジェクトでは、先にすべてを 0.47.0 以降にしてから変える（古いキットは完了済みのファイルをすべてやり直しにする）。',
    maxReviewInputBytes: '1回の AI 呼び出しに本文ごと渡す入力の上限（バイト、1024〜4194304）。変換では実装役・修正役・レビュー役に効き、その単位のソースと移行先・依存の連鎖にあるファイル全部・ルールブック・設計入力を合わせた大きさで比べる。超えた単位は、ファイルの一覧を渡してツールで読ませる方式になる（その単位のファイルは全部、依存は使うところだけ読む）。準備の監査と調査の入力にも同じ上限を使う。担当モデルの入力上限（models list のコンテキスト）より小さくする。',
    verificationInputs: '変更を追跡する追加のファイル（ビルド設定・依存設定など）。リポジトリからの相対パスの配列。',
    buildArtifactRoots: 'コマンドが生成物を書くフォルダー（入力として追跡しない）。',
    designInputs: '全文をレビューに渡し、変更から守る設計文書のパスの配列。',
    packageMap: '移行元から移行先へのパッケージ対応表（migration/ の下の JSON）。null は使わない。',
    sourceEncoding: '移行元のファイルの文字コード（shift_jis、euc-jp、windows-1252 など）。null は自動で判定。',
    dependencyOrder: 'auto は単位ごとの型チェックがあるときだけ依存先のレビューを待つ、reviewed はいつも待つ、none は待たない。',
    fixPolicy: 'single-pass は指摘の修正を1回で終え、ビルド・比較で確かめる。rereview は直したら指摘がなくなるまでレビューし直す。',
    reviewFocus: 'shared は2人のレビュー担当がどちらも両方の観点を確かめる、specialized は1人1観点。',
    auditModels: `準備監査ごとのモデル（${auditNames.join('、')} をモデル名に対応させる）。{} はキットの既定。`,
    transientRetries: '一時的な失敗の再試行回数（bounded のときだけ、0〜10）。null は既定（bounded は2回、continuous は回数で打ち切らない）。',
    transientRetryDelayMs: '再試行までの最初の待ち時間（ミリ秒）。倍々に延び、最大60秒。',
    maxConsecutiveFailures: 'bounded のとき、続けてこの回数失敗したら新しい単位を始めない（1〜1000）。',
    maxFixRounds: 'bounded のときの1単位の修正回数の上限（0〜10）。',
    maxAgentCalls: 'bounded のときの1回の実行の AI 呼び出し数の上限（1〜10000）。',
    maxRunInputBytes: 'bounded のときの1回の実行で AI に渡す入力の合計の上限（バイト）。null は上限なし。',
    maxAiCreditsPerCall: 'bounded のとき各呼び出しに渡す AI クレジットの上限（30以上）。null は渡さない。',
    timeoutSeconds: 'bounded のときの1回の AI 呼び出しの時間上限（秒、0は期限なし）。',
    commandTimeoutSeconds: 'bounded のときのビルド・比較の時間上限（秒、0は期限なし）。'
  },
  en: {
    _about: `Change the migration's settings in this file only. An edit takes effect when the next kit command starts (other than read-only ones such as status). Each field's explanation and choices (such as the available models) are in ${settingsHelpFile}. Fields starting with \`_\` are ignored when reading.`,
    _advanced: 'Below are detailed settings, rarely changed. null means not set (the kit\'s default).',
    reportLanguage: 'Report language: ja or en.',
    originalRuntime: 'Whether the original code can run here: available or unavailable.',
    phaseMode: 'How phases advance. normal waits until each phase\'s prerequisites are met (recommended). relaxed warns when one is missing, asks "fix or proceed" every time, and records a phase you proceed past as waived. auto is relaxed without asking (for Copilot CLI autopilot: phase completions, approvals and waivers are recorded unasked and marked auto; upstream rule 3, stop at sign-off gates, is not followed). Switching never revokes approvals or completion records. Unlike other changes, switching to auto takes effect through settings apply, which asks first.',
    sourceLanguage: 'Language migrated from (for example C#, Java, COBOL).', targetLanguage: 'Language migrated to (for example TypeScript, Go).',
    mode: 'preserve keeps the behavior; redesign changes the design.',
    sourceRoots: 'Source folders (array of repository-relative paths).', outputRoots: 'Folders the migrated code is written to.', verificationRoots: 'Test folders used to check behavior.',
    verificationMode: 'runtime runs the original to compare; source-only checks from the source alone when it cannot run.',
    executionMode: 'continuous runs until done; bounded stops at the limits among the detailed settings below (maxAgentCalls and others).', concurrency: 'Workers running at once (1-64). Changing it keeps approvals and completion records.',
    commands: 'Command for each stage: null, or an array ["command", "arg", ...].',
    models: 'Every role holds the model chosen in the first question; change a role only to differ. Pick model IDs from the available models below. Effort is default or one of that model\'s efforts. Context is default, or long_context when that model\'s contexts list it (it costs more). A surveyor model of same-as-implementer follows the implementer, and its default then means the implementer\'s effort and context.',
    workerCopilotHome: 'Where the Copilot CLI of the translating and reviewing workers runs: shared is your own ~/.copilot; separate is ~/.copilot-migration-kit-workers beside it (keeps their sessions apart).',
    workerSilenceSeconds: 'Seconds a worker call may write nothing (no text, reasoning or event) before it is stopped and retried (300-86400; 0: never). It is not a deadline: a call that keeps writing is never stopped. Changing it keeps approvals and completion records.',
    workerCallMinutes: 'Minutes one translation call (implementer, fixer, reviewer or arbiter) may run (10-1440; 0: never stopped), plus one minute for every 8 KiB of the unit\'s source, current target, RULEBOOK and design inputs. While the silence check is on, time after 2 minutes without output is left to it and not counted. A call still without an answer then is stopped and tried once more; when that one runs past it too, its file is set aside for the run and the other files go on. Changing it keeps approvals and completion records. Where a kit before 0.47.0 also opens the project, update every one to 0.47.0 first (an older kit treats every finished file as not done).',
    maxReviewInputBytes: 'Largest input sent with its full text to one AI call (bytes, 1024-4194304). In translation it applies to the implementer, fixer and reviewers and counts the unit\'s source and target, every file of its dependency chain, the rulebook and the design inputs together. A larger unit gets a list of the files to read with tools instead (its own files whole, its dependencies only where it uses them). Preparation audits and surveys use the same limit for their inputs. Keep it below the input limit of the workers\' models (the context column of models list).',
    verificationInputs: 'More files whose changes are tracked (build or dependency settings): repository-relative paths.',
    buildArtifactRoots: 'Folders the commands write their outputs to (not tracked as inputs).',
    designInputs: 'Design documents sent whole to reviews and protected from change: paths.',
    packageMap: 'Source-to-target package map (a JSON file under migration/). null: none.',
    sourceEncoding: 'Encoding of the source files (shift_jis, euc-jp, windows-1252...). null: detected.',
    dependencyOrder: 'auto waits for reviewed dependencies only when a per-unit typecheck needs them; reviewed always waits; none never waits.',
    fixPolicy: 'single-pass fixes the findings once and lets build and comparisons judge; rereview reviews a fix again until no finding remains.',
    reviewFocus: 'shared: both reviewers check both lenses; specialized: one lens each.',
    auditModels: `The model of each preparation audit (${auditNames.join(', ')} mapped to model names). {}: the kit's defaults.`,
    transientRetries: 'Retries of a transient failure (bounded only, 0-10). null: the default (2 when bounded; continuous never stops on a count).',
    transientRetryDelayMs: 'First wait before a retry (milliseconds); it doubles up to 60 s.',
    maxConsecutiveFailures: 'Bounded only: after this many failures in a row no new unit starts (1-1000).',
    maxFixRounds: 'Bounded only: fix rounds of one unit (0-10).',
    maxAgentCalls: 'Bounded only: AI calls of one run (1-10000).',
    maxRunInputBytes: 'Bounded only: total input sent to AI in one run (bytes). null: no limit.',
    maxAiCreditsPerCall: 'Bounded only: AI Credits cap passed to each call (at least 30). null: none.',
    timeoutSeconds: 'Bounded only: time limit of one AI call (seconds, 0: none).',
    commandTimeoutSeconds: 'Bounded only: time limit of builds and comparisons (seconds, 0: none).'
  }
};

// The surveyor's model lives under models; the other phase models are the audits'.
const auditModelsOf = config => Object.fromEntries(Object.entries(config.phaseModels ?? {}).filter(([k]) => k !== 'survey'));

// The file's values from the configuration as it stands, placeholders where
// nothing was chosen yet. shown: as a new file presents them, where the
// template's example languages are a question too; the reconcile compares
// the languages the record holds (an answer of the same pair is in step).
function currentValues(root, config, preferences, { shown = false } = {}) {
  const languagesUnchosen = shown && Object.entries(templateLanguages).every(([k, v]) => config[k] === v) && !fs.existsSync(safePath(root, 'migration/manifest.tsv'));
  const role = r => {
    if (r === 'surveyor' && !config.phaseModels?.survey) return { model: sameAsImplementer, effort: config.reasoningEfforts?.surveyor ?? 'default', context: config.contextTiers?.surveyor ?? 'default' };
    const model = r === 'surveyor' ? config.phaseModels.survey : config.models?.[r];
    return { model: typeof model === 'string' && model.trim() && !unfilled(model) ? model : fillIn, effort: config.reasoningEfforts?.[r] ?? 'default', context: config.contextTiers?.[r] ?? 'default' };
  };
  const value = key => Object.hasOwn(config, key) ? config[key] : Object.hasOwn(configDefaults, key) ? configDefaults[key] : null;
  return {
    schemaVersion: 1,
    reportLanguage: preferences.userLanguage ?? fillIn,
    originalRuntime: preferences.originalRuntime ?? fillIn,
    phaseMode: preferences.phaseMode ?? fillIn,
    sourceLanguage: languagesUnchosen ? fillIn : config.sourceLanguage,
    targetLanguage: languagesUnchosen ? fillIn : config.targetLanguage,
    mode: config.mode ?? 'preserve', sourceRoots: config.sourceRoots, outputRoots: config.outputRoots, verificationRoots: config.verificationRoots,
    verificationMode: value('verificationMode'), executionMode: value('executionMode'), concurrency: config.concurrency,
    commands: value('commands'),
    models: Object.fromEntries(modelRoles.map(r => [r, role(r)])),
    ...Object.fromEntries(advancedKeys.map(key => [key, key === 'auditModels' ? auditModelsOf(config) : value(key)]))
  };
}

function choices(models) {
  return {
    reportLanguage: userLanguages, originalRuntime: originalRuntimes, phaseMode: phaseModes, mode: modes, verificationMode: verificationModes, executionMode: executionModes,
    workerCopilotHome: ['shared', 'separate'], dependencyOrder: ['auto', 'reviewed', 'none'], fixPolicy: ['single-pass', 'rereview'], reviewFocus: ['shared', 'specialized'],
    effort: ['default', ...effortLevels], context: contextTiers,
    models: Array.isArray(models)
      ? models.filter(m => m.state === 'enabled').map(m => ({ id: m.id, name: m.name, efforts: m.efforts, ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}), contexts: m.contexts?.length ? m.contexts : ['default'] }))
      : models
  };
}

// The explanations and choices, kept out of the settings file so it holds
// only the values. Rewritten by every settings init; nothing reads it back.
function helpMarkdown(language, models) {
  const ja = language === 'ja', { _about, _advanced, ...fields } = help[language], c = choices(models);
  const code = list => list.map(v => `\`${v}\``).join(ja ? '、' : ', ');
  const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const allowed = key => ['effort', 'context', 'models'].includes(key) ? null : c[key];
  const line = ([key, text]) => `- \`${key}\`: ${text}${allowed(key) ? (ja ? `（選択肢: ${code(allowed(key))}）` : ` (choices: ${code(allowed(key))})`) : ''}`;
  const entries = Object.entries(fields);
  const lines = [
    ja ? `# 設定の説明（${settingsFile}）` : `# Settings help (${settingsFile})`, '',
    ja ? `移行の設定は ${settingsFile} だけで変えます。初期設定では AI の質問への答えがそこに入り、最後に「記入しましたか？」と聞かれます。あとから変えるときはファイルを書き換えるだけで、次にキットのコマンド（status など読むだけのものを除く）を始めるときに、全項目を確かめてから反映します。誤りがあれば何も書き込まずに、そのコマンドの出力と status に誤りを全部示します。自動モード（phaseMode の auto）への切り替えだけは \`run_migration.mjs settings apply\` で反映します（確認が出ます）。`
      : `Change the migration's settings in ${settingsFile} only. During setup the AI's questions fill it in, and it asks at the end whether the file is filled in. To change a setting later, edit the file: the next kit command (other than read-only ones such as status) checks every entry and applies it. If any entry is wrong, nothing is written, and that command's output and status list every problem. Switching to auto mode (phaseMode auto) alone takes effect through \`run_migration.mjs settings apply\`, which asks first.`, '',
    ja ? `反映した内容は、キットが \`migration/state/\`（${configFile} と ${preferencesFile}）に記録して読みます。キットの内部記録なので、開いたり書き換えたりする必要はありません（書き換えてしまった値は、次のコマンドが settings.json に写します。元に戻しません）。0.44.x までの \`migration/config.json\` と \`migration/preferences.json\` は、次のコマンドがそこへ移します。このファイル（settings.help.md）は \`settings init\` のたびに作り直され、読み込みには使いません。`
      : `What is applied, the kit records and reads in \`migration/state/\` (${configFile} and ${preferencesFile}). It is the kit's own record: there is no need to open or edit it (a value edited there anyway is copied into settings.json by the next command, not undone). The \`migration/config.json\` and \`migration/preferences.json\` of 0.44.x and earlier are moved there by the next command. This file (settings.help.md) is rewritten by every \`settings init\` and is never read back.`, '',
    ja ? '## 変えたときにやり直しになるもの' : '## What a change sends back', '',
    ...(ja ? [
      '- 変換の中身に関わる設定（sourceLanguage・targetLanguage・mode・sourceRoots・outputRoots・sourceEncoding・packageMap・designInputs など）: 完了済みの単位は次の実行でレビューし直しになり、承認と工程の記録も作り直しになります（どの工程からかは phase next が案内します）。',
      '- テストに関わる設定（verificationMode・verificationRoots・verificationInputs・buildArtifactRoots）: judge・build・smoke・parity の確認（とその承認）をやり直し、工程の確認と記録（verificationMode・verificationRoots は工程 00 から、verificationInputs は 00b から。buildArtifactRoots では 00〜02 の記録はそのままで、03 を judge の後に記録し直し）、変換の承認もやり直しになります。完了済みの単位は残ります。テストのファイルや、リポジトリ直下のビルドの設定ファイルを変えたときは、verificationInputs と同じです。',
      '- コマンド（commands）: そのコマンドの確認と、それより後の確認（とその承認）だけをやり直します。original・mutation・parity は工程 00b の確認の材料なので、00b の確認と、00b から後の工程の記録もやり直しになります（original・mutation は変換の承認も）。source-only の案件はこの3つを実行しないので、変えても何もやり直しません。コマンドに書いたファイル（ビルドのスクリプトなど）を変えたときは、そのコマンドを変えたのと同じです。typecheck は、これから変換する単位の確認に使うだけです。完了済みの単位は残ります。',
      '- モデル・エフォート・コンテキスト（models・auditModels）、レビューの進め方（fixPolicy・reviewFocus・dependencyOrder・maxReviewInputBytes）、細かい実行の上限、reportLanguage・originalRuntime・phaseMode: 何もやり直しません。残りの作業を新しい設定で進めます。'
    ] : [
      '- What the migration produces (sourceLanguage, targetLanguage, mode, sourceRoots, outputRoots, sourceEncoding, packageMap, designInputs and the like): finished units are reviewed again on the next run, and the approvals and the phase records are made again (phase next says from which phase).',
      '- How the tests check it (verificationMode, verificationRoots, verificationInputs, buildArtifactRoots): judge, build, smoke and parity run again (with their approvals), the phases are checked and recorded again (from phase 00 for verificationMode and verificationRoots, from 00b for verificationInputs; buildArtifactRoots keeps the records of phases 00 to 02, and phase 03 is recorded again after the judge), and translation is approved again. Finished units are kept. An edit of a test file or of a build file at the repository root counts as verificationInputs.',
      "- A command (commands): only that command's run and the runs after it (with their approvals) are made again. original, mutation and parity are inputs of phase 00b's check, so 00b is checked again and the phases from 00b are recorded again too (and, for original and mutation, translation is approved again). A source-only project runs none of these three, so changing one sends nothing back. An edit of a file a command names (a build script, say) counts as a change of that command. typecheck only checks the units translated from now on. Finished units are kept.",
      '- The models, efforts and context tiers (models, auditModels), the review procedure (fixPolicy, reviewFocus, dependencyOrder, maxReviewInputBytes), the run limits, reportLanguage, originalRuntime and phaseMode: nothing is sent back; the remaining work uses the new setting.'
    ]), '',
    ja ? '## 各欄' : '## Fields', '',
    ...entries.filter(([key]) => !advancedKeys.includes(key)).map(line),
    ja ? `- \`models.*.effort\` の選択肢: ${code(c.effort)}（そのモデルが対応するものだけ）` : `- \`models.*.effort\` choices: ${code(c.effort)} (only those the model supports)`,
    ja ? `- \`models.*.context\` の選択肢: ${code(c.context)}` : `- \`models.*.context\` choices: ${code(c.context)}`, '',
    ja ? '## 細かい設定（ふつうは変えません）' : '## Detailed settings (rarely changed)', '',
    ja ? '`null` は「指定なし（キットの既定）」です。' : '`null` means not set (the kit\'s default).', '',
    ...entries.filter(([key]) => advancedKeys.includes(key)).map(line), '',
    ja ? '## 使えるモデル' : '## Available models', ''
  ];
  if (Array.isArray(c.models)) lines.push(ja ? '| モデル ID | 名前 | エフォート | コンテキスト |' : '| Model ID | Name | Efforts | Contexts |', '|---|---|---|---|',
    ...c.models.map(m => `| \`${cell(m.id)}\` | ${cell(m.name)} | ${cell((m.efforts ?? []).map(e => e === m.defaultEffort ? `${e}${ja ? '（既定）' : ' (default)'}` : e).join(', ') || '-')} | ${cell(m.contexts.join(', '))} |`));
  else if (models === notListed) lines.push(ja ? 'このファイルはコマンドの開始時に書き直したもので、そのときはモデルの一覧を読みません。一覧は `run_migration.mjs models` で確かめられ、`settings init` でこのファイルを一覧つきで書き直せます。'
    : 'This file was written again at the start of a command, which does not read the model list. `run_migration.mjs models` lists your models, and `settings init` writes this file again with them.');
  else lines.push(ja ? `モデルの一覧を読めませんでした（${models}）。Copilot CLI にサインインしてから \`settings init\` をやり直してください。` : `The model list could not be read (${models}). Sign the Copilot CLI in, then run \`settings init\` again.`);
  return `${lines.join('\n')}\n`;
}

const languageOf = (values, root) => [values?.reportLanguage, (() => { try { return readPreferences(root).userLanguage; } catch { return null; } })()].find(l => userLanguages.includes(l)) ?? 'en';
// The file as the person sees it: the explanation first, the common settings,
// then the detailed ones after their own line. Entries it does not know stay
// at the end for the person to see (settings apply names them).
function writeSettingsFile(root, values) {
  const text = help[languageOf(values, root)], out = { _about: text._about };
  for (const key of settingKeys.filter(k => !advancedKeys.includes(k))) if (values[key] !== undefined) out[key] = values[key];
  out._advanced = text._advanced;
  for (const key of advancedKeys) if (values[key] !== undefined) out[key] = values[key];
  for (const [key, value] of Object.entries(values)) if (!key.startsWith('_') && !settingKeys.includes(key)) out[key] = value;
  writeJSON(safePath(root, settingsFile), out);
}

// The file's old name (0.9.0-0.44.x) becomes the new one, help file included.
// When both exist the new one is used and the old one is left for the person.
// Two commands that start together may both try: the one that finds the old
// name gone and the new one there leaves it to the other.
export function migrateLegacySettings(root) {
  const renamed = [];
  for (const [from, to] of [[legacySettingsFile, settingsFile], [legacySettingsHelpFile, settingsHelpFile]]) {
    const oldFile = safePath(root, from), newFile = safePath(root, to);
    if (!fs.existsSync(oldFile) || fs.existsSync(newFile)) continue;
    try { renameRetry(oldFile, newFile); renamed.push(`${from} -> ${to}`); }
    catch (e) { if (e.code !== 'ENOENT' || fs.existsSync(oldFile) || !fs.existsSync(newFile)) throw e; }
  }
  return renamed;
}

// The records' places until 0.44.x, beside the file. The next command that
// does work moves them (one rename each, content unchanged) while it holds
// the run lock: a runner of an older kit reads them there for its whole run.
// An old file left beside a record already in its place is not used (an
// older kit wrote it again, or it was restored): it stays, and status and
// the command's output name it.
const recordMoves = [[legacyConfigFile, configFile], [legacyPreferencesFile, preferencesFile]];
export const recordsToMove = root => recordMoves.filter(([from, to]) => fs.existsSync(safePath(root, from)) && !fs.existsSync(safePath(root, to)));
export function unusedFiles(root) {
  const left = [[legacySettingsFile, settingsFile], ...recordMoves].filter(([from, to]) => fs.existsSync(safePath(root, from)) && fs.existsSync(safePath(root, to)));
  return left.map(([from]) => from);
}
// The caller holds the run lock. A record that cannot be read stays where
// status names it, to be restored there (for example from version control);
// the next command moves it then.
const readable = (root, rel) => { try { JSON.parse(fs.readFileSync(safePath(root, rel), 'utf8')); return true; } catch { return false; } };
function moveRecords(root) {
  const moved = [];
  for (const [from, to] of recordsToMove(root)) {
    if (!readable(root, from)) continue;
    const target = safePath(root, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    renameRetry(safePath(root, from), target);
    moved.push(`${from} -> ${to}`);
  }
  return moved;
}
const unusedNote = files => `${files.join(', ')} ${files.length > 1 ? 'are' : 'is'} not used: since 0.45.0 the kit keeps its records in migration/state/ and reads the settings from ${settingsFile}. An older kit (another Copilot host that was not updated) may have written ${files.length > 1 ? 'them' : 'it'}: make every host use the same kit version, then delete ${files.length > 1 ? 'them' : 'it'}. Tell the person.`;

// One value of the file: a top-level setting, or one role of models.
const fields = [...preferenceKeys, ...configKeys, ...modelRoles.map(r => `models.${r}`), ...advancedKeys];
const fieldOf = (values, field) => field.startsWith('models.') ? (isObject(values?.models) ? values.models[field.slice(7)] : undefined) : values?.[field];
const setField = (values, field, value) => {
  if (field.startsWith('models.')) values.models = { ...(isObject(values.models) ? values.models : {}), [field.slice(7)]: value };
  else values[field] = value;
};
// A role's model matches case-insensitively; a left-out effort or context is the default.
const sameRole = (a, b) => isObject(a) && isObject(b)
  ? String(a.model).toLowerCase() === String(b.model).toLowerCase() && (a.effort === undefined ? 'default' : a.effort) === (b.effort === undefined ? 'default' : b.effort)
    && (a.context === undefined ? 'default' : a.context) === (b.context === undefined ? 'default' : b.context)
  : same(a, b);
const sameField = (field, a, b) => field.startsWith('models.') ? sameRole(a, b) : same(a, b);
const sideFile = (root, field) => preferenceKeys.includes(field) ? preferencesFileOf(root) : configFileOf(root);
const modifiedAt = (root, rel) => { try { return fs.statSync(safePath(root, rel)).mtimeMs; } catch { return 0; } };

function readBase(root) {
  try { const value = readJSON(safePath(root, settingsBaseFile)); return value?.schemaVersion === 1 && isObject(value.values) ? value.values : null; } catch { return null; }
}
// confirmedAt: when settings apply last succeeded, the person's "filled in"
// at the end of setup. Every command applies an edit of the file, but only
// that answer ends setup; later writes keep it.
const confirmedAt = root => { try { const value = readJSON(safePath(root, settingsBaseFile)); return typeof value?.confirmedAt === 'string' ? value.confirmedAt : null; } catch { return null; } };
const writeBase = (root, values, { confirmed = false } = {}) => {
  const at = confirmed ? new Date().toISOString() : confirmedAt(root);
  writeJSON(safePath(root, settingsBaseFile), { schemaVersion: 1, values, ...(at ? { confirmedAt: at } : {}) });
};
// Whether settings apply has succeeded: setup ends only after it, also when
// another command applied the file first.
export const settingsConfirmed = root => Boolean(confirmedAt(root));
// The base with every field: a field it does not hold yet (a project from
// before 0.45.0, or a setting added since) takes the side written last as
// the change, by modification time. Settled before anything rewrites the file.
function settledBase(root, settings, current) {
  const known = readBase(root), base = structuredClone(known ?? {});
  const fileTime = modifiedAt(root, fs.existsSync(safePath(root, settingsFile)) ? settingsFile : legacySettingsFile);
  let added = false;
  for (const field of fields) {
    if (fieldOf(known, field) !== undefined) continue;
    const f = fieldOf(settings, field), c = fieldOf(current, field);
    setField(base, field, f === undefined || sameField(field, f, c) || fileTime >= modifiedAt(root, sideFile(root, field)) ? structuredClone(c) : structuredClone(f));
    added = true;
  }
  return { base, added };
}
// Nothing chosen: FILL_IN (a role's model, or a preference never recorded).
const placeholder = (field, value) => field.startsWith('models.') ? isObject(value) && unfilled(value.model) : unfilled(value);
// Which way each field that differs goes: an edit of the file is applied; a
// change on the other side is copied into the file; both changed: the file
// is the person's, so it wins. A record that holds nothing for a field the
// file fills (lost, or never written) takes the file's entry: a placeholder
// is never copied over a value.
function compare(settings, current, base) {
  const toApply = [], toCopy = [], bothChanged = [];
  for (const field of fields) {
    const f = fieldOf(settings, field), c = fieldOf(current, field), b = fieldOf(base, field);
    if (f === undefined) { if (c !== undefined) toCopy.push(field); continue; }
    if (sameField(field, f, c)) continue;
    if (placeholder(field, c) && !placeholder(field, f)) toApply.push(field);
    else if (sameField(field, f, b)) toCopy.push(field);
    else { toApply.push(field); if (!sameField(field, c, b)) bothChanged.push(field); }
  }
  return { toApply, toCopy, bothChanged };
}
const unknownKeys = settings => Object.keys(settings).filter(k => !k.startsWith('_') && !settingKeys.includes(k));
// Names in the models map the kit does not know (a role or a role's field):
// reported, never dropped, so a typo does not look applied. Checked on the
// file itself, since the comparison only reads the known names.
const roleTypos = settings => !isObject(settings.models) ? [] : [
  ...Object.keys(settings.models).filter(r => !modelRoles.includes(r)).map(r => `models.${r}: unknown role (roles: ${modelRoles.join(', ')})`),
  ...modelRoles.filter(r => isObject(settings.models[r])).flatMap(r => Object.keys(settings.models[r])
    .filter(k => !['model', 'effort', 'context'].includes(k)).map(k => `models.${r}.${k}: unknown field (model, effort, context)`))];

// Writes the file, or refreshes its explanations and choices when it exists
// (the person's values are kept as written). models is the account's list, or
// a string saying why it could not be read.
// source and target are the person's answer to the language question; they
// replace the languages in the file, and while the folders are still the
// template's, the source language's detected folders become sourceRoots.
export function initSettings(root, models, { source, target, sourceRoots } = {}) {
  const config = readConfigIfPresent(root);
  if (!config) throw new Error(`The project is not initialized (${configFile} is missing): run install.mjs before writing settings`);
  migrateLegacySettings(root);
  const file = safePath(root, settingsFile), exists = fs.existsSync(file);
  const current = currentValues(root, config, readPreferences(root)), shown = currentValues(root, config, readPreferences(root), { shown: true });
  let values, recordedLanguage, base = null;
  if (exists) {
    try { values = readJSON(file); } catch (e) { throw new Error(`${settingsFile} is not valid JSON (${e.message}); correct it or delete it and run settings init again`); }
    if (!isObject(values)) throw new Error(`${settingsFile} must be a JSON object; correct it or delete it and run settings init again`);
    values = Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith('_')));
    recordedLanguage = values.sourceLanguage;
    // Which side changed is settled from the file as it was, before the refresh rewrites it.
    ({ base } = settledBase(root, values, current));
    // An entry still FILL_IN takes what was chosen since (models set, preferences).
    const fill = (value, now) => unfilled(value) && now !== undefined && !unfilled(now) ? now
      : isObject(value) && isObject(now) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, now[k])])) : value;
    values = fill(values, shown);
    // A file written before phaseMode existed gains it; one written before
    // 0.45.0 gains the detailed settings, with the values they have.
    for (const key of ['phaseMode', ...advancedKeys]) if (!Object.hasOwn(values, key)) values[key] = structuredClone(current[key]);
  } else values = structuredClone(shown);
  for (const [key, value] of [['source', source], ['target', target]]) if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error(`--${key} must name a language`);
  const detected = detectSourceLanguages(root, { exclude: [...config.outputRoots ?? [], ...config.verificationRoots ?? []] });
  // Repeating the language the file records is not a new answer (its folder
  // question was settled); a first answer, or another language, is.
  const languageChanged = source !== undefined && (typeof recordedLanguage !== 'string' || unfilled(recordedLanguage)
    || canonicalLanguage(source, detected) !== canonicalLanguage(recordedLanguage, detected));
  if (source !== undefined) {
    values.sourceLanguage = canonicalLanguage(source, detected);
    const found = detected.languages.find(l => l.language === values.sourceLanguage);
    if (found?.roots.length && same(values.sourceRoots, templateRoots) && same(config.sourceRoots, templateRoots)) values.sourceRoots = found.roots;
  }
  if (target !== undefined) values.targetLanguage = target.trim();
  const sourceFound = unfilled(values.sourceLanguage) ? undefined : detected.languages.find(l => l.language === canonicalLanguage(values.sourceLanguage, detected));
  // A folder can be the source when it holds a file (placeholders such as
  // .gitkeep aside). The same test decides whether the template folder needs
  // asking and whether an answer is accepted, so an accepted answer is never
  // asked again; which language the files are is the person's call.
  const placeholders = new Set(['.gitkeep', '.keep', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
  const anyFile = abs => { try { return fs.readdirSync(abs, { withFileTypes: true }).some(e => e.isFile() ? !placeholders.has(e.name)
    : e.isDirectory() && !['.git', 'node_modules', '__pycache__'].includes(e.name) && anyFile(`${abs}/${e.name}`)); } catch { return false; } };
  const holdsFiles = dir => anyFile(safePath(root, dir));
  // The answer to the source-folder question, as a comma-separated list.
  if (sourceRoots !== undefined) {
    const dirs = typeof sourceRoots === 'string' ? [...new Set(sourceRoots.split(',').map(d => d.trim().replace(/\\/g, '/').replace(/^\.\/(?=.)|\/+$/g, '')).filter(Boolean))] : [];
    if (!dirs.length) throw new Error('--source-roots must name one or more folders, separated by commas');
    if (dirs.some(d => d === '.' || d === '/')) throw new Error('--source-roots: the repository root cannot be a source folder (the kit writes migration/ and the output there); the source files must be in a folder');
    const missing = dirs.filter(d => { try { return !fs.statSync(safePath(root, d)).isDirectory(); } catch { return true; } });
    if (missing.length) throw new Error(`--source-roots: ${missing.join(', ')} ${missing.length > 1 ? 'are not folders' : 'is not a folder'} in the repository; ask for the source folders again`);
    const empty = dirs.filter(d => !holdsFiles(d));
    if (empty.length) throw new Error(`--source-roots: ${empty.join(', ')} ${empty.length > 1 ? 'hold' : 'holds'} no files; ask for the source folders again`);
    values.sourceRoots = dirs;
  }
  // Still the template's folders once the languages are chosen: asked while
  // they hold no files, and once, on the language answer, when the language
  // was not detected there. Never left for the person to type.
  const template = !unfilled(values.sourceLanguage) && same(values.sourceRoots, templateRoots) && same(config.sourceRoots, templateRoots);
  const rootsUnchosen = template && (!holdsFiles(templateRoots[0]) || (languageChanged && sourceRoots === undefined && !sourceFound?.roots.includes(templateRoots[0])));
  const verificationFollowed = followOriginalRuntime(values);
  const language = [values.reportLanguage, readPreferences(root).userLanguage].find(l => userLanguages.includes(l)) ?? 'en';
  // Earlier versions wrote _help and _choices into the file; they are left
  // out above, so a refresh shrinks the file to its values.
  writeSettingsFile(root, values);
  // A new file starts from the configuration: what differs from it is an answer to apply.
  writeBase(root, base ?? structuredClone(current));
  atomicWrite(safePath(root, settingsHelpFile), helpMarkdown(language, models));
  const pending = pendingFields(values);
  // Models come first, from one question for every role; the person then
  // edits a role in the file only to differ. An unchosen model sends the
  // parent back to that question.
  const modelsPending = pending.some(p => p.startsWith('models.'));
  // Languages next, from one question: the guessed source is shown and the
  // person picks the target (free text corrects the source).
  const languagesPending = ['sourceLanguage', 'targetLanguage'].some(k => pending.includes(k));
  const languages = languagesPending ? { detected, ...languageQuestion(detected, language) } : undefined;
  // The phase mode is the third question, after models and languages; whether
  // the original runs is the fourth.
  const phaseModePending = pending.includes('phaseMode'), runtimePending = pending.includes('originalRuntime');
  const runtimeQuestion = runtimePending && !modelsPending && !languagesPending && !rootsUnchosen && !phaseModePending ? originalRuntimeQuestion(language, values.sourceLanguage) : undefined;
  // Fifth, only when the original cannot run: is there a specification or a
  // portable test suite? None means source-as-spec, applied before phase 00.
  const preferences = readPreferences(root);
  const specPending = specificationPending(root, values.originalRuntime, preferences, config);
  const specQuestion = specPending && !modelsPending && !languagesPending && !rootsUnchosen && !phaseModePending && !runtimePending ? specificationQuestion(language) : undefined;
  // Questions still ahead, the "filled in?" question and (without a
  // specification) the source-as-spec confirmation included.
  // While the runtime answer is open, the specification question and the
  // switch may still come, so the count only goes down as answers arrive.
  const maybeSpec = runtimePending && config.preparationProfile !== 'source-as-spec';
  const switchAhead = specPending || maybeSpec || (preferences.specification === 'unavailable' && values.originalRuntime === 'unavailable' && config.preparationProfile !== 'source-as-spec');
  const notice = setupFinished(root) ? {} : setupNotice(preferences, language, [modelsPending, languagesPending, rootsUnchosen, phaseModePending, runtimePending, specPending || maybeSpec, true, switchAhead].filter(Boolean).length);
  if (modelsPending && !Array.isArray(models)) return { file: settingsFile, help: settingsHelpFile, created: !exists, refreshed: exists, pending, modelsListed: false, ...(languages ? { languages } : {}), ...notice,
    next: `The model list could not be read (${models}). Offer no model choices: if the CLI is not signed in, start copilot login after the person agrees, then run settings init again.` };
  return { file: settingsFile, help: settingsHelpFile, created: !exists, refreshed: exists, pending, modelsListed: Array.isArray(models), ...(languages ? { languages } : {}),
    ...(runtimeQuestion ? { originalRuntimeQuestion: runtimeQuestion } : {}), ...(specQuestion ? { specificationQuestion: specQuestion } : {}), ...(verificationFollowed ? { verificationModeFollowed: 'source-only' } : {}), ...notice,
    next: modelsPending
      ? 'Models are not chosen yet. Run models list, ask one question for every role\'s model (choices: the enabled models), record it with models set --role all --model ID, then run settings init again.'
      : languagesPending
        ? 'Languages are not chosen yet. Ask languages.question as one question (choices: languages.choices, plus free text), then run settings init --source SOURCE --target TARGET with the guessed source unless the answer corrected it.'
        : rootsUnchosen
          ? `sourceRoots is still the template's ${JSON.stringify(templateRoots)}, and no ${values.sourceLanguage} files were found there. Say so and ask sourceRootsQuestion as one free-text question, then run settings init --source-roots DIR[,DIR] with the answer (files only at the repository root must be moved into a folder first). Never ask the person to edit the file for it.`
        : `${phaseModePending
          ? 'The phase mode is not chosen yet. Ask one question with three choices: normal (recommended: each phase waits until its prerequisites are met), relaxed (a missing prerequisite is a warning, and you ask whether to fix it or proceed every time) or auto (relaxed without asking, for autopilot: completions, approvals and waivers are recorded unasked and marked auto). Record the answer with preferences --phase-mode normal|relaxed|auto (the file follows), then run settings init again.'
          : runtimePending
            ? 'Whether the original runs here is not chosen yet. Ask originalRuntimeQuestion as one question (choices: originalRuntimeQuestion.choices), record the answer with preferences --original-runtime available|unavailable (the file follows; unavailable also sets verificationMode to source-only there), then run settings init again. Never ask the person to edit the file for it.'
            : specPending
              ? 'The original does not run, and whether a specification or portable test suite exists is not answered yet. Ask specificationQuestion as one question (choices: specificationQuestion.choices) and record the answer with preferences --specification available|unavailable, then run settings init again. Unavailable means the source is the only specification: after settings apply, setup switches to source-as-spec before phase 00.'
            : `${verificationFollowed ? 'originalRuntime is unavailable, so verificationMode in the file was set to source-only (the only mode that does not run the original); say so. ' : ''}Show the file path and the help file path, then ask one question: is the file filled in, or does the person have a question? On "filled in", run settings apply.`}`,
    ...(rootsUnchosen && !modelsPending && !languagesPending ? { sourceRootsUnchosen: true, sourceRootsQuestion: language === 'ja'
      ? `移行元のフォルダーが ${templateRoots[0]} のままで、そこに ${values.sourceLanguage} のファイルが見つかりませんでした${sourceFound?.roots.length ? `（${sourceFound.roots.join('、')} にはあります）` : ''}。移行元のフォルダーをリポジトリからの相対パスで書いてください（複数あるときはカンマ区切り。例: Legacy/App, Shared）。リポジトリ直下だけにある場合は、先にフォルダーへ移してください（直下にはキットが migration/ と出力を書きます）。`
      : `The source folder is still ${templateRoots[0]}, and no ${values.sourceLanguage} files were found there${sourceFound?.roots.length ? ` (they are in ${sourceFound.roots.join(', ')})` : ''}. Write the source folders as repository-relative paths (comma-separated; for example Legacy/App, Shared). Files only at the repository root must be moved into a folder first (the kit writes migration/ and the output at the root).` } : {}) };
}

// An original that cannot run here cannot be verified by running it: the
// only verification mode settings apply accepts is then source-only, so the
// file says so instead of stopping the apply on it. Returns whether it changed.
function followOriginalRuntime(values) {
  if (values.originalRuntime !== 'unavailable' || values.verificationMode !== 'runtime') return false;
  values.verificationMode = 'source-only';
  return true;
}

// Whether the fifth question (is there a specification?) is still open: only
// during setup, when the original cannot run and the project is not on
// source-as-spec yet.
function specificationPending(root, originalRuntime, preferences, config) {
  return !phase00Started(root) && originalRuntime === 'unavailable' && !specifications.includes(preferences.specification) && config.preparationProfile !== 'source-as-spec';
}
export function specificationQuestion(language) {
  return language === 'ja' ? {
    question: '移行元の仕様書や、移行先でも使える自動テストはありますか？ どちらも無ければ、ソースそのものを仕様として扱う方式（source-as-spec）に初期設定のうちに切り替えます（新旧の同等性は未検証になります）。',
    choices: [{ value: 'available', label: 'ある（available）' }, { value: 'unavailable', label: 'ない。ソースだけが仕様（unavailable）' }]
  } : {
    question: 'Is there a specification of the original, or an automated test suite the target can use too? If neither exists, setup switches to treating the source itself as the specification (source-as-spec) now; behavioral equivalence then stays unverified.',
    choices: [{ value: 'available', label: 'Yes (available)' }, { value: 'unavailable', label: 'No; the source is the only specification (unavailable)' }]
  };
}
// Auto mode: autopilot cannot answer setup questions, so once auto is chosen
// every remaining setup question says the run is still manual, and how many
// are left; the parent puts setupNotice first in each question.
function setupNotice(preferences, language, remaining) {
  if (preferences.phaseMode !== 'auto') return {};
  return { setupNotice: language === 'ja'
    ? `自動モードを選択済みです。初期設定が終わるまでは手動で進めます（autopilot はまだ使えません。初期設定の確認は残り${remaining}回ほど）。`
    : `Auto mode is chosen. Setup stays manual until it is done (autopilot cannot be used yet; about ${remaining} setup confirmation${remaining === 1 ? '' : 's'} left).` };
}
// The end of setup in auto mode: nothing is left to ask, so the parent stops
// here, before phase 00, for the person to switch to autopilot. How to switch
// differs between Copilot CLI, the Copilot app and VS Code, and the kit cannot
// tell which one runs it, so the handoff names no key or picker.
export function autoHandoff(language) {
  return language === 'ja'
    ? '初期設定が完了しました。autopilot モードに切り替えて「続けて」と送ってください（切り替えなくても、ある程度は自動で進みます）。'
    : 'Setup is done. Switch to autopilot mode and send "continue" (without switching, the run still goes on by itself to some extent).';
}
// Setup is over once any phase has started, completed or been waived (a
// relaxed run can waive 00 and go on), and in auto mode once the handoff was
// shown for the current auto record: a later apply or source-spec init
// neither repeats it nor says setup is still manual.
export function phase00Started(root) {
  return orderedPhases.some(id => ['migration/phases', 'migration/phases/starts', 'migration/phases/waivers'].some(dir => fs.existsSync(safePath(root, `${dir}/${id}.json`))));
}
function handedOff(root) {
  return typeof autoModeRecord(root)?.handedOffAt === 'string';
}
function setupFinished(root) {
  return phase00Started(root) || handedOff(root);
}
const handoffNext = 'Show autoHandoff to the person as written and end the turn now: do not start phase 00 in this turn. On their next message, continue from status.';

// The fourth question, after models, languages and the phase mode: whether
// the original can run here, ready to ask in the report language.
export function originalRuntimeQuestion(language, sourceLanguage) {
  const ja = language === 'ja', name = typeof sourceLanguage === 'string' && !unfilled(sourceLanguage) ? sourceLanguage : null;
  return ja ? {
    question: `移行元の${name ? ` ${name} の` : ''}プログラムを、この環境でビルドして実行できますか？ 動かせれば新旧の動作を比べて確かめ、動かせなければソースだけで確かめます（後から settings.json で変えられます）。`,
    choices: [{ value: 'available', label: '動かせる（available）' }, { value: 'unavailable', label: '動かせない（unavailable）' }]
  } : {
    question: `Can the original${name ? ` ${name}` : ''} program be built and run here? If it runs, the old and new behavior are compared; if not, behavior is checked from the source alone (you can change this later in settings.json).`,
    choices: [{ value: 'available', label: 'It runs (available)' }, { value: 'unavailable', label: 'It does not run (unavailable)' }]
  };
}

function pendingFields(values) {
  const out = [];
  const visit = (value, at) => {
    if (unfilled(value)) out.push(at);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, at ? `${at}.${k}` : k);
  };
  for (const [k, v] of Object.entries(values)) if (!k.startsWith('_')) visit(v, k);
  return out;
}

const readSettings = root => {
  const file = safePath(root, settingsFile);
  if (!fs.existsSync(file)) throw new Error(`${settingsFile} is missing: run settings init first`);
  let value;
  try { value = readJSON(file); } catch (e) { throw new Error(`${settingsFile} is not valid JSON: ${e.message}`); }
  if (!isObject(value)) throw new Error(`${settingsFile} must be a JSON object`);
  return value;
};

// Checks the whole file. Returns { errors, config, preferences }: the
// configuration and preferences it would write when errors is empty. models
// is the account's list (needed only to check model choices); with
// checkModels false the roles' models are left as configured (they did not
// change) and need no list.
export function checkSettings(root, settings, models, { checkModels = true } = {}) {
  const existing = readConfigIfPresent(root);
  if (!existing) return { errors: [`The project is not initialized (${configFile} is missing): run install.mjs first`] };
  const errors = [], config = structuredClone(existing);
  if (settings.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  for (const key of unknownKeys(settings)) errors.push(`${key}: unknown setting (accepted: ${settingKeys.join(', ')}); fields starting with _ are ignored`);
  for (const at of pendingFields(settings)) errors.push(`${at}: still ${fillIn}; fill it in`);
  const oneOf = (key, allowed) => {
    if (!Object.hasOwn(settings, key)) { errors.push(`${key}: missing (one of ${allowed.join(', ')})`); return; }
    if (!unfilled(settings[key]) && !allowed.includes(settings[key])) errors.push(`${key}: must be one of ${allowed.join(', ')}, not ${JSON.stringify(settings[key])}`);
  };
  oneOf('reportLanguage', userLanguages);
  oneOf('originalRuntime', originalRuntimes);
  // Files written before phaseMode existed leave it out: the mode stays as is.
  if (Object.hasOwn(settings, 'phaseMode') && !unfilled(settings.phaseMode) && !phaseModes.includes(settings.phaseMode)) errors.push(`phaseMode: must be one of ${phaseModes.join(', ')}, not ${JSON.stringify(settings.phaseMode)}`);
  // runtime verification runs the original; it cannot when the person says it does not run here.
  if (settings.originalRuntime === 'unavailable' && (settings.verificationMode ?? 'runtime') === 'runtime') errors.push('verificationMode: runtime runs the original, but originalRuntime is unavailable; choose source-only, or record that it runs with preferences --original-runtime available');
  const recorded = key => Object.hasOwn(existing, key) ? existing[key] : Object.hasOwn(configDefaults, key) ? configDefaults[key] : undefined;
  for (const key of configKeys) {
    if (!Object.hasOwn(settings, key)) { errors.push(`${key}: missing`); continue; }
    if (unfilled(settings[key]) || same(settings[key], config[key]) || (!Object.hasOwn(config, key) && Object.hasOwn(configDefaults, key) && same(settings[key], configDefaults[key]))) continue;
    config[key] = structuredClone(settings[key]);
  }
  if (Object.hasOwn(settings, 'commands') && (!settings.commands || typeof settings.commands !== 'object' || Array.isArray(settings.commands))) errors.push('commands: must be an object mapping each stage to null or an argv array');
  // The detailed settings. A file from before 0.45.0 leaves them out: they keep their values.
  for (const key of advancedKeys.filter(k => k !== 'auditModels' && Object.hasOwn(settings, k))) {
    const value = settings[key];
    if (unfilled(value) || same(value, recorded(key))) continue;
    if (value === null && unsetWhenNull.has(key)) { delete config[key]; continue; }
    config[key] = structuredClone(value);
  }
  let phaseModels = isObject(config.phaseModels) ? { ...config.phaseModels } : {};
  if (Object.hasOwn(settings, 'auditModels')) {
    const audits = settings.auditModels;
    if (!isObject(audits)) errors.push(`auditModels: must map preparation audits (${auditNames.join(', ')}) to model names; {} keeps the kit's defaults`);
    else {
      for (const [name, model] of Object.entries(audits)) {
        if (name === 'survey') errors.push('auditModels.survey: the surveyor\'s model is models.surveyor');
        else if (!auditNames.includes(name)) errors.push(`auditModels.${name}: unknown audit (audits: ${auditNames.join(', ')})`);
        else if (typeof model !== 'string' || !model.trim()) errors.push(`auditModels.${name}: write a model name`);
      }
      // Rebuilt only when it changed: the recorded order is kept otherwise.
      if (!same(audits, auditModelsOf(existing))) phaseModels = { ...structuredClone(audits), ...(phaseModels.survey ? { survey: phaseModels.survey } : {}) };
    }
  }
  // Preferences are written after the configuration: a record that cannot be read
  // must stop the apply before anything is written.
  try { readPreferences(root); } catch (e) { errors.push(`${e.message}; correct it before applying`); }
  // Models: each role's choice is checked against the account's list.
  const chosen = settings.models;
  if (!checkModels) {}
  else if (!isObject(chosen)) errors.push('models: must map each role to { "model": ID, "effort": LEVEL|default, "context": default|long_context }');
  else {
    for (const key of Object.keys(chosen)) if (!modelRoles.includes(key)) errors.push(`models.${key}: unknown role (roles: ${modelRoles.join(', ')})`);
    config.models = { ...config.models };
    const efforts = { ...config.reasoningEfforts }, tiers = { ...config.contextTiers };
    for (const role of modelRoles) {
      const entry = chosen[role];
      if (!isObject(entry)) { errors.push(`models.${role}: missing; write { "model": ID, "effort": "default", "context": "default" }`); continue; }
      for (const key of Object.keys(entry)) if (!['model', 'effort', 'context'].includes(key)) errors.push(`models.${role}.${key}: unknown field (model, effort, context)`);
      const effort = entry.effort === undefined ? 'default' : entry.effort, context = entry.context === undefined ? 'default' : entry.context;
      if (typeof context !== 'string' || !contextTiers.includes(context)) { errors.push(`models.${role}.context: must be one of ${contextTiers.join(', ')}`); continue; }
      if (typeof entry.model !== 'string' || !entry.model.trim()) { errors.push(`models.${role}.model: write a model ID from the available models in ${settingsHelpFile}`); continue; }
      if (typeof effort !== 'string' || ![...effortLevels, 'default'].includes(effort)) { errors.push(`models.${role}.effort: must be default or one of ${effortLevels.join(', ')}`); continue; }
      if (unfilled(entry.model)) continue;
      if (role === 'surveyor' && entry.model === sameAsImplementer) {
        delete phaseModels.survey;
        if (effort === 'default') delete efforts.surveyor; else efforts.surveyor = effort;
        if (context === 'default') delete tiers.surveyor; else tiers.surveyor = context;
        continue;
      }
      if (!Array.isArray(models)) continue;
      try {
        const choice = checkChoice(models, entry.model, effort, context);
        // The same model spelled with another case keeps its recorded spelling:
        // rewriting it would revoke reviews without changing the choice.
        const recordedModel = role === 'surveyor' ? existing.phaseModels?.survey : existing.models?.[role];
        const model = typeof recordedModel === 'string' && recordedModel.toLowerCase() === choice.model.toLowerCase() ? recordedModel : choice.model;
        if (role === 'surveyor') phaseModels.survey = model; else config.models[role] = model;
        if (choice.effort) efforts[role] = choice.effort; else delete efforts[role];
        if (choice.context) tiers[role] = choice.context; else delete tiers[role];
      } catch (e) { errors.push(`models.${role}: ${e.message}`); }
    }
    if (!Array.isArray(models)) errors.push(`models: cannot check the model choices (${models})`);
    // An empty map is left out, as models set leaves it ({} and absent mean
    // the same, and no record depends on it).
    for (const [key, value] of [['reasoningEfforts', efforts], ['contextTiers', tiers]]) {
      if (Object.keys(value).length) config[key] = value; else delete config[key];
    }
  }
  // Rewritten when it changed, and (as models set does) left out when empty
  // once the roles were checked.
  if (!same(phaseModels, existing.phaseModels ?? {}) || (checkModels && isObject(chosen))) { if (Object.keys(phaseModels).length) config.phaseModels = phaseModels; else delete config.phaseModels; }
  // The runner's own checks, on the configuration as it would be written,
  // run beside the other errors once nothing is left to fill in.
  if (!pendingFields(settings).length) {
    try { loadConfig(root, { config: structuredClone(config) }); } catch (e) { errors.push(e.message); }
    // Checked with the listed spellings: a model recorded in another case is
    // still that model, and its efforts still apply (inherited ones too).
    const listed = id => (Array.isArray(models) && models.find(m => typeof id === 'string' && m.id.toLowerCase() === id.toLowerCase())?.id) ?? id;
    const canonical = { ...config, models: Object.fromEntries(Object.entries(config.models ?? {}).map(([r, id]) => [r, listed(id)])),
      ...(config.phaseModels?.survey ? { phaseModels: { ...config.phaseModels, survey: listed(config.phaseModels.survey) } } : {}) };
    try { if (checkModels && Array.isArray(models)) checkAssignments(models, canonical); } catch (e) { errors.push(e.message); }
  }
  return { errors: [...new Set(errors)], config, preferences: { language: settings.reportLanguage, originalRuntime: settings.originalRuntime, ...(Object.hasOwn(settings, 'phaseMode') ? { phaseMode: settings.phaseMode } : {}) } };
}

// What the configuration and preferences records would become, and the file with them:
// the plan of one reconcile, written by writePlan unless it has errors.
function planSettings(root, models, { explicit = false } = {}) {
  const config = readConfigIfPresent(root);
  if (!config) return { errors: [`The project is not initialized (${configFile} is missing): run install.mjs first`] };
  if (!fs.existsSync(safePath(root, settingsFile))) return { absent: true };
  let settings, preferences;
  try { settings = readSettings(root); } catch (e) { return { errors: [e.message] }; }
  // Setup still asks for these; settings apply sends each to its question.
  const pending = pendingFields(settings);
  if (pending.length) return { unfilled: pending, settings };
  try { preferences = readPreferences(root); } catch (e) { return { errors: [`${e.message}; correct it before applying`] }; }
  const current = currentValues(root, config, preferences), { base, added } = settledBase(root, settings, current);
  const { toApply, toCopy, bothChanged } = compare(settings, current, base);
  // Switching to auto mode waits for settings apply, which the host confirms.
  const autoSwitch = toApply.includes('phaseMode') && settings.phaseMode === 'auto' && current.phaseMode !== 'auto' && !autoModeOn(root);
  const applying = autoSwitch && !explicit ? toApply.filter(f => f !== 'phaseMode') : toApply;
  const desired = structuredClone(current);
  for (const field of applying) setField(desired, field, structuredClone(fieldOf(settings, field)));
  const unknown = unknownKeys(settings), malformed = Object.hasOwn(settings, 'models') && !isObject(settings.models), typos = roleTypos(settings);
  const plan = { config, preferences, settings, current, base, baseAdded: added, desired, applying, toCopy, bothChanged, ...(autoSwitch && !explicit ? { autoSwitch: true } : {}) };
  if (!applying.length && !unknown.length && !malformed && !typos.length && settings.schemaVersion === 1) return { ...plan, next: { config, preferences: null } };
  // Unknown entries and a broken models map are reported too: a typo must not look applied.
  const input = { ...desired, ...Object.fromEntries(unknown.map(k => [k, settings[k]])), ...(malformed ? { models: settings.models } : {}), schemaVersion: settings.schemaVersion };
  const checkModels = malformed || applying.some(f => f.startsWith('models.'));
  const checked = checkSettings(root, input, models, { checkModels }), errors = [...new Set([...checked.errors, ...typos])];
  return { ...plan, ...(errors.length ? { errors } : {}), next: { config: checked.config, preferences: applying.some(f => preferenceKeys.includes(f)) ? checked.preferences : null } };
}

// Writes a plan without errors: the configuration and preferences records when they
// change, the file (with what was copied into it), and the base.
function writePlan(root, plan, { confirmed = false } = {}) {
  const before = plan.config, after = plan.next.config;
  const changed = Object.keys({ ...before, ...after }).filter(k => !same(before[k], after[k]) && !(same(before[k] ?? {}, {}) && same(after[k] ?? {}, {})));
  if (!same(before, after)) writeJSON(safePath(root, configFileOf(root)), after);
  const preferenceChanges = [];
  if (plan.next.preferences) {
    setPreferences(root, plan.next.preferences);
    for (const [name, key, value] of [['reportLanguage', 'userLanguage', plan.next.preferences.language], ['originalRuntime', 'originalRuntime', plan.next.preferences.originalRuntime], ['phaseMode', 'phaseMode', plan.next.preferences.phaseMode]])
      if (value !== undefined && plan.preferences[key] !== value) preferenceChanges.push(name);
  }
  // The file holds what applies and what was copied; a waiting auto switch
  // stays as the person wrote it, and its base does not, so it keeps waiting.
  const file = { ...structuredClone(plan.desired), ...(plan.autoSwitch ? { phaseMode: plan.settings.phaseMode } : {}) };
  const text = help[languageOf(file, root)];
  if (plan.toCopy.length || plan.applying.length || plan.settings._about !== text._about || plan.settings._advanced !== text._advanced) writeSettingsFile(root, file);
  if (confirmed || plan.baseAdded || !same(plan.base, plan.desired)) writeBase(root, plan.desired, { confirmed });
  return { changed: [...changed, ...preferenceChanges],
    ...(settingsEffect(before, after) ? { note: settingsEffect(before, after) } : {}) };
}

// settings apply: applies the file at once, the switch to auto mode
// included (the hook makes the host ask first). A field changed only in
// the configuration record since the file and the record last agreed is copied
// into the file, not undone.
export function applySettings(root, models) {
  migrateLegacySettings(root);
  const plan = planSettings(root, models, { explicit: true });
  if (plan.absent) return { applied: false, file: settingsFile, errors: [`${settingsFile} is missing: run settings init first`], next: 'Run settings init and follow its next.' };
  if (plan.unfilled) {
    const errors = checkSettings(root, plan.settings, models).errors;
    // Entries a question fills (models, languages, phase mode, whether the
    // original runs) are asked, never left for the person to type into the file.
    const asked = plan.unfilled.filter(at => at.startsWith('models.') || ['sourceLanguage', 'targetLanguage', 'phaseMode', 'originalRuntime'].includes(at));
    return { applied: false, file: settingsFile, errors,
      next: asked.length
        ? `Nothing was written. ${asked.join(', ')} ${asked.length > 1 ? 'are' : 'is'} still ${fillIn} and answered by a question: run settings init and follow its next (it asks them one at a time), then show any other error and ask again whether the file is filled in. Never ask the person to type these into the file.`
        : 'Nothing was written. Show every error, ask the person to correct the file, then ask again whether it is filled in.' };
  }
  if (plan.errors) return { applied: false, file: settingsFile, errors: plan.errors, next: 'Nothing was written. Show every error, ask the person to correct the file, then ask again whether it is filled in.' };
  const written = writePlan(root, plan, { confirmed: true });
  return { applied: true, file: settingsFile, ...written, ...(plan.toCopy.length ? { copied: plan.toCopy } : {}), ...setupEnd(root, plan.next.config) };
}

// What follows settings apply while setup is not finished: the source-as-spec
// switch when there is no specification, then (auto mode) the stop before
// phase 00. Nothing once phase 00 is under way.
export function setupEnd(root, config) {
  if (phase00Started(root)) return {};
  const preferences = readPreferences(root);
  const language = userLanguages.includes(preferences.userLanguage) ? preferences.userLanguage : 'en';
  // The verification method is settled before phase 00 even when a setup
  // answer changes after the handoff; only the handoff itself is not repeated.
  const step = setupStep(root, preferences, config);
  const notice = count => handedOff(root) ? {} : setupNotice(preferences, language, count);
  // Left: the specification question and the source-as-spec confirmation.
  if (step === 'specification') return { ...notice(2), next: 'The original does not run, and whether a specification exists is not answered yet: run settings init and ask its specificationQuestion before phase 00.' };
  if (step === 'source-as-spec') return { ...notice(1), next: 'There is no specification, so switch to source-as-spec now, before phase 00: run source-spec init, show its changes in one message, then run source-spec init --apply (the host asks the person once). Then follow its next.' };
  if (handedOff(root) || preferences.phaseMode !== 'auto' || !autoModeOn(root)) return {};
  // Shown once per auto record: choosing auto again writes a new record.
  writeJSON(safePath(root, autoModeFile), { ...autoModeRecord(root), handedOffAt: new Date().toISOString() });
  return { autoHandoff: autoHandoff(language), next: handoffNext };
}

// What setup still owes before phase 00 for the verification method: the
// specification answer, or the source-as-spec switch it calls for.
function setupStep(root, preferences, config) {
  if (specificationPending(root, preferences.originalRuntime, preferences, config)) return 'specification';
  if (preferences.specification === 'unavailable' && preferences.originalRuntime === 'unavailable' && config.preparationProfile !== 'source-as-spec') return 'source-as-spec';
  return null;
}
// The first phase command refuses while that is open, with the step to take,
// so an out-of-order phase 00 never skips it.
export function setupBlocker(root, config) {
  if (phase00Started(root)) return null;
  let preferences;
  try { preferences = readPreferences(root); } catch { return null; }
  const step = setupStep(root, preferences, config);
  return step === 'specification'
    ? 'Setup is not finished: the original does not run, and whether a specification or portable test suite exists is not answered yet. Run settings init, ask its specificationQuestion and record the answer with preferences --specification available|unavailable, then run settings apply and follow its next before phase 00.'
    : step === 'source-as-spec'
      ? 'Setup is not finished: there is no specification, so the project switches to source-as-spec before phase 00. Run source-spec init, show its changes in one message, then run source-spec init --apply (the host asks the person once), and start phase 00 after it.'
      : null;
}

// For status (cheap, offline, writes nothing): whether the file agrees with
// the configuration, and what the next command will apply or copy into the
// file. Model choices are checked by that command, against the account's list.
export function settingsState(root, config) {
  const legacy = !fs.existsSync(safePath(root, settingsFile)) && fs.existsSync(safePath(root, legacySettingsFile));
  const name = legacy ? legacySettingsFile : settingsFile, file = safePath(root, name);
  const unused = unusedFiles(root), moving = recordsToMove(root).map(([from]) => from);
  const extra = { ...(legacy ? { renameTo: settingsFile } : {}), ...(unused.length ? { unused } : {}), ...(moving.length ? { recordsToMove: moving } : {}) };
  // No file yet (settings init writes it; a project set up before 0.9.0 gets
  // it at its next command once phase 00 has started): status still names the
  // records the next command moves and the old files left unused.
  if (!fs.existsSync(file)) return unused.length || moving.length ? { state: 'absent', file: settingsFile, ...extra } : null;
  let settings;
  try { settings = readJSON(file); } catch { return { state: 'invalid', file: name, ...extra }; }
  if (!isObject(settings)) return { state: 'invalid', file: name, ...extra };
  const pending = pendingFields(settings);
  if (pending.length) return { state: 'unfilled', file: name, pending, ...extra };
  let preferences = {};
  try { preferences = readPreferences(root); } catch {}
  const current = currentValues(root, config, preferences), { base } = settledBase(root, settings, current);
  const { toApply, toCopy } = compare(settings, current, base);
  const unknown = unknownKeys(settings), typos = roleTypos(settings), malformed = Object.hasOwn(settings, 'models') && !isObject(settings.models);
  if (!toApply.length && !toCopy.length && !unknown.length && !typos.length && !malformed && settings.schemaVersion === 1) return { state: 'applied', file: name, ...extra };
  const autoSwitch = toApply.includes('phaseMode') && settings.phaseMode === 'auto' && current.phaseMode !== 'auto' && !autoModeOn(root);
  const desired = structuredClone(current);
  for (const field of toApply) setField(desired, field, structuredClone(fieldOf(settings, field)));
  const errors = toApply.length || unknown.length || typos.length || malformed || settings.schemaVersion !== 1
    ? [...new Set([...checkSettings(root, { ...desired, ...Object.fromEntries(unknown.map(k => [k, settings[k]])), schemaVersion: settings.schemaVersion }, undefined, { checkModels: false }).errors,
      ...typos, ...(malformed ? ['models: must map each role to { "model": ID, "effort": LEVEL|default, "context": default|long_context }'] : [])])] : [];
  return { state: errors.length ? 'invalid-entries' : 'changed', file: name, ...(toApply.length ? { toApply } : {}), ...(toCopy.length ? { toCopy } : {}),
    ...(autoSwitch ? { autoSwitch: true } : {}), ...(errors.length ? { errors } : {}), ...extra };
}

// models set, preferences and source-spec change the same values from chat;
// the file follows them so it stays the record of the run's conditions and
// the next command does not take the old choice for an edit. Only what the
// command set is written: the roles it named (model, effort and context, as
// the command records them) and the preferences it was given, so the
// person's other edits stay for the next command to apply.
export function syncSettings(root, { roles = [], keys = [], report = {} } = {}) {
  // A broken configuration record is reported by the commands that read it; the
  // recorded preference still stands, and settings apply refuses until then.
  migrateLegacySettings(root);
  const file = safePath(root, settingsFile);
  let config = null;
  try { config = readConfigIfPresent(root); } catch {}
  if (!config || !fs.existsSync(file)) return null;
  let value, preferences = {};
  try { value = readJSON(file); } catch { return null; }
  if (!isObject(value)) return null;
  try { preferences = readPreferences(root); } catch {}
  const current = currentValues(root, config, preferences);
  // Which side changed is settled before this write changes the file's time.
  const { base } = settledBase(root, value, current);
  for (const key of keys) if (!unfilled(current[key])) { value[key] = current[key]; base[key] = structuredClone(current[key]); }
  // An original that cannot run makes the file verify from the source; one
  // that runs leaves the mode as it is, and the caller asks about runtime.
  if (keys.includes('originalRuntime') && followOriginalRuntime(value)) report.verificationMode = 'source-only';
  else if (keys.includes('originalRuntime') && value.originalRuntime === 'available' && value.verificationMode === 'source-only') report.verificationModeKept = 'source-only';
  if (roles.length && !isObject(value.models)) value.models = {};
  for (const role of roles) if (current.models[role]) { value.models[role] = current.models[role]; setField(base, `models.${role}`, structuredClone(current.models[role])); }
  writeSettingsFile(root, value);
  writeBase(root, base);
  return settingsFile;
}

// The error of a model choice that could not be checked against the account's list.
const modelListError = /^models: cannot check the model choices/;
// The model list a command start has not read (it reads it only for a changed model).
const notListed = 'model list not read';
// Said once, when the records move: an older kit no longer finds them.
const moveNote = 'every Copilot host that works on this project (VS Code, the CLI, another PC) must run this kit release or a later one from now on: an older kit does not find the moved records, so its hooks check nothing and its commands stop as if the project were not initialized (do not initialize it again; update the kit there). Tell the person';
// The start of every kit command that does work: the old file name is
// renamed, the kit's records move from beside the file into migration/state/,
// a project without the file (set up before 0.9.0) gets it, and the file and
// the configuration are brought together. Never throws: a file that cannot
// be applied leaves the configuration as it is, and the result says why, for
// the command to show. listModels is called only when a role's model
// changed. A pilot's copy follows the project's run limits.
export async function settingsAtStart(root, listModels = async () => notListed) {
  const result = {};
  try {
    // First, before this command can change the settings: what the records
    // of an older kit stand for (lib/context-upgrade.mjs). Silent, once.
    recordContextUpgrade(root);
    const renamed = migrateLegacySettings(root);
    if (renamed.length) result.renamed = renamed;
    if (recordsToMove(root).length) {
      let release;
      try { release = lockRun(root, 'settings'); } catch (e) { result.deferred = `${e.message.split(';')[0]}; the kit's records move to migration/state/ when the next command starts`; }
      if (release) try { const moved = moveRecords(root); if (moved.length) Object.assign(result, { moved, moveNote }); } finally { release(); }
    }
    const unused = unusedFiles(root);
    if (unused.length) Object.assign(result, { unused, unusedNote: unusedNote(unused) });
    const config = readConfigIfPresent(root);
    if (!config) return result;
    if (config.pilot?.parentRoot) return { ...result, ...await followProjectSettings(root, config, listModels) };
    if (!fs.existsSync(safePath(root, settingsFile))) {
      // Set up before the file existed: it is written from the configuration.
      if (!phase00Started(root)) return result;
      let preferences = {};
      try { preferences = readPreferences(root); } catch {}
      const values = currentValues(root, config, preferences);
      writeSettingsFile(root, values);
      writeBase(root, values);
      result.created = settingsFile;
    }
    let models = notListed;
    let plan = planSettings(root, models);
    if (plan.unfilled || plan.absent) return result;
    if (plan.applying?.some(f => f.startsWith('models.')) && !plan.errors?.some(e => !modelListError.test(e))) {
      try { models = await listModels(); } catch (e) { models = e.message; }
      plan = planSettings(root, models);
    }
    const helpText = (() => { try { return fs.readFileSync(safePath(root, settingsHelpFile), 'utf8'); } catch { return ''; } })();
    // The help file of the old name (or none) is written again with the new one's text.
    const helpStale = !helpText || helpText.includes(legacySettingsFile);
    // A model list that could not be read is no error of the file: the change waits.
    const unusable = p => ({ ...result, errors: p.errors, file: settingsFile, ...(p.autoSwitch ? { autoSwitch: true } : {}),
      next: p.errors.every(e => modelListError.test(e))
        ? `Nothing was applied: the kit could not read your model list to check the model choices in ${settingsFile} (the error says why), so the configuration stays as it was and the next command tries again. This command goes on with the settings as they were. Tell the person; if the error says so, sign the Copilot CLI in.`
        : `Nothing was applied: ${settingsFile} has entries that cannot be used, and the configuration stays as it was. Tell the person each error; correct the file with them. The next command applies it.` });
    const idle = p => !p.applying.length && !p.toCopy.length && !p.baseAdded && same(p.base, p.desired) && !helpStale
      && p.settings._about === help[languageOf(p.desired, root)]._about && p.settings._advanced === help[languageOf(p.desired, root)]._advanced;
    if (plan.errors) return unusable(plan);
    if (plan.autoSwitch) result.autoSwitch = 'phaseMode auto in the settings file waits for settings apply, which the host confirms with the person.';
    if (idle(plan)) return result;
    let release;
    // A move that waited for the same lock is named too.
    try { release = lockRun(root, 'settings'); } catch (e) { return { ...result, deferred: `${e.message.split(';')[0]}; ${result.deferred ? 'the kit\'s records move to migration/state/ and ' : ''}the settings file is applied when the next command starts` }; }
    try {
      // Planned again under the lock: a change another command made to the
      // file or the record meanwhile (models set, preferences) is not undone.
      plan = planSettings(root, models);
      if (plan.unfilled || plan.absent) return result;
      if (plan.errors) return models === notListed && plan.errors.every(e => modelListError.test(e))
        ? { ...result, deferred: 'the settings file changed while this command started; the next command applies it' } : unusable(plan);
      if (idle(plan)) return result;
      const written = writePlan(root, plan);
      // The list only when this start read it for a changed model: the
      // Copilot CLI is not started for the help alone.
      if (helpStale) atomicWrite(safePath(root, settingsHelpFile), helpMarkdown(languageOf(plan.desired, root), models));
      return { ...result, file: settingsFile, ...(plan.applying.length ? { applied: plan.applying } : {}), ...(plan.toCopy.length ? { copied: plan.toCopy } : {}),
        ...(written.changed.length ? { changed: written.changed } : {}), ...(written.note ? { note: written.note } : {}), ...(plan.bothChanged.length ? { bothChanged: plan.bothChanged } : {}) };
    } finally { release(); }
  } catch (e) { return { ...result, errors: [e.message], next: `The settings file could not be brought in step (${e.message}); the configuration stays as it was.` }; }
}

// One line for the command's output: what its start did with the file and
// the records ('' when nothing). The result holds the whole of it.
export function settingsNotice(started) {
  const line = [started.moved ? `moved ${started.moved.join(', ')}` : '', started.renamed ? `renamed ${started.renamed.join(', ')}` : '',
    started.created ? `wrote ${started.created} from the configuration` : '',
    started.applied ? `applied ${started.applied.join(', ')} from ${settingsFile}` : '', started.copied ? `copied ${started.copied.join(', ')} into ${settingsFile}` : '',
    started.project?.applied ? `applied ${started.project.applied.join(', ')} from the project's ${settingsFile}` : '', started.followedProject ? `the pilot took ${started.followedProject.join(', ')} from the project` : '',
    started.errors ? `not applied: ${started.errors.join('; ')}` : '', started.project?.errors ? `the project's ${settingsFile} was not applied: ${started.project.errors.join('; ')}` : '',
    typeof started.autoSwitch === 'string' ? started.autoSwitch : '', started.deferred ?? '', started.project?.deferred ?? '', started.unusedNote ?? '', started.moveNote ?? ''].filter(Boolean);
  return line.length ? `settings: ${line.join('; ')}` : '';
}

// A pilot's copy runs with the project's run limits (concurrency, worker
// home, limits and retries): the project's file is applied first, then the
// copy takes them. None of them is part of a reviewed configuration, so the
// pilot's grant and records stay valid.
async function followProjectSettings(root, config, listModels) {
  const parent = config.pilot.parentRoot;
  if (typeof parent !== 'string' || ![configFile, legacyConfigFile].some(rel => fs.existsSync(path.join(parent, rel)))) return {};
  const project = await settingsAtStart(parent, listModels);
  const parentConfig = readConfigIfPresent(parent);
  const differs = operationalConfigKeys.filter(k => !same(parentConfig?.[k], config[k]));
  const result = Object.keys(project).length ? { project } : {};
  if (!parentConfig || !differs.length) return result;
  let release;
  try { release = lockRun(root, 'settings'); } catch (e) { return { ...result, deferred: `${e.message.split(';')[0]}; the pilot takes the project's concurrency, limits and retries when the next command starts` }; }
  try {
    const next = { ...readConfigIfPresent(root) };
    for (const key of differs) { if (Object.hasOwn(parentConfig, key)) next[key] = parentConfig[key]; else delete next[key]; }
    writeJSON(safePath(root, configFileOf(root)), next);
    return { ...result, followedProject: differs };
  } finally { release(); }
}
