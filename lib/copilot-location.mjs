// SPDX-License-Identifier: Apache-2.0
// Where the kit last found a Copilot CLI that worked, and VS Code's copilot
// shims, which are not the CLI. lib/process.mjs uses both when it looks up
// the bare command copilot.
//
// On 2026-11-09 a company PC reset the user's environment from time to time:
// its PATH lost npm's folder, `copilot` was no longer found in PowerShell, and
// the agent offered to install the CLI again. The kit now remembers the file
// of a Copilot CLI that answered (its --version) and runs it when PATH has
// none. The record belongs to the person, not to a project (a project folder
// can be opened from another computer): copilot-cli.json in
// ~/.copilot-migration-kit, beside the person's Copilot home, as the
// workers' home is (an absolute COPILOT_HOME moves both).
//
// VS Code puts a copilot command of its own on PATH that starts the real CLI
// it finds, and offers to install one when it finds none: since VS Code 1.143
// a native shim, <VS Code>\bin\copilot-shim\copilot.exe (Windows setup adds
// that folder to PATH; integrated terminals get it at the end of theirs), and
// before it, scripts in globalStorage\github.copilot-chat\copilotCli
// (copilot.bat and copilot.ps1, first in the terminal's PATH). Without a
// terminal the native shim writes "GitHub Copilot CLI was not found..." and
// exits with 127. A shim the kit found first used to stand in for the CLI,
// so the place the kit remembered was never tried. The kit now passes over a
// shim and runs one only when it finds no CLI anywhere else. A shim is told
// by its content, as VS Code's own shim tells the others (its REQUIREMENTS.md,
// checked 2026-11-10): the marker every native shim build holds, or every
// line of a legacy wrapper's signature.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { renameRetry } from './text.mjs';

export const copilotRecordName = 'copilot-cli.json';
// Read from the kit's own environment, never a worker's (a worker with
// workerCopilotHome "separate" runs with another COPILOT_HOME).
export function copilotRecordFile(env = process.env) {
  const configured = env.COPILOT_HOME;
  const home = configured && path.isAbsolute(configured) ? path.resolve(configured) : path.join(os.homedir(), '.copilot');
  return path.join(`${home}-migration-kit`, copilotRecordName);
}
// The command names the Copilot CLI: copilot, or a path to copilot(.exe|.cmd|.bat)
// (copilot.ps1 is never run). Only these are looked up in the remembered
// place and recorded: a test or a person may run the CLI through node and a script.
export function namesCopilot(command, platform = process.platform) {
  if (typeof command !== 'string' || !command) return false;
  const name = (platform === 'win32' ? path.win32 : path.posix).basename(command);
  return platform === 'win32' ? /^copilot(?:\.(?:exe|cmd|bat))?$/i.test(name) : name === 'copilot';
}
// The recorded file, or null when there is none or it cannot be read.
export function readCopilotRecord(file = copilotRecordFile()) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return value && typeof value === 'object' && typeof value.path === 'string' && path.isAbsolute(value.path) ? value : null;
  } catch { return null; }
}
export const rememberedCopilot = (file = copilotRecordFile()) => readCopilotRecord(file)?.path ?? null;
const samePath = (a, b, platform) => platform === 'win32' ? path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase() : path.posix.normalize(a) === path.posix.normalize(b);
// Writes only a change, so commands that keep finding the same CLI write nothing.
export function writeCopilotRecord(found, { via, version, recordFile = copilotRecordFile(), platform = process.platform, now = new Date() } = {}) {
  const current = readCopilotRecord(recordFile);
  if (current && samePath(current.path, found, platform)) return { recorded: false, unchanged: true, file: recordFile, path: found };
  const record = { path: found, foundIn: via, ...(version ? { version } : {}), recordedAt: now.toISOString(),
    note: 'The Copilot CLI the code migration kit last found working. The kit runs it when copilot is not on PATH. Delete this file to forget it.' };
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  const temp = `${recordFile}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' }); renameRetry(temp, recordFile); }
  finally { fs.rmSync(temp, { force: true }); }
  return { recorded: true, file: recordFile, path: found, ...(current ? { replaced: current.path } : {}) };
}

// The marker every build of VS Code's native shim holds. A larger file is not
// a shim (about 1 MB; the real CLI is about 150 MB) and is never read.
const shimMarker = Buffer.from('VSCODE_COPILOT_RUST_SHIM_V1');
const shimMaxBytes = 16 * 1024 * 1024, scriptMaxBytes = 128 * 1024;
// Every line of one row marks a legacy wrapper (VS Code's REQUIREMENTS.md):
// the batch file that runs copilot.ps1, and the POSIX launchers.
const legacyWrappers = [
  { start: /^@echo off/i, all: [/powershell/i, /-ExecutionPolicy Bypass/i, /-File/i, /copilot(?:CLIShim)?\.ps1/i] },
  { start: /^#!\/bin\/sh/, all: [/unset NODE_OPTIONS/, /ELECTRON_RUN_AS_NODE=1/, /copilotCLIShim\.js/, /"\$@"/] },
  { start: /^#!\/bin\/sh/, all: [/\bexec\b/, /copilot\.bat/, /"\$@"/] }
];
const shimCache = new Map();
function readStart(file, size, limit) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, limit));
    let read = 0;
    while (read < buffer.length) { const n = fs.readSync(fd, buffer, read, buffer.length - read, read); if (!n) break; read += n; }
    return buffer.subarray(0, read);
  } finally { fs.closeSync(fd); }
}
// True for VS Code's copilot shim. A file that cannot be read is not one
// (the lookup then treats it as it did before).
export function isVSCodeShim(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile() || stat.size > shimMaxBytes) return false;
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}`;
  if (shimCache.has(key)) return shimCache.get(key);
  let shim = false;
  try {
    const start = readStart(file, stat.size, shimMaxBytes);
    if (start.includes(shimMarker)) shim = true;
    else {
      const text = start.subarray(0, scriptMaxBytes).toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
      shim = legacyWrappers.some(row => row.start.test(text) && row.all.every(marker => marker.test(text)));
    }
  } catch { shim = false; }
  shimCache.set(key, shim);
  return shim;
}

// How to run a file from a terminal: PowerShell's call operator and bash. On
// Windows, Git Bash takes /c/... paths, and runs npm's extensionless shell
// shim beside its copilot.cmd.
export const powershellQuote = value => `'${String(value).replace(/['‘’‚‛]/g, q => q + q)}'`;
export const shellQuote = value => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;
export function bashPath(file, platform = process.platform) {
  if (platform !== 'win32') return file;
  const drive = /^([A-Za-z]):[\\/]/.exec(file);
  return drive ? `/${drive[1].toLowerCase()}/${file.slice(3).replace(/\\/g, '/')}` : file.replace(/\\/g, '/');
}
export function terminalCommands(file, args = [], { platform = process.platform, exists = fs.existsSync } = {}) {
  const sh = platform === 'win32' && /\.cmd$/i.test(file) && exists(file.slice(0, -4)) ? file.slice(0, -4) : file;
  return {
    powershell: ['&', powershellQuote(file), ...args.map(powershellQuote)].join(' '),
    bash: [shellQuote(bashPath(sh, platform)), ...args.map(shellQuote)].join(' ')
  };
}
