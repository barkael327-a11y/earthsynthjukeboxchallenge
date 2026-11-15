/**
 * timeline.js - the shared clock.
 *
 * Everything that moves reads its position from here: the map frame, the
 * numeric readout, the oscillator's frequency and the trend cursor. One clock
 * is what makes the synchronisation claim checkable.
 *
 * The important design decision, and the one most easily got wrong:
 *
 *     requestAnimationFrame is not a clock.
 *
 * rAF fires when the compositor is ready, which is not when the audio hardware
 * needs a sample. Setting `osc.frequency.value` from an animation callback
 * produces pitch that jitters with frame timing and a synchronisation test that
 * fails about one run in five - the worst kind of bug, because it looks like
 * flakiness rather than an error. So:
 *
 *   - Audio parameters are SCHEDULED against ctx.currentTime, ahead of time,
 *     by the scheduler below.
 *   - rAF is used only to redraw things the eye reads, and never to decide
 *     what the speaker does.
 *
 * The scheduler walks year boundaries rather than a fixed time grid, because
 * the record is annual: there is one scheduled event per published value, and
 * nothing is scheduled for the moments in between. That is two or three
 * scheduling calls a second rather than sixty, and it keeps what is sounding
 * at any instant equal to exactly one year's value.
 *
 * @module timeline
 */

/**
 * @typedef {object} Vertex
 * @property {number} index  integer year index this vertex lands on
 * @property {number} time   ctx.currentTime at which it should land
 */

export class Timeline {
  /**
   * @param {BaseAudioContext} ctx
   * @param {object} opts
   * @param {number} opts.count       number of annual steps
   * @param {number} [opts.rate]      years per second of playback
   * @param {number} [opts.lookahead] seconds of audio scheduled ahead of now
   * @param {number} [opts.interval]  milliseconds between scheduler ticks
   */
  constructor(ctx, { count, rate = 2, lookahead = 0.12, interval = 40 }) {
    this.ctx = ctx;
    this.count = count;
    this.rate = rate;
    this.lookahead = lookahead;
    this.interval = interval;

    /** Index the playhead sat at when the current span of playback began. */
    this.anchorIndex = 0;
    /** ctx.currentTime at that moment. */
    this.anchorTime = ctx.currentTime;
    this.playing = false;

    /** Next integer year boundary not yet scheduled. */
    this._nextVertex = 0;
    this._timer = null;
    this._endTimer = null;
    this._raf = null;

    /** @type {((v:Vertex)=>void)[]} */ this._onSchedule = [];
    /** @type {((i:number, reason:string)=>void)[]} */ this._onSeek = [];
    /** @type {((i:number)=>void)[]} */ this._onFrame = [];
    /** @type {((p:boolean)=>void)[]} */ this._onPlayState = [];
  }

  // -- position ------------------------------------------------------------

  /** Fractional year index right now. Clamped to the record. */
  get index() {
    if (!this.playing) return this.anchorIndex;
    const raw = this.anchorIndex + (this.ctx.currentTime - this.anchorTime) * this.rate;
    return Math.min(Math.max(raw, 0), this.count - 1);
  }

  /** ctx.currentTime at which the playhead reaches a given index. */
  timeOfIndex(i) {
    return this.anchorTime + (i - this.anchorIndex) / this.rate;
  }

  /** True once the playhead has run off the end. */
  get atEnd() {
    return this.index >= this.count - 1;
  }

  // -- transport -----------------------------------------------------------

  /**
   * Move the playhead. Every listener is told, because a seek invalidates
   * everything already scheduled and sinks must cancel before re-scheduling.
   * @param {number} i fractional index
   * @param {string} [reason] 'scrub' | 'step' | 'jump' | 'reset'
   */
  seek(i, reason = 'scrub') {
    const clamped = Math.min(Math.max(i, 0), this.count - 1);
    this.anchorIndex = clamped;
    this.anchorTime = this.ctx.currentTime;
    this._nextVertex = Math.floor(clamped) + 1;

    // Undo the end-of-record state, if the scheduler had already reached it.
    // Once the last vertex is scheduled, _schedule() stops the interval and
    // arms a timer to pause on arrival. Seeking backwards out of that window
    // left the timer armed - so playback paused itself a moment later - and
    // left the interval stopped, so no further vertices were scheduled at all
    // and the carrier would have held one year's tilt while the readout and
    // the globe moved on.
    clearTimeout(this._endTimer);
    this._endTimer = null;
    if (this.playing && this._timer === null) {
      this._timer = setInterval(() => this._schedule(), this.interval);
    }

    for (const fn of this._onSeek) fn(clamped, reason);
    if (this.playing) this._schedule();
    else for (const fn of this._onFrame) fn(clamped);
  }

