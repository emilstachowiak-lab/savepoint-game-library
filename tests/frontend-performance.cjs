'use strict';

// Usage: node tests/frontend-performance.cjs /path/to/pre-change/app.js
// Both versions execute in isolated VMs. No browser, network, database or real
// credentials are used. Timings cover JS work only, not browser layout/raster.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
if (!process.argv[2]) throw new Error('Pass the pre-change app.js path as the first argument.');
const before = fs.readFileSync(process.argv[2], 'utf8');
const after = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const exactMarkup = process.argv.includes('--exact');
new vm.Script(before);
new vm.Script(after);

function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, 'Expected source boundaries: ' + start);
  return source.slice(first, last);
}
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[entity]));

// Compare card meaning independently of intentional presentation changes.
// Keep parsing before entity decoding so an escaped user title cannot become
// markup in this fixture. All other render targets still compare byte-for-byte.
function parseMarkup(html) {
  const root = {tag:'#root',attrs:{},children:[]}, stack = [root];
  const voidTags = new Set(['img','input','br','hr','meta','link','source','area','base','embed','wbr']);
  for (const token of html.match(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      const tag = token.match(/^<\/([^\s>]+)/)[1].toLowerCase();
      while (stack.length > 1 && stack.pop().tag !== tag) {}
    } else if (token.startsWith('<')) {
      const tag = token.match(/^<([^\s/>]+)/)[1].toLowerCase(), attrs = {};
      for (const match of token.slice(tag.length+1,-1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
        attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
      const node = {tag,attrs,children:[]}; stack.at(-1).children.push(node);
      if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(node);
    } else stack.at(-1).children.push(decode(token));
  }
  return root;
}
const descendants = node => typeof node === 'string' ? [] : node.children.flatMap(child => typeof child === 'string' ? [] : [child,...descendants(child)]);
const hasClass = (node,name) => (node.attrs.class ?? '').split(/\s+/).includes(name);
const nodeText = node => !node ? '' : typeof node === 'string' ? node : node.children.map(nodeText).join('');
function cardSemantics(html) {
  const tree = parseMarkup(html), all = descendants(tree);
  for (const node of all) {
    assert(!['script','iframe','object','embed'].includes(node.tag),'Rendered user content must not create active markup');
    assert(!Object.keys(node.attrs).some(name=>/^on/i.test(name)),'Rendered user content must not create event attributes');
    if (node.attrs.src) assert(/^https?:/i.test(node.attrs.src),'Only sanitized HTTP(S) image sources may render');
  }
  const cards = all.filter(node=>hasClass(node,'game-card')).map(card=>{
    const nodes = descendants(card), first = name => nodes.find(node=>hasClass(node,name));
    const image = first('cover-image');
    const status = first('status');
    return {
      title:nodeText(first('game-title')),
      titleHint:first('game-title')?.attrs.title,
      edition:nodeText(first('edition-meta') ?? first('cover-tag')).trim(),
      platforms:nodes.filter(node=>hasClass(node,'platform')).map(nodeText).join(' · '),
      status:nodeText(status).trim(),
      statusClass:(status?.attrs.class ?? '').split(/\s+/).filter(name=>name!=='status').sort(),
      image:image ? {src:image.attrs.src,alt:image.attrs.alt,loading:image.attrs.loading} : null,
      fallback:nodeText(first('cover-title')),
      actions:nodes.filter(node=>node.attrs['data-game-action']).map(node=>({
        action:node.attrs['data-game-action'],id:node.attrs['data-game-id'],
        title:node.attrs.title,label:node.attrs['aria-label']
      }))
    };
  });
  if (cards.length) return {cards};
  return {
    cards,
    title:nodeText(all.find(node=>node.tag==='h2')),
    message:nodeText(all.find(node=>node.tag==='p')),
    actions:all.filter(node=>node.attrs['data-action']).map(node=>node.attrs['data-action'])
  };
}

function renderHarness(source) {
  const counts = { htmlWrites: 0, metadataWrites: 0, urls: 0 };
  const ids = ['gameTitleSuggestions','search','platformFilter','editionFilter','statusFilter','sort','count','statTotal','statPlatforms','statDone','grid'];
  const nodes = Object.fromEntries(ids.map(id => {
    let html = '', text = '', value = '', options = [];
    return [id, {
      querySelectorAll() { return []; },
      get innerHTML() { return html; },
      set innerHTML(next) {
        html = String(next); counts.htmlWrites++;
        if (id !== 'grid') counts.metadataWrites++;
        if (id === 'platformFilter') {
          options = [...html.matchAll(/<option value="([^"]*)"/g)].map(match => decode(match[1]));
          value = options[0] ?? '';
        }
      },
      get textContent() { return text; },
      set textContent(next) { text = String(next); },
      get value() { return value; },
      set value(next) { value = id === 'platformFilter' && !options.includes(String(next)) ? '' : String(next); }
    }];
  }));
  class CountingURL extends URL { constructor(...args) { counts.urls++; super(...args); } }
  const context = vm.createContext({ $: id => nodes[id], games: [], URL: CountingURL, authenticated: true, logoutPending: false, privacySuspended: false, sessionGeneration: 0, API_URL: 'api/games.php', setTimeout(){return 1;}, clearTimeout(){} });
  vm.runInContext(
    section(source, 'const safeImageUrl', 'function readLegacyGames') +
    section(source, source.includes('const COVER_LOAD_TIMEOUT') ? 'const COVER_LOAD_TIMEOUT' : 'function gamePlatforms', 'function platformCheckboxes') +
    (source.includes('function renderGameCard(') ? section(source, 'function renderGameCard(', 'function render()') : '') +
    section(source, 'function render()', '\nlet captchaChallenge'), context);
  return {
    context, nodes, counts,
    snapshot() { return ids.map(id => [id, id === 'grid' && !exactMarkup ? cardSemantics(nodes[id].innerHTML) : nodes[id].innerHTML, nodes[id].textContent, nodes[id].value]); },
    render(filters = {}) {
      Object.entries(filters).forEach(([id, value]) => { nodes[id].value = value; });
      context.render();
    }
  };
}

const fixtures = [
  {id:'1',title:'Żółw & Smok',platform:'PlayStation 5, Xbox One',edition:'Fizyczne i cyfrowe',status:'Ograna',coverUrl:'https://example.invalid/a.png?x=1&y=2',createdAt:20},
  {id:'2',title:'Fifa 15',platform:'Xbox One',edition:'Fizyczne',status:'Do ogrania',coverUrl:'javascript:alert(1)',createdAt:10},
  {id:'3',title:'Fifa 15',platform:['PlayStation 5','Custom & Console'],edition:'Cyfrowe',status:'W trakcie',coverUrl:'http://example.invalid/b.png',createdAt:20},
  {id:'4',title:'<script "test">',platform:'Custom & Console',status:'Ograna',coverUrl:'',createdAt:0},
  {id:'5',title:'ącki',platform:'Nintendo Switch, Nintendo Switch',edition:'Cyfrowe',status:'Ograna',coverUrl:'not-a-url',createdAt:30},
  {id:'"><img src=x onerror=alert(1)>',title:'<img src=x onerror=alert(1)> & "quoted"',platform:'<svg onload=alert(1)>',edition:'Cyfrowe',status:'<script>synthetic</script>',coverUrl:'data:image/svg+xml,<svg onload=alert(1)>',createdAt:15}
];
const oldRender = renderHarness(before), newRender = renderHarness(after);
let renderCases = 0;
for (const games of [[], fixtures.slice(0, 1), fixtures]) {
  oldRender.context.games = games;
  newRender.context.games = games;
  oldRender.render({search:'',platformFilter:'',editionFilter:'',statusFilter:'',sort:'newest'});
  newRender.render({search:'',platformFilter:'',editionFilter:'',statusFilter:'',sort:'newest'});
  assert.deepEqual(newRender.snapshot(), oldRender.snapshot());
  for (const search of ['', 'fifa', 'ŻÓŁ', '<', 'absent'])
    for (const platformFilter of ['', 'PlayStation 5', 'Xbox One', 'Custom & Console'])
      for (const editionFilter of ['', 'Fizyczne', 'Cyfrowe'])
        for (const statusFilter of ['', 'Ograna', 'Do ogrania'])
          for (const sort of ['newest', 'title']) {
            const filters = {search,platformFilter,editionFilter,statusFilter,sort};
            oldRender.render(filters); newRender.render(filters);
            assert.deepEqual(newRender.snapshot(), oldRender.snapshot(), JSON.stringify(filters));
            renderCases++;
          }
}
// Replacing a collection while an active console disappears preserves the
// original behavior for both the current render and the next input event.
for (const harness of [oldRender,newRender]) {
  harness.render({search:'',platformFilter:'Xbox One',editionFilter:'',statusFilter:'',sort:'newest'});
  harness.context.games = fixtures.filter(game => game.platform === 'Custom & Console');
  harness.render();
}
assert.deepEqual(newRender.snapshot(), oldRender.snapshot());
oldRender.render(); newRender.render();
assert.deepEqual(newRender.snapshot(), oldRender.snapshot());
const cachedBaseline = before.includes('function getCollectionMetadata()');
for (const key of ['metadataWrites','urls']) {
  assert(newRender.counts[key] <= oldRender.counts[key],key+' must not regress');
  if (!cachedBaseline) assert(newRender.counts[key] < oldRender.counts[key],key+' must retain the optimization');
}
console.log(`PASS: identical card semantics and other DOM output for ${renderCases} filter/sort cases plus collection replacement; escaped hostile content stays inert`);
console.log('Render operations (baseline -> current):', JSON.stringify({
  metadataHTMLWrites:[oldRender.counts.metadataWrites,newRender.counts.metadataWrites],
  urlParses:[oldRender.counts.urls,newRender.counts.urls]
}));

// The ribbon intentionally changes Canvas2D output. Its clock, raster budget,
// color handling and failure isolation are verified in frontend-background.cjs.
// This historical comparison now covers collection rendering only.
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
function renderTime(source, sort = 'newest') {
  const samples=[];
  for(let sample=0;sample<5;sample++) {
    const harness=renderHarness(source);
    harness.context.games=Array.from({length:2000},(_,index)=>({...fixtures[index%fixtures.length],id:String(index),title:fixtures[index%fixtures.length].title+' '+index}));
    harness.render({sort});
    const start=performance.now();
    for(let index=0;index<30;index++) harness.render({search:index%2?'fifa':'absent'});
    samples.push(performance.now()-start);
  }
  return median(samples);
}
console.log('JS-only median CPU benchmark, milliseconds (baseline -> current; mocked drawing/DOM, not browser raster/layout):');
function initialRenderTime(source, count) {
  const samples=[];
  for(let sample=0;sample<5;sample++) {
    // Setup is outside the timed interval. Each new collection populates a new cache.
    const harness=renderHarness(source), collections=Array.from({length:count===5?200:5},()=>Array.from({length:count},(_,index)=>({...fixtures[index%fixtures.length],id:String(index),title:fixtures[index%fixtures.length].title+' '+index})));
    const start=performance.now();
    for(const games of collections){harness.context.games=games;harness.render({search:'',sort:'newest'});}
    samples.push((performance.now()-start)/collections.length);
  }
  return median(samples);
}
console.log(JSON.stringify({render30Queries2000Games:[renderTime(before),renderTime(after)],render30TitleQueries2000Games:[renderTime(before,'title'),renderTime(after,'title')],initialRender5Games:[initialRenderTime(before,5),initialRenderTime(after,5)],initialRender2000Games:[initialRenderTime(before,2000),initialRenderTime(after,2000)]}));
