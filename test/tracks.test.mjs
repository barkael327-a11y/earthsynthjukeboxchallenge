/**
 * The catalogue's guarantees.
 *
 * tracks.json is the only place where a visualization is allowed to claim it
 * can be measured, so the claim is checked here rather than trusted. Each of
 * these corresponds to a way the jukebox could quietly start lying: a track
 * that shows a residual without a bar behind it, a frame shown with no
 * description, a payload whose units disagree with the contract printed over
 * it.
 */
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTracks, tierLabel, tierExplanation, isPlayable } from '../src/tracks.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Serve the repo's own files to loadTracks(). */
globalThis.fetch = async (url) => {
  const body = await readFile(join(ROOT, String(url).replace(/^\.\//, '')));
  return { ok: true, status: 200, json: async () => JSON.parse(body.toString('utf8')) };
};

const tracks = await loadTracks();

test('everything in the shipped catalogue can be checked', async () => {
  assert.ok(tracks.length >= 2);
  for (const t of tracks) {
    assert.equal(t.tier, 'verifiable',
      `${t.id} ships without a way to check it. Nothing unanchored belongs in the ` +
      `catalogue: a visualization that cannot be measured is named in the written ` +
      `legend instead, where it cannot be mistaken for an entry that failed to load.`);
  }
});

test('every verifiable track names the published bar it was recovered through', () => {
  for (const t of tracks.filter((x) => x.tier === 'verifiable')) {
    assert.ok(t.barSource, `${t.id} claims a measurement with no stated source`);
    assert.ok(t.path, `${t.id} is playable but has no payload`);
    assert.ok(t.terms?.units, `${t.id} has no units`);
  }
});

test('the unanchored tier still refuses to offer a transport', () => {
  // Nothing unanchored ships, but the rule is what produced that catalogue and
  // it has to keep holding: the next frame someone adds will be judged by it.
  const t = { id: 'x', tier: 'unanchored', origin: 'frame' };
  assert.equal(isPlayable(t), false);
  assert.equal(tierLabel(t), 'Unanchored');
  assert.match(tierExplanation(t), /no numeric colour scale/);
});

test('a frame track without a description is refused', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      tracks: [{
        id: 'x', label: 'X', tier: 'unanchored', origin: 'frame',
        source: 'https://svs.gsfc.nasa.gov/0000/', blurb: 'something',
        frame: './x.jpg', frameAlt: '',
      }],
    }),
  });
  await assert.rejects(loadTracks(), /cannot see the picture/);
  globalThis.fetch = saved;
});

test('a track claiming to be verifiable without a bar is refused', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      tracks: [{
        id: 'x', label: 'X', tier: 'verifiable', origin: 'frame', path: './data/x/',
        source: 'https://svs.gsfc.nasa.gov/0000/', blurb: 'something',
        frame: './x.jpg', frameAlt: 'a long enough description of the frame',
      }],
    }),
  });
  await assert.rejects(loadTracks(), /names no published colour bar/);
  globalThis.fetch = saved;
});

test('the contract printed over a track matches the payload it came from', async () => {
  // The slope and balance point are computed by the preprocessor from the
  // published bar and written into the payload. The catalogue repeats the
  // balance point for the legend. If those two ever drift, the page would
  // describe one mapping and sound another.
  for (const t of tracks.filter(isPlayable)) {
    const meta = JSON.parse(
      await readFile(join(ROOT, t.path.replace(/^\.\//, ''), 'meta.json'), 'utf8'));
    if (!meta.contract) continue;        // the numeric track predates the field
    assert.equal(meta.contract.balance_at, t.terms.balanceAt,
      `${t.id}: payload balances at ${meta.contract.balance_at}, catalogue says ${t.terms.balanceAt}`);
    const regions = JSON.parse(
      await readFile(join(ROOT, t.path.replace(/^\.\//, ''), 'regions.json'), 'utf8'));
    for (const r of regions.regions) {
      assert.equal(r.slope, meta.contract.slope,
        `${t.id}: region ${r.id} uses a slope the payload does not declare`);
    }
  }
});

test('a recovered track reports how well its own bar inverts', () => {
  // The floor on every value this track can produce. Publishing it beside the
  // residual is what stops the residual from being read as total accuracy.
  for (const t of tracks.filter((x) => x.tier === 'verifiable' && x.origin === 'frame')) {
    assert.ok(t.inversionError, `${t.id} does not publish its inversion error`);
    assert.ok(t.inversionError.max > 0 && t.inversionError.max < 1,
      `${t.id} reports an implausible inversion error`);
    assert.ok(t.inversionError.mean <= t.inversionError.max);
  }
});
