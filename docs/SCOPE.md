# JPEG-LS Support Scope (Current M2 vs. T.87 Part 1 Target)

**Final Standard Target**: MoonJLS targets the **complete ITU-T T.87 (06/1998) / ISO/IEC 14495-1 JPEG-LS Part 1** encoding, decoding, and data-format capabilities (including both interchange format and abbreviated/table-specification formats, verified via §8 and Annex E). **Current M2 is a delivered milestone on that path, NOT the final scope.** [Authoritative T.87 Conformance Plan](T87_CONFORMANCE_PLAN.md) · [Compatibility Roadmap](ROADMAP.md)

| Dimension | Current M2 Profile (Delivered 2026-11-25) | Final T.87 Part 1 Target (M3-A through M5) |
| --- | --- | --- |
| **Image & Scan Layout** | One frame, one component, one scan, `ILV=0`, `Pt=0`. Known dimensions `1..65,535` (bounded by caller `Limits`). | Multi-component `SOF55`, multi-scan `SOS`, `ILV=0/1/2`, legal `H/V` sampling & edge MCUs, point transform `Pt`, deferred `DNL`, extended dimensions `LSE4`. |
| **Precision & MAXVAL** | Coded precision **`P=2–16`**. Default `MAXVAL = 2^P − 1`; explicit legal `MAXVAL` in `1..2^P−1`. | Same full standard `P=2–16` & `MAXVAL` across multi-component and transformed scans. |
| **NEAR** | Integer `0..min(255, floor(MAXVAL/2))`, verified in original unsigned integer sample units (`Pt=0`, unmapped). | When `Pt>0`, separate coded-domain `|q̂−q| ≤ NEAR` and conservative original-scale bound `s·NEAR + s − 1` (`s = 2^Pt`). |
| **LSE & Tables** | **`LSE ID=1`** (`MAXVAL`, `T1/T2/T3`, `RESET`). Decode accepts implicit defaults, zero fields, and legal explicit overrides (last applicable `LSE1` wins). Encoder emits resolved explicit values when writing `LSE1`. | Cross-scan `LSE1` inheritance (`M3-A`); **`LSE ID=2`** mapping tables, **`LSE ID=3`** table continuations, **`§7(b)`** table-specification streams, and **`§7(c)`** abbreviated image format (`M4`). |
| **Sample Storage** | Core uses MoonBit `Int32` slots. Native raw uses 1 byte/sample for `P<=8`, 2 bytes (`raw-le`/`raw-be`) for `P=9–16`. `P5` PGM uses actual `MAXVAL` (2-byte big-endian when `MAXVAL>255`). SDK uses `Uint16Array` for all `P=2–16`. | Explicit multi-component / planar / packed host buffer & stride contracts (`M3-A` / `M3-B`). |
| **Entropy & Markers** | Regular mode, run mode, run interruption, JPEG-LS `0xFF` 1-bit stuffing; `SOI`, `SOF55`, `LSE1`, `SOS`, `EOI`, budgeted `APPn`/`COM` before `SOF55`/`SOS`. | `DRI` & `RST0–RST7` interval resets, `DNL`, `LSE2/3/4`, and all remaining standard marker positions & filler rules (`M4`). |
| **Backends** | Single pure MoonBit `core` compiled to **Native**, **Wasm GC**, and **JS**. | Same single pure MoonBit core across Native, Wasm GC, and JS. |

## Boundary Separation: Part 1 vs. Part 2 & Containers

- **Included in MoonJLS Final Target**: ITU-T T.87 (06/1998) / ISO/IEC 14495-1 **JPEG-LS Part 1** (Interchange Format + Abbreviated / Table-Specification Formats + §8/Annex E conformance).
- **Separate Out-of-Scope Extensions (Not Part 1 requirements)**:
  - **ITU-T T.870 / ISO/IEC 14495-2 (JPEG-LS Part 2)** extensions.
  - **DICOM** application-layer container encapsulation.
- **Optional Standard Container**: **SPIFF** (recommended in T.87 §4.8 and Annex H.5) is documented and tracked separately from the Annex C core bitstream matrix.

## API & Verification Evidence Notes

- MoonBit keeps `Frame`, `P`, `MAXVAL`, and `NEAR` compatible across grayscale entrypoints (`Frame::maxval()` yields default full-scale `2^P−1`, `Preset` holds resolved `maxval/t1/t2/t3/reset`; streaming decode exposes parameters active at `SOS`). [Public API](API.md)
- Streaming decode returns the exact position after `EOI` (`Done`), keeping pre-EOI rows provisional and rejecting trailing bytes by default.
- Verification datasets are explicitly separated by scope:
  - **388 M2 synthetic cases + 18 LSE variants + 7 invalid encodes + 6 Native PGM checks** (local HP V.1.00 + Annex A vectors) and **12 representative independent golden cases + 18 variants + 7 invalid encodes + 4 PGM checks** running in CI (`scripts/verify_m2_golden.mjs`).
  - **Annex E Table E.2**: `E.2-9`–`E.2-12` passed bidirectional encode/decode across all 3 backends; `E.2-1`–`E.2-8` return expected `UnsupportedFeature` on decode (`encode` `not_run`). [Conformance Results](CONFORMANCE_RESULTS.md)
  - **Historical 640 full-range NEAR regression** (8/12/16-bit full-scale `MAXVAL` only — NOT the full M2 parameter Cartesian product). [Validation](VALIDATION.md)
