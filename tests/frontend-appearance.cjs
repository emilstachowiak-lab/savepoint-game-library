'use strict';

// Run the appearance controller alongside the actual frontend. Theme changes
// must preserve authentication, unsaved form input and the current collection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { harness } = require('./frontend-dom.cjs');
const source = fs.readFileSync(path.join(__dirname, '..', 'appearance.js'), 'utf8');
const THEME_KEY = 'savepoint-theme-v1';
const MOTION_KEY = 'savepoint-background-motion-v1';
const MAZE_BACKGROUND_KEY = 'savepoint-classic-background-v1';
const BACKGROUND_KEY = 'savepoint-classic3-background-v1';

function appearanceHarness(entries = [], reduced = false, storageBlocked = false, pipesMode = 'ready', mazeMode = 'ready') {
  const test = harness({ localStorageEntries: entries });
  const media = { matches: reduced, addEventListener() {} };
  test.context.matchMedia = () => media;
  test.context.Event = class Event { constructor(type) { this.type = type; } };
  test.document.dispatchEvent = event => { test.events[event.type]?.(event); return true; };
  const pipes = { created: 0, destroyed: 0, resized: 0, playing: false };
  if (pipesMode !== 'missing') test.context.window.SavepointPipes = {
    create(canvas, onFailure) {
      assert.equal(canvas, test.nodes.pipesCanvas);
      pipes.created += 1;
      pipes.fail = onFailure;
      if (pipesMode === 'throw') throw new Error('Synthetic factory failure');
      if (pipesMode === 'none') return null;
      if (pipesMode === 'initial-failure') { onFailure(); return null; }
      return {
        resize() { pipes.resized += 1; },
        setPlaying(value) { pipes.playing = value; },
        destroy() { pipes.destroyed += 1; pipes.playing = false; }
      };
    }
  };
  const maze = { created: 0, destroyed: 0, resized: 0, playing: false };
  if (mazeMode !== 'missing') test.context.window.SavepointMaze = {
    create(canvas, onFailure) {
      assert.equal(canvas, test.nodes.mazeCanvas);
      maze.created += 1;
      maze.fail = onFailure;
      if (mazeMode === 'throw') throw new Error('Synthetic maze factory failure');
      if (mazeMode === 'none') return null;
      if (mazeMode === 'initial-failure') { onFailure(); return null; }
      if (mazeMode === 'initial-failure-with-renderer') onFailure();
      return {
        resize() { maze.resized += 1; },
        setPlaying(value) { maze.playing = value; },
        destroy() { maze.destroyed += 1; maze.playing = false; }
      };
    }
  };
  if (storageBlocked) {
    test.context.localStorage = {
      getItem() { throw new Error('Synthetic blocked storage'); },
      setItem() { throw new Error('Synthetic blocked storage'); }
    };
  }
  test.document.readyState = 'loading';
  vm.runInContext(source, test.context, { filename: 'appearance.js' });
  const earlyTheme = test.document.documentElement.dataset.theme;
  const earlyMazeBackground = test.document.documentElement.dataset.classicBackground;
  test.events.DOMContentLoaded();
  return {
    ...test, earlyTheme, earlyMazeBackground,
    root: test.document.documentElement,
    themes: test.queryAll('[data-ui-theme]'),
    motions: test.queryAll('input[data-background-motion]'),
    aquarium: test.query('#aquariumBackground'),
    backgrounds: test.queryAll('select[data-classic3-background]'),
    mazeBackgrounds: test.queryAll('select[data-classic-background]'),
    mazeStage: test.query('#mazeBackground'),
    maze,
    pipesStage: test.query('#pipesBackground'),
    pipes,
    chooseBackground(value) {
      const control = this.backgrounds[0];
      control.value = value;
      this.fire(control, 'change');
      assert(this.backgrounds.every(select => select.value === this.root.dataset.classic3Background));
    },
    chooseMaze(value) {
      const control = this.mazeBackgrounds[0];
      control.value = value;
      this.fire(control, 'change');
      assert(this.mazeBackgrounds.every(select => select.value === this.root.dataset.classicBackground));
    },
    choose(value) {
      const control = this.themes[0];
      control.value = value;
      this.fire(control, 'change');
      assert(this.themes.every(select => select.value === this.root.dataset.theme));
    }
  };
}

