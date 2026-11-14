/**
 * contract.js — the EarthSynth sonification contract.
 *
 * This file is the ONLY definition of the relationship between a temperature
 * anomaly and the audible quantity that encodes it. The audio path, the live
 * validator and the offline validator all import it. Do not restate the
 * formula anywhere else: a second copy will drift, and the drift will be
 * silent.
 *
 * WHAT CARRIES THE MEASUREMENT
 *
 * Spectral tilt — the level ratio between two sine partials at FIXED
 * frequencies, 220 Hz and 880 Hz:
 *
 *     tilt(dT) = SLOPE * dT          decibels
 *     dT(tilt)  = tilt / SLOPE       degrees Celsius
 *
 * At an anomaly of exactly 0.00 °C the two partials sit at equal level, so the
 * tilt is 0 dB. Warming moves energy toward the upper partial; cooling toward
 * the lower one.
 *
 * WHY A RATIO, AND WHY NOT PITCH
 *
 * Pitch is the most precisely recoverable property audio has, and an earlier
 * version of this instrument used it. It was rejected on musical grounds: data
 * driving pitch makes a pad sound unsettled, because every harmonic
 * relationship in the music is then hostage to the measurement. Fixing the
 * pitch to ordinary notes and moving the measurement into timbre is what makes
 * an ambient piece possible.
 *
 * A ratio, rather than an absolute level, because a ratio is immune to
 * everything downstream of it. Both partials pass through the same mixer, the
 * same reverb send and the same volume knob, so all of those cancel. An
 * absolute amplitude would be destroyed by the listener turning the volume
 * down; the tilt would not move at all.
 *
 * Two fixed frequencies, rather than "the filter cutoff", because a cutoff is
 * a knob and not an observable. You cannot read a cutoff out of rendered audio
 * without assuming what went into the filter. Two known partials can be
 * measured directly, whatever else is playing.
 *
 * 220 and 880 Hz are two octaves apart with a geometric mean of 440 Hz, which
 * keeps the original anchor: 440 Hz is still the centre of the mapping, now as
 * the midpoint of the pair rather than as a pitch. Both are A naturals, so the
 * carrier is consonant with every chord in the progression and reads as part
 * of the pad rather than as a test tone.
 *
 * WHAT THIS COSTS, STATED PLAINLY
 *
 * Pitch recovered the input to about 0.002 °C. The tilt recovers it to roughly
 * 0.002–0.02 °C depending on the slope in use — comparable, because the
 * partials are clean sines at known frequencies and a dB ratio is cheap to
 * measure precisely. What is genuinely lost is the LISTENER's ability to read
 * an absolute value: a person can compare two pitches against a remembered
 * anchor far better than two timbres. Relative judgements survive; absolute
 * reading by ear does not. The write-up says so rather than quietly dropping
 * the claim.
 *
 * @module contract
 */

/** A temperature anomaly in degrees Celsius, relative to the baseline. @typedef {number & {__brand:'Celsius'}} Celsius */
/** A level ratio in decibels. @typedef {number & {__brand:'Decibels'}} Decibels */
/** Decibels of tilt per degree Celsius. @typedef {number & {__brand:'Slope'}} Slope */

/** Lower carrier partial. @type {number} */
export const F_LOW = 220;
/** Upper carrier partial. Two octaves above, so the pair's geometric mean is 440 Hz. @type {number} */
export const F_HIGH = 880;
/** The anchor the pair is centred on, kept from the first design. */
export const F_ANCHOR = Math.sqrt(F_LOW * F_HIGH);   // exactly 440

/** The baseline the anomalies are relative to. An anomaly without its baseline is not a measurement. */
export const BASELINE = '1951-1980';

/** Anomalies are reported in degrees Celsius. GISTEMP labels them K; for a difference the two are identical. */
export const UNITS = '°C';

/**
 * Usable tilt range. Beyond about this the quieter partial falls far enough
 * below the other that measuring it stops being reliable, so a region whose
 * record would leave this band needs a gentler slope rather than a louder
 * claim.
 */
export const TILT_LIMIT = Object.freeze({ min: -40, max: 40 });

/**
 * @param {number} slope
 * @returns {number} the same value, validated
 */
