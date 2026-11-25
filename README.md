# MoonJLS: MoonBit-Native JPEG-LS Part 1 Codec and Conformance Verification Toolkit

[简体中文](README.zh-CN.md)

**MoonJLS** is a pure MoonBit **ITU-T T.87 (06/1998) / ISO/IEC 14495-1 JPEG-LS Part 1** streaming codec kernel, multi-target integration layer (Native / JS / Wasm GC), and reproducible conformance verification toolkit. It solves lossless and bounded near-lossless interchange of high-precision scientific, remote-sensing elevation, industrial grayscale, and MoonBit imaging rasters without buffering whole images in core memory. [MoonBit Implementation Map](docs/MOONBIT_IMPLEMENTATION_MAP.md) · [High-Precision Interfaces](docs/HIGH_PRECISION_INTERFACES.md)

## Current M2 Profile vs. Final T.87 Part 1 Target

- **1. Final Target**: Complete **ITU-T T.87 (06/1998) / ISO/IEC 14495-1 JPEG-LS Part 1** encoding, decoding, and data-format capabilities (interchange format, abbreviated & table-specification formats, and `§8` / Annex E conformance), verified in phases against standard requirements. **T.870 Part 2** and **DICOM containers** are separate extensions; **SPIFF** (`§4.8` / `Annex H.5`) is tracked separately as an optional container. [T.87 Conformance Plan](docs/T87_CONFORMANCE_PLAN.md)
- **2. Currently Completed (M2 — Delivered Stage, NOT Final Scope)**: One frame, one component, one scan (`ILV=0`, `Pt=0`), known dimensions (`1..65,535`), coded precision **`P=2–16`**, independent **`MAXVAL` (`1..2^P−1`)**, legal **`NEAR` (`0..min(255, floor(MAXVAL/2))`)**, and default or custom **`LSE ID=1` (`T1/T2/T3/RESET`)** presets, delivered across Native, JS, Wasm GC, streaming CLI/SDK/Worker interfaces, and the scientific workbench. Streaming encode/decode preserve chunk independence and reject trailing bytes after `EOI` (core 2-line prediction buffer accounting applies only to this single-component `ILV=0, Pt=0` profile). [Support Scope](docs/SCOPE.md) · [Two-Minute Reviewer Guide](docs/REVIEWER_GUIDE.md)
- **3. Next Implementation Path**: Multi-component & multi-scan (`M3-A`) → interleave, sampling & point transform (`M3-B`) → remaining format & marker capabilities (`M4`) → full conformance acceptance (`M5`). Future milestone dates below are internal engineering targets only, not organizer-confirmed hackathon deadlines. [Compatibility Roadmap](docs/ROADMAP.md)

## Build & Run

Verified toolchain: Moon `0.1.20261119` (`moonc v0.10.22+124d61d05`), Node `24.20.0`, and Ubuntu 22.04 WSL2 `clang 14` for Native builds.

