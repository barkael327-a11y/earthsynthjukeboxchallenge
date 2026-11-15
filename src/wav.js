/**
 * wav.js - encode float audio buffers as RIFF/WAVE files.
 *
 * Used by the offline validator to export rendered audio for independent
 * analysis. No DOM, no AudioContext: pure typed-array arithmetic so
 * node --test can exercise this directly.
 *
 * Default format is 32-bit float (format 3). Pass bitDepth: 16 for signed PCM
 * if you need broad player compatibility.
 */

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;

/**
 * @param {Float32Array[]} channels one array per channel, all same length
 * @param {number} sampleRate
 * @param {{bitDepth?: 16|32}} [opts]
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate, { bitDepth = 32 } = {}) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TypeError('encodeWav: pass at least one channel');
  }
  if (bitDepth !== 16 && bitDepth !== 32) {
    throw new RangeError(`encodeWav: bitDepth must be 16 or 32, got ${bitDepth}`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`encodeWav: sampleRate must be positive, got ${sampleRate}`);
  }

  const frames = channels[0].length;
  for (const c of channels) {
    if (c.length !== frames) {
      throw new RangeError('encodeWav: every channel must have the same length');
    }
  }

  const nch = channels.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = nch * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  let p = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };
  const u32 = (v) => { view.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { view.setUint16(p, v, true); p += 2; };

  str('RIFF'); u32(36 + dataBytes);
  str('WAVE');
  str('fmt '); u32(16);
  u16(bitDepth === 32 ? FORMAT_FLOAT : FORMAT_PCM);
  u16(nch); u32(sampleRate); u32(sampleRate * blockAlign);
  u16(blockAlign); u16(bitDepth);
  str('data'); u32(dataBytes);

  if (bitDepth === 32) {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < nch; c++) {
        view.setFloat32(p, channels[c][f], true);
        p += 4;
      }
    }
  } else {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < nch; c++) {
        // Clamp before scaling - an out-of-range sample would wrap, not clip.
        const v = Math.max(-1, Math.min(1, channels[c][f]));
        view.setInt16(p, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        p += 2;
      }
    }
  }
  return buffer;
}

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{bitDepth?: 16|32}} [opts]
 */
export function wavBlob(channels, sampleRate, opts) {
  return new Blob([encodeWav(channels, sampleRate, opts)], { type: 'audio/wav' });
}

/** @param {AudioBuffer} audioBuffer @returns {Float32Array[]} */
export function channelsOf(audioBuffer) {
  const out = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    out.push(audioBuffer.getChannelData(c));
  }
  return out;
}

/**
 * Trigger a browser download.
 * @param {Blob} blob
 * @param {string} filename
 */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}