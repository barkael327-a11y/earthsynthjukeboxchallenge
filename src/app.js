/**
 * app.js - wiring. No physics, no mapping, no measurement happens here.
 *
 * Audio parameters are scheduled by the Timeline against ctx.currentTime, ahead
 * of the clock. Display is a separate requestAnimationFrame loop that runs the
 * whole time, including while paused, because the globe turns whether or not
 * the record is playing. The two never mix: nothing audible is ever decided in
 * an animation frame.
 *
 * Everything below the track - payload, regions, contract, colour scale, audio
 * graph - is rebuilt when the selection changes, and nothing is shared between
 * tracks except the AudioContext and the DOM. Two tracks are two different
 * quantities with two different contracts, and a carrier carried over between
 * them would at best sound the old slope and at worst sound both.
 *
 * @module app
 */

import { loadSeries } from './earth-series.js';
import { loadTracks, tierLabel, tierExplanation, isPlayable } from './tracks.js';
import { Timeline } from './timeline.js';
import { CarrierLayer } from './audio-carrier.js';
import { AmbientPad, PROGRESSIONS, DEFAULT_PROGRESSION } from './audio-pad.js';
import { Mixer } from './mixer.js';
import { LiveValidator } from './validate-live.js';
import { Readout } from './readout.js';
import { GlobeRenderer } from './globe.js';
import { drawColourBar, drawRejectionMask } from './field-render.js';
import { TrendChart } from './trend.js';
import { makeScale, ANOMALY_SCALE } from './palette.js';

const $ = (sel) => document.querySelector(sel);

/** Steps per second of playback. One year, or one latitude band, per strike. */
const RATE = 2;

main().catch(showFatal);

