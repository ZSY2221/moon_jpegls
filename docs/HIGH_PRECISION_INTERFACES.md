# High-precision image interfaces

MoonJLS processes unsigned integer samples. The verified grayscale profile has one frame, one component and one scan with ILV=0. The coded precision `bits` determines the full-range MAXVAL. Pass the effective precision independently of the width of the storage container. [Current scope](SCOPE.md) · [NEAR validation](../reports/review-near-20261125/README.md)

| Coded precision | MAXVAL | Legal NEAR | Raw and PGM sample size |
| --- | --- | --- | --- |
| 8 bits | 255 | 0–127 | 1 byte |
| 12 bits | 4095 | 0–255 | 2 bytes |
| 16 bits | 65535 | 0–255 | 2 bytes |

## Storage and layout

| Path | Sample representation and ownership |
| --- | --- |
| MoonBit core | A `FixedArray[Int]` holds unscaled integer samples. Streaming decode borrows one prediction line until the next step. Whole-image helpers collect full output. |
| JS and Wasm GC SDK | All three precisions travel as `Uint16Array` values. Stream callbacks receive owned rows and the Worker can transfer consecutive rows in a batch. Use explicit byte order when converting a raw byte buffer to sample values. |
| Native raw | Tight top-to-bottom rows, left to right, with no padding. `raw-le` uses little-endian byte pairs and `raw-be` uses big-endian byte pairs. The 8-bit representation uses one byte per sample. |
| P5 PGM | Tight rows. The header's MAXVAL determines the coded precision for the current profile. Two-byte samples use big-endian order. |
| MoonImage Gray16 | The example adapter reads big-endian sample pairs with the input's byte stride and skips row padding. Supply the effective `bits`, including `12` for values in 0–4095 stored in Gray16. Decode returns the JPEG-LS `Frame` and a tight big-endian Gray16 raster with default MoonImage metadata. The adapter holds whole rasters. |

For example, sample `2048` at 12-bit precision has value `0x0800` in a typed array, bytes `00 08` in `raw-le`, and bytes `08 00` in `raw-be` or PGM. The host owns physical units, calibration and container metadata. [Core and SDK APIs](API.md) · [Gray16 example](../examples/consumer/README.md)

## Sample error and resource limits

For this profile, `NEAR=0` gives exact reconstruction. Positive `NEAR` bounds `abs(original - reconstructed)` for each sample in its integer scale. The workbench checks the whole raster and presents a bounded preview with integer pixel inspection. Encode rejects out-of-range samples and invalid NEAR with `InvalidArgument`. In a coded stream, an illegal NEAR yields `InvalidData`. Valid features outside this profile, such as custom MAXVAL or presets, can yield `UnsupportedFeature`. [APIs and error codes](API.md)

The single-component streaming core keeps two width-sized prediction lines, adaptive contexts and a gradient lookup table. `workspace_bytes()` reports logical payload, including table lengths. CLI staging, SDK bridge buffers, Worker queues, browser previews and sinks have separate accounting. The whole-image helpers and Gray16 convenience adapter allocate full rasters. Rows remain provisional until the stream finishes. [Resource formulas](ARCHITECTURE.md)

## Scan-aware interfaces in the Part 1 roadmap

The compatibility plan retains the existing grayscale `Frame` and row-oriented entry points. Future multi-component and multi-scan APIs will specify frame and component metadata, component order and sampling, and the active scan's ILV, NEAR, point transform and mapping selectors. Host buffers will describe storage layout and stride explicitly. ILV is a bitstream property, while tight or strided planar or packed raster layout is a host property.

The design must report effective MAXVAL and parameters at the scope where they apply. Point transforms require separate coded-domain and original-scale error reporting. Mapping tables require describing their output sample representation. Delivering combined rows from successive component scans can require buffering or external storage. The memory model for those modes must account for component state, tables and host assembly. [T.87 conformance plan](T87_CONFORMANCE_PLAN.md) · [Compatibility roadmap](ROADMAP.md)
