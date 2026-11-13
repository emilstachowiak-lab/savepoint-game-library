'use strict';

// Execute the production background with deterministic image loading and WAAPI.
// The fixture tests resource/lifecycle contracts; it does not estimate real FPS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {harness:domHarness,flush} = require('./frontend-dom.cjs');
const source = fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const end = source.indexOf('const safeImageUrl');
assert(end > source.indexOf('function initializeXmbBackground()'));

function backgroundHarness(options={}) {
 const events=new Map(), documentEvents=new Map(), pickerEvents=new Map(), mediaEvents=new Map();
 const loaders=[], animations=[], canvases=[], resizers=[], assignments=[];
 const size={width:options.width??1280,height:options.height??720};
 const store=new Map(options.storedColor===undefined?[]:[['savepoint-background-color-v1',options.storedColor]]);
 const add=(map,name,handler)=>{if(!map.has(name))map.set(name,new Set());map.get(name).add(handler);};
 const remove=(map,name,handler)=>map.get(name)?.delete(handler);
 const emit=(map,name,detail={})=>{for(const handler of [...(map.get(name)??[])])handler(detail);};
 class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.nodeType=1;this.style={};this.dataset={};this.attrs={};this.children=[];this.parentElement=null;this.hidden=false;this.isConnected=true;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  removeAttribute(name){delete this.attrs[name];if(name==='src')this._src='';}
  getAttribute(name){return this.attrs[name]??null;}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  appendChild(node){this.append(node);return node;}
  prepend(node){node.remove();node.parentElement=this;this.children.unshift(node);}
  replaceChildren(...nodes){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parentElement){const parent=this.parentElement;parent.children.splice(parent.children.indexOf(this),1);this.parentElement=null;}}
  closest(selector){return selector==='[hidden]'&&(this.hidden||this.parentElement?.closest(selector))?this:null;}
  getBoundingClientRect(){return {...size,left:0,top:0,right:size.width,bottom:size.height};}
  get src(){return this._src??'';}
  set src(value){this._src=String(value);assignments.push({element:this,url:this._src});}
  get textContent(){return '';}
  set textContent(value){this.replaceChildren();}
 }
 if(!options.noAnimation)Element.prototype.animate=function(frames,timing){
  if(options.animateThrows)throw new Error('Synthetic animation failure');
  const animation={element:this,frames,timing,currentTime:0,playState:'running',playbackRate:1,
   play(){this.playState='running';},pause(){this.playState='paused';},cancel(){this.playState='idle';},
   updatePlaybackRate(rate){this.playbackRate=rate;},effect:{setKeyframes(next){animation.frames=next;}}};
  animations.push(animation);return animation;
 };
 const stage=new Element('div'), picker={value:'#0874bc',addEventListener:(n,h)=>add(pickerEvents,n,h),removeEventListener:(n,h)=>remove(pickerEvents,n,h)};
 const body=new Element('body');body.append(stage);
 const media={matches:Boolean(options.reduced),addEventListener:(n,h)=>add(mediaEvents,n,h),removeEventListener:(n,h)=>remove(mediaEvents,n,h),addListener:h=>add(mediaEvents,'change',h),removeListener:h=>remove(mediaEvents,'change',h)};
 const document={hidden:Boolean(options.hidden),body,getElementById:id=>id==='xmbBackground'?(options.noStage?null:stage):id==='backgroundColor'?(options.noPicker?null:picker):null,
  createElement(tag){
   if(options.elementThrows)throw new Error('Synthetic element creation failure');
   if(tag!=='canvas')return new Element(tag);
   const canvas={width:300,height:150,getContext(){canvas.rasterWidth=canvas.width;canvas.rasterHeight=canvas.height;if(options.contextThrows)throw new Error('Synthetic context failure');if(options.noContext)return null;return {drawImage(image){if(options.drawThrows)throw new Error('Synthetic raster failure');canvas.svg=image.src;}};},
    toDataURL(){if(options.dataUrlThrows)throw new Error('Synthetic PNG failure');return 'data:image/png;base64,'+Buffer.from(canvas.svg??'').toString('base64');}};
   canvases.push(canvas);return canvas;
  },addEventListener:(n,h)=>add(documentEvents,n,h),removeEventListener:(n,h)=>remove(documentEvents,n,h)};
 class Loader {
  constructor(){loaders.push(this);}
  set src(value){this._src=value;}get src(){return this._src;}
 }
 class ResizeObserver {
  constructor(callback){this.callback=callback;resizers.push(this);}
  observe(){}disconnect(){this.disconnected=true;}
 }
 const context=vm.createContext({document,Image:Loader,ResizeObserver,matchMedia:()=>media,
  getComputedStyle:element=>({display:element.hidden?'none':'block'}),
  localStorage:{getItem:key=>{if(options.storageThrows)throw new Error('Synthetic storage failure');return store.get(key)??null;},setItem:(key,value)=>{if(options.storageThrows)throw new Error('Synthetic storage failure');store.set(key,value);}},
  addEventListener:(n,h)=>add(events,n,h),removeEventListener:(n,h)=>remove(events,n,h),
  requestAnimationFrame(){throw new Error('Background must not schedule JS frames');},cancelAnimationFrame(){throw new Error('Background must not schedule JS frames');}
 });
 vm.runInContext(source.slice(0,end),context,{filename:'app.js'});
 const controller=vm.runInContext('xmbBackground',context);
 const load=async(items=loaders.filter(loader=>!loader.finished))=>{for(const loader of items){loader.finished=true;loader.onload?.();}await flush();};
 return {context,stage,picker,body,media,store,loaders,animations,canvases,resizers,controller,assignments,load,
  layers:()=>stage.children.flatMap(child=>child.children.length?child.children:[child]).filter(element=>element.tagName==='IMG'),
  visibility(value){document.hidden=value;emit(documentEvents,'visibilitychange');},
  reduce(value){media.matches=value;emit(mediaEvents,'change');},
  color(value){picker.value=value;emit(pickerEvents,'input');},
  resize(width,height){size.width=width;size.height=height;emit(events,'resize');for(const observer of resizers)if(!observer.disconnected)observer.callback([]);},
  pagehide(persisted){emit(events,'pagehide',{persisted});},pageshow(persisted){emit(events,'pageshow',{persisted});},
  listenerCount:()=>[events,documentEvents,pickerEvents,mediaEvents].reduce((count,map)=>count+[...map.values()].reduce((n,set)=>n+set.size,0),0)
 };
}

