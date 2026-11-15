/**
 * mixer.js - two independent paths to the destination.
 *
 * The asymmetry is deliberate:
 *
 *   - The scientific layer's gain is constant. It's the deliverable, and it's
 *     what the validator's tap is measuring. If the mix fader attenuated it,
 *     the audible tone and the measured tone would be different signals, and
 *     the residual on screen would stop describing what anyone is hearing.
 *   - The musical layer's gain is the fader. It can go to zero, which is the
 *     simplified mode, and to full without touching the measurement.
 *
 * So "mix" means how much music joins the tone, never how much tone survives
 * the music.
 *
 * @module mixer
 */

const FADE = 0.04;

export class Mixer {
  /**
   * @param {AudioContext} ctx
   * @param {{scientific:AudioNode, musical:AudioNode}} layers
   */
  constructor(ctx, { scientific, musical }) {
    this.ctx = ctx;

    this.scientificGain = ctx.createGain();
    this.scientificGain.gain.value = 1;      // constant, by design

    this.musicalGain = ctx.createGain();
    this.musicalGain.gain.value = 0;         // starts in the simplified state

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    scientific.connect(this.scientificGain);
    musical.connect(this.musicalGain);
    this.scientificGain.connect(this.master);
    this.musicalGain.connect(this.master);
    this.master.connect(ctx.destination);

    this._mix = 0;
  }

  get mix() { return this._mix; }

  /**
   * @param {number} x 0 = the scientific tone alone, 1 = the full musical mix.
   *   The scientific layer is present at the same level throughout.
   */
  setMix(x) {
    const v = Math.min(Math.max(x, 0), 1);
    this._mix = v;
    const now = this.ctx.currentTime;
    this.musicalGain.gain.cancelScheduledValues(now);
    this.musicalGain.gain.setValueAtTime(this.musicalGain.gain.value, now);
    this.musicalGain.gain.linearRampToValueAtTime(v, now + FADE);
  }

  /**
   * Fade the whole mix out and detach it from the destination.
   *
   * A mixer per track means a path to the speakers per track. Left connected,
   * each switch would add another and the master gains would sum: the tenth
   * track would be ten times louder than the first.
   */
  dispose() {
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 0.25);
    setTimeout(() => {
      for (const n of [this.scientificGain, this.musicalGain, this.master]) {
        try { n.disconnect(); } catch { /* already detached */ }
      }
    }, 400);
  }

  /** @param {number} v 0-1 */
  setMaster(v) {
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(Math.min(Math.max(v, 0), 1), now + FADE);
  }
}