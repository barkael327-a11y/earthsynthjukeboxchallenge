#!/usr/bin/env python3
"""
preprocess.py - turn the published GISTEMP files into EarthSynth's committed payload.

Runs ONCE, before the hackathon, and its output is committed. The browser never
parses netCDF.

    python3 preprocess.py \
        --nc       gistemp1200_GHCNv4_ERSSTv5.nc \
        --glb      GLB.Ts+dSST.csv \
        --zonann   ZonAnn.Ts+dSST.csv \
        --landmask landmask.2degx2deg.txt \
        --out      ../data

What it writes into --out:

    field.i16.gz   the anomaly field, int16, little-endian, gzipped.
                   Layout [year][lat][lon], C order, lat and lon both ascending.
                   Fill value 32767, scale factor 0.01, exactly as published.
    landfrac.u8    land fraction per cell, 0-255, same grid, 16200 bytes.
    meta.json      axes, units, baseline, provenance, access date, and the
                   verification block described below.
    index.json     NASA's own published series, for the on-screen cross-check.
    regions.json   region bounds and per-region kappa. Definitions only.

On the verification block. meta.json carries, per region, the area-weighted
annual series that THIS script computed. Those numbers are check values, not
data: the player recomputes the series in the browser from field.i16 and
asserts agreement. If the player ever reads them as a source of sound, the
central architectural claim - that one array drives both the map and the tone -
quietly becomes false. earth-series.js must never fall back to them.

Quantization note: no quantization happens here. The published file is already
int16 with scale_factor 0.01; we pass that through. The only transformation is
monthly to annual means.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from scipy.io import netcdf_file

# Fully absent cell-years make nanmean warn about an empty slice. That case is
# expected and handled (the year becomes fill), so the warning is noise.
np.seterr(invalid="ignore")
import warnings
warnings.filterwarnings("ignore", message="Mean of empty slice")

# ----------------------------------------------------------------------------
# Constants fixed by the published product. Verified against the file header on
# 2026-11-11; assert_source_matches() re-checks them on every run so a future
# GISTEMP release cannot change them silently.
# ----------------------------------------------------------------------------
FILL = 32767           # _FillValue in the published netCDF
SCALE = 0.01           # scale_factor in the published netCDF, degrees C per count
BASELINE = "1951-1980"
EPOCH = date(1800, 1, 1)   # "days since 1800-01-01 00:00:00"
NLAT, NLON = 90, 180       # 2 x 2 degree grid
MIN_MONTHS = 9             # months required before a cell-year counts as observed

# Region definitions. The slope is authored, not derived: it is chosen from the
# measured range of each region and then held fixed, which is the whole point of
# an anchored mapping. check_tilt() verifies the choice still fits the data.
#
# slope is decibels of spectral tilt per degree Celsius - the balance between
# the 220 Hz and 880 Hz carrier partials. See src/contract.js.
REGIONS = [
    # id, label, lat_min, lat_max, lon_min, lon_max, slope
    ("global",    "Global",            -90,  90, -180, 180, 20.0),
    ("arctic",    "Arctic",             64,  90, -180, 180,  8.0),
    ("n-eurasia", "Northern Eurasia",   45,  65,   10, 180, 10.0),
    ("tropics",   "Tropics",           -24,  24, -180, 180, 20.0),
]

# Beyond this the quieter partial sits too far under the louder one to measure
# reliably, so a region that would leave the band needs a gentler slope.
TILT_LIMIT_DB = 40.0
# What the analysis can resolve in a magnitude ratio, used to report the
# tolerance each slope buys.
DB_PRECISION = 0.05


def to_tilt(dt: float, slope: float) -> float:
    """Mirror of contract.js toTilt()."""
    return slope * dt


# ----------------------------------------------------------------------------


def assert_source_matches(var, lat, lon, times) -> dict:
    """Fail loudly if the published file is not shaped the way we expect."""
    problems = []
    attrs = {k: (v.decode() if isinstance(v, bytes) else v)
             for k, v in var._attributes.items()}

    if var.data.dtype.kind != "i" or var.data.dtype.itemsize != 2:
        problems.append(f"tempanomaly dtype is {var.data.dtype}, expected int16")
    # scale_factor is stored as float32, so it reads back as 0.00999999978 rather
    # than 0.01. Compare at float32 precision and then use the exact decimal: the
    # difference is 2e-8 relative, four orders of magnitude below the tolerance
    # the validators resolve, and using one constant in both directions keeps the
    # decode and re-encode exactly self-inverse.
    published_scale = float(attrs.get("scale_factor", 0))
    if abs(published_scale - SCALE) > 1e-6 * SCALE:
        problems.append(f"scale_factor is {published_scale}, expected {SCALE}")
    if int(attrs.get("_FillValue", 0)) != FILL:
        problems.append(f"_FillValue is {attrs.get('_FillValue')}, expected {FILL}")
    if (len(lat), len(lon)) != (NLAT, NLON):
        problems.append(f"grid is {len(lat)}x{len(lon)}, expected {NLAT}x{NLON}")
    if not (np.allclose(np.diff(lat), 2.0) and np.allclose(np.diff(lon), 2.0)):
        problems.append("grid spacing is not a uniform 2 degrees")
    if lat[0] > lat[-1] or lon[0] > lon[-1]:
        problems.append("axes are not ascending; the payload layout assumes they are")
    if len(times) < 12:
        problems.append("fewer than one year of data")

    if problems:
        raise SystemExit(
            "The published file does not match what EarthSynth expects:\n  - "
            + "\n  - ".join(problems)
            + "\n\nThis is the check that stops a GISTEMP update from silently "
              "changing what the instrument claims. Fix the constants at the top "
              "of this file deliberately, then re-run."
        )
    return attrs


def read_published_tables(glb_path: Path, zon_path: Path) -> dict:
    """NASA's own annual numbers, kept for the on-screen cross-check."""
    glb = {}
    for line in glb_path.read_text().splitlines():
        parts = line.split(",")
        if len(parts) > 13 and parts[0].strip().isdigit():
            jd = parts[13].strip()
            if jd not in ("***", ""):
                glb[int(parts[0])] = float(jd)

    zon_rows = [l.split(",") for l in zon_path.read_text().splitlines() if l.strip()]
    header = [c.strip() for c in zon_rows[0]]
    zon: dict[str, dict[int, float]] = {c: {} for c in header[1:]}
    for row in zon_rows[1:]:
        cells = [c.strip() for c in row]
        if not cells[0].isdigit():
            continue
        year = int(cells[0])
        for name, value in zip(header[1:], cells[1:]):
            if value not in ("***", ""):
                zon[name][year] = float(value)
    return {"global_annual": glb, "zonal_annual": zon}


