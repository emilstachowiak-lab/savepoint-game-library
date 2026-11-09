'use strict';

// Execute the actual renderer, queue and form against the offline DOM harness.
// No credentials, collection records or network services are used.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {harness, flush} = require('./frontend-dom.cjs');
const game = {id:'cover-test-1',title:'Synthetic cover',platform:'PC',edition:'Cyfrowe',status:'Do ogrania',coverUrl:'https://images.example.invalid/cover.jpg',createdAt:1};
const local = id => 'api/games.php?cover='+encodeURIComponent(id);
const requestBody = (test, index) => JSON.parse(test.requests[index].options.body);
function image(test) { return test.nodes.grid.querySelector('img.cover-image'); }
function loaded(loader) { loader.complete=true; loader.naturalWidth=200; loader.onload({target:loader}); }
async function scanMissing(test) {
  const index=test.requests.length;
  test.runTimers(750);await flush();
  const request=requestBody(test,index);
  assert.equal(request.action,'backup-cover-status');
  const games=vm.runInContext('games',test.context);
  test.respond(index,200,{ok:true,backups:request.ids.map(id=>({id,coverUrl:games.find(game=>game.id===id).coverUrl,ready:false}))});
  await flush();test.runTimers(750);await flush();
  return index+1;
}
async function main() {
 {
  const test=harness();
  const fixtures=Array.from({length:19},(_,index)=>({...game,id:'cached-'+index,coverUrl:'https://images.example.invalid/cached-'+index+'.jpg'}));
  test.seed(fixtures);test.context.render();
  assert.equal(test.requests.length,0,'Rendering must not wait on background metadata');
  test.runTimers(750);await flush();
  assert.deepEqual(requestBody(test,0),{action:'backup-cover-status',ids:fixtures.map(game=>game.id)});
  test.context.render();test.runTimers(750);assert.equal(test.requests.length,1,'There can only be one active status worker');
  test.respond(0,200,{ok:true,backups:fixtures.map(game=>({id:game.id,coverUrl:game.coverUrl,ready:true}))});
  await flush();test.runTimers(750);await flush();
  assert.equal(test.requests.length,1,'Nineteen existing copies must require one POST instead of nineteen');
  assert.equal(vm.runInContext('coverBackupQueue.length',test.context),0);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(games)',test.context)),fixtures,'Metadata must not enter games or JSON export');
  console.log('PASS: nineteen cached covers use one deferred metadata POST, preserve rendering and leave export records untouched');
 }
 {
  const test=harness();
  const fixtures=Array.from({length:33},(_,index)=>({...game,id:'batch-'+index,coverUrl:'https://images.example.invalid/batch-'+index+'.jpg'}));
  test.seed(fixtures);test.context.render();
  test.runTimers(750);await flush();assert.equal(requestBody(test,0).ids.length,32);
  test.respond(0,200,{ok:true,backups:fixtures.slice(0,32).map(game=>({id:game.id,coverUrl:game.coverUrl,ready:true}))});
  await flush();test.runTimers(750);await flush();assert.deepEqual(requestBody(test,1),{action:'backup-cover-status',ids:[fixtures[32].id]});
  test.respond(1,200,{ok:true,backups:[{id:fixtures[32].id,coverUrl:fixtures[32].coverUrl,ready:true}]});
  await flush();test.runTimers(750);assert.equal(test.requests.length,2);
  console.log('PASS: metadata batches contain at most thirty-two IDs and ready batches never issue image-download POSTs');
 }
 {
  const test=harness();
  test.seed([game,{...game,id:'cover-test-2'},{...game,id:'cover-test-3',coverUrl:'https://images.example.invalid/other.png'}]);
  test.context.render();
  assert.equal(test.requests.length,0,'Rendering must not block on a backup POST');
  assert.equal(image(test).src,game.coverUrl,'Original cover remains the first source');
  assert.equal(image(test).getAttribute('loading'),'lazy');
  assert.equal(image(test).getAttribute('referrerpolicy'),'no-referrer');
  await scanMissing(test);
  assert.equal(test.requests.length,2);
  assert.deepEqual(requestBody(test,1),{action:'backup-cover',id:game.id},'Only the saved ID is sent, never an arbitrary URL');
  test.context.render();test.runTimers(750);await flush();assert.equal(test.requests.length,2,'One worker only, including during repeated renders');
  test.respond(1,200,{ok:true,backup:{status:'cached'}});await flush();test.runTimers(750);await flush();
  assert.equal(test.requests.length,3);assert.equal(requestBody(test,2).id,'cover-test-3','Identical cover URLs share one backup request');
  test.respond(2,200,{ok:true,backup:{status:'saved'}});await flush();test.context.render();test.runTimers(750);await flush();
  assert.equal(test.requests.length,3,'No repeated work for filtered or unchanged collections');
  assert.equal(JSON.parse(vm.runInContext('JSON.stringify(games)',test.context))[0].coverUrl,game.coverUrl,'Export keeps the original cover URL and record shape');
  console.log('PASS: deferred sequential queue, URL deduplication, stable render and unchanged record/export shape');
 }
 {
  const test=harness();
  const first={...game,coverUrl:'https://IMAGES.EXAMPLE.INVALID:443/a/../cover.jpg'};
  const second={...game,id:'cover-normalized-2',coverUrl:'https://images.example.invalid/cover.jpg'};
  assert.equal(new URL(first.coverUrl).href,new URL(second.coverUrl).href);
  test.seed([first,second]);test.context.render();
  const images=test.nodes.grid.querySelectorAll('img.cover-image');
  for (const cover of images) test.fire(cover,'error');
  await scanMissing(test);test.respond(1,200,{ok:true,backup:{status:'saved'}});await flush();
  assert.equal(images[0].src,local(first.id)+'&ready=1');
  assert.equal(images[1].src,local(second.id),'A normalized-equivalent raw URL must not consume the other backup retry');
  test.runTimers(750);assert.equal(test.requests.length,3,'Every distinct raw database URL needs its own cache key');
  assert.equal(requestBody(test,2).id,second.id);
  test.respond(2,200,{ok:true,backup:{status:'saved'}});await flush();
  assert.equal(images[1].src,local(second.id)+'&ready=1');
  test.context.render();test.runTimers(750);assert.equal(test.requests.length,3,'Both raw keys are deduplicated independently after success');
  console.log('PASS: normalized-equivalent but distinct raw cover URLs retain independent backup keys and ready retries');
 }
 {
  const test=harness();test.seed([game]);test.context.render();
  const cover=image(test);const before=test.imageAssignments.length;
  test.fire(cover,'error');assert.equal(cover.src,local(game.id));
  test.fire(cover,'error');test.fire(cover,'error');assert.equal(test.imageAssignments.length,before+1,'Failure of the backup must not create a loop');
  await scanMissing(test);test.respond(1,200,{ok:true,backup:{status:'saved'}});await flush();
  assert.equal(test.imageAssignments.length,before+2,'A backup created after the first fallback gets one retry');
  test.fire(cover,'error');test.context.markCoverBackupReady(game.coverUrl);assert.equal(test.imageAssignments.length,before+2);
  assert.equal(cover.getAttribute('onerror'),null,'Image handling must comply with the script CSP');
  console.log('PASS: non-bubbling image error uses one local fallback, handles initial backup race and never loops');
 }
 {
  const test=harness();let observer;
  test.context.IntersectionObserver=class {
   constructor(callback){this.callback=callback;this.observed=[];this.disconnected=false;observer=this;}
   observe(element){this.observed.push(element);}
   unobserve(element){this.observed=this.observed.filter(item=>item!==element);}
   disconnect(){this.disconnected=true;}
  };
  test.seed([game]);test.context.render();const cover=image(test);
  test.runTimers(10000);assert.equal(cover.src,game.coverUrl,'Off-screen lazy covers cannot time out before being requested');
  observer.callback([{target:cover,isIntersecting:false}]);test.runTimers(10000);assert.equal(cover.src,game.coverUrl);
  observer.callback([{target:cover,isIntersecting:true}]);test.runTimers(10000);
  assert.equal(cover.src,game.coverUrl,'The slow original remains pending while its backup is probed');
  const probe=test.images.at(-1);assert.equal(probe.src,local(game.id));loaded(probe);
  assert.equal(cover.src,local(game.id),'A visibly stalled source switches only after its copy loads');
  test.context.render();const current=image(test),currentObserver=observer;
  currentObserver.callback([{target:current,isIntersecting:true}]);current.complete=true;current.naturalWidth=200;test.fire(current,'load');test.runTimers(10000);
  assert.equal(current.src,game.coverUrl,'A successful source clears the watchdog');
  const count=test.imageAssignments.length;test.fire(cover,'error');assert.equal(test.imageAssignments.length,count,'Detached cards cannot change after a new render');
  console.log('PASS: visibility starts the stalled-image watchdog without defeating lazy loading; successful and detached cards are safe');
 }
 {
  const test=harness();test.seed([game]);test.context.render();await scanMissing(test);
  const old=image(test);const changed={...game,coverUrl:'https://images.example.invalid/new-cover.png'};
  test.seed([changed]);test.context.render();const current=image(test);
  test.respond(1,200,{ok:true,backup:{status:'saved'}});await flush();
  assert.equal(current.src,changed.coverUrl,'Completing the old URL cannot overwrite the new image');
  test.fire(old,'error');assert.equal(current.src,changed.coverUrl);
  test.runTimers(750);assert.equal(test.requests.length,3);assert.deepEqual(requestBody(test,2),{action:'backup-cover-status',ids:[game.id]});
  test.respond(2,200,{ok:true,backups:[{id:game.id,coverUrl:changed.coverUrl,ready:false}]});await flush();test.runTimers(750);await flush();
  assert.equal(requestBody(test,3).id,game.id,'A changed URL receives its own new backup');
  test.respond(3,200,{ok:true,backup:{status:'unavailable'}});await flush();test.runTimers(750);assert.equal(test.requests.length,4,'Unavailable covers do not hot-loop retries');
  console.log('PASS: URL edits isolate old requests, queue a new copy and avoid repeated failures');
 }
 {
  const test=harness();test.seed([game]);test.context.render();test.runTimers(750);await flush();const old=image(test);
  const logout=test.context.performLogout();await flush();
  assert.equal(test.requests.length,1,'Logout waits for the prior POST before clearing the server session');
  test.respond(0,200,{ok:true,backups:[{id:game.id,coverUrl:game.coverUrl,ready:true}]});await flush();
  assert.equal(test.requests.length,2);assert.equal(requestBody(test,1).action,'logout');
  const assignments=test.imageAssignments.length;test.fire(old,'error');test.runTimers(750);test.runTimers(10000);await flush();
  assert.equal(test.imageAssignments.length,assignments);assert.equal(test.nodes.grid.innerHTML,'');
  test.respond(1,200,{ok:true});await flush();test.respond(2,401,{ok:false,authRequired:true});await logout;
  test.runTimers(750);await flush();assert.equal(test.requests.length,3,'No backup POST may follow logout');
  assert.equal(vm.runInContext('coverImageStates.size + coverBackupQueue.length + coverBackupAttempted.size + coverBackupStatusChecked.size',test.context),0);
  console.log('PASS: logout clears private queue/images, settles the active request and rejects stale callbacks');
 }
 {
  const test=harness();test.seed([game]);test.context.openModal(game);test.runTimers(200);
  const first=test.images.at(-1);assert.equal(first.src,game.coverUrl);first.onerror({target:first});
  const fallback=test.images.at(-1);assert.notEqual(fallback,first);assert.equal(fallback.src,local(game.id));loaded(fallback);
  assert.equal(test.nodes.coverPreview.src,local(game.id));assert.equal(test.nodes.coverPreview.hidden,false);
  test.nodes.coverPreview.onerror({target:test.nodes.coverPreview});assert.equal(test.nodes.coverPreview.hidden,true,'Backup preview failure returns to the existing placeholder');
  test.nodes.coverUrl.value='https://images.example.invalid/draft.png';test.fire(test.nodes.coverUrl,'input');test.runTimers(200);
  const draft=test.images.at(-1);const count=test.images.length;draft.onerror({target:draft});assert.equal(test.images.length,count,'An unsaved draft must not display the old cover backup');
  assert.equal(test.nodes.coverPreview.hidden,true);
  test.context.closeModal();assert.equal(test.nodes.coverPreview.getAttribute('src'),null);
  console.log('PASS: saved-cover preview falls back once and never substitutes a previous cover for a changed draft');
 }
 {
  const test=harness();test.seed([game]);test.context.openModal(game);test.runTimers(200);
  const old=test.images.at(-1);test.runTimers(10000);const probe=test.images.at(-1);assert.equal(probe.src,local(game.id));
  assert.equal(old.src,game.coverUrl);loaded(probe);const fallback=test.images.at(-1);assert.equal(fallback.src,local(game.id));
  const stale=fallback.onerror;test.context.closeModal();stale({target:fallback});test.runTimers(10000);
  assert.equal(test.nodes.coverPreview.getAttribute('src'),null);assert.equal(test.nodes.coverPreview.hidden,true);
  assert.equal(old.getAttribute('src'),null,'Timed out detached source is released');
  console.log('PASS: preview watchdog uses the saved copy and closing cancels watchdogs and late events');
 }
 {
  const test=harness();let observer;
  test.context.IntersectionObserver=class {constructor(cb){this.callback=cb;observer=this;}observe(){}unobserve(){}disconnect(){}};
  test.seed([game]);test.context.render();const cover=image(test);
  observer.callback([{target:cover,isIntersecting:true}]);test.runTimers(10000);
  const cardProbe=test.images.at(-1);cardProbe.onerror({target:cardProbe});assert.equal(cover.src,game.coverUrl,'An unavailable copy must not cancel a slow but viable original');
  test.context.openModal(game);test.runTimers(200);const original=test.images.at(-1);test.runTimers(10000);
  const previewProbe=test.images.at(-1);assert.notEqual(previewProbe,original);previewProbe.onerror({target:previewProbe});
  assert.equal(original.src,game.coverUrl);loaded(original);assert.equal(test.nodes.coverPreview.src,game.coverUrl);
  console.log('PASS: missing backups leave slow original card and preview requests running to completion');
 }
 {
  const test=harness();test.seed([game]);test.context.render();await scanMissing(test);
  for (const [index, delay] of [[1,1500],[2,3000],[3,6000]]) {
   test.respond(index,200,{ok:true,backup:{status:'busy'}});await flush();
   test.runTimers(delay);await flush();assert.equal(test.requests.length,index+2,'A shared backup lock receives a delayed retry');
  }
  test.respond(4,200,{ok:true,backup:{status:'busy'}});await flush();test.runTimers();await flush();
  assert.equal(test.requests.length,5,'Lock contention has a bounded retry count');
  test.context.clearPrivateData();assert.equal(vm.runInContext('coverBackupBusyRetries.size',test.context),0);
  console.log('PASS: shared-lock contention retries with backoff and stops after three retries');
 }
 {
  const test=harness();
  const fixtures=[game,{...game,id:'invalid-status-2',coverUrl:'https://images.example.invalid/second.jpg'},{...game,id:'invalid-status-3',coverUrl:'https://images.example.invalid/third.jpg'}];
  test.seed(fixtures);test.context.render();test.runTimers(750);await flush();
  test.respond(0,200,{ok:true,backups:[
   {id:game.id,coverUrl:game.coverUrl+'?old',ready:true},
   {id:fixtures[1].id,coverUrl:fixtures[1].coverUrl,ready:'true'},
   {id:fixtures[2].id,coverUrl:fixtures[2].coverUrl,ready:true},
   {id:fixtures[2].id,coverUrl:fixtures[2].coverUrl,ready:true},
   {id:'not-requested',coverUrl:game.coverUrl,ready:true}
  ]});await flush();
  for(let index=0;index<fixtures.length;index++){
   test.runTimers(750);await flush();assert.deepEqual(requestBody(test,index+1),{action:'backup-cover',id:fixtures[index].id});
   test.respond(index+1,200,{ok:true,backup:{status:'saved'}});await flush();
  }
  test.runTimers(750);assert.equal(test.requests.length,4);
  console.log('PASS: mismatched URLs, nonboolean readiness, duplicate IDs and unknown entries cannot suppress needed backups');
 }
 {
  for(const [status,payload] of [[400,{ok:false,error:'Synthetic unsupported operation'}],[500,{ok:false,error:'Synthetic server failure'}],[200,{ok:true,backups:null}]]){
   const test=harness();const second={...game,id:'fallback-two',coverUrl:'https://images.example.invalid/two.jpg'};
   test.seed([game,second]);test.context.render();test.runTimers(750);await flush();
   test.respond(0,status,payload);await flush();test.runTimers(750);await flush();
   assert.deepEqual(requestBody(test,1),{action:'backup-cover',id:game.id});
   test.respond(1,200,{ok:true,backup:{status:'saved'}});await flush();test.runTimers(750);await flush();
   assert.deepEqual(requestBody(test,2),{action:'backup-cover',id:second.id},'A failed status endpoint must fall back without another metadata request');
   test.respond(2,200,{ok:true,backup:{status:'saved'}});await flush();
   test.context.clearPrivateData();assert.equal(vm.runInContext('coverBackupStatusAvailable',test.context),true,'A later session can try metadata again');
  }
  console.log('PASS: unsupported, failed or malformed metadata falls back to the original sequential backup operation');
 }
 {
  const test=harness();test.seed([game]);test.context.render();test.runTimers(750);await flush();
  const changed={...game,coverUrl:'https://images.example.invalid/changed-during-status.jpg'};
  test.seed([changed]);test.context.render();
  test.respond(0,200,{ok:true,backups:[{id:game.id,coverUrl:game.coverUrl,ready:true}]});await flush();
  assert.equal(vm.runInContext('coverBackupAttempted.has(syntheticGames[0].coverUrl)',test.context),false);
  test.runTimers(750);await flush();assert.deepEqual(requestBody(test,1),{action:'backup-cover-status',ids:[game.id]});
  test.respond(1,200,{ok:true,backups:[{id:game.id,coverUrl:game.coverUrl,ready:true}]});await flush();test.runTimers(750);await flush();
  assert.deepEqual(requestBody(test,2),{action:'backup-cover',id:game.id},'An old raw URL reported ready cannot suppress the current URL backup');
  assert.equal(image(test).src,changed.coverUrl);
  test.respond(2,200,{ok:true,backup:{status:'saved'}});await flush();
  console.log('PASS: status responses from an old collection or old raw URL cannot mark a changed cover as ready');
 }
 {
  const test=harness();test.seed([game]);test.context.render();test.runTimers(750);await flush();
  test.respond(0,401,{ok:false,authRequired:true,error:'Synthetic expired session'});await flush();test.runTimers(750);await flush();
  assert.equal(test.nodes.grid.innerHTML,'');assert.equal(test.nodes.appShell.hidden,true);assert.equal(test.requests.length,1);
  assert.equal(vm.runInContext('coverImageStates.size + coverBackupQueue.length + coverBackupStatusChecked.size',test.context),0);
  console.log('PASS: a background backup receiving HTTP401 clears expired private data and stops its queue');
 }
 {
  const test=harness();test.seed([{...game,id:'bad" onerror="alert(1)'}]);test.context.render();test.runTimers(750);
  assert.equal(test.requests.length,0,'Invalid IDs cannot become backup routes');
  const cover=image(test);test.fire(cover,'error');assert.equal(cover.src,game.coverUrl);
  test.context.clearPrivateData();test.seed([game]);vm.runInContext('authenticated=false;',test.context);test.context.render();test.runTimers(750);assert.equal(test.requests.length,0);
  console.log('PASS: invalid IDs and unauthenticated rendering cannot schedule backups or construct local fallback URLs');
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
