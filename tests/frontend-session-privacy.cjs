'use strict';

// Execute the production privacy/session code with a synthetic clock, DOM and
// fetch. No real credentials, network, database or production data are used.
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {harness,flush,deferred}=require('./frontend-dom.cjs');
const game={id:'privacy-game',title:'Synthetic private game',platform:'PC',edition:'Fizyczne',status:'Do ogrania',coverUrl:'',createdAt:1};
const BASE=2000000000000;
function fixture(){const clock={wall:BASE,mono:0};const t=harness({clock,autoSession:false});t.seed([game]);t.clock=clock;t.baseSeconds=BASE/1000;return t;}
function metadata(t,{idleAge=0,authAge=60,serverNow=Math.floor((BASE+t.clock.mono)/1000)}={}){return {authenticatedAt:serverNow-authAge,lastActivityAt:serverNow-idleAge,idleExpiresAt:serverNow-idleAge+1800,absoluteExpiresAt:serverNow-authAge+28800,serverNow};}
function apply(t,m=metadata(t)){t.context.auditMetadata=m;return vm.runInContext('applySessionMetadata(auditMetadata,sessionClock())',t.context);}
function advance(t,ms){t.clock.wall+=ms;t.clock.mono+=ms;t.runDueTimers();}
function state(t){return JSON.parse(vm.runInContext('JSON.stringify({authenticated,logoutPending,privacySuspended,remaining:sessionRemaining(),games:games.length})',t.context));}
function action(r){return r.options.body?JSON.parse(r.options.body).action:'GET';}
function assertHidden(t){assert.equal(t.nodes.appShell.hidden,true);assert.equal(t.document.documentElement.classList.contains('privacy-suspended')||state(t).games===0,true);}
async function finishLogout(t){await flush();const i=t.requests.findIndex(r=>action(r)==='logout'&&!r.settled);assert(i>=0,'Expected final logout');t.respond(i,200,{ok:true});await flush();const j=t.requests.findIndex((r,index)=>index>i&&!r.settled);assert(j>=0,'Expected anonymous initialization');t.respond(j,401,{ok:false,authRequired:true,captcha:{provider:'turnstile',siteKey:'synthetic-site'}});await flush();assert.equal(t.nodes.loginForm.hidden,false);}
async function main(){
 for(const kind of ['initialize','login']){
  const clock={wall:BASE,mono:0};const t=harness({clock,autoSession:false});t.clock=clock;
  let pending;
  if(kind==='initialize') pending=t.context.initialize();
  else {
   vm.runInContext("captchaChallenge={provider:'turnstile',siteKey:'synthetic-site'};captchaSolution='synthetic-token';",t.context);
   t.nodes.loginButton.disabled=false;t.nodes.loginUsername.value='synthetic-user';t.nodes.loginPassword.value='synthetic-password';
   pending=t.context.submitLogin({preventDefault(){}});
  }
  assert.equal(t.requests.length,1);t.document.hidden=true;t.events.visibilitychange({});t.windowEvents.blur?.({});
  t.respond(0,200,{ok:true,games:[game],session:metadata(t)});await pending;
  assert.equal(state(t).privacySuspended,false,'Authentication completing in the background does not create a return lock');
  assert.equal(t.nodes.appShell.hidden,false);t.document.hidden=false;t.events.visibilitychange({});t.windowEvents.focus({});await flush();
  assert.equal(t.requests.length,1,'Returning after authentication sends no additional request');assert.equal(t.nodes.appShell.hidden,false);
  console.log('PASS: '+kind+' completing in the background is available on return without another check');
 }
 {
  const t=fixture();apply(t);assert.equal(t.nodes.sessionWarning.hidden,true);
  advance(t,1739000);assert.equal(t.nodes.sessionWarning.hidden,true);
  advance(t,1000);assert.equal(t.nodes.sessionWarning.hidden,false);assert.match(t.nodes.sessionWarningText.textContent,/Zapisz/);assert.equal(t.requests.length,0);
  advance(t,60000);await flush();assertHidden(t);assert.equal(t.requests[0].url,'api/games.php?session=1');
  t.respond(0,401,{ok:false,authRequired:true});await flush();assert.equal(state(t).games,0);assert.equal(t.nodes.grid.innerHTML,'');assert.equal(t.nodes.gameId.value,'');await finishLogout(t);
  console.log('PASS: sixty-second warning, idle deadline, immediate privacy cloak, data clearing and ordinary login after expiry');
 }
 {
  const t=fixture();vm.runInContext('sessionPolicy=null;',t.context);apply(t,metadata(t,{authAge:28740}));assert.equal(t.nodes.sessionWarning.hidden,false);
  advance(t,60000);await flush();assertHidden(t);t.respond(0,401,{ok:false,authRequired:true});await flush();assert.equal(state(t).games,0);await finishLogout(t);
  console.log('PASS: absolute eight-hour boundary applies even with recent server activity');
 }
 {
  const t=fixture();apply(t);const before=state(t).remaining;
  advance(t,5000);const read=t.context.apiRequest('POST',{action:'backup-cover',id:game.id});t.respond(0,200,{ok:true,backup:{status:'cached'},session:{...metadata(t,{idleAge:5,authAge:65})}});await read;
  assert(state(t).remaining<=before-5000,'Passive response cannot renew idle');
  const m=metadata(t,{authAge:65});apply(t,m);assert(state(t).remaining>before-5000,'Genuine newer server activity may update idle');
  console.log('PASS: passive cover responses do not refresh idle; newer foreground server activity can');
 }
 {
  const t=fixture();apply(t);t.clock.wall-=3600000;t.clock.mono+=1800000;
  assert(state(t).remaining<=0,'Rolling wall time backward cannot extend the monotonic deadline');
  t.timers.find(timer=>!timer.cleared&&timer.delay===1800000).handler();await flush();assertHidden(t);assert.equal(t.requests[0].url,'api/games.php?session=1');
  console.log('PASS: local clock rollback cannot extend an active session');
 }
 {
  const t=fixture();apply(t);const check=t.context.revalidatePrivateSession();advance(t,5000);
  t.respond(0,200,{ok:true,session:metadata(t,{idleAge:5,authAge:65})});assert.equal(await check,true);
  assert(state(t).remaining<=1790000,'Response latency is not added back to the deadline');
  const latest=state(t).remaining;apply(t,metadata(t,{authAge:1000,idleAge:500}));assert(state(t).remaining<=latest,'Older authentication snapshot cannot overwrite the newer policy');
  console.log('PASS: request latency and old authentication snapshots cannot move deadlines later');
 }
 {
  const t=fixture();apply(t);t.context.openModal(game);t.nodes.title.value='Unwritten draft';
  t.context.fetch=()=>{throw new Error('Returning to an unexpired session must work offline');};
  t.document.hidden=true;t.events.visibilitychange({});t.windowEvents.blur?.({});
  assert.equal(t.nodes.appShell.hidden,false);assert.equal(t.nodes.modalBackdrop.hidden,false);assert.equal(state(t).privacySuspended,false);
  t.document.hidden=false;t.events.visibilitychange({});t.windowEvents.focus({});await flush();
  assert.equal(t.requests.length,0,'An unexpired return requires no network even when offline');assert.equal(t.nodes.appShell.hidden,false);assert.equal(t.nodes.modalBackdrop.hidden,false);assert.equal(t.nodes.title.value,'Unwritten draft');assert.equal(t.nodes.modalBackdrop.classList.contains('open'),true);
  console.log('PASS: valid blur/visibility return works offline, never cloaks, and preserves the unsaved form');
 }
 {
  const t=fixture();apply(t);const check=t.context.revalidatePrivateSession();t.windowEvents.blur?.({});t.document.hidden=true;t.events.visibilitychange({});
  t.respond(0,200,{ok:true,session:metadata(t)});assert.equal(await check,true);assert.equal(t.nodes.appShell.hidden,false);assert.equal(state(t).privacySuspended,false);
  t.document.hidden=false;t.events.visibilitychange({});t.windowEvents.focus({});await flush();assert.equal(t.requests.length,1);
  console.log('PASS: a check completing after blur restores the view without any follow-up return check');
 }
 {
  const t=fixture();apply(t);const first=t.context.revalidatePrivateSession();t.windowEvents.blur?.({});t.windowEvents.focus({});t.windowEvents.pageshow({persisted:true});
  const second=t.context.revalidatePrivateSession();assert.equal(t.requests.length,1,'Overlapping checks share the original request');
  t.respond(0,200,{ok:true,session:metadata(t)});assert.equal(await first,true);assert.equal(await second,true);await flush();assert.equal(t.requests.length,1);assert.equal(t.nodes.appShell.hidden,false);
  console.log('PASS: repeated focus during a pending check causes no duplicate or follow-up requests');
 }
 {
  const t=fixture();apply(t);t.context.openModal(game);t.nodes.title.value='BFCache draft';
  t.windowEvents.pagehide?.({persisted:true});assert.equal(t.nodes.appShell.hidden,false);assert.equal(state(t).privacySuspended,false);
  t.windowEvents.pageshow({persisted:true});await flush();assert.equal(t.requests.length,0);assert.equal(t.nodes.appShell.hidden,false);assert.equal(t.nodes.title.value,'BFCache draft');assert.equal(t.nodes.modalBackdrop.classList.contains('open'),true);
  console.log('PASS: a valid back-forward cache restoration preserves the view and draft without a request');
 }
 {
  const t=fixture();apply(t);const p=t.context.revalidatePrivateSession();t.requests[0].reject(new Error('Synthetic offline'));await p;assertHidden(t);assert.equal(t.nodes.retryConnection.hidden,false);assert.equal(state(t).games,1,'Unexpired draft remains under the cloak for retry');
  const retry=t.nodes.retryConnection.onclick();await flush();assert.equal(t.requests[1].url,'api/games.php?session=1');t.respond(1,200,{ok:true,session:metadata(t)});await retry;assert.equal(t.nodes.appShell.hidden,false);
  console.log('PASS: a failed explicit session check remains locked and retry cannot bypass validation');
 }
 {
  const t=fixture();apply(t);const p=t.context.revalidatePrivateSession();t.runTimers(10000);await p;assertHidden(t);assert.equal(t.nodes.retryConnection.hidden,false);
  const logout=t.context.performLogout();await flush();assert.equal(t.requests.length,1,'Hung session fetch remains tracked before final logout');
  t.respond(0,200,{ok:true,session:metadata(t)});await flush();assert.equal(state(t).games,0);assert.equal(t.nodes.appShell.hidden,true);await finishLogout(t);await logout;
  console.log('PASS: timeout leaves a retryable locked view and late session replies cannot bypass final logout');
 }
 {
  const t=fixture();apply(t);advance(t,1800000);await flush();t.requests[0].reject(new Error('Synthetic offline at expiry'));await flush();assert.equal(state(t).games,0);assert.equal(t.nodes.title.value,'');assert.equal(t.nodes.appShell.hidden,true);await finishLogout(t);
  console.log('PASS: offline expiry clears private memory and drafts instead of retaining an unlocked cache');
 }
 {
  const t=fixture();apply(t);advance(t,1800000);await flush();
  t.respond(0,429,{ok:false,error:'Synthetic rate limit'});await flush();
  assertHidden(t);assert.equal(t.nodes.retryConnection.hidden,false);assert.equal(t.requests.length,1);
  const retry=t.nodes.retryConnection.onclick();await flush();
  assert.equal(t.requests[1].url,'api/games.php?session=1');
  t.respond(1,200,{ok:true,session:metadata(t,{authAge:1860})});
  await retry;assert.equal(t.nodes.appShell.hidden,false);
  console.log('PASS: rate-limited expiry check stays hidden and can retry without logging out');
 }
 {
  const t=fixture();apply(t);advance(t,1800000);await flush();t.respond(0,200,{ok:true,session:metadata(t,{authAge:1860})});await flush();assert.equal(t.nodes.appShell.hidden,false);assert.equal(state(t).games,1);assert.equal(t.requests.some(r=>action(r)==='logout'),false);
  console.log('PASS: activity in another tab can renew a stale local idle deadline without logging that tab out');
 }
 {
  const t=fixture();apply(t);const saved={...game,title:'Saved while hidden'};const p=t.context.apiRequest('POST',{action:'save',game:saved}).then(result=>{t.context.auditGames=result.games;vm.runInContext('games=auditGames;render();',t.context);});
  t.windowEvents.blur?.({});t.document.hidden=true;t.events.visibilitychange({});t.respond(0,200,{ok:true,games:[saved],session:metadata(t)});await p;assert.equal(t.nodes.appShell.hidden,false);assert.equal(state(t).privacySuspended,false);assert(t.nodes.grid.textContent.includes(saved.title));
  t.document.hidden=false;t.events.visibilitychange({});t.windowEvents.focus({});await flush();assert.equal(t.requests.length,1);assert.equal(t.nodes.appShell.hidden,false);assert(t.nodes.grid.textContent.includes(saved.title));
  console.log('PASS: a save completing in the background updates normally without a return check');
 }
 {
  const t=fixture();apply(t);const draft=JSON.stringify([{...game,title:'Imported fixture'}]);t.context.confirm=()=>true;
  t.windowEvents.blur?.({});t.windowEvents.focus({});await flush();assert.equal(t.requests.length,0);const input={files:[{size:draft.length,text:async()=>draft}],value:'chosen-file'};
  const imported=t.nodes.importFile.onchange({target:input});await flush();assert.equal(t.requests.length,1);assert.equal(action(t.requests[0]),'replace','File selection goes directly to the authorized import');
  t.respond(0,200,{ok:true,games:[{...game,title:'Imported fixture'}],session:metadata(t)});await imported;assert.equal(input.value,'');assert(t.nodes.grid.textContent.includes('Imported fixture'));
  console.log('PASS: native file-picker blur/focus imports directly without an extra session request');
 }
 {
  const t=fixture();apply(t);t.context.openModal(game);t.windowEvents.blur?.({});const p=t.context.revalidatePrivateSession();t.respond(0,401,{ok:false,authRequired:true});await p;await flush();assert.equal(state(t).games,0);assert.equal(t.nodes.modalBackdrop.hidden,false,'Normal hidden defaults are restored for the next login');await finishLogout(t);
  console.log('PASS: an expired session clears forms and restores dialog defaults for a future login');
 }
 for(const event of ['visibilitychange','focus','pageshow']){
  const t=fixture();apply(t);t.document.hidden=true;t.events.visibilitychange({});t.windowEvents.blur?.({});
  // A suspended browser may advance real time without delivering timer callbacks.
  t.clock.wall+=1800001;t.clock.mono+=1800001;assert.equal(t.requests.length,0);t.document.hidden=false;
  if(event==='visibilitychange')t.events.visibilitychange({});else t.windowEvents[event]({persisted:true});
  await flush();assertHidden(t);assert.equal(t.requests.length,1);assert.equal(t.requests[0].url,'api/games.php?session=1');
  t.events.visibilitychange({});t.windowEvents.focus({});t.windowEvents.pageshow({persisted:true});await flush();assert.equal(t.requests.length,1,'Overdue resume events share the expiry check');
  t.respond(0,401,{ok:false,authRequired:true});await flush();assert.equal(state(t).games,0);await finishLogout(t);
  console.log('PASS: '+event+' catches a genuinely elapsed deadline when background timers were frozen');
 }
 {
  const t=fixture();apply(t);t.document.hidden=true;t.events.visibilitychange({});t.clock.wall+=1750000;t.clock.mono+=1750000;
  t.document.hidden=false;t.events.visibilitychange({});t.windowEvents.focus({});await flush();assert.equal(t.requests.length,0);assert.equal(t.nodes.appShell.hidden,false);assert.equal(t.nodes.sessionWarning.hidden,false);
  console.log('PASS: returning within the last minute updates the local warning without a network check');
 }
 {
  const t=fixture();apply(t);t.document.hidden=true;t.events.visibilitychange({});advance(t,1800000);await flush();assertHidden(t);assert.equal(t.requests.length,1);
  t.respond(0,200,{ok:true,session:metadata(t,{authAge:1860})});await flush();assert.equal(state(t).privacySuspended,false);assert.equal(t.nodes.appShell.hidden,false);
  t.document.hidden=false;t.events.visibilitychange({});t.windowEvents.focus({});await flush();assert.equal(t.requests.length,1);
  console.log('PASS: a real expiry check can finish in the background without leaving the view permanently hidden');
 }
 console.log('All offline session privacy checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
