// SPDX-License-Identifier: Apache-2.0
// Run settings in one file the person fills in, instead of one question per
// setting. `settings init` writes migration/run-settings.json from the current
// configuration, and beside it migration/run-settings.help.md with the
// explanations and the account's models as choices (the settings file holds
// only values, so it stays small); `settings apply` checks
// every entry, reports every problem at once and writes nothing unless all
// pass. Accepted values go where they already live: languages, roots, models
// and commands in migration/config.json; the report language and whether the
// original can run in migration/preferences.json, so changing those never
// revokes approvals. The file stays as the record of the conditions a run
// used; status says whether it still matches the configuration.
import fs from 'node:fs';
import { safePath, writeJSON, atomicWrite, roles, effortLevels, contextTiers, loadConfig, semanticConfig } from './core.mjs';
import { readPreferences, setPreferences, userLanguages, originalRuntimes, phaseModes } from './preferences.mjs';
import { checkChoice, checkAssignments, readConfigIfPresent } from './models.mjs';
import { detectSourceLanguages, languageQuestion, canonicalLanguage } from './source-detect.mjs';

export const runSettingsFile = 'migration/run-settings.json';
export const runSettingsHelpFile = 'migration/run-settings.help.md';
export const fillIn = 'FILL_IN';
export const sameAsImplementer = 'same-as-implementer';
const modelRoles = [...roles, 'surveyor'];
const modes = ['preserve', 'redesign'], verificationModes = ['runtime', 'source-only'], executionModes = ['continuous', 'bounded'];
// The settings the person decides, in the order the file shows them. Every
// other configuration key keeps its value in config.json.
const configKeys = ['sourceLanguage', 'targetLanguage', 'mode', 'sourceRoots', 'outputRoots', 'verificationRoots', 'verificationMode', 'executionMode', 'concurrency', 'commands'];
const settingKeys = ['schemaVersion', 'reportLanguage', 'originalRuntime', 'phaseMode', ...configKeys, 'models'];
// Template defaults are examples, not choices: before a manifest exists, a
// fresh file asks for the languages instead of offering the example pair.
const templateLanguages = { sourceLanguage: 'Python', targetLanguage: 'JavaScript' }, templateRoots = ['src'];
// Editors on Windows may save a byte order mark; JSON.parse rejects it.
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
// Values a configuration may leave out; the file shows them, and writing them
// back unchanged must not add keys (that would change the reviewed configuration).
const configDefaults = { verificationMode: 'runtime', executionMode: 'continuous', commands: {} };
// Key order is not a change: an object rewritten in another order compares equal.
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const unfilled = value => typeof value === 'string' && /FILL_IN|SELECT_MODEL/.test(value);

