/**
 * A shared top-to-bottom picture-sweep listening session for independently measured layers.
 * Each carrier retains the published value-to-tilt contract and its own FFT tap.
 * Layer isolation, stereo placement, volume and mute are downstream of those taps.
 * The common scan position is relative picture progress, not a claim that frames
 * share a date, projection, or geographic latitude.
 */
import { CarrierLayer } from './audio-carrier.js';
import { AmbientPad } from './audio-pad.js';
import { LiveValidator } from './validate-live.js';
import { Timeline } from './timeline.js';

const FADE = 0.04;
const HEADROOM = 0.65;
// One shared musical layer; measurement tones sit quietly underneath it.
const BACKDROP_LEVEL = 0.22;
// CarrierLayer ramps for 80 ms; require a complete FFT window after it settles.
const CARRIER_SETTLE = 0.08;

/** Map a canonical scan step to an actual source row, without interpolating values. */
export function sourceIndex(index, sourceCount, count = 90) {
  const held = Math.floor(Math.min(Math.max(index, 0), count - 1));
  return Math.round(held * (sourceCount - 1) / (count - 1));
}

export class LayerSession {
  /**
   * @param {AudioContext} ctx
   * @param {{id:string,series:any,regionId?:string}[]} specs latitude or image-row sweep series
   * @param {{rate?:number,count?:number}} [options]
   */
  constructor(ctx, specs, { rate = 2, count = 90 } = {}) {
    if (!Number.isInteger(count) || count < 2) throw new RangeError('Session needs at least two scan steps.');
    if (!specs.length || new Set(specs.map(s => s.id)).size !== specs.length) {
      throw new Error('Session layers must have unique IDs.');
    }
    // Scan progress is shared; each source retains its own geography and date.
    for (const { id, series } of specs) {
      if (series.axis.kind !== 'scan-lat') {
        throw new Error(`${id}: combined listening requires a top-to-bottom picture sweep.`);
      }
      if (series.count < 2) throw new Error(`${id}: source needs multiple latitude rows.`);
    }
    this.ctx = ctx;
    this.count = count;
    this.volume = 0.8;
    this.muted = false;
    this.started = false;
    this.musicEnabled = true;
    this.disposed = false;
    this.layers = new Map();
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.timeline = new Timeline(ctx, { count, rate });
    specs.forEach(({ id, series, regionId }, position) => {
      const region = series.region(regionId ?? (series.regions.has('global') ? 'global' : series.regions.keys().next().value));
      // The adapter exposes exactly the discrete values that the shared scan sounds.
      const adapter = {
        count,
        rangeOf: rid => series.rangeOf(rid),
        sampleAt: (rid, index) => series.sampleAt(rid, sourceIndex(index, series.count, count)),
      };
      const carrier = new CarrierLayer(ctx, { series: adapter, region });
      carrier._padPlaying = true;
      carrier.setPresence(true); // Audible trim only; the FFT tap remains upstream.
      const validator = new LiveValidator(carrier.analyser, () => carrier.region.contract);
      const gain = ctx.createGain();
      gain.gain.value = HEADROOM / specs.length;
      const pan = ctx.createStereoPanner();
      pan.pan.value = specs.length === 1 ? 0 : -0.65 + 1.3 * position / (specs.length - 1);
      carrier.output.connect(gain);
      gain.connect(pan);
      pan.connect(this.master);
      this.layers.set(id, { id, series, region, carrier, validator, gain, pan, enabled: true, fault: 0, settledAt: new Map() });
    });
    // The original musical voicing, shared by the entire session. It carries no
    // magnitude and goes silent when every included source has a gap.
    const backdropSeries = {
      count, rangeOf: () => ({min:0,max:1}),
      sampleAt: (_, index) => {
        // This normalized blend shapes only the music, never the measured values.
        const musicalValues = [...this.layers.values()].filter(layer => layer.enabled).flatMap(layer => {
          const sample=layer.series.sampleAt(layer.region.id, sourceIndex(index, layer.series.count, count));
          if(!sample.observed) return [];
          const range=layer.series.rangeOf(layer.region.id);
          return [range.max===range.min ? 0.5 : Math.min(1,Math.max(0,(sample.value-range.min)/(range.max-range.min)))];
        });
        const observed=musicalValues.length>0;
        return {value:observed ? musicalValues.reduce((a,b)=>a+b,0)/musicalValues.length : null, observed, coverage:observed ? 1 : 0};
      },
    };
    this.backdrop = new AmbientPad(ctx, {
      series:backdropSeries, region:this.layers.values().next().value.region, yearSeconds:1 / rate,
    });
    this.backdropGain = ctx.createGain();
    this.backdropGain.gain.value = BACKDROP_LEVEL;
    this.backdrop.output.connect(this.backdropGain);
    this.backdropGain.connect(this.master);
    this.timeline.onSchedule(vertex => {
      this.backdrop.scheduleVertex(vertex);
      for (const layer of this.layers.values()) {
        layer.carrier.scheduleVertex(vertex);
        layer.settledAt.set(vertex.index, vertex.time + CARRIER_SETTLE + layer.validator.windowSeconds);
      }
    });
    this.timeline.onSeek(index => {
      this.backdrop.seek(index);
      for (const layer of this.layers.values()) {
        layer.carrier.seek(index);
        layer.settledAt.clear();
        layer.settledAt.set(Math.floor(index), ctx.currentTime + FADE + CARRIER_SETTLE + layer.validator.windowSeconds);
      }
    });
    this.timeline.onPlayState(() => this._outputLevel());
  }

