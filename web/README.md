# Browser workbench

Build the artifacts and serve the static release tree from the repository root. The server is only for loading local application assets.

```powershell
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

Open [the local workbench](http://127.0.0.1:8000/web/). Load the seeded 16-bit sample or choose a binary PGM with MAXVAL in 1–65535. A PGM run encodes and decodes the actual byte stream in two Workers. The decoder requests encoded data one chunk at a time. The page compares every reconstructed sample with its original integer value using a 64 KiB reference window. A row too wide for that window uses a direct read. An uploaded `.jls` is decoded to binary PGM with its effective MAXVAL and big-endian two-byte samples when MAXVAL is at least 256. JLS-only decoding checks stream termination and displays “Not compared” for the original-sample error.

The Precision view exposes resolved P, MAXVAL, NEAR, T1, T2, T3 and RESET. PGM derives the smallest coded precision that holds its MAXVAL with a minimum of two bits. A bounded header read sets the NEAR menu to `0..min(255, floor(MAXVAL / 2))`. Advanced settings allow LSE threshold and RESET overrides. Standalone decode uses the codestream parameters. Raw/JLS divides PGM raster bytes by the measured JPEG-LS byte count.

The image display retains a maximum of 480 × 320 sampled positions. Click an image pixel or focus the preview and use the arrow keys to see its source coordinate and integer values. The magnifier shows the 7 × 7 neighborhood on this sampled grid, and the heat colors map the absolute sample errors relative to NEAR.

The Streaming view shows the configured chunk limits, actual staging and sink bytes, first-row time, acknowledged event count, longest measured host callback through ACK, and logical queue peaks. The Compatibility view reads the [conformance manifest](../tests/conformance/manifest.json) copied into the static build, including clauses, implementation states, test cases and reference evidence.

Rows are provisional until the final checks and output close finish. The in-page processing timer starts after opening the sink and includes validation and output close. The first Canvas timestamp records the return of the first reconstruction drawing call. File and save-location selection and sink setup are outside the processing timer.

Choose bounded verification to discard the output after acknowledgement. This keeps the file reader, codec sessions, relay and previews bounded independently of height. Buffered download retains at most 64 MiB of output payload and materializes a Blob for normal downloads. Blob and runtime overhead can exceed that payload. Stream to a file is available only when the browser exposes `showSaveFilePicker`, and each write is awaited. The native CLI also supports file and pipe streaming.

The UI can be restyled in `style.css` and `index.html`. English and Chinese labels are in `labels.mjs`. File-format, transport, preview and state wiring are in `pgm.mjs`, `transport.mjs`, `preview.mjs` and `app.mjs`. See the [SDK guide](../sdk/README.md) for details of the codec interface.

## Verification report and physical units

Each completed, failed or cancelled job can export [verification report v1](../docs/VERIFICATION_REPORT.md). The workbench recognizes the [pinned NASA LOLA PGM](../tests/fixtures/LUNAR_DATA.md) by SHA-256 and shows codec-added elevation error in metres. Other inputs use integer sample units.

## Browser smoke

With the local server running, install the pinned development-only driver and run the cases from the repository root. Set `MOONJLS_CHROME` to a Chromium-compatible executable path to choose another installed browser. `MOONJLS_WEB_URL` defaults to `http://127.0.0.1:8000`. The test uses Chromium's headless mode and can write a real screenshot via `MOONJLS_SCREENSHOT`.

```powershell
npm.cmd ci --prefix web
$env:MOONJLS_EXPECT_REFERENCE_WINDOW = '1'
node web/smoke.mjs
node web/preview-browser.mjs
node web/capture-presentation.mjs --output .evidence/presentation
```

See the [presentation handoff](../docs/PRESENTATION_HANDOFF.md) for the 90-second operation sequence, controlled output failure tests and paired performance guard.

### Sampled JPEG-LS decode

The Scan Structure Inspector shows the stored sampling factors, real plane sizes, and lines per MCU. The component preview resamples for display. Pixel inspection reports the selected component's coordinates and original-width integer sample values from the decoder.

Sampled images with unequal component sizes export as planar U16LE. Planes follow SOF55 declaration order and contain their actual width × height samples, with rows in raster order. The JSON report lists plane dimensions and sample offsets. The file sink suggests the neutral `.decoded` suffix because it opens before the frame header is parsed. Buffered downloads receive the format-specific suffix. The worker delivers rows incrementally and the browser writes each raw row directly to its plane offset. The host conversion measurement includes one U16LE row, and the buffered sink's retained output is reported separately.

Set `MOONJLS_ANNEX_FIXTURES` to the extracted official Annex E image directory when running `npm run smoke` to check both sampled fixtures against pinned HP 1.00 reconstruction hashes.

### Point transform

Use the Pt field with a PGM or PPM source. The workbench compares right-shifted sample integers against coded NEAR, and compares the original input and reconstructed integers against the original-scale bound. The Scan Structure Inspector and JSON report show both scales. A JLS upload takes Pt from each scan header. Browser rows are Uint16 and a reconstruction above 65,535 is reported as unsupported.

### Workbench microscopy examples

The workbench includes three planes from a 144 × 111 crop of the Lily of the Valley confocal fluorescence microscopy dataset. The 16-bit P6 fixture keeps the original uint16 counts, which occupy 0–4095 in the source. The 8-bit fixture scales counts from 0–4095 to 0–255 before coding. The channels use neutral labels. The 16-bit preview display range is 0–4095 and the inspector reports the original integer count.

Select ILV 0, 1, or 2 to compare processing one plane per scan, alternating component rows, or alternating samples at every pixel. The workbench compares each reconstructed sample with its source. The report keeps independent-reference status separate from the live comparison. A bundled sampled JLS decodes to planes of 144 × 111, 144 × 28, and 72 × 56. The scan inspector shows one coded padding row for the first component. This decode-only run checks stream termination and reports the number of samples without an original comparison.

The microscopy image was acquired by Genevieve Buckley at Monash Micro Imaging in 2018 and distributed under CC0 by scikit-image. [Dataset record](https://scikit-image.org/docs/0.26.0/api/skimage.data.html#skimage.data.lily) · [Pinned TIFF](https://gitlab.com/scikit-image/data/-/blob/2cdc5ce89b334d28f06a58c9f0ca21aa6992a5ba/lily-of-the-valley-fluorescence.tif)

Run `node sdk/build.mjs` and `python web/samples/extract_lily.py PATH_TO_TIFF` with Pillow and NumPy to regenerate the three fixtures. The script checks the TIFF SHA-256 before cropping. Zero-based crop origin is (395,344), and components are TIFF pages 0, 1, and 2.

| Fixture | SHA-256 |
| --- | --- |
| `lily-8.ppm` | `d0c1829a05f81a996edaf2d55f17599f0164fe9adb4c11c5c18ea58bf06f30a9` |
| `lily-16.ppm` | `364565515c9623b242a02f92ce3dd6057fff898309c00acf6b9334cbca088239` |
| `lily-sampled.jls` | `5d07ba5cb525ec4d89998275e562fb992102314ae4603eac477c0dc23e82224c` |
