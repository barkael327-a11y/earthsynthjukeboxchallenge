/**
 * audio-carrier.js
 *
 * Two sine oscillators at 220 Hz and 880 Hz. Frequencies never change.
 * Only the balance between them shifts, encoding the measurement as spectral tilt.
 *
 * Both are A naturals two octaves apart (geometric mean 440 Hz), so they sit
 * naturally inside the pad's harmonic content rather than reading as test tones.
 *
 * The analyser tap is before the sum's output trim, so the mixer level and
 * reverb send cannot affect the measurement.
 */

/** @typedef {import('./earth-series.js').EarthSeries} EarthSeries */
/** @typedef {import('./regions.js').Region} Region */

// Time for the balance to settle when the step changes.
// Short enough that the tilt is stable for most of the step; long enough to avoid clicks.
const GLIDE = 0.08;
const FADE = 0.04;

// Level each partial carries at the balance point (0 dB tilt).
// High enough for a clean FFT signal; the output trim handles audible level separately.
const REFERENCE_GAIN = 0.13;

// How loud the carrier is in the mix. The tap is upstream of this trim,
// so turning it down doesn't affect the measurement.
const PRESENCE_WITH_PAD = 0.10;
const PRESENCE_ALONE = 1.0;

// Slow amplitude swell so the carrier breathes with the pad.
// Applied to the output trim only, so it cancels in the partial ratio.
const BREATH_HZ = 0.07;
const BREATH_DEPTH = 0.16;

export class CarrierLayer {
  /**
   * @param {AudioContext} ctx
   * @param {{series:EarthSeries, region:Region}} opts
   */
  constructor(ctx, { series, region }) {
    this.ctx = ctx;
    this.series = series;
    this.region = region;

    this.oscLow = ctx.createOscillator();
    this.oscLow.type = 'sine';
    this.oscLow.frequency.value = region.contract.fLow;

    this.oscHigh = ctx.createOscillator();
    this.oscHigh.type = 'sine';
    this.oscHigh.frequency.value = region.contract.fHigh;

    this.gainLow = ctx.createGain();
    this.gainHigh = ctx.createGain();
    this.gainLow.gain.value = 0;
    this.gainHigh.gain.value = 0;

    // Track the most recently scheduled gain values.
    // AudioParam.value reports the current instant; we need what was last
    // scheduled so applyAt() can anchor before each ramp (see applyAt()).
    this._lastLow = 0;
    this._lastHigh = 0;

    // Deliberate encoding error, in the track's units. Zero in normal use; set
    // by the "break the encoder" control so the residual can be seen to catch it.
    this._fault = 0;

    // sum is after the tap; output is after sum. Changing output changes
    // what is heard and nothing that is measured.
    this.sum = ctx.createGain();
    this.sum.gain.value = 1;

    this.output = ctx.createGain();
    this.output.gain.value = PRESENCE_ALONE;

    this.breath = ctx.createOscillator();
    this.breath.frequency.value = BREATH_HZ;
    this.breathDepth = ctx.createGain();
    this.breathDepth.gain.value = PRESENCE_ALONE * BREATH_DEPTH;
    this.breath.connect(this.breathDepth);
    this.breathDepth.connect(this.output.gain);
    this.breath.start();

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0;

    this.oscLow.connect(this.gainLow);
    this.oscHigh.connect(this.gainHigh);
    this.gainLow.connect(this.sum);
    this.gainHigh.connect(this.sum);
    this.sum.connect(this.output);
    // Tap the individual gains, before the sum and every downstream effect.
    this.gainLow.connect(this.analyser);
    this.gainHigh.connect(this.analyser);

    this.oscLow.start();
    this.oscHigh.start();

    this._referenceHeld = false;
    this._padPlaying = false;
  }

