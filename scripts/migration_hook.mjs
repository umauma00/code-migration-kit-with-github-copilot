#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { interactiveDecision } from '../lib/guardrails.mjs';
export function decide(event, role, cwd) {
  // Interactive sessions: the human-installed guardrails, plus the human's own
  // acts (guardrails.json edits are denied, approvals ask for confirmation).
  if (!role) { const d = interactiveDecision(event, cwd); return d?.decision === 'deny' ? d.reason : d; }
  if (role.startsWith('reviewer-') && !role.endsWith('-read')) return 'Independent reviewers have no tools; use only the supplied frozen input.';
  if (role === 'surveyor') return 'Surveyors have no tools; use only the supplied frozen scope input.';
  const name = event.toolName ?? event.tool_name;
  if (!name) return 'Malformed hook event: tool name missing';
  if (!['view', 'Read', 'read', 'grep', 'rg', 'Grep', 'glob', 'Glob', 'search'].includes(name)) return `Migration ${role} is read-only; the coordinator performs writes and commands.`;
  let args = event.toolArgs ?? event.tool_input ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return 'Malformed tool arguments'; } }
  if (role.endsWith('-read')) {
    // Tool-assisted reviewers read the listed evidence only: never the whole
    // repository or another worker's records and receipts.
    const target = args?.path ?? args?.file_path;
    if (typeof target !== 'string' || !target.trim()) return 'Tool-assisted reviewers must name a listed file or directory';
    const base = event.cwd ?? cwd ?? process.cwd(), rel = path.relative(base, path.resolve(base, target)).split(path.sep).join('/');
    if (!rel || rel === 'migration' || rel.startsWith('..') || /^migration\/(runs|state|results|gates|phases|pilots?)(\/|$)/.test(rel)) return `Tool-assisted reviewers may not read ${target}; use only the listed evidence files`;
  }
  return null;
}
// nativeInput file: the dedicated reader profile declares this hook with its
// role. It admits only reads of a claimed, in-flight request file of that role
// in the live run, and records the admission so the runner can tell the host
// actually ran the agent-scoped hook.
const nativeRoles = new Set(['implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer', 'surveyor']);
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const promptFile = new RegExp(`^migration/runs/([0-9]+-[a-f0-9]{8})/native/(${uuid})/prompt\\.txt$`);
const readTools = /^(?:view|read|read_file|readfile|copilot_readfile)$/i;
export function decideNativeRead(event, role, cwd) {
  if (!nativeRoles.has(role)) return 'Unknown native file-input role';
  const name = event.toolName ?? event.tool_name;
  if (typeof name !== 'string' || !readTools.test(name)) return 'Native file-input workers may only read their request file; no other tool is available.';
  let args = event.toolArgs ?? event.tool_input ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return 'Malformed tool arguments'; } }
  const target = args?.path ?? args?.file_path ?? args?.filePath;
  if (typeof target !== 'string' || !target.trim()) return 'Name the request file given in the delegation message';
  const base = path.resolve(event.cwd ?? cwd ?? process.cwd());
  let root = base;
  while (!fs.existsSync(path.join(root, 'migration/config.json'))) { if (path.dirname(root) === root) return 'No migration project for this read'; root = path.dirname(root); }
  const full = path.resolve(base, target), rel = path.relative(root, full).split(path.sep).join('/'), match = rel.match(promptFile);
  if (!match) return `Native file-input workers may read only their request file, not ${target}`;
  const [run, id] = match.slice(1), dir = path.join(root, 'migration/runs', run, 'native', id);
  try {
    if (fs.realpathSync(full) !== path.join(fs.realpathSync(root), rel)) return 'Request file path must not traverse links';
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'migration/run.lock'), 'utf8'));
    const request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
    const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (lock.runId !== run || request.task !== `${run}/${id}` || request.nativeInput !== 'file' || request.promptFile !== rel) return 'Request file does not belong to the live runner';
    if (request.role !== role) return `This request is for ${request.role}, not ${role}`;
    if (!fs.existsSync(path.join(dir, 'claim.json')) || ['response.json', 'closed.json'].some(f => fs.existsSync(path.join(dir, f)))) return 'Request is not claimed and in flight';
    if (request.promptSha256 !== digest) return 'Request file changed after it was issued';
    const receipt = path.join(dir, 'reader.json'), temp = `${receipt}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, task: request.task, role, promptSha256: digest, toolName: name, readAt: new Date().toISOString() }));
    fs.renameSync(temp, receipt);
  } catch (e) { return `Cannot verify the request file: ${e.message}`; }
  return null;
}
// A string is a denial; { decision: 'ask', reason } asks the person to confirm.
export function decisionOutput(result) {
  if (!result) return {};
  const ask = typeof result === 'object' && result.decision === 'ask';
  const decision = { permissionDecision: ask ? 'ask' : 'deny', permissionDecisionReason: ask ? result.reason : String(result) };
  // Always emit both shapes. Copilot CLI reads the top level; VS Code also loads
  // CLI-format .github/hooks files but reads hookSpecificOutput, so a CLI-only
  // answer would let VS Code agents through. Each consumer ignores the other key.
  return { ...decision, hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let input = '';
  for await (const part of process.stdin) input += part;
  try {
    const event = JSON.parse(input), at = process.argv.indexOf('--native-file');
    const reason = at > 0 ? decideNativeRead(event, process.argv[at + 1]) : decide(event, process.env.MIGRATION_KIT_ROLE);
    // --vscode is accepted for existing Local templates; output is the same.
    console.log(JSON.stringify(decisionOutput(reason)));
  } catch (e) { console.error(`Migration hook: ${e.message}`); process.exitCode = 2; }
}