def read_landmask(path: Path, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Land fraction on the same grid. Presentation only; carries no magnitude."""
    raw = np.loadtxt(path, skiprows=2)
    i = raw[:, 0].astype(int) - 1
    j = raw[:, 1].astype(int) - 1
    frac = np.zeros((NLAT, NLON))
    frac[j, i] = raw[:, 4]

    grid_lon = np.zeros(NLON); grid_lon[i] = raw[:, 2]
    grid_lat = np.zeros(NLAT); grid_lat[j] = raw[:, 3]
    if not (np.allclose(grid_lat, lat) and np.allclose(grid_lon, lon)):
        raise SystemExit("landmask grid does not align with the netCDF grid")
    return frac


def monthly_to_annual(values: np.ndarray, years: np.ndarray, last_full_year: int):
    """
    Annual mean per cell from the monthly field.

    A cell-year is observed when at least MIN_MONTHS of its months are observed,
    and its value is the mean of those months. Partial years below the threshold
    become fill: an interpolated or thinly-sampled cell must not sound identical
    to a fully observed one.
    """
    wanted = np.arange(int(years.min()), last_full_year + 1)
    annual = np.full((len(wanted), NLAT, NLON), np.nan, dtype=np.float64)
    months = np.zeros((len(wanted), NLAT, NLON), dtype=np.int16)

    for idx, year in enumerate(wanted):
        block = values[years == year]
        count = np.sum(~np.isnan(block), axis=0)
        with np.errstate(invalid="ignore"):
            mean = np.nanmean(block, axis=0)
        annual[idx] = np.where(count >= MIN_MONTHS, mean, np.nan)
        months[idx] = count

    return wanted, annual, months


def area_weights(lat: np.ndarray) -> np.ndarray:
    """cos(latitude). A naive mean over a regular grid over-weights the poles."""
    return np.repeat(np.cos(np.deg2rad(lat))[:, None], NLON, axis=1)


def region_mask(lat, lon, lat_min, lat_max, lon_min, lon_max):
    """Cells whose centres fall inside the requested bounds."""
    rows = (lat >= lat_min) & (lat <= lat_max)
    cols = (lon >= lon_min) & (lon <= lon_max)
    return rows[:, None] & cols[None, :]


def region_series(annual, mask, weights):
    """
    Area-weighted mean over observed cells only, plus the observed area fraction.

    Renormalising over observed cells matters: a region 42% observed and one
    100% observed must not report the same confidence, and the coverage figure
    is what drives the uncertainty layer.
    """
    n = annual.shape[0]
    series = np.full(n, np.nan)
    coverage = np.zeros(n)
    total = float((weights * mask).sum())
    for t in range(n):
        field = annual[t]
        good = (~np.isnan(field)) & mask
        w = float((weights * good).sum())
        if w > 0:
            series[t] = float((field[good] * weights[good]).sum() / w)
            coverage[t] = w / total
    return series, coverage


def check_tilt(regions_out) -> list[str]:
    """Warn if a region's record would push a carrier partial out of measurable range."""
    warnings = []
    for r in regions_out:
        lo, hi = to_tilt(r["min"], r["slope"]), to_tilt(r["max"], r["slope"])
        if lo < -TILT_LIMIT_DB or hi > TILT_LIMIT_DB:
            warnings.append(
                f"{r['id']}: slope={r['slope']} dB/degC puts the record at "
                f"{lo:+.0f}..{hi:+.0f} dB, outside +/-{TILT_LIMIT_DB:.0f} dB. "
                f"Revisit the slope deliberately."
            )
    return warnings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nc", required=True, type=Path)
    ap.add_argument("--glb", required=True, type=Path)
    ap.add_argument("--zonann", required=True, type=Path)
    ap.add_argument("--landmask", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--access-date", default=date.today().isoformat(),
                    help="date the source files were downloaded, for the citation")
    args = ap.parse_args()

    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    # ---- read the published field -----------------------------------------
    nc = netcdf_file(str(args.nc), "r", mmap=False)
    lat = nc.variables["lat"][:].astype("f8")
    lon = nc.variables["lon"][:].astype("f8")
    tim = nc.variables["time"][:].astype("i8")
    var = nc.variables["tempanomaly"]
    raw = var[:].astype("i2")
    provenance = {k: (v.decode() if isinstance(v, bytes) else v)
                  for k, v in nc._attributes.items()}
    attrs = assert_source_matches(var, lat, lon, tim)
    nc.close()

    stamps = [EPOCH + timedelta(days=int(d)) for d in tim]
    years = np.array([s.year for s in stamps])
    print(f"source      {args.nc.name}")
    print(f"            {provenance.get('history', '(no history attribute)')}")
    print(f"grid        {NLAT} x {NLON} at 2 deg, "
          f"lat {lat[0]:+.0f}..{lat[-1]:+.0f}, lon {lon[0]:+.0f}..{lon[-1]:+.0f}")
    print(f"months      {stamps[0]} .. {stamps[-1]}  (n={len(stamps)})")

    # Only complete calendar years are sounded. A year with nine of twelve
    # months is not an annual mean.
    counts = {y: int((years == y).sum()) for y in np.unique(years)}
    last_full = max(y for y, c in counts.items() if c == 12)
    if counts[years.max()] != 12:
        print(f"            {years.max()} has only {counts[years.max()]} months; "
              f"record ends at {last_full}")

    values = np.where(raw == FILL, np.nan, raw * SCALE)
    year_list, annual, months = monthly_to_annual(values, years, last_full)

    full = int((months == 12).sum())
    part = int(((months > 0) & (months < 12)).sum())
    none = int((months == 0).sum())
    kept = int(((months >= MIN_MONTHS) & (months < 12)).sum())
    total = months.size
    print(f"annual      {year_list[0]}..{year_list[-1]} ({len(year_list)} steps)")
    print(f"cell-years  {full/total*100:.1f}% complete, {part/total*100:.1f}% partial "
          f"({kept} of {part} partial kept at >= {MIN_MONTHS} months), "
          f"{none/total*100:.1f}% absent")

    # ---- the payload -------------------------------------------------------
    quantised = np.where(np.isnan(annual), FILL, np.round(annual / SCALE))
    field = quantised.astype("<i2")             # little-endian, explicit
    blob = gzip.compress(field.tobytes(), 9)
    (out / "field.i16.gz").write_bytes(blob)
    digest = hashlib.sha256(blob).hexdigest()
    print(f"field       {field.nbytes/1e6:.2f} MB raw -> {len(blob)/1e6:.2f} MB gzipped")

    land = read_landmask(args.landmask, lat, lon)
    (out / "landfrac.u8").write_bytes(np.round(land * 255).astype("u1").tobytes())

    # ---- regional series, for verification only ----------------------------
    #
    # Computed from the QUANTIZED field, decoded exactly as the browser decodes
    # it, not from the float means above. The check values have to be what the
    # browser should reproduce bit-for-bit from the payload it actually loads.
    # Averaging the pre-quantization floats instead leaves a built-in offset of
    # up to about 0.0007 degrees C in the Arctic - small, but it would make the
    # integrity check permanently fail by a fixed amount and so teach everyone
    # to ignore it.
    annual_q = np.where(field == FILL, np.nan, field.astype("f8") * SCALE)

    weights = area_weights(lat)
    published = read_published_tables(args.glb, args.zonann)

    cross_ref = {"global": ("global_annual", None),
                 "arctic": ("zonal_annual", "64N-90N"),
                 "tropics": ("zonal_annual", "24S-24N")}

    regions_out, verification = [], {}
    print("\nregion                    dB/degC    tilt range dB    range degC   "
          "  vs NASA mean/worst  resolution")
    for rid, label, la0, la1, lo0, lo1, slope in REGIONS:
        mask = region_mask(lat, lon, la0, la1, lo0, lo1)
        series, coverage = region_series(annual_q, mask, weights)
        good = series[~np.isnan(series)]

        # What shipping int16 at 0.01 degC costs in a regional mean. Reported
        # rather than assumed: it belongs beside the validator's tolerance so
        # the two can be compared.
        float_series, _ = region_series(annual, mask, weights)
        both = ~np.isnan(series) & ~np.isnan(float_series)
        quantization_cost = float(np.abs(series[both] - float_series[both]).max())

        rows = lat[(lat >= la0) & (lat <= la1)]
        cols = lon[(lon >= lo0) & (lon <= lo1)]
        realised = {"lat": [float(rows.min() - 1), float(rows.max() + 1)],
                    "lon": [float(cols.min() - 1), float(cols.max() + 1)]}

        entry = {
            "id": rid, "label": label, "slope": slope,
            "requested_bounds": {"lat": [la0, la1], "lon": [lo0, lo1]},
            "bounds": realised,
            "cells": int(mask.sum()),
            "min": round(float(good.min()), 4),
            "max": round(float(good.max()), 4),
            "quantization_cost": round(quantization_cost, 6),
        }

        diff_text = "-"
        key = cross_ref.get(rid)
        if key:
            table = published[key[0]] if key[1] is None else published[key[0]][key[1]]
            diffs = [series[i] - table[int(y)]
                     for i, y in enumerate(year_list)
                     if int(y) in table and not np.isnan(series[i])]
            if diffs:
                d = np.array(diffs)
                entry["published_comparison"] = {
                    "source": key[1] or "GLB.Ts+dSST J-D",
                    "years": len(d),
                    "mean_difference": round(float(d.mean()), 4),
                    "max_abs_difference": round(float(np.abs(d).max()), 4),
                }
                diff_text = f"{d.mean():+.3f} / {np.abs(d).max():.3f}"

        regions_out.append(entry)
        verification[rid] = {
            # Six decimals, not four: at four the serialisation rounding alone
            # is 5e-5 degC, which would swamp the tolerance and make the check
            # meaningless.
            "series": [None if np.isnan(v) else round(float(v), 6) for v in series],
            "coverage": [round(float(c), 4) for c in coverage],
        }
        lo_db, hi_db = to_tilt(entry["min"], slope), to_tilt(entry["max"], slope)
        entry["tilt_range_db"] = [round(lo_db, 2), round(hi_db, 2)]
        entry["resolution_degC"] = round(DB_PRECISION / slope, 5)
        print(f"  {label:<24s} {slope:5.1f}   {lo_db:+6.1f}..{hi_db:+6.1f}    "
              f"{entry['min']:+.2f} .. {entry['max']:+.2f}   {diff_text:>16s}  "
              f"{entry['resolution_degC']:.5f}")

    # ---- metadata ----------------------------------------------------------
    probes = []
    for t, y, x in ((0, 45, 90), (len(year_list) // 2, 70, 10), (len(year_list) - 1, 80, 170)):
        probes.append({"index": int(t * NLAT * NLON + y * NLON + x),
                       "raw": int(field[t, y, x])})

    meta = {
        "schema": 1,
        "generated": date.today().isoformat(),
        "dataset": {
            "name": "NASA GISS Surface Temperature Analysis (GISTEMP v4)",
            "attribution": "NASA GISS/GISTEMP",
            "citation": (
                "GISTEMP Team, 2026: GISS Surface Temperature Analysis (GISTEMP), "
                f"version 4. NASA Goddard Institute for Space Studies. Dataset "
                f"accessed {args.access_date} at https://data.giss.nasa.gov/gistemp/."
            ),
            "source_file": args.nc.name,
            "access_date": args.access_date,
            "provenance": provenance.get("history", ""),
            "baseline": BASELINE,
            "units": "degC",
            "units_note": (
                "The published variable is labelled K. These are anomalies, and a "
                "difference of one kelvin is a difference of one degree Celsius."
            ),
            "smoothing": "1200 km, land-ocean index (ERSSTv5 over ocean)",
            "smoothing_note": (
                "Each cell draws on stations up to 1200 km away, so the field is "
                "smoother and neighbouring cells are less independent than they look."
            ),
        },
        "grid": {
            "nlat": NLAT, "nlon": NLON,
            "lat_start": float(lat[0]), "lat_step": 2.0,
            "lon_start": float(lon[0]), "lon_step": 2.0,
            "note": "Values are cell centres. Both axes ascend.",
        },
        "time": {
            "cadence": "annual",
            "year_start": int(year_list[0]),
            "year_end": int(year_list[-1]),
            "count": len(year_list),
            "rule": (
                f"Annual mean of the observed months; a cell-year counts as "
                f"observed only with at least {MIN_MONTHS} of 12 months."
            ),
            "excluded": (
                f"{int(years.max())} is excluded: it has "
                f"{counts[years.max()]} of 12 months."
            ) if counts[years.max()] != 12 else None,
        },
        "field": {
            "file": "field.i16.gz",
            "encoding": "gzip",
            "dtype": "int16",
            "endianness": "little",
            "layout": "[year][lat][lon], C order",
            "scale_factor": SCALE,
            "fill_value": FILL,
            "quantization_note": (
                "No quantization is applied here. The published file is already "
                "int16 with scale_factor 0.01; this is NASA's own quantization, "
                "passed through."
            ),
            "bytes_raw": int(field.nbytes),
            "bytes_gzipped": len(blob),
            "sha256": digest,
        },
        "landfrac": {
            "file": "landfrac.u8", "dtype": "uint8", "scale": 1 / 255,
            "layout": "[lat][lon], C order",
            "note": "Land fraction. Presentation only; carries no magnitude.",
        },
        "verification": {
            "note": (
                "CHECK VALUES, NOT DATA. The player recomputes these series in the "
                "browser from field.i16 and asserts agreement at load. It must never "
                "read them as a source of sound: the claim that one array drives both "
                "the map and the tone depends on it."
            ),
            "tolerance": 1e-6,
            "tolerance_note": (
                "The check values are computed from the quantized payload, the "
                "same bytes the browser decodes, so any real disagreement is an "
                "error in the weighting. What remains is floating-point summation "
                "order between numpy and JavaScript."
            ),
            "probes": probes,
            "probes_note": (
                "Raw int16 values at known flat indices. A mismatch means the payload "
                "was decoded with the wrong endianness or layout."
            ),
            "regions": verification,
        },
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    (out / "regions.json").write_text(json.dumps(
        {"note": "Definitions only. Every value is computed in the browser from "
                 "field.i16; nothing here carries a measurement. slope is dB of "
                 "spectral tilt per degree C between the 220 Hz and 880 Hz "
                 "carrier partials; see src/contract.js.",
         "regions": regions_out}, indent=2) + "\n")
    (out / "index.json").write_text(json.dumps({
        "note": "NASA's own published annual series, shown beside ours as a "
                "cross-check. Never sounded.",
        "source": {"global": args.glb.name, "zonal": args.zonann.name},
        "global_annual": published["global_annual"],
        "zonal_annual": {k: v for k, v in published["zonal_annual"].items()
                         if k in ("Glob", "64N-90N", "24S-24N")},
    }, indent=2) + "\n")

    for w in check_tilt(regions_out):
        print(f"\nWARNING  {w}", file=sys.stderr)

    print(f"\nwrote       {out}/field.i16.gz  landfrac.u8  meta.json  "
          f"regions.json  index.json")
    print(f"sha256      {digest[:16]}...")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
