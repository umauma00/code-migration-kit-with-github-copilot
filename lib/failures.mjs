// SPDX-License-Identifier: Apache-2.0
// How the runner reacts to a failed worker call under parallel execution:
// - transient (rate limits, 5xx, network, the CLI's internal event stall or
//   lock wait, a model request the CLI gave up on, a silent call): retry the
//   same call with backoff;
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
// A worker CLI that wrote nothing for workerSilenceSeconds (lib/process.mjs):
// most likely a connection lost without an error (a VPN reconnecting or
// rechecking the computer, a network that sleeps while the screen is locked),
// which the CLI waits on forever. On 2026-11-02 (Windows, kit 0.42.0) one
// review call waited 11 hours this way and the whole phase 04 run with it.
// Each retry of the same call waits longer (lib/execution-policy.mjs); a call
// that stays silent is retried a few times only, like the event stall.
export const silentCallPattern = /Process showed no sign of progress for \d+s\b/;
export const isSilentCall = error => silentCallPattern.test(text(error));
// A call the runner stopped for silence just as the person stopped the run:
// the person's stop is what happened, so the call is not retried, its file is
// not blocked as silent and the guidance is not about the network.
export function stoppedWithRun(error, signal) {
  if (signal?.aborted && error instanceof Error && isSilentCall(error) && !/^Interrupted\b/.test(error.message)) error.message = `Interrupted; ${error.message}`;
  return error;
}
// The CLI retried a model request itself and gave up (CLI 1.0.105: "Failed to
// get response from the AI model; retried 5 times (total retry wait time:
// 23.00 seconds) Last error: ...", or "; stopped after ... because the
// slow-stream retry limit was reached"). It retries what can pass: a
// connection that broke in the middle of an answer ("error reading a body from
// connection: unexpected EOF during chunk size line"), a stream without its
// end, a body that was not JSON (a captive portal). So the runner retries it
// too: as long as it lasts when its last error is a network error, a rate
// limit or a 5xx, otherwise a few times only, like the event stall.
export const cliGaveUpPattern = /Failed to get response from the AI model; (?:retried \d+ times|stopped after\b)/i;
const cliGaveUpWrapper = /Failed to get response from the AI model; [^\r\n]*?(?:Last error:|$)/gim;
// Something between this computer and GitHub took the connection over: a
// certificate the computer does not trust (a proxy, VPN or security software
// that inspects HTTPS; a VPN rechecking the computer, such as Cisco ISE
// Posture, can send connections to its own page for a while), or an answer
// that did not come from GitHub. It passes once the VPN is through, or never
// until a setting changes, so it is retried a few times only, never as long
// as it lasts. Node's certificate codes are listed one by one: the flag that
// ignores case would let a pattern such as CERT_\w+ match cert_utils. Where the
// CLI checks its token, an answer without GitHub's error body (CLI 1.0.105:
// "Failed to fetch PAT user login (403): Failed to fetch Copilot user info:
// 403 Forbidden: <html>...", a proxy's page) counts too, and so does a page
// that came with a 200 ("response validation failed: Invalid Copilot user
// response: expected value at line 1 column 1", a portal); a rate limit (429)
// is not one. So does a proxy that asks for its own sign-in inside the
// tunnel ("407 Proxy Authentication Required", where the CLI checks its token
// or as "session.error query 407" on a model call, or "Error: 407" where it
// loads the models), or that could not get the sign-in it asked for (CLI
// 1.0.105's native proxy code: "proxy Negotiate authentication failed:
// failed to acquire proxy credentials: ..." for Kerberos or NTLM through
// Negotiate, "tunnel error: proxy authorization required" for Basic): its
// session can lapse while the screen is locked or the VPN is down, and
// `copilot login` cannot help. A network that asks for a sign-in on its own
// page counts too ("511 Network Authentication Required", a captive portal).
// Where the CLI loads the models, a page that did not come from GitHub reads
// "Error: Access denied by policy settings" without GitHub's request ID (CLI
// 1.0.105, any 403 body; GitHub's own policy refusal carries one: "Access
// denied by policy settings (Request ID: ...)", which blocks the file as up
// to 0.43.1), "Error: 407" or "Error: 511", or, for a page that came with a
// 200, "Error: expected value at line 1 column 1" (a portal). Only the CLI's
// own line counts: the CLI 1.0.105 runtime writes these words only where it
// loads the models, and the same words elsewhere (another message, a worker's
// answer) are not a page.
export const interceptionPattern = /\b407 Proxy Authentication Required\b|\b511 Network Authentication Required\b|\bError: Failed to load models(?: \(Request ID: [^)\r\n]{0,80}\))?\s+Error: (?:(?:407|511)\b|expected value at line \d+ column \d+)|\bproxy (?:\w+ )?authentication failed\b|\bproxy authori[sz]ation required\b|\bproxy required authentication\b|\bfailed to (?:acquire proxy (?:\w+ )?credentials|advance proxy authentication)\b|\bproxy Negotiate tunnel (?:failed|timed out)\b|\bError: Access denied by policy settings\b(?! \(Request ID:)|Invalid Copilot user response|user login\b[^\r\n(]{0,80}\(4(?!29)\d\d\):\s*Failed to fetch Copilot user info:|certificate verify failed|invalid peer certificate|\bUnknownIssuer\b|\bNotValidForName\b|self[- ]signed certificate|unable to (?:get local issuer certificate|verify the first certificate)|\b(?:CERT_(?:HAS_EXPIRED|NOT_YET_VALID|UNTRUSTED|REVOKED|REJECTED|SIGNATURE_FAILURE|CHAIN_TOO_LONG)|ERR_TLS_CERT_ALTNAME_INVALID|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT)\b|certificate has expired|CertificateExpired|SEC_E_UNTRUSTED_ROOT|does not appear to originate from GitHub/i;
// The CLI could not reach GitHub to check its token and says so (CLI 1.0.105:
// "Authentication token found but could not be validated. ... Your token may
// still be valid. Check your network connection and try again.", then its
// sign-in help). That is the network, not a sign-in in doubt: with a network
// error in it, it is retried as long as it lasts, otherwise a few times. When
// GitHub was reached and refused the token, the same message carries the
// answer's status and GitHub's own error message ("Failed to fetch PAT user
// login (403): GitHub returned: ..."; the CLI writes "GitHub returned" only
// for an error body in GitHub's form): any 4xx but a rate limit is then a
// sign-in or permission problem (Bad credentials, a token without access, SAML
// enforcement, Copilot not enabled) and stops the run, as it did up to 0.43.1
// (tokenRefusedPattern, in explicitAuthRejection). GitHub sends a rate limit
// as a 429 or as a 403 that says so ("API rate limit exceeded", "secondary
// rate limit"): retried. Not an organization's IP allow list either: that
// refusal means this computer is off the company network (the VPN dropped), a
// network error (networkFailurePattern). A 4xx answer in another form is not
// GitHub's (a proxy's page, interceptionPattern). Without a status, the CLI
// hides the cause: a refused or unknown proxy and an untrusted certificate
// all read "network fetch failed: request failed: error sending request for
// url (...)", which cannot be told from a network that is down, so it is
// retried as one.
export const tokenCheckFailedPattern = /Authentication token found but could not be validated|Your token may still be valid/i;
const tokenRefusedPattern = /\buser login\b[^\r\n(]{0,80}\(4(?!29)\d\d\):\s*GitHub returned:(?![^\r\n]*(?:IP (?:allow list enabled|address is not permitted)|rate[ -]?limit))/i;
const tokenCheckFailed = value => tokenCheckFailedPattern.test(value) && !tokenRefusedPattern.test(value);
// The CLI could not load the list of models as it started (CLI 1.0.105,
// checked through an inspecting proxy: "Error: Failed to load models (Request
// ID: ...)", then "Error: 503 \"<body>\"" or another status or the network
// error, then "Copilot could not retrieve the list of available models." and
// its sign-in help). Every worker call starts with it, so a 5xx or a rate
// limit there, a network error, and a tunnel the proxy refused or closed
// ("client error (Connect): tunnel error: unsuccessful", "unexpected end of
// file") all read like this; up to 0.43.1 the sign-in help made each of them
// stop the run. It is read like the token check: retried as long as it lasts
// with a network error, a rate limit or a 5xx in it, otherwise a few times.
// GitHub's refusals there come in other words: a 401 reads "Authentication
// failed" and stops the run (explicitAuthRejection), a 403 reads "Access
// denied by policy settings (Request ID: ...)" and blocks the file, both as up
// to 0.43.1, and a 402 stops the run as a matter of credits or the plan
// (modelsPaymentPattern). A proxy's or a portal's page there is
// interceptionPattern.
export const modelsLoadFailedPattern = /\bError: Failed to load models\b|\bCopilot could not retrieve the list of available models\b/i;
// Either check the CLI makes as it starts failed, and was not refused.
const startCheckFailed = value => tokenCheckFailed(value) || modelsLoadFailedPattern.test(value);

export function isTransientFailure(error) {
  const value = text(error), own = String(error?.message ?? error ?? '');
  // User cancellation or the kit's own explicitly chosen deadline is final.
  // A timeout reported by the service or network is not: a retry finishes it.
  const final = /explicit (?:bounded )?deadline|Interrupted/;
  if (final.test(own)) return false;
  // The runner's own stop of a silent call: what the CLI wrote as it was
  // stopped (it may say it was interrupted) is no cancellation.
  if (silentCallPattern.test(own)) return true;
  if (final.test(value)) return false;
  if (hostStallPattern.test(value) || cliLockPattern.test(value) || silentCallPattern.test(value)) return true;
  return passingFailure(value) || cliGaveUpPattern.test(value) || interceptionPattern.test(value) || startCheckFailed(value);
}
// A network error, a rate limit or a 5xx: retried as long as it lasts in
// continuous mode, unless the connection was taken over (isLimitedRetry).
const passingFailure = value => {
  if (/\b(?:request|connection|response|stream|upstream|operation|read|connect) timed out\b|\btimed out (?:waiting|while)\b/i.test(value)) return true;
  if (networkFailurePattern.test(value)) return true;
  // A 5xx where the CLI checks its token ("user login (500): ...") or loads
  // the models ("Error: 500 \"...\"" after "Failed to load models").
  if (/\buser login\b[^\r\n(]{0,80}\(5\d\d\):|\bError: Failed to load models(?: \(Request ID: [^)\r\n]{0,80}\))?\s+Error: 5\d\d\b/i.test(value)) return true;
  // A bare 500 also appears in sizes and limits, so it counts only as a status.
  return /session\.error rate_limit|\b429\b|rate[ -]?limit|too many requests|overloaded|temporar(?:il)?y unavailable|service unavailable|\b50[234]\b|session\.error (?:\S+ )?500\b|\b500 Internal Server Error|internal server error|bad gateway|gateway timeout/i.test(value);
};

// A connection that timed out or dropped, as opposed to a refused sign-in.
// The CLI can print its generic sign-in help after a network failure (it could
// not reach GitHub to check the token), so that help alone next to one of these
// is not a sign-in problem. An explicit statement (not signed in, 401, Bad
// credentials, an authentication session.error) still is.
// Since 0.44.0 also a name that did not resolve, a network that could not be
// reached, a connection the computer itself dropped and one that broke in the
// middle of an answer: what a VPN that is reconnecting or rechecking the
// computer (Cisco Secure Client ISE Posture) or a network adapter put to sleep
// leaves behind. They are retried like the others, never a reason to block a
// file at once. The Windows phrases and the Rust ones (dns error, connection
// closed before message completed, error reading a body from connection) are
// how the CLI's own network code reports them; the CLI 1.0.105 runtime carries
// most of these phrases in its own lists of network errors, and the rest in
// its native HTTP code: a connect-stage timeout, a connect step that ran out
// of time ("tcp connect error: deadline has elapsed": tokio's generic word,
// so only after "connect error"), a TLS connection closed without
// close_notify or during the handshake, an I/O error or a timeout on the
// proxy's tunnel. GitHub's refusal for an organization's IP allow list counts
// too: the computer is off the company network until the VPN is back. Its
// wrapper "error sending request" is not one of them: a certificate, a proxy
// that refuses the tunnel ("tunnel error: unsuccessful", which comes inside
// the CLI's give-up wrapper on a model call) or a wrong address comes in it
// too.
export const networkFailurePattern = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT))\b|socket hang up|fetch failed|network (?:error|timeout|(?:is )?unreachable)|host is (?:unreachable|down)|no route to host|connection refused|\b(?:connection|connect) timed out\b|getaddrinfo|\bdns error\b|failed to lookup address|No such host is known|forcibly closed by the remote host|connected party did not properly respond|target machine actively refused|established connection was aborted|connection reset by peer|connection closed before message completed|error (?:reading|writing) a body (?:from|to) connection|end of file before message length reached|connect-stage timed out|connect error: deadline has elapsed|without (?:sending )?(?:TLS )?close_notify|tls handshake eof|proxy CONNECT (?:I\/O error|did not complete within)|tunnel I\/O error|IP allow list enabled|IP address is not permitted|(?:Headers|Body) Timeout Error|\bos error 1(?:005[0-4]|006[0145]|100[12])\b/i;
const signInHelp = "To authenticate, you can use|run the '\\/login' command";
// "Authentication failed" or "authentication required" from GitHub or the
// CLI, not a proxy's or a network's own sign-in ("407 Proxy Authentication
// Required", "proxy Negotiate authentication failed", "511 Network
// Authentication Required": interceptionPattern).
const notProxyOwn = String.raw`(?<!\b(?:proxy|network) (?:\w+ )?)`;
export const authFailedWords = `${notProxyOwn}authentication (?:failed|required)`;
export const explicitAuthRejection = new RegExp(`session\\.error (?:authentication|authorization|forbidden)\\b|not (?:signed|logged) in to (?:GitHub|Copilot)|${authFailedWords}|\\b401 Unauthorized\\b|Bad credentials|${tokenRefusedPattern.source}`, 'i');
// GitHub answered the CLI's list of models with a 402 Payment Required (CLI
// 1.0.105, checked through an inspecting proxy: "Error: Failed to load models
// (Request ID: ...)", or without the ID, then "Error: 402 Payment Required"
// and its sign-in help), or with the 403 the CLI names "Error: Copilot Pro
// trial paused" (with or without the ID, then GitHub's "Copilot Pro trials
// have been temporarily paused. Please upgrade your account or revert to
// Copilot Free."): Copilot cannot be used on this account until its AI
// Credits, its budget or its plan allow it again. No file passes until then,
// so it stops the run: for the 402 as the sign-in help made it do up to
// 0.43.1 (retried, every file would wait out its retries in turn, for hours
// in a long run); the paused trial left each file unfinished up to 0.43.1.
export const modelsPaymentPattern = /\bError: Failed to load models(?: \(Request ID: [^)\r\n]{0,80}\))?\s+Error: 402\b|\bError: Copilot Pro trial paused\b/i;
// Systemic causes other than sign-in: they stop the run whatever network error
// comes with them.
export const otherSystemicPattern = new RegExp(`${/Too many open files|\bEMFILE\b|session\.error (?:quota\w*|billing\w*|credits?\w*)\b|\bAI Credits?\b|spending limit|quota (?:exceeded|exhausted)|budget (?:exceeded|exhausted|reached)|No such agent|did not report its agent list|spawn \S*copilot|Cannot read the Copilot CLI version|requires tools: |Remove profile model override|is shadowed or duplicated|model ["'`]?[\w.:-]+["'`]? (?:is )?(?:not available|not supported|unavailable|not found)|unknown model/.source}|${modelsPaymentPattern.source}`, 'i');
const signInHelpPattern = new RegExp(signInHelp, 'i');
// Sign-in help next to a network error, or next to the CLI's word that it could
// not check the token or load the models, and nothing more definite: not a
// reason to stop.
const networkSignInHelp = value => (networkFailurePattern.test(value) || startCheckFailed(value)) && signInHelpPattern.test(value) && !explicitAuthRejection.test(value);
// A sign-in that may be missing: the help next to a network error, without
// the CLI's word that the token could not be checked or the models loaded.
export const isSignInDoubt = error => {
  const value = text(error);
  return networkFailurePattern.test(value) && signInHelpPattern.test(value) && !explicitAuthRejection.test(value) && !startCheckFailed(value);
};

export function isSystemicFailure(error) {
  const value = text(error);
  return otherSystemicPattern.test(value) || explicitAuthRejection.test(value) || (signInHelpPattern.test(value) && !networkSignInHelp(value));
}

// Retried a few times only, counted apart from other transient retries: the
// CLI's event stall and lock wait, a call that stayed silent, a network error
// whose sign-in help could still mean the CLI is signed out (a run must not
// retry that forever in continuous mode), a connection taken over, and a model
// request the CLI gave up on, or a token check or models load it could not
// make, for a reason that is not a network error, a rate limit or a 5xx.
export const isLimitedRetry = error => {
  const value = text(error);
  if (isHostStall(error) || isCliLock(error) || isSilentCall(error) || isSignInDoubt(error) || interceptionPattern.test(value)) return true;
  return (cliGaveUpPattern.test(value) || startCheckFailed(value)) && !passingFailure(value.replace(cliGaveUpWrapper, ''));
};
// The CLI says it is not signed in (its sign-in help, "not signed in", "Not
// authenticated. Please authenticate first.", "No authentication information"), with no network error that could explain it
// and without its word that a token was found but could not be checked
// (unless GitHub answered the check with a refusal: another home may hold a
// token GitHub accepts) or that it could not load the models.
// A 401, Bad credentials or a forbidden model is not this: those can be one
// request's refusal. The adapter then repeats the call in the person's own CLI
// home (lib/worker-home.mjs).
const signedOutPattern = new RegExp(`not (?:signed|logged) in|not authenticated|authenticate first|No authentication information|${notProxyOwn}authentication required`, 'i');
export const isSignedOut = error => {
  const value = text(error);
  return (signInHelpPattern.test(value) || signedOutPattern.test(value)) && !networkFailurePattern.test(value) && !startCheckFailed(value);
};
// The CLI could not start its MCP servers or its own storage in the CLI home it
// was given: CLI 1.0.105's own phrases for the MCP host, its ownership records
// in mcp-installations.json and the protected storage tied to a home. On
// 2026-11-01 a worker home holding copies of the person's CLI state failed
// every worker this way before the prompt. The adapter then repeats the call
// in the person's home, as for a sign-in missing only in the worker home.
// Contention (cliLockPattern) is not this, even when the CLI reports it inside
// its MCP host start ("Failed to initialize MCP host: Another process is
// changing MCP configuration."): it is retried in the same home and must not
// move workers.
const homeStatePattern = /Failed to initiali[sz]e MCP host|MCP host not initiali[sz]ed|MCP installation ownership storage failed|protected storage writer (?:lease is invalid|association does not match)|protected transaction root (?:is not initiali[sz]ed|changed)|transaction root (?:is bound to another lock namespace|belongs to another engine identity|must not be a symbolic link|identity no longer matches)|storage directory is (?:owned by another user|writable by group or other users)/i;
const wrappedLock = new RegExp(`(?:Failed to initiali[sz]e MCP host|MCP host not initiali[sz]ed)\\W*(?:Error\\W*)?(?=${cliLockPattern.source})`, 'gi');
export const isHomeStateFailure = error => homeStatePattern.test(text(error).replace(wrappedLock, ''));

// What a retry waited out, for status (lib/status.mjs), in the order it names
// them: read from the whole error (its message and the CLI's stderr) when the
// retry is recorded. The record keeps the first 500 characters of the message
// only, and the CLI's cause can come after a long wrapper (its give-up
// message) or after its stream's error. A connection taken over comes first,
// as in isLimitedRetry: a proxy's page can mention a rate limit, and such a
// call gets the few retries of a connection taken over.
export const retryCauseKeys = ['rateLimit', 'intercepted', 'networkError', 'modelsLoad'];
export const retryCause = error => {
  const value = text(error);
  return interceptionPattern.test(value) ? { intercepted: true } : /rate_limit|\b429\b|rate.?limit/i.test(value) ? { rateLimit: true }
    : networkFailurePattern.test(value) ? { networkError: true } : modelsLoadFailedPattern.test(value) ? { modelsLoad: true } : {};
};
export const retryDelayMs = (config, attempt) => Math.min((config.transientRetryDelayMs ?? 5000) * 2 ** Math.min(attempt, 30), 60000);
