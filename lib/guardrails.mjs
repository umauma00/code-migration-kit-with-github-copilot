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
  const install = `Ask the human to copy the kit's templates/guardrails.json to ${guardrailsFile} and adapt denyCommands to this target's build/test commands, or to record a waiver there: {"schemaVersion":1,"waiver":{"note":"why"}}. Agents must never create or edit this file.`;
  let policy;
  try { policy = readGuardrails(root); }
  catch (e) { throw new Error(`Phase ${phase} guardrails are invalid: ${e.message}. ${install}`); }
  if (!policy) throw new Error(`Phase ${phase} requires human-installed command guardrails. ${install}`);
  if (!policy.denyCommands.length && !policy.waiver) throw new Error(`Phase ${phase} guardrails deny nothing and record no waiver. ${install}`);
  return policy;
}

// Each pipeline/list segment is checked separately; leading VAR=value
// assignments, common wrappers and executable directories are ignored.
export function deniedRule(command, denyCommands) {
  for (const segment of String(command).split(/&&|\|\||[;|\n&`()]|\$\(/)) {
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
