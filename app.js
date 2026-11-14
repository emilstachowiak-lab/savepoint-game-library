// The API supplies the current collection. The legacy storage key is read only
// for migration, while the background color is a separate browser preference.
const $ = id => document.getElementById(id);
const LEGACY_KEY = 'savepoint-library-v1';
const BG_KEY = 'savepoint-background-color-v1';
const API_URL = 'api/games.php';
let games = [];
let toastTimer;

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
  const background = $('xmbBackground'), backgroundPicker = $('backgroundColor');
  if (!background || !backgroundPicker) return null;
  const resetButton = $('backgroundColorReset');
  const defaultColor = '#0874bc';
  const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const selectedColor = () => validColor(backgroundPicker.value) ? backgroundPicker.value : defaultColor;
  const activeAero = () => {
    const theme = document.documentElement?.getAttribute?.('data-theme');
    return !theme || theme === 'aero';
  };
  try {
    const savedColor = localStorage.getItem(BG_KEY);
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
    try { localStorage.setItem(BG_KEY,selectedColor()); } catch {}
    refresh();
  }
  function onColorReset() {
    // Recheck the current theme so hidden or stale events cannot reset Aero
    // while a different desktop is selected. Remove only this preference.
    if (disposed || !resetButton || resetButton.hidden || resetButton.disabled || !activeAero()) return;
    backgroundPicker.value = defaultColor;
    try { localStorage.removeItem(BG_KEY); } catch {}
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
const xmbBackground = initializeXmbBackground();

// Validate the URL scheme before loading a cover. Escape values separately
// when inserting them into an HTML template, including attribute values.
const safeImageUrl = value => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
};
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const LANGUAGE_KEY = 'savepoint-language-v1';
let uiLanguage = 'pl';
try {
  if (localStorage.getItem(LANGUAGE_KEY) === 'en') uiLanguage = 'en';
} catch {}
const uiBindings = new Map();

function uiText(polish, english) {
  return uiLanguage === 'en' ? english ?? polish : polish;
}

function applyUiText(node, field, value) {
  if (field === 'textContent' || field === 'innerHTML' || field === 'alt') {
    if (node[field] !== value) node[field] = value;
  } else if (node.getAttribute(field) !== value) {
    if (value === null) node.removeAttribute(field);
    else node.setAttribute(field, value);
  }
}

// Keep both versions of text on persistent controls so changes to the language
// can update an existing view without replaying the action that produced it.
function bindUiText(node, field, polish, english) {
  if (!node) return;
  let fields = uiBindings.get(node);
  if (!fields) {
    fields = new Map();
    uiBindings.set(node, fields);
  }
  fields.set(field, [polish, english]);
  applyUiText(node, field, uiText(polish, english));
}

function setUiText(node, polish, english) {
  bindUiText(node, 'textContent', polish, english);
}

function uiError(polish, english) {
  const error = new Error(polish);
  error.englishMessage = english;
  return error;
}

// The API sends the other language alongside its primary error. Errors created
// in the browser instead carry an optional English message on the Error object.
function uiErrorText(error) {
  const polish = error?.payload?.errorDefault || error?.message || '';
  const english = error?.payload?.errorEnglish
    || (error?.payload?.errorDefault ? error.message : error?.englishMessage)
    || polish;
  return [polish, english];
}

// Translate labels within their own field. A custom platform can share a name
// with a status or edition. The saved values and form selections stay unchanged.
const englishGameLabels = {
  status: new Map([
    ['Do ogrania', 'To play'],
    ['W trakcie', 'In progress'],
    ['Ograna', 'Completed']
  ]),
  edition: new Map([
    ['Fizyczne', 'Physical'],
    ['Cyfrowe', 'Digital'],
    ['Fizyczne i cyfrowe', 'Physical and digital']
  ]),
  platform: new Map([['Inna', 'Other']])
};
function gameLabel(field, value) {
  return uiText(value, englishGameLabels[field].get(value));
}

