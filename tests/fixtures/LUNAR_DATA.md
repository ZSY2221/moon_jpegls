# Lunar altimetry fixture

`lola.pgm` is reproducible with `python scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm`. The script downloads the fixed, 2,076,866-byte `ldem_4_uint.tif` from the CGI Moon Kit. NASA's Scientific Visualization Studio derived the map from Lunar Orbiter Laser Altimeter (LOLA) gridded elevations. The unsigned render adds 20,000 to the original signed half-meter values. The script reads those stored integers in TIFF order and writes them unchanged in binary PGM big-endian order. [CGI Moon Kit, data and credits](https://svs.gsfc.nasa.gov/4720/#displacement)

The map contains 1,036,800 samples at 1440 × 720. Its observed sample range is 2243 through 41008. The PGM announces `MAXVAL=65535` to preserve the unsigned 16-bit format. TIFF SHA-256 is `e6668bec27fc9b8fbb02d198c7ddfb08eedeeb790167b494f95e6b34201da05e`. PGM SHA-256 is `1adb4e047099b942c229a8d21d33b6227dd2b6af22984d8d9de6b128b0e858a6`.

Credit NASA's Scientific Visualization Studio, the Lunar Reconnaissance Orbiter LOLA team and visualizer Ernie Wright. The SVS FAQ releases content into the public domain unless noted. The source page lists no restriction on the unsigned elevation TIFF. Reference data is downloaded on demand outside the packages. [SVS reuse policy](https://svs.gsfc.nasa.gov/#faq)
