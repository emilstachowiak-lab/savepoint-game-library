'use strict';

// Offline Canvas2D fixture. Gradients and paths are recorded, while ImageData
// uses real typed arrays so the production ribbon material actually executes.
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');

function canvasFixture(options={}) {
 const canvases=[],events=[],allocations=[];
 const size={width:options.width??320,height:options.height??180};
 function canvas(name='offscreen') {
  let context;
  const element={name,width:300,height:150,style:{},getBoundingClientRect:()=>({...size}),
   getContext(type){
    if(type!=='2d'||options.noContext===name)return null;
    if(options.throwContext===name)throw new Error('Synthetic canvas context failure');
    return context??=makeContext(element);
   }
  };
  canvases.push(element);return element;
 }
 function record(target,name,args=[]) {
  if(options.record===false)return;
  for(const value of args)if(typeof value==='number')assert(Number.isFinite(value),'Canvas coordinates must stay finite: '+name);
  events.push([target.name,name,...args]);
 }
 function makeContext(target) {
  const ctx={canvas:target,frame:null};
  for(const name of ['setTransform','fillRect','beginPath','moveTo','lineTo','arc','closePath','fill','stroke','save','restore','clearRect'])
   ctx[name]=(...args)=>record(target,name,args);
  for(const name of ['fillStyle','strokeStyle','globalCompositeOperation','globalAlpha','lineWidth','filter','shadowBlur','shadowColor']) {
   let value;
   Object.defineProperty(ctx,name,{get:()=>value,set:next=>{value=next;record(target,name,[next]);}});
  }
  for(const name of ['createLinearGradient','createRadialGradient'])ctx[name]=(...points)=>{
   const gradient={kind:name,points,stops:[],addColorStop(offset,color){assert(Number.isFinite(offset));this.stops.push([offset,color]);}};
   record(target,name,points);return gradient;
  };
  ctx.createImageData=(width,height)=>{
   assert(Number.isInteger(width)&&width>0&&Number.isInteger(height)&&height>0,'Canvas material allocations must be positive integers');
   if(options.throwImageData)throw new Error('Synthetic image allocation failure');
   allocations.push({width,height});
   return {width,height,data:new Uint8ClampedArray(width*height*4)};
  };
  ctx.putImageData=(image,x,y)=>{ctx.frame=image;record(target,'putImageData',[image.width,image.height,x,y]);};
  ctx.drawImage=(image,...args)=>{
   if(options.throwDraw)throw new Error('Synthetic drawing failure');
   const frame=image.getContext('2d')?.frame;
   const digest=frame?createHash('sha256').update(frame.data).digest('hex'):null;
   record(target,'drawImage',[image.name,...args,digest]);
  };
  return ctx;
 }
 const main=canvas('main');
 return {main,canvas,canvases,events,allocations,size,
  clear(){events.length=0;},
  snapshot(){return JSON.parse(JSON.stringify(events));},
  imageHashes(){return events.filter(event=>event[1]==='drawImage').map(event=>event.at(-1));}
 };
}

module.exports={canvasFixture};
