// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export function readCandidate(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.trimEnd().split(/\r?\n/);
  const last = lines.pop() ?? '';
  assert.match(last, /^\s*(?:\/\/\s*PORT STATUS\b[^\r\n]*|\/\*\s*PORT STATUS\b[^\r\n]*\*\/)\s*$/,
    'File must end with a PORT STATUS comment');
  // Removing a real final comment leaves a valid module. A lookalike inside
  // a multiline string or block cannot close that construct after removal.
  const parsed = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: lines.join('\n'), encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024
  });
  if (parsed.error) throw parsed.error;
  assert.equal(parsed.status, 0, parsed.stderr || 'PORT STATUS must be a final comment');
  return text;
}
