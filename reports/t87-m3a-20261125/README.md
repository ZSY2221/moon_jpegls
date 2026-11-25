# MoonJLS M3-A Verification Acceptance Report (`2026-11-25`)

- **Fixed Tested Source Revision (`core/`, `cmd/`, `sdk/`)**: [`36bb9e6a77bd38db6806a0cc5047885b694276b5`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5)
- **Scope**: M3-A delivers pure MoonBit **single-frame, multi-component (`1..255`), non-interleaved multi-scan (`ILV=0`, `Ns=1`, `H=V=1`, `Pt=0`) JPEG-LS** with `P=2–16`, independent `MAXVAL`, legal `NEAR`, cross-scan `LSE1` inheritance and zero-default re-resolution, non-contiguous component IDs, reordered scan sequences, Native planar streaming (`encode-planar`, `encode-pgms`, `decode-pgms`, `encode-ppm`, `decode ppm`), SDK/Worker multi-scan & batch flush support, and the Chrome Workbench Multicomponent View & Scan Structure Inspector.
- **Boundary Statement**: M3-A is an incremental milestone toward complete **ITU-T T.87 (06/1998) / ISO/IEC 14495-1 JPEG-LS Part 1**. Interleaved modes (`ILV=1,2`), subsampling (`H/V != 1`), point transform (`Pt>0`), mapping tables (`LSE2/3`), abbreviated/table formats, `DRI/RST0–RST7`, `DNL`, and `LSE4` remain scheduled in M3-B–M5. Official Annex E stands at **6/12 passed** (`E.2-1, 4, 9, 10, 11, 12`) and **6/12 expected `UnsupportedFeature`** (`E.2-2, 3, 5, 6, 7, 8`) — full T.87 Part 1 is **NOT** claimed complete.

## 1. Tool Versions & Artifact SHA-256 Fingerprints

- **MoonBit toolchain (Windows & Ubuntu 22.04 WSL2)**: `moon 0.1.20261119 (738607b)`, `moonc v0.10.22+124d61d05`, `moonrun 0.1.20261119`
- **Native C compiler (WSL2 Ubuntu 22.04)**: `Ubuntu clang version 14.0.0-1ubuntu1.1`
- **Node.js / Python / Browser**: `Node v24.20.0`, `Python 3.12.10`, `Google Chrome 158.0.8127.37`
- **Independent Reference Oracles**:
  - **HP JPEG-LS Reference Software V.1.00**: `locod.exe` (`36516cba57c7706a76d9ae3f21c4e35f2b3bd1a7a0ef7ca0f0124f18b78015c0`), `nlocod.exe` (`7cbc4c9506c9031a53b863793ad27c6bcb90f83c7fa257c53a90e83c5a6d5e86`), `loco16d.exe` (`f080d7cd7722ffbbd4e8887a229cb023e2c7ca471a69f6730d2ac41a09a6e7f5`), `nloco16d.exe` (`84682e13e6a12cd60e758cfd8d4c1c4c82d49bd415b76ae0c58a745bc71e4b00`)
  - **ITU official archives**: `jlsimgV100.zip` SHA-256 `b2c250453f631248bc3744bc50c935adcc94f55784f19b2fa1fa28ee8b803b70`; `jlsrefV100.zip` SHA-256 `085285f0552ef0b6ebcf29bc5a6d3bc0d6bda0408e9f2f1c138be2e55200814f`
  - **CharLS Wasm**: `@team-charls/charls-wasm@0.10.0`
  - **CharLS Native**: `imagecodecs==2026.11.11` (`CharLS 2.4.5`)
- **Tested Product Binary / Bundle SHA-256 (`36bb9e6`)**:
  - `sdk/generated/core.mjs` (`js`): `44a78b528bf73263e40bb6090ab4cd01eff2738435c7d69431385444f152751a`
  - `sdk/generated/core.wasm` (`wasm-gc`): `ecdfceff8dec9b0984a9bb776ac4203027189cd355bf370448420e1a6b0e908c`
  - `_build/native/release/build/cmd/moonjls/moonjls.exe` (`native` Linux/WSL release): `6d39a0fcf824f535064994fbc88aa44ed44c2575e39741bd13a5e225d30c9cd2`

## 2. Executed Checks & Raw Receipts

