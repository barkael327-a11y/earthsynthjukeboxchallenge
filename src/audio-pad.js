/**
 * audio-pad.js - the ambient pad.
 *
 * Modelled on a Kilohearts Phase Plant patch: two detuned analog saws per note,
 * hard unison across three voices each, a slow attack into a long decay and a
 * low sustain, two filters in series, an overdrive stage, a quiet noise bed,
 * two tempo-synced delays at 5/16 and 7/16, and reverb.
 *
 * The pitches never move with the data. They are ordinary notes on an ordinary
 * keyboard, and the chord progression runs on a musical clock - four bars each,
 * regardless of what the record is doing. Nothing about which notes sound
 * encodes anything. A pad whose pitch is hostage to a measurement always sounds
 * unsettled.
 *
 * Every chord in every progression contains an A, so the 220 Hz and 880 Hz
 * carrier partials are consonant throughout and sit inside the harmony rather
 * than on top of it.
 *
 * What the data does drive here, all of it presentation and none of it the
 * measurement:
 *
 *   brightness      the lowpass follows the anomaly, a musical mirror of the
 *                   tilt the carrier is encoding. A knob, not an observable,
 *                   which is exactly why the contract isn't defined on it.
 *   reverb size     crossfades from a tight room to a long hall as observed
 *                   coverage falls, so the sparse early record sounds distant
 *                   and the modern record sounds present.
 *   delay feedback  grows with the smoothed year-on-year change, so echoes pile
 *                   up as warming accelerates.
 *
 * What it invents, repeated in the interface and the README: the chords, the
 * voicing, the detune, the envelopes, the overdrive curve, the delay divisions,
 * the reverb, the noise bed, and the smoothing window.
 *
 * @module audio-pad
 */

import { OnePole } from './smooth.js';

/** 60 BPM, so a sixteenth is 250 ms and the delays land at 1.25 s and 1.75 s. */
const BPM = 60;
const SIXTEENTH = 60 / BPM / 4;

/**
 * The progressions. Four chords each, held four bars each.
 *
 * Every chord in every progression contains an A, because the carrier partials
 * sit at 220 Hz and 880 Hz and both are A naturals. A progression in E minor or
 * C major would leave the carrier hanging outside the harmony: nothing
 * measurable would change, but it would sound wrong.
 *
 * Frequencies in hertz, equal temperament, A4 = 440.
 */
export const PROGRESSIONS = {
  'a-minor': {
    label: 'A minor',
    chords: [
      { name: 'Am7',   notes: [220.00, 261.63, 329.63, 392.00] },   // A3 C4 E4 G4
      { name: 'Fmaj7', notes: [174.61, 220.00, 261.63, 329.63] },   // F3 A3 C4 E4
      { name: 'Dm9',   notes: [146.83, 174.61, 220.00, 329.63] },   // D3 F3 A3 E4
      { name: 'Fmaj7', notes: [174.61, 220.00, 261.63, 329.63] },
    ],
  },
  'a-dorian': {
    label: 'A Dorian',
    chords: [
      { name: 'Am7', notes: [220.00, 261.63, 329.63, 392.00] },     // A3 C4 E4 G4
      { name: 'D7',  notes: [146.83, 185.00, 220.00, 261.63] },     // D3 F#3 A3 C4
      { name: 'Am7', notes: [220.00, 261.63, 329.63, 392.00] },
      { name: 'Bm7', notes: [246.94, 293.66, 369.99, 440.00] },     // B3 D4 F#4 A4
    ],
  },
  'd-minor': {
    label: 'D minor',
    chords: [
      { name: 'Dm7',   notes: [146.83, 174.61, 220.00, 261.63] },   // D3 F3 A3 C4
      { name: 'Gm9',   notes: [196.00, 233.08, 293.66, 440.00] },   // G3 Bb3 D4 A4
      { name: 'Fmaj7', notes: [174.61, 220.00, 261.63, 329.63] },   // F3 A3 C4 E4
      { name: 'Am7',   notes: [220.00, 261.63, 329.63, 392.00] },   // A3 C4 E4 G4
    ],
  },
  'f-major': {
    label: 'F major',
    chords: [
      { name: 'Fmaj7', notes: [174.61, 220.00, 261.63, 329.63] },   // F3 A3 C4 E4
      { name: 'Am7',   notes: [220.00, 261.63, 329.63, 392.00] },   // A3 C4 E4 G4
      { name: 'Dm9',   notes: [146.83, 174.61, 220.00, 329.63] },   // D3 F3 A3 E4
      { name: 'Gm9',   notes: [196.00, 233.08, 293.66, 440.00] },   // G3 Bb3 D4 A4
    ],
  },
  'a-major': {
    label: 'A major',
    chords: [
      { name: 'Amaj7',  notes: [220.00, 277.18, 329.63, 415.30] },  // A3 C#4 E4 G#4
      { name: 'F#m7',   notes: [185.00, 220.00, 277.18, 329.63] },  // F#3 A3 C#4 E4
      { name: 'Dadd9',  notes: [146.83, 185.00, 220.00, 329.63] },  // D3 F#3 A3 E4
      { name: 'E7sus4', notes: [164.81, 220.00, 246.94, 293.66] },  // E3 A3 B3 D4
    ],
  },
};

