'use strict';

// Exercise Aero's real color controller, menu and language handlers offline.
// Renderer loading is local; no account, API or production data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { harness } = require('./frontend-dom.cjs');
const directory = path.join(__dirname, '..');
const appearanceSource = fs.readFileSync(path.join(directory, 'appearance.js'), 'utf8');
const staticColorSource = fs.readFileSync(path.join(directory, 'static-background-colors.js'), 'utf8');
const COLOR_KEY = 'savepoint-background-color-v1';
const DEFAULT_COLOR = '#0874bc';
const independentPreferences = [
  ['savepoint-dos-classic-color-v1', '#102030'],
  ['savepoint-classic-desktop-color-v1', '#405060'],
  ['savepoint-classic3-desktop-color-v1', '#708090'],
  ['savepoint-dos-background-v1', 'matrix'],
  ['savepoint-classic-background-v1', 'maze'],
  ['savepoint-classic3-background-v1', 'pipes'],
  ['savepoint-background-motion-v1', 'off']
];
const game = { id: 'aero-reset-demo', title: 'Synthetic Aero reset game', platform: 'PC', edition: 'Fizyczne', status: 'Do ogrania', coverUrl: '', createdAt: 1 };

function aeroHarness(entries = [], { fallback = false, blocked = false } = {}) {
  const initialTheme = new Map(entries).get('savepoint-theme-v1') ?? 'aero';
  const test = harness({
    localStorageEntries: entries,
    prepareDocument(document) {
      // Match the normal head-script restoration before app.js initializes.
      document.documentElement.dataset.theme = initialTheme;
      if (fallback) {
        const create = document.createElement;
        document.createElement = tag => {
          if (tag === 'img') throw new Error('Synthetic Aero artwork failure');
          return create(tag);
        };
      }
    }
  });
  let controller = vm.runInContext('xmbBackground', test.context);
  if (blocked) {
    controller.destroy();
    test.context.localStorage = {
      getItem() { throw new Error('Synthetic blocked storage'); },
      setItem() { throw new Error('Synthetic blocked storage'); },
      removeItem() { throw new Error('Synthetic blocked storage'); }
    };
    controller = test.context.initializeXmbBackground();
  }
  test.context.Event = class Event { constructor(type) { this.type = type; } };
  test.document.dispatchEvent = event => { test.events[event.type]?.(event); return true; };
  for (const name of ['SavepointMaze', 'SavepointPipes', 'SavepointMatrix']) {
    test.context.window[name] = { create() { return { resize() {}, setPlaying() {}, destroy() {} }; } };
  }
  test.context.window.SavepointP2Clock = { create() { return { resize() {}, setState() {}, destroy() {} }; } };
  test.document.readyState = 'complete';
  vm.runInContext(appearanceSource, test.context, { filename: 'appearance.js' });
  vm.runInContext(staticColorSource, test.context, { filename: 'static-background-colors.js' });
  return {
    ...test, controller,
    root: test.document.documentElement,
    picker: test.nodes.backgroundColor,
    reset: test.nodes.backgroundColorReset,
    stage: test.nodes.xmbBackground,
    color(value) {
      this.picker.value = value;
      test.fire(this.picker, 'input');
    },
    choose(theme) {
      const control = test.query('[data-ui-theme]');
      control.value = theme;
      test.fire(control, 'change');
      assert.equal(test.document.documentElement.dataset.theme, theme);
    },
    clickReset() { test.fire(this.reset, 'click'); }
  };
}

