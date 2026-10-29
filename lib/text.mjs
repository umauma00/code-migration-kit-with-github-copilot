// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { isUtf8 } from 'node:buffer';

// Source text in the encodings legacy trees use, decoded the way the bundled
// dependency mappers decode it (scripts/depmap_common.py read_source): a
// UTF-16/32 byte order mark, UTF-16 without one, UTF-8, then Japanese
// cp932 / EUC-JP when the text reads as Japanese, else windows-1252, which
// never fails. The original bytes are never changed; callers record the
// encoding beside the text so a worker knows it read a conversion.
// A declared encoding (config sourceEncoding, a WHATWG label such as
// shift_jis) is tried before the guesses: a Japanese file with kanji but no
// kana cannot be told from Latin-1 by its bytes.
// Returns { content, encoding } or { binary: true }.
const japanese = text => /[\u3000-\u30FF\uFF01-\uFF5E]/.test(text);
const kana = text => (text.match(/[\u3040-\u30FF]/g) ?? []).length;
const utf32 = (data, little) => {
  let out = '';
  for (let i = 0; i + 3 < data.length; i += 4) out += String.fromCodePoint(little ? data.readUInt32LE(i) : data.readUInt32BE(i));
  return out;
};
// cp932 is the name worker input uses for Shift_JIS; TextDecoder knows it as shift_jis.
export const encodingLabel = name => /^(?:cp|ms|windows-)932$/i.test(name) ? 'shift_jis' : name;
export function decodeSource(data, { declared } = {}) {
  const boms = [[[0xFF, 0xFE, 0, 0], 'utf-32le'], [[0, 0, 0xFE, 0xFF], 'utf-32be'], [[0xFF, 0xFE], 'utf-16le'], [[0xFE, 0xFF], 'utf-16be']];
  for (const [bom, label] of boms) {
    if (data.length < bom.length || bom.some((b, i) => data[i] !== b)) continue;
    try {
      const body = data.subarray(bom.length);
      return { content: label.startsWith('utf-32') ? utf32(body, label === 'utf-32le') : new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(body), encoding: label };
    } catch { return { binary: true }; }
  }
  if (data.includes(0)) {
    for (const [label, offset] of [['utf-16le', 1], ['utf-16be', 0]]) {
      let zero = 0, total = 0;
      for (let i = offset; i < data.length; i += 2) { total++; if (!data[i]) zero++; }
      if (data.length % 2 === 0 && zero >= total * 0.9) {
        try { return { content: new TextDecoder(label, { fatal: true }).decode(data), encoding: label }; } catch { break; }
      }
    }
    return { binary: true };
  }
  if (isUtf8(data)) return { content: data.toString('utf8'), encoding: 'utf-8' };
  if (declared) { try { return { content: new TextDecoder(encodingLabel(declared), { fatal: true }).decode(data), encoding: declared }; } catch {} }
  let best = null;
  for (const [label, name] of [['shift_jis', 'cp932'], ['euc-jp', 'euc-jp']]) {
    try {
      const content = new TextDecoder(label, { fatal: true }).decode(data), score = kana(content);
      if (japanese(content) && (!best || score > best.score)) best = { content, encoding: name, score };
    } catch {}
  }
  if (best) return { content: best.content, encoding: best.encoding };
  return { content: new TextDecoder('windows-1252').decode(data), encoding: 'windows-1252' };
}
export function readSourceText(file, name, { declared } = {}) {
  const decoded = decodeSource(fs.readFileSync(file), { declared });
  if (decoded.binary) throw new Error(`Review input must be text: ${name}`);
  if (decoded.content.includes('\0')) throw new Error(`Review input must be text: ${name}`);
  return decoded;
}
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
