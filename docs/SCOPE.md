# JPEG-LS Support Scope

**Final Standard Target**: MoonJLS targets the **complete ITU-T T.87 (06/1998) / ISO/IEC 14495-1 JPEG-LS Part 1** encoding, decoding, and data-format capabilities (including both interchange format and abbreviated/table-specification formats, verified via §8 and Annex E). **The verified profile includes interleaved scans, H/V sampling, edge MCUs and unmapped point transform.** [Authoritative T.87 Conformance Plan](T87_CONFORMANCE_PLAN.md) · [Compatibility Roadmap](ROADMAP.md)

| Dimension | Current Profile (2026-11-26) | Final T.87 Part 1 Target (M3-B through M5) |
| --- | --- | --- |
| **Image & Scan Layout** | One frame, **1–255 components** with H/V factors in 1..4. ILV=0 uses one component per scan. ILV=1/2 uses 2–4 components per scan. ILV=2 requires equal component dimensions within its scan. ILV=1 codes V_i whole lines per component per MCU, including final padded lines, and only delivers actual component rows. Dimensions are limited to 1..65,535 and resource limits count actual samples. | Deferred DNL and extended dimensions are planned. |
| **Precision & MAXVAL** | SOF55 source precision **`P=2–16`**. The coding-domain default is `MAXVAL = 2^P − 1`, including transformed scans. Explicit `MAXVAL` is in `1..2^P−1`. | Mapping table output representation. |
| **NEAR** | Per-scan `NEAR` in `0..min(255, floor(effective_MAXVAL/2))` applies in the coding domain. With unmapped Pt, the original-scale bound is `s·NEAR + s − 1` (`s = 2^Pt`). | Mapping table sample-domain semantics. |
| **LSE & Tables** | **`LSE ID=1`** (`MAXVAL`, `T1/T2/T3`, `RESET`). Retains raw parameters and zero-default semantics across scans, re-resolving per-scan defaults at each `SOS` against that scan's active `NEAR`/`MAXVAL`; re-validates inherited overrides when `NEAR` increases. | **`LSE ID=2`** mapping tables, **`LSE ID=3`** table continuations, **`§7(b)`** table-specification streams, and **`§7(c)`** abbreviated image format (`M4`). |
| **Sample & Host Storage** | The core holds two prediction lines per component and one set of context tables per scan. ILV=1 has independent run indices; ILV=2 shares a run index. Native PGM/PPM interleaved encoding is row-bounded. Native interleaved `encode-planar` converts whole planar input; `host_conversion_buffer_bytes` records the allocation. SDK exposes `encodePlanarImage`/`decodePlanarImage`/`inspectStream`; workbench accounts preview & conversion buffers separately. | Mapping table sample-domain contracts. |
| **Entropy & Markers** | Regular mode, run mode, run interruption, JPEG-LS `0xFF` 1-bit stuffing; `SOI`, multi-component `SOF55`, `LSE1`, multiple `SOS`, `EOI`, inter-scan `LSE1`/`DRI=0`/`APPn`/`COM` (trailing markers after the final component without another `SOS` before `EOI`, e.g. `lse-after-scan`, are classified as `InvalidData`). | `DRI` & `RST0–RST7` interval resets, `DNL`, `LSE2/3/4`, and all remaining standard marker positions & filler rules (`M4`). |
| **Backends** | Single pure MoonBit `core` compiled to **Native**, **Wasm GC**, and **JS**. | Same single pure MoonBit core across Native, Wasm GC, and JS. |

## Point transform

Unmapped Pt=0–15 is supported in the MoonBit core, Native, JS and Wasm GC. Native exposes `raw32-le` and `raw32-be` in decoder delivery order. SDK and Worker opt in to `Uint32Array`, and the workbench exports 32-bit little-endian planes in declared component order. Narrow outputs reject unrepresentable values. Nonzero Pt requires all scan mapping selectors to be zero. Independent evidence includes sampled edge MCUs. [Point-transform results and limits](POINT_TRANSFORM_RESULTS.md)

## Embedded mapping tables

Interchange decoding supports embedded `Wt=1` tables in LSE ID 2 and canonical ID 3 continuations, replacement between scans, and per-component SOS selectors at Pt=0. The output uses unsigned mapped bytes and NEAR remains in the index domain. Wider entries have no standard numeric interpretation. Their output contract, encoding, external tables and abbreviated streams remain M4 work. [Embedded mapping results and limits](EMBEDDED_MAPPING_RESULTS.md)

## Boundary Separation: Part 1 vs. Part 2 & Containers

- **Included in MoonJLS Final Target**: ITU-T T.87 (06/1998) / ISO/IEC 14495-1 **JPEG-LS Part 1** (Interchange Format + Abbreviated / Table-Specification Formats + §8/Annex E conformance).
- **Separate Out-of-Scope Extensions (Not Part 1 requirements)**:
  - **ITU-T T.870 / ISO/IEC 14495-2 (JPEG-LS Part 2)** extensions.
  - **DICOM** application-layer container encapsulation.
- **Optional Standard Container**: **SPIFF** (recommended in T.87 §4.8 and Annex H.5) is documented and tracked separately from the Annex C core bitstream matrix.

## API & Verification Evidence Notes

- Grayscale compatibility entrypoints (`encode`, `decode`, `decode_with_preset`, `Encoder::new`) remain intact; single-component `decode` rejects multi-component streams cleanly with `UnsupportedFeature`. Multi-component entrypoints (`Encoder::new_scans`, `encode_scans`, `decode_multicomponent`, `inspect`) expose `FrameInfo`, `ScanInfo`, `StreamStructure`, and `ErrorLocation`. [Public API](API.md)
- Streaming decode returns `Done` strictly after `EOI`, delivers Component 1 rows immediately before Scan 2/`EOI` arrive, keeps pre-EOI rows provisional, and rejects trailing bytes by default.
- Verification datasets are explicitly separated by scope:
  - **Annex E Table E.2 (12/12)**. The same candidate passed encode and decode on JS, Wasm GC, and Native against HP 1.00. CharLS Wasm independently verified ten cases and returned `reference_unsupported` for E.2-7/8. [Conformance Results](CONFORMANCE_RESULTS.md) · [Workbench checks](../reports/t87-m3b-20261126/public-delivery/workbench-chrome.json)
  - **M3-A Golden Suite** (`scripts/verify_m3a_golden.mjs` in CI): 7 positive cases (2/3/4 components, non-contiguous IDs, reordered scans, cross-scan `LSE1`/zero-reset/per-scan `NEAR`, inter-scan `COM`/`DRI=0`) + 7 negative streams across all 3 backends & CharLS Wasm where applicable.
  - **M2 Synthetic Matrix & CI Golden** (`scripts/test_m2.py`: 388 positive + 18 variants + 7 invalid encodes + 6 Native PGM; `scripts/verify_m2_golden.mjs` in CI: 12 + 18 + 7 + 4) plus **640 full-range NEAR matrix** (`scripts/validate.py --near-matrix`). [M3-A Acceptance Summary](../reports/t87-m3a-20261125/README.md)
