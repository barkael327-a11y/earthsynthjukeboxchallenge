/**
 * field-render.js - the map, drawn from the same array the oscillator reads.
 *
 * This is the visible half of the one-array claim. Every cell on screen is
 * field[t*16200 + j*180 + i] run through the colour scale; the tone is the
 * area-weighted mean of those same numbers run through the contract. Neither is
 * derived from the other, and both are derived from the payload, so the picture
 * and the pitch can't drift apart.
 *
 * Equirectangular projection, chosen over a globe because every cell is visible
 * at once, no cell is distorted away to nothing at the limb, and the inverse is
 * two divisions, which is what region picking needs. project() and unproject()
 * are the only two places that know about geometry, so a globe is a projection
 * swap behind the same interface rather than a rewrite.
 *
 * @module field-render
 */

import { anomalyColour, scaleGradient, ANOMALY_SCALE, INK, DEFAULT_EXTENT } from './palette.js';
import { latOf, lonOf } from './regions.js';

export class FieldRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./earth-series.js').EarthSeries} series
   */
  constructor(canvas, series) {
    this.canvas = canvas;
    this.series = series;
    this.grid = series.grid;
    this.extent = DEFAULT_EXTENT;
    this.g = canvas.getContext('2d');
    this._coast = null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._coast = null;   // cell size changed, so the coastline must be rebuilt
  }

  /** Grid indices to pixels. North is up, so the row axis is flipped. */
  project(j, i) {
    return {
      x: (i / this.grid.nlon) * this.w,
      y: ((this.grid.nlat - 1 - j) / this.grid.nlat) * this.h,
      w: this.w / this.grid.nlon,
      h: this.h / this.grid.nlat,
    };
  }

  /** Pixels back to grid indices, for picking. @returns {{j:number,i:number}|null} */
  unproject(px, py) {
    const i = Math.floor((px / this.w) * this.grid.nlon);
    const j = this.grid.nlat - 1 - Math.floor((py / this.h) * this.grid.nlat);
    if (i < 0 || i >= this.grid.nlon || j < 0 || j >= this.grid.nlat) return null;
    return { j, i };
  }

  /**
   * @param {number} tIndex fractional year index; the nearest annual step is
   *   drawn, because the field itself is annual and a blended frame would show
   *   a year that was never measured
   * @param {import('./regions.js').Region} region highlighted
   */
  draw(tIndex, region) {
    const g = this.g;
    const t = Math.min(Math.max(Math.round(tIndex), 0), this.series.count - 1);
    const { nlat, nlon } = this.grid;

    g.fillStyle = INK.plane;
    g.fillRect(0, 0, this.w, this.h);

    // -- the field --------------------------------------------------------
    for (let j = 0; j < nlat; j++) {
      for (let i = 0; i < nlon; i++) {
        const cell = this.series.cellAt(t, j, i);
        const p = this.project(j, i);
        if (!cell.observed) continue;              // absence is drawn below, as texture
        g.fillStyle = anomalyColour(cell.value, this.extent);
        // +1 avoids hairline seams between cells at fractional pixel sizes.
        g.fillRect(p.x, p.y, p.w + 1, p.h + 1);
      }
    }

    // -- absence ----------------------------------------------------------
    // A sparse diagonal hatch over the page colour. Deliberately not a step on
    // the diverging scale: "not observed" is not "close to the baseline".
    g.save();
    g.strokeStyle = 'rgba(159,176,199,0.22)';
    g.lineWidth = 1;
    g.beginPath();
    for (let j = 0; j < nlat; j++) {
      for (let i = 0; i < nlon; i++) {
        if (this.series.cellAt(t, j, i).observed) continue;
        const p = this.project(j, i);
        g.moveTo(p.x, p.y + p.h);
        g.lineTo(p.x + p.w, p.y);
      }
    }
    g.stroke();
    g.restore();

    this._drawCoastline();
    this._drawRegion(region);
  }

  /**
   * Coastlines from the land-fraction mask, cached. Presentation only: it
   * carries no magnitude and is never read back as data. Without it the field
   * is unreadable as a map and a reader can't tell the Arctic from the Southern
   * Ocean.
   */
  _drawCoastline() {
    const { nlat, nlon } = this.grid;
    if (!this._coast) {
      const path = new Path2D();
      for (let j = 0; j < nlat; j++) {
        for (let i = 0; i < nlon; i++) {
          const land = this.series.landAt(j, i) > 0.5;
          const p = this.project(j, i);
          // Draw the edge where land meets water, in two directions only, so
          // each boundary is drawn once.
          if (i + 1 < nlon && land !== (this.series.landAt(j, i + 1) > 0.5)) {
            path.moveTo(p.x + p.w, p.y);
            path.lineTo(p.x + p.w, p.y + p.h);
          }
          if (j + 1 < nlat && land !== (this.series.landAt(j + 1, i) > 0.5)) {
            path.moveTo(p.x, p.y);
            path.lineTo(p.x + p.w, p.y);
          }
        }
      }
      this._coast = path;
    }
    this.g.save();
    this.g.strokeStyle = 'rgba(11,17,27,0.55)';
    this.g.lineWidth = 1;
    this.g.stroke(this._coast);
    this.g.restore();
  }

  /** @param {import('./regions.js').Region} region */
  _drawRegion(region) {
    if (!region || region.id === 'global') return;
    const g = this.g;
    const [la0, la1] = region.bounds.lat;
    const [lo0, lo1] = region.bounds.lon;

    const x0 = ((lo0 + 180) / 360) * this.w;
    const x1 = ((lo1 + 180) / 360) * this.w;
    const y0 = ((90 - la1) / 180) * this.h;
    const y1 = ((90 - la0) / 180) * this.h;

    g.save();
    g.strokeStyle = INK.accent;
    g.lineWidth = 2;
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    g.restore();
  }
}