function checkSlope(slope) {
  if (typeof slope !== 'number' || !Number.isFinite(slope) || slope <= 0) {
    throw new TypeError(
      `contract: slope must be a positive finite number of dB per ${UNITS}, got ${slope}. ` +
      `It is a property of the region and must be passed explicitly.`
    );
  }
  return slope;
}

/**
 * Anomaly to spectral tilt. The forward half of the contract.
 * @param {Celsius} dT anomaly in degrees C relative to {@link BASELINE}
 * @param {Slope} slope dB per degree C for this region
 * @returns {Decibels}
 */
export function toTilt(dT, slope) {
  checkSlope(slope);
  if (typeof dT !== 'number' || !Number.isFinite(dT)) {
    throw new TypeError(`contract.toTilt: anomaly must be a finite number, got ${dT}`);
  }
  return /** @type {Decibels} */ (slope * dT);
}

/**
 * Spectral tilt to anomaly. The inverse, used by both validators.
 * @param {Decibels} tilt 20*log10(upper / lower)
 * @param {Slope} slope
 * @returns {Celsius}
 */
export function toCelsius(tilt, slope) {
  checkSlope(slope);
  if (typeof tilt !== 'number' || !Number.isFinite(tilt)) {
    throw new TypeError(`contract.toCelsius: tilt must be a finite number of dB, got ${tilt}`);
  }
  return /** @type {Celsius} */ (tilt / slope);
}

/**
 * The two partial gains that realise a given anomaly.
 *
 * Split symmetrically about a constant total, so that warming does not simply
 * make everything louder: the upper partial rises by half the tilt while the
 * lower falls by half. Loudness therefore carries no information, which is
 * what makes the ratio the only thing a listener or a validator can read.
 *
 * @param {Celsius} dT
 * @param {Slope} slope
 * @param {number} [reference] linear gain each partial has at 0.00 °C
 * @returns {{low:number, high:number, tilt:Decibels}}
 */
export function partialGains(dT, slope, reference = 0.12) {
  const tilt = toTilt(dT, slope);
  // Solve for the pair that has the required ratio AND the same total energy
  // at every anomaly:  high/low = 10^(tilt/20),  low^2 + high^2 = 2*reference^2.
  //
  // Splitting the tilt symmetrically in decibels - low down by half, high up
  // by half - looks right and is wrong: the total then grows as cosh(tilt),
  // about 10 dB louder at the top of the global record. Loudness would be a
  // second, worse encoding of the same quantity, and the claim that only the
  // ratio is readable would be false.
  const ratio = Math.pow(10, tilt / 20);
  const low = reference * Math.sqrt(2 / (1 + ratio * ratio));
  return { low, high: low * ratio, tilt };
}

/**
 * Recover the anomaly from two measured magnitudes, in whatever linear unit
 * they share. The shared unit cancels, which is the point.
 * @param {number} lowMagnitude
 * @param {number} highMagnitude
 * @param {Slope} slope
 * @returns {Celsius}
 */
export function recover(lowMagnitude, highMagnitude, slope) {
  if (!(lowMagnitude > 0) || !(highMagnitude > 0)) {
    throw new RangeError('contract.recover: both magnitudes must be positive');
  }
  return toCelsius(/** @type {Decibels} */ (20 * Math.log10(highMagnitude / lowMagnitude)), slope);
}

/**
 * Smallest temperature difference an analysis of the given precision can
 * resolve, from the contract alone. Lets the on-screen tolerance be computed
 * from the actual measurement precision rather than typed in as a constant.
 * @param {Slope} slope
 * @param {number} dbPrecision how finely the magnitude ratio can be measured
 * @returns {Celsius}
 */
export function resolutionCelsius(slope, dbPrecision) {
  checkSlope(slope);
  return /** @type {Celsius} */ (dbPrecision / slope);
}

/**
 * Is this tilt inside the range where both partials stay measurable?
 * @param {Decibels} tilt
 */
export function inRange(tilt) {
  return tilt >= TILT_LIMIT.min && tilt <= TILT_LIMIT.max;
}

