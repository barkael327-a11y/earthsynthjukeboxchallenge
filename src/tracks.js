/**
 * tracks.js — the jukebox's catalogue, and the claim each entry is allowed to make.
 *
 * The Earth Jukebox challenge asks for sonifications generated from NASA's EIC
 * VISUAL FRAMES — the published pictures, not the numeric products behind
 * them. Every track here therefore names a frame, and every track that claims a
 * measurement names the colour bar it was recovered through.
 *
 * TWO TIERS, AND WHY THE SPLIT IS THE POINT
 *
 * A published colour bar is a mapping from value to colour that someone else
 * defined and stated. Running it backwards is a measurement: it has a source,
 * an error floor, and a number you can check. Tracks with one are `verifiable`,
 * and they carry a contract, a tolerance and a live residual.
 *
 * Most EIC visualizations have no such bar. The volumetric carbon-dioxide and
 * methane renderings describe their colour only qualitatively; the aerosol
 * visualization layers several species with no single quantity; the night-lights
 * legend reads "lights out / no change / new lights", which is categorical.
 * Any value read out of those would be invented here. They are `unanchored`:
 * shown, sounded, and explicitly barred from displaying a residual, because
 * there is nothing to check against.
 *
 * Deciding which tier a visualization belongs to is the same judgement the rest
 * of this project makes about its own audio, applied one level up — a picture
 * you can question versus one you can only receive. An instrument that sounded
 * both the same way would be lying about one of them.
 *
 * @module tracks
 */

/**
 * @typedef {object} Track
 * @property {string} id
 * @property {string} label
 * @property {string} path            directory holding the payload
 * @property {'verifiable'|'unanchored'} tier
 * @property {string} units
 * @property {string} frame           the EIC still shown beside the sonification
 * @property {string} frameAlt        what the frame shows, for a reader who cannot see it
 * @property {string} source          the SVS page the frame came from
 * @property {string} credit
 * @property {object} terms           contract terms: units, balanceAt, rising, falling…
 * @property {object} scale           colour scale spec for this quantity
 * @property {string} blurb           one sentence on what the track is
 * @property {string} [barSource]     the published colour bar, for verifiable tracks
 * @property {{mean:number,max:number}} [inversionError]
 */

/**
 * Load and validate the catalogue.
 *
 * The validation is not ceremony. A track that claims to be verifiable without
 * naming the bar it was recovered through is exactly the failure this project
 * exists to avoid, and it is better for the jukebox to refuse to start than to
 * display an unearned tolerance.
 *
 * @param {string} [url]
 * @returns {Promise<Track[]>}
 */
export async function loadTracks(url = './data/tracks.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const doc = await res.json();
  const tracks = doc.tracks ?? [];
  if (!tracks.length) throw new Error(`${url} lists no tracks`);

  const seen = new Set();
  for (const t of tracks) {
    for (const key of ['id', 'label', 'tier', 'source', 'blurb']) {
      if (!t[key]) throw new Error(`track "${t.id ?? '?'}" is missing "${key}"`);
    }
    if (seen.has(t.id)) throw new Error(`duplicate track id "${t.id}"`);
    seen.add(t.id);

    if (t.origin === 'frame' && !t.frameAlt) {
      throw new Error(
        `track "${t.id}" shows a frame with no description of it. The challenge is ` +
        `about reaching people who cannot see the picture; an undescribed image is ` +
        `the failure it exists to fix.`
      );
    }
    if (t.tier === 'verifiable') {
      if (!t.path) throw new Error(`verifiable track "${t.id}" has no payload path`);
      if (!t.barSource) {
        throw new Error(
          `track "${t.id}" claims to be verifiable but names no published colour bar. ` +
          `A recovered value without the bar it came from is a guess with a decimal point.`
        );
      }
    } else if (t.tier !== 'unanchored') {
      throw new Error(`track "${t.id}" has unknown tier "${t.tier}"`);
    }
  }
  return tracks;
}

/**
 * What the track is allowed to say about itself, in one line, for the badge
 * beside the selector.
 * @param {Track} t
 */
export function tierLabel(t) {
  return t.tier === 'verifiable' ? 'Measured' : 'Unanchored';
}

/** @param {Track} t */
export function tierExplanation(t) {
  if (t.tier !== 'verifiable') {
    return `This visualization publishes no numeric colour scale, so no value can be ` +
      `recovered from it and none is claimed. It is shown and described here rather ` +
      `than sounded, because a soundscape with a residual beside it would suggest a ` +
      `measurement that does not exist.`;
  }
  if (t.origin === 'numeric') {
    return `Read from the published numeric product, area-weighted in the browser and ` +
      `checked against NASA's own index before anything sounds.`;
  }
  return `Recovered from the frame through ${t.barSource}, so the value has a source ` +
    `and the audio has a residual you can check against it.`;
}

/** Can this track be played at all? @param {Track} t */
export function isPlayable(t) {
  return t.tier === 'verifiable' && Boolean(t.path);
}