{
  const test = appearanceHarness([['savepoint-background-color-v1', '#8b2fcb']]);
  assert.equal(test.earlyTheme, 'aero');
  assert.equal(test.themes.length, 1);
  assert.equal(test.motions.length, 1);
  assert.equal(test.aquarium.hidden, true);
  assert.equal(test.aquarium.querySelector('img').hasAttribute('src'), false);
  assert.equal(test.nodes.backgroundColor.value, '#8b2fcb');
  assert.equal(test.themes[0].querySelector('option[value="luna"]').textContent, 'Luna');
  test.seed([{ id: 'theme-demo', title: 'Synthetic game', platform: 'PS5', status: 'Do ogrania', edition: 'Fizyczne', coverUrl: '', createdAt: 1 }]);
  test.context.render();
  test.nodes.title.value = 'Unsaved title';
  const cards = test.nodes.grid.innerHTML;
  test.choose('luna');
  assert.equal(test.aquarium.hidden, false);
  assert.equal(test.aquarium.dataset.playing, 'true');
  assert.equal(test.query('#backgroundColorControl').hidden, true);
  assert.match(test.aquarium.querySelector('img').src, /^assets\/luna-reef\.webp\?v=/);
  assert.equal(test.nodes.grid.innerHTML, cards);
  assert.equal(test.nodes.title.value, 'Unsaved title');
  assert.equal(test.nodes.appShell.hidden, false);
  assert.equal(test.requests.length, 0);
  assert.equal(test.context.localStorage.getItem(THEME_KEY), 'luna');
  test.choose('aero');
  assert.equal(test.aquarium.hidden, true);
  assert.equal(test.query('#backgroundColorControl').hidden, false);
  assert.equal(test.nodes.backgroundColor.value, '#8b2fcb');
  assert.equal(test.nodes.grid.innerHTML, cards);
  assert.equal(test.requests.length, 0);
  console.log('PASS: Aero/Luna menu control preserves sign-in, forms, collection and the Aero color');
}

{
  const test = appearanceHarness([[THEME_KEY, 'luna']]);
  assert.equal(test.earlyTheme, 'luna');
  test.document.hidden = true;
  test.events.visibilitychange();
  assert.equal(test.aquarium.dataset.playing, 'false');
  test.document.hidden = false;
  test.events.visibilitychange();
  assert.equal(test.aquarium.dataset.playing, 'true');
  test.windowEvents.pagehide({ persisted: true });
  assert.equal(test.aquarium.dataset.playing, 'false');
  test.windowEvents.pageshow({ persisted: true });
  assert.equal(test.aquarium.dataset.playing, 'true');
  test.motions[0].checked = false;
  test.fire(test.motions[0], 'change');
  assert(test.motions.every(control => !control.checked));
  assert.equal(test.aquarium.dataset.playing, 'false');
  assert.equal(test.context.localStorage.getItem(MOTION_KEY), 'off');
  assert.equal(appearanceHarness([[THEME_KEY, 'luna'], [MOTION_KEY, 'off']]).aquarium.dataset.playing, 'false');
  const reduced = appearanceHarness([[THEME_KEY, 'luna']], true);
  assert.equal(reduced.aquarium.dataset.playing, 'false');
  reduced.motions[0].checked = true;
  reduced.fire(reduced.motions[0], 'change');
  assert.equal(reduced.aquarium.dataset.playing, 'true');
  assert.equal(reduced.root.dataset.backgroundMotion, 'on');
  assert.equal(appearanceHarness([[THEME_KEY, '<invalid>']]).earlyTheme, 'aero');
  const blocked = appearanceHarness([], false, true);
  blocked.choose('luna');
  assert.equal(blocked.aquarium.hidden, false);
  console.log('PASS: restored theme, paused/hidden/BFCache animation, reduced motion and blocked storage');
}

{
  const options = [
    ['aero', 'Aero'], ['luna', 'Luna'], ['classic', 'Classic'],
    ['classic2', 'Classic 2'], ['classic3', 'Classic 3'],
    ['platinum', 'Platinum'], ['aqua', 'Aqua'], ['mountain', 'Mountain Lion'],
    ['liquidglass', 'Liquid Glass'], ['oldlinux', 'Old Linux'], ['ulinux', 'U Linux'],
    ['flinux', 'F Linux'], ['bee', 'Bee'], ['dos', 'DOS'], ['longhorn', 'Longhorn'],
    ['p1', 'P1'], ['p2', 'P2'], ['dream', 'Dream'], ['gc', 'GC'],
    ['play', 'Like to Play'], ['x', 'X'], ['x360', 'X360']
  ];
  for (const name of ['classic', 'classic2', 'classic3']) {
    const test = appearanceHarness([[THEME_KEY, name], [MOTION_KEY, 'on']]);
    assert.equal(test.earlyTheme, name);
    assert(test.themes.every(control => control.value === name));
    for (const select of test.themes) {
      assert.deepEqual(select.querySelectorAll('option').map(option => [option.value, option.textContent]), options);
    }
    assert.equal(test.aquarium.hidden, true);
    assert.equal(test.aquarium.dataset.playing, 'false');
    assert.equal(test.aquarium.querySelector('img').hasAttribute('src'), false);
    assert.equal(test.query('#backgroundColorControl').hidden, true);
    assert(test.motions.every(control => control.closest('.background-motion-control').hidden));
    assert(test.queryAll('.mac-window-caption').every(caption => caption.hidden));
    assert.equal(test.context.localStorage.getItem(MOTION_KEY), 'on');
    test.choose('luna');
    assert.equal(test.aquarium.hidden, false);
    assert.equal(test.aquarium.dataset.playing, 'true');
    assert(test.motions.every(control => !control.closest('.background-motion-control').hidden));
    test.choose(name);
    assert.equal(test.aquarium.hidden, true);
    test.choose('aero');
    assert.equal(test.query('#backgroundColorControl').hidden, false);
    assert(test.motions.every(control => !control.closest('.background-motion-control').hidden));
    assert.equal(test.context.localStorage.getItem(MOTION_KEY), 'on');
  }
  console.log('PASS: all twenty-two names, restored Classic variants and return to unchanged Aero/Luna preferences');
}

