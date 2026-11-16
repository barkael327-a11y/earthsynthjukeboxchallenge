import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerSession, sourceIndex } from '../src/layer-session.js';
import { makeContract } from '../src/contract.js';

class Param {
  constructor(value = 0) { this.value = value; }
  cancelScheduledValues() {}
  setValueAtTime(v) {this.value = v;}
  linearRampToValueAtTime(v) {this.value = v;}
  exponentialRampToValueAtTime(v) {this.value = v;}
  setTargetAtTime(v) {this.value = v;}
}
const node = extra => ({connect(){}, disconnect(){}, ...extra});
class Context {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.destination = node(); }
  resume() { return Promise.resolve(); }
  createGain() {return node({gain:new Param(1)});}
  createOscillator() {return node({frequency:new Param(440),detune:new Param(0),start(){},stop(){},setPeriodicWave(){}});}
  createBiquadFilter() {return node({frequency:new Param(350),Q:new Param(1),gain:new Param(0)});}
  createBufferSource() {return node({start(){},stop(){}});}
  createDelay() {return node({delayTime:new Param(0.5)});}
  createStereoPanner() {return node({pan:new Param(0)});}
  createWaveShaper() {return node({});}
  createConvolver() {return node({});}
  createAnalyser() {return node({context:this,frequencyBinCount:4096,getFloatFrequencyData(db){db.fill(-Infinity);db[38]=-20;db[150]=-20;}});}
  createBuffer(ch,len) {return {numberOfChannels:ch,length:len,getChannelData:()=>new Float32Array(len)};}
  createPeriodicWave() {return {};}
}
function series(count=90, kind='geo') {
  const contract=makeContract({slope:1,balanceAt:10,units:'test'});
  const region={id:'global',contract};
  return {count,grid:{kind},axis:{kind:'scan-lat'},regions:new Map([['global',region]]),region:()=>region,
    rangeOf:()=>({min:0,max:30}),labelAt:i=>`row ${i}`,sampleAt:(_,i)=>({observed:i!==3,value:i===3?null:i/3,coverage:0.8})};
}

test('canonical scan selects actual rows without interpolating their values', () => {
  assert.equal(sourceIndex(0,45),0);
  assert.equal(sourceIndex(89,45),44);
  assert.equal(sourceIndex(45.9,90),45);
  assert.equal(sourceIndex(-10,45),0);
  const session=new LayerSession(new Context(),[{id:'ocean',series:series()},{id:'air',series:series(45,'image')}]);
  assert.equal(session.sample(89)[1].index,44);
  assert.equal(session.sample(3)[0].observed,false);
  assert.equal(session.sample(3)[0].validation,null);
  session.dispose();
});

test('isolation and mute preserve per-layer contracts and independent measurement',async()=>{
  const ctx=new Context();
  const session=new LayerSession(ctx,['ocean','air','wind'].map(id=>({id,series:series()})));
  assert.equal(new Set([...session.layers.values()].map(l=>l.carrier.analyser)).size,3);
  assert.equal(session.master.gain.value,0,'session is silent before play');
  await session.play();
  ctx.currentTime=0.4;
  const before=session.sample(0).map(s=>s.validation.residual);
  session.setEnabled(['air']);
  assert.equal(session.layers.get('ocean').gain.gain.value,0);
  assert.equal(session.layers.get('wind').gain.gain.value,0);
  assert.equal(session.layers.get('air').gain.gain.value,0.65);
  session.setMuted(true);
  session.setVolume(0.3);
  assert.equal(session.master.gain.value,0);
  assert.deepEqual(session.sample(0).map(s=>s.validation.residual),before);
  assert.equal(session.layers.get('air').carrier.oscLow.frequency.value,220);
  assert.equal(session.layers.get('air').carrier.oscHigh.frequency.value,880);
  session.setMuted(false);
  assert.equal(session.master.gain.value,0.3);
  session.pause();
  assert.equal(session.master.gain.value,0);
  session.setEnabled([]);
  assert.ok([...session.layers.values()].every(l=>l.gain.gain.value===0));
  assert.throws(()=>session.setEnabled(['missing']),/Unknown layer/);
  session.dispose();
});


test('lookahead expectation cannot corrupt the current-row residual; transitions and pauses are unclaimed', async () => {
  const ctx = new Context();
  const session = new LayerSession(ctx, [{id:'ocean',series:series()},{id:'air',series:series()}]);
  const air = session.layers.get('air');
  let lastExpected;
  air.validator.measure = expected => { lastExpected = expected.expectedValue; return {residual:0}; };
  await session.play();
  assert.equal(session.sample()[1].measurementState,'settling');
  assert.equal(session.sample()[1].validation,null);
  ctx.currentTime = 0.4;
  session.timeline._schedule(); // Schedules row 1 at 0.5, before that row is sounding.
  assert.equal(air.carrier.expectedValue,1/3);
  assert.equal(session.sample()[1].measurementState,'measured');
  assert.equal(lastExpected,0,'expected source is current row 0, not lookahead row 1');
  ctx.currentTime = 0.55;
  assert.equal(session.sample()[1].validation,null,'do not measure a transitional FFT window');
  ctx.currentTime = 0.8;
  assert.equal(session.sample()[1].measurementState,'measured');
  assert.equal(lastExpected,1/3);
  const fault = session.setFault('air',true);
  assert.equal(fault,3);
  assert.equal(air.carrier._fault,3);
  assert.equal(session.layers.get('ocean').carrier._fault,0);
  assert.equal(session.sample()[1].measurementState,'settling');
  session.setFault('air',false);
  assert.equal(air.carrier._fault,0);
  session.pause();
  assert.equal(session.sample()[1].measurementState,'paused');
  assert.equal(session.sample()[1].validation,null);
  session.seek(3);
  assert.equal(session.sample()[1].measurementState,'no-observation');
  assert.equal(session.sample()[1].validation,null);
  session.dispose();
});

test('one quiet shared backdrop does not stack with enabled layers or enter measurement taps',async()=>{
  const ctx=new Context();
  const session=new LayerSession(ctx,['ocean','air','wind'].map(id=>({id,series:series()})));
  assert.ok(session.backdrop);
  assert.ok([...session.layers.values()].every(layer=>!('pad' in layer)), 'no per-layer pads remain');
  assert.equal(session.backdropGain.gain.value,0.22);
  assert.equal(session.backdropFilter,undefined, "original musical timbre is not low-pass filtered");
  for(const layer of session.layers.values()) assert.equal(layer.carrier.output.gain.value,0.1,"ringing trim is reduced after measurement tap");
  assert.equal(session.backdrop.series.sampleAt('global',3).observed,false, 'missing data stays silent');
  await session.play();ctx.currentTime=0.4;
  const before=session.sample().map(s=>s.validation.residual);
  session.setEnabled(['ocean']);
  assert.equal(session.backdropGain.gain.value,0.22);
  session.setEnabled(['ocean','air','wind']);
  assert.equal(session.backdropGain.gain.value,0.22, 'adding layers cannot stack or raise the backdrop');
  session.setMusic(false);
  assert.equal(session.backdropGain.gain.value,0);
  assert.deepEqual(session.sample().map(s=>s.validation.residual),before);
  session.setMusic(true);session.setEnabled([]);
  assert.equal(session.backdropGain.gain.value,0, 'no layers means no backdrop');
  session.dispose();
});
