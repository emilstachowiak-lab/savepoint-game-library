'use strict';

// Exercise the actual maze rasterizer offline. The fixture keeps native RGBA
// buffers while its recorded frame calls expose allocation and lifecycle work.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { canvasFixture } = require('./frontend-canvas.cjs');
const source = fs.readFileSync(path.join(__dirname, '..', 'maze.js'), 'utf8');

function mazeHarness(options = {}) {
  const drawing = canvasFixture({
    width: options.width ?? 320, height: options.height ?? 180,
    throwImageData: options.throwImageData
  });
  const context = drawing.main.getContext('2d');
  const scheduled = new Map();
  const nativeBuffers = new WeakMap();
  let nextFrame = 0;
  let failures = 0;
  let numericWrites = 0;
  let timestamp = 0;
  if (options.noContext) drawing.main.getContext = () => null;
  if (options.throwContext) drawing.main.getContext = () => { throw new Error('Synthetic context failure'); };
  if (options.throwInitialDraw) context.putImageData = () => { throw new Error('Synthetic initial drawing failure'); };
  if (options.checkNumericWrites) {
    const allocate = context.createImageData;
    context.createImageData = (width, height) => {
      const image = allocate(width, height);
      nativeBuffers.set(image, image.data);
      // Check numbers before Uint8ClampedArray would silently coerce NaN to zero.
      image.data = new Proxy(image.data, {
        set(target, property, value) {
          assert(Number.isFinite(Number(property)) && Number.isFinite(value), 'Every raster write must have finite coordinates and color');
          assert(Number(property) >= 0 && Number(property) < target.length, 'Every raster write must stay within the bitmap');
          numericWrites += 1;
          return Reflect.set(target, property, value, target);
        }
      });
      return image;
    };
  }
  const window = {};
  const sandbox = {
    window,
    requestAnimationFrame(callback) {
      if (options.throwSchedule) throw new Error('Synthetic RAF failure');
      scheduled.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame(id) { scheduled.delete(id); }
  };
  if (options.noSchedule) delete sandbox.requestAnimationFrame;
  vm.runInNewContext(source, sandbox, { filename: 'maze.js' });
  assert.deepEqual(Object.keys(window), ['SavepointMaze']);
  assert.equal(drawing.allocations.length, 0, 'Loading maze.js must allocate no image');
  assert.equal(drawing.events.length, 0, 'Loading maze.js must draw no scene');
  assert.equal(scheduled.size, 0, 'Loading maze.js must start no animation');
  const renderer = window.SavepointMaze.create(drawing.main, () => { failures += 1; });
  return {
    drawing, context, renderer, scheduled,
    get failures() { return failures; },
    get numericWrites() { return numericWrites; },
    pixels() { return nativeBuffers.get(context.frame) ?? context.frame?.data; },
    hash() { return createHash('sha256').update(this.pixels()).digest('hex'); },
    frames() { return drawing.events.filter(event => event[1] === 'putImageData').length; },
    advance(milliseconds) {
      timestamp += milliseconds;
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback(timestamp);
    }
  };
}

function assertOpaqueFrame(test) {
  const pixels = test.pixels();
  assert(pixels instanceof Uint8ClampedArray);
  assert.equal(pixels.length, test.drawing.main.width * test.drawing.main.height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    assert(Number.isFinite(pixels[offset]) && Number.isFinite(pixels[offset + 1]) && Number.isFinite(pixels[offset + 2]));
    assert.equal(pixels[offset + 3], 255, 'The scene must cover every pixel without transparent gaps');
  }
}

{
  const test = mazeHarness();
  assert(test.renderer);
  assert.equal(test.frames(), 1, 'A paused scene must have a useful initial frame');
  assertOpaqueFrame(test);
  const colors = new Set();
  let red = 0, gray = 0, gold = 0;
  const pixels = test.pixels();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const [r, g, b] = pixels.subarray(offset, offset + 3);
    colors.add(`${r},${g},${b}`);
    if (r > 50 && r > g * 2 && r > b * 2) red += 1;
    if (r > 70 && Math.abs(r - g) < 5 && Math.abs(r - b) < 6) gray += 1;
    if (r > g * 1.1 && g > b * 1.3 && g > 35) gold += 1;
  }
  assert(colors.size > 500, 'Texture grain must produce more than flat polygon fills');
  assert(red > 1000 && gray > 1000 && gold > 1000, 'Initial corridor must contain red brick, gray ceiling and golden floor');
  assert.equal(test.hash(), mazeHarness().hash(), 'Seeded materials and initial route must be reproducible');
  const allocations = test.drawing.allocations.length;
  test.drawing.clear();
  assert.equal(test.renderer.resize(), true);
  assert.equal(test.drawing.allocations.length, allocations, 'Unchanged size must reuse its native RGBA buffer');
  assert.equal(test.frames(), 0);
  const initial = test.hash();
  test.renderer.setPlaying(true);
  assert.equal(test.scheduled.size, 1);
  test.advance(10);
  assert.equal(test.frames(), 1);
  test.advance(10);
  test.advance(10);
  test.advance(10);
  test.advance(10);
  assert.equal(test.frames(), 1, 'Sub-50ms steps must not trigger a textured paint');
  test.advance(10);
  assert.equal(test.frames(), 2);
  assert.notEqual(test.hash(), initial, 'Camera movement must change the projected scene');
  for (let index = 0; index < 100; index += 1) test.advance(10);
  assert(test.frames() <= 22, 'The one-second paint budget must stay at 20fps plus boundary frames');
  test.renderer.setPlaying(false);
  assert.equal(test.scheduled.size, 0);
  test.drawing.clear();
  const paused = test.hash();
  test.advance(100000);
  assert.equal(test.frames(), 0);
  assert.equal(test.hash(), paused);
  test.renderer.setPlaying(true);
  test.advance(50);
  assert.equal(test.hash(), paused, 'Resume must not advance by time spent paused');
  test.advance(60);
  assert.notEqual(test.hash(), paused);
  test.renderer.destroy();
  test.renderer.destroy();
  assert.equal(test.scheduled.size, 0);
  assert.equal(test.drawing.main.width, 1);
  assert.equal(test.drawing.main.height, 1);
  assert.equal(test.renderer.resize(), false);
  test.renderer.setPlaying(true);
  assert.equal(test.scheduled.size, 0);
  assert.equal(test.failures, 0);
  console.log('PASS: lazy scene, seeded textured raster, bitmap reuse, bounded paints, movement, pause/resume and cleanup');
}

