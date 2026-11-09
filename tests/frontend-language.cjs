'use strict';

// Exercise the real language controls, renderer and API client offline.
const assert = require('node:assert/strict');
const { harness, flush } = require('./frontend-dom.cjs');

const PREFERENCE = 'savepoint-language-v1';
const USER_PLATFORM = 'Świat <Retro> & Konsola';
const PLATFORM_WITH_EDITION_NAME = 'Cyfrowe';
const PLATFORMS = ['PC', 'Inna', USER_PLATFORM, PLATFORM_WITH_EDITION_NAME];
const ENGLISH_PLATFORM_LABELS = ['PC', 'Other', USER_PLATFORM, PLATFORM_WITH_EDITION_NAME];
const GAME = {
  id: 'synthetic-language-game',
  title: 'Żółw <Cień> & Księżyc',
  platform: PLATFORMS.join(', '),
  status: 'Ograna',
  edition: 'Fizyczne i cyfrowe',
  coverUrl: '',
  createdAt: 1
};

function languageControls(test) {
  const controls = test.queryAll('select[data-ui-language]');
  assert.equal(controls.length, 2);
  const login = controls.find(control => test.nodes.authScreen.contains(control));
  const collection = controls.find(control => test.nodes.appShell.contains(control));
  assert(login && collection, 'Both the login screen and collection must offer language selection');
  return { login, collection };
}

function assertLanguage(test, language) {
  const page = test.document.documentElement;
  assert.equal(page.lang || page.getAttribute('lang'), language);
  const { login, collection } = languageControls(test);
  assert.equal(login.value, language);
  assert.equal(collection.value, language);
}

function changeLanguage(test, control, language) {
  control.value = language;
  test.fire(control, 'change');
  assertLanguage(test, language);
  assert.equal(test.context.localStorage.getItem(PREFERENCE), language);
}

function acceptLanguage(request) {
  const headers = request.options.headers;
  if (typeof headers.get === 'function') return headers.get('Accept-Language');
  return Object.entries(headers).find(([name]) => name.toLowerCase() === 'accept-language')?.[1];
}

function optionLabel(select, value) {
  const option = select.querySelectorAll('option').find(item => item.value === value);
  assert(option, 'Missing canonical option value ' + value);
  return option.textContent.trim();
}

function assertCard(test, language) {
  const card = test.nodes.grid.querySelector('.game-card');
  assert(card, 'The active filters must still show the same game');
  assert.equal(card.querySelector('.game-title').textContent, GAME.title);
  assert.equal(card.querySelector('.game-title').querySelector('*'), null, 'Game title stays plain text');
  assert.deepEqual(
    card.querySelectorAll('.platform-chip').map(chip => chip.textContent),
    language === 'en' ? ENGLISH_PLATFORM_LABELS : PLATFORMS,
    'Imported platform names remain literal even when they match a built-in edition'
  );
  assert.equal(optionLabel(test.nodes.platformFilter, 'Inna'), language === 'en' ? 'Other' : 'Inna');
  assert.equal(optionLabel(test.nodes.platformFilter, PLATFORM_WITH_EDITION_NAME), PLATFORM_WITH_EDITION_NAME);
  const status = card.querySelector('.status').textContent.trim();
  const edition = card.querySelector('.edition-meta').textContent.trim();
  assert.equal(status, optionLabel(test.nodes.status, GAME.status));
  assert.equal(edition, optionLabel(test.nodes.edition, GAME.edition));
  if (language === 'pl') {
    assert.equal(status, GAME.status);
    assert.equal(edition, GAME.edition);
  } else {
    assert.match(status, /^(completed|finished|played)$/i);
    assert.match(edition, /\bphysical\b.*\bdigital\b/i);
  }
}

async function assertLoginRetryRecovers() {
  const test = harness();
  const widgets = [];
  test.context.window.turnstile = {
    render(selector, options) {
      widgets.push(options);
      return widgets.length;
    },
    remove() {}
  };
  const challenge = {
    ok: false,
    authRequired: true,
    captcha: { provider: 'turnstile', siteKey: 'synthetic-site-key' }
  };
  const initial = test.context.initialize();
  test.respond(0, 401, challenge);
  await initial;
  await flush();
  assert.equal(widgets.length, 1);
  const oldWidget = widgets[0];
  oldWidget['error-callback']();
  assert.equal(test.nodes.retryConnection.hidden, false);

  test.fire(test.nodes.retryConnection, 'click');
  assert.equal(test.requests.length, 2);
  test.respond(1, 503, {
    ok: false,
    error: 'Syntetyczny błąd połączenia.',
    errorEnglish: 'Synthetic connection error.'
  });
  await flush();

  function assertRetryVisible() {
    assert.equal(test.nodes.loginForm.hidden, true);
    assert.equal(test.nodes.retryConnection.hidden, false, 'The connection error must leave a visible retry action');
  }

  assertRetryVisible();
  // Already queued callbacks can arrive after the widget has been removed.
  oldWidget.callback('synthetic-late-token');
  assertRetryVisible();
  oldWidget['error-callback']();
  assertRetryVisible();
  changeLanguage(test, languageControls(test).login, 'en');
  await flush();
  assertRetryVisible();
  assert.equal(widgets.length, 1, 'Changing language on a connection error must not rebuild the hidden widget');
  assert.match(test.nodes.authMessage.textContent, /Synthetic connection error/);

  test.fire(test.nodes.retryConnection, 'click');
  assert.equal(test.requests.length, 3);
  assert.equal(acceptLanguage(test.requests[2]), 'en');
  test.respond(2, 401, challenge);
  await flush();
  assert.equal(widgets.length, 2);
  assert.equal(widgets[1].language, 'en');
  assert.equal(test.nodes.loginForm.hidden, false);
  widgets[1].callback('synthetic-current-token');
  assert.equal(test.nodes.loginButton.disabled, false, 'A fresh challenge must allow sign-in after recovery');
  console.log('PASS: failed CAPTCHA retry remains usable across obsolete callbacks and a language change');
}

