#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardrailDecision } from '../lib/guardrails.mjs';
export function decide(event, role, cwd) {
  // Interactive sessions are restricted only by the human-installed guardrails.
  if (!role) return guardrailDecision(event, cwd);
  if (role.startsWith('reviewer-') && !role.endsWith('-read')) return 'Independent reviewers have no tools; use only the supplied frozen input.';
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
export function decisionOutput(reason, vscode = false) {
  if (!reason) return {};
  const decision = { permissionDecision: 'deny', permissionDecisionReason: reason };
  // Explicit harness selection, never infer it from snake_case input keys.
  // Local templates can also be loaded by CLI, which consumes the top level.
  return vscode ? { ...decision, hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } } : decision;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let input = '';
  for await (const part of process.stdin) input += part;
  try {
    const event = JSON.parse(input), reason = decide(event, process.env.MIGRATION_KIT_ROLE);
    console.log(JSON.stringify(decisionOutput(reason, process.argv.includes('--vscode'))));
  } catch (e) { console.error(`Migration hook: ${e.message}`); process.exitCode = 2; }
}
