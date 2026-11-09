'use strict';

// Offline regressions against real application functions. Fetch, DOM, storage,
// timers and files are synthetic; no network, database or real credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
new vm.Script(source, { filename: 'app.js' });
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, 'Expected source boundaries: ' + start);
  return source.slice(first, last);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const game = { id: 'synthetic-game', title: 'Synthetic private game', platform: 'PC, PlayStation 5', edition: 'Fizyczne', coverUrl: '', status: 'Ograna', createdAt: 1 };
const challenge = { provider: 'turnstile', siteKey: 'synthetic-site-key' };

function harness(persisted = false, shared = {}) {
  const requests = [], alerts = [], notices = [], prepared = [], timers = [], listeners = {};
  const marker = [['savepoint-logout-pending-v1', '1']];
  const local = shared.local ?? new Map(persisted === true || persisted === 'local' ? marker : []);
  const session = shared.session ?? new Map(persisted === 'session' ? marker : []);
  const storage = data => ({ getItem: key => data.get(key) ?? null, setItem: (key,value) => data.set(key,value), removeItem: key => data.delete(key) });
  const nodes = {};
  for (const id of ['grid','gameTitleSuggestions','platformFilter','editionFilter','statusFilter','search','sort','count','statTotal','statPlatforms','statDone','gameForm','gameId','title','coverUrl','coverSearch','edition','status','modalBackdrop','loginUsername','loginPassword','toggleLoginPassword','appShell','authScreen','authTitle','authIntro','loginForm','websiteField','authMessage','retryConnection','loginButton','captchaStatus','captchaWidget','toast','importFile','logoutBtn','platform','platformOptions']) {
    const classes = new Set();
    const attributes = {};
    nodes[id] = {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, href: '',
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return attributes[name] ?? null; },
      querySelector() { return null; },
      replaceChildren() { this.innerHTML = ''; this.textContent = ''; },
      focus() {},
      addEventListener() {}
    };
  }
  let inputs = ['PC','PlayStation 5'].map(value => ({ value, checked: false, setCustomValidity(message) { this.validationMessage = message; }, reportValidity() { return !this.validationMessage; } }));
  let extra = false;
  nodes.platform.querySelectorAll = () => inputs;
  nodes.platform.querySelector = () => extra ? { remove() { extra = false; inputs = inputs.filter(input => !input.extra); } } : null;
  nodes.platformOptions.append = () => {};
  nodes.gameForm.reset = () => {
    for (const id of ['gameId','title','coverUrl']) nodes[id].value = '';
    nodes.edition.value = 'Fizyczne'; nodes.status.value = 'Do ogrania';
    inputs.forEach(input => { input.checked = false; });
  };
  const cookies = shared.cookies ?? { value: 'synthetic-existing-session' };
  const test = { requests, alerts, notices, prepared, timers, nodes, local, session, cookies, listeners, legacy: [], confirms: 0, deleteConfirms: 0 };
  const context = vm.createContext({
    $: id => nodes[id], API_URL: 'api/games.php', LEGACY_KEY: 'synthetic-legacy-key',
    TextEncoder, URL, window: {}, location: { protocol: 'https:' },
    localStorage: storage(local), sessionStorage: storage(session),
    crypto: { randomUUID: () => 'synthetic-new-id' },
    readLegacyGames: () => test.legacy,
    fetch: (url,options) => {
      const pending = deferred();
      requests.push({ url, options, cookie: cookies.value, ...pending, settled: false });
      return pending.promise;
    },
    setTimeout: (handler,delay) => { const timer = {handler,delay,cleared:false}; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    addEventListener: (name,handler) => { listeners[name] = handler; },
    notify: message => notices.push(message), alert: message => alerts.push(message),
    confirm: () => { test.confirms++; return test.confirmResult ?? true; },
    confirmGameDeletion: async () => {
      test.deleteConfirms++;
      return test.deleteConfirmation ? await test.deleteConfirmation : test.deleteConfirmResult ?? true;
    },
    setConnectionStatus() {},
    closeModal: () => nodes.modalBackdrop.classList.remove('open'),
    clearCaptchaWidget: () => nodes.captchaWidget.replaceChildren(),
    document: { hidden:false, createElement() { throw new Error('Unexpected DOM creation in lifecycle fixture'); } },
    renderCalls: 0
  });
  vm.runInContext(`let games = []; let toastTimer; let captchaGeneration = 0; let captchaChallenge = null; let captchaSolution = null; let captchaSolvePromise = null;
    function render() { renderCalls++; $('grid').innerHTML = games.map(game => game.title).join('|'); }
    function prepareCaptcha(challenge) { captchaChallenge = challenge; captchaSolution = null; preparedChallenge(challenge); }
    function showAuthenticatedError(message) { $('authMessage').textContent = message; }`, context);
  context.preparedChallenge = value => prepared.push(value);
  vm.runInContext(
    section('const safeImageUrl', 'function readLegacyGames') +
    section('const MAX_REQUEST_BYTES', 'function setConnectionStatus') +
    section('const COVER_LOAD_TIMEOUT', 'function platformCheckboxes') +
    section('function platformCheckboxes', 'function render()') +
    section('function hasCaptchaChallenge', 'async function solveAutomaticCaptcha') +
    section('function setLoginPasswordVisibility(', 'function showLogin()') +
    section('function showLogin()', 'async function submitLogin') +
    section('async function submitLogin', 'function showAuthenticatedError') +
    section("$('retryConnection').onclick =", 'function openModal') +
    section('window.deleteGame =', "$('grid').addEventListener") +
    section("$('gameForm').onsubmit =", "['search', 'platformFilter'") +
    section("$('importFile').onchange =", '\nfunction initializeUiLanguage()') +
    // These cases isolate session/API races. Real form presentation, imported
    // producer tabs and image lifecycles run in frontend-game-form.cjs.
    '\nfunction getPlatformGroups(){return [];} function rebuildPlatformTabs(){} function updatePlatformSelectionSummary(){} function initializeGameFormPresentation(){} function clearCoverPreview(){}', context);
  test.context = context;
  test.state = () => JSON.parse(vm.runInContext('JSON.stringify({games,cache:collectionMetadataCache,rendered:renderedCollectionMetadata,generation:sessionGeneration,pending:logoutPending,freshLoginRequired,authenticated})',context));
  test.seed = () => {
    context.syntheticGames = [{...game}];
    context.syntheticSession=metadata();
    vm.runInContext('games = syntheticGames; collectionMetadataCache = {games}; renderedCollectionMetadata = collectionMetadataCache; authenticated = false; applySessionMetadata(syntheticSession,sessionClock()); authenticated = true;',context);
    nodes.grid.innerHTML = game.title; nodes.gameTitleSuggestions.innerHTML = game.title;
    nodes.platformFilter.innerHTML = 'private consoles';
    for (const id of ['search','title','coverUrl','gameId']) nodes[id].value = 'synthetic-private-value';
    nodes.title.value = game.title; nodes.gameId.value = game.id;
    nodes.appShell.hidden = false; nodes.authScreen.hidden = true;
    nodes.modalBackdrop.classList.add('open');
    extra = true; inputs.push({value:'Synthetic imported console',checked:true,extra:true,setCustomValidity(){}});
    inputs[0].checked = true;
  };
  test.assertCleared = () => {
    const state = test.state();
    assert.equal(state.games.length,0); assert.equal(state.cache,null); assert.equal(state.rendered,null);
    assert.equal(nodes.grid.innerHTML,''); assert.equal(nodes.gameTitleSuggestions.innerHTML,'');
    for (const id of ['search','title','coverUrl','gameId','loginUsername','loginPassword']) assert.equal(nodes[id].value,'',id);
    assert.equal(nodes.loginPassword.type,'password');
    assert.equal(nodes.toggleLoginPassword.getAttribute('aria-pressed'),'false');
    assert.equal(nodes.appShell.hidden,true); assert.equal(nodes.modalBackdrop.classList.contains('open'),false);
    assert.equal(inputs.some(input=>input.checked),false); assert.equal(extra,false);
    assert.equal(nodes.platformFilter.innerHTML,'<option value="">Wszystkie konsole</option>');
  };
  function metadata(){const now=Math.floor(Date.now()/1000);return {authenticatedAt:now-60,lastActivityAt:now,idleExpiresAt:now+1800,absoluteExpiresAt:now-60+28800,serverNow:now};}
  test.respond = (index,status,payload,newCookie) => {
    const request = requests[index]; assert(request && !request.settled,'Expected pending mocked fetch');
    const action=request.options.body?JSON.parse(request.options.body).action:'';
    if(payload?.ok===true&&action!=='logout'&&!Object.hasOwn(payload,'session'))payload={...payload,session:metadata()};
    request.settled = true; if (newCookie !== undefined) cookies.value = newCookie;
    request.resolve({status,ok:status>=200&&status<300,json:async()=>payload});
  };
  test.respondHeaders = (index,status,body,newCookie) => {
    const request=requests[index];assert(request&&!request.settled,'Expected pending mocked fetch');
    request.settled=true;if(newCookie!==undefined)cookies.value=newCookie;
    request.resolve({status,ok:status>=200&&status<300,json:()=>body});
  };
  test.reject = (index,message='Synthetic network failure') => {
    const request = requests[index]; request.settled=true; request.reject(new Error(message));
  };
  test.action = index => requests[index].options.body ? JSON.parse(requests[index].options.body).action : 'GET';
  test.import = file => {
    const target = { files:[file], value:'synthetic-selected-file' };
    return {target,promise:nodes.importFile.onchange({target})};
  };
  return test;
}

