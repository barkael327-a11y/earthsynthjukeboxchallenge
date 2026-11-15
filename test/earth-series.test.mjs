/**
 * Loader tests, run against a real HTTP server so the fetch path is the same
 * one the browser takes.
 *
 * The two server modes matter. A static host may serve `field.i16.gz` as an
 * opaque body (GitHub Pages, python -m http.server) or may advertise
 * `Content-Encoding: gzip` and let the client inflate it (nginx with
 * gzip_static, and some CDNs). The loader has to be right on both, because the
 * wrong one shows up only after deployment.
 *
 * The payload served is test/fixtures/gistemp/: the GISTEMP year-axis build,
 * cut from the shipped catalogue (it is not an EIC Content Database visual)
 * but kept here because it is the only payload with a time axis, a 4.7 MB
 * gzip field and an index check - the cases this loader must survive.
 */
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { loadSeries } from '../src/earth-series.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES = {
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.u8': 'application/octet-stream',
};

/**
 * @param {{advertiseGzip:boolean}} opts
 *   advertiseGzip true  -> send Content-Encoding: gzip, client inflates
 *   advertiseGzip false -> send the bytes opaquely, our loader inflates
 */
async function serve({ advertiseGzip }) {
  const server = http.createServer(async (req, res) => {
    try {
      const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const body = await readFile(join(ROOT, rel));
      const ext = extname(rel);
      res.setHeader('Content-Type', TYPES[ext] ?? 'application/octet-stream');
      if (ext === '.gz' && advertiseGzip) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Encoding', 'gzip');
      }
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/test/fixtures/gistemp/`, close: () => server.close() };
}

/** Load once per server mode and reuse; decoding 4.7 MB per test would be wasteful. */
async function loaded(advertiseGzip) {
  const s = await serve({ advertiseGzip });
  try {
    return await loadSeries(s.base);
  } finally {
    s.close();
  }
}

test('loads when the server sends the gzip bytes opaquely', async () => {
  const series = await loaded(false);
  assert.equal(series.count, 146);
  assert.equal(series.yearStart, 1880);
  assert.equal(series.yearEnd, 2025);
});

test('loads when the server advertises Content-Encoding: gzip', async () => {
  const series = await loaded(true);
  assert.equal(series.count, 146);
  assert.equal(series.field.length, 146 * 90 * 180);
});

test('verification passes and actually checks every region-year', async () => {
  const series = await loaded(false);
  const { checked, worst } = series.verify();
  assert.ok(checked >= 146 * 4 * 0.95,
    `expected roughly 4 regions x 146 years of checks, got ${checked}`);
  assert.ok(worst < 1e-4,
    `browser and preprocessor disagree by ${worst} °C`);
});

test('our global series reproduces NASA published index', async () => {
  // The headline cross-check, re-run in the browser's own code path rather
  // than only in Python.
  const series = await loaded(false);
  const published = series.index.global_annual;
  let worst = 0;
  let sum = 0;
  let n = 0;
  for (let t = 0; t < series.count; t++) {
    const year = series.yearStart + t;
    if (!(year in published)) continue;
    const ours = series.sampleAt('global', t);
    const d = ours.value - published[year];
    worst = Math.max(worst, Math.abs(d));
    sum += d;
    n++;
  }
  assert.ok(n > 140, `expected a full record of comparisons, got ${n}`);
  assert.ok(Math.abs(sum / n) < 0.005, `mean difference ${(sum / n).toFixed(4)} °C`);
  assert.ok(worst < 0.06, `worst-year difference ${worst.toFixed(3)} °C`);
});

test('observed ranges match the published region definitions', async () => {
  const series = await loaded(false);
  const expected = {
    global: [-0.48, 1.29],
    arctic: [-1.76, 3.20],
    'n-eurasia': [-1.20, 2.60],
    tropics: [-0.63, 1.19],
  };
  for (const [id, [lo, hi]] of Object.entries(expected)) {
    const r = series.rangeOf(id);
    assert.ok(Math.abs(r.min - lo) < 0.005, `${id} min ${r.min.toFixed(3)} vs ${lo}`);
    assert.ok(Math.abs(r.max - hi) < 0.005, `${id} max ${r.max.toFixed(3)} vs ${hi}`);
  }
});

test('each region carries its own slope and they are not all equal', async () => {
  const series = await loaded(false);
  assert.equal(series.region('global').contract.slope, 20);
  assert.equal(series.region('arctic').contract.slope, 8);
  // The Arctic peak must stay inside the measurable tilt band at its own slope.
  const tilt = series.region('arctic').contract.toTilt(series.rangeOf('arctic').max);
  assert.ok(Math.abs(tilt) < 40, `Arctic peak needs ${tilt.toFixed(1)} dB of tilt`);
  // And the carrier frequencies are the same everywhere.
  assert.equal(series.region('global').contract.fLow, series.region('arctic').contract.fLow);
});

test('coverage falls away in the early record', async () => {
  const series = await loaded(false);
  const early = series.sampleAt('arctic', 0);              // 1880
  const modern = series.sampleAt('arctic', series.count - 1); // 2025
  assert.ok(early.coverage > 0.3 && early.coverage < 0.6,
    `1880 Arctic coverage ${early.coverage.toFixed(3)}, expected about 0.42`);
  assert.ok(modern.coverage > 0.99,
    `2025 Arctic coverage ${modern.coverage.toFixed(3)}`);
  assert.ok(early.coverage < modern.coverage);
});

test('sampling on an exact step is not flagged as interpolated', async () => {
  const series = await loaded(false);
  const s = series.sampleAt('global', 100);
  assert.equal(s.interpolated, false);
  assert.equal(s.observed, true);
  assert.equal(s.year, 1980);
});

test('scrubbing between years interpolates and says so', async () => {
  const series = await loaded(false);
  const a = series.sampleAt('global', 100);
  const b = series.sampleAt('global', 101);
  const mid = series.sampleAt('global', 100.5);
  assert.equal(mid.interpolated, true);
  assert.ok(Math.abs(mid.value - (a.value + b.value) / 2) < 1e-12);
  assert.equal(mid.year, 1980.5);
});

test('out-of-range indices clamp rather than throw or wrap', async () => {
  const series = await loaded(false);
  assert.equal(series.sampleAt('global', -5).year, 1880);
  assert.equal(series.sampleAt('global', 9999).year, 2025);
});

test('absent cells return null, never the fill value as a number', async () => {
  const series = await loaded(false);
  // 1880 has large gaps; find one and confirm it reads as absence.
  let found = null;
  outer:
  for (let j = 0; j < series.grid.nlat; j++) {
    for (let i = 0; i < series.grid.nlon; i++) {
      const c = series.cellAt(0, j, i);
      if (!c.observed) { found = c; break outer; }
    }
  }
  assert.ok(found, 'expected at least one unobserved cell in 1880');
  assert.equal(found.value, null);
  // The failure this guards against: 32767 * 0.01 = 327.67 C, which the
  // contract maps far above hearing, so a leak would be silent.
  for (let t = 0; t < series.count; t++) {
    for (const id of ['global', 'arctic', 'tropics', 'n-eurasia']) {
      const s = series.sampleAt(id, t);
      if (s.value !== null) {
        assert.ok(Math.abs(s.value) < 20,
          `${id} ${series.yearStart + t} returned ${s.value} °C - fill value leaked`);
      }
    }
  }
});

test('land fraction aligns with the field grid', async () => {
  const series = await loaded(false);
  assert.equal(series.landfrac.length, 90 * 180);
  // Sahara, roughly 23N 13E -> land; mid Pacific, roughly 1S 165W -> ocean.
  const j = Math.round((23 - series.grid.latStart) / series.grid.latStep);
  const i = Math.round((13 - series.grid.lonStart) / series.grid.lonStep);
  assert.ok(series.landAt(j, i) > 0.8, 'Sahara cell should be land');
  const pj = Math.round((-1 - series.grid.latStart) / series.grid.latStep);
  const pi = Math.round((-165 - series.grid.lonStart) / series.grid.lonStep);
  assert.ok(series.landAt(pj, pi) < 0.2, 'mid-Pacific cell should be ocean');
});

test('a corrupted payload is refused rather than sounded', async () => {
  const series = await loaded(false);
  // Simulate a decode that went wrong after the fact: verify() must catch it.
  series.cache.get('global').series[42] += 0.5;
  assert.throws(() => series.verify(), /disagree about area weighting/);
});
