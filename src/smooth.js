/**
 * smooth.js - a one-pole smoother, ported from CosmicSynth's Smooth.h.
 *
 * The derivative of the anomaly record is noisy: year-to-year differences
 * jump around far more than the trend they sit on, and driving a pulse rate
 * straight from them produces a stutter rather than a tempo. Smoothing is what
 * makes rate-of-change usable, and a smoothed derivative is a different
 * quantity from a derivative, so the window gets published in the legend.
 *
 * The ported part worth keeping is the bug fix. CosmicSynth shipped a version
 * where process() was called once per audio buffer rather than once per
 * sample, so a 30 ms setting behaved like 30 ms x bufferSize - about 14
 * seconds at a 480-sample buffer. The fix was to tell the smoother how much
 * time each call stands for:
 *
 *     a = exp(-n / (tau * rate))
 *
 * EarthSynth hits the same trap from the other direction: these smoothers run
 * once per animation frame or once per scheduled year, not once per sample. So
 * the rate here is "calls per second" and `n` is 1, and the correction is in
 * the constructor rather than bolted on afterwards.
 *
 * @module smooth
 */

export class OnePole {
  /**
   * @param {object} opts
   * @param {number} opts.timeMs  time constant in milliseconds
   * @param {number} opts.callsPerSecond how often process() will be called
   * @param {number} [opts.initial]
   */
  constructor({ timeMs, callsPerSecond, initial = 0 }) {
    this.timeMs = Math.min(Math.max(timeMs, 0.1), 60000);
    this.callsPerSecond = Math.max(callsPerSecond, 1e-6);
    this.z = initial;
    this._update();
  }

  _update() {
    const tau = this.timeMs / 1000;
    this.a = Math.exp(-1 / (tau * this.callsPerSecond));
  }

  /** @param {number} callsPerSecond */
  setRate(callsPerSecond) {
    this.callsPerSecond = Math.max(callsPerSecond, 1e-6);
    this._update();
  }

  /** @param {number} x @returns {number} */
  process(x) {
    this.z = this.a * this.z + (1 - this.a) * x;
    return this.z;
  }

  /** @param {number} [value] */
  reset(value = 0) { this.z = value; }

  get value() { return this.z; }
}