// Read records from versions that saved the collection in browser storage.
function readLegacyGames() {
  try {
    const stored = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
    return Array.isArray(stored) ? stored.map(({ price, ...game }) => game) : [];
  } catch { return []; }
}
// Request and file limits apply separately because import re-serializes JSON.
// Session generations identify which login owns pending requests and UI work.
const MAX_REQUEST_BYTES = 65536;
const MAX_IMPORT_FILE_BYTES = 1024 * 1024;
const PENDING_LOGOUT_KEY = 'savepoint-logout-pending-v1';
const FRESH_LOGIN_REQUIRED_KEY = 'savepoint-login-required-v1';
let sessionGeneration = 0;
let authenticated = false;
let logoutRequest = null;
const activeApiRequests = new Set();
let sessionPolicy = null;
let sessionWarningTimer = null;
let sessionExpiryTimer = null;
let privacySuspended = false;
let privacyVisibility = null;
let sessionValidationRequest = null;
let sessionValidationToken = 0;
// Measure elapsed time with both clocks when available. Moving the wall clock
// backwards cannot extend a live session while the monotonic clock advances.
function sessionClock() {
  return {
    wall: Date.now(),
    mono: typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : null
  };
}
function sessionElapsed(anchor) {
  const wall = Math.max(0, Date.now() - anchor.wall);
  const hasMonotonicClock = anchor.mono !== null && typeof performance !== 'undefined'
    && typeof performance.now === 'function';
  const mono = hasMonotonicClock ? Math.max(0, performance.now() - anchor.mono) : 0;
  return Math.max(wall, mono);
}
function sessionRemaining(policy = sessionPolicy) {
  return policy ? Math.min(policy.idleMs, policy.absoluteMs) - sessionElapsed(policy.anchor) : 0;
}
function setSessionWarning(visible) {
  const warning = $('sessionWarning');
  if (!warning) return;
  warning.hidden = !visible || privacySuspended || !authenticated || logoutPending;
  setUiText($('sessionWarningText'), 'Sesja wkrótce wygaśnie. Zapisz otwarty formularz.',
    'Your session will expire soon. Save any open form.');
}
function clearSessionPolicy() {
  clearTimeout(sessionWarningTimer);
  clearTimeout(sessionExpiryTimer);
  sessionWarningTimer = sessionExpiryTimer = null;
  sessionPolicy = null;
  sessionValidationToken++;
  sessionValidationRequest = null;
  privacySuspended = false;
  for (const [node, hidden] of privacyVisibility || []) {
    if (node !== $('appShell')) node.hidden = hidden;
  }
  privacyVisibility = null;
  document.documentElement?.classList.remove('privacy-suspended');
  setSessionWarning(false);
}
// The warning and expiry timers share the earlier of the idle and absolute
// deadlines. Recheck on firing because browser timers can be delayed.
function armSessionTimers() {
  clearTimeout(sessionWarningTimer);
  clearTimeout(sessionExpiryTimer);
  sessionWarningTimer = sessionExpiryTimer = null;
  setSessionWarning(false);
  if (!authenticated || logoutPending || !sessionPolicy) return;
  const remaining = sessionRemaining();
  if (remaining <= 0) { void revalidatePrivateSession(true); return; }
  if (remaining <= 60000) setSessionWarning(true);
  else sessionWarningTimer = setTimeout(() => {
    if (authenticated && !logoutPending) {
      if (sessionRemaining() <= 0) void revalidatePrivateSession(true);
      else if (sessionRemaining() <= 60000) setSessionWarning(true);
      else armSessionTimers();
    }
  }, remaining - 60000);
  sessionExpiryTimer = setTimeout(() => {
    if (authenticated && !logoutPending) {
      if (sessionRemaining() <= 0) void revalidatePrivateSession(true);
      else armSessionTimers();
    }
  }, remaining);
}
// Convert server timestamps to local countdowns anchored when the request
// started, so transport delay cannot add time to the reported lifetime.
function applySessionMetadata(metadata, anchor) {
  const fields = ['authenticatedAt', 'lastActivityAt', 'idleExpiresAt', 'absoluteExpiresAt', 'serverNow'];
  if (!metadata || !fields.every(key => Number.isSafeInteger(metadata[key]) && metadata[key] > 0)
      || metadata.authenticatedAt > metadata.lastActivityAt || metadata.lastActivityAt > metadata.serverNow
      || metadata.idleExpiresAt !== metadata.lastActivityAt + 1800
      || metadata.absoluteExpiresAt !== metadata.authenticatedAt + 28800) return false;
  const next = { anchor, authenticatedAt: metadata.authenticatedAt, lastActivityAt: metadata.lastActivityAt,
    idleMs: (metadata.idleExpiresAt - metadata.serverNow) * 1000,
    absoluteMs: (metadata.absoluteExpiresAt - metadata.serverNow) * 1000 };
  if (sessionPolicy && next.authenticatedAt < sessionPolicy.authenticatedAt) return sessionRemaining() > 0;
  if (sessionPolicy?.authenticatedAt === next.authenticatedAt) {
    if (next.lastActivityAt < sessionPolicy.lastActivityAt) return sessionRemaining() > 0;
    const elapsed = sessionElapsed(anchor);
    const oldElapsed = sessionElapsed(sessionPolicy.anchor);
    // Out-of-order or passive replies cannot move an unchanged deadline later.
    next.absoluteMs = Math.min(next.absoluteMs, sessionPolicy.absoluteMs - oldElapsed + elapsed);
    if (next.lastActivityAt === sessionPolicy.lastActivityAt) next.idleMs = Math.min(next.idleMs, sessionPolicy.idleMs - oldElapsed + elapsed);
  }
  if (sessionRemaining(next) <= 0) return false;
  sessionPolicy = next;
  armSessionTimers();
  return true;
}
// A deadline crossing hides private UI immediately. Keep the current draft
// and prior visibility so a successful passive check can restore them.
function suspendPrivateView() {
  if (!authenticated || logoutPending) return;
  if (!privacySuspended) {
    privacySuspended = true;
    privacyVisibility = new Map();
    for (const id of ['appShell', 'modalBackdrop', 'deleteModalBackdrop', 'toast']) {
      const node = $(id);
      if (node) { privacyVisibility.set(node, node.hidden); node.hidden = true; }
    }
  }
  document.documentElement?.classList.add('privacy-suspended');
  clearTimeout(coverBackupTimer);
  coverBackupTimer = null;
  setSessionWarning(false);
}
function showSessionChecking(error = null) {
  $('authScreen').hidden = false;
  setUiText($('authTitle'), error ? 'Widok zablokowany' : 'Sprawdzam sesję…',
    error ? 'View locked' : 'Checking your session…');
  setUiText($('authIntro'),
    error ? 'Dane pozostają ukryte do potwierdzenia ważności sesji.' : 'Potwierdzam ważność sesji kolekcji.',
    error ? 'Your collection stays hidden until your session is verified.' : 'Verifying your collection session.');
  $('loginForm').hidden = true;
  setUiText($('authMessage'), ...uiErrorText(error));
  setUiText($('captchaStatus'), '');
  $('retryConnection').hidden = !error;
}
// Share one passive check between callers. Its generation and token prevent a
// superseded request from reopening the view after a login or logout.
async function revalidatePrivateSession(expiredCandidate = false) {
  if (!authenticated || logoutPending) return false;
  suspendPrivateView();
  if (sessionValidationRequest) return sessionValidationRequest;
  const generation = sessionGeneration;
  const token = ++sessionValidationToken;
  showSessionChecking();
  let timeout;
  const check = (async () => {
    try {
      await Promise.race([
        apiRequest('GET', undefined, generation, { sessionCheck: true }),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => {
            reject(uiError('Nie udało się potwierdzić sesji. Sprawdź połączenie i ponów próbę.',
              'Could not verify your session. Check your connection and try again.'));
          }, 10000);
        })
      ]);
      ensureCurrentSession(generation);
      if (token !== sessionValidationToken || !authenticated || logoutPending) return false;
      if (!sessionPolicy || sessionRemaining() <= 0) {
        void performLogout();
        return false;
      }
      const visibility = privacyVisibility;
      privacySuspended = false;
      privacyVisibility = null;
      for (const [node, hidden] of visibility || []) node.hidden = hidden;
      document.documentElement?.classList.remove('privacy-suspended');
      $('appShell').hidden = false;
      $('authScreen').hidden = true;
      if (renderedCollectionMetadata && renderedCollectionMetadata.language !== uiLanguage) render();
      armSessionTimers();
      scheduleCoverBackupWorker();
      return true;
    } catch (error) {
      if (ignoredSessionError(error) || generation !== sessionGeneration || token !== sessionValidationToken) return false;
      if (error.status === 429) {
        showSessionChecking(error);
        return false;
      }
      if (expiredCandidate || !sessionPolicy || sessionRemaining() <= 0) {
        void performLogout();
        return false;
      }
      showSessionChecking(error);
      return false;
    } finally {
      clearTimeout(timeout);
      if (token === sessionValidationToken) sessionValidationRequest = null;
    }
  })();
  sessionValidationRequest = check;
  return check;
}
// Async actions can wait for revalidation. Actions requiring a browser user
// gesture use the synchronous gate below and wait for a fresh click instead.
async function ensurePrivateSessionReady(generation = sessionGeneration) {
  ensureCurrentSession(generation);
  if (!authenticated || logoutPending) throw staleSessionError();
  if (privacySuspended || (sessionPolicy && sessionRemaining() <= 0)) {
    if (!await revalidatePrivateSession(Boolean(sessionPolicy && sessionRemaining() <= 0))) throw staleSessionError();
    ensureCurrentSession(generation);
  }
}
function privateViewUsable() {
  if (!authenticated || logoutPending) return false;
  if (privacySuspended || (sessionPolicy && sessionRemaining() <= 0)) {
    void revalidatePrivateSession(Boolean(sessionPolicy && sessionRemaining() <= 0));
    return false;
  }
  return true;
}
function initializeSessionPrivacy() {
  // Returning to a valid session is local and immediate. Re-arm deadlines in
  // case the browser suspended timers; only an elapsed deadline needs the API.
  const resumeSessionTimers = () => {
    if (!document.hidden && authenticated && !logoutPending) armSessionTimers();
  };
  document.addEventListener?.('visibilitychange', () => {
    if (!document.hidden) resumeSessionTimers();
  });
  addEventListener('focus', resumeSessionTimers);
  addEventListener('pageshow', resumeSessionTimers);
}
// Preserve logout state across reloads. Local storage also carries the marker
// to other tabs, and session storage is a fallback for the current tab.
function readStoredFlag(key) {
  return ['localStorage', 'sessionStorage'].some(name => {
    try { return globalThis[name]?.getItem(key) === '1'; } catch { return false; }
  });
}
function storeFlag(key, enabled) {
  ['localStorage', 'sessionStorage'].forEach(name => {
    try {
      if (enabled) globalThis[name]?.setItem(key, '1');
      else globalThis[name]?.removeItem(key);
    } catch {}
  });
}
function readPendingLogout() { return readStoredFlag(PENDING_LOGOUT_KEY); }
function storePendingLogout(pending) { storeFlag(PENDING_LOGOUT_KEY, pending); }
let logoutPending = readPendingLogout();
let freshLoginRequired = readStoredFlag(FRESH_LOGIN_REQUIRED_KEY);
function staleSessionError() {
  const error = new Error('Odpowiedź dotyczy zakończonej sesji.');
  error.staleSession = true;
  return error;
}
function ensureCurrentSession(generation, allowLogout = false) {
  if (generation !== sessionGeneration || (logoutPending && !allowLogout)) throw staleSessionError();
}
function ignoredSessionError(error) { return Boolean(error?.staleSession || error?.sessionExpired); }
// Send same-origin JSON, track requests that can affect the session cookie,
// and accept private results only while their session generation is current.
async function apiRequest(method = 'GET', body = undefined, generation = sessionGeneration, options = {}) {
  const isLogout = body?.action === 'logout';
  const isSessionCheck = options.sessionCheck === true;
  ensureCurrentSession(generation, isLogout);
  if (authenticated && !isLogout && !isSessionCheck
      && (privacySuspended || (sessionPolicy && sessionRemaining() <= 0))) {
    await ensurePrivateSessionReady(generation);
  }
  // Check encoded bytes to match the server's request limit for Unicode text.
  const requestBody = body ? JSON.stringify(body) : undefined;
  if (requestBody && new TextEncoder().encode(requestBody).byteLength > MAX_REQUEST_BYTES) {
    throw uiError('Dane żądania przekraczają limit 64 KiB. Zmniejsz importowaną kolekcję.',
      'The request exceeds the 64 KiB limit. Reduce the size of the imported collection.');
  }
  const anchor = sessionClock();
  const operation = (async () => {
    const response = await fetch(isSessionCheck ? API_URL + '?session=1' : API_URL, {
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Accept-Language': uiLanguage }
        : { 'Accept-Language': uiLanguage },
      body: requestBody,
      credentials: 'same-origin'
    });
    let result;
    try { result = await response.json(); } catch { result = {}; }
    // Consume the response before a pending logout is sent, so an older login
    // cannot apply its session cookie after the final logout request.
    ensureCurrentSession(generation, isLogout);
    if (!response.ok || !result.ok) {
      const fallback = response.status === 413
        ? uiError('Żądanie jest zbyt duże.', 'The request is too large.')
        : response.status === 415
          ? uiError('Żądanie musi zawierać dane JSON.', 'The request must contain JSON.')
          : uiError('Nie udało się połączyć z bazą danych.', 'Could not connect to the database.');
      const error = result.error ? new Error(result.error) : fallback;
      error.status = response.status;
      error.payload = result;
      if (response.status === 401 && authenticated && !isLogout && body?.action !== 'login') {
        if (isSessionCheck) void performLogout();
        else handleSessionExpired(result);
        error.sessionExpired = true;
      }
      throw error;
    }
    if (!isLogout && (authenticated || Array.isArray(result.games) || isSessionCheck) && !applySessionMetadata(result.session, anchor)) {
      void performLogout();
      throw staleSessionError();
    }
    return result;
  })();
  if (!isLogout) activeApiRequests.add(operation);
  try { return await operation; }
  finally { activeApiRequests.delete(operation); }
}
// These indicators report connection state and transient collection actions.
function setConnectionStatus(text, failed = false, english = text) {
  const status = $('connectionStatus');
  bindUiText(status, 'innerHTML', `<i class="dot"></i> ${esc(text)}`, `<i class="dot"></i> ${esc(english)}`);
  status.style.borderColor = failed ? '#bd665a' : '';
  status.style.color = failed ? '#9b342a' : '';
}
function notify(message, english) {
  setUiText($('toast'), message, english);
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}
// Cards load original images lazily. The API creates private backups in a
// separate queue, and the browser can try those backups if an original fails.
const COVER_LOAD_TIMEOUT = 10000;
let coverBackupCollection = null;
let coverBackupQueue = [];
let coverBackupTimer = null;
let coverBackupWorker = null;
const coverBackupAttempted = new Set();
const coverBackupBusyRetries = new Map();
const coverBackupStatusChecked = new Set();
let coverBackupStatusAvailable = true;
let coverSavedById = new Map();
const coverImageStates = new Map();
let coverVisibilityObserver = null;
function localCoverUrl(id) {
  return /^[a-zA-Z0-9-]{1,36}$/.test(String(id)) ? API_URL + '?cover=' + encodeURIComponent(id) : '';
}
function clearCoverImageTracking() {
  coverVisibilityObserver?.disconnect();
  coverVisibilityObserver = null;
  for (const state of coverImageStates.values()) { clearTimeout(state.timer); clearCoverProbe(state); }
  coverImageStates.clear();
}
function clearCoverBackups() {
  clearTimeout(coverBackupTimer);
  coverBackupTimer = null;
  coverBackupCollection = null;
  coverBackupQueue = [];
  coverBackupAttempted.clear();
  coverBackupBusyRetries.clear();
  coverBackupStatusChecked.clear();
  coverBackupStatusAvailable = true;
  coverSavedById.clear();
  clearCoverImageTracking();
}
// Grid renders replace image nodes. Check both the session and the saved URL
// before an async callback changes an image still attached to the grid.
function currentCoverImage(image) {
  const state = coverImageStates.get(image);
  if (!state || state.generation !== sessionGeneration || !authenticated || logoutPending
      || !$('grid').contains(image)) return null;
  const matchesSavedCover = state.collection === games
    && String(state.game.coverUrl) === state.key
    && safeImageUrl(state.game.coverUrl) === state.url;
  return matchesSavedCover ? state : null;
}
function clearCoverProbe(state) {
  if (!state.probe) return;
  state.probe.onload = null;
  state.probe.onerror = null;
  state.probe.removeAttribute('src');
  state.probe = null;
}
// Test a backup off-screen so a missing backup cannot interrupt a slow original.
function probeLocalCover(image) {
  const state = currentCoverImage(image);
  if (!state || state.local || state.probe || (image.complete && image.naturalWidth)) return;
  const probe = new Image();
  state.probe = probe;
  probe.referrerPolicy = 'no-referrer';
  probe.onload = () => {
    if (currentCoverImage(image) !== state || state.probe !== probe) return;
    const originalLoaded = image.complete && image.naturalWidth;
    clearCoverProbe(state);
    if (!originalLoaded) useLocalCover(image);
  };
  probe.onerror = () => { if (state.probe === probe) clearCoverProbe(state); };
  probe.src = localCoverUrl(state.id);
}
function useLocalCover(image) {
  const state = currentCoverImage(image);
  if (!state) return;
  clearTimeout(state.timer);
  state.timer = null;
  clearCoverProbe(state);
  if (state.local) return;
  state.local = true;
  image.src = localCoverUrl(state.id);
}
function trackCoverImages() {
  clearCoverImageTracking();
  const images = $('grid').querySelectorAll('img.cover-image[data-cover-id]');
  for (const image of images) {
    const id = image.dataset.coverId;
    const game = coverSavedById.get(id)?.game;
    if (!game || !localCoverUrl(id)) continue;
    coverImageStates.set(image, {
      id,
      game,
      collection: games,
      key: String(game.coverUrl),
      url: image.getAttribute('src'),
      generation: sessionGeneration,
      local: false,
      retried: false,
      timer: null
    });
    if (image.complete && !image.naturalWidth) useLocalCover(image);
  }
  // A lazy image has no reliable loadstart event. Start its watchdog only once
  // the card is visible, rather than expiring off-screen, unrequested images.
  if (typeof IntersectionObserver !== 'function') return;
  coverVisibilityObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      coverVisibilityObserver?.unobserve(entry.target);
      const state = currentCoverImage(entry.target);
      if (!state || state.local || (entry.target.complete && entry.target.naturalWidth)) continue;
      state.timer = setTimeout(() => probeLocalCover(entry.target), COVER_LOAD_TIMEOUT);
    }
  });
  for (const image of coverImageStates.keys()) coverVisibilityObserver.observe(image);
}
function markCoverBackupReady(key) {
  for (const [image, state] of coverImageStates) {
    // The first fallback can have raced the initial backup. Retry once when
    // the server confirms the file exists; repeated image errors never loop.
    if (state.key !== key || !state.local || state.retried || !currentCoverImage(image)) continue;
    if (image.complete && image.naturalWidth) continue;
    state.retried = true;
    image.src = localCoverUrl(state.id) + '&ready=1';
  }
}
function currentCoverBackupCandidate(candidate) {
  const entry = coverSavedById.get(candidate.id);
  return entry && String(entry.game.coverUrl) === candidate.key && entry.coverUrl === candidate.url;
}
// Run one backup request at a time. Query existing copies in batches first,
// then request individual backups only for URLs that still need one.
function scheduleCoverBackupWorker(delay = 750) {
  if (coverBackupTimer || coverBackupWorker || !coverBackupQueue.length || !authenticated || logoutPending || privacySuspended) return;
  const generation = sessionGeneration;
  coverBackupTimer = setTimeout(async () => {
    coverBackupTimer = null;
    if (generation !== sessionGeneration || !authenticated || logoutPending || coverBackupWorker || privacySuspended) return;
    let item;
    while (coverBackupQueue.length && !item) {
      const candidate = coverBackupQueue.shift();
      if (!coverBackupAttempted.has(candidate.key) && currentCoverBackupCandidate(candidate)) item = candidate;
    }
    if (!item) return;
    const worker = {generation};
    coverBackupWorker = worker;
    let nextDelay = 750;
    const checkingStatus = coverBackupStatusAvailable && !coverBackupStatusChecked.has(item.key);
    try {
      if (checkingStatus) {
        // One metadata request avoids a separate PHP request and database
        // lookup for every cover whose private backup already exists.
        const batch = [item];
        const ids = new Set([item.id]);
        for (const candidate of coverBackupQueue) {
          if (batch.length === 32) break;
          if (ids.has(candidate.id) || coverBackupAttempted.has(candidate.key)
              || coverBackupStatusChecked.has(candidate.key) || !currentCoverBackupCandidate(candidate)) continue;
          ids.add(candidate.id);
          batch.push(candidate);
        }
        const result = await apiRequest('POST', {action: 'backup-cover-status', ids: batch.map(candidate => candidate.id)}, generation);
        ensureCurrentSession(generation);
        if (!Array.isArray(result.backups) || result.backups.length > 32) throw new Error('Nieprawidłowa odpowiedź stanu kopii.');
        const statuses = new Map();
        for (const status of result.backups) {
          if (!status || typeof status.id !== 'string') continue;
          statuses.set(status.id, statuses.has(status.id) ? null : status);
        }
        for (const candidate of batch) {
          if (!currentCoverBackupCandidate(candidate)) continue;
          coverBackupStatusChecked.add(candidate.key);
          const status = statuses.get(candidate.id);
          if (status?.ready !== true || status.coverUrl !== candidate.key) continue;
          coverBackupAttempted.add(candidate.key);
          markCoverBackupReady(candidate.key);
        }
        const requeueItem = !coverBackupAttempted.has(item.key) && currentCoverBackupCandidate(item);
        coverBackupQueue = coverBackupQueue.filter(candidate =>
          !coverBackupAttempted.has(candidate.key) && (!requeueItem || candidate.key !== item.key));
        if (requeueItem) coverBackupQueue.unshift(item);
      } else {
        coverBackupAttempted.add(item.key);
        const result = await apiRequest('POST', {action: 'backup-cover', id: item.id}, generation);
        ensureCurrentSession(generation);
        if (['saved', 'cached'].includes(result.backup?.status)) markCoverBackupReady(item.key);
        else if (result.backup?.status === 'busy') {
          const retries = coverBackupBusyRetries.get(item.key) || 0;
          if (retries < 3) {
            coverBackupBusyRetries.set(item.key, retries + 1);
            coverBackupAttempted.delete(item.key);
            coverBackupQueue.push(item);
            nextDelay = 1500 * 2 ** retries;
          }
        }
      }
    } catch (error) {
      // A backup failure must not block a game save, import or usable original.
      // The server applies a retry cooldown; the next session can try again.
      if (checkingStatus && !ignoredSessionError(error) && generation === sessionGeneration && !logoutPending) {
        coverBackupStatusAvailable = false;
        if (currentCoverBackupCandidate(item)) {
          coverBackupQueue = coverBackupQueue.filter(candidate => candidate.key !== item.key);
          coverBackupQueue.unshift(item);
        }
      }
    } finally {
      if (coverBackupWorker === worker) coverBackupWorker = null;
      scheduleCoverBackupWorker(nextDelay);
    }
  }, delay);
}
// Rebuild the work list on collection replacement. Deduplicate by the raw
// stored URL because the server uses that string as its backup key.
function scheduleCoverBackups(collection = getCollectionMetadata()) {
  if (!authenticated || logoutPending || coverBackupCollection === games) return;
  coverBackupCollection = games;
  coverSavedById = new Map(collection.entries.map(entry => [String(entry.game.id), entry]));
  const seen = new Set();
  coverBackupQueue = [];
  for (const {game, coverUrl: url} of collection.entries) {
    const id = String(game.id);
    const key = String(game.coverUrl);
    if (!url || !localCoverUrl(id) || seen.has(key) || coverBackupAttempted.has(key)) continue;
    seen.add(key);
    coverBackupQueue.push({id, url, key});
  }
  scheduleCoverBackupWorker();
}
// Accept both arrays and legacy comma-separated platform strings.
function gamePlatforms(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(values.map(platform => String(platform).trim()).filter(Boolean))];
}
let collectionMetadataCache = null;
let renderedCollectionMetadata = null;
let titleCollator;
function compareGameTitles(a, b) {
  if (titleCollator === undefined) {
    try { titleCollator = new Intl.Collator('pl'); }
    catch { titleCollator = false; }
  }
  return titleCollator && typeof a.game.title === 'string'
    ? titleCollator.compare(a.game.title, b.game.title)
    : a.game.title.localeCompare(b.game.title, 'pl');
}
// Cache search text, filters, sort orders and rendered cards by collection
// identity and language. A language change invalidates the translated markup.
function getCollectionMetadata() {
  if (collectionMetadataCache?.games === games && collectionMetadataCache.language === uiLanguage) {
    return collectionMetadataCache;
  }
  const entries = games.map(game => ({
    game,
    platforms: gamePlatforms(game.platform),
    searchText: `${game.title} ${game.platform}`.toLocaleLowerCase('pl'),
    coverUrl: game.coverUrl ? safeImageUrl(game.coverUrl) : '',
    cardHtml: null
  }));
  const titles = [...new Set(games.map(game => game.title).filter(Boolean))];
  const platforms = [...new Set(entries.flatMap(entry => entry.platforms))]
    .sort((a, b) => a.localeCompare(b, 'pl'));
  collectionMetadataCache = {
    games, entries, platforms, language: uiLanguage,
    sortedEntries: new Map(),
    titleOptions: titles.map(title => `<option value="${esc(title)}"></option>`).join(''),
    platformOptions: `<option value="">${uiText('Wszystkie konsole', 'All platforms')}</option>` + platforms
      .map(platform => `<option value="${esc(platform)}">${esc(gameLabel('platform', platform))}</option>`).join(''),
    doneCount: games.filter(game => game.status === 'Ograna').length
  };
  return collectionMetadataCache;
}
// The checkboxes hold the actual form values. Tabs and chips are views over
// the same inputs, so switching groups preserves every selected platform.
function platformCheckboxes() {
  return [...$('platform').querySelectorAll('input[name="platform"]')];
}
function getSelectedPlatforms() {
  return platformCheckboxes().filter(input => input.checked).map(input => input.value);
}
function validatePlatformSelection() {
  const inputs = platformCheckboxes();
  const valid = inputs.some(input => input.checked);
  inputs[0].setCustomValidity(valid ? '' : uiText('Zaznacz przynajmniej jedną konsolę.', 'Select at least one platform.'));
  return valid;
}
// Preserve platforms from imported records even if the form has no preset
// checkbox for them. Clear the previous game's extra options first.
function setPlatformSelection(value) {
  $('platform').querySelector('[data-extra-platforms]')?.remove();
  const selected = new Set(gamePlatforms(value));
  const known = new Set(platformCheckboxes().map(input => input.value));
  const extra = [...selected].filter(platform => !known.has(platform));
  if (extra.length) {
    const group = document.createElement('fieldset');
    group.className = 'platform-group';
    group.dataset.extraPlatforms = 'true';
    const legend = document.createElement('legend');
    group.dataset.platformGroup = 'Inne zapisane konsole';
    legend.textContent = uiText('Inne zapisane konsole', 'Other saved platforms');
    const choices = document.createElement('div');
    choices.className = 'platform-choice-grid';
    extra.forEach(platform => {
      const label = document.createElement('label');
      label.className = 'platform-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'platform';
      input.value = platform;
      const name = document.createElement('span');
      name.textContent = platform;
      label.append(input, name);
      choices.append(label);
    });
    group.append(legend, choices);
    $('platformOptions').append(group);
  }
  platformCheckboxes().forEach(input => { input.checked = selected.has(input.value); });
  validatePlatformSelection();
  const groups = getPlatformGroups();
  rebuildPlatformTabs(groups.find(group => group.inputs.some(input => input.checked))?.name || groups[0]?.name);
  updatePlatformSelectionSummary();
}
// Older HTML can use the original form without the tabs and preview.
const gameFormPresentationAvailable = Boolean($('coverPreview') && $('platformTabs'));
let activePlatformGroup = '';
function getPlatformGroups() {
  return [...$('platformOptions').querySelectorAll('.platform-group')].map(element => {
    const label = element.querySelector('legend').textContent.trim();
    return {
      element,
      name: element.dataset.platformGroup || label,
      label,
      inputs: [...element.querySelectorAll('input[name="platform"]')]
    };
  });
}
// Keep the visible group and ARIA selection in sync. Only the active tab is
// in the normal Tab order, with arrow keys available to move between groups.
function activatePlatformGroup(groupName, { focus = false } = {}) {
  if (!gameFormPresentationAvailable) return;
  const groups = getPlatformGroups();
  const active = groups.find(group => group.name === groupName) || groups[0];
  if (!active) return;
  activePlatformGroup = active.name;
  groups.forEach(group => { group.element.hidden = group !== active; });
  $('platformTabs').querySelectorAll('[role="tab"]').forEach(tab => {
    const selected = tab.dataset.platformGroup === active.name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
}
function rebuildPlatformTabs(preferredGroup = activePlatformGroup) {
  if (!gameFormPresentationAvailable) return;
  const groups = getPlatformGroups();
  $('platformTabs').replaceChildren();
  groups.forEach((group, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'platform-tab';
    tab.id = 'platform-tab-' + index;
    tab.dataset.platformGroup = group.name;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'platform-panel-' + index);
    const name = document.createElement('span');
    name.textContent = group.label;
    const count = document.createElement('span');
    count.className = 'platform-tab-count';
    tab.append(name, count);
    $('platformTabs').append(tab);
    group.element.id = 'platform-panel-' + index;
    group.element.setAttribute('role', 'tabpanel');
    group.element.setAttribute('aria-labelledby', tab.id);
  });
  $('platformTabs').hidden = groups.length === 0;
  $('platformOptions').classList.add('platform-tabs-ready');
  activatePlatformGroup(preferredGroup);
}
function updatePlatformSelectionSummary() {
  if (!gameFormPresentationAvailable) return;
  const groups = getPlatformGroups();
  const selected = getSelectedPlatforms();
  $('platformSelectionCount').textContent = uiText('Wybrano ' + selected.length, selected.length + ' selected');
  $('platformTabs').querySelectorAll('[role="tab"]').forEach(tab => {
    const group = groups.find(group => group.name === tab.dataset.platformGroup);
    const count = group?.inputs.filter(input => input.checked).length || 0;
    const badge = tab.querySelector('.platform-tab-count');
    badge.textContent = count ? String(count) : '';
    badge.hidden = count === 0;
  });
  $('selectedPlatforms').replaceChildren();
  const label = document.createElement('span');
  label.className = 'selected-platforms-label';
  label.textContent = uiText('Wybrane:', 'Selected:');
  $('selectedPlatforms').append(label);
  if (!selected.length) {
    const empty = document.createElement('span');
    empty.className = 'selected-platforms-empty';
    empty.textContent = uiText('Zaznacz przynajmniej jedną konsolę', 'Select at least one platform');
    $('selectedPlatforms').append(empty);
    return;
  }
  selected.forEach(platform => {
    const chip = document.createElement('span');
    chip.className = 'selected-platform-chip';
    chip.innerHTML = aeroIcon('check');
    const name = document.createElement('span');
    name.textContent = gameLabel('platform', platform);
    chip.append(name);
    $('selectedPlatforms').append(chip);
  });
}
// Preview state belongs to the current draft. Closing or reopening the form
// cancels timers, detaches image callbacks, and invalidates late results.
let coverPreviewGeneration = 0;
let coverPreviewTimer = null;
let coverPreviewLoader = null;
let coverPreviewWatchdog = null;
let coverPreviewBackupProbe = null;
function clearCoverPreviewProbe() {
  if (!coverPreviewBackupProbe) return;
  coverPreviewBackupProbe.onload = null;
  coverPreviewBackupProbe.onerror = null;
  coverPreviewBackupProbe.removeAttribute('src');
  coverPreviewBackupProbe = null;
}
function clearCoverPreview() {
  if (!gameFormPresentationAvailable) return;
  coverPreviewGeneration++;
  clearTimeout(coverPreviewTimer);
  coverPreviewTimer = null;
  clearTimeout(coverPreviewWatchdog);
  coverPreviewWatchdog = null;
  clearCoverPreviewProbe();
  if (coverPreviewLoader) {
    coverPreviewLoader.onload = null;
    coverPreviewLoader.onerror = null;
    coverPreviewLoader.removeAttribute('src');
    coverPreviewLoader = null;
  }
  const image = $('coverPreview');
  image.onload = null;
  image.onerror = null;
  image.removeAttribute('src');
  image.hidden = true;
  bindUiText(image, 'alt', '');
  $('coverPreviewPlaceholder').hidden = false;
  setUiText($('coverPreviewTitle'), 'Twoja okładka', 'Your cover');
  setUiText($('coverPreviewStatus'), 'Podgląd okładki', 'Cover preview');
}
function updateCoverSearchLinks() {
  const query = $('title').value.trim();
  const coverSearch = $('coverSearch');
  if (coverSearch) {
    coverSearch.href = 'https://www.thecoverproject.net/view.php?searchstring=' + encodeURIComponent(query);
    if (coverSearch.style) coverSearch.style.opacity = query ? '1' : '.65';
  }
  const googleSearch = $('googleCoverSearch');
  if (googleSearch) {
    googleSearch.href = 'https://www.google.com/search?udm=2&q=' + encodeURIComponent(query ? query + ' game cover' : 'video game cover');
  }
}
function updateCoverPreviewTitle() {
  if (!gameFormPresentationAvailable) return;
  const title = $('title').value.trim();
  setUiText($('coverPreviewTitle'), title || 'Twoja okładka', title || 'Your cover');
  if (!$('coverPreview').hidden) {
    bindUiText($('coverPreview'), 'alt',
      title ? 'Okładka gry ' + title : 'Podgląd okładki',
      title ? 'Game cover for ' + title : 'Cover preview');
  }
}
// Debounce typing and load immediately when the input is committed. A saved
// backup is eligible only when the game ID and normalized URL match the draft.
function updateCoverPreview(immediate = false) {
  if (!gameFormPresentationAvailable) return;
  clearCoverPreview();
  if (logoutPending || !$('modalBackdrop').classList.contains('open')) return;
  updateCoverPreviewTitle();
  const value = $('coverUrl').value.trim();
  if (!value) {
    setUiText($('coverPreviewStatus'), 'Wklej adres okładki', 'Paste a cover URL');
    return;
  }
  const url = safeImageUrl(value);
  if (!url) {
    setUiText($('coverPreviewStatus'), 'Wpisz poprawny adres okładki', 'Enter a valid cover URL');
    return;
  }
  const generation = coverPreviewGeneration;
  const session = sessionGeneration;
  const isCurrent = () => generation === coverPreviewGeneration && session === sessionGeneration &&
    !logoutPending && $('modalBackdrop').classList.contains('open') && safeImageUrl($('coverUrl').value.trim()) === url;
  const showFailure = () => {
    if (!isCurrent()) return;
    $('coverPreview').onerror = null;
    $('coverPreview').removeAttribute('src');
    $('coverPreview').hidden = true;
    $('coverPreviewPlaceholder').hidden = false;
    setUiText($('coverPreviewStatus'), 'Nie udało się wczytać okładki', 'Could not load the cover');
  };
  const saved = games.find(game => String(game.id) === $('gameId').value && safeImageUrl(game.coverUrl) === url);
  const backupUrl = saved ? localCoverUrl(saved.id) : '';
  let usedBackup = false;
  const load = (source = url) => {
    coverPreviewTimer = null;
    clearTimeout(coverPreviewWatchdog);
    clearCoverPreviewProbe();
    if (!isCurrent()) return;
    const loader = new Image();
    coverPreviewLoader = loader;
    loader.referrerPolicy = 'no-referrer';
    loader.decoding = 'async';
    const fail = () => {
      if (!isCurrent() || coverPreviewLoader !== loader) return;
      clearTimeout(coverPreviewWatchdog);
      coverPreviewWatchdog = null;
      clearCoverPreviewProbe();
      coverPreviewLoader = null;
      loader.onload = null;
      loader.onerror = null;
      loader.removeAttribute('src');
      if (!usedBackup && backupUrl) { usedBackup = true; load(backupUrl); }
      else showFailure();
    };
    loader.onload = () => {
      if (!isCurrent() || coverPreviewLoader !== loader) return;
      clearTimeout(coverPreviewWatchdog);
      coverPreviewWatchdog = null;
      clearCoverPreviewProbe();
      coverPreviewLoader = null;
      loader.onload = null;
      loader.onerror = null;
      const image = $('coverPreview');
      image.referrerPolicy = 'no-referrer';
      image.onerror = () => {
        if (!isCurrent()) return;
        if (!usedBackup && backupUrl) { usedBackup = true; load(backupUrl); }
        else showFailure();
      };
      image.src = source;
      image.hidden = false;
      $('coverPreviewPlaceholder').hidden = true;
      setUiText($('coverPreviewStatus'), 'Podgląd okładki', 'Cover preview');
      updateCoverPreviewTitle();
    };
    loader.onerror = fail;
    if (backupUrl && !usedBackup) coverPreviewWatchdog = setTimeout(() => {
      if (!isCurrent() || coverPreviewLoader !== loader) return;
      const probe = new Image();
      coverPreviewBackupProbe = probe;
      probe.referrerPolicy = 'no-referrer';
      probe.onload = () => {
        if (!isCurrent() || coverPreviewLoader !== loader || coverPreviewBackupProbe !== probe) return;
        clearCoverPreviewProbe();
        usedBackup = true;
        loader.onload = null;
        loader.onerror = null;
        loader.removeAttribute('src');
        load(backupUrl);
      };
      probe.onerror = () => { if (coverPreviewBackupProbe === probe) clearCoverPreviewProbe(); };
      probe.src = backupUrl;
    }, COVER_LOAD_TIMEOUT);
    loader.src = source;
  };
  setUiText($('coverPreviewStatus'), 'Wczytuję okładkę…', 'Loading cover…');
  if (immediate) load();
  else coverPreviewTimer = setTimeout(() => load(), 200);
}
// Wire the optional controls. Reveal a hidden platform group when native form
// validation needs to focus one of its checkboxes.
function initializeGameFormPresentation() {
  if (!gameFormPresentationAvailable) return;
  $('platformTabs').addEventListener('click', event => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !$('platformTabs').contains(tab)) return;
    activatePlatformGroup(tab.dataset.platformGroup);
  });
  $('platformTabs').addEventListener('keydown', event => {
    const tabs = [...$('platformTabs').querySelectorAll('[role="tab"]')];
    const current = event.target.closest('[role="tab"]');
    if (!current || !tabs.includes(current)) return;
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = tabs.indexOf(current);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    activatePlatformGroup(tabs[target].dataset.platformGroup, { focus: true });
  });
  $('platform').addEventListener('change', () => {
    validatePlatformSelection();
    updatePlatformSelectionSummary();
  });
  $('gameForm').addEventListener('invalid', event => {
    if (event.target.name !== 'platform') return;
    const group = getPlatformGroups().find(group => group.inputs.includes(event.target));
    if (group) activatePlatformGroup(group.name);
  }, true);
  $('coverUrl').addEventListener('input', () => updateCoverPreview());
  $('coverUrl').addEventListener('change', () => updateCoverPreview(true));
}
// Escape record values in both text and attributes. Card actions use data
// attributes so the grid can handle them after replacing its contents.
function renderGameCard({ game, platforms, coverUrl }) {
  const title = esc(game.title);
  const id = esc(game.id);
  const editionIcon = game.edition === 'Fizyczne i cyfrowe'
    ? `<span class="edition-icons" aria-hidden="true">${aeroIcon('disc-3')}${aeroIcon('download')}</span>`
    : aeroIcon(game.edition === 'Cyfrowe' ? 'download' : 'disc-3');
  const cover = coverUrl
    ? `<img class="cover-image" data-cover-id="${id}" src="${esc(coverUrl)}"` +
      ` alt="${uiText('Okładka gry', 'Game cover for')} ${title}" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="cover-title">${title}</div>`;
  const completed = game.status === 'Ograna';
  const inProgress = game.status === 'W trakcie';
  const statusClass = completed ? 'ograna' : inProgress ? 'w-trakcie' : '';
  const statusIcon = aeroIcon(completed ? 'check' : inProgress ? 'play' : 'circle');
  const statusLabel = esc(gameLabel('status', game.status || 'Do ogrania'));
  const platformChips = platforms
    .map(platform => `<span class="platform platform-chip">${esc(gameLabel('platform', platform))}</span>`)
    .join('');
  const editLabel = uiText('Edytuj', 'Edit');
  const deleteLabel = uiText('Usuń', 'Delete');
  const editButton = `<button class="icon-btn" title="${editLabel}" aria-label="${editLabel}"` +
    ` data-game-action="edit" data-game-id="${id}">${aeroIcon('pencil')}</button>`;
  const deleteButton = `<button class="icon-btn" title="${deleteLabel}" aria-label="${deleteLabel}"` +
    ` data-game-action="delete" data-game-id="${id}">${aeroIcon('trash-2')}</button>`;

  return '<article class="game-card">' +
    `<h3 class="game-title" title="${title}">${title}</h3>` +
    `<div class="cover">
    ${cover}
    </div>
    <div class="card-body">
    <div class="edition-meta">${editionIcon}<span>${esc(gameLabel('edition', game.edition || 'Fizyczne'))}</span></div>
    <div class="game-meta">${platformChips}</div>
    <div class="card-bottom"><span class="status ${statusClass}">${statusIcon}${statusLabel}</span>
    <div class="card-menu">${editButton}
    ${deleteButton}</div></div></div></article>`;
}
// Refresh summaries and filter options when the collection or language
// changes. Build the visible grid from the current query and cached cards.
function render() {
  const query = $('search').value.toLocaleLowerCase('pl');
  const platformFilter = $('platformFilter').value;
  const editionFilter = $('editionFilter').value;
  const statusFilter = $('statusFilter').value;
  const sort = $('sort').value;
  const collection = getCollectionMetadata();
  scheduleCoverBackups(collection);
  if (renderedCollectionMetadata !== collection) {
    $('gameTitleSuggestions').innerHTML = collection.titleOptions;
    const select = $('platformFilter');
    const oldPlatform = select.value;
    select.innerHTML = collection.platformOptions;
    if (collection.platforms.includes(oldPlatform)) select.value = oldPlatform;
    const total = games.length;
    const gameUnit = uiText(total === 1 ? 'gra' : total > 1 && total < 5 ? 'gry' : 'gier', total === 1 ? 'game' : 'games');
    $('statTotal').innerHTML = `${total} <small>${gameUnit}</small>`;
    $('statPlatforms').textContent = collection.platforms.length;
    $('statDone').innerHTML = `${collection.doneCount} <small>${uiText('gier', collection.doneCount === 1 ? 'game' : 'games')}</small>`;
    renderedCollectionMetadata = collection;
  }
  const sortedEntries = collection.sortedEntries.get(sort);
  const list = (sortedEntries ?? collection.entries).filter(entry =>
    (!query || entry.searchText.includes(query)) &&
    (!platformFilter || entry.platforms.includes(platformFilter)) &&
    (!editionFilter || (entry.game.edition || 'Fizyczne') === editionFilter || entry.game.edition === 'Fizyczne i cyfrowe') &&
    (!statusFilter || entry.game.status === statusFilter));
  if (!sortedEntries && (sort === 'title' || sort === 'newest')) {
    if (sort === 'title') list.sort(compareGameTitles);
    else list.sort((a, b) => (b.game.createdAt || 0) - (a.game.createdAt || 0));

    // Reuse the complete order without sorting hidden games on a narrow search.
    if (list.length === collection.entries.length) collection.sortedEntries.set(sort, list);
  }
  const resultUnit = uiText(list.length === 1 ? 'GRA' : list.length > 1 && list.length < 5 ? 'GRY' : 'GIER',
    list.length === 1 ? 'GAME' : 'GAMES');
  $('count').textContent = `${list.length} ${resultUnit}`;
  const grid = $('grid');
  clearCoverImageTracking();
  if (!list.length) {
    const isEmpty = !games.length;
    const title = isEmpty ? uiText('Twoja kolekcja zaczyna się tutaj', 'Your collection starts here')
      : uiText('Nie znaleziono gier', 'No games found');
    const message = isEmpty
      ? uiText('Dodaj pierwszą grę i miej wszystkie swoje zakupy na konsole pod ręką.',
        'Add your first game and keep your console collection in one place.')
      : uiText('Zmień wyszukiwanie lub filtry, aby zobaczyć więcej wyników.',
        'Change your search or filters to see more results.');
    const addFirstGame = isEmpty
      ? `<button class="primary" data-action="add-first">${aeroIcon('plus')}${uiText('Dodaj pierwszą grę', 'Add your first game')}</button>`
      : '';
    grid.innerHTML = `<div class="empty"><div class="empty-icon">${aeroIcon(isEmpty ? 'library-big' : 'search-x')}</div>
      <h2>${title}</h2>
      <p>${message}</p>
      ${addFirstGame}</div>`;
    return;
  }
  grid.innerHTML = list.map(entry => entry.cardHtml ??= renderGameCard(entry)).join('');
  trackCoverImages();
}
// Reference only known SVG symbols from the page's icon sprite.
const AERO_ICON_NAMES = new Set([
  'library-big', 'gamepad-2', 'circle-check', 'plus', 'search', 'pencil', 'trash-2',
  'disc-3', 'download', 'upload', 'log-out', 'external-link', 'x', 'check', 'shield-check',
  'triangle-alert', 'search-x', 'circle', 'play', 'eye', 'eye-off', 'menu', 'chevron-down'
]);
function aeroIcon(name) {
  if (!AERO_ICON_NAMES.has(name)) return '';
  return '<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="#ui-icon-' + name + '"></use></svg>';
}
// The configured API supplies the active challenge. A separate generation
// invalidates old widget callbacks each time the login screen is reset.
let captchaChallenge = null;
let captchaSolution = null;
let captchaSolvePromise = null;
let captchaGeneration = 0;
let turnstileScriptPromise = null;
let turnstileWidgetId = null;

