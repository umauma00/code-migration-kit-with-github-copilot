// SPDX-License-Identifier: Apache-2.0
// How the runner reacts to a failed worker call under parallel execution:
// - transient (rate limits, 5xx, network, the CLI's internal event stall or
//   lock wait): retry the same call with backoff;
// - systemic (sign-in, credits, missing CLI/agents, invalid profiles, models):
//   stop the whole run, because every other unit would fail the same way;
// - anything else: block only that unit (and the units that depend on it).
const text = error => `${error?.message ?? error ?? ''}\n${error?.result?.stderr ?? ''}`;
// The CLI's own runtime gave up waiting for its host process to take an event
// (CLI 1.0.105, a fixed wait reported as 120 s: "Session host did not
// acknowledge 'assistant.reasoning' delivery within ..."; its 60 s counterpart
// says the event poll loop "may be wedged"). No setting that lengthens the
// wait was found in CLI 1.0.105. 2026-10-31: a Windows run recorded the same
// stall as "session event delivery failed: session host did not complete the
// assistant.reasoning event within 120s" (also system.message, user.message,
// model.call_final_result), which the first pattern missed.
export const hostStallPattern = /Session host did not acknowledge '[^'\r\n]*' delivery within|session host did not (?:complete|acknowledge) the [\w.-]+ event within|session event delivery failed|event delivery was not acknowledged by the session host|event poll loop may be wedged/i;
// A stall (or a lock wait, below) that repeats this often on one call is not
// passing on its own: block that unit (and its dependants) instead of
// retrying it forever. Counted apart from other transient retries, within the
// usual retry limit.
export const hostStallRetries = 5;
export const isHostStall = error => hostStallPattern.test(text(error));
// The CLI could not take one of its own locks in time: CLI 1.0.105's phrases
// for its shared writer lock and for its MCP configuration being changed by
// another process. On 2026-11-01 (Windows, kit 0.40.0, one worker at a time)
// every pilot worker failed at session.send with "The shared writer lock timed
// out." and the kit blocked each unit at once, without a retry. Another
// Copilot process holding the lock (the Copilot app, or a CLI left from an
// earlier run) lets go of it; one held for good does not, so it is retried a
// few times only, like the event stall.
export const cliLockPattern = /The shared writer lock timed out|MCP installation storage is busy|Another process is changing MCP configuration/i;
export const isCliLock = error => cliLockPattern.test(text(error));

export function isTransientFailure(error) {
  const value = text(error);
  // User cancellation or the kit's own explicitly chosen deadline is final.
  // A timeout reported by the service or network is not: a retry finishes it.
  if (/explicit (?:bounded )?deadline|Interrupted/.test(value)) return false;
  if (/\b(?:request|connection|response|stream|upstream|operation|read|connect) timed out\b|\btimed out (?:waiting|while)\b/i.test(value)) return true;
  if (hostStallPattern.test(value) || cliLockPattern.test(value)) return true;
  // A bare 500 also appears in sizes and limits, so it counts only as a status.
  return /session\.error rate_limit|\b429\b|rate[ -]?limit|too many requests|overloaded|temporar(?:il)?y unavailable|service unavailable|\b50[234]\b|session\.error (?:\S+ )?500\b|\b500 Internal Server Error|internal server error|bad gateway|gateway timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|network (?:error|timeout)|fetch failed/i.test(value);
}

// A connection that timed out or dropped, as opposed to a refused sign-in.
// The CLI can print its generic sign-in help after a network failure (it could
// not reach GitHub to check the token), so that help alone next to one of these
// is not a sign-in problem. An explicit statement (not signed in, 401, Bad
// credentials, an authentication session.error) still is.
export const networkFailurePattern = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b|socket hang up|fetch failed|network (?:error|timeout)|\b(?:connection|connect) timed out\b/i;
const signInHelp = "To authenticate, you can use|run the '\\/login' command";
export const explicitAuthRejection = /session\.error (?:authentication|authorization|forbidden)\b|not (?:signed|logged) in to (?:GitHub|Copilot)|authentication (?:failed|required)|\b401 Unauthorized\b|Bad credentials/i;
// Systemic causes other than sign-in: they stop the run whatever network error
// comes with them.
export const otherSystemicPattern = /Too many open files|\bEMFILE\b|session\.error (?:quota\w*|billing\w*|credits?\w*)\b|\bAI Credits?\b|spending limit|quota (?:exceeded|exhausted)|budget (?:exceeded|exhausted|reached)|No such agent|did not report its agent list|spawn \S*copilot|Cannot read the Copilot CLI version|requires tools: |Remove profile model override|is shadowed or duplicated|model ["'`]?[\w.:-]+["'`]? (?:is )?(?:not available|not supported|unavailable|not found)|unknown model/i;
const signInHelpPattern = new RegExp(signInHelp, 'i');
// Sign-in help next to a network error and nothing more definite.
export const isSignInDoubt = error => {
  const value = text(error);
  return networkFailurePattern.test(value) && signInHelpPattern.test(value) && !explicitAuthRejection.test(value);
};

export function isSystemicFailure(error) {
  const value = text(error);
  return otherSystemicPattern.test(value) || explicitAuthRejection.test(value) || (signInHelpPattern.test(value) && !isSignInDoubt(error));
}

// Retried a few times only, counted apart from other transient retries: the
// CLI's event stall and lock wait, and a network error whose sign-in help
// could still mean the CLI is signed out (a run must not retry that forever in
// continuous mode).
export const isLimitedRetry = error => isHostStall(error) || isCliLock(error) || isSignInDoubt(error);
// The CLI says it is not signed in (its sign-in help, "not signed in", "Not
// authenticated. Please authenticate first.", "No authentication information"), with no network error that could explain it.
// A 401, Bad credentials or a forbidden model is not this: those can be one
// request's refusal. The adapter then repeats the call in the person's own CLI
// home (lib/worker-home.mjs).
const signedOutPattern = /not (?:signed|logged) in|not authenticated|authenticate first|No authentication information|authentication required/i;
export const isSignedOut = error => {
  const value = text(error);
  return (signInHelpPattern.test(value) || signedOutPattern.test(value)) && !networkFailurePattern.test(value);
};
// The CLI could not start its MCP servers or its own storage in the CLI home it
// was given: CLI 1.0.105's own phrases for the MCP host, its ownership records
// in mcp-installations.json and the protected storage tied to a home. On
// 2026-11-01 a worker home holding copies of the person's CLI state failed
// every worker this way before the prompt. The adapter then repeats the call
// in the person's home, as for a sign-in missing only in the worker home.
// Contention (cliLockPattern) is not this: it is retried in the same home and
// must not move workers.
const homeStatePattern = /Failed to initiali[sz]e MCP host|MCP host not initiali[sz]ed|MCP installation ownership storage failed|protected storage writer (?:lease is invalid|association does not match)|protected transaction root (?:is not initiali[sz]ed|changed)|transaction root (?:is bound to another lock namespace|belongs to another engine identity|must not be a symbolic link|identity no longer matches)|storage directory is (?:owned by another user|writable by group or other users)/i;
export const isHomeStateFailure = error => homeStatePattern.test(text(error));

export const retryDelayMs = (config, attempt) => Math.min((config.transientRetryDelayMs ?? 5000) * 2 ** Math.min(attempt, 30), 60000);
