'use strict';

// Run the production login UI against the real HTML and an offline DOM model.
// Credentials, Turnstile callbacks and API responses below are all synthetic.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {harness,flush,deferred} = require('./frontend-dom.cjs');

const challenge = {provider:'turnstile',siteKey:'synthetic-login-site-key'};
const token = 'synthetic-login-token';
const credentials = {username:'synthetic-user',password:'synthetic-password-only'};
const event = () => ({preventDefault(){}});
const requestBody = (test,index=0) => JSON.parse(test.requests[index].options.body);

function loginHarness(options) {
 const test=harness(options),widgets=[];
 test.context.window.turnstile={
  render(selector,callbacks){widgets.push({selector,callbacks});return 'synthetic-widget-'+widgets.length;},
  remove(){},reset(){}
 };
 test.widgets=widgets;
 test.ready=async()=>{
  test.context.showLogin();test.context.prepareCaptcha(challenge);await flush();
  assert.equal(widgets.at(-1).selector,'#captchaWidget','Use the existing real CAPTCHA mount');
  widgets.at(-1).callbacks.callback(token);
  assert.equal(test.nodes.loginButton.disabled,false);
 };
 return test;
}
function enter(test,password=credentials.password) {
 test.nodes.loginUsername.value=credentials.username;test.nodes.loginPassword.value=password;
}
function toggle(test) {test.fire(test.nodes.toggleLoginPassword,'click');}
function assertMasked(test) {
 assert.equal(test.nodes.loginPassword.type,'password','Password must be masked');
 const button=test.nodes.toggleLoginPassword;
 if(button){
  assert.equal(button.getAttribute('aria-pressed'),'false');
  assert.match(button.getAttribute('aria-label'),/pokaż hasło/i);
 }
}
function assertCleared(test) {assert.equal(test.nodes.loginPassword.value,'');assertMasked(test);}
async function finishLogout(test,attempt,index=0) {
 await flush();assert.equal(requestBody(test,index).action,'logout');
 test.respond(index,200,{ok:true});await flush();
 assert.equal(test.requests[index+1].options.method,'GET');
 test.respond(index+1,401,{ok:false,authRequired:true,captcha:challenge});await attempt;await flush();
 assertCleared(test);assert.equal(test.nodes.loginUsername.value,'');
 assert.equal(test.nodes.appShell.hidden,true);assert.equal(test.nodes.authScreen.hidden,false);
}

