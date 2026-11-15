/**
 * Page smoke test: load index.html in jsdom with a stubbed Web Audio and
 * canvas, run app.js against the real payload, and check that the wiring
 * actually holds together.
 *
 * This does not test that anything looks right - jsdom has no renderer. It
 * tests the class of bug that costs an evening: a selector that matches
 * nothing, a data attribute that does not exist, a listener attached to null,
 * an exception thrown during the first render. Those are invisible to the unit
 * tests and obvious the moment a browser opens the page.
 *
 * jsdom is a devDependency used only here. Nothing the page ships depends on it.
 */
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A 2D context that records nothing and refuses nothing. */
function fakeCanvas2D() {
  const noop = () => {};
  return new Proxy({
    canvas: { width: 600, height: 300 },
    measureText: () => ({ width: 40 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
    setTransform: noop,
  }, {
    get: (target, prop) => (prop in target ? target[prop] : noop),
    set: () => true,
  });
}

class FakeParam {
  constructor(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) {
    if (!(v > 0)) throw new RangeError('exponential ramp to a non-positive value');
    this.value = v; return this;
  }
  setTargetAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
const audioNode = (extra = {}) => ({ connect() {}, disconnect() {}, ...extra });

class FakeAudioContext {
  constructor() {
    this.currentTime = 0; this.sampleRate = 48000;
    this.state = 'suspended'; this.destination = audioNode();
  }
  async resume() { this.state = 'running'; }
  createGain() { return audioNode({ gain: new FakeParam(1) }); }
  createOscillator() {
    return audioNode({
      frequency: new FakeParam(440), detune: new FakeParam(0),
      type: 'sine', start() {}, stop() {}, setPeriodicWave() {},
    });
  }
  createBiquadFilter() { return audioNode({ frequency: new FakeParam(350), Q: new FakeParam(1), gain: new FakeParam(0), type: 'lowpass' }); }
  createBufferSource() { return audioNode({ buffer: null, loop: false, start() {}, stop() {} }); }
  createAnalyser() {
    return audioNode({
      fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0, context: this,
      // Two partials, at the bins 220 Hz and 880 Hz land on for a 48 kHz
      // 8192-point analysis, so the validator finds a real ratio.
      getFloatFrequencyData(a) {
        a.fill(-150);
        for (let k = 34; k <= 42; k++) a[k] = -30;
        for (let k = 146; k <= 154; k++) a[k] = -22;
      },
    });
  }
  createBuffer(ch, len) { return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) }; }
  createDelay() { return audioNode({ delayTime: new FakeParam(0.5) }); }
  createStereoPanner() { return audioNode({ pan: new FakeParam(0) }); }
  createWaveShaper() { return audioNode({ curve: null, oversample: 'none' }); }
  createConvolver() { return audioNode({ buffer: null, normalize: true }); }
  createPeriodicWave() { return {}; }
}

/** Serve the repo's own files to the page's fetch(). */
function fileFetch() {
  return async (url) => {
    const path = join(ROOT, String(url).replace(/^\.\//, ''));
    const body = await readFile(path);
    return {
      ok: true, status: 200,
      json: async () => JSON.parse(body.toString('utf8')),
      text: async () => body.toString('utf8'),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

async function openPage() {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  window.HTMLCanvasElement.prototype.getContext = fakeCanvas2D;
  window.AudioContext = FakeAudioContext;
  window.fetch = fileFetch();
  window.DecompressionStream = globalThis.DecompressionStream;
  window.Blob = globalThis.Blob;
  window.Response = globalThis.Response;
  window.atob = globalThis.atob;
  // A pumpable frame queue. The app renders from a requestAnimationFrame loop
  // that runs continuously (the globe turns even while paused), so a stub that
  // never invokes its callback means nothing ever renders, and one that invokes
  // immediately recurses forever. Queue them and let each test drain as many as
  // it needs.
  const rafQueue = [];
  window.requestAnimationFrame = (cb) => rafQueue.push(cb);
  window.cancelAnimationFrame = () => {};
  const pump = (rounds = 3) => {
    for (let i = 0; i < rounds; i++) for (const cb of rafQueue.splice(0)) cb(Date.now());
  };

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  // Install the globals app.js closes over, then run it.
  const saved = {};
  // Note: `performance` is deliberately NOT copied across. jsdom's
  // performance.now() delegates to the global one, so installing it as the
  // global makes it call itself until the stack runs out.
  for (const k of ['document', 'window', 'fetch', 'AudioContext',
                   'requestAnimationFrame', 'cancelAnimationFrame', 'Blob',
                   'Response', 'DecompressionStream', 'atob', 'Path2D']) {
    saved[k] = globalThis[k];
    if (window[k] !== undefined) globalThis[k] = window[k];
  }
  globalThis.Path2D = window.Path2D ?? class { moveTo() {} lineTo() {} };

  await import('../src/app.js?page-test=' + Date.now());
  await new Promise((r) => setTimeout(r, 400));   // let loadSeries settle
  pump(4);

  return { window, document: window.document, errors, pump,
           restore: () => Object.assign(globalThis, saved) };
}

let page = null;
async function thePage() {
  if (!page) page = await openPage();
  return page;
}

test('the page loads the payload and reports no error banner', async () => {
  const { document } = await thePage();
  const banner = document.getElementById('error');
  assert.equal(banner.hidden, true,
    `the page refused to start: ${banner.textContent.slice(0, 200)}`);
});

test('every readout field in the markup is one the code writes to', async () => {
  const { document } = await thePage();
  const names = [...document.querySelectorAll('[data-ro]')].map((e) => e.dataset.ro);
  // A field present in the HTML but never written is dead markup; a field
  // written but absent is a silently dropped number. Both are typos.
  assert.ok(names.includes('value') && names.includes('tilt') && names.includes('vResidual'));
  for (const required of ['region', 'year', 'coverage', 'status', 'contractShort',
                          'contractLegend', 'vExpected', 'vMeasured', 'vRecovered', 'vNote']) {
    assert.ok(names.includes(required), `markup is missing [data-ro="${required}"]`);
  }
});

/** Click a track tab and let its payload load. */
async function selectTrack(id) {
  const { document, pump } = await thePage();
  const tab = [...document.querySelectorAll('[data-track]')].find((t) => t.dataset.track === id);
  assert.ok(tab, `no tab for track "${id}"`);
  tab.click();
  await new Promise((r) => setTimeout(r, 500));
  pump(2);
  return document;
}

const ro = (document, n) => document.querySelector(`[data-ro="${n}"]`).textContent;
const regionTabs = (document) => [...document.querySelectorAll('#regions [role="tab"]')];

// ---------------------------------------------------------------------------
// the catalogue
// ---------------------------------------------------------------------------

test('the catalogue is built from tracks.json, with one selected', async () => {
  const { document } = await thePage();
  const tabs = [...document.querySelectorAll('[data-track]')];
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs.map((t) => t.dataset.track), ['sst', 'no2']);
  assert.equal(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, 1);
  // Every entry states its tier on its face. Everything that ships is measured;
  // the tier is still shown because the claim is the point, and because a track
  // that could not make it would be refused at load rather than silently mixed
  // in among these.
  for (const t of tabs) {
    const tier = t.querySelector('small');
    assert.ok(tier, `track tab "${t.textContent}" shows no tier`);
    assert.equal(tier.textContent, 'Measured');
  }
});

test('every frame on display carries a description of itself', async () => {
  // The challenge exists because Earth science is delivered as pictures. An
  // undescribed picture in this player would reproduce the problem it is
  // meant to fix, so loadTracks() refuses a frame track without alt text and
  // this checks the rendered result rather than the manifest.
  const { document } = await thePage();
  const img = document.getElementById('frameImg');
  assert.equal(img.hidden, false, 'the EIC frame is not being shown');
  assert.ok(img.getAttribute('alt').length > 40,
    `frame alt text is "${img.getAttribute('alt')}"`);
  assert.match(document.getElementById('frameSource').href, /^https:\/\/svs\.gsfc\.nasa\.gov\//);
});

// ---------------------------------------------------------------------------
// the default track: sea surface temperature, recovered from an EIC frame
// ---------------------------------------------------------------------------

test('the first render fills in real numbers, not placeholders', async () => {
  const { document, pump } = await thePage();
  pump();
  assert.match(ro(document, 'value'), /^\d+\.\d\d$/, `value shows "${ro(document, 'value')}"`);
  assert.match(ro(document, 'tilt'), /^[+−]\d+\.\d$/, `tilt shows "${ro(document, 'tilt')}"`);
  assert.match(ro(document, 'carrier'), /220 \/ 880 Hz/);
  assert.match(ro(document, 'coverage'), /% observed/);
  assert.match(ro(document, 'contractShort'), /220\/880 Hz/);
  assert.match(ro(document, 'contractLegend'), /pitches never change/);
});

test('a sequential quantity is never printed with a sign', async () => {
  // A sea surface temperature of "+27.70" would assert a departure from a
  // reference that was never measured. Neither shipped track is an anomaly,
  // so nothing on the page should ever print a sign on a value.
  const { document, pump } = await thePage();
  pump();
  assert.doesNotMatch(ro(document, 'value'), /^[+−]/);
  assert.match(ro(document, 'valueUnit'), /°C/);
});

test('a still frame is played as a latitude sweep, not as time', async () => {
  // The EIC tracks are stills. A still has no time axis to play, so the
  // transport sweeps it north to south and the readout says where it is
  // rather than printing a year that does not exist.
  const { document } = await thePage();
  assert.match(ro(document, 'year'), /^\d+°[NS]$/, `axis label shows "${ro(document, 'year')}"`);
  assert.equal(document.getElementById('scrub').max, '89');
  assert.equal(document.getElementById('scanLine').hidden, false,
    'the sweep is not marked on the frame');
});

test('the contract balances at the middle of the published bar', async () => {
  const { document } = await thePage();
  // Zero is not a meaningful midpoint for a 0-32 °C bar, so this track
  // declares its own balance point and the legend says what it is.
  assert.match(ro(document, 'contractShort'), /balanced at 16\.00 °C/);
  assert.match(ro(document, 'contractLegend'), /middle of the published/);
});

test('the inversion error is published beside the track that depends on it', async () => {
  const { document } = await thePage();
  const note = document.getElementById('inversion');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /no more faithful than its own legend/);
});

test('region tabs are built from the payload, with one selected', async () => {
  const { document } = await thePage();
  const tabs = regionTabs(document);
  assert.equal(tabs.length, 4);
  assert.deepEqual(tabs.map((t) => t.textContent),
    ['Global', 'Tropics', 'N mid-latitudes', 'S mid-latitudes']);
  assert.equal(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, 1);
});

test('the scrub bar is a native range with a spoken value', async () => {
  const { document, pump } = await thePage();
  const scrub = document.getElementById('scrub');
  assert.equal(scrub.tagName, 'INPUT');
  assert.equal(scrub.type, 'range');
  scrub.value = '45';
  scrub.dispatchEvent(new (document.defaultView.Event)('input', { bubbles: true }));
  pump();
  assert.match(scrub.getAttribute('aria-valuetext'), /^\d+°S, /,
    `spoken value is "${scrub.getAttribute('aria-valuetext')}"`);
});

// ---------------------------------------------------------------------------
// switching tracks
// ---------------------------------------------------------------------------

test('switching to an image-grid track hides the globe and relabels the axis', async () => {
  // The NO2 still publishes no geographic bounds, so it is not drawn on a
  // globe and its sweep is labelled in rows rather than in degrees. Claiming
  // latitudes for it would be inventing the one number that makes a map.
  const document = await selectTrack('no2');
  assert.equal(document.getElementById('globeWrap').hidden, true);
  assert.match(ro(document, 'year'), /^row \d+ of 45$/, `axis shows "${ro(document, 'year')}"`);
  assert.equal(document.getElementById('scrub').max, '44');
  assert.match(ro(document, 'contractShort'), /molecules/);
  assert.equal(regionTabs(document).length, 0, 'a single region is not a choice');
});

test('coming back to the first track makes it playable again', async () => {
  const document = await selectTrack('sst');
  assert.equal(document.getElementById('play').disabled, false);
  assert.equal(document.getElementById('validPanel').hidden, false);
  assert.equal(document.getElementById('tierBadge').dataset.tier, 'verifiable');
});

test('coming back from an image-grid track restores latitudes and the globe', async () => {
  // The previous test left the page on SST after NO2 had hidden the globe
  // and relabelled the axis in rows. Both must come back, not stay stuck.
  const { document } = await thePage();
  assert.equal(document.getElementById('globeWrap').hidden, false);
  assert.match(ro(document, 'year'), /^\d+°[NS]$/, `axis shows "${ro(document, 'year')}"`);
  assert.equal(document.getElementById('scrub').max, '89');
  assert.equal(regionTabs(document).length, 4);
  assert.equal(document.getElementById('scanLine').hidden, false);
});

test('changing region moves the selection and keeps the contract chip honest', async () => {
  // Every SST region shares one slope (0.9375 dB/°C, the bar's full range
  // over ±15 dB), so the chip must NOT change: a chip that moved here would
  // be claiming a different contract than the one the payload carries.
  const { document } = await thePage();
  const chip = () => ro(document, 'contractShort');
  const tabs = regionTabs(document);
  const before = chip();
  tabs[1].click();                      // Tropics
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(chip(), before);
  tabs[0].click();                      // back to Global
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(chip(), before);
});

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

test('the live region announces where the sweep is', async () => {
  const { document } = await thePage();
  await new Promise((r) => setTimeout(r, 400));   // past the announcement settle delay
  const live = document.querySelector('[data-live]');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.ok(live.textContent.length > 0, 'the live region said nothing');
});

test('every control is reachable without a pointer', async () => {
  const { document } = await thePage();
  // Nothing interactive may be a bare div with a click handler.
  const interactive = [...document.querySelectorAll('button, input, select, [role="tab"]')];
  assert.ok(interactive.length >= 8, `only ${interactive.length} focusable controls`);
  for (const el of interactive) {
    assert.ok(['BUTTON', 'INPUT', 'SELECT'].includes(el.tagName),
      `${el.tagName} with role ${el.getAttribute('role')} is not a native control`);
    assert.ok(!el.hasAttribute('tabindex') || Number(el.getAttribute('tabindex')) >= 0,
      'a negative tabindex would take a control out of the tab order');
  }
});

test('pressing play resumes the context and starts the transport', async () => {
  const { document, pump } = await thePage();
  const play = document.getElementById('play');
  play.click();
  await new Promise((r) => setTimeout(r, 60));
  pump();
  assert.equal(play.getAttribute('aria-pressed'), 'true');
  assert.equal(play.getAttribute('aria-label'), 'Pause');
  play.click();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(play.getAttribute('aria-pressed'), 'false');
  assert.equal(play.getAttribute('aria-label'), 'Play');
});

test('the validation panel fills in once audio has started', async () => {
  const { document, pump } = await thePage();
  pump();
  const residual = ro(document, 'vResidual');
  // The stubbed analyser returns a fixed spectrum, so the NUMBER here is an
  // artefact of the fake; what this checks is that the panel is wired and
  // formatting in the live track's units rather than showing a placeholder.
  assert.match(residual, /^\d+\.\d{4} °C$/,
    `residual shows "${residual}" after play was pressed`);
  assert.match(ro(document, 'vExpected'), /dB$/);
});

test('the Scientific only / + Musical pair stays mutually exclusive', async () => {
  const { document } = await thePage();
  const sci = document.getElementById('sciOnly');
  const mus = document.getElementById('withMusic');
  assert.equal(sci.getAttribute('aria-pressed'), 'true');
  mus.click();
  assert.equal(mus.getAttribute('aria-pressed'), 'true');
  assert.equal(sci.getAttribute('aria-pressed'), 'false');
  sci.click();
  assert.equal(sci.getAttribute('aria-pressed'), 'true');
  assert.equal(mus.getAttribute('aria-pressed'), 'false');
});

test('the reference announces its real state, in both directions', async () => {
  // Regression: the announcement was unconditional, so turning the reference
  // OFF told a screen-reader user it was on - and it described a 440 Hz tone
  // that no longer exists under the current contract.
  const { document } = await thePage();
  const live = document.querySelector('[data-live]');
  const button = document.getElementById('reference');

  button.click();
  assert.match(live.textContent, /held/i, `on announced "${live.textContent}"`);
  assert.doesNotMatch(live.textContent, /440/,
    'the reference is the 220/880 pair at equal level; there is no 440 Hz tone');

  button.click();
  assert.match(live.textContent, /released/i, `off announced "${live.textContent}"`);

  assert.doesNotMatch(document.getElementById('refHelp').textContent, /440/);
});

test('the reference toggle and simplified mode flip their pressed state', async () => {
  const { document } = await thePage();
  for (const id of ['reference', 'simplified']) {
    const b = document.getElementById(id);
    assert.equal(b.getAttribute('aria-pressed'), 'false');
    b.click();
    assert.equal(b.getAttribute('aria-pressed'), 'true', `${id} did not toggle`);
    b.click();
    assert.equal(b.getAttribute('aria-pressed'), 'false');
  }
});

test('no uncaught errors were raised during any of this', async () => {
  const { errors, window } = await thePage();
  assert.deepEqual(errors, []);
  // jsdom's visual emulation keeps its own timer running; closing the window
  // lets the process exit rather than hanging after the last assertion.
  window.close();
});
