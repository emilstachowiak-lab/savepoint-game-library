// The P2 clock reads the viewing device's local time. Loading this file creates
// no canvas, texture or animation; the appearance controller owns its lifecycle.
(() => {
  'use strict';
  const P2ClockMath = (() => {
    'use strict';
    const TAU = Math.PI * 2;
    const wrap = (value, period) => ((value % period) + period) % period;

    function finite(value) {
      if (!Number.isFinite(value)) throw new TypeError('Clock values must be finite numbers.');
      return value;
    }

    // Rodrigues rotation uses the same array representation as the scene points.
    function rotate(point, axis, angle) {
      const [x, y, z] = point.map(finite);
      const length = Math.hypot(...axis.map(finite));
      if (length === 0) throw new RangeError('A rotation axis must be nonzero.');
      const [u, v, w] = axis.map(component => component / length);
      const cosine = Math.cos(finite(angle));
      const sine = Math.sin(angle);
      const projection = (u * x + v * y + w * z) * (1 - cosine);
      return [
        x * cosine + (v * z - w * y) * sine + u * projection,
        y * cosine + (w * x - u * z) * sine + v * projection,
        z * cosine + (u * y - v * x) * sine + w * projection
      ];
    }

    // Convert local seconds since midnight into a twelve-hour face. Progress
    // within the hour drains its crystal; each minute completes one face turn.
    function model(secondsOfDay) {
      const time = wrap(finite(secondsOfDay), 86400);
      const hour = Math.floor(time / 3600);
      const minute = Math.floor(time / 60) % 60;
      const seconds = time % 60;
      const hourProgress = (minute * 60 + seconds) / 3600;
      const activeHour = hour % 12;
      const hourAngle = TAU * (activeHour + minute / 60 + seconds / 3600) / 12;
      const faceAngle = TAU * seconds / 60;
      const activeAngle = TAU * activeHour / 12;
      const axis = [Math.sin(activeAngle), -Math.cos(activeAngle), 0];
      const orbRadius = 0.12 + 0.62 * hourProgress;
      const direction = [Math.sin(hourAngle), -Math.cos(hourAngle), 0];
      const tangent = [Math.cos(hourAngle), Math.sin(hourAngle), 0];

      // This spherical trajectory is original artwork, not Sony's formula.
      // Shared phase geometry preserves every documented grouping and makes all
      // seven orbs meet at the hour-hand position at the start of each minute.
      const orbs = Array.from({ length: 7 }, (_, index) => {
        const phase = TAU * (index + 1) * seconds / 60;
        const tilt = faceAngle + 0.7 * Math.sin(phase);
        const along = Math.cos(phase);
        const across = Math.sin(phase);
        return [
          orbRadius * (along * direction[0] + across * Math.cos(tilt) * tangent[0]),
          orbRadius * (along * direction[1] + across * Math.cos(tilt) * tangent[1]),
          orbRadius * across * Math.sin(tilt)
        ];
      });

      return {
        hour, minute, seconds, hourProgress, activeHour, hourAngle, faceAngle,
        axis, fill: 1 - hourProgress, orbRadius, orbs
      };
    }

    return { model, rotate };
  })();

  function createP2Clock(canvas, onFailure) {
    let failureReported = false;
    let failed = false;
    let disposed = false;
    let active = false;
    let playing = false;
    let frame = null;
    let timer = null;
    let width = 0;
    let height = 0;
    let ratio = 1;
    let mistTime = 0;
    let lastPaint = -Infinity;
    let mist = null;
    let context = null;
    const TAU = Math.PI * 2;

    function releaseBitmaps() {
      try { if (canvas) canvas.width = canvas.height = 1; } catch {}
      try { if (mist) mist.width = mist.height = 1; } catch {}
    }
    function stop() {
      try { if (frame !== null) cancelAnimationFrame(frame); } catch {}
      try { if (timer !== null) clearTimeout(timer); } catch {}
      frame = timer = null;
    }
    function reportFailure() {
      if (failed || disposed) return;
      failed = true;
      active = false;
      stop();
      releaseBitmaps();
      if (!failureReported) {
        failureReported = true;
        try { if (typeof onFailure === 'function') onFailure(); } catch {}
      }
    }

    // Civil time is read afresh for every frame, including one-second updates
    // with smooth motion disabled. Device time-zone and clock changes are immediate.
    function deviceTime() {
      const date = new Date();
      return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()
        + date.getMilliseconds() / 1000;
    }

    function initializeMist() {
      // A small deterministic texture supplies the cloudy tunnel. The image is
      // prepared once; the animation only moves and scales the cached bitmap.
      mist = document.createElement('canvas');
      mist.width = mist.height = 384;
      const mistContext = mist.getContext('2d');
      if (!mistContext) throw new Error('The P2 mist context is unavailable.');
      function hash(x, y) {
        let value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + 1234567;
        value = Math.imul(value ^ (value >>> 13), 1274126177);
        return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
      }
      function noise(x, y) {
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = x - ix, fy = y - iy;
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const top = hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx;
        const bottom = hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx;
        return top * (1 - sy) + bottom * sy;
      }
      const pixels = mistContext.createImageData(mist.width, mist.height);
      for (let y = 0; y < mist.height; y += 1) {
        for (let x = 0; x < mist.width; x += 1) {
          const nx = (x - mist.width / 2) / (mist.width / 2);
          const ny = (y - mist.height / 2) / (mist.height / 2);
          const radius = Math.hypot(nx, ny);
          const angle = Math.atan2(ny, nx) + radius * 1.45;
          const px = Math.cos(angle) * radius * 4.2 + 8;
          const py = Math.sin(angle) * radius * 4.2 + 12;
          const detail = noise(px, py) * 0.55 + noise(px * 2.1, py * 2.1) * 0.26
            + noise(px * 4.5, py * 4.5) * 0.13 + noise(px * 9, py * 9) * 0.06;
          const center = 0.32 + 0.68 * Math.min(1, radius * 1.8);
          const offset = (y * mist.width + x) * 4;
          pixels.data[offset] = (30 + detail * 48) * center;
          pixels.data[offset + 1] = (27 + detail * 43) * center;
          pixels.data[offset + 2] = (44 + detail * 70) * center;
          pixels.data[offset + 3] = 255;
        }
      }
      mistContext.putImageData(pixels, 0, 0);
    }

    function drawTunnel(time) {
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = '#100e1c';
      context.fillRect(0, 0, width, height);
      const size = Math.hypot(width, height) * 1.1;
      const drift = time;
      context.save();
      context.translate(width / 2 + Math.sin(drift / 37) * width * 0.015,
        height / 2 + Math.cos(drift / 43) * height * 0.015);
      context.rotate(drift * 0.0035);
      context.globalAlpha = 0.95;
      context.drawImage(mist, -size / 2, -size / 2, size, size);
      context.globalCompositeOperation = 'screen';
      context.globalAlpha = 0.14;
      context.rotate(-drift * 0.006 - 0.5);
      context.drawImage(mist, -size * 0.59, -size * 0.52, size * 1.18, size * 1.18);
      context.restore();
      const tunnel = context.createRadialGradient(width * 0.5, height * 0.49,
        0, width * 0.5, height * 0.49, Math.max(width, height) * 0.57);
      tunnel.addColorStop(0, '#02030bc4');
      tunnel.addColorStop(0.25, '#07061275');
      tunnel.addColorStop(0.66, '#09071500');
      tunnel.addColorStop(1, '#02020c8c');
      context.fillStyle = tunnel;
      context.fillRect(0, 0, width, height);
    }

    function project(point, scene) {
      const perspective = 5 / (5 + point[2]);
      return { x: scene.x + point[0] * scene.unit * perspective,
        y: scene.y + point[1] * scene.unit * perspective, z: point[2], scale: perspective };
    }
    function polygon(vertices) {
      context.beginPath();
      context.moveTo(vertices[0].x, vertices[0].y);
      for (const point of vertices.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
    }

    // Each marker is a six-sided prism. The twelve-marker face rotates around
    // the current hour's radial axis, keeping that hour marker on the axis.
    function crystal(index, model, time, scene, items) {
      const angle = TAU * index / 12;
      const direction = [Math.sin(angle), -Math.cos(angle), 0];
      const tangent = [Math.cos(angle), Math.sin(angle), 0];
      const spin = time * 0.23 + index * 0.31;
      const active = index === model.activeHour;
      function point(radius, thickness, side) {
        const phase = spin + side * TAU / 6;
        const raw = [direction[0] * radius + tangent[0] * Math.cos(phase) * thickness,
          direction[1] * radius + tangent[1] * Math.cos(phase) * thickness,
          Math.sin(phase) * thickness];
        return P2ClockMath.rotate(raw, model.axis, model.faceAngle);
      }
      function surface(inner, outer, thickness, liquid) {
        const low = Array.from({ length: 6 }, (_, side) => point(inner, thickness, side));
        const high = Array.from({ length: 6 }, (_, side) => point(outer, thickness, side));
        const faces = [low.slice().reverse(), high];
        for (let side = 0; side < 6; side += 1) {
          const next = (side + 1) % 6;
          faces.push([low[side], low[next], high[next], high[side]]);
        }
        for (const face of faces) {
          const a = face[0], b = face[1], c = face[2];
          const u = b.map((value, axis) => value - a[axis]);
          const v = c.map((value, axis) => value - a[axis]);
          const normal = [u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const length = Math.hypot(...normal) || 1;
          const lighting = Math.abs((-normal[0] * 0.34 - normal[1] * 0.48 - normal[2] * 0.81) / length);
          const brightness = liquid ? 0.8 + lighting * 0.3 : 0.45 + lighting * 0.7;
          const base = liquid ? [223, 230, 255] : active ? [165, 174, 255] : [141, 130, 255];
          const color = base.map(channel => Math.min(255, Math.round(channel * brightness)));
          items.push({ type: 'face', points: face.map(vertex => project(vertex, scene)),
            z: face.reduce((sum, vertex) => sum + vertex[2], 0) / face.length,
            color, alpha: liquid ? 0.9 : 0.72, liquid, active });
        }
      }
      surface(0.56, 1.58, 0.105, false);
      // The inner glowing volume empties continuously toward the inner end.
      if (active && model.fill > 0.001) surface(0.57, 0.57 + model.fill, 0.074, true);
    }

    function drawFace(item) {
      polygon(item.points);
      const color = item.color.join(',');
      context.fillStyle = `rgba(${color},${item.alpha})`;
      context.fill();
      context.strokeStyle = item.liquid ? 'rgba(220,236,255,.55)' : 'rgba(161,170,255,.27)';
      context.lineWidth = item.liquid ? 0.75 : 0.55;
      context.stroke();
    }
    function drawOrb(item) {
      const radius = Math.max(2, item.scene.unit * 0.024 * item.point.scale);
      const glow = context.createRadialGradient(item.point.x, item.point.y, 0,
        item.point.x, item.point.y, radius * 5);
      glow.addColorStop(0, '#eeffff');
      glow.addColorStop(0.17, '#cfffff');
      glow.addColorStop(0.35, `rgba(117,222,255,${0.38})`);
      glow.addColorStop(1, '#5ddcff00');
      context.save();
      context.globalCompositeOperation = 'screen';
      context.fillStyle = glow;
      context.fillRect(item.point.x - radius * 5, item.point.y - radius * 5,
        radius * 10, radius * 10);
      context.fillStyle = '#dfffff';
      context.beginPath();
      context.arc(item.point.x, item.point.y, radius * 0.77, 0, TAU);
      context.fill();
      context.restore();
    }
    // Reconstruct recent orb positions from clock time rather than retaining
    // earlier frames, so trails also work after a pause or a one-second update.
    function drawTrails(time, scene) {
      const samples = Array.from({ length: 23 }, (_, index) =>
        P2ClockMath.model(time - (22 - index) * 0.048).orbs.map(point => project(point, scene)));
      context.save();
      context.globalCompositeOperation = 'screen';
      context.lineWidth = 0.75;
      for (let orb = 0; orb < 7; orb += 1) {
        for (let index = 1; index < samples.length; index += 1) {
          const before = samples[index - 1][orb], after = samples[index][orb];
          const alpha = 0.36 * Math.pow(index / samples.length, 1.7);
          context.strokeStyle = `rgba(91,165,255,${alpha})`;
          context.beginPath();
          context.moveTo(before.x, before.y);
          context.lineTo(after.x, after.y);
          context.stroke();
        }
      }
      context.restore();
    }
    function paint() {
      if (disposed || failed || !active || width < 1 || height < 1) return;
      const time = deviceTime();
      const model = P2ClockMath.model(time);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.globalAlpha = 1;
      context.shadowBlur = 0;
      if (playing) mistTime = time;
      drawTunnel(mistTime);
      const scene = { x: width / 2, y: height * 0.49,
        unit: Math.min(width * 0.42, height * 0.4) / 1.68 };
      drawTrails(time, scene);
      const items = [];
      for (let index = 0; index < 12; index += 1) crystal(index, model, time, scene, items);
      for (const point of model.orbs) {
        const projected = project(point, scene);
        items.push({ type: 'orb', point: projected, z: point[2], scene });
      }
      items.sort((a, b) => b.z - a.z);
      for (const item of items) item.type === 'face' ? drawFace(item) : drawOrb(item);
    }

    // A stopped clock still reflects local time once per second. All scheduling
    // goes through this guard so failure cancels both kinds of pending work.
    function schedule() {
      if (disposed || failed || !active) return;
      try {
        if (playing) frame = requestAnimationFrame(tick);
        else timer = setTimeout(step, 1000);
      } catch { reportFailure(); }
    }
    function safePaint() {
      try { paint(); return !failed; } catch { reportFailure(); return false; }
    }
    function tick(timestamp) {
      frame = null;
      if (disposed || failed || !active) return;
      if (timestamp - lastPaint >= 1000 / 24) {
        lastPaint = timestamp;
        if (!safePaint()) return;
      }
      schedule();
    }
    function step() {
      timer = null;
      if (disposed || failed || !active) return;
      if (safePaint()) schedule();
    }

    function resize() {
      if (disposed || failed) return;
      try {
        const rectangle = canvas.getBoundingClientRect();
        const nextWidth = Number(rectangle.width);
        const nextHeight = Number(rectangle.height);
        if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)
          || nextWidth < 1 || nextHeight < 1) return;
        width = Math.min(8192, nextWidth);
        height = Math.min(8192, nextHeight);
        const dpr = Number(window.devicePixelRatio) || 1;
        // Keep scene coordinates in CSS pixels while capping bitmap allocation.
        ratio = Math.min(Math.max(0.1, dpr), 1.5, Math.sqrt(1400000 / (width * height)));
        const bitmapWidth = Math.max(1, Math.floor(width * ratio));
        const bitmapHeight = Math.max(1, Math.floor(height * ratio));
        if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
          canvas.width = bitmapWidth;
          canvas.height = bitmapHeight;
        }
        if (active) safePaint();
      } catch { reportFailure(); }
    }

    function setState(next = {}) {
      if (disposed || failed) return;
      const nextActive = next.active === true;
      const nextPlaying = next.playing === true;
      if (nextActive === active && nextPlaying === playing) return;
      stop();
      active = nextActive;
      playing = nextPlaying;
      if (!active) return;
      lastPaint = -Infinity;
      resize();
      if (!failed) schedule();
    }

    function destroy() {
      if (disposed) return;
      disposed = true;
      active = false;
      stop();
      releaseBitmaps();
      mist = null;
      context = null;
    }

    try {
      context = canvas?.getContext('2d', { alpha: false });
      if (!context) throw new Error('The P2 clock context is unavailable.');
      initializeMist();
    } catch {
      reportFailure();
      return null;
    }
    return { resize, setState, destroy };
  }

  window.SavepointP2Clock = Object.freeze({ create: createP2Clock });
})();
