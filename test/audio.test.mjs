/**
 * Scheduling tests, against a Web Audio stub that records every automation
 * event.
 *
 * These cover the part of the build with the least margin for error and the
 * worst failure mode: a mis-scheduled parameter still makes a pleasant noise,
 * so nothing looks broken while the central claim is quietly false. The stub
 * enforces the real API's constraints, so an exponential ramp to zero throws
 * here exactly as it does in a browser.
 */
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

import { loadSeries } from '../src/earth-series.js';
import { CarrierLayer } from '../src/audio-carrier.js';
import { AmbientPad } from '../src/audio-pad.js';
import { Mixer } from '../src/mixer.js';
import { Timeline } from '../src/timeline.js';
import { F_LOW, F_HIGH, recover } from '../src/contract.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// -- the stub --------------------------------------------------------------

class FakeParam {
  constructor(value) { this.value = value; this.events = []; }
  setValueAtTime(v, t) { this._push('set', v, t); return this; }
  linearRampToValueAtTime(v, t) { this._push('linear', v, t); return this; }
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw new RangeError('exponentialRampToValueAtTime: target must be positive');
    this._push('exponential', v, t);
    return this;
  }
  setTargetAtTime(v, t) { this._push('target', v, t); return this; }
  cancelScheduledValues(t) { this.events.push({ type: 'cancel', t }); return this; }
  _push(type, v, t) {
    if (!Number.isFinite(v)) throw new RangeError(`${type}: non-finite value ${v}`);
    if (!Number.isFinite(t)) throw new RangeError(`${type}: non-finite time ${t}`);
    this.events.push({ type, v, t });
    this.value = v;
  }
  /** Events since the last cancel, in order. */
  get live() {
    const i = this.events.map((e) => e.type).lastIndexOf('cancel');
    return this.events.slice(i + 1);
  }
}

const node = (extra = {}) => ({ connect() {}, disconnect() {}, ...extra });

class FakeCtx {
  constructor() {
    this.currentTime = 0; this.sampleRate = 48000;
    this.state = 'running'; this.destination = node();
  }
  createGain() { return node({ gain: new FakeParam(1) }); }
  createOscillator() {
    return node({
      frequency: new FakeParam(440), detune: new FakeParam(0),
      type: 'sine', start() {}, stop() {}, setPeriodicWave() {},
    });
  }
  createBiquadFilter() {
    return node({ frequency: new FakeParam(350), Q: new FakeParam(1), gain: new FakeParam(0), type: 'lowpass' });
  }
  createBufferSource() { return node({ buffer: null, loop: false, start() {}, stop() {} }); }
  createDelay() { return node({ delayTime: new FakeParam(0.5) }); }
  createStereoPanner() { return node({ pan: new FakeParam(0) }); }
  createWaveShaper() { return node({ curve: null, oversample: 'none' }); }
  createConvolver() { return node({ buffer: null, normalize: true }); }
  createAnalyser() {
    return node({
      fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0, context: this,
      getFloatFrequencyData() {},
    });
  }
  createBuffer(ch, len) {
    return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) };
  }
  createPeriodicWave() { return {}; }
}

// -- fixtures --------------------------------------------------------------