{
  const defaults = aeroHarness();
  assert.equal(defaults.picker.value, DEFAULT_COLOR);
  assert.equal(defaults.reset.hidden, false);
  assert.equal(defaults.reset.disabled, true);
  const test = aeroHarness([[COLOR_KEY, '#8b2fcb'], ...independentPreferences]);
  assert.equal(test.picker.value, '#8b2fcb');
  assert.equal(test.reset.hidden, false);
  assert.equal(test.reset.disabled, false);
  assert.notEqual(test.stage.style.background, defaults.stage.style.background);
  test.clickReset();
  assert.equal(test.picker.value, DEFAULT_COLOR);
  assert.equal(test.reset.disabled, true);
  assert.equal(test.context.localStorage.getItem(COLOR_KEY), null);
  assert.equal(test.stage.style.background, defaults.stage.style.background, 'Reset must refresh the existing Aero renderer to its original palette');
  for (const [key, value] of independentPreferences) assert.equal(test.context.localStorage.getItem(key), value);
  test.color('#24935b');
  assert.equal(test.context.localStorage.getItem(COLOR_KEY), '#24935b');
  assert.equal(test.reset.disabled, false);
  test.clickReset();
  assert.equal(test.picker.value, DEFAULT_COLOR);
  assert.equal(test.context.localStorage.getItem(COLOR_KEY), null);
  assert.equal(test.reset.disabled, true);
  assert.equal(test.requests.length, 0);
  console.log('PASS: restored and newly selected Aero colors reset to the original palette and remove only Aero preference');
}

