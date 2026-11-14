/**
 * earth-series.js - load the committed payload and sample it.
 *
 * One Int16Array holds the whole record. The map renders from it and the
 * oscillator's frequency is computed from it, so the pixel under the cursor and
 * the pitch in the speaker are the same number. Everything downstream reads this
 * module; nothing else decodes the payload.
 *
 * Ported from CosmicSynth's GWSeries with two changes:
 *
 *   - GWSeries.sampleAt() returned an interpolated frame with no indication it
 *     was interpolated. Harmless for GW audio at 4096 Hz; not harmless for a
 *     sparse 1880s temperature field, where an infilled cell must never sound
 *     like an observation. sampleAt() here returns an `observed` flag beside
 *     the value and the audio path acts on it.
 *
 *   - GWSeries.finalise() computed a single dt from the endpoints, assuming
 *     uniform spacing. The year axis is uniform, but that assumption is written
 *     down here rather than left implicit, and the axis is stored.
 *
 * @module earth-series
 */

import { makeRegion, areaWeights, regionMean, latOf, lonOf } from './regions.js';

/** @typedef {import('./contract.js').Celsius} Celsius */
/** @typedef {import('./regions.js').Region} Region */
/** @typedef {import('./regions.js').Grid} Grid */

const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Fetch a binary file and gunzip it if it arrives still compressed.
 *
 * Servers disagree about `.gz`: GitHub Pages serves it as an opaque body, which
 * is what we want, while Python's http.server guesses from the extension and
 * sets Content-Encoding: gzip, so the browser inflates it before we see it.
 * Decompressing an already-decompressed buffer throws, and it only fails on one
 * of the two servers. Checking the magic bytes makes the loader correct on both.
 *
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchMaybeGzipped(url, transfer) {
  const buf = transfer === 'base64-json'
    ? await fetchBase64Json(url)
    : await fetchBinary(url);

  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  const looksGzipped = head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
  if (!looksGzipped) return buf;              // the transport already inflated it

  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      `${url} arrived gzipped and this browser has no DecompressionStream. ` +
      `Commit an uncompressed field.i16 beside it and point the loader there.`
    );
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

/** @param {string} url */
async function fetchBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

/**
 * Some static hosts serve only a fixed set of extensions and refuse binary
 * payloads. Where that's the case the same bytes ship base64-encoded inside a
 * JSON envelope, at a cost of a third more over the wire. The payload is
 * unchanged - still gzipped, still int16 - so the sha256 in meta.json and the
 * load-time verification both still apply.
 *
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchBase64Json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const { data } = await res.json();
  if (typeof data !== 'string') throw new Error(`${url}: expected a "data" string`);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * What the transport moves along.
 *
 * The original build had one answer, years, and hardcoded it. There are now
 * two, because most EIC tracks are stills. A published frame has no time axis
 * to play, so the alternative is to play space: sweep the frame latitude band
 * by latitude band, sounding the area-weighted mean of each. That turns a
 * single image into twenty seconds of listening and makes the physical
 * structure of the frame audible - the warm equatorial belt of a sea-surface
 * map, the industrial band across the northern mid-latitudes in NO2. Nothing
 * about the mapping changes: same contract, same area weighting, same silence
 * where there is no data.
 *
 * locate(step) is the whole abstraction. It says which payload frame a step
 * reads and which latitude row of it, if any. Everything downstream averages
 * identically for both kinds.
 *
 * @param {any} meta
 * @param {Grid} grid
 */
