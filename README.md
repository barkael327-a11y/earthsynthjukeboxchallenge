# EarthSynth

The Fourier Collective · NASA Space Apps 2026 · The Earth Information Jukebox

EarthSynth turns NASA-published visualization frames into a three-layer listening experience. Values are recovered through NASA's published color bars and encoded as the balance between two fixed tones. An independent browser FFT measures each carrier before the music and mix, recovering its value and reporting the difference.

## Try the preview

Run `python3 -m http.server 8080` in this directory and open `http://localhost:8080`. No build step or runtime package installation is required. The public submission still needs an accessible hosted URL or a public repository with these run instructions; localhost cannot be used by remote judges.

- Start listening to ocean, air and wind together.
- Use each switch to include/exclude a layer, or **Listen alone** to isolate one.
- **Show** chooses the measured field on screen without changing the audible selection.
- Mute silences the entire output; volume and mute do not move the upstream measurement.
- **Cinematic mode** opens a listening room with NASA astronaut photographs. Those photographs illustrate each theme; they are not the source frames being measured. **About this scene** gives the photograph's credit and source. Exit or Escape returns to the instrument without restarting its clock.
- **Sources, coverage & sound controls** contains the musical key, backdrop toggle and deliberate encoder-error test. The test should raise only that layer's sound difference.

## Three frozen NASA sources

| Layer | Exact NASA page | What is measured | Coverage and limits |
|---|---|---|---|
| Ocean temperature | [Perpetual Ocean, SVS 3912](https://svs.gsfc.nasa.gov/3912/) | ECCO2 surface-temperature picture recovered through the published 0–32 °C bar | Archival still; canonical 2° grid; not current ocean conditions |
| Global air pollution | [Science On a Sphere: Air Quality Model Runs, SVS 5518](https://svs.gsfc.nasa.gov/5518/) | GEOS-CF near-surface nitrogen oxides **NO + NO₂**, in ppbv; July 1, 2024 | Model estimate, not observed NO₂ column density or AQI. Published logarithmic color positions are decoded into physical values **before** averaging. |
| Wind speed | [GEOS-FP Near-Surface Wind Speed, SVS 5148](https://svs.gsfc.nasa.gov/5148/) | Model wind-speed picture, 0–40 m/s; October 30, 2026 at 05:00 EDT | Whole-picture image coordinates. No geographic projection is asserted. Neutral/ambiguous pixels and annotations are excluded, so missing areas are not calm wind. |

The ocean source is listed directly in the challenge's Resources. [Challenge and Resources](https://www.spaceappschallenge.org/2026/challenges/the-earth-information-jukebox/?tab=resources). Exact source assets, hashes, color ramps, dates, masks, and inversion limitations appear in `data/*/meta.json`, `data/nox-global/PROVENANCE.md`, `data/wind-global/PROVENANCE.md`, and the reproducible `tools/build_global_layers.py`.

These snapshots have different dates. Their common 90-step sweep is **relative top-to-bottom picture progress**, not simultaneous weather and not common geographic coordinates for wind. Values with different units are never combined into one scientific number.

## What sound means

Each scientific layer retains 220 Hz and 880 Hz. Pitch never carries a measurement. The balance between the tones carries the departure from that layer's declared balance point. Ocean is panned left, air centered and wind right, after separate FFT taps. Isolation is provided because simultaneous layers can mask one another by ear; stereo placement does not make the final combined waveform independently decodable as three values.

One shared musical backdrop supplies harmony, texture and reverb. It is artistic presentation and carries no independent scientific measurement. Its expression follows normalized source variation, but it does not combine physical units or claim a causal relationship. Steady carrier tones are trimmed after their analysers so the music can lead without changing the measured ratios.

**Sound difference** compares the source value with the value recovered from that layer's generated audio. It is not NASA model uncertainty or a claim that frame inversion equals the underlying raw dataset. The display withholds residuals while paused, missing data, or during an unsettled FFT window. Missing measurements remain missing and their carriers fall silent.

## Accessibility

All controls are native buttons, checkboxes, selects and ranges. Numeric values and coverage remain available as text; color is never the only channel. **Speak values** enables throttled screen-reader live announcements; it does not start a standalone text-to-speech voice. The cinematic dialog also receives those announcements when enabled. Keyboard focus is trapped by the native modal and restored on exit, and keyboard interaction keeps its controls visible. Reduced-motion preferences disable cinematic drift/fades and automatic globe rotation. This is implementation evidence, not a claim of completed assistive-technology certification; independent screen-reader testing is still recommended.

## Attribution, rights and assistance

NASA is the source of the scientific frames, color bars and cinematic photographs. NASA does not endorse EarthSynth. Credits and photo IDs for the three illustrative scenes are in `data/cinematic/manifest.json` and reachable from the app. No cinematic imagery was AI-generated; web copies were resized and JPEG-compressed.

OpenAI **Codex**, including collaborating agents, assisted UI implementation, research, preprocessing code and tests during this revision. NASA source measurements were not generated by an AI model. Audio is deterministic/procedural Web Audio synthesis, not output from a generative audio model. Include this assistance in the official submission's SI/AI field and references; the team must add any other tools it used.

Fonts: [Alegreya](https://github.com/google/fonts/tree/main/ofl/alegreya), [Source Sans 3](https://github.com/google/fonts/tree/main/ofl/sourcesans3), [IBM Plex Mono](https://github.com/google/fonts/tree/main/ofl/ibmplexmono), loaded through Google Fonts. Development dependencies are recorded in `package.json`/`package-lock.json`; preprocessing uses Python, NumPy, SciPy and Pillow. Design references consulted: [GetMe](https://getmetaste.com/) and [Linear's design discussion](https://linear.app/now/behind-the-latest-design-refresh).

**Rights still requiring team confirmation:** original project licensing; upstream citation and permission for source headers identifying CosmicSynth-derived code; and a complete inventory of tools/materials used before this revision. This preview does not assign a license to teammates' work. Consult `SPACE_APPS_REVIEW.md` before submission.

## Verification

Focused checks cover source payload loading/probes/region means, physical contracts, FFT recovery, shared timeline, missingness, isolation/mute independence, the single backdrop, and chart tick spacing. Run:

```sh
node --test test/global-payloads.test.mjs test/contract.test.mjs test/measurement.test.mjs test/layer-session.test.mjs test/trend-layout.test.mjs
```

The older page smoke tests describe the previous single-layer entry point and are not a certification of the new cinematic experience. `validate.html` remains the existing offline carrier/WAV tool. Do not reuse old README precision figures as measured results for the new three-layer UI.

## Team

The Fourier Collective — Kael Barba and Pranay Kaveri. Verify the accepted Space Apps platform roster and event separately.
