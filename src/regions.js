/**
 * regions.js - region masks and area weighting.
 *
 * One function computes the area-weighted mean of a region, and both the
 * numeric readout and the oscillator read it. If the panel and the speaker
 * called different code, the two could disagree without anyone noticing.
 *
 * Two things that are easy to get wrong here:
 *
 *   1. Weight by cos(latitude). A naive mean over a regular lat/lon grid
 *      over-weights the poles badly: a 2x2 degree cell at 89N covers about
 *      1/57th the area of one at the equator.
 *
 *   2. Renormalise over observed cells only, and report what fraction of the
 *      region that was. The Arctic is 42% observed in 1880 and 100% from the
 *      1950s on; those must not sound equally confident. The coverage figure
 *      drives the uncertainty layer.
 *
 * @module regions
 */

import { makeContract } from './contract.js';

/** @typedef {import('./contract.js').Celsius} Celsius */

/**
 * @typedef {object} Grid
 * @property {number} nlat
 * @property {number} nlon
 * @property {number} latStart  latitude of the first cell centre
 * @property {number} latStep
 * @property {number} lonStart
 * @property {number} lonStep
 */

/**
 * @param {Grid} g
 * @param {number} j row index
 * @returns {number} latitude of the cell centre
 */
export const latOf = (g, j) => g.latStart + j * g.latStep;

/**
 * @param {Grid} g
 * @param {number} i column index
 * @returns {number} longitude of the cell centre
 */
export const lonOf = (g, i) => g.lonStart + i * g.lonStep;

/**
 * cos(latitude) per cell, as a flat Float64Array of length nlat*nlon.
 * Computed once at load; it never changes.
 * @param {Grid} g
 */
export function areaWeights(g) {
  const w = new Float64Array(g.nlat * g.nlon);
  if (g.kind === 'image') {
    // Rows and columns of a published picture, not latitude and longitude. A
    // regional frame whose geographic bounds NASA did not state can't be
    // georeferenced, so it's weighted uniformly and labelled as an image.
    // Applying cos(latitude) to a row index would give a confident wrong answer.
    w.fill(1);
    return w;
  }
  for (let j = 0; j < g.nlat; j++) {
    const c = Math.cos((latOf(g, j) * Math.PI) / 180);
    w.fill(c, j * g.nlon, (j + 1) * g.nlon);
  }
  return w;
}

/**
 * A region, ready to average over.
 *
 * @typedef {object} Region
 * @property {string} id
 * @property {string} label
 * @property {{lat:number[], lon:number[]}} bounds realised cell-edge bounds
 * @property {Uint8Array} mask 1 where the cell belongs to the region
 * @property {number} totalWeight sum of weights over the whole region
 * @property {number} cells
 * @property {ReturnType<typeof makeContract>} contract slope bound for this region
 * @property {string} weighting human-readable description, for the legend
 */

/**
 * Build a region from its published definition.
 *
 * @param {{id:string,label:string,kappa:number,bounds:{lat:number[],lon:number[]},
 *          requested_bounds?:{lat:number[],lon:number[]}}} def
 * @param {Grid} g
 * @param {Float64Array} weights
 * @returns {Region}
 */
export function makeRegion(def, g, weights, terms = {}) {
  const [la0, la1] = def.requested_bounds?.lat ?? def.bounds.lat;
  const [lo0, lo1] = def.requested_bounds?.lon ?? def.bounds.lon;

  const mask = new Uint8Array(g.nlat * g.nlon);
  // Per-row totals, so a latitude scan reports coverage against the weight of
  // the row it's on rather than the whole region. Without this a fully observed
  // row at 70N reads as 2% coverage: true of the region, false of what's
  // actually sounding.
  const rowWeights = new Float64Array(g.nlat);
  let totalWeight = 0;
  let cells = 0;
  for (let j = 0; j < g.nlat; j++) {
    const lat = latOf(g, j);
    if (lat < la0 || lat > la1) continue;
    for (let i = 0; i < g.nlon; i++) {
      const lon = lonOf(g, i);
      if (lon < lo0 || lon > lo1) continue;
      const k = j * g.nlon + i;
      mask[k] = 1;
      rowWeights[j] += weights[k];
      totalWeight += weights[k];
      cells++;
    }
  }
  if (cells === 0) throw new Error(`region ${def.id} selects no cells`);

  const cellLabel = g.kind === 'image'
    ? `${cells} cells of the frame`
    : `${Math.abs(g.latStep)}°×${Math.abs(g.lonStep)}°`;
  return Object.freeze({
    id: def.id,
    label: def.label,
    bounds: def.bounds,
    mask,
    rowWeights,
    totalWeight,
    cells,
    contract: makeContract({ ...terms, slope: def.slope, label: def.label, id: def.id }),
    weighting: g.kind === 'image'
      ? `uniform mean over ${cellLabel}`
      : `area-weighted by cos(latitude) over ${cells} cells of ${cellLabel}`,
  });
}

/**
 * Area-weighted mean of one timestep of the field over one region.
 *
 * The readout calls this, the oscillator calls this, and the load-time
 * verification calls this. Nothing else computes a regional value.
 *
 * @param {Int16Array} field flat [step][lat][lon] payload
 * @param {number} t step index
 * @param {Region} region
 * @param {Float64Array} weights
 * @param {{scale:number, fill:number, cellsPerFrame:number, offset?:number}} codec
 * @param {number} [row] latitude row to restrict to; -1 means the whole region.
 *   A still frame is scanned row by row rather than played year by year, and the
 *   scan must average the same way the record does.
 * @param {number} [nlon] cells per row; required when row is given
 * @returns {{value:Celsius|null, coverage:number, observedCells:number}}
 *   value is null when nothing in the region was observed at that step. A null
 *   is silence and must never be rendered as a number.
 */
export function regionMean(field, t, region, weights, codec, row = -1, nlon = 0) {
  const { scale, fill, cellsPerFrame } = codec;
  const offset = codec.offset ?? 0;
  const base = t * cellsPerFrame;
  const mask = region.mask;

  const from = row >= 0 ? row * nlon : 0;
  const to = row >= 0 ? from + nlon : cellsPerFrame;
  const denominator = row >= 0 ? region.rowWeights[row] : region.totalWeight;

  let sum = 0;
  let weight = 0;
  let observedCells = 0;

  for (let k = from; k < to; k++) {
    if (mask[k] === 0) continue;
    const raw = field[base + k];
    if (raw === fill) continue;          // absent cells contribute nothing, not zero
    const w = weights[k];
    sum += (raw * scale + offset) * w;
    weight += w;
    observedCells++;
  }

  if (weight === 0 || denominator === 0) {
    return { value: null, coverage: 0, observedCells: 0 };
  }
  return {
    value: /** @type {Celsius} */ (sum / weight),
    coverage: weight / denominator,
    observedCells,
  };
}