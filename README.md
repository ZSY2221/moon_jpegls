# MoonJLS

[简体中文](README.zh-CN.md)

MoonJLS is a pure MoonBit streaming JPEG-LS codec for 8-, 12- and 16-bit grayscale images. It implements a single-frame, single-component and single-scan T.87 baseline profile. `NEAR=0` preserves every sample. `NEAR=1–3` bounds the absolute error of each reconstructed sample in its original integer scale. The core keeps two prediction lines and operates on Native, Wasm GC and JS. [Support matrix](docs/SCOPE.md)

MoonJLS's final target is the full JPEG-LS Part 1 codec and data-format capabilities in ITU-T T.87 (06/1998) / ISO/IEC 14495-1. The grayscale profile above is the current implementation stage. The [T.87 capability matrix and acceptance plan](docs/T87_CONFORMANCE_PLAN.md) separates verified capabilities from upcoming work, and the [compatibility roadmap](docs/ROADMAP.md) gives the phases and their exit criteria.

## Build and test

The verified SDK is Moon `0.1.20261119` and `moonc v0.10.22+124d61d05`. Node `24.20.0` runs the SDK. Native ran on Ubuntu 22.04 in WSL2. Use MoonBit with a system C compiler and shell on Linux for the native commands.

```sh
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
moon test core --target native --deny-warn
moon build cmd/moonjls --target native --release
```

Each test command runs nine core test groups, including the 12 precision/NEAR combinations, exhaustive single-split replay, bounded output, long runs, cancellation, truncation and marker validation. [Independent validation](docs/VALIDATION.md)

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

## Evidence and limits

External validation uses prebuilt CharLS 2.4.5 and official CharLS Wasm stably pinned by version and source revision. The corpus covers every 16-bit integer in a full-range ramp, NEAR 0–3 and adverse run and stuffing patterns. The fixed-width benchmark measures payload, process peak RSS, time to first row and sink backpressure with synthetic and public-data results reported separately. [Validation](docs/VALIDATION.md) · [Benchmark](docs/BENCHMARK.md)

The current profile leaves multiple components, custom presets, mapping tables, restart intervals and deferred or extended dimensions for later Part 1 phases. T.870 Part 2 and DICOM containers are separate extensions. The codec's error checks do not replace an application checksum. See the current local candidate status and handoff for reproducibility, browser coverage and release boundaries. [Status](PROJECT_STATUS.md) · [Ecosystem audit](docs/ECOSYSTEM_AUDIT.md) · [Antigravity handoff](docs/ANTIGRAVITY_HANDOFF.md)