const help = {
  ja: {
    _about: `このファイルを埋めてから、AI の質問に「記入した」と答えてください。各欄の説明と選択肢（使えるモデルなど）は ${runSettingsHelpFile} にあります。\`_\` で始まる欄は読み込みで無視します。`,
    reportLanguage: '報告の言語。ja か en。',
    originalRuntime: '移行元のコードをこの環境で実行できるか。available か unavailable。',
    phaseMode: '工程の進め方。normal は前提が揃うまで次の工程に進まない（推奨）。relaxed は前提が足りなくても警告して「直す／進む」を毎回聞き、進んだ工程は見送りとして記録する。auto は relaxed を人に聞かずに進める（Copilot CLI の autopilot 向け。工程の完了・承認・見送りを自動で記録し、自動の印を付ける。上流の規則3「承認ゲートで止まる」に従わない）。切り替えても承認や完了記録は消えない。',
    sourceLanguage: '移行元の言語（例: C#、Java、COBOL）。', targetLanguage: '移行先の言語（例: TypeScript、Go）。',
    mode: 'preserve は動作をそのまま移す、redesign は設計を変える。',
    sourceRoots: '移行元のフォルダー（リポジトリからの相対パスの配列）。', outputRoots: '移行先のコードを書くフォルダー。', verificationRoots: '動作確認に使うテストのフォルダー。',
    verificationMode: 'runtime は元のコードを実行して比べる、source-only は実行できないときにソースだけで確かめる。',
    executionMode: 'continuous は終わるまで続ける、bounded は config.json の上限で止める。', concurrency: '同時に動かすワーカーの数（1〜64）。',
    commands: '各段階のコマンド。null か、["コマンド", "引数", ...] の配列。',
    models: '最初の質問で選んだモデルが全担当に入っています。担当ごとに変えたいときだけ書き換えます。モデル ID は下の「使えるモデル」から選ぶ。エフォートは default か、そのモデルの efforts のどれか。context は default か、そのモデルの contexts にあるときだけ long_context（料金が上がります）。surveyor の model に same-as-implementer を書くと implementer と同じになり、そのときの default は implementer のエフォート・コンテキスト。'
  },
  en: {
    _about: `Fill in this file, then answer the AI's question with "filled in". Each field's explanation and choices (such as the available models) are in ${runSettingsHelpFile}. Fields starting with \`_\` are ignored when reading.`,
    reportLanguage: 'Report language: ja or en.',
    originalRuntime: 'Whether the original code can run here: available or unavailable.',
    phaseMode: 'How phases advance. normal waits until each phase\'s prerequisites are met (recommended). relaxed warns when one is missing, asks "fix or proceed" every time, and records a phase you proceed past as waived. auto is relaxed without asking (for Copilot CLI autopilot: phase completions, approvals and waivers are recorded unasked and marked auto; upstream rule 3, stop at sign-off gates, is not followed). Switching never revokes approvals or completion records.',
    sourceLanguage: 'Language migrated from (for example C#, Java, COBOL).', targetLanguage: 'Language migrated to (for example TypeScript, Go).',
    mode: 'preserve keeps the behavior; redesign changes the design.',
    sourceRoots: 'Source folders (array of repository-relative paths).', outputRoots: 'Folders the migrated code is written to.', verificationRoots: 'Test folders used to check behavior.',
    verificationMode: 'runtime runs the original to compare; source-only checks from the source alone when it cannot run.',
    executionMode: 'continuous runs until done; bounded stops at the limits in config.json.', concurrency: 'Workers running at once (1-64).',
    commands: 'Command for each stage: null, or an array ["command", "arg", ...].',
    models: 'Every role holds the model chosen in the first question; change a role only to differ. Pick model IDs from the available models below. Effort is default or one of that model\'s efforts. Context is default, or long_context when that model\'s contexts list it (it costs more). A surveyor model of same-as-implementer follows the implementer, and its default then means the implementer\'s effort and context.'
  }
};

// The file's values from the configuration as it stands, placeholders where
// nothing was chosen yet.
function currentValues(root, config, preferences) {
  const languagesUnchosen = Object.entries(templateLanguages).every(([k, v]) => config[k] === v) && !fs.existsSync(safePath(root, 'migration/manifest.tsv'));
  const role = r => {
    if (r === 'surveyor' && !config.phaseModels?.survey) return { model: sameAsImplementer, effort: config.reasoningEfforts?.surveyor ?? 'default', context: config.contextTiers?.surveyor ?? 'default' };
    const model = r === 'surveyor' ? config.phaseModels.survey : config.models?.[r];
    return { model: typeof model === 'string' && model.trim() && !unfilled(model) ? model : fillIn, effort: config.reasoningEfforts?.[r] ?? 'default', context: config.contextTiers?.[r] ?? 'default' };
  };
  return {
    schemaVersion: 1,
    reportLanguage: preferences.userLanguage ?? fillIn,
    originalRuntime: preferences.originalRuntime ?? fillIn,
    phaseMode: preferences.phaseMode ?? fillIn,
    sourceLanguage: languagesUnchosen ? fillIn : config.sourceLanguage,
    targetLanguage: languagesUnchosen ? fillIn : config.targetLanguage,
    mode: config.mode ?? 'preserve', sourceRoots: config.sourceRoots, outputRoots: config.outputRoots, verificationRoots: config.verificationRoots,
    verificationMode: config.verificationMode ?? 'runtime', executionMode: config.executionMode ?? 'continuous', concurrency: config.concurrency,
    commands: config.commands ?? {},
    models: Object.fromEntries(modelRoles.map(r => [r, role(r)]))
  };
}

