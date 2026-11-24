# Browser workbench

Build the artifacts and serve the static release tree from the repository root. The server is only for loading local application assets.

```powershell
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

Open [the local workbench](http://127.0.0.1:8000/web/). Load the seeded 16-bit sample or choose a binary PGM with MAXVAL 255, 4095 or 65535. A PGM run encodes and independently decodes the actual byte stream in two Workers. The decoder requests encoded data one chunk at a time. The page compares every reconstructed sample with its original integer value using a 64 KiB reference window. A row too wide for that window uses a direct read. An uploaded `.jls` is decoded to binary PGM, with high-bit-depth samples written big-endian. JLS-only decoding checks stream termination and displays “Not compared” for the original-sample error.

The display samples a maximum of 480 × 320 positions. Each preview retains only the selected original and reconstructed `Uint16Array` values. Click an image pixel or focus a preview and use the arrow keys to inspect its source coordinate and integer values. The heat colors map absolute error relative to NEAR. Raw/JLS divides raster storage bytes, one byte per 8-bit sample and two per 12/16-bit sample, by the measured JPEG-LS byte count.

Rows are provisional until the final checks and output close finish. The in-page processing timer starts after opening the sink and includes validation and output close. The first Canvas timestamp records the return of the first reconstruction drawing call. File and save-location selection and sink setup are outside the processing timer.

Choose bounded verification to discard the output after acknowledgement. This keeps the file reader, codec sessions, relay and previews bounded independently of height. Buffered download retains at most 64 MiB of output payload and materializes a Blob for normal downloads. Blob and runtime overhead can exceed that payload. Stream to a file is available only when the browser exposes `showSaveFilePicker`, and each write is awaited. The native CLI also supports file and pipe streaming.

The UI can be restyled in `style.css` and `index.html`. English and Chinese labels are in `labels.mjs`. File-format, transport, preview and state wiring are in `pgm.mjs`, `transport.mjs`, `preview.mjs` and `app.mjs`. See the [SDK guide](../sdk/README.md) for details of the codec interface.

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