export const DEFAULT_PROGRESSION = 'a-minor';

const BARS_PER_CHORD = 4;
const CHORD_SECONDS = (BARS_PER_CHORD * 4 * 60) / BPM;   // 16 s at 60 BPM

/** Two saws per note, at the harmonic ratios from the patch. */
const OSCILLATORS = [
  { ratio: 1.005, level: 1.00 },
  { ratio: 0.998, level: 0.60 },
];
/** Hard unison, three voices, detuned in cents. */
const UNISON = [-11, 0, 11];

const VOICE_LEVEL = 0.042;
const NOISE_LEVEL = 0.022;
const ATTACK = 0.99;
const SMOOTHING_MS = 4000;

export class AmbientPad {
  /**
   * @param {AudioContext} ctx
   * @param {{series:import('./earth-series.js').EarthSeries, region:import('./regions.js').Region, yearSeconds?:number}} opts
   */
  constructor(ctx, { series, region, yearSeconds = 0.5 }) {
    this.ctx = ctx;
    this.series = series;
    this.yearSeconds = yearSeconds;
    this.smoother = new OnePole({ timeMs: SMOOTHING_MS, callsPerSecond: 1 / yearSeconds });
    this.chordIndex = -1;
    this.progression = PROGRESSIONS[DEFAULT_PROGRESSION];
    this.setRegion(region);

    this.output = ctx.createGain();
    this.output.gain.value = 1;

    // -- the two filters, in series -------------------------------------
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 700;
    this.lowpass.Q.value = 0.9;

    this.body = ctx.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = 260;
    this.body.Q.value = 0.8;
    this.body.gain.value = 3;

    // -- overdrive -------------------------------------------------------
    this.drive = ctx.createWaveShaper();
    this.drive.curve = softClip(2.2);
    this.drive.oversample = '2x';

    this.preDrive = ctx.createGain();
    this.preDrive.gain.value = 0.9;

    // -- the voices ------------------------------------------------------
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1;
    /** @type {{osc:OscillatorNode, gain:GainNode, ratio:number, level:number, cents:number}[]} */
    this.voices = [];
    for (let n = 0; n < 4; n++) {
      for (const spec of OSCILLATORS) {
        for (const cents of UNISON) {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          // Start on a chord tone of the first chord, so every frequency this
          // oscillator ever holds - including the value a seek pins it at
          // before re-voicing - is a note of the progression.
          osc.frequency.value = this.progression.chords[0].notes[n] * spec.ratio;
          osc.detune.value = cents;
          const gain = ctx.createGain();
          gain.gain.value = 0;
          osc.connect(gain);
          gain.connect(this.voiceBus);
          osc.start();
          this.voices.push({ osc, gain, ratio: spec.ratio, level: spec.level, cents, note: n });
        }
      }
    }

    // -- the noise bed ---------------------------------------------------
    this.noise = ctx.createBufferSource();
    this.noise.buffer = noiseBuffer(ctx, 3);
    this.noise.loop = true;
    this.noiseBand = ctx.createBiquadFilter();
    this.noiseBand.type = 'bandpass';
    this.noiseBand.frequency.value = 1400;
    this.noiseBand.Q.value = 1.1;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = NOISE_LEVEL;
    this.noise.connect(this.noiseBand);
    this.noiseBand.connect(this.noiseGain);
    this.noiseGain.connect(this.voiceBus);
    this.noise.start();

    this.voiceBus.connect(this.preDrive);
    this.preDrive.connect(this.drive);
    this.drive.connect(this.body);
    this.body.connect(this.lowpass);

    // -- delays, 5/16 and 7/16 ------------------------------------------
    this.delayA = makeDelay(ctx, 5 * SIXTEENTH, 2200, -0.5);
    this.delayB = makeDelay(ctx, 7 * SIXTEENTH, 1500, 0.5);
    this.lowpass.connect(this.delayA.input);
    this.lowpass.connect(this.delayB.input);

    // -- reverb: two sizes, crossfaded by coverage ------------------------
    this.dry = ctx.createGain();
    this.dry.gain.value = 0.62;
    this.roomSend = ctx.createGain();
    this.roomSend.gain.value = 0.5;
    this.hallSend = ctx.createGain();
    this.hallSend.gain.value = 0.0;

    this.room = ctx.createConvolver();
    this.room.buffer = impulse(ctx, 1.4, 2.6);
    this.hall = ctx.createConvolver();
    this.hall.buffer = impulse(ctx, 5.5, 1.5);

    for (const src of [this.lowpass, this.delayA.output, this.delayB.output]) {
      src.connect(this.dry);
      src.connect(this.roomSend);
      src.connect(this.hallSend);
    }
    this.roomSend.connect(this.room);
    this.hallSend.connect(this.hall);
    this.dry.connect(this.output);
    this.room.connect(this.output);
    this.hall.connect(this.output);
  }

