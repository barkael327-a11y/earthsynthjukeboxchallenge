import { createCinematicView } from './cinematic-view.js';
import { PROGRESSIONS } from './audio-pad.js';
import { loadSeries } from './earth-series.js';
import { makeScale } from './palette.js';
import { TrendChart } from './trend.js';
import { LayerSession } from './layer-session.js';
import { mountExploreView } from './explore-view.js';
import { ExperienceRenderer, sampledScale } from './experience-render.js';

const root = document.getElementById('earth-experience');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const layers = new Map();

let session;
let view;
let cinema;
let renderer;
let trend;
let focused = 'ocean';
let enabled = new Set(['ocean', 'air', 'wind']);
let speaking = false;
let lastSpoken = 0;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function main() {
  const definitions = await fetchJson('./data/experience-layers.json');
  for (const spec of definitions) {
    const meta = await fetchJson(`${spec.path}meta.json`);
    const terms = {
      units: spec.units,
      balanceAt: meta.contract.balance_at,
      balanceLabel: 'the middle of the published physical range',
      rising: 'increasing',
      falling: 'decreasing',
    };
    const series = await loadSeries({ ...spec, terms });
    const scale = spec.palette
      ? sampledScale(await fetchJson(spec.palette), spec.units)
      : makeScale({ ...spec.scale, units: spec.units });
    layers.set(spec.id, {
      ...spec, series, scale, meta,
      region: series.region(series.regions.keys().next().value),
    });
  }

  view = mountExploreView(root, {
    onToggle(id, on) {
      on ? enabled.add(id) : enabled.delete(id);
      session.setEnabled([...enabled]);
      announce(`${layers.get(id).label} ${on ? 'included' : 'off'}.`);
      refresh();
    },
    onIsolate(id) {
      enabled = new Set([id]);
      session.setEnabled([id]);
      focus(id);
      announce(`Listening to ${layers.get(id).label} only.`);
    },
    onPlay: togglePlay,
    onSeek(index) {
      session.seek(Number(index));
      refresh();
    },
    onMute() {
      session.setMuted(!session.muted);
      refresh();
    },
    onFocus: focus,
  });
  session = new LayerSession(
    new AudioContext(),
    [...layers.values()].map(layer => ({ id: layer.id, series: layer.series })),
    { count: 90, rate: 2 },
  );
  session.setEnabled([...enabled]);
  session.timeline.onFrame(() => refresh());
  session.timeline.onPlayState(() => refresh());

  mountAccessControls();
  await mountCinematicMode();
  mountSourceControls();

  window.addEventListener('resize', () => {
    renderer?.resize();
    trend?.resize();
    refresh();
  });

  focus('ocean');
  // Timeline schedules the audio; animation frames only paint the sphere.
  function paint() {
    if (renderer && session && !cinema?.element.open) {
      const layer = layers.get(focused);
      renderer.draw(layerIndex(layer, session.timeline.index), layer.region);
    }
    requestAnimationFrame(paint);
  }
  requestAnimationFrame(paint);
}

function mountAccessControls() {
  const tools = document.createElement('div');
  tools.className = 'experience-access';
  tools.innerHTML = '<button type="button" id="experience-speak" aria-pressed="false">Speak values</button><label for="experience-volume">Volume</label><input id="experience-volume" type="range" min="0" max="100" value="65"><span id="experience-status" class="sr-only" aria-live="polite" aria-atomic="true"></span>';
  root.appendChild(tools);
  document.getElementById('experience-speak').addEventListener('click', event => {
    speaking = !speaking;
    event.currentTarget.setAttribute('aria-pressed', String(speaking));
    refresh(true);
  });
  document.getElementById('experience-volume').addEventListener('input', event => {
    session.setVolume(Number(event.target.value) / 100);
  });
  session.setVolume(.65);
}

