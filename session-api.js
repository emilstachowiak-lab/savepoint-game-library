// Own the API request lifecycle, transport deadlines and current session.
// Imported collections and the page's controls use this shared transport.
const API_URL = 'api/games.php';
const MAX_REQUEST_BYTES = 65536;
const COLLECTION_WRITES = new Set([
  'save', 'delete', 'replace', 'migrate', 'collection-upload-finish', 'ai-add', 'ai-duplicates-apply'
]);
const PENDING_LOGOUT_KEY = 'savepoint-logout-pending-v1';
const FRESH_LOGIN_REQUIRED_KEY = 'savepoint-login-required-v1';
// Each generation identifies the sign-in that owns pending UI work.
let sessionGeneration = 0;
let authenticated = false;
let logoutRequest = null;
const activeApiRequests = new Set();
let collectionWriteTail = null;
let sessionPolicy = null;
let sessionWarningTimer = null;
let sessionExpiryTimer = null;
let privacySuspended = false;
let privacyVisibility = null;
let sessionValidationRequest = null;
let sessionValidationToken = 0;

// These durations must match enforceSessionTimeout and sessionMetadata in PHP.
const SESSION_IDLE_SECONDS = 1800;
const SESSION_ABSOLUTE_SECONDS = 28800;

// Measure elapsed time with both clocks when available. Moving the wall clock
// backwards cannot extend a live session while the monotonic clock advances.
function sessionClock() {
  return {
    wall: Date.now(),
    mono: typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : null
  };
}
function sessionElapsed(anchor) {
  const wall = Math.max(0, Date.now() - anchor.wall);
  const hasMonotonicClock = anchor.mono !== null && typeof performance !== 'undefined'
    && typeof performance.now === 'function';
  const mono = hasMonotonicClock ? Math.max(0, performance.now() - anchor.mono) : 0;
  return Math.max(wall, mono);
}
function sessionRemaining(policy = sessionPolicy) {
  return policy ? Math.min(policy.idleMs, policy.absoluteMs) - sessionElapsed(policy.anchor) : 0;
}
function setSessionWarning(visible) {
  const warning = $('sessionWarning');
  if (!warning) return;
  warning.hidden = !visible || privacySuspended || !authenticated || logoutPending;
  setUiText($('sessionWarningText'), 'Sesja wkrótce wygaśnie. Zapisz otwarty formularz.',
    'Your session will expire soon. Save any open form.');
}
function clearSessionPolicy() {
  clearTimeout(sessionWarningTimer);
  clearTimeout(sessionExpiryTimer);
  sessionWarningTimer = sessionExpiryTimer = null;
  sessionPolicy = null;
  sessionValidationToken++;
  sessionValidationRequest = null;
  privacySuspended = false;
  for (const [node, hidden] of privacyVisibility || []) {
    if (node !== $('appShell')) node.hidden = hidden;
  }
  privacyVisibility = null;
  document.documentElement?.classList.remove('privacy-suspended');
  setSessionWarning(false);
}
// The warning and expiry timers share the earlier of the idle and absolute
// deadlines. Recheck on firing because browser timers can be delayed.
function armSessionTimers() {
  clearTimeout(sessionWarningTimer);
  clearTimeout(sessionExpiryTimer);
  sessionWarningTimer = sessionExpiryTimer = null;
  setSessionWarning(false);
  if (!authenticated || logoutPending || !sessionPolicy) return;
  const remaining = sessionRemaining();
  if (remaining <= 0) { void revalidatePrivateSession(true); return; }
  if (remaining <= 60000) setSessionWarning(true);
  else sessionWarningTimer = setTimeout(() => {
    if (authenticated && !logoutPending) {
      if (sessionRemaining() <= 0) void revalidatePrivateSession(true);
      else if (sessionRemaining() <= 60000) setSessionWarning(true);
      else armSessionTimers();
    }
  }, remaining - 60000);
  sessionExpiryTimer = setTimeout(() => {
    if (authenticated && !logoutPending) {
      if (sessionRemaining() <= 0) void revalidatePrivateSession(true);
      else armSessionTimers();
    }
  }, remaining);
}
// Convert server timestamps to local countdowns anchored when the request
// started, so transport delay cannot add time to the reported lifetime.
function applySessionMetadata(metadata, anchor) {
  const fields = ['authenticatedAt', 'lastActivityAt', 'idleExpiresAt', 'absoluteExpiresAt', 'serverNow'];
  if (!metadata || !fields.every(key => Number.isSafeInteger(metadata[key]) && metadata[key] > 0)
      || metadata.authenticatedAt > metadata.lastActivityAt || metadata.lastActivityAt > metadata.serverNow
      || metadata.idleExpiresAt !== metadata.lastActivityAt + SESSION_IDLE_SECONDS
      || metadata.absoluteExpiresAt !== metadata.authenticatedAt + SESSION_ABSOLUTE_SECONDS) return false;
  const next = { anchor, authenticatedAt: metadata.authenticatedAt, lastActivityAt: metadata.lastActivityAt,
    idleMs: (metadata.idleExpiresAt - metadata.serverNow) * 1000,
    absoluteMs: (metadata.absoluteExpiresAt - metadata.serverNow) * 1000 };
  if (sessionPolicy && next.authenticatedAt < sessionPolicy.authenticatedAt) return sessionRemaining() > 0;
  if (sessionPolicy?.authenticatedAt === next.authenticatedAt) {
    if (next.lastActivityAt < sessionPolicy.lastActivityAt) return sessionRemaining() > 0;
    const elapsed = sessionElapsed(anchor);
    const oldElapsed = sessionElapsed(sessionPolicy.anchor);
    // Out-of-order or passive replies cannot move an unchanged deadline later.
    next.absoluteMs = Math.min(next.absoluteMs, sessionPolicy.absoluteMs - oldElapsed + elapsed);
    if (next.lastActivityAt === sessionPolicy.lastActivityAt) next.idleMs = Math.min(next.idleMs, sessionPolicy.idleMs - oldElapsed + elapsed);
  }
  if (sessionRemaining(next) <= 0) return false;
  sessionPolicy = next;
  armSessionTimers();
  return true;
}
// A deadline crossing hides private UI immediately. Keep the current draft
// and prior visibility so a successful passive check can restore them.
function suspendPrivateView() {
  if (!authenticated || logoutPending) return;
  aiImportController?.clearPrivateData();
  duplicatesController?.clearPrivateData();
  clearAiCoverSearch();
  if (!privacySuspended) {
    privacySuspended = true;
    privacyVisibility = new Map();
    for (const id of ['appShell', 'modalBackdrop', 'deleteModalBackdrop', 'toast']) {
      const node = $(id);
      if (node) { privacyVisibility.set(node, node.hidden); node.hidden = true; }
    }
  }
  document.documentElement?.classList.add('privacy-suspended');
  clearTimeout(coverBackupTimer);
  coverBackupTimer = null;
  setSessionWarning(false);
}
function showSessionChecking(error = null) {
  $('authScreen').hidden = false;
  setUiText($('authTitle'), error ? 'Widok zablokowany' : 'Sprawdzam sesję…',
    error ? 'View locked' : 'Checking your session…');
  setUiText($('authIntro'),
    error ? 'Dane pozostają ukryte do potwierdzenia ważności sesji.' : 'Potwierdzam ważność sesji kolekcji.',
    error ? 'Your collection stays hidden until your session is verified.' : 'Verifying your collection session.');
  $('loginForm').hidden = true;
  setUiText($('authMessage'), ...uiErrorText(error));
  setUiText($('captchaStatus'), '');
  $('retryConnection').hidden = !error;
}
// Share one passive check between callers. Its generation and token prevent a
// superseded request from reopening the view after a login or logout.
async function revalidatePrivateSession(expiredCandidate = false) {
  if (!authenticated || logoutPending) return false;
  suspendPrivateView();
  if (sessionValidationRequest) return sessionValidationRequest;
  const generation = sessionGeneration;
  const token = ++sessionValidationToken;
  showSessionChecking();
  let timeout;
  const check = (async () => {
    try {
      await Promise.race([
        apiRequest('GET', undefined, generation, { sessionCheck: true }),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => {
            reject(uiError('Nie udało się potwierdzić sesji. Sprawdź połączenie i ponów próbę.',
              'Could not verify your session. Check your connection and try again.'));
          }, 10000);
        })
      ]);
      ensureCurrentSession(generation);
      if (token !== sessionValidationToken || !authenticated || logoutPending) return false;
      if (!sessionPolicy || sessionRemaining() <= 0) {
        void performLogout();
        return false;
      }
      const visibility = privacyVisibility;
      privacySuspended = false;
      privacyVisibility = null;
      for (const [node, hidden] of visibility || []) node.hidden = hidden;
      document.documentElement?.classList.remove('privacy-suspended');
      $('appShell').hidden = false;
      $('authScreen').hidden = true;
      if (renderedCollectionMetadata && renderedCollectionMetadata.language !== uiLanguage) render();
      armSessionTimers();
      scheduleCoverBackupWorker();
      return true;
    } catch (error) {
      if (ignoredSessionError(error) || generation !== sessionGeneration || token !== sessionValidationToken) return false;
      if (error.status === 429) {
        showSessionChecking(error);
        return false;
      }
      if (expiredCandidate || !sessionPolicy || sessionRemaining() <= 0) {
        void performLogout();
        return false;
      }
      showSessionChecking(error);
      return false;
    } finally {
      clearTimeout(timeout);
      if (token === sessionValidationToken) sessionValidationRequest = null;
    }
  })();
  sessionValidationRequest = check;
  return check;
}
// Async actions can wait for revalidation. Actions requiring a browser user
// gesture use the synchronous gate below and wait for a fresh click instead.
async function ensurePrivateSessionReady(generation = sessionGeneration) {
  ensureCurrentSession(generation);
  if (!authenticated || logoutPending) throw staleSessionError();
  if (privacySuspended || (sessionPolicy && sessionRemaining() <= 0)) {
    if (!await revalidatePrivateSession(Boolean(sessionPolicy && sessionRemaining() <= 0))) throw staleSessionError();
    ensureCurrentSession(generation);
  }
}
function privateViewUsable() {
  if (!authenticated || logoutPending) return false;
  if (privacySuspended || (sessionPolicy && sessionRemaining() <= 0)) {
    void revalidatePrivateSession(Boolean(sessionPolicy && sessionRemaining() <= 0));
    return false;
  }
  return true;
}
function initializeSessionPrivacy() {
  // Returning to a valid session is local and immediate. Re-arm deadlines in
  // case the browser suspended timers; only an elapsed deadline needs the API.
  const resumeSessionTimers = () => {
    if (!document.hidden && authenticated && !logoutPending) armSessionTimers();
  };
  document.addEventListener?.('visibilitychange', () => {
    if (!document.hidden) resumeSessionTimers();
  });
  addEventListener('focus', resumeSessionTimers);
  addEventListener('pageshow', resumeSessionTimers);
}
// Preserve logout state across reloads. Local storage also carries the marker
// to other tabs, and session storage is a fallback for the current tab.
function readStoredFlag(key) {
  return ['localStorage', 'sessionStorage'].some(name => {
    try { return globalThis[name]?.getItem(key) === '1'; } catch { return false; }
  });
}
function storeFlag(key, enabled) {
  ['localStorage', 'sessionStorage'].forEach(name => {
    try {
      if (enabled) globalThis[name]?.setItem(key, '1');
      else globalThis[name]?.removeItem(key);
    } catch {}
  });
}
function readPendingLogout() { return readStoredFlag(PENDING_LOGOUT_KEY); }
function storePendingLogout(pending) { storeFlag(PENDING_LOGOUT_KEY, pending); }
let logoutPending = readPendingLogout();
let freshLoginRequired = readStoredFlag(FRESH_LOGIN_REQUIRED_KEY);
function staleSessionError() {
  const error = new Error('Odpowiedź dotyczy zakończonej sesji.');
  error.staleSession = true;
  return error;
}
function ensureCurrentSession(generation, allowLogout = false) {
  if (generation !== sessionGeneration || (logoutPending && !allowLogout)) throw staleSessionError();
}
function ignoredSessionError(error) { return Boolean(error?.staleSession || error?.sessionExpired); }
// A full games array replaces the snapshot. Delta replies upsert saved records
// or remove deletedId. AI batch additions can include records from a replay.
function applyCollectionReply(result, action) {
  if (Array.isArray(result.games)) games = result.games;
  else if (action === 'ai-add' && Array.isArray(result.addedGames)) {
    const byId = new Map(games.map(game => [game.id, game]));
    for (const game of result.addedGames) byId.set(game.id, game);
    games = [...byId.values()];
  } else if ((action === 'save' || action === 'delete' || action === 'ai-duplicates-apply')
      && (result.game || typeof result.deletedId === 'string')) {
    let next = games.filter(game => game.id !== result.deletedId);
    if (result.game) {
      const exists = next.some(game => game.id === result.game.id);
      next = exists ? next.map(game => game.id === result.game.id ? result.game : game) : [...next, result.game];
    }
    games = next;
  } else {
    throw uiError('Serwer zwrócił niekompletną odpowiedź. Odśwież kolekcję.',
      'The server returned an incomplete response. Reload the collection.');
  }
  if (authenticated && !privacySuspended && !$('appShell').hidden) render();
}

