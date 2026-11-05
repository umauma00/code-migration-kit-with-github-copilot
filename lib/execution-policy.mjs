// SPDX-License-Identifier: Apache-2.0
// Old installations contain 600-second and per-run call/round defaults. Those
// values are not an instruction to kill useful work. Only an explicitly chosen
// bounded mode enforces them; an explicit per-command budget still applies.
export const boundedExecution = config => config.executionMode === 'bounded';
export const executionLimits = config => ({
  calls: boundedExecution(config) ? config.maxAgentCalls : Infinity,
  fixRounds: boundedExecution(config) ? config.maxFixRounds : Infinity,
  inputBytes: boundedExecution(config) ? config.maxRunInputBytes ?? Infinity : Infinity,
  retries: boundedExecution(config) ? config.transientRetries ?? 2 : Infinity,
  consecutiveFailures: boundedExecution(config) ? config.maxConsecutiveFailures ?? 3 : Infinity,
  aiCredits: boundedExecution(config) ? config.maxAiCreditsPerCall : undefined
});
export const processTimeout = (config, key) => boundedExecution(config) ? (config[key] ?? 0) * 1000 : 0;
// How long a worker call may show no sign of progress (nothing at all from its
// CLI: no streamed text, reasoning or event) before it is stopped and retried,
// in both modes: it is not a deadline, a call that keeps writing runs as long
// as it needs. Each earlier silent attempt of the same call doubles the wait,
// up to four times the setting (10, 20, 40, 40... minutes by default), so a
// call that only thinks long without a word gets more room on every retry.
// workerSilenceSeconds 0 turns the check off (and workers stream nothing).
export const defaultWorkerSilenceSeconds = 600;
export const silenceWait = (baseMs, silentAttempts = 0) => baseMs > 0 ? baseMs * 2 ** Math.min(2, Math.max(0, Math.floor(silentAttempts) || 0)) : 0;
export const workerSilenceMs = (config, silentAttempts = 0) => silenceWait((config.workerSilenceSeconds ?? defaultWorkerSilenceSeconds) * 1000, silentAttempts);
// How long one worker call of the translation loop may run, in both modes: a
// call still at work past it is stopped, tried once more with a note on what
// happened, and then its file is set aside for the run (lib/pipeline.mjs).
// The silence check above cannot see such a call: on 2026-11-05 (Windows,
// CLI 1.0.105) calls told to read every listed file in full read a 1 MB
// generated dependency 20 KB at a time (the most view returns), one model
// turn each, and ran 1.5 to 3.5 hours, writing all along. The limit grows
// with the files a call reads whole (the unit's source and current target,
// the RULEBOOK and the design inputs; the caller adds up ownBytes), one minute
// for every 8 KiB, so the translation of a large file keeps the time it needs
// (the 1016 KB file of that run: 157 minutes and more, where its implementer
// took 57). While the silence check is on, a call at its limit that has written
// nothing for lib/process.mjs callIdleMs is stopped at its next output, or
// by the silence check first. workerCallMinutes 0 turns the
// limit off.
export const defaultWorkerCallMinutes = 30;
export const callLimitMinutes = (config, ownBytes = 0) => {
  const base = config.workerCallMinutes ?? defaultWorkerCallMinutes;
  return base > 0 ? base + Math.floor(Math.max(0, Number(ownBytes) || 0) / 8192) : 0;
};
// Limits written in the configuration that continuous mode does not enforce.
// The template's own values (2 fix rounds, 100 calls, no timeouts) are left
// out; anything else was probably chosen on purpose, so doctor and the run
// reports name it instead of ignoring it silently.
const templateDefaults = { maxFixRounds: 2, maxAgentCalls: 100, timeoutSeconds: 0, commandTimeoutSeconds: 0 };
const limitKeys = ['maxAgentCalls', 'maxFixRounds', 'timeoutSeconds', 'commandTimeoutSeconds', 'maxRunInputBytes', 'transientRetries', 'maxConsecutiveFailures', 'maxAiCreditsPerCall'];
export const ignoredLimits = config => boundedExecution(config) ? [] :
  limitKeys.filter(key => config[key] !== undefined && config[key] !== templateDefaults[key]);
