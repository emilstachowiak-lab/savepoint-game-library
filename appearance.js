// Restore appearance before the page paints. These preferences belong to the
// browser, independently of sign-in, language and the saved game collection.
(() => {
  'use strict';
  const THEME_KEY = 'savepoint-theme-v1';
  const MOTION_KEY = 'savepoint-background-motion-v1';
  const CLASSIC_BACKGROUND_KEY = 'savepoint-classic-background-v1';
  const CLASSIC3_BACKGROUND_KEY = 'savepoint-classic3-background-v1';
  const root = document.documentElement;
  const macThemes = ['platinum', 'aqua', 'mountain'];
  const additionalThemes = ['liquidglass', 'oldlinux', 'ulinux', 'flinux', 'bee', 'dos', 'longhorn'];
  const consoleThemes = {
    p1: 'P1', p2: 'P2', dream: 'Dream', gc: 'GC',
    play: 'Like to Play', x: 'X', x360: 'X360'
  };
  const consoleThemeKeys = Object.keys(consoleThemes);
  const themes = ['aero', 'luna', 'classic', 'classic2', 'classic3', ...macThemes, ...additionalThemes, ...consoleThemeKeys];
  const normalizeTheme = value => themes.includes(value) ? value : 'aero';
  // Blocked browser storage must not prevent appearance changes in this page.
  function readPreference(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function savePreference(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }
  let theme = normalizeTheme(readPreference(THEME_KEY));
  let classicBackground = readPreference(CLASSIC_BACKGROUND_KEY) === 'maze' ? 'maze' : 'classic';
  let classic3Background = readPreference(CLASSIC3_BACKGROUND_KEY) === 'pipes' ? 'pipes' : 'classic';
  const savedMotion = readPreference(MOTION_KEY);
  // Follow the system motion setting until the user saves an explicit choice.
  let motionPreference = ['on', 'off'].includes(savedMotion) ? savedMotion : null;
  let reducedMotion = null;
  try { reducedMotion = matchMedia('(prefers-reduced-motion: reduce)'); } catch {}
  const motionEnabled = () => motionPreference === null
    ? reducedMotion?.matches !== true
    : motionPreference === 'on';
  root.dataset.theme = theme;
  root.dataset.backgroundMotion = motionEnabled() ? 'on' : 'off';
  root.dataset.classicBackground = classicBackground;
  root.dataset.classic3Background = classic3Background;

  function initializeAppearance() {
    const themeControls = document.querySelectorAll('[data-ui-theme]');
    const macCaptions = document.querySelectorAll('.mac-window-caption');
    const additionalCaptions = document.querySelectorAll('.skin-window-caption');
    const consoleElements = document.querySelectorAll('.console-atmosphere, .console-window-caption, .console-navigation');
    const consoleNames = document.querySelectorAll('[data-console-theme-name]');
    const motionControls = document.querySelectorAll('input[data-background-motion]');
    const mazeControls = document.querySelectorAll('select[data-classic-background]');
    const mazeStatuses = document.querySelectorAll('[data-maze-status]');
    const backgroundControls = document.querySelectorAll('select[data-classic3-background]');
    const backgroundStatuses = document.querySelectorAll('[data-pipes-status]');
    const aquarium = document.getElementById('aquariumBackground');
    const reef = aquarium?.querySelector('.luna-reef');
    const colorControl = document.getElementById('backgroundColorControl');
    const mazeStage = document.getElementById('mazeBackground');
    const mazeCanvas = document.getElementById('mazeCanvas');
    const pipesStage = document.getElementById('pipesBackground');
    const pipesCanvas = document.getElementById('pipesCanvas');
    let pageSuspended = false;
    let disposed = false;
    let mazeRenderer = null;
    let mazeFailed = false;
    let mazeObserver = null;
    let pipesRenderer = null;
    let pipesFailed = false;
    let pipesObserver = null;

    function onMazeFailure() {
      mazeFailed = true;
      // Defer fallback until the factory or active draw has returned. Keep the
      // saved choice so a later page load can retry a temporary canvas failure.
      Promise.resolve().then(refresh);
    }

    function resizeMaze() {
      if (!disposed && mazeStage && !mazeStage.hidden) mazeRenderer?.resize();
    }

    function onPipesFailure() {
      pipesFailed = true;
      // A renderer can fail during its first draw. Defer the UI update until
      // its factory returns, preventing reentrant construction or disposal.
      Promise.resolve().then(refresh);
    }

    function resizePipes() {
      if (!disposed && pipesStage && !pipesStage.hidden) pipesRenderer?.resize();
    }

    // Create optional renderers only when requested. A failed renderer changes
    // the displayed fallback without overwriting the saved background choice.
    function refresh() {
      if (disposed) return;
      const playing = motionEnabled();
      const wantsMaze = theme === 'classic' && classicBackground === 'maze' && !mazeFailed;
      if (mazeStage) mazeStage.hidden = !wantsMaze;
      if (wantsMaze && !mazeRenderer) {
        try { mazeRenderer = window.SavepointMaze?.create(mazeCanvas, onMazeFailure) ?? null; } catch { mazeFailed = true; }
        if (!mazeRenderer) mazeFailed = true;
      }
      if (mazeFailed && mazeRenderer) {
        mazeRenderer.destroy();
        mazeRenderer = null;
      }
      const activeMaze = wantsMaze && !mazeFailed;
      const mazeBackground = mazeFailed ? 'classic' : classicBackground;
      const wantsPipes = theme === 'classic3' && classic3Background === 'pipes' && !pipesFailed;
      if (pipesStage) pipesStage.hidden = !wantsPipes;
      if (wantsPipes && !pipesRenderer) {
        try { pipesRenderer = window.SavepointPipes?.create(pipesCanvas, onPipesFailure) ?? null; } catch { pipesFailed = true; }
        if (!pipesRenderer) pipesFailed = true;
      }
      if (pipesFailed && pipesRenderer) {
        pipesRenderer.destroy();
        pipesRenderer = null;
      }
      const activePipes = wantsPipes && !pipesFailed;
      const background = pipesFailed ? 'classic' : classic3Background;
      root.dataset.theme = theme;
      root.dataset.backgroundMotion = playing ? 'on' : 'off';
      root.dataset.classicBackground = mazeBackground;
      root.dataset.classic3Background = background;
      for (const control of themeControls) control.value = theme;
      // Decorative Mac captions never participate in the existing theme layouts.
      for (const caption of macCaptions) caption.hidden = !macThemes.includes(theme);
      // Each caption belongs exclusively to its own group of optional skins.
      for (const caption of additionalCaptions) caption.hidden = !additionalThemes.includes(theme);
      // Console decoration and shortcuts stay out of all existing themes.
      const isConsoleTheme = consoleThemeKeys.includes(theme);
      for (const element of consoleElements) element.hidden = !isConsoleTheme;
      for (const name of consoleNames) name.textContent = consoleThemes[theme] || '';
      for (const control of mazeControls) {
        control.value = mazeBackground;
        control.querySelector('option[value="maze"]').disabled = mazeFailed;
        const label = control.closest('.classic-background-control');
        if (label) label.hidden = theme !== 'classic';
      }
      for (const status of mazeStatuses) status.hidden = !(theme === 'classic' && classicBackground === 'maze' && mazeFailed);
      for (const control of backgroundControls) {
        control.value = background;
        control.querySelector('option[value="pipes"]').disabled = pipesFailed;
        const label = control.closest('.classic3-background-control');
        if (label) label.hidden = theme !== 'classic3';
      }
      for (const status of backgroundStatuses) status.hidden = !(theme === 'classic3' && classic3Background === 'pipes' && pipesFailed);
      for (const control of motionControls) {
        control.checked = playing;
        const label = control.closest('.background-motion-control');
        if (label) label.hidden = theme !== 'aero' && theme !== 'luna' && !activePipes && !activeMaze;
      }
      if (colorControl) colorControl.hidden = theme !== 'aero';
      if (aquarium) {
        aquarium.hidden = theme !== 'luna';
        aquarium.dataset.playing = String(theme === 'luna' && playing
          && document.hidden !== true && !pageSuspended);
        // Aero never downloads the optional aquarium artwork. The blue water
        // remains visible while the image loads or when it is unavailable.
        if (theme === 'luna' && reef && !reef.hasAttribute('src')) reef.src = reef.dataset.src;
      }
      if (mazeStage) mazeStage.hidden = !activeMaze;
      resizeMaze();
      mazeRenderer?.setPlaying(activeMaze && playing && document.hidden !== true && !pageSuspended);
      if (pipesStage) pipesStage.hidden = !activePipes;
      resizePipes();
      pipesRenderer?.setPlaying(activePipes && playing && document.hidden !== true && !pageSuspended);
      document.dispatchEvent(new Event('savepoint:themechange'));
    }

    for (const control of themeControls) {
      control.addEventListener('change', () => {
        theme = normalizeTheme(control.value);
        savePreference(THEME_KEY, theme);
        refresh();
      });
    }
    // These console-style controls reuse the collection's existing actions.
    // They neither submit data nor change authentication or saved game records.
    for (const control of document.querySelectorAll('[data-console-action]')) {
      control.addEventListener('click', () => {
        if (!consoleThemeKeys.includes(theme)) return;
        if (control.dataset.consoleAction === 'library') {
          document.getElementById('grid')?.scrollIntoView({ block: 'nearest' });
        } else if (control.dataset.consoleAction === 'search') {
          const search = document.getElementById('search');
          search?.scrollIntoView({ block: 'center' });
          search?.focus({ preventScroll: true });
        } else if (control.dataset.consoleAction === 'add') {
          document.getElementById('addBtn')?.click();
        }
      });
    }
    for (const control of motionControls) {
      control.addEventListener('change', () => {
        motionPreference = control.checked ? 'on' : 'off';
        savePreference(MOTION_KEY, motionPreference);
        refresh();
      });
    }
    for (const control of mazeControls) {
      control.addEventListener('change', () => {
        classicBackground = control.value === 'maze' ? 'maze' : 'classic';
        savePreference(CLASSIC_BACKGROUND_KEY, classicBackground);
        refresh();
      });
    }
    for (const control of backgroundControls) {
      control.addEventListener('change', () => {
        classic3Background = control.value === 'pipes' ? 'pipes' : 'classic';
        savePreference(CLASSIC3_BACKGROUND_KEY, classic3Background);
        refresh();
      });
    }
    document.addEventListener('visibilitychange', refresh);
    // BFCache keeps paused renderers for pageshow; a final departure releases
    // their observers, animation frames and bitmap memory instead.
    addEventListener('pagehide', event => {
      pageSuspended = true;
      refresh();
      if (!event.persisted) {
        disposed = true;
        mazeObserver?.disconnect();
        mazeRenderer?.destroy();
        mazeRenderer = null;
        pipesObserver?.disconnect();
        pipesRenderer?.destroy();
        pipesRenderer = null;
      }
    });
    addEventListener('pageshow', () => { pageSuspended = false; refresh(); });
    if (typeof reducedMotion?.addEventListener === 'function') reducedMotion.addEventListener('change', refresh);
    else reducedMotion?.addListener?.(refresh);
    if (mazeStage && typeof ResizeObserver === 'function') {
      mazeObserver = new ResizeObserver(resizeMaze);
      mazeObserver.observe(mazeStage);
    }
    if (pipesStage && typeof ResizeObserver === 'function') {
      pipesObserver = new ResizeObserver(resizePipes);
      pipesObserver.observe(pipesStage);
    }
    addEventListener('resize', resizeMaze);
    addEventListener('resize', resizePipes);
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeAppearance, { once: true });
  else initializeAppearance();
})();
