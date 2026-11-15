/**
 * globe.js
 *
 * Renders the data field on a rotating orthographic sphere.
 *
 * Rather than projecting each grid cell to a quad (slow), we invert the
 * projection per screen pixel: for each pixel inside the disc, compute the
 * lat/lon and look up the cell. The spin only adds to longitude, so everything
 * else (disc membership, latitude, base longitude, shading) is precomputed
 * once per resize in _buildPixelMap().
 *
 * Note: a step index is not a frame index. For a time-axis track the step IS
 * the frame, but a still swept by latitude has one frame and many steps.
 * Always use axis.locate(step) to get the frame; never multiply step * cellsPerFrame.
 */

import { ANOMALY_SCALE, INK } from './palette.js';

const TILT_DEG = 18;
const SPIN_DEG_PER_SEC = 4.5;
const LUT_STEPS = 512;

export class GlobeRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./earth-series.js').EarthSeries} series
   */
  constructor(canvas, series) {
    this.canvas = canvas;
    this.series = series;
    this.grid = series.grid;
    this.g = canvas.getContext('2d');
    this.scale = ANOMALY_SCALE;
    this.spinDeg = -20;
    this.autoSpin = true;
    this._lastFrameMs = null;
    this._lut = buildLut(this.scale);
    this._stars = null;
    this._warnedBadRead = false;
    this.resize();

    let dragging = false;
    let lastX = 0;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; lastX = e.clientX; this.autoSpin = false;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.spinDeg += (e.clientX - lastX) * 0.4;
      lastX = e.clientX;
    });
    const stop = () => { dragging = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width  = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.pw = this.canvas.width;
    this.ph = this.canvas.height;
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this._buildPixelMap();
    this._stars = makeStars(this.pw, this.ph);
    this.image   = this.g.createImageData(this.pw, this.ph);
    this.pixels  = new Uint32Array(this.image.data.buffer);
    this.scratch = document.createElement('canvas');
    this.scratch.width  = this.pw;
    this.scratch.height = this.ph;
    this.scratchCtx = this.scratch.getContext('2d');
  }

  // Precompute per-pixel geometry. All the trig lives here; the draw loop
  // only does array lookups and arithmetic.
  _buildPixelMap() {
    const { pw, ph } = this;
    const cx = pw / 2;
    const cy = ph / 2;
    const r  = Math.min(pw, ph) * 0.43;
    this.cx = cx; this.cy = cy; this.r = r;

    const n      = pw * ph;
    const inside = new Uint8Array(n);
    const latIdx = new Int16Array(n);
    const latDeg = new Float32Array(n);
    const lonBase = new Float32Array(n);
    const shade  = new Float32Array(n);
    const edge   = new Uint8Array(n);

    const t    = (TILT_DEG * Math.PI) / 180;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    const { nlat } = this.grid;

    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        const k = py * pw + px;
        const X  = (px + 0.5 - cx) / r;
        const Y  = -(py + 0.5 - cy) / r;
        const d2 = X * X + Y * Y;
        if (d2 > 1) continue;

        const Z = Math.sqrt(1 - d2);
        // Undo tilt to get the point in the globe's own frame.
        const y = Y * cosT + Z * sinT;
        const z = -Y * sinT + Z * cosT;

        const lat = (Math.asin(Math.min(Math.max(y, -1), 1)) * 180) / Math.PI;
        const lon = (Math.atan2(X, z) * 180) / Math.PI;

        let j = Math.floor((lat + 90) / 2);
        if (j < 0) j = 0; else if (j >= nlat) j = nlat - 1;

        inside[k]  = 1;
        latIdx[k]  = j;
        latDeg[k]  = lat;
        lonBase[k] = lon;
        shade[k]   = 0.42 + 0.58 * Math.pow(Z, 0.55);

        const latFrac = ((lat + 90) / 2) % 1;
        if (latFrac < 0.06 || latFrac > 0.94) edge[k] = 1;
      }
    }
    this.map = { inside, latIdx, latDeg, lonBase, shade, edge };
  }

  /** @param {ReturnType<import('./palette.js').makeScale>} scale */
  setScale(scale) { this.scale = scale; this._lut = buildLut(scale); }

  // Log once when a payload read goes out of bounds, then draw the cell as absent.
  // The silent failure mode (undefined -> NaN -> 0 -> darkest colour) looks like
  // valid data and is much harder to notice.
  _noteBadRead(base, offset) {
    if (this._warnedBadRead) return;
    this._warnedBadRead = true;
    console.error(
      `globe: read past payload end at ${base + offset} of ` +
      `${this.series.field.length}. Use series.axis.locate(step) for the frame index.`
    );
  }

  /**
   * @param {number} tIndex fractional step; nearest whole step is used (payload is discrete)
   * @param {import('./regions.js').Region} region
   */
  draw(tIndex, region) {
    const now = performance.now();
    if (this.autoSpin && this._lastFrameMs !== null) {
      this.spinDeg += ((now - this._lastFrameMs) / 1000) * SPIN_DEG_PER_SEC;
    }
    this._lastFrameMs = now;
    if (this.spinDeg >  180) this.spinDeg -= 360;
    if (this.spinDeg < -180) this.spinDeg += 360;

    const step = Math.min(Math.max(Math.round(tIndex), 0), this.series.count - 1);
    const { frame, row: sweepRow } = this.series.axis.locate(step);

    const { inside, latIdx, latDeg, lonBase, shade, edge } = this.map;
    const { nlat, nlon } = this.grid;
    const land        = this.series.landfrac;
    const field       = this.series.field;
    const fill        = this.series.codec.fill;
    const cellsPerFrame = this.series.cellsPerFrame;
    const base        = frame * cellsPerFrame;
    const px32        = this.pixels;
    const lut         = this._lut;
    const lo          = this.scale.lo;
    const span        = this.scale.hi - this.scale.lo;
    const codecScale  = this.series.codec.scale;
    const codecOffset = this.series.codec.offset ?? 0;
    const spin        = this.spinDeg;

    const [la0, la1] = region ? region.bounds.lat : [-90, 90];
    const [lo0, lo1] = region ? region.bounds.lon : [-180, 180];
    const whole = !region || region.id === 'global';

    px32.fill(0);
    for (let k = 0; k < px32.length; k++) {
      if (!inside[k]) continue;

      let lon = lonBase[k] - spin;
      while (lon < -180) lon += 360;
      while (lon >=  180) lon -= 360;

      let i = ((lon + 180) / 2) | 0;
      if (i < 0) i = 0; else if (i >= nlon) i = nlon - 1;

      const j      = latIdx[k];
      const offset = j * nlon + i;
      const raw    = field[base + offset];
      let s        = shade[k];

      // Bilinear land fraction for a smooth coastline contour at the 0.5 threshold.
      const yc = (latDeg[k] + 89) / 2;
      const xc = (lon + 179) / 2;
      let j0   = Math.floor(yc);
      const ty = yc - j0;
      let i0   = Math.floor(xc);
      const tx = xc - i0;
      const j1 = Math.min(Math.max(j0 + 1, 0), nlat - 1);
      j0 = Math.min(Math.max(j0, 0), nlat - 1);
      const iA  = ((i0 % nlon) + nlon) % nlon;
      const iB  = ((i0 + 1) % nlon + nlon) % nlon;
      const f00 = land[j0 * nlon + iA];
      const f01 = land[j0 * nlon + iB];
      const f10 = land[j1 * nlon + iA];
      const f11 = land[j1 * nlon + iB];
      const frac = ((f00 + (f01 - f00) * tx) * (1 - ty)
                  + (f10 + (f11 - f10) * tx) * ty) / 255;

      const coast = Math.abs(frac - 0.5) < 0.085;
      s *= frac >= 0.5 ? 1.08 : 0.78;

      const readable = Number.isFinite(raw);
      if (!readable) this._noteBadRead(base, offset);
      const absent = !readable || raw === fill;

      let r, g, b;
      if (absent) {
        // Diagonal hatch so absence is visually distinct from "near baseline".
        const hatch = ((k % this.pw) + ((k / this.pw) | 0)) % 9 < 3 ? 1.5 : 1;
        r = 48 * s * hatch; g = 56 * s * hatch; b = 70 * s * hatch;
      } else {
        const value = raw * codecScale + codecOffset;
        let idx = (((value - lo) / span) * (LUT_STEPS - 1)) | 0;
        if (idx < 0) idx = 0; else if (idx >= LUT_STEPS) idx = LUT_STEPS - 1;
        const c = lut[idx];
        r = (c & 255) * s;
        g = ((c >> 8)  & 255) * s;
        b = ((c >> 16) & 255) * s;
      }

      const lat = j * 2 - 89;
      const inRegion = !whole && lat >= la0 && lat <= la1
        && (lo0 <= lo1 ? (lon >= lo0 && lon <= lo1) : (lon >= lo0 || lon <= lo1));

      if (edge[k] || ((lon + 180) / 2) % 1 < 0.06) { r *= 0.74; g *= 0.74; b *= 0.8; }
      if (coast)    { r = r * 0.35 + 150; g = g * 0.35 + 168; b = b * 0.35 + 190; }
      if (inRegion) { r = r * 0.72 +  50; g = g * 0.72 + 110; b = b * 0.72 + 110; }
      // Highlight the row currently being scanned (latitude sweep axis only).
      // sweepRow is -1 on a time axis, so this is a no-op there.
      if (j === sweepRow) { r = r * 0.62 + 96; g = g * 0.62 + 104; b = b * 0.62 + 112; }

      // Clamp before packing — a channel over 255 carries into the next
      // channel when assembled with shifts, turning e.g. saturated red into teal.
      px32[k] = 0xff000000
        | (clamp255(b) << 16)
        | (clamp255(g) <<  8)
        | clamp255(r);
    }

    const g2 = this.g;
    g2.setTransform(1, 0, 0, 1, 0, 0);
    g2.fillStyle = INK.surface;
    g2.fillRect(0, 0, this.pw, this.ph);
    this._drawStars(g2);
    this._drawAtmosphere(g2);
    // drawImage composites; putImageData would erase the stars and atmosphere.
    this.scratchCtx.putImageData(this.image, 0, 0);
    g2.drawImage(this.scratch, 0, 0);
    this._drawRim(g2);
  }

  /** @param {CanvasRenderingContext2D} g2 */
  _drawStars(g2) {
    g2.save();
    for (const s of this._stars) {
      g2.globalAlpha = s.a;
      g2.fillStyle = '#cfe4ff';
      g2.fillRect(s.x, s.y, s.r, s.r);
    }
    g2.restore();
  }

  _drawAtmosphere(g2) {
    const grad = g2.createRadialGradient(
      this.cx, this.cy, this.r * 0.97,
      this.cx, this.cy, this.r * 1.13
    );
    grad.addColorStop(0, 'rgba(79,209,197,0.30)');
    grad.addColorStop(1, 'rgba(79,209,197,0)');
    g2.fillStyle = grad;
    g2.beginPath();
    g2.arc(this.cx, this.cy, this.r * 1.13, 0, Math.PI * 2);
    g2.fill();
  }

  /** @param {CanvasRenderingContext2D} g2 */
  _drawRim(g2) {
    g2.save();
    g2.strokeStyle = 'rgba(79,209,197,0.45)';
    g2.lineWidth = Math.max(1, this.pw / 600);
    g2.beginPath();
    g2.arc(this.cx, this.cy, this.r, 0, Math.PI * 2);
    g2.stroke();
    g2.restore();
  }
}

function clamp255(v) {
  return v > 255 ? 255 : v > 0 ? v | 0 : 0;
}

function buildLut(scale) {
  const lut = new Uint32Array(LUT_STEPS);
  for (let i = 0; i < LUT_STEPS; i++) {
    const value = scale.lo + (i / (LUT_STEPS - 1)) * (scale.hi - scale.lo);
    const m = scale.colourAt(value).match(/\d+/g);
    lut[i] = (+m[2] << 16) | (+m[1] << 8) | +m[0];
  }
  return lut;
}

function makeStars(w, h) {
  const out = [];
  const n = Math.round((w * h) / 26000);
  for (let i = 0; i < n; i++) {
    out.push({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() < 0.8 ? 1 : 2,
      a: 0.18 + Math.random() * 0.5,
    });
  }
  return out;
}