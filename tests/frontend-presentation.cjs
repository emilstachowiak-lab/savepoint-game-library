'use strict';

// Real frontend code with synthetic DOM/canvas/storage/fetch. No browser,
// network, database, personal data or real credentials are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const {parseMarkup,descendants,hasClass,nodeText,harness,flush}=require('./frontend-dom.cjs');
const tree = parseMarkup(html), all = descendants(tree);
const staticIds = all.filter(node=>node.attrs.id);
assert.equal(new Set(staticIds.map(node=>node.attrs.id)).size,staticIds.length,'HTML IDs must remain unique');
const symbols = new Set(all.filter(node=>node.tag==='symbol').map(node=>node.attrs.id));
assert(symbols.size > 0,'Icons must use the local SVG sprite');
for (const node of all.filter(node=>node.tag==='use')) assert(symbols.has((node.attrs.href ?? '').slice(1)) && node.attrs.href.startsWith('#'),'SVG references must resolve locally');
for (const node of all.filter(node=>node.tag==='symbol').flatMap(descendants)) {
  assert(!['script','foreignobject','iframe','image'].includes(node.tag),'Sprite must contain only passive vector artwork');
  assert(!Object.keys(node.attrs).some(name=>/^on/i.test(name)),'Sprite must not add event handlers');
}
for (const match of source.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g))
  assert(staticIds.some(node=>node.attrs.id===match[1]),'Missing DOM contract #'+match[1]);
assert.match(html,/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/,'Auth/app visibility must honor hidden');
assert.match(html,/--radius\s*:\s*7px\b/,'Classic radius must remain 7px');
assert.match(html,/\.cover-image\s*\{[^}]*object-fit\s*:\s*contain/,'Whole covers must not be cropped');
assert.match(html,/\.cover:{1,2}after\s*\{[^}]*pointer-events\s*:\s*none/,'Cover shine must not intercept clicks');
const deleteDialog = all.find(node=>node.attrs['aria-labelledby']==='deleteDialogTitle');
assert.equal(deleteDialog?.attrs.role,'alertdialog');assert.equal(deleteDialog.attrs['aria-modal'],'true');
for (const id of ['deleteClose','deleteCancelButton','deleteConfirmButton'])
  assert.equal(staticIds.find(node=>node.attrs.id===id)?.attrs.type,'button','Dialog controls must not submit another form');
console.log('PASS: DOM IDs, local SVG references, hidden states, Classic cover/radius/shine and dialog semantics');