function choices(models) {
  return {
    reportLanguage: userLanguages, originalRuntime: originalRuntimes, phaseMode: phaseModes, mode: modes, verificationMode: verificationModes, executionMode: executionModes,
    effort: ['default', ...effortLevels], context: contextTiers,
    models: Array.isArray(models)
      ? models.filter(m => m.state === 'enabled').map(m => ({ id: m.id, name: m.name, efforts: m.efforts, ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}), contexts: m.contexts?.length ? m.contexts : ['default'] }))
      : models
  };
}

// The explanations and choices, kept out of the settings file so it holds
// only the values. Rewritten by every settings init; nothing reads it back.
function helpMarkdown(language, models) {
  const ja = language === 'ja', { _about, ...fields } = help[language], c = choices(models);
  const code = list => list.map(v => `\`${v}\``).join(ja ? '、' : ', ');
  const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const allowed = { reportLanguage: c.reportLanguage, originalRuntime: c.originalRuntime, phaseMode: c.phaseMode, mode: c.mode, verificationMode: c.verificationMode, executionMode: c.executionMode };
  const lines = [
    ja ? `# 実行設定の説明（${runSettingsFile}）` : `# Run settings help (${runSettingsFile})`, '',
    ja ? `${runSettingsFile} を埋めてから、AI の質問に「記入した」と答えてください。\`run_migration.mjs settings apply\` が全項目をまとめて確かめ、1つでも誤りがあれば何も書き込まずに全部の誤りを返します。このファイルは \`settings init\` のたびに作り直され、読み込みには使いません。`
      : `Fill in ${runSettingsFile}, then answer the AI's question with "filled in". \`run_migration.mjs settings apply\` checks every entry and, if any is wrong, writes nothing and returns every problem. This file is rewritten by every \`settings init\` and is never read back.`, '',
    ja ? '## 各欄' : '## Fields', '',
    ...Object.entries(fields).map(([key, text]) => `- \`${key}\`: ${text}${allowed[key] ? (ja ? `（選択肢: ${code(allowed[key])}）` : ` (choices: ${code(allowed[key])})`) : ''}`),
    ja ? `- \`models.*.effort\` の選択肢: ${code(c.effort)}（そのモデルが対応するものだけ）` : `- \`models.*.effort\` choices: ${code(c.effort)} (only those the model supports)`,
    ja ? `- \`models.*.context\` の選択肢: ${code(c.context)}` : `- \`models.*.context\` choices: ${code(c.context)}`, '',
    ja ? '## 使えるモデル' : '## Available models', ''
  ];
  if (Array.isArray(c.models)) lines.push(ja ? '| モデル ID | 名前 | エフォート | コンテキスト |' : '| Model ID | Name | Efforts | Contexts |', '|---|---|---|---|',
    ...c.models.map(m => `| \`${cell(m.id)}\` | ${cell(m.name)} | ${cell((m.efforts ?? []).map(e => e === m.defaultEffort ? `${e}${ja ? '（既定）' : ' (default)'}` : e).join(', ') || '-')} | ${cell(m.contexts.join(', '))} |`));
  else lines.push(ja ? `モデルの一覧を読めませんでした（${models}）。Copilot CLI にサインインしてから \`settings init\` をやり直してください。` : `The model list could not be read (${models}). Sign the Copilot CLI in, then run \`settings init\` again.`);
  return `${lines.join('\n')}\n`;
}