function makeAxis(meta, grid) {
  const spec = meta.axis ?? { kind: 'time' };

  if (spec.kind === 'scan-lat') {
    const image = grid.kind === 'image';
    // Top to bottom, so the sweep runs the way the globe is drawn and the way
    // a reader scans a map.
    const step = -Math.abs(grid.latStep);
    const start = grid.latStart + (grid.nlat - 1) * Math.abs(grid.latStep);
    return Object.freeze({
      kind: 'scan-lat',
      count: grid.nlat,
      start,
      step,
      unit: image ? '' : '°',
      noun: image ? 'row' : 'latitude',
      /** @param {number} t */
      locate: (t) => ({ frame: spec.frame ?? 0, row: grid.nlat - 1 - Math.round(t) }),
      format: image
        ? (v) => `row ${grid.nlat - Math.round(v)} of ${grid.nlat}`
        : (v) => `${Math.abs(v).toFixed(0)}°${v < 0 ? 'S' : 'N'}`,
      speak: image
        ? (v) => `row ${grid.nlat - Math.round(v)} of ${grid.nlat}`
        : (v) => `${Math.abs(v).toFixed(0)} degrees ${v < 0 ? 'south' : 'north'}`,
    });
  }

  if (spec.kind !== 'time' && spec.kind !== undefined) {
    throw new Error(`unknown axis kind "${spec.kind}"`);
  }
  const t = meta.time ?? {};
  return Object.freeze({
    kind: 'time',
    count: t.count,
    start: t.year_start,
    step: 1,
    unit: '',
    noun: t.cadence === 'frame' ? 'frame' : 'year',
    /** @param {number} s */
    locate: (s) => ({ frame: Math.round(s), row: -1 }),
    /** @param {number} v */
    format: (v) => String(Math.round(v)),
    /** @param {number} v */
    speak: (v) => String(Math.round(v)),
  });
}

/**
 * @typedef {object} Sample
 * @property {Celsius|null} value  null means not observed; it is silence, never a number
 * @property {boolean} observed
 * @property {number} coverage     fraction of the region's area that was observed
 * @property {number} year         the (possibly fractional) year this sample stands for
 * @property {boolean} interpolated true when the sample lies between two annual steps
 */

export class EarthSeries {
  /**
   * @param {object} parts
   * @param {any} parts.meta
   * @param {any} parts.regionDefs
   * @param {any} parts.index
   * @param {Int16Array} parts.field
   * @param {Uint8Array} parts.landfrac
   */
  constructor({ meta, regionDefs, index, field, landfrac, terms = {} }) {
    this.meta = meta;
    this.index = index;
    this.field = field;
    this.landfrac = landfrac;
    this.terms = terms;

    /** @type {Grid} */
    this.grid = {
      nlat: meta.grid.nlat,
      nlon: meta.grid.nlon,
      latStart: meta.grid.lat_start,
      latStep: meta.grid.lat_step,
      lonStart: meta.grid.lon_start,
      lonStep: meta.grid.lon_step,
      // 'geo' cells are latitude and longitude and get cos(latitude) weighting
      // and a globe. 'image' cells are rows and columns of a published frame
      // whose geographic bounds were never stated, so they get neither.
      kind: meta.grid.kind === 'image' ? 'image' : 'geo',
    };
    this.cellsPerFrame = this.grid.nlat * this.grid.nlon;

    this.codec = {
      scale: meta.field.scale_factor,
      // A frame recovered from a colour bar carries the bar's own minimum as an
      // offset, so the int16 counts stay small and positive across the whole
      // published range. GISTEMP needs none and declares none.
      offset: meta.field.offset ?? 0,
      fill: meta.field.fill_value,
      cellsPerFrame: this.cellsPerFrame,
    };

    this.axis = makeAxis(meta, this.grid);
    this.count = this.axis.count;

    // Kept under their original names: the GISTEMP track is still a year axis
    // and the trend chart, the timeline and the tests all read these.
    this.yearStart = this.axis.start;
    this.yearEnd = this.axis.start + this.axis.step * (this.axis.count - 1);
    this.yearStep = this.axis.step;

    this.weights = areaWeights(this.grid);

    /** @type {Map<string, Region>} */
    this.regions = new Map();
    for (const def of regionDefs.regions) {
      this.regions.set(def.id, makeRegion(def, this.grid, this.weights, terms));
    }

    // Cached once at load, as GWSeries.finalise() cached maxAbsH and maxFgw.
    // A per-frame rescale is exactly what an anchored mapping forbids.
    /** @type {Map<string, {series:Float64Array, coverage:Float64Array, min:number, max:number}>} */
    this.cache = new Map();
    for (const [id, region] of this.regions) {
      this.cache.set(id, this.#computeRegionSeries(region));
    }
  }

  /**
   * Area-weighted series for one region, computed here in the browser from the
   * one array. Nothing is read from the published check values.
   * @param {Region} region
   */
  #computeRegionSeries(region) {
    const series = new Float64Array(this.count).fill(NaN);
    const coverage = new Float64Array(this.count);
    let min = Infinity;
    let max = -Infinity;

    for (let t = 0; t < this.count; t++) {
      const { frame, row } = this.axis.locate(t);
      const r = regionMean(
        this.field, frame, region, this.weights, this.codec, row, this.grid.nlon,
      );
      coverage[t] = r.coverage;
      if (r.value !== null) {
        series[t] = r.value;
        if (r.value < min) min = r.value;
        if (r.value > max) max = r.value;
      }
    }
    return { series, coverage, min, max };
  }