async function mountCinematicMode() {
  const cinemaButton = document.createElement('button');
  cinemaButton.type = 'button';
  cinemaButton.className = 'experience-cinema-entry';
  cinemaButton.textContent = 'Cinematic mode';
  cinemaButton.setAttribute('aria-haspopup', 'dialog');
  root.querySelector('.ex-mast').appendChild(cinemaButton);
  cinema = createCinematicView({
    onTogglePlay: togglePlay,
    onMute() {
      session.setMuted(!session.muted);
      refresh();
    },
    onEnabledChange(selection) {
      enabled = new Set(Object.entries(selection).filter(([, on]) => on).map(([id]) => id));
      session.setEnabled([...enabled]);
      refresh();
    },
    onExit() {
      renderer?.resize();
      trend?.resize();
      refresh();
    },
  });
  try {
    cinema.setScenes(await fetchJson('./data/cinematic/manifest.json'));
  } catch (error) {
    cinemaButton.disabled = true;
    cinemaButton.textContent = 'Cinematic scenes unavailable';
    console.error(error);
  }
  cinemaButton.addEventListener('click', () => {
    refresh();
    cinema.open();
  });
}

function mountSourceControls() {
  const chartSection = document.createElement('section');
  chartSection.className = 'experience-trend';
  chartSection.innerHTML = '<h2>Along the picture</h2><p id="experience-chart-description"></p><canvas id="experience-trend" aria-hidden="true"></canvas>';
  root.appendChild(chartSection);

  const details = root.querySelector('.ex-sources');
  details.className = 'experience-method';
  details.innerHTML = '<summary>Sources, coverage & sound controls</summary><p>These are separate published snapshots, not simultaneous live conditions. The shared control sweeps each picture from top to bottom. Ocean and air have geographic grids; wind stays in image coordinates until its projection is confirmed. Combining the audio does not combine their units or imply a causal relationship.</p><p>Every layer uses two fixed tones, 220 and 880 Hz. Their balance carries its value. Ocean is placed left, air in the middle and wind right; headphones make isolation easier to hear. Each layer is measured independently before the mix. Sound accuracy checks the encoder, not NASA’s source accuracy.</p><div id="experience-sources"></div>';
  root.appendChild(details);

  const advanced = document.createElement('div');
  advanced.className = 'experience-advanced';
  advanced.innerHTML = '<label><input id="experience-music" type="checkbox" checked> Background music</label><label for="experience-key">Key</label><select id="experience-key"></select><button id="experience-fault" type="button" aria-pressed="false">Test this layer’s encoder</button><p>The encoder test adds a deliberate error to the pictured layer. Its sound difference should rise; volume, music and key should not change it.</p>';
  details.appendChild(advanced);

  const keySelect = document.getElementById('experience-key');
  for (const [id, progression] of Object.entries(PROGRESSIONS)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = progression.label;
    keySelect.appendChild(option);
  }
  keySelect.addEventListener('change', event => session.setProgression(event.target.value));
  document.getElementById('experience-music').addEventListener('change', event => {
    session.setMusic(event.target.checked);
  });
  document.getElementById('experience-fault').addEventListener('click', () => {
    const on = !session.layers.get(focused).fault;
    session.setFault(focused, on);
    refresh();
  });
  root.querySelector('.ex-source-section')?.remove();
}

async function togglePlay() {
  try {
    session.timeline.playing ? session.pause() : await session.play();
    refresh();
  } catch (error) {
    showError(error);
  }
}

function layerIndex(layer, index) {
  return Math.round(Math.floor(index) / 89 * (layer.series.count - 1));
}