async function main() {
 {
  const test=loginHarness();
  assert.equal(test.nodes.loginUsername.value,'','The production login must start with an empty username');
  assert.equal(test.nodes.loginPassword.value,'');assertMasked(test);
  assert.equal(test.nodes.loginPassword.closest('form'),test.nodes.loginForm);
  assert.equal(test.nodes.captchaWidget.closest('form'),test.nodes.loginForm);
  assert.equal(test.nodes.toggleLoginPassword.closest('form'),test.nodes.loginForm);
  assert(test.query('label[for="loginPassword"]'),'Password must retain a visible label');
  assert.equal(test.nodes.toggleLoginPassword.type,'button','Visibility control must not submit the form');
  assert.equal(test.nodes.loginButton.type,'submit');
  enter(test);toggle(test);
  assert.equal(test.nodes.loginPassword.type,'text');assert.equal(test.nodes.loginPassword.value,credentials.password);
  assert.equal(test.nodes.toggleLoginPassword.getAttribute('aria-pressed'),'true');
  assert.match(test.nodes.toggleLoginPassword.getAttribute('aria-label'),/ukryj hasło/i);
  toggle(test);assertMasked(test);assert.equal(test.nodes.loginPassword.value,credentials.password);
  assert.equal(test.requests.length,0,'Showing and hiding a password must stay local');
  console.log('PASS: production login starts empty and an accessible non-submit control only toggles password visibility');
 }
 {
  const test=loginHarness();await test.ready();enter(test);toggle(test);
  const attempt=test.context.submitLogin(event());
  assert.equal(test.requests.length,1);assertCleared(test);
  const body=requestBody(test);
  assert.deepEqual(body,{action:'login',username:credentials.username,password:credentials.password,website:'',captcha:{token}},'Presentation must preserve the real login payload');
  assert.equal(test.requests[0].options.credentials,'same-origin');
  enter(test,'synthetic-value-entered-while-pending');toggle(test);
  test.respond(0,200,{ok:true,games:[]});await attempt;
  assertCleared(test);assert.equal(test.nodes.authScreen.hidden,true);assert.equal(test.nodes.appShell.hidden,false);
  console.log('PASS: a pending and successful login clear and mask the field while sending the original credentials and CAPTCHA');
 }
 for(const withChallenge of [false,true]) {
  const test=loginHarness();await test.ready();enter(test);toggle(test);
  const attempt=test.context.submitLogin(event());assertCleared(test);
  enter(test,'synthetic-value-entered-while-pending');toggle(test);
  test.respond(0,401,{ok:false,error:'Synthetic rejected login',...(withChallenge?{captcha:challenge}:{})});
  await attempt;await flush();assertCleared(test);
  assert.equal(test.nodes.authMessage.textContent,'Synthetic rejected login');
  assert.equal(test.nodes.authScreen.hidden,false);assert.equal(test.nodes.appShell.hidden,true);
  assert.equal(test.requests.length,1,'A rejection must not automatically resend credentials');
  assert.equal(test.widgets.length,withChallenge?2:1);
  if(!withChallenge)assert.equal(test.nodes.retryConnection.hidden,false);
  console.log('PASS: a rejected login clears and masks a retyped password '+(withChallenge?'with a fresh CAPTCHA':'without a fresh CAPTCHA'));
 }
 for(const missing of ['challenge','token']) {
  const test=loginHarness();await test.ready();enter(test);toggle(test);
  vm.runInContext(missing==='challenge'?'captchaChallenge=null;':'captchaSolution=null;',test.context);
  // Exercise the defensive branch even if a provider callback made the button
  // actionable before its challenge/token was invalidated.
  test.nodes.loginButton.disabled=false;
  await test.context.submitLogin(event());assertCleared(test);
  assert.equal(test.requests.length,0,'Missing '+missing+' must prevent transmitting credentials');
  assert(test.nodes.authMessage.textContent);assert.equal(test.nodes.retryConnection.hidden,false);
  console.log('PASS: missing CAPTCHA '+missing+' clears and masks the field without an API request');
 }
 {
  const test=loginHarness();test.seed([]);enter(test);toggle(test);
  const attempt=test.context.performLogout();assertCleared(test);
  assert.equal(test.nodes.loginUsername.value,'');assert.equal(test.nodes.loginForm.hidden,true);
  await finishLogout(test,attempt);
  assert.equal(test.nodes.loginForm.hidden,false);assert.equal(test.widgets.length,1);
  console.log('PASS: logout immediately clears revealed credentials and returns to a masked login after server confirmation');
 }
 {
  const test=loginHarness();test.seed([]);enter(test);toggle(test);
  const attempt=test.context.apiRequest('GET');
  test.respond(0,401,{ok:false,error:'Synthetic expired session',captcha:challenge});
  await assert.rejects(attempt,error=>error.sessionExpired===true);await flush();
  assertCleared(test);assert.equal(test.nodes.loginUsername.value,'');
  assert.equal(test.nodes.authScreen.hidden,false);assert.equal(test.nodes.appShell.hidden,true);
  assert.equal(test.nodes.loginForm.hidden,false);assert.equal(test.widgets.length,1);
  console.log('PASS: an expired session clears and masks credentials through the real API error path');
 }
 {
  const test=loginHarness();await test.ready();enter(test);toggle(test);
  const staleCaptcha=test.widgets[0].callbacks.callback;
  const login=test.context.submitLogin(event());enter(test,'synthetic-late-password');toggle(test);
  const logout=test.context.performLogout();assertCleared(test);await flush();
  assert.equal(test.requests.length,1,'Logout must wait for the older login response');
  test.respond(0,200,{ok:true,games:[{id:'synthetic-late-game',title:'Synthetic late game'}]});
  await login;await flush();assertCleared(test);assert.equal(test.nodes.appShell.hidden,true);
  staleCaptcha('synthetic-obsolete-token');assert.equal(test.nodes.loginButton.disabled,true);
  await finishLogout(test,logout,1);
  assert.equal(test.nodes.grid.textContent,'');assert.equal(test.requests.length,3);
  console.log('PASS: a late login and stale CAPTCHA callback cannot restore private data or revealed credentials after logout');
 }
 {
  const test=loginHarness();await test.ready();const proof=deferred();
  test.context.syntheticPendingProof=proof.promise;
  vm.runInContext("captchaChallenge={provider:'pow',nonce:'synthetic-old-nonce'};captchaSolution=null;captchaSolvePromise=syntheticPendingProof;",test.context);
  enter(test);toggle(test);const oldAttempt=test.context.submitLogin(event());
  const logout=test.context.performLogout();await finishLogout(test,logout);
  test.widgets.at(-1).callbacks.callback(token);enter(test,'synthetic-new-session-password');toggle(test);
  const status=test.nodes.captchaStatus.textContent;
  proof.resolve('synthetic-old-proof');await oldAttempt;
  assert.equal(test.requests.length,2,'An obsolete proof must not send a login request');
  assert.equal(test.nodes.loginPassword.value,'synthetic-new-session-password');assert.equal(test.nodes.loginPassword.type,'text');
  assert.equal(test.nodes.toggleLoginPassword.getAttribute('aria-pressed'),'true');
  assert.equal(test.nodes.loginButton.disabled,false);assert.equal(test.nodes.captchaStatus.textContent,status);
  console.log('PASS: a stale pending verification cannot erase or remask a newer login form');
 }
 {
  const test=loginHarness({prepareDocument(document){document.getElementById('toggleLoginPassword').remove();}});
  assert.equal(test.nodes.toggleLoginPassword,undefined);
  test.context.initializeLoginPresentation();await test.ready();enter(test);
  test.nodes.loginPassword.type='text';
  test.context.setLoginPasswordVisibility(false);assertMasked(test);
  test.context.setLoginPasswordVisibility(true);assert.equal(test.nodes.loginPassword.type,'text');
  const attempt=test.context.submitLogin(event());assertCleared(test);
  test.respond(0,200,{ok:true,games:[]});await attempt;assertCleared(test);
  assert.equal(test.nodes.appShell.hidden,false);assert.equal(test.nodes.authScreen.hidden,true);
  console.log('PASS: new JavaScript initializes and logs in with older HTML lacking the optional visibility control');
 }
 console.log('All offline login presentation checks passed. No network or real credentials used.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