function apiTimeout(action, isSessionCheck) {
  if (isSessionCheck) return 10000;
  if (action === 'logout' || action === 'collection-upload-chunk' || action === 'ai-upload-chunk') return 15000;
  if (action === 'collection-upload-finish' || action === 'ai-recognize') return 55000;
  if (action === 'ai-cover-search' || action === 'ai-duplicates-scan') return 35000;
  return 25000;
}

// A hosting error page means the initial read can be retried once. Both reads
// and the short delay share the original startup deadline.
async function requestInitialSession(generation) {
  const started = sessionClock();
  const timeout = apiTimeout();
  try {
    return await apiRequest('GET', undefined, generation);
  } catch (error) {
    if (!error.hostUnavailable) throw error;
    const delay = 500 + Math.floor(Math.random() * 500);
    const minimumRetryTime = 3000;
    if (timeout - sessionElapsed(started) < delay + minimumRetryTime) throw error;
    await new Promise(resolve => setTimeout(resolve, delay));
    const remaining = Math.floor(timeout - sessionElapsed(started));
    if (remaining < minimumRetryTime) throw error;
    return apiRequest('GET', undefined, generation, { timeoutMs: remaining });
  }
}

// Send same-origin JSON and accept private results only for the current
// session. Track requests that must finish before sign-out.
async function apiRequest(method = 'GET', body = undefined, generation = sessionGeneration, options = {}) {
  const action = body?.action;
  const isLogout = action === 'logout';
  const isSessionCheck = options.sessionCheck === true;
  const changesCollection = COLLECTION_WRITES.has(action);
  // All requests still send the same-origin session cookie. These AI routes
  // never set a cookie in their replies and never change the saved collection.
  // Some write temporary upload files. Confirmed collection writes remain
  // tracked through sign-out so their outcome can be reconciled.
  const abortableAiRequest = options.abortableAiRequest === true && [
    'ai-status', 'ai-upload-start', 'ai-upload-chunk', 'ai-recognize', 'ai-upload-cancel', 'ai-cover-search',
    'ai-duplicates-scan'
  ].includes(action);
  ensureCurrentSession(generation, isLogout);
  if (authenticated && !isLogout && !isSessionCheck
      && (privacySuspended || (sessionPolicy && sessionRemaining() <= 0))) {
    await ensurePrivateSessionReady(generation);
  }
  // Check encoded bytes to match the server's request limit for Unicode text.
  const requestBody = body ? JSON.stringify(body) : undefined;
  if (requestBody && new TextEncoder().encode(requestBody).byteLength > MAX_REQUEST_BYTES) {
    throw uiError('Dane żądania przekraczają limit 64 KiB.', 'The request exceeds the 64 KiB limit.');
  }

  async function dispatch() {
    ensureCurrentSession(generation, isLogout);
    const anchor = sessionClock();
    const callerSignal = abortableAiRequest ? options.signal : null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const abort = () => controller?.abort();
    if (callerSignal?.aborted) abort();
    else callerSignal?.addEventListener?.('abort', abort, { once: true });
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = uiError('Serwer nie odpowiedział na czas. Spróbuj ponownie.',
          'The server did not respond in time. Try again.');
        error.timeout = true;
        reject(error);
        abort();
      }, options.timeoutMs ?? apiTimeout(action, isSessionCheck));
    });
    const transport = (async () => {
      const signal = controller?.signal || callerSignal;
      const response = await fetch(isSessionCheck ? API_URL + '?session=1' : API_URL, {
        method,
        headers: body
          ? { 'Content-Type': 'application/json', 'Accept-Language': uiLanguage }
          : { 'Accept-Language': uiLanguage },
        body: requestBody,
        credentials: 'same-origin',
        ...(signal ? { signal } : {})
      });
      let result = null;
      try {
        const json = await response.json();
        if (json && typeof json === 'object' && !Array.isArray(json)) result = json;
      } catch {}
      return { response, result };
    })();
    if (!isLogout && !abortableAiRequest) {
      activeApiRequests.add(transport);
      // Wait for requests that can set a session cookie or change saved records.
      // A transport may settle later than the application deadline.
      const settled = () => activeApiRequests.delete(transport);
      transport.then(settled, settled);
    }
    try {
      const { response, result } = await Promise.race([transport, deadline]);
      ensureCurrentSession(generation, isLogout);
      if (!response.ok || result?.ok !== true) {
        const fallback = response.status === 413
          ? uiError('Żądanie jest zbyt duże.', 'The request is too large.')
          : response.status === 415
            ? uiError('Serwer odrzucił typ danych żądania.', 'The server rejected the request content type.')
            : response.status === 429
            ? uiError('Zbyt wiele żądań. Spróbuj ponownie później.', 'Too many requests. Try again later.')
            : uiError('Serwer nie zwrócił poprawnej odpowiedzi.', 'The server did not return a valid response.');
        const error = typeof result?.error === 'string' && result.error ? new Error(result.error) : fallback;
        error.status = response.status;
        error.payload = result ?? {};
        error.hostUnavailable = response.status === 503 && result === null;
        if (response.status === 401 && authenticated && !isLogout && action !== 'login') {
          if (isSessionCheck) void performLogout();
          else handleSessionExpired(result);
          error.sessionExpired = true;
        }
        throw error;
      }
      if (!isLogout && (authenticated || Array.isArray(result.games) || isSessionCheck) && !applySessionMetadata(result.session, anchor)) {
        void performLogout();
        throw staleSessionError();
      }
      if (changesCollection || options.reloadCollection === true) applyCollectionReply(result, action);
      return result;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.('abort', abort);
    }
  }

  // Serialize writes and reloads from this tab so successful replies apply in
  // submission order. Queued work rechecks the login before transmission.
  if (!changesCollection && options.reloadCollection !== true) return dispatch();
  const operation = collectionWriteTail ? collectionWriteTail.then(dispatch) : dispatch();
  const settled = operation.catch(() => {});
  collectionWriteTail = settled;
  try { return await operation; }
  finally { if (collectionWriteTail === settled) collectionWriteTail = null; }
}