{
  const test = appearanceHarness([['savepoint-background-color-v1', '#8b2fcb']]);
  test.seed([{ id: 'classic-demo', title: 'Synthetic game', platform: 'PS5', status: 'Do ogrania', edition: 'Fizyczne', coverUrl: '', createdAt: 1 }]);
  test.context.render();
  test.nodes.title.value = 'Unsaved draft';
  const cards = test.nodes.grid.innerHTML;
  for (const name of ['classic', 'classic2', 'classic3', 'platinum', 'aqua', 'mountain', 'luna', 'aero']) {
    test.choose(name);
    assert.equal(test.nodes.title.value, 'Unsaved draft');
    assert.equal(test.nodes.grid.innerHTML, cards);
    assert.equal(test.nodes.appShell.hidden, false);
    assert.equal(test.requests.length, 0);
    assert.equal(test.nodes.backgroundColor.value, '#8b2fcb');
  }
  test.choose('classic2');
  const language = test.queryAll('select[data-ui-language]')[0];
  language.value = 'en';
  test.fire(language, 'change');
  assert.equal(test.document.documentElement.getAttribute('lang'), 'en');
  assert.equal(test.root.dataset.theme, 'classic2');
  assert(test.themes.every(select => select.querySelector('option[value="classic2"]').textContent === 'Classic 2'));
  assert.equal(test.nodes.title.value, 'Unsaved draft');
  assert.equal(test.requests.length, 0);
  console.log('PASS: switching every theme preserves collection, authentication, draft, color and language');
}

{
  const names = [['platinum', 'Platinum'], ['aqua', 'Aqua'], ['mountain', 'Mountain Lion']];
  for (const [name, label] of names) {
    const test = appearanceHarness([
      [THEME_KEY, name], [MOTION_KEY, 'on'],
      [MAZE_BACKGROUND_KEY, 'maze'], [BACKGROUND_KEY, 'pipes']
    ]);
    assert.equal(test.earlyTheme, name, 'A saved Mac theme must be restored before the page paints');
    assert(test.themes.every(control => control.value === name));
    assert(test.themes.every(control => control.querySelector(`option[value="${name}"]`).textContent === label));
    assert.equal(test.queryAll('.mac-window-caption').length, 2);
    assert(test.queryAll('.mac-window-caption').every(caption => !caption.hidden));
    assert.equal(test.aquarium.hidden, true);
    assert.equal(test.aquarium.querySelector('img').hasAttribute('src'), false);
    assert.equal(test.mazeStage.hidden, true);
    assert.equal(test.pipesStage.hidden, true);
    assert.equal(test.maze.created, 0);
    assert.equal(test.pipes.created, 0);
    assert(test.mazeBackgrounds.every(control => control.closest('.classic-background-control').hidden));
    assert(test.backgrounds.every(control => control.closest('.classic3-background-control').hidden));
    assert(test.motions.every(control => control.closest('.background-motion-control').hidden));
    assert.equal(test.query('#backgroundColorControl').hidden, true);
    assert.equal(test.context.localStorage.getItem(MAZE_BACKGROUND_KEY), 'maze');
    assert.equal(test.context.localStorage.getItem(BACKGROUND_KEY), 'pipes');
    assert.equal(test.context.localStorage.getItem(MOTION_KEY), 'on');
    test.choose('luna');
    assert(test.queryAll('.mac-window-caption').every(caption => caption.hidden));
    assert.equal(test.aquarium.dataset.playing, 'true');
    test.choose(name);
    assert(test.queryAll('.mac-window-caption').every(caption => !caption.hidden));
    assert.equal(test.aquarium.dataset.playing, 'false');
    assert.equal(test.maze.created, 0);
    assert.equal(test.pipes.created, 0);
    assert.equal(test.context.localStorage.getItem(THEME_KEY), name);
    assert.equal(test.requests.length, 0);
  }
  console.log('PASS: restored Platinum/Aqua/Mountain Lion, synchronized captions and inactive optional backgrounds');
}