function clearCaptchaWidget() {
  if (turnstileWidgetId !== null && window.turnstile) {
    try { window.turnstile.remove(turnstileWidgetId); } catch {}
  }
  turnstileWidgetId = null;
  $('captchaWidget').replaceChildren();
}

// Share the script load between callers and release failed loads for retry.
function loadTurnstileApi() {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.turnstileApi = 'true';
    script.onload = () => {
      if (window.turnstile) resolve();
      else {
        turnstileScriptPromise = null;
        script.remove();
        reject(uiError('Nie udało się uruchomić weryfikacji Turnstile.', 'Could not start Turnstile verification.'));
      }
    };
    script.onerror = () => {
      turnstileScriptPromise = null;
      script.remove();
      reject(uiError('Nie udało się załadować weryfikacji. Sprawdź połączenie i spróbuj ponownie.',
        'Could not load verification. Check your connection and try again.'));
    };
    document.head.append(script);
  });
  return turnstileScriptPromise;
}

function hasCaptchaChallenge(challenge) {
  return challenge?.provider === 'turnstile'
    ? typeof challenge.siteKey === 'string' && challenge.siteKey.length > 0
    : typeof challenge?.nonce === 'string' && challenge.nonce.length > 0;
}

// Older API responses can carry a proof-of-work nonce. Yield between bounded
// batches of hashes to keep the form responsive while solving the challenge.
async function solveAutomaticCaptcha(challenge) {
  if (!globalThis.crypto?.subtle || !globalThis.TextEncoder) {
    throw uiError('Automatyczna weryfikacja wymaga aktualnej przeglądarki i połączenia HTTPS.',
      'Automatic verification requires an up-to-date browser and an HTTPS connection.');
  }
  const difficulty = Math.max(1, Math.min(4, Number(challenge.difficulty) || 3));
  const encoder = new TextEncoder();
  const maxAttempts = 2000000;
  const batchSize = 128;
  const fullZeroBytes = Math.floor(difficulty / 2);
  const needsZeroNibble = difficulty % 2 === 1;
  for (let batchStart = 0; batchStart < maxAttempts; batchStart += batchSize) {
    const batchLength = Math.min(batchSize, maxAttempts - batchStart);
    const candidates = Array.from({ length: batchLength }, (_, index) => {
      const counter = batchStart + index;
      return { counter, data: encoder.encode(`${challenge.nonce}:${counter}`) };
    });
    const digests = await Promise.all(candidates.map(candidate =>
      crypto.subtle.digest('SHA-256', candidate.data)
    ));
    for (let index = 0; index < digests.length; index++) {
      const digest = new Uint8Array(digests[index]);
      let matches = true;
      for (let byte = 0; byte < fullZeroBytes; byte++) {
        if (digest[byte] !== 0) { matches = false; break; }
      }
      if (matches && needsZeroNibble && (digest[fullZeroBytes] & 0xf0) !== 0) matches = false;
      if (matches) return String(candidates[index].counter);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw uiError('Nie udało się przygotować automatycznej weryfikacji. Odśwież stronę.',
    'Could not prepare automatic verification. Reload the page.');
}
// Keep submit disabled until the current challenge produces a usable answer.
// Turnstile expiry clears the token so it cannot be reused by a later attempt.
function prepareCaptcha(challenge) {
  const isTurnstile = challenge?.provider === 'turnstile';
  if (!hasCaptchaChallenge(challenge)) {
    $('loginButton').disabled = true;
    setUiText($('captchaStatus'), 'Brak danych weryfikacji. Odśwież stronę.',
      'Verification details are missing. Reload the page.');
    $('retryConnection').hidden = false;
    return;
  }
  const generation = ++captchaGeneration;
  clearCaptchaWidget();
  captchaChallenge = challenge;
  captchaSolution = null;
  setUiText($('authIntro'),
    isTurnstile ? 'Wpisz dane konta i potwierdź weryfikację, jeśli zostaniesz o to poproszony.'
      : 'Wpisz dane konta. Automatyczna kontrola antybotowa działa w tle.',
    isTurnstile ? 'Enter your account details and complete verification if prompted.'
      : 'Enter your account details. Bot verification runs in the background.');
  $('loginButton').disabled = true;
  setUiText($('loginButton'), 'Sprawdzam zabezpieczenie…', 'Verifying…');
  $('retryConnection').hidden = true;
  setUiText($('captchaStatus'), 'Trwa automatyczna weryfikacja zabezpieczenia…', 'Running automatic verification…');
  if (isTurnstile) {
    captchaSolvePromise = null;
    loadTurnstileApi().then(() => {
      if (generation !== captchaGeneration) return;
      turnstileWidgetId = window.turnstile.render('#captchaWidget', {
        sitekey: challenge.siteKey,
        action: 'login',
        theme: 'auto',
        language: uiLanguage,
        callback: token => {
          if (generation !== captchaGeneration) return;
          captchaSolution = token;
          setUiText($('captchaStatus'), 'Weryfikacja gotowa.', 'Verification complete.');
          $('loginButton').disabled = false;
          setUiText($('loginButton'), 'Zaloguj się', 'Sign in');
          $('retryConnection').hidden = true;
        },
        'expired-callback': () => {
          if (generation !== captchaGeneration) return;
          captchaSolution = null;
          setUiText($('captchaStatus'), 'Weryfikacja wygasła. Rozwiąż ją ponownie.',
            'Verification expired. Complete it again.');
          $('loginButton').disabled = true;
          try { window.turnstile.reset(turnstileWidgetId); } catch {}
        },
        'error-callback': () => {
          if (generation !== captchaGeneration) return;
          captchaSolution = null;
          setUiText($('captchaStatus'), 'Weryfikacja jest chwilowo niedostępna.', 'Verification is temporarily unavailable.');
          $('loginButton').disabled = true;
          $('retryConnection').hidden = false;
        }
      });
      setUiText($('captchaStatus'), 'Potwierdź weryfikację zabezpieczenia.', 'Complete the security check.');
    }).catch(error => {
      if (generation !== captchaGeneration) return;
      setUiText($('captchaStatus'), ...uiErrorText(error));
      $('retryConnection').hidden = false;
    });
    return;
  }
  captchaSolvePromise = solveAutomaticCaptcha(challenge).then(solution => {
    if (generation === captchaGeneration) {
      captchaSolution = solution;
      setUiText($('captchaStatus'), 'Automatyczna weryfikacja gotowa.', 'Automatic verification complete.');
      $('loginButton').disabled = false;
      setUiText($('loginButton'), 'Zaloguj się', 'Sign in');
      $('retryConnection').hidden = true;
    }
    return solution;
  }).catch(error => {
    if (generation === captchaGeneration) {
      setUiText($('captchaStatus'), ...uiErrorText(error));
      $('loginButton').disabled = true;
      setUiText($('loginButton'), 'Zaloguj się', 'Sign in');
      $('retryConnection').hidden = false;
    }
    return null;
  });
}
// Keep the optional visibility control and its accessible state in sync.
function setLoginPasswordVisibility(visible) {
  $('loginPassword').type = visible ? 'text' : 'password';
  const button = $('toggleLoginPassword');
  if (!button) return;
  button.setAttribute('aria-pressed', String(visible));
  bindUiText(button, 'aria-label', visible ? 'Ukryj hasło' : 'Pokaż hasło',
    visible ? 'Hide password' : 'Show password');
  const icon = button.querySelector('use');
  if (icon) icon.setAttribute('href', visible ? '#ui-icon-eye-off' : '#ui-icon-eye');
  else setUiText(button, visible ? 'Ukryj' : 'Pokaż', visible ? 'Hide' : 'Show');
}
function clearLoginPassword() {
  $('loginPassword').value = '';
  setLoginPasswordVisibility(false);
}
function initializeLoginPresentation() {
  const button = $('toggleLoginPassword');
  if (!button) return;
  setLoginPasswordVisibility(false);
  button.addEventListener('click', () => setLoginPasswordVisibility($('loginPassword').type === 'password'));
}
// The action menu is a keyboard-accessible disclosure over existing buttons.
// Restore focus only while the user can still interact with the collection.
function closeAppMenu(restoreFocus = false) {
  const menu = $('appMenu'), toggle = $('appMenuToggle');
  if (!menu || !toggle) return;
  const wasOpen = !menu.hidden;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus && wasOpen && !$('appShell').hidden && !logoutPending) toggle.focus();
}
function setAppMenuOpen(open) {
  const menu = $('appMenu'), toggle = $('appMenuToggle');
  if (!menu || !toggle) return;
  if (!open || $('appShell').hidden || logoutPending || !authenticated) { closeAppMenu(); return; }
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
}
// Arrow navigation visits menu actions and category summaries. Native fields
// inside a category retain their own arrow, Home and End behavior.
function appMenuNavigationItems(menu) {
  return Array.from(menu.querySelectorAll('button.app-menu-item, summary'))
    .filter(item => !item.disabled && !item.closest('[hidden]'));
}
function handleAppMenuKeydown(event) {
  const container = $('appMenuContainer'), menu = $('appMenu'), toggle = $('appMenuToggle');
  if (!container || !menu || !toggle) return false;
  const target = document.activeElement;
  if (event.key === 'Escape' && !menu.hidden) {
    event.preventDefault();
    closeAppMenu(true);
    return true;
  }
  if (target === toggle && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    setAppMenuOpen(true);
    const items = appMenuNavigationItems(menu);
    if (!menu.hidden && items.length) items[event.key === 'ArrowDown' ? 0 : items.length - 1].focus();
    return true;
  }
  if (!menu.hidden && menu.contains(target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    if (target?.closest?.('input, select, textarea')) return false;
    const items = appMenuNavigationItems(menu);
    if (!items.length) return false;
    event.preventDefault();
    const current = items.indexOf(target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
    return true;
  }
  return false;
}
function initializeAppMenu() {
  const container = $('appMenuContainer'), menu = $('appMenu'), toggle = $('appMenuToggle');
  if (!container || !menu || !toggle || container.dataset.menuInitialized === 'true') return;
  container.dataset.menuInitialized = 'true';
  closeAppMenu();
  toggle.addEventListener('click', () => setAppMenuOpen(menu.hidden));
  // Capture closes the disclosure before the unchanged import/export/logout
  // handlers run. In particular the file picker keeps the original user gesture.
  menu.addEventListener('click', event => {
    if (event.target?.closest?.('button.app-menu-item')) closeAppMenu(true);
  }, true);
  container.addEventListener('focusout', event => {
    // Native color/select popups can transfer focus outside the DOM temporarily.
    // An actual outside click or Tab to another element still closes the menu.
    if (!event.relatedTarget && event.target?.matches?.('input, select, textarea')) return;
    if (!container.contains(event.relatedTarget)) closeAppMenu();
  });
  document.addEventListener('click', event => {
    if (!container.contains(event.target)) closeAppMenu();
  });
}
// A fresh login screen starts with its previous challenge discarded.
function showLogin() {
  closeAppMenu();
  setLoginPasswordVisibility(false);
  clearSessionCaptcha();
  $('appShell').hidden = true;
  $('authScreen').hidden = false;
  setUiText($('authTitle'), 'Zaloguj się', 'Sign in');
  setUiText($('authIntro'), 'Wpisz dane konta. Automatyczna kontrola antybotowa działa w tle.',
    'Enter your account details. Bot verification runs in the background.');
  $('loginForm').hidden = false;
  $('websiteField').value = '';
  setUiText($('authMessage'), '');
  $('retryConnection').hidden = true;
  $('loginButton').disabled = true;
  setUiText($('loginButton'), 'Sprawdzam zabezpieczenie…', 'Verifying…');
  setUiText($('captchaStatus'), 'Przygotowuję automatyczną weryfikację…', 'Preparing automatic verification…');
  $('loginUsername').focus();
}
function showAuthError(message, connectionError = false, english) {
  closeAppMenu();
  setLoginPasswordVisibility(false);
  clearSessionCaptcha();
  $('loginButton').disabled = true;
  $('appShell').hidden = true;
  $('authScreen').hidden = false;
  setUiText($('authTitle'), connectionError ? 'Brak połączenia z aplikacją' : 'Nie udało się zalogować',
    connectionError ? 'Could not connect to the application' : 'Could not sign in');
  setUiText($('authIntro'), '');
  $('loginForm').hidden = true;
  setUiText($('authMessage'), message, english);
  $('retryConnection').hidden = !connectionError;
}
// Logout and expiry clear collection records, rendered cards, form drafts,
// search options, and previews. Cancel view timers and image work as well.
function clearPrivateData() {
  clearSessionPolicy();
  closeAppMenu();
  clearCoverBackups();
  games = [];
  collectionMetadataCache = null;
  renderedCollectionMetadata = null;
  $('appShell').hidden = true;
  $('grid').replaceChildren();
  $('gameTitleSuggestions').replaceChildren();
  $('platformFilter').innerHTML = `<option value="">${uiText('Wszystkie konsole', 'All platforms')}</option>`;
  ['search', 'platformFilter', 'editionFilter', 'statusFilter'].forEach(id => { $(id).value = ''; });
  $('sort').value = 'newest';
  $('count').textContent = uiText('0 GIER', '0 GAMES');
  $('statTotal').innerHTML = uiText('0 <small>gier</small>', '0 <small>games</small>');
  $('statPlatforms').textContent = '0';
  $('statDone').innerHTML = uiText('0 <small>gier</small>', '0 <small>games</small>');
  clearTimeout(toastTimer);
  setUiText($('toast'), '');
  $('toast').classList.remove('show');
  $('gameForm').reset();
  setPlatformSelection();
  $('gameId').value = '';
  $('importFile').value = '';
  updateCoverSearchLinks();
  closeModal();
  $('loginUsername').value = '';
  clearLoginPassword();
  $('websiteField').value = '';
}
// Invalidate callbacks before removing the widget so stale verification cannot
// enable sign-in or hide Retry after the form has been replaced by an error.
function clearSessionCaptcha() {
  captchaGeneration++;
  clearCaptchaWidget();
  captchaChallenge = null;
  captchaSolution = null;
  captchaSolvePromise = null;
}
function handleSessionExpired(payload) {
  sessionGeneration++;
  authenticated = false;
  clearPrivateData();
  showLogin();
  if (hasCaptchaChallenge(payload?.captcha)) prepareCaptcha(payload.captcha);
  else showAuthError('Sesja wygasła. Połącz się ponownie, aby się zalogować.', true,
    'Your session expired. Reconnect to sign in.');
}
function showLogoutStatus(error = null) {
  $('appShell').hidden = true;
  $('authScreen').hidden = false;
  setUiText($('authTitle'), error ? 'Wylogowanie niepotwierdzone' : 'Wylogowywanie…',
    error ? 'Sign-out could not be confirmed' : 'Signing out…');
  setUiText($('authIntro'),
    error ? 'Dane kolekcji są ukryte. Ponów wylogowanie po odzyskaniu połączenia.'
      : 'Dane kolekcji są ukryte. Czekam na potwierdzenie wylogowania z serwera.',
    error ? 'Your collection is hidden. Try signing out again when you reconnect.'
      : 'Your collection is hidden while the server confirms sign-out.');
  $('loginForm').hidden = true;
  setUiText($('captchaStatus'), '');
  setUiText($('authMessage'), ...uiErrorText(error));
  $('retryConnection').hidden = !error;
}
// A restored cookie must not bypass the fresh-login marker. Keep the screen
// locked until the server confirms logout and the user logs in again.
function lockUnexpectedSession() {
  sessionGeneration++;
  authenticated = false;
  logoutPending = true;
  freshLoginRequired = true;
  storePendingLogout(true);
  storeFlag(FRESH_LOGIN_REQUIRED_KEY, true);
  clearPrivateData();
  clearSessionCaptcha();
  showLogoutStatus(uiError('Serwer nadal zwraca aktywną sesję. Ponów wylogowanie przed nowym logowaniem.',
    'The server still reports an active session. Sign out again before signing in.'));
}
async function settlePendingRequests(requests) {
  if (!requests.length) return;
  let timer;
  try {
    await Promise.race([
      Promise.allSettled(requests),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(uiError('Wcześniejsze żądania jeszcze się nie zakończyły. Spróbuj ponownie wylogować aplikację.',
            'Earlier requests are still running. Try signing out again.'));
        }, 15000);
      })
    ]);
  } finally { clearTimeout(timer); }
}
// Hide and clear local data before contacting the server. Leave the pending
// marker set until confirmation so reloading or retrying cannot reveal it.
async function performLogout() {
  if (logoutRequest) return logoutRequest;
  logoutPending = true;
  freshLoginRequired = true;
  storePendingLogout(true);
  storeFlag(FRESH_LOGIN_REQUIRED_KEY, true);
  const generation = ++sessionGeneration;
  authenticated = false;
  clearPrivateData();
  clearSessionCaptcha();
  showLogoutStatus();
  const outstanding = [...activeApiRequests];
  const attempt = (async () => {
    try {
      // Wait for older login responses (including Set-Cookie) before the final
      // logout. Aborting a browser fetch alone does not cancel server work.
      await settlePendingRequests(outstanding);
      ensureCurrentSession(generation, true);
      await apiRequest('POST', { action: 'logout' }, generation);
      ensureCurrentSession(generation, true);
      logoutPending = false;
      storePendingLogout(false);
      logoutRequest = null;
      await initialize();
    } catch (error) {
      if (generation !== sessionGeneration || ignoredSessionError(error)) return;
      showLogoutStatus(error);
    } finally {
      if (logoutRequest === attempt) logoutRequest = null;
    }
  })();
  logoutRequest = attempt;
  return attempt;
}
// Move legacy records only inside a confirmed session. Preserve the browser
// copy if migration fails so the user can retry without losing it.
async function acceptAuthenticated(initialGames, generation = sessionGeneration) {
  ensureCurrentSession(generation);
  authenticated = true;
  clearLoginPassword();
  captchaGeneration++;
  clearCaptchaWidget();
  captchaChallenge = null;
  captchaSolution = null;
  captchaSolvePromise = null;
  const legacyGames = readLegacyGames();
  let migrationNotice;
  let nextGames = initialGames;
  if (legacyGames.length) {
    try {
      const migration = await apiRequest('POST', { action: 'migrate', games: legacyGames }, generation);
      ensureCurrentSession(generation);
      nextGames = migration.games;
      try { localStorage.removeItem(LEGACY_KEY); } catch {}
      if (migration.inserted > 0) {
        const unit = migration.inserted === 1 ? 'game' : 'games';
        migrationNotice = [
          `Przeniesiono ${migration.inserted} gier do bazy danych`,
          `Moved ${migration.inserted} ${unit} to the database`
        ];
      }
    } catch (error) {
      if (ignoredSessionError(error) || generation !== sessionGeneration) throw error;
      const [polish, english] = uiErrorText(error);
      migrationNotice = [
        `Nie udało się przenieść starszej kolekcji. Kopia w przeglądarce została zachowana. ${polish}`,
        `Could not move the older collection. The copy in your browser was kept. ${english}`
      ];
    }
  }
  ensureCurrentSession(generation);
  games = nextGames;
  setConnectionStatus('zapis w bazie danych', false, 'saved in the database');
  if (!sessionPolicy) { void performLogout(); throw staleSessionError(); }
  $('appShell').hidden = privacySuspended;
  $('authScreen').hidden = !privacySuspended;
  armSessionTimers();
  render();
  if (migrationNotice) notify(...migrationNotice);
}
// Recover a pending logout first, then ask the API whether it can resume an
// existing session or needs to provide a challenge for a new login.
async function initialize() {
  if (logoutPending) return performLogout();
  const generation = sessionGeneration;
  if (location.protocol === 'file:') {
    showAuthError('Aplikacja została otwarta jako plik. Zalogowanie wymaga strony uruchomionej na hostingu z PHP.', true,
      'The application was opened as a file. Serve the page from a PHP host to sign in.');
    return;
  }
  try {
    const initial = await apiRequest('GET', undefined, generation);
    ensureCurrentSession(generation);
    if (freshLoginRequired || readStoredFlag(FRESH_LOGIN_REQUIRED_KEY)) {
      lockUnexpectedSession();
      return;
    }
    await acceptAuthenticated(initial.games, generation);
  } catch (error) {
    if (ignoredSessionError(error) || generation !== sessionGeneration || logoutPending) return;
    if (error.status === 401) {
      if (!hasCaptchaChallenge(error.payload?.captcha)) {
        showAuthError('Serwer ma starszą wersję API logowania i nie udostępnia CAPTCHA. Wgraj aktualny plik api/games.php z projektu i odśwież stronę.', true,
          'The server uses an older sign-in API without CAPTCHA. Upload the current api/games.php from the project and reload the page.');
        return;
      }
      showLogin();
      prepareCaptcha(error.payload?.captcha);
      return;
    }
    const [polish, english] = uiErrorText(error);
    setConnectionStatus('brak połączenia z bazą', true, 'database connection unavailable');
    showAuthError(`${polish} Upewnij się, że strona działa przez HTTPS na serwerze PHP z poprawną konfiguracją bazy.`, true,
      `${english} Make sure the site uses HTTPS on a PHP server with the correct database configuration.`);
  }
}
// Consume the challenge once. Clear the password field as soon as the request
// captures it, and ignore callbacks from a login that no longer owns the form.
async function submitLogin(event) {
  event.preventDefault();
  if ($('loginButton').disabled) return;
  const generation = sessionGeneration;
  $('loginButton').disabled = true;
  setUiText($('loginButton'), 'Sprawdzam zabezpieczenie…', 'Verifying…');
  setUiText($('authMessage'), '');
  setUiText($('captchaStatus'), 'Trwa automatyczna weryfikacja zabezpieczenia…', 'Running automatic verification…');
  let requestSent = false;
  try {
    if (!captchaChallenge) {
      throw uiError('Odśwież stronę, aby uruchomić automatyczną weryfikację.', 'Reload the page to start automatic verification.');
    }
    const challenge = captchaChallenge;
    const solution = challenge.provider === 'turnstile'
      ? captchaSolution
      : captchaSolution || (captchaSolvePromise ? await captchaSolvePromise : null);
    ensureCurrentSession(generation);
    if (!solution) {
      throw uiError('Automatyczna weryfikacja nie powiodła się. Odśwież stronę.', 'Automatic verification failed. Reload the page.');
    }
    captchaChallenge = null;
    captchaSolution = null;
    captchaSolvePromise = null;
    requestSent = true;
    const loginRequest = apiRequest('POST', {
      action: 'login',
      username: $('loginUsername').value,
      password: $('loginPassword').value,
      website: $('websiteField').value,
      captcha: challenge.provider === 'turnstile'
        ? { token: solution }
        : { nonce: challenge.nonce, solution }
    }, generation);
    clearLoginPassword();
    const result = await loginRequest;
    ensureCurrentSession(generation);
    freshLoginRequired = false;
    storeFlag(FRESH_LOGIN_REQUIRED_KEY, false);
    await acceptAuthenticated(result.games, generation);
  } catch (error) {
    if (ignoredSessionError(error) || generation !== sessionGeneration || logoutPending) return;
    showAuthenticatedError(...uiErrorText(error));
    if (error.payload?.captcha) prepareCaptcha(error.payload.captcha);
    else {
      setUiText($('captchaStatus'),
        requestSent ? 'Weryfikacja została zużyta. Uruchom ją ponownie, aby spróbować zalogować się jeszcze raz.'
          : 'Automatyczna weryfikacja nie powiodła się. Uruchom ją ponownie.',
        requestSent ? 'This verification has been used. Complete it again to retry sign-in.'
          : 'Automatic verification failed. Start it again.');
      $('retryConnection').hidden = false;
    }
  } finally {
    if (generation === sessionGeneration) {
      clearLoginPassword();
      if (!logoutPending) {
        $('loginButton').disabled = !captchaSolution;
        setUiText($('loginButton'), 'Zaloguj się', 'Sign in');
      }
    }
  }
}
function showAuthenticatedError(message, english) {
  setUiText($('authMessage'), message, english);
}
$('loginForm').addEventListener('submit', submitLogin);
$('retryConnection').onclick = () => {
  if (logoutPending) return performLogout();
  if (privacySuspended && authenticated) return revalidatePrivateSession();
  return initialize();
};
$('logoutBtn').onclick = performLogout;
// Propagate logout locks to other tabs that share the same session cookie.
addEventListener('storage', event => {
  if (event.key === FRESH_LOGIN_REQUIRED_KEY && event.newValue === '1') freshLoginRequired = true;
  if (event.key === PENDING_LOGOUT_KEY && event.newValue === '1' && !logoutPending) performLogout();
});
// Use one form for new and existing games. Clear stale previews and selections
// before populating an edit, then focus the title in the current session.
function openModal(game) {
  if (!privateViewUsable()) return;
  closeAppMenu();
  clearCoverPreview();
  resolveDeleteConfirmation(false);
  const generation = sessionGeneration;
  $('gameForm').reset();
  setPlatformSelection(game?.platform);
  $('gameId').value = game?.id || '';
  setUiText($('modalTitle'), game ? 'Edytuj grę' : 'Dodaj grę do kolekcji',
    game ? 'Edit game' : 'Add a game to your collection');
  setUiText($('modalBackdrop').querySelector('.modal-sub'),
    game ? 'Uzupełnij szczegóły swojego egzemplarza.' : 'Nowy tytuł, kolejny zapis w Twojej bibliotece.',
    game ? 'Update the details of your copy.' : 'Add another title to your library.');
  if (game) {
    $('title').value = game.title;
    $('edition').value = game.edition || 'Fizyczne';
    $('coverUrl').value = game.coverUrl || '';
    $('status').value = game.status || 'Do ogrania';
  }
  updateCoverSearchLinks();
  $('modalBackdrop').classList.add('open');
  $('gameForm').querySelector('.form-grid').scrollTop = 0;
  updateCoverPreview(true);
  setTimeout(() => {
    if (generation === sessionGeneration && !logoutPending && $('modalBackdrop').classList.contains('open')) $('title').focus();
  }, 40);
}
// A single pending promise represents the delete dialog. Dismissal, another
// action, and logout resolve it without allowing the old delete to proceed.
let pendingDeleteConfirmation = null;
function resolveDeleteConfirmation(confirmed) {
  const pending = pendingDeleteConfirmation;
  pendingDeleteConfirmation = null;
  $('deleteModalBackdrop').classList.remove('open');
  setUiText($('deleteGameName'), '');
  setUiText($('deleteGamePlatforms'), '');
  if (pending) {
    if (!logoutPending && !$('appShell').hidden && pending.focusTarget?.isConnected) pending.focusTarget.focus();
    pending.resolve(confirmed === true);
  }
}
function confirmGameDeletion(game) {
  closeAppMenu();
  resolveDeleteConfirmation(false);
  if (!privateViewUsable()) return Promise.resolve(false);
  closeModal();
  setUiText($('deleteGameName'), '„' + game.title + '”', '“' + game.title + '”');
  const platforms = gamePlatforms(game.platform);
  setUiText($('deleteGamePlatforms'), platforms.join(' · '),
    platforms.map(platform => englishGameLabels.platform.get(platform) ?? platform).join(' · '));
  const promise = new Promise(resolve => { pendingDeleteConfirmation = { resolve, focusTarget: document.activeElement }; });
  $('deleteModalBackdrop').classList.add('open');
  $('deleteCancelButton').focus();
  return promise;
}
function closeModal() {
  $('modalBackdrop').classList.remove('open');
  clearCoverPreview();
  $('gameForm').reset();
  updateCoverSearchLinks();
  setPlatformSelection();
  $('gameId').value = '';
  resolveDeleteConfirmation(false);
}
// Card actions look up the current record by ID before opening a dialog.
window.openModal = openModal;
window.editGame = id => {
  const game = games.find(item => item.id === id);
  if (game) openModal(game);
};
window.deleteGame = async id => {
  const generation = sessionGeneration;
  const game = games.find(item => item.id === id);
  if (!game) return;
  try {
    if (!await confirmGameDeletion(game)) return;
    ensureCurrentSession(generation);
    const result = await apiRequest('POST', { action: 'delete', id }, generation);
    ensureCurrentSession(generation);
    games = result.games;
    render();
    notify('Gra usunięta z kolekcji', 'Game removed from your collection');
  } catch (error) {
    if (!ignoredSessionError(error) && generation === sessionGeneration && !logoutPending) notify(...uiErrorText(error));
  }
};
// Delegate events to the stable grid element. Capture is needed for load and
// error events from images, which do not bubble from the replacement cards.
$('grid').addEventListener('error', event => {
  if (!event.target.matches?.('img.cover-image')) return;
  useLocalCover(event.target);
}, true);
$('grid').addEventListener('load', event => {
  const state = coverImageStates.get(event.target);
  if (state) { clearTimeout(state.timer); state.timer = null; clearCoverProbe(state); }
}, true);
$('grid').addEventListener('click', event => {
  const button = event.target.closest('[data-action], [data-game-action]');
  if (!button || !$('grid').contains(button)) return;
  if (button.dataset.action === 'add-first') openModal();
  if (button.dataset.gameAction === 'edit') window.editGame(button.dataset.gameId);
  if (button.dataset.gameAction === 'delete') window.deleteGame(button.dataset.gameId);
});
$('addBtn').onclick = () => openModal();
$('title').addEventListener('input', () => {
  updateCoverSearchLinks();
  updateCoverPreviewTitle();
});
$('closeModal').onclick = closeModal;
$('cancelBtn').onclick = closeModal;
$('modalBackdrop').onclick = event => { if (event.target === $('modalBackdrop')) closeModal(); };
$('deleteClose').onclick = () => resolveDeleteConfirmation(false);
$('deleteCancelButton').onclick = () => resolveDeleteConfirmation(false);
$('deleteConfirmButton').onclick = () => resolveDeleteConfirmation(true);
$('deleteModalBackdrop').onclick = event => { if (event.target === $('deleteModalBackdrop')) resolveDeleteConfirmation(false); };
document.addEventListener('keydown', event => {
  if (handleAppMenuKeydown(event)) return;
  if (event.key === 'Escape') closeModal();
  if (event.key === 'Tab' && $('deleteModalBackdrop').classList.contains('open')) {
    const first = $('deleteClose'), last = $('deleteConfirmButton');
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
initializeGameFormPresentation();
// Keep an existing record's ID and creation time. Commit the UI update only
// after the server returns the saved collection for the current session.
$('gameForm').onsubmit = async event => {
  event.preventDefault();
  const generation = sessionGeneration;
  if (logoutPending) return;
  if (privacySuspended || (sessionPolicy && sessionRemaining() <= 0)) {
    try { await ensurePrivateSessionReady(generation); } catch { return; }
  }
  if (!validatePlatformSelection()) {
    const first = platformCheckboxes()[0];
    const group = getPlatformGroups().find(group => group.inputs.includes(first));
    if (group) activatePlatformGroup(group.name);
    first.reportValidity();
    return;
  }
  const id = $('gameId').value;
  const existing = games.find(game => game.id === id);
  const game = {
    id: id || crypto.randomUUID(),
    title: $('title').value.trim(),
    platform: getSelectedPlatforms().join(', '),
    edition: $('edition').value,
    coverUrl: safeImageUrl($('coverUrl').value),
    status: $('status').value,
    createdAt: existing?.createdAt || Date.now()
  };
  try {
    const result = await apiRequest('POST', { action: 'save', game }, generation);
    ensureCurrentSession(generation);
    games = result.games;
    render();
    closeModal();
    notify(id ? 'Zmiany zapisane' : 'Gra dodana do kolekcji', id ? 'Changes saved' : 'Game added to your collection');
  } catch (error) {
    if (!ignoredSessionError(error) && generation === sessionGeneration && !logoutPending) notify(...uiErrorText(error));
  }
};
['search', 'platformFilter', 'editionFilter', 'statusFilter', 'sort'].forEach(id =>
  $(id).addEventListener(id === 'search' ? 'input' : 'change', render));
// Export the current collection as a temporary browser download.
$('exportBtn').onclick = () => {
  if (!privateViewUsable()) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(games, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'savepoint-kolekcja.json';
  anchor.click();
  URL.revokeObjectURL(url);
  notify('Kopia kolekcji pobrana', 'Collection backup downloaded');
};
$('importBtn').onclick = () => { if (privateViewUsable()) $('importFile').click(); };
// Read and validate a bounded JSON file, then require explicit confirmation
// before asking the server to replace the current collection.
$('importFile').onchange = async event => {
  const file = event.target.files[0];
  if (!file) {
    event.target.value = '';
    return;
  }
  const generation = sessionGeneration;
  try {
    await ensurePrivateSessionReady(generation);
    ensureCurrentSession(generation);
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      throw uiError('Plik importu przekracza limit 1 MiB.', 'The import file exceeds the 1 MiB limit.');
    }
    let imported;
    try { imported = JSON.parse(await file.text()); }
    catch {
      throw uiError('Nie udało się odczytać pliku JSON. Wybierz poprawny eksport Savepoint.',
        'Could not read the JSON file. Choose a valid Savepoint export.');
    }
    ensureCurrentSession(generation);
    await ensurePrivateSessionReady(generation);
    if (!Array.isArray(imported) || imported.some(game => !game || !game.title || !game.platform)) {
      throw uiError('Plik JSON nie zawiera poprawnej kolekcji gier.', 'The JSON file does not contain a valid game collection.');
    }
    const count = imported.length;
    const unit = count === 1 ? 'game' : 'games';
    if (confirm(uiText(`Zaimportować ${count} gier? Obecna kolekcja zostanie zastąpiona.`,
      `Import ${count} ${unit}? This will replace your current collection.`))) {
      ensureCurrentSession(generation);
      const importedGames = imported.map(({ price, ...game }) => ({
        ...game,
        id: game.id || crypto.randomUUID(),
        createdAt: game.createdAt || Date.now()
      }));
      const result = await apiRequest('POST', { action: 'replace', games: importedGames }, generation);
      ensureCurrentSession(generation);
      games = result.games;
      render();
      notify('Kolekcja zaimportowana do bazy danych', 'Collection imported into the database');
    }
  } catch (error) {
    if (!ignoredSessionError(error) && generation === sessionGeneration && !logoutPending) {
      alert(uiText(...uiErrorText(error)) || uiText('Nie udało się zaimportować kolekcji.', 'Could not import the collection.'));
    }
  } finally {
    event.target.value = '';
  }
};

function initializeUiLanguage() {
  // data-en replaces textContent. Use it on text-only elements so translation
  // preserves any icons or controls in their parent elements.
  const translatedFields = [
    ['data-en', 'textContent'],
    ['data-en-aria-label', 'aria-label'],
    ['data-en-placeholder', 'placeholder'],
    ['data-en-title', 'title'],
    ['data-en-alt', 'alt'],
    ['data-en-label', 'label']
  ];
  for (const [attribute, field] of translatedFields) {
    for (const node of document.querySelectorAll(`[${attribute}]`)) {
      const polish = field === 'textContent' ? node.textContent : node.getAttribute(field);
      bindUiText(node, field, polish, node.getAttribute(attribute));
    }
  }

  document.documentElement?.setAttribute('lang', uiLanguage);
  const controls = document.querySelectorAll('[data-ui-language]');
  for (const control of controls) {
    control.value = uiLanguage;
    control.addEventListener('change', () => {
      const language = control.value === 'en' ? 'en' : 'pl';
      if (language === uiLanguage) return;
      uiLanguage = language;
      try { localStorage.setItem(LANGUAGE_KEY, language); } catch {}
      document.documentElement?.setAttribute('lang', language);
      for (const selector of controls) selector.value = language;
      for (const [node, fields] of uiBindings) {
        for (const [field, [polish, english]] of fields) applyUiText(node, field, uiText(polish, english));
      }
      if (gameFormPresentationAvailable) {
        const extra = $('platformOptions').querySelector('[data-extra-platforms] legend');
        if (extra) extra.textContent = uiText('Inne zapisane konsole', 'Other saved platforms');
        rebuildPlatformTabs();
        updatePlatformSelectionSummary();
        validatePlatformSelection();
      }
      if (authenticated && !$('appShell').hidden && !logoutPending && !privacySuspended) render();
      // Turnstile sets its language on creation. Rebuild it only when the
      // login form is visible so an error screen can keep its Retry action.
      if (!authenticated && !logoutPending && !$('loginForm').hidden && captchaChallenge?.provider === 'turnstile') {
        prepareCaptcha(captchaChallenge);
      }
    });
  }
}

// Install page controls before the first session request updates the UI.
initializeUiLanguage();
initializeAppMenu();
initializeLoginPresentation();
initializeSessionPrivacy();
initialize();
