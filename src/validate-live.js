/**
 * validate-live.js - the residual, on screen, while the piece plays.
 *
 * The same check as the offline validator, made visible. It renders nothing and
 * assumes nothing about the data: it reads the audio actually leaving the
 * carrier, recovers a temperature from it through the contract's inverse, and
 * reports the difference from the value the instrument says it's sounding.
 *
 * Two sine partials sit at known, fixed frequencies. For each one, the energy
 * in the bins around it is summed and converted to decibels; the difference of
 * the two is the spectral tilt, and the contract inverts that to a temperature.
 *
 * Summing a window of bins rather than reading the single nearest bin is what
 * makes this accurate. Neither 220 nor 880 Hz lands exactly on a bin centre at
 * a typical sample rate, and a partial that falls between bins loses up to a
 * couple of decibels to scalloping - differently at each frequency, which would
 * put a fixed bias in the ratio. The analyser applies a Blackman window whose
 * main lobe is about six bins wide, so summing power across +/-4 bins captures
 * essentially all of each partial and the scalloping cancels.
 *
 * It isn't circular. The number on the left comes from the payload; the number
 * on the right comes from a spectrum of the rendered signal. Nothing computes
 * the second from the first. If the carrier were mis-scheduled, or the slope
 * applied twice, or the contract edited in one place and not another, the
 * residual would move.
 *
 * Both partials pass through the same gain stages, so any level change applies
 * to both and cancels in the difference. Turning the music up, sending more to
 * the reverb, or pulling the master fader cannot move this number.
 *
 * @module validate-live
 */

/** Bins either side of each partial included in the power sum. */
const WINDOW_BINS = 4;

/** Below this the carrier is silent, not quiet. */
const FLOOR_DB = -130;

/**
 * Measurement precision of the dB ratio, used to report the tolerance the
 * current slope buys. Conservative: the measured spread on a clean two-tone
 * render is smaller than this.
 */
export const DB_PRECISION = 0.05;

/**
 * Sum the power in the bins around a frequency and return it in decibels.
 *
 * Exported so the offline validator and the tests can run the identical
 * calculation on a spectrum from any source rather than reimplementing it. A
 * second copy would drift, and the drift would be silent.
 *
 * @param {Float32Array} db magnitudes in decibels, as getFloatFrequencyData gives them
 * @param {number} hz frequency of interest
 * @param {number} sampleRate
 * @param {number} fftSize
 * @returns {number} total power in dB, or -Infinity if there is nothing there
 */
export function bandPowerDb(db, hz, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const centre = Math.round(hz / binHz);
  let power = 0;
  for (let k = centre - WINDOW_BINS; k <= centre + WINDOW_BINS; k++) {
    if (k < 0 || k >= db.length) continue;
    const magnitude = Math.pow(10, db[k] / 20);
    power += magnitude * magnitude;
  }
  return power > 0 ? 10 * Math.log10(power) : -Infinity;
}

export class LiveValidator {
  /**
   * @param {AnalyserNode} analyser tapped on the carrier, before the mixer
   * @param {() => any} getContract returns the contract currently in force
   */
  constructor(analyser, getContract) {
    this.analyser = analyser;
    this.getContract = getContract;
    this.bins = new Float32Array(analyser.frequencyBinCount);
    this.sampleRate = analyser.context.sampleRate;
  }

  get windowSeconds() { return this.analyser.fftSize / this.sampleRate; }
  get binHz() { return this.sampleRate / this.analyser.fftSize; }

  /**
   * Read the spectrum once and recover a temperature from it.
   *
   * @param {{expectedValue:number|null, expectedTilt:number|null}} expected
   *   what the instrument believes it is currently sounding
   * @returns {null | {
   *   lowDb:number, highDb:number, tilt:number, expectedTilt:number,
   *   recovered:number, expected:number, residual:number, resolution:number,
   *   windowSeconds:number, binHz:number, withinTolerance:boolean
   * }}
   *   null when the carrier is silent - an absent year, or playback not
   *   started. Silence is reported as silence, never as a residual of zero.
   */
  measure(expected) {
    if (expected.expectedValue === null || expected.expectedTilt === null) return null;

    const contract = this.getContract();
    this.analyser.getFloatFrequencyData(this.bins);

    const lowDb = bandPowerDb(this.bins, contract.fLow, this.sampleRate, this.analyser.fftSize);
    const highDb = bandPowerDb(this.bins, contract.fHigh, this.sampleRate, this.analyser.fftSize);
    if (!Number.isFinite(lowDb) || !Number.isFinite(highDb)) return null;
    if (lowDb < FLOOR_DB && highDb < FLOOR_DB) return null;

    const tilt = highDb - lowDb;
    const recovered = contract.toCelsius(tilt);
    const residual = Math.abs(recovered - expected.expectedValue);
    const resolution = contract.resolutionCelsius(DB_PRECISION);

    return {
      lowDb,
      highDb,
      tilt,
      expectedTilt: expected.expectedTilt,
      recovered,
      expected: expected.expectedValue,
      residual,
      resolution,
      windowSeconds: this.windowSeconds,
      binHz: this.binHz,
      // The tolerance is derived from the slope in force and the analysis
      // precision, not typed in as a constant.
      withinTolerance: residual <= resolution * 4,
    };
  }
}