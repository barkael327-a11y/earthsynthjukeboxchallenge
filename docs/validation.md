# EarthSynth — offline validation

Rendered 2026-11-14T19:02:46.700Z, 48000 Hz, 32-bit float, 62 segments.

`validate.html` renders the real carrier through an `OfflineAudioContext` and exports a WAV. This program reads that WAV, computes its own FFT, and inverts the published contract. The two share no code.

## Recovery by track and region

| Track | Region | Slope | n | Mean abs error | Worst | At |
| --- | --- | --- | --- | --- | --- | --- |
| Sea surface temperature | Global | 0.9375 dB/°C | 9 | 6.714e-07 °C | 1.197e-06 °C | 5.288 °C |
| Sea surface temperature | Tropics | 0.9375 dB/°C | 8 | 3.357e-07 °C | 7.632e-07 °C | 25.965 °C |
| Sea surface temperature | N mid-latitudes | 0.9375 dB/°C | 9 | 7.034e-07 °C | 1.325e-06 °C | 3.919 °C |
| Sea surface temperature | S mid-latitudes | 0.9375 dB/°C | 9 | 4.644e-07 °C | 1.020e-06 °C | 21.483 °C |
| Tropospheric NO₂ | Whole frame | 3 dB/×10¹⁵ molecules/cm² | 9 | 1.882e-07 ×10¹⁵ molecules/cm² | 4.900e-07 ×10¹⁵ molecules/cm² | 1.900 ×10¹⁵ molecules/cm² |

## Level invariance

Segments rendered through a master gain of 1 compared with the same values at unity. Worst disagreement **1.133e-08**, over 18 pairs.

A ratio cannot see a volume knob. This is the number that says so.

## Balance point

| Track | Region | Measured tilt |
| --- | --- | --- |
| Sea surface temperature | Global | +4.596e-07 dB |
| Sea surface temperature | N mid-latitudes | +4.598e-07 dB |
| Sea surface temperature | S mid-latitudes | +4.681e-07 dB |
| Tropospheric NO₂ | Whole frame | +4.598e-07 dB |

At the balance point the two partials are level and the tilt is zero by construction. What is printed here is the measurement floor.

## Every segment

