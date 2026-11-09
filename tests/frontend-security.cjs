'use strict';

// Run with Node.js. The harness executes the real login functions in an
// isolated VM with synthetic credentials, a mocked DOM and no network API.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
new vm.Script(source, { filename: 'app.js' });

function extract(start, next) {
  const first = source.indexOf(start);
  const last = source.indexOf(next, first);
  assert(first >= 0 && last > first, 'Expected login function boundaries');
  return source.slice(first, last);
}

const submitSource = extract('async function submitLogin(event)', '\nfunction showAuthenticatedError');
const acceptSource = extract('async function acceptAuthenticated(', '\nasync function initialize()');
const passwordSource = extract('function setLoginPasswordVisibility(', '\nfunction initializeLoginPresentation(');
const languageSource = extract('const LANGUAGE_KEY', '\nfunction readLegacyGames()');

function element() {
  const attributes = {};
  return {
    value: '', type: 'password', textContent: '', disabled: false, hidden: true,
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    querySelector() { return null; }
  };
}
function assertPasswordCleared(elements, message) {
  assert.equal(elements.loginPassword.value, '', message);
  assert.equal(elements.loginPassword.type, 'password', message + ': must restore masking');
  if (elements.toggleLoginPassword) {
    assert.equal(elements.toggleLoginPassword.getAttribute('aria-pressed'), 'false');
    assert.equal(elements.toggleLoginPassword.getAttribute('aria-label'), 'Pokaż hasło');
  }
}

function createSubmitContext(overrides = {}) {
  let resolveRequest;
  let rejectRequest;
  const request = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const elements = Object.fromEntries([
    'loginButton', 'authMessage', 'captchaStatus', 'loginUsername',
    'loginPassword', 'toggleLoginPassword', 'websiteField', 'retryConnection'
  ].map(id => [id, element()]));
  elements.loginUsername.value = 'synthetic-user';
  elements.loginPassword.value = 'synthetic-password-only';

  const calls = [];
  const accepted = [];
  const errors = [];
  const challenges = [];
  const context = vm.createContext({
    $: id => elements[id],
    captchaChallenge: { provider: 'turnstile', siteKey: 'synthetic-site-key' },
    captchaSolution: 'synthetic-captcha-token',
    captchaSolvePromise: null,
    sessionGeneration: 0,
    logoutPending: false,
    freshLoginRequired: false,
    FRESH_LOGIN_REQUIRED_KEY: 'synthetic-login-required-key',
    storeFlag() {},
    ensureCurrentSession() {},
    ignoredSessionError: error => Boolean(error?.staleSession || error?.sessionExpired),
    apiRequest: (method, body) => {
      calls.push({ method, body });
      return request;
    },
    acceptAuthenticated: async games => { accepted.push(games); },
    showAuthenticatedError: message => errors.push(message),
    prepareCaptcha: challenge => challenges.push(challenge),
    ...overrides
  });
  vm.runInContext([languageSource, passwordSource, submitSource].join('\n'), context);
  context.setLoginPasswordVisibility(true);
  return { context, elements, calls, accepted, errors, challenges, resolveRequest, rejectRequest };
}

async function main() {
  {
    const test = createSubmitContext();
    const attempt = test.context.submitLogin({ preventDefault() {} });
    assert.equal(test.calls.length, 1);
    assert.equal(test.calls[0].method, 'POST');
    assert.equal(test.calls[0].body.username, 'synthetic-user');
    assert.equal(test.calls[0].body.password, 'synthetic-password-only');
    assert.equal(test.calls[0].body.captcha.token, 'synthetic-captcha-token');
    assertPasswordCleared(test.elements, 'Password must be empty while request is pending');

    // A value entered while waiting must not survive a completed attempt.
    test.elements.loginPassword.value = 'synthetic-retyped-value';
    test.context.setLoginPasswordVisibility(true);
    const games = [{ id: 'synthetic-game' }];
    test.resolveRequest({ games });
    await attempt;
    assertPasswordCleared(test.elements, 'Password must stay empty after success');
    assert.equal(test.accepted[0], games);
    console.log('PASS: pending/success clears password and sends original synthetic credentials');
  }

  for (const includeChallenge of [false, true]) {
    const test = createSubmitContext();
    const attempt = test.context.submitLogin({ preventDefault() {} });
    assertPasswordCleared(test.elements, 'Pending rejection');
    test.elements.loginPassword.value = 'synthetic-retyped-value';
    test.context.setLoginPasswordVisibility(true);
    const error = new Error('Synthetic rejected login');
    if (includeChallenge) error.payload = { captcha: { provider: 'turnstile', siteKey: 'synthetic-next-site-key' } };
    test.rejectRequest(error);
    await attempt;
    assertPasswordCleared(test.elements, 'Password must be empty after rejected request');
    assert.equal(test.accepted.length, 0);
    assert.equal(test.errors[0], 'Synthetic rejected login');
    assert.equal(test.challenges.length, includeChallenge ? 1 : 0);
    console.log('PASS: failed request clears password' + (includeChallenge ? ' with new challenge' : ' without new challenge'));
  }

  const verificationCases = [
    ['missing challenge', () => ({ captchaChallenge: null })],
    ['missing token', () => ({ captchaSolution: null })],
    ['rejected verification', () => ({
      captchaChallenge: { provider: 'pow', nonce: 'synthetic-nonce' },
      captchaSolution: null,
      captchaSolvePromise: Promise.reject(new Error('Synthetic verification failure'))
    })]
  ];
  for (const [name, overrides] of verificationCases) {
    const test = createSubmitContext(overrides());
    await test.context.submitLogin({ preventDefault() {} });
    assert.equal(test.calls.length, 0, name + ': must not send a login request');
    assertPasswordCleared(test.elements, name + ': must clear password');
    assert.equal(test.errors.length, 1);
    console.log('PASS: ' + name + ' clears password without sending credentials');
  }

  {
    const elements = {
      loginPassword: { ...element(), value: 'synthetic-password-only', type: 'text' },
      toggleLoginPassword: element(),
      appShell: { hidden: true },
      authScreen: { hidden: false }
    };
    const context = vm.createContext({
      $: id => elements[id],
      captchaGeneration: 0,
      captchaChallenge: {},
      captchaSolution: 'synthetic-captcha-token',
      captchaSolvePromise: null,
      sessionGeneration: 0,
      logoutPending: false,
      authenticated: false,
      document:{hidden:false},
      sessionPolicy:{},
      privacySuspended:false,
      windowBlurred:false,
      armSessionTimers(){},
      ensureCurrentSession() {},
      ignoredSessionError: error => Boolean(error?.staleSession || error?.sessionExpired),
      clearCaptchaWidget() {},
      readLegacyGames() { return []; },
      setConnectionStatus() {},
      render() {},
      games: [],
      apiRequest() { throw new Error('Unexpected request during authenticated initialization'); }
    });
    vm.runInContext([languageSource, passwordSource, acceptSource].join('\n'), context);
    await context.acceptAuthenticated([]);
    assertPasswordCleared(elements, 'Authenticated initialization must clear password');
    assert.equal(elements.appShell.hidden, false);
    assert.equal(elements.authScreen.hidden, true);
    console.log('PASS: authenticated initialization defensively clears password');
  }

  console.log('All frontend security checks passed. No network or real credentials used.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
