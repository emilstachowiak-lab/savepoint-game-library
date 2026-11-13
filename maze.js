// Optional Classic desktop. Loading this file creates no canvas or animation.
(() => {
  'use strict';

  // The scene is entirely local: seeded materials and corridors need no assets.
  function createMazeBackground(canvas, onFailure) {
    let failureReported = false;
    function releaseBitmap() {
      try { canvas.width = 1; canvas.height = 1; } catch {}
    }
    function reportFailure() {
      if (failureReported) return;
      failureReported = true;
      try { if (typeof onFailure === 'function') onFailure(); } catch {}
    }
    let context;
    try { context = canvas?.getContext('2d', { alpha: false }); } catch {}
    if (!context) { releaseBitmap(); reportFailure(); return null; }

    const textureSize = 128;
    const textureMask = textureSize - 1;
    const mapSize = 17;
    const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const maze = Array.from({ length: mapSize }, () => Array(mapSize).fill(1));
    let seed = 9801968;
    let width = 0;
    let height = 0;
    let image = null;
    let frame = null;
    let playing = false;
    let disposed = false;
    let failed = false;
    let lastTimestamp = null;
    let lastPaint = -1;
    let elapsed = 0;
    let direction = 0;
    const camera = { x: 1.5, y: 1.5, angle: 0 };
    let action = null;
    let actionTime = 0;

    function random() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    const integer = limit => Math.floor(random() * limit);
    const open = (x, y) => maze[y]?.[x] === 0;

    // Depth-first carving connects the interior cells without opening the outer
    // wall. An initial straight passage makes the first paused frame recognizable.
    const stack = [[1, 1], [3, 1], [5, 1], [7, 1]];
    for (let x = 1; x <= 7; x += 1) maze[1][x] = 0;
    while (stack.length) {
      const [x, y] = stack[stack.length - 1];
      const choices = directions.filter(([dx, dy]) => {
        const nextX = x + dx * 2, nextY = y + dy * 2;
        return nextX > 0 && nextX < mapSize - 1 && nextY > 0 && nextY < mapSize - 1 && maze[nextY][nextX] === 1;
      });
      if (!choices.length) { stack.pop(); continue; }
      const [dx, dy] = choices[integer(choices.length)];
      maze[y + dy][x + dx] = 0;
      maze[y + dy * 2][x + dx * 2] = 0;
      stack.push([x + dx * 2, y + dy * 2]);
    }

    // Reproducible noise gives brick, mortar, ceiling tiles and the golden floor
    // their low-resolution material grain without network images or random flicker.
    function makeTexture(kind) {
      const data = new Uint8ClampedArray(textureSize * textureSize * 3);
      for (let y = 0; y < textureSize; y += 1) {
        for (let x = 0; x < textureSize; x += 1) {
          const noise = (random() - 0.5) * 38;
          let color;
          if (kind === 'wall') {
            const brickY = y % 32;
            const brickX = (x + (Math.floor(y / 32) % 2) * 32) % 64;
            const mortar = brickY < 3 || brickX < 3;
            const edge = brickY < 5 || brickX < 5 || brickY > 29 || brickX > 61;
            color = mortar ? [210 + noise, 206 + noise, 195 + noise]
              : [139 + noise - (edge ? 24 : 0), 12 + noise * 0.24, 8 + noise * 0.19];
          } else if (kind === 'ceiling') {
            const seam = x % 32 === 0 || y % 32 === 0;
            const base = seam ? 116 : 193 + noise * 1.35;
            color = [base, base + 1, base - 2];
          } else {
            const grain = noise + ((x + y) % 3 === 0 ? 9 : 0);
            color = [177 + grain, 125 + grain * 0.77, 55 + grain * 0.46];
          }
          const offset = (y * textureSize + x) * 3;
          data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2];
        }
      }
      return data;
    }
    const wallTexture = makeTexture('wall');
    const floorTexture = makeTexture('floor');
    const ceilingTexture = makeTexture('ceiling');

    // Travel between cell centers, then turn in place. Picking only open neighbors
    // keeps the automatic camera inside the maze and away from wall intersections.
    function moveAction() {
      const [dx, dy] = directions[direction];
      action = { kind: 'move', x: camera.x, y: camera.y, dx, dy, duration: 0.92 };
      actionTime = 0;
    }

    function chooseAction() {
      const cellX = Math.floor(camera.x), cellY = Math.floor(camera.y);
      const available = directions.map((_, index) => index).filter(index => {
        const [dx, dy] = directions[index];
        return open(cellX + dx, cellY + dy);
      });
      const forward = available.includes(direction);
      const onward = available.filter(index => index !== (direction + 2) % 4);
      const choices = onward.length ? onward : available;
      const next = forward && random() < 0.66 ? direction : choices[integer(choices.length)];
      if (next === direction) { moveAction(); return; }
      let turn = next * Math.PI / 2 - camera.angle;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      action = { kind: 'turn', angle: camera.angle, turn, next, duration: Math.abs(turn) > 2 ? 1.1 : 0.67 };
      actionTime = 0;
    }
    moveAction();

    function advance(delta) {
      let remaining = delta;
      while (remaining > 0) {
        const step = Math.min(remaining, action.duration - actionTime);
        actionTime += step;
        remaining -= step;
        const progress = Math.min(1, actionTime / action.duration);
        if (action.kind === 'move') {
          camera.x = action.x + action.dx * progress;
          camera.y = action.y + action.dy * progress;
        } else {
          const smooth = progress * progress * (3 - 2 * progress);
          camera.angle = action.angle + action.turn * smooth;
        }
        if (progress < 1) return;
        if (action.kind === 'turn') {
          direction = action.next;
          camera.angle = direction * Math.PI / 2;
          moveAction();
        } else chooseAction();
      }
    }

    function render() {
      if (disposed || failed || !image) return;
      const pixels = image.data;
      const dirX = Math.cos(camera.angle), dirY = Math.sin(camera.angle);
      const planeScale = width / height * 0.55;
      const planeX = -dirY * planeScale, planeY = dirX * planeScale;
      const focal = height / 1.1;
      const horizon = height / 2;

      // Row casting gives floor and ceiling textures the same perspective as walls.
      for (let y = Math.floor(horizon); y < height; y += 1) {
        const distance = 0.5 * focal / Math.max(0.5, y - horizon + 0.5);
        const stepX = distance * planeX * 2 / width, stepY = distance * planeY * 2 / width;
        let worldX = camera.x + distance * (dirX - planeX);
        let worldY = camera.y + distance * (dirY - planeY);
        const light = 0.62 + 0.38 / (1 + distance * 0.055);
        for (let x = 0; x < width; x += 1) {
          const tx = Math.floor(worldX * textureSize) & textureMask;
          const ty = Math.floor(worldY * textureSize) & textureMask;
          const textureOffset = (ty * textureSize + tx) * 3;
          const floorOffset = (y * width + x) * 4;
          const ceilingOffset = ((height - y - 1) * width + x) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            pixels[floorOffset + channel] = floorTexture[textureOffset + channel] * light;
            pixels[ceilingOffset + channel] = ceilingTexture[textureOffset + channel] * light;
          }
          pixels[floorOffset + 3] = 255;
          pixels[ceilingOffset + 3] = 255;
          worldX += stepX; worldY += stepY;
        }
      }

      // Each screen column marches across the map to the first wall. Perpendicular
      // distance keeps the perspective straight; the hit point selects its texture.
      for (let x = 0; x < width; x += 1) {
        const screenX = 2 * (x + 0.5) / width - 1;
        const rayX = dirX + planeX * screenX, rayY = dirY + planeY * screenX;
        let mapX = Math.floor(camera.x), mapY = Math.floor(camera.y);
        const deltaX = Math.abs(1 / (rayX || 1e-12)), deltaY = Math.abs(1 / (rayY || 1e-12));
        const stepX = rayX < 0 ? -1 : 1, stepY = rayY < 0 ? -1 : 1;
        let sideX = (rayX < 0 ? camera.x - mapX : mapX + 1 - camera.x) * deltaX;
        let sideY = (rayY < 0 ? camera.y - mapY : mapY + 1 - camera.y) * deltaY;
        let side = 0;
        for (let steps = 0; steps < mapSize * 2; steps += 1) {
          if (sideX < sideY) { sideX += deltaX; mapX += stepX; side = 0; }
          else { sideY += deltaY; mapY += stepY; side = 1; }
          if (!open(mapX, mapY)) break;
        }
        const distance = Math.max(0.02, side === 0 ? sideX - deltaX : sideY - deltaY);
        const wallHeight = focal / distance;
        const top = horizon - wallHeight / 2;
        const bottom = Math.min(height, Math.ceil(horizon + wallHeight / 2));
        const hit = side === 0 ? camera.y + distance * rayY : camera.x + distance * rayX;
        let textureX = Math.floor((hit - Math.floor(hit)) * textureSize);
        if ((side === 0 && rayX > 0) || (side === 1 && rayY < 0)) textureX = textureSize - textureX - 1;
        const light = (side === 0 ? 1 : 0.84) / (1 + distance * 0.045);
        for (let y = Math.max(0, Math.floor(top)); y < bottom; y += 1) {
          const textureY = Math.min(textureMask, Math.max(0, Math.floor((y - top) / wallHeight * textureSize)));
          const textureOffset = (textureY * textureSize + textureX) * 3;
          const offset = (y * width + x) * 4;
          pixels[offset] = wallTexture[textureOffset] * light;
          pixels[offset + 1] = wallTexture[textureOffset + 1] * light;
          pixels[offset + 2] = wallTexture[textureOffset + 2] * light;
          pixels[offset + 3] = 255;
        }
      }
      context.putImageData(image, 0, 0);
    }

    // A paused or hidden scene schedules no frames. Reset the timestamp so a
    // resumed tab continues smoothly instead of jumping across elapsed wall time.
    function stop() {
      playing = false;
      lastTimestamp = null;
      if (frame !== null) {
        if (typeof cancelAnimationFrame === 'function') {
          try { cancelAnimationFrame(frame); } catch {}
        }
        frame = null;
      }
    }
    function fail() {
      if (failed || disposed) return;
      failed = true;
      stop();
      image = null;
      releaseBitmap();
      reportFailure();
    }
    function tick(timestamp) {
      frame = null;
      if (!playing || disposed || failed) return;
      try {
        const delta = lastTimestamp === null ? 0 : Math.min(0.08, Math.max(0, (timestamp - lastTimestamp) / 1000));
        lastTimestamp = timestamp;
        elapsed += delta;
        advance(delta);
        // Keep camera time smooth while bounding expensive textured paints to 20fps.
        if (elapsed - lastPaint >= 1 / 20) { render(); lastPaint = elapsed; }
        frame = requestAnimationFrame(tick);
      } catch { fail(); }
    }
    function setPlaying(value) {
      if (disposed || failed) return;
      const next = Boolean(value) && typeof requestAnimationFrame === 'function';
      if (playing === next) return;
      if (!next) { stop(); return; }
      playing = true;
      lastTimestamp = null;
      try { frame = requestAnimationFrame(tick); } catch { fail(); }
    }
    function resize() {
      if (disposed || failed) return false;
      try {
        const rect = canvas.getBoundingClientRect?.() ?? {};
        const sourceWidth = Math.max(1, Number(rect.width) || canvas.parentElement?.clientWidth || 1024);
        const sourceHeight = Math.max(1, Number(rect.height) || canvas.parentElement?.clientHeight || 720);
        // Preserve the full viewport aspect ratio with a retro bitmap no larger
        // than 720x480. Reuse its allocation until the actual backing size changes.
        const scale = Math.min(1, 720 / sourceWidth, 480 / sourceHeight);
        const nextWidth = Math.max(1, Math.floor(sourceWidth * scale));
        const nextHeight = Math.max(1, Math.floor(sourceHeight * scale));
        if (width === nextWidth && height === nextHeight) return true;
        width = nextWidth; height = nextHeight;
        canvas.width = width; canvas.height = height;
        image = context.createImageData(width, height);
        render();
        return true;
      } catch { fail(); return false; }
    }
    function destroy() {
      if (disposed) return;
      stop(); disposed = true; image = null;
      releaseBitmap();
    }

    if (!resize()) return null;
    return { setPlaying, resize, destroy };
  }

  window.SavepointMaze = { create: createMazeBackground };
})();