  /** @param {string} id */
  region(id) {
    const r = this.regions.get(id);
    if (!r) throw new Error(`unknown region "${id}"`);
    return r;
  }

  /** The axis values, for the timeline and the trend chart. */
  years() {
    return Array.from({ length: this.count }, (_, i) => this.axis.start + this.axis.step * i);
  }

  /** The axis value at a (possibly fractional) step, printed. */
  labelAt(index) {
    return this.axis.format(this.axis.start + this.axis.step * index);
  }

  /** Observed range of a region over the whole record. Cached at load. */
  rangeOf(id) {
    const c = this.cache.get(id);
    if (!c) throw new Error(`unknown region "${id}"`);
    return { min: c.min, max: c.max };
  }

  /**
   * Sample a region at a (possibly fractional) year index.
   *
   * Scrubbing lands between annual steps, so the value is linearly interpolated
   * and flagged as such. If either neighbouring year is unobserved the sample is
   * unobserved: inventing a number across a gap is the failure this project
   * exists to avoid.
   *
   * @param {string} id
   * @param {number} tIndex fractional index into the year axis
   * @returns {Sample}
   */
  sampleAt(id, tIndex) {
    const c = this.cache.get(id);
    if (!c) throw new Error(`unknown region "${id}"`);

    const clamped = Math.min(Math.max(tIndex, 0), this.count - 1);
    const i0 = Math.floor(clamped);
    const i1 = Math.min(i0 + 1, this.count - 1);
    const frac = clamped - i0;
    const year = this.axis.start + this.axis.step * clamped;

    const a = c.series[i0];
    const b = c.series[i1];
    const interpolated = frac > 0 && i0 !== i1;

    if (Number.isNaN(a) || (interpolated && Number.isNaN(b))) {
      return { value: null, observed: false, coverage: c.coverage[i0], year, interpolated };
    }
    const value = interpolated ? a + (b - a) * frac : a;
    const coverage = interpolated
      ? c.coverage[i0] + (c.coverage[i1] - c.coverage[i0]) * frac
      : c.coverage[i0];

    return {
      value: /** @type {Celsius} */ (value),
      observed: true,
      coverage,
      year,
      interpolated,
    };
  }

  /**
   * One cell at one transport step. Used by the map and, eventually, by
   * per-cell picking.
   *
   * The step is not a frame index: a still swept by latitude has one frame and
   * many steps, so the frame has to come from axis.locate(). Single-cell
   * anomalies reach +/-16 C, far outside the band any region kappa is tuned for.
   *
   * @param {number} t transport step
   * @param {number} j latitude index
   * @param {number} i longitude index
   */
  cellAt(t, j, i) {
    const { frame } = this.axis.locate(t);
    const raw = this.field[frame * this.cellsPerFrame + j * this.grid.nlon + i];
    if (raw === this.codec.fill) {
      return { value: null, observed: false, lat: latOf(this.grid, j), lon: lonOf(this.grid, i) };
    }
    return {
      value: /** @type {Celsius} */ (raw * this.codec.scale + this.codec.offset),
      observed: true,
      lat: latOf(this.grid, j),
      lon: lonOf(this.grid, i),
    };
  }

  /** Land fraction 0-1 for a cell. Presentation only; carries no magnitude. */
  landAt(j, i) {
    return this.landfrac[j * this.grid.nlon + i] / 255;
  }