{
  for (const name of ['platinum', 'aqua', 'mountain']) {
    const test = appearanceHarness([
      [THEME_KEY, name], [MOTION_KEY, 'off'],
      [MAZE_BACKGROUND_KEY, 'maze'], [BACKGROUND_KEY, 'pipes'],
      ['savepoint-background-color-v1', '#8b2fcb']
    ]);
    test.seed([{ id: 'mac-demo', title: 'Synthetic Mac game', platform: 'PS5', status: 'Do ogrania', edition: 'Fizyczne', coverUrl: '', createdAt: 1 }]);
    test.context.render();
    test.nodes.title.value = 'Unsaved Mac draft';
    const polishCards = test.nodes.grid.innerHTML;
    const language = test.queryAll('select[data-ui-language]')[0];
    language.value = 'en';
    test.fire(language, 'change');
    assert.equal(test.root.getAttribute('lang'), 'en');
    assert.equal(test.root.dataset.theme, name);
    assert(test.themes.every(control => control.querySelector('option[value="platinum"]').textContent === 'Platinum'));
    assert(test.themes.every(control => control.querySelector('option[value="aqua"]').textContent === 'Aqua'));
    assert(test.themes.every(control => control.querySelector('option[value="mountain"]').textContent === 'Mountain Lion'));
    const englishCards = test.nodes.grid.innerHTML;
    for (const target of ['aero', 'luna', 'classic', 'classic2', 'classic3', name]) {
      test.choose(target);
      assert.equal(test.nodes.appShell.hidden, false);
      assert.equal(test.nodes.title.value, 'Unsaved Mac draft');
      assert.equal(test.nodes.grid.innerHTML, englishCards);
      assert.equal(test.root.getAttribute('lang'), 'en');
      assert.equal(test.nodes.backgroundColor.value, '#8b2fcb');
      assert.equal(test.context.localStorage.getItem(MOTION_KEY), 'off');
      assert.equal(test.context.localStorage.getItem(MAZE_BACKGROUND_KEY), 'maze');
      assert.equal(test.context.localStorage.getItem(BACKGROUND_KEY), 'pipes');
      assert(test.motions.every(control => !control.checked));
      assert(test.queryAll('.mac-window-caption').every(caption => caption.hidden === (target !== name)));
      assert.equal(test.maze.playing, false);
      assert.equal(test.pipes.playing, false);
      assert.equal(test.aquarium.dataset.playing, 'false');
      assert.equal(test.requests.length, 0);
    }
    assert.equal(test.maze.created, 1, 'Returning to Classic must still restore its saved maze');
    assert.equal(test.pipes.created, 1, 'Returning to Classic 3 must still restore its saved pipes');
    language.value = 'pl';
    test.fire(language, 'change');
    assert.equal(test.root.getAttribute('lang'), 'pl');
    assert.equal(test.nodes.grid.innerHTML, polishCards);
    assert.equal(test.nodes.title.value, 'Unsaved Mac draft');
    assert.equal(test.root.dataset.theme, name);
    assert.equal(test.requests.length, 0);
  }
  console.log('PASS: all Mac themes preserve PL/EN, authentication, collection, draft and existing appearance preferences');
}

{
  const test = appearanceHarness([[THEME_KEY, 'classic3']]);
  assert.equal(test.root.dataset.classic3Background, 'classic');
  assert.equal(test.pipes.created, 0);
  assert.equal(test.backgrounds.length, 1);
  assert(test.backgrounds.every(control => !control.closest('.classic3-background-control').hidden));
  assert.equal(test.pipesStage.hidden, true);
  test.chooseBackground('pipes');
  assert.equal(test.pipes.created, 1);
  assert.equal(test.pipesStage.hidden, false);
  assert.equal(test.pipes.playing, true);
  assert(test.motions.every(control => !control.closest('.background-motion-control').hidden));
  assert.equal(test.context.localStorage.getItem(BACKGROUND_KEY), 'pipes');
  test.chooseBackground('classic');
  assert.equal(test.pipesStage.hidden, true);
  assert.equal(test.pipes.playing, false);
  assert.equal(test.pipes.destroyed, 0);
  test.chooseBackground('pipes');
  test.choose('luna');
  assert.equal(test.pipesStage.hidden, true);
  assert.equal(test.pipes.playing, false);
  assert.equal(test.aquarium.dataset.playing, 'true');
  test.choose('classic3');
  assert.equal(test.pipes.playing, true);
  assert.equal(test.pipes.created, 1, 'Returning to pipes reuses the paused scene');
  test.document.hidden = true;
  test.events.visibilitychange();
  assert.equal(test.pipes.playing, false);
  test.document.hidden = false;
  test.events.visibilitychange();
  assert.equal(test.pipes.playing, true);
  test.windowEvents.pagehide({ persisted: true });
  assert.equal(test.pipes.playing, false);
  assert.equal(test.pipes.destroyed, 0);
  test.windowEvents.pageshow({ persisted: true });
  assert.equal(test.pipes.playing, true);
  test.motions[0].checked = false;
  test.fire(test.motions[0], 'change');
  assert.equal(test.pipes.playing, false);
  test.windowEvents.pagehide({ persisted: false });
  assert.equal(test.pipes.destroyed, 1);
  test.windowEvents.pageshow({ persisted: true });
  assert.equal(test.pipes.destroyed, 1);
  assert.equal(test.pipes.playing, false);
  assert.equal(test.requests.length, 0);
  console.log('PASS: Classic/Pipes selectors, lazy scene reuse, theme changes, pause, visibility, BFCache and cleanup');
}

