import { ApiError, fail } from './http.mjs';
import { chooseCovers, providerJson } from './gemini.mjs';

const aliases = {
  'Xbox Series': ['Xbox Series X|S', 'Xbox Series X/S', 'Xbox Series X'],
  PC: ['PC (Microsoft Windows)', 'Windows', 'Linux', 'Mac', 'DOS'],
  NES: ['Nintendo Entertainment System', 'Family Computer'],
  SNES: ['Super Nintendo Entertainment System', 'Super Famicom'],
  PSP: ['PlayStation Portable'],
  'PlayStation Vita': ['PS Vita'],
  'Mega Drive / Genesis': ['Sega Mega Drive/Genesis', 'Sega Mega Drive', 'Sega Genesis'],
  'Sega CD / Mega-CD': ['Sega CD', 'Mega-CD', 'Sega Mega CD'],
  'SG-1000': ['Sega SG-1000'],
  '32X': ['Sega 32X'],
  GameCube: ['Nintendo GameCube'],
};
const key = text => text.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const wikiKey = text => text.trim().replace(/[_\s]+/gu, ' ').toLowerCase();
const credential = value => typeof value === 'string' && /^[\x21-\x7e]{10,1024}$/.test(value);
const safeLabel = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
const asList = value => Array.isArray(value) ? value : [];
const year = value => Number.isSafeInteger(value) && value > 0 && value < 9999999999
  ? new Date(value * 1000).getUTCFullYear() : null;
const unique = list => [...new Set(list)];

function groups(items, size) {
  const list = [];
  for (let i = 0; i < items.length; i += size) list.push(items.slice(i, i + size));
  return list;
}

async function boundedParallel(items, map) {
  const result = [];
  for (const group of groups(items, 4)) {
    result.push(...await Promise.all(group.map(item => Promise.resolve().then(() => map(item)).catch(() => null))));
  }
  return result;
}

async function igdb(titles, env, signal) {
  const client = env.IGDB_CLIENT_ID;
  const secret = env.IGDB_CLIENT_SECRET;
  if (!credential(client) || !credential(secret)) return [];
  const { access_token: token } = await providerJson('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: client, client_secret: secret, grant_type: 'client_credentials' }),
  }, signal);
  if (!credential(token)) return [];
  const safe = titles.filter(title => !/["\\]/.test(title));
  const replies = await boundedParallel(groups(safe, 10), group => providerJson('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: { 'Client-ID': client, Authorization: 'Bearer ' + token, 'Content-Type': 'text/plain' },
    body: 'fields name,slug,cover.image_id,platforms.name,first_release_date; where ('
      + group.map(title => 'name ~ "' + title + '"').join(' | ') + '); limit 96;',
  }, signal));
  return replies.flatMap(reply => asList(reply).slice(0, 96)).filter(entry => safeLabel(entry?.name, 320)).map(entry => {
    const slug = entry.slug;
    const image = entry.cover?.image_id;
    const valid = typeof slug === 'string' && /^[a-z0-9-]{1,250}$/.test(slug)
      && typeof image === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(image);
    return {
      name: entry.name,
      platforms: asList(entry.platforms).map(platform => platform?.name).filter(name => safeLabel(name, 100)).slice(0, 24),
      year: year(entry.first_release_date),
      url: valid ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${image}.jpg` : '',
      source: valid ? `https://www.igdb.com/games/${slug}` : '',
      provider: 'igdb',
    };
  });
}