| Suite / Check | Result | Receipt |
| --- | --- | --- |
| `moon test core` (JS / Wasm GC / Native `--deny-warn`) | **18/18 passed** on all 3 targets, 0 warnings | [core-js.log](core-js.log) · [core-wasm-gc.log](core-wasm-gc.log) · [core-native-and-build.log](core-native-and-build.log) |
| Official **Annex E Table E.2** vs **HP 1.00** & **CharLS Wasm 0.10.0** (3 backends) | **6/12 passed** (`E.2-1, 4, 9, 10, 11, 12`), **18/18** encoded candidate streams byte-identical to official `.JLS`; **6/12** (`E.2-2, 3, 5, 6, 7, 8`) `expected_unsupported` (`UnsupportedFeature`) | [annex-e-hp.json](annex-e-hp.json) · [annex-e-charls.json](annex-e-charls.json) |
| **M3-A Golden Conformance** (`scripts/verify_m3a_golden.mjs --with-oracle`) | **7 positive + 7 negative** cases (21 frozen files), **21 backend checks** (`js`, `wasm-gc`, `native`), **2 CharLS Wasm cross-checks** passed | [m3a-golden.json](m3a-golden.json) |
| **M2 Golden Conformance** (`scripts/verify_m2_golden.mjs`) | **12 positive + 18 wire variants + 7 invalid encodes + 4 Native PGM** checks (54 frozen files) passed on 3 backends | [m2-golden.json](m2-golden.json) |
| **M2 Full Local Matrix** (`scripts/test_m2.py` w/ `jlsrefV100.zip`) | **388 positive + 18 variants + 7 invalid encodes + 6 Native PGM**, **826** SDK entries, **413** Native entries, **388** reciprocal cross-backend checks passed | [m2-matrix-summary.json](m2-matrix-summary.json) |
| **Full-Range NEAR Matrix** (`scripts/validate.py --near-matrix`) | **640/640** images (`8/0–127`, `12/0–255`, `16/0–255`), `5,120` SDK + `3,200` Native same-stream comparisons, `8,320` native/oracle checks passed (`scripts/interop.mjs:67` row-0 fix verified) | [near-matrix-report.json](near-matrix-report.json) |
| **Native Multi-Scan Delivery Regression** (`REVIEW_EVIDENCE/native_multiscan_delivery_regression.py`) | Component 1 (`9,216 B` @ `96x48x16` & `1,024 B` @ `64x16x8`) delivered immediately with `<=4096 B` chunks before Scan 2/3/`EOI`; Component 2 delivered before Scan 3/`EOI`; late tail rejected (`CommandError.Input`) | [native-multiscan-delivery.json](native-multiscan-delivery.json) |
| **Native Row Delivery & Tail Matrix** | Passed all eager, short-read, blocked-sink backpressure, missing/short EOI, and trailing-byte checks | [native-row-delivery.json](native-row-delivery.json) · [native-tail-matrix.json](native-tail-matrix.json) |
| **Worker Protocol / Codec / Reports / Web Unit Tests & TypeScript Strict Check** | Worker protocol **20/20**; Worker codec + report + `pgm` + `preview` **21/21**; `tsc --noEmit --strict` exit 0 | [worker-protocol.log](worker-protocol.log) · [node-tests.log](node-tests.log) |
| **Chrome 158 Workbench Smoke Suite** (`web/smoke.mjs` against `web/dist/`) | All M1/M2/M3-A checks passed (`#sample-rgb8`, `#sample-multi16` raw >255 inspector, CharLS Wasm verify, `.jls` reload w/ `C0/C1/C2` & Scan Inspector linkage, dark-theme contrast, Compatibility `6/12` Annex E manifest view) | [workbench-smoke.json](workbench-smoke.json) · [screenshots/](screenshots/) |

## 3. Notice on `lse-after-scan` Classification

In M2 (single-component, single-scan), a trailing `LSE1` appended after the first scan before `EOI` (`lse-after-scan.jls`) returned `UnsupportedFeature` because multi-scan resumption was not yet implemented. In M3-A, multi-scan resumption is supported: an inter-scan `LSE1` marker is valid only when followed by another `SOS`, whereas encountering `EOI` directly after `LSE1` is malformed syntax. Both HP `nlocod.exe` (*"In this implementation last marker must be EOI"*) and CharLS Wasm (`Invalid JPEG-LS stream`) reject this stream as invalid syntax; `tests/conformance/m2_golden/manifest.json` and `scripts/test_m2.py` now expect `InvalidData` without removing or softening the test.

## 4. Exact Reproduction Commands (Windows PowerShell + WSL2 Ubuntu-22.04)

```powershell
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
wsl -d Ubuntu-22.04 --exec bash -c "CC=clang ~/.moon/bin/moon test core --target native --deny-warn && CC=clang ~/.moon/bin/moon build cmd/moonjls --target native --release --deny-warn"
node sdk/build.mjs
node web/build.mjs
wsl -d Ubuntu-22.04 --exec bash -c "python3 REVIEW_EVIDENCE/native_row_delivery_regression.py _build/native/release/build/cmd/moonjls/moonjls.exe && python3 REVIEW_EVIDENCE/native_multiscan_delivery_regression.py _build/native/release/build/cmd/moonjls/moonjls.exe && python3 REVIEW_EVIDENCE/native_tail_matrix.py _build/native/release/build/cmd/moonjls/moonjls.exe"
node scripts/verify_m2_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe --native-wsl Ubuntu-22.04
node scripts/verify_m3a_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe --native-wsl Ubuntu-22.04 --with-oracle
python scripts/test_m2.py --hp-archive "D:\Program Files\GPT_project\moon_jpegls\.tools\itu-reference\jlsrefV100.zip" --native-binary _build/native/release/build/cmd/moonjls/moonjls.exe --native-wsl Ubuntu-22.04 --directory .evidence/m2-matrix-m3a
& "D:\Program Files\GPT_project\moon_jpegls\.tools\oracle-venv\Scripts\python.exe" scripts/validate.py --near-matrix --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe --native-wsl Ubuntu-22.04 --directory .evidence/near-matrix-m3a
node scripts/validate_annex_e.mjs --fixtures "C:\Users\sjm\.codex\worktrees\moonjls-t87-m2\moon_jpegls\.tools\annex-e" --hp-reference "C:\Users\sjm\.codex\worktrees\moonjls-t87-m2\moon_jpegls\.tools\annex-e-hp" --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe --native-wsl Ubuntu-22.04
node scripts/validate_annex_e.mjs --fixtures "C:\Users\sjm\.codex\worktrees\moonjls-t87-m2\moon_jpegls\.tools\annex-e" --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe --native-wsl Ubuntu-22.04
```