{
  const entries = [[THEME_KEY, 'classic3'], [BACKGROUND_KEY, 'pipes']];
  const restored = appearanceHarness(entries, true);
  assert.equal(restored.root.dataset.classic3Background, 'pipes');
  assert.equal(restored.pipes.created, 1);
  assert.equal(restored.pipes.playing, false);
  const invalid = appearanceHarness([[THEME_KEY, 'classic3'], [BACKGROUND_KEY, '<invalid>']]);
  assert.equal(invalid.root.dataset.classic3Background, 'classic');
  assert.equal(invalid.pipes.created, 0);
  for (const mode of ['none', 'missing', 'throw', 'initial-failure']) {
    const failed = appearanceHarness(entries, false, false, mode);
    assert.equal(failed.root.dataset.classic3Background, 'classic');
    assert.equal(failed.pipesStage.hidden, true);
    assert(failed.backgrounds.every(control => control.querySelector('option[value="pipes"]').disabled));
    assert(failed.queryAll('[data-pipes-status]').every(status => !status.hidden));
    failed.chooseBackground('classic');
    assert(failed.queryAll('[data-pipes-status]').every(status => status.hidden));
    assert.equal(failed.requests.length, 0);
  }
  const failedLater = appearanceHarness(entries);
  failedLater.pipes.fail();
  failedLater.events.visibilitychange();
  assert.equal(failedLater.root.dataset.classic3Background, 'classic');
  assert.equal(failedLater.pipesStage.hidden, true);
  assert.equal(failedLater.pipes.destroyed, 1);
  const language = restored.queryAll('select[data-ui-language]')[0];
  language.value = 'en';
  restored.fire(language, 'change');
  assert(restored.backgrounds.every(control => control.querySelector('option[value="classic"]').textContent === 'Classic'));
  assert(restored.backgrounds.every(control => control.querySelector('option[value="pipes"]').textContent === '3D Pipes'));
  assert.equal(restored.root.dataset.classic3Background, 'pipes');
  console.log('PASS: saved background, reduced motion, translated names and safe fallback for unavailable/failed pipes');
}

{
  const test = appearanceHarness([[THEME_KEY, 'classic']]);
  assert.equal(test.earlyMazeBackground, 'classic');
  assert.equal(test.mazeBackgrounds.length, 1);
  assert.equal(test.maze.created, 0, 'The original Classic desktop must not allocate a maze');
  assert.equal(test.mazeStage.hidden, true);
  assert(test.mazeBackgrounds.every(control => !control.closest('.classic-background-control').hidden));
  assert(test.mazeBackgrounds.every(control => control.querySelector('option[value="maze"]').textContent === 'Labirynt 3D'));
  test.chooseMaze('maze');
  assert.equal(test.root.dataset.classicBackground, 'maze');
  assert.equal(test.maze.created, 1);
  assert.equal(test.mazeStage.hidden, false);
  assert.equal(test.maze.playing, true);
  assert(test.motions.every(control => !control.closest('.background-motion-control').hidden));
  assert.equal(test.context.localStorage.getItem(MAZE_BACKGROUND_KEY), 'maze');
  test.chooseMaze('classic');
  assert.equal(test.mazeStage.hidden, true);
  assert.equal(test.maze.playing, false);
  assert(test.motions.every(control => control.closest('.background-motion-control').hidden));
  test.chooseMaze('maze');
  test.choose('classic2');
  assert.equal(test.mazeStage.hidden, true);
  assert.equal(test.maze.playing, false);
  assert(test.mazeBackgrounds.every(control => control.closest('.classic-background-control').hidden));
  test.choose('classic');
  assert.equal(test.maze.playing, true);
  assert.equal(test.maze.created, 1, 'Returning to the maze reuses the paused scene');
  assert.equal(test.requests.length, 0);
  console.log('PASS: Classic keeps its original desktop by default, synchronizes both maze selectors and lazily reuses the scene');
}

{
  const entries = [[THEME_KEY, 'classic'], [MAZE_BACKGROUND_KEY, 'maze'], [BACKGROUND_KEY, 'pipes']];
  const test = appearanceHarness(entries);
  assert.equal(test.earlyMazeBackground, 'maze');
  assert.equal(test.maze.created, 1);
  assert.equal(test.pipes.created, 0, 'A saved Classic 3 choice must stay inactive in Classic');
  test.choose('classic3');
  assert.equal(test.pipes.playing, true);
  assert.equal(test.pipesStage.hidden, false);
  assert.equal(test.maze.playing, false);
  assert.equal(test.mazeStage.hidden, true);
  test.chooseBackground('classic');
  assert.equal(test.context.localStorage.getItem(MAZE_BACKGROUND_KEY), 'maze');
  test.choose('classic');
  assert.equal(test.maze.playing, true);
  assert.equal(test.pipes.playing, false);
  test.chooseMaze('classic');
  test.choose('classic3');
  test.chooseBackground('pipes');
  assert.equal(test.context.localStorage.getItem(MAZE_BACKGROUND_KEY), 'classic');
  assert.equal(test.context.localStorage.getItem(BACKGROUND_KEY), 'pipes');
  test.choose('classic');
  assert.equal(test.mazeStage.hidden, true);
  assert.equal(test.root.dataset.classicBackground, 'classic');
  assert.equal(test.root.dataset.classic3Background, 'pipes');
  assert.equal(test.pipesStage.hidden, true);
  assert.equal(test.requests.length, 0);
  console.log('PASS: Classic maze and Classic 3 pipes preferences remain independent and never animate together');
}

