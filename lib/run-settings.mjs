// SPDX-License-Identifier: Apache-2.0
// Run settings in one file the person fills in, instead of one question per
// setting. `settings init` writes migration/run-settings.json from the current
// configuration with the account's models as choices; `settings apply` checks
// every entry, reports every problem at once and writes nothing unless all
// pass. Accepted values go where they already live: languages, roots, models
// and commands in migration/config.json; the report language and whether the
// original can run in migration/preferences.json, so changing those never
// revokes approvals. The file stays as the record of the conditions a run
// used; status says whether it still matches the configuration.
import fs from 'node:fs';
import { safePath, writeJSON, roles, effortLevels, contextTiers, loadConfig, semanticConfig } from './core.mjs';
import { readPreferences, setPreferences, userLanguages, originalRuntimes } from './preferences.mjs';
import { checkChoice, checkAssignments, readConfigIfPresent } from './models.mjs';

export const runSettingsFile = 'migration/run-settings.json';
export const fillIn = 'FILL_IN';
export const sameAsImplementer = 'same-as-implementer';
const modelRoles = [...roles, 'surveyor'];
const modes = ['preserve', 'redesign'], verificationModes = ['runtime', 'source-only'], executionModes = ['continuous', 'bounded'];
// The settings the person decides, in the order the file shows them. Every
// other configuration key keeps its value in config.json.
const configKeys = ['sourceLanguage', 'targetLanguage', 'mode', 'sourceRoots', 'outputRoots', 'verificationRoots', 'verificationMode', 'executionMode', 'concurrency', 'commands'];
const settingKeys = ['schemaVersion', 'reportLanguage', 'originalRuntime', ...configKeys, 'models'];
// Template defaults are examples, not choices: before a manifest exists, a
// fresh file asks for the languages instead of offering the example pair.
const templateLanguages = { sourceLanguage: 'Python', targetLanguage: 'JavaScript' };
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
    _about: 'このファイルを埋めてから、AI の質問に「記入した」と答えてください。`run_migration.mjs settings apply` が全項目をまとめて確かめ、1つでも誤りがあれば何も書き込まずに全部の誤りを返します。`_` で始まる欄は説明と選択肢で、読み込みでは無視します。',
    reportLanguage: '報告の言語。ja か en。',
    originalRuntime: '移行元のコードをこの環境で実行できるか。available か unavailable。',
    sourceLanguage: '移行元の言語（例: C#、Java、COBOL）。', targetLanguage: '移行先の言語（例: TypeScript、Go）。',
    mode: 'preserve は動作をそのまま移す、redesign は設計を変える。',
    sourceRoots: '移行元のフォルダー（リポジトリからの相対パスの配列）。', outputRoots: '移行先のコードを書くフォルダー。', verificationRoots: '動作確認に使うテストのフォルダー。',
    verificationMode: 'runtime は元のコードを実行して比べる、source-only は実行できないときにソースだけで確かめる。',
    executionMode: 'continuous は終わるまで続ける、bounded は config.json の上限で止める。', concurrency: '同時に動かすワーカーの数（1〜64）。',
    commands: '各段階のコマンド。null か、["コマンド", "引数", ...] の配列。',
    models: '担当ごとのモデル ID とエフォート。モデル ID は _choices.models から選ぶ。エフォートは default か、そのモデルの efforts のどれか。context は default か、そのモデルの contexts にあるときだけ long_context（料金が上がります）。surveyor の model に same-as-implementer を書くと implementer と同じになり、そのときの default は implementer のエフォート・コンテキスト。'
  },
  en: {
    _about: 'Fill in this file, then answer the AI\'s question with "filled in". `run_migration.mjs settings apply` checks every entry and, if any is wrong, writes nothing and returns every problem. Fields starting with `_` are explanations and choices; reading ignores them.',
    reportLanguage: 'Report language: ja or en.',
    originalRuntime: 'Whether the original code can run here: available or unavailable.',
    sourceLanguage: 'Language migrated from (for example C#, Java, COBOL).', targetLanguage: 'Language migrated to (for example TypeScript, Go).',
    mode: 'preserve keeps the behavior; redesign changes the design.',
    sourceRoots: 'Source folders (array of repository-relative paths).', outputRoots: 'Folders the migrated code is written to.', verificationRoots: 'Test folders used to check behavior.',
    verificationMode: 'runtime runs the original to compare; source-only checks from the source alone when it cannot run.',
    executionMode: 'continuous runs until done; bounded stops at the limits in config.json.', concurrency: 'Workers running at once (1-64).',
    commands: 'Command for each stage: null, or an array ["command", "arg", ...].',
    models: 'Model ID and effort per role. Pick model IDs from _choices.models. Effort is default or one of that model\'s efforts. Context is default, or long_context when that model\'s contexts list it (it costs more). A surveyor model of same-as-implementer follows the implementer, and its default then means the implementer\'s effort and context.'
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
    reportLanguage: userLanguages, originalRuntime: originalRuntimes, mode: modes, verificationMode: verificationModes, executionMode: executionModes,
    effort: ['default', ...effortLevels], context: contextTiers,
    models: Array.isArray(models)
      ? models.filter(m => m.state === 'enabled').map(m => ({ id: m.id, name: m.name, efforts: m.efforts, ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}), contexts: m.contexts?.length ? m.contexts : ['default'] }))
      : models
  };
}