| Track | Region | Gain | Expected | Measured | Error | Tilt expected | Tilt measured |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sst | global | ×1 | +1.3877 | +1.3877 | +1.183e-06 | -13.699 dB | -13.699 dB |
| sst | global | ×1 | +5.2876 | +5.2876 | +1.197e-06 | -10.043 dB | -10.043 dB |
| sst | global | ×1 | +9.1874 | +9.1874 | +8.881e-07 | -6.387 dB | -6.387 dB |
| sst | global | ×1 | +13.0873 | +13.0873 | +5.434e-07 | -2.731 dB | -2.731 dB |
| sst | global | ×1 | +16.0000 | +16.0000 | +4.902e-07 | +0.000 dB | +0.000 dB |
| sst | global | ×1 | +16.9871 | +16.9871 | -1.194e-07 | +0.925 dB | +0.925 dB |
| sst | global | ×1 | +20.8870 | +20.8870 | +5.925e-07 | +4.582 dB | +4.582 dB |
| sst | global | ×1 | +24.7868 | +24.7868 | +3.433e-07 | +8.238 dB | +8.238 dB |
| sst | global | ×1 | +28.6866 | +28.6866 | +6.856e-07 | +11.894 dB | +11.894 dB |
| sst | global | ×0.08 | +1.3877 | +1.3877 | +1.175e-06 | -13.699 dB | -13.699 dB |
| sst | global | ×0.08 | +5.2876 | +5.2876 | +1.193e-06 | -10.043 dB | -10.043 dB |
| sst | global | ×0.08 | +9.1874 | +9.1874 | +8.896e-07 | -6.387 dB | -6.387 dB |
| sst | global | ×0.08 | +13.0873 | +13.0873 | +5.433e-07 | -2.731 dB | -2.731 dB |
| sst | global | ×0.08 | +16.0000 | +16.0000 | +4.936e-07 | +0.000 dB | +0.000 dB |
| sst | global | ×0.08 | +16.9871 | +16.9871 | -1.224e-07 | +0.925 dB | +0.925 dB |
| sst | global | ×0.08 | +20.8870 | +20.8870 | +5.934e-07 | +4.582 dB | +4.582 dB |
| sst | global | ×0.08 | +24.7868 | +24.7868 | +3.347e-07 | +8.238 dB | +8.238 dB |
| sst | global | ×0.08 | +28.6866 | +28.6866 | +6.743e-07 | +11.894 dB | +11.894 dB |
| sst | tropics | ×1 | +23.9241 | +23.9241 | -5.862e-08 | +7.429 dB | +7.429 dB |
| sst | tropics | ×1 | +24.6045 | +24.6045 | +1.773e-07 | +8.067 dB | +8.067 dB |
| sst | tropics | ×1 | +25.2848 | +25.2848 | -1.326e-07 | +8.705 dB | +8.705 dB |
| sst | tropics | ×1 | +25.9652 | +25.9652 | +7.632e-07 | +9.342 dB | +9.342 dB |
| sst | tropics | ×1 | +26.6456 | +26.6456 | +3.157e-07 | +9.980 dB | +9.980 dB |
| sst | tropics | ×1 | +27.3259 | +27.3259 | +3.354e-07 | +10.618 dB | +10.618 dB |
| sst | tropics | ×1 | +28.0063 | +28.0063 | -2.306e-07 | +11.256 dB | +11.256 dB |
| sst | tropics | ×1 | +28.6866 | +28.6866 | +6.725e-07 | +11.894 dB | +11.894 dB |
| sst | n-mid | ×1 | +3.9185 | +3.9186 | +1.325e-06 | -11.326 dB | -11.326 dB |
| sst | n-mid | ×1 | +5.9677 | +5.9677 | +1.222e-06 | -9.405 dB | -9.405 dB |
| sst | n-mid | ×1 | +8.0169 | +8.0169 | +8.512e-07 | -7.484 dB | -7.484 dB |
| sst | n-mid | ×1 | +10.0661 | +10.0661 | +8.983e-07 | -5.563 dB | -5.563 dB |
| sst | n-mid | ×1 | +12.1152 | +12.1152 | +4.201e-07 | -3.642 dB | -3.642 dB |
| sst | n-mid | ×1 | +14.1644 | +14.1644 | +6.035e-07 | -1.721 dB | -1.721 dB |
| sst | n-mid | ×1 | +16.0000 | +16.0000 | +4.905e-07 | +0.000 dB | +0.000 dB |
| sst | n-mid | ×1 | +16.2136 | +16.2136 | -2.485e-07 | +0.200 dB | +0.200 dB |
| sst | n-mid | ×1 | +18.2627 | +18.2627 | +2.706e-07 | +2.121 dB | +2.121 dB |
| sst | s-mid | ×1 | +4.0172 | +4.0172 | +8.508e-07 | -11.234 dB | -11.234 dB |
| sst | s-mid | ×1 | +6.9281 | +6.9281 | +5.674e-07 | -8.505 dB | -8.505 dB |
| sst | s-mid | ×1 | +9.8391 | +9.8391 | +6.522e-07 | -5.776 dB | -5.776 dB |
| sst | s-mid | ×1 | +12.7501 | +12.7501 | +1.330e-07 | -3.047 dB | -3.047 dB |
| sst | s-mid | ×1 | +15.6610 | +15.6610 | -1.751e-08 | -0.318 dB | -0.318 dB |
| sst | s-mid | ×1 | +16.0000 | +16.0000 | +4.993e-07 | +0.000 dB | +0.000 dB |
| sst | s-mid | ×1 | +18.5720 | +18.5720 | +7.868e-08 | +2.411 dB | +2.411 dB |
| sst | s-mid | ×1 | +21.4829 | +21.4829 | +1.020e-06 | +5.140 dB | +5.140 dB |
| sst | s-mid | ×1 | +24.3939 | +24.3939 | +3.602e-07 | +7.869 dB | +7.869 dB |
| no2 | frame | ×1 | +1.2500 | +1.2500 | +2.561e-07 | -11.250 dB | -11.250 dB |
| no2 | frame | ×1 | +1.8997 | +1.8997 | +4.900e-07 | -9.301 dB | -9.301 dB |
| no2 | frame | ×1 | +2.5494 | +2.5494 | +1.963e-07 | -7.352 dB | -7.352 dB |
| no2 | frame | ×1 | +3.1990 | +3.1990 | +6.528e-08 | -5.403 dB | -5.403 dB |
| no2 | frame | ×1 | +3.8487 | +3.8487 | +1.970e-07 | -3.454 dB | -3.454 dB |
| no2 | frame | ×1 | +4.4984 | +4.4984 | +1.501e-07 | -1.505 dB | -1.505 dB |
| no2 | frame | ×1 | +5.0000 | +5.0000 | +1.533e-07 | +0.000 dB | +0.000 dB |
| no2 | frame | ×1 | +5.1481 | +5.1481 | +1.389e-07 | +0.444 dB | +0.444 dB |
| no2 | frame | ×1 | +5.7978 | +5.7978 | -4.656e-08 | +2.393 dB | +2.393 dB |
| no2 | frame | ×0.08 | +1.2500 | +1.2500 | +2.578e-07 | -11.250 dB | -11.250 dB |
| no2 | frame | ×0.08 | +1.8997 | +1.8997 | +4.899e-07 | -9.301 dB | -9.301 dB |
| no2 | frame | ×0.08 | +2.5494 | +2.5494 | +1.949e-07 | -7.352 dB | -7.352 dB |
| no2 | frame | ×0.08 | +3.1990 | +3.1990 | +6.654e-08 | -5.403 dB | -5.403 dB |
| no2 | frame | ×0.08 | +3.8487 | +3.8487 | +1.971e-07 | -3.454 dB | -3.454 dB |
| no2 | frame | ×0.08 | +4.4984 | +4.4984 | +1.503e-07 | -1.505 dB | -1.505 dB |
| no2 | frame | ×0.08 | +5.0000 | +5.0000 | +1.533e-07 | +0.000 dB | +0.000 dB |
| no2 | frame | ×0.08 | +5.1481 | +5.1481 | +1.396e-07 | +0.444 dB | +0.444 dB |
| no2 | frame | ×0.08 | +5.7978 | +5.7978 | -4.621e-08 | +2.393 dB | +2.393 dB |

