import test from 'node:test';
import assert from 'node:assert/strict';
import { valueTicks, TrendChart } from '../src/trend.js';

test('value ticks fit the rendered height across ocean, air and anomaly ranges', () => {
  for (const height of [72, 95, 114, 184, 300]) {
    for (const [lo, hi] of [[-0.15,28.15],[-0.15,10.15],[-3.15,3.15],[0,0.003],[0,1e8]]) {
      const {ticks, step} = valueTicks(lo, hi, height);
      assert.ok(ticks.length <= 5);
      assert.ok(ticks.length >= 1);
      assert.ok(ticks.every(v => v >= lo && v <= hi));
      if (ticks.length > 1) assert.ok(step / (hi-lo) * height >= 28);
    }
  }
});

test('rendered latitude chart uses track axis labels, not hardcoded years', () => {
  globalThis.window = {devicePixelRatio: 1};
  const labels = [];
  const g = new Proxy({
    measureText(text) {return {width: text.length*6};},
    fillText(text,x,y) { labels.push({text,x,y}); },
  }, {get(target,key) {return key in target ? target[key] : ()=>{};}});
  const canvas = {getContext:()=>g,getBoundingClientRect:()=>({width:320,height:150}),addEventListener(){}};
  const series = {count:90,rangeOf:()=>({min:1.3,max:28}),labelAt:i=>`${89-i*2}°`,sampleAt:()=>({observed:false,value:0})};
  const chart = new TrendChart(canvas, series);
  chart.scale = {kind:'sequential',units:'°C',colourAt:()=> '#123456'};
  chart.draw(0);
  const yLabels = labels.filter(d=>d.x === chart.plot.x - 8);
  assert.ok(yLabels.length <= 5);
  for (let i=1;i<yLabels.length;i++) assert.ok(Math.abs(yLabels[i].y-yLabels[i-1].y)>=28);
  assert.ok(labels.some(d=>d.text==='89°'));
  assert.ok(labels.some(d=>d.text==='-89°'));
  assert.ok(labels.some(d=>d.text==='°C'));
  assert.ok(!labels.some(d=>d.text==='1880'));
});
