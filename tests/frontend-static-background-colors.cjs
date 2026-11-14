'use strict';

// Exercise the real color settings alongside the production appearance, menu
// and language handlers. The offline fixtures never use an account or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { harness } = require('./frontend-dom.cjs');
const rootDirectory = path.join(__dirname, '..');
const appearanceSource = fs.readFileSync(path.join(rootDirectory, 'appearance.js'), 'utf8');
const colorSource = fs.readFileSync(path.join(rootDirectory, 'static-background-colors.js'), 'utf8');
const html = fs.readFileSync(path.join(rootDirectory, 'index.html'), 'utf8');
const THEME_KEY = 'savepoint-theme-v1';
const AERO_COLOR_KEY = 'savepoint-background-color-v1';
const configurations = [
  { theme: 'dos', backgroundKey: 'savepoint-dos-background-v1', animated: 'matrix', key: 'savepoint-dos-classic-color-v1', property: '--dos-classic-color', defaultColor: '#080a0a' },
  { theme: 'classic', backgroundKey: 'savepoint-classic-background-v1', animated: 'maze', key: 'savepoint-classic-desktop-color-v1', property: '--classic-desktop-color', defaultColor: '#008080' },
  { theme: 'classic3', backgroundKey: 'savepoint-classic3-background-v1', animated: 'pipes', key: 'savepoint-classic3-desktop-color-v1', property: '--classic3-desktop-color', defaultColor: '#3a6ea5' },
  { theme: 'platinum', key: 'savepoint-platinum-desktop-color-v1', property: '--platinum-desktop-color', defaultColor: '#858da8' },
  { theme: 'bee', key: 'savepoint-bee-desktop-color-v1', property: '--bee-desktop-color', defaultColor: '#07486d' }
];
const game = { id: 'static-color-demo', title: 'Synthetic color game', platform: 'PC', edition: 'Fizyczne', status: 'Do ogrania', coverUrl: '', createdAt: 1 };

function colorHarness(entries = [], { blocked = false, renderers = true } = {}) {
  const test = harness({ localStorageEntries: entries });
  const root = test.document.documentElement;
  // The shared DOM fixture stores custom properties directly. Supply only the
  // standard getter if the production module needs to read one back.
  root.style.getPropertyValue = name => root.style[name] ?? '';
  test.context.matchMedia = () => ({ matches: false, addEventListener() {} });
  test.context.Event = class Event { constructor(type) { this.type = type; } };
  test.document.dispatchEvent = event => { test.events[event.type]?.(event); return true; };
  if (renderers) {
    for (const name of ['SavepointMaze', 'SavepointPipes', 'SavepointMatrix']) {
      test.context.window[name] = { create() { return { resize() {}, setPlaying() {}, destroy() {} }; } };
    }
    test.context.window.SavepointP2Clock = { create() { return { resize() {}, setState() {}, destroy() {} }; } };
  }
  if (blocked) test.context.localStorage = {
    getItem() { throw new Error('Synthetic blocked storage'); },
    setItem() { throw new Error('Synthetic blocked storage'); },
    removeItem() { throw new Error('Synthetic blocked storage'); }
  };
  test.document.readyState = 'loading';
  vm.runInContext(appearanceSource, test.context, { filename: 'appearance.js' });
  vm.runInContext(colorSource, test.context, { filename: 'static-background-colors.js' });
  const earlyColors = Object.fromEntries(configurations.map(config => [config.theme, root.style[config.property]]));
  const earlyBeeCustom = root.dataset.beeDesktopCustomColor;
  test.events.DOMContentLoaded();
  return {
    ...test, root, earlyColors, earlyBeeCustom,
    wrapper: test.nodes.staticBackgroundColorControls,
    color: test.nodes.staticBackgroundColor,
    reset: test.nodes.staticBackgroundColorReset,
    choose(theme) {
      const control = test.query('[data-ui-theme]');
      control.value = theme;
      test.fire(control, 'change');
      assert.equal(root.dataset.theme, theme);
    },
    chooseBackground(config, value) {
      const attribute = { dos: 'data-dos-background', classic: 'data-classic-background', classic3: 'data-classic3-background' }[config.theme];
      const control = test.query(`select[${attribute}]`);
      control.value = value;
      test.fire(control, 'change');
    },
    setColor(value, event = 'input') {
      this.color.value = value;
      test.fire(this.color, event);
    }
  };
}