// Writes the file, or refreshes its explanations and choices when it exists
// (the person's values are kept as written). models is the account's list, or
// a string saying why it could not be read.
export function initRunSettings(root, models) {
  const config = readConfigIfPresent(root);
  if (!config) throw new Error('migration/config.json is missing: initialize the project (install.mjs) before writing run settings');
  const file = safePath(root, runSettingsFile), exists = fs.existsSync(file);
  let values;
  if (exists) {
    try { values = readJSON(file); } catch (e) { throw new Error(`${runSettingsFile} is not valid JSON (${e.message}); correct it or delete it and run settings init again`); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${runSettingsFile} must be a JSON object; correct it or delete it and run settings init again`);
    values = Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith('_')));
  } else values = currentValues(root, config, readPreferences(root));
  const language = [values.reportLanguage, readPreferences(root).userLanguage].find(l => userLanguages.includes(l)) ?? 'en';
  const { _about, ...fieldHelp } = help[language];
  writeJSON(file, { _about, ...values, _help: fieldHelp, _choices: choices(models) });
  const pending = pendingFields(values);
  return { file: runSettingsFile, created: !exists, refreshed: exists, pending, modelsListed: Array.isArray(models),
    next: 'Show the file path, then ask one question: is the file filled in, or does the person have a question? On "filled in", run settings apply.' };
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
      if (typeof entry.model !== 'string' || !entry.model.trim()) { errors.push(`models.${role}.model: write a model ID from _choices.models`); continue; }
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
    // An empty map stays as it was written ({} or absent): rewriting it would
    // change the reviewed configuration without changing any choice.
    for (const [key, value] of [['reasoningEfforts', efforts], ['phaseModels', phaseModels], ['contextTiers', tiers]]) {
      if (Object.keys(value).length || config[key] !== undefined) config[key] = value;
    }
  }
  if (!errors.length) {
    // The runner's own checks, on the configuration as it would be written.
    try { loadConfig(root, { config }); } catch (e) { errors.push(e.message); }
    // Checked with the listed spellings: a model recorded in another case is
    // still that model, and its efforts still apply (inherited ones too).
    const listed = id => (Array.isArray(models) && models.find(m => typeof id === 'string' && m.id.toLowerCase() === id.toLowerCase())?.id) ?? id;
    const canonical = { ...config, models: Object.fromEntries(Object.entries(config.models ?? {}).map(([r, id]) => [r, listed(id)])),
      ...(config.phaseModels?.survey ? { phaseModels: { ...config.phaseModels, survey: listed(config.phaseModels.survey) } } : {}) };
    try { if (Array.isArray(models)) checkAssignments(models, canonical); } catch (e) { errors.push(e.message); }
  }
  return { errors, config, preferences: { language: settings.reportLanguage, originalRuntime: settings.originalRuntime } };
}

export function applyRunSettings(root, models) {
  const settings = readSettings(root);
  const { errors, config, preferences } = checkRunSettings(root, settings, models);
  if (errors.length) return { applied: false, file: runSettingsFile, errors,
    next: 'Nothing was written. Show every error, ask the person to correct the file, then ask again whether it is filled in.' };
  const before = readConfigIfPresent(root), oldPreferences = readPreferences(root), changed = Object.keys({ ...before, ...config }).filter(k => JSON.stringify(before[k]) !== JSON.stringify(config[k]));
  if (changed.length) writeJSON(safePath(root, 'migration/config.json'), config);
  setPreferences(root, preferences);
  const preferenceChanges = [['reportLanguage', 'userLanguage', preferences.language], ['originalRuntime', 'originalRuntime', preferences.originalRuntime]]
    .filter(([, key, value]) => oldPreferences[key] !== value).map(([name]) => name);
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
  // Languages compare with the configuration itself: Python to JavaScript is a real choice too.
  for (const key of configKeys) if (!same(settings[key], config[key] ?? current[key])) differs.push(key);
  for (const role of modelRoles) {
    const want = settings.models?.[role], have = current.models[role];
    if (!want || String(want.model).toLowerCase() !== String(have.model).toLowerCase() || (want.effort === undefined ? 'default' : want.effort) !== have.effort
      || (want.context === undefined ? 'default' : want.context) !== have.context) differs.push(`models.${role}`);
  }
  return differs.length ? { state: 'differs', file: runSettingsFile, differs } : { state: 'applied', file: runSettingsFile };
}
