/**
 * readout.js - the numbers beside the sound, and what a screen reader hears.
 *
 * Two audiences, one source. Sighted users read the panel; screen-reader users
 * hear the live region. Both are fed from the same state object, so they cannot
 * drift apart, and neither is told anything the audio is not doing.
 *
 * The throttle matters more than it looks. Dragging the scrub bar moves the
 * playhead sixty times a second, and an aria-live region updated at that rate
 * either floods the speech queue or, on some screen readers, silences itself
 * entirely. So announcements go out at most every ANNOUNCE_MS, plus one final
 * announcement after the playhead has been still for SETTLE_MS - which is the
 * one that actually matters, because it says where the user landed.
 *
 * @module readout
 */

const ANNOUNCE_MS = 1100;
const SETTLE_MS = 280;

/**
 * With the residual spoken as well, each line takes several seconds to read
 * aloud, so it needs correspondingly more room before the next one arrives.
 */
const SPEAKING_MS = 3500;

/** @param {number} v */
const signed = (v, digits = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

export class Readout {
  /**
   * @param {HTMLElement} root element containing [data-ro] fields
   */
  constructor(root) {
    this.root = root;
    /** @type {Record<string, HTMLElement>} */
    this.fields = {};
    for (const el of root.querySelectorAll('[data-ro]')) {
      this.fields[/** @type {HTMLElement} */ (el).dataset.ro] = el;
    }
    this.live = root.querySelector('[data-live]');
    /** Whether the spoken line carries the live residual as well. */
    this.speakResidual = false;
    this._lastAnnounce = 0;
    this._settleTimer = null;
    this._pending = '';
  }

  /** @param {string} name @param {string} text */
  set(name, text) {
    const el = this.fields[name];
    if (el && el.textContent !== text) el.textContent = text;
  }

  /**
   * @param {object} s
   * @param {string} s.regionLabel
   * @param {number} s.year
   * @param {number|null} s.value
   * @param {boolean} s.observed
   * @param {number} s.coverage
   * @param {boolean} s.interpolated
   * @param {any} s.contract
   * @param {ReturnType<import('./validate-live.js').LiveValidator['measure']>} [s.validation]
   * @param {boolean} s.started whether audio has been started yet
   */
  update(s) {
    const label = s.label ?? String(Math.round(s.year));
    // Signed only where the sign means something. A sea surface temperature
    // printed as "+27.70" would be asserting a departure from a reference
    // that was never measured; the GISTEMP anomaly genuinely is one.
    const show = (v, d = 2) => (s.diverging === false ? v.toFixed(d) : signed(v, d));

    this.set('region', s.regionLabel);
    this.set('year', label);
    this.set('trendYear', label);

    if (!s.observed || s.value === null) {
      this.set('value', '—');
      this.set('tilt', '—');
      this.set('carrier', 'no observation');
      this.set('status', 'No observation · silent');
      this.set('coverage', `${(s.coverage * 100).toFixed(0)}% observed`);
      this._dot('#6d7f96');
    } else {
      const tilt = s.contract.toTilt(s.value);
      this.set('value', show(s.value));
      this.set('tilt', `${tilt >= 0 ? '+' : '−'}${Math.abs(tilt).toFixed(1)}`);
      this.set('carrier', `${s.contract.fLow} / ${s.contract.fHigh} Hz`);
      this.set('coverage', `${(s.coverage * 100).toFixed(1)}% observed`);
      this.set(
        'status',
        s.coverage > 0.995 ? 'Observed · full coverage' : 'Observed · partial coverage'
      );
      // The dot is never the only cue: the words beside it say the same thing.
      this._dot(s.coverage > 0.995 ? '#0ca30c' : '#fab219');
    }

    // -- the validation panel ---------------------------------------------
    const v = s.validation;
    if (!s.started) {
      this.set('vExpected', '—');
      this.set('vMeasured', '—');
      this.set('vRecovered', '—');
      this.set('vResidual', '—');
      this.set('vNote', 'Press play to start the audio and begin measuring.');
    } else if (!v) {
      this.set('vExpected', '—');
      this.set('vMeasured', '—');
      this.set('vRecovered', '—');
      this.set('vResidual', '—');
      this.set('vNote', 'The carrier is silent, so there is nothing to measure.');
    } else {
      const dB = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(3)} dB`;
      this.set('vExpected', dB(v.expectedTilt));
      this.set('vMeasured', dB(v.tilt));
      const u = s.contract.units;
      this.set('vRecovered', `${show(v.recovered, 4)} ${u}`);
      this.set('vResidual', `${v.residual.toFixed(4)} ${u}`);
      this.set(
        'vNote',
        `${this._fftLabel(v)} At this slope the analysis resolves ${v.resolution.toFixed(4)} ${u}. ` +
        `Raising the pad, the reverb or the master fader cannot move this number: both partials ` +
        `pass through the same gain, so it cancels in the ratio.`
      );
      const el = this.fields.vResidual;
      if (el) el.dataset.ok = String(v.withinTolerance);
    }

    this._queueAnnounce(s);
  }

  /** @param {string} colour */
  _dot(colour) {
    const el = this.root.querySelector('[data-ro-dot]');
    if (el && el.style.background !== colour) el.style.background = colour;
  }

  /** @param {any} v */
  _fftLabel(v) {
    return `${(v.windowSeconds * 1000).toFixed(0)} ms window, ${v.binHz.toFixed(2)} Hz bins, band power at each partial.`;
  }

  /** @param {any} s */
  _queueAnnounce(s) {
    const label = s.label ?? String(Math.round(s.year));
    const unit = (s.contract?.units ?? '°C').replace('°C', 'degrees');
    const amount = s.value === null ? ''
      : s.diverging === false
        ? `${s.value.toFixed(2)} ${unit}`
        : `${s.value >= 0 ? 'plus' : 'minus'} ${Math.abs(s.value).toFixed(2)} ${unit}`;
    let text = s.observed && s.value !== null
      ? `${label}, ${amount}, ` +
        `${s.coverage > 0.995 ? 'fully observed' : `${(s.coverage * 100).toFixed(0)} percent observed`}` +
        `${s.interpolated ? ', between steps' : ''}`
      : `${label}, no observation`;

    // The residual goes on the end of this line rather than into a second
    // announcement of its own. One live region with two writers means whichever
    // flushes last wins and the other is never heard.
    const v = s.validation;
    if (this.speakResidual && v && Number.isFinite(v.residual)) {
      text += `, residual ${v.residual.toFixed(3)}`;
    }

    this._pending = text;
    const now = performance.now();
    const gap = this.speakResidual ? SPEAKING_MS : ANNOUNCE_MS;
    if (now - this._lastAnnounce > gap) this._flush();

    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => this._flush(), SETTLE_MS);
  }

  _flush() {
    if (!this.live || !this._pending) return;
    if (this.live.textContent === this._pending) return;
    this.live.textContent = this._pending;
    this._lastAnnounce = performance.now();
  }

  /** Announce something immediately, for state changes the user just caused. */
  say(text) {
    if (!this.live) return;
    this.live.textContent = text;
    this._lastAnnounce = performance.now();
  }
}