{
  const script = html.match(/<script\b[^>]*\bsrc="static-background-colors\.js[^"<]*"[^>]*>/);
  assert(script, 'The static color module must be included in the application');
  assert(html.indexOf(script[0]) < html.indexOf('</head>'), 'Saved colors must restore before the page paints');
  assert(!/\b(?:defer|async)\b/.test(script[0]), 'Pre-paint color restoration must not wait for deferred scripts');
  const restoredColors = ['#A1B2C3', '#00AaBB', '#EEDDCC', '#789AbC', '#BC9A78'];
  const test = colorHarness(configurations.map((config, index) => [config.key, restoredColors[index]]));
  assert.equal(test.earlyBeeCustom, 'true', 'A saved custom Bee palette must be available before painting');
  for (const [index, config] of configurations.entries()) {
    const expected = restoredColors[index].toLowerCase();
    assert.equal(test.earlyColors[config.theme], expected);
    assert.equal(test.root.style[config.property], expected);
    test.choose(config.theme);
    assert.equal(test.wrapper.hidden, false);
    assert.equal(test.color.value, expected);
    assert.equal(test.reset.disabled, false);
  }
  assert.equal(test.requests.length, 0);
  console.log('PASS: valid independent colors restore in lowercase before painting and populate the active control');
}

{
  for (const value of ['#123', '#11223344', 'red', ' #112233', '#12FG45', 'url(https://invalid.example/image)', '']) {
    const test = colorHarness(configurations.map(config => [config.key, value]));
    for (const config of configurations) {
      assert.equal(test.earlyColors[config.theme], config.defaultColor, 'Malformed saved colors must not reach CSS');
      test.choose(config.theme);
      assert.equal(test.color.value, config.defaultColor);
      assert.equal(test.reset.disabled, true);
    }
    assert.equal(test.earlyBeeCustom, 'false', 'Malformed Bee colors must preserve the original patterned desktop');
    assert.equal(test.requests.length, 0);
  }
  console.log('PASS: malformed saved values fall back independently to all five original desktop colors');
}

{
  const test = colorHarness([[AERO_COLOR_KEY, '#8b2fcb']]);
  for (const config of configurations) {
    assert.equal(test.root.style[config.property], config.defaultColor);
    test.choose(config.theme);
    assert.equal(test.reset.disabled, true);
    test.setColor('#Aa12Bc');
    assert.equal(test.root.style[config.property], '#aa12bc');
    assert.equal(test.context.localStorage.getItem(config.key), '#aa12bc');
    assert.equal(test.reset.disabled, false);
    for (const other of configurations.filter(other => other !== config)) {
      assert.equal(test.root.style[other.property], other.defaultColor);
      assert.equal(test.context.localStorage.getItem(other.key), null);
    }
    test.setColor('#cCdDeE', 'change');
    assert.equal(test.root.style[config.property], '#ccddee');
    assert.equal(test.context.localStorage.getItem(config.key), '#ccddee');
    test.setColor('#abcd');
    assert.equal(test.root.style[config.property], '#ccddee', 'Malformed input events must not replace a valid color');
    assert.equal(test.context.localStorage.getItem(config.key), '#ccddee');
    test.fire(test.reset, 'click');
    assert.equal(test.root.style[config.property], config.defaultColor);
    assert.equal(test.color.value, config.defaultColor);
    assert.equal(test.reset.disabled, true);
    assert.equal(test.context.localStorage.getItem(config.key), null);
  }
  assert.equal(test.context.localStorage.getItem(AERO_COLOR_KEY), '#8b2fcb');
  assert.equal(test.nodes.backgroundColor.value, '#8b2fcb');
  assert.equal(test.requests.length, 0);
  console.log('PASS: input/change and reset affect only the selected static desktop and preserve Aero');
}

{
  const selected = ['#123456', '#abcdef', '#987654', '#456789', '#654321'];
  const test = colorHarness(configurations.map((config, index) => [config.key, selected[index]]));
  test.choose('classic');
  test.fire(test.reset, 'click');
  for (const [index, config] of configurations.entries()) {
    assert.equal(test.root.style[config.property], config.theme === 'classic' ? config.defaultColor : selected[index]);
    assert.equal(test.context.localStorage.getItem(config.key), config.theme === 'classic' ? null : selected[index]);
  }
  test.choose('dos');
  assert.equal(test.color.value, selected[0]);
  test.choose('classic3');
  assert.equal(test.color.value, selected[2]);
  console.log('PASS: resetting one saved desktop leaves the other four saved colors intact');
}