  /**
   * Fade out and release every node. Called when the jukebox changes track;
   * twenty-four sawtooth oscillators left running would go on playing the old
   * track's chords under the new one.
   */
  dispose() {
    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(this.output.gain.value, now);
    this.output.gain.linearRampToValueAtTime(0, now + 0.25);
    for (const v of this.voices) {
      try { v.osc.stop(now + 0.3); } catch { /* already stopped */ }
    }
    try { this.noise.stop(now + 0.3); } catch { /* already stopped */ }
    setTimeout(() => {
      for (const v of this.voices) { try { v.osc.disconnect(); v.gain.disconnect(); } catch { /**/ } }
      for (const n of [this.noise, this.noiseBand, this.noiseGain, this.voiceBus,
                       this.preDrive, this.drive, this.body, this.lowpass,
                       this.dry, this.roomSend, this.hallSend, this.room, this.hall,
                       this.output]) {
        try { n?.disconnect(); } catch { /* already detached */ }
      }
      this.voices = [];
    }, 400);
  }

  /** @param {import('./regions.js').Region} region */
  setRegion(region) {
    this.region = region;
    const r = this.series.rangeOf(region.id);
    this.min = r.min;
    this.max = r.max;
    this.smoother.reset(0);
  }

  /**
   * Switch key. Safe to call mid-playback: the pitches carry nothing, so the
   * residual is unaffected. Clearing chordIndex forces a re-voice on the next
   * scheduled step.
   * @param {keyof typeof PROGRESSIONS} id
   */
  setProgression(id) {
    const next = PROGRESSIONS[id];
    if (!next) throw new Error(`unknown progression "${id}"`);
    this.progression = next;
    this.chordIndex = -1;
    return next;
  }

  /** @param {number} seconds */
  setYearSeconds(seconds) {
    this.yearSeconds = Math.max(seconds, 0.05);
    this.smoother.setRate(1 / this.yearSeconds);
  }

  /** Where a value sits in the record's range, 0-1. Presentation only. */
  _normalised(v) {
    return this.max === this.min ? 0.5
      : Math.min(Math.max((v - this.min) / (this.max - this.min), 0), 1);
  }

  /** Which chord a playhead position falls on. Musical clock, not the data. */
  _chordAt(index) {
    const elapsed = index * this.yearSeconds;
    return Math.floor(elapsed / CHORD_SECONDS) % this.progression.chords.length;
  }

  /** @param {number} index */
  _derivative(index) {
    const here = this.series.sampleAt(this.region.id, index);
    const prev = this.series.sampleAt(this.region.id, Math.max(index - 1, 0));
    return here.observed && prev.observed ? here.value - prev.value : 0;
  }

  /** @param {number} index */
  seek(index) {
    const now = this.ctx.currentTime;
    const params = [
      this.lowpass.frequency, this.dry.gain, this.roomSend.gain, this.hallSend.gain,
      this.delayA.feedback.gain, this.delayB.feedback.gain, this.noiseGain.gain,
      ...this.voices.flatMap((v) => [v.osc.frequency, v.gain.gain]),
    ];
    for (const p of params) {
      const held = p.value;
      p.cancelScheduledValues(now);
      p.setValueAtTime(held, now);
    }
    this.chordIndex = -1;                       // force a re-voice
    this.smoother.reset(this._derivative(Math.floor(index)));
    this._applyAt(Math.floor(index), now + 0.05, true);
  }

  /** @param {{index:number, time:number}} vertex */
  scheduleVertex({ index, time }) {
    this._applyAt(index, time, false);
  }

