// SPDX-License-Identifier: Apache-2.0
// How the runner reacts to a failed worker call under parallel execution:
// - transient (rate limits, 5xx, network, the CLI's internal event stall):
//   retry the same call with backoff;
// - systemic (sign-in, credits, missing CLI/agents, invalid profiles, models):
//   stop the whole run, because every other unit would fail the same way;
// - anything else: block only that unit (and the units that depend on it).
const text = error => `${error?.message ?? error ?? ''}\n${error?.result?.stderr ?? ''}`;
// The CLI's own runtime gave up waiting for its host process to take an event
// (CLI 1.0.105, a fixed wait reported as 120 s: "Session host did not
// acknowledge 'assistant.reasoning' delivery within ..."; its 60 s counterpart
// says the event poll loop "may be wedged"). No setting that lengthens the
// wait was found in CLI 1.0.105.
export const hostStallPattern = /Session host did not acknowledge '[^'\r\n]*' delivery within|event delivery was not acknowledged by the session host|event poll loop may be wedged/i;
// A stall that repeats this often on one call is not passing on its own:
// block that unit (and its dependants) instead of retrying it forever. Counted
// apart from other transient retries, within the usual retry limit.
export const hostStallRetries = 5;
export const isHostStall = error => hostStallPattern.test(text(error));

export function isTransientFailure(error) {
  const value = text(error);
  // User cancellation or the kit's own explicitly chosen deadline is final.
  // A timeout reported by the service or network is not: a retry finishes it.
  if (/explicit (?:bounded )?deadline|Interrupted/.test(value)) return false;
  if (/\b(?:request|connection|response|stream|upstream|operation|read|connect) timed out\b|\btimed out (?:waiting|while)\b/i.test(value)) return true;
  if (hostStallPattern.test(value)) return true;
  // A bare 500 also appears in sizes and limits, so it counts only as a status.
  return /session\.error rate_limit|\b429\b|rate[ -]?limit|too many requests|overloaded|temporar(?:il)?y unavailable|service unavailable|\b50[234]\b|session\.error (?:\S+ )?500\b|\b500 Internal Server Error|internal server error|bad gateway|gateway timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|network (?:error|timeout)|fetch failed/i.test(value);
}

export function isSystemicFailure(error) {
  return /Too many open files|\bEMFILE\b|session\.error (?:authentication|authorization|forbidden|quota\w*|billing\w*|credits?\w*)\b|To authenticate, you can use|run the '\/login' command|not (?:signed|logged) in to (?:GitHub|Copilot)|authentication (?:failed|required)|\b401 Unauthorized\b|Bad credentials|\bAI Credits?\b|spending limit|quota (?:exceeded|exhausted)|budget (?:exceeded|exhausted|reached)|No such agent|did not report its agent list|spawn \S*copilot|Cannot read the Copilot CLI version|requires tools: |Remove profile model override|is shadowed or duplicated|model ["'`]?[\w.:-]+["'`]? (?:is )?(?:not available|not supported|unavailable|not found)|unknown model/i.test(text(error));
}

export const retryDelayMs = (config, attempt) => Math.min((config.transientRetryDelayMs ?? 5000) * 2 ** Math.min(attempt, 30), 60000);
