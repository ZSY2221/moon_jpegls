# MoonJLS JavaScript SDK

Build the MoonBit bindings from the repository root with `node sdk/build.mjs`. They use the same `core` package as the native executable. The outputs are `sdk/generated/core.mjs` and `sdk/generated/core.wasm`. Node and browsers use `sdk/index.mjs` with adjacent TypeScript declarations. Wasm GC uses the JavaScript string builtins when instantiating the generated artifact. Choose `backend: 'js'` when a runtime lacks those capabilities.

```js
import { loadCore, encodeImage, decodeImage } from './sdk/index.mjs';

const core = await loadCore({ backend: 'wasm-gc' });
const frame = { width: 3, height: 2, bits: 16, near: 1 };
const pixels = Uint16Array.of(0, 32767, 65535, 7, 32768, 65534);
const { bytes } = await encodeImage(core, frame, pixels);
const { samples } = await decodeImage(core, bytes);
console.log(Array.from(samples));
```

`encodeImage` and `decodeImage` collect an entire result. For a bounded pipeline, use `encodeStream` and `decodeStream` with a `read(maxElements)` source and an awaited sink. Encode input uses `Uint16Array`, decode input and encode output use `Uint8Array`, and decoded rows use `Uint16Array`. An empty array is a chunk. Return `null` to end the source. A decode checks for trailing data by default, including a one-byte source pull after EOI if necessary. Set `trailing: 'allow'` to stop at EOI and report the actual consumed offset. File adapters that need the unread suffix must retain or seek the underlying source.

The Node CLI exercises the same streaming driver with bounded file reads and writes. Raw samples use unsigned 16-bit little-endian storage even if the effective bit depth is 8 or 12. Use new output paths. An interrupted or failed run may leave an output prefix.

```powershell
node sdk/cli.mjs encode --backend js --input samples.raw --output out.jls --width 64 --height 64 --bits 16 --near 1 --chunk 7 --output-chunk 29
node sdk/cli.mjs decode --backend wasm-gc --input out.jls --output reconstructed.raw --chunk 1
```

For browser isolation, import `startWorker` from `sdk/worker-client.mjs`. Pass the same bounded `read` source, a mode, and `onEvent`. The Worker hands the host at most one input request, output chunk, row, row batch or progress message at a time. It waits for `input` or `ack` with the corresponding sequence before advancing. The `pause()`, `resume()` and `cancel()` controls can run while an acknowledgement is pending. One already-started source read can finish after a pause. An output event receives its own transferred buffer. A source chunk is transferred and detached if it owns its whole buffer. Otherwise, the client first copies the selected range to a standalone buffer.

Decode accepts `maxBatchBytes`, an integer in `0..1048576`; the default `0` disables batching. The first row is delivered immediately. A `rows` event contains `samples: Uint16Array`, `startIndex`, `count`, `frame` and `stats`; its sample view contains exactly `count * frame.width` elements. The host must await consumption of the entire event before its ACK. The budget limits each batch buffer, not total Worker memory: copying also holds one source row, and a row wider than the budget remains one atomic `row` event. The final batch is capped by the remaining image rows. A time-limited batch can transfer a short view backed by a larger buffer.

Decoded rows retain all 16 bits. `inputChunkSize` counts bytes on decode and samples on encode. `outputChunkSize` counts encoded bytes. Statistics expose row progress, current and peak input and output payload in bytes, total consumption and production, first row timing, the core payload and bridge staging. Worker `outputQueueBytes` includes its allocated batch buffer or an unacknowledged output's entire backing buffer, even when the transferred view is shorter. Worker `outputPeakBytes` also includes the source row while it is copied into a batch; it is monotonic across events and the terminal `done` result. At successful completion the queue is zero and the peak is retained. JavaScript objects, runtime allocator overhead, detached backing stores pending collection, output retained by a consumer after ACK and operating system caches are excluded. These fields are not total Worker heap or RSS. The browser application accounts separately for preview buffers, the one-chunk pipe and optional buffered downloads.

Errors are `CodecError` objects with `code` and `message`. The core binding reports `InvalidData`, `UnsupportedFeature`, `ResourceLimit`, `Truncated`, `InvalidArgument`, and `Cancelled`. The strict host tail check can also report `TrailingData`. The Worker uses `RuntimeError` for bridge or host runtime failures. Async streams accept an `AbortSignal` and return or reject as soon as a pending source or sink can be abandoned. The source or sink owns cleanup of any underlying I/O it previously started.
