'use strict';

// Exercise review and explicit writes without a Gemini key or real game data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { harness, deferred, flush } = require('./frontend-dom.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'duplicates.js'), 'utf8');
const game = (id, fields) => ({ id, title: `Synthetic ${id}`, platform: 'PC', edition: 'Fizyczne',
  coverUrl: '', status: 'W trakcie', createdAt: 1200000000000, ...fields });
const left = game('left', { title: '<img src=x>', coverUrl: 'https://covers.example.test/left.jpg' });
const right = game('right', { platform: 'PlayStation 2, PC', edition: 'Cyfrowe', coverUrl: 'https://covers.example.test/right.jpg' });
const alternate = game('alternate');
const pair = (first, second, ticket, recommendation = 'merge') => ({ left: first, right: second, ticket, recommendation });

function setup({ games, candidates } = {}) {
  const test = harness();
  const calls = [], saved = [], reloads = [];
  let language = 'pl';
  let generation = 0;
  const button = test.document.createElement('button');
  const backdrop = test.document.createElement('div');
  test.document.tree.append(button, backdrop);
  test.context.AbortController = AbortController;
  const workers = [];
  if (candidates) {
    test.document.baseURI = 'https://example.test/';
    test.context.Worker = class {
      constructor(url, settings) {
        assert.equal(url.origin, 'https://example.test');
        assert.match(url.pathname, /duplicate-candidates\.mjs$/);
        assert.equal(settings.type, 'module');
        workers.push(this);
      }
      postMessage(message) {
        if (message.games) this.scan = candidates.createCandidateScan(message.games);
        else Promise.resolve().then(() => {
          if (!this.stopped) this.onmessage({ data: candidates.nextCandidatePage(this.scan, message.position) });
        });
      }
      terminate() { this.stopped = true; }
    };
  }
  vm.runInContext(source, test.context, { filename: 'duplicates.js' });
  const controller = test.context.window.SavepointDuplicates.create({
    button, backdrop, ensureReady: async () => {},
    ...(games ? { getGames: () => games } : {}),
    getGeneration: () => generation,
    isCurrent: owner => owner === generation,
    getLanguage: () => language,
    reloadCollection: async owner => { reloads.push(owner); },
    gameLabel: (field, value) => language === 'en' && field === 'edition' && value === 'Fizyczne i cyfrowe'
      ? 'Physical and digital' : value,
    errorText: error => [error.payload.error, error.payload.errorEnglish],
    request(body, owner, signal) {
      const call = { body: JSON.parse(JSON.stringify(body)), owner, signal, ...deferred() };
      calls.push(call);
      return call.promise;
    },
    onSaved: (result, mode) => saved.push({ result, mode })
  });
  const query = selector => backdrop.querySelector(selector);
  const click = node => test.fire(node, 'click');
  const status = () => query('#duplicatesStatus').textContent;
  const rows = () => backdrop.querySelectorAll('.duplicates-pair');
  async function scan(pairs, limited = false) {
    click(query('#duplicatesScan'));
    await flush();
    assert.deepEqual(calls.at(-1).body, { action: 'ai-duplicates-scan' });
    calls.at(-1).resolve({ pairs, limited });
    await flush();
  }
  function choose(row, side, action) {
    const radio = row.querySelectorAll('input[type="radio"]')[side];
    radio.checked = true;
    test.fire(radio, 'change');
    click(row.querySelectorAll('.duplicates-actions > button')[action]);
  }
  return { test, backdrop, button, calls, saved, reloads, workers, controller, query, click, status, rows, scan, choose,
    switchLanguage() { language = 'en'; controller.refreshLanguage(); },
    logout() { generation++; controller.clearPrivateData(); } };
}

