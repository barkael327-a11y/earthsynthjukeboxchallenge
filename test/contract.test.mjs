/**
 * Round-trip and fixture tests for the sonification contract.
 *
 * The point is narrow and important: every bit of the error budget the
 * validators report must come from spectral analysis, not from the mapping.
 * These tests pin the mapping to machine precision so that claim stays true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  F_LOW, F_HIGH, F_ANCHOR, BASELINE, TILT_LIMIT,
  toTilt, toCelsius, partialGains, recover,
  resolutionCelsius, inRange, legend, shortLabel, makeContract,
} from '../src/contract.js';

const SLOPE = 20;

test('the carrier frequencies are fixed and centred on the old anchor', () => {
  assert.equal(F_LOW, 220);
  assert.equal(F_HIGH, 880);
  assert.equal(F_ANCHOR, 440);
  assert.equal(F_HIGH / F_LOW, 4, 'two octaves apart');
  assert.equal(BASELINE, '1951-1980');
});

test('zero anomaly is zero tilt: the partials are equal at the baseline', () => {
  assert.equal(toTilt(0, SLOPE), 0);
  assert.equal(toCelsius(0, SLOPE), 0);
  const g = partialGains(0, SLOPE);
  assert.ok(Math.abs(g.low - g.high) < 1e-15, 'equal gains at 0.00 °C');
});

test('round trip is exact to machine precision over every slope in use', () => {
  let worst = 0;
  for (const slope of [8, 10, 20, 30]) {
    for (let dT = -5; dT <= 5; dT += 0.001) {
      worst = Math.max(worst, Math.abs(toCelsius(toTilt(dT, slope), slope) - dT));
    }
  }
  assert.ok(worst < 1e-12,
    `round-trip error ${worst.toExponential(2)} °C exceeds machine precision; ` +
    `the validators' error budget must come from the FFT, not the mapping`);
});

test('recover() inverts partialGains() exactly, whatever the overall level', () => {
  for (const slope of [8, 20]) {
    for (const dT of [-1.76, -0.4, 0, 0.37, 1.29, 3.2]) {
      for (const reference of [0.01, 0.13, 1, 50]) {
        const { low, high } = partialGains(dT, slope, reference);
        const back = recover(low, high, slope);
        assert.ok(Math.abs(back - dT) < 1e-12,
          `slope ${slope}, level ${reference}: ${dT} came back as ${back}`);
      }
    }
  }
});

test('the measurement is immune to the volume knob, which is the whole point', () => {
  const { low, high } = partialGains(0.83, SLOPE);
  const quiet = recover(low * 0.001, high * 0.001, SLOPE);
  const loud = recover(low * 1000, high * 1000, SLOPE);
  assert.ok(Math.abs(quiet - loud) < 1e-12);
  assert.ok(Math.abs(quiet - 0.83) < 1e-12);
});

test('loudness carries nothing: the split is symmetric about a constant total', () => {
  // If warming simply made everything louder, level would be a second and
  // worse encoding of the same thing. It must not be.
  const cold = partialGains(-1, SLOPE);
  const warm = partialGains(+1, SLOPE);
  const power = (g) => g.low * g.low + g.high * g.high;
  assert.ok(Math.abs(power(cold) - power(warm)) < 1e-12,
    'cold and warm must carry the same total energy');
});

test('slope must be supplied and positive', () => {
  for (const bad of [undefined, null, 0, -1, NaN, Infinity, '20']) {
    assert.throws(() => toTilt(0.5, bad), TypeError);
    assert.throws(() => toCelsius(10, bad), TypeError);
  }
});

test('non-finite inputs throw rather than sound', () => {
  assert.throws(() => toTilt(NaN, SLOPE), TypeError);
  assert.throws(() => toCelsius(undefined, SLOPE), TypeError);
  assert.throws(() => recover(0, 1, SLOPE), RangeError);
  assert.throws(() => recover(1, -1, SLOPE), RangeError);
});

test('measured region ranges stay inside the measurable tilt band', () => {
  // Ranges measured from gistemp1200_GHCNv4_ERSSTv5.nc on 2026-11-11, annual
  // 1880-2025. If a data update pushes a region out of band this fails, and
  // the slope gets revisited deliberately rather than a partial quietly
  // dropping out of measurable range.
  const regions = [
    { id: 'global', slope: 20, min: -0.48, max: 1.29 },
    { id: 'tropics', slope: 20, min: -0.63, max: 1.19 },
    { id: 'n-eurasia', slope: 10, min: -1.20, max: 2.60 },
    { id: 'arctic', slope: 8, min: -1.76, max: 3.20 },
  ];
  for (const r of regions) {
    for (const v of [r.min, r.max]) {
      const tilt = toTilt(v, r.slope);
      assert.ok(inRange(tilt),
        `${r.id} at ${v} °C needs ${tilt.toFixed(1)} dB, outside ` +
        `${TILT_LIMIT.min}..${TILT_LIMIT.max} dB`);
    }
  }
});

test('resolution follows from the slope, and is below the data own uncertainty', () => {
  // GISTEMP annual global uncertainty is around 0.05 °C. The instrument should
  // resolve comfortably better than the thing it is reporting.
  for (const slope of [8, 10, 20]) {
    const res = resolutionCelsius(slope, 0.05);
    assert.ok(res < 0.01, `slope ${slope} resolves only ${res.toFixed(4)} °C`);
  }
  assert.ok(Math.abs(resolutionCelsius(20, 0.05) - 0.0025) < 1e-9);
});

test('legend states the numbers it promises', () => {
  const text = legend(20);
  assert.match(text, /220 Hz/);
  assert.match(text, /880 Hz/);
  assert.match(text, /440 Hz/);
  assert.match(text, /1951-1980/);
  assert.match(text, /20 dB/);
  assert.match(text, /pitches never change/);
  assert.match(text, /volume up or down/);
  assert.match(shortLabel(8), /8 dB/);
});

test('a bound contract agrees with the bare functions exactly', () => {
  const c = makeContract({ slope: 8, label: 'Arctic', id: 'arctic' });
  for (let dT = -2; dT <= 3.3; dT += 0.017) {
    assert.equal(c.toTilt(dT), toTilt(dT, 8));
  }
  assert.equal(c.slope, 8);
  assert.equal(c.fLow, F_LOW);
  assert.equal(c.fHigh, F_HIGH);
  assert.throws(() => { c.slope = 20; },
    'the contract must be frozen so the slope cannot be retuned silently');
});
