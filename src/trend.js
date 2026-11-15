/**
 * trend.js - the record as a line, with the playhead on it.
 *
 * Form: change over time, one series, so a line chart with no legend - the
 * panel heading names the series, and a legend box for a single line is noise.
 * Grid and axes are recessive; the only emphatic marks are the line itself, the
 * zero baseline (which is what every value is relative to, so it has to be
 * visible) and the playhead.
 *
 * The line is coloured by value from the same diverging scale as the map, so
 * the colour bar is the legend for both and a reader learns one scale rather
 * than two. Sign is not carried by colour alone: the zero baseline is drawn,
 * and the value is printed in the readout and spoken by the live region.
 *
 * This canvas is aria-hidden on purpose. It is a picture of data that is also
 * available as a number, as a tone, and as a screen-reader announcement, and
 * the control that moves the playhead is a native range input beneath it - not
 * this canvas. A keyboard user never needs to touch it.
 *
 * @module trend
 */

import { ANOMALY_SCALE, INK } from './palette.js';

const PAD = { top: 14, right: 16, bottom: 22, left: 40 };

export class TrendChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./earth-series.js').EarthSeries} series
   */
  constructor(canvas, series) {
    this.canvas = canvas;
    this.series = series;
    this.scale = ANOMALY_SCALE;
    this.g = canvas.getContext('2d');
    this.regionId = 'global';
    this.hover = null;
    this.resize();

    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = this._indexAtX(e.clientX - r.left);
      this.draw(this._lastIndex ?? 0);
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.draw(this._lastIndex ?? 0);
    });
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** @param {string} id */
  setRegion(id) {
    this.regionId = id;
  }

  get plot() {
    return {
      x: PAD.left,
      y: PAD.top,
      w: this.w - PAD.left - PAD.right,
      h: this.h - PAD.top - PAD.bottom,
    };
  }

  /**
   * A value in the track's own units.
   *
   * Signed only on a diverging scale, where the sign is a departure from a
   * stated reference and is the first thing to read. On a sequential track a
   * leading "+" would assert a polarity the quantity does not have.
   */
  _fmt(v) {
    const u = this.scale.units ? ` ${this.scale.units}` : '';
    return this.scale.kind === 'diverging'
      ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}${u}`
      : `${v.toFixed(2)}${u}`;
  }

  _xOf(index) {
    const p = this.plot;
    return p.x + (index / (this.series.count - 1)) * p.w;
  }

  _indexAtX(px) {
    const p = this.plot;
    const t = (px - p.x) / p.w;
    return Math.min(Math.max(Math.round(t * (this.series.count - 1)), 0), this.series.count - 1);
  }

  _scale() {
    const r = this.series.rangeOf(this.regionId);
    // Pad the range a little and always include zero, since every value on
    // this chart is an anomaly relative to it.
    const lo = Math.min(r.min, 0) - 0.15;
    const hi = Math.max(r.max, 0) + 0.15;
    const p = this.plot;
    return {
      lo, hi,
      y: (v) => p.y + ((hi - v) / (hi - lo)) * p.h,
    };
  }

  /** @param {number} tIndex current playhead, fractional */
  draw(tIndex) {
    this._lastIndex = tIndex;
    const g = this.g;
    const p = this.plot;
    const s = this._scale();

    g.clearRect(0, 0, this.w, this.h);
    g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

    // -- recessive chrome --------------------------------------------------
    const step = s.hi - s.lo > 3 ? 1 : 0.5;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let v = Math.ceil(s.lo / step) * step; v <= s.hi; v += step) {
      const y = s.y(v);
      g.strokeStyle = Math.abs(v) < 1e-9 ? INK.axis : INK.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(p.x, Math.round(y) + 0.5);
      g.lineTo(p.x + p.w, Math.round(y) + 0.5);
      g.stroke();
      g.fillStyle = INK.muted;
      g.fillText(v === 0 ? '0.0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`, p.x - 8, y);
    }

    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let year = 1880; year <= this.series.yearEnd; year += 30) {
      const x = this._xOf(year - this.series.yearStart);
      g.fillStyle = INK.muted;
      g.fillText(String(year), x, p.y + p.h + 6);
    }

    // -- the line ----------------------------------------------------------
    // Drawn segment by segment so colour can follow value. 2px, no markers:
    // 146 markers would be noise, and the playhead marks the one that matters.
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (let i = 0; i + 1 < this.series.count; i++) {
      const a = this.series.sampleAt(this.regionId, i);
      const b = this.series.sampleAt(this.regionId, i + 1);
      if (!a.observed || !b.observed) continue;    // a gap is a gap; do not bridge it
      g.strokeStyle = this.scale.colourAt((a.value + b.value) / 2);
      g.beginPath();
      g.moveTo(this._xOf(i), s.y(a.value));
      g.lineTo(this._xOf(i + 1), s.y(b.value));
      g.stroke();
    }

    // -- hover crosshair ---------------------------------------------------
    if (this.hover !== null) this._marker(this.hover, s, 'rgba(159,176,199,0.5)', true);

    // -- the playhead ------------------------------------------------------
    this._marker(tIndex, s, INK.accent, false);
  }

  /**
   * @param {number} index @param {{y:(v:number)=>number}} s
   * @param {string} colour @param {boolean} tooltip
   */
  _marker(index, s, colour, tooltip) {
    const g = this.g;
    const p = this.plot;
    const x = this._xOf(index);
    const sample = this.series.sampleAt(this.regionId, index);

    g.save();
    g.strokeStyle = colour;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, p.y);
    g.lineTo(Math.round(x) + 0.5, p.y + p.h);
    g.stroke();

    if (sample.observed) {
      const y = s.y(sample.value);
      // A 2px surface ring so the dot stays legible over the line it sits on.
      g.fillStyle = INK.surface;
      g.beginPath(); g.arc(x, y, 5.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = colour;
      g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();

      if (tooltip) {
        const text = `${this.series.labelAt(index)}  ${this._fmt(sample.value)}`;
        g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        const tw = g.measureText(text).width + 14;
        const tx = Math.min(Math.max(x - tw / 2, p.x), p.x + p.w - tw);
        g.fillStyle = 'rgba(11,17,27,0.92)';
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.beginPath();
        g.roundRect(tx, p.y + 2, tw, 20, 4);
        g.fill(); g.stroke();
        g.fillStyle = INK.primary;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(text, tx + 7, p.y + 12);
      }
    }
    g.restore();
  }
}
