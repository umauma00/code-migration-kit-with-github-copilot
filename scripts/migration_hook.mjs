#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { interactiveDecision } from '../lib/guardrails.mjs';
export function decide(event, role, cwd) {
  // Interactive sessions: the human-installed guardrails, plus the human's own
  // acts (guardrails.json edits are denied, approvals ask for confirmation).
  if (!role) { const d = interactiveDecision(event, cwd); return d?.decision === 'deny' ? d.reason : d; }
  if (role.startsWith('reviewer-') && !role.endsWith('-read')) return 'Independent reviewers have no tools; use only the supplied frozen input.';
  if (role === 'surveyor') return 'Surveyors have no tools; use only the supplied frozen scope input.';
  if (role === 'preparation-auditor') return 'Preparation auditors have no tools; use only the supplied frozen audit request.';
  const name = event.toolName ?? event.tool_name;
  if (!name) return 'Malformed hook event: tool name missing';
  if (!['view', 'Read', 'read', 'grep', 'rg', 'Grep', 'glob', 'Glob', 'search'].includes(name)) return `Migration ${role} is read-only; the coordinator performs writes and commands.`;
  let args = event.toolArgs ?? event.tool_input ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return 'Malformed tool arguments'; } }
  if (role.endsWith('-read')) {
    // Tool-assisted reviewers read the listed evidence only: never the whole
    // repository or another worker's records and receipts.
    // view names one path; grep/rg and glob name `paths` (a string or an
    // array; CLI 1.0.105), and leaving it out searches the whole directory.
    // Every target key present is checked, so one key cannot hide another.
    const present = ['path', 'file_path', 'paths'].filter(key => args?.[key] !== undefined);
    const targets = present.flatMap(key => Array.isArray(args[key]) ? args[key] : [args[key]]);
    // An empty list may mean the default, the whole directory.
    if (!targets.length || present.some(key => Array.isArray(args[key]) && !args[key].length) || targets.some(t => typeof t !== 'string' || !t.trim())) return 'Tool-assisted reviewers must name a listed file or directory';
    // A glob pattern is relative to those paths and must stay inside them: no
    // "..", no absolute or drive-letter start, also inside {a,b} alternatives.
    if (/^glob$/i.test(name) && args?.pattern !== undefined && (typeof args.pattern !== 'string' || args.pattern.includes('..') || /(^|[{,])\s*([\\/~]|[A-Za-z]:)/.test(args.pattern)))
      return `Tool-assisted reviewers may not search ${String(args.pattern)}; use only the listed evidence files`;
    const base = path.resolve(event.cwd ?? cwd ?? process.cwd());
    // Resolve links (a listed path must not alias a record directory) and compare
    // case-insensitively: macOS and Windows treat Migration/Runs as migration/runs.
    // A missing leaf resolves through its nearest existing ancestor.
    const real = p => {
      const rest = [];
      for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
        try { return path.join(fs.realpathSync.native(dir), ...rest.reverse()); }
        catch { if (path.dirname(dir) === dir) return path.resolve(p); rest.push(path.basename(dir)); }
      }
    };
    const records = /^migration\/(runs|state|results|gates|phases|pilots?)(\/|$)/i;
    for (const target of targets) {
      // Windows ignores trailing dots and spaces in a name (migration/runs.).
      const relative = path.relative(real(base), real(path.resolve(base, target))).split(path.sep).map(part => process.platform === 'win32' ? part.replace(/[. ]+$/, '') || part : part).join('/');
      if (!relative || /^migration$/i.test(relative) || relative.split('/')[0] === '..' || path.isAbsolute(relative) || records.test(relative)) return `Tool-assisted reviewers may not read ${target}; use only the listed evidence files`;
    }
  }
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
    const event = JSON.parse(input), reason = decide(event, process.env.MIGRATION_KIT_ROLE);
    // --vscode is accepted for existing Local templates; output is the same.
    console.log(JSON.stringify(decisionOutput(reason)));
  } catch (e) { console.error(`Migration hook: ${e.message}`); process.exitCode = 2; }
}
