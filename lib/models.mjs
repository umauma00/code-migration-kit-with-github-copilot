// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { roles, safePath, readJSON, writeJSON, effortLevels, effortRoles, workerEffort, validateEfforts } from './core.mjs';

// The person running the kit picks each worker's model and reasoning effort
// from what their own account offers. The list comes from the Copilot CLI's
// headless server (`models.list`, the call behind the SDK's listModels()): ids,
// policy state, supported reasoning efforts and billing, for the signed-in account.
export { effortLevels, effortRoles, workerEffort, validateEfforts };

// Minimal JSON-RPC 2.0 client over stdio with Content-Length framing, the
// transport the Copilot SDK uses for `copilot --headless --stdio`.
function rpcSession(command, prefixArgs, { cwd, timeoutMs, signal }) {
  // No --no-auto-update: list the models of the same build the workers run.
  const child = spawn(command, [...prefixArgs, '--headless', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, COPILOT_ALLOW_ALL: 'false' } });
  const pending = new Map();
  let buffer = Buffer.alloc(0), nextId = 0, stderr = '', ended = null;
  const failAll = error => { ended ??= error; for (const { reject } of pending.values()) reject(error); pending.clear(); };
  const timer = setTimeout(() => { failAll(new Error(`Copilot CLI model list timed out after ${timeoutMs / 1000} s`)); child.kill(); }, timeoutMs);
  const abort = () => { failAll(new Error('Interrupted')); child.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.on('error', e => failAll(new Error(`Cannot start the Copilot CLI (${command}): ${e.message}`)));
  child.on('close', code => failAll(new Error(`Copilot CLI exited (code ${code}) before answering${stderr ? `: ${stderr.slice(-500)}` : ''}`)));
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const head = buffer.indexOf('\r\n\r\n');
      if (head < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, head).toString('ascii'))?.[1]);
      if (!Number.isSafeInteger(length)) { failAll(new Error('Copilot CLI sent a malformed message')); child.kill(); return; }
      if (buffer.length < head + 4 + length) return;
      let message;
      try { message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString('utf8')); } catch { message = null; }
      buffer = buffer.subarray(head + 4 + length);
      const waiter = message && pending.get(message.id);
      if (!waiter) continue; // notifications and server requests are not needed here
      pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? 'Copilot CLI request failed'), { code: message.error.code }));
      else waiter.resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (ended) { reject(ended); return; }
    const id = ++nextId, body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    pending.set(id, { resolve, reject });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  const close = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); ended ??= new Error('closed'); child.stdin.end(); child.kill(); };
  return { call, close };
}

export function normalizeModels(models) {
  if (!Array.isArray(models)) throw new Error('Copilot CLI returned no model list');
  return models.filter(m => typeof m?.id === 'string' && m.id).map(m => ({
    id: m.id, name: typeof m.name === 'string' ? m.name : m.id,
    // No policy means no organization restriction applies.
    state: m.policy?.state ?? 'enabled',
    efforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.filter(e => typeof e === 'string') : [],
    ...(typeof m.defaultReasoningEffort === 'string' ? { defaultEffort: m.defaultReasoningEffort } : {}),
    ...(Number.isFinite(m.billing?.multiplier) ? { multiplier: m.billing.multiplier } : {}),
    ...(m.billing?.tokenPrices && typeof m.billing.tokenPrices === 'object' ? { tokenPrices: m.billing.tokenPrices } : {}),
  }));
}

export async function listAvailableModels({ command = 'copilot', prefixArgs = [], cwd, timeoutMs = 60000, signal } = {}) {
  const rpc = rpcSession(command, prefixArgs, { cwd, timeoutMs, signal });
  try {
    try { await rpc.call('connect', {}); }
    catch (e) { if (e.code === -32601) await rpc.call('ping', {}); else throw e; }
    let result;
    try { result = await rpc.call('models.list', {}); }
    catch (e) {
      if (/not authenticated|authenticate first|401/i.test(e.message)) throw new Error(`The Copilot CLI is not signed in to Copilot, so it cannot list your models; run copilot login first (${e.message})`);
      throw new Error(`Copilot CLI could not list models: ${e.message}`);
    }
    return normalizeModels(result?.models);
  } finally { rpc.close(); }
}

const configPath = root => safePath(root, 'migration/config.json');
export function currentAssignments(config) {
  return effortRoles.map(role => ({ role, model: role === 'surveyor' ? (config.phaseModels?.survey ?? config.models?.implementer ?? null) : (config.models?.[role] ?? null),
    effort: workerEffort(config, role) ?? null, ...(role === 'surveyor' && !config.phaseModels?.survey ? { inherits: 'implementer' } : {}) }));
}