{
  const test = colorHarness();
  const allowed = new Set(configurations.map(config => config.theme));
  for (const option of test.query('[data-ui-theme]').querySelectorAll('option')) {
    test.choose(option.value);
    assert.equal(test.wrapper.hidden, !allowed.has(option.value), 'The shared picker belongs only to the five supported static desktops');
    if (!allowed.has(option.value)) {
      test.setColor('#224466');
      test.fire(test.reset, 'click');
      for (const config of configurations) {
        assert.equal(test.root.style[config.property], config.defaultColor);
        assert.equal(test.context.localStorage.getItem(config.key), null);
      }
    }
  }
  // A delayed native picker event may arrive after attributes change but before
  // the next appearance notification. It must not color the newly active theme.
  test.choose('classic');
  test.root.dataset.theme = 'dos';
  test.setColor('#224466');
  assert.equal(test.context.localStorage.getItem('savepoint-dos-classic-color-v1'), null);
  assert.equal(test.root.style['--dos-classic-color'], '#080a0a');
  test.choose('classic');
  test.root.dataset.classicBackground = 'maze';
  test.setColor('#224466');
  test.fire(test.reset, 'click');
  assert.equal(test.context.localStorage.getItem('savepoint-classic-desktop-color-v1'), null);
  assert.equal(test.root.style['--classic-desktop-color'], '#008080');
  test.choose('classic');
  for (const config of configurations.filter(config => config.animated)) {
    test.choose(config.theme);
    test.setColor('#13579b');
    test.chooseBackground(config, config.animated);
    assert.equal(test.wrapper.hidden, true);
    test.setColor('#2468ac', 'change');
    test.fire(test.reset, 'click');
    assert.equal(test.root.style[config.property], '#13579b', 'Stale native events from an animated desktop must not change the stored static color');
    assert.equal(test.context.localStorage.getItem(config.key), '#13579b');
    test.chooseBackground(config, 'classic');
    assert.equal(test.wrapper.hidden, false);
    assert.equal(test.color.value, '#13579b');
  }
  assert.equal(test.requests.length, 0);
  const fallback = colorHarness([[THEME_KEY, 'dos'], ['savepoint-dos-background-v1', 'matrix']], { renderers: false });
  assert.equal(fallback.root.dataset.dosBackground, 'classic');
  assert.equal(fallback.wrapper.hidden, false, 'A static failure fallback may use the color picker');
  fallback.setColor('#446688');
  assert.equal(fallback.root.style['--dos-classic-color'], '#446688');
  assert.equal(fallback.context.localStorage.getItem('savepoint-dos-background-v1'), 'matrix');
  console.log('PASS: all unrelated themes and animated desktops ignore hidden events; static fallback remains editable');
}

