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
// Limits written in the configuration that continuous mode does not enforce.
// The template's own values (2 fix rounds, 100 calls, no timeouts) are left
// out; anything else was probably chosen on purpose, so doctor and the run
// reports name it instead of ignoring it silently.
const templateDefaults = { maxFixRounds: 2, maxAgentCalls: 100, timeoutSeconds: 0, commandTimeoutSeconds: 0 };
const limitKeys = ['maxAgentCalls', 'maxFixRounds', 'timeoutSeconds', 'commandTimeoutSeconds', 'maxRunInputBytes', 'transientRetries', 'maxConsecutiveFailures', 'maxAiCreditsPerCall'];
export const ignoredLimits = config => boundedExecution(config) ? [] :
  limitKeys.filter(key => config[key] !== undefined && config[key] !== templateDefaults[key]);
