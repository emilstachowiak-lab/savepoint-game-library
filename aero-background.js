// Render the original Aero desktop and manage its browser preferences.
const AERO_BACKGROUND_COLOR_KEY = 'savepoint-background-color-v1';

// The XMB background rasterizes two decorative ribbons at a fixed size per color.
// The browser animates their transforms without repainting the canvas each frame.
function createEconomyXmb(stage, getColor, onError) {
  'use strict';
  const bitmapWidth = 768;
  const bitmapHeight = 432;
  const overscan = 1.42;
  const sheets = [
    {
      d: 'M-140 245C250 235 425 590 810 595S1390 240 1740 235L1740 400C1360 420 1190 785 820 825S245 420-140 430Z',
      crest: 'M-140 320C260 345 430 675 815 705S1375 330 1740 325',
      edge: 'M-140 245C250 235 425 590 810 595S1390 240 1740 235',
      alpha: .38,
      width: 90
    },
    {
      d: 'M-140 405C255 395 435 690 850 665S1410 370 1740 330L1740 405C1400 455 1205 795 855 740S245 495-140 485Z',
      crest: 'M-140 440C250 435 440 750 852 705S1400 410 1740 365',
      edge: 'M-140 405C255 395 435 690 850 665S1410 370 1740 330',
      alpha: .32,
      width: 55
    }
  ];
  const periods = [4800, 6000];
  const movement = [
    [[-.040, -.055, -.3], [.020, .035, .15], [.040, .055, .3], [-.020, -.035, -.15]],
    [[.040, .070, .45], [-.025, -.030, -.2], [-.040, -.070, -.45], [.025, .030, .2]]
  ];
  let disposed = false;
  let playing = false;
  let loadedColor = '';
  let pendingColor = '';
  let generation = 0;
  let size = { width: 0, height: 0 };
  const layers = [];
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  function selectedColor() {
    const color = typeof getColor === 'function' ? getColor() : '';
    return /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#0874bc';
  }
  function palette(hex) {
    const rgb = parseInt(hex.slice(1), 16);
    const red = (rgb >> 16 & 255) / 255;
    const green = (rgb >> 8 & 255) / 255;
    const blue = (rgb & 255) / 255;
    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    const delta = high - low;
    const light = (high + low) / 2;
    let hue = 205;
    if (delta) {
      const sector = high === red ? (green - blue) / delta % 6
        : high === green ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
      hue = (sector * 60 + 360) % 360;
    }
    const saturation = delta ? delta / (1 - Math.abs(2 * light - 1)) : 0;
    // Normalize against the original Aero blue so a custom hue tints the
    // existing artwork while the default palette keeps its original balance.
    const strength = clamp(saturation / .918, 0, 1.1);
    const luminance = clamp(light / .3843, 0, 1.5);
    return (shift, sat, lightness, alpha = 1) => {
      const shiftedHue = (hue + shift + 360) % 360;
      const adjustedSaturation = clamp(sat * strength, 0, 100);
      const adjustedLightness = clamp(lightness * luminance, 0, 100);
      return `hsla(${shiftedHue},${adjustedSaturation}%,${adjustedLightness}%,${alpha})`;
    };
  }
  function gradient(color) {
    const shade = palette(color);
    return `linear-gradient(180deg,${shade(-7, 95, 64)},${shade(3, 51, 46)} 47%,${shade(28, 59, 24)})`;
  }
  function svgFor(sheet, color, index) {
    const shade = palette(color);
    const prefix = 'xmb' + index;
    const ink = shade(24, 73, 13, .65);
    const glow = shade(-4, 85, 80, .72);
    const soft = shade(-1, 77, 72, .5);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="432"' +
      ' viewBox="0 0 1600 900" preserveAspectRatio="none"><defs>' +
      `<linearGradient id="${prefix}fill" x1="0" y1="0" x2="0.1" y2="1">` +
        `<stop stop-color="${shade(-3, 90, 80, .15)}"/>` +
        `<stop offset=".28" stop-color="${shade(0, 80, 62, sheet.alpha)}"/>` +
        `<stop offset=".56" stop-color="${shade(4, 70, 38, .22)}"/>` +
        `<stop offset=".77" stop-color="${shade(0, 78, 68, .26)}"/>` +
        `<stop offset="1" stop-color="${shade(10, 70, 45, .08)}"/>` +
      '</linearGradient>' +
      `<linearGradient id="${prefix}edge">` +
        `<stop stop-color="${shade(-4, 92, 83, .52)}"/>` +
        `<stop offset=".46" stop-color="${shade(-1, 80, 77, .15)}"/>` +
        `<stop offset="1" stop-color="${shade(-6, 92, 86, .60)}"/>` +
      '</linearGradient>' +
      `<filter id="${prefix}soft" x="-.15" y="-.25" width="1.3" height="1.5">` +
        '<feGaussianBlur stdDeviation="15"/></filter>' +
      `<filter id="${prefix}shadow" x="-.15" y="-.25" width="1.3" height="1.5">` +
        '<feGaussianBlur stdDeviation="20"/></filter>' +
      `<clipPath id="${prefix}clip"><path d="${sheet.d}"/></clipPath></defs>` +
      `<path d="${sheet.d}" fill="url(#${prefix}fill)"/>` +
      `<g clip-path="url(#${prefix}clip)">` +
        `<path d="${sheet.crest}" transform="translate(0 65)" fill="none" stroke="${ink}"` +
          ` stroke-width="${sheet.width * .8}" filter="url(#${prefix}shadow)"/>` +
        `<path d="${sheet.crest}" fill="none" stroke="${soft}"` +
          ` stroke-width="${sheet.width}" filter="url(#${prefix}soft)"/>` +
        `<path d="${sheet.crest}" transform="translate(0 -22)" fill="none" stroke="${glow}"` +
          ` stroke-width="${sheet.width * .12}" filter="url(#${prefix}soft)"/>` +
      '</g>' +
      `<path d="${sheet.edge}" fill="none" stroke="url(#${prefix}edge)" stroke-width="3.5"/></svg>`;
  }
  function fail() {
    if (disposed) return;
    destroy();
    try { onError?.(); } catch {}
  }
  function frames(index, motion = true) {
    const scaleX = size.width * overscan / bitmapWidth;
    const scaleY = size.height * overscan / bitmapHeight;
    const points = movement[index];
    // Interpolate between the control points on each axis of the closed loop.
    const smooth = (a, b, c, d, t) => .5 * (
      2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t
      + (-a + 3 * b - 3 * c + d) * t * t * t
    );
    return Array.from({ length: 33 }, (_, sample) => {
      const offset = sample / 32;
      const progress = offset * points.length;
      const segment = Math.floor(progress) % points.length;
      const fraction = progress - Math.floor(progress);
      const pointAt = relative => points[(segment + relative + points.length) % points.length];
      const [x, y, angle] = [0, 1, 2].map(axis => motion
        ? smooth(pointAt(-1)[axis], pointAt(0)[axis], pointAt(1)[axis], pointAt(2)[axis], fraction)
        : 0);
      return {
        offset,
        transform: `scale(${scaleX},${scaleY})` +
          ` translate3d(${x * 100 / overscan}%,${y * 100 / overscan}%,0) rotate(${angle}deg)`
      };
    });
  }
  function setPlaying(value) {
    if (disposed) return;
    playing = Boolean(value);
    try {
      for (const layer of layers) {
        layer.image.style.willChange = playing && layer.animation ? 'transform' : 'auto';
        if (!layer.animation) continue;
        if (playing && layer.animation.playState !== 'running') layer.animation.play();
        else if (!playing && layer.animation.playState === 'running') layer.animation.pause();
      }
      stage.dataset.xmbPlaying = String(playing && layers.some(layer => layer.animation));
    } catch { fail(); }
  }
  function updateFrames() {
    if (disposed || !loadedColor) return;
    try {
      for (let index = 0; index < layers.length; index++) {
        const layer = layers[index];
        if (!layer.animation && typeof layer.image.animate === 'function') {
          layer.animation = layer.image.animate(frames(index), {
            duration: periods[index],
            iterations: Infinity,
            easing: 'linear',
            delay: -periods[index] * (index * .29)
          });
          layer.animation.pause();
        } else if (layer.animation) {
          // Resizing changes the transform geometry while preserving the phase.
          const time = layer.animation.currentTime;
          layer.animation.effect.setKeyframes(frames(index));
          if (time !== null) layer.animation.currentTime = time;
        } else layer.image.style.transform = frames(index,false)[0].transform;
      }
      setPlaying(playing);
    } catch { fail(); }
  }
  function renderAsset(sheet, color, index, current) {
    return new Promise((resolve,reject) => {
      const loader = new Image();
      loader.onload = () => {
        loader.onload = loader.onerror = null;
        if (disposed || current !== generation) { resolve(null); return; }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = bitmapWidth; canvas.height = bitmapHeight;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Background bitmap unavailable');
          context.drawImage(loader,0,0,bitmapWidth,bitmapHeight);
          const source = canvas.toDataURL('image/png');
          if (!source.startsWith('data:image/png')) throw new Error('Background bitmap unavailable');
          canvas.width = canvas.height = 1;
          resolve(source);
        } catch (error) { reject(error); }
      };
      loader.onerror = () => { loader.onload = loader.onerror = null; reject(new Error('Background image unavailable')); };
      loader.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor(sheet,color,index));
    });
  }
  // Build both layers before swapping the palette. A generation check discards
  // late assets when the user changes the color again or leaves the page.
  function loadAssets(color) {
    const current = ++generation;
    pendingColor = color;
    stage.dataset.xmbReady = 'false';
    Promise.all(sheets.map((sheet,index) => renderAsset(sheet,color,index,current))).then(results => {
      if (disposed || current !== generation) return;
      for (let index = 0; index < layers.length; index++) layers[index].image.src = results[index];
      stage.style.background = gradient(color);
      loadedColor = color; pendingColor = '';
      updateFrames();
      if (!disposed) stage.dataset.xmbReady = 'true';
    }).catch(() => { if (!disposed && current === generation) fail(); });
  }
  function refresh() {
    if (disposed) return;
    try {
      const color = selectedColor(), rect = stage.getBoundingClientRect();
      if (!loadedColor) stage.style.background = gradient(color);
      if (rect.width < 1 || rect.height < 1) return;
      const resized = rect.width !== size.width || rect.height !== size.height;
      size = {width:rect.width,height:rect.height};
      if (pendingColor && pendingColor !== color) {
        generation++; pendingColor = '';
        stage.dataset.xmbReady = String(Boolean(loadedColor));
      }
      if (color !== loadedColor && pendingColor !== color) loadAssets(color);
      else if (resized) updateFrames();
    } catch { fail(); }
  }
  function destroy() {
    if (disposed) return;
    disposed = true; generation++;
    resizer?.disconnect();
    for (const layer of layers) {
      try { layer.animation?.cancel(); } catch {}
      layer.image.removeAttribute('src'); layer.image.remove();
    }
    stage.dataset.xmbPlaying = 'false';
  }
  let resizer = null;
  try {
    for (let index = 0; index < sheets.length; index++) {
      const image = document.createElement('img');
      image.className = 'xmb-ribbon-layer'; image.alt = ''; image.draggable = false;
      image.width = bitmapWidth; image.height = bitmapHeight;
      image.style.cssText = 'position:absolute;left:50%;top:50%;display:block;' +
        'width:768px;height:432px;max-width:none;margin-left:-384px;margin-top:-216px;' +
        'transform-origin:50% 50%;pointer-events:none;user-select:none;';
      layers.push({image,animation:null});
      stage.append(image);
    }
    if (typeof ResizeObserver === 'function') { resizer = new ResizeObserver(refresh); resizer.observe(stage); }
    refresh();
  } catch (error) { destroy(); throw error; }
  return {refresh,resize:refresh,setPlaying,destroy};
}