async function main() {
  const tracks = await loadTracks();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const readout = new Readout(document.body);

  /** Everything that belongs to the track currently loaded. */
  let live = null;
  let started = false;
  let scrubbing = false;
  let musical = false;
  let maskOn = false;
  let progression = DEFAULT_PROGRESSION;

  let announcing = false;
  let faulted = false;
  /** Pending display updates for the scale preview, so play can cancel them. */
  let scaleTimers = [];

  buildTrackTabs();
  buildChordButtons();
  bindGlobalControls();
  requestAnimationFrame(frame);

  await selectTrack(tracks.find(isPlayable).id);

  // ---------------------------------------------------------------------
  // the catalogue
  // ---------------------------------------------------------------------

  function buildTrackTabs() {
    const list = $('#tracks');
    for (const t of tracks) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.track = t.id;
      b.setAttribute('aria-selected', 'false');
      b.innerHTML =
        `<span>${t.short ?? t.label}</span>` +
        `<small class="${t.tier}">${tierLabel(t)}</small>`;
      b.addEventListener('click', () => selectTrack(t.id));
      list.appendChild(b);
    }
  }

  /** @param {string} id */
  async function selectTrack(id) {
    const track = tracks.find((t) => t.id === id);
    if (!track || live?.track.id === id) return;

    for (const b of document.querySelectorAll('[data-track]')) {
      b.setAttribute('aria-selected', String(b.dataset.track === id));
    }
    teardown();
    showFrame(track);
    applyTrackText(track);

    if (!isPlayable(track)) {
      // An unanchored visualization is shown and described, and that is all.
      // Giving it a transport would imply there is something to measure.
      setPlayable(false);
      setMask(false);
      $('#maskToggle').disabled = true;
      readout.say(`${track.label}. ${tierExplanation(track)}`);
      return;
    }
    setPlayable(true);
    await mount(track);
  }

  // ---------------------------------------------------------------------
  // one track's worth of instrument
  // ---------------------------------------------------------------------

  /** @param {any} track */
  async function mount(track) {
    const series = await loadSeries(track);
    const check = series.verify();
    console.info(
      `EarthSynth: ${track.id} verified — ${check.checked} checks, ` +
      `worst disagreement ${check.worst.toExponential(2)} ${track.units}.`
    );

    const scale = track.scale ? makeScale({ ...track.scale, units: track.units }) : ANOMALY_SCALE;
    const region = series.region(series.regions.keys().next().value);

    const carrier = new CarrierLayer(ctx, { series, region });
    const pad = new AmbientPad(ctx, { series, region, yearSeconds: 1 / RATE });
    const mixer = new Mixer(ctx, { scientific: carrier.output, musical: pad.output });
    const validator = new LiveValidator(carrier.analyser, () => live.region.contract);
    const timeline = new Timeline(ctx, { count: series.count, rate: RATE });

    const globe = track.globe ? new GlobeRenderer($('#globe'), series) : null;
    if (globe) globe.setScale(scale);
    const trend = new TrendChart($('#trend'), series);
    trend.scale = scale;
    // The chart can't default to "global": a track whose frame has no published
    // geography has no global region, only the frame itself.
    trend.setRegion(region.id);

    live = { track, series, scale, region, carrier, pad, mixer, validator, timeline, globe, trend };

    timeline.onSchedule((vertex) => {
      live.carrier.scheduleVertex(vertex);
      live.pad.scheduleVertex(vertex);
    });
    timeline.onSeek((index) => {
      live.carrier.seek(index);
      live.pad.seek(index);
    });
    timeline.onPlayState((playing) => {
      const b = $('#play');
      b.textContent = playing ? '❚❚' : '▶';
      b.setAttribute('aria-pressed', String(playing));
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });

    const scrub = $('#scrub');
    scrub.max = String(series.count - 1);
    scrub.value = '0';

    $('#globeWrap').hidden = !globe;
    buildRegionTabs();
    applyRegionText();
    drawColourBar($('#colourbar'), scale);
    $('#barUnits').innerHTML = `${track.label}<br>(${track.units})`;

    // The mix, the key and the mask all survive a track change: they are the
    // listener's preferences, not properties of the record.
    live.pad.setProgression(progression);
    setMusic(musical);
    $('#maskToggle').disabled = !track.frame;
    if (!track.frame) setMask(false);
    else if (maskOn) redrawMask();

    // A fault is a thing you do to a demonstration, not a preference, so it does
    // not follow the listener to the next track. The new carrier starts clean, so
    // only the button needs resetting - seeking here would restart the pad's first
    // chord a moment after it began.
    faulted = false;
    $('#faultBtn').setAttribute('aria-pressed', 'false');
    $('#faultBtn').textContent = 'Break the encoder';
  }

  function teardown() {
    if (!live) return;
    endScale();
    live.timeline.pause();
    live.timeline.dispose();
    live.carrier.dispose();
    live.pad.dispose();
    live.mixer.dispose();
    live = null;
    started = false;
    $('#regions').replaceChildren();
  }

  // ---------------------------------------------------------------------
  // the EIC frame
  // ---------------------------------------------------------------------

  /** @param {any} track */
  function showFrame(track) {
    const wrap = $('#framePanel');
    const img = /** @type {HTMLImageElement} */ ($('#frameImg'));
    if (track.frame) {
      img.src = track.frame;
      // The alt text is the frame for a listener. tracks.js requires it of
      // every frame track at load time rather than leaving it to good
      // intentions.
      img.alt = track.frameAlt;
      img.hidden = false;
      $('#frameMissing').hidden = true;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      $('#frameMissing').hidden = false;
      $('#frameMissing').textContent = track.origin === 'numeric'
        ? 'This track reads the published numeric product directly, so there is no frame to show. The globe beside it is drawn from that payload.'
        : track.frameAlt;
    }
    $('#frameSource').textContent = track.sourceLabel ?? track.source;
    $('#frameSource').href = track.source;
    $('#frameCredit').textContent = track.credit ?? '';
    wrap.hidden = false;
  }

  /** @param {any} track */
  function applyTrackText(track) {
    readout.set('trackTitle', track.label);
    readout.set('trackBlurb', track.blurb);
    readout.set('tierBadge', tierLabel(track));
    readout.set('tierNote', tierExplanation(track));
    $('#tierBadge').dataset.tier = track.tier;

    if (track.inversionError) {
      readout.set(
        'inversion',
        `Colour bar inverts its own colours to ${track.inversionError.mean.toFixed(3)} ` +
        `${track.units} on average, ${track.inversionError.max.toFixed(3)} at worst. ` +
        `That is the floor: a frame can be no more faithful than its own legend.`
      );
      $('#inversion').hidden = false;
    } else {
      $('#inversion').hidden = true;
    }
  }

  /** @param {boolean} on */
  function setPlayable(on) {
    for (const sel of ['#play', '#prev', '#next', '#scrub', '#sciOnly', '#withMusic',
                       '#reference', '#simplified', '#master', '#scaleBtn', '#faultBtn',
                       '#announce']) {
      /** @type {HTMLButtonElement} */ ($(sel)).disabled = !on;
    }
    $('#transportNote').hidden = on;
    $('#readoutPanel').hidden = !on;
    $('#validPanel').hidden = !on;
    $('#trendPanel').hidden = !on;
    $('#globeWrap').hidden = !on;
    $('#chordRow').hidden = !on;
    $('#scaleRow').hidden = !on;
  }

  // ---------------------------------------------------------------------
  // controls, bound once and reading whatever track is live
  // ---------------------------------------------------------------------

  function bindGlobalControls() {
    $('#play').addEventListener('click', togglePlay);
    $('#prev').addEventListener('click', () => live?.timeline.stepBy(-1));
    $('#next').addEventListener('click', () => live?.timeline.stepBy(1));

    const scrub = $('#scrub');
    scrub.addEventListener('pointerdown', () => { scrubbing = true; });
    window.addEventListener('pointerup', () => { scrubbing = false; });
    scrub.addEventListener('input', () => live?.timeline.seek(Number(scrub.value), 'scrub'));

    $('#sciOnly').addEventListener('click', () => setMusic(false));
    $('#withMusic').addEventListener('click', () => setMusic(true));

    $('#reference').addEventListener('click', (e) =>
      setReference(e.currentTarget.getAttribute('aria-pressed') !== 'true'));

    $('#simplified').addEventListener('click', (e) => {
      if (!live) return;
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      live.carrier.setSimplified(on);
      if (on) setMusic(false);
      readout.say(on
        ? 'Simplified mode on. Carrier only, louder: no pad, no reverb, no delays.'
        : 'Simplified mode off.');
    });

    $('#maskToggle').addEventListener('click', (e) =>
      setMask(e.currentTarget.getAttribute('aria-pressed') !== 'true'));

    $('#master').addEventListener('input', (e) =>
      live?.mixer.setMaster(Number(e.currentTarget.value) / 100));

    $('#scaleBtn').addEventListener('click', playScale);

    $('#faultBtn').addEventListener('click', (e) =>
      setFault(e.currentTarget.getAttribute('aria-pressed') !== 'true'));

    $('#announce').addEventListener('click', (e) =>
      setAnnouncing(e.currentTarget.getAttribute('aria-pressed') !== 'true'));

    // The mask is sized from the rendered image, so it can only be drawn once
    // the frame has actually loaded.
    $('#frameImg').addEventListener('load', redrawMask);

    // Skipped when focus is in a control, so the native key handling of the
    // range input and the buttons keeps working. Nothing here is the only route
    // to a feature; these are shortcuts to controls that already exist.
    window.addEventListener('keydown', (e) => {
      const tag = /** @type {HTMLElement} */ (e.target).tagName;
      if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || e.metaKey || e.ctrlKey) return;
      if (!live && e.key !== 'Tab') return;
      switch (e.key) {
        case ' ': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); live.timeline.stepBy(-1); break;
        case 'ArrowRight': e.preventDefault(); live.timeline.stepBy(1); break;
        case 'Home': e.preventDefault(); live.timeline.seek(0, 'jump'); break;
        case 'End': e.preventDefault(); live.timeline.seek(live.series.count - 1, 'jump'); break;
        case 'r': case 'R':
          if (!e.repeat) setReference($('#reference').getAttribute('aria-pressed') !== 'true');
          break;
        case 'm': case 'M': setMusic(live.mixer.mix === 0); break;
        case 's': case 'S': $('#simplified').click(); break;
        case 'd': case 'D': $('#maskToggle').click(); break;
        case 'l': case 'L': if (!e.repeat) playScale(); break;
        case 'b': case 'B': if (!e.repeat) setFault(!faulted); break;
        case 'v': case 'V': if (!e.repeat) setAnnouncing(!announcing); break;
        default:
          if (/^[1-9]$/.test(e.key)) {
            const tabs = [...document.querySelectorAll('#regions [role="tab"]')];
            tabs[Number(e.key) - 1]?.click();
          }
      }
    });

    window.addEventListener('resize', () => {
      live?.globe?.resize();
      live?.trend.resize();
      if (live) drawColourBar($('#colourbar'), live.scale);
      redrawMask();
    });
  }

  async function togglePlay() {
    if (!live) return;
    endScale();
    if (ctx.state !== 'running') await ctx.resume();
    started = true;
    live.timeline.toggle();
  }

  /** @param {boolean} on */
  function setMusic(on) {
    musical = on;
    $('#withMusic').setAttribute('aria-pressed', String(on));
    $('#sciOnly').setAttribute('aria-pressed', String(!on));
    if (!live) return;
    live.mixer.setMix(on ? 1 : 0);
    // Two bare sines are conspicuous against a pad, so tuck them down when it's
    // playing. The tap is upstream of this, so the residual doesn't move.
    live.carrier._padPlaying = on;
    live.carrier.setPresence(on);
    if (on) {
      $('#simplified').setAttribute('aria-pressed', 'false');
      live.carrier.setSimplified(false);
    }
    readout.say(on
      ? 'Ambient pad on. The residual does not change: the measurement is a ratio, tapped before the mixer.'
      : 'Carrier only.');
  }

  /** @param {boolean} on */
  function setReference(on) {
    if (!live) return;
    $('#reference').setAttribute('aria-pressed', String(on));
    live.carrier.reference(on);
    if (!on) live.timeline.seek(live.timeline.index, 'reference');
    const c = live.region.contract;
    readout.say(on
      ? `Reference held: both partials at equal level, ${c.balanceAt.toFixed(2)} ${c.units}.`
      : 'Reference released.');
  }

  // ---------------------------------------------------------------------
  // the audible scale
  // ---------------------------------------------------------------------

  /**
   * Sound the range this region covers, naming each step as it goes. A colour
   * bar gives a sighted listener the scale before they read the picture; without
   * this the tilt has nothing to be judged against by ear.
   *
   * Only from a stopped transport, so it never competes with the scheduler.
   */
  async function playScale() {
    if (!live || live.timeline.playing) return;
    if ($('#reference').getAttribute('aria-pressed') === 'true') setReference(false);
    endScale();

    if (ctx.state !== 'running') await ctx.resume();
    started = true;

    const range = live.series.rangeOf(live.region.id);
    const c = live.region.contract;
    // Five steps rather than three. At the ends of a wide range one partial sits
    // so far below the other that you effectively hear it alone, and three points
    // that far apart read as pitch jumps - which is the one thing this instrument
    // never does. The intermediate steps make it audible as the crossfade it is.
    const anchors = [
      range.min,
      (range.min + c.balanceAt) / 2,
      c.balanceAt,
      (c.balanceAt + range.max) / 2,
      range.max,
    ];
    const { schedule, endsAt } = live.carrier.playScale(anchors, 0.8);

    $('#scaleBtn').setAttribute('aria-pressed', 'true');
    readout.say(`Scale for ${live.region.label}, five tones.`);

    // The carrier is told what each tone is as it arrives, so the residual
    // beside it is checking the preview too, not just the record.
    const from = ctx.currentTime;
    scaleTimers = schedule.map(({ value, at }) => setTimeout(() => {
      live.carrier.expectValue(value);
      $('#scaleNow').textContent = `${value.toFixed(2)} ${c.units}`;
      readout.say(fmtSpoken(value, c));
    }, (at - from) * 1000));

    scaleTimers.push(setTimeout(endScale, (endsAt - from) * 1000 + 150));
  }

  /** Clear the preview and hand the carrier back to the record. */
  function endScale() {
    for (const t of scaleTimers) clearTimeout(t);
    scaleTimers = [];
    $('#scaleBtn').setAttribute('aria-pressed', 'false');
    $('#scaleNow').textContent = '';
    live?.timeline.seek(live.timeline.index, 'scale');
  }

  // ---------------------------------------------------------------------
  // speaking, and the deliberate fault
  // ---------------------------------------------------------------------

  /** @param {boolean} on */
  function setAnnouncing(on) {
    announcing = on;
    // The readout owns the live region, so the residual goes on the end of the
    // line it already speaks. Two writers into one region means whichever
    // flushes last wins and the other is never heard.
    readout.speakResidual = on;
    $('#announce').setAttribute('aria-pressed', String(on));
    readout.say(on
      ? 'Speaking values. Each step, its measurement and the live residual, every few seconds.'
      : 'Stopped speaking values.');
  }

  /**
   * @param {boolean} on sound a value other than the one being reported, so the
   *   residual can be watched to catch it
   */
  function setFault(on) {
    faulted = on;
    $('#faultBtn').setAttribute('aria-pressed', String(on));
    $('#faultBtn').textContent = on ? 'Repair the encoder' : 'Break the encoder';
    if (!live) return;

    const range = live.series.rangeOf(live.region.id);
    const c = live.region.contract;
    // A quarter of the region's own span: unmistakable on any track, and still
    // inside the tilt range where both partials stay measurable.
    const amount = on ? (range.max - range.min) * 0.25 : 0;
    live.carrier.setFault(amount);
    live.timeline.seek(live.timeline.index, 'fault');

    readout.say(on
      ? `Encoder broken. The carrier is sounding a value ${amount.toFixed(2)} ${c.units} away ` +
        `from the one it reports, and the residual has grown to match. Nothing else changed.`
      : 'Encoder repaired. The residual returns to the measurement floor.');
  }

  // ---------------------------------------------------------------------
  // key, and the discarded-pixel mask
  // ---------------------------------------------------------------------

  function buildChordButtons() {
    const list = $('#chords');
    for (const [id, p] of Object.entries(PROGRESSIONS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.progression = id;
      b.setAttribute('aria-pressed', String(id === progression));
      b.textContent = p.label;
      b.addEventListener('click', () => setProgression(id));
      list.appendChild(b);
    }
  }

  /** @param {string} id */
  function setProgression(id) {
    progression = id;
    for (const b of document.querySelectorAll('[data-progression]')) {
      b.setAttribute('aria-pressed', String(b.dataset.progression === id));
    }
    if (!live) return;
    const p = live.pad.setProgression(id);
    // Re-seek so the new chord is voiced now rather than at the next bar. The
    // carrier re-anchors at the same value, so the residual is untouched.
    live.timeline.seek(live.timeline.index, 'progression');
    readout.say(
      `${p.label}. ${p.chords.map((c) => c.name).join(', ')}. ` +
      `The residual does not move: no pitch in this instrument encodes anything.`
    );
  }

  /** @param {boolean} on */
  function setMask(on) {
    maskOn = on;
    const button = $('#maskToggle');
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'Hide discarded pixels' : 'Show discarded pixels';
    $('#frameMask').hidden = !on;
    if (!on) {
      $('#maskCount').textContent = '';
      if (live) readout.say('Discarded pixels hidden.');
      return;
    }
    const share = redrawMask();
    if (share !== null) {
      readout.say(
        `Discarded pixels shown. ${(share * 100).toFixed(0)} percent of this frame did not ` +
        `land on the published colour bar, so none of it is read as a value.`
      );
    }
  }

  /** @returns {number|null} share discarded, or null if there is nothing to draw */
  function redrawMask() {
    if (!maskOn || !live || !live.track.frame) return null;
    const share = drawRejectionMask($('#frameMask'), live.series, live.timeline.index);
    $('#maskCount').textContent = `${(share * 100).toFixed(0)}% of the frame discarded`;
    return share;
  }

  function buildRegionTabs() {
    const list = $('#regions');
    list.replaceChildren();
    // A single region is not a choice, and a tablist of one is clutter.
    if (live.series.regions.size < 2) { list.hidden = true; return; }
    list.hidden = false;
    for (const [id, r] of live.series.regions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.region = id;
      b.setAttribute('aria-selected', String(id === live.region.id));
      b.textContent = r.label;
      b.addEventListener('click', () => selectRegion(id));
      list.appendChild(b);
    }
  }

  /** @param {string} id */
  function selectRegion(id) {
    live.region = live.series.region(id);
    for (const tab of document.querySelectorAll('#regions [role="tab"]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.region === id));
    }
    live.carrier.setRegion(live.region);
    live.pad.setRegion(live.region);
    live.trend.setRegion(id);
    applyRegionText();
    // The slope can change with the region, so everything already scheduled was
    // computed under the old contract. Re-seeking cancels and re-anchors.
    live.timeline.seek(live.timeline.index, 'region');
    // The fault is sized from the region's own span, so it has to be resized too.
    if (faulted) setFault(true);
    const r = live.series.rangeOf(id);
    const c = live.region.contract;
    readout.say(
      `${live.region.label}. ${live.region.weighting}. ${c.slope} decibels of tilt per ` +
      `${c.units}. Range ${r.min.toFixed(2)} to ${r.max.toFixed(2)} ${c.units}.`
    );
  }

  function applyRegionText() {
    const c = live.region.contract;
    readout.set('contractShort', c.shortLabel());
    readout.set('contractLegend', c.legend());
    readout.set('footerContract', c.shortLabel());
    readout.set('regionDetail', live.region.weighting);
    readout.set('regionBounds', boundsLabel(live.region, live.series.grid));
    readout.set('trendSub',
      `${live.region.label}, ${c.units} along ${live.series.axis.noun}.`);
    readout.set('valueUnit', c.units);
  }

  // ---------------------------------------------------------------------

  /** @param {number} now */
  function frame(now) {
    requestAnimationFrame(frame);
    if (!live) return;

    const index = live.timeline.index;
    // What is sounding is the step last reached, not an interpolation: the tilt
    // is held between steps. The readout prints that, so the number on screen is
    // the number in the balance.
    const held = live.carrier.heldSample(index);
    const label = live.series.labelAt(index);

    live.globe?.draw(index, live.region);
    live.trend.draw(index);
    positionScanLine(index);

    const scrub = $('#scrub');
    if (!scrubbing) {
      scrub.value = String(Math.round(index));
      scrub.setAttribute('aria-valuetext', held.observed
        ? `${label}, ${fmtSpoken(held.value, live.region.contract)}`
        : `${label}, no observation`);
    }

    readout.update({
      regionLabel: live.region.label,
      year: held.year,
      label,
      value: held.value,
      observed: held.observed,
      coverage: held.coverage,
      interpolated: false,
      contract: live.region.contract,
      diverging: live.scale.kind === 'diverging',
      started,
      validation: started
        ? live.validator.measure({
            expectedValue: live.carrier.expectedValue,
            expectedTilt: live.carrier.expectedTilt,
          })
        : null,
    });
  }

  /**
   * The sweep, drawn on the frame itself. A listener who can see the picture
   * should be able to see where the sound is coming from. The line is
   * decoration over the real published image and carries no value of its own.
   */
  function positionScanLine(index) {
    const line = $('#scanLine');
    if (!live || live.series.axis.kind !== 'scan-lat' || !live.track.frame) {
      line.hidden = true;
      return;
    }
    line.hidden = false;
    line.style.top = `${(index / Math.max(live.series.count - 1, 1)) * 100}%`;
  }
}

/** @param {number|null} v @param {any} c */
function fmtSpoken(v, c) {
  if (v === null) return 'no observation';
  const unit = c.units.replace('°C', 'degrees Celsius');
  return c.balanceAt === 0
    ? `${v >= 0 ? 'plus' : 'minus'} ${Math.abs(v).toFixed(2)} ${unit}`
    : `${v.toFixed(2)} ${unit}`;
}

/** @param {import('./regions.js').Region} r @param {any} grid */
function boundsLabel(r, grid) {
  if (grid.kind === 'image') return 'rows and columns of the frame';
  if (r.id === 'global') return 'whole Earth, area-weighted';
  const [la0, la1] = r.bounds.lat;
  const ns = (v) => `${Math.abs(v)}°${v < 0 ? 'S' : 'N'}`;
  return `${ns(la0)}–${ns(la1)} · area-weighted`;
}

/** @param {unknown} err */
function showFatal(err) {
  const box = document.getElementById('error');
  if (!box) { console.error(err); return; }
  box.hidden = false;
  box.innerHTML =
    '<strong>EarthSynth could not verify its data, so it will not play.</strong><br>' +
    'An instrument that cannot prove what it is sounding should say so rather than sound something.' +
    `<br><br><code>${String(err && err.message ? err.message : err)}</code>`;
  console.error(err);
}