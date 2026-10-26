// Behavior check for a fixed ported/math_ops.mjs: node checks/math_ops.mjs FILE
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readCandidate } from './common.mjs';
const file = process.argv[2];
readCandidate(file);
const { divide } = await import(pathToFileURL(file).href);
assert.deepEqual(divide(7, 2), [3, 1]);
assert.deepEqual(divide(-7, 2), [-4, 1]);
assert.deepEqual(divide(7, -2), [-4, -1]);
assert.deepEqual(divide(-7, -2), [3, -1]);
assert.throws(() => divide(1, 0), /division by zero/);