// Writes the file, or refreshes its explanations and choices when it exists
// (the person's values are kept as written). models is the account's list, or
// a string saying why it could not be read.
// source and target are the person's answer to the language question; they
// replace the languages in the file, and while the folders are still the
// template's, the source language's detected folders become sourceRoots.
export function initRunSettings(root, models, { source, target, sourceRoots } = {}) {
  const config = readConfigIfPresent(root);
  if (!config) throw new Error('migration/config.json is missing: initialize the project (install.mjs) before writing run settings');
  const file = safePath(root, runSettingsFile), exists = fs.existsSync(file);
  let values;
  if (exists) {
    try { values = readJSON(file); } catch (e) { throw new Error(`${runSettingsFile} is not valid JSON (${e.message}); correct it or delete it and run settings init again`); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${runSettingsFile} must be a JSON object; correct it or delete it and run settings init again`);
    values = Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith('_')));
    // An entry still FILL_IN takes what was chosen since (models set, preferences).
    const fill = (value, current) => unfilled(value) && current !== undefined && !unfilled(current) ? current
      : value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, current[k])])) : value;
    const current = currentValues(root, config, readPreferences(root));
    values = fill(values, current);
    // A file written before phaseMode existed gains it in its place.
    if (!Object.hasOwn(values, 'phaseMode')) values = Object.fromEntries(Object.entries({ ...values, phaseMode: current.phaseMode })
      .sort(([a], [b]) => (settingKeys.indexOf(a) + 1 || Infinity) - (settingKeys.indexOf(b) + 1 || Infinity)));
  } else values = currentValues(root, config, readPreferences(root));
  for (const [key, value] of [['source', source], ['target', target]]) if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error(`--${key} must name a language`);
  const detected = detectSourceLanguages(root, { exclude: [...config.outputRoots ?? [], ...config.verificationRoots ?? []] });
  // The source folders are still the template's when nothing could fill them
  // (files only at the repository root or in test folders, or a language with
  // no files here): the result then says to ask for them.
  let rootsUnchosen = false;
  if (source !== undefined) {
    values.sourceLanguage = canonicalLanguage(source, detected);
    const found = detected.languages.find(l => l.language === values.sourceLanguage);
    if (same(values.sourceRoots, templateRoots) && same(config.sourceRoots, templateRoots)) {
      if (found?.roots.length) values.sourceRoots = found.roots;
      else rootsUnchosen = true;
    }
  }
  if (target !== undefined) values.targetLanguage = target.trim();
  // The answer to the source-folder question, as a comma-separated list.
  if (sourceRoots !== undefined) {
    const dirs = typeof sourceRoots === 'string' ? [...new Set(sourceRoots.split(',').map(d => d.trim().replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '')).filter(Boolean))] : [];
    if (!dirs.length) throw new Error('--source-roots must name one or more folders, separated by commas');
    const missing = dirs.filter(d => { try { return !fs.statSync(safePath(root, d)).isDirectory(); } catch { return true; } });
    if (missing.length) throw new Error(`--source-roots: ${missing.join(', ')} ${missing.length > 1 ? 'are not folders' : 'is not a folder'} in the repository; ask for the source folders again`);
    values.sourceRoots = dirs;
  }
  // Still the template's folders once the languages are chosen, and the
  // source language has no files there: asked as a question, not left in the file.
  if (sourceRoots === undefined && !rootsUnchosen && !unfilled(values.sourceLanguage) && same(values.sourceRoots, templateRoots) && same(config.sourceRoots, templateRoots))
  {
    const found = detected.languages.find(l => l.language === canonicalLanguage(values.sourceLanguage, detected));
    let isDir = false;
    try { isDir = fs.statSync(safePath(root, templateRoots[0])).isDirectory(); } catch {}
    // A language the kit cannot detect keeps an existing src/ as it is.
    rootsUnchosen = !isDir || Boolean(found && !found.roots.includes(templateRoots[0]));
  }
  if (sourceRoots !== undefined) rootsUnchosen = false;
  const verificationFollowed = followOriginalRuntime(values);
  const language = [values.reportLanguage, readPreferences(root).userLanguage].find(l => userLanguages.includes(l)) ?? 'en';
  // Earlier versions wrote _help and _choices into the file; they are left
  // out above, so a refresh shrinks the file to its values.
  writeJSON(file, { _about: help[language]._about, ...values });
  atomicWrite(safePath(root, runSettingsHelpFile), helpMarkdown(language, models));
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
  const runtimeQuestion = runtimePending && !modelsPending && !languagesPending && !phaseModePending ? originalRuntimeQuestion(language, values.sourceLanguage) : undefined;
  if (modelsPending && !Array.isArray(models)) return { file: runSettingsFile, help: runSettingsHelpFile, created: !exists, refreshed: exists, pending, modelsListed: false, ...(languages ? { languages } : {}),
    next: `The model list could not be read (${models}). Offer no model choices: if the CLI is not signed in, start copilot login after the person agrees, then run settings init again.` };
  return { file: runSettingsFile, help: runSettingsHelpFile, created: !exists, refreshed: exists, pending, modelsListed: Array.isArray(models), ...(languages ? { languages } : {}),
    ...(runtimeQuestion ? { originalRuntimeQuestion: runtimeQuestion } : {}), ...(verificationFollowed ? { verificationModeFollowed: 'source-only' } : {}),
    next: modelsPending
      ? 'Models are not chosen yet. Run models list, ask one question for every role\'s model (choices: the enabled models), record it with models set --role all --model ID, then run settings init again.'
      : languagesPending
        ? 'Languages are not chosen yet. Ask languages.question as one question (choices: languages.choices, plus free text), then run settings init --source SOURCE --target TARGET with the guessed source unless the answer corrected it.'
        : rootsUnchosen
          ? `No folder holds ${values.sourceLanguage} files outside test folders, so sourceRoots is still the template's ${JSON.stringify(templateRoots)}. Say so and ask sourceRootsQuestion as one free-text question, then run settings init --source-roots DIR[,DIR] with the answer. Never ask the person to edit the file for it.`
        : `${phaseModePending
          ? 'The phase mode is not chosen yet. Ask one question with three choices: normal (recommended: each phase waits until its prerequisites are met), relaxed (a missing prerequisite is a warning, and you ask whether to fix it or proceed every time) or auto (relaxed without asking, for autopilot: completions, approvals and waivers are recorded unasked and marked auto). Record the answer with preferences --phase-mode normal|relaxed|auto (the file follows), then run settings init again.'
          : runtimePending
            ? 'Whether the original runs here is not chosen yet. Ask originalRuntimeQuestion as one question (choices: originalRuntimeQuestion.choices), record the answer with preferences --original-runtime available|unavailable (the file follows; unavailable also sets verificationMode to source-only there), then run settings init again. Never ask the person to edit the file for it.'
            : `${verificationFollowed ? 'originalRuntime is unavailable, so verificationMode in the file was set to source-only (the only mode that does not run the original); say so. ' : ''}Show the file path and the help file path, then ask one question: is the file filled in, or does the person have a question? On "filled in", run settings apply.`}`,
    ...(rootsUnchosen && !modelsPending && !languagesPending ? { sourceRootsUnchosen: true, sourceRootsQuestion: language === 'ja'
      ? `${values.sourceLanguage} のファイルがテスト以外のフォルダーに見つかりませんでした。移行元のフォルダーをリポジトリからの相対パスで書いてください（複数あるときはカンマ区切り。例: Legacy/App, Shared）。`
      : `No ${values.sourceLanguage} files were found outside test folders. Write the source folders as repository-relative paths (comma-separated; for example Legacy/App, Shared).` } : {}) };
}

// An original that cannot run here cannot be verified by running it: the
// only verification mode settings apply accepts is then source-only, so the
// file says so instead of stopping the apply on it. Returns whether it changed.
function followOriginalRuntime(values) {
  if (values.originalRuntime !== 'unavailable' || values.verificationMode !== 'runtime') return false;
  values.verificationMode = 'source-only';
  return true;
}

// The fourth question, after models, languages and the phase mode: whether
// the original can run here, ready to ask in the report language.
export function originalRuntimeQuestion(language, sourceLanguage) {
  const ja = language === 'ja', name = typeof sourceLanguage === 'string' && !unfilled(sourceLanguage) ? sourceLanguage : null;
  return ja ? {
    question: `移行元の${name ? ` ${name} の` : ''}プログラムを、この環境でビルドして実行できますか？ 動かせれば新旧の動作を比べて確かめ、動かせなければソースだけで確かめます（後から run-settings.json で変えられます）。`,
    choices: [{ value: 'available', label: '動かせる（available）' }, { value: 'unavailable', label: '動かせない（unavailable）' }]
  } : {
    question: `Can the original${name ? ` ${name}` : ''} program be built and run here? If it runs, the old and new behavior are compared; if not, behavior is checked from the source alone (you can change this later in run-settings.json).`,
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
  const file = safePath(root, runSettingsFile);
  if (!fs.existsSync(file)) throw new Error(`${runSettingsFile} is missing: run settings init first`);
  let value;
  try { value = readJSON(file); } catch (e) { throw new Error(`${runSettingsFile} is not valid JSON: ${e.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${runSettingsFile} must be a JSON object`);
  return value;
};

// Checks the whole file. Returns { errors, config, preferences }: the
// configuration and preferences it would write when errors is empty. models
// is the account's list (needed only to check model choices).
export function checkRunSettings(root, settings, models) {
  const existing = readConfigIfPresent(root);
  if (!existing) return { errors: ['migration/config.json is missing: initialize the project (install.mjs) first'] };
  const errors = [], config = structuredClone(existing);
  if (settings.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  for (const key of Object.keys(settings)) if (!key.startsWith('_') && !settingKeys.includes(key)) errors.push(`${key}: unknown setting (accepted: ${settingKeys.join(', ')}); fields starting with _ are ignored`);
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
  if (settings.originalRuntime === 'unavailable' && (settings.verificationMode ?? 'runtime') === 'runtime') errors.push('verificationMode: runtime runs the original, but originalRuntime is unavailable; choose source-only (or correct originalRuntime)');
  for (const key of configKeys) {
    if (!Object.hasOwn(settings, key)) { errors.push(`${key}: missing`); continue; }
    if (unfilled(settings[key]) || same(settings[key], config[key]) || (!Object.hasOwn(config, key) && Object.hasOwn(configDefaults, key) && same(settings[key], configDefaults[key]))) continue;
    config[key] = structuredClone(settings[key]);
  }
  if (Object.hasOwn(settings, 'commands') && (!settings.commands || typeof settings.commands !== 'object' || Array.isArray(settings.commands))) errors.push('commands: must be an object mapping each stage to null or an argv array');
  // Preferences are written after config.json: a file that cannot be read
  // must stop the apply before anything is written.
  try { readPreferences(root); } catch (e) { errors.push(`${e.message}; correct it before applying`); }
  // Models: each role's choice is checked against the account's list.
  const chosen = settings.models;
  if (!chosen || typeof chosen !== 'object' || Array.isArray(chosen)) errors.push('models: must map each role to { "model": ID, "effort": LEVEL|default, "context": default|long_context }');
  else {
    for (const key of Object.keys(chosen)) if (!modelRoles.includes(key)) errors.push(`models.${key}: unknown role (roles: ${modelRoles.join(', ')})`);
    config.models = { ...config.models };
    const efforts = { ...config.reasoningEfforts }, phaseModels = { ...config.phaseModels }, tiers = { ...config.contextTiers };
    for (const role of modelRoles) {
      const entry = chosen[role];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`models.${role}: missing; write { "model": ID, "effort": "default", "context": "default" }`); continue; }
      for (const key of Object.keys(entry)) if (!['model', 'effort', 'context'].includes(key)) errors.push(`models.${role}.${key}: unknown field (model, effort, context)`);
      const effort = entry.effort === undefined ? 'default' : entry.effort, context = entry.context === undefined ? 'default' : entry.context;
      if (typeof context !== 'string' || !contextTiers.includes(context)) { errors.push(`models.${role}.context: must be one of ${contextTiers.join(', ')}`); continue; }
      if (typeof entry.model !== 'string' || !entry.model.trim()) { errors.push(`models.${role}.model: write a model ID from the available models in ${runSettingsHelpFile}`); continue; }
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
        const recorded = role === 'surveyor' ? existing.phaseModels?.survey : existing.models?.[role];
        const model = typeof recorded === 'string' && recorded.toLowerCase() === choice.model.toLowerCase() ? recorded : choice.model;
        if (role === 'surveyor') phaseModels.survey = model; else config.models[role] = model;
        if (choice.effort) efforts[role] = choice.effort; else delete efforts[role];
        if (choice.context) tiers[role] = choice.context; else delete tiers[role];
      } catch (e) { errors.push(`models.${role}: ${e.message}`); }
    }
    if (!Array.isArray(models)) errors.push(`models: cannot check the model choices (${models})`);
    // An empty map is left out, as models set leaves it ({} and absent mean
    // the same to the reviewed configuration, see semanticConfig).
    for (const [key, value] of [['reasoningEfforts', efforts], ['phaseModels', phaseModels], ['contextTiers', tiers]]) {
      if (Object.keys(value).length) config[key] = value; else delete config[key];
    }
  }
  // The runner's own checks, on the configuration as it would be written,
  // run beside the other errors once nothing is left to fill in.
  if (!pendingFields(settings).length) {
    try { loadConfig(root, { config }); } catch (e) { errors.push(e.message); }
    // Checked with the listed spellings: a model recorded in another case is
    // still that model, and its efforts still apply (inherited ones too).
    const listed = id => (Array.isArray(models) && models.find(m => typeof id === 'string' && m.id.toLowerCase() === id.toLowerCase())?.id) ?? id;
    const canonical = { ...config, models: Object.fromEntries(Object.entries(config.models ?? {}).map(([r, id]) => [r, listed(id)])),
      ...(config.phaseModels?.survey ? { phaseModels: { ...config.phaseModels, survey: listed(config.phaseModels.survey) } } : {}) };
    try { if (Array.isArray(models)) checkAssignments(models, canonical); } catch (e) { errors.push(e.message); }
  }
  return { errors: [...new Set(errors)], config, preferences: { language: settings.reportLanguage, originalRuntime: settings.originalRuntime, ...(Object.hasOwn(settings, 'phaseMode') ? { phaseMode: settings.phaseMode } : {}) } };
}

export function applyRunSettings(root, models) {
  const settings = readSettings(root);
  const { errors, config, preferences } = checkRunSettings(root, settings, models);
  // Entries a question fills (models, languages, phase mode, whether the
  // original runs) are asked, never left for the person to type into the file.
  const asked = pendingFields(settings).filter(at => at.startsWith('models.') || ['sourceLanguage', 'targetLanguage', 'phaseMode', 'originalRuntime'].includes(at));
  if (errors.length) return { applied: false, file: runSettingsFile, errors,
    next: asked.length
      ? `Nothing was written. ${asked.join(', ')} ${asked.length > 1 ? 'are' : 'is'} still ${fillIn} and answered by a question: run settings init and follow its next (it asks them one at a time), then show any other error and ask again whether the file is filled in. Never ask the person to type these into the file.`
      : 'Nothing was written. Show every error, ask the person to correct the file, then ask again whether it is filled in.' };
  const before = readConfigIfPresent(root), oldPreferences = readPreferences(root), changed = Object.keys({ ...before, ...config })
    .filter(k => !same(before[k], config[k]) && !(same(before[k] ?? {}, {}) && same(config[k] ?? {}, {})));
  if (!same(before, config)) writeJSON(safePath(root, 'migration/config.json'), config);
  setPreferences(root, preferences);
  const preferenceChanges = [['reportLanguage', 'userLanguage', preferences.language], ['originalRuntime', 'originalRuntime', preferences.originalRuntime], ['phaseMode', 'phaseMode', preferences.phaseMode]]
    .filter(([, key, value]) => value !== undefined && oldPreferences[key] !== value).map(([name]) => name);
  return { applied: true, file: runSettingsFile, changed: [...changed, ...preferenceChanges],
    ...(!same(semanticConfig(before), semanticConfig(config)) ? { note: 'The reviewed configuration changed: reviewed units and stage records made under the previous configuration are checked again on the next run.' } : {}) };
}

// Whether the file still matches what is configured, without the model list
// (status must stay cheap and offline): absent, unfilled, applied or differs.
export function runSettingsState(root, config) {
  const file = safePath(root, runSettingsFile);
  if (!fs.existsSync(file)) return null;
  let settings;
  try { settings = readJSON(file); } catch { return { state: 'invalid', file: runSettingsFile }; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { state: 'invalid', file: runSettingsFile };
  const pending = pendingFields(settings);
  if (pending.length) return { state: 'unfilled', file: runSettingsFile, pending };
  let preferences = {};
  try { preferences = readPreferences(root); } catch {}
  const current = currentValues(root, config, preferences);
  const differs = [];
  if (settings.reportLanguage !== current.reportLanguage) differs.push('reportLanguage');
  if (settings.originalRuntime !== current.originalRuntime) differs.push('originalRuntime');
  if (Object.hasOwn(settings, 'phaseMode') && settings.phaseMode !== current.phaseMode) differs.push('phaseMode');
  // Languages compare with the configuration itself: Python to JavaScript is a real choice too.
  for (const key of configKeys) if (!same(settings[key], config[key] ?? current[key])) differs.push(key);
  for (const role of modelRoles) {
    const want = settings.models?.[role], have = current.models[role];
    if (!want || String(want.model).toLowerCase() !== String(have.model).toLowerCase() || (want.effort === undefined ? 'default' : want.effort) !== have.effort
      || (want.context === undefined ? 'default' : want.context) !== have.context) differs.push(`models.${role}`);
  }
  return differs.length ? { state: 'differs', file: runSettingsFile, differs } : { state: 'applied', file: runSettingsFile };
}

// models set and preferences change the same values from chat; the file
// follows them so it stays the record of the run's conditions and a later
// settings apply does not write the old choice back. Only what the command
// set is written: the roles it named (model, effort and context, as the
// command records them) and the preferences it was given, so the person's
// other unapplied edits stay.
export function syncRunSettings(root, { roles = [], keys = [] } = {}) {
  // A broken config.json is reported by the commands that read it; the
  // recorded preference still stands, and settings apply refuses until then.
  const file = safePath(root, runSettingsFile);
  let config = null;
  try { config = readConfigIfPresent(root); } catch {}
  if (!config || !fs.existsSync(file)) return null;
  let value, preferences = {};
  try { value = readJSON(file); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try { preferences = readPreferences(root); } catch {}
  const current = currentValues(root, config, preferences);
  for (const key of keys) if (!unfilled(current[key])) value[key] = current[key];
  if (keys.includes('originalRuntime')) followOriginalRuntime(value);
  if (roles.length && (!value.models || typeof value.models !== 'object' || Array.isArray(value.models))) value.models = {};
  for (const role of roles) if (current.models[role]) value.models[role] = current.models[role];
  writeJSON(file, value);
  return runSettingsFile;
}
