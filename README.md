# MoonJLS

[简体中文](README.zh-CN.md)

**A native MoonBit JPEG-LS codec and verification toolkit**

MoonJLS serves high-precision integer image interchange with a pure MoonBit codec, Native, JS and Wasm GC interfaces, and reproducible interoperability checks. The scientific image workbench shows original sample precision, compression error, streaming behavior and validation evidence. PGM, raw rasters and MoonImage are the first integration paths. [High-precision image interfaces](docs/HIGH_PRECISION_INTERFACES.md)

The current implementation streams full-range 8-, 12- and 16-bit grayscale images with one frame, one component and one scan (ILV=0). `NEAR=0` preserves every sample. Positive integer `NEAR` bounds absolute error in the original sample scale, with a maximum of 127 at 8 bits and 255 at 12 or 16 bits. The streaming core keeps two prediction lines for this profile. [Support matrix](docs/SCOPE.md) · [Published NEAR validation](reports/review-near-20261125/README.md)

The final target is the full JPEG-LS Part 1 codec and data-format capabilities in ITU-T T.87 (06/1998) / ISO/IEC 14495-1. The roadmap expands parameter, scan and marker support in phases, with separate acceptance criteria for encoding and decoding. [T.87 capability matrix](docs/T87_CONFORMANCE_PLAN.md) · [Compatibility roadmap](docs/ROADMAP.md)

## Build and test

The verified SDK is Moon `0.1.20261119` and `moonc v0.10.22+124d61d05`. Node `24.20.0` runs the SDK. Native ran on Ubuntu 22.04 in WSL2. Use MoonBit with a system C compiler and shell on Linux for the native commands.

```sh
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
moon test core --target native --deny-warn
moon build cmd/moonjls --target native --release
```

Each test command runs 11 core tests, including the original 12 precision/NEAR combinations and high-NEAR boundary checks, exhaustive single-split replay, bounded output, long runs, cancellation, truncation and marker validation. [Independent validation](docs/VALIDATION.md)

## Native file and pipe use

```sh
python3 scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm
moon run --target native cmd/moonjls -- encode-pgm 0 .evidence/real/lola.pgm lola.jls 4096
moon run --target native cmd/moonjls -- decode lola.jls recovered.pgm pgm 4096
moon run --target native cmd/moonjls -- inspect lola.jls
moon run --target native cmd/moonjls -- verify lola.jls 17
```

`encode WIDTH HEIGHT BITS NEAR INPUT OUTPUT [raw-le|raw-be] [CHUNK]` reads one raw byte per 8-bit sample or two per 12/16-bit sample. Binary `P5` PGM stores high-depth samples big-endian. Use `-` for standard input or output. File outputs use exclusive creation. A failed operation can leave a partial output. `inspect` and `verify` decode through EOI and reject trailing data. Use the [native pipeline example](examples/stream_pipeline.sh) to send compressed bytes directly to a decoder while saving a copy.

## Browser and SDK

```sh
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

Open [the local workbench](http://127.0.0.1:8000/web/). Load the built-in 16-bit sample, a P5 PGM, or a `.jls` file. For a round trip, the Workers encode and decode the same bytes. The UI displays the bounded preview, full-resolution maximum error, dimensions, encoded bytes and elapsed time. The default browser download is explicitly buffered and capped at 64 MiB. Choose bounded verification for a discarding sink, or a direct file sink on browsers that expose the file picker. [Browser checks](web/README.md)

The SDK exports `Uint16Array` decoded rows, typed declarations, chunk and pause controls, and observable backpressure. Use `loadCore`, `encodeStream` and `decodeStream` for programmatic access. The independent MoonBit example uses the public package dependency and includes a `moonimage` Gray16 adapter. [SDK guide](sdk/README.md) · [Independent consumer](examples/consumer/README.md)

## Verification toolkit

The SDK CLI, Native verification adapter and browser workbench export a shared [verification report](docs/VERIFICATION_REPORT.md). The [NASA LOLA experiment](reports/lunar-budget-20261125/README.md) provides measured NEAR candidates and a physical error scale bound to the exact input. [Scientific workbench handoff](docs/SCIENTIFIC_WORKBENCH_HANDOFF.md)

## Evidence and limits

External validation uses prebuilt CharLS 2.4.5 and official CharLS Wasm stably pinned by version and source revision. The original corpus covers every 16-bit integer in a full-range ramp, NEAR 0–3 and adverse run and stuffing patterns. A separate comparison covers all 640 legal precision and NEAR combinations in the current profile. [NEAR expansion results](reports/review-near-20261125/README.md) The fixed-width benchmark measures payload, process peak RSS, time to first row and sink backpressure with synthetic and public-data results reported separately. [Validation](docs/VALIDATION.md) · [Benchmark](docs/BENCHMARK.md)

The current profile leaves multiple components, custom presets, mapping tables, restart intervals and deferred or extended dimensions for later Part 1 phases. T.870 Part 2 and DICOM containers are separate extensions. The codec's error checks do not replace an application checksum. See the current local candidate status and handoff for reproducibility, browser coverage and release boundaries. [Status](PROJECT_STATUS.md) · [Ecosystem audit](docs/ECOSYSTEM_AUDIT.md) · [Antigravity handoff](docs/ANTIGRAVITY_HANDOFF.md)
