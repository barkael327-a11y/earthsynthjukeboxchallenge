#!/usr/bin/env python3
"""
validate.py - recover EarthSynth values from rendered audio independently.

    python validate.py --wav earthsynth-validation.wav \\
                       --manifest earthsynth-validation.json \\
                       --out ../docs/validation.md

Shares no code with the instrument. Parses the WAV header itself, computes
its own FFT, and inverts the contract using only the slope and balance point
from the manifest.

Per segment:
    power in +/-4 bins around 220 Hz and 880 Hz
    tilt  = 20 * log10(mag_high / mag_low)
    value = balanceAt + tilt / slope

Also checks:
  - LEVEL INVARIANCE: segments at gain 0.08 must recover the same values as
    those at unity. If not, the central claim of the instrument is false.
  - BALANCE POINT: tilt at the balance value should be ~0 dB.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

BAND_BINS = 4
WINDOW    = np.hanning


def read_wav(path: Path):
    """Parse a RIFF/WAVE file. Returns (samples as float64 [frames, channels], rate)."""
    raw = path.read_bytes()
    if raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise SystemExit(f"{path} is not a RIFF/WAVE file")

    fmt  = None
    data = None
    pos  = 12
    while pos + 8 <= len(raw):
        chunk_id = raw[pos:pos + 4]
        (size,)  = struct.unpack_from("<I", raw, pos + 4)
        body     = raw[pos + 8: pos + 8 + size]
        if chunk_id == b"fmt ":
            fmt  = struct.unpack_from("<HHIIHH", body, 0)
        elif chunk_id == b"data":
            data = body
        pos += 8 + size + (size & 1)  # chunks are word-aligned

    if fmt is None or data is None:
        raise SystemExit(f"{path}: missing fmt or data chunk")

    audio_format, channels, rate, _byte_rate, _align, bits = fmt

    if audio_format == 3 and bits == 32:
        samples = np.frombuffer(data, dtype="<f4").astype(np.float64)
    elif audio_format == 1 and bits == 16:
        samples = np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0
    elif audio_format == 1 and bits == 32:
        samples = np.frombuffer(data, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise SystemExit(
            f"{path}: unsupported format {audio_format} at {bits} bits. "
            f"validate.html writes 32-bit float."
        )

    return samples.reshape(-1, channels), rate


def band_magnitude(segment: np.ndarray, rate: int, freq: float) -> float:
    """
    RMS magnitude in a +/-BAND_BINS window around freq.

    Summing across the main lobe handles the case where the partial doesn't
    land exactly on a bin boundary. The Hann window's coherent gain cancels
    when comparing two magnitudes measured the same way.
    """
    n        = len(segment)
    windowed = segment * WINDOW(n)
    spectrum = np.fft.rfft(windowed)
    power    = np.abs(spectrum) ** 2
    centre   = int(round(freq * n / rate))
    lo       = max(centre - BAND_BINS, 0)
    hi       = min(centre + BAND_BINS + 1, len(power))
    return float(np.sqrt(power[lo:hi].sum()))


def analyse(samples: np.ndarray, rate: int, manifest: dict) -> list[dict]:
    mono = samples[:, 0]
    rows = []
    for seg in manifest["segments"]:
        start, end = seg["analysisStart"], seg["analysisEnd"]
        if end > len(mono):
            raise SystemExit(
                f"manifest refers to sample {end} but WAV has {len(mono)}. "
                f"WAV and manifest are from different renders."
            )
        window = mono[start:end]
        low    = band_magnitude(window, rate, seg["fLow"])
        high   = band_magnitude(window, rate, seg["fHigh"])
        if low <= 0 or high <= 0:
            raise SystemExit(
                f"{seg['track']}/{seg['region']} at {seg['expectedValue']}: "
                f"a partial measured zero. Silence is not a measurement."
            )
        tilt  = 20.0 * np.log10(high / low)
        value = seg["balanceAt"] + tilt / seg["slope"]
        rows.append({
            **{k: seg[k] for k in (
                "track", "trackLabel", "region", "regionLabel", "units",
                "slope", "balanceAt", "masterGain", "attenuated",
                "expectedValue", "expectedTilt",
            )},
            "measuredTilt":  float(tilt),
            "measuredValue": float(value),
            "errorValue":    float(value - seg["expectedValue"]),
            "errorTilt":     float(tilt  - seg["expectedTilt"]),
        })
    return rows


def level_invariance(rows: list[dict]) -> list[dict]:
    """Pair attenuated segments with their unity-gain equivalents."""
    plain = {(r["track"], r["region"], round(r["expectedValue"], 6)): r
             for r in rows if not r["attenuated"]}
    out = []
    for r in rows:
        if not r["attenuated"]:
            continue
        twin = plain.get((r["track"], r["region"], round(r["expectedValue"], 6)))
        if twin is None:
            continue
        out.append({
            "track": r["track"], "region": r["region"], "units": r["units"],
            "value":      r["expectedValue"],
            "difference": float(r["measuredValue"] - twin["measuredValue"]),
        })
    return out


def summarise(rows: list[dict]) -> list[dict]:
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        if r["attenuated"]:
            continue
        key = (r["track"], r["trackLabel"], r["region"],
               r["regionLabel"], r["units"], r["slope"])
        groups.setdefault(key, []).append(r)

    out = []
    for (track, track_label, region, region_label, units, slope), rs in groups.items():
        errs  = np.abs([r["errorValue"] for r in rs])
        worst = max(rs, key=lambda r: abs(r["errorValue"]))
        out.append({
            "track": track, "trackLabel": track_label,
            "region": region, "regionLabel": region_label,
            "units": units, "slope": slope, "n": len(rs),
            "meanAbsError": float(errs.mean()),
            "maxAbsError":  float(errs.max()),
            "worstAt":      worst["expectedValue"],
        })
    return out


def write_report(path: Path, manifest: dict, rows: list[dict],
                 summary: list[dict], invariance: list[dict]) -> None:
    lines = []
    w = lines.append

    w("# EarthSynth -- offline validation")
    w("")
    w(f"Rendered {manifest['generated']}, "
      f"{manifest['sampleRate']} Hz, {manifest['bitDepth']}-bit float, "
      f"{len(rows)} segments.")
    w("")
    w("`validate.html` renders the real carrier through an `OfflineAudioContext` "
      "and exports a WAV. This program reads that WAV, computes its own FFT, and "
      "inverts the published contract. The two share no code.")
    w("")
    w("## Recovery by track and region")
    w("")
    w("| Track | Region | Slope | n | Mean abs error | Worst | At |")
    w("| --- | --- | --- | --- | --- | --- | --- |")
    for s in summary:
        w(f"| {s['trackLabel']} | {s['regionLabel']} | "
          f"{s['slope']} dB/{s['units']} | {s['n']} | "
          f"{s['meanAbsError']:.3e} {s['units']} | "
          f"{s['maxAbsError']:.3e} {s['units']} | "
          f"{s['worstAt']:.3f} {s['units']} |")
    w("")

    if invariance:
        worst = max(abs(i["difference"]) for i in invariance)
        w("## Level invariance")
        w("")
        w(f"Segments at gain {manifest['segments'][0].get('masterGain', 1)} "
          f"vs unity. Worst disagreement **{worst:.3e}**, over {len(invariance)} pairs.")
        w("")
        w("A ratio cannot see a volume knob. This is the number that says so.")
        w("")

    balance = [r for r in rows
               if abs(r["expectedValue"] - r["balanceAt"]) < 1e-9 and not r["attenuated"]]
    if balance:
        w("## Balance point")
        w("")
        w("| Track | Region | Measured tilt |")
        w("| --- | --- | --- |")
        for r in balance:
            w(f"| {r['trackLabel']} | {r['regionLabel']} | "
              f"{r['measuredTilt']:+.3e} dB |")
        w("")
        w("At the balance point the two partials are level and tilt is zero "
          "by construction. This is the measurement floor.")
        w("")

    w("## Every segment")
    w("")
    w("| Track | Region | Gain | Expected | Measured | Error | Tilt expected | Tilt measured |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        w(f"| {r['track']} | {r['region']} | x{r['masterGain']:g} | "
          f"{r['expectedValue']:+.4f} | {r['measuredValue']:+.4f} | "
          f"{r['errorValue']:+.3e} | {r['expectedTilt']:+.3f} dB | "
          f"{r['measuredTilt']:+.3f} dB |")
    w("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wav",       required=True, type=Path)
    ap.add_argument("--manifest",  required=True, type=Path)
    ap.add_argument("--out",       type=Path, default=Path("validation.md"))
    ap.add_argument("--json",      type=Path, help="also write raw rows as JSON")
    ap.add_argument("--tolerance", type=float, default=0.05,
                    help="fail if any recovery error exceeds this (track units)")
    args = ap.parse_args()

    samples, rate = read_wav(args.wav)
    manifest      = json.loads(args.manifest.read_text(encoding="utf-8"))

    if rate != manifest["sampleRate"]:
        raise SystemExit(
            f"WAV is {rate} Hz but manifest says {manifest['sampleRate']}. "
            f"They are from different renders."
        )

    rows       = analyse(samples, rate, manifest)
    summary    = summarise(rows)
    invariance = level_invariance(rows)

    print(f"{len(rows)} segments, {rate} Hz, {samples.shape[0] / rate:.1f} s\n")
    print(f"{'track':<10s} {'region':<14s} {'slope':>8s} {'n':>4s} "
          f"{'mean |err|':>12s} {'max |err|':>12s}")
    for s in summary:
        print(f"{s['track']:<10s} {s['region']:<14s} "
              f"{s['slope']:>6.4g}   {s['n']:>4d} "
              f"{s['meanAbsError']:>12.3e} {s['maxAbsError']:>12.3e}")

    if invariance:
        worst = max(abs(i["difference"]) for i in invariance)
        print(f"\nlevel invariance   worst disagreement {worst:.3e} "
              f"over {len(invariance)} pairs")

    write_report(args.out, manifest, rows, summary, invariance)
    print(f"\nwrote {args.out}")
    if args.json:
        args.json.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {args.json}")

    worst_overall = max(abs(r["errorValue"]) for r in rows)
    if worst_overall > args.tolerance:
        print(f"\nFAIL: worst recovery error {worst_overall:.4f} exceeds "
              f"tolerance {args.tolerance}", file=sys.stderr)
        return 1
    print(f"\nPASS: worst recovery error {worst_overall:.3e}, "
          f"tolerance {args.tolerance}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())