async function finishLogout(test, attempt) {
  await flush();
  const index = test.requests.findIndex(request=>!request.settled);
  assert.equal(test.action(index),'logout');
  test.respond(index,200,{ok:true},''); await flush();
  const next = test.requests.findIndex(request=>!request.settled);
  assert.equal(test.action(next),'GET');
  test.respond(next,401,{ok:false,authRequired:true,captcha:challenge});
  await attempt;
  assert.equal(test.state().pending,false);
  assert.equal(test.local.has('savepoint-logout-pending-v1'),false);
  assert.equal(test.session.has('savepoint-logout-pending-v1'),false);
  test.assertCleared();
}

async function main() {
  for (const [status,message] of [[413,'Żądanie jest zbyt duże.'],[415,'Żądanie musi zawierać dane JSON.']]) {
    const test=harness();test.seed();
    const operation=test.context.apiRequest('POST',{action:'save',game}).catch(error=>error);
    assert.equal(test.requests.length,1);assert.equal(test.action(0),'save');
    test.requests[0].settled=true;
    test.requests[0].resolve(new Response('<!doctype html><title>Web server rejection</title>',{status,headers:{'Content-Type':'text/html'}}));
    const error=await operation;
    assert.equal(error.message,message);assert.equal(error.status,status);
    assert.equal(JSON.stringify(error.payload),'{}');
    assert.equal(test.state().authenticated,true);assert.equal(test.state().games.length,1);
    assert.equal(vm.runInContext('activeApiRequests.size',test.context),0);
    console.log('PASS: non-JSON HTTP '+status+' preserves its status and readable error without clearing the session');
  }
  {
    for(const status of [413,415,500]) {
      const test=harness();test.seed();
      const operation=test.context.apiRequest('POST',{action:'save',game}).catch(error=>error);
      const payload={ok:false,error:'Synthetic original API error',details:'synthetic-details'};
      test.respond(0,status,payload);
      const error=await operation;
      assert.equal(error.message,payload.error);assert.equal(error.status,status);assert.equal(error.payload,payload);
      assert.equal(test.state().authenticated,true);assert.equal(test.state().games.length,1);
    }
    console.log('PASS: JSON API error messages and payloads retain priority over status fallbacks');
  }
  {
    const test=harness();
    const operation=test.context.apiRequest().catch(error=>error);
    test.requests[0].settled=true;
    test.requests[0].resolve(new Response('<html>Unavailable</html>',{status:500,headers:{'Content-Type':'text/html'}}));
    const error=await operation;
    assert.equal(error.message,'Nie udało się połączyć z bazą danych.');assert.equal(error.status,500);
    assert.equal(JSON.stringify(error.payload),'{}');
    console.log('PASS: other non-JSON HTTP failures retain the existing connection error');
  }
  {
    const test=harness(); test.seed();
    const attempt=test.context.performLogout();
    test.assertCleared(); assert.equal(test.state().pending,true);
    assert.equal(test.nodes.loginForm.hidden,true); assert.equal(test.local.get('savepoint-logout-pending-v1'),'1');
    assert.equal(test.session.get('savepoint-logout-pending-v1'),'1');
    await flush(); assert.equal(test.action(0),'logout');
    test.reject(0); await attempt;
    assert.equal(test.nodes.authTitle.textContent,'Wylogowanie niepotwierdzone');
    assert.equal(test.nodes.retryConnection.hidden,false); assert.equal(test.requests.length,1);
    const retry=test.nodes.retryConnection.onclick(); await finishLogout(test,retry);
    console.log('PASS: immediate clearing, pending logout, visible failure, retry and confirmed unlock');
  }
  for (const store of ['local','session']) {
    const test=harness(store);
    const attempt=test.context.initialize(); await flush();
    assert.equal(test.requests.length,1); assert.equal(test.action(0),'logout','Reload marker must block bootstrap GET');
    test.respond(0,500,{ok:false,error:'Synthetic server failure'}); await attempt;
    assert.equal(test.requests.length,1); assert.equal(test.state().pending,true);
    assert.equal(test[store].get('savepoint-logout-pending-v1'),'1');
    console.log('PASS: '+store+'Storage marker survives reload and failed logout cannot auto-unlock');
  }
  {
    const test=harness();test.seed();
    test.listeners.storage({key:'savepoint-logout-pending-v1',newValue:'1'});
    test.assertCleared();assert.equal(test.state().pending,true);
    await finishLogout(test,test.context.performLogout());
    console.log('PASS: logout marker from another tab locks and clears this tab');
  }
  {
    const test=harness();
    test.nodes.loginUsername.value='synthetic-user'; test.nodes.loginPassword.value='synthetic-password';
    vm.runInContext('captchaChallenge = {provider:"turnstile"}; captchaSolution = "synthetic-token";',test.context);
    const login=test.context.submitLogin({preventDefault(){}}); assert.equal(test.action(0),'login');
    const attempt=test.context.performLogout(); test.assertCleared(); await flush();
    assert.equal(test.requests.length,1,'Do not send logout before pending login settles');
    test.respond(0,200,{ok:true,games:[game]},'synthetic-rotated-session'); await login; await flush();
    assert.equal(test.action(1),'logout'); assert.equal(test.requests[1].cookie,'synthetic-rotated-session');
    assert.equal(test.nodes.authTitle.textContent,'Wylogowywanie…'); test.assertCleared();
    await finishLogout(test,attempt);
    console.log('PASS: pending login response cannot repopulate UI and final logout uses rotated cookie');
  }
  {
    // Two independent page contexts share only browser cookies and localStorage.
    // A finishes its logout while B still has an old login body in flight.
    const shared={local:new Map(),cookies:{value:'synthetic-original-session'}};
    const a=harness(false,shared),b=harness(false,shared),body=deferred();
    a.seed();
    b.nodes.loginUsername.value='synthetic-user';b.nodes.loginPassword.value='synthetic-password';
    vm.runInContext('captchaChallenge = {provider:"turnstile"}; captchaSolution = "synthetic-token";',b.context);
    const oldLogin=b.context.submitLogin({preventDefault(){}});
    const aLogout=a.context.performLogout();await flush();
    b.listeners.storage({key:'savepoint-logout-pending-v1',newValue:'1'});
    const bLogout=b.context.performLogout();await flush();
    assert.equal(a.action(0),'logout');assert.equal(b.requests.length,1);
    a.respond(0,200,{ok:true},'');
    b.respondHeaders(0,200,body.promise,'synthetic-late-rotated-session');
    await flush();
    assert.equal(a.action(1),'GET');
    assert.equal(a.requests[1].cookie,'synthetic-late-rotated-session');
    a.respond(1,200,{ok:true,games:[game]});await aLogout;
    a.assertCleared();assert.equal(a.state().pending,true);
    assert.equal(a.state().freshLoginRequired,true);
    assert.equal(a.requests.length,2,'Unexpected authenticated bootstrap must stop without a request loop');
    assert.equal(a.nodes.retryConnection.hidden,false);
    assert.equal(b.requests.length,1,'B still waits for its old login response body');
    body.resolve({ok:true,games:[game]});await oldLogin;await flush();
    await finishLogout(b,bLogout);
    a.assertCleared();b.assertCleared();
    assert.equal(shared.local.get('savepoint-login-required-v1'),'1');
    console.log('PASS: two tabs cannot restore collection through a late shared session cookie after logout');
  }
  for (const store of ['local','session']) {
    const persisted=new Map([['savepoint-login-required-v1','1']]);
    const test=harness(false,{[store]:persisted});
    const init=test.context.initialize();
    assert.equal(test.action(0),'GET');
    test.respond(0,200,{ok:true,games:[game]});await init;
    test.assertCleared();assert.equal(test.state().pending,true);
    assert.equal(test.state().freshLoginRequired,true);
    assert.equal(test.requests.length,1,'Reload must not accept an old authenticated session or loop');
    console.log('PASS: '+store+'Storage fresh-login marker prevents authenticated bootstrap after reload');
  }
  {
    const local=new Map([['savepoint-login-required-v1','1']]);
    const test=harness(false,{local});
    const init=test.context.initialize();
    test.respond(0,401,{ok:false,authRequired:true,captcha:challenge});await init;
    assert.equal(local.get('savepoint-login-required-v1'),'1');
    const startLogin=()=>{
      test.nodes.loginUsername.value='synthetic-user';test.nodes.loginPassword.value='synthetic-password';
      test.nodes.loginButton.disabled=false;
      vm.runInContext('captchaChallenge = {provider:"turnstile"}; captchaSolution = "synthetic-token";',test.context);
      return test.context.submitLogin({preventDefault(){}});
    };
    const failed=startLogin();
    test.respond(1,401,{ok:false,error:'Synthetic invalid credentials',captcha:challenge});await failed;
    assert.equal(local.get('savepoint-login-required-v1'),'1','Failed manual login cannot clear the logout guard');
    const success=startLogin();
    test.respond(2,200,{ok:true,games:[game]});await success;
    assert.equal(test.state().freshLoginRequired,false);assert.equal(local.has('savepoint-login-required-v1'),false);
    assert.equal(test.session.has('savepoint-login-required-v1'),false);
    assert.equal(test.nodes.appShell.hidden,false);assert.equal(test.state().games.length,1);
    console.log('PASS: only successful current manual login clears the fresh-login guard');
  }
  {
    const test=harness();const verification=deferred();test.context.syntheticVerification=verification.promise;
    test.nodes.loginPassword.value='synthetic-old-password';
    vm.runInContext('captchaChallenge = {provider:"pow",nonce:"synthetic"}; captchaSolution = null; captchaSolvePromise = syntheticVerification;',test.context);
    const login=test.context.submitLogin({preventDefault(){}});
    const attempt=test.context.performLogout();await finishLogout(test,attempt);
    test.nodes.loginPassword.value='synthetic-new-password';
    test.nodes.loginButton.disabled=false;test.nodes.loginButton.textContent='Synthetic new login state';
    verification.resolve('synthetic-old-solution');await login;
    assert.equal(test.requests.length,2,'Old verification must not send a login request');
    assert.equal(test.nodes.loginPassword.value,'synthetic-new-password');
    assert.equal(test.nodes.loginButton.disabled,false);assert.equal(test.nodes.loginButton.textContent,'Synthetic new login state');
    console.log('PASS: old verification/finally cannot alter a new login form after confirmed logout');
  }
  {
    const test=harness();test.seed();test.deleteConfirmResult=false;
    await test.context.window.deleteGame(game.id);
    assert.equal(test.deleteConfirms,1);assert.equal(test.confirms,0,'Deletion uses its Aero dialog, not browser confirm');
    assert.equal(test.requests.length,0);assert.equal(test.state().games.length,1);assert.equal(test.notices.length,0);
    console.log('PASS: cancelled Aero deletion sends no request and preserves the collection');
  }
  {
    const test=harness(),decision=deferred();test.seed();test.deleteConfirmation=decision.promise;
    const deletion=test.context.window.deleteGame(game.id);await flush();
    assert.equal(test.requests.length,0,'Do not delete while confirmation remains pending');
    decision.resolve(true);await flush();
    assert.equal(test.requests.length,1);assert.equal(test.action(0),'delete');
    assert.equal(JSON.parse(test.requests[0].options.body).id,game.id);
    test.respond(0,200,{ok:true,games:[]});await deletion;
    assert.equal(test.state().games.length,0);assert.equal(test.notices.length,1);
    console.log('PASS: deletion waits for explicit confirmation before sending exactly one request');
  }
  {
    const test=harness(),decision=deferred();test.seed();test.deleteConfirmation=decision.promise;
    const deletion=test.context.window.deleteGame(game.id);await flush();
    assert.equal(test.requests.length,0);
    const attempt=test.context.performLogout();await finishLogout(test,attempt);
    decision.resolve(true);await deletion;
    assert.equal(test.requests.length,2,'An old positive confirmation cannot send a delete after logout');
    assert.equal(test.notices.length,0);test.assertCleared();
    console.log('PASS: confirmation resolving after logout cannot delete, repopulate or show stale messages');
  }
  for (const kind of ['read','save','delete','migrate','import']) {
    const test=harness(); test.seed();
    let operation;
    if(kind==='read') operation=test.context.initialize();
    if(kind==='save') operation=test.nodes.gameForm.onsubmit({preventDefault(){}});
    if(kind==='delete') operation=test.context.window.deleteGame(game.id);
    if(kind==='migrate') {test.legacy=[game];operation=test.context.acceptAuthenticated([game]);}
    let imported;
    if(kind==='import') {imported=test.import({size:100,text:async()=>JSON.stringify([game])});operation=imported.promise;}
    const observed=Promise.resolve(operation).catch(error=>error);
    await flush(); assert.equal(test.requests.length,1,kind);
    const attempt=test.context.performLogout(); test.assertCleared(); await flush();
    assert.equal(test.requests.length,1,kind+': logout waits for old operation');
    test.respond(0,200,{ok:true,games:[game],inserted:1}); await observed; await flush();
    test.assertCleared(); assert.equal(test.context.renderCalls,0); assert.equal(test.notices.length,0);
    if(imported) assert.equal(imported.target.value,'');
    await finishLogout(test,attempt);
    console.log('PASS: stale '+kind+' response cannot restore private data or success messages');
  }
  {
    const test=harness();test.seed();
    const request=test.context.apiRequest('POST',{action:'save',game}).catch(error=>error);
    test.respond(0,401,{ok:false,authRequired:true,captcha:challenge});
    const error=await request; assert.equal(error.sessionExpired,true); test.assertCleared();
    assert.equal(test.nodes.loginForm.hidden,false); assert.equal(test.prepared.length,1);
    console.log('PASS: expired session clears collection/cache/form and returns to login');
  }
  {
    const test=harness();test.seed(); let reads=0;
    const imported=test.import({size:1024*1024+1,text:async()=>{reads++;return '[]';}}); await imported.promise;
    assert.equal(reads,0);assert.equal(test.requests.length,0);assert.equal(imported.target.value,'');
    assert.match(test.alerts[0],/1 MiB/);
    console.log('PASS: oversized file is rejected before reading and input clears');
  }
  {
    const test=harness();test.seed();test.confirmResult=false;
    const imported=test.import({size:2,text:async()=>'[]'});await imported.promise;
    assert.equal(imported.target.value,'');assert.equal(test.requests.length,0);
    const bad=test.import({size:1,text:async()=>'{'});await bad.promise;
    assert.equal(bad.target.value,'');assert.match(test.alerts[0],/JSON/);
    console.log('PASS: cancelled/invalid import clears file input');
  }
  {
    const test=harness();test.seed();
    const huge={...game,title:'ł'.repeat(40000)};
    const imported=test.import({size:90000,text:async()=>JSON.stringify([huge])});await imported.promise;
    assert.equal(test.requests.length,0);assert.equal(imported.target.value,'');assert.match(test.alerts[0],/64 KiB/);
    console.log('PASS: full outgoing JSON is limited by UTF-8 bytes before fetch');
  }
  {
    const test=harness();test.seed();const text=' '.repeat(70000)+JSON.stringify([game]);
    const imported=test.import({size:Buffer.byteLength(text),text:async()=>text});await flush();
    assert.equal(test.action(0),'replace');assert(Buffer.byteLength(test.requests[0].options.body)<65536);
    test.respond(0,200,{ok:true,games:[game]});await imported.promise;
    assert.equal(imported.target.value,'');assert.equal(test.state().games.length,1);
    console.log('PASS: whitespace-heavy file below 1 MiB can import when compact request fits 64 KiB');
  }
  {
    const test=harness();test.seed();const reading=deferred();
    const imported=test.import({size:100,text:()=>reading.promise});
    const attempt=test.context.performLogout();await finishLogout(test,attempt);
    reading.resolve(JSON.stringify([game]));await imported.promise;
    assert.equal(test.requests.length,2);assert.equal(test.confirms,0);assert.equal(imported.target.value,'');test.assertCleared();
    console.log('PASS: import file resolving after logout cannot confirm/send/restore anything');
  }
  {
    const test=harness();test.seed();test.legacy=[{...game,title:'ł'.repeat(40000)}];test.local.set('synthetic-legacy-key','synthetic-backup');
    await test.context.acceptAuthenticated([game]);
    assert.equal(test.requests.length,0);assert.equal(test.state().games.length,1);
    assert.equal(test.local.get('synthetic-legacy-key'),'synthetic-backup');assert.match(test.notices[0],/64 KiB/);
    assert.equal(test.nodes.appShell.hidden,false);
    console.log('PASS: oversized legacy migration keeps backup and does not block authenticated collection');
  }
  {
    const test=harness();test.seed();
    const read=test.context.apiRequest().catch(error=>error);
    const attempt=test.context.performLogout();await flush();
    test.timers.find(timer=>timer.delay===15000&&!timer.cleared).handler();await attempt;
    assert.equal(test.state().pending,true);assert.equal(test.requests.length,1);
    assert.equal(test.nodes.retryConnection.hidden,false);test.assertCleared();
    test.respond(0,200,{ok:true,games:[game]});await read;
    const retry=test.nodes.retryConnection.onclick();await finishLogout(test,retry);
    console.log('PASS: timeout stays locally locked and a later retry finishes logout');
  }
  {
    const nodes=Object.fromEntries(['authIntro','loginButton','retryConnection','captchaStatus','captchaWidget'].map(id=>[id,{textContent:'',disabled:false,hidden:true,replaceChildren(){}}]));
    let callbacks,removals=0,resets=0;
    const context=vm.createContext({
      $:id=>nodes[id],
      window:{turnstile:{render:(selector,options)=>{callbacks=options;return 'synthetic-widget';},remove(){removals++;},reset(){resets++;}}},
      hasCaptchaChallenge:()=>true,loadTurnstileApi:()=>Promise.resolve(),
      solveAutomaticCaptcha(){throw new Error('Unexpected automatic verification');}
    });
    vm.runInContext('let captchaGeneration=0;let captchaChallenge=null;let captchaSolution=null;let captchaSolvePromise=null;let turnstileWidgetId=null;',context);
    vm.runInContext(
      section('const LANGUAGE_KEY', 'function readLegacyGames()')+
      section('function clearCaptchaWidget()', 'function loadTurnstileApi()')+
      section('function prepareCaptcha(', 'function showLogin()')+
      section('function clearSessionCaptcha()', 'function handleSessionExpired('),context);
    context.prepareCaptcha(challenge);await flush();assert(callbacks);
    context.clearSessionCaptcha();
    nodes.loginButton.disabled=true;nodes.loginButton.textContent='Wylogowywanie…';nodes.captchaStatus.textContent='Synthetic logout status';
    callbacks.callback('synthetic-old-token');callbacks['expired-callback']();callbacks['error-callback']();
    assert.equal(nodes.loginButton.disabled,true);assert.equal(nodes.loginButton.textContent,'Wylogowywanie…');
    assert.equal(nodes.captchaStatus.textContent,'Synthetic logout status');assert.equal(nodes.retryConnection.hidden,true);
    assert.equal(vm.runInContext('captchaSolution',context),null);assert.equal(removals,1);assert.equal(resets,0);
    console.log('PASS: old CAPTCHA callbacks cannot enable login or overwrite logout state');
  }
  console.log('All offline frontend lifecycle checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
