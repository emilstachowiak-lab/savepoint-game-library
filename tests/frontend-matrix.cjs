'use strict';

// Run the actual text renderer with finite-coordinate checks and a controlled
// frame queue. Snapshots verify time behavior without copying its calculations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'matrix.js'), 'utf8');

function matrixHarness(options = {}) {
  const size = { width: options.width ?? 640, height: options.height ?? 360 };
  const scheduled = new Map();
  const paints = [];
  let current = null;
  let nextFrame = 0;
  let failures = 0;
  let reads = 0;
  let drawingFailure = options.throwDraw === true;
  let schedulingFailure = options.throwSchedule === true;
  const context = {
    setTransform(...values) { assert(values.every(Number.isFinite)); },
    fillRect(...values) {
      if (drawingFailure) throw new Error('Synthetic drawing failure');
      assert(values.every(Number.isFinite));
      current = [];
      paints.push(current);
    },
    fillText(glyph, x, y) {
      assert(Number.isFinite(x) && Number.isFinite(y));
      assert.equal(Array.from(glyph).length, 1);
      assert(!this.fillStyle.includes('NaN'));
      current.push([glyph, x, y, this.fillStyle, this.globalAlpha, this.font]);
    }
  };
  const canvas = {
    width: 1, height: 1,
    getBoundingClientRect() { return { ...size }; },
    getContext() {
      reads += 1;
      if (options.throwContext) throw new Error('Synthetic context failure');
      return options.noContext ? null : context;
    }
  };
  const window = { devicePixelRatio: options.dpr ?? 2 };
  const sandbox = {
    window,
    requestAnimationFrame(callback) {
      if (schedulingFailure) throw new Error('Synthetic scheduling failure');
      scheduled.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame(id) { scheduled.delete(id); }
  };
  if (options.noSchedule) delete sandbox.requestAnimationFrame;
  vm.runInNewContext(source, sandbox, { filename: 'matrix.js' });
  assert.deepEqual(Object.keys(window), ['devicePixelRatio', 'SavepointMatrix']);
  assert.equal(reads, 0, 'Module loading must not touch the canvas');
  assert.equal(paints.length, 0);
  assert.equal(scheduled.size, 0);
  const renderer = window.SavepointMatrix.create(canvas, () => { failures += 1; });
  return {
    canvas, context, renderer, scheduled, paints, size,
    get failures() { return failures; },
    snapshot() { return JSON.stringify(paints.at(-1)); },
    failDraw() { drawingFailure = true; },
    failSchedule() { schedulingFailure = true; },
    advance(timestamp) {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      callbacks.forEach(callback => callback(timestamp));
    }
  };
}

{
  const test = matrixHarness();
  assert(test.renderer);
  assert.equal(test.paints.length, 1, 'A paused renderer must start with a useful scene');
  const glyphs = test.paints[0];
  assert(glyphs.length > 300, 'The initial scene must contain dense code streams');
  assert(new Set(glyphs.map(glyph => glyph[1])).size > 50, 'Streams should fill the desktop width');
  assert(new Set(glyphs.map(glyph => glyph[5])).size > 1, 'Stream depth must vary');
  assert(glyphs.some(glyph => glyph[3] === '#d8ffdf'), 'Bright leading glyphs should be present');
  assert(glyphs.some(glyph => /[\u30a0-\u30ff]/.test(glyph[0])), 'Include katakana');
  assert(glyphs.some(glyph => /\d/.test(glyph[0])), 'Include digits');
  const initial = test.snapshot();
  test.renderer.resize();
  test.renderer.setPlaying(false);
  assert.equal(test.snapshot(), initial, 'Repeated paused updates must preserve glyphs and positions');
  assert.equal(test.paints.length, 1, 'An unchanged resize should not repaint');
  test.renderer.setPlaying(true);
  test.advance(1000);
  assert.equal(test.snapshot(), initial, 'The first frame must not invent elapsed time');
  for (let timestamp = 1050; timestamp <= 2000; timestamp += 50) test.advance(timestamp);
  assert.notEqual(test.snapshot(), initial, 'Streams must move and mutate while playing');
  test.renderer.setPlaying(false);
  const paused = test.snapshot();
  assert.equal(test.scheduled.size, 0);
  test.renderer.setPlaying(true);
  test.advance(1000000);
  assert.equal(test.snapshot(), paused, 'Time spent paused must not cause a resumed jump');
  test.advance(1000050);
  assert.notEqual(test.snapshot(), paused);
  test.renderer.destroy();
  test.renderer.destroy();
  assert.equal(test.scheduled.size, 0);
  assert.equal(test.canvas.width * test.canvas.height, 1);
  assert.equal(test.failures, 0);
}

for (const [width, height] of [[320, 800], [7680, 4320], [30000, 30000], [1, 1]]) {
  const test = matrixHarness({ width, height, dpr: 3 });
  assert(test.renderer);
  assert(test.canvas.width * test.canvas.height <= 1400000, 'The backing bitmap must stay within its pixel budget');
  assert(test.canvas.width <= width * 1.5 && test.canvas.height <= height * 1.5);
  assert(test.paints[0].length <= 216 * 42, 'Per-frame glyph work must stay bounded');
  test.renderer.destroy();
}

{
  const test = matrixHarness({ width: 0, height: 0 });
  assert(test.renderer, 'A temporarily hidden stage must be allowed to initialize');
  assert.equal(test.paints.length, 0);
  assert.equal(test.failures, 0);
  test.size.width = 640;
  test.size.height = 360;
  test.renderer.resize();
  assert.equal(test.paints.length, 1);
  const before = test.snapshot();
  test.size.width = 800;
  test.renderer.resize();
  assert.notEqual(test.snapshot(), before);
  test.renderer.destroy();
}

{
  const test = matrixHarness();
  test.renderer.setPlaying(true);
  test.advance(1000);
  const before = test.paints.length;
  for (let timestamp = 1001; timestamp <= 1100; timestamp += 1) test.advance(timestamp);
  assert(test.paints.length - before <= 3, 'High-refresh displays must not trigger unbounded text paints');
  test.renderer.destroy();
}

for (const failure of [{ noContext: true }, { throwContext: true }, { throwDraw: true }, { width: Infinity }]) {
  const test = matrixHarness(failure);
  assert.equal(test.renderer, null);
  assert.equal(test.failures, 1);
  assert.equal(test.scheduled.size, 0);
  assert.equal(test.canvas.width * test.canvas.height, 1);
}
for (const failure of [{ throwSchedule: true }, { noSchedule: true }, {}]) {
  const test = matrixHarness(failure);
  assert(test.renderer);
  test.renderer.setPlaying(true);
  if (!failure.throwSchedule && !failure.noSchedule) {
    test.failDraw();
    test.advance(1000);
  }
  test.renderer.setPlaying(true);
  test.renderer.resize();
  test.renderer.destroy();
  assert.equal(test.failures, 1, 'Failures should be reported once');
  assert.equal(test.scheduled.size, 0);
  assert.equal(test.canvas.width * test.canvas.height, 1);
}

console.log('Matrix renderer: scene, timing, pause/resume, budgets and failure cleanup passed.');
