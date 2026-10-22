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

// On Windows a rename over a file that another process (status polling, an
// editor, antivirus) has open briefly fails with EPERM/EACCES/EBUSY; retry for
// up to about two seconds, as graceful-fs does.
export function renameRetry(from, to, { platform = process.platform, rename = fs.renameSync } = {}) {
  for (let wait = 10; ; wait *= 2) {
    try { return rename(from, to); }
    catch (e) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || wait > 1280) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}
