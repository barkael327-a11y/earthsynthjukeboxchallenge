/**
 * palette.js - colour scales for the data field.
 *
 * Two kinds, and choosing between them is a claim about the data:
 *
 *   diverging  - the value is a departure from a stated reference and its sign
 *                matters. Neutral grey midpoint so zero reads as "nothing".
 *   sequential - the value is a magnitude on a published bar with no special
 *                interior value. One hue, light to dark.
 *
 * Lightness rises away from the midpoint in both directions because the page is
 * dark: on a dark surface, magnitude reads as distance from the background.
 *
 * Absent cells get the page colour and a texture rather than a step on the
 * scale. "No observation" must not look like a small anomaly.
 *
 * @module palette
 */

/**
 * Steps outward from the neutral midpoint. Index 0 is the midpoint itself.
 *
 * Both arms run L = 0.475, 0.622, 0.717, 0.812, 0.905 in OKLab. Off-the-shelf
 * reds sit about 0.05 L darker than the matching blues, which makes warming
 * look stronger than cooling before anyone has read a number, so the warm arm
 * was re-stepped to match.
 */
const COOL = ['#39404c', '#2a5f93', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
const WARM = ['#39404c', '#943c35', '#e84242', '#fd7171', '#f4acac', '#fcd4d4'];

/**
 * Sequential ramps for quantities with no meaningful zero - sea surface
 * temperature, NO2 column density. Rendering those on the diverging scale would
 * invent a polarity the data doesn't have.
 *
 * Reversed for the dark surface: low values sit close to the plane colour, high
 * values furthest from it.
 */
const SEQUENTIAL = Object.freeze({
  teal:   ['#17313b', '#1b5566', '#1f7d92', '#35a7b4', '#6fcbd0', '#b6e8e6'],
  ember:  ['#2a1d33', '#5b2352', '#93306a', '#c54a6b', '#e87f62', '#f6c58a'],
  violet: ['#1d2140', '#34306b', '#55408f', '#7b57a8', '#a67cc4', '#d0abdd'],
});

/** The anomaly, in degrees C, at which each arm reaches its outermost step. */
export const DEFAULT_EXTENT = 3;

/** @param {string} hex @returns {[number,number,number]} */
function rgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

const COOL_RGB = COOL.map(rgb);
const WARM_RGB = WARM.map(rgb);

/**
 * Colour for an anomaly, interpolated within the arm.
 *
 * @param {number} value anomaly in degrees C
 * @param {number} [extent] value at which the scale saturates
 * @returns {string} css rgb()
 */
export function anomalyColour(value, extent = DEFAULT_EXTENT) {
  const arm = value < 0 ? COOL_RGB : WARM_RGB;
  const t = Math.min(Math.abs(value) / extent, 1) * (arm.length - 1);
  const i = Math.min(Math.floor(t), arm.length - 2);
  const f = t - i;
  const a = arm[i];
  const b = arm[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/**
 * Fill a canvas gradient with the scale, for the colour bar.
 * @param {CanvasRenderingContext2D} g
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {number} [extent]
 */
export function rampGradient(g, x0, y0, x1, y1, extent = DEFAULT_EXTENT) {
  const grad = g.createLinearGradient(x0, y0, x1, y1);
  const steps = 21;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    grad.addColorStop(t, anomalyColour((t * 2 - 1) * extent, extent));
  }
  return grad;
}

/**
 * A colour scale bound to one track's published range.
 *
 * Renderers take one of these rather than a bare extent, because the tracks
 * carry quantities that differ in kind, not just in units.
 *
 * `lo` and `hi` are the ends of the scale in the track's own units, so the
 * colour bar can be labelled with real numbers instead of "low" and "high".
 *
 * @param {object} spec
 * @param {'diverging'|'sequential'} spec.kind
 * @param {number} spec.lo
 * @param {number} spec.hi
 * @param {keyof typeof SEQUENTIAL} [spec.hue] sequential only
 * @param {string} [spec.units]
 */
export function makeScale({ kind, lo, hi, hue = 'teal', units = '' }) {
  if (!(hi > lo)) throw new RangeError(`palette: scale needs hi > lo, got ${lo}..${hi}`);
  if (kind === 'diverging') {
    // A diverging scale must be symmetric about its midpoint, or equal
    // departures in opposite directions get unequal colour.
    const extent = Math.max(Math.abs(lo), Math.abs(hi));
    return Object.freeze({
      kind, units, lo: -extent, hi: extent, extent,
      /** @param {number} v */
      colourAt: (v) => anomalyColour(v, extent),
      ticks: () => [extent, extent / 2, 0, -extent / 2, -extent],
    });
  }
  if (kind !== 'sequential') throw new RangeError(`palette: unknown scale kind "${kind}"`);
  const arm = (SEQUENTIAL[hue] ?? SEQUENTIAL.teal).map(rgb);
  return Object.freeze({
    kind, units, lo, hi, extent: hi - lo,
    /** @param {number} v */
    colourAt: (v) => {
      const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1) * (arm.length - 1);
      const i = Math.min(Math.floor(t), arm.length - 2);
      const f = t - i;
      const a = arm[i];
      const b = arm[i + 1];
      return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
    },
    ticks: () => [hi, lo + (hi - lo) * 0.75, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.25, lo],
  });
}

/** The scale the original single-track build used. Kept as the default. */
export const ANOMALY_SCALE = makeScale({
  kind: 'diverging', lo: -DEFAULT_EXTENT, hi: DEFAULT_EXTENT, units: '°C',
});

/**
 * Fill a gradient from any scale, for the colour bar.
 * @param {CanvasRenderingContext2D} g
 * @param {ReturnType<typeof makeScale>} scale
 */
export function scaleGradient(g, scale, x0, y0, x1, y1) {
  const grad = g.createLinearGradient(x0, y0, x1, y1);
  const steps = 21;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    grad.addColorStop(t, scale.colourAt(scale.lo + t * (scale.hi - scale.lo)));
  }
  return grad;
}

/** Chart chrome, matched to the dark surface this page renders on. */
export const INK = Object.freeze({
  surface: '#f2efdf',
  plane: '#f2efdf',
  primary: '#203d32',
  secondary: '#425840',
  muted: '#59664d',
  grid: '#becab1',
  axis: '#a8b79c',
  accent: '#315841',
});