# MoonJLS

[简体中文](README.zh-CN.md) · [Two-minute review](docs/REVIEWER_GUIDE.md) · [Conformance results](docs/CONFORMANCE_RESULTS.md) · [Workbench](https://zsy2221.github.io/moon_jpegls/web/)

MoonJLS preserves high-precision integer images through lossless or bounded near-lossless JPEG-LS exchange. The same MoonBit codec runs as a Native CLI and drives the JavaScript and Wasm GC SDKs. It keeps prediction rows in core memory and lets a pipe or Worker deliver reconstructed rows while the input is still arriving.

## Try the workbench

Build the SDK and launch the existing workbench from the repository root.

~~~sh
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
~~~

Open [the local workbench](http://127.0.0.1:8000/web/). Load the 8-bit or 16-bit microscopy example, choose ILV and NEAR, and run. The scan inspector shows the coded component order and geometry. The comparison uses the original integer samples. Download the JPEG-LS stream or the run report. [Browser checks](web/README.md)

The Native CLI can encode and inspect a tiny 8-bit image from a pipe.

~~~sh
printf 'P5\n3 2\n255\n\000\177\377\001\052\020' |
  moon run --target native cmd/moonjls -- encode-pgm 0 - sample.jls 7
moon run --target native cmd/moonjls -- inspect sample.jls --json
~~~

For sampled images, encode from separate component PGMs with explicit H/V factors and decode to separate PGMs. [CLI and SDK API](docs/API.md) · [Streaming pipe example](examples/stream_pipeline.sh) · [MoonBit consumer](examples/consumer/README.md)

## Verified scope

| Stage | Delivered capability | Evidence |
| --- | --- | --- |
| M2 | Coded precision 2–16 bits, explicit MAXVAL, legal NEAR, LSE1 presets | [388-case M2 matrix](reports/t87-m2-20261125/synthetic-matrix.md) |
| M3-A | Non-interleaved multi-component scans and cross-scan LSE1 defaults | [M3-A acceptance](reports/t87-m3a-20261125/README.md) |
| M3-B | ILV=1 line interleave, ILV=2 sample interleave, H/V sampling and edge MCU handling | [Annex E 12/12 on JS, Wasm GC and Native](docs/CONFORMANCE_RESULTS.md) |

HP 1.00 independently verifies all 12 official cases in both directions. CharLS Wasm 0.10.0 independently verifies ten and reports unsupported sampling for E.2-7/8. The pinned conformance report records inputs, decoded samples, candidate streams, artifact hashes, and the tested source revision. The NASA LOLA example verifies 1,036,800 reconstructed samples from a public elevation raster. [Evidence and reproduction](docs/CODEX_M3B_HANDOFF.md) · [LOLA fixture](tests/fixtures/LUNAR_DATA.md)

~~~sh
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
CC=clang moon test core --target native --deny-warn
~~~

[Encoder](core/encoder.mbt), [decoder](core/decoder.mbt), and [context model](core/model.mbt) implement the codec in MoonBit. [Native CLI](cmd/moonjls/main.mbt) links the same core. The [MoonBit bridge](cmd/bridge/bridge.mbt) generates JS and Wasm GC bindings. Handwritten [SDK](sdk/index.mjs), [Worker](sdk/worker.mjs), and [workbench](web/app.mjs) code handle transport and presentation. [Implementation map](docs/MOONBIT_IMPLEMENTATION_MAP.md)

## T.87 Part 1 roadmap

The final target is the full ITU-T T.87 / ISO/IEC 14495-1 Part 1 encoding, decoding, and data-format scope. All official Annex E cases use Pt=0. The remaining milestones cover nonzero point transform, mapping tables, abbreviated and table-specification formats, restart intervals, DNL, extended dimensions, and complete §8 acceptance. Each milestone has an exit criterion and independent reference requirements. [Roadmap](docs/ROADMAP.md) · [Support scope](docs/SCOPE.md) · [Mooncakes package status](docs/MOONCAKES_RELEASE.md)