{
  const test = mazeHarness();
  for (const [width, height] of [[7680, 4320], [4320, 7680], [320, 740], [20000, 100], [100, 20000], [1, 1]]) {
    test.drawing.size.width = width;
    test.drawing.size.height = height;
    assert.equal(test.renderer.resize(), true);
    assert(test.drawing.main.width <= 720 && test.drawing.main.height <= 480);
    assert(test.drawing.main.width * test.drawing.main.height <= 720 * 480);
    assertOpaqueFrame(test);
  }
  test.renderer.destroy();
  const checked = mazeHarness({ width: 48, height: 36, checkNumericWrites: true });
  checked.renderer.setPlaying(true);
  const initial = checked.hash();
  for (let index = 0; index < 240; index += 1) {
    checked.advance(50);
    if (index % 20 === 0) assertOpaqueFrame(checked);
  }
  assert.equal(checked.failures, 0, 'Several turns must keep every raster write finite and within bounds');
  assert(checked.numericWrites > 1000000);
  assert.notEqual(checked.hash(), initial);
  checked.renderer.destroy();
  console.log('PASS: bounded 8K/portrait/mobile bitmaps and native finite/opaque raster writes across camera turns');
}

{
  for (const options of [{ noContext: true }, { throwContext: true }, { throwImageData: true }, { throwInitialDraw: true }]) {
    const test = mazeHarness(options);
    assert.equal(test.renderer, null);
    assert.equal(test.failures, 1);
    assert.equal(test.scheduled.size, 0);
    assert.equal(test.drawing.main.width, 1);
    assert.equal(test.drawing.main.height, 1);
  }
  const scheduling = mazeHarness({ throwSchedule: true });
  scheduling.renderer.setPlaying(true);
  scheduling.renderer.setPlaying(true);
  assert.equal(scheduling.failures, 1);
  assert.equal(scheduling.scheduled.size, 0);
  assert.equal(scheduling.drawing.main.width, 1);
  const drawing = mazeHarness();
  drawing.context.putImageData = () => { throw new Error('Synthetic drawing failure'); };
  drawing.renderer.setPlaying(true);
  drawing.advance(50);
  assert.equal(drawing.failures, 1);
  assert.equal(drawing.scheduled.size, 0);
  assert.equal(drawing.drawing.main.width, 1);
  assert.equal(drawing.drawing.main.height, 1);
  drawing.renderer.resize();
  drawing.renderer.setPlaying(true);
  drawing.renderer.destroy();
  assert.equal(drawing.failures, 1, 'A failed scene must notify the controller only once');
  const staticScene = mazeHarness({ noSchedule: true });
  staticScene.renderer.setPlaying(true);
  assert.equal(staticScene.scheduled.size, 0);
  assertOpaqueFrame(staticScene);
  staticScene.renderer.destroy();
  console.log('PASS: missing/throwing context, allocation/draw/RAF failures, one-shot fallback callback and static-only rendering');
}
