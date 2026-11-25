# Architecture

`core/` contains the codec shared by Native, JS and Wasm GC. `cmd/moonjls` adapts native files and pipes. `cmd/bridge` exports a buffer-oriented ABI for the SDK, and `sdk/` adapts it to typed arrays and a Worker protocol. The browser uses the same SDK as a Node consumer. `scripts/` and `tests/` run the independent oracle and measurements. CharLS is a development dependency.

## From prediction to the bitstream

`parameters.mbt` derives RANGE, qbpp, LIMIT, and thresholds from coded precision and NEAR. `model.mbt` implements the median edge predictor, signed context normalization, bias correction, quantized errors and modulo reconstruction. The encoder stores reconstructed values in its prediction lines, including run samples. Consequently a subsequent prediction uses the same values as the decoder. Both use 365 regular contexts and two run interruption contexts, with RESET=64. Counter and intermediate arithmetic uses 32-bit `Int`. The largest supported RANGE is 65536. Across the 640 supported precision and NEAR combinations, the magnitude of a reduced error is at most 32768 and `RANGE × (2 × NEAR + 1)` is at most 66504 (16-bit, NEAR=244). A reduced error times the quantization step has magnitude at most 33252. Adding it to a clipped prediction gives an intermediate in −33252..98787 before the single wrap adjustment and final clamp. Context sums stay below 2²² under the RESET=64 schedule.

`markers.mbt` consumes segment lengths and structured payloads incrementally. APPn and COM are skipped by counting bytes against `max_metadata_bytes`. Dimensions are checked before allocating the scan. The pixel limit uses division before any width × height multiplication. LSE ID 1 zero fields resolve against the defaults in effect at SOS. The encoder writes explicit default presets for 16-bit streams for compatibility with readers that expect them.

`bits.mbt` uses eight payload bits per byte and seven for a byte immediately following an entropy byte of `FF`. Unary Golomb codes have a mode-specific bound and an escape with `qbpp` suffix bits. The decoder keeps the unary count and partial suffix across calls. It commits a prediction update only after it has the complete symbol. Run segments can be emitted or applied as soon as a full block is known. Row completion preserves the run index and adaptive contexts for the next line.

## Ownership and limits

| Storage | Bound in the core |
| --- | --- |
| Reconstructed prediction lines | Two `FixedArray[Int]` objects of `width` elements |
| Adaptive contexts | 365 × 4 and 2 × 3 signed integer fields, plus references and object headers |
| Decoder header scratch | 771 payload bytes and five preset integers. APPn/COM size does not increase this scratch. |
| Encoder byte queue | 32 bytes. The first header stage is at most 30 bytes. A subsequent stage drains before more input is coded. |
| Decoder byte residual | At most eight unread bits from a supplied byte. Partial Golomb/run states use scalar counters. |
| Completed decoded row | One borrowed prediction line at a time. Next `step` acknowledges the row and allows reuse. |

`workspace_bytes()` counts the allocated array payload and logical context counters, using four bytes per integer. Once the scan is initialized, the current implementation gives `8 × width + 5896 + 4 × q_lut.length()` for encode and `8 × width + 6655 + 4 × q_lut.length()` for decode. The gradient quantization table belongs to each scan and has `2 × T3 + 1` integer entries. At 8 bits, the default threshold calculation can fall back to the previous bound as NEAR increases, so the table size is not monotonic. At NEAR=255 the 12-bit and 16-bit tables each have 4123 entries (16492 B), the largest in this profile. At width 512 and 16 bits, the encoder and initialized decoder report 12204 B and 12963 B for NEAR=0, and 26484 B and 27243 B for NEAR=255, respectively. Earlier benchmark reports retain the counts of their own source versions. Runtime object headers, references, stack, adapter data and copies, and host allocator behavior are measured or accounted for separately. See [BENCHMARK.md](BENCHMARK.md).

The CLI bounds input, sample staging and output blocks with its chunk setting. It serially awaits each write. The SDK stages one input at a time and copies rows or emitted bytes into typed arrays. A Worker waits for acknowledgement of each row or byte event before sending another. The browser preview keeps a fixed maximum grid. Standard downloads collect Blob parts. The bounded encode mode reuses a single compressed chunk and validates the reconstruction without retaining a compressed image.

The convenience functions collect one compressed or reconstructed image. The independent Gray16 adapter also allocates a whole image to honor the third-party image type. Neither path is used to establish end-to-end streaming bounds.

## End-of-stream and failures

An empty chunk is ordinary input. The encoder needs an explicit final signal and an exact sample count. The decoder can reach `Done` with `eof=false` after checking zero padding and EOI. With `eof=true`, a missing required byte is `Truncated`. Codec errors and cancellation are sticky. Budget violations return `ResourceLimit` before the corresponding allocation. Exhaustion inside the runtime allocator itself follows the host's failure behavior. Callers must honor the consumed count and preserve suffixes across row events. Decoded rows are provisional until `Done`, since an error or cancellation can follow an earlier row event. The envelope has no integrity checksum.
