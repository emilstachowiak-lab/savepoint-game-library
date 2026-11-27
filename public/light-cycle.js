// Optional Grid scene. Loading the script itself allocates no canvases or frames.
(() => {
  'use strict';

  const MAX_BITMAP_PIXELS = 1650000;
  const MAX_BITMAP_EDGE = 4096;
  const FRAME_INTERVAL_MS = 1000 / 30;

  function createLightCycle(canvas, onFailure) {
    let ctx;
    let scenery;
    let still;
    let frame = null;
    let nextPaint = null;
    let lastPaint = null;
    let time = 0;
    let width = 0;
    let height = 0;
    let horizon = 0;
    let pixelScale = 1;
    let playing = false;
    let failed = false;
    let disposed = false;

    const racers = [
      makeTrack([[-26, 11], [4, 11], [4, 49], [-20, 49], [-20, 74], [-32, 74], [-32, 29], [-26, 29]],
        { rgb: "30,231,255", light: "#abfaff", speed: 13.6, phase: 28, trail: 57, lift: 2.4 }),
      makeTrack([[27, 22], [11, 22], [11, 38], [25, 38], [25, 64], [6, 64], [6, 88], [36, 88], [36, 44], [27, 44]],
        { rgb: "255,112,46", light: "#ffcb91", speed: 15.7, phase: 8, trail: 53, lift: 2.14 })
    ];

    function makeTrack(points, settings) {
      let total = 0;
      const segments = points.map(([x, z], index) => {
        const [nextX, nextZ] = points[(index + 1) % points.length];
        const length = Math.hypot(nextX - x, nextZ - z);
        const segment = { x, z, length, start: total, dx: (nextX - x) / length, dz: (nextZ - z) / length };
        total += length;
        return segment;
      });
      return { ...settings, segments, total };
    }

    function wrap(value, length) { return ((value % length) + length) % length; }

    function locate(track, distance) {
      const offset = wrap(distance, track.total);
      const segment = track.segments.find(segment => offset < segment.start + segment.length);
      const progress = offset - segment.start;
      return {
        x: segment.x + progress * segment.dx,
        z: segment.z + progress * segment.dz,
        dx: segment.dx,
        dz: segment.dz
      };
    }

    function project(x, z, elevation = 0) {
      const scale = 1 / (z + 16);
      return {
        x: width * (.515 + x * .64 * scale),
        y: horizon + height * (10.5 - elevation) * 1.18 * scale
      };
    }

    function trace(target, points, close = false) {
      target.beginPath();
      target.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index++) target.lineTo(points[index].x, points[index].y);
      if (close) target.closePath();
    }

    function solid(target, points, color) {
      trace(target, points, true);
      target.fillStyle = color;
      target.fill();
    }

    function line(target, points, color, size = 1) {
      trace(target, points);
      target.lineWidth = size;
      target.strokeStyle = color;
      target.stroke();
    }

    function tint(racer, alpha) { return "rgba(" + racer.rgb + "," + alpha + ")"; }

    function random01(seed) {
      const sample = Math.sin(seed * 127.1 + 37.3) * 43758.5453123;
      return sample - Math.floor(sample);
    }

    function renderScenery() {
      const sky = still.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, "#050911");
      sky.addColorStop(.24, "#081521");
      sky.addColorStop(.39, "#102d3b");
      sky.addColorStop(.56, "#081a26");
      sky.addColorStop(1, "#080e16");
      still.fillStyle = sky;
      still.fillRect(0, 0, width, height);

      const glows = [
        [width * .2, horizon, width * .34, "#17688445"],
        [width * .74, horizon * .97, width * .31, "#1877895e"],
        [width * .93, horizon, Math.min(width * .26, height * .6), "#ac4e272a"]
      ];
      for (const [x, y, radius, inner] of glows) {
        const glow = still.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, inner);
        glow.addColorStop(1, "#0000");
        still.fillStyle = glow;
        still.fillRect(0, 0, width, height);
      }

      const towers = Math.ceil(width / 15);
      for (let idx = 0; idx < towers; idx++) {
        const buildingX = idx * width / towers;
        const buildingWidth = (7 + random01(idx + 122) * 23) * Math.min(1, width / 540);
        const heightFactor = .015 + random01(idx + 26) ** 3 * .10;
        const buildingHeight = height * heightFactor;
        const top = horizon - buildingHeight;
        const color = idx % 3 ? "#091521" : "#0b1a27";
        solid(still, [
          { x: buildingX, y: horizon }, { x: buildingX, y: top + 4 },
          { x: buildingX + buildingWidth * .69, y: top },
          { x: buildingX + buildingWidth, y: top + buildingWidth * .28 },
          { x: buildingX + buildingWidth, y: horizon }
        ], color);
        if (idx % 4 === 0) {
          line(still, [{ x: buildingX + 1, y: top + 5 }, { x: buildingX + 1, y: horizon - 2 }], "#4297ac39");
        }
        if (idx % 7 === 0) {
          still.fillStyle = "#68eaff74";
          still.fillRect(buildingX + buildingWidth * .61, top + 4, 1.5, 1.5);
        }
      }

      const horizonLine = still.createLinearGradient(0, horizon, width, horizon);
      horizonLine.addColorStop(0, "#39cae222");
      horizonLine.addColorStop(.45, "#69dff688");
      horizonLine.addColorStop(.76, "#7ee3faae");
      horizonLine.addColorStop(1, "#f8855860");
      line(still, [{ x: 0, y: horizon }, { x: width, y: horizon }], horizonLine);

      const floor = still.createLinearGradient(0, horizon, 0, height);
      floor.addColorStop(0, "#090f19");
      floor.addColorStop(.31, "#081823");
      floor.addColorStop(1, "#050b13");
      still.fillStyle = floor;
      still.fillRect(0, horizon + 1, width, height - horizon);

      const gridGradient = still.createLinearGradient(0, horizon, 0, height);
      gridGradient.addColorStop(0, "#46bcd924");
      gridGradient.addColorStop(.5, "#42cde946");
      gridGradient.addColorStop(1, "#3ab4d03e");
      for (let x = -104; x <= 104; x += 4) {
        line(still, [project(x, 414), project(x, 1)], gridGradient, x % 16 === 0 ? 1.12 : .72);
      }
      for (let z = 4; z <= 140; z += 4) {
        line(still, [project(-148, z), project(148, z)], gridGradient, z % 16 === 0 ? 1 : .68);
      }
      const strips = [
        [-35, 46, 108, "#286e8d75"], [-34, 46, 108, "#71d9eb51"],
        [36, 25, 110, "#537e9a78"], [37.2, 25, 110, "#f6a46e6b"],
        [102, 9, 154, "#18869f59"], [-102, 9, 154, "#18869f59"]
      ];
      for (const [x, start, end, color] of strips) line(still, [project(x, start), project(x, end)], color);
      const vignette = still.createRadialGradient(width * .51, height * .54, Math.min(width, height) * .25,
        width * .51, height * .54, Math.hypot(width, height) * .59);
      vignette.addColorStop(0, "#0000");
      vignette.addColorStop(1, "#02050ad6");
      still.fillStyle = vignette;
      still.fillRect(0, 0, width, height);
    }

    function buildTrail(track, distance) {
      const start = distance - track.trail;
      const corners = [start];
      for (const segment of track.segments) {
        const vertex = start - wrap(start - segment.start, track.total) + track.total;
        if (vertex < distance - .001) corners.push(vertex);
      }
      corners.push(distance);
      corners.sort((a, b) => a - b);
      const samples = [{ ...locate(track, start), progress: 0 }];
      for (let idx = 1; idx < corners.length; idx++) {
        const from = corners[idx - 1];
        const to = corners[idx];
        const steps = Math.ceil((to - from) / 3.5);
        for (let step = 1; step <= steps; step++) {
          const sample = from + (to - from) * step / steps;
          samples.push({ ...locate(track, sample), progress: (sample - start) / track.trail });
        }
      }
      return samples;
    }

    function renderTrail(track, trail) {
      const wall = trail.map(point => {
        const intensity = .15 + point.progress * .85;
        return {
          floor: project(point.x, point.z, .1),
          top: project(point.x, point.z, track.lift * Math.min(1, intensity * 2.7)),
          intensity
        };
      });
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowBlur = 14 * pixelScale;
      ctx.shadowColor = tint(track, .85);
      line(ctx, wall.slice(-17).map(point => point.floor), tint(track, .52), 2.15);
      line(ctx, wall.slice(-16).map(point => point.top), tint(track, .39), 2.4);
      ctx.shadowBlur = 0;
      for (let idx = 1; idx < wall.length; idx++) {
        const from = wall[idx - 1], to = wall[idx];
        const energy = to.intensity * to.intensity;
        solid(ctx, [from.floor, to.floor, to.top, from.top], tint(track, .25 * energy));
        line(ctx, [from.floor, to.floor], tint(track, .23 + energy * .56), 1.05 + energy * 1.15);
        line(ctx, [from.top, to.top], tint(track, .16 + energy * .73), 1.05 + energy * 1.6);
        if (energy > .46) line(ctx, [from.top, to.top], "rgba(235,252,255," + (energy * .71) + ")", .85);
      }
      ctx.restore();
    }

    function renderBike(track, point) {
      const place = (forward, lateral, y) => project(
        point.x + point.dx * forward - point.dz * lateral,
        point.z + point.dz * forward + point.dx * lateral,
        y
      );
      const nearSide = point.dx < 0 ? 1 : -1;
      const head = place(1.72, 0, .73);
      const rear = place(-1.73, 0, .71);
      const ground = place(0, 0, .05);
      const unit = height * 1.18 / (point.z + 16);
      const spray = Math.max(13, unit * 1.75);
      const pool = ctx.createRadialGradient(ground.x, ground.y, 1, ground.x, ground.y, spray);
      pool.addColorStop(0, tint(track, .56));
      pool.addColorStop(1, tint(track, 0));
      ctx.fillStyle = pool;
      ctx.fillRect(ground.x - spray, ground.y - spray, spray * 2, spray * 2);

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (const wheelCenter of [-1.08, 1.08]) {
        const wheel = Array.from({ length: 18 }, (_, index) => {
          const angle = index * Math.PI * 2 / 18;
          return place(wheelCenter + Math.cos(angle) * .52, nearSide * .30, .54 + Math.sin(angle) * .50);
        });
        solid(ctx, wheel, "#080d16");
        ctx.shadowBlur = pixelScale * 10;
        ctx.shadowColor = tint(track, 1);
        line(ctx, [...wheel, wheel[0]], tint(track, .96), Math.max(1, unit * .076));
        ctx.shadowBlur = 0;
      }

      const side = [
        place(-1.69, nearSide * .40, .42), place(-1.33, nearSide * .48, .92),
        place(-.46, nearSide * .49, 1.11), place(.26, nearSide * .31, 1.49),
        place(.93, nearSide * .49, .98), place(1.70, nearSide * .36, .63),
        place(1.04, nearSide * .46, .40), place(-.74, nearSide * .43, .39)
      ];
      const top = [
        place(-1.50, -.35, .80), place(-.55, -.40, 1.1), place(.24, 0, 1.53),
        place(1.43, -.27, .73), place(1.70, nearSide * .36, .63), place(.26, nearSide * .31, 1.49),
        place(-.46, nearSide * .49, 1.11), place(-1.33, nearSide * .48, .92)
      ];
      solid(ctx, side, "#07101a");
      solid(ctx, top, "#1b2e3a");
      line(ctx, [side[0], side[1], side[2], side[3], side[4], side[5]], tint(track, .91), Math.max(1, unit * .076));
      line(ctx, [side[0], side[7], side[6], side[5]], tint(track, .78), Math.max(1, unit * .068));
      ctx.shadowColor = tint(track, 1);
      ctx.shadowBlur = 10 * pixelScale;
      line(ctx, [place(1.57, -.28, .73), head, place(1.57, .28, .73)], track.light, Math.max(1, unit * .12));
      line(ctx, [place(-1.60, -.27, .67), rear, place(-1.60, .27, .67)], tint(track, 1), Math.max(1, unit * .09));
      ctx.restore();
    }

    function draw() {
      if (!width || !height) return;
      ctx.drawImage(scenery, 0, 0, width, height);
      const scenes = racers.map(track => {
        const distance = time * track.speed + track.phase;
        return { track, leading: locate(track, distance), trail: buildTrail(track, distance) };
      }).sort((left, right) => right.leading.z - left.leading.z);
      for (const { track, trail } of scenes) renderTrail(track, trail);
      for (const { track, leading } of scenes) renderBike(track, leading);
    }

    function stop() {
      const pending = frame;
      frame = null;
      nextPaint = null;
      lastPaint = null;
      if (pending !== null) {
        try { cancelAnimationFrame(pending); } catch {}
      }
    }

    function releaseBitmaps() {
      for (const target of [canvas, scenery]) {
        if (!target) continue;
        target.removeEventListener?.('contextlost', fail);
        try { target.width = target.height = 1; } catch {}
      }
      ctx = null;
      still = null;
      scenery = null;
    }

    function fail() {
      if (failed || disposed) return;
      failed = true;
      playing = false;
      stop();
      releaseBitmaps();
      onFailure?.();
    }

    function resize() {
      if (disposed || failed) return;
      try {
        const box = canvas.getBoundingClientRect();
        const nextWidth = Math.round(box.width);
        const nextHeight = Math.round(box.height);
        if (!(nextWidth > 0 && nextHeight > 0) || !Number.isFinite(nextWidth * nextHeight)) return;
        const dpr = Number(window.devicePixelRatio) || 1;
        const nextScale = Math.min(Math.max(.1, dpr), 1.75,
          Math.sqrt(MAX_BITMAP_PIXELS / (nextWidth * nextHeight)),
          MAX_BITMAP_EDGE / Math.max(nextWidth, nextHeight));
        if (width === nextWidth && height === nextHeight && pixelScale === nextScale) return;

        width = nextWidth;
        height = nextHeight;
        pixelScale = nextScale;
        horizon = height * .325;
        const bitmapWidth = Math.max(1, Math.floor(width * pixelScale));
        const bitmapHeight = Math.max(1, Math.floor(height * pixelScale));
        canvas.width = scenery.width = bitmapWidth;
        canvas.height = scenery.height = bitmapHeight;
        ctx.setTransform(bitmapWidth / width, 0, 0, bitmapHeight / height, 0, 0);
        still.setTransform(bitmapWidth / width, 0, 0, bitmapHeight / height, 0, 0);
        renderScenery();
        draw();
      } catch { fail(); }
    }

    function schedule() {
      if (!playing || frame !== null) return;
      try { frame = requestAnimationFrame(animate); } catch { fail(); }
    }

    function animate(now) {
      frame = null;
      if (!playing) return;
      if (nextPaint === null || now >= nextPaint - 1) {
        if (lastPaint !== null) time += Math.min(Math.max(0, now - lastPaint) / 1000, .07);
        lastPaint = now;
        // Retain the cadence if an individual requestAnimationFrame is late.
        nextPaint = nextPaint === null || now - nextPaint >= FRAME_INTERVAL_MS
          ? now + FRAME_INTERVAL_MS
          : nextPaint + FRAME_INTERVAL_MS;
        try { draw(); } catch { fail(); }
      }
      schedule();
    }

    function setPlaying(next) {
      if (disposed || failed || playing === Boolean(next)) return;
      playing = Boolean(next);
      if (playing) schedule();
      else stop();
    }

    function destroy() {
      if (disposed) return;
      disposed = true;
      playing = false;
      stop();
      if (!failed) releaseBitmaps();
    }

    try {
      ctx = canvas?.getContext('2d', { alpha: false });
      scenery = document.createElement('canvas');
      still = scenery.getContext('2d', { alpha: false });
      if (!ctx || !still) throw new Error('Light Cycle requires a 2D canvas.');
      canvas.addEventListener?.('contextlost', fail);
      scenery.addEventListener?.('contextlost', fail);
      resize();
    } catch { fail(); }
    return failed ? null : { resize, setPlaying, destroy };
  }

  window.SavepointLightCycle = Object.freeze({ create: createLightCycle });
})();
