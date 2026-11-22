'use strict';

// Run the photo workflow with the real application DOM and deterministic camera,
// image encoder and API boundaries. No private photos, network or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { harness, deferred, flush } = require('./frontend-dom.cjs');
const source = fs.readFileSync(path.join(__dirname, '..', 'ai-import.js'), 'utf8');
const uploadId = 'a'.repeat(32);
const firstGame = { title: 'Synthetic first game', platform: 'PC', confidence: 'high', note: '' };
const secondGame = { title: 'Synthetic second game', platform: 'PlayStation 2', confidence: 'low', note: 'Synthetic uncertain platform' };

function setup({ existing = [], language = 'pl', camera, bitmap } = {}) {
  const test = harness();
  test.seed(existing);
  const calls = [], notices = [], saved = [], encoders = [], streams = [];
  let sequence = 0, active = true, currentLanguage = language;
  const bytes = Uint8Array.from({ length: 50000 }, (_, index) => index % 251);
  const originalCreate = test.document.createElement;
  test.document.createElement = tag => {
    if (tag !== 'canvas') return originalCreate(tag);
    const canvas = { width: 1, height: 1, draws: [], getContext() {
      return { fillRect() {}, drawImage: (...args) => canvas.draws.push(args) };
    }, toBlob(callback, type) {
      callback({ type, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });
    } };
    encoders.push(canvas);
    return canvas;
  };
  test.context.AbortController = AbortController;
  test.context.btoa = value => Buffer.from(value, 'binary').toString('base64');
  test.context.crypto = { randomUUID() { return '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0'); } };
  test.context.createImageBitmap = bitmap || (async () => ({ width: 2400, height: 1800, close() {} }));
  test.context.navigator = { mediaDevices: camera ? { getUserMedia: async constraints => {
    assert.equal(constraints.audio, false);
    assert.equal(constraints.video.facingMode.ideal, 'environment');
    const stream = await camera(constraints); streams.push(stream); return stream;
  } } : {} };
  vm.runInContext(source, test.context, { filename: 'ai-import.js' });
  const button = test.nodes.addAiBtn || test.document.createElement('button');
  const backdrop = test.nodes.aiImportBackdrop || test.document.createElement('div');
  if (!button.isConnected) test.document.tree.append(button);
  if (!backdrop.isConnected) test.document.tree.append(backdrop);
  button.onclick = null;
  const platformGroups = test.nodes.platformOptions.querySelectorAll('.platform-group')
    .filter(group => !group.hasAttribute('data-extra-platforms')).map(group => ({
      name: group.dataset.platformGroup,
      englishName: group.querySelector('legend').getAttribute('data-en') || group.dataset.platformGroup,
      platforms: group.querySelectorAll('input[name="platform"]').map(input => input.value)
    }));
  const controller = test.context.window.SavepointAiImport.create({
    button, backdrop,
    request(body, generation, signal) {
      const call = { body, generation, signal, ...deferred() }; calls.push(call); return call.promise;
    },
    ensureReady: async () => {}, getGeneration: () => 0, isCurrent: generation => active && generation === 0,
    getGames: () => existing, getLanguage: () => currentLanguage,
    errorText: error => [error.message, error.englishMessage || error.message],
    notify: (...args) => notices.push(args), onSaved: (...args) => saved.push(args),
    platforms: platformGroups.flatMap(group => group.platforms), platformGroups
  });
  const query = selector => backdrop.querySelector(selector);
  async function open(available = true) {
    const opening = controller.open(); await flush();
    assert.equal(calls.at(-1).body.action, 'ai-status');
    calls.at(-1).resolve({ available }); await opening;
  }
  async function photo(file = { type: 'image/jpeg', size: 100000 }) {
    const input = query('#aiImportFile'); input.files = [file];
    test.fire(input, 'change'); await flush();
  }
  async function identify(candidates = [firstGame, secondGame], details = {}) {
    test.fire(query('#aiImportAnalyze'), 'click'); await flush();
    const start = calls.at(-1); assert.equal(start.body.action, 'ai-upload-start');
    start.resolve({ uploadId, offset: 0, chunkBytes: 32768 }); await flush();
    while (calls.at(-1).body.action === 'ai-upload-chunk') {
      const chunk = calls.at(-1);
      const decoded = Buffer.from(chunk.body.data, 'base64');
      assert(decoded.length <= 32768);
      assert(new TextEncoder().encode(JSON.stringify(chunk.body)).length < 65536);
      chunk.resolve({ offset: chunk.body.offset + decoded.length }); await flush();
    }
    const recognition = calls.at(-1); assert.equal(recognition.body.action, 'ai-recognize');
    recognition.resolve({ candidates, notes: 'Synthetic review note', ...details }); await flush();
  }
  function field(index, name) { return query(`[data-ai-candidate="${index}"]`).querySelector(`[data-ai-field="${name}"]`); }
  const card = index => query(`[data-ai-candidate="${index}"]`);
  const preview = index => {
    const frame = card(index).querySelector('.cover-preview-frame');
    return { frame, image: frame.querySelector('.ai-import-cover-image'),
      placeholder: frame.querySelector('.cover-preview-placeholder'), title: frame.querySelector('.cover-preview-title'),
      status: frame.querySelector('.cover-preview-status') };
  };
  function editCover(index, value, commit = false) {
    const input = field(index, 'coverUrl'); input.value = value;
    test.fire(input, commit ? 'change' : 'input');
    if (!commit) test.runTimers(200);
  }
  const platforms = index => card(index).querySelectorAll('.platform-option input');
  const tabs = index => card(index).querySelectorAll('.platform-tabs [role="tab"]');
  function pick(index, value, checked = true) {
    const input = platforms(index).find(input => input.value === value);
    assert(input, 'Expected platform ' + value); input.checked = checked; test.fire(input, 'change'); return input;
  }
  function confirm() { const input = query('#aiImportConfirm'); input.checked = true; test.fire(input, 'change'); }
  function clickSave() { test.fire(query('#aiImportSave'), 'click'); }
  return { ...test, calls, notices, saved, encoders, streams, bytes, controller, button, backdrop, query, open, photo, identify, field, card, preview, editCover, platforms, tabs, pick, platformGroups, confirm, clickSave,
    setLanguage(value) { currentLanguage = value; controller.refreshLanguage(); }, expire() { active = false; controller.clearPrivateData(); } };
}

