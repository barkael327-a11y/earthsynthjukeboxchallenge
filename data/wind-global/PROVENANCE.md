# Global wind picture

Frozen NASA GEOS-FP modeled near-surface wind speed frame. Timestamp printed in the downloaded source: 30 Oct 2026 05:00:00 EDT (2026-10-30T05:00:00-04:00). Not live/current weather.

Source: https://svs.gsfc.nasa.gov/5148/
Frame: MC02_stage3_GMAO_near_surface_wind_2048x1024_en-hwtool/00000001.png from the published lossless frame set.
Published colorbar: https://svs.gsfc.nasa.gov/vis/a000000/a005100/a005148/NearSurfaceWindSpeed_colorbar.png

The source page does not explicitly establish projection/extent. Thus this is a 90x180 image-space grid with a whole-frame region, not claimed georeferenced globe cells. Relative sweep progress is comparable as interaction only, not as geographic correspondence with other layers.

The bar is linear 0…40 m/s, with flat/neutral colors at the low end and gray at the high end. All neutral source pixels are conservatively rejected because the gray basemap could otherwise masquerade as wind. Logo and date rectangles are masked. Ramp-only ambiguity across all samples reaches 2.06m/s in the neutral low-end plateau, but the retained chromatic sample subset max error is 0.4124m/s (mean 0.0417). These are inversion ambiguity checks, not model uncertainty. Missing areas must remain missing, not calm wind.

Rebuild: tools/build_global_layers.py (numpy, scipy, Pillow). Source and cleaned bar sampling are reproducible. palette.json stores exactly the ramp/positions used. Byte and browser-load verification checks reside in meta.json.