async function steamGrid(titles, env, signal) {
  if (!credential(env.STEAMGRIDDB_API_KEY)) return [];
  const headers = { Authorization: 'Bearer ' + env.STEAMGRIDDB_API_KEY };
  const fetchData = async route => {
    const reply = await providerJson('https://www.steamgriddb.com/api/v2' + route, { headers }, signal);
    return reply.success === true ? asList(reply.data) : [];
  };
  const searched = await boundedParallel(titles, async title => {
    const games = await fetchData('/search/autocomplete/' + encodeURIComponent(title));
    const matching = new Map(games.slice(0, 12).filter(game => Number.isSafeInteger(game?.id) && game.id > 0
      && safeLabel(game.name, 320) && key(game.name) === key(title)).map(game => [game.id, game]));
    return matching.size === 1 ? { ...matching.values().next().value, title } : null;
  });
  return (await boundedParallel(searched.filter(Boolean), async game => {
    const images = await fetchData(`/grids/game/${game.id}?dimensions=600x900,660x930,342x482&types=static&nsfw=false&humor=false&epilepsy=false&limit=5`);
    const image = images.slice(0, 5).find(item => typeof item?.url === 'string'
      && /^https:\/\/cdn2?\.steamgriddb\.com\/grid\/[a-z0-9_-]{1,120}\.(?:jpe?g|png|webp)$/i.test(item.url)
      && Number.isSafeInteger(item.id) && item.id > 0 && Number.isSafeInteger(item.width) && Number.isSafeInteger(item.height)
      && item.width > 0 && item.width < item.height && item.nsfw === false && item.humor === false && item.epilepsy === false
      && ['image/png', 'image/jpeg', 'image/webp'].includes(item.mime));
    return image ? { title: game.title, name: game.name, platforms: [], year: year(game.release_date),
      url: image.url, source: `https://www.steamgriddb.com/grid/${image.id}`, provider: 'steamgriddb' } : null;
  })).filter(Boolean);
}

