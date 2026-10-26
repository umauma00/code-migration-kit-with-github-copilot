#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Reproducible source index for the interruption-policy review. This lexical
// index includes error propagation and ordinary loop breaks as candidates; it
// is not a claim to enumerate failures inside arbitrary external programs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const roots = ['lib', 'scripts', '.github/extensions', '.github/hooks', 'com.github.copilot/hooks', 'templates', '.github/workflows'];
const candidate = /\bthrow\b|\breject\s*\(|\bfail(?:All)?\s*\(|\.abort\s*\(|\.kill\s*\(|process\.exit(?:Code)?\b|sys\.exit\s*\(|\braise\s+|\bbreak\b|return done\s*\(|\btimeout(?:Ms|Seconds|Sec|-minutes)?\b|\bexit\s+["$\d]|boundedExecution|executionLimits|executionMode|config\.max|limits\.(?:calls|fixRounds|inputBytes|retries|consecutiveFailures)/;
export function auditInterruptions(root) {
  const files = [];
  const visit = rel => {
    if (rel === 'lib/vendor') return;
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) { for (const name of fs.readdirSync(full).sort()) visit(`${rel}/${name}`); return; }
    if (!/\.(?:mjs|py|sh|json|yml)$/.test(rel) || rel === 'scripts/audit_interruptions.mjs') return;
    const source = fs.readFileSync(full, 'utf8');
    const entries = source.split(/\r?\n/).flatMap((code, i) => {
      if (!candidate.test(code)) return [];
      const kind = /process\.kill\([^,]+,\s*0\)/.test(code) ? 'pid-probe'
        : /\.kill\s*\(|SIGKILL|taskkill/.test(code) ? 'process-termination'
        : /\.abort\s*\(/.test(code) ? 'cancellation'
        : /timeout/i.test(code) ? 'deadline-or-observation'
        : /\bbreak\b|return done/.test(code) ? 'loop-exit-candidate' : 'error-or-exit-candidate';
      return [{ line: i + 1, kind, code: code.trim() }];
    });
    files.push({ path: rel, sha256: crypto.createHash('sha256').update(source).digest('hex'), entries });
  };
  for (const rel of roots) visit(rel);
  return { schemaVersion: 1, scope: 'All maintained lib/scripts sources, extension bridges, hook and runtime templates, and CI settings. Excludes tests, fixtures, vendor code and external programs. Entries include non-terminating error/control-flow candidates for manual review.',
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')), candidateLines: files.reduce((n, f) => n + f.entries.length, 0) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(auditInterruptions(fileURLToPath(new URL('../', import.meta.url))), null, 2));
}