  /**
   * Check the decoded payload against the values recorded at preprocessing
   * time. Catches two independent failures:
   *
   *   - probes catch a wrong endianness or array layout, which would otherwise
   *     produce a plausible-looking field of wrong numbers;
   *   - the region series catch any disagreement between this browser's area
   *     weighting and the preprocessor's.
   *
   * The check values are never used as data. If this throws, the instrument is
   * wrong and should refuse to play rather than sound something unverified.
   *
   * @returns {{checked:number, worst:number, worstRegion:string}}
   */
  verify() {
    const v = this.meta.verification;
    const tol = v.tolerance ?? 1e-4;
    const units = this.terms.units ?? '°C';

    for (const probe of v.probes) {
      const got = this.field[probe.index];
      if (got !== probe.raw) {
        throw new Error(
          `payload probe at index ${probe.index} is ${got}, expected ${probe.raw}. ` +
          `The field was decoded with the wrong endianness or layout.`
        );
      }
    }

    let checked = 0;
    let worst = 0;
    let worstRegion = '';
    for (const [id, expected] of Object.entries(v.regions)) {
      const got = this.cache.get(id);
      if (!got) throw new Error(`meta.json verifies region "${id}" which is not defined`);
      const want = /** @type {(number|null)[]} */ (expected.series);
      if (want.length !== this.count) {
        throw new Error(
          `region "${id}" has ${want.length} check values for ${this.count} ${this.axis.noun}s`
        );
      }
      for (let t = 0; t < want.length; t++) {
        const a = want[t];
        const b = got.series[t];
        if (a === null) {
          if (!Number.isNaN(b)) throw new Error(`region "${id}" at ${this.labelAt(t)} should be unobserved`);
          continue;
        }
        if (Number.isNaN(b)) throw new Error(`region "${id}" at ${this.labelAt(t)} is unobserved but should be ${a}`);
        const d = Math.abs(a - b);
        if (d > worst) { worst = d; worstRegion = id; }
        checked++;
      }
    }
    if (worst > tol) {
      throw new Error(
        `region "${worstRegion}" differs from its check value by ${worst.toFixed(6)} ${units}, ` +
        `tolerance ${tol}. The browser and the preprocessor disagree about area weighting.`
      );
    }
    return { checked, worst, worstRegion };
  }
}

/**
 * Load the committed payload.
 *
 * @param {string} [base] directory holding the payload, relative to the page.
 *   Keep it relative: GitHub Project Pages serve from a subpath, so an absolute
 *   "/data/..." works locally and 404s in production.
 * @returns {Promise<EarthSeries>}
 */
export async function loadSeries(track = './data/') {
  const spec = typeof track === 'string' ? { path: track } : track;
  const base = spec.path.endsWith('/') ? spec.path : `${spec.path}/`;

  // Filenames come from meta.json rather than being hardcoded, because some
  // static hosts refuse to serve particular extensions. The loader identifies
  // gzip by its magic bytes, not by a ".gz" suffix, so the same bytes can be
  // served under whatever name a host will accept.
  const meta = await fetch(`${base}meta.json`).then((r) => r.json());
  const [regionDefs, index, fieldBuf, landBuf] = await Promise.all([
    fetch(`${base}regions.json`).then((r) => r.json()),
    // Published cross-check series, where the dataset has one. A frame
    // recovered from a colour bar has no published counterpart to sit beside.
    fetch(`${base}index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchMaybeGzipped(`${base}${meta.field.file}`, meta.field.transfer),
    fetchMaybeGzipped(`${base}${meta.landfrac.file}`, meta.landfrac.transfer),
  ]);

  const frames = meta.time.count;
  const expected = frames * meta.grid.nlat * meta.grid.nlon * 2;
  if (fieldBuf.byteLength !== expected) {
    throw new Error(
      `${base}${meta.field.file} inflates to ${fieldBuf.byteLength} bytes, expected ${expected} ` +
      `(${frames} × ${meta.grid.nlat} × ${meta.grid.nlon} × 2)`
    );
  }

  const series = new EarthSeries({
    meta,
    regionDefs,
    index,
    field: new Int16Array(fieldBuf),
    landfrac: new Uint8Array(landBuf),
    terms: spec.terms ?? {},
  });
  series.verify();
  series.track = spec;
  return series;
}