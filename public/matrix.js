// Optional DOS desktop: locally drawn falling code with no external assets.
// Loading the module allocates no bitmap and schedules no animation.
(() => {
  'use strict';

  function createMatrixBackground(canvas, onFailure) {
    const glyphs = Array.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン<>+=:*');
    const layers = [
      { size: 13, brightness: 0.30, speed: 3.5, limit: 84 },
      { size: 16, brightness: 0.62, speed: 5.0, limit: 72 },
      { size: 20, brightness: 1.00, speed: 6.5, limit: 60 }
    ];
    let context = null;
    let streams = [];
    let width = 0;
    let height = 0;
    let ratio = 1;
    let elapsed = 0;
    let lastTimestamp = null;
    let lastPaint = -Infinity;
    let frame = null;
    let playing = false;
    let disposed = false;
    let failed = false;
    let failureReported = false;

    function releaseBitmap() {
      try { if (canvas) canvas.width = canvas.height = 1; } catch {}
    }
    function stop() {
      playing = false;
      lastTimestamp = null;
      if (frame !== null) {
        try { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame); } catch {}
        frame = null;
      }
    }
    function fail() {
      if (disposed || failed) return;
      failed = true;
      stop();
      streams = [];
      releaseBitmap();
      if (!failureReported) {
        failureReported = true;
        try { if (typeof onFailure === 'function') onFailure(); } catch {}
      }
    }

    // A stable hash gives each column its own depth, length, speed and symbols.
    // Glyph changes depend on scene time, so pausing freezes the complete frame.
    function hash(a, b = 0) {
      let value = Math.imul(a + 1, 374761393) ^ Math.imul(b + 7, 668265263);
      value = Math.imul(value ^ (value >>> 13), 1274126177);
      return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
    }
    // Reuse each column's normalized cycle position when the desktop resizes;
    // changing its row count must not restart the falling-code sequence.
    function makeStreams() {
      const previous = new Map(streams.map(stream => [stream.key, stream]));
      const scale = Math.max(0.9, Math.min(width / 1280, height / 720));
      streams = [];
      layers.forEach((layer, depth) => {
        const size = layer.size * scale;
        const count = Math.min(layer.limit, Math.max(1, Math.ceil(width / (size * 0.94))));
        const spacing = width / count;
        for (let column = 0; column < count; column += 1) {
          const key = depth * 1000 + column;
          const old = previous.get(key);
          const length = 12 + Math.floor(hash(key, 1) * 31);
          streams.push({
            key, size, spacing, x: (column + 0.5) * spacing,
            brightness: layer.brightness * (0.72 + hash(key, 2) * 0.28),
            speed: layer.speed * (0.65 + hash(key, 3) * 1.05),
            length, rows: height / size,
            gap: 4 + hash(key, 4) * 12,
            phase: old?.phase ?? hash(key, 5),
            mutationRate: 2.5 + hash(key, 6) * 4.5
          });
        }
      });
    }

    function advance(delta) {
      elapsed += delta;
      for (const stream of streams) {
        const cycle = stream.rows + stream.length + stream.gap;
        stream.phase = (stream.phase + delta * stream.speed / cycle) % 1;
      }
    }
    function render() {
      if (disposed || failed || width < 1 || height < 1) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.globalAlpha = 1;
      context.shadowBlur = 0;
      context.fillStyle = '#000000';
      context.fillRect(0, 0, width, height);
      context.textAlign = 'center';
      context.textBaseline = 'middle';

      // Draw complete tails instead of accumulating transparent frames. This
      // keeps resize, pause and low frame rates from changing the fade profile.
      for (const stream of streams) {
        const head = stream.phase * (stream.rows + stream.length + stream.gap) - stream.gap;
        const mutation = Math.floor(elapsed * stream.mutationRate);
        context.font = `${stream.size}px "Courier New", "Noto Sans Mono", monospace`;
        for (let tail = stream.length - 1; tail >= 0; tail -= 1) {
          const y = (head - tail) * stream.size;
          if (y < -stream.size || y > height + stream.size) continue;
          const fade = Math.pow(1 - tail / stream.length, 1.65);
          const shimmer = 0.55 + hash(stream.key + tail * 17, 8) * 0.45;
          const brightness = stream.brightness * fade * shimmer;
          if (tail === 0) {
            context.fillStyle = stream.brightness > 0.6 ? '#d8ffdf' : '#79d994';
            context.globalAlpha = Math.min(1, stream.brightness + 0.14);
          } else {
            context.fillStyle = `rgb(${Math.round(8 + brightness * 13)},${Math.round(40 + brightness * 194)},${Math.round(14 + brightness * 49)})`;
            context.globalAlpha = 1;
          }
          const character = glyphs[Math.floor(hash(stream.key + tail * 71, mutation) * glyphs.length)];
          context.fillText(character, stream.x, y);
        }
      }
      context.globalAlpha = 1;
    }

    // The first resumed frame advances by zero; time spent in another theme or
    // a hidden tab never becomes a jump. Expensive text paints are capped at 24fps.
    function tick(timestamp) {
      frame = null;
      if (!playing || disposed || failed) return;
      try {
        const delta = lastTimestamp === null ? 0
          : Math.min(0.08, Math.max(0, (timestamp - lastTimestamp) / 1000));
        lastTimestamp = timestamp;
        advance(delta);
        if (elapsed - lastPaint >= 1 / 24) {
          render();
          lastPaint = elapsed;
        }
        frame = requestAnimationFrame(tick);
      } catch { fail(); }
    }
    function setPlaying(value) {
      if (disposed || failed) return;
      const next = Boolean(value);
      if (next === playing) return;
      if (!next) { stop(); return; }
      playing = true;
      lastTimestamp = null;
      lastPaint = -Infinity;
      try { frame = requestAnimationFrame(tick); } catch { fail(); }
    }
    function resize() {
      if (disposed || failed) return false;
      try {
        const rectangle = canvas.getBoundingClientRect();
        const sourceWidth = Number(rectangle.width);
        const sourceHeight = Number(rectangle.height);
        if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
          throw new Error('Matrix desktop dimensions must be finite.');
        }
        // A newly selected theme can still be hidden during this refresh. Wait
        // for its visible resize without treating a zero-sized stage as failure.
        if (sourceWidth < 1 || sourceHeight < 1) return true;
        const nextWidth = Math.min(16384, sourceWidth);
        const nextHeight = Math.min(16384, sourceHeight);
        const dpr = Number(window.devicePixelRatio) || 1;
        // Text positions use logical pixels; backing density bounds bitmap
        // memory independently of the layer limits that bound glyph work.
        const nextRatio = Math.min(Math.max(0.1, dpr), 1.5,
          Math.sqrt(1400000 / (nextWidth * nextHeight)));
        if (width === nextWidth && height === nextHeight && ratio === nextRatio) return true;
        width = nextWidth;
        height = nextHeight;
        ratio = nextRatio;
        canvas.width = Math.max(1, Math.floor(width * ratio));
        canvas.height = Math.max(1, Math.floor(height * ratio));
        makeStreams();
        render();
        return true;
      } catch { fail(); return false; }
    }
    function destroy() {
      if (disposed) return;
      stop();
      disposed = true;
      streams = [];
      context = null;
      releaseBitmap();
    }

    try { context = canvas?.getContext('2d', { alpha: false }); } catch {}
    if (!context) { fail(); return null; }
    if (!resize()) return null;
    return { resize, setPlaying, destroy };
  }

  window.SavepointMatrix = Object.freeze({ create: createMatrixBackground });
})();
