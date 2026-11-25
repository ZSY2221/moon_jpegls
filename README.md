# MoonJLS: MoonBit-Native JPEG-LS Part 1 Codec and Conformance Verification Toolkit

[简体中文](README.zh-CN.md)

**MoonJLS** is a pure MoonBit **ITU-T T.87 (06/1998) / ISO/IEC 14495-1 JPEG-LS Part 1** streaming codec kernel, multi-target integration layer (Native / JS / Wasm GC), and reproducible conformance verification toolkit. It solves lossless and bounded near-lossless interchange of high-precision scientific, remote-sensing elevation, industrial grayscale, and MoonBit imaging rasters without buffering whole images in core memory. [MoonBit Implementation Map](docs/MOONBIT_IMPLEMENTATION_MAP.md) · [High-Precision Interfaces](docs/HIGH_PRECISION_INTERFACES.md)

## Current M3-A Profile vs. Final T.87 Part 1 Target

- **1. Final Target**: Complete **ITU-T T.87 (06/1998) / ISO/IEC 14495-1 JPEG-LS Part 1** encoding, decoding, and data-format capabilities (interchange format, abbreviated & table-specification formats, and `§8` / Annex E conformance), verified in phases against standard requirements. **T.870 Part 2** and **DICOM containers** are separate extensions; **SPIFF** (`§4.8` / `Annex H.5`) is tracked separately as an optional container. [T.87 Conformance Plan](docs/T87_CONFORMANCE_PLAN.md)
- **2. Currently Completed (M3-A — Delivered Stage, NOT Final Scope)**: Single-frame grayscale & **non-interleaved multi-component multi-scan JPEG-LS (`1..255` components, `ILV=0`, `Ns=1`, `H=V=1`, `Pt=0`)**, coded precision **`P=2–16`**, independent **`MAXVAL` (`1..2^P−1`)**, legal **`NEAR` (`0..min(255, floor(MAXVAL/2))`)**, cross-scan **`LSE ID=1` (`T1/T2/T3/RESET`)** inheritance and zero-default re-resolution, arbitrary non-contiguous component IDs & legal reordered scan sequences, strict rejection of duplicate/missing/unknown components and trailing bytes after `EOI`, Native planar CLI (`encode-planar`, `encode-pgms`, `encode-ppm`, `decode-pgms`, `inspect --json`), SDK/Worker multi-scan streaming, and the scientific workbench with **Multicomponent View** and **Scan Structure Inspector**. Tested product source: [`36bb9e6`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5). [Support Scope](docs/SCOPE.md) · [Two-Minute Reviewer Guide](docs/REVIEWER_GUIDE.md)
- **3. Next Implementation Path**: Interleave, sampling & point transform (`M3-B`) → mapping tables, abbreviated streams, `DRI/RST`, `DNL`, `LSE4` & remaining markers (`M4`) → full conformance acceptance (`M5`). Future milestone dates below are internal engineering targets only, not organizer-confirmed hackathon deadlines. [Compatibility Roadmap](docs/ROADMAP.md)

## Build & Run

Verified toolchain: Moon `0.1.20261119` (`moonc v0.10.22+124d61d05`), Node `24.20.0`, and Ubuntu 22.04 WSL2 `clang 14` for Native builds.

