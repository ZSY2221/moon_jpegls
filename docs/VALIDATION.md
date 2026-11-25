# Validation

MoonJLS uses one MoonBit codec across Native, JS and Wasm GC. The external oracle exercises both directions. Each decoder is compared sample by sample against the CharLS decoder for the same byte stream. For lossless frames each reconstruction also equals the original. For near-lossless frames each sample satisfies `abs(original - reconstructed) <= NEAR`.

## Verified NEAR expansion (Historical M1 Full-Range Regression)

For the historical M1 full-range, single-component profile (`P=8/12/16`, default full-scale `MAXVAL = 2^P - 1`), the expansion matrix covers 8-bit NEAR 0–127 and 12- and 16-bit NEAR 0–255. It uses independently encoded CharLS Wasm input for all 640 configurations and checks Native, JS and Wasm GC in both directions (re-run and passed 640/640 on M2 frozen binaries as well). **Explicit scope note**: this 640-configuration suite is the historical full-range 8/12/16-bit NEAR regression, NOT the full Cartesian product of M2's `P=2–16`, arbitrary `MAXVAL`, and custom `LSE1` presets. For M2 numeric/preset/LSE1 validation and official Annex E results, see [Conformance Results](CONFORMANCE_RESULTS.md), [CI M2 Golden Fixtures](../tests/conformance/m2_golden/README.md), and [M2 Acceptance Summary](../reports/t87-m2-20261125/README.md). [M1 NEAR matrix results and reproduction commands](../reports/review-near-20261125/README.md)

## Reproduce

From the repository root in PowerShell, using Python 3.12 and Node 24:

```powershell
python -m venv .tools/oracle-venv
./.tools/oracle-venv/Scripts/python.exe -m pip install --only-binary=:all: -r scripts/oracle-requirements.txt
npm.cmd install --prefix .tools/oracle-npm --ignore-scripts --save-exact @team-charls/charls-wasm@0.10.0
./.tools/oracle-venv/Scripts/python.exe scripts/oracle.py self-test
node scripts/oracle.mjs --self-test
node sdk/build.mjs
./.tools/oracle-venv/Scripts/python.exe scripts/validate.py --conformance
```

Add Native verification with the Linux MoonBit SDK and clang in Ubuntu 22.04 WSL:

```powershell
wsl -d Ubuntu-22.04 --exec bash -lc 'CC=clang ~/.moon/bin/moon build cmd/moonjls --target native --release --target-dir .tools/wsl-build'
./.tools/oracle-venv/Scripts/python.exe scripts/validate.py --conformance --native-wsl Ubuntu-22.04 --native-exe .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe
```

On Linux, omit `--native-wsl`, pass the local release executable through `--native-exe` and run the script with the installed Python environment. Python stages the fixtures and coordinates comparisons. Node executes the JS/Wasm GC SDK and Wasm oracle. WSL executes the Native CLI through real pipes and files. The convenience tests call the exported whole-image SDK entry points. Moon tests exercise the core methods directly.

```text
moon test core --target js
moon test core --target wasm-gc
```

For a targeted reproduction use `--match b16-n3-all-values`. `--prepare-only` generates the raw samples, native reference streams and manifest without loading MoonJLS. The default evidence folder is `.evidence/validation/`. A failed run writes its complete invocation, seed, working source revision, exception and first observed sample or byte difference where applicable. Fixture inputs and candidate outputs remain in that directory. When iterating on a failure, give the next run a fresh `--directory` to retain the original outputs. The mutation runner changes one deterministic entropy bit per attempt and preserves unexpected failures in their one-bit form. Child process timeouts are 180 seconds for the JS/Wasm batch and 240 seconds for the Native CLI batch.

The reference drivers accept uint16 little-endian raw for every effective depth. The Native MoonJLS CLI uses one byte per 8-bit sample. The harness explicitly converts to and from this representation. For PGM the harness supplies 16-bit big-endian samples on stdin and checks the reconstructed file byte for byte.

## Reference versions

| Driver | Pinned build | Coverage |
| --- | --- | --- |
| `scripts/oracle.py` | `imagecodecs==2026.11.11`, verified at runtime as CharLS 2.4.5, tag peeled to `14b654dff1efed4d04e278ff3e99f0a486cf20cc` | Native encode 8/16, decode 8/12/16. The wrapper derives encoder precision from NumPy dtype. |
| `scripts/oracle.mjs` | `@team-charls/charls-wasm@0.10.0`, repository `7b95b8fcbb3c9bd9183d02820c736afb63fcd2c4`, `extern/charls` `5a2481fb28573149e72621aefaabf5aa9eaf0eb1` | Encode/decode 8/12/16, including explicit high-precision preset emission. |