const game={id:'synthetic-id',title:'<img src=x onerror=alert(1)> & "quoted"',platform:'PC, PlayStation 5',edition:'Fizyczne i cyfrowe',status:'Ograna',coverUrl:'javascript:alert(1)',createdAt:1};
async function main(){
  {
    const test=harness();test.seed([game]);test.context.render();
    const nodes=descendants(parseMarkup(test.nodes.grid.innerHTML));
    const card=nodes.find(node=>hasClass(node,'game-card')),body=descendants(card);
    assert.equal(nodeText(body.find(node=>hasClass(node,'game-title'))),game.title);
    assert.equal(nodeText(body.find(node=>hasClass(node,'edition-meta'))),game.edition);
    assert.deepEqual(body.filter(node=>hasClass(node,'platform-chip')).map(nodeText),['PC','PlayStation 5']);
    const bottom=body.find(node=>hasClass(node,'card-bottom'));
    assert(descendants(bottom).some(node=>hasClass(node,'card-menu')),'Actions belong in the card footer');
    assert(descendants(bottom).some(node=>hasClass(node,'status')),'Status stays in the card footer');
    assert.equal(nodes.some(node=>['img','script','iframe'].includes(node.tag)),false,'Hostile title/URL must remain inert');
    for(const node of nodes.filter(node=>node.tag==='use'))assert(symbols.has(node.attrs.href.slice(1)));
    for(const name of symbols){
      const markup=test.context.aeroIcon(name.slice('ui-icon-'.length));
      assert(markup.includes('href="#'+name+'"'),'Whitelisted icon should resolve to its local symbol');
    }
    for(const unsafe of ['"><script>synthetic</script>','javascript:alert(1)','../external.svg#x','constructor','__proto__'])
      assert.equal(test.context.aeroIcon(unsafe),'','Unknown icon identifiers must not enter markup');
    console.log('PASS: real card markup preserves escaped data, console chips, footer actions and icon whitelist');
  }
  for(const cancel of ['button','close','escape','backdrop','closeModal']){
    const test=harness();test.seed([game]);
    const pending=test.context.confirmGameDeletion(game);
    assert.equal(test.nodes.deleteModalBackdrop.classList.contains('open'),true);
    assert.equal(test.nodes.deleteGameName.textContent,'„'+game.title+'”');
    assert.equal(test.nodes.deleteGameName.querySelector('img'),null,'User titles must not create markup in the dialog');
    assert.equal(test.nodes.deleteGamePlatforms.textContent,'PC · PlayStation 5');
    assert.equal(test.document.activeElement,test.nodes.deleteCancelButton,'Initial focus must be on Cancel');
    if(cancel==='button')test.nodes.deleteCancelButton.onclick();
    if(cancel==='close')test.nodes.deleteClose.onclick();
    if(cancel==='escape')test.events.keydown({key:'Escape'});
    if(cancel==='backdrop')test.nodes.deleteModalBackdrop.onclick({target:test.nodes.deleteModalBackdrop});
    if(cancel==='closeModal')test.context.closeModal();
    assert.equal(await pending,false);assert.equal(test.requests.length,0);
    assert.equal(test.nodes.deleteModalBackdrop.classList.contains('open'),false);
    assert.equal(test.nodes.deleteGameName.textContent,'');assert.equal(test.nodes.deleteGamePlatforms.textContent,'');
    assert.equal(vm.runInContext('pendingDeleteConfirmation',test.context),null);
    assert.equal(test.document.activeElement,test.nodes.addBtn,'Cancellation restores the originating focus');
  }
  console.log('PASS: Cancel, close, Escape, backdrop and closeModal resolve false and clear private dialog text');
  {
    const test=harness();test.seed([game]);
    const first=test.context.confirmGameDeletion(game),second=test.context.confirmGameDeletion({...game,title:'Synthetic replacement'});
    assert.equal(await first,false,'Opening another confirmation must settle the previous one');
    let prevented=0;
    test.nodes.deleteConfirmButton.focus();test.events.keydown({key:'Tab',preventDefault(){prevented++;}});
    assert.equal(test.document.activeElement,test.nodes.deleteClose);
    test.events.keydown({key:'Tab',shiftKey:true,preventDefault(){prevented++;}});
    assert.equal(test.document.activeElement,test.nodes.deleteConfirmButton);assert.equal(prevented,2);
    test.nodes.deleteConfirmButton.onclick();assert.equal(await second,true);
    test.context.resolveDeleteConfirmation(true);
    assert.equal(test.nodes.deleteGameName.textContent,'');assert.equal(test.requests.length,0);
    console.log('PASS: replacement cancels an old dialog, focus stays inside it, explicit confirmation resolves once');
  }
  {
    const test=harness();test.seed([game]);
    const deletion=test.context.window.deleteGame(game.id);await flush();
    assert.equal(test.requests.length,0,'No delete request before confirmation');
    const logout=test.context.performLogout();
    assert.equal(test.nodes.deleteModalBackdrop.classList.contains('open'),false);
    assert.equal(test.nodes.deleteGameName.textContent,'');assert.equal(test.nodes.deleteGamePlatforms.textContent,'');
    await deletion;await flush();
    assert.equal(test.requests.length,1);assert.equal(JSON.parse(test.requests[0].options.body).action,'logout');
    test.respond(0,200,{ok:true});await flush();
    test.respond(1,401,{ok:false,authRequired:true});await logout;
    assert.equal(test.requests.length,2,'Logout must not issue a stale delete');
    assert.equal(test.nodes.grid.innerHTML,'');assert.equal(test.nodes.appShell.hidden,true);
    console.log('PASS: real logout cancels a pending deletion and clears private dialog data without sending delete');
  }
  console.log('All offline Aero presentation checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