// The GISTEMP year-axis payload, no longer shipped (see earth-series.test.mjs)
// but kept as the scheduling fixture: 146 steps and four regions with
// different slopes exercise far more of the scheduler than a still sweep.
const TYPES = { '.json': 'application/json', '.gz': 'application/gzip' };
let cached = null;
async function fixture() {
  if (cached) return cached;
  const server = http.createServer(async (req, res) => {
    try {
      const rel = normalize(decodeURIComponent(req.url)).replace(/^(\.\.[/\\])+/, '');
      const body = await readFile(join(ROOT, rel));
      res.setHeader('Content-Type', TYPES[extname(rel)] ?? 'application/octet-stream');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cached = await loadSeries(`http://127.0.0.1:${server.address().port}/test/fixtures/gistemp/`);
  server.close();
  return cached;
}

async function rig(regionId = 'global') {
  const series = await fixture();
  const ctx = new FakeCtx();
  const region = series.region(regionId);
  const carrier = new CarrierLayer(ctx, { series, region });
  const pad = new AmbientPad(ctx, { series, region, yearSeconds: 0.5 });
  const mixer = new Mixer(ctx, { scientific: carrier.output, musical: pad.output });
  return { series, ctx, region, carrier, pad, mixer };
}

// -- the carrier -----------------------------------------------------------

test('the carrier frequencies never move, for any value or any region', async () => {
  for (const id of ['global', 'arctic', 'tropics', 'n-eurasia']) {
    const { carrier, series } = await rig(id);
    for (const index of [0, 40, 99, 145]) carrier.seek(index);
    for (let i = 1; i < series.count; i++) carrier.scheduleVertex({ index: i, time: i * 0.5 });

    assert.equal(carrier.oscLow.frequency.value, F_LOW, `${id} moved the lower partial`);
    assert.equal(carrier.oscHigh.frequency.value, F_HIGH, `${id} moved the upper partial`);
    for (const p of [carrier.oscLow.frequency, carrier.oscHigh.frequency]) {
      for (const e of p.events) {
        if (e.type === 'cancel') continue;
        assert.ok(e.v === F_LOW || e.v === F_HIGH,
          `a carrier partial was scheduled to ${e.v} Hz; the pitches must be constant`);
      }
    }
  }
});

test('the scheduled balance recovers exactly the published value', async () => {
  const { series, carrier, region } = await rig();
  carrier.seek(0);
  for (let i = 1; i < series.count; i++) carrier.scheduleVertex({ index: i, time: i * 0.5 });

  // applyAt() schedules two events per step: a setValueAtTime anchor at the
  // vertex, holding what the previous step ended on, and a ramp to the new
  // balance one GLIDE later. The ramps carry the published values. The anchors
  // are checked separately below.
  const lows = carrier.gainLow.gain.live.filter((e) => e.type === 'linear');
  const highs = carrier.gainHigh.gain.live.filter((e) => e.type === 'linear');
  assert.equal(lows.length, highs.length);

  let checked = 0;
  for (let k = 0; k < lows.length; k++) {
    if (lows[k].t < 0.4) continue;                 // skip the seek anchor
    const index = Math.round((lows[k].t - 0.08) / 0.5);
    const expected = series.sampleAt('global', index);
    if (!expected.observed) continue;
    const back = recover(lows[k].v, highs[k].v, region.contract.slope);
    assert.ok(Math.abs(back - expected.value) < 1e-12,
      `year index ${index}: the balance encodes ${back} °C but the data says ${expected.value} °C`);
    checked++;
  }
  assert.ok(checked > 140, `expected the whole record to be checked, got ${checked}`);

  // Each anchor must hold exactly what the ramp before it reached. Without
  // that, the next ramp interpolates from a stale value and the balance never
  // settles on any published number - it slides across the whole step.
  const events = carrier.gainLow.gain.live;
  for (let k = 1; k < events.length; k++) {
    if (events[k].type !== 'set') continue;
    const previousRamp = events.slice(0, k).reverse().find((e) => e.type === 'linear');
    if (!previousRamp) continue;
    assert.equal(events[k].v, previousRamp.v,
      `the anchor at ${events[k].t} s does not hold what the ramp before it reached`);
  }
});

test('warming does not simply make the carrier louder', async () => {
  const { series, carrier } = await rig();
  const power = [];
  for (const index of [0, 50, 100, 145]) {
    carrier.seek(index);
    if (!series.sampleAt('global', index).observed) continue;
    const lo = carrier.gainLow.gain.value;
    const hi = carrier.gainHigh.gain.value;
    power.push(lo * lo + hi * hi);
  }
  const spread = Math.max(...power) - Math.min(...power);
  assert.ok(spread < 1e-9,
    'total carrier energy varied across the record; loudness must carry nothing');
});

test('an unobserved year silences both partials', async () => {
  const { series, ctx } = await rig();
  // No region-year in the shipped payload is fully unobserved, so stub one in
  // to exercise the path a sparser dataset will hit.
  const patched = Object.create(series);
  patched.sampleAt = (id, i) => (Math.round(i) === 5
    ? { value: null, observed: false, coverage: 0, year: 1885, interpolated: false }
    : series.sampleAt(id, i));

  const carrier = new CarrierLayer(ctx, { series: patched, region: series.region('global') });
  carrier.seek(0);
  for (let i = 1; i <= 5; i++) carrier.scheduleVertex({ index: i, time: i * 0.5 });

  // The vertex is at 2.5 s; the fade to silence completes one GLIDE later.
  const reachesZero = (p) => p.live.some((e) => e.v === 0 && e.t > 2.5 && e.t < 2.7);
  assert.ok(reachesZero(carrier.gainLow.gain), 'the lower partial should reach zero');
  assert.ok(reachesZero(carrier.gainHigh.gain), 'the upper partial should reach zero');
  // At the gap itself the validator must be told there is nothing to check,
  // rather than being handed the previous year's value.
  assert.equal(carrier.expectedValue, null);
  assert.equal(carrier.expectedTilt, null);
});

test('seeking cancels before it re-anchors', async () => {
  const { carrier } = await rig();
  carrier.seek(0);
  for (let i = 1; i < 10; i++) carrier.scheduleVertex({ index: i, time: i * 0.5 });
  carrier.seek(100);
  for (const p of [carrier.gainLow.gain, carrier.gainHigh.gain]) {
    const at = p.events.map((e) => e.type).lastIndexOf('cancel');
    assert.ok(at >= 0, 'a seek must cancel scheduled values');
    assert.equal(p.events[at + 1].type, 'set',
      'the ramp start must be pinned, or the next ramp interpolates from a stale value');
  }
});

test('the reference holds both partials equal, which is exactly 0.00 °C', async () => {
  const { carrier, region } = await rig();
  carrier.seek(120);
  carrier.reference(true);
  const back = recover(carrier.gainLow.gain.value, carrier.gainHigh.gain.value, region.contract.slope);
  assert.ok(Math.abs(back) < 1e-12, `the reference balance encodes ${back} °C`);
});

test('holding the reference tells the validator the baseline, not the year', async () => {
  // Regression: applyAt() used to set the expectation from the payload before
  // checking the reference, so while the reference was held the carrier sounded
  // 0.00 °C and reported the year's anomaly. The residual then read as the whole
  // anomaly, about 1.2 °C globally, which is 120x tolerance, and painted the
  // headline integrity number red.
  for (const id of ['global', 'arctic']) {
    const { carrier, region } = await rig(id);
    carrier.seek(145);
    assert.ok(Math.abs(carrier.expectedValue) > 0.5, 'precondition: a large anomaly');

    carrier.reference(true);
    assert.equal(carrier.expectedValue, 0, `${id}: expectation while held`);
    assert.equal(carrier.expectedTilt, 0);

    // What is sounding and what is reported must agree, which is what makes
    // the residual meaningful rather than decorative.
    const sounding = recover(carrier.gainLow.gain.value, carrier.gainHigh.gain.value,
      region.contract.slope);
    assert.ok(Math.abs(sounding - carrier.expectedValue) < 1e-12,
      `${id}: sounding ${sounding} but reporting ${carrier.expectedValue}`);

    // A vertex arriving while the reference is held must not overwrite it.
    carrier.scheduleVertex({ index: 100, time: 99 });
    assert.equal(carrier.expectedValue, 0, `${id}: a scheduled vertex leaked through`);
  }
});

test('releasing the reference restores the year being shown', async () => {
  const { carrier } = await rig();
  carrier.seek(145);
  const before = carrier.expectedValue;
  carrier.reference(true);
  carrier.reference(false);
  carrier.seek(145);                 // what app.js does on release
  assert.equal(carrier.expectedValue, before);
});

test('each region keeps the frequencies and changes only the slope', async () => {
  const a = await rig('global');
  const b = await rig('arctic');
  assert.equal(a.region.contract.slope, 20);
  assert.equal(b.region.contract.slope, 8);
  assert.equal(a.region.contract.fLow, b.region.contract.fLow);
  assert.equal(a.region.contract.fHigh, b.region.contract.fHigh);
});

test('trimming the carrier in the mix does not touch what is measured', async () => {
  const { carrier, region } = await rig();
  carrier.seek(100);
  const before = {
    low: carrier.gainLow.gain.value,
    high: carrier.gainHigh.gain.value,
    events: carrier.gainLow.gain.events.length + carrier.gainHigh.gain.events.length,
  };

  carrier.setPresence(true);     // tuck it under the pad
  carrier.setPresence(false);    // and bring it back

  assert.equal(carrier.gainLow.gain.value, before.low);
  assert.equal(carrier.gainHigh.gain.value, before.high);
  assert.equal(
    carrier.gainLow.gain.events.length + carrier.gainHigh.gain.events.length,
    before.events,
    'changing the audible level scheduled something on the measured partials'
  );
  // And the value the analyser would see is unchanged.
  const back = recover(carrier.gainLow.gain.value, carrier.gainHigh.gain.value, region.contract.slope);
  assert.ok(Math.abs(back - carrier.expectedValue) < 1e-12);
});

test('the pad fader cannot move the carrier level', async () => {
  const { mixer } = await rig();
  const before = mixer.scientificGain.gain.events.length;
  mixer.setMix(0); mixer.setMix(0.5); mixer.setMix(1);
  assert.equal(mixer.scientificGain.gain.events.length, before,
    'setMix touched the carrier path; the tap and the audible carrier would diverge');
  assert.equal(mixer.scientificGain.gain.value, 1);
});

test('the scale preview sounds exactly the values it names', async () => {
  const { carrier, region } = await rig();
  const anchors = [-0.4, 0, 1.2];
  const { schedule } = carrier.playScale(anchors, 1);

  assert.equal(schedule.length, anchors.length);
  const lows = carrier.gainLow.gain.live.filter((e) => e.type === 'linear');
  const highs = carrier.gainHigh.gain.live.filter((e) => e.type === 'linear');
  // A ramp to silence first, one per anchor, and one to silence at the end.
  assert.equal(lows.length, anchors.length + 2);

  for (let k = 0; k < anchors.length; k++) {
    const back = recover(lows[k + 1].v, highs[k + 1].v, region.contract.slope);
    assert.ok(Math.abs(back - anchors[k]) < 1e-12,
      `the preview named ${anchors[k]} but sounded ${back}`);
  }

  // It must end silent and claiming nothing, so the caller can seek back onto
  // the record without the validator reading a stale expectation meanwhile.
  assert.equal(lows.at(-1).v, 0);
  assert.equal(highs.at(-1).v, 0);
  assert.equal(carrier.expectedValue, null);
  assert.equal(carrier.expectedTilt, null);
});

test('a deliberate fault moves the sound and not the claim', async () => {
  const { carrier, region } = await rig();
  carrier.seek(100);
  const honest = carrier.expectedValue;
  assert.ok(Number.isFinite(honest), 'precondition: an observed year');

  carrier.setFault(0.75);
  carrier.seek(100);
  assert.equal(carrier.expectedValue, honest,
    'the fault leaked into the expectation, so the residual would stay at zero');
  const faulted = recover(carrier.gainLow.gain.value, carrier.gainHigh.gain.value,
    region.contract.slope);
  assert.ok(Math.abs(faulted - (honest + 0.75)) < 1e-12,
    `the fault should offset the sound by 0.75, got ${faulted - honest}`);

  carrier.setFault(0);
  carrier.seek(100);
  const repaired = recover(carrier.gainLow.gain.value, carrier.gainHigh.gain.value,
    region.contract.slope);
  assert.ok(Math.abs(repaired - honest) < 1e-12, 'repairing did not restore the encoding');
});
// -- the pad ---------------------------------------------------------------

test('every pad pitch comes from the fixed progression, never from the data', async () => {
  const { series, pad } = await rig();
  // Equal temperament, A4 = 440: the notes used by Am7, Fmaj7 and Dm9.
  const allowed = new Set([146.83, 174.61, 220.00, 261.63, 329.63, 392.00]);
  pad.seek(0);
  for (let i = 1; i < series.count; i++) pad.scheduleVertex({ index: i, time: i * 0.5 });

  for (const v of pad.voices) {
    for (const e of v.osc.frequency.events) {
      if (e.type === 'cancel') continue;
      // Each voice detunes its note by one of the two fixed oscillator ratios.
      const base = e.v / v.ratio;
      const match = [...allowed].some((n) => Math.abs(n - base) < 0.02);
      assert.ok(match,
        `a pad voice was tuned to ${e.v.toFixed(2)} Hz, which is not a note of the progression`);
    }
  }
});

test('the pad falls silent across a gap too', async () => {
  const { series, ctx } = await rig();
  const patched = Object.create(series);
  patched.sampleAt = (id, i) => (Math.floor(i) === 5
    ? { value: null, observed: false, coverage: 0, year: 1885, interpolated: false }
    : series.sampleAt(id, i));
  const pad = new AmbientPad(ctx, { series: patched, region: series.region('global'), yearSeconds: 0.5 });
  pad.seek(0);
  for (let i = 1; i <= 8; i++) pad.scheduleVertex({ index: i, time: i * 0.5 });
  const silenced = pad.voices.every((v) => v.gain.gain.live.some((e) => e.v === 0));
  assert.ok(silenced, 'the pad may invent harmony, but not presence where there is no observation');
});

// -- the clock -------------------------------------------------------------

test('the timeline schedules ahead of the clock, never behind it', async () => {
  const series = await fixture();
  const ctx = new FakeCtx();
  const timeline = new Timeline(ctx, { count: series.count, rate: 2, lookahead: 1.2, interval: 1e9 });
  const seen = [];
  const seeks = [];
  timeline.onSchedule((v) => seen.push(v));
  timeline.onSeek((_i, reason) => seeks.push(reason));

  try {
    timeline.play();
    assert.deepEqual(seeks, ['play']);
    assert.equal(seen.length, 2, `expected 2 vertices inside the window, got ${seen.length}`);
    for (const v of seen) {
      assert.ok(v.time >= ctx.currentTime, `vertex ${v.index} was scheduled in the past`);
      assert.ok(v.time <= ctx.currentTime + 1.2 + 1e-9, `vertex ${v.index} went past the lookahead`);
    }

    const narrow = new Timeline(ctx, { count: series.count, rate: 2, lookahead: 0.1, interval: 1e9 });
    let narrowSeen = 0;
    narrow.onSchedule(() => { narrowSeen++; });
    try { narrow.play(); } finally { narrow.dispose(); }
    assert.equal(narrowSeen, 0, 'a narrow lookahead schedules nothing yet, which is correct');

    const before = seen.length;
    ctx.currentTime += 1;
    timeline._schedule();
    assert.ok(seen.length > before);
    for (let i = 1; i < seen.length; i++) {
      assert.equal(seen[i].index, seen[i - 1].index + 1, 'vertices must be consecutive');
      assert.ok(seen[i].time > seen[i - 1].time, 'and monotonic in time');
    }
  } finally { timeline.dispose(); }
});

test('readout and carrier refer to the same year, including after a scrub', async () => {
  const { series, carrier, region } = await rig();
  for (const index of [0, 1, 70, 99, 145, 12.5]) {
    carrier.seek(index);
    const held = carrier.heldSample(index);
    const sounded = recover(carrier.gainLow.gain.value, carrier.gainHigh.gain.value, region.contract.slope);
    assert.equal(Math.round(held.year), series.yearStart + Math.floor(index));
    assert.ok(Math.abs(sounded - held.value) < 1e-12,
      `at index ${index} the balance says ${sounded} but the readout says ${held.value}`);
    assert.ok(Math.abs(carrier.expectedValue - held.value) < 1e-12,
      'the validator is told a different value from the one being sounded');
  }
});

test('seeking out of the final moments resumes scheduling and cancels the stop', async () => {
  // Regression: once the last vertex was scheduled, _schedule() stopped the
  // interval and armed a timer to pause on arrival. A seek backwards left both
  // in place, so playback paused itself a moment later and nothing further was
  // ever scheduled - the carrier would hold one year's tilt while the readout
  // and the globe moved on.
  const series = await fixture();
  const ctx = new FakeCtx();
  const timeline = new Timeline(ctx, { count: series.count, rate: 2, lookahead: 0.2, interval: 20 });
  const seen = [];
  timeline.onSchedule((v) => seen.push(v));
  try {
    timeline.play();
    // Jump to the very end so the scheduler reaches its terminal branch.
    timeline.seek(series.count - 1, 'jump');
    ctx.currentTime += 0.01;
    timeline._schedule();
    assert.equal(timeline._timer, null, 'precondition: the terminal branch ran');
    assert.ok(timeline._endTimer !== null, 'precondition: the stop timer is armed');

    timeline.seek(10, 'scrub');
    assert.equal(timeline._endTimer, null, 'the stop timer must be cancelled');
    assert.ok(timeline._timer !== null, 'the scheduler must be running again');
    assert.equal(timeline.playing, true);

    const before = seen.length;
    ctx.currentTime += 1;
    timeline._schedule();
    assert.ok(seen.length > before, 'vertices must be scheduled again after the seek');
  } finally { timeline.dispose(); }
});

test('the timeline stops at the end rather than running off it', async () => {
  const series = await fixture();
  const ctx = new FakeCtx();
  const timeline = new Timeline(ctx, { count: series.count, rate: 1e6, interval: 1e9 });
  try {
    timeline.play();
    ctx.currentTime += 10;
    assert.equal(timeline.index, series.count - 1);
  } finally { timeline.dispose(); }
});
test('mute silences both layers, preserves volume, and leaves measurement gains intact', () => {
  const mixer = new Mixer(new FakeCtx(), {scientific: node(), musical: node()});
  mixer.setMix(0.6);
  mixer.setMaster(0.7);
  mixer.setMuted(true);
  assert.equal(mixer.master.gain.value, 0);
  assert.equal(mixer.scientificGain.gain.value, 1);
  assert.equal(mixer.musicalGain.gain.value, 0.6);
  mixer.setMaster(0.4);
  assert.equal(mixer.master.gain.value, 0, 'volume adjustment cannot bypass mute');
  mixer.setMuted(false);
  assert.equal(mixer.master.gain.value, 0.4, 'unmute restores the chosen level');
});