{
  const defaults = aeroHarness([], { fallback: true });
  const test = aeroHarness([[COLOR_KEY, '#7a493c']], { fallback: true });
  assert.equal(test.reset.hidden, false);
  assert.equal(test.reset.disabled, false);
  assert.match(test.stage.style.background, /^linear-gradient\(155deg/);
  assert.notEqual(test.stage.style.background, defaults.stage.style.background);
  test.clickReset();
  assert.equal(test.picker.value, DEFAULT_COLOR);
  assert.equal(test.context.localStorage.getItem(COLOR_KEY), null);
  assert.equal(test.stage.style.background, defaults.stage.style.background, 'The gradient fallback must refresh even after artwork initialization fails');
  assert.equal(test.reset.disabled, true);
  assert.equal(test.requests.length, 0);
  console.log('PASS: an unavailable Aero renderer retains color reset and immediately refreshes its gradient fallback');
}

{
  const test = aeroHarness([[COLOR_KEY, '#8b2fcb'], ...independentPreferences]);
  const customBackground = test.stage.style.background;
  for (const option of test.query('[data-ui-theme]').querySelectorAll('option')) {
    if (option.value === 'aero') continue;
    test.choose(option.value);
    assert.equal(test.reset.hidden, true, 'Aero reset must stay hidden in every other theme');
    assert.equal(test.reset.disabled, true);
    test.clickReset();
    assert.equal(test.picker.value, '#8b2fcb');
    assert.equal(test.context.localStorage.getItem(COLOR_KEY), '#8b2fcb');
    for (const [key, value] of independentPreferences) assert.equal(test.context.localStorage.getItem(key), value);
  }
  test.choose('aero');
  assert.equal(test.reset.hidden, false);
  assert.equal(test.reset.disabled, false);
  test.reset.hidden = true;
  test.clickReset();
  assert.equal(test.context.localStorage.getItem(COLOR_KEY), '#8b2fcb', 'A hidden stale button event must be ignored');
  test.controller.refresh();
  test.root.dataset.theme = 'classic';
  test.clickReset();
  assert.equal(test.context.localStorage.getItem(COLOR_KEY), '#8b2fcb', 'The current theme must be checked even before its change notification arrives');
  assert.equal(test.stage.style.background, customBackground);
  test.choose('aero');
  test.clickReset();
  assert.equal(test.picker.value, DEFAULT_COLOR);
  assert.equal(test.requests.length, 0);
  console.log('PASS: all twenty-one other themes and hidden/stale events preserve Aero and independent desktop preferences');
}

{
  const test = aeroHarness([[COLOR_KEY, '#8b2fcb']]);
  test.seed([game]);
  test.context.render();
  test.nodes.title.value = 'Unsaved Aero reset draft';
  const polishCards = test.nodes.grid.innerHTML;
  assert.equal(test.reset.type, 'button');
  assert(test.nodes.appMenuTheme.contains(test.reset));
  assert(!test.nodes.authScreen.contains(test.reset));
  assert(!test.reset.closest('form'), 'Aero reset must not submit a form');
  test.fire(test.nodes.appMenuToggle, 'click');
  test.nodes.appMenuTheme.setAttribute('open', '');
  test.reset.focus();
  test.clickReset();
  assert.equal(test.document.activeElement, test.picker, 'Focus must move off Reset before it becomes disabled');
  assert.equal(test.reset.disabled, true);
  assert.equal(test.nodes.appMenu.hidden, false);
  assert(test.nodes.appMenuTheme.hasAttribute('open'));
  const polishReset = test.reset.textContent;
  const language = test.query('[data-ui-language]');
  language.value = 'en';
  test.fire(language, 'change');
  assert.equal(test.reset.textContent, 'Restore default color');
  assert.notEqual(test.reset.textContent, polishReset);
  const englishCards = test.nodes.grid.innerHTML;
  test.color('#3579ab');
  test.reset.focus();
  test.clickReset();
  assert.equal(test.document.activeElement, test.picker);
  assert.equal(test.nodes.grid.innerHTML, englishCards);
  assert.equal(test.nodes.title.value, 'Unsaved Aero reset draft');
  assert.equal(test.nodes.appShell.hidden, false);
  assert.equal(test.nodes.appMenu.hidden, false);
  assert.equal(test.root.getAttribute('lang'), 'en');
  language.value = 'pl';
  test.fire(language, 'change');
  assert.equal(test.reset.textContent, polishReset);
  assert.equal(test.nodes.grid.innerHTML, polishCards);
  assert.equal(test.requests.length, 0);
  console.log('PASS: focused reset keeps the authenticated Theme menu open and preserves PL/EN, collection, draft and session');
}

{
  const test = aeroHarness([], { blocked: true, fallback: true });
  assert.equal(test.picker.value, DEFAULT_COLOR);
  assert.equal(test.reset.disabled, true);
  const defaultBackground = test.stage.style.background;
  test.color('#936421');
  assert.equal(test.reset.disabled, false);
  assert.notEqual(test.stage.style.background, defaultBackground);
  test.clickReset();
  assert.equal(test.picker.value, DEFAULT_COLOR);
  assert.equal(test.reset.disabled, true);
  assert.equal(test.stage.style.background, defaultBackground);
  assert.equal(test.requests.length, 0);
  console.log('PASS: storage read/write/removal failures do not block temporary Aero color selection or reset');
}

{
  const test = aeroHarness([[COLOR_KEY, '#8b2fcb']]);
  const resetListeners = () => (test.reset.listeners.click ?? []).length;
  const pickerListeners = () => (test.picker.listeners.input ?? []).length;
  assert(resetListeners() > 0);
  test.windowEvents.pagehide({ persisted: true });
  assert(resetListeners() > 0, 'BFCache suspension must retain reset controls');
  test.windowEvents.pageshow({ persisted: true });
  test.clickReset();
  assert.equal(test.picker.value, DEFAULT_COLOR);
  assert.equal(test.context.localStorage.getItem(COLOR_KEY), null);
  test.color('#334455');
  const customBackground = test.stage.style.background;
  test.windowEvents.pagehide({ persisted: false });
  assert.equal(resetListeners(), 0, 'Final departure must remove the reset listener');
  assert.equal(pickerListeners(), 0);
  test.controller.destroy();
  test.reset.hidden = false;
  test.reset.disabled = false;
  test.clickReset();
  assert.equal(test.context.localStorage.getItem(COLOR_KEY), '#334455', 'Disposed controls cannot change preferences');
  test.color('#112233');
  assert.equal(test.context.localStorage.getItem(COLOR_KEY), '#334455');
  assert.equal(test.stage.style.background, customBackground);
  test.windowEvents.pageshow?.({ persisted: false });
  assert.equal(resetListeners(), 0, 'A disposed controller must not reattach on a later page event');
  assert.equal(test.requests.length, 0);
  console.log('PASS: BFCache retains Aero reset and final cleanup prevents stale listeners from changing color or storage');
}