async function main() {
  {
    const test = setup(); await test.open(false);
    assert.equal(test.query('#aiImportStatus').getAttribute('role'), 'alert');
    assert.equal(test.query('#aiImportStatus').textContent, 'Funkcja Dodaj Gry AI jest niedostępna bez klucza Gemini API.');
    assert.equal(test.notices.length, 1);
    assert.equal(test.notices[0][1], 'Add Games AI is unavailable without a Gemini API key.');
    assert.equal(test.query('#aiImportAnalyze').disabled, true);
    assert.equal(test.query('#aiImportChoose').disabled, false, 'A local preview does not require an API key');
    await test.photo();
    assert(test.query('.ai-import-preview').src.startsWith('data:image/jpeg;base64,'));
    test.fire(test.query('#aiImportAnalyze'), 'click'); await flush();
    assert.equal(test.calls.length, 1, 'No upload or recognition request is allowed without configuration');
    test.setLanguage('en');
    assert.equal(test.query('#aiImportStatus').textContent, 'Add Games AI is unavailable without a Gemini API key.');
    test.controller.destroy();
    console.log('PASS: missing API key produces the exact PL/EN error and toast; local previews remain available without uploading');
  }
  {
    const test = setup({ language: 'en' }); await test.open(false);
    assert.equal(test.query('#aiImportStatus').textContent, 'Add Games AI is unavailable without a Gemini API key.');
    assert.equal(test.query('#aiImportStatus').getAttribute('role'), 'alert');
    assert.equal(test.notices[0][0], 'Funkcja Dodaj Gry AI jest niedostępna bez klucza Gemini API.');
    assert(test.query('#aiImportExplanation').textContent.includes('Google Gemini'));
    assert(test.query('#aiImportExplanation').textContent.includes('IGDB and SteamGridDB for covers and checks Wikipedia if it finds no match'));
    test.setLanguage('pl');
    assert(test.query('#aiImportExplanation').textContent.includes('gdy nie znajdzie pasującej okładki, sprawdza Wikipedię'));
    assert(!test.backdrop.textContent.includes('OpenAI'));
    test.controller.destroy();
    console.log('PASS: opening in English exposes Gemini privacy wording and the exact missing-key alert');
  }
  {
    const test = setup(); await test.open(); await test.photo();
    assert.equal(test.calls.length, 1, 'Selecting a photo is local');
    assert.equal(test.encoders[0].width, 1, 'Canvas backing memory is released');
    assert.equal(test.encoders[0].draws[0][3], 1600);
    assert.equal(test.encoders[0].draws[0][4], 1200);
    await test.identify();
    assert.equal(test.backdrop.querySelectorAll('[data-ai-candidate]').length, 2);
    assert.equal(test.field(0, 'selected').checked, true);
    assert.equal(test.field(1, 'selected').checked, false, 'Uncertain recognition needs deliberate selection');
    assert.equal(test.query('#aiImportSave').disabled, true);
    test.clickSave(); await flush();
    assert(!test.calls.some(call => call.body.action === 'ai-add'));
    test.controller.destroy();
    console.log('PASS: metadata-free resized preview, bounded chunk upload and multi-game recognition never add games automatically');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify();
    test.field(1, 'selected').checked = true; test.fire(test.field(1, 'selected'), 'change');
    test.field(1, 'title').value = 'Corrected second game'; test.fire(test.field(1, 'title'), 'input');
    test.field(1, 'status').value = 'Ograna'; test.fire(test.field(1, 'status'), 'change');
    test.confirm(); assert.equal(test.query('#aiImportSave').disabled, false);
    test.clickSave(); test.clickSave(); await flush();
    const saves = test.calls.filter(call => call.body.action === 'ai-add'); assert.equal(saves.length, 1);
    const body = saves[0].body; assert.equal(body.confirmed, true); assert.equal(body.games.length, 2);
    assert.equal(body.games[1].title, 'Corrected second game'); assert.equal(body.games[1].status, 'Ograna');
    assert.notEqual(body.games[0].id, body.games[1].id);
    assert.deepEqual(Object.keys(body.games[0]).sort(), ['coverUrl', 'createdAt', 'edition', 'id', 'platform', 'status', 'title']);
    saves[0].resolve({ games: [], inserted: 2 }); await flush();
    assert.equal(test.saved.length, 1); assert.equal(test.saved[0][1], 2);
    assert.equal(test.backdrop.hidden, true); assert.equal(test.backdrop.children.length, 0);
    console.log('PASS: corrected multiple games require explicit confirmation, one additive request and successful-save cleanup');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify([firstGame]);
    test.confirm(); test.field(0, 'title').value = 'Edited after confirmation'; test.fire(test.field(0, 'title'), 'input');
    assert.equal(test.query('#aiImportConfirm').checked, false, 'Changing a selected value invalidates confirmation');
    test.confirm(); test.clickSave(); await flush();
    const first = test.calls.at(-1); const payload = JSON.stringify(first.body);
    first.reject(new Error('Synthetic lost response')); await flush();
    assert.equal(test.field(0, 'title').disabled, true, 'An uncertain save keeps its original payload locked');
    assert(test.platforms(0).every(input => input.disabled), 'An uncertain save must lock every platform checkbox');
    assert(test.tabs(0).every(tab => tab.disabled), 'An uncertain save must lock the platform tabs');
    assert.equal(test.query('.ai-import-retry-hint').hidden, false);
    test.clickSave(); await flush();
    assert.equal(JSON.stringify(test.calls.at(-1).body), payload);
    test.calls.at(-1).resolve({ games: [], inserted: 0 }); await flush();
    assert.equal(test.saved.length, 1);
    console.log('PASS: edits invalidate confirmation and uncertain save retries reuse exact stable IDs, timestamps and fields');
  }
  {
    const test = setup(); await test.open(); await test.photo();
    test.fire(test.query('#aiImportAnalyze'), 'click'); await flush();
    test.calls.at(-1).resolve({ uploadId, offset: 0, chunkBytes: 45000, expiresIn: 900 }); await flush();
    const first = test.calls.at(-1);
    first.resolve({ offset: 45000 }); await flush();
    const second = test.calls.at(-1);
    const sent = JSON.stringify(second.body);
    second.reject(new Error('Synthetic lost chunk response')); await flush();
    for (const delay of [300, 1000]) {
      test.runTimers(delay); await flush();
      assert.equal(JSON.stringify(test.calls.at(-1).body), sent);
      test.calls.at(-1).reject(new Error('Synthetic interrupted connection')); await flush();
    }
    assert.match(test.query('#aiImportStatus').textContent, /wznowić/);
    test.fire(test.query('#aiImportAnalyze'), 'click'); await flush();
    assert.equal(JSON.stringify(test.calls.at(-1).body), sent, 'Explicit retry resumes at the last confirmed offset');
    test.calls.at(-1).resolve({ offset: 50000 }); await flush();
    assert.equal(test.calls.at(-1).body.action, 'ai-recognize');
    test.calls.at(-1).resolve({ candidates: [firstGame] }); await flush();
    test.controller.destroy();
    console.log('PASS: upload retries replay the exact chunk, cap automatic attempts and can resume manually');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify([firstGame]);
    test.editCover(0, 'https://okładka.example/gry/Żółć.jpg', true);
    test.confirm(); test.clickSave(); await flush();
    const save = test.calls.at(-1);
    assert.equal(save.body.delta, true);
    assert.equal(save.body.games[0].coverUrl, 'https://xn--okadka-4db.example/gry/%C5%BB%C3%B3%C5%82%C4%87.jpg');
    const rejected = new Error('Synthetic validation failure');
    rejected.status = 422;
    save.reject(rejected); await flush();
    assert.equal(test.field(0, 'title').disabled, false);
    assert.equal(test.query('.ai-import-retry-hint').hidden, true);
    test.editCover(0, 'http://images.example/cover.png', true);
    test.confirm(); test.clickSave(); await flush();
    assert.equal(test.calls.at(-1), save, 'Insecure replacement covers never reach the batch API');
    test.editCover(0, 'https://images.example/cover.png', true);
    test.confirm(); test.clickSave(); await flush();
    test.calls.at(-1).resolve({ addedGames: [], inserted: 1 }); await flush();
    assert.equal(test.saved.length, 1);
    console.log('PASS: definite rejection unlocks corrections and saving sends a canonical HTTPS cover');
  }
  {
    const test = setup({ existing: [{ title: firstGame.title, platform: 'PC' }] });
    await test.open(); await test.photo(); await test.identify([firstGame, { ...firstGame, title: '<img src=x onerror=alert(1)>', note: '<script>evil()</script>' }]);
    assert.equal(test.field(0, 'selected').checked, false);
    assert.equal(test.query('.ai-import-warning').hidden, false);
    assert.equal(test.field(1, 'title').value, '<img src=x onerror=alert(1)>');
    assert.equal(test.backdrop.querySelectorAll('script').length, 0);
    assert.equal(test.backdrop.querySelectorAll('img').length, 3, 'Only the photo and two application-owned cover previews can create images');
    assert(test.backdrop.querySelectorAll('.ai-import-cover-image').every(image => image.hidden && !image.hasAttribute('src')),
      'Model text must not create an active cover image');
    test.setLanguage('en'); assert.equal(test.query('#aiImportSave').textContent, 'Add selected games');
    assert.equal(test.field(1, 'title').value, '<img src=x onerror=alert(1)>');
    test.controller.destroy();
    console.log('PASS: duplicate warnings, safe text rendering and live language changes preserve candidate data without active markup');
  }
  {
    const test = setup(); await test.open(); await test.photo();
    await test.identify([firstGame, { ...firstGame, title: '  SYNTHETIC FIRST GAME  ', platform: ' pc ' }]);
    assert.equal(test.field(0, 'selected').checked, false);
    assert.equal(test.field(1, 'selected').checked, false);
    assert(test.backdrop.querySelectorAll('.ai-import-warning').every(warning => warning.hidden === false));
    test.field(1, 'title').value = 'Synthetic distinct title'; test.fire(test.field(1, 'title'), 'input');
    assert(test.backdrop.querySelectorAll('.ai-import-warning').every(warning => warning.hidden === true));
    test.controller.destroy();
    console.log('PASS: repeated title/platform suggestions are not preselected and duplicate warnings follow edits');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify();
    const presetValues = test.platformGroups.flatMap(group => group.platforms);
    assert.deepEqual(test.platforms(0).map(input => input.value), presetValues, 'AI must expose the same preset consoles as Add Game');
    assert.equal(test.card(0).querySelector('input[list]'), null, 'The old free-text platform control must be replaced');
    assert(test.card(0).classList.contains('game-modal'), 'Shared form and theme styling must apply to the picker');
    assert.equal(test.tabs(0).length, 5);
    assert.equal(test.tabs(0).find(tab => tab.getAttribute('aria-selected') === 'true').dataset.platformGroup, 'Pozostałe');
    assert.equal(test.tabs(1).find(tab => tab.getAttribute('aria-selected') === 'true').dataset.platformGroup, 'Sony');
    test.confirm(); test.pick(0, 'Xbox 360');
    assert.equal(test.query('#aiImportConfirm').checked, false, 'Changing consoles must require confirmation again');
    test.pick(0, 'PlayStation 5');
    const sony = test.tabs(0).find(tab => tab.dataset.platformGroup === 'Sony'); test.fire(sony, 'click');
    assert.equal(test.tabs(1).find(tab => tab.getAttribute('aria-selected') === 'true').dataset.platformGroup, 'Sony');
    assert.equal(test.platforms(1).filter(input => input.checked).map(input => input.value).join(', '), 'PlayStation 2', 'Other rows must retain their own choices');
    assert.equal(test.card(0).querySelectorAll('.selected-platform-chip').length, 3);
    assert.match(test.card(0).querySelector('.platform-selection-count').textContent, /\b3\b/);
    assert.equal(test.nodes.platform.querySelectorAll('input[name="platform"]').filter(input => input.checked).length, 0, 'AI selection must not alter Add Game');
    const ids = test.backdrop.querySelectorAll('[id]').map(element => element.id);
    assert.equal(new Set(ids).size, ids.length, 'Every candidate needs unique tab, panel and help IDs');
    for (const index of [0, 1]) for (const tab of test.tabs(index)) {
      const panel = test.document.getElementById(tab.getAttribute('aria-controls'));
      assert(panel && test.card(index).contains(panel));
      assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
      assert.equal(panel.getAttribute('role'), 'tabpanel');
    }
    test.confirm(); test.clickSave(); await flush();
    assert.equal(test.calls.at(-1).body.action, 'ai-add');
    assert.equal(test.calls.at(-1).body.games[0].platform, 'Xbox 360, PlayStation 5, PC', 'Save uses the ordinary form order across producer groups');
    test.controller.destroy();
    console.log('PASS: AI reuses the complete grouped picker, independent selections and accessible IDs; multiple consoles save in form order');
  }
  {
    const unknown = 'Synthetic <img src=x onerror=alert(1)> console';
    const test = setup(); await test.open(); await test.photo();
    await test.identify([{ ...firstGame, platform: 'PlayStation 2, ' + unknown }, { ...secondGame, platform: 'PC' }]);
    const extra = test.platforms(0).find(input => input.value === unknown);
    assert(extra && extra.checked, 'An unlisted AI platform must not disappear');
    assert.equal(test.tabs(0).length, 6); assert.equal(test.tabs(1).length, 5);
    assert.equal(test.card(0).querySelectorAll('img').length, 1, 'Detected platform names must remain inert text beside the application-owned preview');
    assert.equal(test.card(0).querySelector('img').getAttribute('src'), null);
    assert(test.card(0).querySelector('.selected-platforms').textContent.includes(unknown));
    const tabs = test.tabs(0), first = tabs[0], last = tabs.at(-1);
    test.fire(first, 'keydown', { key: 'ArrowRight' });
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true'); assert.equal(test.document.activeElement, tabs[1]);
    test.fire(tabs[1], 'keydown', { key: 'End' }); assert.equal(last.getAttribute('aria-selected'), 'true');
    test.fire(last, 'keydown', { key: 'ArrowRight' }); assert.equal(first.getAttribute('aria-selected'), 'true');
    test.fire(first, 'keydown', { key: 'ArrowLeft' }); assert.equal(last.getAttribute('aria-selected'), 'true');
    test.fire(last, 'keydown', { key: 'Home' }); assert.equal(first.getAttribute('aria-selected'), 'true');
    assert.equal(tabs.filter(tab => tab.tabIndex === 0).length, 1);
    assert.equal(test.card(0).querySelectorAll('.platform-group').filter(group => !group.hidden).length, 1);
    test.setLanguage('en');
    assert.equal(tabs.find(tab => tab.dataset.platformGroup === 'Pozostałe').querySelector('span').textContent, 'Other');
    assert(test.card(0).querySelector('.platform-picker-label').textContent.includes('Consoles'));
    assert(test.card(0).querySelector('.selected-platforms').textContent.includes('Selected:'));
    assert.equal(test.platforms(0).find(input => input.value === 'Inna').closest('label').querySelector('span').textContent, 'Other');
    assert(extra.checked); test.setLanguage('pl');
    assert(test.card(0).querySelector('.platform-picker-label').textContent.includes('Konsole'));
    test.controller.destroy();
    console.log('PASS: unknown platforms stay safe and selected; producer keyboard navigation and live PL/EN labels preserve row state');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify([firstGame]);
    test.pick(0, 'PC', false);
    const sony = test.tabs(0).find(tab => tab.dataset.platformGroup === 'Sony'); test.fire(sony, 'click');
    test.confirm(); test.clickSave(); await flush();
    assert(!test.calls.some(call => call.body.action === 'ai-add'), 'Missing consoles must never reach the save endpoint');
    const invalid = test.reportedValidity.at(-1); assert(invalid, 'Missing consoles must expose native validity');
    assert(test.platforms(0).includes(invalid));
    assert(invalid.validationMessage); assert.equal(test.document.activeElement, invalid);
    assert.equal(invalid.closest('.platform-group').hidden, false, 'Validation must reveal the invalid checkbox before focusing it');
    test.pick(0, 'PlayStation 2'); test.confirm(); test.clickSave(); await flush();
    assert.equal(test.calls.at(-1).body.action, 'ai-add');
    assert.equal(test.calls.at(-1).body.games[0].platform, 'PlayStation 2');
    test.controller.destroy();
    console.log('PASS: an empty platform selection blocks saving and reveals a visible native checkbox for correction');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify();
    const links = index => test.card(index).querySelectorAll('.cover-search-links .cover-search');
    function checkLinks(index, title) {
      const [google, covers] = links(index); assert(google && covers);
      assert.equal(google.href, 'https://www.google.com/search?udm=2&q=' + encodeURIComponent(title ? title + ' game cover' : 'video game cover'));
      assert.equal(covers.href, 'https://www.thecoverproject.net/view.php?searchstring=' + encodeURIComponent(title));
      assert.deepEqual([...new URL(google.href).searchParams.keys()].sort(), ['q', 'udm']);
      for (const link of [google, covers]) {
        assert.equal(link.getAttribute('target'), '_blank');
        const rel = link.getAttribute('rel').split(/\s+/); assert(rel.includes('noopener') && rel.includes('noreferrer'));
        assert.equal(link.querySelector('img'), null);
        assert.equal(link.getAttribute('onclick'), null, 'Cover searches must retain native link behavior');
      }
    }
    checkLinks(0, firstGame.title); checkLinks(1, secondGame.title);
    assert(links(0)[0].textContent.includes('Szukaj w Grafice Google'));
    assert(links(0)[1].textContent.includes('Szukaj w The Cover Project'));
    const title = '  Źródło & #1? cover=<img src=x onerror=alert(1)> / 日本語  ';
    const callsBefore = test.calls.length;
    test.field(0, 'title').value = title; test.fire(test.field(0, 'title'), 'input');
    checkLinks(0, title.trim()); checkLinks(1, secondGame.title);
    test.field(0, 'title').value = '   '; test.fire(test.field(0, 'title'), 'input'); checkLinks(0, '');
    test.setLanguage('en');
    assert(links(0)[0].textContent.includes('Search Google Images'));
    assert(links(0)[1].textContent.includes('Search The Cover Project'));
    assert.equal(test.calls.length, callsBefore, 'Preparing search links must not send titles anywhere');
    const staleLinks = links(1); test.controller.close();
    assert(staleLinks.every(link => !link.isConnected), 'Closing must discard private title queries with the rest of the draft');
    console.log('PASS: each AI cover field has isolated native search links with safely encoded live titles, blank defaults and PL/EN labels');
  }
  {
    const test = setup(); await test.open(); await test.photo();
    const firstUrl = 'https://images.example.invalid/first-result.png';
    const secondUrl = 'https://images.example.invalid/second-result.png';
    const sourceUrl = 'https://en.wikipedia.org/?curid=123';
    await test.identify([
      { ...firstGame, coverUrl: firstUrl, coverSource: 'wikipedia', coverSourceUrl: sourceUrl },
      { ...secondGame, confidence: 'high', coverUrl: secondUrl, coverSourceUrl: 'javascript:alert(1)' }
    ]);
    const suggestion = index => test.card(index).querySelector('.ai-import-cover-suggestion');
    assert.equal(test.field(0, 'coverUrl').value, firstUrl);
    assert.equal(test.field(1, 'coverUrl').value, secondUrl);
    assert.deepEqual(test.images.map(image => image.src), [firstUrl, secondUrl], 'Suggested covers begin loading with the results');
    test.images[0].onload();
    assert.equal(test.preview(0).image.src, firstUrl);
    assert.equal(test.preview(0).image.referrerPolicy, 'no-referrer');
    assert.equal(suggestion(0).querySelector('a').href, sourceUrl);
    assert.equal(suggestion(0).querySelector('a').textContent, 'Źródło w Wikipedii');
    assert.equal(suggestion(0).querySelector('a').getAttribute('rel'), 'noopener noreferrer');
    assert.equal(suggestion(1).querySelector('a'), null);
    test.setLanguage('en');
    assert(suggestion(0).textContent.includes('Cover selected by Gemini'));
    assert.equal(suggestion(0).querySelector('a').textContent, 'Source on Wikipedia');
    test.confirm();
    const replacement = 'https://images.example.invalid/own-cover.png';
    test.editCover(0, replacement, true);
    assert(suggestion(0).hidden && !suggestion(1).hidden);
    assert.equal(test.query('#aiImportConfirm').checked, false, 'Changing a suggested cover requires review again');
    test.editCover(1, '', true);
    assert(suggestion(1).hidden);
    assert.equal(test.preview(1).image.src, '');
    test.confirm(); test.clickSave(); await flush();
    const save = test.calls.at(-1);
    assert.equal(save.body.action, 'ai-add');
    assert.deepEqual(Array.from(save.body.games, game => game.coverUrl), [replacement, '']);
    save.resolve({ games: [], inserted: 2 }); await flush();
    test.controller.destroy();
    console.log('PASS: Wikipedia covers show their source in Polish and English, preview immediately and can be replaced or cleared before saving');
  }
  {
    const test = setup(); await test.open(); await test.photo();
    const igdbUrl = 'https://www.igdb.com/games/first-game';
    const steamGridDbUrl = 'https://www.steamgriddb.com/game/123';
    await test.identify([
      { ...firstGame, coverUrl: 'https://images.example.invalid/first.png', coverSource: 'igdb', coverSourceUrl: igdbUrl },
      { ...secondGame, coverUrl: 'https://images.example.invalid/second.png', coverSource: 'steamgriddb', coverSourceUrl: steamGridDbUrl }
    ]);
    const sourceLink = index => test.card(index).querySelector('.ai-import-cover-suggestion a');
    assert.equal(sourceLink(0).href, igdbUrl);
    assert.equal(sourceLink(1).href, steamGridDbUrl);
    assert.equal(sourceLink(0).textContent, 'Źródło w IGDB');
    assert.equal(sourceLink(1).textContent, 'Źródło w SteamGridDB');
    assert.equal(sourceLink(0).getAttribute('aria-label'), 'Źródło w IGDB (otwiera nową kartę)');
    test.setLanguage('en');
    assert.equal(sourceLink(0).textContent, 'Source on IGDB');
    assert.equal(sourceLink(1).textContent, 'Source on SteamGridDB');
    assert.equal(sourceLink(1).getAttribute('aria-label'), 'Source on SteamGridDB (opens in a new tab)');
    test.controller.destroy();
    console.log('PASS: suggested IGDB and SteamGridDB covers link to their catalog sources in both languages');
  }
  {
    const test = setup(); await test.open(); await test.photo();
    await test.identify([
      { ...firstGame, coverUrl: 'https://user:secret@images.example.invalid/cover.png' },
      { ...secondGame, coverUrl: 'http://images.example.invalid/cover.png' }
    ], { coverSearch: 'unavailable' });
    assert.equal(test.images.length, 0, 'Unsafe prefilled addresses must not load');
    assert.equal(test.field(0, 'coverUrl').value, '');
    assert.equal(test.field(1, 'coverUrl').value, '');
    const notice = test.query('.ai-import-cover-notice');
    assert(!notice.hidden);
    test.setLanguage('en');
    assert(notice.textContent.includes('could not be matched automatically'));
    assert.equal(test.card(0).querySelectorAll('.cover-search-links a').length, 2);
    assert.equal(test.field(0, 'selected').checked, true);
    test.confirm(); test.clickSave(); await flush();
    const save = test.calls.at(-1);
    assert.equal(save.body.action, 'ai-add');
    assert.equal(save.body.games[0].coverUrl, '');
    save.resolve({ games: [], inserted: 1 }); await flush();
    test.controller.destroy();
    console.log('PASS: failed automatic matching and invalid suggestions leave valid game results and manual cover links available');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify();
    const callsBefore = test.calls.length;
    for (const index of [0, 1]) {
      const preview = test.preview(index);
      assert(test.card(index).querySelector('.game-details').contains(preview.frame));
      assert.equal(preview.image.hidden, true); assert.equal(preview.image.getAttribute('src'), null);
      assert.equal(preview.placeholder.hidden, false);
      assert.equal(preview.title.textContent, test.field(index, 'title').value);
      assert.equal(preview.status.textContent, 'Wklej adres okładki');
      assert.equal(preview.status.getAttribute('role'), 'status');
      assert.equal(preview.status.getAttribute('aria-live'), 'polite');
    }
    for (const url of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', 'file:///tmp/private.jpg',
      '/private-cover.jpg', 'https://user:secret@invalid.example/cover.jpg', 'https://invalid.example/' + 'ą'.repeat(1050)]) {
      test.editCover(0, url); assert.equal(test.images.length, 0, 'Invalid cover addresses must not start image work');
      assert.equal(test.preview(0).status.textContent, 'Wpisz poprawny adres okładki');
    }
    test.editCover(0, ''); test.field(0, 'title').value = ''; test.fire(test.field(0, 'title'), 'input');
    assert.equal(test.preview(0).title.textContent, 'Twoja okładka');
    test.setLanguage('en');
    assert.equal(test.preview(0).title.textContent, 'Your cover');
    assert.equal(test.preview(0).status.textContent, 'Paste a cover URL');
    assert.equal(test.preview(0).frame.getAttribute('aria-label'), 'Cover preview');
    assert.equal(test.calls.length, callsBefore, 'Cover previews do not call the game or recognition API');
    test.controller.destroy();
    console.log('PASS: AI cover frames reuse the ordinary form structure, announce empty/error states and reject unsafe or oversized URLs before loading');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify();
    const callsBefore = test.calls.length;
    test.editCover(0, 'https://images.example.invalid/first.jpg');
    const first = test.images.at(-1);
    assert.equal(first.referrerPolicy, 'no-referrer'); assert.equal(first.decoding, 'async');
    assert.equal(test.preview(0).status.textContent, 'Wczytuję okładkę…');
    test.editCover(1, 'http://images.example.invalid/second.jpg', true);
    const second = test.images.at(-1); assert.notEqual(first, second);
    second.onload();
    assert.equal(test.preview(1).image.hidden, false); assert.equal(test.preview(1).placeholder.hidden, true);
    assert.equal(test.preview(1).image.src, 'http://images.example.invalid/second.jpg');
    assert.equal(test.preview(0).image.hidden, true, 'A different row finishing must not reveal this row');
    first.onload();
    assert.equal(test.preview(0).image.src, 'https://images.example.invalid/first.jpg');
    assert.equal(test.preview(0).image.referrerPolicy, 'no-referrer');
    assert.equal(test.preview(0).status.textContent, 'Podgląd okładki');
    const title = 'Synthetic <img src=x onerror=alert(1)> title';
    test.field(0, 'title').value = title; test.fire(test.field(0, 'title'), 'input');
    assert.equal(test.preview(0).title.textContent, title); assert.equal(test.preview(0).title.querySelector('img'), null);
    test.setLanguage('en');
    assert.equal(test.preview(0).image.getAttribute('alt'), 'Game cover for ' + title);
    assert.equal(test.preview(0).status.textContent, 'Cover preview');
    assert.equal(test.images.length, 2, 'Title or language changes must not reload a cover');
    const fail = test.preview(1).image.onerror; assert.equal(typeof fail, 'function'); fail();
    assert.equal(test.preview(1).image.hidden, true); assert.equal(test.preview(1).image.getAttribute('src'), null);
    assert.equal(test.preview(1).placeholder.hidden, false);
    assert.equal(test.preview(1).status.textContent, 'Could not load the cover');
    assert.equal(test.preview(0).image.hidden, false, 'One failed cover must not clear the other row');
    test.setLanguage('pl'); assert.equal(test.preview(1).status.textContent, 'Nie udało się wczytać okładki');
    test.editCover(0, ''); assert.equal(test.preview(0).image.getAttribute('src'), null);
    assert.equal(test.preview(0).image.hidden, true); assert.equal(test.preview(0).status.textContent, 'Wklej adres okładki');
    assert.equal(test.calls.length, callsBefore); test.controller.destroy();
    console.log('PASS: cover loads are independent per game, omit referrers, follow titles and language, and expose load failures without API calls');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify([firstGame]);
    const input = test.field(0, 'coverUrl');
    input.value = 'https://images.example.invalid/old.jpg'; test.fire(input, 'input');
    input.value = 'https://images.example.invalid/new.jpg'; test.fire(input, 'input');
    assert.equal(test.images.length, 0, 'Typing must wait for the debounce');
    test.runTimers(200); assert.equal(test.images.length, 1);
    const old = test.images.at(-1), lateLoad = old.onload, lateError = old.onerror;
    assert.equal(old.src, 'https://images.example.invalid/new.jpg');
    test.editCover(0, 'https://images.example.invalid/committed.jpg', true);
    assert.equal(test.images.length, 2, 'Committing a URL must load immediately');
    assert.equal(old.onload, null); assert.equal(old.onerror, null); assert.equal(old.getAttribute('src'), null);
    const latest = test.images.at(-1); latest.onload();
    lateLoad(); lateError();
    assert.equal(test.preview(0).image.src, 'https://images.example.invalid/committed.jpg');
    assert.equal(test.preview(0).image.hidden, false);
    const staleDisplayError = test.preview(0).image.onerror;
    test.editCover(0, 'https://images.example.invalid/final.jpg'); test.images.at(-1).onload(); staleDisplayError();
    assert.equal(test.preview(0).image.src, 'https://images.example.invalid/final.jpg');
    test.editCover(0, 'https://images.example.invalid/failure.jpg', true); test.images.at(-1).onerror();
    assert.equal(test.preview(0).image.hidden, true); assert.equal(test.preview(0).placeholder.hidden, false);
    assert.equal(test.preview(0).status.textContent, 'Nie udało się wczytać okładki');
    test.controller.destroy();
    console.log('PASS: cover typing is debounced, committed URLs load immediately and stale loader/display callbacks cannot replace a newer cover');
  }
  {
    for (const cleanup of ['skip', 'photo', 'close', 'expire']) {
      const test = setup(); await test.open(); await test.photo(); await test.identify();
      test.editCover(0, 'https://images.example.invalid/private-loaded.jpg', true);
      test.images.at(-1).onload();
      const first = test.preview(0), staleDisplayError = first.image.onerror;
      test.editCover(1, 'https://images.example.invalid/private-pending.jpg', true);
      const loader = test.images.at(-1), staleLoad = loader.onload, staleError = loader.onerror;
      const second = test.preview(1);
      // A pending debounce must not start another request after private cleanup.
      const input = test.field(1, 'coverUrl'); input.value = 'https://images.example.invalid/private-deferred.jpg'; test.fire(input, 'input');
      if (cleanup === 'skip') {
        test.fire(test.card(0).querySelector('.ai-import-remove'), 'click');
        test.fire(test.card(1).querySelector('.ai-import-remove'), 'click');
      } else if (cleanup === 'photo') await test.photo();
      else if (cleanup === 'close') test.controller.close();
      else test.expire();
      const count = test.images.length; test.runTimers(200);
      staleLoad(); staleError(); staleDisplayError();
      assert.equal(test.images.length, count, cleanup + ' must cancel pending preview timers');
      for (const preview of [first, second]) {
        assert.equal(preview.image.getAttribute('src'), null, cleanup + ' must clear loaded image URLs');
        assert.equal(preview.image.onerror, null); assert.equal(preview.image.onload, null);
        assert.equal(preview.image.isConnected, false);
      }
      assert.equal(loader.onload, null); assert.equal(loader.onerror, null); assert.equal(loader.getAttribute('src'), null);
      assert.equal(test.backdrop.querySelectorAll('[data-ai-candidate]').length, 0);
      test.controller.destroy();
    }
    console.log('PASS: skipped games, replacement photos, close and expired sessions cancel preview work and discard private cover URLs');
  }
  {
    const test = setup(); await test.open(); await test.photo();
    const candidates = Array.from({ length: 32 }, (_, index) => ({ ...firstGame, title: `Synthetic game ${index}` }));
    await test.identify(candidates);
    assert.equal(test.backdrop.querySelectorAll('[data-ai-candidate]').length, 32);
    assert.equal(test.backdrop.querySelectorAll('.ai-import-cover-image').length, 32);
    assert(test.backdrop.querySelectorAll('.ai-import-cover-image').every(image => image.hidden && !image.hasAttribute('src')));
    assert.equal(test.field(31, 'title').value, 'Synthetic game 31');
    await test.identify([...candidates, { ...firstGame, title: 'Synthetic overflow' }]);
    assert.equal(test.backdrop.querySelectorAll('[data-ai-candidate]').length, 0);
    assert.equal(test.query('#aiImportStatus').getAttribute('role'), 'alert');
    assert(!test.calls.some(call => call.body.action === 'ai-add'));
    test.controller.destroy();
    console.log('PASS: exactly 32 editable suggestions are supported and oversized recognition results cannot be saved');
  }
  {
    const test = setup(); await test.open(); await test.photo(); await test.identify([firstGame]);
    test.field(0, 'title').value = 'ą'.repeat(256); test.fire(test.field(0, 'title'), 'input');
    test.confirm(); test.clickSave(); await flush();
    assert(!test.calls.some(call => call.body.action === 'ai-add'));
    assert(test.field(0, 'title').validationMessage);
    test.field(0, 'title').value = 'Synthetic fixed title'; test.fire(test.field(0, 'title'), 'input');
    test.field(0, 'coverUrl').value = 'https://user:password@invalid.example/cover.jpg'; test.fire(test.field(0, 'coverUrl'), 'input');
    test.confirm(); test.clickSave(); await flush();
    assert(!test.calls.some(call => call.body.action === 'ai-add'));
    test.controller.destroy();
    console.log('PASS: oversized UTF-8 fields and credential-bearing cover URLs fail before any batch save');
  }
  {
    const test = setup(); await test.open();
    await test.photo({ type: 'image/svg+xml', size: 100 }); assert.equal(test.calls.length, 1);
    assert.equal(test.query('#aiImportAnalyze').disabled, true);
    await test.photo({ type: 'image/jpeg', size: 13 * 1024 * 1024 }); assert.equal(test.calls.length, 1);
    assert.equal(test.query('#aiImportStatus').getAttribute('role'), 'alert');
    test.controller.destroy();
    console.log('PASS: unsupported or oversized source files do not reach an upload request');
  }
  {
    const test = setup(); const opening = test.controller.open(); await flush();
    const statusCall = test.calls[0]; test.controller.clearPrivateData();
    assert.equal(statusCall.signal.aborted, true);
    statusCall.resolve({ available: true }); await opening;
    assert.equal(test.backdrop.hidden, true); assert.equal(test.backdrop.children.length, 0);
    assert.equal(test.notices.length, 0);
    console.log('PASS: closing an in-flight request aborts it and a late result cannot reopen or refill private UI');
  }
  {
    const test = setup(); await test.open(); await test.photo();
    test.fire(test.query('#aiImportAnalyze'), 'click'); await flush();
    test.calls.at(-1).resolve({ uploadId, offset: 0, chunkBytes: 32768 }); await flush();
    const chunk = test.calls.at(-1); test.expire();
    assert.equal(chunk.signal.aborted, true); chunk.resolve({ offset: 32768 }); await flush();
    assert.equal(test.backdrop.children.length, 0); assert.equal(test.saved.length, 0);
    assert(!test.calls.some(call => call.body.action === 'ai-recognize'));
    console.log('PASS: session cleanup clears photo/candidates and prevents upload continuation or stale recognition');
  }
  {
    for (const settle of ['resolve', 'reject']) {
      const test = setup(); await test.open(); await test.photo();
      test.fire(test.query('#aiImportAnalyze'), 'click'); await flush();
      test.calls.at(-1).resolve({ uploadId, offset: 0, chunkBytes: 32768 }); await flush();
      const oldChunk = test.calls.at(-1);
      assert.equal(oldChunk.body.action, 'ai-upload-chunk');
      test.controller.close();
      assert.equal(oldChunk.signal.aborted, true);
      assert.equal(test.calls.at(-1).body.action, 'ai-upload-cancel');
      assert.equal(test.calls.at(-1).body.uploadId, uploadId);
      test.calls.at(-1).resolve({});

      await test.open(); await test.photo();
      test.fire(test.query('#aiImportAnalyze'), 'click'); await flush();
      const newUploadId = 'b'.repeat(32);
      assert.equal(test.calls.at(-1).body.action, 'ai-upload-start');
      test.calls.at(-1).resolve({ uploadId: newUploadId, offset: 0, chunkBytes: 32768 }); await flush();
      const newChunk = test.calls.at(-1);
      assert.equal(newChunk.body.action, 'ai-upload-chunk');
      assert.equal(newChunk.body.uploadId, newUploadId);

      if (settle === 'resolve') oldChunk.resolve({ offset: 32768 });
      else oldChunk.reject(new Error('Synthetic late upload failure'));
      await flush();
      assert.equal(test.calls.at(-1), newChunk, 'A stale request must not cancel the new upload');
      assert.equal(newChunk.signal.aborted, false);
      while (test.calls.at(-1).body.action === 'ai-upload-chunk') {
        const chunk = test.calls.at(-1);
        assert.equal(chunk.body.uploadId, newUploadId);
        chunk.resolve({ offset: chunk.body.offset + Buffer.from(chunk.body.data, 'base64').length });
        await flush();
      }
      const recognition = test.calls.at(-1);
      assert.equal(recognition.body.action, 'ai-recognize');
      assert.equal(recognition.body.uploadId, newUploadId);
      recognition.resolve({ candidates: [firstGame] }); await flush();
      assert.equal(test.field(0, 'title').value, firstGame.title);
      test.controller.destroy();
    }
    console.log('PASS: late upload results and failures from a closed dialog cannot cancel or clear a new upload');
  }
  {
    let stopped = 0; const stream = { getTracks: () => [{ stop() { stopped++; } }] };
    const test = setup({ camera: async () => stream }); await test.open(false);
    assert.equal(test.streams.length, 0, 'Opening the dialog must not request camera permission');
    test.fire(test.query('#aiImportCamera'), 'click'); await flush();
    const video = test.query('video'); assert.equal(video.srcObject, stream);
    video.videoWidth = 1920; video.videoHeight = 1080; test.fire(video, 'loadedmetadata');
    assert.equal(test.query('#aiImportCapture').disabled, false);
    test.fire(test.query('#aiImportCapture'), 'click'); await flush();
    assert.equal(stopped, 1); assert.equal(video.srcObject, null);
    assert(test.query('.ai-import-preview').src.startsWith('data:image/jpeg;base64,'));
    assert.equal(test.calls.length, 1, 'Capturing without an API key remains entirely local');
    assert.equal(test.query('#aiImportAnalyze').disabled, true);
    test.controller.destroy();
    console.log('PASS: explicit webcam permission and capture create a local preview and stop the camera without uploading');
  }
  {
    let stopped = 0; const permission = deferred();
    const test = setup({ camera: () => permission.promise }); await test.open();
    test.fire(test.query('#aiImportCamera'), 'click'); await flush();
    test.controller.clearPrivateData(); permission.resolve({ getTracks: () => [{ stop() { stopped++; } }] }); await flush();
    assert.equal(stopped, 1); assert.equal(test.backdrop.children.length, 0);
    console.log('PASS: a late camera permission reply stops its tracks after private-view cleanup');
  }
  {
    let stopped = 0; const test = setup({ camera: async () => ({ getTracks: () => [{ stop() { stopped++; } }] }) });
    await test.open(); test.fire(test.query('#aiImportCamera'), 'click'); await flush(); test.expire();
    assert.equal(stopped, 1); assert.equal(test.backdrop.hidden, true);
    const denied = setup({ camera: async () => { throw new Error('Synthetic denied camera'); } }); await denied.open();
    denied.fire(denied.query('#aiImportCamera'), 'click'); await flush();
    assert.equal(denied.query('#aiImportStatus').getAttribute('role'), 'alert');
    assert.equal(denied.query('#aiImportChoose').disabled, false);
    assert.equal(denied.calls.length, 1); denied.controller.destroy();
    console.log('PASS: logout stops active camera tracks and denied camera access retains the file-picker fallback');
  }
  {
    const test = setup(); await test.open(); let picks = 0, captures = 0;
    const file = test.query('#aiImportFile'), cameraFile = test.query('#aiImportCameraFile');
    file.click = () => { picks++; }; cameraFile.click = () => { captures++; };
    assert.equal(file.hasAttribute('capture'), false); assert.equal(cameraFile.getAttribute('capture'), 'environment');
    test.fire(test.query('#aiImportChoose'), 'click'); test.fire(test.query('#aiImportCamera'), 'click'); await flush();
    assert.equal(picks, 1); assert.equal(captures, 1);
    test.controller.destroy();
    console.log('PASS: regular file choice is distinct from mobile camera fallback when getUserMedia is unavailable');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