// One check for a person's choice: the model is listed and enabled for the
// account, and the effort is one the model supports ("default" clears it).
export function checkChoice(models, model, effort) {
  const found = models.find(m => m.id === model) ?? models.find(m => m.id.toLowerCase() === String(model).toLowerCase());
  if (!found) throw new Error(`Model ${model} is not in your Copilot model list; run models list and pick one of its ids`);
  if (found.state !== 'enabled') throw new Error(`Model ${found.id} is ${found.state} for your account (an organization policy or terms decide this); pick an enabled model`);
  if (effort === undefined || effort === 'default') return { model: found.id, effort: undefined };
  if (!effortLevels.includes(effort)) throw new Error(`Effort must be one of ${effortLevels.join(', ')} or default`);
  if (!found.efforts.includes(effort)) throw new Error(found.efforts.length ? `Model ${found.id} supports reasoning effort ${found.efforts.join(', ')}; not ${effort}` : `Model ${found.id} has no selectable reasoning effort; use default`);
  return { model: found.id, effort };
}

const roleList = value => {
  const out = [];
  for (const r of String(value ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (r === 'all') out.push(...roles);
    else if (r === 'reviewers') out.push('reviewer-semantics', 'reviewer-rules');
    else if (effortRoles.includes(r)) out.push(r);
    else throw new Error(`Unknown role ${r}: use ${effortRoles.join(', ')}, reviewers or all`);
  }
  if (!out.length) throw new Error('models set requires --role ROLE[,ROLE] (or reviewers, all)');
  return [...new Set(out)];
};
// Writes the person's choice into migration/config.json. models and
// reasoningEfforts decide what workers produce, so a change revokes reviewed
// units and stage records like any other semantic configuration change.
export function setRoleModels(root, models, { role, model, effort }) {
  if (!model) throw new Error('models set requires --model ID from models list');
  if (!fs.existsSync(configPath(root))) throw new Error('migration/config.json is missing: initialize the project (install.mjs) before recording model choices');
  const targets = roleList(role), choice = checkChoice(models, model, effort);
  const file = configPath(root), config = readJSON(file);
  config.models ??= {};
  for (const r of targets) {
    if (r === 'surveyor') { config.phaseModels = { ...config.phaseModels, survey: choice.model }; }
    else config.models[r] = choice.model;
    if (choice.effort) config.reasoningEfforts = { ...config.reasoningEfforts, [r]: choice.effort };
    else if (config.reasoningEfforts) delete config.reasoningEfforts[r];
  }
  if (config.reasoningEfforts && !Object.keys(config.reasoningEfforts).length) delete config.reasoningEfforts;
  validateEfforts(config);
  writeJSON(file, config);
  return { updated: targets, model: choice.model, effort: choice.effort ?? 'default', assignments: currentAssignments(config),
    note: 'Model and effort are part of the reviewed configuration: units reviewed under the previous choice are reviewed again on the next run.' };
}

export function readConfigIfPresent(root) {
  const file = configPath(root);
  return fs.existsSync(file) ? readJSON(file) : null;
}

const cell = s => String(s).replace(/\|/g, '\\|');
const price = m => {
  const p = m.tokenPrices;
  if (p && (p.input !== undefined || p.output !== undefined)) return `${p.input ?? '?'} / ${p.output ?? '?'}`;
  return m.multiplier !== undefined ? `x${m.multiplier}` : '';
};
// A list the parent agent shows as is and turns into choices for the person.
export function modelsMarkdown(models, config, language = 'en') {
  const ja = language === 'ja';
  const usable = models.filter(m => m.state === 'enabled'), other = models.filter(m => m.state !== 'enabled');
  const lines = [ja ? '## 利用できるモデル' : '## Available models', '',
    ja ? '| モデル ID | 名前 | エフォート（既定） | 料金 |' : '| Model ID | Name | Effort (default) | Price |', '| --- | --- | --- | --- |',
    ...usable.map(m => `| \`${cell(m.id)}\` | ${cell(m.name)} | ${m.efforts.length ? `${m.efforts.join(', ')}${m.defaultEffort ? ` (${m.defaultEffort})` : ''}` : '—'} | ${cell(price(m))} |`)];
  if (other.length) lines.push('', ja ? `利用できないモデル（組織の設定または利用規約）: ${other.map(m => `\`${m.id}\` (${m.state})`).join(', ')}` : `Not available (organization policy or terms): ${other.map(m => `\`${m.id}\` (${m.state})`).join(', ')}`);
  if (config) {
    lines.push('', ja ? '## 現在の割り当て' : '## Current assignment', '', ja ? '| 担当 | モデル | エフォート |' : '| Role | Model | Effort |', '| --- | --- | --- |',
      ...currentAssignments(config).map(a => `| ${a.role} | ${a.model && !/SELECT_MODEL/.test(a.model) ? `\`${cell(a.model)}\`` : (ja ? '未選択' : 'not chosen')}${a.inherits ? (ja ? '（implementer と同じ）' : ' (as implementer)') : ''} | ${a.effort ?? (ja ? '既定' : 'default')} |`));
  }
  return lines.join('\n');
}