  _ramp(param, value) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + FADE);
  }

  _outputLevel() {
    this._ramp(this.master.gain, !this.muted && this.timeline.playing ? this.volume : 0);
  }

  /** All selected layers play together. Pass one ID to isolate it; [] is silent. */
  setEnabled(ids) {
    const selected = new Set(ids);
    for (const id of selected) if (!this.layers.has(id)) throw new Error(`Unknown layer: ${id}`);
    for (const layer of this.layers.values()) {
      layer.enabled = selected.has(layer.id);
      this._ramp(layer.gain.gain, layer.enabled ? HEADROOM / Math.max(1, selected.size) : 0);
    }
    this._backdropLevel();
    this.backdrop.seek(this.timeline.index);
  }

  /** Musical layer is presentation only and carries no independent measurement. */
  setMusic(on) {
    this.musicEnabled = Boolean(on);
    this._backdropLevel();
  }
  _backdropLevel() {
    const anyEnabled = [...this.layers.values()].some(layer => layer.enabled);
    this._ramp(this.backdropGain.gain, this.musicEnabled && anyEnabled ? BACKDROP_LEVEL : 0);
  }
  setProgression(id) {
    this.backdrop.setProgression(id);
    this.timeline.seek(this.timeline.index, 'key');
  }

  /** Deliberately offset one encoder by 3 dB worth of its own units.
   * The expected value remains the published source value, so its residual rises.
   */
  setFault(id, on) {
    const layer = this.layers.get(id);
    if (!layer) throw new Error(`Unknown layer: ${id}`);
    layer.fault = on ? layer.region.contract.resolutionCelsius(3) : 0;
    layer.carrier.setFault(layer.fault);
    this.timeline.seek(this.timeline.index, 'fault');
    return layer.fault;
  }

  setMuted(muted) { this.muted = Boolean(muted); this._outputLevel(); }
  setVolume(value) {
    if (!Number.isFinite(value)) throw new TypeError('Volume must be finite.');
    this.volume = Math.min(Math.max(value, 0), 1);
    this._outputLevel();
  }

  /** Update the same named region in every source, atomically. */
  setRegion(id) {
    const regions = [...this.layers.values()].map(layer => layer.series.region(id));
    [...this.layers.values()].forEach((layer, i) => {
      layer.region = regions[i];
      layer.carrier.setRegion(regions[i]);
    });
    this.backdrop.setRegion(regions[0]);
    this.timeline.seek(this.timeline.index, 'region');
  }

  async play() {
    if (this.disposed) throw new Error('This listening session was disposed.');
    await this.ctx.resume();
    if (this.disposed) throw new Error('This listening session was disposed.');
    this.started = true;
    this.timeline.play();
  }
  pause() { this.timeline.pause(); }
  seek(index) { this.timeline.seek(index); }
  get index() { return this.timeline.index; }
  get playing() { return this.timeline.playing; }

  /** Current discrete source values and independently measured residuals. */
  sample(index = this.timeline.index) {
    return [...this.layers.values()].map(layer => {
      const row = sourceIndex(index, layer.series.count, this.count);
      const value = layer.series.sampleAt(layer.region.id, row);
      const contract = layer.region.contract;
      const expected = {
        expectedValue: value.observed ? value.value : null,
        expectedTilt: value.observed ? contract.toTilt(value.value) : null,
      };
      const currentStep = Math.floor(this.timeline.index);
      const atCurrentStep = Math.floor(index) === currentStep;
      const settledAt = layer.settledAt.get(currentStep) ?? Infinity;
      const settled = this.ctx.currentTime >= settledAt;
      // Scheduling lookahead changes carrier.expectedValue ahead of its audible
      // arrival. Measure against the current held SOURCE row instead, and never
      // interpret a ramp / mixed FFT window / paused output as a failed encoding.
      const canMeasure = this.started && this.playing && atCurrentStep && settled && value.observed;
      const validation = canMeasure ? layer.validator.measure(expected) : null;
      const measurementState = !value.observed ? 'no-observation'
        : !this.playing ? 'paused' : !atCurrentStep || !settled ? 'settling'
        : validation ? 'measured' : 'silent';
      return {
        id: layer.id, enabled: layer.enabled, index: row,
        value: value.value, coverage: value.coverage, observed: value.observed,
        label: layer.series.labelAt(row), contract, validation, measurementState, fault: layer.fault,
      };
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.timeline.dispose();
    this._ramp(this.master.gain, 0);
    this.backdrop.dispose();
    for (const layer of this.layers.values()) layer.carrier.dispose();
    setTimeout(() => {
      for (const layer of this.layers.values()) {
        layer.gain.disconnect();
        layer.pan.disconnect();
      }
      this.backdropGain.disconnect();
      this.master.disconnect();
    }, 450);
  }
}