Both drivers use prebuilt BSD-3-Clause CharLS distributions from the same codec lineage. The Native package lists CharLS 2.4.5 as a build dependency, and the wheel reports the same version at runtime. The pinned sources were checked for `set_frame_info`, `set_near_lossless`, preset emission, decoder header and destination APIs, and the sample call sequence. CharLS 2.4.5 specifies CMake 3.13 or later. The pinned Wasm build documents CMake 3.22+ and Emscripten 5.0.4+. [CharLS 2.4.5 source](https://github.com/team-charls/charls/tree/14b654dff1efed4d04e278ff3e99f0a486cf20cc), [Native wrapper source](https://github.com/cgohlke/imagecodecs/blob/v2026.11.11/imagecodecs/_jpegls.pyx), [Native wheel metadata](https://pypi.org/project/imagecodecs/2026.11.11/), [Wasm build requirements](https://github.com/team-charls/charls-wasm/blob/7b95b8fcbb3c9bd9183d02820c736afb63fcd2c4/BUILDING.md).

The Wasm package reports npm integrity `sha512-VS8tykpsGp2vrRebBESAg5hOJ+mr1imfgqwQm0RMNPze8rjxE0X3WJSc9i50nG1m+9KlH/U4R/t9Fl87lvV9hw==`. `node scripts/oracle.mjs --self-test` covers all 12 bit-depth and NEAR combinations. The native driver self-test covers eight. The same 12-bit Wasm-produced streams are also decoded with Native CharLS 2.4.5. [Wasm version and usage](https://github.com/team-charls/charls-wasm/tree/7b95b8fcbb3c9bd9183d02820c736afb63fcd2c4).

## Recorded results

See [machine-readable report](../reports/validation.json). The deterministic seed is `0x8716123`. Base coverage is 100 images. At every depth and NEAR, the generator covers a single pixel, one row and one column, zero and maximum constants, an odd-sized checkerboard, a gradient interspersed with long runs and interruptions, and full-range seeded noise. An extra 16-bit ramp includes all 65,536 possible values at each NEAR. The 16-bit NEAR=1 ramp produced 4,329 `FF` entropy bytes within a 9,117-byte entropy payload in external CharLS.

| Assertion | Recorded passes |
| --- | ---: |
| JS and Wasm GC exact same-stream reconstructions against official CharLS Wasm | 736 |
| Exact same-stream reconstructions against CharLS 2.4.5 across the three MoonJLS backends | 1,204 |
| Native CLI same-stream decode exercises | 468 |
| Fixed-strategy byte agreement across two backends and Native comparisons | 100 JS↔Wasm GC and 200 Native↔JS or Wasm GC |
| Fixed-strategy byte agreement between large and small chunks | 200 SDK and 100 Native CLI |
| SDK whole-image and streaming entry-point comparisons | 400 |
| Every single split, plus every proper truncated prefix of a small 16-bit NEAR=3 fixture | 160 splits and 162 truncations total across JS/Wasm GC |
| Default, zero-field and implicit LSE equivalence | 8 |
| Typed negative structural tests | 26 |
| Backpressure pause/resume and cancellation | 4 each |
| Deliberate host tail acceptance with exact EOI consumption | 2 |
| Native PGM pipe endian, encode, decode, inspect, and verify assertions | 4 |

The three measured precisions return the same maximum absolute error vector `[0, 1, 2, 3]` for NEAR 0–3. Byte equality is asserted between MoonJLS builds of the same encoding policy. External streams are judged by metadata, same-stream reconstruction and precision bounds. The mutation corpus produced 6 accepted frames and 90 typed rejections across the two SDK backends. An entropy mutation can produce another valid stream with different pixels.

The pinned Annex E conformance subset yields two supported monochrome streams and five out-of-scope streams per backend. Supported cases `t16e0.jls` and `t16e3.jls` reconstruct within the specified error against their source `test16.pgm`, which has 12 effective bits. Full 16-bit coverage comes from the separate synthetic dataset. The multicomponent, interleaved, subsampled and custom-preset cases are tracked under `UnsupportedFeature`. Hashes, attribution and sources are in [fixture provenance](../tests/fixtures/README.md). [Pinned conformance notes](https://github.com/team-charls/charls/blob/14b654dff1efed4d04e278ff3e99f0a486cf20cc/test/conformance/README.md).

The first SDK harness attempt failed because it read counters on the result object instead of `result.stats`. After adjusting the harness to the exported SDK shape, all counters and per-sample assertions ran. A subsequent marker review tightened invalid-field classification and SOI fill handling. See the core test and marker-fix history for those changes.