async function run() {
  {
    const candidates = await import('../public/duplicate-candidates.mjs');
    const games = Array.from({ length: 10 }, (_, index) => game('scan-' + index,
      { title: 'Synthetic shared title', revision: 'a'.repeat(64) }));
    const ui = setup({ games, candidates });
    ui.controller.open();
    const scan = () => ui.click(ui.query('#duplicatesScan'));
    scan(); await flush();
    const first = ui.calls.at(-1);
    assert.deepEqual(Object.keys(first.body), ['action', 'pairs']);
    assert.equal(first.body.pairs.length, 32);
    assert(first.body.pairs.every(pair => pair.every(ref => ref.length === 2 && ref[0].startsWith('scan-'))));
    first.reject(Object.assign(new Error('Synthetic unavailable'), { status: 503 })); await flush();
    scan(); await flush();
    assert.deepEqual(ui.calls.at(-1).body, first.body, 'Retry retains the exact candidate batch');
    ui.calls.at(-1).resolve({ pairs: [], limited: false, cursor: null }); await flush();
    assert.equal(ui.query('.duplicates-limit').hidden, false);
    scan(); await flush();
    const final = ui.calls.at(-1);
    assert.equal(final.body.pairs.length, 13);
    assert.equal(ui.workers.length, 1, 'Continuations reuse the index in one Worker');
    final.resolve({ pairs: [], limited: false, cursor: null }); await flush();
    assert.equal(ui.query('.duplicates-limit').hidden, true);
    assert.equal(ui.workers[0].stopped, true);
    ui.controller.close();
    console.log('PASS: large scans page locally in one Worker and send only the current bounded batch of references');
  }
  {
    const ui = setup();
    ui.click(ui.button);
    assert.equal(ui.calls.length, 0, 'Opening the dialog must not start a scan');
    assert(ui.query('#duplicatesExplanation').textContent.includes('tytuły i platformy'));
    assert.equal(ui.test.document.activeElement, ui.query('#duplicatesScan'));
    const independent = pair(game('other'), game('second-other'), 'separate', 'delete');
    await ui.scan([pair(left, right, 'first'), pair(right, alternate, 'overlap'), independent], true);
    assert.equal(ui.rows().length, 3);
    assert.equal(ui.query('.duplicates-limit').hidden, false);
    assert(ui.rows()[0].textContent.includes('<img src=x>'));
    assert(ui.rows()[0].textContent.includes('Inna niż w drugim wpisie'));
    assert.equal(ui.query('img'), null, 'Titles are text and stored covers are not fetched');
    assert.equal(ui.rows()[0].querySelector('.duplicates-actions > button').disabled, true);

    ui.choose(ui.rows()[0], 1, 0);
    assert.equal(ui.calls.length, 1, 'Selecting merge must not write');
    const result = ui.rows()[0].querySelector('.duplicates-merged-details');
    assert(result.textContent.includes('PlayStation 2, PC'));
    assert(result.textContent.includes('Fizyczne i cyfrowe'));
    ui.switchLanguage();
    assert(result.textContent.includes('Physical and digital'));
    assert(ui.rows()[0].querySelector('.duplicates-confirmation > p').textContent.includes(left.title));
    ui.click(ui.rows()[0].querySelectorAll('.duplicates-confirmation button')[1]);
    await flush();
    assert.deepEqual(ui.calls.at(-1).body, { action: 'ai-duplicates-apply', ticket: 'first', mode: 'merge',
      keepId: 'right', confirmed: true, delta: true });
    assert.equal(ui.calls.at(-1).signal, undefined, 'Confirmed writes are not aborted on close');
    ui.calls.at(-1).resolve({ game: right, deletedId: left.id });
    await flush();
    assert.equal(ui.rows().length, 1, 'Remove all proposals involving either changed record');
    assert.equal(ui.saved[0].mode, 'merge');
    ui.controller.close();
    assert.equal(ui.test.document.activeElement, ui.button);
    assert.equal(ui.backdrop.textContent, '');
    console.log('PASS: consent, safe comparison, localized merge preview and explicit confirmation');
  }
  {
    const ui = setup();
    ui.controller.open();
    ui.click(ui.query('#duplicatesScan'));
    await flush();
    const scan = ui.calls.at(-1);
    ui.logout();
    assert.equal(scan.signal.aborted, true);
    assert.equal(ui.backdrop.hidden, true);
    scan.resolve({ pairs: [pair(left, right, 'stale')], limited: false });
    await flush();
    assert.equal(ui.backdrop.textContent, '');
    ui.controller.open();
    await ui.scan([]);
    assert(ui.status().includes('Nie znaleziono'));
    assert.equal(ui.query('.duplicates-limit').hidden, true);
    console.log('PASS: an aborted scan cannot restore private results after logout');
  }
  {
    const ui = setup();
    ui.controller.open();
    await ui.scan([pair(left, right, 'delete', 'delete')]);
    ui.choose(ui.rows()[0], 0, 1);
    const buttons = ui.rows()[0].querySelectorAll('.duplicates-confirmation button');
    ui.click(buttons[0]);
    assert.equal(ui.calls.length, 1, 'Cancelling the preview must not write');
    ui.choose(ui.rows()[0], 0, 1);
    ui.click(buttons[1]);
    await flush();
    assert.deepEqual(ui.calls.at(-1).body, { action: 'ai-duplicates-apply', ticket: 'delete', mode: 'delete',
      keepId: 'left', confirmed: true, delta: true });
    const changed = new Error('Conflict');
    changed.status = 409;
    changed.payload = { error: 'Wpis został zmieniony.', errorEnglish: 'The entry changed.' };
    ui.calls.at(-1).reject(changed);
    await flush();
    assert.equal(ui.saved.length, 0);
    assert.equal(ui.reloads.length, 1);
    assert.equal(ui.rows().length, 0);
    assert.equal(ui.status(), 'Wpis został zmieniony.');
    await ui.scan([pair(left, right, 'fresh', 'delete')]);
    ui.choose(ui.rows()[0], 0, 1);
    ui.click(ui.rows()[0].querySelectorAll('.duplicates-confirmation button')[1]);
    await flush();
    ui.controller.close();
    ui.calls.at(-1).resolve({ games: [left] });
    await flush();
    assert.equal(ui.saved[0].mode, 'delete');
    assert.equal(ui.backdrop.textContent, '');
    console.log('PASS: cancelling is read-only, conflicts clear stale proposals and completed removals update the collection');
  }
  {
    const ui = setup();
    ui.controller.open();
    ui.click(ui.query('#duplicatesScan'));
    await flush();
    ui.calls.at(-1).resolve({ pairs: [pair(left, right, 'first')], limited: true, cursor: 'next-page' });
    await flush();
    assert.equal(ui.calls.length, 1, 'The next page requires explicit user action');
    assert.match(ui.query('#duplicatesScan').textContent, /kolejne pary/);
    ui.click(ui.query('#duplicatesScan'));
    await flush();
    assert.deepEqual(ui.calls.at(-1).body, { action: 'ai-duplicates-scan', cursor: 'next-page' });
    ui.calls.at(-1).resolve({ pairs: [pair(right, alternate, 'second')], limited: false, cursor: null });
    await flush();
    assert.equal(ui.rows().length, 2, 'Earlier suggestions remain available during review');
    ui.choose(ui.rows()[0], 0, 1);
    ui.click(ui.rows()[0].querySelectorAll('.duplicates-confirmation button')[1]);
    await flush();
    ui.calls.at(-1).reject(new Error('Synthetic lost write response'));
    await flush();
    assert.equal(ui.reloads.length, 1);
    assert.equal(ui.rows().length, 0);
    assert.match(ui.status(), /Odświeżono kolekcję/);
    console.log('PASS: continuation sends the opaque cursor and a lost write refreshes the collection');
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