/**
 * The contract as prose, for the legend beside the player. A colour bar is not
 * a legend for a listener who cannot see it.
 *
 * @param {Slope} slope
 * @param {object} [t] the track's terms
 * @param {string} [t.units]
 * @param {number} [t.balanceAt] value at which the partials sit level
 * @param {string} [t.balanceLabel] what that value means, in words
 * @param {string} [t.rising] what an increase is called
 * @param {string} [t.falling] what a decrease is called
 */
export function legend(slope, t = {}) {
  checkSlope(slope);
  const units = t.units ?? UNITS;
  const at = t.balanceAt ?? 0;
  const meaning = t.balanceLabel ?? `the ${BASELINE} average`;
  const up = t.rising ?? 'warming';
  const down = t.falling ?? 'cooling';
  return (
    `Two tones sound together throughout, at ${F_LOW} Hz and ${F_HIGH} Hz — ` +
    `two octaves apart, centred on ${F_ANCHOR} Hz. At ${at.toFixed(2)} ${units}, ` +
    `${meaning}, they are equally loud. Every ${units} of ${up} ` +
    `shifts ${slope} dB of balance from the lower tone to the upper one, and every ` +
    `${units} of ${down} shifts it back. Their pitches never change: only the balance ` +
    `between them carries the measurement, which is why turning the volume up or down ` +
    `cannot alter it.`
  );
}

/**
 * The one-line form for the header chip.
 * @param {Slope} slope
 * @param {{units?:string, balanceAt?:number}} [t]
 */
export function shortLabel(slope, t = {}) {
  const units = t.units ?? UNITS;
  const at = t.balanceAt ?? 0;
  checkSlope(slope);
  return `${F_LOW}/${F_HIGH} Hz balanced at ${at.toFixed(2)} ${units} · ${slope} dB / ${units}`;
}

/**
 * Bind the slope and the track's terms once, so a region's contract can be
 * passed around as a value and two parts of the instrument can never disagree
 * about it.
 *
 * `balanceAt` is the value at which the two partials sit level — the audible
 * zero. For GISTEMP it is 0.00 °C, the baseline itself, which is why the
 * original single-track build never needed the parameter. A track whose
 * published bar runs 0 to 32 °C has no such natural zero: balancing at 0 would
 * put the entire record on one side of the contract and push the tilt past the
 * range where both partials stay measurable. Such a track declares its own
 * balance point, and the legend says what that point is rather than letting
 * the listener assume it means "nothing".
 *
 * @param {{slope:Slope, label?:string, id?:string, units?:string,
 *          baseline?:string, balanceAt?:number, balanceLabel?:string,
 *          rising?:string, falling?:string}} spec
 */
export function makeContract({
  slope, label = '', id = '',
  units = UNITS, baseline = BASELINE, balanceAt = 0, balanceLabel = '',
  rising = 'warming', falling = 'cooling',
}) {
  checkSlope(slope);
  if (typeof balanceAt !== 'number' || !Number.isFinite(balanceAt)) {
    throw new TypeError(`contract: balanceAt must be a finite number, got ${balanceAt}`);
  }
  const terms = { units, balanceAt, balanceLabel: balanceLabel || undefined, rising, falling };
  return Object.freeze({
    id,
    label,
    slope,
    fLow: F_LOW,
    fHigh: F_HIGH,
    fAnchor: F_ANCHOR,
    baseline,
    units,
    balanceAt,
    balanceLabel,
    /** Value to tilt. The departure from the balance point is what is encoded. */
    toTilt: (v) => toTilt(/** @type {Celsius} */ (v - balanceAt), slope),
    /** Tilt back to a value in the track's own units. */
    toValue: (tilt) => balanceAt + toCelsius(tilt, slope),
    /** Kept under its original name: the GISTEMP track's units are degrees. */
    toCelsius: (tilt) => balanceAt + toCelsius(tilt, slope),
    /** @param {number} v @param {number} [reference] linear gain at the balance point */
    partialGains: (v, reference) =>
      partialGains(/** @type {Celsius} */ (v - balanceAt), slope, reference),
    /** @param {number} lo @param {number} hi */
    recover: (lo, hi) => balanceAt + recover(lo, hi, slope),
    /** @param {number} dbPrecision */
    resolutionCelsius: (dbPrecision) => resolutionCelsius(slope, dbPrecision),
    legend: () => legend(slope, terms),
    shortLabel: () => shortLabel(slope, terms),
  });
}
