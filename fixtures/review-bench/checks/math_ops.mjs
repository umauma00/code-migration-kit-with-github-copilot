// Behavior check for a fixed ported/math_ops.mjs: node checks/math_ops.mjs FILE
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const file = process.argv[2];
assert.match(fs.readFileSync(file, 'utf8'), /PORT STATUS/, 'PORT STATUS trailer missing');
const { divide } = await import(pathToFileURL(file).href);
assert.deepEqual(divide(7, 2), [3, 1]);
assert.deepEqual(divide(-7, 2), [-4, 1]);
assert.deepEqual(divide(7, -2), [-4, -1]);
assert.deepEqual(divide(-7, -2), [3, -1]);
assert.throws(() => divide(1, 0), /division by zero/);