// Keep the decorative renderer independent of authentication and the collection.
// A plain gradient remains available if image loading or animation fails.
function initializeXmbBackground() {
  const background = document.getElementById('xmbBackground');
  const backgroundPicker = document.getElementById('backgroundColor');
  if (!background || !backgroundPicker) return null;
  const resetButton = document.getElementById('backgroundColorReset');
  const defaultColor = '#0874bc';
  const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const selectedColor = () => validColor(backgroundPicker.value) ? backgroundPicker.value : defaultColor;
  const activeAero = () => {
    const theme = document.documentElement?.getAttribute?.('data-theme');
    return !theme || theme === 'aero';
  };
  try {
    const savedColor = localStorage.getItem(AERO_BACKGROUND_COLOR_KEY);
    if (validColor(savedColor)) backgroundPicker.value = savedColor;
  } catch {}
  let renderer = null, disposed = false, failed = false, pageSuspended = false, reducedMotion = null;
  try { if (typeof matchMedia === 'function') reducedMotion = matchMedia('(prefers-reduced-motion: reduce)'); } catch {}
  function fallback() {
    const n = parseInt(selectedColor().slice(1),16), channels = [n >> 16,n >> 8 & 255,n & 255];
    const shade = factor => 'rgb(' + channels.map(channel => Math.round(channel*factor)).join(',') + ')';
    background.style.background = 'linear-gradient(155deg,'+shade(.4)+','+shade(.85)+' 48%,'+shade(.25)+')';
  }
  function disableRenderer() {
    if (disposed) return;
    failed = true;
    try { renderer?.destroy(); } catch {}
    renderer = null;
    refresh();
  }
  function refresh() {
    if (disposed) return;
    const active = activeAero();
    // Keep controls accurate even when only the gradient fallback is available.
    if (resetButton) {
      resetButton.hidden = !active;
      resetButton.disabled = !active || selectedColor().toLowerCase() === defaultColor;
    }
    if (failed) { fallback(); return; }
    try {
      const visible = document.hidden !== true && !pageSuspended;
      const preference = document.documentElement?.getAttribute?.('data-background-motion');
      const motion = preference === 'on' || (preference !== 'off' && reducedMotion?.matches !== true);
      renderer?.setPlaying(active && motion && visible);
      if (visible && active) renderer?.refresh();
    } catch { disableRenderer(); }
  }
  function onColorChange() {
    if (disposed) return;
    try { localStorage.setItem(AERO_BACKGROUND_COLOR_KEY,selectedColor()); } catch {}
    refresh();
  }
  function onColorReset() {
    // Recheck the current theme so hidden or stale events cannot reset Aero
    // while a different desktop is selected. Remove only this preference.
    if (disposed || !resetButton || resetButton.hidden || resetButton.disabled || !activeAero()) return;
    backgroundPicker.value = defaultColor;
    try { localStorage.removeItem(AERO_BACKGROUND_COLOR_KEY); } catch {}
    // Reset becomes disabled below; preserve focus within the appearance menu.
    if (document.activeElement === resetButton) {
      try { backgroundPicker.focus({ preventScroll: true }); } catch {}
    }
    refresh();
  }
  function onPageHide(event) {
    // A page in the back-forward cache can resume its existing animation.
    if (!event.persisted) { destroy(); return; }
    pageSuspended = true;
    refresh();
  }
  function onPageShow() { if (!disposed) { pageSuspended = false; refresh(); } }
  function destroy() {
    if (disposed) return;
    disposed = true;
    backgroundPicker.removeEventListener?.('input',onColorChange);
    resetButton?.removeEventListener?.('click',onColorReset);
    document.removeEventListener?.('visibilitychange',refresh);
    document.removeEventListener?.('savepoint:themechange',refresh);
    if (typeof removeEventListener === 'function') {
      removeEventListener('resize',refresh); removeEventListener('pagehide',onPageHide); removeEventListener('pageshow',onPageShow);
    }
    if (typeof reducedMotion?.removeEventListener === 'function') reducedMotion.removeEventListener('change',refresh);
    else reducedMotion?.removeListener?.(refresh);
    try { renderer?.destroy(); } catch {}
    renderer = null;
  }
  backgroundPicker.addEventListener('input',onColorChange);
  resetButton?.addEventListener('click',onColorReset);
  document.addEventListener('visibilitychange',refresh);
  document.addEventListener('savepoint:themechange',refresh);
  if (typeof addEventListener === 'function') {
    addEventListener('resize',refresh); addEventListener('pagehide',onPageHide); addEventListener('pageshow',onPageShow);
  }
  if (typeof reducedMotion?.addEventListener === 'function') reducedMotion.addEventListener('change',refresh);
  else reducedMotion?.addListener?.(refresh);
  fallback();
  try { renderer = createEconomyXmb(background,selectedColor,disableRenderer); refresh(); } catch { disableRenderer(); }
  return {refresh,resize:refresh,redraw:refresh,destroy};
}
