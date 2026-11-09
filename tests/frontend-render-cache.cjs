'use strict';

// Exercise the real renderer and privacy lifecycle. No network or real records.
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {harness}=require('./frontend-dom.cjs');
const fixtures=[
 {id:'1',title:'Fifa & <img src=x onerror=alert(1)>',platform:'PC, PlayStation 5',edition:'Fizyczne i cyfrowe',status:'Ograna',coverUrl:'javascript:alert(1)',createdAt:2},
 {id:'2',title:'Żółw',platform:'PC',edition:'Cyfrowe',status:'W trakcie',coverUrl:'https://example.invalid/cover.jpg?x=1&y=2',createdAt:3}
];
const test=harness();
test.context.cardBuilds=[];
vm.runInContext('const originalCardRenderer=renderGameCard;renderGameCard=entry=>{cardBuilds.push(entry.game.id);return originalCardRenderer(entry);};',test.context);
test.seed(fixtures);
test.nodes.search.value='fifa';test.context.render();
assert.deepEqual(Array.from(test.context.cardBuilds),['1'],'Only visible cards should be built on first use');
const first=test.nodes.grid.innerHTML;
assert(first.includes('&lt;img src=x onerror=alert(1)&gt;'));
assert(!first.includes('<img src=x'));
assert(!first.includes('javascript:'));
const firstNode=test.nodes.grid.firstElementChild;
test.nodes.search.value='FIFA';test.context.render();
assert.equal(test.nodes.grid.innerHTML,first,'Cached markup must match the initial render exactly');
assert.notEqual(test.nodes.grid.firstElementChild,firstNode,'Every render must retain the existing DOM replacement behavior');
assert.deepEqual(Array.from(test.context.cardBuilds),['1'],'The same visible card should reuse its HTML');
test.nodes.search.value='';test.context.render();
assert.deepEqual(Array.from(test.context.cardBuilds),['1','2'],'A newly visible card should be built lazily once');
const coverImages=test.nodes.grid.querySelectorAll('img.cover-image');
assert.equal(coverImages.length,1,'The valid external cover must render while the unsafe URL stays rejected');
assert.equal(coverImages[0].getAttribute('referrerpolicy'),'no-referrer','Collection cover requests must not transmit the application URL');
test.nodes.sort.value='title';test.context.render();
test.nodes.platformFilter.value='PlayStation 5';test.context.render();
test.nodes.editionFilter.value='Cyfrowe';test.context.render();
assert.deepEqual(Array.from(test.context.cardBuilds),['1','2'],'Sort/filter changes must reuse card markup');
console.log('PASS: lazy construction, exact cached HTML, hostile content escaping and unchanged DOM replacement');

test.seed(fixtures.map(game=>({...game,title:'Replacement '+game.title,edition:'Fizyczne',status:'Do ogrania'})));
for(const id of ['search','platformFilter','editionFilter','statusFilter'])test.nodes[id].value='';
test.context.render();
assert.equal(test.context.cardBuilds.length,4,'Replacing the collection must invalidate both cards even when IDs are reused');
assert(test.nodes.grid.textContent.includes('Replacement'));
assert(!test.nodes.grid.textContent.includes('W trakcie'));
console.log('PASS: replacement records with reused IDs do not reuse stale markup');

test.context.clearPrivateData();
assert.equal(test.nodes.grid.innerHTML,'');
assert.equal(vm.runInContext('collectionMetadataCache',test.context),null);
assert.equal(vm.runInContext('renderedCollectionMetadata',test.context),null);
test.seed(fixtures.map(game=>({...game,title:'Next session '+game.title})));
test.context.render();
assert.equal(test.context.cardBuilds.length,6,'A new session must build fresh cards');
assert(test.nodes.grid.textContent.includes('Next session'));
console.log('PASS: private data clearing releases renderer caches and a new session receives fresh markup');

const titles=['Fifa','fifa','FIFA','Żółw','Zolw','ząb','źdźbło','Łąka','Laka','ącki','é','e\u0301','a','a2','a10','Å','Ä','Ω','中','🎮','😀','','  ','<img src=x>','A&B','👩‍💻','\u0000','Straße','STRASSE'];
for(const a of titles)for(const b of titles)
 assert.equal(Math.sign(test.context.compareGameTitles({game:{title:a}},{game:{title:b}})),Math.sign(a.localeCompare(b,'pl')));
let collatorBuilds=0;
test.context.Intl={Collator:class {constructor(locale){collatorBuilds++;this.compare=new Intl.Collator(locale).compare;}}};
vm.runInContext('titleCollator=undefined;',test.context);
for(const a of titles)test.context.compareGameTitles({game:{title:a}},{game:{title:'Fifa'}});
assert.equal(collatorBuilds,1,'Repeated comparisons must reuse one Polish collator');
test.context.Intl=undefined;
vm.runInContext('titleCollator=undefined;',test.context);
for(const a of titles)for(const b of titles)
 assert.equal(Math.sign(test.context.compareGameTitles({game:{title:a}},{game:{title:b}})),Math.sign(a.localeCompare(b,'pl')));
console.log('PASS: cached Polish collation matches localeCompare for 841 Unicode pairs and retains its fallback');
