import assert from 'node:assert/strict';
import { aiAction } from '../backend/ai.mjs';
import { scanDuplicates } from '../backend/ai-duplicates.mjs';
import { suggestCovers } from '../backend/catalogues.mjs';
import { now, sha256 } from '../backend/http.mjs';
import { uploadAppend, uploadStart } from '../backend/uploads.mjs';
import { createCandidateScan, nextCandidatePage } from '../public/duplicate-candidates.mjs';
import { d1Fixture } from './sqlite-d1.mjs';

// All photos, catalogue results, credentials and collection records are synthetic.
const fetchOriginal = globalThis.fetch;
const env = { AI_ENABLED: 'true', GEMINI_API_KEY: 'synthetic-gemini-test-key', GEMINI_MODEL: 'gemini-3.8-flash',
  IGDB_CLIENT_ID: 'synthetic-client', IGDB_CLIENT_SECRET: 'synthetic-secret', STEAMGRIDDB_API_KEY: 'synthetic-steam-key' };
const modelResponse = result => Response.json({ candidates: [{ finishReason: 'STOP',
  content: { role: 'model', parts: [{ text: JSON.stringify(result) }] } }] });
const ref = game => [game.id, game.revision];
const game = (id, title) => ({ id, title, revision: 'a'.repeat(64) });

