'use strict';

// A deterministic, offline DOM model for executing the real frontend. It
// implements DOM primitives only; application behavior always comes from app.js.
// Browser QA covers visual layout, clipping and native popup behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {canvasFixture}=require('./frontend-canvas.cjs');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'" }[entity]));
// Parse controlled application markup, rather than implementing a browser's
// complete HTML parser or error-recovery rules.
function parseMarkup(markup) {
  const tree = {tag:'#root',attrs:{},children:[]}, stack = [tree];
  const voidTags = new Set(['img','input','br','hr','meta','link','source','area','base','embed','wbr']);
  for (const token of markup.match(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+/g) ?? []) {
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
  return tree;
}
const descendants = node => typeof node === 'string' ? [] : node.children.flatMap(child => typeof child === 'string' ? [] : [child,...descendants(child)]);
const hasClass = (node,name) => (node.attrs.class ?? '').split(/\s+/).includes(name);
const nodeText = node => !node ? '' : typeof node === 'string' ? node : node.children.map(nodeText).join('');

const escape = value => String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const deferred = () => { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
const flush = async () => { for (let index=0;index<20;index++) await Promise.resolve(); };
function harness(options = {}) {
 const requests=[],timers=[],events={},images=[],imageAssignments=[],reportedValidity=[];
 const windowEvents={};
 const listeners=new Map(),windowListeners=new Map();
 const addListener=(registry,publicEvents,name,handler)=>{const set=registry.get(name)??new Set();set.add(handler);registry.set(name,set);publicEvents[name]=event=>{for(const listener of [...set])listener(event);};};
 const removeListener=(registry,name,handler)=>registry.get(name)?.delete(handler);
 const background=canvasFixture({width:1280,height:720,record:false,...options.backgroundCanvas});
 let document;
 // Support the selector subset exercised by the application tests. This
 // lightweight matcher does not interpret styles or compute element visibility.
 function simpleMatch(element,selector,scope) {
  if(!element || element.nodeType!==1)return false;
  if(selector.includes(':scope')){if(element!==scope)return false;selector=selector.replace(':scope','');}
  if(selector.includes(':checked')){if(!element.checked)return false;selector=selector.replace(':checked','');}
  const attributes=[...selector.matchAll(/\[([^\]=\s]+)(?:\s*=\s*["']?([^\]"']*)["']?)?\]/g)];
  selector=selector.replace(/\[[^\]]*\]/g,'');
  for(const [,name,value] of attributes){if(!element.hasAttribute(name))return false;if(value!==undefined&&element.getAttribute(name)!==value.trim())return false;}
  const tag=selector.match(/^[a-zA-Z][\w-]*|^\*/)?.[0];
  if(tag&&tag!=='*'&&element.tagName.toLowerCase()!==tag.toLowerCase())return false;
  for(const [,id] of selector.matchAll(/#([\w-]+)/g))if(element.id!==id)return false;
  for(const [,name] of selector.matchAll(/\.([\w-]+)/g))if(!element.classList.contains(name))return false;
  return true;
 }
 function matches(element,selector,scope) {
  return selector.split(',').some(part=>{
   const tokens=part.trim().replace(/\s*>\s*/g,' > ').split(/\s+/);let index=tokens.length-1,node=element;
   if(!simpleMatch(node,tokens[index--],scope))return false;
   while(index>=0){if(tokens[index]==='>'){index--;node=node.parentElement;if(!simpleMatch(node,tokens[index--],scope))return false;}
    else{const wanted=tokens[index--];node=node.parentElement;while(node&&!simpleMatch(node,wanted,scope))node=node.parentElement;if(!node)return false;}}
   return true;
  });
 }
 class TextNode {
  constructor(value){this.nodeType=3;this.data=String(value);this.parentElement=null;}
  get textContent(){return this.data;}set textContent(value){this.data=String(value);}
  get isConnected(){return Boolean(this.parentElement?.isConnected);}
  remove(){this.parentElement?.removeChild(this);}
 }
 class Element {
  constructor(tag,attrs={}) {
   this.nodeType=1;
   this.tagName=tag.toUpperCase();
   this.attrs={...attrs};
   this.childNodes=[];
   this.parentElement=null;
   this.listeners={};
   this.style={
    setProperty(name,value) { this[name]=String(value); },
    removeProperty(name) { delete this[name]; }
   };
   this._value=undefined;
   this.checked=Object.hasOwn(attrs,'checked');
   this.disabled=Object.hasOwn(attrs,'disabled');
   this.validationMessage='';
   this.complete=false;
   this.naturalWidth=0;
   this.dataset=new Proxy({}, {
    get:(_,name)=>this.attrs['data-'+String(name).replace(/[A-Z]/g,c=>'-'+c.toLowerCase())],
    set:(_,name,value)=>{
     this.attrs['data-'+String(name).replace(/[A-Z]/g,c=>'-'+c.toLowerCase())]=String(value);
     return true;
    }
   });
   this.classList={
    contains:name=>this.className.split(/\s+/).includes(name),
    add:(...names)=>{
     this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),...names])].join(' ');
    },
    remove:(...names)=>{
     this.className=this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ');
    },
    toggle:(name,force)=>{
     const on=force===undefined?!this.classList.contains(name):force;
     on?this.classList.add(name):this.classList.remove(name);
     return on;
    }
   };
  }
  get children(){return this.childNodes.filter(node=>node.nodeType===1);}
  get firstElementChild(){return this.children[0]??null;}
  get firstChild(){return this.childNodes[0]??null;}
  get id(){return this.attrs.id??'';}set id(value){this.attrs.id=String(value);}
  get className(){return this.attrs.class??'';}set className(value){this.attrs.class=String(value);}
  get name(){return this.attrs.name??'';}set name(value){this.attrs.name=String(value);}
  get type(){return this.attrs.type??(this.tagName==='BUTTON'?'submit':'text');}set type(value){this.attrs.type=String(value);}
  get hidden(){return Object.hasOwn(this.attrs,'hidden');}set hidden(value){value?this.attrs.hidden='':delete this.attrs.hidden;}
  get tabIndex(){return Number(this.attrs.tabindex??0);}set tabIndex(value){this.attrs.tabindex=String(value);}
  get textContent(){return this.childNodes.map(node=>node.textContent).join('');}set textContent(value){this.replaceChildren(new TextNode(value));}
  get innerHTML(){return this.childNodes.map(serialize).join('');}set innerHTML(value){this.replaceChildren(...parseMarkup(String(value)).children.map(build));}
  get value(){if(this._value!==undefined)return this._value;if(this.tagName==='SELECT'){const choices=this.querySelectorAll('option');const option=choices.find(e=>e.hasAttribute('selected'))??choices[0];return option?(option.getAttribute('value')??option.textContent):'';}return this.attrs.value??'';}set value(value){this._value=String(value);}
  get src(){return this.attrs.src??'';}set src(value){this.attrs.src=String(value);imageAssignments.push({element:this,url:String(value)});this.complete=false;this.naturalWidth=0;}
  get href(){return this.attrs.href??'';}set href(value){this.attrs.href=String(value);}
  get currentSrc(){return this.src;}
  get isConnected(){return this===document?.tree || Boolean(this.parentElement?.isConnected);}
  setAttribute(name,value){this.attrs[String(name).toLowerCase()]=String(value);}
  getAttribute(name){return Object.hasOwn(this.attrs,name)?this.attrs[name]:null;}
  hasAttribute(name){return Object.hasOwn(this.attrs,name);}
  removeAttribute(name){delete this.attrs[name];}
  append(...nodes){for(let node of nodes){if(typeof node==='string')node=new TextNode(node);if(node.nodeType===11){this.append(...node.childNodes);continue;}node.remove();node.parentElement=this;this.childNodes.push(node);}}
  appendChild(node){this.append(node);return node;}
  removeChild(node){const index=this.childNodes.indexOf(node);if(index>=0){this.childNodes.splice(index,1);node.parentElement=null;}return node;}
  remove(){this.parentElement?.removeChild(this);}
  replaceChildren(...nodes){for(const child of this.childNodes)child.parentElement=null;this.childNodes=[];this.append(...nodes);}
  contains(node){return node===this||this.childNodes.some(child=>child.nodeType===1&&child.contains(node));}
  querySelectorAll(selector){const candidates=this.children.flatMap(child=>[child,...child.querySelectorAll('*')]);return candidates.filter(node=>matches(node,selector,this));}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  matches(selector){return matches(this,selector,this);}
  closest(selector){let current=this;while(current){if(matches(current,selector,current))return current;current=current.parentElement;}return null;}
  focus(){document.activeElement=this;}
  scrollIntoView(){this.scrolledIntoView=true;}
  setCustomValidity(value){this.validationMessage=String(value);}
  reportValidity(){reportedValidity.push(this);return !this.validationMessage;}
  get validity(){return {valid:!this.validationMessage};}
  addEventListener(name,handler,options={}){(this.listeners[name]??=[]).push({handler,capture:options===true||Boolean(options?.capture)});}
  removeEventListener(name,handler){this.listeners[name]=(this.listeners[name]??[]).filter(item=>item.handler!==handler);}
  dispatchEvent(event){return fire(this,event.type,event);}
  reset(){for(const input of this.querySelectorAll('input, select')){input._value=undefined;input.checked=input.hasAttribute('checked');}}
 }
 function serialize(node){if(node.nodeType===3)return escape(node.textContent);const tag=node.tagName.toLowerCase(),attributes=Object.entries(node.attrs).map(([name,value])=>' '+name+'="'+escape(value)+'"').join('');return '<'+tag+attributes+'>'+(['img','input','br','hr','meta','link'].includes(tag)?'':node.innerHTML+'</'+tag+'>');}
 function build(node){if(typeof node==='string')return new TextNode(node);const element=new Element(node.tag,node.attrs);element.append(...node.children.map(build));return element;}
 document={
  tree:build(parseMarkup(options.markup ?? html)),
  activeElement:null,
  hidden:false,
  getElementById(id) { return this.tree.querySelector('#'+id); },
  querySelector(selector) { return this.tree.querySelector(selector); },
  querySelectorAll(selector) { return this.tree.querySelectorAll(selector); },
  createElement:tag=>tag.toLowerCase()==='canvas'?background.canvas():new Element(tag),
  createTextNode:value=>new TextNode(value),
  createDocumentFragment() {
   const element=new Element('fragment');
   element.nodeType=11;
   return element;
  },
  addEventListener(name,handler) { addListener(listeners,events,name,handler); },
  removeEventListener(name,handler) { removeListener(listeners,name,handler); }
 };
 document.documentElement=document.querySelector('html');
 if(options.prepareDocument)options.prepareDocument(document);
 const nodes=Object.fromEntries(document.querySelectorAll('[id]').map(node=>[node.id,node]));
 document.activeElement=nodes.addBtn;
 document.head=document.querySelector('head');
 nodes.xmbBackground.getContext=()=>background.main.getContext('2d');
 nodes.xmbBackground.getBoundingClientRect=()=>background.main.getBoundingClientRect();
 // Gallery tests count network cover loaders separately from the background's
 // self-contained SVG preparation. Both still execute through real Image use.
 class FakeImage extends Element {
  constructor(){super('img');}
  get src(){return super.src;}
  set src(value){super.src=value;if(!String(value).startsWith('data:')&&!images.includes(this))images.push(this);}
 }
 function fire(target,type,details={}){
  const event={...details,type,target:details.target??target,currentTarget:target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;}};
  const chain=[];for(let current=target;current;current=current.parentElement)chain.push(current);
  const call=(element,capture)=>{event.currentTarget=element;for(const listener of element.listeners[type]??[])if(listener.capture===capture)listener.handler.call(element,event);};
  // Native validity and image events do not bubble; capture handlers still run.
  for(const element of [...chain].reverse()){call(element,true);if(event.stopped)return !event.defaultPrevented;}
  const bubbles=details.bubbles??!['invalid','load','error'].includes(type);
  for(const element of bubbles?chain:[target]){call(element,false);if(typeof element['on'+type]==='function')element['on'+type].call(element,event);if(event.stopped)break;}
  return !event.defaultPrevented;
 }

 const store=new Map(options.localStorageEntries),storage={getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
 const media={matches:true,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}};
 const browserWindow={matchMedia:()=>media};
 const now=()=>options.clock?.wall??Date.now();
 const authAt=Math.floor(now()/1000)-60;
 const metadata=()=>{const serverNow=Math.floor(now()/1000);return {authenticatedAt:authAt,lastActivityAt:serverNow,idleExpiresAt:serverNow+1800,absoluteExpiresAt:authAt+28800,serverNow};};
 class ClockDate extends Date {static now(){return now();}}
 const context=vm.createContext({
  Date:options.clock?ClockDate:Date,
  performance:options.clock?{now:()=>options.clock.mono}:undefined,
  document,
  Image:FakeImage,
  window:browserWindow,
  localStorage:storage,
  sessionStorage:storage,
  innerWidth:1280,
  innerHeight:720,
  devicePixelRatio:1,
  location:{protocol:'https:'},
  matchMedia:()=>media,
  addEventListener(name,handler) { addListener(windowListeners,windowEvents,name,handler); },
  removeEventListener(name,handler) { removeListener(windowListeners,name,handler); },
  requestAnimationFrame() { return 1; },
  cancelAnimationFrame() {},
  setTimeout:(handler,delay)=>{
   const timer={handler,delay,createdAt:now(),cleared:false};
   timers.push(timer);
   return timer;
  },
  clearTimeout(timer) { if(timer)timer.cleared=true; },
  crypto:{randomUUID:()=>'synthetic-new-id'},
  TextEncoder,
  URL,
  confirm() { throw new Error('Deletion must use the Aero dialog'); },
  alert() {},
  fetch:(url,options)=>{
   const request={url,options,...deferred()};
   requests.push(request);
   return request.promise;
  }
 });
 const startup=source.lastIndexOf('\ninitialize();');assert(startup>0,'Expected explicit app bootstrap');vm.runInContext(source.slice(0,startup),context,{filename:'app.js'});
 return {context,nodes,document,requests,timers,events,windowEvents,images,imageAssignments,reportedValidity,fire,metadata,
  seed(games){context.syntheticGames=games;context.syntheticSession=metadata();vm.runInContext('games=syntheticGames;authenticated=false;applySessionMetadata(syntheticSession,sessionClock());authenticated=true;',context);nodes.appShell.hidden=false;nodes.authScreen.hidden=true;},
  respond(index,status,payload){const action=requests[index].options.body?JSON.parse(requests[index].options.body).action:'';if(options.autoSession!==false&&payload?.ok===true&&action!=='logout'&&!Object.hasOwn(payload,'session'))payload={...payload,session:metadata()};requests[index].settled=true;requests[index].resolve({status,ok:status>=200&&status<300,json:async()=>payload});},
  runTimers(delay){const pending=timers.filter(timer=>!timer.cleared&&(delay===undefined||timer.delay===delay));for(const timer of pending){timer.cleared=true;timer.handler();}},
  runDueTimers(){const pending=timers.filter(timer=>!timer.cleared&&timer.createdAt+timer.delay<=now());for(const timer of pending){timer.cleared=true;timer.handler();}},
  query(selector){return document.querySelector(selector);},queryAll(selector){return document.querySelectorAll(selector);}
 };
}
module.exports={source,html,parseMarkup,descendants,hasClass,nodeText,harness,deferred,flush};
