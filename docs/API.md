# Calling MoonJLS

## MoonBit

Import package `ZSY2221/moon_jpegls/core` as `@jls`. `Frame` holds `width`, `height`, `bits` and `near`. `Frame::maxval()` derives MAXVAL from a valid coded `bits`. `Limits::default()` allows up to 65535 on either axis, 100 million pixels and 1 MiB of APPn/COM marker segments. Applications may choose lower limits before accepting a stream.

```moonbit
let frame : @jls.Frame = { width: 3, height: 2, bits: 16, near: 0 }
let samples : FixedArray[Int] = [0, 32767, 32768, 65535, 1, 42]
let compressed = @jls.encode(frame, samples)
let (decoded_frame, reconstructed) = @jls.decode(compressed)
```

`encode(frame, pixels, limits?)` and `decode(bytes, limits?)` raise `CodecError` and allocate the entire result. The latter rejects input after EOI. For a bound independent of height, call `Encoder::new(frame, limits)` or `Decoder::new(limits)` and advance the state explicitly.

| Operation | Input and results |
| --- | --- |
| `encoder.step(input, offset, length, output, eof)` | Sample slice in `FixedArray[Int]`, writable `FixedArray[Byte]`. Returns `{ consumed, produced, status }`. Output begins at zero. |
| `decoder.step(bytes, offset, length, eof)` | Slice in `Bytes`. Returns `{ consumed, status }`. Query `frame()` and `row()` on `RowReady`. |
| `cancel()` | A subsequent step on an active stream returns `Failed(Cancelled)` with zero counts. |
| `workspace_bytes()` | Formula in [ARCHITECTURE.md](ARCHITECTURE.md). `pending_bytes()` on the encoder and `pending_bits()` on the decoder report occupied core buffers. |

| Status | Host action |
| --- | --- |
| `NeedInput` | Keep any suffix and obtain another block. Set `eof=true` on the last block or in a separate empty call. |
| `NeedOutput` | Take the produced bytes and supply space. With zero capacity this may have zero counts and a pending output queue. |
| `RowReady` | Handle the row. Encoder uses this as a progress event. Decoder returns a borrowed line that callers must treat as read-only and copy to retain. The next step acknowledges the event. |
| `Done` | Consume the returned counts. On decode, they end at EOI and leave any trailing bytes to the host. Repeated calls return `Done` with zero counts. |
| `Failed(error)` | Stop advancing. Output from earlier calls and any counts on this call describe provisional work. |

`eof=true` identifies the boundary at the end of the currently supplied slice. Retrying an unconsumed suffix preserves that flag. If no output room is available, wait for the sink instead of polling. The errors distinguish `InvalidData`, `UnsupportedFeature`, `ResourceLimit`, `Truncated`, `InvalidArgument`, and `Cancelled`.

## JS and Wasm GC

Run `node sdk/build.mjs` from the repository root. The ESM exports and adjacent `.d.mts` files are in `sdk/`. Loading is asynchronous. A `Core` creates synchronous, stateful sessions with `stage(chunk | null)` and `step()`. `null` is EOF. Each result reports counts and an owned output chunk, when present. Encode stages `Uint16Array` samples for all precisions and returns `Uint8Array` bytes. Decode stages `Uint8Array` bytes and returns `Uint16Array` rows. Samples retain their original integer scale.

```js
import { loadCore, decodeStream } from './sdk/index.mjs';

const core = await loadCore({ backend: 'wasm-gc' });
const result = await decodeStream(core, {
  inputChunkSize: 4096,
  read: async (maxBytes) => source.readAtMost(maxBytes), // Uint8Array or null
  onRow: async (row, y) => sink.write(y, row),
  trailing: 'reject',
});
console.log(result.frame, result.stats);
```

`encodeStream` pulls a source and awaits `onBytes`. `decodeStream` awaits `onRow`. The `encodeImage` and `decodeImage` helpers aggregate all output. Each stream accepts an `AbortSignal`, honors configured chunk ceilings, and updates the `Stats` fields defined in [index.d.mts](../sdk/index.d.mts). Decode's `trailing: 'allow'` reports consumption at EOI, while `'reject'` checks for a suffix and probes the source for EOF. Keep track of the most recently supplied block if you need its unconsumed tail. Host and codec errors are surfaced as rejected promises.

## Worker protocol

`startWorker` in `sdk/worker-client.mjs` accepts the same options, a pull source, and `onEvent`. It returns `{ result, pause, resume, cancel }`. Options and events are typed in [worker-client.d.mts](../sdk/worker-client.d.mts).

| Message | Ownership and sequencing |
| --- | --- |
| `start` | Main thread sends mode, limits, backend, chunk ceilings and encoder frame. One job per Worker. |
| `needInput(seq, maxElements)` → `input(seq, chunk)` | Worker asks for one block. Host supplies `Uint8Array`, `Uint16Array`, or `null` for EOF. A subview is copied before transfer to prevent retaining or detaching a larger buffer. Full, owned input buffers are transferred and detached from the sender. |
| `bytes`, `row`, `rows`, `progress` → `ack(seq)` | Worker waits for the sink promise before proceeding. Byte and row buffers transfer ownership to the host. Rows are `Uint16Array`, accompanied by frame fields and zero-based row index. A `rows` event carries `startIndex`, `count` and a `samples` view of exactly `count * frame.width` elements. |
| `pause`, `resume`, `cancel` | Pause stops new source reads and Worker requests at the next boundary. At most one already requested pull or event can be in flight. Cancel rejects the session. |
| `done`, `error` | Terminal frame/metrics or error code and message. The client terminates its Worker. |

Metrics expose rows, input and output units, consumed/produced totals, live and peak queue bytes, core and bridge payload, elapsed time, and first-row timing. A sink can block acknowledgements to impose backpressure. The demo's fixed preview and file download choices are host policy.

Worker decode batching is optional: `maxBatchBytes` is an integer in `0..1048576`, with `0` disabling batching. The first row is immediate; wider-than-budget rows remain atomic. This is a batch-buffer budget, not a total memory ceiling. `outputQueueBytes` reports the allocated batch or the full backing buffer of an unacknowledged output; short views can therefore have a smaller `byteLength`. `outputPeakBytes` additionally counts the source row while copying into a batch, remains monotonic across progress/data/terminal records, and is retained after `done` clears the live queue. These are explicit output payloads, not JavaScript heap or browser RSS. See [SDK ownership and metrics](../sdk/README.md).