{
  const entries = [[THEME_KEY, 'classic'], [MAZE_BACKGROUND_KEY, 'maze']];
  const test = appearanceHarness(entries, true);
  assert.equal(test.mazeStage.hidden, false, 'Reduced motion still shows a static maze');
  assert.equal(test.maze.playing, false);
  test.motions[0].checked = true;
  test.fire(test.motions[0], 'change');
  assert.equal(test.maze.playing, true);
  assert(test.motions.every(control => control.checked));
  test.document.hidden = true;
  test.events.visibilitychange();
  assert.equal(test.maze.playing, false);
  test.document.hidden = false;
  test.events.visibilitychange();
  assert.equal(test.maze.playing, true);
  test.windowEvents.pagehide({ persisted: true });
  assert.equal(test.maze.playing, false);
  assert.equal(test.maze.destroyed, 0);
  test.windowEvents.pageshow({ persisted: true });
  assert.equal(test.maze.playing, true);
  const resized = test.maze.resized;
  test.windowEvents.resize();
  assert(test.maze.resized > resized);
  test.motions[0].checked = false;
  test.fire(test.motions[0], 'change');
  assert.equal(test.maze.playing, false);
  assert.equal(test.context.localStorage.getItem(MOTION_KEY), 'off');
  const restored = appearanceHarness([...entries, [MOTION_KEY, 'off']]);
  assert.equal(restored.mazeStage.hidden, false);
  assert.equal(restored.maze.playing, false);
  test.windowEvents.pagehide({ persisted: false });
  assert.equal(test.maze.destroyed, 1);
  test.windowEvents.pageshow({ persisted: true });
  test.windowEvents.pagehide({ persisted: false });
  assert.equal(test.maze.destroyed, 1);
  assert.equal(test.maze.playing, false);
  const invalid = appearanceHarness([[THEME_KEY, 'classic'], [MAZE_BACKGROUND_KEY, '<invalid>']]);
  assert.equal(invalid.earlyMazeBackground, 'classic');
  assert.equal(invalid.maze.created, 0);
  const blocked = appearanceHarness([], false, true);
  blocked.choose('classic');
  blocked.chooseMaze('maze');
  assert.equal(blocked.mazeStage.hidden, false);
  assert.equal(blocked.maze.playing, true);
  console.log('PASS: maze restore, reduced motion, manual pause, resize, visibility, BFCache, cleanup and unavailable storage');
}

{
  const test = appearanceHarness([['savepoint-background-color-v1', '#8b2fcb']]);
  test.seed([{ id: 'maze-demo', title: 'Synthetic maze game', platform: 'PS5', status: 'Do ogrania', edition: 'Fizyczne', coverUrl: '', createdAt: 1 }]);
  test.context.render();
  test.nodes.title.value = 'Unsaved maze draft';
  const cards = test.nodes.grid.innerHTML;
  const language = test.queryAll('select[data-ui-language]')[0];
  test.choose('classic');
  test.chooseMaze('maze');
  language.value = 'en';
  test.fire(language, 'change');
  assert.equal(test.document.documentElement.getAttribute('lang'), 'en');
  assert(test.mazeBackgrounds.every(control => control.querySelector('option[value="maze"]').textContent === '3D Maze'));
  assert(test.mazeBackgrounds.every(control => control.getAttribute('aria-label') === 'Classic background'));
  assert(test.queryAll('[data-maze-status]').every(status => status.textContent === '3D Maze could not start. The Classic background is displayed.'));
  const englishCards = test.nodes.grid.innerHTML;
  assert.match(englishCards, /Synthetic maze game/);
  assert.match(englishCards, /Physical/);
  for (const name of ['aero', 'luna', 'classic2', 'classic3', 'classic']) {
    test.choose(name);
    assert.equal(test.nodes.appShell.hidden, false);
    assert.equal(test.nodes.title.value, 'Unsaved maze draft');
    assert.equal(test.nodes.grid.innerHTML, englishCards);
    assert.equal(test.nodes.backgroundColor.value, '#8b2fcb');
    assert.equal(test.root.getAttribute('lang'), 'en');
    assert.equal(test.requests.length, 0);
  }
  language.value = 'pl';
  test.fire(language, 'change');
  assert(test.mazeBackgrounds.every(control => control.querySelector('option[value="maze"]').textContent === 'Labirynt 3D'));
  assert(test.mazeBackgrounds.every(control => control.getAttribute('aria-label') === 'Tło motywu Classic'));
  assert.equal(test.nodes.grid.innerHTML, cards);
  assert.equal(test.root.dataset.classicBackground, 'maze');
  assert.equal(test.maze.playing, true);
  assert.equal(test.requests.length, 0);
  console.log('PASS: English/Polish maze labels and accessibility text preserve sign-in, collection, draft and Aero color');
}

