# Lunar altimetry fixture

`lola.pgm` is reproducible with `python scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm`. The script downloads the fixed, 2,076,866-byte `ldem_4_uint.tif` from the CGI Moon Kit. Pass `--source-tiff <file>` to convert a downloaded copy with the same verification. The converter checks the TIFF length and SHA-256, reads the stored unsigned integers in TIFF order, and writes them unchanged in binary PGM big-endian order. [CGI Moon Kit, data and credits](https://svs.gsfc.nasa.gov/4720/#displacement) · [Pinned TIFF](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_4_uint.tif)

If the Python downloader's connection closes early, save the pinned TIFF using a browser or `curl` and pass its local path to `--source-tiff`.

NASA's Scientific Visualization Studio derived the map from Lunar Orbiter Laser Altimeter gridded elevations. The unsigned TIFF adds 20,000 counts to the signed source elevations. Each count represents half a meter, and the reference sphere has a radius of 1,737,400 m. Elevation relative to that sphere is `(sample − 20000) × 0.5 m` and radius is `1737400 m + elevation`. The absolute elevation difference is `abs(original − reconstructed) × 0.5 m`, so the codec's NEAR bounds of 0, 1, 2, and 3 correspond to 0, 0.5, 1, and 1.5 m. These bounds describe reconstruction error relative to these input samples. [NASA's displacement-map encoding](https://svs.gsfc.nasa.gov/4720/#displacement)

The CGI Moon Kit figure caption lists a different radius. The 1737.4 km value used here follows the technical description and the LOLA data specification. The common offset cancels from the codec-added difference. [LOLA data specification](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/document/rdrsis.htm)

The map contains 1,036,800 samples at 1440 × 720. Its observed sample range is 2243 through 41008, corresponding to elevations of −8,878.5 m through 10,504 m relative to the reference sphere. The PGM is 2,073,618 bytes and uses `MAXVAL=65535` to preserve the unsigned 16-bit format. TIFF SHA-256 is `e6668bec27fc9b8fbb02d198c7ddfb08eedeeb790167b494f95e6b34201da05e`. PGM SHA-256 is `1adb4e047099b942c229a8d21d33b6227dd2b6af22984d8d9de6b128b0e858a6`.

[`sdk/lunar.mjs`](../../sdk/lunar.mjs) exposes `lunarMetadataFor({ sha256, bytes, format })`, `lunarElevationMeters(sample)` and `lunarErrorMeters(absoluteSampleError)`. First compute the SHA-256 of the actual file. The metadata lookup returns the lunar unit mapping for the exact pinned PGM and `null` for other inputs. The PGM and JPEG-LS codec exposures retain their sample integers.

The Node SDK runner records whole-image compression at NEAR 0–3, strict decode, full-sample comparison and artifact hashes. [Measured elevation error and rerun commands](../../reports/lunar-budget-20261125/README.md)

Credit NASA's Scientific Visualization Studio, the Lunar Reconnaissance Orbiter LOLA team and visualizer Ernie Wright. The SVS FAQ releases content into the public domain unless noted. The source page lists no restriction on the unsigned elevation TIFF. Reference data is downloaded on demand outside the packages. [SVS reuse policy](https://svs.gsfc.nasa.gov/#faq)