  /**
   * Stop and disconnect all nodes.
   * An oscillator left running after a track switch would keep sounding the
   * old value and corrupt the analyser's signal.
   */
  dispose() {
    const now = this.ctx.currentTime;
    for (const g of [this.gainLow, this.gainHigh, this.output]) {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + 0.05);
    }
    for (const o of [this.oscLow, this.oscHigh, this.breath]) {
      try { o.stop(now + 0.06); } catch { /* already stopped */ }
    }
    setTimeout(() => {
      for (const n of [this.oscLow, this.oscHigh, this.breath, this.breathDepth,
                       this.gainLow, this.gainHigh, this.sum, this.output, this.analyser]) {
        try { n.disconnect(); } catch { /* already detached */ }
      }
    }, 120);
  }

  get expectedValue() { return this._expectedValue ?? null; }
  get expectedTilt()  { return this._expectedTilt  ?? null; }

  /** @param {Region} region slope changes with region; frequencies do not */
  setRegion(region) {
    this.region = region;
    const now = this.ctx.currentTime;
    this.oscLow.frequency.setValueAtTime(region.contract.fLow, now);
    this.oscHigh.frequency.setValueAtTime(region.contract.fHigh, now);
  }

  /**
   * The value at the nearest whole step to `index` what is actually sounding,
   * not an interpolation.
   * @param {number} index
   */
  heldSample(index) {
    const clamped = Math.min(Math.max(index, 0), this.series.count - 1);
    return this.series.sampleAt(this.region.id, Math.floor(clamped));
  }

  /**
   * Point the validator at a value that is not coming from the record, so the
   * scale preview is held to the same contract the record is. Pass null when
   * nothing is being claimed.
   * @param {number|null} value
   */
  expectValue(value) {
    this._expectedValue = value;
    this._expectedTilt = value === null ? null : this.region.contract.toTilt(value);
  }

  /**
   * Cancel all scheduled events and re-anchor at the current gain values,
   * then immediately apply the new step.
   * Without the anchor, the next ramp would start from the last scheduled
   * event rather than from now.
   * @param {number} index
   */
  seek(index) {
    const now = this.ctx.currentTime;
    for (const p of [this.gainLow.gain, this.gainHigh.gain]) {
      const held = p.value;
      p.cancelScheduledValues(now);
      p.setValueAtTime(held, now);
    }
    this._lastLow  = this.gainLow.gain.value;
    this._lastHigh = this.gainHigh.gain.value;
    this.applyAt(index, now + FADE);
  }

  /** @param {{index:number, time:number}} vertex scheduled ahead of clock by the timeline */
  scheduleVertex({ index, time }) {
    this.applyAt(index, time);
  }

  /**
   * Schedule the gain balance for `index` to be reached at `when`.
   *
   * linearRampToValueAtTime ramps from the PREVIOUS scheduled event, not from
   * the current instant. So first anchor the ramp at the last scheduled value, then ramp to the new value.
   *
   * @param {number} index
   * @param {number} when audio-context time the new balance should be reached
   */
  applyAt(index, when) {
    const s = this.heldSample(index);

    if (this._referenceHeld) {
      // While the reference tone is held the carrier sounds the balance point,
      // not the step value. Report that so the validator reads correctly.
      this._expectedValue = 0;
      this._expectedTilt  = 0;
      return;
    }

    this._expectedValue = s.value;
    this._expectedTilt  = s.observed ? this.region.contract.toTilt(s.value) : null;

    // Hold the last scheduled value up to `when`, then ramp over GLIDE.
    this.gainLow.gain.setValueAtTime(this._lastLow,   when);
    this.gainHigh.gain.setValueAtTime(this._lastHigh, when);

    if (!s.observed) {
      this.gainLow.gain.linearRampToValueAtTime(0, when + GLIDE);
      this.gainHigh.gain.linearRampToValueAtTime(0, when + GLIDE);
      this._lastLow  = 0;
      this._lastHigh = 0;
      return;
    }

    // The fault is added to what is sounded and deliberately left out of the
    // expectation above, so the two disagree by exactly the injected amount.
    const encoded = s.value + this._fault;
    const { low, high } = this.region.contract.partialGains(encoded, REFERENCE_GAIN);
    this.gainLow.gain.linearRampToValueAtTime(low,   when + GLIDE);
    this.gainHigh.gain.linearRampToValueAtTime(high, when + GLIDE);
    this._lastLow  = low;
    this._lastHigh = high;
  }

  /**
   * Sound a short sequence of values so the ear has something to measure the
   * tilt against before the record starts. The published colour bar tells a
   * sighted listener what the colours mean; this is the same for the tones.
   *
   * It cancels everything scheduled and ends silent, so the caller has to seek
   * afterwards to put the carrier back on the record.
   *
   * @param {number[]} values in the track's own units
   * @param {number} [hold] seconds each value is held
   * @returns {{schedule:{value:number, at:number}[], endsAt:number}}
   */
  playScale(values, hold = 1.1) {
    const now = this.ctx.currentTime;
    for (const p of [this.gainLow.gain, this.gainHigh.gain]) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + FADE);
    }
    this._lastLow = 0;
    this._lastHigh = 0;
    this.expectValue(null);

    const schedule = [];
    let at = now + FADE;
    for (const value of values) {
      const { low, high } = this.region.contract.partialGains(value, REFERENCE_GAIN);
      this.gainLow.gain.setValueAtTime(this._lastLow, at);
      this.gainHigh.gain.setValueAtTime(this._lastHigh, at);
      this.gainLow.gain.linearRampToValueAtTime(low, at + GLIDE);
      this.gainHigh.gain.linearRampToValueAtTime(high, at + GLIDE);
      this._lastLow = low;
      this._lastHigh = high;
      schedule.push({ value, at });
      at += hold;
    }

    this.gainLow.gain.setValueAtTime(this._lastLow, at);
    this.gainHigh.gain.setValueAtTime(this._lastHigh, at);
    this.gainLow.gain.linearRampToValueAtTime(0, at + GLIDE);
    this.gainHigh.gain.linearRampToValueAtTime(0, at + GLIDE);
    this._lastLow = 0;
    this._lastHigh = 0;

    return { schedule, endsAt: at + GLIDE };
  }

  /**
   * Offset what the carrier sounds while leaving what it reports alone, so the
   * sound and the claim disagree on purpose. A residual that does not move under
   * this is not measuring anything.
   * @param {number} amount in the track's units; 0 clears it
   */
  setFault(amount) {
    this._fault = amount;
  }

  /**
   * Hold the balance point (both partials equal) as a timbral reference tone.
   * @param {boolean} on
   */
  reference(on) {
    this._referenceHeld = on;
    const now = this.ctx.currentTime;
    for (const p of [this.gainLow.gain, this.gainHigh.gain]) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
    }
    this._lastLow  = this.gainLow.gain.value;
    this._lastHigh = this.gainHigh.gain.value;
    if (on) {
      this.gainLow.gain.linearRampToValueAtTime(REFERENCE_GAIN, now + FADE);
      this.gainHigh.gain.linearRampToValueAtTime(REFERENCE_GAIN, now + FADE);
      this._lastLow  = REFERENCE_GAIN;
      this._lastHigh = REFERENCE_GAIN;
      this._expectedValue = 0;
      this._expectedTilt  = 0;
    }
  }

  /**
   * @param {boolean} padPlaying adjusts audible presence; tap is upstream, measurement unaffected
   */
  setPresence(padPlaying) {
    const level = padPlaying ? PRESENCE_WITH_PAD : PRESENCE_ALONE;
    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(this.output.gain.value, now);
    this.output.gain.linearRampToValueAtTime(level, now + 0.25);
    this.breathDepth.gain.setTargetAtTime(level * BREATH_DEPTH, now, 0.1);
  }

  /** @param {boolean} on */
  setSimplified(on) {
    this.setPresence(!on && this._padPlaying === true);
  }
}