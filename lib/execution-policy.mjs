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