```sh
# 1. Run pure MoonBit core tests (18/18 on every backend)
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
CC=clang moon test core --target native --deny-warn

# 2. Build Native CLI, JS/Wasm GC SDK, and Scientific Workbench
CC=clang moon build cmd/moonjls --target native --release --deny-warn
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

Native CLI file and streaming pipe usage (single-component & multi-component `ILV=0`):

```sh
python3 scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm
moon run --target native cmd/moonjls -- encode-pgm 0 .evidence/real/lola.pgm lola.jls 4096
moon run --target native cmd/moonjls -- decode lola.jls recovered.pgm pgm 4096
moon run --target native cmd/moonjls -- encode-planar 64 32 16 3 0 planes.raw out.jls raw-le 4096 --comp-ids 10,42,7 --scan-order 42,7,10
moon run --target native cmd/moonjls -- decode-pgms out.jls c0.pgm c1.pgm c2.pgm
moon run --target native cmd/moonjls -- encode-ppm 0 rgb.ppm rgb.jls
moon run --target native cmd/moonjls -- inspect out.jls --json
```

- `encode` / `encode-pgm` stream single-component raw/PGM inputs (`P<=8` 1 byte/sample, above 2 bytes); `encode-planar` / `encode-pgms` / `decode-pgms` stream multi-component planes with `host_conversion_buffer_bytes=0`; `encode-ppm` / `decode ppm` perform explicit P6 RGB planar conversion. Use `-` for stdin/stdout. [Streaming Pipeline Example](examples/stream_pipeline.sh) · [SDK Guide](sdk/README.md) · [MoonImage Gray16 Consumer](examples/consumer/README.md)
- Open [the local workbench](http://127.0.0.1:8000/web/) for Precision Lab, Multicomponent View, Scan Structure Inspector, Streaming Lab, and Compatibility Lab. [Browser Checks](web/README.md) · [M3-A Acceptance Summary](reports/t87-m3a-20261125/README.md)

## Verification & Honest Evidence Scope

```sh
# Fast 3-backend independent M2 & M3-A golden regressions + Annex E manifest check (run in CI)
node scripts/validate_annex_e.mjs --check-manifest
node scripts/verify_m2_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe
node scripts/verify_m3a_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe
```

- **Three-backend core tests**: **18/18** MoonBit tests pass on Native, JS, and Wasm GC (`--deny-warn`, 0 warnings).
- **CI automated checks** ([workflow](.github/workflows/verification.yml)): runs 18/18 core tests on 3 backends, Native row-delivery, multi-scan delivery (`native_multiscan_delivery_regression.py`), & tail regressions, Worker/SDK/TS strict checks, Annex E manifest schema check, **M2 golden suite (`verify_m2_golden.mjs`)**, **M3-A golden suite (`verify_m3a_golden.mjs`: 7 positive + 7 negative multi-component cases)**, and the **640 full-range NEAR matrix** (`scripts/validate.py --near-matrix`).
- **Measured M3-A full independent acceptance** (fixed tested product core/CLI/SDK [`36bb9e6`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5), report [reports/t87-m3a-20261125/README.md](reports/t87-m3a-20261125/README.md)):
  - **Official Annex E Table E.2 (6/12 passed)**: **`E.2-1` (`T8C0E0.JLS`, 3-comp lossless)**, **`E.2-4` (`T8C0E3.JLS`, 3-comp `NEAR=3`)**, and **`E.2-9`–`E.2-12`** passed bidirectional encode & decode on JS, Wasm GC, and Native against BOTH **HP JPEG-LS 1.00** and **CharLS Wasm 0.10.0** (all **18** candidate encoded bitstreams byte-for-byte identical to the official ITU `.JLS` files); **`E.2-2, 3, 5, 6, 7, 8`** (interleaved / subsampled) return expected `UnsupportedFeature` on decode (`encode` `not_run`). **Passing 6/12 is an M3-A milestone — NOT full T.87 Part 1 completion.** [Conformance Results](docs/CONFORMANCE_RESULTS.md)
  - **M2 & M3-A local synthetic suites**: **388 M2 positive cases + 18 LSE variants + 7 invalid encodes + 6 Native PGM checks** (`lse-after-scan` reclassified to `InvalidData` once multi-scan resumed, matching HP `nlocod.exe` & CharLS Wasm) and **7+7 M3-A golden vectors** passed across 3 backends.
  - **Full-range NEAR matrix**: **640/640** passed across Native, JS, and Wasm GC (specific full-scale 8/12/16-bit configurations — **not** an exhaustive Cartesian product of arbitrary `P`/`MAXVAL`/multi-scan presets).
  - **Chrome 158 Workbench & Packaging**: `#sample-rgb8` (NEAR=0/3 + `.ppm` + CharLS Wasm verify), `#sample-multi16` (`MAXVAL=65,535`, `>255` integer inspector), standalone `.jls` decode (`C0/C1/C2` labels, Scan Structure Inspector click linkage), and Compatibility Lab verified in Chrome 158; `moon package --frozen` passes (`0.1.0`), while public Mooncakes registry currently returns `not found` / HTTP 404 (no online `moon publish` run). [Mooncakes Readiness](docs/MOONCAKES_RELEASE.md) · [Benchmark](docs/BENCHMARK.md)

## Roadmap (Completed M0–M3-A & Next Targets)

| Phase | Status / Target Date* | Scope & Primary Acceptance Criteria |
| --- | --- | --- |
| **M0** | **Completed** | Pure MoonBit core, Native/JS/Wasm GC, streaming state machine, CLI/Worker/Workbench, and 3 correctness fixes (`16a7b49`). |
| **M1** | **Completed** | Full legal `NEAR` expansion at full-scale 8/12/16-bit (`640/640` CharLS bidirectional parity). |
| **M2** | **Completed (2026-11-25)** | `P=2–16`, independent `MAXVAL`, legal `NEAR`, custom `LSE ID=1` (`T1/T2/T3/RESET`), Precision/Streaming/Compatibility Labs (`fc43bc2`). |
| **M3-A** | **Completed (2026-11-25)** | Multicomponent (`1–255`), multiple `SOS`, `ILV=0` multi-scan state, cross-scan `LSE1` inheritance/zero-reset, reordered scan IDs, Multicomponent Workbench & Scan Inspector (`36bb9e6`). Verified **Annex E `E.2-1`, `E.2-4`** (+ `E.2-9..12` = 6/12). |
| **M3-B** | Target **2026-12-25** | `ILV=1` (line), `ILV=2` (sample), legal `H/V` sampling & edge MCUs, point transform `Pt` & dual-scale error reporting. Exit: **Annex E `E.2-2`, `E.2-3`, `E.2-5`–`E.2-8`**. |
| **M4** | Target **2027-01-10** | Mapping tables & continuations (`LSE2/3`), table-spec & abbreviated formats (`§7(b)(c)`), `DRI/RST0–RST7`, `DNL`, `LSE4` extended dimensions, remaining markers. |
| **M5** | Target **2027-01-20** | Full Part 1 conformance closure: official Annex E (`12/12`), T.87 `§8.2`/`§8.3`, capability-qualified oracles, 3-backend clean-room reproducibility. |

*\*Dates from M3-B onward are internal engineering targets, not organizer-confirmed hackathon acceptance dates.* [Compatibility Roadmap](docs/ROADMAP.md) · [Project Status](PROJECT_STATUS.md) · [Benchmark](docs/BENCHMARK.md)