try {
  {
    const candidates = [game('quake', 'Quake'), game('typo', 'Quxke'),
      game('original', 'Resident Evil 2'), game('regional', 'Biohazard II'), game('other', 'Biohazard 3')];
    const scan = createCandidateScan(candidates, 1);
    const matched = [];
    let position = null;
    do {
      const page = nextCandidatePage(scan, position);
      matched.push(...page.pairs.map(pair => pair.map(ref => ref[0]).sort().join(':')));
      position = page.next;
    } while (position);
    assert.deepEqual(matched.sort(), ['original:regional', 'quake:typo']);
    console.log('PASS: midpoint typos and numbered regional aliases survive candidate generation and paging');
  }
  {
    const { db } = d1Fixture();
    const requests = [];
    globalThis.fetch = async (value, options) => {
      const url = new URL(value);
      requests.push(url.hostname);
      if (url.hostname === 'id.twitch.tv') return Response.json({ access_token: 'synthetic-access-token' });
      if (url.hostname === 'api.igdb.com') return Response.json([
        { name: 'Synthetic Game', slug: 'synthetic-game', cover: { image_id: 'abc' }, platforms: [{ name: 'Xbox Series X|S' }] }
      ]);
      if (url.hostname === 'www.steamgriddb.com') {
        if (url.pathname.includes('/search/')) return Response.json({ success: true, data: [{ id: 42, name: 'Synthetic Game' }] });
        return Response.json({ success: true, data: [{ id: 43, url: 'https://cdn.steamgriddb.com/grid/test.png',
          width: 342, height: 482, nsfw: false, humor: false, epilepsy: false, mime: 'image/png' }] });
      }
      assert.equal(url.hostname, 'generativelanguage.googleapis.com');
      const body = JSON.parse(options.body);
      if (url.pathname.includes('/gemini-3.8-flash:')) {
        assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
      } else {
        assert.match(url.pathname, /gemini-2\.5-flash/);
        assert.equal(body.generationConfig.thinkingConfig, undefined);
      }
      const catalogue = JSON.parse(body.contents[0].parts[0].text);
      assert.deepEqual(catalogue.map(candidate => candidate.provider), ['steamgriddb']);
      return modelResponse({ matches: [0] });
    };
    for (const model of ['gemini-3.8-flash', 'gemini-2.5-flash']) {
      const state = { candidates: [{ title: 'Synthetic Game', platform: 'PlayStation 5', confidence: 'high' }] };
      await suggestCovers(db, { ...env, GEMINI_MODEL: model }, state, Date.now() + 12000, true);
      assert.equal(state.candidates[0].coverSource, 'steamgriddb');
    }
    assert(requests.includes('api.igdb.com'));
    console.log('PASS: incompatible IGDB platform does not hide a validated SteamGridDB cover, and model options remain compatible');
  }
  {
    const { db, sqlite } = d1Fixture();
    const sessionValue = 'a'.repeat(64);
    const session = { token: await sha256(sessionValue), authenticated_at: now(), activity_at: now() };
    sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(session.token, session.authenticated_at, session.activity_at);
    const request = new Request('https://example.test/api/games.php', {
      headers: { Cookie: `savepoint_cf_session_v1=${sessionValue}` }
    });
    const jpeg = Uint8Array.of(255, 216, 255, 192, 0, 8, 8, 0, 1, 0, 1, 3, 255, 217);
    const { uploadId } = await uploadStart(db, session, 'ai', { size: jpeg.length, mime: 'image/jpeg' });
    await uploadAppend(db, session, 'ai', { uploadId, offset: 0, data: Buffer.from(jpeg).toString('base64') });
    let calls = 0;
    let release, entered;
    const processing = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    globalThis.fetch = async value => {
      assert.equal(new URL(value).hostname, 'generativelanguage.googleapis.com');
      if (++calls === 1) return new Response('Synthetic provider interruption', { status: 503, headers: { 'Retry-After': '60' } });
      entered();
      await processing;
      return modelResponse({ candidates: [], notes: 'Synthetic test' });
    };
    const recognize = () => aiAction(db, env, request, session, 'ai-recognize', { uploadId });
    await assert.rejects(recognize(), { status: 503 });
    assert.equal(sqlite.prepare('SELECT state FROM uploads WHERE id = ?').get(uploadId).state, 'uploading');
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM upload_chunks WHERE upload_id = ?').get(uploadId).count, 1);
    const pending = recognize();
    await started;
    await assert.rejects(recognize(), { status: 409, id: 'ai_upload_busy' });
    release();
    assert.deepEqual(await pending, { candidates: [], notes: 'Synthetic test' });
    assert.deepEqual(await recognize(), { candidates: [], notes: 'Synthetic test' });
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM upload_chunks WHERE upload_id = ?').get(uploadId).count, 0);
    assert.equal(calls, 2);
    console.log('PASS: recognition retries need no re-upload, concurrent retries are guarded, success discards bytes and can replay');
  }
  {
    const { db, sqlite } = d1Fixture();
    const save = sqlite.prepare(`INSERT INTO games (id,title,platform,edition,cover_url,status,created_at,revision)
      VALUES (?, ?, 'PC', 'Cyfrowe', ?, 'Do ogrania', 1, ?)`);
    for (let index = 0; index < 5000; index++) {
      save.run('game-' + index, 'Synthetic unrelated ' + index, '', 'b'.repeat(64));
    }
    const left = game('same-1', 'Synthetic Twin'), right = game('same-2', 'Synthetic Twin');
    const cover = 'https://example.test/' + 'x'.repeat(2048);
    for (const record of [left, right]) save.run(record.id, record.title, cover, record.revision);
    let modelCalls = 0;
    globalThis.fetch = async (_value, options) => {
      modelCalls++;
      const batch = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      assert.deepEqual(batch, [{ index: 0, left: { title: left.title, platform: 'PC' },
        right: { title: right.title, platform: 'PC' } }]);
      return modelResponse({ decisions: [{ index: 0, duplicate: true }] });
    };
    const session = { token: 'a'.repeat(64) };
    const proposed = [[ref(left), ref(right)]];
    const result = await scanDuplicates(db, env, session, { pairs: proposed });
    assert.equal(result.pairs[0].recommendation, 'delete');
    assert.equal(result.pairs[0].coversMatch, true);
    assert.equal(result.pairs[0].left.hasCover, true);
    assert(!Object.hasOwn(result.pairs[0].left, 'coverUrl'));
    assert.match(result.pairs[0].ticket, /^[\w-]+\.[\w-]+$/);
    sqlite.prepare('UPDATE games SET revision = ? WHERE id = ?').run('c'.repeat(64), right.id);
    await assert.rejects(scanDuplicates(db, env, session, { pairs: proposed }), { status: 409 });
    await assert.rejects(scanDuplicates(db, env, session, { pairs: Array.from({ length: 33 }, () => proposed[0]) }), { status: 422 });
    assert.equal(modelCalls, 1);
    console.log('PASS: a large collection is verified in bounded batches with authoritative revisions and no cover URLs');
  }
} finally {
  globalThis.fetch = fetchOriginal;
}