function focus(id) {
  if (!layers.has(id)) return;
  focused = id;
  const layer = layers.get(id);
  // A fresh canvas avoids retaining pointer listeners from the previous globe.
  const previous = view.canvas;
  const canvas = previous.cloneNode(false);
  previous.replaceWith(canvas);
  view.canvas = canvas;
  renderer = new ExperienceRenderer(canvas, layer.series, layer.scale);
  if (renderer.globe) renderer.globe.autoSpin = !reducedMotion.matches;

  let legend = document.getElementById('experience-legend');
  if (!legend) {
    legend = document.createElement('div');
    legend.id = 'experience-legend';
    legend.className = 'experience-legend';
    canvas.parentElement.after(legend);
  }
  legend.replaceChildren();
  const strip = document.createElement('div');
  strip.className = 'experience-ramp';
  strip.setAttribute('aria-hidden', 'true');
  strip.style.background = 'linear-gradient(to right,' + Array.from({ length: 32 }, (_, index) => {
    const value = layer.scale.lo + (layer.scale.hi - layer.scale.lo) * index / 31;
    return layer.scale.colourAt(value);
  }).join(',') + ')';
  const label = document.createElement('span');
  label.textContent = `${layer.scale.lo} – ${layer.scale.hi} ${layer.units} · displayed physical range`;
  legend.append(strip, label);

  if (trend) trend = null;
  const trendCanvas = document.getElementById('experience-trend');
  if (trendCanvas) {
    const fresh = trendCanvas.cloneNode(false);
    trendCanvas.replaceWith(fresh);
    trend = new TrendChart(fresh, layer.series);
    trend.scale = layer.scale;
    trend.setRegion(layer.region.id);
  }
  refresh();
}

function refresh(forceSpeak = false) {
  if (!session || !view) return;
  const samples = session.sample();
  const readings = samples.map(sample => {
    const layer = layers.get(sample.id);
    return {
      ...sample, label: layer.label, units: layer.units,
      residual: sample.validation?.residual ?? null, sourceNote: layer.sourceNote,
    };
  });
  const layer = layers.get(focused);
  const faultButton = document.getElementById('experience-fault');
  if (faultButton) {
    const on = Boolean(session.layers.get(focused).fault);
    faultButton.setAttribute('aria-pressed', String(on));
    faultButton.textContent = on ? 'Repair this layer’s encoder' : 'Test this layer’s encoder';
  }
  view.update({
    playing: session.timeline.playing, muted: session.muted,
    index: session.timeline.index, count: 90, focus: focused, enabled: [...enabled], readings,
    visualMode: layer.series.grid.kind === 'geo' ? 'globe' : 'map',
    visualNote: `${layer.sourceNote} Showing the decoded ${layer.label.toLowerCase()} field; the picture and sound read the same cells.`,
    sources: [...layers.values()].map(source => ({
      id: source.id, label: source.label, url: source.source, note: source.sourceNote,
    })),
  });
  const description = document.getElementById('experience-chart-description');
  if (description) {
    description.textContent = `${layer.label} · ${layer.units} · ${layer.series.grid.kind === 'geo' ? 'mean along latitude' : 'mean by picture row'} · gaps mean no usable data.`;
  }
  if (trend && !cinema?.element.open) trend.draw(layerIndex(layer, session.timeline.index));
  cinema?.update({
    playing: session.playing, muted: session.muted,
    enabled: [...enabled], focus: focused, index: session.index,
  });
  if (speaking && (forceSpeak || performance.now() - lastSpoken > 4500)) {
    lastSpoken = performance.now();
    const spokenSummary = readings.filter(reading => enabled.has(reading.id)).map(reading =>
      `${reading.label}: ${reading.observed && Number.isFinite(reading.value) ? reading.value.toFixed(2) + ' ' + reading.units : 'no usable data'}. ${reading.validation ? 'Sound difference ' + reading.validation.residual.toFixed(3) + ' ' + reading.units + '.' : ''}`,
    ).join(' ');
    announce(spokenSummary);
    cinema?.update({ spokenSummary });
  }
}

function announce(text) {
  const region = document.getElementById('experience-status');
  if (region) region.textContent = text;
}

function showError(error) {
  console.error(error);
  let alert = document.getElementById('experience-error');
  if (!alert) {
    alert = document.createElement('p');
    alert.id = 'experience-error';
    alert.setAttribute('role', 'alert');
    root.prepend(alert);
  }
  alert.textContent = 'Unable to load the verified experience: ' + error.message;
}

main().catch(showError);