// Runtime failures report asynchronously. Let the actual deferred refresh run
// without an extra UI event, so a frozen scene cannot mask a broken fallback.
(async () => {
  const entries = [[THEME_KEY, 'classic'], [MAZE_BACKGROUND_KEY, 'maze']];
  for (const mode of ['none', 'missing', 'throw', 'initial-failure', 'initial-failure-with-renderer']) {
    const failed = appearanceHarness(entries, false, false, 'ready', mode);
    await Promise.resolve();
    assert.equal(failed.root.dataset.classicBackground, 'classic');
    assert.equal(failed.mazeStage.hidden, true);
    assert.equal(failed.maze.playing, false);
    assert(failed.mazeBackgrounds.every(control => control.querySelector('option[value="maze"]').disabled));
    assert(failed.queryAll('[data-maze-status]').every(status => !status.hidden));
    assert.equal(failed.context.localStorage.getItem(MAZE_BACKGROUND_KEY), 'maze', 'Failure must not overwrite the saved choice');
    if (mode === 'initial-failure-with-renderer') assert.equal(failed.maze.destroyed, 1);
    failed.chooseMaze('classic');
    assert(failed.queryAll('[data-maze-status]').every(status => status.hidden));
    failed.choose('classic3');
    failed.chooseBackground('pipes');
    assert.equal(failed.pipes.playing, true, 'A maze failure must not disable the other renderer');
    assert.equal(failed.requests.length, 0);
  }
  const failedLater = appearanceHarness(entries);
  failedLater.maze.fail();
  await Promise.resolve();
  assert.equal(failedLater.root.dataset.classicBackground, 'classic');
  assert.equal(failedLater.mazeStage.hidden, true);
  assert.equal(failedLater.maze.destroyed, 1);
  assert.equal(failedLater.maze.playing, false);
  assert(failedLater.queryAll('[data-maze-status]').every(status => !status.hidden));
  assert.equal(failedLater.context.localStorage.getItem(MAZE_BACKGROUND_KEY), 'maze');
  assert.equal(failedLater.requests.length, 0);
  console.log('PASS: initial and runtime maze failures fall back automatically, preserve preference and leave pipes functional');
})().catch(error => { console.error(error); process.exitCode = 1; });

// New skins must change presentation without restarting authentication, losing
// unsaved edits, loading inactive artwork or changing existing theme settings.
{
  const names = [
    ['liquidglass', 'Liquid Glass'], ['oldlinux', 'Old Linux'], ['ulinux', 'U Linux'],
    ['flinux', 'F Linux'], ['bee', 'Bee'], ['dos', 'DOS'], ['longhorn', 'Longhorn']
  ];
  for (const [name, label] of names) {
    const test = appearanceHarness([
      [THEME_KEY, name], [MOTION_KEY, 'off'],
      [MAZE_BACKGROUND_KEY, 'maze'], [BACKGROUND_KEY, 'pipes'],
      ['savepoint-background-color-v1', '#8b2fcb']
    ]);
    assert.equal(test.earlyTheme, name);
    assert(test.themes.every(control => control.value === name));
    assert(test.themes.every(control => control.querySelector(`option[value="${name}"]`).textContent === label));
    assert.equal(test.queryAll('.skin-window-caption').length, 2);
    assert(test.queryAll('.skin-window-caption').every(caption => !caption.hidden));
    assert(test.queryAll('.mac-window-caption').every(caption => caption.hidden));
    assert.equal(test.aquarium.hidden, true);
    assert.equal(test.aquarium.querySelector('img').hasAttribute('src'), false);
    assert.equal(test.maze.created, 0);
    assert.equal(test.pipes.created, 0);
    assert(test.mazeBackgrounds.every(control => control.closest('.classic-background-control').hidden));
    assert(test.backgrounds.every(control => control.closest('.classic3-background-control').hidden));
    assert(test.motions.every(control => control.closest('.background-motion-control').hidden));
    test.seed([{ id: 'new-theme-demo', title: 'Synthetic game', platform: 'PS5', status: 'Do ogrania', edition: 'Fizyczne', coverUrl: '', createdAt: 1 }]);
    test.context.render();
    test.nodes.title.value = 'Unsaved theme draft';
    const polishCards = test.nodes.grid.innerHTML;
    const language = test.queryAll('select[data-ui-language]')[0];
    language.value = 'en';
    test.fire(language, 'change');
    const englishCards = test.nodes.grid.innerHTML;
    assert.notEqual(englishCards, polishCards);
    for (const target of ['aero', 'luna', 'classic', 'classic2', 'classic3', 'platinum', 'aqua', 'mountain', ...names.map(([key]) => key)]) {
      test.choose(target);
      assert.equal(test.nodes.appShell.hidden, false);
      assert.equal(test.nodes.title.value, 'Unsaved theme draft');
      assert.equal(test.nodes.grid.innerHTML, englishCards);
      assert.equal(test.root.getAttribute('lang'), 'en');
      assert.equal(test.nodes.backgroundColor.value, '#8b2fcb');
      assert.equal(test.context.localStorage.getItem(MAZE_BACKGROUND_KEY), 'maze');
      assert.equal(test.context.localStorage.getItem(BACKGROUND_KEY), 'pipes');
      assert.equal(test.context.localStorage.getItem(MOTION_KEY), 'off');
      assert.equal(test.maze.playing, false);
      assert.equal(test.pipes.playing, false);
      assert.equal(test.aquarium.dataset.playing, 'false');
      assert(test.queryAll('.skin-window-caption').every(caption => caption.hidden === !names.some(([key]) => key === target)));
      assert(test.queryAll('.mac-window-caption').every(caption => caption.hidden === !['platinum', 'aqua', 'mountain'].includes(target)));
      assert.equal(test.requests.length, 0);
    }
    assert.equal(test.maze.created, 1);
    assert.equal(test.pipes.created, 1);
    test.choose(name);
    language.value = 'pl';
    test.fire(language, 'change');
    assert.equal(test.root.dataset.theme, name);
    assert.equal(test.nodes.grid.innerHTML, polishCards);
    assert.equal(test.nodes.title.value, 'Unsaved theme draft');
    assert.equal(test.context.localStorage.getItem(THEME_KEY), name);
    const blocked = appearanceHarness([], false, true);
    blocked.choose(name);
    assert.equal(blocked.root.dataset.theme, name);
  }
  console.log('PASS: seven new skins restore before paint, preserve PL/EN/drafts/collection and return to all existing backgrounds');
}

