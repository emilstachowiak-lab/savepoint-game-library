'use strict';

// Execute the production form code against a deterministic DOM and image loader.
// Images, timers, requests and game records are synthetic. No network or DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {harness,flush,html,parseMarkup,descendants} = require('./frontend-dom.cjs');
const all = descendants(parseMarkup(html));
const productionPlatforms = all.filter(node=>node.tag==='input'&&node.attrs.name==='platform').map(node=>node.attrs.value);
const game = {id:'synthetic-form-id',title:'Synthetic game',platform:'Xbox 360, PlayStation 5',edition:'Fizyczne i cyfrowe',status:'W trakcie',coverUrl:'',createdAt:1};
const foundCover = 'https://images.igdb.com/igdb/image/upload/t_cover_big/cofixture.jpg';
const checkboxes = test => test.nodes.platform.querySelectorAll('input[name="platform"]');
const tabs = test => test.nodes.platformTabs.querySelectorAll('[role="tab"]');
const groups = test => test.nodes.platformOptions.querySelectorAll('.platform-group');
const selectedTab = test => tabs(test).find(tab=>tab.getAttribute('aria-selected')==='true');
const visibleGroups = test => groups(test).filter(group=>!group.hidden);
const tabName = tab => tab?.dataset.platformGroup ?? tab?.textContent.replace(/\d+\s*$/,'').trim();
function pick(test,name,checked=true){const input=checkboxes(test).find(input=>input.value===name);assert(input,'Expected console '+name);input.checked=checked;test.fire(input,'change');return input;}
function clickTab(test,name){const tab=tabs(test).find(tab=>tabName(tab)===name);assert(tab,'Expected producer '+name);test.fire(tab,'click');return tab;}
function latestImage(test){assert(test.images.length,'Expected a detached, synthetic image loader');return test.images.at(-1);}
function load(image){image.complete=true;image.naturalWidth=320;const callback=image.onload;assert.equal(typeof callback,'function','Image loader must have a load callback');callback.call(image,{target:image});}
function isVisible(node){for(let current=node;current;current=current.parentElement)if(current.hidden)return false;return true;}
function assertGoogleCoverQuery(test,title=''){
 const link=test.nodes.googleCoverSearch;
 assert(link,'The cover field must contain a Google Images search link');
 const url=new URL(link.href);
 assert.equal(url.origin,'https://www.google.com');assert.equal(url.pathname,'/search');
 assert.equal(url.searchParams.get('udm'),'2','Search must open image results');
 assert.equal(url.searchParams.get('q'),title?title+' game cover':'video game cover');
 assert.deepEqual([...url.searchParams.keys()].sort(),['q','udm'],'A title cannot inject additional search parameters');
}
function assertPrivatePreviewCleared(test){
 assert.equal(test.nodes.coverPreview.getAttribute('src'),null,'Closed form must release its visible cover URL');
 assert.equal(test.nodes.coverPreview.hidden,true);assert.equal(test.nodes.coverPreviewPlaceholder.hidden,false);
 assert(!test.nodes.coverPreviewTitle.textContent.includes('Synthetic'),'Closed form must clear private cover title');
 assert.equal(test.nodes.selectedPlatforms.querySelectorAll('.selected-platform-chip').length,0,'Closed form must clear selected console names');
 for(const value of ['Xbox 360','PlayStation 5','Synthetic'])assert(!test.nodes.selectedPlatforms.textContent.includes(value),'Closed summary must not retain '+value);
 assert.equal(test.nodes.title.value,'');assert.equal(test.nodes.coverUrl.value,'');
 if(test.nodes.googleCoverSearch)assertGoogleCoverQuery(test);
}
function urlInput(test,value){test.nodes.coverUrl.value=value;test.fire(test.nodes.coverUrl,'input');test.runTimers(200);}
function titleInput(test,value){test.nodes.title.value=value;test.fire(test.nodes.title,'input');}
function manualCoverDraft(){
 const test=harness();test.seed([]);test.context.AbortController=AbortController;test.context.openModal();
 titleInput(test,game.title);pick(test,'PC');return test;
}
function classicFormDocument(document){
 // Keep the original inputs, native fieldsets and all existing application IDs,
 // but remove the optional gallery UI, reproducing the old form DOM contract.
 const field = id => document.getElementById(id).closest('.field');
 const title=field('title'),cover=field('coverUrl'),edition=field('edition'),status=field('status');
 document.getElementById('aiCoverSearchControls')?.remove();
 const platform=document.getElementById('platform'),options=document.getElementById('platformOptions'),help=document.getElementById('platformHelp');
 document.getElementById('platformSelectionCount').remove();
 const legend=platform.querySelector('legend');
 platform.replaceChildren(legend,options,help);
 document.querySelector('#gameForm .form-grid').replaceChildren(title,cover,platform,edition,status);
 document.querySelector('#modalBackdrop .modal').classList.remove('game-modal');
 for(const id of ['coverPreview','coverPreviewPlaceholder','coverPreviewTitle','coverPreviewStatus','platformTabs','platformSelectionCount','selectedPlatforms'])
  assert.equal(document.getElementById(id),null,'Classic fixture must not expose #'+id);
}
async function main(){
 {
  const test=harness();test.seed([game]);
  const link=test.nodes.googleCoverSearch;
  assert(link.closest('.field').contains(test.nodes.coverUrl),'Google Images belongs to the existing cover field');
  assert.equal(link.getAttribute('target'),'_blank');
  const rel=(link.getAttribute('rel')??'').split(/\s+/);
  assert(rel.includes('noopener')&&rel.includes('noreferrer'),'External search must isolate the new tab and omit referrer');
  assert.equal(link.getAttribute('onclick'),null,'Use a native link, preserving browser tab behavior');
  test.context.openModal();assertGoogleCoverQuery(test);
  const title='  Źródło & #1? cover=<img src=x onerror=alert(1)> / 日本語  ';
  test.nodes.title.value=title;test.fire(test.nodes.title,'input');assertGoogleCoverQuery(test,title.trim());
  assert.equal(new URL(test.nodes.coverSearch.href).searchParams.get('searchstring'),title.trim(),'The existing Cover Project search must remain available');
  assert.equal(link.querySelector('img'),null,'A title must never become link markup');
  test.context.closeModal();assertGoogleCoverQuery(test);
  test.context.openModal(game);assertGoogleCoverQuery(test,game.title);
  test.nodes.title.value='   ';test.fire(test.nodes.title,'input');assertGoogleCoverQuery(test);
  test.context.closeModal();test.context.openModal();assertGoogleCoverQuery(test);
  test.context.openModal({...game,title:'Synthetic private Google search'});assertGoogleCoverQuery(test,'Synthetic private Google search');
  test.context.clearPrivateData();assertGoogleCoverQuery(test);
  assert.equal(test.requests.length,0,'Preparing links must never send the title or game data to an API');
  console.log('PASS: Google Images search is an isolated native link, safely encodes titles, preserves Cover Project and clears private queries on reset');
 }
 {
  const test=harness({prepareDocument(document){document.getElementById('googleCoverSearch')?.remove();}});test.seed([game]);
  test.context.openModal();test.nodes.title.value='Synthetic title in the previous HTML';test.fire(test.nodes.title,'input');
  assert.equal(new URL(test.nodes.coverSearch.href).searchParams.get('searchstring'),test.nodes.title.value);
  test.context.closeModal();test.context.openModal(game);test.context.clearPrivateData();
  assert.equal(test.requests.length,0,'The optional search link must not break the previous HTML during deployment');
  console.log('PASS: previous HTML without the Google search link still opens, updates and clears the form safely');
 }
 {
  const test=harness();test.seed([game]);test.context.AbortController=AbortController;
  const {aiCoverSearch: button,aiCoverSearchStatus: status}=test.nodes;
  assert.equal(button.type,'button','AI cover lookup must not submit the form');
  assert.equal(status.getAttribute('role'),'status');assert.equal(isVisible(button),false);
  test.context.openModal();assert.equal(isVisible(button),true);
  test.fire(button,'click');assert.match(status.textContent,/Wpisz tytuł/);
  assert.equal(test.document.activeElement,test.nodes.title);
  titleInput(test,'  '+game.title+'  ');test.fire(button,'click');assert.match(status.textContent,/Wybierz/);
  assert.equal(test.document.activeElement.name,'platform');assert.equal(isVisible(test.document.activeElement),true);
  assert.equal(test.requests.length,0,'Title and at least one platform are required before lookup');
  pick(test,'Xbox 360');pick(test,'PlayStation 5');test.fire(button,'click');test.fire(button,'click');
  assert.equal(button.disabled,true);assert.match(status.textContent,/Szukam/);
  assert.equal(test.requests.length,1,'One pending lookup suppresses repeated clicks');
  const search=test.requests[0];
  assert.equal(search.options.method,'POST');assert.equal(search.options.credentials,'same-origin');assert(search.options.signal);
  assert.deepEqual(JSON.parse(search.options.body),{action:'ai-cover-search',title:game.title,platforms:['Xbox 360','PlayStation 5']});
  test.respond(0,200,{ok:true,coverUrl:foundCover,coverSource:'igdb'});await flush();
  assert.equal(button.disabled,false);assert.match(status.textContent,/Znaleziono okładkę/);
  assert.equal(test.nodes.coverUrl.value,foundCover);const image=latestImage(test);assert.equal(image.src,foundCover);load(image);
  assert.equal(test.nodes.coverPreview.src,foundCover);assert.equal(test.nodes.coverPreview.hidden,false);
  assert.equal(test.requests.length,1,'A matching result must populate the draft without saving it');
  const save=test.nodes.gameForm.onsubmit({preventDefault(){}});
  const body=JSON.parse(test.requests[1].options.body);assert.equal(body.action,'save');assert.equal(body.game.coverUrl,foundCover);
  test.respond(1,200,{ok:true,games:[body.game]});await save;
  assertPrivatePreviewCleared(test);assert.equal(status.textContent,'');assert.equal(isVisible(button),false);
  console.log('PASS: manually adding a game supports authenticated, editable AI cover lookup with a preview and an explicit save');
 }
 {
  const originalCover = 'https://images.example.invalid/existing-cover.jpg';
  const edited = {...game, coverUrl: originalCover, platform: `${game.platform}, Inna, Legacy console`};
  const test = harness();
  test.seed([edited]);
  const {aiCoverSearch: button, aiCoverSearchStatus: status} = test.nodes;
  test.context.openModal(edited);
  assert.equal(isVisible(button), true, 'Editing exposes the same AI cover lookup as adding');
  assert.equal(test.nodes.title.value, edited.title);
  assert.equal(test.nodes.coverUrl.value, originalCover);
  load(latestImage(test));
  assert.equal(test.nodes.coverPreview.src, originalCover);

  test.fire(button, 'click');
  assert.equal(test.requests.length, 1);
  assert.deepEqual(JSON.parse(test.requests[0].options.body), {
   action: 'ai-cover-search', title: edited.title, platforms: ['Xbox 360', 'PlayStation 5']
  }, 'Lookup sends the supported platforms from the edited game');
  test.respond(0, 200, {ok: true, coverUrl: foundCover, coverSource: 'igdb'});
  await flush();
  assert.match(status.textContent, /Znaleziono okładkę/);
  assert.equal(test.nodes.coverUrl.value, foundCover);
  load(latestImage(test));
  assert.equal(test.nodes.coverPreview.src, foundCover);
  assert.equal(test.requests.length, 1, 'Finding an edit cover must not automatically save it');

  const pending = test.nodes.gameForm.onsubmit({preventDefault(){}});
  assert.equal(test.requests.length, 2);
  const saved = {...edited, coverUrl: foundCover};
  assert.deepEqual(JSON.parse(test.requests[1].options.body), {action: 'save', mode: 'edit', game: saved, delta: true},
   'Explicit save updates the cover while preserving ID, creation time, and all selected platforms');
  test.respond(1, 200, {ok: true, game: saved});
  await pending;
  assertPrivatePreviewCleared(test);
  assert.equal(isVisible(button), false);
  console.log('PASS: edit looks up and previews a replacement cover, and saves it only on explicit submission');
 }
 {
  const edited = {...game, coverUrl: 'https://images.example.invalid/first-edit-cover.jpg'};
  const next = {...edited, id: 'different-synthetic-id'};
  const test = harness();
  test.seed([edited, next]);
  test.context.AbortController = AbortController;
  const {aiCoverSearch: button, aiCoverSearchStatus: status} = test.nodes;
  test.context.openModal(edited);
  test.fire(button, 'click');
  test.context.openModal(next);
  assert.equal(test.requests[0].options.signal.aborted, true, 'Switching games must cancel the previous draft lookup');
  test.fire(button, 'click');
  test.respond(0, 200, {ok: true, coverUrl: foundCover});
  await flush();
  assert.equal(test.nodes.gameId.value, next.id);
  assert.equal(test.nodes.coverUrl.value, next.coverUrl, 'An identical title, platforms, and old cover do not make the old reply current');
  assert.equal(button.disabled, true, 'The late reply must leave the new lookup in progress');
  assert.match(status.textContent, /Szukam/);
  test.respond(1, 200, {ok: true, coverUrl: foundCover});
  await flush();
  assert.equal(test.nodes.coverUrl.value, foundCover);
  test.context.closeModal();
  assertPrivatePreviewCleared(test);
  assert.equal(test.requests.length, 2, 'Cancelling a draft with a suggested cover must not save it');
  console.log('PASS: lookup replies stay with the correct edit draft even when two games share the same form values');
 }
 {
  const test=manualCoverDraft();const {aiCoverSearch: button,aiCoverSearchStatus: status}=test.nodes;
  const typedCover='https://images.example.invalid/user-supplied-cover.jpg';urlInput(test,typedCover);
  for(const [code,result,message] of [
   [200,{ok:true,coverUrl:''},/Nie znaleziono/],
   [200,{ok:true,coverUrl:'',coverSearch:'unavailable'},/chwilowo niedostępne/],
   [200,{ok:true,coverUrl:'javascript:alert(1)'},/Nie udało się/],
   [200,{ok:true,coverUrl:'https://user@images.example.invalid/cover.jpg'},/Nie udało się/],
   [429,{ok:false,error:'Synthetic cover quota exhausted.',errorDefault:'Osiągnięto limit okładek.'},/limit okładek/],
   [503,{ok:false},/Nie udało się/],
  ]){
   const index=test.requests.length;test.fire(button,'click');test.respond(index,code,result);await flush();
   assert.match(status.textContent,message);assert.equal(button.disabled,false);
   assert.equal(test.nodes.coverUrl.value,typedCover,'A failed lookup must preserve an existing cover URL');
  }
  assert.equal(test.images.length,1,'Neither a miss nor an unsafe response starts a new image preview');
  console.log('PASS: empty, unavailable, invalid and failed searches preserve the user’s cover URL and report status');
 }
 {
  for(const [label,change] of [
   ['title',test=>titleInput(test,'A newer synthetic title')],
   ['platforms',test=>pick(test,'PlayStation 5')],
   ['manual cover',test=>urlInput(test,'https://images.example.invalid/new-manual-cover.jpg')],
   ['reopened form',test=>{test.context.closeModal();test.context.openModal();titleInput(test,game.title);pick(test,'PC');}],
  ]){
   const test=manualCoverDraft();const {aiCoverSearch: button,aiCoverSearchStatus: status}=test.nodes;
   test.fire(button,'click');change(test);
   assert.equal(test.requests[0].options.signal.aborted,true,label+' must cancel the prior search');
   const expected=test.nodes.coverUrl.value;
   test.fire(button,'click');
   test.respond(0,200,{ok:true,coverUrl:foundCover});await flush();
   assert.equal(test.nodes.coverUrl.value,expected,label+' must reject late results from a previous draft');
   assert.equal(button.disabled,true,'A late reply must not re-enable the button during another lookup');
   assert.match(status.textContent,/Szukam/);
   test.respond(1,200,{ok:true,coverUrl:''});await flush();
   assert.equal(test.nodes.coverUrl.value,expected);assert.equal(button.disabled,false);
  }
  const test=manualCoverDraft();const {aiCoverSearch: button,aiCoverSearchStatus: status}=test.nodes;
  test.fire(button,'click');const logout=test.context.performLogout();await flush();
  assert.equal(test.requests[0].options.signal.aborted,true);assert.equal(test.requests.length,2,'Cookie-free lookup must not delay logout');
  assert.equal(JSON.parse(test.requests[1].options.body).action,'logout');
  test.respond(0,200,{ok:true,coverUrl:foundCover});await flush();
  assertPrivatePreviewCleared(test);assert.equal(status.textContent,'');
  test.respond(1,200,{ok:true});await flush();test.respond(2,401,{ok:false,authRequired:true});await logout;
  assertPrivatePreviewCleared(test);assert.equal(status.textContent,'');
  console.log('PASS: aborted searches cannot cross draft changes, close/reopen, or logout even when a stale reply arrives');
 }
 {
  const test=harness();test.seed([]);test.context.openModal();
  assert.equal(productionPlatforms.length,35);assert.equal(new Set(productionPlatforms).size,35);
  assert.deepEqual(checkboxes(test).map(input=>input.value),productionPlatforms,'All existing native console values must remain available');
  assert.equal(tabs(test).length,5);assert.equal(tabName(selectedTab(test)),'Microsoft');assert.equal(visibleGroups(test).length,1);
  for(const tab of tabs(test)){const panel=test.document.getElementById(tab.getAttribute('aria-controls'));assert(panel,'Tab must reference an existing producer panel');assert.equal(panel.getAttribute('aria-labelledby'),tab.id);assert.equal(panel.getAttribute('role'),'tabpanel');}
  assert.equal(tabs(test).filter(tab=>tab.tabIndex===0).length,1,'Only the selected producer belongs to the tab sequence');
  clickTab(test,'Sony');test.fire(checkboxes(test)[0],'invalid');
  assert.equal(isVisible(checkboxes(test)[0]),true,'Non-bubbling native invalid must reveal its producer through a capturing listener');
  assert.equal(tabName(selectedTab(test)),'Microsoft');clickTab(test,'Sony');
  await test.nodes.gameForm.onsubmit({preventDefault(){}});
  assert.equal(test.requests.length,0,'Missing a console must not send an API write');
  const invalid=test.reportedValidity.at(-1);assert(invalid,'Missing console must report validity');
  assert.equal(isVisible(invalid),true,'Native validation must reveal its panel before focusing a checkbox');
  assert.equal(visibleGroups(test).length,1);
  console.log('PASS: add form retains all 35 consoles, accessible producer tabs and visible native validation');
 }
 {
  const test=harness();test.seed([]);test.context.openModal();
  pick(test,'Xbox One');clickTab(test,'Sony');pick(test,'PlayStation 5');clickTab(test,'Nintendo');pick(test,'Nintendo Switch');
  clickTab(test,'Microsoft');clickTab(test,'Sony');
  assert.deepEqual(Array.from(test.context.getSelectedPlatforms()),['Xbox One','PlayStation 5','Nintendo Switch']);
  assert.match(test.nodes.platformSelectionCount.textContent,/\b3\b/);
  for(const value of ['Xbox One','PlayStation 5','Nintendo Switch'])assert(test.nodes.selectedPlatforms.textContent.includes(value),'Selection summary must retain '+value);
  assert.equal(test.requests.length,0,'Switching tabs and checking consoles must remain local');
  console.log('PASS: selections and selected-console summary persist across producer tabs');
 }
 {
  const test=harness();test.seed([]);test.context.openModal();
  const first=tabs(test)[0],last=tabs(test).at(-1);
  test.fire(first,'keydown',{key:'ArrowRight'});
  assert.equal(selectedTab(test),tabs(test)[1]);assert.equal(test.document.activeElement,tabs(test)[1]);
  test.fire(selectedTab(test),'keydown',{key:'End'});assert.equal(selectedTab(test),last);assert.equal(test.document.activeElement,last);
  test.fire(last,'keydown',{key:'ArrowRight'});assert.equal(selectedTab(test),first);
  test.fire(first,'keydown',{key:'ArrowLeft'});assert.equal(selectedTab(test),last);
  test.fire(last,'keydown',{key:'Home'});assert.equal(selectedTab(test),first);
  assert.equal(tabs(test).filter(tab=>tab.tabIndex===0).length,1);assert.equal(visibleGroups(test).length,1);
  console.log('PASS: producer tabs support arrow keys, wrapping, Home/End and roving focus');
 }
 {
  const test=harness(),unknown='Synthetic <img src=x onerror=alert(1)> console';test.seed([game]);
  test.context.openModal({...game,platform:'PlayStation 5, '+unknown});
  assert.equal(tabName(selectedTab(test)),'Sony','Editing reveals the first producer with a selection');
  assert.equal(tabs(test).length,6);assert.equal(checkboxes(test).length,36);
  const extra=groups(test).find(group=>group.hasAttribute('data-extra-platforms'));assert(extra);
  assert(extra.textContent.includes(unknown));assert.equal(extra.querySelector('img'),null,'Unknown console labels must stay text');
  assert.equal(test.nodes.selectedPlatforms.querySelector('img'),null,'Selected chips must not parse console names as HTML');
  clickTab(test,'Inne zapisane konsole');assert.equal(extra.hidden,false);
  assert.equal(checkboxes(test).find(input=>input.value===unknown).checked,true);
  test.context.closeModal();assertPrivatePreviewCleared(test);
  test.context.openModal();assert.equal(checkboxes(test).length,35);assert.equal(tabs(test).length,5);assert.equal(test.nodes.selectedPlatforms.querySelectorAll('.selected-platform-chip').length,0);
  console.log('PASS: edit preserves imported consoles safely; closing and reopening removes private/extra values');
 }
 {
  const test=harness();test.seed([game]);test.context.openModal(game);
  test.nodes.title.value='Synthetic updated game';test.nodes.coverUrl.value='https://images.example.invalid/synthetic.jpg';
  const pending=test.nodes.gameForm.onsubmit({preventDefault(){}});
  assert.equal(test.requests.length,1);const body=JSON.parse(test.requests[0].options.body);
  assert.equal(body.action,'save');assert.equal(body.game.id,game.id);assert.equal(body.game.platform,game.platform);
  assert.equal(body.game.edition,game.edition);assert.equal(body.game.status,game.status);assert.equal(body.game.title,'Synthetic updated game');
  test.respond(0,200,{ok:true,games:[body.game]});await pending;
  assert.equal(test.nodes.modalBackdrop.classList.contains('open'),false);assertPrivatePreviewCleared(test);
  console.log('PASS: edit submits exactly one normal save preserving multiple consoles, both editions and status');
 }
 {
  const test=harness();test.seed([]);
  test.nodes.addBtn.focus();
  test.context.openModal();test.runTimers(40);
  assert.equal(test.document.activeElement,test.nodes.title);
  assert.equal(test.nodes.appShell.inert,true);
  const submit=test.nodes.gameForm.querySelector('button[type="submit"]');
  submit.focus();
  let tabTrapped=false;
  test.events.keydown({key:'Tab',preventDefault(){tabTrapped=true;}});
  assert.equal(tabTrapped,true);
  assert.equal(test.document.activeElement,test.nodes.closeModal);
  test.nodes.title.value='Retryable draft';
  checkboxes(test).find(input=>input.value==='PC').checked=true;
  let dismissed=0;
  test.context.confirm=()=>{dismissed++;return false;};
  test.events.keydown({key:'Escape',preventDefault(){}});
  assert.equal(dismissed,1);assert.equal(test.nodes.title.value,'Retryable draft');

  const before=test.nodes.gameForm.onsubmit({preventDefault(){}});
  await test.nodes.gameForm.onsubmit({preventDefault(){}});
  assert.equal(test.requests.length,1,'A double submission sends one request');
  const original=JSON.parse(test.requests[0].options.body);
  test.respond(0,503,{ok:false,error:'Synthetic temporary failure'});await before;
  const retry=test.nodes.gameForm.onsubmit({preventDefault(){}});
  assert.deepEqual(JSON.parse(test.requests[1].options.body),original,'Retry retains ID, timestamp and data');
  test.respond(1,200,{ok:true,game:{...original.game,revision:'a'.repeat(64)}});await retry;
  assert.equal(test.nodes.appShell.inert,false);assert.equal(test.document.activeElement,test.nodes.addBtn);
  console.log('PASS: keyboard confinement and dirty dismissal, one in-flight save, stable retry ID and focus restoration');
 }
 {
  const previous={...game,revision:'a'.repeat(64),edition:'Imported custom edition',status:'Imported custom status'};
  const reviewed={...previous,revision:'b'.repeat(64)};
  const test=harness();test.seed([previous]);test.context.openModal(previous);
  test.seed([reviewed]);
  test.nodes.title.value='My draft still matters';
  const pending=test.nodes.gameForm.onsubmit({preventDefault(){}});
  const request=JSON.parse(test.requests[0].options.body);
  assert.equal(request.revision,previous.revision,'Revision belongs to the record originally opened');
  assert.equal(request.game.edition,previous.edition);assert.equal(request.game.status,previous.status);
  test.respond(0,409,{ok:false,code:'collection_conflict',error:'Synthetic edit conflict'});await flush();
  assert.equal(test.requests[1].options.method,'GET');
  test.respond(1,200,{ok:true,games:[reviewed]});await pending;
  assert.equal(test.nodes.title.value,'My draft still matters');assert.equal(test.nodes.modalBackdrop.classList.contains('open'),true);
  console.log('PASS: an older edit sends its original revision, preserves imported options and retains the draft during conflict recovery');
 }
 {
  const test=harness();test.seed([]);test.context.openModal();
  for(const unsafe of ['javascript:alert(1)','data:image/svg+xml,synthetic','blob:synthetic']){
   urlInput(test,unsafe);assert.equal(test.images.length,0,'Unsafe image schemes must not start a loader');
   assert.equal(test.nodes.coverPreview.hidden,true);assert.equal(test.nodes.coverPreview.getAttribute('src'),null);
  }
  test.nodes.title.value='<img src=x onerror=alert(1)> Synthetic private title';test.fire(test.nodes.title,'input');
  assert.equal(test.nodes.coverPreviewTitle.textContent,test.nodes.title.value);assert.equal(test.nodes.coverPreviewTitle.querySelector('img'),null);
  urlInput(test,'https://images.example.invalid/synthetic-first.jpg');const image=latestImage(test);
  assert.equal(test.nodes.coverPreview.hidden,true,'Loading an image must not show a stale previous cover');
  load(image);assert.equal(test.nodes.coverPreview.hidden,false);assert.equal(test.nodes.coverPreviewPlaceholder.hidden,true);
  assert.equal(test.nodes.coverPreview.src,'https://images.example.invalid/synthetic-first.jpg');
  const fail=test.nodes.coverPreview.onerror;assert.equal(typeof fail,'function');fail({target:test.nodes.coverPreview});
  assert.equal(test.nodes.coverPreview.hidden,true);assert.equal(test.nodes.coverPreviewPlaceholder.hidden,false);
  assert.match(test.nodes.coverPreviewStatus.textContent,/Nie udało się/);
  urlInput(test,'');assert.equal(test.nodes.coverPreview.getAttribute('src'),null);assert.equal(test.nodes.coverPreview.hidden,true);
  assert.equal(test.requests.length,0,'Cover previews must not call the game API');
  console.log('PASS: cover preview rejects unsafe schemes, handles loading/error/empty states and escapes titles');
 }
 {
  const test=harness();test.seed([]);test.context.openModal();
  test.nodes.coverUrl.value='https://images.example.invalid/synthetic-debounced-old.jpg';test.fire(test.nodes.coverUrl,'input');
  test.nodes.coverUrl.value='https://images.example.invalid/synthetic-debounced-new.jpg';test.fire(test.nodes.coverUrl,'input');
  assert.equal(test.images.length,0,'Typing must wait for the debounce before starting image work');
  test.runTimers(200);assert.equal(test.images.length,1,'Rapid edits must coalesce to one image loader');
  const image=latestImage(test);assert.equal(image.src,'https://images.example.invalid/synthetic-debounced-new.jpg');
  assert.equal(image.referrerPolicy,'no-referrer','Image preview must not transmit the application URL as a referrer');
  const failed=image.onerror;failed.call(image,{target:image});
  assert.equal(test.nodes.coverPreview.getAttribute('src'),null);assert.equal(test.nodes.coverPreviewPlaceholder.hidden,false);
  assert.match(test.nodes.coverPreviewStatus.textContent,/Nie udało się/);
  test.nodes.coverUrl.value='https://images.example.invalid/synthetic-cancelled.jpg';test.fire(test.nodes.coverUrl,'input');
  test.context.closeModal();test.runTimers(200);assert.equal(test.images.length,1,'Closing cancels pending debounce work');
  assertPrivatePreviewCleared(test);assert.equal(test.requests.length,0);
  console.log('PASS: debounce coalesces edits, loader failures fall back, and closing cancels pending image work');
 }
 {
  const test=harness();test.seed([]);test.context.openModal();
  urlInput(test,'https://images.example.invalid/synthetic-old.jpg');const oldImage=latestImage(test),oldLoad=oldImage.onload,oldError=oldImage.onerror;
  urlInput(test,'https://images.example.invalid/synthetic-new.jpg');const current=latestImage(test),currentLoad=current.onload;assert.notEqual(current,oldImage);load(current);
  oldImage.naturalWidth=100;oldLoad.call(oldImage,{target:oldImage});oldError.call(oldImage,{target:oldImage});
  assert.equal(test.nodes.coverPreview.src,'https://images.example.invalid/synthetic-new.jpg');assert.equal(test.nodes.coverPreview.hidden,false);
  test.context.closeModal();assertPrivatePreviewCleared(test);
  currentLoad.call(current,{target:current});assertPrivatePreviewCleared(test);
  test.context.openModal({...game,title:'Synthetic later game',coverUrl:'https://images.example.invalid/synthetic-later.jpg'});test.runTimers(200);
  const later=latestImage(test);load(later);oldLoad.call(oldImage,{target:oldImage});
  assert.equal(test.nodes.coverPreview.src,'https://images.example.invalid/synthetic-later.jpg');
  console.log('PASS: stale image load/error events cannot replace a newer cover or revive a closed form');
 }
 {
  const test=harness();test.seed([game]);test.context.openModal({...game,title:'Synthetic private title',coverUrl:'https://images.example.invalid/synthetic-private.jpg'});test.runTimers(200);
  const image=latestImage(test),staleLoad=image.onload,staleError=image.onerror;
  const logout=test.context.performLogout();assertPrivatePreviewCleared(test);
  staleLoad.call(image,{target:image});staleError.call(image,{target:image});assertPrivatePreviewCleared(test);
  await flush();assert.equal(test.requests.length,1);assert.equal(JSON.parse(test.requests[0].options.body).action,'logout');
  test.respond(0,200,{ok:true});await flush();test.respond(1,401,{ok:false,authRequired:true});await logout;
  assertPrivatePreviewCleared(test);assert.equal(test.requests.length,2,'Logout must not cause a save or image API request');
  console.log('PASS: logout cancels cover work and clears private preview/selection data despite late events');
 }
 {
  const archivedMarkup=process.argv[2]?fs.readFileSync(process.argv[2],'utf8'):null;
  const test=harness(archivedMarkup?{markup:archivedMarkup}:{prepareDocument:classicFormDocument});
  test.seed([game]);
  assert.equal(test.document.getElementById('coverPreview'),null);assert.equal(test.document.getElementById('platformTabs'),null);
  assert.equal(test.document.getElementById('aiCoverSearch'),null);
  assert.equal(checkboxes(test).length,35);
  test.context.openModal();assert.equal(test.nodes.modalBackdrop.classList.contains('open'),true);assert.equal(test.nodes.title.value,'');
  assert.equal(visibleGroups(test).length,5,'Old HTML must retain all five visible producer groups');
  test.context.closeModal();assert.equal(test.nodes.modalBackdrop.classList.contains('open'),false);
  const legacyGame={...game,coverUrl:'https://images.example.invalid/synthetic-classic.jpg'};
  test.context.openModal(legacyGame);assert.equal(test.nodes.title.value,legacyGame.title);
  assert.deepEqual(Array.from(test.context.getSelectedPlatforms()),['Xbox 360','PlayStation 5']);
  test.runTimers(200);assert.equal(test.images.length,0,'An older document must not start optional gallery image work');
  test.nodes.title.value='Synthetic old HTML edit';test.fire(test.nodes.title,'input');
  const save=test.nodes.gameForm.onsubmit({preventDefault(){}});assert.equal(test.requests.length,1);
  const body=JSON.parse(test.requests[0].options.body);assert.equal(body.action,'save');
  assert.equal(body.game.platform,legacyGame.platform);assert.equal(body.game.edition,legacyGame.edition);assert.equal(body.game.status,legacyGame.status);assert.equal(body.game.coverUrl,legacyGame.coverUrl);
  test.respond(0,200,{ok:true,games:[body.game]});await save;
  assert.equal(test.nodes.modalBackdrop.classList.contains('open'),false);assert.equal(test.nodes.title.value,'');
  assert.equal(checkboxes(test).filter(input=>input.checked).length,0);
  console.log('PASS: new JavaScript also initializes, opens, edits, saves and closes safely with '+(archivedMarkup?'archived classic HTML':'the classic HTML DOM contract'));
 }
 console.log('All offline gallery game-form checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
