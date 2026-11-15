# EarthSynth

Our synth allows you to turn a NASA picture into sound, and then measure the sound to get numbers back.

> The Earth Information Jukebox · NASA Space Apps 2026 · The Fourier Collective

## What it does

It reads an Earth Information Center (EIC) frame through the color bar that NASA has publicized beside it, it's usually found near the corner but you can download it separately. EarthSynth encodes each value as the balance between two fixed tones, then runs a fast fourier transform (FFT) on its own output to recover those values, and the gap between the two is shown on screen the whole time. For example, on sea surface temperature the gap is about 0.16 °C. The colour bar's own inversion error is 0.19 °C, so the picture is the limit, not the audio.

## Try it yourself

1. Press `L`. Five tones play, bottom of the range to top, each one named. This is the colour bar translated into sound.
2. Press play and watch the big number in Live Validation.
3. Drag the master volume. It doesn't move because the measurement is a ratio, so any gain both tones pass through cancels.
4. Press `B`. That offsets what the carrier sounds and leaves what it reports alone. The residual jumps to 6.8 and turns orange.

Step 4 is the main point of our project confirming EarthSynth's scientific validity, because a number that always reads near zero could just be hardcoded.

## How the mapping works

| | |
|---|---|
| Carrier | two sines, 220 Hz and 880 Hz, fixed forever |
| Measurement | tilt = slope × (value − balance), in dB |
| At the balance point | both partials equal |
| Total energy | constant, so loudness carries nothing |
| Pitch | carries nothing, ever |

Pixels go to OKLab and match the nearest colour on the published bar. The match distance is the test: pixels landing far from the bar are basemap, coastline and labels, so they fall silent instead of reading as low values. Press `D` to see which ones got thrown out.

## What the music invents

We implemented each of the following so it sounds pleasant:

- Chords
- Filter sweep
- Reverb size
- Delay feedback
- Voicing
- Noise bed

None of it encodes anything, hiss is a coverage proxy and is labeled as one. Silence means no observation, never a value near zero.

## Accessibility

This challenge exists because a picture leaves people out, so the sound isn't an extra here, it's the way in. Every number on screen is also a tone.

`L` plays the scale before the data starts, so your ear has something to measure against. `V` announces position, value and live residual through an ARIA live region, so the instrument and its own error can be followed by ear. We throttle it on purpose, because a live region updated at the step rate fills the queue faster than a screen reader empties it. `R` holds the balance point as a reference tone to compare against. `S` strips the pad and the effects so only the two measured partials are left.

Every frame carries a written description and the loader rejects one that doesn't. Both canvases are marked decorative, because everything in them is also printed, spoken and sounded. Nothing is conveyed by colour alone, the residual shows a ✓ or ✗ as well as changing colour. Every control is a real `<button>` or `<input>`, and Tab reaches all of them.

Keys: `Space` play, `←` `→` step, `Home` `End` ends, `L` scale, `V` speak, `B` break, `R` reference, `S` simplified, `M` music, `D` discarded pixels, `1`–`4` region.

## Run it on your own end

```bash
python -m http.server 8080
```

No build step, no framework. `npm install && npm test` runs the 79 tests; jsdom is the only dependency.

## Checking it yourself

`validate.html` renders each contract through an OfflineAudioContext and writes a WAV. `tools/validate.py` analyses that WAV with numpy, sharing no code with the browser. Worst disagreement: 9.7 × 10⁻⁷ °C at 44.1 kHz, 8.9 × 10⁻⁷ at 48 kHz.

## Data

| Track | Source | Bar | Bar inverts to (mean / max) |
|---|---|---|---|
| Sea surface temperature | ECCO2 Perpetual Ocean — https://svs.gsfc.nasa.gov/3912/#media_group_349716 | 0–32 °C | 0.077 / 0.191 °C |
| Tropospheric NO₂ | https://svs.gsfc.nasa.gov/4810/ | 0–10 ×10¹⁵ molec/cm² | 0.006 / 0.048 |

Imagery from NASA's Scientific Visualization Studio. NASA doesn't endorse this.

## Limits

- Spectral tilt is harder to read by ear than pitch. That's the real cost of refusing to map data to pitch, and it's why the scale preview and the spoken values exist.
- At the ends of a wide range one partial nearly vanishes, so the extremes can be mistaken for pitch movement. Nothing moved.
- Two tracks. The tier rule cut more than it kept.
- The audio chain is verified to 10⁻⁶. The frame inversion is only verified against itself — comparing it to an independent numeric product is the obvious next step and isn't done here.
- The NO₂ frame is 320×180 feeding a 45×80 grid, which is coarse.

## Team

The Fourier Collective — Kael Barba, Pranay Kaveri