async function main(){
 {
  const test=backgroundHarness();await test.load();
  assert.equal(test.layers().length,2,'The economical variant uses two visible ribbon surfaces');
  assert.equal(test.animations.length,2);assert.deepEqual(test.animations.map(a=>a.timing.duration),[4800,6000]);
  assert.equal(test.canvases.length,2);assert(test.canvases.every(c=>c.rasterWidth===768&&c.rasterHeight===432),'Image preparation must have a fixed pixel budget');
  assert(test.layers().every(e=>e.src.startsWith('data:image/png;')));
  assert(test.animations.every(a=>a.playState==='running'));
  for(const animation of test.animations){
   assert(animation.frames.length>2);assert.deepEqual(animation.frames[0].transform,animation.frames.at(-1).transform,'The cycle must close without a positional jump');
   assert(animation.frames.every(frame=>Object.keys(frame).every(key=>['offset','transform'].includes(key))),'Only compositor transforms may change each frame');
   const positions=animation.frames.map(frame=>{
    const match=frame.transform.match(/scale\(([^,]+),([^)]+)\) translate3d\(([^%]+)%,([^%]+)%/);
    assert(match,'Expected finite transform geometry');
    return {x:Number(match[1])*768*Number(match[3])/100,y:Number(match[2])*432*Number(match[4])/100};
   });
   const range=key=>Math.max(...positions.map(p=>p[key]))-Math.min(...positions.map(p=>p[key]));
   assert(range('x')>1280*.06&&range('y')>720*.09,'Ribbon displacement must be clearly visible across the viewport');
  }
  console.log('PASS: two bounded PNG layers, approved 4.8/6-second cycles and transform-only motion without JS frame scheduling');
 }
 {
  const test=backgroundHarness();await test.load();test.animations.forEach((a,i)=>a.currentTime=900+i*140);
  test.visibility(true);assert(test.animations.every(a=>a.playState==='paused'));test.visibility(false);assert(test.animations.every(a=>a.playState==='running'));
  assert.deepEqual(test.animations.map(a=>a.currentTime),[900,1040],'Visibility must preserve the paused phase');
  test.reduce(true);assert(test.animations.every(a=>a.playState==='paused'));test.color('#8b2fcb');await test.load();assert(test.animations.every(a=>a.playState==='paused'));
  test.reduce(false);assert(test.animations.every(a=>a.playState==='running'));
  const reduced=backgroundHarness({reduced:true});await reduced.load();assert(reduced.animations.every(a=>a.playState==='paused'));
  const hidden=backgroundHarness({hidden:true});await hidden.load();assert(hidden.animations.every(a=>a.playState==='paused'));
  console.log('PASS: hidden/reduced-motion pause, same-phase resume and color updates while motion is disabled');
 }
 {
  const test=backgroundHarness();await test.load();test.animations.forEach(a=>a.currentTime=1234);
  test.pagehide(true);assert(test.animations.every(a=>a.playState==='paused'));test.pageshow(true);assert(test.animations.every(a=>a.playState==='running'));
  assert(test.animations.every(a=>a.currentTime===1234),'BFCache must preserve phase');
  const count=test.loaders.length;test.pagehide(false);test.pageshow(true);test.color('#ff2200');test.resize(320,640);await test.load();
  assert(test.animations.every(a=>a.playState==='idle'));assert.equal(test.loaders.length,count,'A destroyed page must not restart work');
  console.log('PASS: BFCache pagehide/pageshow pauses and resumes; permanent navigation disposes listeners and animation work');
 }
 {
  const test=backgroundHarness({storedColor:'#8b2fcb'});await test.load();assert.equal(test.picker.value,'#8b2fcb');
  test.color('#cc5511');await test.load();assert.equal(test.store.get('savepoint-background-color-v1'),'#cc5511');
  assert.equal(backgroundHarness({storedColor:'<script>invalid</script>'}).picker.value,'#0874bc');
  const locked=backgroundHarness({storageThrows:true});await locked.load();locked.color('#335577');await locked.load();assert.equal(locked.layers().length,2);
  for(const color of ['#000000','#ffffff','#888888']){
   test.color(color);const pending=test.loaders.filter(e=>!e.finished);await test.load(pending);
   for(const loader of pending){
    const svg=decodeURIComponent(loader.src.slice(loader.src.indexOf(',')+1));
    assert(!/NaN|Infinity/.test(svg),'Neutral colors must have finite color channels');
    assert.match(svg,/hsla\([^,]+,0%,/,'Neutral choices must not introduce a colored tint');
    if(color==='#000000')assert.match(svg,/hsla\([^,]+,0%,0%,/,'Black must retain zero lightness');
   }
  }
  console.log('PASS: stored color, validation, unavailable storage and neutral color choices retain the background');
 }
 {
  const test=backgroundHarness();await test.load();const original=test.layers().map(e=>e.src), background=test.stage.style.background;
  test.color('#cc5511');const stale=test.loaders.filter(e=>!e.finished);test.color('#0874bc');await test.load(stale);
  assert.deepEqual(test.layers().map(e=>e.src),original,'Returning to the rendered color must reject the pending color');
  assert.equal(test.stage.style.background,background,'Gradient and ribbons must retain one committed color');
  test.color('#6622bb');const earlier=test.loaders.filter(e=>!e.finished);test.color('#22aa66');const latest=test.loaders.filter(e=>!e.finished&&!earlier.includes(e));
  await test.load(latest);const winner=test.layers().map(e=>e.src);await test.load(earlier);
  assert.deepEqual(test.layers().map(e=>e.src),winner,'Late loaders must not replace the newest chosen color');
  assert.notDeepEqual(winner,original);
  console.log('PASS: rapid A→B→A changes and out-of-order image loads cannot commit stale colors');
 }
 {
  const test=backgroundHarness();await test.load();test.animations.forEach(a=>a.currentTime=333);const loads=test.loaders.length,rasters=test.canvases.length;
  for(const [width,height] of [[7680,4320],[4320,7680],[320,640],[1280,720]])test.resize(width,height);
  assert.equal(test.loaders.length,loads);assert.equal(test.canvases.length,rasters,'Resizing must reuse prepared images');
  assert.equal(test.animations.length,2,'Resize must not create duplicate animations');assert(test.animations.every(a=>a.currentTime===333));
  assert(test.animations.flatMap(a=>a.frames).every(f=>!f.transform.includes('NaN')&&!f.transform.includes('Infinity')));
  console.log('PASS: desktop/8K/portrait/mobile resize reuses raster images, maintains finite geometry and preserves animation phase');
 }
 {
  const plain=backgroundHarness({noAnimation:true});await plain.load();assert.equal(plain.layers().length,2);assert.equal(plain.animations.length,0);assert(plain.layers().every(e=>e.style.transform));
  for(const options of [{elementThrows:true},{noContext:true},{contextThrows:true},{drawThrows:true},{dataUrlThrows:true},{animateThrows:true}]){
   const test=backgroundHarness(options);await test.load();assert.match(test.stage.style.background,/gradient/,'A rendering failure must leave a color fallback');
   assert(test.animations.every(a=>a.playState!=='running'),'Failure must not leave active animation work');
   const before=test.stage.style.background;test.color('#cc5511');await test.load();assert.notEqual(test.stage.style.background,before,'Fallback must keep the color control');
  }
  const failed=backgroundHarness();for(const loader of failed.loaders){loader.finished=true;loader.onerror?.();}await flush();assert.match(failed.stage.style.background,/gradient/);
  assert(failed.animations.every(a=>a.playState!=='running'));
  assert.equal(backgroundHarness({noStage:true}).controller,null);assert.equal(backgroundHarness({noPicker:true}).controller,null);
  console.log('PASS: no-WAAPI static ribbons and image/context/allocation/animation failure fallback retain color changes');
 }
 {
  const test=backgroundHarness();await test.load();assert(test.listenerCount()>0);test.controller.destroy();test.controller.destroy();assert.equal(test.listenerCount(),0);
  assert(test.resizers.every(r=>r.disconnected));assert(test.animations.every(a=>a.playState==='idle'));assert.equal(test.layers().length,0);
  const during=backgroundHarness();during.controller.destroy();await during.load();assert.equal(during.animations.length,0,'In-flight asset work must not resurrect a destroyed renderer');
  const login=domHarness({prepareDocument(document){const create=document.createElement;document.createElement=tag=>{if(tag==='img')throw new Error('Synthetic background DOM failure');return create(tag);};}});
  login.context.window.turnstile={render(){return 'synthetic-widget';},remove(){}};
  const attempt=login.context.initialize();assert.equal(login.requests.length,1,'Rendering failure must not block authentication initialization');
  login.respond(0,401,{ok:false,authRequired:true,captcha:{provider:'turnstile',siteKey:'synthetic-site-key'}});await attempt;await flush();
  assert.equal(login.nodes.authScreen.hidden,false);assert.equal(login.nodes.loginForm.hidden,false);assert.equal(login.nodes.appShell.hidden,true);
  console.log('PASS: idempotent cleanup, in-flight load cancellation and renderer failure isolation from real login initialization');
 }
 {
  const test=backgroundHarness();await test.load();
  let theme='aero';
  test.context.document.documentElement={getAttribute:name=>name==='data-theme'?theme:null};
  test.animations.forEach(animation=>animation.currentTime=345);
  for(const value of ['luna','classic','classic2','classic3']){
   theme=value;test.controller.refresh();
   assert(test.animations.every(animation=>animation.playState==='paused'),'Inactive Aero must pause under '+value);
  }
  theme='aero';test.controller.refresh();
  assert(test.animations.every(animation=>animation.playState==='running'));
  assert(test.animations.every(animation=>animation.currentTime===345),'Returning to Aero preserves its animation phase');
  console.log('PASS: all other themes pause hidden Aero animation and returning to Aero resumes the same phase');
 }
 console.log('All offline XMB oszczędne background checks passed. No network or real credentials used.');
}

main().catch(error=>{console.error(error);process.exitCode=1;});
