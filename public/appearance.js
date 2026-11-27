// Restore appearance before the page paints. These preferences belong to the
// browser, independently of sign-in, language and the saved game collection.
(() => {
  'use strict';
  const THEME_KEY = 'savepoint-theme-v1';
  const MOTION_KEY = 'savepoint-background-motion-v1';
  const CLASSIC_BACKGROUND_KEY = 'savepoint-classic-background-v1';
  const CLASSIC3_BACKGROUND_KEY = 'savepoint-classic3-background-v1';
  const DOS_BACKGROUND_KEY = 'savepoint-dos-background-v1';
  const RENDERER_IDLE_TIMEOUT_MS = 30000;
  const root = document.documentElement;
  const macThemes = ['platinum', 'aqua', 'mountain'];
  const additionalThemes = ['liquidglass', 'oldlinux', 'ulinux', 'flinux', 'bee', 'dos', 'longhorn'];
  const consoleThemes = {
    p1: 'P1', p2: 'P2', dream: 'Dream', gc: 'GC',
    play: 'Like to Play', x: 'X', x360: 'X360'
  };
  const consoleThemeKeys = Object.keys(consoleThemes);
  const themes = ['aero', 'luna', 'classic', 'classic2', 'classic3', ...macThemes, ...additionalThemes, ...consoleThemeKeys, '3d'];
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
  function setThemeAttributes() {
    root.dataset.theme = theme;
    // The two families share component styles. Their palettes still match
    // individual theme keys and override the common styles in document order.
    if (additionalThemes.includes(theme)) root.dataset.themeFamily = 'additional';
    else if (consoleThemeKeys.includes(theme)) root.dataset.themeFamily = 'console';
    else root.removeAttribute('data-theme-family');
  }

  setThemeAttributes();
  root.dataset.backgroundMotion = motionEnabled() ? 'on' : 'off';
  root.dataset.classicBackground = classicBackground;
  root.dataset.classic3Background = classic3Background;
  root.dataset.dosBackground = dosBackground;
  // The script element supplies the versioned URLs for optional backgrounds.
  const backgroundScripts = document.currentScript?.dataset ?? {};
  const themeStyles = Array.from(document.querySelectorAll('link[data-theme-style]'));

  function loadThemeStyles(initial = false) {
    // Leave the links in document order so theme overrides use the same cascade.
    for (const link of themeStyles) {
      if (!link.hasAttribute('href') && link.dataset.themes.split(' ').includes(theme)) {
        if (initial) link.setAttribute('blocking', 'render');
        link.addEventListener('error', () => {
          link.removeAttribute('href');
          link.removeAttribute('blocking');
        }, { once: true });
        link.href = link.dataset.themeStyle;
      }
    }
  }

  loadThemeStyles(true);

  function initializeAppearance() {
    const themeControls = document.querySelectorAll('[data-ui-theme]');
    const macCaptions = document.querySelectorAll('.mac-window-caption');
    const additionalCaptions = document.querySelectorAll('.skin-window-caption');
    const consoleElements = document.querySelectorAll('.console-atmosphere, .console-window-caption, .console-navigation');
    const consoleNames = document.querySelectorAll('[data-console-theme-name]');
    const motionControls = document.querySelectorAll('input[data-background-motion]');
    const mazeControls = document.querySelectorAll('select[data-classic-background]');
    const mazeStatuses = document.querySelectorAll('[data-maze-status]');
    const pipesControls = document.querySelectorAll('select[data-classic3-background]');
    const pipesStatuses = document.querySelectorAll('[data-pipes-status]');
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

    const maze = createCanvasBackground(mazeStage, mazeCanvas, 'SavepointMaze', backgroundScripts.maze);
    const pipes = createCanvasBackground(pipesStage, pipesCanvas, 'SavepointPipes', backgroundScripts.pipes);
    const p2Clock = createCanvasBackground(
      p2Stage, p2Canvas, 'SavepointP2Clock', backgroundScripts.p2,
      (renderer, active, playing) => {
        // Pausing smooth motion keeps the clock current at one hertz.
        // Hidden pages and other themes stop its work entirely.
        renderer.setState({ active: active && document.hidden !== true && !pageSuspended, playing });
      }
    );
    const matrix = createCanvasBackground(matrixStage, matrixCanvas, 'SavepointMatrix', backgroundScripts.matrix);
    const backgrounds = [maze, pipes, p2Clock, matrix];

    function updateAnimation(renderer, active, playing) {
      renderer.setPlaying(active && playing && document.hidden !== true && !pageSuspended);
    }

    function createCanvasBackground(stage, canvas, factoryName, scriptUrl, updateRenderer = updateAnimation) {
      let renderer = null;
      let failed = false;
      let observer = null;
      let script = null;
      let downloadFailed = false;
      let idleTimer = null;

      function onFailure() {
        failed = true;
        // A factory or draw can report failure synchronously. Let it return
        // before refreshing the fallback, and keep the saved background choice.
        Promise.resolve().then(refresh);
      }

      function destroyRenderer() {
        clearTimeout(idleTimer);
        idleTimer = null;
        renderer?.destroy();
        renderer = null;
      }

      // While the script loads, keep the chosen background and hide its canvas.
      // Only an actual failure marks the option unavailable and shows a fallback.
      function prepare(requested) {
        if (requested && !failed && !downloadFailed && !window[factoryName] && scriptUrl) {
          if (!script) {
            script = document.createElement('script');
            script.src = scriptUrl;
            script.addEventListener('load', () => {
              if (window[factoryName]) refresh();
              else onFailure();
            }, { once: true });
            script.addEventListener('error', () => {
              script?.remove();
              script = null;
              downloadFailed = true;
              refresh();
            }, { once: true });
            document.head.append(script);
          }
          return false;
        }
        const available = requested && !failed && !downloadFailed;
        if (stage) stage.hidden = !available;
        if (available && !renderer) {
          try {
            renderer = window[factoryName]?.create(canvas, onFailure) ?? null;
          } catch {
            failed = true;
          }
          if (!renderer) failed = true;
        }
        if (failed && renderer) destroyRenderer();
        return available && !failed;
      }

      function resize() {
        if (!disposed && stage && !stage.hidden) renderer?.resize();
      }

      function update(active, playing) {
        if (stage) stage.hidden = !active;
        resize();
        if (renderer === null) return;
        updateRenderer(renderer, active, playing);
        if (active && idleTimer !== null) {
          clearTimeout(idleTimer);
          idleTimer = null;
        } else if (!active && idleTimer === null) {
          // A quick switch can reuse the scene. Release large inactive bitmaps
          // after a short grace period, regardless of the motion setting.
          idleTimer = setTimeout(destroyRenderer, RENDERER_IDLE_TIMEOUT_MS);
        }
      }

      function observe() {
        if (stage && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(resize);
          observer.observe(stage);
        }
      }

      function dispose() {
        observer?.disconnect();
        destroyRenderer();
      }

      return { prepare, resize, update, observe, dispose,
        retryDownload() { downloadFailed = false; },
        get failed() { return failed || downloadFailed; },
        get rendererFailed() { return failed; },
      };
    }

    function updateThemeControls(playing, displayedClassic, displayedClassic3, displayedDos) {
      setThemeAttributes();
      root.dataset.backgroundMotion = playing ? 'on' : 'off';
      root.dataset.classicBackground = displayedClassic;
      root.dataset.classic3Background = displayedClassic3;
      root.dataset.dosBackground = displayedDos;
      for (const control of themeControls) control.value = theme;
      // Decorative Mac captions never participate in the existing theme layouts.
      for (const caption of macCaptions) caption.hidden = !macThemes.includes(theme);
      // Each caption belongs exclusively to its own group of optional skins.
      for (const caption of additionalCaptions) caption.hidden = !additionalThemes.includes(theme);
      // Console decoration and shortcuts stay out of all existing themes.
      const isConsoleTheme = consoleThemeKeys.includes(theme);
      for (const element of consoleElements) element.hidden = !isConsoleTheme;
      for (const name of consoleNames) name.textContent = consoleThemes[theme] || '';
    }

    function updateBackgroundPicker({ controls, statuses, themeKey, option, saved, displayed, background }) {
      const active = theme === themeKey;
      for (const control of controls) {
        control.value = displayed;
        control.querySelector(`option[value="${option}"]`).disabled = background.rendererFailed;
        const label = control.closest(`.${themeKey}-background-control`);
        if (label) label.hidden = !active;
      }
      for (const status of statuses) status.hidden = !(active && saved === option && background.failed);
    }

    function updateMotionControls(playing, hasAnimatedDesktop) {
      for (const control of motionControls) {
        control.checked = playing;
        const label = control.closest('.background-motion-control');
        if (label) label.hidden = theme !== 'aero' && theme !== 'luna' && !hasAnimatedDesktop;
      }
    }

    function updateAquarium(playing) {
      if (!aquarium) return;
      aquarium.hidden = theme !== 'luna';
      aquarium.dataset.playing = String(theme === 'luna' && playing
        && document.hidden !== true && !pageSuspended);
      // Aero never downloads the optional aquarium artwork. The blue water
      // remains visible while the image loads or when it is unavailable.
      if (theme === 'luna' && reef && !reef.hasAttribute('src')) reef.src = reef.dataset.src;
    }

    function refresh() {
      if (disposed) return;
      loadThemeStyles();
      const playing = motionEnabled();

      // Prepare the canvases before publishing a background or its fallback.
      const activeMatrix = matrix.prepare(theme === 'dos' && dosBackground === 'matrix');
      const displayedDos = matrix.failed ? 'classic' : dosBackground;
      const activeP2 = p2Clock.prepare(theme === 'p2');
      const activeMaze = maze.prepare(theme === 'classic' && classicBackground === 'maze');
      const displayedClassic = maze.failed ? 'classic' : classicBackground;
      const activePipes = pipes.prepare(theme === 'classic3' && classic3Background === 'pipes');
      const displayedClassic3 = pipes.failed ? 'classic' : classic3Background;

      updateThemeControls(playing, displayedClassic, displayedClassic3, displayedDos);
      updateBackgroundPicker({ controls: mazeControls, statuses: mazeStatuses, themeKey: 'classic',
        option: 'maze', saved: classicBackground, displayed: displayedClassic, background: maze });
      updateBackgroundPicker({ controls: pipesControls, statuses: pipesStatuses, themeKey: 'classic3',
        option: 'pipes', saved: classic3Background, displayed: displayedClassic3, background: pipes });
      updateBackgroundPicker({ controls: dosControls, statuses: matrixStatuses, themeKey: 'dos',
        option: 'matrix', saved: dosBackground, displayed: displayedDos, background: matrix });
      updateMotionControls(playing, activePipes || activeMaze || activeP2 || activeMatrix);
      // This controller owns only Aero's original picker. The shared static
      // desktop color/reset controls are owned by static-background-colors.js.
      if (colorControl) colorControl.hidden = theme !== 'aero';
      updateAquarium(playing);

      maze.update(activeMaze, playing);
      pipes.update(activePipes, playing);
      p2Clock.update(activeP2, playing);
      matrix.update(activeMatrix, playing);
      document.dispatchEvent(new Event('savepoint:themechange'));
    }

    for (const control of themeControls) {
      control.addEventListener('change', () => {
        theme = normalizeTheme(control.value);
        savePreference(THEME_KEY, theme);
        for (const background of backgrounds) background.retryDownload();
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
        maze.retryDownload();
        refresh();
      });
    }
    for (const control of pipesControls) {
      control.addEventListener('change', () => {
        classic3Background = control.value === 'pipes' ? 'pipes' : 'classic';
        savePreference(CLASSIC3_BACKGROUND_KEY, classic3Background);
        pipes.retryDownload();
        refresh();
      });
    }
    for (const control of dosControls) {
      control.addEventListener('change', () => {
        dosBackground = control.value === 'matrix' ? 'matrix' : 'classic';
        savePreference(DOS_BACKGROUND_KEY, dosBackground);
        matrix.retryDownload();
        refresh();
      });
    }
    document.addEventListener('visibilitychange', refresh);
    addEventListener('online', () => {
      for (const background of backgrounds) background.retryDownload();
      refresh();
    });
    // BFCache keeps paused renderers for pageshow; a final departure releases
    // their observers, animation frames and bitmap memory instead.
    addEventListener('pagehide', event => {
      pageSuspended = true;
      refresh();
      if (!event.persisted) {
        disposed = true;
        for (const background of backgrounds) background.dispose();
      }
    });
    addEventListener('pageshow', () => { pageSuspended = false; refresh(); });
    if (typeof reducedMotion?.addEventListener === 'function') reducedMotion.addEventListener('change', refresh);
    else reducedMotion?.addListener?.(refresh);
    maze.observe();
    pipes.observe();
    addEventListener('resize', maze.resize);
    addEventListener('resize', pipes.resize);
    p2Clock.observe();
    addEventListener('resize', p2Clock.resize);
    matrix.observe();
    addEventListener('resize', matrix.resize);
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeAppearance, { once: true });
  else initializeAppearance();
})();