function wikiImage(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  const match = /^https:\/\/upload\.wikimedia\.org(\/wikipedia\/(?:en|commons)\/[a-z0-9/_.%()+,;!'@&=-]+\.(?:jpe?g|png|webp))(?:\?.*)?$/i.exec(value);
  if (!match || /%(?:2f|5c)|%(?![a-f0-9]{2})/i.test(match[1])) return '';
  try {
    if (/(?:^|\/)\.{1,2}(?:\/|$)|[\x00-\x1f\x7f]/.test(decodeURIComponent(match[1]))) return '';
  } catch { return ''; }
  return 'https://upload.wikimedia.org' + match[1];
}

async function wikipedia(titles, signal) {
  const safe = titles.filter(title => !/[|#[\]{}<>]/.test(title));
  const pages = new Map();
  if (!safe.length) return pages;
  const replies = await boundedParallel(groups(safe, 16), group => {
    const variants = unique(group.flatMap(title => [title, title + ' (video game)']));
    return providerJson('https://en.wikipedia.org/w/api.php', {
      method: 'POST',
      headers: { 'Api-User-Agent': 'Savepoint/1.0 (cover lookup; https://github.com/emilstachowiak-lab/savepoint-game-library)' },
      body: new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', redirects: '1', prop: 'pageimages|pageprops',
        ppprop: 'disambiguation|wikibase-shortdesc', piprop: 'thumbnail|name', pilicense: 'any',
        pithumbsize: '480', pilimit: String(variants.length), titles: variants.join('|'),
      }),
    }, signal);
  });
  const queries = replies.map(reply => reply?.query).filter(query => Array.isArray(query?.pages));
  if (!queries.length) fail(502, 'ai_cover_search_unavailable');
  const redirects = new Map();
  for (const query of queries) {
    for (const page of query.pages) {
      const description = page?.pageprops?.['wikibase-shortdesc'];
      if (page?.ns !== 0 || !Number.isSafeInteger(page.pageid) || page.pageid < 1
        || !safeLabel(page.title, 340) || !safeLabel(page.pageimage, 300) || !safeLabel(description, 320)
        || !/\bvideo[- ]game\b/i.test(description) || /\b(series|franchise|disambiguation)\b/i.test(description)
        || Object.hasOwn(page.pageprops, 'disambiguation')) continue;
      const url = wikiImage(page.thumbnail?.source);
      if (url) pages.set(wikiKey(page.title), {
        name: page.title, platforms: [], year: null, url, source: `https://en.wikipedia.org/?curid=${page.pageid}`,
        description, file: page.pageimage, provider: 'wikipedia',
      });
    }
    for (const alias of [...asList(query.normalized), ...asList(query.redirects)]) {
      if (safeLabel(alias?.from, 340) && safeLabel(alias?.to, 340) && !alias.tofragment) {
        redirects.set(wikiKey(alias.from), wikiKey(alias.to));
      }
    }
  }
  for (const [from, target] of redirects) {
    let to = target;
    const visited = new Set([from]);
    while (!pages.has(to) && redirects.has(to) && !visited.has(to)) {
      visited.add(to);
      to = redirects.get(to);
    }
    if (!pages.has(from) && pages.has(to)) pages.set(from, pages.get(to));
  }
  return pages;
}

function matchingPlatform(platform, published) {
  const options = [platform, ...(aliases[platform] ?? [])].map(key);
  return published.some(name => options.includes(key(name)));
}

async function assign(db, env, result, candidates, deadline) {
  const options = candidates.map(({ gameIndex, entry }, index) => {
    const game = result.candidates[gameIndex];
    return {
      index, gameIndex, title: game.title, platform: game.platform,
      provider: entry.provider, catalogueTitle: entry.name, cataloguePlatforms: entry.platforms,
      releaseYear: entry.year,
      artwork: { igdb: 'Game cover', steamgriddb: 'Static portrait grid', wikipedia: 'Article image' }[entry.provider],
      ...(entry.description ? { articleDescription: entry.description, imageFilename: entry.file } : {}),
    };
  });
  const accepted = new Set(await chooseCovers(db, env, options, deadline));
  for (const [index, { gameIndex, entry }] of candidates.entries()) {
    if (!accepted.has(index) || result.candidates[gameIndex].coverUrl) continue;
    Object.assign(result.candidates[gameIndex], { coverUrl: entry.url, coverSourceUrl: entry.source, coverSource: entry.provider });
  }
}

export async function suggestCovers(db, env, result, deadline, manual = false) {
  const games = result.candidates.map((game, index) => ({ ...game, index }))
    .filter(game => game.confidence !== 'low' && game.platform && game.platform !== 'Inna' && key(game.title));
  if (!games.length) return result;
  const titles = unique(games.map(game => game.title));
  const timeout = ms => AbortSignal.timeout(Math.max(1, Math.min(ms, deadline - Date.now())));
  // Keep the catalogue requests and their credentials limited to fixed hosts.
  const igdbItems = await igdb(titles, env, timeout(4000)).catch(() => []);
  const steam = await steamGrid(titles, env, timeout(8000)).catch(() => []);
  const options = [];
  const fallback = [];
  for (const game of games) {
    const matches = igdbItems.filter(item => key(item.name) === key(game.title));
    const compatible = matches.filter(item => matchingPlatform(game.platform, item.platforms));
    const covers = new Map(compatible.filter(item => item.url).map(item => [item.url, item]));
    if (covers.size > 1 || matches.some(item => item.platforms.length) && !compatible.length) continue;
    if (covers.size) options.push({ gameIndex: game.index, entry: covers.values().next().value });
    const grid = steam.find(item => item.title === game.title);
    if (grid) options.push({ gameIndex: game.index, entry: grid });
    fallback.push(game);
  }
  try {
    if (Date.now() >= deadline) fail(504, 'ai_provider_timeout');
    await assign(db, env, result, options, deadline);
    if (manual && result.candidates.some(game => game.coverUrl)) return result;
    const missing = fallback.filter(game => !result.candidates[game.index].coverUrl);
    if (missing.length) {
      const pages = await wikipedia(unique(missing.map(game => game.title)), timeout(4000));
      const wikiOptions = missing.flatMap(game => {
        const title = wikiKey(game.title);
        const entries = unique([pages.get(title), pages.get(title + ' (video game)')].filter(Boolean));
        return entries.map(entry => ({ gameIndex: game.index, entry }));
      });
      await assign(db, env, result, wikiOptions, deadline);
      if (Date.now() >= deadline) result.coverSearch = 'unavailable';
    }
  } catch (error) {
    if (manual && error instanceof ApiError && ['ai_provider_rate_limited', 'ai_provider_timeout'].includes(error.id)) throw error;
    result.coverSearch = 'unavailable';
  }
  return result;
}
