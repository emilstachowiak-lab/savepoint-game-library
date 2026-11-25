// Optional Classic 3 background. Loading this file allocates no canvas or animation.
(() => {
  'use strict';
  function createPipesBackground(canvas, onFailure) {
    let context;
    try { context = canvas?.getContext('2d', { alpha: false }); } catch {}
    if (!context) return null;

    const colors = [
      [60, 184, 184], [191, 35, 22], [73, 157, 49],
      [172, 181, 181], [201, 157, 43], [61, 107, 183]
    ];
    const bounds = [7, 4, 4];
    const spacing = 1.24;
    const radius = 0.115;
    const maxBitmapPixels = 2000000;
    const maxBitmapEdge = 4096;
    let seed = 19692000;
    let width = 0;
    let height = 0;
    let playing = false;
    let disposed = false;
    let failed = false;
    let frame = null;
    let lastTimestamp = null;
    let lastPaint = -1;
    let elapsed = 0;
    let sceneStarted = 0;
    let generation = 0;
    let routes = [];

    function stop() {
      playing = false;
      lastTimestamp = null;
      const pending = frame;
      frame = null;
      if (pending !== null && typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(pending); } catch {}
      }
    }

    function fail() {
      if (failed || disposed) return;
      failed = true;
      stop();
      routes = [];
      try { canvas.width = 1; canvas.height = 1; } catch {}
      try { if (typeof onFailure === 'function') onFailure(); } catch {}
    }

    function random() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    const integer = limit => Math.floor(random() * limit);
    const key = point => point.join(',');
    const world = point => point.map(value => value * spacing);
    const shade = (color, multiplier, white = 0) => 'rgb(' + color.map(channel =>
      Math.round(Math.min(255, channel * multiplier * (1 - white) + 255 * white))
    ).join(',') + ')';

    // Reserve grid positions across all pipes so routes grow into free space.
    // The first scene starts partly grown to keep a paused background useful.
    function newScene() {
      const occupied = new Set();
      routes = colors.map((color, routeIndex) => {
        let point = bounds.map(bound => integer(bound * 2 + 1) - bound);
        while (occupied.has(key(point))) point = bounds.map(bound => integer(bound * 2 + 1) - bound);
        occupied.add(key(point));
        const points = [world(point)];
        let previousAxis = -1;

        for (let step = 0; step < 48; step += 1) {
          let next = null;
          let axis = 0;
          for (let attempt = 0; attempt < 18 && !next; attempt += 1) {
            axis = integer(3);
            if (axis === previousAxis && random() < 0.68) axis = (axis + 1 + integer(2)) % 3;
            const candidate = point.slice();
            candidate[axis] += random() > 0.5 ? 1 : -1;
            if (Math.abs(candidate[axis]) <= bounds[axis] && !occupied.has(key(candidate))) next = candidate;
          }
          if (!next) break;
          point = next;
          previousAxis = axis;
          occupied.add(key(point));
          points.push(world(point));
        }

        return {
          points,
          initial: Math.min(points.length - 1, generation ? 3 + integer(6) : 17 + integer(15)),
          speed: 1.35 + routeIndex * 0.11,
          shades: {
            edge: shade(color, 0.15), shadow: shade(color, 0.34),
            base: shade(color, 0.87), light: shade(color, 1.1),
            shine: shade(color, 1, 0.57), joint: shade(color, 1, 0.78)
          }
        };
      });
      generation += 1;
      sceneStarted = elapsed;
    }

    function render() {
      if (disposed || failed) return;
      const age = elapsed - sceneStarted;
      if (age > 32) newScene();
      context.fillStyle = '#000';
      context.fillRect(0, 0, width, height);

      // Rotate the shared 3D grid, then project positions and pipe radii using
      // the same perspective depth so distant segments appear smaller.
      const yaw = 0.35 + Math.sin(elapsed * 0.045) * 0.095;
      const pitch = -0.19 + Math.cos(elapsed * 0.037) * 0.035;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const focal = Math.max(width * 0.9, height * 1.08);
      const project = point => {
        const x = point[0] * cy + point[2] * sy;
        const z = point[2] * cy - point[0] * sy;
        const y = point[1] * cp - z * sp;
        const depth = 15.5 + point[1] * sp + z * cp;
        return { x: width * 0.5 + x * focal / depth, y: height * 0.47 + y * focal / depth, depth, r: radius * focal / depth };
      };
      const items = [];

      for (const route of routes) {
        const progress = Math.min(route.points.length - 1, route.initial + (elapsed - sceneStarted) * route.speed);
        const full = Math.floor(progress);
        const points = route.points.slice(0, full + 1);
        if (full < route.points.length - 1) {
          const fraction = progress - full;
          points.push(route.points[full].map((value, axis) => value + (route.points[full + 1][axis] - value) * fraction));
        }
        const projected = points.map(project);
        for (let index = 0; index < projected.length; index += 1) {
          const point = projected[index];
          items.push({ type: 1, depth: point.depth, point, shades: route.shades });
          if (index) {
            const previous = projected[index - 1];
            items.push({ type: 0, depth: (previous.depth + point.depth) / 2, from: previous, to: point, shades: route.shades });
          }
        }
      }

      // Far surfaces paint first. The model uses short grid segments, keeping
      // this painter's approximation stable where projected paths cross.
      items.sort((a, b) => b.depth - a.depth || a.type - b.type);
      for (const item of items) {
        if (item.type === 1) {
          drawJoint(item.point, item.shades);
        } else {
          drawSegment(item.from, item.to, item.shades);
        }
      }
    }

    function drawSegment(from, to, shades) {
      const dx = to.x - from.x, dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.1) return;
      const r = (from.r + to.r) / 2;
      const nx = -dy / length, ny = dx / length;
      const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
      const surface = context.createLinearGradient(mx - nx * r, my - ny * r, mx + nx * r, my + ny * r);
      surface.addColorStop(0, shades.edge);
      surface.addColorStop(0.17, shades.shadow);
      surface.addColorStop(0.37, shades.light);
      surface.addColorStop(0.45, shades.shine);
      surface.addColorStop(0.58, shades.base);
      surface.addColorStop(0.87, shades.shadow);
      surface.addColorStop(1, shades.edge);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.lineCap = 'round';
      context.lineWidth = r * 2 + 1.2;
      context.strokeStyle = shades.edge;
      context.stroke();
      context.lineWidth = r * 2;
      context.strokeStyle = surface;
      context.stroke();
    }

    function drawJoint(point, shades) {
      const r = point.r * 1.08;
      if (point.x < -r || point.x > width + r || point.y < -r || point.y > height + r) return;
      const surface = context.createRadialGradient(point.x - r * 0.33, point.y - r * 0.42, 0, point.x, point.y, r);
      surface.addColorStop(0, shades.joint);
      surface.addColorStop(0.21, shades.light);
      surface.addColorStop(0.54, shades.base);
      surface.addColorStop(0.86, shades.shadow);
      surface.addColorStop(1, shades.edge);
      context.beginPath();
      context.arc(point.x, point.y, r, 0, Math.PI * 2);
      context.fillStyle = surface;
      context.fill();
    }

    // Bound elapsed time after delayed frames and paint at most 24 times per
    // second. Pausing resets the timestamp so resuming cannot skip ahead.
    function tick(timestamp) {
      frame = null;
      if (!playing || disposed || failed) return;
      try {
        if (lastTimestamp !== null) elapsed += Math.min(0.08, Math.max(0, (timestamp - lastTimestamp) / 1000));
        lastTimestamp = timestamp;
        if (elapsed - lastPaint >= 1 / 24) {
          render();
          lastPaint = elapsed;
        }
        frame = requestAnimationFrame(tick);
      } catch { fail(); }
    }

    function setPlaying(value) {
      if (disposed || failed) return;
      const next = Boolean(value) && typeof requestAnimationFrame === 'function';
      if (next === playing) return;
      playing = next;
      lastTimestamp = null;
      if (playing) {
        try { frame = requestAnimationFrame(tick); } catch { fail(); }
      } else stop();
    }

    function dimension(value, fallback) {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? Math.max(1, Math.round(number)) : fallback;
    }

    function resize() {
      if (disposed || failed) return false;
      try {
        const rect = canvas.getBoundingClientRect?.() ?? {};
        const nextWidth = dimension(rect.width, dimension(canvas.parentElement?.clientWidth, 1024));
        const nextHeight = dimension(rect.height, dimension(canvas.parentElement?.clientHeight, 640));
        const requestedDensity = typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
          ? devicePixelRatio : 1;
        // Large displays use a lower backing resolution, keeping the full scene
        // while bounding both memory allocation and per-frame raster work.
        const density = Math.min(2, requestedDensity, Math.sqrt(maxBitmapPixels / (nextWidth * nextHeight)),
          maxBitmapEdge / nextWidth, maxBitmapEdge / nextHeight);
        const bitmapWidth = Math.max(1, Math.floor(nextWidth * density));
        const bitmapHeight = Math.max(1, Math.floor(nextHeight * density));
        if (width === nextWidth && height === nextHeight
            && canvas.width === bitmapWidth && canvas.height === bitmapHeight) return true;
        width = nextWidth;
        height = nextHeight;
        canvas.width = bitmapWidth;
        canvas.height = bitmapHeight;
        context.setTransform(bitmapWidth / width, 0, 0, bitmapHeight / height, 0, 0);
        render();
        return true;
      } catch { fail(); return false; }
    }

    function destroy() {
      if (disposed) return;
      stop();
      disposed = true;
      routes = [];
      try { canvas.width = 1; canvas.height = 1; } catch {}
    }

    try { newScene(); } catch { fail(); return null; }
    if (!resize()) return null;
    return { setPlaying, resize, destroy };
  }

  window.SavepointPipes = { create: createPipesBackground };
})();
