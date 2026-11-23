# Browser workbench

Build the artifacts and serve the static release tree from the repository root. The server is only for loading local application assets.

```powershell
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

Open [the local workbench](http://127.0.0.1:8000/web/). Load the seeded 16-bit sample or choose a binary PGM with MAXVAL 255, 4095 or 65535. A PGM run encodes and independently decodes the actual byte stream in two Workers. The decoder requests encoded data one chunk at a time. The page reads the original PGM one row at a time during comparison, preserving the original values for the error bound. An uploaded `.jls` is decoded to big-endian binary PGM. The original and error views require a reference image.

The display samples a maximum of 480 × 320 positions. Each preview retains only the selected original and reconstructed `Uint16Array` values. Click a preview to see the underlying integer values. The heat colors represent absolute error relative to NEAR, while the displayed maximum is evaluated across every sample. Raw/JLS divides the PGM raster bytes, with 8-bit data stored in one byte and 12/16-bit data stored in two, by the measured JPEG-LS byte count. The timing covers browser reads, Worker processing and the selected sink before it closes.

Choose bounded verification to discard the output after acknowledgement. This keeps the file reader, codec sessions, relay and previews bounded independently of height. Buffered download retains at most 64 MiB of output payload and materializes a Blob for normal downloads. Blob and runtime overhead can exceed that payload. Stream to a file is available only when the browser exposes `showSaveFilePicker`, and each write is awaited. The native CLI also supports file and pipe streaming.

The UI can be restyled in `style.css` and `index.html`. English and Chinese labels are in `labels.mjs`. File-format, transport, preview and state wiring are in `pgm.mjs`, `transport.mjs`, `preview.mjs` and `app.mjs`. See the [SDK guide](../sdk/README.md) for details of the codec interface.

## Browser smoke

With the local server running, install the pinned development-only driver and run the cases from the repository root. Set `MOONJLS_CHROME` to a Chromium-compatible executable path to choose another installed browser. `MOONJLS_WEB_URL` defaults to `http://127.0.0.1:8000`. The test uses Chromium's headless mode and can write a real screenshot via `MOONJLS_SCREENSHOT`.

```powershell
npm.cmd --prefix web ci
$env:MOONJLS_SCREENSHOT = '../reports/local/workbench.png'
npm.cmd --prefix web run smoke
```
