import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadSeries} from '../src/earth-series.js';
import {sampledScale} from '../src/experience-render.js';
const base=new URL('../',import.meta.url);
test('all three shipped layers load verified arrays, physical contracts and published palettes',async()=>{
 const realFetch=globalThis.fetch;
 globalThis.fetch=async path=>{try{return new Response(await readFile(new URL(path,base)));}catch{return new Response('',{status:404});}};
 try{
 const specs=JSON.parse(await readFile(new URL('data/experience-layers.json',base),'utf8'));
 for(const spec of specs){
  const m=JSON.parse(await readFile(new URL(`${spec.path}meta.json`,base),'utf8'));
  const series=await loadSeries({...spec,terms:{units:spec.units,balanceAt:m.contract.balance_at}});
  assert.equal(series.count,90);assert.ok(series.verify().checked>=90);
  const reg=series.region(series.regions.keys().next().value);
  for(let i=0;i<90;i++){const p=series.sampleAt(reg.id,i);if(p.observed){assert.ok(p.value>=m.dataset.colour_bar_range[0]&&p.value<=m.dataset.colour_bar_range[1]);assert.ok(Math.abs(reg.contract.toValue(reg.contract.toTilt(p.value))-p.value)<1e-10);}}
  if(spec.palette){const palette=JSON.parse(await readFile(new URL(spec.palette,base),'utf8'));assert.equal(palette.colors.length,palette.positions.length);assert.ok(palette.positions.every((v,i,a)=>!i||v>=a[i-1]));const scale=sampledScale(palette,spec.units);const rgb=h=>`rgb(${parseInt(h.slice(1,3),16)},${parseInt(h.slice(3,5),16)},${parseInt(h.slice(5,7),16)})`;assert.equal(scale.colourAt(palette.lo),rgb(palette.colors[0]));assert.equal(scale.colourAt(palette.hi),rgb(palette.colors.at(-1)));if(spec.id==='air')assert.equal(palette.kind,'log');}
 }
 }finally{globalThis.fetch=realFetch;}
});