async function main() {
  const login = harness();
  assertLanguage(login, 'pl');
  const loginControl = languageControls(login).login;
  changeLanguage(login, loginControl, 'en');
  assert.equal(login.requests.length, 0, 'Language changes do not send API requests');

  const reloaded = harness({ localStorageEntries: [[PREFERENCE, login.context.localStorage.getItem(PREFERENCE)]] });
  assertLanguage(reloaded, 'en');
  const initial = reloaded.context.initialize();
  assert.equal(reloaded.requests.length, 1);
  assert.equal(acceptLanguage(reloaded.requests[0]), 'en');
  reloaded.respond(0, 503, {
    ok: false,
    error: 'Synthetic English configuration error.',
    errorDefault: 'Syntetyczny polski błąd konfiguracji.'
  });
  await initial;
  assert.match(reloaded.nodes.authMessage.textContent, /Synthetic English configuration error/);
  changeLanguage(reloaded, languageControls(reloaded).login, 'pl');
  assert.match(reloaded.nodes.authMessage.textContent, /Syntetyczny polski błąd konfiguracji/);
  assert.equal(reloaded.requests.length, 1, 'An existing error translates locally');
  console.log('PASS: Polish default, synchronized language controls, stored preference and localized API error');

  await assertLoginRetryRecovers();

  const test = harness();
  test.seed([GAME]);
  test.nodes.search.value = 'Żółw';
  test.nodes.statusFilter.value = GAME.status;
  test.nodes.sort.value = 'title';
  test.context.render();
  assertCard(test, 'pl');
  assert.match(test.nodes.addBtn.textContent, /dodaj grę/i);
  assert(test.nodes.addBtn.querySelector('svg'));

  test.context.openModal(GAME);
  const draftTitle = 'Roboczy <tytuł> & gracz';
  const draftCover = 'https://images.example.invalid/robocza.jpg';
  test.nodes.title.value = draftTitle;
  test.nodes.coverUrl.value = draftCover;
  const collectionControl = languageControls(test).collection;

  function assertDraft(language) {
    assert.equal(test.nodes.appShell.hidden, false);
    assert.equal(test.nodes.authScreen.hidden, true);
    assert(test.nodes.modalBackdrop.classList.contains('open'), 'The edit dialog stays open');
    assert.equal(test.nodes.gameId.value, GAME.id);
    assert.equal(test.nodes.title.value, draftTitle);
    assert.equal(test.nodes.coverUrl.value, draftCover);
    assert.equal(test.nodes.status.value, GAME.status);
    assert.equal(test.nodes.edition.value, GAME.edition);
    const selected = test.nodes.platform.querySelectorAll('input[name="platform"]').filter(input => input.checked);
    assert.deepEqual(selected.map(input => input.value), PLATFORMS);
    const importedPlatform = selected.find(input => input.value === PLATFORM_WITH_EDITION_NAME);
    assert.equal(importedPlatform.closest('label').textContent.trim(), PLATFORM_WITH_EDITION_NAME);
    assert.deepEqual(
      test.nodes.selectedPlatforms.querySelectorAll('.selected-platform-chip').map(chip => chip.textContent),
      language === 'en' ? ENGLISH_PLATFORM_LABELS : PLATFORMS
    );
    assert.equal(test.nodes.search.value, 'Żółw');
    assert.equal(test.nodes.statusFilter.value, GAME.status);
    assert.equal(test.nodes.sort.value, 'title');
  }

  changeLanguage(test, collectionControl, 'en');
  assertCard(test, 'en');
  assert.match(test.nodes.addBtn.textContent, /\badd\b.*\bgame\b/i);
  assert(test.nodes.addBtn.querySelector('svg'), 'Translation must retain the button icon');
  assertDraft('en');
  changeLanguage(test, collectionControl, 'pl');
  assertCard(test, 'pl');
  assertDraft('pl');
  assert.equal(test.requests.length, 0, 'Switching language keeps the existing session without a request');
  console.log('PASS: rendered cards, filters and unsaved game survive switching both ways');

  const save = test.nodes.gameForm.onsubmit({ preventDefault() {} });
  assert.equal(test.requests.length, 1);
  assert.equal(acceptLanguage(test.requests[0]), 'pl');
  const body = JSON.parse(test.requests[0].options.body);
  assert.equal(body.action, 'save');
  assert.deepEqual(body.game, { ...GAME, title: draftTitle, coverUrl: draftCover });
  test.respond(0, 200, { ok: true, games: [body.game] });
  await save;
  console.log('PASS: saving after switching sends the chosen locale and unchanged canonical collection values');

  test.nodes.search.value = '';
  changeLanguage(test, collectionControl, 'en');
  const deleteButton = test.nodes.grid.querySelector('[data-game-action="delete"]');
  assert(deleteButton);
  test.fire(deleteButton, 'click');
  assert(test.nodes.deleteModalBackdrop.classList.contains('open'));
  assert.equal(test.nodes.deleteGamePlatforms.textContent, ENGLISH_PLATFORM_LABELS.join(' · '));
  test.fire(test.nodes.deleteCancelButton, 'click');
  await flush();
  assert.equal(test.requests.length, 1, 'Cancelling the confirmation does not send a delete request');
  console.log('PASS: delete confirmation translates the built-in platform label and retains imported names');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