{
  const macCss = fs.readFileSync(path.join(rootDirectory, 'mac.css'), 'utf8');
  const sevenCss = fs.readFileSync(path.join(rootDirectory, 'seven-themes.css'), 'utf8');
  const colorCss = fs.readFileSync(path.join(rootDirectory, 'static-background-colors.css'), 'utf8');
  const platinumOriginal = macCss.match(/html\[data-theme="platinum"\]\s*\{([\s\S]*?)\}/)?.[1];
  const beeOriginal = sevenCss.match(/html\[data-theme="bee"\]\s*\{([\s\S]*?)\}/)?.[1];
  assert(platinumOriginal && beeOriginal);
  assert.match(platinumOriginal, /--mac-desktop:\s*repeating-linear-gradient\(0deg, #ffffff08 0 1px, transparent 1px 4px\), repeating-linear-gradient\(90deg, #353a5e14 0 1px, transparent 1px 4px\), #858da8;/);
  assert.match(beeOriginal, /--skin-desktop:\s*repeating-linear-gradient\(135deg, transparent 0 2px, #23a1aa22 2px 3px, transparent 3px 6px\), repeating-linear-gradient\(45deg, #063d68 0 2px, #176d8b 2px 3px, #07486d 3px 5px\);/);
  const platinumOverride = colorCss.match(/html\[data-theme="platinum"\]\s+body\s*\{([^}]+)\}/)?.[1];
  assert(platinumOverride, 'Platinum must change its desktop base color without replacing the original texture');
  assert.match(platinumOverride, /background-color:\s*var\(--platinum-desktop-color,\s*#858da8\)/);
  assert.doesNotMatch(platinumOverride, /(?:^|;)\s*background(?:-image)?\s*:/);
  const beeOverrides = [...colorCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].includes('[data-theme="bee"]'));
  assert(beeOverrides.length > 0);
  for (const [, selector] of beeOverrides) {
    assert(selector.includes('[data-bee-desktop-custom-color="true"]'), 'Bee must retain the original pattern until a custom color is active');
  }
  const test = colorHarness();
  assert.equal(test.earlyColors.platinum, '#858da8');
  assert.equal(test.earlyColors.bee, '#07486d');
  assert.equal(test.earlyBeeCustom, 'false');
  test.choose('platinum');
  assert.equal(test.color.value, '#858da8');
  assert.equal(test.reset.disabled, true);
  test.choose('bee');
  assert.equal(test.color.value, '#07486d');
  assert.equal(test.reset.disabled, true);
  assert.equal(test.root.dataset.beeDesktopCustomColor, 'false');
  console.log('PASS: Platinum and Bee defaults retain their original CSS textures; only custom Bee colors enable its override');
}

{
  const bee = configurations.find(config => config.theme === 'bee');
  const others = configurations.filter(config => config !== bee);
  const saved = others.map((config, index) => [config.key, ['#123456', '#234567', '#345678', '#456789'][index]]);
  const test = colorHarness([
    ...saved, [bee.key, '#Ac42F0'], [AERO_COLOR_KEY, '#8b2fcb'],
    ['savepoint-dos-background-v1', 'matrix'],
    ['savepoint-classic-background-v1', 'maze'],
    ['savepoint-classic3-background-v1', 'pipes']
  ]);
  assert.equal(test.earlyColors.bee, '#ac42f0');
  assert.equal(test.earlyBeeCustom, 'true');
  test.choose('platinum');
  assert.equal(test.wrapper.hidden, false, 'Platinum is editable independently of animated choices in other themes');
  test.choose('bee');
  assert.equal(test.wrapper.hidden, false);
  assert.equal(test.color.value, '#ac42f0');
  for (const color of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#123456']) {
    test.setColor(color);
    assert.equal(test.root.style[bee.property], color);
    assert.equal(test.root.dataset.beeDesktopCustomColor, 'true');
    for (const property of ['--bee-desktop-shadow', '--bee-desktop-highlight']) {
      const value = test.root.style[property];
      assert.match(value, /^#[0-9a-f]{6}$/, 'Derived Bee tones must remain valid opaque hexadecimal CSS colors');
      assert(Number.isFinite(parseInt(value.slice(1), 16)));
    }
    assert.match(test.root.style['--bee-desktop-sheen'], /^#[0-9a-f]{8}$/, 'The Bee sheen must retain an explicit safe alpha channel');
  }
  assert.notEqual(test.root.style['--bee-desktop-shadow'], test.root.style['--bee-desktop-highlight']);
  test.reset.focus();
  test.fire(test.reset, 'click');
  assert.equal(test.document.activeElement, test.color);
  assert.equal(test.root.style[bee.property], '#07486d');
  assert.equal(test.root.dataset.beeDesktopCustomColor, 'false');
  assert.equal(test.context.localStorage.getItem(bee.key), null);
  assert.equal(test.reset.disabled, true);
  for (const [key, color] of saved) assert.equal(test.context.localStorage.getItem(key), color);
  assert.equal(test.context.localStorage.getItem(AERO_COLOR_KEY), '#8b2fcb');
  test.setColor('#07486D');
  assert.equal(test.root.dataset.beeDesktopCustomColor, 'false', 'Selecting Bee\'s base color must restore its original pattern');
  assert.equal(test.reset.disabled, true);
  const restoredDefault = colorHarness([[bee.key, '#07486D']]);
  assert.equal(restoredDefault.earlyBeeCustom, 'false');
  assert.equal(restoredDefault.earlyColors.bee, '#07486d');
  assert.equal(test.requests.length, 0);
  console.log('PASS: Bee custom colors use safe derived tones and reset restores its original patterned desktop independently');
}

{
  const test = colorHarness();
  for (const theme of ['platinum', 'bee']) {
    const config = configurations.find(config => config.theme === theme);
    test.choose(theme);
    test.setColor('#224466');
    test.wrapper.hidden = true;
    test.setColor('#aaccee');
    assert.equal(test.context.localStorage.getItem(config.key), '#224466');
    test.wrapper.hidden = true;
    test.fire(test.reset, 'click');
    assert.equal(test.context.localStorage.getItem(config.key), '#224466');
    test.root.dataset.theme = 'aero';
    test.setColor('#aaccee');
    test.fire(test.reset, 'click');
    assert.equal(test.root.style[config.property], '#224466');
    assert.equal(test.context.localStorage.getItem(config.key), '#224466');
    test.choose(theme);
    assert.equal(test.wrapper.hidden, false);
    assert.equal(test.color.value, '#224466');
  }
  test.choose('platinum');
  test.root.dataset.theme = 'bee';
  test.setColor('#abcdef');
  assert.equal(test.context.localStorage.getItem('savepoint-bee-desktop-color-v1'), '#224466', 'A stale Platinum event cannot recolor Bee');
  assert.equal(test.context.localStorage.getItem('savepoint-platinum-desktop-color-v1'), '#224466');
  assert.equal(test.requests.length, 0);
  console.log('PASS: Platinum and Bee ignore hidden and delayed events while preserving their separate colors');
}

{
  const test = colorHarness([], { blocked: true });
  for (const config of configurations) {
    assert.equal(test.earlyColors[config.theme], config.defaultColor);
    test.choose(config.theme);
    test.setColor('#102030');
    assert.equal(test.root.style[config.property], '#102030');
    test.fire(test.reset, 'click');
    assert.equal(test.root.style[config.property], config.defaultColor);
    assert.equal(test.reset.disabled, true);
  }
  assert.equal(test.requests.length, 0);
  console.log('PASS: blocked browser storage still permits temporary color changes and reset');
}

{
  const test = colorHarness([[THEME_KEY, 'classic'], [AERO_COLOR_KEY, '#8b2fcb']]);
  test.seed([game]);
  test.context.render();
  test.nodes.title.value = 'Unsaved static-color draft';
  const polishCards = test.nodes.grid.innerHTML;
  for (const control of [test.wrapper, test.color, test.reset]) {
    assert(test.nodes.appMenuTheme.contains(control));
    assert(!test.nodes.authScreen.contains(control));
    assert(!control.closest('form'), 'Appearance controls must never submit a form');
  }
  assert.equal(test.color.type, 'color');
  assert.equal(test.reset.type, 'button');
  assert.equal(test.nodes.authScreen.querySelectorAll('input[type="color"]').length, 0);
  test.fire(test.nodes.appMenuToggle, 'click');
  test.nodes.appMenuTheme.setAttribute('open', '');
  test.color.focus();
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab']) {
    let prevented = false;
    test.events.keydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, 'Native color-picker keys must not trigger menu navigation');
    assert.equal(test.document.activeElement, test.color);
  }
  test.setColor('#507090');
  test.fire(test.color, 'click');
  assert.equal(test.nodes.appMenu.hidden, false);
  test.reset.focus();
  assert.equal(test.document.activeElement, test.reset);
  test.fire(test.reset, 'click');
  assert.equal(test.document.activeElement, test.color, 'A focused Reset must move focus to the picker before becoming disabled');
  assert.equal(test.reset.disabled, true);
  assert.equal(test.color.value, '#008080');
  assert.equal(test.root.style['--classic-desktop-color'], '#008080');
  assert.equal(test.nodes.appMenu.hidden, false, 'Resetting a color must keep the Theme category open');
  const polishReset = test.reset.textContent;
  const polishLabel = test.color.getAttribute('aria-label');
  const language = test.query('[data-ui-language]');
  language.value = 'en';
  test.fire(language, 'change');
  assert.equal(test.root.getAttribute('lang'), 'en');
  assert(test.color.getAttribute('data-en-aria-label'));
  assert.equal(test.color.getAttribute('aria-label'), test.color.getAttribute('data-en-aria-label'));
  assert.notEqual(test.reset.textContent, polishReset);
  const englishCards = test.nodes.grid.innerHTML;
  for (const config of configurations) {
    test.choose(config.theme);
    test.setColor('#305070');
    assert.equal(test.nodes.grid.innerHTML, englishCards);
    assert.equal(test.nodes.title.value, 'Unsaved static-color draft');
    assert.equal(test.nodes.appShell.hidden, false);
    assert.equal(test.root.getAttribute('lang'), 'en');
    assert.equal(test.nodes.appMenu.hidden, false);
    assert.equal(test.nodes.backgroundColor.value, '#8b2fcb');
  }
  language.value = 'pl';
  test.fire(language, 'change');
  assert.equal(test.reset.textContent, polishReset);
  assert.equal(test.color.getAttribute('aria-label'), polishLabel);
  assert.equal(test.nodes.grid.innerHTML, polishCards);
  assert.equal(test.requests.length, 0);
  console.log('PASS: authenticated menu, native keyboard behavior and PL/EN preserve the collection, draft, session and Aero color');
}
