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
