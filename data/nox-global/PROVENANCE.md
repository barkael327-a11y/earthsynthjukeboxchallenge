# Global nitrogen oxides

Frozen July 1, 2024 NASA GEOS-CF modeled near-surface NO + NO2. Not observed NO2 column density, not AQI, not current conditions.

NASA explicitly identifies this product as equirectangular Science On A Sphere content: https://svs.gsfc.nasa.gov/5518/

Selected frame: AirQuality_NOx_Layer_2048x1024_0000.png from the page's separate 2048x1024 NitrogenOxides_Layer set. Frame 0000 corresponds to the first row of https://svs.gsfc.nasa.gov/vis/a000000/a005500/a005518/dates.txt (Jul 01, 2024).

Published colorbar: https://svs.gsfc.nasa.gov/vis/a000000/a005500/a005518/NitrogenOxides_colorbar.png

The 0.001…10 ppbv ramp is logarithmic. Pixel inversion uses logarithmic sample positions, then physical values are averaged and quantized. The audio contract stays linear in physical ppbv, independent of the displayed logarithmic palette. Opaque RGBA source confirmed alpha=255 everywhere. Neutral/missing pixels and coastlines rejected by color distance and chroma; no missing pixel becomes zero pollution. Conservative masks mean coverage is incomplete.

Rebuild: tools/build_global_layers.py (numpy, scipy, Pillow). palette.json contains the same cleaned source ramp and physical positions used for inversion. Numeric hashes, checks, masks, and bar round-trip errors are in meta.json. These error values measure palette ambiguity, not NASA model error or frame scientific accuracy.
