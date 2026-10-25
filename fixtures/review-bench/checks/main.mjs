// Run a fixed main.mjs with known dependencies and compare its JSON output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const text = fs.readFileSync(process.argv[2], 'utf8');
assert.match(text, /PORT STATUS/, 'PORT STATUS trailer missing');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-main-'));
try {
  fs.writeFileSync(path.join(scratch, 'main.mjs'), text);
  for (const name of ['math_ops.mjs', 'text_ops.mjs']) {
    fs.copyFileSync(new URL(`../../mini/expected/${name}`, import.meta.url), path.join(scratch, name));
  }
  const cases = [
    [{ a: 7, b: 2, name: 'Ada' }, { quotient: 3, remainder: 1, greeting: 'Hello, Ada', length: 3 }],
    [{ a: -7, b: 2, name: '\u{1F600}x' }, { quotient: -4, remainder: 1, greeting: 'Hello, \u{1F600}x', length: 2 }],
    [{ a: 7, b: -2, name: '' }, { quotient: -4, remainder: -1, greeting: 'Hello, ', length: 0 }],
    [{ a: 1, b: 0, name: 'Ada' }, { error: 'division by zero' }]
  ];
  for (const [input, expected] of cases) {
    const result = spawnSync(process.execPath, [path.join(scratch, 'main.mjs')], {
      cwd: scratch, input: JSON.stringify(input), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || 'main did not exit successfully');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
