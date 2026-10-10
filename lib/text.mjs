// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { isUtf8 } from 'node:buffer';

export function readUtf8(file, name) {
  const data = fs.readFileSync(file);
  if (!isUtf8(data)) throw new Error(`Review input must be valid UTF-8: ${name}; convert the file to UTF-8 before retrying`);
  const content = data.toString('utf8');
  if (content.includes('\0')) throw new Error(`Review input must be text: ${name}`);
  return content;
}
