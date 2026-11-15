#!/usr/bin/env python3
"""
eic_frames.py - turn NASA EIC visual frames into an EarthSynth payload.

This is the tool that makes EarthSynth answer the Earth Jukebox challenge on
its own terms. The challenge asks for sonifications generated from EIC VISUAL
FRAMES, not from the numeric data behind them. So we take the frames and invert
them.

    EIC frame -> sample pixels -> invert the published colour bar -> values
    -> the sonification contract -> sound -> FFT -> values again

The inversion is only legitimate because the colour bar is PUBLISHED. NASA's
SVS ships the NO2 bar as its own image with the range printed on it: 0 to 12
x10^15 molecules/cm^2. That bar is a mapping from value to colour that someone
else defined and stated, which makes running it backwards a measurement rather
than a guess.

WHICH VISUALIZATIONS THIS WORKS ON, AND WHICH IT DOES NOT

Not every EIC visualization can be inverted, and the difference matters more
than the technique:

  - NO2 (SVS 4810) publishes a labelled colour bar. A value can be recovered
    and checked. It gets a contract, a tolerance and a residual.
  - The volumetric CO2 and CH4 renderings (SVS 5115, 5116) do not. Their pages
    describe colour only qualitatively and give no range, no units and no bar.
    They are beautiful and they are evidence of nothing recoverable: any value
    read out of them would be invented here. They get shown, and they get a
    soundscape driven by their own brightness, explicitly labelled as having no
    anchor - never a residual, because there is nothing to check against.

That distinction is the whole argument of this project, applied one level up:
a visualization you can question versus one you can only receive.

HOW CONFIDENT A PIXEL IS

Inverting by nearest colour always returns something, so the distance to the
ramp is kept as well. A basemap pixel, a coastline, a label or a cloud lands
far from every colour on the bar; a data pixel lands on it. Pixels beyond the
threshold are marked unobserved, which routes them into the same silence the
rest of the instrument already uses for absent data. Absence of data and a
value near zero stay distinguishable.

Usage:

    python3 eic_frames.py --bar cbar_NO2.png --bar-range 0 12 \\
        --frames no2_*.png --out ../data/no2 \\
        --units "1e15 molecules/cm^2" --label "Tropospheric NO2"
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from datetime import date
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

FILL = 32767
#: Colour-bar images are usually drawn with a border and arrow heads for
#: out-of-range values. Those are not part of the ramp.
DEFAULT_TRIM = 0.02


# ---------------------------------------------------------------------------
# colour space
# ---------------------------------------------------------------------------

def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.asarray(c, dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def oklab(rgb: np.ndarray) -> np.ndarray:
    """
    sRGB to OKLab.

    Nearest-colour matching has to happen in a space where equal distances look
    equally different, or the match is biased toward whichever hues RGB happens
    to spread out. OKLab is near-uniform, so "closest colour" means what it
    sounds like.
    """
    rgb = np.asarray(rgb, dtype=np.float64)
    r, g, b = (_srgb_to_linear(rgb[..., i]) for i in range(3))
    l = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return np.stack([
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ], axis=-1)


# ---------------------------------------------------------------------------
# the colour bar
# ---------------------------------------------------------------------------

def _unit(v: np.ndarray, eps: float = 1e-9):
    """Direction and magnitude of each row of an OKLab array."""
    mag = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(mag, eps), mag[..., 0]


class ColourBar:
    """
    A published value-to-colour mapping, read back out of its own image.

    TWO WAYS TO MATCH, AND WHY THE SECOND ONE EXISTS

    A filled map paints every data pixel at full strength, so the colour in the
    frame is the colour on the bar and plain nearest-neighbour in OKLab finds
    it. A streamline or particle rendering does not: it draws each line at the
    bar colour and composites it over black with a varying alpha, so a genuine
    data pixel is a DARKENED version of its bar colour. Matched literally, most
    of the frame is rejected as "not data" - on the ECCO2 map, all but 0.4% of
    it.

    The fix is not a looser threshold, which would start admitting basemap. It
    is to model what the renderer actually did. OKLab is a linear map of the
    cube roots of LMS, and compositing over black scales linear RGB by alpha;
    so the cube roots scale by alpha^(1/3), and the whole (L, a, b) vector
    scales by alpha^(1/3) with its DIRECTION unchanged. An alpha-blended ramp
    colour is therefore a scalar multiple of the original, and matching on the
    unit vector recovers the value exactly while the magnitude recovers the
    alpha - which is line density, not temperature, and is discarded.

    Pixels too close to black are still rejected: there the direction is
    numerical noise rather than a colour.
    """

    def __init__(self, ramp: np.ndarray, vmin: float, vmax: float,
                 alpha_blend: bool = False, min_magnitude: float = 0.12):
        self.ramp = ramp
        self.lab = oklab(ramp)
        self.vmin = vmin
        self.vmax = vmax
        self.alpha_blend = alpha_blend
        self.min_magnitude = min_magnitude
        self.values = vmin + np.arange(len(ramp)) / (len(ramp) - 1) * (vmax - vmin)
        self._tree = cKDTree(_unit(self.lab)[0] if alpha_blend else self.lab)

    @classmethod
    def from_image(cls, path: Path, vmin: float, vmax: float,
                   trim: float = DEFAULT_TRIM, **kw) -> "ColourBar":
        img = np.array(Image.open(path).convert('RGB')).astype(np.float64)

        # The bar is the band of rows with the most colour variation along x.
        colourfulness = img.std(axis=2).mean(axis=1)
        rows = np.where(colourfulness > colourfulness.max() * 0.35)[0]
        if rows.size == 0:
            raise SystemExit(f'{path}: no colour band found; is this a colour bar?')
        top = rows.min() + (rows.max() - rows.min()) // 4
        bottom = rows.max() - (rows.max() - rows.min()) // 4
        band = img[top:bottom + 1]

        # The rectangle's outline shows up as the largest colour jumps along
        # the row; everything outside those is border and arrow head.
        strip = band.mean(axis=0)
        jump = np.abs(np.diff(strip, axis=0)).sum(axis=1)
        mid = len(jump) // 2
        left = int(np.argmax(jump[:mid])) + 1
        right = int(mid + np.argmax(jump[mid:]))

        pad = int((right - left) * trim)
        ramp = band[:, left + pad:right - pad].mean(axis=0)
        return cls(ramp, vmin, vmax, **kw)

    def invert(self, pixels: np.ndarray):
        """
        Nearest colour on the bar, for an array of RGB pixels.

        Returns the recovered values and the OKLab distance to the ramp, which
        is what tells a data pixel from a basemap one.

        A KD-tree rather than a cross-product. The obvious
        `(pixels[:,None,:] - ramp[None,:,:])` is one line and allocates
        pixels x ramp x 3 floats: a 2576x1288 frame against a 900-entry ramp is
        over 70 GB, so it does not merely run slowly, it does not run. The tree
        is built once per bar and queried in O(log n) with flat memory.
        """
        shape = pixels.shape[:-1]
        q = oklab(np.asarray(pixels, dtype=np.float64).reshape(-1, 3))
        if self.alpha_blend:
            q, mag = _unit(q)
            dist, idx = self._tree.query(q, k=1, workers=-1)
            # A pixel too near black carries no direction to match, so it is
            # pushed past any threshold rather than matched to whatever the
            # rounding error happens to point at.
            dist = np.where(mag >= self.min_magnitude, dist, np.inf)
        else:
            dist, idx = self._tree.query(q, k=1, workers=-1)
        return self.values[idx].reshape(shape), dist.reshape(shape)

    def round_trip(self):
        """How well the bar inverts its own colours. The honest error floor."""
        back, _ = self.invert(self.ramp)
        err = np.abs(back - self.values)
        return float(err.mean()), float(err.max())


# ---------------------------------------------------------------------------
# the canonical grid
# ---------------------------------------------------------------------------
#
# Every track resamples onto the SAME 2x2 degree grid the GISTEMP payload uses.
# That is what lets one globe renderer, one set of region masks, one area
# weighting and one landmask serve the whole jukebox: a track is a different
# field over identical geometry, not a different program. It also means the
# region means of an EIC track and of GISTEMP are computed by the same code
# over the same cells, so the two are comparable rather than merely adjacent.

NLAT, NLON = 90, 180
LAT_START, LAT_STEP = -89.0, 2.0
LON_START, LON_STEP = -179.0, 2.0

#: Decibels of tilt the published range is allowed to span, end to end. The
#: contract keeps both partials measurable out to +/-40 dB; 30 leaves headroom
#: for a frame that runs slightly past its own bar.
TILT_SPAN_DB = 30.0

DEFAULT_REGIONS = [
    {'id': 'global', 'label': 'Global', 'lat': [-90, 90], 'lon': [-180, 180]},
    {'id': 'tropics', 'label': 'Tropics', 'lat': [-23.5, 23.5], 'lon': [-180, 180]},
    {'id': 'n-mid', 'label': 'N mid-latitudes', 'lat': [30, 60], 'lon': [-180, 180]},
    {'id': 's-mid', 'label': 'S mid-latitudes', 'lat': [-60, -30], 'lon': [-180, 180]},
]


IMAGE_REGIONS = [
    {'id': 'frame', 'label': 'Whole frame', 'lat': [0, 10 ** 6], 'lon': [0, 10 ** 6]},
]


def canonical_grid() -> dict:
    return {'nlat': NLAT, 'nlon': NLON, 'kind': 'geo',
            'lat_start': LAT_START, 'lat_step': LAT_STEP,
            'lon_start': LON_START, 'lon_step': LON_STEP,
            'note': 'The canonical 2x2 degree grid, shared with the GISTEMP track.'}


def image_grid(rows: int, cols: int) -> dict:
    return {'nlat': rows, 'nlon': cols, 'kind': 'image',
            'lat_start': 0.0, 'lat_step': 1.0,
            'lon_start': 0.0, 'lon_step': 1.0,
            'note': ('Rows and columns of the published frame. This visualization '
                     'states no geographic bounds, so georeferencing it would mean '
                     'inventing the one number that makes a map a map. The values '
                     'are still recovered through the published colour bar; only '
                     'their placement on the Earth is unclaimed.')}


def area_weights(grid: dict) -> np.ndarray:
    """
    cos(latitude) per cell for a geographic grid, uniform for an image one.

    Weighting an image grid by cos(row index) would be arithmetic performed on
    a number that is not an angle. Uniform is the only defensible choice when
    the frame's geography is not published, and the payload says which was used.
    """
    if grid['kind'] == 'image':
        return np.ones((grid['nlat'], grid['nlon']))
    lat = grid['lat_start'] + np.arange(grid['nlat']) * grid['lat_step']
    return np.repeat(np.cos(np.radians(lat))[:, None], grid['nlon'], axis=1)


def resample_image(value: np.ndarray, lit: np.ndarray, grid: dict):
    """Bin a frame's lit pixels into a plain rows x cols grid of itself."""
    rows, cols = grid['nlat'], grid['nlon']
    h, w = value.shape
    j = np.clip((np.arange(h) * rows) // h, 0, rows - 1)
    i = np.clip((np.arange(w) * cols) // w, 0, cols - 1)
    # Row 0 of the output is the BOTTOM of the frame, matching the geographic
    # case where row 0 is the southernmost band, so one scan direction serves
    # both and "top to bottom" means the same thing on screen either way.
    flat = ((rows - 1 - j)[:, None] * cols + i[None, :]).ravel()
    sel = lit.ravel()
    counts = np.bincount(flat[sel], minlength=rows * cols)
    sums = np.bincount(flat[sel], weights=value.ravel()[sel], minlength=rows * cols)
    mean = np.where(counts > 0, sums / np.maximum(counts, 1), 0.0)
    return mean.reshape(rows, cols), counts.reshape(rows, cols)


def resample(value: np.ndarray, lit: np.ndarray, geo) -> tuple[np.ndarray, np.ndarray]:
    """
    Average the lit pixels of an equirectangular frame onto the canonical grid.

    Pixels are binned by the cell they fall in rather than the frame being
    block-averaged, for the reason --sparse exists: a streamline rendering is
    thin bright marks on black, and averaging a block of mostly-black pixels
    produces a colour that is on no part of the bar. Only pixels that landed on
    the ramp contribute, and a cell with none of them is left unobserved rather
    than filled with a plausible number.
    """
    lat0, lat1, lon0, lon1 = geo
    h, w = value.shape

    # Pixel centres. Row 0 is the northern edge, as every map image is drawn.
    lat = lat1 - (np.arange(h) + 0.5) * (lat1 - lat0) / h
    lon = lon0 + (np.arange(w) + 0.5) * (lon1 - lon0) / w

    j = np.clip(np.round((lat - LAT_START) / LAT_STEP), 0, NLAT - 1).astype(np.int64)
    i = np.clip(np.round((lon - LON_START) / LON_STEP), 0, NLON - 1).astype(np.int64)
    flat = (j[:, None] * NLON + i[None, :]).ravel()

    v = value.ravel()[lit.ravel()]
    k = flat[lit.ravel()]
    counts = np.bincount(k, minlength=NLAT * NLON)
    sums = np.bincount(k, weights=v, minlength=NLAT * NLON)

    with np.errstate(invalid='ignore', divide='ignore'):
        mean = np.where(counts > 0, sums / np.maximum(counts, 1), 0.0)
    return mean.reshape(NLAT, NLON), counts.reshape(NLAT, NLON)


def region_masks(defs, grid):
    """Cell masks for each region definition, in the grid's own coordinates."""
    NLAT, NLON = grid['nlat'], grid['nlon']
    lat = grid['lat_start'] + np.arange(NLAT) * grid['lat_step']
    lon = grid['lon_start'] + np.arange(NLON) * grid['lon_step']
    out = {}
    for d in defs:
        la0, la1 = d['lat']
        lo0, lo1 = d['lon']
        m = (((lat >= la0) & (lat <= la1))[:, None]
             & ((lon >= lo0) & (lon <= lo1))[None, :])
        if not m.any():
            raise SystemExit(f"region {d['id']} selects no cells")
        out[d['id']] = m
    return out


def region_series(field, masks, weights, scale, offset, axis_kind, nlat):
    """
    The check values, computed from the QUANTIZED payload.

    From the payload rather than from the floats upstream of it, because the
    browser will decode these exact bytes. Computing the check values from the
    pre-quantization array is how you get a verifier that fails by a hair on a
    correct build - it happened once already on the GISTEMP track.
    """
    out = {}
    observed = field != FILL
    decoded = np.where(observed, field * scale + offset, np.nan)

    for rid, mask in masks.items():
        series, coverage = [], []
        total = float(weights[mask].sum())
        if axis_kind == 'scan-lat':
            # One step per latitude row, north to south, mirroring the axis the
            # player sweeps. The browser averages the same cells the same way.
            for row in range(nlat - 1, -1, -1):
                rm = np.zeros_like(mask)
                rm[row] = mask[row]
                series.append(_mean(decoded[0], rm, weights, observed[0]))
                rw = float(weights[rm].sum())
                coverage.append(
                    float(weights[rm & observed[0]].sum() / rw) if rw else 0.0)
        else:
            for t in range(field.shape[0]):
                series.append(_mean(decoded[t], mask, weights, observed[t]))
                coverage.append(float(weights[mask & observed[t]].sum() / total))
        out[rid] = {
            'series': [None if v is None else round(v, 6) for v in series],
            'coverage': [round(c, 4) for c in coverage],
        }
    return out


def _mean(decoded_frame, mask, weights, observed_frame):
    sel = mask & observed_frame
    w = weights[sel].sum()
    if w == 0:
        return None
    return float((decoded_frame[sel] * weights[sel]).sum() / w)


# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bar', required=True, type=Path, help='the published colour bar image')
    ap.add_argument('--bar-range', required=True, nargs=2, type=float, metavar=('MIN', 'MAX'))
    ap.add_argument('--frames', required=True, nargs='+', type=Path)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--units', required=True)
    ap.add_argument('--label', required=True)
    ap.add_argument('--source', default='', help='the SVS page URL')
    ap.add_argument('--threshold', type=float, default=0.04,
                    help='OKLab distance beyond which a pixel is not data')
    ap.add_argument('--downsample', type=int, default=4,
                    help='block factor; frames are far finer than the data behind them')
    ap.add_argument('--sparse', action='store_true',
                    help='for streamline or stippled renderings: classify at full '
                         'resolution and aggregate the lit pixels only')
    ap.add_argument('--min-pixels', type=int, default=3,
                    help='lit pixels a grid cell needs before it counts as observed')
    ap.add_argument('--scale', type=float, default=0.0,
                    help='int16 scale factor; 0 picks one from the range')
    ap.add_argument('--geo', nargs=4, type=float, default=[-90, 90, -180, 180],
                    metavar=('LAT0', 'LAT1', 'LON0', 'LON1'),
                    help='geographic bounds of the frame, equirectangular')
    ap.add_argument('--crop', nargs=4, type=int, default=None,
                    metavar=('LEFT', 'TOP', 'RIGHT', 'BOTTOM'),
                    help='pixels to cut before projecting; titles, bars and borders '
                         'are not map')
    ap.add_argument('--axis', choices=['auto', 'time', 'scan-lat'], default='auto',
                    help='auto: a single frame is scanned by latitude, a sequence is played')
    ap.add_argument('--landfrac', type=Path, default=Path('../data/landfrac.u8'),
                    help='landmask on the canonical grid, copied in beside the payload')
    ap.add_argument('--balance-at', type=float, default=None,
                    help='value at which the two carrier partials sit level; '
                         'defaults to the middle of the published bar')
    ap.add_argument('--grid', choices=['geo', 'image'], default='geo',
                    help='geo: an equirectangular map, resampled onto the canonical '
                         '2x2 degree grid and drawn on the globe. image: a frame '
                         'whose geographic bounds are not published, kept as rows '
                         'and columns of itself')
    ap.add_argument('--image-grid', nargs=2, type=int, default=[72, 128],
                    metavar=('ROWS', 'COLS'), help='target size for --grid image')
    ap.add_argument('--alpha-blend', action='store_true',
                    help='the frame draws data as lines or particles composited over '
                         'black; match on colour direction, which that compositing '
                         'leaves unchanged, rather than on the darkened colour itself')
    ap.add_argument('--mask-box', nargs=4, type=int, action='append', default=[],
                    metavar=('LEFT', 'TOP', 'RIGHT', 'BOTTOM'),
                    help='blank a rectangle before inverting. EIC stills often print '
                         'their own legend INSIDE the map, and those pixels are ramp '
                         'colours that are not measurements of anywhere. Repeatable.')
    ap.add_argument('--min-magnitude', type=float, default=0.12,
                    help='with --alpha-blend, the OKLab magnitude below which a pixel '
                         'is too near black to carry a direction')
    args = ap.parse_args()

    vmin, vmax = args.bar_range
    bar = ColourBar.from_image(args.bar, vmin, vmax,
                               alpha_blend=args.alpha_blend,
                               min_magnitude=args.min_magnitude)
    mean_err, max_err = bar.round_trip()
    if args.alpha_blend:
        print('matching     on OKLab direction (alpha-over-black compositing)')
    print(f'colour bar   {args.bar.name}: {len(bar.ramp)} steps, {vmin}..{vmax} {args.units}')
    print(f'             round trip mean {mean_err:.4f}  worst {max_err:.4f} {args.units}')

    # The scale is pinned to the PUBLISHED range, not to what the frames happen
    # to contain. A quantization derived from the data would change whenever a
    # frame was added, and a mapping that moves when the data moves is the one
    # thing an anchored contract forbids.
    scale = args.scale or round((vmax - vmin) / 30000, 8)
    frames = sorted(args.frames)
    print(f'frames       {len(frames)}, quantising at {scale} {args.units} per count')

    grid = (canonical_grid() if args.grid == 'geo'
            else image_grid(*args.image_grid))
    weights = area_weights(grid)
    stack, coverage, cell_counts = [], [], []

    for path in frames:
        img = np.array(Image.open(path).convert('RGB')).astype(np.float64)
        if args.crop:
            left, top, right, bottom = args.crop
            img = img[top:img.shape[0] - bottom, left:img.shape[1] - right]

        # Classify at FULL resolution, always. Block-averaging the pixels first
        # blends a lit streamline with the black gaps around it and drags the
        # colour off the ramp entirely - at 4x it threw away all but 0.1% of an
        # ECCO2 frame. Resampling happens after classification, never before.
        value_full, dist_full = bar.invert(img)
        lit = dist_full < args.threshold
        for left, top, right, bottom in args.mask_box:
            lit[top:bottom, left:right] = False

        value, counts = (resample(value_full, lit, args.geo) if args.grid == 'geo'
                         else resample_image(value_full, lit, grid))
        observed = counts >= args.min_pixels

        q_counts = np.round((value - vmin) / scale)
        # Check the DATA, not the array that already holds the fill value -
        # otherwise the guard fires on its own sentinel every time.
        if observed.any() and q_counts[observed].max() >= FILL:
            raise SystemExit(
                f'{path}: {q_counts[observed].max():.0f} counts overflows the fill '
                f'value {FILL}; raise --scale'
            )
        stack.append(np.where(observed, q_counts, FILL).astype('<i2'))

        area = float(weights[observed].sum() / weights.sum())
        coverage.append(area)
        cell_counts.append(int(observed.sum()))
        vals = value[observed]
        print(f'  {path.name:<34s} {img.shape[1]:5d}x{img.shape[0]:<5d} -> '
              f'{grid["nlat"]}x{grid["nlon"]}  {lit.mean() * 100:5.1f}% lit  '
              f'{area * 100:5.1f}% of area  '
              f'median {np.median(vals):7.2f}  '
              f'p5 {np.percentile(vals, 5):7.2f}  '
              f'p95 {np.percentile(vals, 95):7.2f} {args.units}')

    field = np.stack(stack)
    nt = field.shape[0]
    axis_kind = args.axis
    if axis_kind == 'auto':
        # A still has no time to play, so it is swept by latitude instead. A
        # sequence plays as a sequence.
        axis_kind = 'scan-lat' if nt == 1 else 'time'
    if axis_kind == 'scan-lat' and nt != 1:
        raise SystemExit('--axis scan-lat expects exactly one frame')

    # The contract's terms come from the published bar: balance at its middle,
    # and a slope that puts the two ends of the bar at the edges of the usable
    # tilt range. Both are properties of the legend NASA printed, not of the
    # pixels, so adding frames cannot move them.
    balance = args.balance_at if args.balance_at is not None else (vmin + vmax) / 2
    slope = round(TILT_SPAN_DB / (vmax - vmin), 4)

    region_defs = DEFAULT_REGIONS if args.grid == 'geo' else IMAGE_REGIONS
    masks = region_masks(region_defs, grid)
    checks = region_series(field, masks, weights, scale, vmin, axis_kind, grid['nlat'])

    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    blob = gzip.compress(field.tobytes(), 9)
    (out / 'field.i16.gz').write_bytes(blob)

    if args.grid == 'geo':
        if not args.landfrac.exists():
            raise SystemExit(
                f'{args.landfrac} not found. A geographic track renders on the same '
                f'globe as every other one, so it needs the same landmask; point '
                f'--landfrac at the one preprocess.py wrote.'
            )
        (out / 'landfrac.u8').write_bytes(args.landfrac.read_bytes())
    else:
        # No globe, so no landmask - but the loader expects the file to exist,
        # and an all-ocean mask is the honest stand-in for "this is not a map".
        (out / 'landfrac.u8').write_bytes(bytes(grid['nlat'] * grid['nlon']))

    flat = field.reshape(-1)
    probe_idx = [i for i in (len(flat) // 7, len(flat) // 3, len(flat) - 1)]

    regions_doc = {
        'note': (
            'Regions for an EIC frame track. The cells, the cos(latitude) weighting '
            'and the masks are identical to the GISTEMP track, so the two are '
            'comparable rather than merely adjacent.'
        ),
        'regions': [
            {
                'id': d['id'], 'label': d['label'], 'slope': slope,
                'requested_bounds': {'lat': d['lat'], 'lon': d['lon']},
                'bounds': {'lat': d['lat'], 'lon': d['lon']},
                'cells': int(masks[d['id']].sum()),
            }
            for d in region_defs
        ],
    }
    (out / 'regions.json').write_text(json.dumps(regions_doc, indent=2) + '\n')

    meta = {
        'schema': 1,
        'generated': date.today().isoformat(),
        'dataset': {
            'name': f'{args.label} (NASA SVS / Earth Information Center)',
            'attribution': "NASA's Scientific Visualization Studio",
            'source_url': args.source,
            'units': args.units,
            'colour_bar': args.bar.name,
            'colour_bar_range': [vmin, vmax],
            'derivation': (
                'Recovered from the published colour bar of the EIC visual frames, '
                'not from the numeric product behind them. The bar is a mapping '
                'someone else defined and stated; this runs it backwards.'
            ),
            'inversion_error': {
                'mean': round(mean_err, 5),
                'max': round(max_err, 5),
                'note': (
                    'How accurately the colour bar inverts its own colours. This is '
                    'the floor: a frame can be no more faithful than its own legend.'
                ),
            },
        },
        'contract': {
            'slope': slope,
            'balance_at': balance,
            'units': args.units,
            'note': (
                f'{slope} dB of spectral tilt per {args.units}, level at {balance}. '
                f'Both come from the published bar: the balance point is its middle '
                f'and the slope spans {TILT_SPAN_DB} dB end to end.'
            ),
        },
        'grid': grid,
        'axis': {'kind': axis_kind,
                 'note': ('A still frame has no time axis, so the transport sweeps it '
                          'north to south, sounding the area-weighted mean of each '
                          'latitude band.')
                 if axis_kind == 'scan-lat' else 'One step per published frame.'},
        'time': {'cadence': 'frame', 'count': nt, 'frames': [p.name for p in frames]},
        'field': {'file': 'field.i16.gz', 'encoding': 'gzip', 'dtype': 'int16',
                  'endianness': 'little', 'layout': '[frame][lat][lon], C order',
                  'scale_factor': scale, 'offset': vmin, 'fill_value': FILL,
                  'bytes_gzipped': len(blob),
                  'sha256': hashlib.sha256(blob).hexdigest()},
        'landfrac': {'file': 'landfrac.u8', 'dtype': 'uint8',
                     'scale': 1 / 255, 'layout': '[lat][lon], C order',
                     'note': 'Presentation only; carries no magnitude.'},
        'coverage': [round(c, 4) for c in coverage],
        'cells_observed': cell_counts,
        'threshold': args.threshold,
        'min_pixels': args.min_pixels,
        'geo': args.geo,
        'crop': args.crop,
        'threshold_note': (
            'OKLab distance from the colour bar beyond which a pixel is treated as '
            'not data. Basemap, coastlines, labels and cloud land far from every '
            'colour on the bar; data pixels land on it. Marked pixels fall silent, '
            'so missing data never sounds like a low value.'
        ),
        'verification': {
            'note': ('CHECK VALUES, NOT DATA. The player recomputes these in the '
                     'browser from field.i16 and refuses to sound anything if they '
                     'disagree.'),
            'tolerance': 1e-6,
            'tolerance_note': ('Computed from the quantized payload - the same bytes '
                               'the browser decodes - so the only disagreement this '
                               'can catch is a real one.'),
            'probes': [{'index': int(i), 'raw': int(flat[i])} for i in probe_idx],
            'probes_note': ('Raw int16 values at known flat indices. A mismatch means '
                            'the payload was decoded with the wrong endianness or '
                            'layout.'),
            'regions': checks,
        },
    }
    (out / 'meta.json').write_text(json.dumps(meta, indent=2) + '\n')

    print(f'\ncontract     {slope} dB per {args.units}, level at {balance} {args.units}')
    print(f'wrote        {out}/field.i16.gz  ({len(blob) / 1e6:.2f} MB)')
    print(f'             meta.json, regions.json, landfrac.u8')
    print(f'             {nt} frame(s) on a {grid["nlat"]}x{grid["nlon"]} '
          f'{grid["kind"]} grid, axis "{axis_kind}"')
    for rid, c in checks.items():
        vals = [v for v in c['series'] if v is not None]
        if vals:
            print(f'  {rid:<16s} {len(vals):3d} steps  '
                  f'{min(vals):7.2f} .. {max(vals):7.2f} {args.units}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