// Console skins keep the original collection and editor mounted while their
// own decoration and navigation remain hidden in all fifteen previous skins.
{
  const names = [
    ['p1', 'P1'], ['p2', 'P2'], ['dream', 'Dream'], ['gc', 'GC'],
    ['play', 'Like to Play'], ['x', 'X'], ['x360', 'X360']
  ];
  const oldSkins = ['liquidglass', 'oldlinux', 'ulinux', 'flinux', 'bee', 'dos', 'longhorn'];
  const oldMac = ['platinum', 'aqua', 'mountain'];
  const previous = ['aero', 'luna', 'classic', 'classic2', 'classic3', ...oldMac, ...oldSkins];
  for (const [name, label] of names) {
    const test = appearanceHarness([
      [THEME_KEY, name], [MOTION_KEY, 'off'],
      [MAZE_BACKGROUND_KEY, 'maze'], [BACKGROUND_KEY, 'pipes'],
      ['savepoint-background-color-v1', '#8b2fcb']
    ]);
    assert.equal(test.earlyTheme, name);
    assert(test.themes.every(control => control.value === name));
    assert(test.themes.every(control => control.querySelector(`option[value="${name}"]`).textContent === label));
    assert(test.queryAll('[data-console-theme-name]').every(caption => caption.textContent === label));
    const decoration = test.queryAll('.console-atmosphere, .console-window-caption, .console-navigation');
    assert.equal(decoration.length, 4);
    assert(decoration.every(element => !element.hidden));
    assert(test.queryAll('.mac-window-caption, .skin-window-caption').every(caption => caption.hidden));
    assert.equal(test.aquarium.hidden, true);
    assert.equal(test.aquarium.querySelector('img').hasAttribute('src'), false);
    assert.equal(test.maze.created, 0);
    assert.equal(test.pipes.created, 0);
    test.seed([{ id: 'console-theme-demo', title: 'Synthetic game', platform: 'PS5', status: 'Do ogrania', edition: 'Fizyczne', coverUrl: '', createdAt: 1 }]);
    test.context.render();
    test.nodes.title.value = 'Unsaved console draft';
    const polishCards = test.nodes.grid.innerHTML;
    const language = test.queryAll('select[data-ui-language]')[0];
    language.value = 'en';
    test.fire(language, 'change');
    const englishCards = test.nodes.grid.innerHTML;
    for (const target of [...previous, ...names.map(([key]) => key)]) {
      test.choose(target);
      assert.equal(test.nodes.appShell.hidden, false);
      assert.equal(test.nodes.title.value, 'Unsaved console draft');
      assert.equal(test.nodes.grid.innerHTML, englishCards);
      assert.equal(test.root.lang || test.root.getAttribute('lang'), 'en');
      assert.equal(test.nodes.backgroundColor.value, '#8b2fcb');
      assert.equal(test.context.localStorage.getItem(MAZE_BACKGROUND_KEY), 'maze');
      assert.equal(test.context.localStorage.getItem(BACKGROUND_KEY), 'pipes');
      assert.equal(test.context.localStorage.getItem(MOTION_KEY), 'off');
      assert.equal(test.maze.playing, false);
      assert.equal(test.pipes.playing, false);
      assert.equal(test.aquarium.dataset.playing, 'false');
      assert(decoration.every(element => element.hidden === !names.some(([key]) => key === target)));
      assert(test.queryAll('.mac-window-caption').every(caption => caption.hidden === !oldMac.includes(target)));
      assert(test.queryAll('.skin-window-caption').every(caption => caption.hidden === !oldSkins.includes(target)));
      assert.equal(test.requests.length, 0);
    }
    test.choose(name);
    language.value = 'pl';
    test.fire(language, 'change');
    assert.equal(test.nodes.grid.innerHTML, polishCards);
    assert.equal(test.nodes.title.value, 'Unsaved console draft');
    assert.equal(test.context.localStorage.getItem(THEME_KEY), name);
    const blocked = appearanceHarness([], false, true);
    blocked.choose(name);
    assert.equal(blocked.root.dataset.theme, name);

    // Supply the native click primitive missing from the lightweight DOM model,
    // then exercise the production shortcut against the actual form handler.
    test.nodes.addBtn.click = () => test.fire(test.nodes.addBtn, 'click');
    test.fire(test.nodes.consoleLibrary, 'click');
    assert.equal(test.nodes.grid.scrolledIntoView, true);
    test.fire(test.nodes.consoleSearch, 'click');
    assert.equal(test.document.activeElement, test.nodes.search);
    test.fire(test.nodes.consoleAdd, 'click');
    assert(test.nodes.modalBackdrop.classList.contains('open'));
    assert.equal(test.requests.length, 0);
    test.context.closeModal();
    test.choose('aero');
    test.fire(test.nodes.consoleAdd, 'click');
    assert(!test.nodes.modalBackdrop.classList.contains('open'));
  }
  console.log('PASS: all seven renamed console skins preserve data/PL/EN/old backgrounds, isolate decoration and reuse existing actions');
}
