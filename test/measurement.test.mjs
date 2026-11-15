/**
 * The measurement itself, checked numerically against synthesised audio.
 *
 * This is the closest thing to the offline validator that can run in a
 * terminal: build the exact signal the carrier produces for a known anomaly,
 * take its spectrum the way an AnalyserNode does, run the real
 * `bandPowerDb()` over it, invert through the real contract, and see what
 * comes back.
 *
 * It is not circular. The input is a temperature; the output is a temperature
 * recovered from a spectrum of rendered samples. Nothing in the chain computes
 * the second from the first - if the contract, the gain split or the band
 * summation were wrong, the number would not come back.
 *
 * What it cannot do is prove anything about Web Audio: the oscillators here
 * are a sine function, not an OscillatorNode. That is what `validate.html`
 * and `tools/validate.py` are for, rendering the real graph offline and
 * exporting a WAV. This file proves the maths; those prove the implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { partialGains, toCelsius, F_LOW, F_HIGH } from '../src/contract.js';
import { bandPowerDb, DB_PRECISION } from '../src/validate-live.js';

/** Iterative radix-2 FFT, in place. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * wr - im[i + k + half] * wi;
        const vi = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
      }
    }
  }
}

/** Magnitudes in dB, matching what getFloatFrequencyData returns. */
function spectrumDb(signal) {
  const n = signal.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Blackman, which is the window the Web Audio AnalyserNode applies.
    const w = 0.42
      - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
      + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    re[i] = signal[i] * w;
  }
  fft(re, im);
  const out = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    out[k] = 20 * Math.log10(Math.max(Math.hypot(re[k], im[k]) / n, 1e-20));
  }
  return out;
}

/** The signal the carrier produces for a given anomaly. */
function carrier(dT, slope, { sampleRate, n, noise = 0, seed = 1 }) {
  const { low, high } = partialGains(dT, slope);
  const sig = new Float64Array(n);
  // Arbitrary, unequal phases, as in any real render.
  const p1 = (seed * 2.399963) % (2 * Math.PI);
  const p2 = (seed * 0.76543) % (2 * Math.PI);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    sig[i] = low * Math.sin(2 * Math.PI * F_LOW * t + p1)
      + high * Math.sin(2 * Math.PI * F_HIGH * t + p2);
    if (noise) sig[i] += noise * (Math.sin(i * 12.9898 + seed) * 43758.5453 % 1);
  }
  return sig;
}

/** Recover an anomaly from a rendered buffer, exactly as the live validator does. */
function recoverFrom(signal, slope, sampleRate) {
  const db = spectrumDb(signal);
  const n = signal.length;
  const tilt = bandPowerDb(db, F_HIGH, sampleRate, n) - bandPowerDb(db, F_LOW, sampleRate, n);
  return toCelsius(tilt, slope);
}

const CASES = [-1.76, -1.2, -0.63, -0.48, -0.1, 0, 0.37, 1.0, 1.19, 1.29, 2.6, 3.2];

test('the input anomaly is recovered from the rendered spectrum', async (t) => {
  for (const sampleRate of [44100, 48000]) {
    let worst = 0;
    let worstCase = null;
    for (const slope of [8, 10, 20]) {
      for (const dT of CASES) {
        const sig = carrier(dT, slope, { sampleRate, n: 8192 });
        const err = Math.abs(recoverFrom(sig, slope, sampleRate) - dT);
        if (err > worst) { worst = err; worstCase = `${dT} °C at ${slope} dB/°C`; }
      }
    }
    t.diagnostic(`${sampleRate} Hz: worst ${worst.toExponential(2)} °C (${worstCase})`);
    assert.ok(worst < 0.002,
      `worst recovery error ${worst.toExponential(2)} °C at ${sampleRate} Hz (${worstCase})`);
  }
});

test('recovery is far better than the stated tolerance', () => {
  // The claimed resolution comes from DB_PRECISION; the actual error should sit
  // well inside it, so the published figure is conservative rather than tight.
  const slope = 20;
  const claimed = DB_PRECISION / slope;
  let worst = 0;
  for (const dT of CASES) {
    const sig = carrier(dT, slope, { sampleRate: 48000, n: 8192 });
    worst = Math.max(worst, Math.abs(recoverFrom(sig, slope, 48000) - dT));
  }
  assert.ok(worst < claimed,
    `measured ${worst.toExponential(2)} °C against a claimed ${claimed} °C`);
});

test('neither partial landing on a bin centre introduces a bias', () => {
  // 220 and 880 Hz fall between bins at every ordinary sample rate, and they
  // fall differently, so reading the single nearest bin would put a fixed
  // offset in the ratio. Summing the band is what removes it. If this fails,
  // WINDOW_BINS is too narrow.
  const slope = 20;
  const errors = CASES.map((dT) =>
    recoverFrom(carrier(dT, slope, { sampleRate: 48000, n: 8192 }), slope, 48000) - dT);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  assert.ok(Math.abs(mean) < 1e-4,
    `mean error ${mean.toExponential(2)} °C indicates a scalloping bias`);
});

test('a louder or quieter render recovers the same value', () => {
  const slope = 20;
  const base = carrier(0.83, slope, { sampleRate: 48000, n: 8192 });
  const quiet = Float64Array.from(base, (v) => v * 0.002);
  const loud = Float64Array.from(base, (v) => v * 400);
  const a = recoverFrom(quiet, slope, 48000);
  const b = recoverFrom(loud, slope, 48000);
  // 2e5 of dynamic range between the two renders, through a float32
  // spectrum: agreement to 1e-5 degC is the float noise floor, not a bias.
  assert.ok(Math.abs(a - b) < 1e-5, `${a} vs ${b}`);
  assert.ok(Math.abs(a - 0.83) < 0.002);
});

test('a shorter analysis window still works, so scrubbing stays responsive', () => {
  const slope = 20;
  let worst = 0;
  for (const dT of CASES) {
    const sig = carrier(dT, slope, { sampleRate: 48000, n: 4096 });
    worst = Math.max(worst, Math.abs(recoverFrom(sig, slope, 48000) - dT));
  }
  assert.ok(worst < 0.01, `worst at 4096 points: ${worst.toExponential(2)} °C`);
});