/**
 * The colour bar. It is the legend for the map, and deliberately not the only
 * legend: the written contract beside the player says the same thing in words,
 * for a reader who can't use a colour scale at all.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('./palette.js').makeScale>} [scale]
 */
export function drawColourBar(canvas, scale = ANOMALY_SCALE) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const barW = 14;
  const top = 10;
  const bottom = h - 10;

  g.fillStyle = scaleGradient(g, scale, 0, bottom, 0, top);
  g.fillRect(0, top, barW, bottom - top);
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 1;
  g.strokeRect(0.5, top + 0.5, barW - 1, bottom - top - 1);

  g.fillStyle = INK.muted;
  g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.textBaseline = 'middle';
  // Ticks come from the scale, so a track whose bar runs 0 to 32 is labelled
  // 0 to 32 rather than against a legend belonging to a different quantity. The
  // signed form is for diverging scales only: a "+24 °C" sea surface
  // temperature would be claiming a departure that was never measured.
  const signed = scale.kind === 'diverging';
  const span = scale.hi - scale.lo;
  for (const v of scale.ticks()) {
    const y = top + ((scale.hi - v) / span) * (bottom - top);
    g.fillRect(barW, y, 3, 1);
    const digits = Math.abs(v) >= 10 || Number.isInteger(v) ? 0 : 1;
    const label = signed
      ? (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`)
      : v.toFixed(digits);
    g.fillText(label, barW + 7, y);
  }
}

/**
 * Draw the discarded pixels over the published frame.
 *
 * This is the inversion's own test, made visible. A pixel whose colour landed
 * near a point on the published bar became a value; one that landed far from it
 * is basemap, coastline, a label or an annotation, and was stored as the fill
 * value instead. Darkening exactly those cells shows what the method threw
 * away, which is the only honest way to show what it kept.
 *
 * The canvas is sized from its own box, so it must be drawn after the frame
 * image has loaded, and again on resize.
 *
 * @param {HTMLCanvasElement} canvas overlaid on the frame image
 * @param {import('./earth-series.js').EarthSeries} series
 * @param {number} step transport position, not a frame index
 * @returns {number} share of the frame that was discarded, 0-1
 */
export function drawRejectionMask(canvas, series, step) {
  const { nlat, nlon } = series.grid;
  const { frame } = series.axis.locate(step);
  const base = frame * series.cellsPerFrame;
  const fill = series.codec.fill;

  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;

  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const cellW = w / nlon;
  const cellH = h / nlat;
  let discarded = 0;

  g.fillStyle = 'rgba(4,7,12,0.88)';
  for (let j = 0; j < nlat; j++) {
    // Row nlat-1 is the top of the frame, matching project() above.
    const y = ((nlat - 1 - j) / nlat) * h;
    for (let i = 0; i < nlon; i++) {
      if (series.field[base + j * nlon + i] !== fill) continue;
      discarded++;
      // +1 avoids hairline gaps between cells at fractional pixel sizes.
      g.fillRect((i / nlon) * w, y, cellW + 1, cellH + 1);
    }
  }
  return discarded / (nlat * nlon);
}