  /**
   * @param {number} index
   * @param {number} when
   * @param {boolean} immediate true when re-anchoring after a seek
   */
  _applyAt(index, when, immediate) {
    const s = this.series.sampleAt(this.region.id, Math.floor(index));
    const slope = this.smoother.process(this._derivative(Math.floor(index)));

    // -- chord: a musical clock, nothing to do with the values ------------
    const chord = this._chordAt(index);
    if (chord !== this.chordIndex) {
      this.chordIndex = chord;
      this._voice(this.progression.chords[chord].notes, when, immediate, s.observed);
    } else if (s.observed) {
      // Hold the sustain level; a gap may have muted the voices.
      for (const v of this.voices) {
        v.gain.gain.linearRampToValueAtTime(VOICE_LEVEL * v.level, when + this.yearSeconds);
      }
    }

    if (!s.observed || s.value === null) {
      // The music falls silent across a gap too. It may invent harmony; it may
      // not invent presence where there is no observation.
      for (const v of this.voices) v.gain.gain.linearRampToValueAtTime(0, when + 0.2);
      this.noiseGain.gain.linearRampToValueAtTime(0, when + 0.2);
      return;
    }
    this.noiseGain.gain.linearRampToValueAtTime(NOISE_LEVEL, when + 0.4);

    const warmth = this._normalised(s.value);
    const glide = Math.max(this.yearSeconds * 0.9, 0.2);

    // -- brightness mirrors the anomaly -----------------------------------
    this.lowpass.frequency.linearRampToValueAtTime(420 + 3400 * warmth, when + glide);
    this.body.gain.linearRampToValueAtTime(4 - 2.5 * warmth, when + glide);

    // reverb size from coverage
    const unobserved = Math.min(Math.max(1 - s.coverage, 0), 1);
    this.roomSend.gain.linearRampToValueAtTime(0.5 * (1 - unobserved), when + glide);
    this.hallSend.gain.linearRampToValueAtTime(0.18 + 0.52 * unobserved, when + glide);
    this.dry.gain.linearRampToValueAtTime(0.62 - 0.22 * unobserved, when + glide);

    // -- delay feedback from the smoothed rate of change -------------------
    const drive = Math.min(Math.max(slope / 0.02, 0), 1);
    this.delayA.feedback.gain.linearRampToValueAtTime(0.22 + 0.42 * drive, when + glide);
    this.delayB.feedback.gain.linearRampToValueAtTime(0.18 + 0.38 * drive, when + glide);
  }

  /**
   * Retune to a chord. The pitch change happens while the voices are dipped, so
   * no glide is audible: the notes step from one chord to the next under cover
   * of the envelope and the reverb tail.
   * @param {number[]} notes
   * @param {number} when
   * @param {boolean} immediate
   * @param {boolean} observed
   */
  _voice(notes, when, immediate, observed) {
    const dipAt = immediate ? when : Math.max(when - 0.9, this.ctx.currentTime);
    const setAt = immediate ? when : Math.max(when - 0.45, this.ctx.currentTime + 0.01);
    const target = observed ? VOICE_LEVEL : 0;

    for (const v of this.voices) {
      const hz = notes[v.note % notes.length] * v.ratio;
      if (!immediate) v.gain.gain.linearRampToValueAtTime(VOICE_LEVEL * v.level * 0.18, dipAt);
      v.osc.frequency.setValueAtTime(hz, setAt);
      v.gain.gain.linearRampToValueAtTime(target * v.level, setAt + ATTACK);
    }
  }
}

/**
 * A feedback delay with a damped loop and a stereo position.
 * @param {AudioContext} ctx @param {number} time @param {number} tone @param {number} pan
 */
function makeDelay(ctx, time, tone, pan) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(4);
  delay.delayTime.value = time;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.25;
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = tone;
  const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
  if (panner.pan) panner.pan.value = pan;
  const output = ctx.createGain();
  output.gain.value = 0.42;

  input.connect(delay);
  delay.connect(damp);
  damp.connect(feedback);
  feedback.connect(delay);          // the loop
  damp.connect(panner);
  panner.connect(output);
  return { input, output, delay, feedback, damp };
}

/** Soft clipping, for the overdrive stage. @param {number} amount */
function softClip(amount) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

/**
 * A synthetic impulse response: decaying noise. Not a measured space, and the
 * legend says so - it is a reverb, not a room.
 * @param {BaseAudioContext} ctx @param {number} seconds @param {number} decay
 */
function impulse(ctx, seconds, decay) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
  }
  return buffer;
}

/** @param {BaseAudioContext} ctx @param {number} seconds */
function noiseBuffer(ctx, seconds) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}