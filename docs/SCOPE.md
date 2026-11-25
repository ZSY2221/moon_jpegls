# JPEG-LS Support Scope (Current M3-A vs. T.87 Part 1 Target)

**Final Standard Target**: MoonJLS targets the **complete ITU-T T.87 (06/1998) / ISO/IEC 14495-1 JPEG-LS Part 1** encoding, decoding, and data-format capabilities (including both interchange format and abbreviated/table-specification formats, verified via §8 and Annex E). **Current M3-A is a delivered milestone on that path, NOT the final scope.** [Authoritative T.87 Conformance Plan](T87_CONFORMANCE_PLAN.md) · [Compatibility Roadmap](ROADMAP.md)

| Dimension | Current M3-A Profile (Delivered 2026-11-25) | Final T.87 Part 1 Target (M3-B through M5) |
| --- | --- | --- |
| **Image & Scan Layout** | One frame, **1–255 components** (`H=V=1`), **non-interleaved multi-scan (`ILV=0`, `Ns=1` per `SOS`)**, `Pt=0`. Supports arbitrary non-contiguous component IDs and reordered scan sequences; rejects duplicate, missing, or unknown component IDs and premature `EOI`. Known dimensions `1..65,535` (overflow-safe `width × height × components` limited by caller `Limits`). | Interleaved modes `ILV=1/2`, legal `H/V` subsampling (`1..4`) & edge MCUs, point transform `Pt`, deferred `DNL`, extended dimensions `LSE4`. |
| **Precision & MAXVAL** | Coded precision **`P=2–16`**. Default `MAXVAL = 2^P − 1`; explicit legal `MAXVAL` in `1..2^P−1`. | Same full standard `P=2–16` & `MAXVAL` across interleaved, subsampled, and transformed scans. |
| **NEAR** | Per-scan integer `NEAR` in `0..min(255, floor(effective_MAXVAL/2))`, verified in original unsigned integer sample units (`Pt=0`, unmapped). | When `Pt>0`, separate coded-domain `|q̂−q| ≤ NEAR` and conservative original-scale bound `s·NEAR + s − 1` (`s = 2^Pt`). |
| **LSE & Tables** | **`LSE ID=1`** (`MAXVAL`, `T1/T2/T3`, `RESET`). Retains raw parameters and zero-default semantics across scans, re-resolving per-scan defaults at each `SOS` against that scan's active `NEAR`/`MAXVAL`; re-validates inherited overrides when `NEAR` increases. | **`LSE ID=2`** mapping tables, **`LSE ID=3`** table continuations, **`§7(b)`** table-specification streams, and **`§7(c)`** abbreviated image format (`M4`). |
| **Sample & Host Storage** | Core holds two prediction lines + context/run tables per active scan (reset at each `SOS`). Native raw streams in scan order (`host_conversion_buffer_bytes=0`); `encode-pgms`/`decode-pgms` stream per-component PGMs with zero whole-image buffer. P6 PPM import/export uses explicit `host_conversion_buffer_bytes` for RGB planar conversion. SDK exposes `encodePlanarImage`/`decodePlanarImage`/`inspectStream`; workbench accounts preview & conversion buffers separately. | Explicit interleaved/subsampled row and MCU contracts (`M3-B`). |
| **Entropy & Markers** | Regular mode, run mode, run interruption, JPEG-LS `0xFF` 1-bit stuffing; `SOI`, multi-component `SOF55`, `LSE1`, multiple `SOS`, `EOI`, inter-scan `LSE1`/`DRI=0`/`APPn`/`COM` (trailing markers after the final component without another `SOS` before `EOI`, e.g. `lse-after-scan`, are classified as `InvalidData`). | `DRI` & `RST0–RST7` interval resets, `DNL`, `LSE2/3/4`, and all remaining standard marker positions & filler rules (`M4`). |
| **Backends** | Single pure MoonBit `core` compiled to **Native**, **Wasm GC**, and **JS**. | Same single pure MoonBit core across Native, Wasm GC, and JS. |

## Boundary Separation: Part 1 vs. Part 2 & Containers

- **Included in MoonJLS Final Target**: ITU-T T.87 (06/1998) / ISO/IEC 14495-1 **JPEG-LS Part 1** (Interchange Format + Abbreviated / Table-Specification Formats + §8/Annex E conformance).
- **Separate Out-of-Scope Extensions (Not Part 1 requirements)**:
  - **ITU-T T.870 / ISO/IEC 14495-2 (JPEG-LS Part 2)** extensions.
  - **DICOM** application-layer container encapsulation.
- **Optional Standard Container**: **SPIFF** (recommended in T.87 §4.8 and Annex H.5) is documented and tracked separately from the Annex C core bitstream matrix.

## API & Verification Evidence Notes

- Grayscale compatibility entrypoints (`encode`, `decode`, `decode_with_preset`, `Encoder::new`) remain intact; single-component `decode` rejects multi-component streams cleanly with `UnsupportedFeature`. Multi-component entrypoints (`Encoder::new_multicomponent`, `encode_multicomponent`, `decode_multicomponent`, `inspect`) expose `FrameInfo`, `ScanInfo`, `StreamStructure`, and `ErrorLocation`. [Public API](API.md)
- Streaming decode returns `Done` strictly after `EOI`, delivers Component 1 rows immediately before Scan 2/`EOI` arrive, keeps pre-EOI rows provisional, and rejects trailing bytes by default.
- Verification datasets are explicitly separated by scope:
  - **Annex E Table E.2 (6/12)**: `E.2-1`, `E.2-4`, `E.2-9`, `E.2-10`, `E.2-11`, and `E.2-12` passed bidirectional encode/decode across JS, Wasm GC, and Native against both HP 1.00 and CharLS Wasm (all 18 candidate bitstreams byte-identical to official `.JLS`); `E.2-2, 3, 5, 6, 7, 8` return expected `UnsupportedFeature` on decode (`encode` `not_run`). **Passing 6/12 does NOT imply full T.87 Part 1 completion.** [Conformance Results](CONFORMANCE_RESULTS.md)
  - **M3-A Golden Suite** (`scripts/verify_m3a_golden.mjs` in CI): 7 positive cases (2/3/4 components, non-contiguous IDs, reordered scans, cross-scan `LSE1`/zero-reset/per-scan `NEAR`, inter-scan `COM`/`DRI=0`) + 7 negative streams across all 3 backends & CharLS Wasm where applicable.
  - **M2 Synthetic Matrix & CI Golden** (`scripts/test_m2.py`: 388 positive + 18 variants + 7 invalid encodes + 6 Native PGM; `scripts/verify_m2_golden.mjs` in CI: 12 + 18 + 7 + 4) plus **640 full-range NEAR matrix** (`scripts/validate.py --near-matrix`). [M3-A Acceptance Summary](../reports/t87-m3a-20261125/README.md)