  /** @param {number} n whole years to move by */
  stepBy(n) {
    this.seek(Math.round(this.index) + n, 'step');
  }

  play() {
    if (this.playing) return;
    if (this.atEnd) this.seek(0, 'reset');
    this.anchorIndex = this.index;
    this.anchorTime = this.ctx.currentTime;
    this._nextVertex = Math.floor(this.anchorIndex) + 1;
    this.playing = true;
    for (const fn of this._onSeek) fn(this.anchorIndex, 'play');
    this._schedule();
    this._timer = setInterval(() => this._schedule(), this.interval);
    this._startFrames();
    for (const fn of this._onPlayState) fn(true);
  }

  pause() {
    if (!this.playing) return;
    const where = this.index;
    this.playing = false;
    clearInterval(this._timer);
    clearTimeout(this._endTimer);
    this._timer = null;
    this._endTimer = null;
    this.anchorIndex = where;
    this.anchorTime = this.ctx.currentTime;
    for (const fn of this._onSeek) fn(where, 'pause');
    for (const fn of this._onPlayState) fn(false);
    // One last frame so the readout shows exactly where it stopped.
    for (const fn of this._onFrame) fn(where);
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  /** @param {number} r years per second */
  setRate(r) {
    const where = this.index;
    this.rate = r;
    this.seek(where, 'rate');
  }

  // -- the scheduler -------------------------------------------------------

  /**
   * Hand every year boundary that falls inside the lookahead window to the
   * sinks, with the exact audio time it should land on.
   */
  _schedule() {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime + this.lookahead;
    while (this._nextVertex <= this.count - 1) {
      const when = this.timeOfIndex(this._nextVertex);
      if (when > horizon) break;
      const vertex = { index: this._nextVertex, time: when };
      for (const fn of this._onSchedule) fn(vertex);
      this._nextVertex += 1;
    }
    if (this._nextVertex > this.count - 1) {
      // The last vertex is scheduled; stop when the playhead actually gets
      // there rather than now, or the final year is cut off mid-ramp.
      const endsAt = this.timeOfIndex(this.count - 1);
      const remaining = Math.max(0, endsAt - this.ctx.currentTime);
      clearInterval(this._timer);
      this._timer = null;
      clearTimeout(this._endTimer);
      this._endTimer = setTimeout(
        () => { if (this.playing) this.pause(); },
        remaining * 1000 + 20
      );
    }
  }

  /**
   * Display frames. Guarded because this module has to run in two places where
   * there is no animation loop at all: Node, for the scheduling tests, and an
   * OfflineAudioContext render, where the whole point is to produce audio
   * faster than real time with nothing on screen. Audio scheduling never
   * depends on this running.
   */
  _startFrames() {
    if (typeof requestAnimationFrame !== 'function') return;
    const tick = () => {
      if (!this.playing) { this._raf = null; return; }
      for (const fn of this._onFrame) fn(this.index);
      this._raf = requestAnimationFrame(tick);
    };
    if (this._raf === null) this._raf = requestAnimationFrame(tick);
  }

  // -- subscription --------------------------------------------------------

  /** Audio sinks subscribe here. Called ahead of time, with an audio timestamp. */
  onSchedule(fn) { this._onSchedule.push(fn); return this; }
  /** Called when the playhead jumps. Sinks must cancel scheduled values. */
  onSeek(fn) { this._onSeek.push(fn); return this; }
  /** Display only. Never schedule audio from here. */
  onFrame(fn) { this._onFrame.push(fn); return this; }
  onPlayState(fn) { this._onPlayState.push(fn); return this; }

  dispose() {
    clearInterval(this._timer);
    clearTimeout(this._endTimer);
    if (this._raf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._raf);
    }
    this._timer = this._endTimer = this._raf = null;
    this.playing = false;
  }
}
