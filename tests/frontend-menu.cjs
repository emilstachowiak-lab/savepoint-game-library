'use strict';

// Real production disclosure and existing data/session handlers, exercised with
// the offline DOM model. No production account, file or network is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {harness,flush} = require('./frontend-dom.cjs');
const game={id:'menu-test',title:'Synthetic menu game',platform:'PC',edition:'Fizyczne',status:'Do ogrania',coverUrl:'',createdAt:1};
const challenge={provider:'turnstile',siteKey:'synthetic-menu-site-key'};
const ready=()=>{const test=harness();test.seed([game]);return test;};
const click=(test,node)=>test.fire(node,'click');
const open=test=>click(test,test.nodes.appMenuToggle);
const assertClosed=test=>{assert.equal(test.nodes.appMenu.hidden,true);assert.equal(test.nodes.appMenuToggle.getAttribute('aria-expanded'),'false');};
const key=(test,value)=>{let prevented=false;test.events.keydown({key:value,preventDefault(){prevented=true;}});return prevented;};

async function main(){
 {
  const test=ready(),{nodes}=test;
  assertClosed(test);
  assert.equal(nodes.appMenuToggle.getAttribute('aria-controls'),nodes.appMenu.id);
  for(const id of ['importBtn','exportBtn','logoutBtn']){
   assert(nodes.appMenu.contains(nodes[id]),id+' must be inside the disclosure');
   assert.equal(nodes[id].type,'button');
  }
  assert(!nodes.appMenu.closest('form'),'Menu actions must not submit a form');
  open(test);assert.equal(nodes.appMenu.hidden,false);assert.equal(nodes.appMenuToggle.getAttribute('aria-expanded'),'true');
  open(test);assertClosed(test);
  test.context.initializeAppMenu();test.context.initializeAppMenu();open(test);
  assert.equal(nodes.appMenu.hidden,false,'Repeated initialization must not duplicate toggling');
  assert.equal(test.requests.length,0);
  console.log('PASS: original actions are in one initially closed disclosure; toggling and initialization stay local');
 }
 {
  const test=ready(),{nodes}=test;
  nodes.appMenuToggle.focus();assert(key(test,'ArrowDown'));assert.equal(test.document.activeElement,nodes.importBtn);
  assert(key(test,'ArrowUp'));assert.equal(test.document.activeElement,nodes.logoutBtn);
  assert(key(test,'ArrowDown'));assert.equal(test.document.activeElement,nodes.importBtn);
  assert(key(test,'End'));assert.equal(test.document.activeElement,nodes.logoutBtn);
  assert(key(test,'Home'));assert.equal(test.document.activeElement,nodes.importBtn);
  assert(key(test,'Escape'));assertClosed(test);assert.equal(test.document.activeElement,nodes.appMenuToggle);
  assert(!key(test,'Tab'),'Tab remains native');
  nodes.appMenuToggle.focus();key(test,'ArrowUp');assert.equal(test.document.activeElement,nodes.logoutBtn);
  test.fire(nodes.appMenuContainer,'focusout',{relatedTarget:nodes.exportBtn});assert.equal(nodes.appMenu.hidden,false,'Focus inside menu must not close it');
  nodes.search.focus();test.fire(nodes.appMenuContainer,'focusout',{relatedTarget:nodes.search});assertClosed(test);assert.equal(test.document.activeElement,nodes.search,'Tab out must not pull focus back');
  open(test);test.events.click({target:nodes.importBtn});assert.equal(nodes.appMenu.hidden,false);
  test.events.click({target:nodes.hero ?? nodes.search});assertClosed(test);
  assert.equal(test.requests.length,0);
  console.log('PASS: arrow/Home/End/Escape, native Tab, focus exit and outside click preserve intended focus');
 }
 {
  const test=ready(),{nodes}=test;
  const theme=test.query('[data-ui-theme]');
  const motion=test.query('input[data-background-motion]');
  const maze=test.query('select[data-classic-background]');
  const pipes=test.query('select[data-classic3-background]');
  const color=nodes.backgroundColor;
  assert.equal(test.queryAll('[data-ui-theme]').length,1);
  assert.equal(nodes.appMenuTheme.tagName,'DETAILS');
  assert.equal(nodes.themeMenuSummary.tagName,'SUMMARY');
  for(const control of [theme,motion,maze,pipes,color]){
   assert(nodes.appMenuTheme.contains(control),'All appearance settings belong to the Theme category');
   assert(!nodes.authScreen.contains(control),'No appearance setting may remain in login');
  }
  assert.equal(nodes.authScreen.querySelectorAll('[data-ui-theme],[data-background-motion],[data-classic-background],[data-classic3-background],input[type="color"]').length,0);
  open(test);nodes.exportBtn.focus();assert(key(test,'ArrowDown'));
  assert.equal(test.document.activeElement,nodes.themeMenuSummary);
  assert(key(test,'ArrowDown'));assert.equal(test.document.activeElement,nodes.logoutBtn);
  // Native details opening is supplied by the browser; the model expresses
  // its open attribute so the production menu code can be checked independently.
  nodes.appMenuTheme.setAttribute('open','');
  for(const control of [theme,motion,maze,pipes,color]){
   control.focus();
   for(const value of ['ArrowDown','ArrowUp','Home','End']){
    assert(!key(test,value),'Native field keys must not trigger menu navigation');
    assert.equal(test.document.activeElement,control);
   }
   click(test,control);assert.equal(nodes.appMenu.hidden,false);
   test.fire(control,'focusout',{relatedTarget:null});
   assert.equal(nodes.appMenu.hidden,false,'Native popup focus transfers keep the menu open');
  }
  test.context.Event=class Event{constructor(type){this.type=type;}};
  test.document.dispatchEvent=event=>{test.events[event.type]?.(event);return true;};
  test.document.readyState='complete';
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','appearance.js'),'utf8'),test.context);
  const cards=nodes.grid.innerHTML;
  nodes.title.value='Unsaved menu draft';
  for(const option of theme.querySelectorAll('option')){
   theme.value=option.value;test.fire(theme,'change');
   assert.equal(test.document.documentElement.dataset.theme,option.value);
   assert.equal(nodes.appMenu.hidden,false,'Changing a theme must keep its category usable');
   assert(nodes.appMenuTheme.hasAttribute('open'));
   assert.equal(nodes.grid.innerHTML,cards);
   assert.equal(nodes.title.value,'Unsaved menu draft');
  }
  theme.value='aero';test.fire(theme,'change');
  motion.checked=false;test.fire(motion,'change');
  color.value='#8b2fcb';test.fire(color,'input');
  assert.equal(nodes.appMenu.hidden,false);
  assert.equal(test.context.localStorage.getItem('savepoint-background-motion-v1'),'off');
  assert.equal(test.context.localStorage.getItem('savepoint-background-color-v1'),'#8b2fcb');
  const language=test.queryAll('[data-ui-language]')[0];
  language.value='en';test.fire(language,'change');
  assert(nodes.themeMenuSummary.textContent.includes('Theme'));
  assert.equal(test.requests.length,0);
  assert(key(test,'Escape'));assertClosed(test);
  assert.equal(test.document.activeElement,nodes.appMenuToggle);
  console.log('PASS: all theme settings live only in the authenticated category; native keys/popups and all 22 theme changes preserve menu, draft and collection');
 }
 {
  const test=ready();let picked=0;
  test.nodes.importFile.click=()=>{assertClosed(test);picked++;};
  open(test);click(test,test.nodes.importBtn);
  assert.equal(picked,1,'Import must open the existing file picker exactly once in the click stack');assert.equal(test.requests.length,0);
  const allocations=[],revocations=[],downloads=[];
  test.context.Blob=class{constructor(parts,options){this.parts=parts;this.type=options.type;}};
  test.context.URL=class extends URL{
   static createObjectURL(blob){allocations.push(blob);return 'blob:synthetic-menu-export';}
   static revokeObjectURL(url){revocations.push(url);}
  };
  const original=test.document.createElement;
  test.document.createElement=tag=>{const element=original(tag);if(tag==='a')element.click=()=>{assertClosed(test);downloads.push({href:element.href,download:element.download});};return element;};
  open(test);click(test,test.nodes.exportBtn);assertClosed(test);
  assert.equal(allocations.length,1);assert.equal(allocations[0].type,'application/json');
  assert.deepEqual(JSON.parse(allocations[0].parts[0]),[game],'Export keeps the real collection payload');
  assert.deepEqual(downloads,[{href:'blob:synthetic-menu-export',download:'savepoint-kolekcja.json'}]);
  assert.deepEqual(revocations,['blob:synthetic-menu-export']);assert.equal(test.requests.length,0);
  console.log('PASS: capture closes before the unchanged import picker and export download; data and cleanup are preserved');
 }
 {
  const test=ready(),{nodes}=test;
  open(test);test.context.openModal();assertClosed(test);assert(nodes.modalBackdrop.classList.contains('open'));
  test.context.closeModal();open(test);const pending=test.context.confirmGameDeletion(game);assertClosed(test);test.context.resolveDeleteConfirmation(false);await pending;
  open(test);test.context.showLogin();assertClosed(test);assert.equal(test.document.activeElement,nodes.loginUsername,'Login must retain focus in the account field');
  test.context.setAppMenuOpen(true);assertClosed(test);
  test.seed([game]);open(test);test.context.handleSessionExpired({});assertClosed(test);assert.equal(nodes.appShell.hidden,true);
  assert.equal(test.requests.length,0);
  console.log('PASS: modal, deletion, login and session expiry close the disclosure without restoring focus into hidden UI');
 }
 {
  const test=ready(),{nodes}=test;
  test.context.window.turnstile={render(){return 'synthetic-menu-widget';},remove(){},reset(){}};
  open(test);click(test,nodes.logoutBtn);assertClosed(test);await flush();
  assert.equal(nodes.appShell.hidden,true,'Existing immediate privacy lock must remain');
  assert.equal(test.requests.length,1);assert.equal(JSON.parse(test.requests[0].options.body).action,'logout');
  test.respond(0,200,{ok:true});await flush();
  assert.equal(test.requests.length,2);test.respond(1,401,{ok:false,authRequired:true,captcha:challenge});await flush();
  assertClosed(test);assert.equal(nodes.authScreen.hidden,false);assert.equal(nodes.loginUsername.value,'');assert.equal(nodes.loginPassword.value,'');
  console.log('PASS: the menu invokes original logout, clears private state and remains closed after the refreshed login screen');
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
