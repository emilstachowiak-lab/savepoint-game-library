'use strict';

// Execute the real optional renderer with recorded Canvas2D drawing and RAF.
// These checks cover resource limits and lifecycle, rather than browser FPS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { canvasFixture } = require('./frontend-canvas.cjs');
const source = fs.readFileSync(path.join(__dirname, '..', 'pipes.js'), 'utf8');

function pipesHarness(options = {}) {
  const drawing = canvasFixture({ width: 1280, height: 720 });
  const scheduled = new Map();
  const context = drawing.main.getContext('2d');
  let nextFrame = 0;
  let failures = 0;
  let timestamp = 0;
  if (options.noContext) drawing.main.getContext = () => null;
  if (options.throwContext) drawing.main.getContext = () => { throw new Error('Synthetic context failure'); };
  const window = {};
  vm.runInNewContext(source, {
    window, devicePixelRatio: options.density ?? 2,
    requestAnimationFrame(callback) {
      if (options.throwSchedule) throw new Error('Synthetic RAF failure');
      scheduled.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame(id) { scheduled.delete(id); }
  }, { filename: 'pipes.js' });
  assert.equal(drawing.events.length, 0, 'Loading pipes.js must not draw or allocate an active scene');
  const renderer = window.SavepointPipes.create(drawing.main, () => { failures += 1; });
  return {
    drawing, context, renderer, scheduled,
    get failures() { return failures; },
    advance(milliseconds) {
      timestamp += milliseconds;
      const pending = [...scheduled.values()];
      scheduled.clear();
      for (const callback of pending) callback(timestamp);
    }
  };
}

{
  const test = pipesHarness();
  assert(test.renderer);
  assert(test.drawing.events.some(event => event[1] === 'stroke'));
  assert(test.drawing.events.some(event => event[1] === 'arc'));
  assert(test.drawing.main.width * test.drawing.main.height <= 2000000);
  const initial = test.drawing.snapshot();
  test.drawing.clear();
  test.renderer.resize();
  assert.equal(test.drawing.events.length, 0, 'An unchanged size must reuse its bitmap');
  test.renderer.setPlaying(true);
  assert.equal(test.scheduled.size, 1);
  for (let index = 0; index < 5; index += 1) test.advance(50);
  assert(test.drawing.events.some(event => event[1] === 'fillRect'));
  assert.notDeepEqual(test.drawing.snapshot(), initial);
  test.renderer.setPlaying(false);
  assert.equal(test.scheduled.size, 0);
  test.drawing.clear();
  test.advance(100000);
  assert.equal(test.drawing.events.length, 0, 'A paused scene must schedule no drawing');
  test.renderer.setPlaying(true);
  test.advance(50);
  assert.equal(test.failures, 0);
  test.renderer.destroy();
  test.renderer.destroy();
  assert.equal(test.scheduled.size, 0);
  assert.equal(test.drawing.main.width, 1);
  assert.equal(test.drawing.main.height, 1);
  console.log('PASS: lazy loading, glossy geometry, size reuse, active frames, pause/resume and idempotent cleanup');
}

{
  const test = pipesHarness({ density: 4 });
  for (const [width, height] of [[7680, 4320], [4320, 7680], [320, 740], [20000, 100], [1, 1]]) {
    test.drawing.size.width = width;
    test.drawing.size.height = height;
    test.renderer.resize();
    assert(test.drawing.main.width * test.drawing.main.height <= 2000000);
    assert(test.drawing.main.width <= 4096 && test.drawing.main.height <= 4096);
    assert.equal(test.failures, 0);
    test.drawing.clear();
  }
  test.drawing.size.width = 1280;
  test.drawing.size.height = 720;
  test.renderer.resize();
  test.renderer.setPlaying(true);
  for (let index = 0; index < 840; index += 1) {
    test.advance(50);
    test.drawing.clear();
  }
  assert.equal(test.failures, 0);
  assert.equal(test.scheduled.size, 1);
  test.renderer.destroy();
  console.log('PASS: bitmap budget on 8K/portrait/mobile viewports and a finite 42-second grow/restart cycle');
}

{
  assert.equal(pipesHarness({ noContext: true }).renderer, null);
  assert.equal(pipesHarness({ throwContext: true }).renderer, null);
  const schedule = pipesHarness({ throwSchedule: true });
  schedule.renderer.setPlaying(true);
  assert.equal(schedule.failures, 1);
  assert.equal(schedule.scheduled.size, 0);
  const drawing = pipesHarness();
  drawing.context.stroke = () => { throw new Error('Synthetic drawing failure'); };
  drawing.renderer.setPlaying(true);
  drawing.advance(50);
  assert.equal(drawing.failures, 1);
  assert.equal(drawing.scheduled.size, 0);
  drawing.renderer.resize();
  drawing.renderer.setPlaying(true);
  assert.equal(drawing.failures, 1);
  console.log('PASS: unavailable context and scheduling/drawing failures stop work and report only once');
}
