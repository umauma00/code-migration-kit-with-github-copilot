// SPDX-License-Identifier: Apache-2.0
// Copilot has no repository setting that denies shell commands, so the
// upstream settings.json deny list becomes a human-installed policy file that
// the preToolUse hook enforces for every agent session (not only workers).
// Like the upstream deny rules, this is a guardrail, not a security boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const guardrailsFile = 'migration/guardrails.json';
const shellTools = new Set(['bash', 'Bash', 'shell', 'powershell', 'write_bash', 'run_in_terminal', 'runInTerminal', 'terminal']);
const wrappers = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup']);

export function parseGuardrails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) throw new Error(`${guardrailsFile} must be an object with schemaVersion 1`);
  const deny = value.denyCommands ?? [];
  if (!Array.isArray(deny) || deny.some(rule => typeof rule !== 'string' || !rule.trim())) throw new Error(`${guardrailsFile}: denyCommands must be nonempty strings`);
  const waiver = value.waiver;
  if (waiver !== undefined && (typeof waiver !== 'object' || typeof waiver.note !== 'string' || !waiver.note.trim())) throw new Error(`${guardrailsFile}: waiver needs a nonempty note`);
  return { denyCommands: deny.map(rule => rule.trim().split(/\s+/)), waiver };
}

export function readGuardrails(root) {
  const file = path.join(root, guardrailsFile);
  if (!fs.existsSync(file)) return null;
  return parseGuardrails(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Upstream prompts 03/04 refuse to fan out without the human-installed denies.
export function requireGuardrails(root, phase) {
  const install = `Propose the deny list from \`run_migration.mjs guardrails show\` (or a waiver with its reason) to the human in chat. Once they agree, run \`run_migration.mjs guardrails install\` with the agreed --add/--remove/--deny or --waiver options: the host asks the person to confirm that exact command, and that confirmation is their act. Never create or edit ${guardrailsFile} any other way.`;
  let policy;
  try { policy = readGuardrails(root); }
  catch (e) { throw new Error(`Phase ${phase} guardrails are invalid: ${e.message}. ${install}`); }
  if (!policy) throw new Error(`Phase ${phase} requires human-installed command guardrails. ${install}`);
  if (!policy.denyCommands.length && !policy.waiver) throw new Error(`Phase ${phase} guardrails deny nothing and record no waiver. ${install}`);
  return policy;
}

// The upstream deny list is installed by the human. Chat-only use keeps that:
// the agent proposes, and this runner command (a host-confirmed human gate, see
// humanGate) writes the file. Comma-separated lists keep the argv free of the
// separators the hook splits commands on.
const list = value => value === undefined ? [] : String(value).split(',').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
export function guardrailsProposal(root, kitRoot, config) {
  const template = JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/guardrails.json'), 'utf8'));
  const configured = ['build', 'smoke', 'parity', 'typecheck', 'original', 'mutation'].map(name => config?.commands?.[name])
    .filter(Array.isArray).map(argv => argv.slice(0, 2).map(w => w.split(/[\\/]/).pop()).join(' '));
  let current = null, currentError;
  try { current = readGuardrails(root); } catch (e) { currentError = e.message; }
  return { file: guardrailsFile, installed: current ? { denyCommands: current.denyCommands.map(r => r.join(' ')), waiver: current.waiver ?? null } : null,
    ...(currentError ? { invalid: currentError } : {}), template: template.denyCommands,
    configuredCommands: [...new Set(configured)],
    note: 'Agree the list with the human. Runner-owned commands (config.commands) run as runner processes and are not affected by these denies; listing their command words still stops agents from running the same builds/tests by hand. A cheap per-unit typecheck that dissolves Step 4 must not be denied.' };
}
export function installGuardrails(root, kitRoot, { deny, add, remove, waiver, replace = false } = {}) {
  const file = path.join(root, guardrailsFile);
  if (fs.existsSync(file) && !replace) throw new Error(`${guardrailsFile} already exists; pass --replace to change it (still the human's confirmed act)`);
  if (waiver !== undefined && (deny !== undefined || add !== undefined || remove !== undefined)) throw new Error('Choose a deny list or a waiver, not both');
  let value;
  if (waiver !== undefined) value = { schemaVersion: 1, waiver: { note: String(waiver) } };
  else {
    const template = JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/guardrails.json'), 'utf8'));
    const base = deny !== undefined ? list(deny) : template.denyCommands;
    const removed = new Set(list(remove));
    for (const r of removed) if (!base.includes(r)) throw new Error(`Cannot remove "${r}": it is not in the deny list`);
    value = { schemaVersion: 1, denyCommands: [...new Set([...base.filter(r => !removed.has(r)), ...list(add)])] };
  }
  parseGuardrails(value);
  if (!value.waiver && !value.denyCommands.length) throw new Error('A guardrails file must deny something or record a waiver');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(temp, file);
  return { file: guardrailsFile, written: value, note: 'Installed by the human through the host confirmation of this exact command.' };
}

// Each pipeline/list segment is checked separately; leading VAR=value
// assignments, common wrappers and executable directories are ignored.
const segments = command => String(command).split(/&&|\|\||[;|\n&`()]|\$\(/);
export function deniedRule(command, denyCommands) {
  for (const segment of segments(command)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || wrappers.has(words[0]))) words.shift();
    if (!words.length) continue;
    words[0] = words[0].split(/[\\/]/).pop();
    const rule = denyCommands.find(tokens => tokens.every((token, i) => words[i] === token));
    if (rule) return rule.join(' ');
  }
  return null;
}

function projectRoot(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'migration/config.json'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

export function guardrailDecision(event, cwd = process.cwd()) {
  const name = event.toolName ?? event.tool_name;
  if (!shellTools.has(name)) return null;
  const root = projectRoot(event.cwd ?? cwd);
  if (!root) return null;
  let policy;
  try { policy = readGuardrails(root); }
  catch (e) { return `Migration guardrails are invalid (${e.message}); shell commands are denied until the human fixes ${guardrailsFile}.`; }
  if (!policy?.denyCommands.length) return null;
  let args = event.toolArgs ?? event.tool_input ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return 'Malformed tool arguments'; } }
  const command = args?.command ?? args?.input ?? args?.cmd;
  if (typeof command !== 'string') return null;
  const rule = deniedRule(command, policy.denyCommands);
  return rule ? `"${rule}" is denied by ${guardrailsFile} during the migration. This is the design working: report it instead of routing around it; the runner or the human runs builds and tests.` : null;
}

// Interactive (parent) sessions: the human's acts stay the human's.
// - Agents never create or edit migration/guardrails.json (upstream: installing
//   the denies is the human's act; Claude Code protected its settings file).
// - Recording an approval, a phase completion, a pilot grant or a verification
//   profile switch asks the person to confirm that exact command in the host.
// Like the deny rules, this is a guardrail against accidental self-approval,
// not a security boundary.
const readOnlyWords = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'jq', 'ls', 'stat', 'wc', 'diff', 'file', 'test', '[', 'git', 'type', 'Get-Content', 'gc']);
const writeTool = /edit|write|create|patch|replace|insert|rename|delete|move|remove/i;
const mentionsGuardrails = text => /(?:^|[\\/"'\s=>])migration[\\/]+guardrails\.json/.test(text);
function guardrailsWrite(command) {
  for (const segment of segments(command)) {
    if (!mentionsGuardrails(` ${segment}`)) continue;
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || wrappers.has(words[0]))) words.shift();
    const head = words[0]?.split(/[\\/]/).pop();
    if (/>/.test(segment) || !readOnlyWords.has(head) || (head === 'jq' && words.includes('-i')) || (head === 'git' && !['diff', 'log', 'status', 'show'].includes(words[1]))) return true;
  }
  return false;
}
function writeTargets(args) {
  const out = [];
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'target', 'destination', 'new_path', 'newPath', 'old_path', 'uri']) if (typeof args?.[key] === 'string') out.push(args[key]);
  for (const key of ['filePaths', 'paths', 'files']) if (Array.isArray(args?.[key])) for (const v of args[key]) { if (typeof v === 'string') out.push(v); else if (typeof v?.path === 'string') out.push(v.path); else if (typeof v?.filePath === 'string') out.push(v.filePath); }
  // apply_patch style inputs name their files in headers.
  for (const key of ['input', 'patch', 'diff']) if (typeof args?.[key] === 'string') {
    for (const m of args[key].matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) out.push((m[1] ?? m[2]).trim());
  }
  return out;
}
function isGuardrailsFile(root, cwd, p) {
  const value = String(p).replace(/^file:\/\//, '');
  const full = path.resolve(cwd ?? root, value);
  return full === path.join(root, guardrailsFile) || /(?:^|[\\/])migration[\\/]+guardrails\.json$/.test(value) && path.resolve(root, value) === path.join(root, guardrailsFile);
}
// Runner subcommands that record a human decision. Every chained segment is
// checked, so a harmless first command cannot carry an approval past the host.
export function humanGate(command) {
  for (const segment of segments(command)) {
    const gate = segmentGate(segment);
    if (gate) return gate;
  }
  return null;
}
function segmentGate(segment) {
  const words = segment.split(/\s+/).map(w => w.replace(/^["']+|["']+$/g, '')).filter(Boolean);
  const at = words.findIndex(w => /(?:^|[\\/])run_migration\.mjs$/.test(w));
  if (at < 0) return null;
  const valued = new Set(['--root', '--note', '--deny', '--add', '--remove', '--waiver', '--run', '--max-rounds', '--copilot', '--batch', '--targets', '--target', '--sources', '--through', '--language', '--tokens', '--subagents', '--model', '--evidence', '--queue', '--pid', '--format', '--message']);
  const positional = [];
  for (let i = at + 1; i < words.length; i++) {
    if (words[i].startsWith('--')) { if (valued.has(words[i])) i++; continue; }
    positional.push(words[i]);
  }
  const [cmd, sub] = positional;
  if (cmd === 'approve') return `approve ${sub ?? ''}`.trim();
  if (cmd === 'phase' && sub === 'complete') return `phase complete ${positional[2] ?? ''}`.trim();
  if (cmd === 'pilot' && sub === 'prepare') return 'pilot prepare';
  if (cmd === 'guardrails' && sub === 'install') return 'guardrails install';
  if (cmd === 'build-loop') return 'build-loop';
  if (cmd === 'sessions' && sub === 'prune') return 'sessions prune';
  if (cmd === 'source-spec' && sub === 'init' && words.includes('--apply')) return 'source-spec init --apply';
  return null;
}
function language(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'migration/preferences.json'), 'utf8')).userLanguage === 'ja' ? 'ja' : 'en'; } catch { return 'en'; }
}
// Returns null, or { decision: 'deny' | 'ask', reason }.
export function interactiveDecision(event, cwd = process.cwd()) {
  const name = event.toolName ?? event.tool_name;
  const root = projectRoot(event.cwd ?? cwd);
  if (!root || !name) return null;
  let args = event.toolArgs ?? event.tool_input ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return shellTools.has(name) ? { decision: 'deny', reason: 'Malformed tool arguments' } : null; } }
  const ja = language(root) === 'ja';
  const guardReason = ja
    ? `${guardrailsFile} の設置・変更は人間の判断です。ファイルを直接書かず、禁止リスト（または免除理由）をチャットで提案し、合意後に \`run_migration.mjs guardrails install\` を実行してください（ホストが利用者に確認を求めます）。`
    : `${guardrailsFile} is the human's decision. Do not write it directly: propose the deny list (or a waiver) in chat and, after agreement, run \`run_migration.mjs guardrails install\` (the host asks the person to confirm).`;
  if (!shellTools.has(name)) {
    // Only the files a write tool targets matter, not text that mentions the file.
    if (writeTool.test(name) && writeTargets(args).some(p => isGuardrailsFile(root, event.cwd ?? cwd, p))) return { decision: 'deny', reason: guardReason };
    return null;
  }
  const command = args?.command ?? args?.input ?? args?.cmd;
  if (typeof command !== 'string') return null;
  if (guardrailsWrite(command)) return { decision: 'deny', reason: guardReason };
  const denied = guardrailDecision(event, cwd);
  if (denied) return { decision: 'deny', reason: denied };
  const gate = humanGate(command);
  if (gate === 'guardrails install') return { decision: 'ask', reason: ja
    ? `「${gate}」はコマンド制限（${guardrailsFile}）の設置で、人間の判断です。チャットで合意した禁止リスト（または免除理由）と一致する場合だけ許可してください。`
    : `"${gate}" installs the command guardrails (${guardrailsFile}), which is the human's decision. Allow it only if it matches the deny list (or waiver) you agreed in chat.` };
  if (gate === 'build-loop') return { decision: 'ask', reason: ja
    ? `「${gate}」は、指定回数までbuildの承認・実行と、レビュー付きの修正を繰り返す一括の許可で、人間の判断です。チャットで合意した回数と内容の場合だけ許可してください。`
    : `"${gate}" grants repeated build approvals and reviewed repairs up to the round limit, which is the human's decision. Allow it only if it matches the rounds and note you agreed in chat.` };
  if (gate === 'sessions prune') return { decision: 'ask', reason: ja
    ? `「${gate}」はこのキットのワーカーが残したCopilot CLIのセッション記録を削除します（元に戻せません）。チャットで同意した場合だけ許可してください。`
    : `"${gate}" deletes the Copilot CLI session transcripts left by this kit's workers (not undoable). Allow it only if you agreed in chat.` };
  if (gate) return { decision: 'ask', reason: ja
    ? `「${gate}」は承認・完了の記録で、人間の判断です。対象の成果物をあなたが確認済みの場合だけ許可してください。`
    : `"${gate}" records an approval or completion, which is the human's decision. Allow it only if you reviewed the artifacts it names.` };
  return null;
}

// Copilot CLI loads repository hooks (.github/hooks) only in trusted folders;
// plugin hooks load regardless. A trusted ancestor also trusts the project.
export function cliFolderTrust(root, home = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')) {
  const file = path.join(home, 'config.json');
  let folders;
  try {
    const text = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
    folders = JSON.parse(text).trustedFolders ?? [];
    if (!Array.isArray(folders)) return 'unknown';
  } catch { return 'unknown'; }
  const project = fs.realpathSync(root);
  const real = folder => { try { return fs.realpathSync(folder); } catch { return path.resolve(folder); } };
  return folders.some(folder => typeof folder === 'string' && (project === real(folder) || project.startsWith(`${real(folder)}${path.sep}`))) ? 'trusted' : 'untrusted';
}