```sh
# 1. Run pure MoonBit core tests (15/15 on every backend)
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
CC=clang moon test core --target native --deny-warn

# 2. Build Native CLI, JS/Wasm GC SDK, and Scientific Workbench
CC=clang moon build cmd/moonjls --target native --release
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

Native CLI file and streaming pipe usage:

```sh
python3 scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm
moon run --target native cmd/moonjls -- encode-pgm 0 .evidence/real/lola.pgm lola.jls 4096
moon run --target native cmd/moonjls -- decode lola.jls recovered.pgm pgm 4096
moon run --target native cmd/moonjls -- inspect lola.jls
moon run --target native cmd/moonjls -- verify lola.jls 17
```

- `encode WIDTH HEIGHT BITS NEAR INPUT OUTPUT [raw-le|raw-be] [CHUNK] [--maxval N] [--t1 N --t2 N --t3 N --reset N]` reads 1 byte/sample for `P<=8` and 2 bytes/sample above; `encode-pgm` reads `MAXVAL` from the `P5` PGM header (big-endian when `MAXVAL>255`). Use `-` for stdin/stdout. [Streaming Pipeline Example](examples/stream_pipeline.sh) · [SDK Guide](sdk/README.md) · [MoonImage Gray16 Consumer](examples/consumer/README.md)
- Open [the local workbench](http://127.0.0.1:8000/web/) for Precision Lab, Streaming Lab, and Compatibility Lab. [Browser Checks](web/README.md) · [Verification Report v1](docs/VERIFICATION_REPORT.md)

## Verification & Honest Evidence Scope

```sh
# Fast 3-backend independent M2 golden regression + Annex E manifest check (runs in CI)
node scripts/validate_annex_e.mjs --check-manifest
node scripts/verify_m2_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe
```

- **Three-backend core tests**: **15/15** MoonBit tests pass on Native, JS, and Wasm GC.
- **CI automated checks** ([workflow](.github/workflows/verification.yml)): runs 15/15 core tests on 3 backends, Native row-delivery & tail regressions, Worker/SDK/TS strict checks, Annex E manifest schema check, **12 independent synthetic HP/Annex A M2 golden cases + 18 LSE variants + 7 invalid encodes + 4 Native PGM checks** (`scripts/verify_m2_golden.mjs`), and the **historical 640 full-range NEAR matrix** (`scripts/validate.py --near-matrix`). Note: CI's `--check-manifest` checks manifest integrity only, and the 12 synthetic golden cases test single-component numeric/`LSE1` boundaries — they do **not** equal passing all 12 official ITU Annex E tests.
- **Archived M2 full independent acceptance** (fixed tested product source [`fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44), frozen evidence [`a7d8c39`](https://github.com/ZSY2221/moon_jpegls/commit/a7d8c391b7af0d88bc5c912ed62c78eaf4c79565); retained as fixed-source evidence and not re-executed on documentation-only commits):
  - **388 M2 positive cases** + **18 LSE wire variants** (5 valid, 13 rejected) + **7 invalid encodes** + **6 Native PGM checks** verified across all 3 backends against HP JPEG-LS V.1.00 and T.87 Annex A vectors (`MAXVAL=1,2`). [M2 Synthetic Matrix](reports/t87-m2-20261125/synthetic-matrix.md)
  - **Official Annex E Table E.2**: **`E.2-9`–`E.2-12`** passed encode & decode on all 3 backends (all 12 candidate bitstreams byte-identical to official `.JLS` files); **`E.2-1`–`E.2-8`** (multicomponent/interleaved/subsampled) returned expected `UnsupportedFeature` on decode (`encode` `not_run`). [Conformance Results](docs/CONFORMANCE_RESULTS.md)
  - **Historical M1 full-range NEAR regression**: **640/640** (specific full-scale 8-bit `NEAR=0–127` and 12/16-bit `NEAR=0–255` configurations — explicitly **not** an exhaustive Cartesian product of `P=2–16` × arbitrary `MAXVAL` × all custom presets). [Validation](docs/VALIDATION.md) · [M1 NEAR Report](reports/review-near-20261125/README.md)
  - **NASA LOLA & Chrome**: **1,036,800** 16-bit samples verified sample-by-sample against CharLS (`NEAR=0–3`) plus real Chrome workbench roundtrip, error heatmap, download, and cancel/restart checks. [Lunar Budget Report](reports/lunar-budget-20261125/README.md)
  - **Packaging**: Loopback registry package consumption (`0.1.0`) passed on 3 backends locally; public Mooncakes online query currently returns HTTP 404 (not a public Mooncakes release). [Mooncakes Readiness](docs/MOONCAKES_RELEASE.md) · Measured performance/memory figures apply only to their stated configurations and single-component profile. [Benchmark](docs/BENCHMARK.md)

## Roadmap (Completed M0–M2 & Next Targets)

| Phase | Status / Target Date* | Scope & Primary Acceptance Criteria |
| --- | --- | --- |
| **M0** | **Completed** | Pure MoonBit core, Native/JS/Wasm GC, streaming state machine, CLI/Worker/Workbench, and 3 correctness fixes (`16a7b49`). |
| **M1** | **Completed** | Full legal `NEAR` expansion at full-scale 8/12/16-bit (`640/640` CharLS bidirectional parity). |
| **M2** | **Completed (2026-11-25)** | `P=2–16`, independent `MAXVAL`, legal `NEAR`, custom `LSE ID=1` (`T1/T2/T3/RESET`), Precision/Streaming/Compatibility Labs (`fc43bc2`). |
| **M3-A** | Target **2026-12-10** | Multicomponent frames, multiple `SOS` scans, `ILV=0` multi-scan state & cross-scan LSE inheritance. Exit: **Annex E `E.2-1`, `E.2-4`**. |
| **M3-B** | Target **2026-12-25** | `ILV=1` (line), `ILV=2` (sample), legal `H/V` sampling & edge MCUs, point transform `Pt` & dual-scale error reporting. Exit: **Annex E `E.2-2`, `E.2-3`, `E.2-5`–`E.2-8`**. |
| **M4** | Target **2027-01-10** | Mapping tables & continuations (`LSE2/3`), table-spec & abbreviated formats (`§7(b)(c)`), `DRI/RST0–RST7`, `DNL`, `LSE4` extended dimensions, remaining markers. |
| **M5** | Target **2027-01-20** | Full Part 1 conformance closure: official Annex E (`12/12`), T.87 `§8.2`/`§8.3`, capability-qualified oracles, 3-backend clean-room reproducibility. |

*\*Dates from M3-A onward are internal engineering targets, not organizer-confirmed hackathon acceptance dates.* [Compatibility Roadmap](docs/ROADMAP.md) · [Project Status](PROJECT_STATUS.md) · [Benchmark](docs/BENCHMARK.md)
