// Restore appearance before the page paints. These preferences belong to the
// browser, independently of sign-in, language and the saved game collection.
(() => {
  'use strict';
  const THEME_KEY = 'savepoint-theme-v1';
  const MOTION_KEY = 'savepoint-background-motion-v1';
  const CLASSIC_BACKGROUND_KEY = 'savepoint-classic-background-v1';
  const CLASSIC3_BACKGROUND_KEY = 'savepoint-classic3-background-v1';
  const DOS_BACKGROUND_KEY = 'savepoint-dos-background-v1';
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
  let dosBackground = readPreference(DOS_BACKGROUND_KEY) === 'matrix' ? 'matrix' : 'classic';
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
  root.dataset.dosBackground = dosBackground;

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
    const dosControls = document.querySelectorAll('select[data-dos-background]');
    const matrixStatuses = document.querySelectorAll('[data-matrix-status]');
    const aquarium = document.getElementById('aquariumBackground');
    const reef = aquarium?.querySelector('.luna-reef');
    const colorControl = document.getElementById('backgroundColorControl');
    const mazeStage = document.getElementById('mazeBackground');
    const mazeCanvas = document.getElementById('mazeCanvas');
    const pipesStage = document.getElementById('pipesBackground');
    const pipesCanvas = document.getElementById('pipesCanvas');
    const p2Stage = document.getElementById('p2ClockBackground');
    const p2Canvas = document.getElementById('p2ClockCanvas');
    const matrixStage = document.getElementById('matrixBackground');
    const matrixCanvas = document.getElementById('matrixCanvas');
    let pageSuspended = false;
    let disposed = false;
    let mazeRenderer = null;
    let mazeFailed = false;
    let mazeObserver = null;
    let pipesRenderer = null;
    let pipesFailed = false;
    let pipesObserver = null;
    let p2Renderer = null;
    let p2Failed = false;
    let p2Observer = null;
    let matrixRenderer = null;
    let matrixFailed = false;
    let matrixObserver = null;

    function onMatrixFailure() {
      matrixFailed = true;
      // Display the unchanged Classic desktop without losing the saved choice.
      Promise.resolve().then(refresh);
    }

    function resizeMatrix() {
      if (!disposed && matrixStage && !matrixStage.hidden) matrixRenderer?.resize();
    }

    function onP2Failure() {
      p2Failed = true;
      // Keep the plain violet desktop if canvas rendering is unavailable.
      Promise.resolve().then(refresh);
    }

    function resizeP2() {
      if (!disposed && p2Stage && !p2Stage.hidden) p2Renderer?.resize();
    }

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
      const wantsMatrix = theme === 'dos' && dosBackground === 'matrix' && !matrixFailed;
      if (matrixStage) matrixStage.hidden = !wantsMatrix;
      if (wantsMatrix && !matrixRenderer) {
        try {
          matrixRenderer = window.SavepointMatrix?.create(matrixCanvas, onMatrixFailure) ?? null;
        } catch {
          matrixFailed = true;
        }
        if (!matrixRenderer) matrixFailed = true;
      }
      if (matrixFailed && matrixRenderer) {
        matrixRenderer.destroy();
        matrixRenderer = null;
      }
      const activeMatrix = wantsMatrix && !matrixFailed;
      const displayedDosBackground = matrixFailed ? 'classic' : dosBackground;
      const wantsP2 = theme === 'p2' && !p2Failed;
      if (p2Stage) p2Stage.hidden = !wantsP2;
      if (wantsP2 && !p2Renderer) {
        try {
          p2Renderer = window.SavepointP2Clock?.create(p2Canvas, onP2Failure) ?? null;
        } catch {
          p2Failed = true;
        }
        if (!p2Renderer) p2Failed = true;
      }
      if (p2Failed && p2Renderer) {
        p2Renderer.destroy();
        p2Renderer = null;
      }
      const activeP2 = wantsP2 && !p2Failed;
      const wantsMaze = theme === 'classic' && classicBackground === 'maze' && !mazeFailed;
      if (mazeStage) mazeStage.hidden = !wantsMaze;
      if (wantsMaze && !mazeRenderer) {
        try {
          mazeRenderer = window.SavepointMaze?.create(mazeCanvas, onMazeFailure) ?? null;
        } catch {
          mazeFailed = true;
        }
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
        try {
          pipesRenderer = window.SavepointPipes?.create(pipesCanvas, onPipesFailure) ?? null;
        } catch {
          pipesFailed = true;
        }
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
      root.dataset.dosBackground = displayedDosBackground;
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
      for (const control of dosControls) {
        control.value = displayedDosBackground;
        control.querySelector('option[value="matrix"]').disabled = matrixFailed;
        const label = control.closest('.dos-background-control');
        if (label) label.hidden = theme !== 'dos';
      }
      for (const status of matrixStatuses) status.hidden = !(theme === 'dos' && dosBackground === 'matrix' && matrixFailed);
      for (const control of motionControls) {
        control.checked = playing;
        const label = control.closest('.background-motion-control');
        if (label) label.hidden = theme !== 'aero' && theme !== 'luna'
          && !activePipes && !activeMaze && !activeP2 && !activeMatrix;
      }
      // This controller owns only Aero's original picker. The shared static
      // desktop color/reset controls are owned by static-background-colors.js.
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
      if (p2Stage) p2Stage.hidden = !activeP2;
      // Pausing smooth motion keeps the functional clock current at one hertz.
      // Hidden pages and other themes stop its work entirely.
      resizeP2();
      p2Renderer?.setState({
        active: activeP2 && document.hidden !== true && !pageSuspended,
        playing
      });
      if (matrixStage) matrixStage.hidden = !activeMatrix;
      resizeMatrix();
      matrixRenderer?.setPlaying(activeMatrix && playing && document.hidden !== true && !pageSuspended);
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
    for (const control of dosControls) {
      control.addEventListener('change', () => {
        dosBackground = control.value === 'matrix' ? 'matrix' : 'classic';
        savePreference(DOS_BACKGROUND_KEY, dosBackground);
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
        p2Observer?.disconnect();
        p2Renderer?.destroy();
        p2Renderer = null;
        matrixObserver?.disconnect();
        matrixRenderer?.destroy();
        matrixRenderer = null;
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
    if (p2Stage && typeof ResizeObserver === 'function') {
      p2Observer = new ResizeObserver(resizeP2);
      p2Observer.observe(p2Stage);
    }
    addEventListener('resize', resizeP2);
    if (matrixStage && typeof ResizeObserver === 'function') {
      matrixObserver = new ResizeObserver(resizeMatrix);
      matrixObserver.observe(matrixStage);
    }
    addEventListener('resize', resizeMatrix);
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeAppearance, { once: true });
  else initializeAppearance();
})();
