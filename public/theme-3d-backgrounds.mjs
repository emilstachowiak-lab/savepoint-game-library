// 3D owns a single background layer. The original themes retain their own
// stages, preferences and renderer instances.
const canvasScenes = {
  maze: ['maze', 'SavepointMaze'],
  pipes: ['pipes', 'SavepointPipes'],
  clock: ['p2', 'SavepointP2Clock'],
  matrix: ['matrix', 'SavepointMatrix'],
  'light-cycle': ['lightCycle', 'SavepointLightCycle']
};

export function createThreeDBackground({ stage, aquarium, scripts, getAeroColor, onFailure }) {
  const document = stage.ownerDocument;
  const browser = document.defaultView;
  const pendingScripts = new Map();
  const unusableScripts = new WeakSet();
  let state = { selection: 'original', visible: false, playing: false };
  let scene = null;
  let failed = false;
  let destroyed = false;

  function loadFactory(selection) {
    const [scriptKey, factoryName] = canvasScenes[selection];
    const available = () => {
      const factory = browser[factoryName];
      return typeof factory?.create === 'function' ? factory : null;
    };
    const factory = available();
    if (factory) return Promise.resolve(factory);
    if (pendingScripts.has(selection)) return pendingScripts.get(selection).promise;
    const scriptUrl = scripts?.[scriptKey];
    if (!scriptUrl) return Promise.resolve(null);

    let href;
    try { href = new URL(scriptUrl, document.baseURI).href; } catch { return Promise.resolve(null); }
    const existing = [...document.scripts].find(script => script.src === href && !unusableScripts.has(script));
    const script = existing || document.createElement('script');
    let resolve;
    let settled = false;
    const promise = new Promise(done => { resolve = done; });
    const onLoad = () => finish(available());
    const onError = () => finish(available());
    const timeout = browser.setTimeout(onError, 12000);

    function finish(result, cancelled = false) {
      if (settled) return;
      settled = true;
      browser.clearTimeout(timeout);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      pendingScripts.delete(selection);
      if (!result) {
        if (!existing) script.remove();
        else if (!cancelled) unusableScripts.add(script);
      }
      resolve(result);
    }

    pendingScripts.set(selection, { promise, cancel: () => finish(null, true) });
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
    if (!existing) {
      script.src = href;
      try { document.head.append(script); } catch { onError(); }
    }
    return promise;
  }

  function releaseScene() {
    const previous = scene;
    scene = null;
    stage.hidden = true;
    delete stage.dataset.scene;
    stage.dataset.playing = 'false';
    previous?.observer?.disconnect();
    if (previous?.watchingResize) browser.removeEventListener('resize', resize);
    try { previous?.renderer?.destroy(); } catch {}
    stage.replaceChildren();
  }

  function reportFailure(current) {
    if (destroyed || scene !== current) return;
    failed = true;
    releaseScene();
    onFailure?.(current.selection);
  }

  function resize() {
    const current = scene;
    if (!current?.renderer || !state.visible) return;
    try { current.renderer.resize(); } catch { reportFailure(current); }
  }

  function applyMotion(current) {
    if (stage.hidden) return;
    const playing = state.visible && state.playing;
    stage.dataset.playing = String(playing);
    if (!current.renderer) return;
    try {
      if (current.selection === 'clock') current.renderer.setState({ active: state.visible, playing });
      else current.renderer.setPlaying(playing);
    } catch { reportFailure(current); }
  }

  function show(current, ...children) {
    stage.replaceChildren(...children);
    stage.dataset.scene = current.selection;
    stage.hidden = false;
  }

  function mountRenderer(current, child, create, ownsObserver = false) {
    if (scene !== current) return;
    show(current, child);
    let renderer;
    try {
      renderer = create(() => reportFailure(current));
    } catch {
      reportFailure(current);
      return;
    }
    // A factory can report synchronous failure before it returns.
    if (scene !== current) {
      try { renderer?.destroy(); } catch {}
      return;
    }
    if (!renderer) { reportFailure(current); return; }
    current.renderer = renderer;
    if (!ownsObserver && typeof browser.ResizeObserver === 'function') {
      current.observer = new browser.ResizeObserver(resize);
      current.observer.observe(stage);
    }
    current.watchingResize = !ownsObserver || typeof browser.ResizeObserver !== 'function';
    if (current.watchingResize) browser.addEventListener('resize', resize);
    resize();
    if (scene === current) applyMotion(current);
  }

  function mountAquarium(current) {
    const children = [...(aquarium?.children ?? [])].map(child => child.cloneNode(true));
    if (!children.length) { reportFailure(current); return; }
    for (const child of children) {
      child.removeAttribute('id');
      for (const nested of child.querySelectorAll('[id]')) nested.removeAttribute('id');
      if (child.classList.contains('luna-reef') && child.dataset.src) child.src = child.dataset.src;
    }
    show(current, ...children);
    applyMotion(current);
  }

  function refresh() {
    if (destroyed || failed || state.selection === 'original') return;
    if (scene) {
      applyMotion(scene);
      return;
    }
    if (!state.visible) return;
    const current = { selection: state.selection };
    scene = current;
    if (current.selection === 'aquarium') {
      mountAquarium(current);
    } else if (current.selection === 'aero') {
      const layer = document.createElement('div');
      layer.className = 'three-d-aero';
      mountRenderer(current, layer, fail => browser.createEconomyXmb(layer, getAeroColor, fail), true);
    } else {
      loadFactory(current.selection).then(factory => {
        if (scene !== current) return;
        if (!factory) { reportFailure(current); return; }
        const canvas = document.createElement('canvas');
        canvas.className = 'three-d-background-canvas';
        canvas.width = canvas.height = 1;
        mountRenderer(current, canvas, fail => factory.create(canvas, fail));
      }).catch(() => reportFailure(current));
    }
  }

  return {
    setState({ selection, visible, playing }) {
      if (destroyed) return;
      const next = selection === 'aero' || selection === 'aquarium' || Object.hasOwn(canvasScenes, selection)
        ? selection : 'original';
      const previous = state;
      state = { selection: next, visible: visible === true, playing: playing === true };
      if (previous.selection !== next) {
        releaseScene();
        failed = false;
      }
      if (!previous.visible && state.visible && scene?.renderer) resize();
      refresh();
    },
    retry() {
      failed = false;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      releaseScene();
      for (const pending of pendingScripts.values()) pending.cancel();
    }
  };
}
